/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({ mount: vi.fn(), credentials: vi.fn() }))
vi.mock('vue', () => ({ createApp: () => ({ mount: startup.mount }) }))
vi.mock('./RootApp.vue', () => ({ default: {} }))
vi.mock('./core/AndroidAppUpdate', () => ({ installAndroidAppUpdateChecks: vi.fn() }))
vi.mock('./core/FatalErrorNotice', () => ({ installGlobalErrorHandlers: vi.fn() }))
vi.mock('./core/NativeRuntime', () => ({ installNativeRuntime: vi.fn() }))
vi.mock('./core/PerformanceMonitor', () => ({ installPerformanceMonitor: vi.fn() }))
vi.mock('./core/SystemInsetsService', () => ({ installSystemInsetsService: vi.fn() }))
vi.mock('./core/AppContainer', () => ({
  initializeCredentialServices: startup.credentials,
}))
vi.mock('./core/SafeStartup', () => ({
  beginStartupAttempt: () => ({ rescueRequired: false }),
  installSafeModeBanner: vi.fn(),
  installStartupRescuePrompt: vi.fn(),
  isSafeModeActive: () => false,
}))
vi.mock('./core/ServiceWorkerUpdate', () => ({
  disableServiceWorkerForNativeApp: vi.fn(),
  installServiceWorker: vi.fn(),
}))
vi.mock('./utils/CapacitorDetection', () => ({ isCapacitorApp: () => true }))

describe('Main viewport state', () => {
  it('mounts the authentication shell without initializing feature services', async () => {
    startup.credentials.mockReturnValue(new Promise(() => undefined))
    await import('./Main')
    expect(startup.mount).toHaveBeenCalledWith('#app')
    expect(startup.credentials).not.toHaveBeenCalled()
  })
  let iosStandalone: boolean
  let iosBrowser: boolean
  let standaloneDisplay: boolean
  let viewport: { height: number; offsetTop: number; addEventListener: ReturnType<typeof vi.fn> }
  let pendingFrames: FrameRequestCallback[]
  let listeners: Map<string, EventListenerOrEventListenerObject[]>
  let viewportListeners: Map<string, EventListenerOrEventListenerObject>

  function applyScheduledViewport(): void {
    const resizeListeners = listeners.get('resize')
    if (!resizeListeners?.length) throw new Error('Missing viewport resize listener')
    for (const listener of resizeListeners) {
      if (typeof listener === 'function') listener(new Event('resize'))
      else listener.handleEvent(new Event('resize'))
    }
    if (!pendingFrames.length) throw new Error('Missing scheduled viewport update')
    for (const callback of pendingFrames.splice(0)) callback(0)
  }

  function settleScheduledViewport(): void {
    for (let pass = 0; pass < 5 && pendingFrames.length; pass += 1) {
      for (const callback of pendingFrames.splice(0)) callback(0)
    }
  }

  function notifyFocusIn(): void {
    const event = new FocusEvent('focusin', { bubbles: true })
    for (const listener of listeners.get('focusin') ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }

  function notifyViewport(type: string): void {
    const listener = viewportListeners.get(type)
    if (typeof listener === 'function') listener(new Event(type))
    else listener?.handleEvent(new Event(type))
    for (const callback of pendingFrames.splice(0)) callback(0)
  }

  beforeEach(() => {
    vi.resetModules()
    startup.mount.mockClear()
    startup.credentials.mockReset()
    vi.useFakeTimers()
    iosStandalone = false
    iosBrowser = false
    standaloneDisplay = false
    pendingFrames = []
    listeners = new Map()
    viewportListeners = new Map()
    viewport = {
      height: 778,
      offsetTop: 0,
      addEventListener: vi.fn((name, listener) => viewportListeners.set(name, listener)),
    }
    document.documentElement.removeAttribute('style')
    document.body.replaceChildren()
    document.documentElement.classList.remove('modal-open')
    document.body.classList.remove('modal-open')
    delete document.documentElement.dataset.displayMode
    delete document.documentElement.dataset.iosStandalone
    delete document.documentElement.dataset.iosKeyboardOpen
    vi.stubGlobal('navigator', {
      get standalone() {
        return iosStandalone
      },
      get platform() {
        return iosBrowser || iosStandalone ? 'iPhone' : 'Linux x86_64'
      },
      get maxTouchPoints() {
        return iosBrowser || iosStandalone ? 5 : 0
      },
      get userAgent() {
        return iosStandalone && !iosBrowser
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
          : iosBrowser
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      },
    })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 812)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: standaloneDisplay })),
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        pendingFrames.push(callback)
        return pendingFrames.length
      }),
    )
    vi.spyOn(window, 'addEventListener').mockImplementation((name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps ordinary browser height equal to the visual viewport', async () => {
    await import('./Main')
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '778px',
    )
    expect(document.documentElement.dataset.displayMode).toBe('browser')
    expect(document.getElementById('srl-ios-pwa-geometry-diagnostic')).toBeNull()
  })

  it('keeps the window surface independent of keyboard content height and updates on rotation', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    await import('./Main')
    viewport.height = 448
    viewport.offsetTop = 180
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--layout-viewport-height')).toBe(
      '812px',
    )
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '448px',
    )
    vi.stubGlobal('innerWidth', 844)
    vi.stubGlobal('innerHeight', 390)
    viewport.height = 200
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--layout-viewport-height')).toBe(
      '390px',
    )
  })

  it('publishes reduced geometry during zoom without identifying it as an iOS keyboard', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const input = document.createElement('textarea')
    document.body.append(input)
    input.focus()
    await import('./Main')
    expect(document.documentElement.dataset.visualViewportReduced).toBe('false')

    Object.assign(viewport, { height: 300, scale: 1.25 })
    applyScheduledViewport()
    expect(document.documentElement.dataset.visualViewportReduced).toBe('true')
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    expect(document.documentElement.style.getPropertyValue('--layout-viewport-height')).toBe(
      '812px',
    )

    Object.assign(viewport, { height: 778 / 1.25, scale: 1.25 })
    applyScheduledViewport()
    expect(document.documentElement.dataset.visualViewportReduced).toBe('false')
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')

    Object.assign(viewport, { height: 778, scale: 1 })
    applyScheduledViewport()
    expect(document.documentElement.dataset.visualViewportReduced).toBe('false')
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    input.remove()
  })

  it('tracks reduced input space when the focus session starts already zoomed', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    Object.assign(viewport, { height: 778 / 1.25, scale: 1.25 })
    const input = document.createElement('textarea')
    document.body.append(input)
    input.focus()
    await import('./Main')
    expect(document.documentElement.dataset.visualViewportReduced).toBe('false')
    viewport.height = 300
    applyScheduledViewport()
    expect(document.documentElement.dataset.visualViewportReduced).toBe('true')
    viewport.height = 778 / 1.25
    applyScheduledViewport()
    expect(document.documentElement.dataset.visualViewportReduced).toBe('false')
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    input.remove()
  })

  it.each([
    { ios: true, width: 390, height: 448, scale: 1, open: true, focused: true },
    { ios: true, width: 390, height: 753, scale: 1, open: false },
    { ios: true, width: 390, height: 812, scale: 1, open: false },
    { ios: true, width: 390, height: 448, scale: 1.33, open: false },
    { ios: true, width: 1280, height: 448, scale: 1, open: false },
    { ios: false, width: 390, height: 448, scale: 1, open: false },
  ])(
    'marks the iOS keyboard and clears it on close: %j',
    async ({ ios, width, height, scale, open, focused = false }) => {
      iosStandalone = ios
      vi.stubGlobal('innerWidth', width)
      Object.assign(viewport, { height: open && focused ? 778 : height, scale })
      if (focused) {
        const input = document.createElement('input')
        document.body.append(input)
        input.focus()
      }
      await import('./Main')
      if (open && focused) {
        viewport.height = height
        applyScheduledViewport()
      }
      expect(document.documentElement.dataset.iosKeyboardOpen).toBe(String(open))
      viewport.height = 812
      applyScheduledViewport()
      expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    },
  )

  it.each([
    { expanded: 778, restored: 777.75, blur: false },
    { expanded: 778, restored: 777.75, blur: true },
    { expanded: 778.5, restored: 778.25, blur: false },
    { expanded: 778.5, restored: 778.25, blur: true },
    { expanded: 778.1, restored: 777.9, blur: false },
    { expanded: 778.1, restored: 777.9, blur: true },
  ])(
    'restores the keyboard UI within the same CSS pixel: %j',
    async ({ expanded, restored, blur }) => {
      iosStandalone = true
      vi.stubGlobal('innerWidth', 390)
      viewport.height = expanded
      const input = document.createElement('textarea')
      input.value = '保留已输入的画面描述'
      document.body.append(input)
      input.focus()
      await import('./Main')

      viewport.height = 420
      applyScheduledViewport()
      expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
      if (blur) input.blur()
      viewport.height = restored
      applyScheduledViewport()
      expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
      expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe(
        `${restored}px`,
      )
      expect(input.value).toBe('保留已输入的画面描述')

      input.focus()
      notifyFocusIn()
      viewport.height = 420
      applyScheduledViewport()
      expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
    },
  )

  it('keeps the iOS keyboard marker when innerHeight shrinks with visualViewport', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await import('./Main')
    vi.stubGlobal('innerHeight', 420)
    viewport.height = 420
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
    expect(document.documentElement.style.getPropertyValue('--layout-viewport-height')).toBe(
      '812px',
    )
    vi.stubGlobal('innerHeight', 812)
    viewport.height = 812
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
  })

  it('tracks the keyboard and reveals focused fields in regular iOS Safari', async () => {
    iosBrowser = true
    vi.stubGlobal('innerWidth', 390)
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    dialog.style.overflowY = 'auto'
    const input = document.createElement('textarea')
    dialog.append(input)
    document.body.append(dialog)
    Object.defineProperties(dialog, {
      clientHeight: { value: 264 },
      scrollHeight: { value: 1500 },
    })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 69, 390, 264))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 442 - dialog.scrollTop, 390, 154),
    )
    input.focus()
    await import('./Main')
    expect(document.documentElement.dataset.iosStandalone).toBe('false')

    viewport.height = 448
    viewport.offsetTop = 296
    applyScheduledViewport()
    settleScheduledViewport()

    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
    expect(dialog.scrollTop).toBeGreaterThan(0)
    expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(432)
    dialog.remove()
  })

  it('keeps keyboard state through blur until the visual viewport has fully expanded', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const input = document.createElement('input')
    const button = document.createElement('button')
    document.body.append(input, button)
    input.focus()
    await import('./Main')
    viewport.height = 420
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')

    button.focus()
    notifyFocusIn()
    viewport.height = 610
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
    viewport.height = 778
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
  })

  it('marks iOS standalone without adding the safe area to app height', async () => {
    iosStandalone = true
    await import('./Main')
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '778px',
    )
    expect(document.documentElement.dataset.displayMode).toBe('standalone')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('')
    expect(document.documentElement.dataset.iosStandalone).toBe('true')
    expect(document.getElementById('srl-ios-pwa-geometry-diagnostic')).toBeNull()
  })

  it('does not add the iOS correction for non-iOS standalone browsers', async () => {
    standaloneDisplay = true
    await import('./Main')
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.documentElement.dataset.displayMode).toBe('standalone')
    expect(document.documentElement.dataset.iosStandalone).toBe('false')
    expect(document.getElementById('srl-ios-pwa-geometry-diagnostic')).toBeNull()
  })

  it('falls back to innerHeight when visualViewport is unavailable', async () => {
    iosStandalone = true
    vi.stubGlobal('visualViewport', undefined)
    await import('./Main')
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('812px')
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '812px',
    )
  })

  it('updates standalone markers without changing the app height', async () => {
    await import('./Main')
    iosStandalone = true
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.documentElement.dataset.iosStandalone).toBe('true')
    iosStandalone = false
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('778px')
    expect(document.documentElement.dataset.displayMode).toBe('browser')
    expect(document.documentElement.dataset.iosStandalone).toBe('false')
  })

  it('tracks keyboard panning on viewport scroll even when height does not change', async () => {
    iosStandalone = true
    await import('./Main')
    viewport.height = 420
    viewport.offsetTop = 240
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-offset-top')).toBe(
      '240px',
    )
    const scroll = viewport.addEventListener.mock.calls.find(([name]) => name === 'scroll')?.[1]
    expect(scroll).toBeTypeOf('function')
    viewport.offsetTop = 180.5
    scroll(new Event('scroll'))
    for (const callback of pendingFrames.splice(0)) callback(0)
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-offset-top')).toBe(
      '180.5px',
    )
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '420px',
    )
    viewport.height = 778
    viewport.offsetTop = 0
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-offset-top')).toBe(
      '0px',
    )
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '778px',
    )
  })

  it.each([
    { ios: true, width: 390, scale: 1, reveal: true },
    { ios: false, width: 390, scale: 1, reveal: false },
    { ios: true, width: 1280, scale: 1, reveal: false },
    { ios: true, width: 390, scale: 1.33, reveal: false },
  ])(
    'reveals cold dialog focus only for the affected mobile viewport: %j',
    async ({ ios, width, scale, reveal }) => {
      iosStandalone = ios
      vi.stubGlobal('innerWidth', width)
      Object.assign(viewport, { scale })
      const dialog = document.createElement('section')
      dialog.setAttribute('role', 'dialog')
      const input = document.createElement('textarea')
      dialog.style.overflowY = 'auto'
      dialog.append(input)
      document.body.append(dialog)
      Object.defineProperties(dialog, {
        clientHeight: { value: 264 },
        scrollHeight: { value: 1500 },
      })
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 69, 390, 264))
      vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, 442 - dialog.scrollTop, 390, 154),
      )
      input.focus()
      await import('./Main')
      expect(dialog.scrollTop).toBe(0)
      viewport.height = 448
      viewport.offsetTop = 296
      applyScheduledViewport()
      settleScheduledViewport()
      expect(document.activeElement).toBe(input)
      expect(input.getBoundingClientRect().bottom).toBe(reveal ? 321 : 596)
      const savedScroll = dialog.scrollTop
      viewport.height = 778
      viewport.offsetTop = 0
      applyScheduledViewport()
      expect(dialog.scrollTop).toBe(savedScroll)
    },
  )

  it('rechecks the focused control when switching fields while the keyboard is open', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const first = document.createElement('input')
    const second = document.createElement('select')
    content.append(first, second)
    document.body.append(content)
    Object.defineProperties(content, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 390, 40))
    vi.spyOn(second, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 - content.scrollTop, 390, 40),
    )
    first.focus()
    await import('./Main')
    viewport.height = 420
    applyScheduledViewport()
    expect(content.scrollTop).toBe(0)

    second.focus()
    notifyFocusIn()
    settleScheduledViewport()
    expect(content.scrollTop).toBeGreaterThan(0)
    content.remove()
  })

  it('tracks and reveals editable controls inside open shadow roots', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'open' })
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const first = document.createElement('input')
    const second = document.createElement('textarea')
    content.append(first, second)
    shadow.append(content)
    document.body.append(host)
    Object.defineProperties(content, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
    for (const input of [first, second])
      vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, 500 - content.scrollTop, 390, 40),
      )
    await import('./Main')
    first.focus()
    notifyFocusIn()
    viewport.height = 420
    applyScheduledViewport()
    settleScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('true')
    expect(content.scrollTop).toBeGreaterThan(0)
    content.scrollTop = 0
    second.focus()
    notifyFocusIn()
    settleScheduledViewport()
    expect(content.scrollTop).toBeGreaterThan(0)
    viewport.height = 778
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    host.remove()
  })

  it('waits through 25 viewport animation frames and never re-corrects after its own scroll', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('input')
    content.append(input)
    dialog.append(content)
    document.body.append(dialog)
    Object.defineProperties(content, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 - content.scrollTop, 390, 40),
    )
    input.focus()
    await import('./Main')

    for (let frame = 0; frame < 25; frame += 1) {
      viewport.height = 600 - frame * 11
      applyScheduledViewport()
      expect(content.scrollTop).toBe(0)
    }

    settleScheduledViewport()
    expect(content.scrollTop).toBeGreaterThan(0)
    const settledScrollTop = content.scrollTop
    viewport.offsetTop = 7
    notifyViewport('scroll')
    settleScheduledViewport()
    expect(content.scrollTop).toBe(settledScrollTop)
    dialog.remove()
  })

  it('does not treat semantic dialogs or feature pages as root-scroll locks', async () => {
    const featurePage = document.createElement('section')
    featurePage.className = 'image-generation-app'
    featurePage.setAttribute('role', 'dialog')
    featurePage.setAttribute('aria-modal', 'true')
    const nestedDialog = document.createElement('section')
    nestedDialog.setAttribute('role', 'dialog')
    featurePage.append(nestedDialog)
    document.body.append(featurePage)
    await import('./Main')
    expect(document.documentElement.classList.contains('modal-open')).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)

    nestedDialog.remove()
    featurePage.remove()
    await Promise.resolve()
    expect(document.documentElement.classList.contains('modal-open')).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
  })

  it('does not remove root locks owned by the app overlay lifecycle', async () => {
    document.documentElement.classList.add('modal-open')
    document.body.classList.add('modal-open')
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    await import('./Main')
    dialog.remove()
    applyScheduledViewport()
    expect(document.documentElement.classList.contains('modal-open')).toBe(true)
    expect(document.body.classList.contains('modal-open')).toBe(true)
  })

  it.each(['textarea', 'select', 'contenteditable'] as const)(
    'applies the same settled correction to %s focus',
    async (kind) => {
      iosStandalone = true
      vi.stubGlobal('innerWidth', 390)
      const container = document.createElement('div')
      container.style.overflowY = 'auto'
      const target =
        kind === 'textarea'
          ? document.createElement('textarea')
          : kind === 'select'
            ? document.createElement('select')
            : document.createElement('div')
      if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true')
      container.append(target)
      document.body.append(container)
      Object.defineProperties(container, {
        clientHeight: { value: 300 },
        scrollHeight: { value: 1200 },
      })
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
      vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, 500 - container.scrollTop, 390, 40),
      )
      target.focus()
      await import('./Main')
      viewport.height = 420
      applyScheduledViewport()
      settleScheduledViewport()
      expect(container.scrollTop).toBeGreaterThan(0)
      container.remove()
    },
  )

  it('starts a fresh correction session when focus moves to another field with the keyboard open', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    const first = document.createElement('input')
    const second = document.createElement('textarea')
    container.append(first, second)
    document.body.append(container)
    Object.defineProperties(container, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 110, 390, 40))
    vi.spyOn(second, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 - container.scrollTop, 390, 40),
    )
    first.focus()
    await import('./Main')
    viewport.height = 420
    applyScheduledViewport()
    settleScheduledViewport()
    expect(container.scrollTop).toBe(0)

    second.focus()
    notifyFocusIn()
    settleScheduledViewport()
    expect(container.scrollTop).toBeGreaterThan(0)
    container.remove()
  })

  it('allows one new correction after the keyboard closes and reopens on the same focused field', async () => {
    iosStandalone = true
    vi.stubGlobal('innerWidth', 390)
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    const input = document.createElement('input')
    container.append(input)
    document.body.append(container)
    Object.defineProperties(container, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1200 },
    })
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 300))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 - container.scrollTop, 390, 40),
    )
    input.focus()
    await import('./Main')
    viewport.height = 420
    applyScheduledViewport()
    settleScheduledViewport()
    const firstCorrection = container.scrollTop
    expect(firstCorrection).toBeGreaterThan(0)

    viewport.height = 778
    applyScheduledViewport()
    expect(document.documentElement.dataset.iosKeyboardOpen).toBe('false')
    container.scrollTop = 0
    viewport.height = 420
    applyScheduledViewport()
    settleScheduledViewport()
    expect(container.scrollTop).toBeGreaterThan(0)
    container.remove()
  })

  it('clears a previous viewport offset when visualViewport becomes unavailable', async () => {
    viewport.offsetTop = 120
    await import('./Main')
    vi.stubGlobal('visualViewport', undefined)
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-offset-top')).toBe(
      '0px',
    )
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '812px',
    )
  })

  it('updates both heights after viewport resize without repeated safe-area addition', async () => {
    iosStandalone = true
    await import('./Main')
    viewport.height = 400
    applyScheduledViewport()
    applyScheduledViewport()
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('400px')
    expect(document.documentElement.style.getPropertyValue('--visual-viewport-height')).toBe(
      '400px',
    )
    expect(viewport.addEventListener.mock.calls.map(([name]) => name)).toEqual(['resize', 'scroll'])
    expect(document.getElementById('srl-ios-pwa-geometry-diagnostic')).toBeNull()
    expect(listeners.has('orientationchange')).toBe(true)
    expect(listeners.has('pageshow')).toBe(true)
  })

  it('does not start a second diagnostic panel or polling timer in Main', async () => {
    iosStandalone = true
    const interval = vi.spyOn(window, 'setInterval')
    await import('./Main')
    vi.advanceTimersByTime(500)
    expect(interval).not.toHaveBeenCalled()
    expect(document.getElementById('srl-ios-pwa-geometry-diagnostic')).toBeNull()
    expect(document.getElementById('srl-performance-monitor')).toBeNull()
  })
})
