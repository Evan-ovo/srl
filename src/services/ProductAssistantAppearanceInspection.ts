import postcss from 'postcss'
import type { AppearanceScope } from '../core/AppearanceScopes'

const privateNodes =
  '.auth-portal,.account-trigger,[data-srl-auth-portal],[data-sensitive],[data-srl-sensitive],[class*="login"],[class*="credential"],input[type="password"],iframe,script,style'
const controls = 'button,input,textarea,select,[role="button"],[role="switch"],[role="checkbox"]'

/** Read-only geometry/material evidence. Never read text, IDs, URLs, values or option labels. */
export function inspectAssistantAppearance(scope: AppearanceScope, theme: string) {
  const root = document.querySelector<HTMLElement>(scope.selector)
  if (!root || root.closest(privateNodes)) throw new Error('该界面尚未挂载或属于账号区域，无法检查')
  const elements = new Set<HTMLElement>([root])
  for (const element of root.querySelectorAll<HTMLElement>(controls)) {
    if (!element.closest(privateNodes)) elements.add(element)
    if (elements.size >= 49) break
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      (node as Element).matches(privateNodes) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  let walked = 0
  let next: Node | null
  while (elements.size < 64 && walked++ < 256 && (next = walker.nextNode()))
    elements.add(next as HTMLElement)
  const rect = root.getBoundingClientRect()
  const rootStyle = getComputedStyle(root)
  return {
    scope: scope.value,
    theme,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visible: rect.width > 0 && rect.height > 0,
    variables: Object.fromEntries(
      [
        '--color-canvas',
        '--color-surface',
        '--color-surface-raised',
        '--color-ink',
        '--color-ink-soft',
        '--color-accent',
        '--color-accent-soft',
        '--color-on-accent',
        '--color-line',
        '--radius-control',
        '--radius-panel',
      ].map((name) => [name, rootStyle.getPropertyValue(name).trim()]),
    ),
    overflowX:
      root.clientWidth > 0 && !['auto', 'scroll'].includes(rootStyle.overflowX)
        ? Math.max(0, root.scrollWidth - root.clientWidth)
        : 0,
    sampled: true,
    limit: 64,
    nodes: [...elements].map((element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        tag: element.tagName.toLowerCase(),
        classes: [...element.classList]
          .filter((name) => /^[a-zA-Z_][\w-]{0,80}$/u.test(name))
          .slice(0, 8),
        ...(element.matches(controls)
          ? {
              control: ['button', 'switch', 'checkbox'].includes(element.getAttribute('role') ?? '')
                ? element.getAttribute('role')
                : element instanceof HTMLInputElement
                  ? element.type
                  : element.tagName.toLowerCase(),
              disabled: element.matches(':disabled,[aria-disabled="true"]'),
            }
          : {}),
        width: Math.round(box.width),
        height: Math.round(box.height),
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        borderRadius: style.borderRadius,
        borderWidth: style.borderWidth,
        padding: style.padding,
        display: style.display,
      }
    }),
    hint: rect.width
      ? '实际挂载界面；有界采样优先控件，不能证明未打开页面或全部状态正常'
      : '后台隐藏界面，尺寸为零时以实际CSS为准',
  }
}

/** Selector evidence is advisory; hidden/conditional/stateful UI is not called dead CSS. */
export function inspectAssistantCssSelectors(scope: AppearanceScope, css: string, global = false) {
  const root = document.querySelector<HTMLElement>(scope.selector)
  if (!root || root.closest(privateNodes))
    return { mounted: false, rules: [], total: 0, sampled: false }
  const rules: Array<{
    selector: string
    conditions: string[]
    active: boolean | null
    matched: number | null
    issue?: string
  }> = []
  const layoutRisks: string[] = []
  let total = 0
  postcss.parse(css).walkRules((rule) => {
    const conditions: string[] = []
    let active: boolean | null = true
    for (let parent: postcss.AnyNode | undefined = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule') continue
      if (/keyframes$/iu.test(parent.name)) return
      conditions.unshift(`@${parent.name} ${parent.params}`)
      if (parent.name === 'media') {
        if (typeof window.matchMedia !== 'function') active = active === false ? false : null
        else if (!window.matchMedia(parent.params).matches) active = false
      } else if (parent.name === 'supports') {
        if (typeof globalThis.CSS?.supports !== 'function') active = active === false ? false : null
        else if (!CSS.supports(parent.params)) active = false
      } else if (['container', 'scope'].includes(parent.name))
        active = active === false ? false : null
    }
    total++
    if (
      /\.resource-(?:card|list|grid)\b/u.test(rule.selector) &&
      !/data-(?:mobile-card-orientation|resource-card-height)/u.test(rule.selector)
    ) {
      const properties: string[] = []
      rule.walkDecls((decl) => {
        if (
          [
            'height',
            'min-height',
            'aspect-ratio',
            'grid-template-columns',
            'flex-direction',
          ].includes(decl.prop) &&
          !/^(?:auto|initial|unset|inherit)$/u.test(decl.value)
        )
          properties.push(decl.prop)
      })
      if (properties.length && layoutRisks.length < 8)
        layoutRisks.push(
          `${rule.selector} 的 ${properties.join('/')} 未按卡片模式限定，可能覆盖横竖/高度切换`,
        )
    }
    if (rules.length >= 48) return
    const target: ParentNode = global ? document : root
    const selector = rule.selector.replace(
      /::(?:before|after|marker|placeholder|selection)\b/gu,
      '',
    )
    try {
      const nodes = [
        ...target.querySelectorAll<Element>(selector),
        ...(!global && root.matches(selector) ? [root] : []),
      ]
      const matched = nodes.filter((node) => !node.closest(privateNodes)).length
      rules.push({
        selector: rule.selector,
        conditions,
        active,
        matched,
        ...(matched === 0
          ? { issue: '当前DOM未命中；检查类名/页面/交互状态，不能据此认定规则无用' }
          : {}),
      })
    } catch {
      rules.push({
        selector: rule.selector,
        conditions,
        active,
        matched: null,
        issue: '当前浏览器无法查询该选择器（嵌套/特殊伪元素等）；未证明命中',
      })
    }
  })
  return { mounted: true, rules, total, sampled: total > rules.length, layoutRisks }
}

/** CSS can apply while evidence is unavailable; do not turn an advisory check into write failure. */
export function verifyAssistantAppearance(
  scope: AppearanceScope,
  theme: string,
  css: string,
  global = false,
) {
  try {
    return {
      inspection: inspectAssistantAppearance(scope, theme),
      selectors: inspectAssistantCssSelectors(scope, css, global),
      visualReview: '未由模型看图核验；本机对比不回传像素，需要时调用capture_current_ui',
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : '无法检查当前界面',
      visualReview: '未视觉核验',
    }
  }
}
