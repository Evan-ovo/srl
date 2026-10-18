import type { Component } from 'vue'
import { entries, runtimeEntry } from 'virtual:srl-official-app-entries'
import { BUILD_INFO } from './BuildInfo'
import { OFFICIAL_APP_HOST_API_VERSION } from './OfficialAppHostApi'
import { appDatabase } from './AppDatabaseInstance'
import { InstalledOfficialAppStorage } from '../storage/InstalledOfficialAppStorage'
import { clearOfficialAppData } from '../storage/OfficialAppDataStorage'
import { OfficialAppService } from '../services/OfficialAppService'
import {
  OFFICIAL_APP_IDS,
  type OfficialAppBuildCatalog,
  type OfficialAppId,
} from '../types/OfficialApp'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import { getOfficialAppShellFiles } from '../utils/OfficialAppBuildCatalog'

export const fetchOfficialAppAsset: typeof fetch = (input, init) => {
  const nativeFetch = (window as Window & { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch
  return (typeof nativeFetch === 'function' ? nativeFetch : window.fetch).call(window, input, init)
}
const shellManifestUrl = new URL('/official-app-assets.json', location.origin)
let shellFiles: Promise<Record<string, { size: number; sha256: string }>> | undefined
function getShellFiles(): Promise<Record<string, { size: number; sha256: string }>> {
  shellFiles ??= (async () => {
    if (__SRL_PREINSTALL_OFFICIAL_APPS__ && isCapacitorApp()) {
      const catalogUrl = new URL(
        `/official-apps/${BUILD_INFO.buildId}/catalog.json`,
        location.origin,
      )
      const response = await fetchOfficialAppAsset(catalogUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error('无法读取 APK 内置 APP catalog')
      const catalog = (await response.json()) as OfficialAppBuildCatalog
      if (
        catalog.shellVersion !== BUILD_INFO.buildId ||
        catalog.hostApiVersion !== OFFICIAL_APP_HOST_API_VERSION
      )
        throw new Error('APK 内置 APP catalog 与当前版本不匹配')
      return getOfficialAppShellFiles(catalog)
    }
    const response = await fetchOfficialAppAsset(shellManifestUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取资源库内置 APP 资产清单')
    let manifest: { shellFiles?: Array<{ path: string; size: number; sha256: string }> }
    try {
      manifest = (await response.json()) as typeof manifest
    } catch {
      throw new Error(
        `无法读取资源库内置 APP 资产清单（${response.url || shellManifestUrl.href} 返回非 JSON 内容）`,
      )
    }
    return Object.fromEntries(
      (manifest.shellFiles ?? []).map((file) => [
        file.path,
        { size: file.size, sha256: file.sha256 },
      ]),
    )
  })()
  return shellFiles
}
const dataRevisions = new Map(
  OFFICIAL_APP_IDS.map((id) => [id, localStorage.getItem(`srl.officialApps.dataRevision.${id}`)]),
)
export const officialAppService = new OfficialAppService(
  new InstalledOfficialAppStorage(appDatabase),
  BUILD_INFO.buildId,
  fetchOfficialAppAsset,
  location.origin,
  async (id) => {
    await clearOfficialAppData(appDatabase, id)
  },
  async (id) => {
    const { clearOfficialAppAppearance } = await import('../services/AppearanceScopeService')
    clearOfficialAppAppearance(id)
  },
  OFFICIAL_APP_HOST_API_VERSION,
  getShellFiles,
  runtimeEntry ? new URL(runtimeEntry, location.href).pathname : undefined,
)

let preinstalledApps: Promise<void> | undefined
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=optional-app-ids
const OPTIONAL_DOWNLOAD_ONLY_APP_IDS = new Set<OfficialAppId>(['assistant'])
// SRL-PUBLIC-SYNC: END REPLACE id=optional-app-ids
export function ensurePreinstalledOfficialApps(): Promise<void> {
  if (!__SRL_PREINSTALL_OFFICIAL_APPS__ || !isCapacitorApp()) return Promise.resolve()
  const marker = `srl.officialApps.preinstalled.${BUILD_INFO.buildId}`
  if (localStorage.getItem(marker) === 'done') return Promise.resolve()
  preinstalledApps ??= (async () => {
    for (const id of OFFICIAL_APP_IDS)
      if (
        !OPTIONAL_DOWNLOAD_ONLY_APP_IDS.has(id) &&
        (!__SRL_PREINSTALL_OFFICIAL_APP_IDS__ || __SRL_PREINSTALL_OFFICIAL_APP_IDS__.includes(id))
      )
        if (!(await officialAppService.ready(id))) await officialAppService.install(id)
    localStorage.setItem(marker, 'done')
  })().catch((error: unknown) => {
    preinstalledApps = undefined
    throw error
  })
  return preinstalledApps
}

export async function acquireOfficialAppUse(id: OfficialAppId): Promise<() => void> {
  if (import.meta.env.DEV) return () => {}
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(
        `srl-official-app-use:${id}`,
        { mode: 'shared' },
        () => new Promise<void>((release) => resolve(release)),
      )
      .catch(reject)
  })
}

export async function loadOfficialApp(
  id: OfficialAppId,
  onReady?: (ready: boolean) => void,
): Promise<Component | undefined> {
  if (dataRevisions.get(id) !== localStorage.getItem(`srl.officialApps.dataRevision.${id}`))
    throw new Error('APP 数据已清除，请刷新页面后重新打开')
  const entry = entries[id]!
  let module: { default: Component; prepare?: () => Promise<void> }
  if (import.meta.env.DEV && entry.load) {
    onReady?.(true)
    module = await entry.load()
  } else {
    const installed = await officialAppService.getReadyPackage(id)
    onReady?.(Boolean(installed))
    if (!installed) return undefined
    if (!isCapacitorApp() && !navigator.serviceWorker?.controller)
      throw new Error('离线加载尚未就绪，请刷新页面后打开 APP')
    await Promise.all(
      installed.styles.map((path) => {
        const href = new URL(path, location.origin).href
        if ([...document.styleSheets].some((sheet) => sheet.href === href)) return
        return new Promise<void>((resolve, reject) => {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = href
          link.dataset.srlOfficialApp = id
          link.onload = () => resolve()
          link.onerror = () => {
            link.remove()
            reject(new Error('APP 样式加载失败，请重新下载'))
          }
          document.head.append(link)
        })
      }),
    )
    module = await import(/* @vite-ignore */ installed.entry)
  }
  await module.prepare?.()
  return module.default
}
