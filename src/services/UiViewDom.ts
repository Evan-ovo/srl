import type { UiViewAction, UiViewSnapshot } from '../types/UiCustomization'

export const UI_PRIVATE_SELECTOR =
  '[data-ui-protected], [data-private], [data-sensitive], .main-api-settings, .api-settings, .local-credential-settings, .secret-protection-settings, .account-trigger, .auth-portal, input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]'

/** This self-contained function also runs inside the built-in reader's isolated frame. */
export function createUiDomSession(root: HTMLElement, privateSelector: string, omitSelector = '') {
  const ids = new WeakMap<Element, string>()
  const targets = new Map<string, HTMLElement>()
  const nativeTargets = new Set<string>()
  let nextId = 0
  const controlsSelector =
    'button, input, select, textarea, form, summary, a[href], [role="button"], [role="tab"], [tabindex]'
  const visible = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === 'none') return false
      if (
        node.parentElement instanceof HTMLDetailsElement &&
        !node.parentElement.open &&
        node.tagName !== 'SUMMARY'
      )
        return false
      if (node === root) break
    }
    return true
  }
  const read = (): UiViewSnapshot => {
    targets.clear()
    nativeTargets.clear()
    const controls: UiViewSnapshot['controls'] = []
    const nativeRegions: NonNullable<UiViewSnapshot['nativeRegions']> = []
    const copy = (node: Node): Node | null => {
      if (node.nodeType === Node.TEXT_NODE) return node.cloneNode()
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return null
      if (omitSelector && node.matches(omitSelector)) return null
      if (node instanceof HTMLElement && !visible(node)) return null
      if (
        node.hasAttribute('data-srl-native-anchor') ||
        node.hasAttribute('data-srl-custom-surface')
      )
        return null
      const privateContent = node.matches(privateSelector)
      if (
        node instanceof HTMLElement &&
        (privateContent ||
          node.hasAttribute('data-srl-native-root') ||
          node.matches('input[type="file"], .fa-solid, .fa-regular, .fa-brands, .fa-duotone') ||
          ['IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG'].includes(node.tagName))
      ) {
        const id = ids.get(node) ?? `control-${++nextId}`
        ids.set(node, id)
        targets.set(id, node)
        nativeTargets.add(id)
        nativeRegions.push({
          id,
          tag: node.tagName.toLowerCase(),
          label: privateContent
            ? '受保护输入'
            : node.getAttribute('aria-label') || node.getAttribute('title') || '原生内容',
        })
        const placeholder = document.createElement('div')
        for (const attribute of [...node.attributes])
          if (attribute.name === 'class' || attribute.name.startsWith('data-v-'))
            placeholder.setAttribute(attribute.name, attribute.value)
        placeholder.dataset.srlNative = id
        placeholder.style.width = `${node.clientWidth}px`
        placeholder.style.height = `${node.clientHeight}px`
        placeholder.style.maxWidth = '100%'
        return placeholder
      }
      if (['SCRIPT', 'STYLE', 'LINK', 'OBJECT', 'EMBED'].includes(node.tagName)) return null
      const clone = node.cloneNode(false) as Element
      if (node instanceof HTMLElement) {
        const id = ids.get(node) ?? `control-${++nextId}`
        ids.set(node, id)
        targets.set(id, node)
        clone.setAttribute('data-srl-node', id)
      }
      for (const attribute of [...clone.attributes]) {
        if (
          /^on/iu.test(attribute.name) ||
          ['href', 'srcdoc', 'action', 'formaction', 'nonce'].includes(attribute.name)
        )
          clone.removeAttribute(attribute.name)
      }
      if (node instanceof HTMLElement && node.matches(controlsSelector)) {
        const id = ids.get(node)!
        clone.setAttribute('data-srl-action', id)
        const field = node as HTMLInputElement
        const label =
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          node.getAttribute('placeholder') ||
          node.textContent?.trim().slice(0, 120) ||
          node.tagName.toLowerCase()
        controls.push({
          id,
          label,
          tag: node.tagName.toLowerCase(),
          type: field.type || '',
          disabled: field.disabled === true,
          ...('value' in node && field.type !== 'file' ? { value: String(field.value) } : {}),
          ...('checked' in node ? { checked: field.checked } : {}),
        })
        if (node instanceof HTMLInputElement && node.type !== 'file') {
          clone.setAttribute('value', node.value)
          clone.toggleAttribute('checked', node.checked)
        }
        if (node instanceof HTMLTextAreaElement) clone.textContent = node.value
      }
      if (node instanceof HTMLSelectElement) {
        for (const option of [...node.options]) {
          const copied = option.cloneNode(true) as HTMLOptionElement
          copied.toggleAttribute('selected', option.selected)
          clone.append(copied)
        }
      } else if (!(node instanceof HTMLTextAreaElement)) {
        for (const child of [...node.childNodes]) {
          const copied = copy(child)
          if (copied) clone.append(copied)
        }
      }
      return clone
    }
    const clone = copy(root) as HTMLElement | null
    clone?.classList.remove('srl-ui-controller-hidden')
    clone?.removeAttribute('aria-hidden')
    clone?.setAttribute('data-srl-view-root', '')
    // Keep ancestor selectors and inherited tokens without duplicating their grid/scroll layout.
    let markup = clone
    for (
      let ancestor = root.parentElement;
      markup && ancestor && ancestor.id !== 'app' && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      const context = document.createElement(ancestor.tagName)
      for (const attribute of [...ancestor.attributes])
        if (attribute.name === 'class' || attribute.name.startsWith('data-'))
          context.setAttribute(attribute.name, attribute.value)
      context.classList.remove('srl-ui-controller-hidden')
      context.style.setProperty('display', 'contents', 'important')
      context.append(markup)
      markup = context
    }
    const environment = Object.fromEntries(
      [
        'data-font-scale',
        'data-mobile-card-orientation',
        'data-resource-card-height',
        'data-no-image-resource-cover',
        'data-display-mode',
      ].map((name) => [name, document.documentElement.getAttribute(name) || '']),
    )
    return {
      html: markup?.outerHTML ?? '',
      controls,
      theme: document.documentElement.dataset.theme || 'light',
      route: root.dataset.featurePage || '',
      nativeRegions,
      environment,
    }
  }
  const invoke = (action: UiViewAction): void => {
    if (!action || typeof action.id !== 'string') throw new Error('界面动作无效')
    const target = targets.get(action.id)
    if (
      !target ||
      !root.contains(target) ||
      !visible(target) ||
      target.matches(':disabled') ||
      target.closest(privateSelector) ||
      target.closest('[inert]')
    )
      throw new Error('该控件当前不可操作')
    if (action.event === 'click' && target.matches(controlsSelector)) target.click()
    else if (action.event === 'submit' && target instanceof HTMLFormElement) target.requestSubmit()
    else if (action.event === 'input' || action.event === 'change') {
      if (
        !(
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement
        ) ||
        ('readOnly' in target && target.readOnly) ||
        (target instanceof HTMLInputElement && ['password', 'file'].includes(target.type))
      )
        throw new Error('该控件不支持界面赋值')
      if (typeof action.value === 'string') {
        const prototype =
          target instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : target instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLSelectElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, action.value)
      }
      if (target instanceof HTMLInputElement && typeof action.checked === 'boolean')
        target.checked = action.checked
      target.dispatchEvent(new Event(action.event, { bubbles: true }))
    } else if (
      action.event === 'keydown' &&
      typeof action.key === 'string' &&
      action.key.length < 40
    ) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true }))
    } else if (
      action.event === 'scroll' &&
      Number.isFinite(action.top) &&
      Number.isFinite(action.left)
    ) {
      target.scrollTo({ top: action.top, left: action.left })
    } else throw new Error('不支持的界面动作')
  }
  return {
    read,
    invoke,
    native: (id: string) => {
      const node = targets.get(id)
      return node && root.contains(node) && nativeTargets.has(id) ? node : undefined
    },
  }
}
