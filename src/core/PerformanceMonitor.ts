import { BUILD_INFO } from './BuildInfo'
import {
  setMobileInputFocusDiagnosticListener,
  type MobileInputFocusDiagnostic,
} from '../utils/MobileInputFocus'

export interface PerformanceSnapshot {
  firstInteractiveMs: number | null
  firstListRenderMs: number | null
  firstListItemCount: number | null
  estimatedDroppedFrames: number
  longestTaskMs: number | null
  longTaskCount: number
}

const snapshot: PerformanceSnapshot = {
  firstInteractiveMs: null,
  firstListRenderMs: null,
  firstListItemCount: null,
  estimatedDroppedFrames: 0,
  longestTaskMs: null,
  longTaskCount: 0,
}

let bootStartedAt = 0
let listStartedAt = 0
let panel: HTMLDetailsElement | undefined
let panelMetrics: HTMLElement | undefined
let panelNote: HTMLElement | undefined
let safeAreaProbe: HTMLElement | undefined
let scrollingUntil = 0
let scrollFrame = 0
let previousFrameAt = 0
let scrollListener: (() => void) | undefined
let longTaskObserver: PerformanceObserver | undefined
let diagnosticsInstalled = false
let diagnosticsFrame = 0
let diagnosticSessionStartedAt = 0
// Only enabled by the existing monitor switch; session-only, bounded and without field values.
const keyboardSamples: Array<Record<string, unknown>> = []
const keyboardEvents: Array<Record<string, unknown>> = []
let lastKeyboardGeometry = ''

const interactionEventTypes = [
  'pointerdown',
  'pointerup',
  'click',
  'focusin',
  'focusout',
  'blur',
  'beforeinput',
  'input',
  'change',
  'compositionstart',
  'compositionend',
] as const

type InteractionEventType = (typeof interactionEventTypes)[number]
const interactionListeners = new Map<InteractionEventType, (event: Event) => void>()

function roundDiagnostic(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value * 100) / 100
}

function getDisplayMode(): string {
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  const mediaStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  if (iosStandalone || mediaStandalone) return 'standalone'
  return 'browser'
}

function getViewportDiagnosticState(): Record<string, unknown> {
  const viewport = window.visualViewport
  const innerHeight = window.innerHeight
  const visualHeight = viewport?.height ?? innerHeight
  const keyboardDelta = innerHeight - visualHeight
  return {
    innerHeight: roundDiagnostic(innerHeight),
    visualHeight: roundDiagnostic(viewport?.height),
    offsetTop: roundDiagnostic(viewport?.offsetTop),
    offsetLeft: roundDiagnostic(viewport?.offsetLeft),
    pageTop: roundDiagnostic(viewport?.pageTop),
    scale: roundDiagnostic(viewport?.scale),
    keyboardDelta: roundDiagnostic(keyboardDelta),
    keyboardLikelyOpen: document.documentElement.dataset.iosKeyboardOpen === 'true',
  }
}

function describeElement(element: Element | null | undefined): string {
  if (!element) return 'none'
  if (element.closest('#srl-performance-monitor')) return 'monitor'
  if (
    element.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  ) {
    if (element instanceof HTMLInputElement) return `input:${element.type || 'text'}`
    if (element instanceof HTMLTextAreaElement) return 'textarea'
    if (element instanceof HTMLSelectElement) return 'select'
    return 'contenteditable'
  }
  if (element.closest('[role="dialog"], [role="alertdialog"]')) return 'dialog'
  if (element.closest('.editor-overlay, .mobile-dialog-viewport')) return 'overlay'
  return element.tagName.toLowerCase()
}

function getInputDiagnostic(element: Element | null | undefined): Record<string, unknown> | null {
  if (
    !element?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  )
    return null
  const rect = element.getBoundingClientRect()
  const input = element instanceof HTMLInputElement ? element : null
  const textarea = element instanceof HTMLTextAreaElement ? element : null
  const select = element instanceof HTMLSelectElement ? element : null
  return {
    kind: describeElement(element),
    disabled: input?.disabled ?? textarea?.disabled ?? select?.disabled ?? false,
    readOnly: input?.readOnly ?? textarea?.readOnly ?? false,
    tabIndex: (element as HTMLElement).tabIndex,
    box: {
      top: roundDiagnostic(rect.top),
      bottom: roundDiagnostic(rect.bottom),
      height: roundDiagnostic(rect.height),
    },
    fontSize: getComputedStyle(element).fontSize,
  }
}

function describePointHit(clientX: number, clientY: number): string | null {
  if (!document.elementFromPoint) return null
  try {
    return describeElement(document.elementFromPoint(clientX, clientY))
  } catch {
    return null
  }
}

function recordInteractionEvent(type: InteractionEventType, event: Event): void {
  if (!shouldShowPerformancePanel() || !isIosStandalonePwa()) return
  const target = event.target instanceof Element ? event.target : null
  const pointer =
    typeof PointerEvent !== 'undefined' && event instanceof PointerEvent ? event : null
  keyboardEvents.push({
    ms: Math.round(performance.now()),
    type,
    target: describeElement(target),
    activeElement: describeElement(document.activeElement),
    input: getInputDiagnostic(target),
    defaultPrevented: event.defaultPrevented,
    ...(pointer
      ? {
          pointerType: pointer.pointerType || null,
          isPrimary: pointer.isPrimary,
          clientX: roundDiagnostic(pointer.clientX),
          clientY: roundDiagnostic(pointer.clientY),
          hit: describePointHit(pointer.clientX, pointer.clientY),
        }
      : {}),
    viewport: getViewportDiagnosticState(),
  })
  if (keyboardEvents.length > 80) keyboardEvents.shift()
  // Capture before the click closes a settled modal, then after its UI update.
  // Opening samples alone may still be inside the entrance transition.
  if (type === 'click') {
    sampleKeyboardGeometry()
    scheduleDiagnosticsRender()
  }
}

function recordMobileInputFocusDiagnostic(event: MobileInputFocusDiagnostic): void {
  if (!shouldShowPerformancePanel() || !isIosStandalonePwa()) return
  keyboardEvents.push({
    ms: Math.round(performance.now()),
    type: `focus-scroll:${event.action}`,
    ...event,
    viewport: getViewportDiagnosticState(),
  })
  if (keyboardEvents.length > 80) keyboardEvents.shift()
}

function getEnvironmentDiagnostic(): Record<string, unknown> {
  const nav = navigator as Navigator & { standalone?: boolean }
  const serviceWorker = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined
  return {
    userAgent: navigator.userAgent || null,
    platform: navigator.platform || null,
    maxTouchPoints: navigator.maxTouchPoints ?? null,
    devicePixelRatio: roundDiagnostic(window.devicePixelRatio),
    screen: { width: window.screen?.width ?? null, height: window.screen?.height ?? null },
    online: navigator.onLine,
    visibility: document.visibilityState,
    displayMode: getDisplayMode(),
    iosStandalone: Boolean(nav.standalone),
    mediaStandalone:
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches,
    hasVisualViewport: Boolean(window.visualViewport),
    serviceWorker: serviceWorker
      ? {
          supported: true,
          controlled: Boolean(serviceWorker.controller),
        }
      : { supported: false, controlled: false },
  }
}

function getNavigation(): HTMLElement | null {
  // Plaza replaces the host navigation while its APP is open.
  return (
    document.querySelector<HTMLElement>('.plaza-navigation') ??
    document.querySelector<HTMLElement>('.mobile-bottom-nav')
  )
}

function sampleKeyboardGeometry(): void {
  if (!shouldShowPerformancePanel() || !isIosStandalonePwa()) return
  const viewport = window.visualViewport
  const active = document.activeElement
  const focusedDialog = active?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  const focusedPage = active?.closest<HTMLElement>('.srl-independent-page')
  const dialog =
    focusedDialog ??
    [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .at(-1)
  const page =
    focusedPage ??
    [...document.querySelectorAll<HTMLElement>('.srl-independent-page')]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .at(-1)
  const overlay =
    page ?? dialog?.closest<HTMLElement>('.editor-overlay, .mobile-dialog-viewport, .action-sheet')
  const round = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 100) / 100
  const geometry = (element: Element | null | undefined) => {
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) }
  }
  const input = active?.matches(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  )
    ? active
    : null
  const rootStyle = getComputedStyle(document.documentElement)
  const overlayStyle = overlay ? getComputedStyle(overlay) : null
  const nav = getNavigation()
  const navStyle = nav ? getComputedStyle(nav) : null
  // Rectangles alone do not describe clipping or hit testing. Keep both coordinate
  // hypotheses: iOS and desktop engines need not report viewport panning alike.
  // These are read-only probes, not evidence of the pixels actually painted.
  const hitRows = (originY: number) => {
    if (!overlay || !document.elementFromPoint) return null
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    const hit = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y)
      if (!element) return 'none'
      if (element.closest('#srl-performance-monitor')) return 'monitor'
      if (dialog?.contains(element)) return 'dialog'
      if (page?.contains(element)) return 'page'
      if (overlay.contains(element)) return 'overlay'
      return 'outside'
    }
    return [0.25, 0.5, 0.75, 0.98].map((fraction) => {
      const y = originY + height * fraction
      return {
        y: round(y),
        left: hit(width * 0.25, y),
        right: hit(width * 0.75, y),
      }
    })
  }
  const ancestors = []
  let ancestor: HTMLElement | null = overlay ?? null
  // Bound diagnostics even with deeply nested/custom layouts. Never collect text,
  // selectors, attributes or input values from the sampled elements.
  while (ancestor && ancestors.length < 8) {
    const style = getComputedStyle(ancestor)
    ancestors.push({
      box: geometry(ancestor),
      clientHeight: ancestor.clientHeight,
      scrollHeight: ancestor.scrollHeight,
      scrollTop: round(ancestor.scrollTop),
      position: style.position,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      transformed: style.transform !== 'none' && style.transform !== '',
      paintContainment: /\b(paint|strict|content)\b/.test(style.contain),
      clipped: style.clipPath !== 'none' && style.clipPath !== '',
    })
    ancestor = ancestor.parentElement
  }
  const state = {
    innerHeight: round(window.innerHeight),
    visualHeight: round(viewport?.height),
    offsetTop: round(viewport?.offsetTop),
    pageTop: round(viewport?.pageTop),
    scale: round(viewport?.scale),
    scrollY: round(window.scrollY),
    rootScrollTop: round(document.documentElement.scrollTop),
    root: geometry(document.documentElement),
    rootClientHeight: document.documentElement.clientHeight,
    body: geometry(document.body),
    keyboardOpen: document.documentElement.dataset.iosKeyboardOpen === 'true',
    viewportReduced: document.documentElement.dataset.visualViewportReduced === 'true',
    navigation: nav
      ? {
          kind: nav.matches('.plaza-navigation') ? 'plaza' : 'main',
          box: geometry(nav),
          visibility: navStyle?.visibility,
          display: navStyle?.display,
          pointerEvents: navStyle?.pointerEvents,
          position: navStyle?.position,
          bottom: navStyle?.bottom,
        }
      : null,
    modalLocked: document.body.classList.contains('modal-open'),
    page: overlay?.matches('.srl-independent-page')
      ? 'independent-page'
      : overlay?.matches('.action-sheet')
        ? 'action-sheet'
        : overlay?.matches('.resource-detail-page')
          ? 'resource-detail'
          : overlay?.matches('.layout-settings-overlay, .layout-settings-page')
            ? 'settings'
            : dialog
              ? 'other-dialog'
              : 'page',
    overlay: geometry(overlay),
    overlayPosition: overlayStyle?.position ?? null,
    overlayTop: overlayStyle?.top ?? null,
    dialog: geometry(dialog),
    dialogScrollTop: round(
      (dialog?.querySelector<HTMLElement>('.resource-detail__layout') ?? dialog)?.scrollTop,
    ),
    input: geometry(input),
    inputFontSize: input ? getComputedStyle(input).fontSize : null,
    cssHeight: rootStyle.getPropertyValue('--visual-viewport-height').trim(),
    cssLayoutHeight: rootStyle.getPropertyValue('--layout-viewport-height').trim(),
    safeTop: safeAreaProbe
      ? Number.parseFloat(getComputedStyle(safeAreaProbe).paddingTop) || 0
      : null,
    cssOffsetTop: rootStyle.getPropertyValue('--visual-viewport-offset-top').trim(),
    hitRowsFromZero: hitRows(0),
    hitRowsFromOffset: viewport?.offsetTop ? hitRows(viewport.offsetTop) : null,
    overlayAncestors: ancestors,
  }
  const signature = JSON.stringify(state)
  if (signature === lastKeyboardGeometry) return
  lastKeyboardGeometry = signature
  keyboardSamples.push({ ms: Math.round(performance.now()), ...state })
  if (keyboardSamples.length > 40) keyboardSamples.shift()
}

export function getKeyboardDiagnosticText(): string {
  // Opening a non-input surface need not change the viewport. Capture the
  // requested state now instead of copying only an earlier settings snapshot.
  sampleKeyboardGeometry()
  return JSON.stringify(
    {
      schemaVersion: 2,
      capturedAt: new Date(diagnosticSessionStartedAt || Date.now()).toISOString(),
      buildId: BUILD_INFO.buildId,
      workerDeployVersion: BUILD_INFO.workerDeployVersion,
      environment: getEnvironmentDiagnostic(),
      events: keyboardEvents,
      samples: keyboardSamples,
    },
    null,
    2,
  )
}

const visibilityStorageKey = 'srl.performance-monitor.visible'
const positionStorageKey = 'srl.performance-monitor.position'
const dragMargin = 8

function shouldShowPerformancePanel(): boolean {
  try {
    return window.localStorage.getItem(visibilityStorageKey) === 'true'
  } catch {
    return false
  }
}

function isIosStandalonePwa(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  const isAppleMobile =
    /iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1)
  if (!isAppleMobile) return false
  const iosStandalone = Boolean(nav.standalone)
  const mediaStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  return iosStandalone || mediaStandalone
}

function formatDuration(value: number | null): string {
  return value === null ? '等待记录' : `${Math.round(value)} ms`
}

function renderMetrics(rows: Array<[string, string]>): void {
  if (!panelMetrics) return
  // Preserve scroll geometry while refreshing: WebKit clamps scrollTop if the
  // metrics are cleared before the geometry reads in getIosGeometryRows().
  rows.forEach(([label, value], index) => {
    let row = panelMetrics!.children[index]
    if (!row) {
      row = document.createElement('p')
      row.className = 'srl-performance-monitor__metric'
      row.append(document.createElement('span'), document.createElement('strong'))
      panelMetrics!.append(row)
    }
    if (row.children[0]!.textContent !== label) row.children[0]!.textContent = label
    if (row.children[1]!.textContent !== value) row.children[1]!.textContent = value
  })
  while (panelMetrics.children.length > rows.length) panelMetrics.lastElementChild!.remove()
}

function getIosGeometryRows(): Array<[string, string]> {
  const viewport = window.visualViewport
  const viewportHeight = viewport?.height ?? window.innerHeight
  const viewportBottom = (viewport?.offsetTop ?? 0) + viewportHeight
  const nav = getNavigation()
  const navRect = nav?.getBoundingClientRect()
  const rootStyle = getComputedStyle(document.documentElement)
  // SystemInsetsService supplies env()/CSS expressions on the web; measure their resolved value.
  const safeBottom = safeAreaProbe
    ? Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom) || 0
    : 0
  const appViewport = rootStyle.getPropertyValue('--app-viewport-height').trim() || '未设置'
  const contentHeight = Number.parseFloat(appViewport)
  const contentBottom =
    (viewport?.offsetTop ?? 0) +
    (Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : viewportHeight)
  const navGap = navRect ? contentBottom - navRect.bottom : null
  const rawNavGap = navRect ? viewportBottom - navRect.bottom : null

  let verdict = '等待底栏渲染'
  if (navGap !== null) {
    if (Math.abs(navGap) <= 1) verdict = '底栏已贴视口底部'
    else if (navGap > 1) verdict = `底栏上浮 ${Math.round(navGap)}px`
    else verdict = `底栏超出 ${Math.round(Math.abs(navGap))}px`
  }
  if (appViewport.includes('safe-bottom')) verdict += ' · App 高度仍含 safe-bottom'

  return [
    ['打开方式', getDisplayMode()],
    ['键盘状态', getViewportDiagnosticState().keyboardLikelyOpen ? '可能已弹起' : '未检测到弹起'],
    ['当前焦点', describeElement(document.activeElement)],
    ['最近事件', String(keyboardEvents.at(-1)?.type ?? '暂无')],
    ['inner / visual', `${Math.round(window.innerHeight)} / ${Math.round(viewportHeight)} px`],
    ['visual offsetTop', `${Math.round(viewport?.offsetTop ?? 0)} px`],
    [
      '底栏 bottom / height',
      navRect ? `${Math.round(navRect.bottom)} / ${Math.round(navRect.height)} px` : '未找到',
    ],
    ['底栏差值', navGap === null ? '未找到' : `${Math.round(navGap * 100) / 100} px`],
    ['原生 visual 差值', rawNavGap === null ? '未找到' : `${Math.round(rawNavGap * 100) / 100} px`],
    ['safe-bottom', `${Math.round(safeBottom * 100) / 100} px`],
    ['App viewport', appViewport],
    ['判定', verdict],
  ]
}

function readSavedPosition(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(positionStorageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown }
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null
    return { left: parsed.left, top: parsed.top }
  } catch {
    return null
  }
}

function savePanelPosition(left: number, top: number): void {
  try {
    window.localStorage.setItem(positionStorageKey, JSON.stringify({ left, top }))
  } catch {
    // 受限存储下仅保留当前会话位置。
  }
}

function clampPanelPosition(left: number, top: number): { left: number; top: number } {
  if (!panel) return { left, top }
  const width = panel.offsetWidth
  const height = panel.offsetHeight
  const viewport = window.visualViewport
  const offsetLeft = viewport?.offsetLeft ?? 0
  const offsetTop = viewport?.offsetTop ?? 0
  const safeArea = safeAreaProbe ? getComputedStyle(safeAreaProbe) : undefined
  const minLeft = offsetLeft + (parseFloat(safeArea?.paddingLeft ?? '') || 0) + dragMargin
  const minTop = offsetTop + (parseFloat(safeArea?.paddingTop ?? '') || 0) + dragMargin
  const maxLeft =
    offsetLeft +
    (viewport?.width ?? window.innerWidth) -
    (parseFloat(safeArea?.paddingRight ?? '') || 0) -
    width -
    dragMargin
  const maxTop =
    offsetTop +
    (viewport?.height ?? window.innerHeight) -
    (parseFloat(safeArea?.paddingBottom ?? '') || 0) -
    height -
    dragMargin
  return {
    left: Math.min(Math.max(minLeft, left), Math.max(minLeft, maxLeft)),
    // Keep the drag handle reachable even when the expanded panel is taller than the viewport.
    top: Math.min(Math.max(minTop, top), Math.max(minTop, maxTop)),
  }
}

function applyPanelPosition(left: number, top: number, persist = false): void {
  if (!panel) return
  const next = clampPanelPosition(left, top)
  panel.style.left = `${next.left}px`
  panel.style.top = `${next.top}px`
  panel.style.right = 'auto'
  panel.style.bottom = 'auto'
  panel.dataset.positioned = 'true'
  if (persist) savePanelPosition(next.left, next.top)
}

function restorePanelPosition(): void {
  requestAnimationFrame(() => {
    const saved = readSavedPosition()
    if (saved && panel) applyPanelPosition(saved.left, saved.top)
  })
}

export function resetPerformanceMonitorPosition(): void {
  try {
    window.localStorage.removeItem(positionStorageKey)
  } catch {
    // Storage restrictions must not prevent recovery of the visible capsule.
  }
  if (!panel) return
  panel.open = false
  for (const property of ['left', 'top', 'right', 'bottom']) panel.style.removeProperty(property)
  delete panel.dataset.positioned
  const rect = panel.getBoundingClientRect()
  const next = clampPanelPosition(rect.left, rect.top)
  if (next.left !== rect.left || next.top !== rect.top) applyPanelPosition(next.left, next.top)
}

function clampSavedPanelPosition(): void {
  if (!panel || panel.dataset.positioned !== 'true') return
  const rect = panel.getBoundingClientRect()
  applyPanelPosition(rect.left, rect.top, true)
}

function installPanelDragging(summary: HTMLElement): void {
  let suppressNextSummaryClick = false
  summary.addEventListener(
    'click',
    (event) => {
      if (!suppressNextSummaryClick || event.detail === 0) return
      suppressNextSummaryClick = false
      event.preventDefault()
      event.stopPropagation()
    },
    true,
  )

  summary.addEventListener('pointerdown', (event) => {
    if (!panel || event.button !== 0 || !event.isPrimary) return
    suppressNextSummaryClick = false
    const startRect = panel.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    let dragged = false

    summary.setPointerCapture(event.pointerId)

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      const deltaX = moveEvent.clientX - startX
      const deltaY = moveEvent.clientY - startY
      if (!dragged && Math.hypot(deltaX, deltaY) < 4) return
      dragged = true
      panel?.setAttribute('data-dragging', 'true')
      applyPanelPosition(startRect.left + deltaX, startRect.top + deltaY)
      moveEvent.preventDefault()
    }

    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return
      summary.removeEventListener('pointermove', onMove)
      summary.removeEventListener('pointerup', finish)
      summary.removeEventListener('pointercancel', finish)
      summary.removeEventListener('lostpointercapture', finish)
      panel?.removeAttribute('data-dragging')
      // Touch can omit its compatibility click after moving the capsule. Complete a tap here;
      // suppress only the duplicate pointer click, preserving native keyboard activation.
      if (!dragged && panel && endEvent.type === 'pointerup' && endEvent.pointerType === 'touch') {
        panel.open = !panel.open
        suppressNextSummaryClick = true
      }
      if (dragged && panel) {
        const rect = panel.getBoundingClientRect()
        applyPanelPosition(rect.left, rect.top, true)
        suppressNextSummaryClick = endEvent.type === 'pointerup'
      }
    }

    summary.addEventListener('pointermove', onMove)
    summary.addEventListener('pointerup', finish)
    summary.addEventListener('pointercancel', finish)
    summary.addEventListener('lostpointercapture', finish)
  })
}

function renderPanel(): void {
  if (!panel || !panelMetrics) return
  if (!shouldShowPerformancePanel()) {
    removePanel()
    return
  }

  const iosDiagnosticsVisible = isIosStandalonePwa()
  sampleKeyboardGeometry()
  const summaryLabel = panel.querySelector<HTMLElement>('summary span')
  if (summaryLabel) summaryLabel.textContent = iosDiagnosticsVisible ? '性能 · iOS' : '性能'

  const headerSmall = panel.querySelector<HTMLElement>(
    '.srl-performance-monitor__body > header small',
  )
  const headerStrong = panel.querySelector<HTMLElement>(
    '.srl-performance-monitor__body > header strong',
  )
  if (headerSmall)
    headerSmall.textContent = iosDiagnosticsVisible ? '本机观测 · iOS 几何' : '本机观测'
  if (headerStrong) headerStrong.textContent = '本次页面会话'

  const rows: Array<[string, string]> = [
    ['首屏可交互', formatDuration(snapshot.firstInteractiveMs)],
    [
      '列表首批渲染',
      snapshot.firstListRenderMs === null
        ? '等待记录'
        : `${Math.round(snapshot.firstListRenderMs)} ms · ${snapshot.firstListItemCount ?? 0} 项`,
    ],
    ['滚动估算掉帧', `${snapshot.estimatedDroppedFrames} 帧`],
    [
      '长任务',
      snapshot.longestTaskMs === null
        ? '浏览器未报告'
        : `${Math.round(snapshot.longestTaskMs)} ms · ${snapshot.longTaskCount} 次`,
    ],
  ]
  if (iosDiagnosticsVisible) {
    rows.unshift(['当前页面', BUILD_INFO.workerDeployVersion], ...getIosGeometryRows())
  }
  renderMetrics(rows)

  if (panelNote) {
    panelNote.hidden = !iosDiagnosticsVisible
    panelNote.textContent =
      'iOS 诊断：底栏差值应接近 0；safe-bottom 是 Home Indicator 保护区；App viewport 不应再次叠加 safe-bottom。'
  }
}

function createPanel(): void {
  if (panel || !document.body || !shouldShowPerformancePanel()) return

  panel = document.createElement('details')
  panel.id = 'srl-performance-monitor'
  panel.className = 'srl-performance-monitor'
  panel.innerHTML =
    '<summary><i aria-hidden="true"></i><span>性能</span><b aria-hidden="true">⌄</b></summary>'

  const summary = panel.querySelector<HTMLElement>('summary')
  if (summary) installPanelDragging(summary)

  const panelBody = document.createElement('div')
  panelBody.className = 'srl-performance-monitor__body'
  panelBody.setAttribute('aria-live', 'polite')

  const header = document.createElement('header')
  header.innerHTML = '<small>本机观测</small><strong>本次页面会话</strong>'

  panelMetrics = document.createElement('div')
  panelMetrics.className = 'srl-performance-monitor__metrics'

  panelNote = document.createElement('p')
  panelNote.className = 'srl-performance-monitor__note'

  panelBody.append(header, panelMetrics, panelNote)
  if (isIosStandalonePwa()) {
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'srl-performance-monitor__copy'
    copyButton.textContent = '复制键盘诊断'
    const manualCopy = document.createElement('textarea')
    manualCopy.className = 'srl-performance-monitor__diagnostic-text'
    manualCopy.readOnly = true
    manualCopy.hidden = true
    manualCopy.setAttribute('aria-label', '键盘诊断文本')
    copyButton.addEventListener('click', async () => {
      const text = getKeyboardDiagnosticText()
      try {
        await navigator.clipboard.writeText(text)
        copyButton.textContent = '已复制键盘诊断'
        manualCopy.hidden = true
      } catch {
        manualCopy.value = text
        manualCopy.hidden = false
        copyButton.textContent = '请长按下方文本复制'
      }
    })
    const note = document.createElement('p')
    note.className = 'srl-performance-monitor__note'
    note.textContent =
      '复现后收起键盘，再复制诊断。仅保留本次开启期间最近 40 次位置变化，不含输入内容；关闭胶囊即清除。'
    panelBody.append(copyButton, manualCopy, note)
  }
  panel.append(panelBody)
  safeAreaProbe = document.createElement('div')
  safeAreaProbe.className = 'srl-performance-monitor__safe-area-probe'
  safeAreaProbe.setAttribute('aria-hidden', 'true')
  safeAreaProbe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)'
  panel.append(safeAreaProbe)
  // Async APP navigation may mount after the last viewport sample. Opening the
  // existing capsule must read the current surface, not display startup metrics.
  panel.addEventListener('toggle', scheduleDiagnosticsRender)
  document.body.append(panel)
  restorePanelPosition()
  renderPanel()
}

function removePanel(): void {
  panel?.remove()
  panel = undefined
  panelMetrics = undefined
  panelNote = undefined
  safeAreaProbe = undefined
}

function scheduleDiagnosticsRender(): void {
  if (diagnosticsFrame || !shouldShowPerformancePanel()) return
  diagnosticsFrame = requestAnimationFrame(() => {
    diagnosticsFrame = 0
    createPanel()
    renderPanel()
    clampSavedPanelPosition()
  })
}

function installDiagnosticsListeners(): void {
  if (diagnosticsInstalled) return
  diagnosticsInstalled = true
  window.addEventListener('resize', scheduleDiagnosticsRender, { passive: true })
  window.addEventListener('orientationchange', scheduleDiagnosticsRender, { passive: true })
  window.addEventListener('pageshow', scheduleDiagnosticsRender, { passive: true })
  window.visualViewport?.addEventListener('resize', scheduleDiagnosticsRender, { passive: true })
  window.visualViewport?.addEventListener('scroll', scheduleDiagnosticsRender, { passive: true })
  interactionEventTypes.forEach((type) => {
    const listener = (event: Event) => recordInteractionEvent(type, event)
    interactionListeners.set(type, listener)
    document.addEventListener(type, listener, true)
  })
  setMobileInputFocusDiagnosticListener(recordMobileInputFocusDiagnostic)
}

function uninstallDiagnosticsListeners(): void {
  if (!diagnosticsInstalled) return
  diagnosticsInstalled = false
  window.removeEventListener('resize', scheduleDiagnosticsRender)
  window.removeEventListener('orientationchange', scheduleDiagnosticsRender)
  window.removeEventListener('pageshow', scheduleDiagnosticsRender)
  window.visualViewport?.removeEventListener('resize', scheduleDiagnosticsRender)
  window.visualViewport?.removeEventListener('scroll', scheduleDiagnosticsRender)
  interactionEventTypes.forEach((type) => {
    const listener = interactionListeners.get(type)
    if (listener) document.removeEventListener(type, listener, true)
  })
  interactionListeners.clear()
  setMobileInputFocusDiagnosticListener(undefined)
  if (diagnosticsFrame) cancelAnimationFrame(diagnosticsFrame)
  diagnosticsFrame = 0
}

function trackScrollFrames(): void {
  const now = performance.now()
  if (previousFrameAt) {
    const frameGap = now - previousFrameAt
    if (frameGap > 20)
      snapshot.estimatedDroppedFrames += Math.max(0, Math.floor(frameGap / 16.67) - 1)
  }
  previousFrameAt = now
  if (now < scrollingUntil) scrollFrame = requestAnimationFrame(trackScrollFrames)
  else {
    scrollFrame = 0
    previousFrameAt = 0
    renderPanel()
  }
}

function installLongTaskObserver(): void {
  if (!('PerformanceObserver' in window)) return
  try {
    longTaskObserver = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        snapshot.longTaskCount += 1
        snapshot.longestTaskMs = Math.max(snapshot.longestTaskMs ?? 0, entry.duration)
      }
      renderPanel()
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    // Safari 等浏览器未实现 longtask；面板保留“浏览器未报告”而不伪造数据。
  }
}

function resetSnapshot(): void {
  snapshot.firstInteractiveMs = null
  snapshot.firstListRenderMs = null
  snapshot.firstListItemCount = null
  snapshot.estimatedDroppedFrames = 0
  snapshot.longestTaskMs = null
  snapshot.longTaskCount = 0
}

function stopPerformanceMonitor(): void {
  keyboardSamples.length = 0
  keyboardEvents.length = 0
  diagnosticSessionStartedAt = 0
  lastKeyboardGeometry = ''
  if (scrollListener) {
    window.removeEventListener('scroll', scrollListener, true)
    scrollListener = undefined
  }
  longTaskObserver?.disconnect()
  longTaskObserver = undefined
  uninstallDiagnosticsListeners()
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  scrollFrame = 0
  bootStartedAt = 0
  listStartedAt = 0
  scrollingUntil = 0
  previousFrameAt = 0
  resetSnapshot()
  removePanel()
}

export function markLibraryLoadStarted(): void {
  if (!bootStartedAt) return
  listStartedAt = performance.now()
}

export function markLibraryListRendered(itemCount: number): void {
  if (!bootStartedAt || !listStartedAt || snapshot.firstListRenderMs !== null) return
  requestAnimationFrame(() => {
    snapshot.firstListRenderMs = performance.now() - listStartedAt
    snapshot.firstListItemCount = itemCount
    renderPanel()
  })
}

export function installPerformanceMonitor(): void {
  if (!shouldShowPerformancePanel()) return
  if (bootStartedAt) {
    createPanel()
    renderPanel()
    return
  }

  bootStartedAt = performance.now()
  diagnosticSessionStartedAt = Date.now()
  void import('../styles/PerformanceMonitor.css')
  installDiagnosticsListeners()
  scrollListener = () => {
    scrollingUntil = performance.now() + 160
    if (!scrollFrame) scrollFrame = requestAnimationFrame(trackScrollFrames)
  }
  window.addEventListener('scroll', scrollListener, { capture: true, passive: true })
  installLongTaskObserver()
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      snapshot.firstInteractiveMs = performance.now() - bootStartedAt
      createPanel()
      renderPanel()
    }),
  )
}

export function getPerformanceMonitorVisible(): boolean {
  return shouldShowPerformancePanel()
}

export function setPerformanceMonitorVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(visibilityStorageKey, String(visible))
  } catch {
    // 隐私模式或受限存储下仍可继续当前会话，不把显示偏好写入失败变成页面错误。
  }

  if (!visible) {
    stopPerformanceMonitor()
    return
  }
  installPerformanceMonitor()
}

export function getPerformanceSnapshot(): PerformanceSnapshot {
  return { ...snapshot }
}
