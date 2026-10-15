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
