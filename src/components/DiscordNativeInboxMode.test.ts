/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({
  available: true,
  state: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  webAvailable: false,
  webStatus: 'off',
  webStart: vi.fn(),
  webStop: vi.fn(),
  webListeners: new Set<() => void>(),
}))
vi.mock('../services/WebDiscordInboxSession', () => ({
  isWebDiscordInboxAvailable: () => runtime.webAvailable,
  webDiscordInboxState: () => ({ status: runtime.webStatus, message: '' }),
  startWebDiscordInbox: runtime.webStart,
  pauseWebDiscordInbox: runtime.webStop,
  subscribeWebDiscordInbox: (listener: () => void) => {
    runtime.webListeners.add(listener)
    return () => runtime.webListeners.delete(listener)
  },
}))
vi.mock('../services/NativeDiscordInboxService', () => ({
  isNativeDiscordInboxAvailable: () => runtime.available,
  readNativeDiscordInboxState: runtime.state,
  startNativeDiscordInbox: runtime.start,
  stopNativeDiscordInbox: runtime.stop,
}))
import Mode from './DiscordNativeInboxMode.vue'
beforeEach(() => {
  vi.clearAllMocks()
  runtime.available = true
  runtime.webAvailable = false
  runtime.webStatus = 'off'
  runtime.state.mockResolvedValue(false)
  runtime.start.mockResolvedValue(undefined)
  runtime.stop.mockResolvedValue(undefined)
})
describe('receive mode control', () => {
  it('keeps startup pending until native acknowledgement and does not claim success on failure', async () => {
    let reject!: (error: Error) => void
    runtime.start.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    const wrapper = mount(Mode)
    try {
      await flushPromises()
      await wrapper.get('button').trigger('click')
      expect(wrapper.get('button').text()).toBe('正在启动…')
      expect(wrapper.get('button').attributes('disabled')).toBeDefined()
      expect(wrapper.get('button').attributes('aria-pressed')).toBe('false')
      reject(new Error('后台收件服务未能启动'))
      await flushPromises()
      expect(wrapper.get('button').text()).toBe('开启收件模式')
      expect(wrapper.get('[role="alert"]').text()).toContain('未能启动')
      expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })
  it('starts on user action and reflects notification stop without enabling again on mount', async () => {
    const wrapper = mount(Mode)
    try {
      await flushPromises()
      expect(runtime.start).not.toHaveBeenCalled()
      await wrapper.get('button').trigger('click')
      expect(runtime.start).toHaveBeenCalledOnce()
      window.dispatchEvent(new CustomEvent('srl:cloud-inbox-state', { detail: { running: true } }))
      expect(wrapper.get('button').attributes('aria-pressed')).toBe('false')
      await flushPromises()
      expect(wrapper.get('button').text()).toBe('停止收件')
      await wrapper.get('button').trigger('click')
      expect(runtime.stop).toHaveBeenCalledOnce()
      window.dispatchEvent(new CustomEvent('srl:cloud-inbox-state', { detail: { running: false } }))
      await flushPromises()
      expect(wrapper.get('button').text()).toBe('开启收件模式')
    } finally {
      wrapper.unmount()
    }
  })
  it('shows permission or old APK failures and releases the button for another attempt', async () => {
    runtime.start.mockRejectedValueOnce(new Error('请先允许系统通知'))
    const wrapper = mount(Mode)
    try {
      await flushPromises()
      await wrapper.get('button').trigger('click')
      await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('系统通知')
      expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })
  it('does not offer the native switch in iOS or browser', () => {
    runtime.available = false
    const wrapper = mount(Mode)
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
  it('uses the same entry for a web session and preserves it when the inbox view closes', async () => {
    runtime.available = false
    runtime.webAvailable = true
    runtime.webStart.mockImplementationOnce(async () => {
      runtime.webStatus = 'running'
      runtime.webListeners.forEach((fn) => fn())
    })
    runtime.webStop.mockImplementationOnce(async () => {
      runtime.webStatus = 'paused'
      runtime.webListeners.forEach((fn) => fn())
    })
    const first = mount(Mode)
    await first.get('button').trigger('click')
    await flushPromises()
    expect(runtime.webStart).toHaveBeenCalledOnce()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(first.get('button').text()).toBe('停止收件')
    first.unmount()
    expect(runtime.webStop).not.toHaveBeenCalled()
    const second = mount(Mode)
    expect(second.get('button').text()).toBe('停止收件')
    await second.get('button').trigger('click')
    await flushPromises()
    expect(runtime.webStop).toHaveBeenCalledOnce()
    expect(second.get('button').text()).toBe('开启收件模式')
    second.unmount()
  })
})
