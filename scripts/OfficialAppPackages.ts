import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { unzipSync, zipSync } from 'fflate'
import {
  OFFICIAL_APP_HOST_API_VERSION,
  OFFICIAL_APP_MAX_PACKAGE_FILES,
} from '../src/core/OfficialAppHostApi.js'
import {
  LEGACY_OFFICIAL_APP_CONTENT_REVISION,
  OFFICIAL_APP_CONTENT_REVISIONS,
} from '../src/core/OfficialAppContentRevision.js'

type ReleasedPackage = { url: string; sha256: string; downloadBytes: number }

export function officialAppContentHash(
  files: Array<{ path: string; size: number; sha256: string; bundled?: boolean }>,
  assetMode: 'host' | 'self-contained' = 'host',
): string {
  const ownedFiles = files
    .filter((file) => assetMode === 'self-contained' || !file.bundled)
    .map(({ path, size, sha256 }) => [path, size, sha256] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(ownedFiles)).digest('hex')
}

/** Preserve published ZIP bytes; only an identical final file graph may reuse a build ID. */
export function reuseReleasedOfficialAppPackage(
  bytes: Uint8Array,
  expected: Record<string, Uint8Array>,
  release: ReleasedPackage,
): Uint8Array {
  if (
    bytes.length !== release.downloadBytes ||
    createHash('sha256').update(bytes).digest('hex') !== release.sha256
  )
    throw new Error('Released official APP archive failed size/SHA-256 verification')
  const actual = unzipSync(bytes)
  if (
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([name, value]) => !actual[name] || !Buffer.from(actual[name]).equals(Buffer.from(value)),
    )
  )
    throw new Error('Released official APP content changed; use a new buildId before publishing')
  return bytes
}

export const entries = {
  chatReader: 'ChatReaderApp.vue',
  draw: 'DrawApp.vue',
  stitch: 'PresetStitcherApp.vue',
  frontendWorkshop: 'FrontendWorkshopSourceAiShell.vue',
  imageGeneration: 'ImageGenerationApp.vue',
  imageAlbum: 'GeneratedImageAlbumApp.vue',
  userPersona: 'UserPersonaApp.vue',
  tavernBridge: 'TavernBridgeCenter.vue',
  assistant: 'ProductAssistant.vue',
}
const virtualId = 'virtual:srl-official-app-entries'
const runtimeId = 'virtual:srl-official-app-runtime'

/** Uses the same build graph, Vue runtime and host services as the shell. */
export function officialAppPackagesPlugin(shellVersion: string, requireLoadingGate = true): Plugin {
  let production = false
  let publicRoot = ''
  const refs = new Map<string, string>()
  let runtimeRef = ''
  return {
    name: 'srl-official-app-packages',
    enforce: 'pre',
    configResolved(config) {
      production = config.command === 'build'
      publicRoot = config.publicDir || ''
    },
    resolveId(id, importer) {
      // Only this strict public entry imports Vue directly. Consumer-specific
      // tree shaking/export aliases must not change the renderer's identity.
      if (production && id === 'vue' && importer !== '\0' + runtimeId) return '\0' + runtimeId
      if (id === virtualId || id === runtimeId || id.startsWith('virtual:srl-official-app/'))
        return '\0' + id
    },
    buildStart() {
      if (!production) return
      // Strict public exports give the shell and every APP the same module URL,
      // including offline. Its hash also covers its static dependency graph.
      runtimeRef = this.emitFile({
        type: 'chunk',
        preserveSignature: 'strict',
        id: runtimeId,
        name: 'OfficialAppVueRuntime',
      })
      for (const [id, component] of Object.entries(entries)) {
        refs.set(
          id,
          this.emitFile({
            type: 'chunk',
            preserveSignature: 'strict',
            id: 'virtual:srl-official-app/' + id,
            name: component.replace('.vue', ''),
          }),
        )
      }
    },
    load(id) {
      if (id === '\0' + runtimeId) return 'export * from "vue"'
      if (id.startsWith('\0virtual:srl-official-app/')) {
        const appId = id.slice('\0virtual:srl-official-app/'.length)
        const component = entries[appId as keyof typeof entries]
        if (!component) throw new Error('Unknown official APP')
        const root = JSON.stringify(resolve('src/components', component).replaceAll('\\', '/'))
        let prepare = ''
        if (appId === 'imageGeneration')
          prepare =
            'export async function prepare(){const [g,a]=await Promise.all([import("/src/core/ImageGenerationContainer.ts"),import("/src/core/ImageAlbumContainer.ts")]);await Promise.all([g.frontendWorkshopImageGenerationService.initializeCredentials(),a.frontendWorkshopImageHostingService.initializeCredentials()])}'
        if (appId === 'imageAlbum')
          prepare =
            'export async function prepare(){const a=await import("/src/core/ImageAlbumContainer.ts");await a.frontendWorkshopImageHostingService.initializeCredentials()}'
        return 'export {default} from ' + root + ';' + prepare
      }
      if (id !== '\0' + virtualId) return
      if (!production) {
        return `export const runtimeEntry=undefined;export const entries={${Object.keys(entries)
          .map(
            (key) =>
              `${JSON.stringify(key)}:{load:()=>import(${JSON.stringify('virtual:srl-official-app/' + key)})}`,
          )
          .join(',')}}`
      }
      return `export const runtimeEntry=import.meta.ROLLUP_FILE_URL_${runtimeRef};export const entries={${[
        ...refs,
      ]
        .map(([key, ref]) => `${JSON.stringify(key)}:{url:import.meta.ROLLUP_FILE_URL_${ref}}`)
        .join(',')}}`
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const releasedCatalogPath = resolve(
          publicRoot,
          `official-apps/${shellVersion}/catalog.json`,
        )
        const released =
          publicRoot && existsSync(releasedCatalogPath)
            ? (JSON.parse(readFileSync(releasedCatalogPath, 'utf8')) as {
                shellVersion: string
                apps: Record<string, ReleasedPackage>
              })
            : undefined
        if (released && released.shellVersion !== shellVersion)
          throw new Error('Released official APP catalog buildId mismatch')
        const appEntries = new Map([...refs].map(([id, ref]) => [id, this.getFileName(ref)]))
        const appRoots = new Set(appEntries.values())
        const closure = (
          roots: string[],
          skipApps: boolean,
          hostOwned?: ReadonlySet<string>,
        ): Set<string> => {
          const seen = new Set<string>()
          const visit = (name: string) => {
            if (seen.has(name) || (appRoots.has(name) && (skipApps || !roots.includes(name))))
              return
            const file = bundle[name]
            if (!file) return
            seen.add(name)
            if (file.type !== 'chunk') return
            const meta = file as typeof file & {
              viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> }
            }
            for (const dep of [
              ...file.imports,
              // Lazy capabilities of shared services belong to the shell. Following these
              // edges copied host-only editors/compilers into unrelated APP packages.
              ...(hostOwned?.has(name) ? [] : file.dynamicImports),
              ...(meta.viteMetadata?.importedCss ?? []),
              ...(meta.viteMetadata?.importedAssets ?? []),
            ])
              visit(dep)
          }
          roots.forEach(visit)
          return seen
        }
        const shellRoots = Object.values(bundle)
          .filter((file) => file.type === 'chunk' && file.isEntry && !appRoots.has(file.fileName))
          .map((file) => file.fileName)
        const core = closure(shellRoots, true)
        const runtimeEntry = '/' + this.getFileName(runtimeRef)
        const vueRuntime = new Set(
          Object.values(bundle)
            .filter(
              (file) =>
                file.type === 'chunk' &&
                Object.keys(file.modules).some((name) =>
                  /\/@vue\/(?:runtime-core|runtime-dom|reactivity)\//u.test(
                    name.replaceAll('\\', '/'),
                  ),
                ),
            )
            .map((file) => file.fileName),
        )
        if (!vueRuntime.size || [...vueRuntime].some((name) => !core.has(name)))
          throw new Error('Official APPs must share the shell Vue runtime')
        const visitRuntime = (name: string) => {
          if (visitedRuntime.has(name)) return
          visitedRuntime.add(name)
          const file = bundle[name]
          if (!file || file.type !== 'chunk')
            throw new Error('Official APP Vue runtime dependency missing')
          if (
            Object.keys(file.modules).some((id) => {
              const path = id.replaceAll('\\', '/')
              return id !== '\0' + runtimeId && !/\/node_modules\/(?:@vue\/[^/]+|vue)\//u.test(path)
            })
          )
            throw new Error('Official APP Vue runtime must not include product modules')
          vueRuntime.add(name)
          file.imports.forEach(visitRuntime)
        }
        const visitedRuntime = new Set<string>()
        visitRuntime(runtimeEntry.slice(1))
        const optional = new Set<string>()
        const catalog: Record<string, unknown> = {}
        for (const [id, entry] of appEntries) {
          const gate = Object.values(bundle).find(
            (file) =>
              file.type === 'chunk' &&
              Object.keys(file.modules).some((name) =>
                name.replaceAll('\\', '/').endsWith('/components/OfficialAppGate.vue'),
              ),
          )?.fileName
          if (!gate && requireLoadingGate) throw new Error('Official APP loading gate missing')
          // The shell loads the gate before importing an installed APP. Making it a
          // package root pulls the shell/installer graph into every APP and turns
          // unrelated shell rebuilds into mandatory compatibility repairs.
          const graph = closure([entry, this.getFileName(runtimeRef)], false, core)
          // Source import/preview is an actual frontend APP capability. Its lazy compiler
          // must work offline even though the shared container also reaches this service.
          if (id === 'frontendWorkshop') {
            const compilerRoots = Object.values(bundle)
              .filter(
                (file) =>
                  file.type === 'chunk' &&
                  Object.keys(file.modules).some((name) =>
                    name
                      .replaceAll('\\', '/')
                      .endsWith('/services/FrontendWorkshopBrowserSourceCompilerService.ts'),
                  ),
              )
              .map((file) => file.fileName)
            for (const dependency of closure(compilerRoots, false)) graph.add(dependency)
          }
          const archive: Record<string, Uint8Array> = {}
          const files = [...graph].sort().map((name) => {
            if (!core.has(name)) optional.add(name)
            const file = bundle[name]!
            const bytes = Buffer.from(file.type === 'chunk' ? file.code : file.source)
            archive[name] = bytes
            return {
              path: '/' + name,
              bundled: core.has(name),
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }
          })
          if (!files.some((file) => file.path === '/' + entry))
            throw new Error(`Official APP ${id} is still eagerly reachable from the shell`)
          // Match the installer: the archive also contains manifest.json.
          if (files.length + 1 > OFFICIAL_APP_MAX_PACKAGE_FILES)
            throw new Error(`Official APP ${id} exceeds package file limit: ${files.length + 1}`)
          const assetMode = 'self-contained' as const
          // Product service/database modules must resolve to the shell's module URLs too.
          // Sharing Vue alone allows an older APP to open its own inactive IndexedDB owner.
          const hostFiles = files.filter((file) => core.has(file.path.slice(1)))
          if (
            !hostFiles.some((file) => file.path === runtimeEntry) ||
            [...vueRuntime].some((path) => !hostFiles.some((file) => file.path === '/' + path))
          )
            throw new Error(`Official APP ${id} does not share every shell Vue runtime chunk`)
          const appContentHash = officialAppContentHash(files, assetMode)
          const appContentRevision =
            OFFICIAL_APP_CONTENT_REVISIONS[id as keyof typeof OFFICIAL_APP_CONTENT_REVISIONS]
          archive['manifest.json'] = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              shellVersion,
              assetMode,
              hostFiles,
              runtimeEntry,
              hostApiVersion: OFFICIAL_APP_HOST_API_VERSION,
              appContentHash,
              appContentRevision,
              id,
              entry: '/' + entry,
              styles: [...graph].filter((name) => name.endsWith('.css')).map((name) => '/' + name),
              files,
            }),
          )
          const previous = released?.apps[id]
          if (
            released &&
            (!previous ||
              !new RegExp(`^/official-apps/${shellVersion}/${id}-[a-f0-9]{16}\\.srlapp$`, 'u').test(
                previous.url,
              ))
          )
            throw new Error(`Released official APP ${id} has an invalid archive path`)
          const content = previous
            ? reuseReleasedOfficialAppPackage(
                readFileSync(resolve(publicRoot, previous.url.slice(1))),
                archive,
                previous,
              )
            : zipSync(archive, { level: 6 })
          const packageHash = createHash('sha256').update(content).digest('hex')
          const url = `official-apps/${shellVersion}/${id}-${packageHash.slice(0, 16)}.srlapp`
          this.emitFile({ type: 'asset', fileName: url, source: content })
          const manifest = archive['manifest.json']!
          const manifestUrl = url.replace(/\.srlapp$/u, '.json')
          this.emitFile({ type: 'asset', fileName: manifestUrl, source: manifest })
          catalog[id] = {
            manifest: {
              url: '/' + manifestUrl,
              size: manifest.byteLength,
              sha256: createHash('sha256').update(manifest).digest('hex'),
            },
            shellVersion,
            hostApiVersion: OFFICIAL_APP_HOST_API_VERSION,
            assetMode,
            appContentHash,
            appContentRevision,
            hostFiles,
            runtimeEntry,
            url: '/' + url,
            sha256: packageHash,
            downloadBytes: Buffer.byteLength(content),
            installedBytes: files.reduce((total, file) => total + file.size, 0),
            entry: '/' + entry,
          }
        }
        const catalogDocument = JSON.stringify({
          schemaVersion: 1,
          shellVersion,
          hostApiVersion: OFFICIAL_APP_HOST_API_VERSION,
          apps: catalog,
        })
        this.emitFile({
          type: 'asset',
          fileName: `official-apps/${shellVersion}/catalog.json`,
          source: catalogDocument,
        })
        let needsLegacyWorkbenchCover = false
        const compatibleApps: Record<string, unknown[]> = Object.fromEntries(
          Object.keys(entries).map((id) => [id, []]),
        )
        for (const [id, current] of Object.entries(catalog)) compatibleApps[id]!.push(current)
        const compatibleCatalogs = new Map([[OFFICIAL_APP_HOST_API_VERSION, compatibleApps]])
        const retainedRoot = resolve(publicRoot, 'official-apps')
        if (existsSync(retainedRoot)) {
          for (const build of readdirSync(retainedRoot, { withFileTypes: true })) {
            if (!build.isDirectory() || !/^srl-(?:public-)?\d+\.\d+\.\d+-v\d+$/u.test(build.name))
              continue
            const catalogPath = resolve(retainedRoot, build.name, 'catalog.json')
            if (!existsSync(catalogPath)) continue
            const previous = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
              apps?: Record<string, { url: string }>
            }
            for (const [id, download] of Object.entries(previous.apps ?? {})) {
              if (!(id in compatibleApps)) continue
              const packagePath = resolve(publicRoot, download.url.slice(1))
              if (!existsSync(packagePath)) continue
              const archive = unzipSync(readFileSync(packagePath))
              const manifest = JSON.parse(
                Buffer.from(archive['manifest.json']!).toString('utf8'),
              ) as {
                id: string
                shellVersion: string
                hostApiVersion?: number
                appContentHash?: string
                appContentRevision?: number
                assetMode?: 'host' | 'self-contained'
                hostFiles?: Array<{ path: string; size: number; sha256: string; bundled?: boolean }>
                runtimeEntry?: string
                files: Array<{ path: string; size: number; sha256: string; bundled?: boolean }>
              }
              const hostApiVersion = manifest.hostApiVersion ?? 1
              if (
                manifest.id !== id ||
                !Number.isSafeInteger(hostApiVersion) ||
                hostApiVersion < 1 ||
                hostApiVersion > OFFICIAL_APP_HOST_API_VERSION
              )
                continue
              // Still-issued APKs use their original API catalog until users upgrade the shell.
              let apps = compatibleCatalogs.get(hostApiVersion)
              if (!apps) {
                apps = Object.fromEntries(Object.keys(entries).map((appId) => [appId, []]))
                compatibleCatalogs.set(hostApiVersion, apps)
              }
              // 已发布包仍引用旧 public URL；仅在保留目录实际需要时生成兼容地址。
              if (id === 'frontendWorkshop')
                needsLegacyWorkbenchCover ||= Object.entries(archive).some(
                  ([path, bytes]) =>
                    path.endsWith('.css') &&
                    Buffer.from(bytes)
                      .toString('utf8')
                      .includes('/images/frontend-workbench-cover-v1.jpg'),
                )
              apps[id]!.push({
                ...download,
                shellVersion: manifest.shellVersion,
                hostApiVersion,
                assetMode: manifest.assetMode ?? 'host',
                runtimeEntry: manifest.runtimeEntry,
                appContentHash:
                  manifest.appContentHash ??
                  officialAppContentHash(manifest.files, manifest.assetMode ?? 'host'),
                appContentRevision:
                  manifest.appContentRevision ?? LEGACY_OFFICIAL_APP_CONTENT_REVISION,
                hostFiles:
                  manifest.hostFiles ??
                  (manifest.assetMode === 'self-contained'
                    ? []
                    : manifest.files.filter((file) => file.bundled)),
              })
            }
          }
        }
        if (
          needsLegacyWorkbenchCover &&
          !existsSync(resolve(publicRoot, 'images/frontend-workbench-cover-v1.jpg'))
        ) {
          const cover = Object.values(bundle).find(
            (file) =>
              file.type === 'asset' &&
              /^assets\/frontend-workbench-cover-v1-[^/]+\.jpg$/u.test(file.fileName),
          )
          this.emitFile({
            type: 'asset',
            fileName: 'images/frontend-workbench-cover-v1.jpg',
            source:
              cover?.type === 'asset'
                ? cover.source
                : readFileSync(resolve('src/assets/frontend-workbench-cover-v1.jpg')),
          })
        }
        for (const [hostApiVersion, apps] of compatibleCatalogs) {
          for (const candidates of Object.values(apps)) {
            const unique = new Map(
              candidates.map((candidate) => [(candidate as { url: string }).url, candidate]),
            )
            candidates.splice(
              0,
              candidates.length,
              ...[...unique.values()].sort((left, right) =>
                (right as { shellVersion: string }).shellVersion.localeCompare(
                  (left as { shellVersion: string }).shellVersion,
                  undefined,
                  { numeric: true },
                ),
              ),
            )
          }
          this.emitFile({
            type: 'asset',
            fileName: `official-apps/api-${hostApiVersion}/catalog.json`,
            source: JSON.stringify({
              schemaVersion: 1,
              hostApiVersion,
              apps,
            }),
          })
        }
        // Capacitor packaging excludes these files and package downloads. The Web host retains them.
        this.emitFile({
          type: 'asset',
          fileName: 'official-app-assets.json',
          source: JSON.stringify({
            shellVersion,
            hostApiVersion: OFFICIAL_APP_HOST_API_VERSION,
            compatibleHostApiVersions: [...compatibleCatalogs.keys()].sort(
              (left, right) => left - right,
            ),
            files: [...optional].sort(),
            shellFiles: [...core].sort().map((name) => {
              const file = bundle[name]!
              const bytes = Buffer.from(file.type === 'chunk' ? file.code : file.source)
              return {
                path: '/' + name,
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              }
            }),
          }),
        })
      },
    },
  }
}
