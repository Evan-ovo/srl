/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appearanceScopes } from '../core/AppearanceScopes'
import { DEFAULT_MAIN_API_CONFIG } from '../services/MainApiService'
import {
  ProductAssistantService,
  type AssistantRunResult,
  type AssistantExecution,
  type AssistantToolHost,
} from '../services/ProductAssistantService'
import {
  ProductAssistantContextService,
  planAssistantCompression,
} from '../services/ProductAssistantContext'
import ProductAssistantSettings from './ProductAssistantSettings.vue'
import ProductAssistant from './ProductAssistant.vue'
import * as nativeDiscordBrowser from '../services/AssistantBrowserRuntime'
import { assistantPetCue } from '../core/ProductAssistantPetState'
import type { AssistantPreferences } from '../services/ProductAssistantWorkspaceService'
const discordSetup = vi.hoisted(() => ({
  assistantConversationId: vi.fn(),
  continueInTaskConversation: vi.fn(),
  peekAssistantDraft: vi.fn(),
  peekAssistantRequest: vi.fn(),
  takeAssistantDraft: vi.fn(),
  takeAssistantRequest: vi.fn(),
  execute: vi.fn(),
  suspendForModelConsent: vi.fn(),
  restoreAfterModelConsent: vi.fn(),
  progressCursor: vi.fn(() => 0),
  continueAfterProgress: vi.fn(),
  agentRunId: vi.fn(),
  settleAssistantTurn: vi.fn(),
  pauseAgent: vi.fn(async () => {}),
  returnToBrowser: vi.fn(async () => {}),
}))
const {
  confirm,
  choose,
  getConfig,
  appOwner,
  invokeTool,
  workspace,
  readOnline,
  resetConversationSync,
  publishConversation,
} = vi.hoisted(() => {
  const conversationListeners = new Set<
    (conversation: { id: string; history: unknown[] }, sourceId?: string) => void
  >()
  const activityListeners = new Set<(id: string, sourceId: string, active: boolean) => void>()
  const activityOwners = new Map<string, string>()
  return {
    readOnline: vi.fn(),
    resetConversationSync: () => {
      conversationListeners.clear()
      activityListeners.clear()
      activityOwners.clear()
    },
    publishConversation: (conversation: { id: string; history: unknown[] }, sourceId?: string) => {
      for (const listener of conversationListeners)
        listener(JSON.parse(JSON.stringify(conversation)), sourceId)
    },
    workspace: {
      preferences: vi.fn(),
      onPreferencesChange: vi.fn((_listener: (value: AssistantPreferences) => void) => vi.fn()),
      onConversationChange: (
        listener: (value: { id: string; history: unknown[] }, sourceId?: string) => void,
      ) => {
        conversationListeners.add(listener)
        return () => conversationListeners.delete(listener)
      },
      onConversationActivityChange: (
        listener: (id: string, sourceId: string, active: boolean) => void,
      ) => {
        activityListeners.add(listener)
        return () => activityListeners.delete(listener)
      },
      setConversationActivity: (id: string, sourceId: string, active: boolean) => {
        const owner = activityOwners.get(id)
        if (active && owner && owner !== sourceId) return false
        if (active) activityOwners.set(id, sourceId)
        else if (owner === sourceId) activityOwners.delete(id)
        else return true
        for (const listener of activityListeners) listener(id, sourceId, active)
        return true
      },
      conversationActivityOwner: (id: string) => activityOwners.get(id),
      savePreferences: vi.fn(),
      memories: () => [],
      initialize: vi.fn(),
      config: vi.fn(),
      save: vi.fn(),
      list: vi.fn(),
      switch: vi.fn(),
      continueDiscordSetupConversation: vi.fn(),
      flush: vi.fn(),
      templates: vi.fn(),
      templateText: (value: { name: string; steps: string[] }) =>
        `${value.name}\n${value.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      readGitHubCredential: vi.fn(async () => ''),
    },
    confirm: vi.fn(),
    choose: vi.fn(),
    getConfig: vi.fn(),
    appOwner: {
      createSourcePreview: vi.fn(),
      install: vi.fn(),
      get: vi.fn(),
      exportPreviewPackage: vi.fn(),
      listCustomTools: vi.fn(),
      requireCustomTool: vi.fn(),
    },
    invokeTool: vi.fn(),
  }
})
vi.mock('../services/ProductAssistantOnline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ProductAssistantOnline')>()),
  readAssistantOnline: readOnline,
}))
vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction: confirm,
  chooseAction: choose,
  useConfirmDialogState: () => ({ activeDialog: { value: undefined } }),
}))
vi.mock('../core/AppContainer', () => ({
  resourceService: {
    get: vi.fn(),
    getSummary: vi.fn(),
    listResourceListSummaries: vi.fn(async () => []),
  },
  discordSetupService: discordSetup,
  productAssistantWorkspaceService: workspace,
  externalAppService: appOwner,
  mainApiService: {
    getConfig,
    getActiveProfile: () => ({ model: 'vision-model' }),
    completeWithUsage: vi.fn(),
  },
}))
vi.mock('./ExternalAppHost.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      setup(_props, { expose }) {
        expose({ invokeTool })
        return () => h('div', { class: 'external-app-host' }, '真实宿主的测试替身')
      },
    }),
  }
})
const context = {
  presetId: 'draft',
  appliedCss: '',
  scopes: appearanceScopes(),
  currentScope: 'library',
  css: { library: '.resource-card{color:red}' },
}
function render(
  execute = vi
    .fn<() => Promise<AssistantExecution>>()
    .mockResolvedValue({ text: '样式已实际应用' }),
) {
  return mount(ProductAssistant, { props: { getContext: () => context, execute } })
}
async function send(w: ReturnType<typeof render>, text = '卡片改浅紫') {
  await flushPromises()
  await w.get('[aria-label="发送消息"]').setValue(text)
  await w.get('form').trigger('submit')
  await flushPromises()
  await w.get('[aria-label="生成回复"]').trigger('click')
  await flushPromises()
}
describe('ProductAssistant chat', () => {
  it('keeps IME confirmation untouched by the send shortcut', async () => {
    const w = render()
    await flushPromises()
    const input = w.get('[aria-label="发送消息"]')
    await input.setValue('中文草稿')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input.element.dispatchEvent(composing)
    await flushPromises()
    expect(composing.defaultPrevented).toBe(false)
    expect((input.element as HTMLTextAreaElement).value).toBe('中文草稿')
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect((input.element as HTMLTextAreaElement).value).toBe('')
    w.unmount()
  })
  it('keeps a general task in the existing full chat with one webpage preview instead of a second pet window', async () => {
    workspace.initialize.mockResolvedValueOnce({
      id: 'general-chat',
      title: '表单任务',
      history: [],
      input: '',
      images: [],
      updatedAt: 1,
    })
    vi.spyOn(nativeDiscordBrowser, 'hasDiscordSetupBrowser').mockReturnValue(true)
    Object.assign(nativeDiscordBrowser.discordSetupSession, {
      purpose: 'general',
      active: true,
      webStepActive: true,
      assistantConversationId: 'general-chat',
      browserVisible: false,
    })
    const wrapper = mount(ProductAssistant, {
      props: { getContext: () => context, execute: vi.fn() },
    })
    try {
      await flushPromises()
      expect(wrapper.findAll('.assistant-browser-task-preview')).toHaveLength(1)
      expect(wrapper.find('.assistant-return-browser').exists()).toBe(false)
      expect(workspace.continueDiscordSetupConversation).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      Object.assign(nativeDiscordBrowser.discordSetupSession, {
        purpose: 'discord-setup',
        active: false,
        webStepActive: false,
      })
    }
  })
  it('executes queued webpage work in the retained hidden task chat without opening it or aborting when expanded', async () => {
    const value = {
      id: 'background-task',
      title: 'Discord Bridge 网页协助',
      history: [],
      input: '',
      images: [],
      updatedAt: 1,
    }
    workspace.initialize.mockResolvedValueOnce(value)
    workspace.continueDiscordSetupConversation.mockResolvedValue(value)
    discordSetup.assistantConversationId.mockResolvedValue(value.id)
    discordSetup.agentRunId.mockReturnValue('background-run')
    nativeDiscordBrowser.discordSetupSession.active = true
    nativeDiscordBrowser.discordSetupSession.assistantConversationId = value.id
    nativeDiscordBrowser.discordSetupSession.agentRunning = true
    let finish!: (result: AssistantRunResult) => void
    let pendingSignal!: AbortSignal
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementation((_request, _config, signal) => {
        pendingSignal = signal
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    const wrapper = mount(ProductAssistant, {
      props: {
        getContext: () => context,
        execute: vi.fn(),
        compact: true,
        visible: false,
        backgroundTask: true,
      },
    })
    try {
      await flushPromises()
      discordSetup.peekAssistantRequest.mockReturnValueOnce('检查当前部署结果')
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(reply).toHaveBeenCalledOnce()
      expect(pendingSignal.aborted).toBe(false)
      await wrapper.setProps({ visible: true, compact: false })
      expect(pendingSignal.aborted).toBe(false)
      expect(reply).toHaveBeenCalledOnce()
      await wrapper.setProps({ visible: false, compact: true })
      expect(pendingSignal.aborted).toBe(false)
    } finally {
      finish?.({ text: '已核验部署', images: [] })
      await flushPromises()
      wrapper.unmount()
      discordSetup.assistantConversationId.mockReset()
      discordSetup.agentRunId.mockReset()
      nativeDiscordBrowser.discordSetupSession.active = false
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
      nativeDiscordBrowser.discordSetupSession.assistantConversationId = ''
    }
  })
  it('loads the task conversation into the existing compact chat without generating or continuing work', async () => {
    const value = {
      id: 'setup-chat',
      title: 'Discord Bridge 网页协助',
      history: [],
      input: '',
      images: [],
      updatedAt: 1,
    }
    workspace.continueDiscordSetupConversation.mockResolvedValueOnce(value)
    discordSetup.assistantConversationId.mockResolvedValue('setup-chat')
    vi.spyOn(nativeDiscordBrowser, 'hasDiscordSetupBrowser').mockReturnValue(true)
    nativeDiscordBrowser.discordSetupSession.active = true
    nativeDiscordBrowser.discordSetupSession.webStepActive = true
    nativeDiscordBrowser.discordSetupSession.assistantConversationId = 'setup-chat'
    nativeDiscordBrowser.discordSetupSession.browserVisible = false
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const wrapper = mount(ProductAssistant, {
      props: { getContext: () => context, execute: vi.fn(), compact: true },
    })
    try {
      await flushPromises()
      expect(workspace.continueDiscordSetupConversation).toHaveBeenCalledWith('setup-chat')
      expect(wrapper.find('.assistant-return-browser').exists()).toBe(false)
      expect(wrapper.find('[aria-label="网页协助操作"]').exists()).toBe(true)
      expect(reply).not.toHaveBeenCalled()
      expect(discordSetup.continueInTaskConversation).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      nativeDiscordBrowser.discordSetupSession.active = false
      nativeDiscordBrowser.discordSetupSession.webStepActive = false
      nativeDiscordBrowser.discordSetupSession.assistantConversationId = ''
      discordSetup.assistantConversationId.mockReset()
    }
  })
  it('keeps one task-controls entry in the chat header without an extra return button or AI request', async () => {
    workspace.initialize.mockResolvedValueOnce({
      id: 'task-chat',
      title: 'Discord Bridge 网页协助',
      history: [],
      input: '',
      images: [],
      updatedAt: 1,
    })
    vi.spyOn(nativeDiscordBrowser, 'hasDiscordSetupBrowser').mockReturnValue(true)
    nativeDiscordBrowser.discordSetupSession.active = true
    nativeDiscordBrowser.discordSetupSession.webStepActive = true
    nativeDiscordBrowser.discordSetupSession.assistantConversationId = 'task-chat'
    nativeDiscordBrowser.discordSetupSession.browserVisible = false
    discordSetup.returnToBrowser.mockClear()
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const wrapper = render()
    try {
      await flushPromises()
      await wrapper.get('.feature-app-header__back').trigger('click')
      expect(wrapper.emitted('back')).toHaveLength(1)
      expect(discordSetup.returnToBrowser).not.toHaveBeenCalled()
      expect(wrapper.find('.assistant-return-browser').exists()).toBe(false)
      await wrapper.get('[aria-label="网页协助操作"]').trigger('click')
      expect(discordSetup.returnToBrowser).toHaveBeenCalledExactlyOnceWith(true)
      expect(reply).not.toHaveBeenCalled()
      nativeDiscordBrowser.discordSetupSession.agentRunning = true
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('[aria-label="暂停网页协助"]')).toHaveLength(1)
      expect(wrapper.find('[aria-label="生成回复"]').exists()).toBe(false)
      discordSetup.pauseAgent.mockClear()
      await wrapper.get('[aria-label="暂停网页协助"]').trigger('click')
      expect(discordSetup.pauseAgent).toHaveBeenCalledOnce()
      expect(reply).not.toHaveBeenCalled()
      await wrapper.setProps({ compact: true })
      await wrapper.get('[aria-label="关闭快捷对话"]').trigger('click')
      expect(wrapper.emitted('back')).toHaveLength(2)
      expect(discordSetup.returnToBrowser).toHaveBeenCalledOnce()
      nativeDiscordBrowser.discordSetupSession.webStepActive = false
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
      nativeDiscordBrowser.discordSetupSession.assistantConversationId = ''
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.assistant-return-browser').exists()).toBe(false)
      expect(wrapper.find('[aria-label="网页协助操作"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      nativeDiscordBrowser.discordSetupSession.active = false
      nativeDiscordBrowser.discordSetupSession.webStepActive = false
    }
  })
  it('keeps the browser return action out of an unrelated ordinary conversation', async () => {
    vi.spyOn(nativeDiscordBrowser, 'hasDiscordSetupBrowser').mockReturnValue(true)
    nativeDiscordBrowser.discordSetupSession.active = true
    nativeDiscordBrowser.discordSetupSession.webStepActive = true
    nativeDiscordBrowser.discordSetupSession.browserVisible = false
    nativeDiscordBrowser.discordSetupSession.assistantConversationId = 'another-task-chat'
    const wrapper = render()
    try {
      await flushPromises()
      expect(wrapper.find('.assistant-return-browser').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      nativeDiscordBrowser.discordSetupSession.active = false
      nativeDiscordBrowser.discordSetupSession.webStepActive = false
      nativeDiscordBrowser.discordSetupSession.assistantConversationId = ''
    }
  })
  it('does not let an idle ordinary chat cancel the active task conversation on a page notification', async () => {
    const taskChat = {
      id: 'active-task-chat',
      title: 'Discord Bridge 网页协助',
      updatedAt: Date.now(),
      history: [],
      input: '',
      images: [],
    }
    workspace.initialize.mockResolvedValueOnce(taskChat)
    discordSetup.assistantConversationId.mockResolvedValue(taskChat.id)
    discordSetup.agentRunId.mockReturnValue('active-run')
    nativeDiscordBrowser.discordSetupSession.agentRunning = true
    let finish!: (result: AssistantRunResult) => void
    let pendingSignal!: AbortSignal
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementation((_request, _config, signal) => {
        pendingSignal = signal
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    const full = render()
    let idle: ReturnType<typeof render> | undefined
    try {
      await flushPromises()
      discordSetup.peekAssistantRequest.mockReturnValueOnce('检查部署结果并继续')
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(reply).toHaveBeenCalledOnce()
      expect(workspace.conversationActivityOwner(taskChat.id)).toBeTruthy()

      workspace.initialize.mockResolvedValueOnce({ ...taskChat, id: 'ordinary-chat' })
      idle = render()
      await flushPromises()
      discordSetup.settleAssistantTurn.mockClear()
      discordSetup.settleAssistantTurn.mockImplementationOnce(async () => {
        window.dispatchEvent(new Event('srl:discord-setup-stop'))
      })
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(discordSetup.settleAssistantTurn).not.toHaveBeenCalled()
      expect(pendingSignal.aborted).toBe(false)
      expect(reply).toHaveBeenCalledOnce()
    } finally {
      finish?.({ text: '等待网站完成部署', images: [] })
      await flushPromises()
      idle?.unmount()
      full.unmount()
      reply.mockRestore()
      discordSetup.assistantConversationId.mockReset()
      discordSetup.agentRunId.mockReset()
      discordSetup.settleAssistantTurn.mockReset()
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
    }
  })
  it('stops and reports a failed idle browser check without requesting AI', async () => {
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const w = render()
    try {
      await flushPromises()
      discordSetup.agentRunId.mockReturnValue('active-run')
      discordSetup.pauseAgent.mockClear()
      discordSetup.settleAssistantTurn.mockRejectedValueOnce(new Error('Browser closed'))
      nativeDiscordBrowser.discordSetupSession.agentRunning = true
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(discordSetup.pauseAgent).toHaveBeenCalledExactlyOnceWith('active-run')
      expect(w.text()).toContain('网页状态检查失败')
      expect(reply).not.toHaveBeenCalled()
    } finally {
      w.unmount()
      reply.mockRestore()
      discordSetup.agentRunId.mockReset()
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
    }
  })
  it('settles an idle browser notification without requesting AI when no task prompt is queued', async () => {
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const w = render()
    try {
      await flushPromises()
      discordSetup.agentRunId.mockReturnValue('active-run')
      discordSetup.settleAssistantTurn.mockClear()
      nativeDiscordBrowser.discordSetupSession.agentRunning = true
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(discordSetup.settleAssistantTurn).toHaveBeenCalledExactlyOnceWith('active-run')
      expect(reply).not.toHaveBeenCalled()
    } finally {
      w.unmount()
      reply.mockRestore()
      discordSetup.agentRunId.mockReset()
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
    }
  })
  it('hands a task started from ordinary chat off before further webpage operations', async () => {
    const browser = vi.spyOn(nativeDiscordBrowser, 'hasDiscordSetupBrowser').mockReturnValue(true)
    discordSetup.execute.mockImplementationOnce(async () => {
      discordSetup.assistantConversationId.mockResolvedValue('new-agent-chat')
      return { ok: true, mode: 'agent', step: 'discord-app' }
    })
    discordSetup.continueInTaskConversation.mockReturnValue(true)
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementationOnce(async (request, _config, signal, host) => {
        const start = await host!.execute(
          { action: 'discord-setup', args: { operation: 'start', task: 'configure' } },
          request,
          signal,
        )
        const inspect = await host!.execute(
          { action: 'discord-setup', args: { operation: 'inspect' } },
          request,
          signal,
        )
        expect(start.data).toMatchObject({ taskConversationRequired: true })
        expect(inspect.data).toMatchObject({ taskConversationRequired: true })
        return { text: '已转到独立网页协助对话', images: [] }
      })
    const w = render()
    try {
      await send(w, '开始网页配置')
      expect(discordSetup.execute).toHaveBeenCalledOnce()
      expect(discordSetup.execute.mock.calls[0]?.[0].operation).toBe('start')
    } finally {
      w.unmount()
      reply.mockRestore()
      browser.mockRestore()
      discordSetup.assistantConversationId.mockReset()
      discordSetup.execute.mockReset()
      discordSetup.continueInTaskConversation.mockReset()
    }
  })
  it('moves a webpage agent to its independent conversation without sending ordinary chat or its draft', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '正在处理网页任务', images: [] })
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('普通聊天未发送的内容')
      discordSetup.assistantConversationId.mockResolvedValue('isolated-web-task')
      workspace.continueDiscordSetupConversation.mockResolvedValue({
        id: 'isolated-web-task',
        customTitle: 'Discord Bridge 网页协助',
        title: 'Discord Bridge 网页协助',
        updatedAt: Date.now(),
        history: [],
        input: '',
        images: [],
      })
      discordSetup.peekAssistantRequest.mockReturnValueOnce('请继续网页配置任务')
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(
        workspace.save.mock.calls.some(([chat]) => chat.input === '普通聊天未发送的内容'),
      ).toBe(true)
      expect(workspace.continueDiscordSetupConversation).toHaveBeenCalledOnce()
      expect(
        workspace.save.mock.calls.some(
          ([chat]) =>
            chat.id === 'isolated-web-task' && chat.customTitle === 'Discord Bridge 网页协助',
        ),
      ).toBe(true)
      expect(reply.mock.calls[0]?.[0].history.map((turn) => turn.text)).toEqual([
        '请继续网页配置任务',
      ])
      expect(w.get('[aria-label="发送消息"]').element).toHaveProperty('value', '')
      window.dispatchEvent(new Event('srl:discord-setup-fullscreen'))
      await flushPromises()
      expect(workspace.continueDiscordSetupConversation).toHaveBeenCalledOnce()
    } finally {
      w.unmount()
      reply.mockRestore()
      discordSetup.assistantConversationId.mockReset()
    }
  })
  it('receives the webpage fullscreen draft in the same chat without replacing its draft or requesting AI', async () => {
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('原有草稿')
      discordSetup.peekAssistantDraft.mockReturnValueOnce('小窗未发送的问题')
      window.dispatchEvent(new Event('srl:discord-setup-fullscreen'))
      await flushPromises()
      expect(w.get('[aria-label="发送消息"]').element).toHaveProperty(
        'value',
        '原有草稿\n\n小窗未发送的问题',
      )
      expect(reply).not.toHaveBeenCalled()
      expect(w.findAll('.chat-message--user')).toHaveLength(0)
    } finally {
      w.unmount()
      reply.mockRestore()
    }
  })
  it.each([
    { toolBudgetExhausted: false },
    { toolBudgetExhausted: true },
    { toolBudgetExhausted: false, warning: '网络请求失败' },
  ])('continues a successful native request without replacing its draft: %j', async (result) => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '请填写三个值。', images: [], ...result })
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('未发送的草稿')
      discordSetup.suspendForModelConsent.mockResolvedValueOnce(true)
      discordSetup.peekAssistantRequest.mockReturnValueOnce('请继续当前 Discord 配置步骤')
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(reply).toHaveBeenCalledOnce()
      expect(discordSetup.restoreAfterModelConsent).toHaveBeenCalledWith(true)
      if (result.warning) expect(discordSetup.continueAfterProgress).not.toHaveBeenCalled()
      else expect(discordSetup.continueAfterProgress).toHaveBeenCalledWith(undefined, 0)
      expect(discordSetup.settleAssistantTurn).toHaveBeenCalledWith(
        undefined,
        false,
        result.toolBudgetExhausted === true,
      )
      expect(reply.mock.calls[0]![0].history.at(-1)?.text).toBe('请继续当前 Discord 配置步骤')
      expect(w.findAll('.chat-message--user')).toHaveLength(0)
      expect(w.get('[aria-label="发送消息"]').element).toHaveProperty('value', '未发送的草稿')
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(reply).toHaveBeenCalledOnce()
    } finally {
      w.unmount()
      reply.mockRestore()
    }
  })
  it('keeps the full chat and shortcut window on the same conversation while a reply is pending', async () => {
    const chat = {
      id: 'shared-assistant-chat',
      title: '新对话',
      updatedAt: Date.now(),
      history: [],
      input: '',
      images: [],
    }
    workspace.initialize.mockResolvedValue(chat)
    let finish!: (result: AssistantRunResult) => void
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const full = render()
    const quick = render()
    try {
      await flushPromises()
      await quick.setProps({ compact: true })
      await full.get('[aria-label="发送消息"]').setValue('请帮我查一下')
      await full.get('form').trigger('submit')
      await flushPromises()
      expect(quick.find('.chat-message--user').text()).toContain('请帮我查一下')

      await full.get('[aria-label="生成回复"]').trigger('click')
      await flushPromises()
      expect(reply).toHaveBeenCalledOnce()
      expect(quick.get('[aria-label="发送消息"]').attributes('placeholder')).toContain(
        '另一个对话窗口正在等待回复',
      )
      expect(quick.get('[aria-label="发送消息"]').element).toHaveProperty('disabled', true)
      expect(quick.find('[aria-label="另一个对话窗口正在等待回复"]').exists()).toBe(true)
      discordSetup.agentRunId.mockReturnValue('active-run')
      discordSetup.settleAssistantTurn.mockClear()
      nativeDiscordBrowser.discordSetupSession.agentRunning = true
      window.dispatchEvent(new Event('srl:discord-setup-assist'))
      await flushPromises()
      expect(discordSetup.settleAssistantTurn).not.toHaveBeenCalled()
      expect(quick.get('[aria-label="展开完整对话"]').element).toHaveProperty('disabled', false)
      await quick.get('[aria-label="展开完整对话"]').trigger('click')
      await flushPromises()
      expect(quick.emitted('expand')).toHaveLength(1)

      finish({ text: '查到啦。', images: [] })
      await flushPromises()
      expect(quick.find('.chat-message--assistant').text()).toContain('查到啦。')
      expect(quick.find('[aria-label="另一个对话窗口正在等待回复"]').exists()).toBe(false)
    } finally {
      full.unmount()
      quick.unmount()
      reply.mockRestore()
      discordSetup.agentRunId.mockReset()
      nativeDiscordBrowser.discordSetupSession.agentRunning = false
    }
  })
  it('discards prompt edits on returning to settings while preserving other settings drafts', async () => {
    const w = mount(ProductAssistant, { props: { getContext: () => context, execute: vi.fn() } })
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      const name = w.get<HTMLInputElement>('[aria-label="助手名字"]')
      await name.setValue('小蒜')
      await w.get('[aria-label="系统提示词"]').trigger('click')
      const original = w.get<HTMLTextAreaElement>('[aria-label="系统提示词内容"]').element.value
      await w.get('[aria-label="系统提示词内容"]').setValue('未保存提示')
      choose.mockResolvedValueOnce('alternative')
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(w.get<HTMLInputElement>('[aria-label="助手名字"]').element.value).toBe('小蒜')
      await w.get('[aria-label="系统提示词"]').trigger('click')
      expect(w.get<HTMLTextAreaElement>('[aria-label="系统提示词内容"]').element.value).toBe(
        original,
      )
      expect(workspace.savePreferences).not.toHaveBeenCalled()
    } finally {
      w.unmount()
    }
  })
  it.each([false, true])(
    'keeps prompt drafts behind the existing exit reminder and sends only saved edits (compact=%s)',
    async (compact) => {
      const reply = vi
        .spyOn(ProductAssistantService.prototype, 'reply')
        .mockResolvedValue({ text: '收到啦', images: [] })
      const w = mount(ProductAssistant, {
        props: { getContext: () => context, execute: vi.fn(), compact },
      })
      try {
        await flushPromises()
        await w.get('[aria-label="聊天设置"]').trigger('click')
        expect(w.find('[aria-label="系统提示词内容"]').exists()).toBe(false)
        await w.get('[aria-label="系统提示词"]').trigger('click')
        await w.get('[aria-label="系统提示词内容"]').setValue('自定义简洁提示词')
        choose.mockResolvedValueOnce('cancel')
        await w.get('[aria-label="返回功能桌面"]').trigger('click')
        await flushPromises()
        expect(choose).toHaveBeenCalledWith(expect.objectContaining({ title: '有修改未保存' }))
        expect(workspace.savePreferences).not.toHaveBeenCalled()
        choose.mockResolvedValueOnce('confirm')
        await w.get('[aria-label="返回功能桌面"]').trigger('click')
        await flushPromises()
        expect(workspace.savePreferences).toHaveBeenCalledWith(
          expect.objectContaining({ promptOverrides: { common: '自定义简洁提示词' } }),
        )
        expect(w.find('[aria-label="系统提示词内容"]').exists()).toBe(false)
        await w.get('[aria-label="返回功能桌面"]').trigger('click')
        await send(w, '你好')
        expect(reply.mock.calls[0]![0].promptOverrides).toEqual({ common: '自定义简洁提示词' })
      } finally {
        w.unmount()
        reply.mockRestore()
      }
    },
  )
  it.each([false, true])(
    'opens real returned reasoning without another API call (compact=%s)',
    async (compact) => {
      const reasoning = '  先确认用户问的是哪里修改。\n<script>这里只是返回的文本</script>  '
      const reply = vi
        .spyOn(ProductAssistantService.prototype, 'reply')
        .mockResolvedValue({ text: '功能在这里哦。', reasoning, images: [] })
      const w = mount(ProductAssistant, {
        props: { getContext: () => context, execute: vi.fn(), compact },
      })
      try {
        await send(w, '在哪里改呀')
        const trigger = w.get('[aria-label="查看这条回复的思考内容"]')
        expect(trigger.find('svg').exists()).toBe(true)
        expect(trigger.element.closest('.chat-message--assistant')).not.toBeNull()
        expect(w.get('.chat-bubble').text()).not.toContain('先确认用户')
        await trigger.trigger('click')
        await flushPromises()
        expect(w.get('.chat-reasoning-viewer pre').element.textContent).toBe(reasoning)
        expect(w.find('.chat-reasoning-viewer script').exists()).toBe(false)
        expect(reply).toHaveBeenCalledOnce()
        expect(workspace.save.mock.calls.at(-1)?.[0].history.at(-1).reasoning).toBe(reasoning)
      } finally {
        w.unmount()
      }
    },
  )
  it.each([undefined, '', ' \n '])(
    'does not invent reasoning when the API returns %s',
    async (reasoning) => {
      vi.spyOn(ProductAssistantService.prototype, 'reply').mockResolvedValue({
        text: '你好呀。',
        reasoning,
        images: [],
      })
      const w = render()
      try {
        await send(w, '你好')
        expect(w.find('.chat-reasoning-trigger').exists()).toBe(false)
      } finally {
        w.unmount()
      }
    },
  )
  it.each([false, true])(
    'only skips public-source confirmation when saved opt-in is %s',
    async (skip) => {
      workspace.preferences.mockReturnValue({
        ...workspace.preferences(),
        networkEnabled: true,
        githubReadWithoutConfirmation: skip,
      })
      readOnline.mockResolvedValue({
        source: 'https://github.com/octocat/Hello-World',
        text: 'Hello World!',
      })
      let execution: AssistantExecution | undefined
      vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
        async (request, _config, signal, host) => {
          execution = await host.execute(
            {
              action: 'online',
              operation: 'read-webpage',
              args: { url: 'https://github.com/octocat/Hello-World', path: 'README' },
            },
            request,
            signal,
          )
          return { text: execution.text, images: [] }
        },
      )
      const w = render()
      try {
        await send(w, '读取公开源码')
        expect(readOnline).toHaveBeenCalledOnce()
        expect(
          confirm.mock.calls.filter(([options]) => options.title === '读取公开资料'),
        ).toHaveLength(skip ? 0 : 1)
        expect(execution).toMatchObject({ showInChat: false, data: { text: 'Hello World!' } })
        expect(execution?.sources).toBeUndefined()
        expect(execution?.toolResult).toBeUndefined()
        expect(w.text()).toContain('已读取公开资料')
      } finally {
        w.unmount()
      }
    },
  )
  it('hides GitHub sources and public-data receipt buttons from saved chat messages', async () => {
    vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      async (_request, _config, _signal, host) => {
        host.onToolCall?.({ id: 'github-read', label: '读取 GitHub 资料', state: 'completed' })
        return {
          text: '我看完啦。',
          images: [],
          sources: [{ title: 'GitHub 源码', url: 'https://api.github.com/repos/example/repo' }],
          toolResults: [{ title: '公开资料回执', json: '{"private":"local receipt"}' }],
        }
      },
    )
    const w = render()
    try {
      await send(w, '查看资料')
      expect(w.find('.chat-sources').exists()).toBe(false)
      expect(w.text()).not.toContain('查看工具结果（本机）')
      expect(w.text()).not.toContain('已读取 GitHub 资料')
      expect(w.text()).not.toContain('local receipt')
    } finally {
      w.unmount()
    }
  })
  it('still confirms native search with public-source opt-in', async () => {
    workspace.preferences.mockReturnValue({
      ...workspace.preferences(),
      networkEnabled: true,
      providerSearch: true,
      githubReadWithoutConfirmation: true,
    })
    confirm.mockImplementation(async (options) => options.title !== '联网搜索')
    vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      async (request, _config, signal, host) => {
        const result = await host.execute(
          { action: 'online', operation: 'search-web', args: { query: '公开功能说明' } },
          request,
          signal,
        )
        expect(result.cancelled).toBe(true)
        return { text: result.text, images: [] }
      },
    )
    const w = render()
    try {
      await send(w)
      expect(confirm.mock.calls.some(([options]) => options.title === '联网搜索')).toBe(true)
      expect(readOnline).not.toHaveBeenCalled()
    } finally {
      w.unmount()
    }
  })
  it.each([
    {
      networkEnabled: false,
      url: 'https://github.com/octocat/Hello-World',
      error: '联网功能已关闭',
    },
    { networkEnabled: true, url: 'https://example.com/private', error: '仅支持 GitHub' },
    {
      networkEnabled: true,
      url: 'https://github.com/octocat/Hello-World?token=secret',
      error: '无凭据',
    },
  ])(
    'does not weaken network or target validation with opt-in: $error',
    async ({ networkEnabled, url, error }) => {
      workspace.preferences.mockReturnValue({
        ...workspace.preferences(),
        networkEnabled,
        githubReadWithoutConfirmation: true,
      })
      vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
        async (request, _config, signal, host) => {
          await expect(
            host.execute(
              { action: 'online', operation: 'read-webpage', args: { url } },
              request,
              signal,
            ),
          ).rejects.toThrow(error)
          return { text: '已阻止读取', images: [] }
        },
      )
      const w = render()
      try {
        await send(w)
        expect(readOnline).not.toHaveBeenCalled()
        expect(confirm.mock.calls.some(([options]) => options.title === '读取公开资料')).toBe(false)
      } finally {
        w.unmount()
      }
    },
  )
  it('confirms archiving before switching chats and retains the current conversation on cancel', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('仍要保留的输入')
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      const archive = w
        .findAll('button')
        .find((button) => button.text().includes('归档并开始新对话'))!
      workspace.save.mockClear()
      confirm.mockResolvedValueOnce(false)
      await archive.trigger('click')
      await flushPromises()
      expect(confirm).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: '归档并开始新对话', confirmLabel: '归档并新建' }),
      )
      expect(workspace.save).not.toHaveBeenCalled()
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(true)
      confirm.mockResolvedValueOnce(true)
      await archive.trigger('click')
      await flushPromises()
      expect(workspace.save.mock.calls[0]![0].input).toBe('仍要保留的输入')
      expect(workspace.save).toHaveBeenCalledWith(
        expect.objectContaining({ history: [], input: '' }),
        true,
      )
      expect(w.get<HTMLTextAreaElement>('[aria-label="发送消息"]').element.value).toBe('')
    } finally {
      w.unmount()
    }
  })

  it('follows settings saved by another chat entry and removes the subscription on teardown', async () => {
    const w = render()
    await flushPromises()
    const listener = workspace.onPreferencesChange.mock.calls[0]![0]
    const unsubscribe = workspace.onPreferencesChange.mock.results[0]!.value
    listener({ ...workspace.preferences(), estimateInputTokens: true })
    confirm.mockResolvedValue(false)
    await send(w, '短问题')
    expect(confirm.mock.lastCall![0].title).toContain('预计输入约')
    expect(confirm.mock.lastCall![0].tokenReview.parts.length).toBeGreaterThan(0)
    w.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('finishes and saves a hidden generation, showing its real reply in the pet bubble', async () => {
    let finish!: (value: AssistantRunResult) => void
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const w = render()
    try {
      await send(w, '功能在哪里呀')
      const signal = reply.mock.calls[0]![2]
      await w.setProps({ visible: false })
      expect(signal.aborted).toBe(false)
      finish({ text: '功能在这里哦', images: [] })
      await flushPromises()
      expect(w.get('.chat-message--assistant').text()).toContain('功能在这里哦')
      expect(workspace.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          history: expect.arrayContaining([expect.objectContaining({ text: '功能在这里哦' })]),
        }),
        false,
        expect.any(String),
      )
      expect(assistantPetCue.value?.text).toBe('功能在这里哦，点开看详情')
      workspace.initialize.mockResolvedValueOnce(workspace.save.mock.calls.at(-1)![0])
      await w.setProps({ visible: true })
      await flushPromises()
      expect(w.get('.chat-message--assistant').text()).toContain('功能在这里哦')
      expect(reply).toHaveBeenCalledOnce()
      expect(w.emitted('activity')?.at(-1)).toEqual([false])
    } finally {
      w.unmount()
    }
  })
  it('can stop the same pending generation after hiding and reopening, and aborts on real teardown', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementation(() => new Promise(() => {}))
    const w = render()
    await send(w)
    const signal = reply.mock.calls[0]![2]
    await w.setProps({ visible: false })
    await w.setProps({ visible: true })
    expect(signal.aborted).toBe(false)
    await w.get('[aria-label="停止生成"]').trigger('click')
    expect(signal.aborted).toBe(true)
    expect(reply).toHaveBeenCalledOnce()
    w.unmount()
    const another = render()
    await send(another)
    const teardownSignal = reply.mock.calls[1]![2]
    another.unmount()
    expect(teardownSignal.aborted).toBe(true)
  })
  it.each([undefined, 1])(
    'does not inject an input cap from compression preferences (%s)',
    async (compressionTokenThreshold) => {
      workspace.preferences.mockReturnValue({
        ...workspace.preferences(),
        autoCompressContext: false,
        compressionTokenThreshold,
      })
      const reply = vi
        .spyOn(ProductAssistantService.prototype, 'reply')
        .mockResolvedValue({ text: '收到', images: [] })
      const w = render()
      try {
        await send(w, '需求'.repeat(10000))
        expect(reply).toHaveBeenCalledOnce()
        expect(reply.mock.calls[0]![0]).not.toHaveProperty('contextTokenLimit')
        expect(reply.mock.calls[0]![0].history.at(-1)?.text).toBe('需求'.repeat(10000))
      } finally {
        w.unmount()
      }
    },
  )
  it('opens the existing template editor from the header SVG plus', async () => {
    workspace.templates.mockResolvedValue([])
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w
        .findAll('button')
        .find((b) => b.text() === '任务模板›')!
        .trigger('click')
      await flushPromises()
      const create = w.get('.feature-app-header [aria-label="新建模板"]')
      expect(create.find('svg').exists()).toBe(true)
      expect(w.findAll('[aria-label="新建模板"]')).toHaveLength(1)
      await create.trigger('click')
      await flushPromises()
      expect(w.get('[aria-label="模板名称"]').element).toHaveProperty('value', '')
    } finally {
      w.unmount()
    }
  })
  it('appends a task template to an existing composer draft without sending or generating', async () => {
    const run = vi.spyOn(ProductAssistantService.prototype, 'reply')
    workspace.templates.mockResolvedValue([
      { id: 'task', name: '检查保存', steps: ['预览', '重载检查'] },
    ])
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('已有的要求')
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w
        .findAll('button')
        .find((b) => b.text() === '任务模板›')!
        .trigger('click')
      await flushPromises()
      let finishSave!: () => void
      const stored = new Promise<undefined>((resolve) => {
        finishSave = () => resolve(undefined)
      })
      workspace.save.mockReturnValue(stored)
      await w.get('[aria-label="使用模板 检查保存"]').trigger('click')
      await flushPromises()
      expect(w.find('[aria-label="常用任务模板"]').exists()).toBe(true)
      finishSave()
      await flushPromises()
      expect(w.find('[aria-label="常用任务模板"]').exists()).toBe(false)
      expect(w.get('[aria-label="发送消息"]').element).toHaveProperty(
        'value',
        '已有的要求\n\n检查保存\n1. 预览\n2. 重载检查',
      )
      expect(run).not.toHaveBeenCalled()
      expect(w.findAll('[data-turn-id]')).toHaveLength(0)
    } finally {
      w.unmount()
      run.mockRestore()
    }
  })
  it('uses a reactive saved skill row without cloning a Vue proxy or starting a model request', async () => {
    const run = vi.spyOn(ProductAssistantService.prototype, 'reply')
    workspace.templates.mockResolvedValue([
      {
        id: 'skill',
        name: '定位保存',
        description: '先取证再复验',
        mode: 'features',
        steps: ['核对入口'],
        capabilities: ['history'],
        version: 2,
      },
    ])
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w
        .findAll('button')
        .find((button) => button.text() === '任务模板›')!
        .trigger('click')
      await flushPromises()
      await w.get('[aria-label="使用模板 定位保存"]').trigger('click')
      await flushPromises()
      expect(w.find('.chat-composer .assistant-task-context').exists()).toBe(false)
      expect(w.find('[aria-label="退出技能 定位保存"]').exists()).toBe(false)
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await flushPromises()
      expect(w.find('[aria-label="退出技能 定位保存"]').exists()).toBe(true)
      expect(w.get('[aria-label="发送消息"]').element).toHaveProperty(
        'value',
        '使用技能“定位保存”：先取证再复验',
      )
      expect(workspace.save.mock.calls.at(-1)?.[0].taskSkill).toMatchObject({
        id: 'skill',
        version: 2,
      })
      expect(run).not.toHaveBeenCalled()
    } finally {
      w.unmount()
      run.mockRestore()
    }
  })
  it('asks before leaving edited settings and supports staying, discarding or saving', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(true)
      choose.mockResolvedValueOnce('cancel')
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(choose).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '有修改未保存',
          confirmLabel: '保存并退出',
          alternativeLabel: '不保存退出',
          cancelLabel: '继续编辑',
        }),
      )
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(true)
      expect(workspace.savePreferences).not.toHaveBeenCalled()
      choose.mockResolvedValueOnce('alternative')
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(false)
      expect(workspace.savePreferences).not.toHaveBeenCalled()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      expect(w.get<HTMLInputElement>('[aria-label="联网工具"]').element.checked).toBe(false)
      await w.get('[aria-label="联网工具"]').setValue(true)
      choose.mockResolvedValueOnce('confirm')
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(workspace.savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ networkEnabled: true }),
      )
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(false)
    } finally {
      w.unmount()
    }
  })
  it('keeps edited settings open when saving fails and allows a successful retry', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(true)
      choose.mockResolvedValue('confirm')
      workspace.savePreferences.mockRejectedValueOnce(new Error('存储失败'))
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(w.get('[role="alert"]').text()).toBe('存储失败')
      expect(w.get<HTMLInputElement>('[aria-label="联网工具"]').element.checked).toBe(true)
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      expect(workspace.savePreferences).toHaveBeenCalledTimes(2)
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(false)
    } finally {
      w.unmount()
    }
  })
  it('does not queue duplicate prompts or discard edits made during a pending save', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(true)
      let finish!: () => void
      const pending = new Promise<void>((resolve) => (finish = resolve))
      workspace.savePreferences.mockImplementationOnce(async (value) => {
        await pending
        return { ...value }
      })
      choose.mockResolvedValue('confirm')
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await flushPromises()
      await w.get('[aria-label="返回功能桌面"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(false)
      finish()
      await flushPromises()
      expect(choose).toHaveBeenCalledOnce()
      expect(workspace.savePreferences).toHaveBeenCalledOnce()
      expect(workspace.savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ networkEnabled: true }),
      )
      expect(w.get<HTMLInputElement>('[aria-label="联网工具"]').element.checked).toBe(false)
      expect(w.get('.chat-settings-save [role="status"]').text()).toBe('有修改，待保存')
    } finally {
      w.unmount()
    }
  })
  it.each(['escape', 'native'])('guards the settings %s back path', async (path) => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(true)
      if (path === 'escape') {
        await w.get('[aria-label="联网工具"]').trigger('keydown', { key: 'Escape' })
      } else {
        const detail = { handled: false }
        window.dispatchEvent(new CustomEvent('srl:back-request', { detail }))
        expect(detail.handled).toBe(true)
      }
      await flushPromises()
      expect(choose).toHaveBeenCalledOnce()
      expect(w.find('[aria-label="联网工具"]').exists()).toBe(true)
      expect(workspace.savePreferences).not.toHaveBeenCalled()
    } finally {
      w.unmount()
    }
  })
  it.each(['archive', 'history', 'expand'])('guards the settings %s exit path', async (path) => {
    const w = render()
    try {
      await flushPromises()
      await w.setProps({ compact: true })
      workspace.list.mockResolvedValue({
        items: [{ id: 'other', title: '另一对话', updatedAt: 1 }],
        total: 1,
      })
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w.get('[aria-label="联网工具"]').setValue(true)
      if (path === 'expand') {
        await w.get('[aria-label="展开完整对话"]').trigger('click')
      } else if (path === 'archive') {
        await w
          .findAll('button')
          .find((button) => button.text() === '归档并开始新对话›')!
          .trigger('click')
      } else {
        await w
          .findAll('button')
          .find((button) => button.text() === '历史对话›')!
          .trigger('click')
        await flushPromises()
        await w.get('.chat-history-open').trigger('click')
      }
      await flushPromises()
      expect(choose).toHaveBeenCalledOnce()
      expect(workspace.savePreferences).not.toHaveBeenCalled()
      expect(workspace.save).not.toHaveBeenCalled()
      expect(workspace.switch).not.toHaveBeenCalled()
      expect(w.findComponent(ProductAssistantSettings).exists()).toBe(true)
      expect(w.emitted('expand')).toBeUndefined()
    } finally {
      w.unmount()
    }
  })
  it('collapses summarized originals and expands the actual message selected from search', async () => {
    const history = [
      { id: 'old', role: 'user' as const, text: '早年紫色方案' },
      { id: 'answer', role: 'assistant' as const, text: '已记录' },
      { id: 'latest', role: 'user' as const, text: '继续' },
    ]
    const contextSummary = await new ProductAssistantContextService({
      completeWithUsage: vi
        .fn()
        .mockResolvedValue({ text: '关键词：紫色；原文ID：old', finishReason: 'stop' }),
    }).compress(
      history,
      undefined,
      planAssistantCompression(history, undefined, 1),
      DEFAULT_MAIN_API_CONFIG,
      new AbortController().signal,
      vi.fn(),
    )
    const chat = {
      id: 'old-chat',
      title: '旧方案',
      updatedAt: 1,
      history,
      input: '',
      images: [],
      contextSummary,
    }
    workspace.initialize.mockResolvedValue(chat)
    workspace.switch.mockResolvedValue(chat)
    const w = render()
    try {
      await flushPromises()
      expect(w.find('[data-turn-id="old"]').exists()).toBe(false)
      expect(w.find('[data-turn-id="latest"]').exists()).toBe(true)
      await w.get('[aria-label="聊天设置"]').trigger('click')
      w.findComponent(ProductAssistantSettings).vm.$emit('open', 'old-chat', 'old')
      await flushPromises()
      expect(w.get('[data-turn-id="old"]').text()).toContain('早年紫色方案')
      expect(w.get('.chat-history-summary').attributes('open')).toBeDefined()
      expect(w.get('[data-turn-id="old"]').classes()).toContain('chat-message--found')
    } finally {
      w.unmount()
    }
  })

  it('keeps an excluded message visible and persists both exclusion and restoration through the small menu', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('保留聊天显示')
      await w.get('form').trigger('submit')
      await flushPromises()
      await w.get('[aria-haspopup="menu"]').trigger('contextmenu')
      await w.get('[aria-label="隐藏"]').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('保留聊天显示')
      expect(w.text()).toContain('不参与上下文和总结')
      expect(workspace.save.mock.lastCall![0].history[0].contextExcluded).toBe(true)
      await w.get('[aria-haspopup="menu"]').trigger('contextmenu')
      expect(w.get('[aria-label="取消隐藏"]').text()).toContain('取消隐藏')
      await w.get('[aria-label="取消隐藏"]').trigger('click')
      await flushPromises()
      expect(workspace.save.mock.lastCall![0].history[0].contextExcluded).toBe(false)
    } finally {
      w.unmount()
    }
  })
  it('keeps the per-star token review after initial consent and does not generate when cancelled', async () => {
    workspace.preferences.mockReturnValue({ ...workspace.preferences(), estimateInputTokens: true })
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '收到。', images: [] })
    const w = render()
    try {
      await send(w)
      expect(confirm.mock.lastCall![0].title).toContain('预计输入约')
      expect(reply).toHaveBeenCalledTimes(1)
      confirm.mockResolvedValueOnce(false)
      discordSetup.suspendForModelConsent.mockResolvedValueOnce(true)
      await w.get('[aria-label="生成回复"]').trigger('click')
      await flushPromises()
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(discordSetup.restoreAfterModelConsent).toHaveBeenCalledWith(false)
      expect(reply).toHaveBeenCalledTimes(1)
      expect(w.findAll('.chat-message--user')).toHaveLength(1)
      expect(w.findAll('.chat-message--assistant')).toHaveLength(1)
    } finally {
      w.unmount()
    }
  })
  it('saves the full reply before navigating and blocks navigation on a failed save', async () => {
    const destination = { target: 'cloud', title: '云备份' }
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '即将打开云备份。', images: [], navigation: destination })
    const order: string[] = []
    workspace.save.mockImplementation(async () => {
      order.push('save')
    })
    const navigate = vi.fn(async () => {
      order.push('navigate')
    })
    const w = render()
    try {
      await w.setProps({ navigate })
      await send(w, '帮我打开云备份')
      expect(navigate).toHaveBeenCalledWith('cloud')
      const navigatedAt = order.indexOf('navigate')
      expect(order[navigatedAt - 1]).toBe('save')
      expect(order.slice(navigatedAt + 1)).toContain('save')
      expect(workspace.save.mock.calls.at(-1)?.[0].history.at(-1)?.text).toBe('即将打开云备份。')
      navigate.mockClear()
      await w.get('[aria-label="发送消息"]').setValue('再次打开')
      await w.get('form').trigger('submit')
      await flushPromises()
      workspace.save.mockImplementation(async (chat) => {
        if (chat.history.some((turn: { role: string }) => turn.role === 'assistant'))
          throw new Error('存储空间不足')
      })
      await w.get('[aria-label="生成回复"]').trigger('click')
      await flushPromises()
      expect(reply).toHaveBeenCalledTimes(2)
      expect(navigate).not.toHaveBeenCalled()
      expect(w.get('[role="alert"]').text()).toContain('存储空间不足')
    } finally {
      w.unmount()
    }
  })
  it('queues multiple messages without requests, generates explicitly and edits/resends/deletes both roles', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '好的，已记录。', images: [] })
    const w = render()
    try {
      await flushPromises()
      for (const text of ['先改圆角', '再换背景']) {
        await w.get('[aria-label="发送消息"]').setValue(text)
        await w.get('form').trigger('submit')
        await flushPromises()
      }
      expect(w.findAll('.chat-message--user')).toHaveLength(2)
      expect(reply).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
      await w.get('[aria-label="生成回复"]').trigger('click')
      await flushPromises()
      expect(reply.mock.calls[0]![0].history.map((turn) => turn.text)).toEqual([
        '先改圆角',
        '再换背景',
      ])
      await w.findAll('[aria-haspopup="menu"]')[0]!.trigger('contextmenu')
      await w
        .findAll('[role="menuitem"]')
        .find((b) => b.attributes('aria-label') === '编辑问题')!
        .trigger('click')
      await flushPromises()
      await w.get('[aria-label="发送消息"]').setValue('圆角改为24px')
      await w.get('form').trigger('submit')
      await flushPromises()
      expect(w.findAll('.chat-message--user')).toHaveLength(2)
      expect(w.findAll('.chat-message--user')[0]!.text()).toContain('24px')
      expect(reply).toHaveBeenCalledOnce()
      await w.findAll('[aria-haspopup="menu"]')[2]!.trigger('contextmenu')
      await w.get('[aria-label="收藏消息"]').trigger('click')
      await flushPromises()
      expect(w.find('.chat-message--assistant .chat-bookmarked').text()).toBe('已收藏')
      expect(
        workspace.save.mock.calls
          .at(-1)?.[0]
          .history.find((turn: { role: string }) => turn.role === 'assistant').favorite,
      ).toBe(true)
      await w.findAll('[aria-haspopup="menu"]')[2]!.trigger('contextmenu')
      await w.get('[aria-label="取消收藏"]').trigger('click')
      await flushPromises()
      expect(w.find('.chat-message--assistant .chat-bookmarked').exists()).toBe(false)
      await w.findAll('[aria-haspopup="menu"]')[0]!.trigger('contextmenu')
      await w
        .findAll('[role="menuitem"]')
        .find((b) => b.attributes('aria-label') === '重新发送')!
        .trigger('click')
      await flushPromises()
      expect(w.findAll('.chat-message--user')).toHaveLength(3)
      expect(reply).toHaveBeenCalledOnce()
      await w.findAll('[aria-haspopup="menu"]')[2]!.trigger('contextmenu')
      await w
        .findAll('[role="menuitem"]')
        .find((b) => b.attributes('aria-label') === '删除消息')!
        .trigger('click')
      await flushPromises()
      expect(w.find('.chat-message--assistant').exists()).toBe(false)
      await w.findAll('[aria-haspopup="menu"]')[0]!.trigger('contextmenu')
      await w
        .findAll('[role="menuitem"]')
        .find((b) => b.attributes('aria-label') === '删除消息')!
        .trigger('click')
      await flushPromises()
      expect(w.findAll('.chat-message--user')).toHaveLength(2)
      expect(workspace.save).toHaveBeenCalled()
    } finally {
      w.unmount()
    }
  })
  it('keeps a source draft visible after deleting the AI message that carried it', async () => {
    const { ProductAssistantAppSession } = await import('../services/ProductAssistantAppSession')
    vi.spyOn(ProductAssistantAppSession.prototype, 'summary').mockReturnValue({
      id: 'draft',
      revision: 1,
      name: '保留草稿',
      files: ['index.html'],
    })
    workspace.initialize.mockResolvedValue({
      id: 'chat',
      title: '草稿',
      updatedAt: 1,
      history: [
        {
          id: 'ai',
          role: 'assistant',
          text: '做好了',
          app: { id: 'draft', revision: 1, name: '保留草稿', files: [] },
        },
      ],
      input: '',
      images: [],
    })
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-haspopup="menu"]').trigger('contextmenu')
      await w
        .findAll('[role="menuitem"]')
        .find((b) => b.attributes('aria-label') === '删除消息')!
        .trigger('click')
      await flushPromises()
      expect(w.text()).not.toContain('做好了')
      expect(w.get('.chat-app-preview').text()).toContain('保留草稿')
      expect(w.get('[aria-label="预览 APP"]').text()).toBe('预览')
    } finally {
      w.unmount()
    }
  })
  const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'showModal',
  )
  const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: vi.fn(),
    })
    vi.clearAllMocks()
    resetConversationSync()
    confirm.mockResolvedValue(true)
    choose.mockResolvedValue('cancel')
    workspace.savePreferences.mockImplementation(async (value) => ({ ...value }))
    workspace.preferences.mockReturnValue({
      name: '蒜惹菈',
      avatar: '/icons/assistant-avatar.png',
      apiProfileId: '',
    })
    workspace.initialize.mockImplementation(async () => ({
      id: crypto.randomUUID(),
      title: '新对话',
      updatedAt: Date.now(),
      history: [],
      input: '',
      images: [],
    }))
    workspace.config.mockImplementation((fallback) => fallback)
    workspace.save.mockImplementation(async (chat, _activate, sourceId) =>
      publishConversation(chat, sourceId),
    )
    workspace.list.mockResolvedValue({ items: [], total: 0 })
    getConfig.mockReturnValue({
      ...DEFAULT_MAIN_API_CONFIG,
      url: 'https://example.com/v1',
      model: 'vision-model',
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalShowModal)
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
    if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
    else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  })
  it('opens history settings from the header SVG and closes that dialog before leaving history', async () => {
    const w = render()
    try {
      await flushPromises()
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w
        .findAll('button')
        .find((button) => button.text() === '历史对话›')!
        .trigger('click')
      await flushPromises()
      const gear = w.get('[aria-label="历史设置"]')
      expect(gear.find('svg').exists()).toBe(true)
      await gear.trigger('click')
      await flushPromises()
      expect(w.findComponent(ProductAssistantSettings).vm.historyRecoveryOpen).toBe(true)
      const detail = { handled: false }
      window.dispatchEvent(new CustomEvent('srl:back-request', { detail }))
      await flushPromises()
      expect(detail.handled).toBe(true)
      expect(w.findComponent(ProductAssistantSettings).vm.historyRecoveryOpen).toBe(false)
      expect(w.find('[aria-label="历史设置"]').exists()).toBe(true)
    } finally {
      w.unmount()
    }
  })
  it('updates centered system messages in place, keeps them local to each turn and clears them with a new chat', async () => {
    let report!: NonNullable<AssistantToolHost['onToolCall']>
    let finish!: (value: AssistantRunResult) => void
    vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      async (_request, _config, _signal, host) => {
        report = host.onToolCall!
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    )
    const w = render()
    try {
      await send(w)
      report({ id: 'same-id', label: '读取样式', state: 'running' })
      await flushPromises()
      const row = w.get('[data-state="running"]').element
      expect(w.findAll('.chat-system-message')).toHaveLength(1)
      expect(w.find('.chat-bubble--working').exists()).toBe(false)
      expect(w.find('.chat-avatar').exists()).toBe(false)
      expect(w.get('[data-state="running"]').findAll('.chat-system-message__dot')).toHaveLength(1)
      expect(w.find('.chat-system-message svg, .chat-system-message .chat-thinking').exists()).toBe(
        false,
      )
      expect(w.get('.chat-message--user').text()).toBe('卡片改浅紫')
      expect(row.closest('.chat-bubble')).toBeNull()
      report({ id: 'same-id', label: '读取样式', state: 'completed' })
      report({ id: 'failed', label: '应用美化', state: 'failed' })
      report({ id: 'cancelled', label: '安装 APP', state: 'cancelled' })
      await flushPromises()
      expect(w.get('[data-state="completed"]').element).toBe(row)
      expect(w.get('[data-state="failed"]').text()).toContain('未完成')
      expect(w.get('[data-state="cancelled"]').text()).toContain('已取消')
      finish({ text: '请调整要求后继续。', status: '内部回执', images: [] })
      await flushPromises()
      expect(w.findAll('[data-state]')).toHaveLength(3)
      expect(w.get('.chat-message--assistant').text()).toBe('请调整要求后继续。')
      expect(w.text()).not.toContain('内部回执')
      expect(w.find('.chat-action-status').exists()).toBe(false)
      await send(w, '再读一下')
      report({ id: 'same-id', label: '读取样式', state: 'completed' })
      finish({ text: '读取完成。', images: [] })
      await flushPromises()
      expect(w.findAll('[data-state="completed"]')).toHaveLength(2)
      expect(w.findAll('[data-state]')).toHaveLength(4)
      await w.get('[aria-label="聊天设置"]').trigger('click')
      await w
        .findAll('button')
        .find((button) => button.text().includes('归档并开始新对话'))!
        .trigger('click')
      await flushPromises()
      expect(w.find('.chat-system-message').exists()).toBe(false)
    } finally {
      w.unmount()
    }
  })
  it.each([false, true])(
    'reviews the concrete result before disclosure, keeps local result out of payload and binds approval to the active request target (share=%s)',
    async (share) => {
      const descriptor = {
        id: 'com.example.tool/note',
        appId: 'com.example.tool',
        name: 'note',
        title: '笔记',
        appName: '笔记 APP',
        version: '1.0.0',
        fingerprint: 'current',
        permissions: ['app.storage'],
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }
      appOwner.requireCustomTool.mockResolvedValue(descriptor)
      appOwner.listCustomTools.mockResolvedValue({ items: [descriptor], total: 1 })
      invokeTool.mockImplementation(async () => {
        getConfig.mockReturnValue({
          ...DEFAULT_MAIN_API_CONFIG,
          url: 'https://changed.example/v2',
          model: 'changed-model',
        })
        return { private: 'APP_PRIVATE_RESULT' }
      })
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(share)
      let execution: AssistantExecution | undefined
      vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
        async (request, _config, signal, host) => {
          const list = await host.execute(
            { action: 'custom-tools', operation: 'list', args: { query: '*', offset: '0' } },
            request,
            signal,
          )
          expect(list.data?.items).toEqual([descriptor])
          execution = await host.execute(
            {
              action: 'custom-tools',
              operation: 'run',
              args: { id: descriptor.id, fingerprint: 'current', arguments: '{}' },
            },
            request,
            signal,
          )
          return {
            text: execution.text,
            images: [],
            status: execution.status,
            toolResults: [execution.toolResult!],
          }
        },
      )
      const w = render()
      try {
        await send(w, '运行笔记工具')
        expect(invokeTool).toHaveBeenCalledOnce()
        expect(confirm.mock.calls[2]![0].message).toContain('APP_PRIVATE_RESULT')
        expect(confirm.mock.calls[2]![0].message).toContain('https://example.com/v1')
        expect(confirm.mock.calls[2]![0].message).not.toContain('changed.example')
        expect(execution?.data).toEqual(
          share
            ? { executed: true, result: { private: 'APP_PRIVATE_RESULT' } }
            : { executed: true, resultWithheld: true },
        )
        expect(w.text()).toContain('查看工具结果（本机）')
        expect(w.find('.chat-tool-workspace').exists()).toBe(false)
        expect(w.find('.chat-tool-result').text()).not.toContain('APP_PRIVATE_RESULT')
      } finally {
        w.unmount()
      }
    },
  )
  it('keeps one preview in chat, routes APP tools to its owner, confirms installation, and clears only the draft', async () => {
    const manifest = { id: 'com.srl.ai.test', name: '打卡', entry: 'index.html', version: '1.0.0' }
    const preview = {
      manifest,
      packageFiles: { 'index.html': new TextEncoder().encode('<html>预览</html>') },
      runtimeHtml: '<html>预览</html>',
      requestedPermissions: ['app.storage'],
      packageFingerprint: 'fingerprint',
    }
    appOwner.createSourcePreview.mockResolvedValue(preview)
    appOwner.install.mockResolvedValue({ id: manifest.id })
    appOwner.get.mockResolvedValue({ packageFingerprint: 'fingerprint' })
    vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      async (request, _config, signal, host) => {
        const created = await host.execute(
          {
            action: 'app',
            operation: 'create',
            args: {
              name: '打卡',
              description: '测试',
              files: '{"index.html":"<html>预览</html>"}',
              permissions: '["app.storage"]',
            },
          },
          request,
          signal,
        )
        host.onExecution?.(created)
        const shown = await host.execute(
          { action: 'app', operation: 'preview', args: {} },
          { ...host.getContext(), history: request.history },
          signal,
        )
        host.onExecution?.(shown)
        return { text: '真实预览已展开', app: shown.app, images: [] }
      },
    )
    const appearanceOwner = vi.fn()
    const wrapper = render(appearanceOwner)
    await send(wrapper, '帮我做一个 APP')
    expect(appearanceOwner).not.toHaveBeenCalled()
    const frame = wrapper.get('iframe').element
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe('<html>预览</html>')
    const installButton = wrapper.get('[aria-label="安装到扩展"]')
    await installButton.trigger('click')
    await flushPromises()
    expect(confirm.mock.lastCall![0].message).toContain('保存此 APP 自己的本地数据')
    expect(appOwner.install).toHaveBeenCalledOnce()
    expect(wrapper.findAll('iframe')).toHaveLength(1)
    expect(wrapper.get('iframe').element).toBe(frame)
    expect(wrapper.text()).toContain('已安装')
    await wrapper.get('[aria-label="聊天设置"]').trigger('click')
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('归档并开始新对话'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(appOwner.install).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('automatically executes an edit and displays verified owner results in bubbles', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockImplementation(async (request, _config, signal, host) => {
        host.onToolCall?.({ id: 'style', label: '应用美化', state: 'running' })
        const result = await host.execute(
          {
            action: 'style',
            answer: '模型说完成',
            scope: 'library',
            css: '.resource-card{color:purple}',
          },
          request,
          signal,
        )
        host.onExecution?.(result)
        host.onToolCall?.({ id: 'style', label: '应用美化', state: 'completed' })
        return {
          text: result.text,
          status: result.status,
          images: result.image ? [result.image] : [],
        }
      })
    const execute = vi.fn().mockResolvedValue({
      text: '真正应用成功',
      status: '已应用到资源库',
      image: {
        id: 'result',
        name: '效果.jpg',
        dataUrl: 'data:image/jpeg;base64,AA',
        result: true,
      },
    })
    const w = render(execute)
    await send(w)
    expect(confirm.mock.calls[0]![0].message).toContain('example.com/v1')
    expect(execute).toHaveBeenCalledOnce()
    expect(w.get('.chat-message--user').text()).toBe('卡片改浅紫')
    expect(w.get('.chat-message--assistant').text()).toContain('真正应用成功')
    expect(w.get('[data-state="completed"]').text()).toBe('已应用美化')
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('[aria-label="AI CSS 方案"]').exists()).toBe(false)
    expect(w.get('.chat-image img').attributes('src')).toContain('image/jpeg')
    await send(w, '保存为预设')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[1]![0].history[1]?.images?.[0]?.result).toBe(true)
    expect(reply.mock.calls[1]![0].history[1]?.status).toBe('已应用到资源库')
    w.unmount()
  })
  it('asks sending consent again for new reference images and keeps them in chat', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '想改哪里？', images: [] })
    const w = render()
    await send(w)
    const upload = w.get<HTMLInputElement>('input[type=file]')
    Object.defineProperty(upload.element, 'files', {
      value: [new File(['png'], '截图.png', { type: 'image/png' })],
      configurable: true,
    })
    await upload.trigger('change')
    await vi.waitFor(() => expect(w.find('.chat-attachments img').exists()).toBe(true))
    await send(w, '照着这张图改')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(
      reply.mock.calls[1]![0].history.filter((turn) => turn.role === 'user').at(-1)?.images?.[0]
        ?.name,
    ).toBe('截图.png')
    expect(w.find('.chat-attachments').exists()).toBe(false)
    w.unmount()
  })
  it('attaches JSON as a compact style reference and sends it through normal consent', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockResolvedValue({ text: '我会按参考风格适配。', images: [] })
    const w = render()
    await send(w)
    const upload = w.get<HTMLInputElement>('input[type=file]')
    Object.defineProperty(upload.element, 'files', {
      value: [
        new File(['{ "theme": { "primary": "#8aaacc", "radius": 14 } }'], 'design.json', {
          type: 'application/json',
        }),
      ],
      configurable: true,
    })
    await upload.trigger('change')
    await vi.waitFor(() => expect(w.find('.chat-attachments').text()).toContain('design.json'))
    await send(w, '按它的风格改全局 CSS')
    expect(confirm.mock.calls.length).toBeGreaterThanOrEqual(2)
    const reference = reply.mock.calls[1]![0].history.filter((turn) => turn.role === 'user').at(-1)
    expect(reference?.designReferences?.[0]).toMatchObject({
      name: 'design.json',
      json: '{"theme":{"primary":"#8aaacc","radius":14}}',
    })
    expect(w.find('.chat-json-reference--message').text()).toContain('design.json')
    expect(w.findAll('.chat-message--user').at(-1)?.text()).not.toContain('#8aaacc')
    w.unmount()
  })
  it('preserves a failed input and prevents late cancelled replies from executing', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockRejectedValue(new Error('模型不支持图片'))
    const execute = vi.fn()
    const w = render(execute)
    await send(w)
    expect(w.get<HTMLTextAreaElement>('[aria-label="发送消息"]').element.value).toBe('')
    expect(w.get('[role=alert]').text()).toContain('不支持图片')
    let resolve!: (value: AssistantRunResult) => void
    reply.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await send(w, '再试')
    expect(w.emitted('activity')?.at(-1)).toEqual([true])
    await w.get('[aria-label="停止生成"]').trigger('click')
    expect(reply.mock.calls[1]![2].aborted).toBe(true)
    resolve({
      text: '晚到',
      images: [],
    })
    await flushPromises()
    expect(execute).not.toHaveBeenCalled()
    expect(w.emitted('activity')?.at(-1)).toEqual([false])
    expect(w.text()).not.toContain('晚到')
    w.unmount()
  })
  it('does not call the model when sending consent is declined', async () => {
    confirm.mockResolvedValue(false)
    const reply = vi.spyOn(ProductAssistantService.prototype, 'reply')
    const w = render()
    await send(w)
    expect(reply).not.toHaveBeenCalled()
    expect(w.get<HTMLTextAreaElement>('[aria-label="发送消息"]').element.value).toBe('')
    w.unmount()
  })
  it('keeps only a classified recent API failure for on-demand diagnostics and clears it with new chat', async () => {
    const reply = vi
      .spyOn(ProductAssistantService.prototype, 'reply')
      .mockRejectedValueOnce(
        new Error('HTTP 429 PRIVATE_API_ERROR https://example.com/?key=PRIVATE_KEY'),
      )
      .mockResolvedValue({ text: '服务限流，需要核对额度。', images: [] })
    const w = render()
    await send(w, '为什么不回复')
    expect(w.get('[role=alert]').text()).toContain('检查服务额度')
    await send(w, '检查 AI 助手')
    expect(reply.mock.calls[1]![0].recentProblem).toMatchObject({
      kind: 'rate-limit',
      httpStatus: 429,
    })
    expect(JSON.stringify(reply.mock.calls[1]![0].recentProblem)).not.toMatch(
      /PRIVATE_|example.com/u,
    )
    expect(JSON.stringify(reply.mock.calls[1]![0].history)).not.toContain('PRIVATE_API_ERROR')
    await w.get('[aria-label="聊天设置"]').trigger('click')
    await w
      .findAll('button')
      .find((button) => button.text().includes('归档并开始新对话'))!
      .trigger('click')
    await flushPromises()
    await send(w, '新的问题')
    expect(reply.mock.calls[2]![0].recentProblem).toBeUndefined()
    w.unmount()
  })
  it('shows real receipts immediately and keeps them after stopping the remaining model reply', async () => {
    let finish!: (value: AssistantRunResult) => void
    vi.spyOn(ProductAssistantService.prototype, 'reply').mockImplementation(
      async (request, _config, signal, host) => {
        host.onToolCall?.({ id: 'save', label: '保存当前预设', state: 'running' })
        const executed = await host.execute(
          { action: 'save', answer: '保存当前预设' },
          request,
          signal,
        )
        host.onExecution?.(executed)
        host.onToolCall?.({ id: 'save', label: '保存当前预设', state: 'completed' })
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    )
    const w = render(vi.fn().mockResolvedValue({ text: '真实保存成功', status: '已保存预设' }))
    await send(w)
    expect(w.get('[data-state="completed"]').text()).toBe('已保存当前预设')
    await w.get('[aria-label="停止生成"]').trigger('click')
    finish({
      text: '已保存；停止后续操作。',
      status: '已保存预设',
      images: [],
      warning: '已停止后续操作',
    })
    await flushPromises()
    expect(w.findAll('.chat-message--assistant')).toHaveLength(1)
    expect(w.get('[data-state="completed"]').text()).toBe('已保存当前预设')
    expect(w.get('[role=alert]').text()).toContain('已停止')
    expect(w.get<HTMLTextAreaElement>('[aria-label="发送消息"]').element.value).toBe('')
    w.unmount()
  })
})
