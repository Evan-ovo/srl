import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, process.argv[2] ?? 'dist')
const [buildInfo, manifest, serviceWorker] = await Promise.all([
  readFile(resolve(root, 'build-info.json'), 'utf8').then(JSON.parse),
  readFile(resolve(dist, 'offline-assets.json'), 'utf8').then(JSON.parse),
  readFile(resolve(dist, 'sw.js'), 'utf8'),
])
const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

requireValue(manifest.version === buildInfo.buildId, '完整离线清单版本与 BuildInfo 不一致')
const appContainer = manifest.assets.filter((asset) =>
  /^\/assets\/AppContainer-[^/]+\.js$/u.test(asset.url),
)
requireValue(appContainer.length > 0, '离线主界面缺少AppContainer执行Owner分包')
for (const asset of appContainer)
  requireValue(serviceWorker.includes(asset.url.slice(1)), '默认precache缺少主界面AppContainer依赖')
requireValue(
  Array.isArray(manifest.assets) && manifest.assets.length > 20,
  '完整离线清单缺少 Feature 资源',
)
requireValue(
  manifest.assets.some((asset) => asset.url === '/index.html'),
  '完整离线清单缺少应用入口',
)
requireValue(
  manifest.assets.some((asset) => asset.url.startsWith('/tutorials/')),
  '完整离线清单缺少教程资源',
)
for (const asset of manifest.assets) {
  requireValue(!asset.url.startsWith('/api/'), `离线清单不得包含 API：${asset.url}`)
  requireValue(!asset.url.startsWith('/downloads/'), `离线清单不得包含下载包：${asset.url}`)
}
requireValue(
  serviceWorker.includes('srl-feature-assets'),
  'Service Worker 缺少 Feature runtime cache',
)
requireValue(serviceWorker.includes('srl-runtime-images'), 'Service Worker 缺少图片 runtime cache')
requireValue(serviceWorker.includes('NetworkOnly'), 'Service Worker 未把 API 固定为 NetworkOnly')
requireValue(!serviceWorker.includes('tutorials/'), '教程图片不应进入默认 precache')
requireValue(!serviceWorker.includes('shen-yanzhou-opening'), '大型示例图不应进入默认 precache')
requireValue(
  !serviceWorker.includes('FrontendWorkshopWorkbench-'),
  '大型工作坊分包不应进入默认 precache',
)
for (const compilerAsset of [
  'FrontendWorkshopBrowserSourceCompilerService-',
  'compiler-sfc.esm-browser-',
  'esbuild-',
]) {
  requireValue(
    !serviceWorker.includes(compilerAsset),
    `按需 Browser Compiler 资源不应进入默认 precache：${compilerAsset}`,
  )
}
await stat(resolve(dist, 'force-refresh.html'))

if (failures.length) throw new Error(`PWA 离线门禁失败：\n- ${failures.join('\n- ')}`)
process.stdout.write(
  `PWA 离线门禁通过：默认壳分层缓存，完整离线清单 ${manifest.assets.length} 项\n`,
)
