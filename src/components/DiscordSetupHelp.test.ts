/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiscordSetupHelp from './DiscordSetupHelp.vue'
import { discordSetupSession } from '../services/AssistantBrowserRuntime'
const start = vi.hoisted(() => vi.fn())
const current = vi.hoisted(() => vi.fn())
const resume = vi.hoisted(() => vi.fn())
const restart = vi.hoisted(() => vi.fn())
const pauseAgent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../core/AppContainer', () => ({
  discordSetupService: { start, current, resume, restart, pauseAgent },
}))
beforeEach(() => {
  vi.clearAllMocks()
  discordSetupSession.agentRunning = false
  current.mockResolvedValue(undefined)
  resume.mockResolvedValue({})
  restart.mockResolvedValue({})
})
describe('Discord help route choices', () => {
  it('keeps pause available in the local configuration menu without resuming or starting another task', async () => {
    current.mockResolvedValue({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      startedAt: 1,
    })
    discordSetupSession.agentRunning = true
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '暂停网页协助')!
        .trigger('click')
      await flushPromises()
      expect(pauseAgent).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
      expect(wrapper.emitted('update:open')).toEqual([[false]])
    } finally {
      wrapper.unmount()
      discordSetupSession.agentRunning = false
    }
  })
  it('starts an independent diagnostic task through the same centered entry and agent permission path', async () => {
    start.mockResolvedValue({})
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '已经配置过，但有问题，帮我排查')!
        .trigger('click')
      expect(wrapper.text()).not.toContain('省 Token 模式')
      await wrapper
        .findAll('button')
        .find((button) => button.text().startsWith('代理模式'))!
        .trigger('click')
      await flushPromises()
      expect(start).toHaveBeenCalledExactlyOnceWith('diagnose', undefined, 'agent')
      expect(wrapper.emitted('update:open')).toEqual([[false]])
    } finally {
      wrapper.unmount()
    }
  })
  it('keeps mode selection open when permission confirmation was cancelled', async () => {
    start.mockResolvedValue({ cancelled: true })
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '之前从未配过 Discord Bridge')!
        .trigger('click')
      await wrapper
        .findAll('button')
        .find((button) => button.text().startsWith('代理模式'))!
        .trigger('click')
      await flushPromises()
      expect(wrapper.emitted('update:open')).toBeUndefined()
      expect(wrapper.text()).toContain('选择部署协助模式')
    } finally {
      wrapper.unmount()
    }
  })
  it('waits for a mode choice before starting and supports agent mode', async () => {
    start.mockReset().mockResolvedValue({})
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '之前从未配过 Discord Bridge')!
        .trigger('click')
      expect(start).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('选择部署协助模式')
      await wrapper
        .findAll('button')
        .find((button) => button.text().startsWith('代理模式'))!
        .trigger('click')
      await flushPromises()
      expect(start).toHaveBeenCalledExactlyOnceWith('configure', undefined, 'agent')
    } finally {
      wrapper.unmount()
    }
  })
  it('does not offer an already completed task as unfinished', async () => {
    current.mockResolvedValue({ task: 'configure', step: 'done', startedAt: 1 })
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      expect(wrapper.text()).not.toContain('继续上次配置')
      expect(wrapper.text()).toContain('之前从未配过 Discord Bridge')
    } finally {
      wrapper.unmount()
    }
  })
  it.each(['update-worker', 'update-commands-only', 'update-commands'])(
    'keeps the second menu open and starts %s once',
    async (task) => {
      start.mockReset().mockResolvedValue({})
      const wrapper = mount(DiscordSetupHelp, {
        props: { open: true },
        global: { stubs: { teleport: true } },
      })
      await flushPromises()
      try {
        await wrapper
          .findAll('button')
          .find((button) => button.text().startsWith('之前配置过'))!
          .trigger('click')
        expect(wrapper.emitted('update:open')).toBeUndefined()
        const labels = {
          'update-worker': '仅更新 Worker',
          'update-commands-only': '仅更新指令（Worker 已经更新过）',
          'update-commands': '更新指令（Worker 也还未更新）',
        }
        await wrapper
          .findAll('button')
          .find((button) => button.text() === labels[task as keyof typeof labels])!
          .trigger('click')
        await wrapper
          .findAll('button')
          .find((button) => button.text().startsWith('省 Token 模式'))!
          .trigger('click')
        await flushPromises()
        expect(start).toHaveBeenCalledExactlyOnceWith(task, undefined, 'economy')
        expect(wrapper.emitted('update:open')).toEqual([[false]])
      } finally {
        wrapper.unmount()
      }
    },
  )
  it('starts first setup and leaves a failed request reviewable', async () => {
    start.mockReset().mockRejectedValue(new Error('配置步骤未打开'))
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    try {
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '之前从未配过 Discord Bridge')!
        .trigger('click')
      await wrapper
        .findAll('button')
        .find((button) => button.text().startsWith('省 Token 模式'))!
        .trigger('click')
      await flushPromises()
      expect(start).toHaveBeenCalledExactlyOnceWith('configure', undefined, 'economy')
      expect(wrapper.emitted('update:open')).toBeUndefined()
      expect(wrapper.text()).toContain('配置步骤未打开')
    } finally {
      wrapper.unmount()
    }
  })
  it('resumes the saved step without starting another task', async () => {
    current.mockResolvedValue({ task: 'configure', step: 'wrangler-check', startedAt: 1 })
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      expect(wrapper.text()).toContain('上次停在：检查 Wrangler 格式')
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '继续网页协助')!
        .trigger('click')
      await flushPromises()
      expect(resume).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
      expect(restart).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('does not reset progress until a new route is selected after restart', async () => {
    current.mockResolvedValue({ task: 'configure', step: 'wrangler-check', startedAt: 1 })
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '重新开始')!
        .trigger('click')
      expect(restart).not.toHaveBeenCalled()
      expect(wrapper.emitted('update:open')).toBeUndefined()
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '之前从未配过 Discord Bridge')!
        .trigger('click')
      await wrapper
        .findAll('button')
        .find((button) => button.text().startsWith('省 Token 模式'))!
        .trigger('click')
      await flushPromises()
      expect(restart).toHaveBeenCalledExactlyOnceWith('configure', 'economy')
      expect(start).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('blocks restart when saved progress could not be read', async () => {
    current.mockRejectedValue(new Error('disk read failed'))
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await flushPromises()
      expect(wrapper.text()).toContain('读取失败')
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '之前从未配过 Discord Bridge')!
        .trigger('click')
      expect(start).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('discards a saved-state response arriving after close', async () => {
    let resolve!: (value: unknown) => void
    current.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const wrapper = mount(DiscordSetupHelp, {
      props: { open: true },
      global: { stubs: { teleport: true } },
    })
    try {
      await wrapper.setProps({ open: false })
      resolve({ task: 'configure', step: 'wrangler-check', startedAt: 1 })
      await flushPromises()
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
      expect(start).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
})
