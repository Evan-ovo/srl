import type { AppearanceScope } from '../core/AppearanceScopes'
import { BUILD_INFO } from '../core/BuildInfo'
import { isOfficialAppId, type InstalledOfficialApp } from '../types/OfficialApp'

export interface OriginalCssDocument {
  parts: string[]
}

export interface OriginalCssReader {
  document: Document
  origin: string
  shellVersion: string
  apps: InstalledOfficialApp[]
  readAsset: (url: string, signal?: AbortSignal) => Promise<string>
  readExtraCss?: () => Promise<string>
}

function cssUrl(path: string, origin: string): string {
  const url = new URL(path, origin)
  if (
    url.origin !== origin ||
    !/^\/assets\/[A-Za-z0-9_.-]+\.css$/u.test(url.pathname) ||
    url.pathname.includes('..')
  )
    throw new Error('原始 CSS 文件来源无效')
  return url.href
}

/** Read current shell assets and the selected installed APP's exact asset manifest. */
export async function readOriginalCss(
  scope?: AppearanceScope,
  signal?: AbortSignal,
  reader?: OriginalCssReader,
): Promise<OriginalCssDocument> {
  if (scope && !scope.selector) throw new Error('该界面暂不可用，已保存的自定义 CSS 不受影响')
  if (!reader) {
    const { officialAppService, fetchOfficialAppAsset } = await import('../core/OfficialAppRuntime')
    reader = {
      document,
      origin: location.origin,
      shellVersion: BUILD_INFO.buildId,
      apps: scope ? await officialAppService.list() : [],
      // The host extension manager is lazy, but has no independently installed APP manifest.
      readExtraCss:
        !scope || scope.value === 'shell'
          ? async () =>
              '/* 恢复提示内部的 Shadow DOM 原始样式。自定义时在全局 CSS 设置 --recovery-* / --button-* 变量；普通选择器不能穿透保护层。 */\n' +
              (await import('../styles/RecoveryControls.css?inline')).default
          : scope?.value === 'app:extensions'
            ? async () => (await import('../styles/ExternalAppManager.css?inline')).default
            : scope?.appId === 'chatReader'
              ? async () =>
                  '/* 读了么列表与设置的原始样式；聊天正文请在阅读器的外观设置中调整。 */\n' +
                  (await import('../reader/ChatReader.css?raw')).default
              : undefined,
      readAsset: async (url, requestSignal) => {
        const response = await fetchOfficialAppAsset(url, { signal: requestSignal })
        if (!response.ok || !/^text\/css(?:;|$)/iu.test(response.headers.get('Content-Type') ?? ''))
          throw new Error('原始 CSS 文件读取失败，请检查离线资源或网络后重试')
        return response.text()
      },
    }
  }
  if (signal?.aborted) throw new DOMException('已取消读取原始 CSS', 'AbortError')
  const { document: sourceDocument, origin, apps } = reader
  const appId = scope?.appId
  const app = appId && isOfficialAppId(appId) ? apps.find((item) => item.id === appId) : undefined
  if (appId && isOfficialAppId(appId) && !app)
    throw new Error('请先安装该 APP，再读取它的原始 CSS；已有自定义样式仍保留')

  if (app && app.shellVersion !== reader.shellVersion)
    throw new Error('该 APP 需要更新，不能混用不同版本的原始 CSS')

  const appOnlyUrls = new Set<string>()
  const bundledUrls = new Set<string>()
  for (const installed of apps) {
    for (const file of installed.files) {
      if (!file.path.endsWith('.css')) continue
      const url = cssUrl(file.path, origin)
      if (file.bundled) bundledUrls.add(url)
      else appOnlyUrls.add(url)
    }
  }
  const wantedUrls = new Set<string>()
  for (const path of app?.styles ?? []) {
    if (!app?.files.some((file) => file.path === path))
      throw new Error('该 APP 的 CSS 清单不完整，请重新下载 APP')
    wantedUrls.add(cssUrl(path, origin))
  }

  const sources: Array<{ url?: string; text?: string; media: string }> = []
  const seenUrls = new Set<string>()
  for (const node of sourceDocument.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
    'style, link[rel~="stylesheet"]',
  )) {
    if (
      node.id === 'srl-custom-ui-style' ||
      node.hasAttribute('data-custom-css') ||
      node.hasAttribute('data-appearance-css')
    )
      continue
    if (node.tagName === 'STYLE') {
      // Vite's official development styles; arbitrary injected/user styles are not official CSS.
      if (!node.hasAttribute('data-vite-dev-id') && !node.hasAttribute('data-srl-official-css'))
        continue
      sources.push({ text: node.textContent ?? '', media: node.media })
      continue
    }
    const href = node.getAttribute('href')
    if (!href) continue
    let url: string
    try {
      url = cssUrl(href, origin)
    } catch {
      // External fonts, extensions, data/blob URLs and user-linked styles are not shell assets.
      continue
    }
    if (
      scope &&
      !wantedUrls.has(url) &&
      !bundledUrls.has(url) &&
      (appOnlyUrls.has(url) || node.hasAttribute('data-srl-official-app'))
    )
      continue
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    sources.push({ url, media: node.media })
  }
  // An installed APP need not be opened/executed just to export its styles.
  for (const url of wantedUrls) {
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    sources.push({ url, media: '' })
  }

  if (reader.readExtraCss) {
    const css = await reader.readExtraCss()
    sources.push({ text: css, media: '' })
  }

  const title = (scope?.title ?? '当前应用').replaceAll('*/', '* /')
  const parts = [`/* SRL 原始 CSS：${title}；包含依赖的公共样式。 */\n`]
  let nonempty = false
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('已取消读取原始 CSS', 'AbortError')
    const css = source.url ? await reader.readAsset(source.url, signal) : (source.text ?? '')
    if (!css.trim()) continue
    nonempty = true
    if (source.url) parts.push(`\n/* ${new URL(source.url).pathname} */\n`)
    const media = source.media.trim()
    if (media && media !== 'all') parts.push(`@media ${media} {\n`, css, '\n}\n')
    else parts.push(css, '\n')
    // Keep file collection responsive; never spread all CSS rules onto a function's argument stack.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  if (signal?.aborted) throw new DOMException('已取消读取原始 CSS', 'AbortError')
  if (!nonempty) throw new Error('未读取到原始 CSS，没有生成空文件')
  return { parts }
}
