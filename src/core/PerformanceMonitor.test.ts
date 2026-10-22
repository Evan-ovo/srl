/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getKeyboardDiagnosticText,
  getPerformanceMonitorVisible,
  installPerformanceMonitor,
  resetPerformanceMonitorPosition,
  setPerformanceMonitorVisible,
} from './PerformanceMonitor'

describe('PerformanceMonitor', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number
  let viewport: EventTarget & { height: number; offsetTop: number }

  function flushFrames(): void {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(performance.now()))
  }

  function enablePanel(): HTMLDetailsElement {
    setPerformanceMonitorVisible(true)
    flushFrames()
    flushFrames()
    return document.querySelector<HTMLDetailsElement>('#srl-performance-monitor')!
  }

  function metric(label: string): string | null | undefined {
    return [...document.querySelectorAll('.srl-performance-monitor__metric')]
      .find((row) => row.querySelector('span')?.textContent === label)
      ?.querySelector('strong')?.textContent
  }

  beforeEach(() => {
    frames = new Map()
    nextFrame = 0
    viewport = Object.assign(new EventTarget(), { height: 778, offsetTop: 0 })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 812)
    vi.stubGlobal('innerWidth', 390)
    vi.stubGlobal('navigator', {
      standalone: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      onLine: true,
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    document.documentElement.style.setProperty('--app-viewport-height', '778px')
  })

  afterEach(() => {
    setPerformanceMonitorVisible(false)
    window.localStorage.clear()
    document.body.replaceChildren()
    document.documentElement.removeAttribute('style')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the diagnostic panel hidden until a user explicitly enables it', () => {
    expect(getPerformanceMonitorVisible()).toBe(false)
    installPerformanceMonitor()
    expect(document.getElementById('srl-performance-monitor')).toBeNull()
    expect(frames.size).toBe(0)

    window.localStorage.setItem('srl.performance-monitor.visible', 'true')
    expect(getPerformanceMonitorVisible()).toBe(true)
  })

  it('separates the restored shell edge from the raw native visual extent', () => {
    const nav = document.createElement('nav')
    nav.className = 'mobile-bottom-nav'
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 774, 393, 78))
    document.body.append(nav)
    viewport.height = 793
    document.documentElement.style.setProperty('--app-viewport-height', '852px')
    enablePanel()
    expect(metric('底栏差值')).toBe('0 px')
    expect(metric('原生 visual 差值')).toBe('-59 px')
    expect(metric('判定')).toBe('底栏已贴视口底部')
  })

  it('refreshes nav geometry in the enabled monitor and handles a removed nav', () => {
    const nav = document.createElement('nav')
    nav.className = 'mobile-bottom-nav'
    let bottom = 778
    vi.spyOn(nav, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, bottom - 78, 390, 78),
    )
    document.body.append(nav)
    const panel = enablePanel()
    expect(panel.open).toBe(false)
    expect(metric('底栏 bottom / height')).toBe('778 / 78 px')
    expect(metric('底栏差值')).toBe('0 px')
    bottom = 744
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(metric('底栏差值')).toBe('34 px')
    expect(metric('判定')).toBe('底栏上浮 34px')
    viewport.offsetTop = 10
    viewport.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(metric('底栏差值')).toBe('44 px')
    nav.remove()
    window.dispatchEvent(new Event('pageshow'))
    flushFrames()
    expect(metric('底栏 bottom / height')).toBe('未找到')
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.querySelectorAll('#srl-performance-monitor')).toHaveLength(1)
    setPerformanceMonitorVisible(false)
    flushFrames()
    window.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(0)
    expect(document.getElementById('srl-performance-monitor')).toBeNull()
  })

  it('reports the active plaza navigation and its hidden state without changing it', () => {
    document.body.innerHTML =
      '<nav class="mobile-bottom-nav" style="display:none"></nav><nav class="plaza-navigation" style="visibility:hidden;pointer-events:none">private-navigation-label</nav>'
    const nav = document.querySelector<HTMLElement>('.plaza-navigation')!
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 715, 393, 78))
    enablePanel()
    const report = JSON.parse(getKeyboardDiagnosticText())
    expect(report.samples.at(-1).navigation).toMatchObject({
      kind: 'plaza',
      visibility: 'hidden',
      pointerEvents: 'none',
      box: { top: 715, bottom: 793, height: 78 },
    })
    expect(metric('底栏 bottom / height')).toBe('793 / 78 px')
    expect(nav.style.visibility).toBe('hidden')
    expect(JSON.stringify(report)).not.toContain('private-navigation-label')
  })

  it('reads resolved safe-bottom pixels instead of parsing an env expression', () => {
    document.documentElement.style.setProperty('--safe-bottom', 'env(safe-area-inset-bottom, 0px)')
    const getStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = getStyle(element)
      if (element.classList.contains('srl-performance-monitor__safe-area-probe')) {
        Object.defineProperty(style, 'paddingBottom', { value: '34px' })
      }
      return style
    })
    const panel = enablePanel()
    expect(metric('safe-bottom')).toBe('34 px')
    expect(panel.querySelector('.srl-performance-monitor__safe-area-probe')).not.toBeNull()
    setPerformanceMonitorVisible(false)
    expect(document.querySelector('.srl-performance-monitor__safe-area-probe')).toBeNull()
  })

  it('refreshes navigation mounted after startup when the capsule opens without a viewport change', () => {
    const panel = enablePanel()
    expect(metric('底栏 bottom / height')).toBe('未找到')
    const nav = document.createElement('nav')
    nav.className = 'plaza-navigation'
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 700, 390, 78))
    document.body.append(nav)
    panel.open = true
    panel.dispatchEvent(new Event('toggle'))
    flushFrames()
    expect(metric('底栏 bottom / height')).toBe('778 / 78 px')
  })

  it('retains keyboard geometry after blur without capturing names, URLs or secrets', async () => {
    document.body.innerHTML =
      '<div class="editor-overlay layout-settings-overlay"><section role="dialog"><input value="private-api-key" placeholder="private-host-url"></section></div>'
    const input = document.querySelector('input')!
    const dialog = document.querySelector('section')!
    const overlay = document.querySelector<HTMLElement>('.editor-overlay')!
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -80, 390, 420))
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -80, 390, 420))
    const panel = enablePanel()
    input.focus()
    viewport.height = 420
    viewport.offsetTop = 30
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    input.blur()
    viewport.height = 778
    viewport.offsetTop = 0
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { standalone: true, clipboard: { writeText } })
    panel.querySelector<HTMLButtonElement>('button')!.click()
    await Promise.resolve()
    const text = writeText.mock.calls[0]![0] as string
    const report = JSON.parse(text)
    const keyboard = report.samples.find(
      (sample: { visualHeight: number }) => sample.visualHeight === 420,
    )
    expect(keyboard).toMatchObject({
      offsetTop: 30,
      page: 'settings',
      overlay: { top: -80, bottom: 340, height: 420 },
    })
    expect(keyboard.input).not.toBeNull()
    expect(report.samples.at(-1).visualHeight).toBe(778)
    expect(text).not.toContain('private-api-key')
    expect(text).not.toContain('private-host-url')
    expect(panel.querySelector('button')?.textContent).toBe('已复制键盘诊断')
  })

  it('records a bounded, value-free focus and pointer event timeline', async () => {
    document.body.innerHTML =
      '<section role="alertdialog"><input type="email" value="private@example.com"></section>'
    const input = document.querySelector('input')!
    const panel = enablePanel()
    input.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        isPrimary: true,
        clientX: 24,
        clientY: 48,
      }),
    )
    input.focus()
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      standalone: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      onLine: true,
      clipboard: { writeText },
    })
    panel.querySelector<HTMLButtonElement>('button')!.click()
    await Promise.resolve()
    const report = JSON.parse(writeText.mock.calls[0]![0] as string)
    expect(report.schemaVersion).toBe(2)
    expect(report.workerDeployVersion).toBeTruthy()
    expect(report.environment.displayMode).toBe('standalone')
    expect(report.events.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(['pointerdown', 'focusin', 'input', 'change']),
    )
    expect(
      report.events.find((event: { type: string }) => event.type === 'pointerdown'),
    ).toMatchObject({
      target: 'input:email',
      pointerType: 'touch',
      clientX: 24,
      clientY: 48,
    })
    expect(report.events.some((event: Record<string, unknown>) => 'value' in event)).toBe(false)
    expect(JSON.stringify(report)).not.toContain('private@example.com')
  })

  it('bounds and deduplicates samples and clears them when disabled', () => {
    enablePanel()
    for (let index = 0; index < 60; index++) {
      viewport.offsetTop = index
      viewport.dispatchEvent(new Event('scroll'))
      flushFrames()
    }
    const before = getKeyboardDiagnosticText()
    expect(JSON.parse(before).samples).toHaveLength(40)
    viewport.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(getKeyboardDiagnosticText()).toBe(before)
    setPerformanceMonitorVisible(false)
    viewport.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(JSON.parse(getKeyboardDiagnosticText()).samples).toEqual([])
  })

  it('records hit-test gaps independently of a full dialog rectangle without leaking content', () => {
    document.body.innerHTML =
      '<div class="editor-overlay layout-settings-overlay"><section role="dialog"><input value="private-api-key"></section></div><p>private-background</p>'
    const overlay = document.querySelector<HTMLElement>('.editor-overlay')!
    const dialog = document.querySelector('section')!
    const input = document.querySelector('input')!
    const background = document.querySelector('p')!
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 448))
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 59, 390, 389))
    // Replay the diagnostic blind spot: a full box can coexist with a lower
    // hit-test boundary. This models the evidence, not WebKit's rendering cause.
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn((_x: number, y: number) => (y < 290 ? input : background)),
    })
    try {
      Object.assign(viewport, { height: 448, offsetTop: 158 })
      const initialScroll = document.documentElement.scrollTop
      enablePanel()
      const text = getKeyboardDiagnosticText()
      const sample = JSON.parse(text).samples.at(-1)
      expect(sample.overlay).toEqual({ top: 0, bottom: 448, height: 448 })
      expect(sample.hitRowsFromZero).toEqual([
        { y: 112, left: 'dialog', right: 'dialog' },
        { y: 224, left: 'dialog', right: 'dialog' },
        { y: 336, left: 'outside', right: 'outside' },
        { y: 439.04, left: 'outside', right: 'outside' },
      ])
      expect(sample.hitRowsFromOffset[0]).toEqual({ y: 270, left: 'dialog', right: 'dialog' })
      expect(sample.overlayAncestors).toHaveLength(3)
      expect(text).not.toMatch(/private-api-key|private-background/)
      expect(document.documentElement.scrollTop).toBe(initialScroll)
      expect(overlay.style.cssText).toBe('')
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('copies the current action sheet even when opening it caused no viewport event', () => {
    enablePanel()
    const overlay = document.createElement('div')
    overlay.className = 'action-sheet'
    overlay.innerHTML = '<section role="dialog"><button>private-action-label</button></section>'
    document.body.append(overlay)
    const dialog = overlay.firstElementChild!
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 852))
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 652, 358, 200))
    const text = getKeyboardDiagnosticText()
    const sample = JSON.parse(text).samples.at(-1)
    expect(sample.page).toBe('action-sheet')
    expect(sample.overlay).toEqual({ top: 0, bottom: 852, height: 852 })
    expect(sample.dialog).toEqual({ top: 652, bottom: 852, height: 200 })
    expect(sample.overlayAncestors).toHaveLength(3)
    expect(text).not.toContain('private-action-label')
    expect(overlay.style.cssText).toBe('')
    overlay.remove()
  })

  it('retains an opened action sheet after closing it to access the monitor', () => {
    enablePanel()
    const trigger = document.createElement('button')
    const overlay = document.createElement('div')
    overlay.className = 'action-sheet'
    overlay.innerHTML = '<section role="dialog"><button>private-action-label</button></section>'
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 852))
    vi.spyOn(overlay.firstElementChild!, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(16, 652, 358, 200),
    )
    trigger.addEventListener('click', () => document.body.append(overlay))
    document.body.append(trigger)
    trigger.click()
    flushFrames()
    overlay.querySelector('button')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('button')!.click()
    flushFrames()
    const report = JSON.parse(getKeyboardDiagnosticText())
    expect(report.samples.some((sample: { page: string }) => sample.page === 'action-sheet')).toBe(
      true,
    )
    expect(report.samples.at(-1).page).toBe('page')
    trigger.remove()
  })

  it('provides a manual copy field when clipboard access fails', async () => {
    const panel = enablePanel()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { standalone: true, clipboard: { writeText } })
    panel.querySelector<HTMLButtonElement>('button')!.click()
    await Promise.resolve()
    const field = panel.querySelector('textarea')!
    expect(field.hidden).toBe(false)
    expect(field.readOnly).toBe(true)
    expect(JSON.parse(field.value).samples.length).toBeGreaterThan(0)
  })

  it('recovers saved positions inside resolved safe areas and follows the visible viewport', () => {
    const getStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = getStyle(element)
      if (element.classList.contains('srl-performance-monitor__safe-area-probe')) {
        Object.defineProperties(style, {
          paddingTop: { value: '59px' },
          paddingRight: { value: '10px' },
          paddingBottom: { value: '34px' },
          paddingLeft: { value: '12px' },
        })
      }
      return style
    })
    localStorage.setItem('srl.performance-monitor.position', JSON.stringify({ left: -100, top: 8 }))
    const panel = enablePanel()
    Object.defineProperties(panel, { offsetWidth: { value: 120 }, offsetHeight: { value: 44 } })
    vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(parseFloat(panel.style.left), parseFloat(panel.style.top), 120, 44),
    )
    flushFrames()
    expect(panel.style.left).toBe('20px')
    expect(panel.style.top).toBe('67px')
    Object.assign(viewport, { offsetLeft: 25, offsetTop: 80, width: 300, height: 400 })
    viewport.dispatchEvent(new Event('scroll'))
    flushFrames()
    expect(panel.style.left).toBe('45px')
    expect(panel.style.top).toBe('147px')
    panel.style.left = '2000px'
    panel.style.top = '2000px'
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(panel.style.left).toBe('187px')
    expect(panel.style.top).toBe('394px')
    viewport.height = 100
    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(panel.style.top).toBe('147px')
  })

  it('resets an unreachable position without clearing diagnostics or restoring stale coordinates', () => {
    localStorage.setItem(
      'srl.performance-monitor.position',
      JSON.stringify({ left: 8, top: -1000 }),
    )
    const panel = enablePanel()
    const before = getKeyboardDiagnosticText()
    panel.open = true
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 600, 120, 44))
    resetPerformanceMonitorPosition()
    flushFrames()
    expect(panel.open).toBe(false)
    expect(panel.dataset.positioned).toBeUndefined()
    expect(panel.style.left).toBe('')
    expect(panel.style.top).toBe('')
    expect(localStorage.getItem('srl.performance-monitor.position')).toBeNull()
    expect(getKeyboardDiagnosticText()).toBe(before)
    setPerformanceMonitorVisible(false)
    localStorage.setItem(
      'srl.performance-monitor.position',
      JSON.stringify({ left: 8, top: -1000 }),
    )
    resetPerformanceMonitorPosition()
    expect(localStorage.getItem('srl.performance-monitor.position')).toBeNull()
  })

  it('does not suppress the next tap after a cancelled drag or react to another pointer', () => {
    const panel = enablePanel()
    const summary = panel.querySelector('summary')!
    summary.setPointerCapture = vi.fn()
    const pointer = (type: string, x: number, pointerId = 1, isPrimary = true) =>
      summary.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          isPrimary,
          button: 0,
          clientX: x,
          clientY: 40,
          cancelable: true,
        }),
      )
    pointer('pointerdown', 40)
    pointer('pointermove', 120, 2, false)
    expect(panel.dataset.dragging).toBeUndefined()
    pointer('pointermove', 80)
    expect(panel.dataset.dragging).toBe('true')
    pointer('pointercancel', 80)
    expect(panel.dataset.dragging).toBeUndefined()
    const tap = new MouseEvent('click', { cancelable: true, detail: 1 })
    summary.dispatchEvent(tap)
    expect(tap.defaultPrevented).toBe(false)
    pointer('pointerdown', 40)
    pointer('pointermove', 80)
    pointer('pointerup', 80)
    const dragClick = new MouseEvent('click', { cancelable: true, detail: 1 })
    summary.dispatchEvent(dragClick)
    expect(dragClick.defaultPrevented).toBe(true)
    expect(window.localStorage.getItem('srl.performance-monitor.position')).not.toBeNull()
  })

  it('completes a touch tap once even without a compatibility click and preserves keyboard clicks', () => {
    const panel = enablePanel()
    const summary = panel.querySelector('summary')!
    summary.setPointerCapture = vi.fn()
    for (const type of ['pointerdown', 'pointerup']) {
      summary.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 }),
      )
    }
    expect(panel.open).toBe(true)
    const compatibilityClick = new MouseEvent('click', { cancelable: true, detail: 1 })
    summary.dispatchEvent(compatibilityClick)
    expect(compatibilityClick.defaultPrevented).toBe(true)
    expect(panel.open).toBe(true)
    const keyboardClick = new MouseEvent('click', { cancelable: true, detail: 0 })
    summary.dispatchEvent(keyboardClick)
    expect(keyboardClick.defaultPrevented).toBe(false)
    expect(panel.open).toBe(false)
  })
})
