import { appearanceScopes } from './AppearanceScopes'
import type { CustomCssScope } from '../types/BrowserPreferences'
import type { UiViewAction, UiViewSnapshot } from '../types/UiCustomization'
import { createUiDomSession, UI_PRIVATE_SELECTOR } from '../services/UiViewDom'

/** Editor-only snapshots never enter a theme, backup or live action session. */
export function readUiViewPreview(scope: CustomCssScope, title: string, capture = true) {
  const selector = capture
    ? appearanceScopes().find((item) => item.value === scope)?.selector
    : undefined
  let element: HTMLElement | null = null
  try {
    element = selector ? document.querySelector<HTMLElement>(selector) : null
  } catch {
    /* Unsupported scope selector: use an explicit example. */
  }
  if (element && !element.closest('[data-ui-protected]')) {
    const snapshot = createUiDomSession(
      element,
      UI_PRIVATE_SELECTOR,
      '.appearance-ui-editor',
    ).read()
    if (snapshot.html && snapshot.controls.length) return { snapshot, live: true }
  }
  const root = document.createElement('main')
  root.className = 'feature-shell'
  root.setAttribute('data-srl-view-root', '')
  root.innerHTML =
    '<header class="feature-app-header" data-srl-feature-header="true"><button class="feature-app-header__back" data-srl-action="example-back" aria-label="返回">←</button><div class="feature-app-header__copy"><h1></h1></div><div class="feature-app-header__trailing"><button data-srl-action="example-more">更多</button></div></header><section class="ui-preview-content"><p>示例内容，可在 Vue 中调整布局和交互。</p><label>搜索<input data-srl-action="example-search" placeholder="搜索示例资源"></label><button data-srl-action="example-open">查看示例</button></section>'
  root.querySelector('h1')!.textContent = title
  return {
    live: false,
    snapshot: {
      html: root.outerHTML,
      controls: [
        { id: 'example-back', label: '返回', tag: 'button', type: 'button', disabled: false },
        { id: 'example-more', label: '更多', tag: 'button', type: 'button', disabled: false },
        {
          id: 'example-search',
          label: '搜索',
          tag: 'input',
          type: 'text',
          disabled: false,
          value: '',
        },
        { id: 'example-open', label: '查看示例', tag: 'button', type: 'button', disabled: false },
      ],
      theme: document.documentElement.dataset.theme || 'light',
    } satisfies UiViewSnapshot,
  }
}

/** Simulate fields only; clicking a preview never calls the host's controls. */
export function updateUiViewPreview(
  snapshot: UiViewSnapshot,
  action: UiViewAction,
): UiViewSnapshot {
  const control = snapshot.controls.find((item) => item.id === action.id)
  if (!control || control.disabled) throw new Error('该预览控件当前不可操作')
  if (action.event !== 'input' && action.event !== 'change') return snapshot
  const copy = new DOMParser().parseFromString(snapshot.html, 'text/html')
  const node = [...copy.querySelectorAll('[data-srl-action]')].find(
    (element) => element.getAttribute('data-srl-action') === action.id,
  )
  if (typeof action.value === 'string') {
    node?.setAttribute('value', action.value)
    if (node?.tagName === 'TEXTAREA') node.textContent = action.value
  }
  if (typeof action.checked === 'boolean') node?.toggleAttribute('checked', action.checked)
  return {
    ...snapshot,
    html: copy.body.innerHTML,
    controls: snapshot.controls.map((item) =>
      item.id === control.id
        ? {
            ...item,
            ...(typeof action.value === 'string' ? { value: action.value } : {}),
            ...(typeof action.checked === 'boolean' ? { checked: action.checked } : {}),
          }
        : item,
    ),
  }
}
