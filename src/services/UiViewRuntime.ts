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
  let paintCandidates: HTMLElement[] = []
  let paintCandidatesDirty = true
  let lastPlacement = ''
  type Rect = { top: number; left: number; width: number; height: number }
  const intersect = (a: Rect, b: Rect): Rect => {
    const left = Math.max(a.left, b.left)
    const top = Math.max(a.top, b.top)
    return {
      left,
      top,
      width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
      height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top),
    }
  }
  const subtract = (rect: Rect, cover: Rect): Rect[] => {
    const cut = intersect(rect, cover)
    if (!cut.width || !cut.height) return [rect]
    return [
      { ...rect, height: cut.top - rect.top },
      { ...rect, top: cut.top + cut.height, height: rect.top + rect.height - cut.top - cut.height },
      { top: cut.top, left: rect.left, width: cut.left - rect.left, height: cut.height },
      {
        top: cut.top,
        left: cut.left + cut.width,
        width: rect.left + rect.width - cut.left - cut.width,
        height: cut.height,
      },
    ].filter((part) => part.width > 0 && part.height > 0)
  }
  const mutationOptions = {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'style',
      'hidden',
      'open',
      'data-srl-native',
      'data-srl-host-scroll',
      'data-srl-native-overlay',
      'aria-modal',
    ],
  }
  const runningLayoutAnimation = () =>
    (document.getAnimations?.() ?? []).some((animation) => {
      const effect = animation.effect as (KeyframeEffect & { pseudoElement?: string | null }) | null
      const target = effect?.target
      if (
        (!animation.pending && animation.playState !== 'running') ||
        !(target instanceof Element) ||
        effect?.pseudoElement ||
        !effect
          ?.getKeyframes()
          .some((frame) =>
            Object.keys(frame).some((key) =>
              /^(transform|translate|scale|rotate|opacity|visibility|clipPath|top|left|right|bottom|inset|width|height|margin|padding)/u.test(
                key,
              ),
            ),
          )
      )
        return false
      return (
        [...regions.keys()].some((node) => target.contains(node)) ||
        paintCandidates.some((node) => target.contains(node) || node.contains(target))
      )
    })
  const placeRegions = () => {
    if (!port || regionsQueued || failed) return
    regionsQueued = true
    requestAnimationFrame(() => {
      regionsQueued = false
      if (failed) return
      // Hit-testing may temporarily restore pointer events. Do not observe our own probes;
      // preserve pending author mutations before disconnecting the same observer.
      if (changes.takeRecords().length) observeRegions()
      changes.disconnect()
      const bounds = new Map<Element, DOMRect>()
      const styles = new Map<Element, CSSStyleDeclaration>()
      const box = (node: Element) => {
        if (!bounds.has(node)) bounds.set(node, node.getBoundingClientRect())
        return bounds.get(node)!
      }
      const style = (node: Element) => {
        if (!styles.has(node)) styles.set(node, getComputedStyle(node))
        return styles.get(node)!
      }
      if (paintCandidatesDirty) {
        paintCandidatesDirty = false
        paintCandidates = [...document.body.querySelectorAll<HTMLElement>('*')].filter((node) => {
          if (!(node instanceof HTMLElement) || node.matches('script, style, link, meta'))
            return false
          const css = style(node)
          return (
            node.hasAttribute('data-srl-native') ||
            ['absolute', 'fixed', 'sticky'].includes(css.position) ||
            css.zIndex !== 'auto' ||
            node.matches('dialog[open], [aria-modal="true"], [data-srl-native-overlay]')
          )
        })
      }
      const frontOf = (cover: HTMLElement, node: HTMLElement, overlap: Rect) => {
        const restored = [cover, node]
          .filter((element) => style(element).pointerEvents === 'none')
          .map((element) => ({
            element,
            attribute: element.getAttribute('style'),
          }))
        for (const { element } of restored)
          element.style.setProperty('pointer-events', 'auto', 'important')
        const stack =
          document.elementsFromPoint?.(
            overlap.left + overlap.width / 2,
            overlap.top + overlap.height / 2,
          ) ?? []
        for (const { element, attribute } of restored) {
          if (attribute === null) element.removeAttribute('style')
          else element.setAttribute('style', attribute)
        }
        const nativeIndex = stack.indexOf(node)
        const coverIndex = stack.findIndex(
          (element) => element === cover || cover.contains(element),
        )
        return nativeIndex >= 0 && coverIndex >= 0 && coverIndex < nativeIndex
      }
      const visibleBounds = new Map<Element, Rect>()
      const clippedBox = (node: Element) => {
        if (!visibleBounds.has(node)) {
          const rect = box(node)
          let clipped: Rect = intersect(rect, {
            top: 0,
            left: 0,
            width: innerWidth,
            height: innerHeight,
          })
          let hidden = ['hidden', 'collapse'].includes(style(node).visibility)
          for (
            let ancestor: HTMLElement | null = node as HTMLElement;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            const css = style(ancestor)
            if (css.display === 'none' || (css.opacity !== '' && Number(css.opacity) === 0))
              hidden = true
            if (ancestor === node) continue
            const clipX = ['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowX)
            const clipY = ['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowY)
            if (clipX || clipY) {
              const a = box(ancestor)
              const sx = ancestor.offsetWidth ? a.width / ancestor.offsetWidth : 1
              const sy = ancestor.offsetHeight ? a.height / ancestor.offsetHeight : 1
              const left = clipX ? a.left + ancestor.clientLeft * sx : clipped.left
              const top = clipY ? a.top + ancestor.clientTop * sy : clipped.top
              clipped = intersect(clipped, {
                left,
                top,
                width: clipX ? ancestor.clientWidth * sx : clipped.width,
                height: clipY ? ancestor.clientHeight * sy : clipped.height,
              })
            }
          }
          visibleBounds.set(node, hidden ? { ...clipped, width: 0, height: 0 } : clipped)
        }
        return visibleBounds.get(node)!
      }
      // Long image lists must not compare every region with every other region.
      // Rebuild this interval index from the cached rectangles once per layout sample.
      type Candidate = { node: HTMLElement; rect: Rect }
      type PaintIndex = {
        center: number
        middle: Candidate[]
        left?: PaintIndex
        right?: PaintIndex
      }
      const indexPaint = (items: Candidate[]): PaintIndex | undefined => {
        if (!items.length) return
        const center = items[Math.floor(items.length / 2)]!.rect.top
        const left: Candidate[] = [],
          right: Candidate[] = [],
          middle: Candidate[] = []
        for (const item of items) {
          if (item.rect.top + item.rect.height <= center) left.push(item)
          else if (item.rect.top > center) right.push(item)
          else middle.push(item)
        }
        return { center, middle, left: indexPaint(left), right: indexPaint(right) }
      }
      const paintIndex = indexPaint(
        paintCandidates
          .map((node) => ({ node, rect: clippedBox(node) }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0)
          .sort((a, b) => a.rect.top - b.rect.top),
      )
      function* overlaps(index: PaintIndex | undefined, rect: Rect): Generator<Candidate> {
        if (!index) return
        for (const item of index.middle)
          if (item.rect.top < rect.top + rect.height && item.rect.top + item.rect.height > rect.top)
            yield item
        if (rect.top < index.center) yield* overlaps(index.left, rect)
        if (rect.top + rect.height > index.center) yield* overlaps(index.right, rect)
      }
      const scrollRoot = document.querySelector<HTMLElement>('[data-srl-host-scroll]')
      const scrollBox = scrollRoot?.getBoundingClientRect()
      const message = {
        type: 'native',
        nonce,
        // Collapsed margins can move the natural root down; report its document bottom.
        hostScrollHeight: scrollBox
          ? Math.max(0, scrollBox.height + (scrollBox.top || 0) + scrollY)
          : null,
        regions: [...regions]
          .filter(([node]) => node.isConnected)
          .map(([node, id]) => {
            const rect = box(node)
            const clipped = clippedBox(node)
            let visible = !clipped.width || !clipped.height ? [] : [clipped]
            for (const { node: cover, rect: coverRect } of overlaps(paintIndex, clipped)) {
              if (!visible.length) break
              if (cover === node || cover.contains(node) || !cover.isConnected) continue
              const overlap = intersect(clipped, coverRect)
              if (overlap.width && overlap.height && frontOf(cover, node as HTMLElement, overlap))
                visible = visible.flatMap((part) => subtract(part, overlap))
            }
            return {
              id,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              visibleRects: visible.map((part) => ({
                ...part,
                top: part.top - rect.top,
                left: part.left - rect.left,
              })),
            }
          }),
      }
      changes.observe(document.documentElement, mutationOptions)
      const key = JSON.stringify(message)
      if (key !== lastPlacement) {
        lastPlacement = key
        port?.postMessage(message)
      }
      if (regions.size && document.visibilityState !== 'hidden' && runningLayoutAnimation())
        placeRegions()
    })
  }
  const sizes = new ResizeObserver(placeRegions)
  const observeRegions = () => {
    if (failed) return
    paintCandidatesDirty = true
    sizes.disconnect()
    regions.clear()
    for (const node of document.querySelectorAll<HTMLElement>('[data-srl-native]')) {
      regions.set(node, node.dataset.srlNative!)
      sizes.observe(node)
    }
    const scrollRoot = document.querySelector<HTMLElement>('[data-srl-host-scroll]')
    if (scrollRoot) sizes.observe(scrollRoot)
    placeRegions()
  }
  const changes = new MutationObserver(observeRegions)
  changes.observe(document.documentElement, mutationOptions)
  window.addEventListener('resize', placeRegions)
  document.addEventListener('scroll', placeRegions, true)
  for (const event of [
    'transitionrun',
    'transitionend',
    'transitioncancel',
    'animationstart',
    'animationend',
    'animationcancel',
    'visibilitychange',
    'pointerover',
    'pointerout',
    'focusin',
    'focusout',
  ])
    document.addEventListener(event, placeRegions, true)
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
      /** Invalidate after author-driven layout/animation APIs that do not change DOM attributes. */
      refreshLayout: placeRegions,
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
    placeRegions()
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
      placeRegions()
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
    placeRegions()
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
    changes.disconnect()
    sizes.disconnect()
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
