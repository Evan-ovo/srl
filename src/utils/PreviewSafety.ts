const MAX_PREVIEW_SOURCE_LENGTH = 200_000
const STANDALONE_CODE_FENCE_PATTERN = /(^|\r?\n)[ \t]*```(?:html|css|xml|svg)?[ \t]*(?=\r?\n|$)/gi

export interface StaticMarkupPreview {
  markup: string
  css: string
  hasStaticContent: boolean
  blockedScripts: boolean
  blockedExternalAssets: boolean
}

export interface PreviewCssOptions {
  allowExternalResources?: boolean
  allowLocalResources?: boolean
  /** Trusted host styles can include complete packaged assets; author source uses the default budget. */
  preserveLength?: boolean
}

export function stripCodeFence(value: string): string {
  const source = value.trim().slice(0, MAX_PREVIEW_SOURCE_LENGTH)
  const fenced = source.match(/^```(?:html|css|xml|svg)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return fenced[1]?.trim() ?? ''
  return source.replace(STANDALONE_CODE_FENCE_PATTERN, '$1').trim()
}

export function sanitizeCssForPreview(value: string, options: PreviewCssOptions = {}): string {
  const safeSource = (options.preserveLength ? value : value.slice(0, MAX_PREVIEW_SOURCE_LENGTH))
    .replace(/expression\s*\([^)]*\)/gi, 'none')
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]*/gi, '/* 已阻止危险 CSS */')
    .replace(/<\/style/gi, '<\\/style')

  if (options.allowExternalResources) return safeSource

  return safeSource
    .replace(/@import\s+(?:url\s*\([^)]*\)|[^;])*;?/gi, '/* 已阻止外部 @import */')
    .replace(/url\s*\((?:"[^"]*"|'[^']*'|[^)])*\)/gi, (reference) => {
      const url = reference.replace(/^url\s*\(\s*['"]?|['"]?\s*\)$/giu, '').trim()
      return options.allowLocalResources &&
        /^(?:data:(?:image|font)\/|blob:|srl-ui-asset:)/iu.test(url)
        ? reference
        : 'none'
    })
}

export function extractPreviewCss(value: string, options: PreviewCssOptions = {}): string {
  const source = stripCodeFence(value)
  const styleBlocks = Array.from(source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi))
    .map((match) => match[1] ?? '')
    .filter(Boolean)
  return sanitizeCssForPreview(styleBlocks.length ? styleBlocks.join('\n') : source, options)
}

function removeUnsafeMarkup(
  value: string,
  allowExternalResources = false,
): {
  markup: string
  blockedScripts: boolean
  blockedExternalAssets: boolean
} {
  const blockedScripts = /<script\b|\son[a-z]+\s*=|javascript\s*:/i.test(value)
  // <audio> 和 <video> 不包含在内：它们无法执行脚本，最多自动播放或加载远程资源；
  // 远程媒体仍由远程资源开关控制其 src 属性。自闭合 <source> 仅作为子元素保留。
  const blockedExternalAssets =
    /<(?:link|iframe|object|embed)\b|\s(?:src|href|action|formaction)\s*=/i.test(value)
  let markup = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|link|meta|base)\b[^>]*\/?\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '')
  if (!allowExternalResources) {
    markup = markup.replace(
      /\s(?:src|href|action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      '',
    )
  } else {
    markup = markup.replace(/\s(?:action|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  }
  return { markup, blockedScripts, blockedExternalAssets }
}

export function prepareStaticMarkupPreview(
  value: string,
  options: PreviewCssOptions = {},
): StaticMarkupPreview {
  const source = stripCodeFence(value)
  const styleBlocks = Array.from(source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi))
    .map((match) => match[1] ?? '')
    .filter(Boolean)
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)
  const bodySource = bodyMatch?.[1] ?? source.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
  const withoutStyles = bodySource.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
  const sanitized = removeUnsafeMarkup(withoutStyles, options.allowExternalResources)
  const markup = sanitized.markup
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .trim()
  const textContent = markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim()
  const hasVisibleElement =
    /<(?:article|aside|audio|button|canvas|div|figure|h[1-6]|img|input|li|main|nav|p|section|span|table|textarea|ul|video)\b/i.test(
      markup,
    )
  // 避免把普通文字、JSON、Emoji 误判为 CSS：
  // 只当开头像选择器（. # * 字母 或 @media/@keyframes/@font-face）时才按纯 CSS 处理。
  const cssOnly =
    !markup &&
    /\s*(?:[.#*@]|[a-z]+\b|@(?:media|keyframes|font-face|supports|container|layer))\s*[^{]*\{[^{}]*:[^{}]*\}/is.test(
      source,
    )

  return {
    markup,
    css: sanitizeCssForPreview(
      styleBlocks.length ? styleBlocks.join('\n') : cssOnly ? source : '',
      options,
    ),
    hasStaticContent: Boolean(textContent || hasVisibleElement || cssOnly),
    blockedScripts: sanitized.blockedScripts,
    blockedExternalAssets:
      sanitized.blockedExternalAssets || /@import\s|url\s*\(/i.test(styleBlocks.join('\n')),
  }
}
