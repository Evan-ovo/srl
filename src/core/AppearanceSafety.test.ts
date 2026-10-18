/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appearanceTransaction,
  createProtectedHost,
  recoverInterruptedAppearance,
} from './AppearanceSafety'
import {
  beginStartupAttempt,
  installSafeModeBanner,
  installStartupRescuePrompt,
  isSafeModeActive,
  markStartupReady,
} from './SafeStartup'
import { createUiView } from './UiCustomization'

describe('memory-only live appearance preview', () => {
  afterEach(() => {
    appearanceTransaction.exitPreview()
    vi.useRealTimers()
    localStorage.clear()
    document.body.replaceChildren()
  })

  it('stays active beyond 15 seconds and exits with the exact previous CSS and no storage writes', async () => {
    vi.useFakeTimers()
    localStorage.setItem('srl.ui.customCss', '.saved{}')
    const stored = { ...localStorage }
    const apply = vi.fn()
    const onExit = vi.fn()
    const views = { library: { ...createUiView(), enabled: true } }
    appearanceTransaction.preview({
      previousCss: '.saved{}',
      nextCss: '.draft{}',
      views,
      apply,
      onExit,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(appearanceTransaction.isPreviewing()).toBe(true)
    expect(appearanceTransaction.getPreviewViews()).toEqual(views)
    expect(apply).toHaveBeenLastCalledWith('.draft{}')
    expect({ ...localStorage }).toEqual(stored)
    const host = document.getElementById('srl-appearance-preview-layer')!
    expect(host.shadowRoot!.textContent).toContain('保存、删除会影响真实数据')
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-exit-preview]')!.click()
    expect(apply).toHaveBeenLastCalledWith('.saved{}')
    expect(appearanceTransaction.getPreviewViews()).toBeUndefined()
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(host.isConnected).toBe(false)
    expect({ ...localStorage }).toEqual(stored)
  })

  it('follows the host theme and discloses preview details without ending the session', async () => {
    document.documentElement.dataset.theme = 'dark'
    appearanceTransaction.preview({
      previousCss: '',
      nextCss: '.draft{}',
      views: {},
      apply: vi.fn(),
      onExit: vi.fn(),
    })
    const host = document.getElementById('srl-appearance-preview-layer')!
    const info = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-preview-info]')!
    const help = host.shadowRoot!.querySelector<HTMLElement>('#srl-preview-help')!
    expect(host.dataset.previewTheme).toBe('dark')
    expect(help.hidden).toBe(true)
    info.click()
    expect(info.getAttribute('aria-expanded')).toBe('true')
    expect(help.hidden).toBe(false)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(help.hidden).toBe(true)
    expect(appearanceTransaction.isPreviewing()).toBe(true)
    document.documentElement.dataset.theme = 'light'
    await Promise.resolve()
    expect(host.dataset.previewTheme).toBe('light')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(appearanceTransaction.isPreviewing()).toBe(false)
    delete document.documentElement.dataset.theme
  })

  it('keeps a canceled dirty-editor exit active, then accepts Escape and removes its listeners', async () => {
    const beforeExit = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const onExit = vi.fn()
    appearanceTransaction.preview({
      previousCss: '',
      nextCss: '.draft{}',
      views: {},
      apply: vi.fn(),
      onExit,
      beforeExit,
    })
    document
      .getElementById('srl-appearance-preview-layer')!
      .shadowRoot!.querySelector<HTMLButtonElement>('button')!
      .click()
    await Promise.resolve()
    expect(appearanceTransaction.isPreviewing()).toBe(true)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await Promise.resolve()
    expect(appearanceTransaction.isPreviewing()).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('disables a failing preview Vue only in memory and restores when applying another appearance', () => {
    const view = { ...createUiView(), enabled: true }
    const original = { library: view }
    const apply = vi.fn()
    const onExit = vi.fn()
    appearanceTransaction.preview({
      previousCss: '.saved{}',
      nextCss: '.draft{}',
      views: original,
      apply,
      onExit,
    })
    expect(appearanceTransaction.disablePreviewView('library')).toBe(true)
    expect(original.library.enabled).toBe(true)
    expect(appearanceTransaction.getPreviewViews()!.library!.enabled).toBe(false)
    appearanceTransaction.clear('.applied{}', apply, vi.fn())
    expect(appearanceTransaction.getPreviewViews()).toBeUndefined()
    expect(apply.mock.calls.map(([css]) => css)).toEqual(['.draft{}', '.saved{}', '.applied{}'])
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(appearanceTransaction.disablePreviewView('library')).toBe(false)
  })

  it('cleans up and restores CSS when preview application fails', () => {
    const onExit = vi.fn()
    const apply = vi.fn((css: string) => {
      if (css === '.broken{}') throw new Error('failed')
    })
    expect(() =>
      appearanceTransaction.preview({
        previousCss: '.saved{}',
        nextCss: '.broken{}',
        views: {},
        apply,
        onExit,
      }),
    ).toThrow('failed')
    expect(apply).toHaveBeenLastCalledWith('.saved{}')
    expect(appearanceTransaction.isPreviewing()).toBe(false)
    expect(document.getElementById('srl-appearance-preview-layer')).toBeNull()
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

describe('AppearanceSafety', () => {
  it('后创建的Vue恢复按钮不遮挡试用确认和立即恢复', () => {
    appearanceTransaction.begin({
      previousCss: '',
      nextCss: '.trial{}',
      apply: vi.fn(),
      persist: vi.fn(),
    })
    const { host } = createProtectedHost('srl-custom-ui-rescue')
    const guard = document.getElementById('srl-appearance-safe-layer')!
    expect(host.compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    appearanceTransaction.keep()
    expect(host.isConnected).toBe(true)
  })
  afterEach(() => {
    appearanceTransaction.rollback()
    vi.useRealTimers()
    localStorage.clear()
    sessionStorage.clear()
    document.body.replaceChildren()
  })

  it('在受 Shadow DOM 保护的 15 秒层确认后保留新 CSS', () => {
    const apply = vi.fn()
    const persist = vi.fn()
    appearanceTransaction.begin({ previousCss: '.old{}', nextCss: '.new{}', apply, persist })
    const host = document.getElementById('srl-appearance-safe-layer')
    expect(host?.shadowRoot?.textContent).toContain('保留更改')
    expect(host?.style.getPropertyPriority('display')).toBe('important')
    expect(host?.style.getPropertyValue('z-index')).toBe('2147483647')
    expect(host?.style.getPropertyValue('pointer-events')).toBe('none')
    host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-keep]')?.click()
    expect(persist).toHaveBeenCalledWith('.new{}')
    expect(localStorage.getItem('srl.appearance.pending.v1')).toBeNull()
  })

  it('超时自动恢复上一版，刷新中断也读取 previousCss 自愈', async () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const persist = vi.fn()
    appearanceTransaction.begin({
      previousCss: '.old{}',
      nextCss: '.bad{}',
      apply,
      persist,
      durationMs: 1000,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(persist).toHaveBeenLastCalledWith('.old{}')
    expect(apply).toHaveBeenLastCalledWith('.old{}')

    localStorage.setItem(
      'srl.appearance.pending.v1',
      JSON.stringify({ previousCss: '.safe{}', nextCss: '.bad{}', expiresAt: Date.now() + 1000 }),
    )
    expect(recoverInterruptedAppearance()).toBe('.safe{}')
  })
  it('AI edits persist automatically and can be undone once after the guard closes', async () => {
    vi.useFakeTimers()
    const apply = vi.fn(),
      persist = vi.fn()
    appearanceTransaction.begin({
      previousCss: '.old{}',
      nextCss: '.ai{}',
      autoKeep: true,
      durationMs: 1000,
      apply,
      persist,
    })
    const root = document.getElementById('srl-appearance-safe-layer')!.shadowRoot!
    expect(root.querySelector('strong')!.textContent).toBe('美化已应用')
    expect(root.querySelector('[data-rollback]')!.textContent).toBe('撤销')
    await vi.advanceTimersByTimeAsync(1000)
    expect(document.getElementById('srl-appearance-safe-layer')).toBeNull()
    expect(persist).toHaveBeenLastCalledWith('.ai{}')
    expect(appearanceTransaction.undo()).toBe(true)
    expect(persist).toHaveBeenLastCalledWith('.old{}')
    expect(appearanceTransaction.undo()).toBe(false)
  })
  it('clearing CSS invalidates the undo record rather than restoring an obsolete edit', () => {
    const apply = vi.fn(),
      persist = vi.fn()
    appearanceTransaction.begin({
      previousCss: '.old{}',
      nextCss: '.ai{}',
      autoKeep: true,
      apply,
      persist,
    })
    appearanceTransaction.keep()
    appearanceTransaction.clear('', apply, persist)
    expect(appearanceTransaction.undo()).toBe(false)
    expect(persist).toHaveBeenLastCalledWith('')
  })
})

describe('SafeStartup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    document.body.replaceChildren()
  })

  it('连续启动未完成只提示，不自动关闭外观和预览；ready 后撤掉提示', () => {
    expect(beginStartupAttempt().rescueRequired).toBe(false)
    expect(beginStartupAttempt().rescueRequired).toBe(false)
    expect(beginStartupAttempt().rescueRequired).toBe(true)
    expect(isSafeModeActive()).toBe(false)
    installStartupRescuePrompt()
    const host = document.getElementById('srl-startup-rescue-layer')
    expect(host?.shadowRoot?.textContent).toContain('继续使用')
    expect(host?.shadowRoot?.textContent).toContain('安全模式')
    expect(host?.shadowRoot?.querySelector('[aria-modal]')).toBeNull()
    expect(host?.style.getPropertyValue('z-index')).toBe('2147483647')
    expect(host?.shadowRoot?.querySelector('[data-clear]')).toBeNull()
    markStartupReady()
    expect(document.getElementById('srl-startup-rescue-layer')).toBeNull()
    expect(beginStartupAttempt().failures).toBe(0)
  })

  it('不继承跨标签共享的旧失败计数或旧版 pending 安全模式', () => {
    localStorage.setItem(
      'srl.startup.state.v1',
      JSON.stringify({ pending: true, consecutiveFailures: 9, startedAt: 1 }),
    )
    sessionStorage.setItem('srl.safeMode.session.v1', 'pending')
    expect(beginStartupAttempt()).toEqual({ rescueRequired: false, failures: 0 })
    expect(isSafeModeActive()).toBe(false)
    expect(localStorage.getItem('srl.startup.state.v1')).toBeNull()
  })

  it('用户主动开启的安全模式保留；无 CSS 时不提供无效清除操作', () => {
    sessionStorage.setItem('srl.safeMode.session.v1', 'safe')
    beginStartupAttempt()
    installSafeModeBanner()
    markStartupReady()
    const root = document.getElementById('srl-startup-rescue-layer')?.shadowRoot
    expect(isSafeModeActive()).toBe(true)
    expect(root?.querySelector('[data-clear]')).toBeNull()
    expect(root?.textContent).toContain('恢复正常并重开')
    expect(root?.querySelector('details')).not.toBeNull()
  })

  it('有 CSS 时先确认，取消不清除 CSS 或其他设置', () => {
    sessionStorage.setItem('srl.safeMode.session.v1', 'safe')
    localStorage.setItem('srl.ui.customCss', '.saved{}')
    localStorage.setItem('unrelated', 'keep')
    installSafeModeBanner()
    const root = document.getElementById('srl-startup-rescue-layer')!.shadowRoot!
    root.querySelector<HTMLButtonElement>('[data-clear]')!.click()
    expect(root.querySelector<HTMLElement>('[data-clear-confirm]')!.hidden).toBe(false)
    expect(localStorage.getItem('srl.ui.customCss')).toBe('.saved{}')
    root.querySelector<HTMLButtonElement>('[data-cancel-clear]')!.click()
    expect(root.querySelector<HTMLElement>('[data-clear-confirm]')!.hidden).toBe(true)
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('站点存储不可访问时，恢复机制本身不再抛错阻止页面启动', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const)
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError')
      })
    expect(() => beginStartupAttempt()).not.toThrow()
    expect(() => markStartupReady()).not.toThrow()
    expect(() => recoverInterruptedAppearance()).not.toThrow()
    expect(isSafeModeActive()).toBe(false)
  })
})
