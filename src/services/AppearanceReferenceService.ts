import { parseAppearanceCss } from '../core/AppearanceCssReference'
import type { ReferenceCatalog, ReferenceSource } from '../types/AppearanceReference'
import type { InstalledOfficialApp } from '../types/OfficialApp'

export interface AppearanceReferenceReader {
  read(appIds: string[], signal: AbortSignal): Promise<ReferenceCatalog>
  clear(): void
}

/** On-demand reference for the exact installed APP; no installation, execution or user CSS read. */
export function createAppearanceReferenceReader(
  catalog: ReferenceCatalog,
  list: () => Promise<InstalledOfficialApp[]>,
  readAsset: (path: string, signal: AbortSignal) => Promise<string>,
): AppearanceReferenceReader {
  const parsed = new Map<string, Promise<ReferenceSource>>()
  const overrides = new Map<string, { key: string; sources: ReferenceSource[] }>()
  let last: { key: string; catalog: ReferenceCatalog } | undefined
  const keyOf = (app: InstalledOfficialApp) =>
    JSON.stringify([app.shellVersion, app.styles, app.files])
  const assetKey = (app: InstalledOfficialApp, path: string) => {
    const file = app.files.find((file) => file.path === path)
    if (!file || !/^\/assets\/[A-Za-z0-9_.-]+\.css$/u.test(path) || path.includes('..'))
      throw new Error('接口手册的 APP 样式清单无效')
    return `${path}:${file.sha256}`
  }
  return {
    clear() {
      parsed.clear()
      overrides.clear()
      last = undefined
    },
    async read(appIds, signal) {
      if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
      const apps = await list()
      const valid = new Set(apps.flatMap((app) => app.styles.map((path) => assetKey(app, path))))
      for (const key of parsed.keys()) if (!valid.has(key)) parsed.delete(key)
      for (const [id, old] of overrides) {
        const app = apps.find((app) => app.id === id)
        if (!app || keyOf(app) !== old.key) overrides.delete(id)
      }
      for (const id of new Set(appIds)) {
        const app = apps.find((app) => app.id === id)
        if (!app || overrides.has(id)) continue
        const sources: ReferenceSource[] = []
        for (const path of app.styles) {
          const key = assetKey(app, path)
          if (!parsed.has(key)) {
            const reading = readAsset(path, signal).then((css) => {
              if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
              return parseAppearanceCss(css, path)
            })
            parsed.set(key, reading)
            void reading.catch(() => {
              if (parsed.get(key) === reading) parsed.delete(key)
            })
          }
          sources.push(await parsed.get(key)!)
          if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
        }
        overrides.set(id, { key: keyOf(app), sources })
      }
      if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
      // Owner returns its cached registry; no second file/asset read. Reject a package change in flight.
      const current = await list()
      for (const id of new Set(appIds)) {
        const before = apps.find((app) => app.id === id)
        const after = current.find((app) => app.id === id)
        if ((before ? keyOf(before) : '') !== (after ? keyOf(after) : '')) {
          overrides.delete(id)
          throw new Error('APP 在读取教程期间已更新，请重新选择该 APP')
        }
      }
      if (signal.aborted) throw new DOMException('已取消读取教程', 'AbortError')
      const resultKey = JSON.stringify([...overrides].map(([id, value]) => [id, value.key]))
      if (last?.key === resultKey) return last.catalog
      const result: ReferenceCatalog = {
        ...catalog,
        sources: [...catalog.sources],
        scopes: { ...catalog.scopes },
        installed: {},
      }
      for (const [id, override] of overrides) {
        const app = apps.find((app) => app.id === id)!
        result.scopes[id] = [
          ...(catalog.scopes.global ?? []).filter((path) =>
            path.startsWith('src/styles/Foundation.css:'),
          ),
          ...override.sources.map((source) => source.path),
        ]
        for (const source of override.sources)
          if (!result.sources.some((item) => item.path === source.path)) result.sources.push(source)
        result.installed![id] = {
          version: app.shellVersion,
          fingerprint:
            app.appContentHash ??
            app.files
              .filter((file) => app.styles.includes(file.path))
              .map((file) => file.sha256)
              .join(','),
        }
      }
      last = { key: resultKey, catalog: result }
      return result
    },
  }
}

export async function createInstalledAppearanceReferenceReader(
  catalog: ReferenceCatalog,
): Promise<AppearanceReferenceReader> {
  const { officialAppService, fetchOfficialAppAsset } = await import('../core/OfficialAppRuntime')
  return createAppearanceReferenceReader(
    catalog,
    () => officialAppService.loadInstalled(),
    async (path, signal) => {
      const response = await fetchOfficialAppAsset(new URL(path, location.origin), { signal })
      if (!response.ok || !/^text\/css(?:;|$)/iu.test(response.headers.get('Content-Type') ?? ''))
        throw new Error('无法读取已安装 APP 的 CSS 接口，请检查离线资源或网络')
      return response.text()
    },
  )
}
