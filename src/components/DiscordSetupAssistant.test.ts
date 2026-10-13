/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiscordSetupAssistant from './DiscordSetupAssistant.vue'
const fixture = vi.hoisted(() => ({
  available: true,
  state: { task: 'update-commands', step: 'local-settings', startedAt: 1 },
  current: vi.fn(),
  start: vi.fn(),
  restart: vi.fn(),
  resume: vi.fn(),
  next: vi.fn(),
  open: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  discordSetupService: {
    current: fixture.current,
    start: fixture.start,
    restart: fixture.restart,
    resume: fixture.resume,
    next: fixture.next,
    open: fixture.open,
  },
}))
vi.mock('../services/AssistantBrowserRuntime', () => ({
  hasDiscordSetupBrowser: () => fixture.available,
}))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.available = true
  fixture.current.mockResolvedValue(fixture.state)
  fixture.start.mockResolvedValue({})
  fixture.next.mockResolvedValue({})
})
describe('compact APK setup entry', () => {
  it('does not offer a completion shortcut during diagnosis', async () => {
    fixture.current.mockResolvedValue({ task: 'diagnose', step: 'diagnose', startedAt: 1 })
    const wrapper = mount(DiscordSetupAssistant)
    try {
      await flushPromises()
      expect(wrapper.text()).toContain('排查当前 Discord Bridge 配置')
      expect(wrapper.text()).not.toContain('本步完成，核验并继续')
      expect(fixture.next).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('opening Continue asks about saved progress and does not advance the local step', async () => {
    const wrapper = mount(DiscordSetupAssistant, { global: { stubs: { teleport: true } } })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '继续')!
        .trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('继续上次配置？')
      expect(wrapper.text()).toContain('上次停在：填写资源库连接参数')
      expect(fixture.next).not.toHaveBeenCalled()
      expect(fixture.start).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('shows what has passed after completion without claiming a real Discord operation', async () => {
    fixture.current.mockResolvedValue({ task: 'update-worker', step: 'done', startedAt: 1 })
    const wrapper = mount(DiscordSetupAssistant)
    try {
      await flushPromises()
      expect(wrapper.text()).toContain('本次连接与命令检查通过')
      expect(wrapper.text()).toContain('请到 Discord 实际使用一次命令')
      expect(wrapper.text()).not.toContain('本步完成，核验并继续')
    } finally {
      wrapper.unmount()
    }
  })
  it('is absent from web and older APKs', async () => {
    fixture.available = false
    const wrapper = mount(DiscordSetupAssistant)
    await flushPromises()
    expect(wrapper.find('.discord-setup-assistant').exists()).toBe(false)
    expect(fixture.current).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('keeps updates in the existing action sheet and opens the native checkpoint chooser', async () => {
    const wrapper = mount(DiscordSetupAssistant, { global: { stubs: { teleport: true } } })
    await flushPromises()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('[aria-label="网页协助更多选项"]').exists()).toBe(false)
    await wrapper.get('.discord-setup-assistant__continue').trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重新开始')!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().startsWith('之前配置过'))!
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '更新指令（Worker 也还未更新）')!
      .trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text().startsWith('省 Token 模式'))!
      .trigger('click')
    await flushPromises()
    expect(fixture.restart).toHaveBeenCalledWith('update-commands', 'economy')
    expect(fixture.start).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('keeps the current task after a failed local check and releases its event listener on exit', async () => {
    const wrapper = mount(DiscordSetupAssistant)
    await flushPromises()
    fixture.next.mockRejectedValue(new Error('请先注册命令'))
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '本步完成，核验并继续')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toBe('请先注册命令')
    expect(wrapper.text()).toContain('填写资源库连接参数')
    wrapper.unmount()
    const count = fixture.current.mock.calls.length
    window.dispatchEvent(new Event('srl:discord-setup-changed'))
    await flushPromises()
    expect(fixture.current).toHaveBeenCalledTimes(count)
  })
})
