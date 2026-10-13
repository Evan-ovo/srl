declare const caches: {
  open(name: string): Promise<{
    match(request: Request): Promise<Response | undefined>
    put(request: Request, response: Response): Promise<void>
    keys(): Promise<Request[]>
    delete(request: Request): Promise<boolean>
  }>
}
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildDiscordManualWorkerSource } from './scripts/DiscordManualWorkerSource.ts'
import { officialAppPackagesPlugin } from './scripts/OfficialAppPackages.js'
import { appearanceReferencePlugin } from './scripts/AppearanceReferenceCatalog.js'
import { isOfficialAppId } from './src/types/OfficialApp.js'

import vue from '@vitejs/plugin-vue'
import { build } from 'esbuild'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import buildInfo from './build-info.json' with { type: 'json' }

const previewVendorGlobalsSourceId = 'virtual:srl-preview-vendor-globals-source'
const resolvedPreviewVendorGlobalsSourceId = `\0${previewVendorGlobalsSourceId}`
const appearanceStarterCssSourceId = 'virtual:srl-appearance-starter-css-source'
const resolvedAppearanceStarterCssSourceId = `\0${appearanceStarterCssSourceId}`
const startupPrecache = new Map<string, { url: string; revision: null; size: number }>()

interface AppearanceStarterCssSource {
  file: string
  selectorHint?: RegExp
}

const appearanceStarterCssSources: Record<string, AppearanceStarterCssSource[]> = {
  library: [
    { file: 'AppShell.css', selectorHint: /\.(library|resource)-/u },
    { file: 'ResourceList.css', selectorHint: /\.resource-/u },
    { file: 'LayoutAndResponsive.css', selectorHint: /\.resource-/u },
  ],
  details: [{ file: 'ResourceDetails.css', selectorHint: /\.resource-detail/u }],
  features: [{ file: 'FeatureDesktop.css', selectorHint: /\.feature-/u }],
  draw: [{ file: 'FeatureDesktop.css', selectorHint: /\.(draw|gallery-reveal)/u }],
  cabinet: [
    {
      file: 'FolderLibrary.css',
      selectorHint: /\.(folder-library|visual-folder|cabinet-resource)/u,
    },
  ],
  appearance: [{ file: 'AppearanceStudio.css', selectorHint: /\.(appearance|layout-settings)-/u }],
  cloud: [{ file: 'CloudBackup.css', selectorHint: /\.cloud-/u }],
  bridge: [{ file: 'TavernBridgeCenter.css', selectorHint: /\.tavern-bridge/u }],
  stitch: [{ file: 'PresetStitcherApp.css', selectorHint: /\.stitch/u }],
  frontend: [
    { file: 'FrontendWorkshopBase.css', selectorHint: /\.frontend-workshop/u },
    { file: 'FrontendWorkshopDelivery.css', selectorHint: /\.frontend-workshop/u },
    { file: 'FrontendWorkshopResponsive.css', selectorHint: /\.frontend-workshop/u },
  ],
  persona: [{ file: 'UserPersonaApp.css', selectorHint: /\.persona-app/u }],
  'app:imageGeneration': [
    { file: 'ImageGenerationApp.css', selectorHint: /\.image-generation-app/u },
  ],
  'app:imageAlbum': [{ file: 'GeneratedImageAlbumApp.css', selectorHint: /\.generated-album/u }],
  'app:extensions': [{ file: 'ExternalAppManager.css', selectorHint: /\.external-app-manager/u }],
  settings: [
    { file: 'AppearanceStudio.css', selectorHint: /\.(appearance|settings|layout-settings)-/u },
    { file: 'LayoutAndResponsive.css', selectorHint: /\.layout-settings/u },
  ],
}

function extractAppearanceStarterRules(css: string, selectorHint?: RegExp, limit = 40): string[] {
  const rules: string[] = []
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const header = match[1]?.trim() ?? ''
    if (header.startsWith('@') || header.includes('@') || header.includes(':root')) continue
    if (!/\.[a-zA-Z_][\w-]*/u.test(header)) continue
    if (selectorHint && !selectorHint.test(header)) continue
    rules.push(`${header} {\n${match[2]?.trim() ?? ''}\n}`)
    if (rules.length >= limit) break
  }
  return rules
}

function appearanceStarterCssSourcePlugin(): Plugin {
  return {
    name: 'srl-appearance-starter-css-source',
    resolveId(id) {
      return id === appearanceStarterCssSourceId ? resolvedAppearanceStarterCssSourceId : undefined
    },
    load(id) {
      if (id !== resolvedAppearanceStarterCssSourceId) return undefined
      const root = join(process.cwd(), 'src', 'styles')
      return `export default ${JSON.stringify(
        Object.fromEntries(
          Object.entries(appearanceStarterCssSources).map(([scope, sources]) => [
            scope,
            sources
              .flatMap(({ file, selectorHint }) =>
                extractAppearanceStarterRules(readFileSync(join(root, file), 'utf8'), selectorHint),
              )
              .slice(0, 80)
              .join('\n\n'),
          ]),
        ),
      )}`
    },
  }
}

function previewVendorGlobalsSourcePlugin(): Plugin {
  return {
    name: 'srl-preview-vendor-globals-source',
    resolveId(id) {
      return id === previewVendorGlobalsSourceId ? resolvedPreviewVendorGlobalsSourceId : undefined
    },
    async load(id) {
      if (id !== resolvedPreviewVendorGlobalsSourceId) return undefined
      const result = await build({
        entryPoints: [join(process.cwd(), 'src', 'utils', 'PreviewVendorGlobals.ts')],
        bundle: true,
        format: 'iife',
        legalComments: 'inline',
        minify: true,
        platform: 'browser',
        target: 'es2022',
        write: false,
      })
      const source = result.outputFiles[0]?.text
      if (!source) throw new Error('Preview vendor globals bundle is empty')
      return `export default ${JSON.stringify(source)}`
    },
  }
}

function listPublicOfflineAssets(
  root: string,
  directory = root,
): Array<{ url: string; size: number }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name)
    if (directory === root && entry.name === 'official-apps') return []
    if (entry.isDirectory()) return listPublicOfflineAssets(root, absolutePath)
    const publicPath = relative(root, absolutePath).split(sep).join('/')
    if (
      publicPath.startsWith('downloads/') ||
      publicPath === '_headers' ||
      publicPath === 'sw-share-target.js'
    ) {
      return []
    }
    return [{ url: `/${publicPath}`, size: statSync(absolutePath).size }]
  })
}

function offlineAssetManifestPlugin(): Plugin {
  const publicAssets = [
    { url: '/index.html', size: statSync(join(process.cwd(), 'index.html')).size },
    ...listPublicOfflineAssets(join(process.cwd(), 'public')),
  ]
  return {
    name: 'srl-offline-asset-manifest',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        // 文件名前缀不能证明启动依赖齐全。仅沿正式核心入口的静态依赖收集；
        // 可选 APP、编辑器和预览编译器的动态分包仍按需缓存。
        startupPrecache.clear()
        const visitStartup = (name: string): void => {
          if (startupPrecache.has(name)) return
          const file = bundle[name]
          if (!file) return
          const content = file.type === 'chunk' ? file.code : file.source
          startupPrecache.set(name, { url: name, revision: null, size: Buffer.byteLength(content) })
          if (file.type !== 'chunk') return
          const metadata = file as typeof file & {
            viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> }
          }
          for (const dependency of [
            ...file.imports,
            ...(metadata.viteMetadata?.importedCss ?? []),
            ...(metadata.viteMetadata?.importedAssets ?? []),
          ])
            visitStartup(dependency)
        }
        for (const file of Object.values(bundle)) {
          // Vite 的独立 Worker 构建作为 asset 输出，不在主图的 imports 中。
          if (/^assets\/ContentSearchWorker-[^/]+\.js$/u.test(file.fileName))
            visitStartup(file.fileName)
          if (
            file.type === 'chunk' &&
            [
              ...Object.keys(file.modules),
              ...(file.facadeModuleId ? [file.facadeModuleId] : []),
            ].some(
              (id) =>
                /\/src\/(?:Bootstrap|Main|App|core\/AppContainer|components\/DiscordSourceHandoffIntake)\.(?:ts|vue)$/u.test(
                  id.replaceAll('\\', '/'),
                ) || id.replaceAll('\\', '/').includes('/workbox-window/'),
            )
          )
            visitStartup(file.fileName)
        }
        const optionalAsset = bundle['official-app-assets.json']
        const optionalFiles = new Set<string>(
          optionalAsset?.type === 'asset' ? JSON.parse(String(optionalAsset.source)).files : [],
        )
        const outputAssets = Object.values(bundle)
          .filter(
            (entry) =>
              !entry.fileName.endsWith('.map') &&
              !optionalFiles.has(entry.fileName) &&
              !entry.fileName.startsWith('official-apps/') &&
              entry.fileName !== 'official-app-assets.json',
          )
          .map((entry) => ({
            url: `/${entry.fileName}`,
            size:
              entry.type === 'chunk'
                ? Buffer.byteLength(entry.code)
                : typeof entry.source === 'string'
                  ? Buffer.byteLength(entry.source)
                  : entry.source.byteLength,
          }))
        const assets = [
          ...new Map(
            [...outputAssets, ...publicAssets].map((asset) => [asset.url, asset]),
          ).values(),
        ].sort((left, right) => left.url.localeCompare(right.url))
        this.emitFile({
          type: 'asset',
          fileName: 'offline-assets.json',
          source: JSON.stringify({
            version: buildInfo.buildId,
            totalBytes: assets.reduce((total, asset) => total + asset.size, 0),
            assets,
          }),
        })
      },
    },
  }
}

// https://vite.dev/config/
const preinstalledOfficialAppIds =
  process.env.SRL_ANDROID_PREINSTALL_OFFICIAL_APP_IDS?.split(',').filter(Boolean) ?? null
if (preinstalledOfficialAppIds?.some((id) => !isOfficialAppId(id) || id === 'assistant')) {
  throw new Error('Selected APP preinstallation contains an unsupported APP ID.')
}
export default defineConfig({
  define: {
    __SRL_PREINSTALL_OFFICIAL_APP_IDS__: JSON.stringify(preinstalledOfficialAppIds),
    __SRL_PREINSTALL_OFFICIAL_APPS__: JSON.stringify(
      process.env.SRL_ANDROID_PREINSTALL_OFFICIAL_APPS === '1',
    ),
  },
  plugins: [
    vue(),
    {
      name: 'srl-runtime-build-info',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const serializedBuildInfo = JSON.stringify(buildInfo).replaceAll('<', '\\u003c')
          return {
            html,
            tags: [
              {
                tag: 'script',
                children: `globalThis.__SRL_BUILD_INFO__=${serializedBuildInfo};`,
                injectTo: 'head-prepend',
              },
            ],
          }
        },
      },
    },
    appearanceStarterCssSourcePlugin(),
    appearanceReferencePlugin(),
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=official-app-package-build
    officialAppPackagesPlugin(buildInfo.buildId),
    // SRL-PUBLIC-SYNC: END REPLACE id=official-app-package-build
    previewVendorGlobalsSourcePlugin(),
    {
      name: 'srl-discord-manual-worker-source',
      resolveId(id) {
        return id === 'virtual:srl-discord-manual-worker-source'
          ? '\0srl-discord-manual-worker-source'
          : undefined
      },
      async load(id) {
        if (id !== '\0srl-discord-manual-worker-source') return undefined
        return 'export default ' + JSON.stringify(await buildDiscordManualWorkerSource())
      },
    },
    offlineAssetManifestPlugin(),
    VitePWA({
      // 更新不静默生效：新版本就绪后由页面提示用户刷新，避免运行中的会话被换掉分包。
      registerType: 'prompt',
      injectRegister: null,
      // 沿用 public/manifest.webmanifest，不再生成第二份清单。
      manifest: false,
      workbox: {
        clientsClaim: true,
        // Web Share Target 的 POST 接收器；系统分享的文件由它暂存后交回应用。
        importScripts: ['sw-share-target.js'],
        // 默认只安装应用壳与资源库核心入口；Feature 分包和教程图按需进入运行时缓存。
        // 官方 APP 共享资产清单随壳预缓存，供原生端安全判断旧 APP 依赖是否仍可用。
        globPatterns: [
          'index.html',
          'force-refresh.html',
          'manifest.webmanifest',
          'official-app-assets.json',
          // Keep startup cache limited to compact app icons. Apple touch and 512px icons remain
          // published and in the complete offline list, then load when requested.
          'icons/*-192.png',
          'icons/srl-icon-32.png',
        ],
        manifestTransforms: [
          async (entries) => ({
            manifest: [...entries, ...startupPrecache.values()],
            warnings: [],
          }),
        ],
        globIgnores: ['**/downloads/**', '**/official-apps/**', '**/offline-assets.json'],
        navigateFallback: 'index.html',
        // 互传中继必须实时访问 Worker，任何情况下都不能走缓存。
        navigateFallbackDenylist: [/^\/api\//, /^\/force-refresh\.html$/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              (url.pathname.startsWith('/assets/') ||
                request.destination === 'script' ||
                request.destination === 'style'),
            handler: async ({ request }) => {
              const installed = await (
                await caches.open('srl-official-app-assets-v1')
              ).match(request)
              if (installed) return installed
              const runtime = await caches.open('srl-feature-assets')
              const cached = await runtime.match(request)
              if (cached) return cached
              const response = await fetch(request)
              if (response.ok) {
                await runtime.put(request, response.clone())
                const keys = await runtime.keys()
                for (const key of keys.slice(0, Math.max(0, keys.length - 180)))
                  await runtime.delete(key)
              }
              return response
            },
          },
          {
            urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'srl-runtime-images',
              expiration: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'srl-runtime-fonts',
              expiration: { maxEntries: 24, maxAgeSeconds: 365 * 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    // Keep production CSS compatible with older Android WebViews used by packaged APKs.
    // This prevents minification from emitting modern media-query range syntax that those runtimes may ignore.
    cssTarget: 'chrome61',
  },
  server: {
    watch: { ignored: ['**/android/**'] },
  },
})
