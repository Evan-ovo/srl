/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { appearanceScopes } from '../core/AppearanceScopes'
import { DEFAULT_MAIN_API_CONFIG, type MainApiTool } from './MainApiService'
import { describeAssistantInput } from './ProductAssistantContext'
import { assistantDiscordGuidance } from './ProductAssistantDiscordGuidance'
import {
  buildAssistantMessages,
  getAssistantRequestTools,
  ProductAssistantService,
  type AssistantRequest,
} from './ProductAssistantService'

const context = (): AssistantRequest => ({
  mode: 'auto',
  presetId: 'draft',
  appliedCss: '',
  css: {},
  scopes: appearanceScopes(),
  currentScope: 'library',
  history: [{ role: 'user', text: '核对失败入口，修复后沿原操作验证' }],
  canUseNetwork: true,
  canSearchWeb: true,
  canUseBrowser: true,
  canConfigureDiscordBrowser: true,
  canRunPageScripts: true,
  canControlPet: true,
  canCaptureCurrent: true,
})
const names = (tools: readonly MainApiTool[]) => tools.map(({ name }) => name)
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  name,
  arguments: JSON.stringify(args),
})
const reply = (toolCalls?: ReturnType<typeof call>[]) => ({
  text: toolCalls ? '' : '定位证据已取得，原失败操作仍待复验。',
  finishReason: toolCalls ? 'tool_calls' : 'stop',
  toolCalls,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: 'provider' as const },
})
const signal = () => new AbortController().signal

describe('assistant task capability routing', () => {
  it('loads one matching skill without opening a disabled capability or adding another storage owner', async () => {
    const current: AssistantRequest = {
      ...context(),
      mode: 'features',
      capabilities: ['skills'],
      canUseNetwork: false,
    }
    const skill = {
      id: 'skill',
      name: '定位',
      description: '取证后原操作复验',
      mode: 'features',
      version: 2,
      steps: ['检查入口'],
      capabilities: ['source'],
    }
    const completeWithUsage = vi
      .fn()
      .mockResolvedValueOnce(
        reply([call('skill', 'read_task_skill', { id: 'skill', version: '2' })]),
      )
      .mockResolvedValueOnce(reply())
    const execute = vi.fn().mockResolvedValue({ ok: true, data: { skill } })
    await new ProductAssistantService({ completeWithUsage }).reply(
      current,
      DEFAULT_MAIN_API_CONFIG,
      signal(),
      { getContext: () => current, execute },
    )
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task-skills' }),
      expect.anything(),
      expect.anything(),
    )
    expect(names(completeWithUsage.mock.lastCall![2].tools)).not.toContain('read_webpage')
    expect(String(completeWithUsage.mock.lastCall![0][0].content)).toContain(skill.description)
  })
  it('keeps a selected skill after a successful APP write', async () => {
    const current: AssistantRequest = {
      ...context(),
      mode: 'creation',
      taskSkill: {
        id: 'skill',
        name: '制作',
        description: '写入后检查',
        mode: 'creation',
        steps: ['写入'],
      },
    }
    const completeWithUsage = vi
      .fn()
      .mockResolvedValueOnce(
        reply([
          call('write', 'create_app', {
            name: 'APP',
            description: '测试',
            permissions: '[]',
            files: '{"index.html":"hello"}',
          }),
        ]),
      )
      .mockResolvedValueOnce(reply())
    await new ProductAssistantService({ completeWithUsage }).reply(
      current,
      DEFAULT_MAIN_API_CONFIG,
      signal(),
      {
        getContext: () => current,
        execute: vi.fn().mockResolvedValue({ text: '已写入', ok: true }),
      },
    )
    expect(String(completeWithUsage.mock.lastCall![0][0].content)).toContain('写入后检查')
  })
  it('refuses a resource read after the user selection has been revoked', async () => {
    const current: AssistantRequest = {
      ...context(),
      mode: 'features',
      referenceResources: [{ id: 'book', name: '书', contentHash: 'h' }],
    }
    const completeWithUsage = vi
      .fn()
      .mockImplementationOnce(async () => {
        current.referenceResources = []
        return reply([
          call('read', 'read_resource_excerpt', { id: 'book', hash: 'h', locator: '#/content' }),
        ])
      })
      .mockResolvedValueOnce(reply())
    const execute = vi.fn()
    await new ProductAssistantService({ completeWithUsage }).reply(
      current,
      DEFAULT_MAIN_API_CONFIG,
      signal(),
      { getContext: () => current, execute },
    )
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['general', 'discord-setup'] as const)(
    'unloads the completed %s task before another stale action can run',
    async (purpose) => {
      const capability = purpose === 'general' ? 'browser' : 'discord'
      const tool = purpose === 'general' ? 'browser' : 'configure_discord_browser'
      const current: AssistantRequest = {
        ...context(),
        mode: 'features',
        activeBrowserPurpose: purpose,
        capabilities: [capability],
      }
      const args =
        purpose === 'general'
          ? { operation: 'finish', query: '任务实际完成结果' }
          : { operation: 'verify-local' }
      const completeWithUsage = vi
        .fn()
        .mockResolvedValueOnce(
          reply([call('finish', tool, args), call('stale', tool, { operation: 'inspect' })]),
        )
        .mockResolvedValueOnce(reply())
      const execute = vi.fn().mockResolvedValue({
        ok: true,
        data: purpose === 'general' ? { verified: true } : { step: 'done', task: 'configure' },
      })
      await new ProductAssistantService({ completeWithUsage }).reply(
        current,
        DEFAULT_MAIN_API_CONFIG,
        signal(),
        { getContext: () => current, execute },
      )
      expect(execute).toHaveBeenCalledOnce()
      expect(names(completeWithUsage.mock.lastCall![2].tools)).not.toContain(tool)
      const messages = completeWithUsage.mock.lastCall![0]
      expect(String(messages[0].content)).not.toContain('网页代理任务：')
      expect(
        JSON.parse(
          messages.find((item: { toolCallId?: string }) => item.toolCallId === 'stale').content,
        ).ok,
      ).toBe(false)
    },
  )
  it('answers a location question without executing an unsolicited navigation', async () => {
    const current = { ...context(), history: [{ role: 'user' as const, text: '云备份在哪里？' }] }
    const completeWithUsage = vi
      .fn()
      .mockResolvedValueOnce(reply([call('navigate', 'open_feature', { target: 'cloud' })]))
      .mockResolvedValueOnce(reply())
    const execute = vi.fn()
    await new ProductAssistantService({ completeWithUsage }).reply(
      current,
      DEFAULT_MAIN_API_CONFIG,
      signal(),
      { getContext: () => current, execute },
    )
    expect(names(completeWithUsage.mock.calls[0]![2].tools)).not.toContain('open_feature')
    expect(execute).not.toHaveBeenCalled()
    expect(
      JSON.parse(
        completeWithUsage.mock.lastCall![0].find((item: { role: string }) => item.role === 'tool')
          .content,
      ).ok,
    ).toBe(false)
  })
  it('keeps unrelated workflows out of a question even when every device capability is available', () => {
    const current = context()
    const tools = getAssistantRequestTools(current)
    expect(names(tools).sort()).toEqual(
      [
        'select_mode',
        'get_feature_help',
        'get_navigation_targets',
        'open_feature',
        'capture_current_ui',
      ].sort(),
    )
    expect(JSON.stringify(tools)).not.toMatch(
      /prepare-secret|run_custom_tool|search_conversation|indexedDB|wait-status/u,
    )
    const creation = getAssistantRequestTools({ ...current, mode: 'creation' })
    expect(names(creation)).toContain('write_app_file')
    expect(names(creation)).not.toContain('get_custom_tool_help')
    expect(names(creation)).not.toContain('configure_discord_browser')
    const parts = describeAssistantInput(current)
    expect(JSON.parse(parts.find(({ id }) => id === 'tools')!.content!)).toEqual(tools)
  })

  it('rejects undiscovered calls, then loads source tools and executes through the original owner', async () => {
    const current = context()
    const read = { url: 'https://github.com/example/project', path: 'src/entry.ts' }
    const snapshots: string[][] = []
    const responses = [
      reply([call('premature', 'read_webpage', read)]),
      reply([call('load', 'select_mode', { mode: 'features', capability: 'source' })]),
      reply([call('read', 'read_webpage', read)]),
      reply(),
      reply(),
    ]
    const completeWithUsage = vi.fn(async (_messages, _config, options) => {
      snapshots.push(names(options.tools))
      return responses.shift()!
    })
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      data: { kind: 'file', path: read.path, ref: 'main', text: 'FAILURE_ENTRY_EVIDENCE' },
    })
    const service = new ProductAssistantService({ completeWithUsage })
    await service.reply(current, DEFAULT_MAIN_API_CONFIG, signal(), {
      getContext: () => current,
      execute,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![0]).toMatchObject({ action: 'online', operation: 'read-webpage' })
    expect(snapshots[0]).not.toContain('read_webpage')
    expect(snapshots[2]).toContain('read_webpage')
    const messages = completeWithUsage.mock.lastCall![0]
    expect(JSON.stringify(messages)).toContain('FAILURE_ENTRY_EVIDENCE')
    expect(
      JSON.parse(
        messages.find((item: { toolCallId?: string }) => item.toolCallId === 'premature').content,
      ).ok,
    ).toBe(false)
    await service.reply(current, DEFAULT_MAIN_API_CONFIG, signal(), {
      getContext: () => current,
      execute,
    })
    expect(snapshots.at(-1)).not.toContain('read_webpage')
    expect(current.capabilities).toBeUndefined()
  })

  it('composes necessary capabilities within a task and clears them on a mode change', async () => {
    const current = { ...context(), mode: 'features' as const }
    const snapshots: string[][] = []
    const responses = [
      reply([call('source', 'select_mode', { mode: 'features', capability: 'source' })]),
      reply([call('history', 'select_mode', { mode: 'features', capability: 'history' })]),
      reply([call('app', 'select_mode', { mode: 'creation' })]),
      reply(),
    ]
    const completeWithUsage = vi.fn(async (_messages, _config, options) => {
      snapshots.push(names(options.tools))
      return responses.shift()!
    })
    const execute = vi.fn()
    await new ProductAssistantService({ completeWithUsage }).reply(
      current,
      DEFAULT_MAIN_API_CONFIG,
      signal(),
      { getContext: () => current, execute },
    )
    expect(snapshots[2]).toEqual(expect.arrayContaining(['read_webpage', 'read_conversation']))
    expect(snapshots[3]).toContain('write_app_file')
    expect(snapshots[3]).not.toContain('read_webpage')
    expect(snapshots[3]).not.toContain('read_conversation')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'revoked', 'unknown'] as const)(
    'does not turn %s capability discovery into permission',
    async (reason) => {
      const current = { ...context(), canUseNetwork: reason !== 'disabled' }
      const actual = { ...current, canUseNetwork: reason === 'unknown' }
      const completeWithUsage = vi
        .fn()
        .mockResolvedValueOnce(
          reply([
            call('load', 'select_mode', {
              mode: 'features',
              capability: reason === 'unknown' ? 'arbitrary' : 'source',
            }),
          ]),
        )
        .mockResolvedValueOnce(reply())
      const execute = vi.fn()
      await new ProductAssistantService({ completeWithUsage }).reply(
        current,
        DEFAULT_MAIN_API_CONFIG,
        signal(),
        { getContext: () => actual, execute },
      )
      const messages = completeWithUsage.mock.lastCall![0]
      expect(
        JSON.parse(messages.find((item: { role: string }) => item.role === 'tool').content).ok,
      ).toBe(false)
      expect(names(completeWithUsage.mock.lastCall![2].tools)).not.toContain('read_webpage')
      expect(String(messages[0].content)).toContain('当前模式：自动')
      expect(execute).not.toHaveBeenCalled()
    },
  )

  it('resumes only the live browser purpose and discards retired scheduling instructions', () => {
    const current = {
      ...context(),
      mode: 'features' as const,
      history: [
        { role: 'user' as const, text: 'OLD_SCHEDULE', status: 'discord-setup-internal' },
        { role: 'user' as const, text: '普通问题' },
      ],
    }
    expect(names(getAssistantRequestTools(current))).not.toContain('configure_discord_browser')
    expect(JSON.stringify(buildAssistantMessages(current))).not.toContain('OLD_SCHEDULE')
    const active = { ...current, activeBrowserPurpose: 'discord-setup' as const }
    expect(names(getAssistantRequestTools(active))).toContain('configure_discord_browser')
    expect(names(getAssistantRequestTools(active))).not.toContain('browser')
    const general = { ...current, activeBrowserPurpose: 'general' as const }
    expect(names(getAssistantRequestTools(general))).toContain('browser')
    expect(names(getAssistantRequestTools(general))).not.toContain('configure_discord_browser')
    expect(JSON.stringify(buildAssistantMessages(general))).not.toContain('OLD_SCHEDULE')
    expect(getAssistantRequestTools({ ...active, toolCallingEnabled: false })).toEqual([])
  })

  it('separates existing-tool execution from APP tool authoring without losing the authoring path', () => {
    const current = {
      ...context(),
      mode: 'creation' as const,
      appDraft: { id: 'example', name: '原项目', revision: 1, files: ['index.html'] },
    }
    const run = { ...current, capabilities: ['custom-tools'] as const }
    expect(names(getAssistantRequestTools(run))).toContain('run_custom_tool')
    expect(names(getAssistantRequestTools(run))).not.toContain('write_app_file')
    expect(String(buildAssistantMessages(run)[0]!.content)).not.toContain('原项目')
    const author = { ...current, capabilities: ['tool-authoring'] as const }
    expect(names(getAssistantRequestTools(author))).toEqual(
      expect.arrayContaining([
        'get_custom_tool_help',
        'write_app_file',
        'set_app_tools',
        'test_app',
      ]),
    )
    expect(String(buildAssistantMessages(author)[0]!.content)).toContain('原项目')
    const customized = { ...run, promptOverrides: { common: '用户通用', creation: '用户制作' } }
    expect(String(buildAssistantMessages(customized)[0]!.content)).toContain('用户通用\n用户制作')
  })

  it('injects only global preferences until a concrete mode is chosen', () => {
    const current = {
      ...context(),
      preferenceMemories: [
        { scope: 'all', text: 'GLOBAL_STYLE' },
        { scope: 'appearance', text: 'APPEARANCE_ONLY' },
        { scope: 'creation', text: 'CREATION_ONLY' },
      ],
    }
    expect(String(buildAssistantMessages(current)[0]!.content)).not.toMatch(
      /APPEARANCE_ONLY|CREATION_ONLY/u,
    )
    const selected = String(buildAssistantMessages({ ...current, mode: 'creation' })[0]!.content)
    expect(selected).toContain('GLOBAL_STYLE')
    expect(selected).toContain('CREATION_ONLY')
    expect(selected).not.toContain('APPEARANCE_ONLY')
  })

  it.each(['usage', 'diagnosis', 'source'] as const)(
    'returns only %s knowledge instead of the entire feature bundle',
    async (detail) => {
      const current = context()
      const completeWithUsage = vi
        .fn()
        .mockResolvedValueOnce(
          reply([call('help', 'get_feature_help', { query: '酒馆互传', detail })]),
        )
        .mockResolvedValueOnce(reply())
      await new ProductAssistantService({ completeWithUsage }).reply(
        current,
        DEFAULT_MAIN_API_CONFIG,
        signal(),
        { getContext: () => current, execute: vi.fn() },
      )
      const value = JSON.parse(
        completeWithUsage.mock.lastCall![0].find((item: { role: string }) => item.role === 'tool')
          .content,
      )
      const guide = value.guides[0]
      expect(guide.id).toBe('bridge')
      expect(Boolean(guide.steps)).toBe(detail === 'usage')
      expect(Boolean(guide.troubleshooting)).toBe(detail === 'diagnosis')
      expect(Boolean(guide.owners)).toBe(detail === 'source')
      expect(Boolean(value.sourceRepositories)).toBe(detail === 'source')
    },
  )
})

describe('Discord instructions follow actual owner phase', () => {
  it('keeps economy guidance separate from autonomous browser operations', () => {
    const guidance = assistantDiscordGuidance('cf-secret', 'configure', 'economy')
    expect(guidance).toContain('网页由用户操作')
    expect(guidance).not.toMatch(/transfer-secret|prepare-secret|github-connect/)
  })
  it('does not inject first-time setup actions into an update or diagnosis milestone', () => {
    for (const task of ['update-worker', 'update-commands', 'update-commands-only', 'diagnose']) {
      const guidance = assistantDiscordGuidance('verify', task)
      expect(guidance).toContain('verify-local')
      expect(guidance).not.toMatch(
        /collect-config新建|当前目标：同一App的Bot Token|advance-step到discord-token/,
      )
    }
    expect(assistantDiscordGuidance('d1-uuid', 'configure')).toContain('不强求Settings有UUID')
    expect(assistantDiscordGuidance('local-settings', 'configure')).not.toContain(
      'open-install打开',
    )
  })
  it('reuses phase instructions within a turn but sends fresh guidance on transitions and new turns', async () => {
    const current = {
      ...context(),
      mode: 'features' as const,
      activeBrowserPurpose: 'discord-setup' as const,
    }
    const completeWithUsage = vi
      .fn()
      .mockResolvedValueOnce(
        reply([call('first', 'configure_discord_browser', { operation: 'inspect' })]),
      )
      .mockResolvedValueOnce(
        reply([call('same-phase', 'configure_discord_browser', { operation: 'inspect' })]),
      )
      .mockResolvedValueOnce(
        reply([
          call('transition', 'configure_discord_browser', {
            operation: 'advance-step',
            from: 'd1-uuid',
            document_id: '2',
          }),
        ]),
      )
      .mockResolvedValueOnce(reply())
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        data: { task: 'configure', step: 'd1-uuid', hint: '请重新观察当前页' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { task: 'configure', step: 'd1-uuid', documentId: 2 },
      })
      .mockResolvedValueOnce({ ok: true, data: { task: 'configure', step: 'github-fork' } })
    const service = new ProductAssistantService({ completeWithUsage })
    await service.reply(current, DEFAULT_MAIN_API_CONFIG, signal(), {
      getContext: () => current,
      execute,
    })
    const messages = completeWithUsage.mock.lastCall![0]
    const value = (id: string) =>
      JSON.parse(
        messages.find((message: { toolCallId?: string }) => message.toolCallId === id).content,
      )
    expect(value('first').guidance).toContain('database_id_target')
    expect(value('same-phase')).toMatchObject({ documentId: 2, guidanceFromToolCallId: 'first' })
    expect(value('same-phase').guidance).toBeUndefined()
    expect(value('transition').guidance).toContain('owned-source')
    completeWithUsage
      .mockResolvedValueOnce(
        reply([call('new-turn', 'configure_discord_browser', { operation: 'status' })]),
      )
      .mockResolvedValueOnce(reply())
    execute.mockResolvedValueOnce({ ok: true, data: { task: 'configure', step: 'github-fork' } })
    await service.reply(current, DEFAULT_MAIN_API_CONFIG, signal(), {
      getContext: () => current,
      execute,
    })
    const newMessages = completeWithUsage.mock.lastCall![0]
    expect(
      JSON.parse(
        newMessages.find((message: { toolCallId?: string }) => message.toolCallId === 'new-turn')
          .content,
      ).guidance,
    ).toContain('owned-source')
  })
  it('keeps unrelated deployment/Secret workflows out of current observation and completion', () => {
    expect(assistantDiscordGuidance('cf-secret', 'configure')).toContain('transfer-secret')
    expect(assistantDiscordGuidance('cf-secret', 'configure')).not.toContain(
      'deployment_assessment',
    )
    expect(assistantDiscordGuidance('github-save', 'configure')).toContain('deployment_assessment')
    expect(assistantDiscordGuidance('github-save', 'configure')).not.toContain('transfer-secret')
    expect(assistantDiscordGuidance(undefined, undefined)).toContain('先status')
    expect(assistantDiscordGuidance('diagnose', 'diagnose')).toContain('repair')
    expect(assistantDiscordGuidance('done', 'configure')).not.toMatch(
      /prepare-secret|github-connect|fill-config/u,
    )
  })
})
