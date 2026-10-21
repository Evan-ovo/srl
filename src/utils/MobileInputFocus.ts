const INPUT_VIEWPORT_PADDING = 12

interface ViewportBounds {
  height: number
  offsetTop: number
}

interface ElementBounds {
  top: number
  bottom: number
}

export type MobileEditableElement =
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement

/** Native focus is retargeted to the host of built-in open shadow surfaces. */
export function getMobileActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

export function isMobileEditableElement(element: Element | null): element is MobileEditableElement {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )
    return true
  return (
    element instanceof HTMLElement &&
    element.getAttribute('contenteditable') !== null &&
    element.getAttribute('contenteditable') !== 'false'
  )
}

export interface MobileInputFocusDiagnostic {
  action: 'avoidance-check' | 'restore'
  target: 'input' | 'textarea' | 'select' | 'contenteditable' | 'element'
  result: 'scrolled' | 'already-visible' | 'not-restored' | 'restored' | 'skipped'
  targetBefore: ElementBounds
  targetAfter: ElementBounds
  containerScrollTopBefore: number | null
  containerScrollTopAfter: number | null
  delta: number | null
  restorable: boolean | null
}

let diagnosticListener: ((event: MobileInputFocusDiagnostic) => void) | undefined

export function setMobileInputFocusDiagnosticListener(
  listener: ((event: MobileInputFocusDiagnostic) => void) | undefined,
): void {
  diagnosticListener = listener
}

function getTargetKind(target: HTMLElement): MobileInputFocusDiagnostic['target'] {
  if (target instanceof HTMLInputElement) return 'input'
  if (target instanceof HTMLTextAreaElement) return 'textarea'
  if (target instanceof HTMLSelectElement) return 'select'
  if (target.matches('[contenteditable]:not([contenteditable="false"])')) return 'contenteditable'
  return 'element'
}

function reportDiagnostic(event: MobileInputFocusDiagnostic): void {
  diagnosticListener?.(event)
}

function getElementBounds(element: HTMLElement): ElementBounds {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom }
}

function getVisibleBounds(
  viewport: ViewportBounds,
  container: HTMLElement,
): ElementBounds | undefined {
  const area = container.getBoundingClientRect()
  // getBoundingClientRect() is already expressed in visual-viewport client
  // coordinates. visualViewport.offsetTop is a layout-viewport offset, so
  // adding it here would move the visible region a second time on iOS.
  const top = Math.max(INPUT_VIEWPORT_PADDING, area.top + INPUT_VIEWPORT_PADDING)
  const bottom = Math.min(
    viewport.height - INPUT_VIEWPORT_PADDING,
    area.bottom - INPUT_VIEWPORT_PADDING,
  )
  return bottom > top ? { top, bottom } : undefined
}

function getScrollableContainer(target: HTMLElement): HTMLElement | undefined {
  const dialog = target.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  let container = target.parentElement
  while (container && container !== document.body && container !== document.documentElement) {
    const styles = getComputedStyle(container)
    if (
      /(auto|scroll|overlay)/.test(styles.overflowY) &&
      container.scrollHeight > container.clientHeight
    )
      return container
    if (container === dialog) break
    container = container.parentElement
  }
  return undefined
}

function getScrollDelta(target: ElementBounds, visible: ElementBounds): number {
  if (target.top < visible.top) return target.top - visible.top
  if (target.bottom > visible.bottom) return target.bottom - visible.bottom
  return 0
}

let personalAvoidance:
  | {
      target: HTMLElement
      container: HTMLElement
      before: number
      applied: number
      restorable: boolean
    }
  | undefined

/** Undo only our own personal-editor avoidance, never a user's later scroll or field change. */
export function restorePersonalInputScroll(): void {
  const previous = personalAvoidance
  personalAvoidance = undefined
  if (!previous || !previous.restorable || !previous.target.isConnected) return
  const before = previous.container.scrollTop
  const active = getMobileActiveElement()
  if (isMobileEditableElement(active) && active !== previous.target) return
  const { container } = previous
  const expected = Math.min(
    previous.applied,
    Math.max(0, container.scrollHeight - container.clientHeight),
  )
  if (container.isConnected && Math.abs(container.scrollTop - expected) <= 1) {
    container.scrollTop = previous.before
    const targetBounds = getElementBounds(previous.target)
    reportDiagnostic({
      action: 'restore',
      target: getTargetKind(previous.target),
      result: 'restored',
      targetBefore: targetBounds,
      targetAfter: targetBounds,
      containerScrollTopBefore: before,
      containerScrollTopAfter: container.scrollTop,
      delta: container.scrollTop - before,
      restorable: true,
    })
  } else {
    const targetBounds = getElementBounds(previous.target)
    reportDiagnostic({
      action: 'restore',
      target: getTargetKind(previous.target),
      result: 'not-restored',
      targetBefore: targetBounds,
      targetAfter: targetBounds,
      containerScrollTopBefore: before,
      containerScrollTopAfter: container.scrollTop,
      delta: 0,
      restorable: true,
    })
  }
}

/**
 * iOS 打开软键盘时会自行滚动焦点元素。只有元素仍落在视觉视口外时，
 * 才做最小距离补偿，避免与系统滚动和键盘动画叠加。
 */
export function revealMobileInputIfOccluded(
  target: MobileEditableElement,
  viewport: ViewportBounds,
): boolean {
  const bounds = target.getBoundingClientRect()
  const targetKind = getTargetKind(target)
  const container = getScrollableContainer(target)
  const before = container?.scrollTop ?? null
  const visible = container ? getVisibleBounds(viewport, container) : undefined
  const delta = visible ? getScrollDelta(bounds, visible) : 0

  if (!container || !visible) {
    const targetBounds = getElementBounds(target)
    reportDiagnostic({
      action: 'avoidance-check',
      target: targetKind,
      // An off-screen container is not an "already visible" field. The host
      // document owns that displacement, and we must not scroll it here.
      result: 'skipped',
      targetBefore: { top: bounds.top, bottom: bounds.bottom },
      targetAfter: targetBounds,
      containerScrollTopBefore: before,
      containerScrollTopAfter: before,
      delta: 0,
      restorable: null,
    })
    return false
  }

  if (!delta) {
    const targetBounds = getElementBounds(target)
    reportDiagnostic({
      action: 'avoidance-check',
      target: targetKind,
      result: 'already-visible',
      targetBefore: { top: bounds.top, bottom: bounds.bottom },
      targetAfter: targetBounds,
      containerScrollTopBefore: before,
      containerScrollTopAfter: before,
      delta: 0,
      restorable: personalAvoidance?.target === target ? personalAvoidance.restorable : null,
    })
    return false
  }

  const dialog = target.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  if (dialog?.matches('.personal-resource-editor')) {
    if (!personalAvoidance) {
      personalAvoidance = {
        target,
        container,
        before: container.scrollTop,
        applied: container.scrollTop,
        restorable: true,
      }
    } else if (
      personalAvoidance.target !== target ||
      personalAvoidance.container !== container ||
      Math.abs(container.scrollTop - personalAvoidance.applied) > 1
    ) {
      personalAvoidance.restorable = false
    }
  }
  container.scrollTop += delta
  if (personalAvoidance?.container === container) personalAvoidance.applied = container.scrollTop
  const targetBounds = getElementBounds(target)
  reportDiagnostic({
    action: 'avoidance-check',
    target: targetKind,
    result: 'scrolled',
    targetBefore: { top: bounds.top, bottom: bounds.bottom },
    targetAfter: targetBounds,
    containerScrollTopBefore: before,
    containerScrollTopAfter: container.scrollTop,
    delta: container.scrollTop - (before ?? container.scrollTop),
    restorable: personalAvoidance?.target === target ? personalAvoidance.restorable : null,
  })
  return true
}

export function isElementOccludedByViewport(
  element: ElementBounds,
  viewport: ViewportBounds,
): boolean {
  // Element client rects and visualViewport.height share the visual viewport's
  // coordinate space. offsetTop deliberately does not participate here.
  const viewportTop = INPUT_VIEWPORT_PADDING
  const viewportBottom = viewport.height - INPUT_VIEWPORT_PADDING
  return element.top < viewportTop || element.bottom > viewportBottom
}
