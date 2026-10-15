import { installUiRecoveryGesture } from '../core/UiRecoveryGesture'

/** Runs exclusively inside sandbox=allow-scripts. The host never evaluates author code. */
function installUiViewBridge(installRecoveryGesture: typeof installUiRecoveryGesture) {
  let port: MessagePort | undefined
  let nonce = ''
  let sequence = 0
  let state: unknown
  let failed = false
  let stopRecoveryGesture: (() => void) | undefined
  const listeners = new Set<(value: unknown) => void>()
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const regions = new Map<Element, string>()
  let regionsQueued = false
  const placeRegions = () => {
    if (!port || regionsQueued) return
    regionsQueued = true
    requestAnimationFrame(() => {
      regionsQueued = false
      port?.postMessage({
        type: 'native',
        nonce,
        regions: [...regions]
          .filter(([node]) => node.isConnected)
          .map(([node, id]) => {
            const rect = node.getBoundingClientRect()
            return { id, top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          }),
      })
    })
  }
  const sizes = new ResizeObserver(placeRegions)
  const observeRegions = () => {
    sizes.disconnect()
    regions.clear()
    for (const node of document.querySelectorAll<HTMLElement>('[data-srl-native]')) {
      regions.set(node, node.dataset.srlNative!)
      sizes.observe(node)
    }
    placeRegions()
  }
  new MutationObserver(observeRegions).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  window.addEventListener('resize', placeRegions)
  document.addEventListener('scroll', placeRegions, true)
  const invoke = (action: unknown) =>
    new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error('界面尚未连接'))
        return
      }
      const id = ++sequence
      pending.set(id, { resolve, reject })
      port.postMessage({ type: 'action', nonce, id, sequence, action })
    })
  Object.defineProperty(window, 'srlUi', {
    value: Object.freeze({
      /** 底层订阅接口，返回取消订阅函数；卸载时取消。快照字段见 UiViewSnapshot。 */
      subscribe(callback: (value: unknown) => void) {
        listeners.add(callback)
        if (state !== undefined) callback(state)
        return () => listeners.delete(callback)
      },
      /** 底层操作接口，返回 Promise；使用最新快照的控件 id，参数字段见 UiViewAction。 */
      invoke,
    }),
  })
  window.addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== 'srl:ui-connect' ||
      typeof event.data.nonce !== 'string' ||
      !event.ports[0] ||
      port
    )
      return
    nonce = event.data.nonce
    port = event.ports[0]
    port.onmessage = ({ data }) => {
      if (data?.nonce !== nonce) return
      if (data.type === 'state') {
        state = data.state
        document.documentElement.dataset.theme = data.state.theme
        for (const name of [
          'data-font-scale',
          'data-mobile-card-orientation',
          'data-resource-card-height',
          'data-no-image-resource-cover',
          'data-display-mode',
        ])
          document.documentElement.setAttribute(name, data.state.environment?.[name] || '')
        const active = document.activeElement as HTMLInputElement | null
        const actionId = active?.getAttribute('data-srl-action')
        const selection =
          active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA'
            ? [active.selectionStart, active.selectionEnd]
            : undefined
        const scroll = [...document.querySelectorAll<HTMLElement>('[data-srl-node]')]
          .filter((element) => element.scrollTop || element.scrollLeft)
          .map(
            (element) =>
              [
                element.getAttribute('data-srl-node'),
                element.scrollTop,
                element.scrollLeft,
              ] as const,
          )
        for (const listener of listeners) listener(state)
        queueMicrotask(() => {
          if (actionId) {
            const next = document.querySelector<HTMLInputElement>(`[data-srl-action="${actionId}"]`)
            next?.focus({ preventScroll: true })
            if (selection?.[0] != null && selection[1] != null) {
              try {
                next?.setSelectionRange(selection[0], selection[1])
              } catch {
                /* Non-text inputs. */
              }
            }
          }
          for (const [id, top, left] of scroll) {
            const node = document.querySelector<HTMLElement>(`[data-srl-node="${id}"]`)
            if (node) {
              node.scrollTop = top
              node.scrollLeft = left
            }
          }
          observeRegions()
          // Vue's state-triggered DOM flush precedes this microtask. A hidden frame may
          // never paint until the host receives readiness, so do not wait for a paint.
          if (!failed) port?.postMessage({ type: 'rendered', nonce })
        })
      } else if (data.type === 'recovery-gesture') {
        stopRecoveryGesture?.()
        stopRecoveryGesture =
          data.enabled === true
            ? installRecoveryGesture(document, () =>
                port?.postMessage({ type: 'reveal-recovery', nonce }),
              )
            : undefined
      } else if (data.type === 'styles') {
        const style = document.getElementById('srl-ui-host-styles')!
        style.textContent = data.css
      } else if (data.type === 'result' && pending.has(data.id)) {
        const request = pending.get(data.id)!
        pending.delete(data.id)
        if (data.ok) request.resolve(data.value)
        else request.reject(new Error(data.error || '原界面未执行该操作'))
      }
    }
    port.start()
    port.postMessage({ type: failed ? 'error' : 'ready', nonce })
  })
  const send = (action: unknown) => {
    void invoke(action).catch(() => {})
  }
  document.addEventListener('click', (event) => {
    const control = (event.target as Element)?.closest<HTMLElement>('[data-srl-action]')
    if (
      !control ||
      !control.matches(
        'button, summary, a, [role="button"], [role="tab"], input[type="button"], input[type="submit"]',
      )
    )
      return
    event.preventDefault()
    send({ id: control.dataset.srlAction, event: 'click' })
  })
  for (const name of ['input', 'change'])
    document.addEventListener(name, (event) => {
      const control = event.target as HTMLInputElement
      if (!control?.dataset.srlAction) return
      send({
        id: control.dataset.srlAction,
        event: name,
        value: control.value,
        checked: control.checked,
      })
    })
  document.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement
    if (!form.dataset.srlAction) return
    event.preventDefault()
    send({ id: form.dataset.srlAction, event: 'submit' })
  })
  document.addEventListener('keydown', (event) => {
    const control = event.target as HTMLElement
    if (
      control?.dataset.srlAction &&
      ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)
    )
      send({ id: control.dataset.srlAction, event: 'keydown', key: event.key })
  })
  document.addEventListener(
    'scroll',
    (event) => {
      const node = event.target as HTMLElement
      if (node?.dataset?.srlNode)
        send({
          id: node.dataset.srlNode,
          event: 'scroll',
          top: node.scrollTop,
          left: node.scrollLeft,
        })
    },
    true,
  )
  const reportError = () => {
    failed = true
    stopRecoveryGesture?.()
    port?.postMessage({ type: 'error', nonce })
  }
  window.addEventListener('error', reportError)
  window.addEventListener('unhandledrejection', reportError)
  parent.postMessage({ type: 'srl:ui-ready' }, '*')
}

/** The controlled parent keeps frame-src enforced even if author code navigates itself. */
function installUiContainer(documentText: string) {
  const child = document.getElementById('srl-ui-author-frame') as HTMLIFrameElement
  let loaded = false
  child.addEventListener('load', () => {
    if (loaded) parent.postMessage({ type: 'srl:ui-navigation' }, '*')
    loaded = true
  })
  window.addEventListener('message', (event) => {
    if (event.source === child.contentWindow && event.data?.type === 'srl:ui-ready')
      parent.postMessage({ type: 'srl:ui-ready' }, '*')
    else if (event.source === parent && event.data?.type === 'srl:ui-connect' && event.ports[0])
      child.contentWindow?.postMessage(event.data, '*', [event.ports[0]])
  })
  child.srcdoc = documentText
}

export function createUiViewDocument(source: string, allowNetwork: boolean): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${allowNetwork ? ' https:' : ''}`,
    `font-src data:${allowNetwork ? ' https:' : ''}`,
    `media-src data: blob:${allowNetwork ? ' https:' : ''}`,
    `connect-src ${allowNetwork ? 'https:' : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  const inner = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style id="srl-ui-host-styles"></style><style>html,body{margin:0;min-height:100%}#app{min-height:100%}</style></head><body><script>(${installUiViewBridge.toString()})(${installUiRecoveryGesture.toString()})</script><div id="app">${source}</div></body></html>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy.replace("frame-src 'none'", 'frame-src about:')}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe id="srl-ui-author-frame" title="界面源码内容" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>(${installUiContainer.toString()})(${JSON.stringify(inner).replace(/</gu, '\\u003c')})</script></body></html>`
}
