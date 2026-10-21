/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbProductAssistantStorage } from '../storage/IndexedDbProductAssistantStorage'
import {
  ProductAssistantWorkspaceService,
  newAssistantConversation,
} from './ProductAssistantWorkspaceService'
import { DEFAULT_MAIN_API_CONFIG, MainApiService } from './MainApiService'
import { ProductAssistantAppSession } from './ProductAssistantAppSession'
import { ExternalAppService } from './ExternalAppService'
import { IndexedDbExternalAppStorage } from '../storage/IndexedDbExternalAppStorage'
import { DEFAULT_ASSISTANT_PROMPTS } from '../core/ProductAssistantKnowledge'
const databases: AppDatabase[] = []
function setup() {
  localStorage.clear()
  const db = new AppDatabase(`assistant-workspace-${crypto.randomUUID()}`)
  databases.push(db)
  const storage = new IndexedDbProductAssistantStorage(db)
  const secrets = new Map<string, string>()
  const credentials = {
    read: vi.fn(async (id: string) => secrets.get(id) || ''),
    save: vi.fn(async (id: string, value: string) => {
      secrets.set(id, value)
    }),
    clear: vi.fn(async (id: string) => {
      secrets.delete(id)
    }),
  }
  const api = new MainApiService(credentials)
  return {
    api,
    secrets,
    db,
    storage,
    credentials,
    workspace: new ProductAssistantWorkspaceService(storage, api, credentials),
  }
}
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close()
    await AppDatabase.delete(db.name)
  }
})
describe('assistant workspace with actual indexed settings', () => {
  it('keeps each restarted web task separate and resumes only its own conversation', async () => {
    const { workspace } = setup()
    const ordinary = await workspace.initialize()
    ordinary.input = '普通聊天未发送草稿'
    ordinary.history = [{ role: 'user', text: '普通聊天内容' }]
    await workspace.save(ordinary, true)
    const first = await workspace.continueDiscordSetupConversation('agent-task-one')
    expect(first.history).toEqual([])
    expect(first.input).toBe('')
    first.history = [{ role: 'assistant', text: '第一项任务进展' }]
    await workspace.save(first)
    const second = await workspace.continueDiscordSetupConversation('agent-task-two')
    expect(second.history).toEqual([])
    expect((await workspace.continueDiscordSetupConversation(first.id)).history).toEqual(
      first.history,
    )
    expect((await workspace.switch(ordinary.id)).input).toBe('普通聊天未发送草稿')
    expect((await workspace.switch(ordinary.id)).history).toEqual(ordinary.history)
  })
  it('coalesces manual recoveries and queues autosaves until recovery has settled', async () => {
    const { workspace, storage } = setup()
    const chat = await workspace.initialize()
    const result = {
      scanned: 0,
      total: 0,
      recovered: 0,
      repaired: 0,
      conflicts: 0,
      invalid: 0,
      missingProjects: 0,
      cancelled: false,
    }
    let finish!: (value: typeof result) => void
    const recover = vi.spyOn(storage, 'recoverHistory').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = workspace.recoverHistory()
    expect(workspace.recoverHistory()).toBe(first)
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    const save = workspace.save({ ...chat, input: '等待恢复后的输入' })
    expect((await storage.read(chat.id))?.input).toBe('')
    finish(result)
    await first
    await save
    expect((await storage.read(chat.id))?.input).toBe('等待恢复后的输入')
    expect(await storage.active()).toBe(chat.id)
  })
  it('broadcasts the live conversation snapshot while persisting unfinished tool calls as cancelled', async () => {
    const { workspace, storage } = setup()
    const chat = await workspace.initialize()
    const received: Array<{ id: string; toolState?: string }> = []
    workspace.onConversationChange((value, sourceId) => {
      if (sourceId !== 'full-chat') return
      received.push({ id: value.id, toolState: value.history[0]?.toolCalls?.[0]?.state })
    })
    const stringify = vi.spyOn(JSON, 'stringify')
    await workspace.save(
      {
        ...chat,
        history: [
          {
            id: 'user-turn',
            role: 'user',
            text: '请帮我处理',
            toolCalls: [{ id: 'running-tool', label: '处理', state: 'running' }],
          },
        ],
      },
      false,
      'full-chat',
    )
    const completeSnapshots = stringify.mock.calls.filter(
      ([value]) => value && typeof value === 'object' && value.id === chat.id && value.history,
    )
    stringify.mockRestore()
    expect(completeSnapshots).toHaveLength(1)
    await workspace.flush()
    expect(received).toEqual([{ id: chat.id, toolState: 'running' }])
    expect((await storage.read(chat.id))?.history[0]?.toolCalls?.[0]?.state).toBe('cancelled')
  })
  it('allows only one chat surface to own a conversation generation at a time', async () => {
    const { workspace } = setup()
    const chat = await workspace.initialize()
    const changes: Array<[string, string, boolean]> = []
    workspace.onConversationActivityChange((id, sourceId, active) => {
      changes.push([id, sourceId, active])
    })
    expect(workspace.setConversationActivity(chat.id, 'full-chat', true)).toBe(true)
    expect(workspace.setConversationActivity(chat.id, 'quick-chat', true)).toBe(false)
    expect(workspace.conversationActivityOwner(chat.id)).toBe('full-chat')
    expect(workspace.setConversationActivity(chat.id, 'quick-chat', false)).toBe(true)
    expect(workspace.conversationActivityOwner(chat.id)).toBe('full-chat')
    expect(workspace.setConversationActivity(chat.id, 'full-chat', false)).toBe(true)
    expect(workspace.conversationActivityOwner(chat.id)).toBeUndefined()
    expect(changes).toEqual([
      [chat.id, 'full-chat', true],
      [chat.id, 'full-chat', false],
    ])
  })
  it('persists prompt replacements through the existing settings owner, isolates drafts and restores defaults', async () => {
    const { workspace, storage, api, credentials } = setup()
    await workspace.initialize()
    const edits = {
      common: '  简洁中文\n保留原文  ',
      features: '',
      creation: DEFAULT_ASSISTANT_PROMPTS.creation,
    }
    await workspace.savePreferences({ ...workspace.preferences(), promptOverrides: edits })
    edits.common = '外部未保存变更'
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.loadPreferences()
    expect(reopened.preferences().promptOverrides).toEqual({
      common: '  简洁中文\n保留原文  ',
      features: '',
    })
    const draft = reopened.preferences()
    draft.promptOverrides!.common = '草稿修改'
    expect(reopened.preferences().promptOverrides!.common).toBe('  简洁中文\n保留原文  ')
    vi.spyOn(storage, 'savePreferences').mockRejectedValueOnce(new Error('保存失败'))
    await expect(reopened.savePreferences(draft)).rejects.toThrow('保存失败')
    expect(reopened.preferences().promptOverrides!.common).toBe('  简洁中文\n保留原文  ')
    await reopened.savePreferences({
      ...draft,
      promptOverrides: {
        common: DEFAULT_ASSISTANT_PROMPTS.common,
        features: DEFAULT_ASSISTANT_PROMPTS.features,
      },
    })
    expect((await storage.preferences())?.promptOverrides).toBeUndefined()
    const restored = new ProductAssistantWorkspaceService(storage, api, credentials)
    await restored.loadPreferences()
    expect(restored.preferences().promptOverrides).toBeUndefined()
  })
  it('does not interpret or send a legacy Jina credential as a GitHub token', async () => {
    const { workspace, secrets, credentials } = setup()
    secrets.set('product-assistant:jina-reader', 'old-jina-private-fixture')
    await workspace.initialize()
    expect(await workspace.readGitHubCredential()).toBe('')
    expect(credentials.read).not.toHaveBeenCalledWith('product-assistant:jina-reader')
    await workspace.savePreferences(workspace.preferences(), 'github_pat_new_fixture')
    expect(secrets.get('product-assistant:jina-reader')).toBe('old-jina-private-fixture')
    expect(await workspace.readGitHubCredential()).toBe('github_pat_new_fixture')
  })

  it('keeps Reader secrets in the existing credential owner, outside preferences and chat exports', async () => {
    const { workspace, storage, api, credentials } = setup()
    const chat = await workspace.initialize()
    await workspace.savePreferences(workspace.preferences(), 'github_pat_local_fixture')
    expect(await workspace.readGitHubCredential()).toBe('github_pat_local_fixture')
    expect(credentials.save).toHaveBeenCalledWith(
      'product-assistant:github-read',
      'github_pat_local_fixture',
    )
    expect(JSON.stringify(await storage.preferences())).not.toContain('github_pat_local_fixture')
    expect(JSON.stringify(await storage.read(chat.id))).not.toContain('github_pat_local_fixture')
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(await reopened.readGitHubCredential()).toBe('github_pat_local_fixture')
    await reopened.savePreferences({ ...reopened.preferences(), networkEnabled: false })
    expect(await reopened.readGitHubCredential()).toBe('github_pat_local_fixture')
    await reopened.savePreferences(reopened.preferences(), '')
    expect(await reopened.readGitHubCredential()).toBe('')
  })
  it('clears a saved Reader key when switching to session and loses only session secrets on reopen', async () => {
    const { workspace, storage, api, credentials, secrets } = setup()
    await workspace.initialize()
    await workspace.savePreferences(workspace.preferences(), 'github_pat_old_fixture')
    await workspace.savePreferences(
      { ...workspace.preferences(), githubReadPersistence: 'session' },
      'github_pat_session_fixture',
    )
    expect(secrets.has('product-assistant:github-read')).toBe(false)
    expect(await workspace.readGitHubCredential()).toBe('github_pat_session_fixture')
    expect(JSON.stringify(await storage.preferences())).not.toContain('github_pat_session_fixture')
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences().githubReadPersistence).toBe('session')
    expect(await reopened.readGitHubCredential()).toBe('')
  })
  it('retains the previous credential and preferences after a settings write failure', async () => {
    const { workspace, storage } = setup()
    await workspace.initialize()
    await workspace.savePreferences(workspace.preferences(), 'github_pat_old_reader_fixture')
    vi.spyOn(storage, 'savePreferences').mockRejectedValueOnce(new Error('写入失败'))
    await expect(
      workspace.savePreferences(
        { ...workspace.preferences(), githubReadPersistence: 'session' },
        'github_pat_new_reader_fixture',
      ),
    ).rejects.toThrow('写入失败')
    expect(await workspace.readGitHubCredential()).toBe('github_pat_old_reader_fixture')
    expect((await storage.preferences())?.githubReadPersistence).toBe('local')
  })

  it('keeps screenshot permission compatible with older settings and persists turning it off', async () => {
    const { workspace, storage, api, credentials } = setup()
    await storage.savePreferences({ name: '蒜惹菈', avatar: '', apiProfileId: '' })
    await workspace.initialize()
    expect(workspace.preferences().allowScreenshots).toBe(true)
    await workspace.savePreferences({ ...workspace.preferences(), allowScreenshots: false })
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences().allowScreenshots).toBe(false)
  })
  it('defaults public reads to confirmation and round-trips opt-in independently of networking', async () => {
    const { workspace, storage, api, credentials } = setup()
    await storage.savePreferences({ name: '蒜惹菈', avatar: '', apiProfileId: '' })
    await workspace.initialize()
    expect(workspace.preferences().githubReadWithoutConfirmation).toBe(false)
    await workspace.savePreferences({
      ...workspace.preferences(),
      networkEnabled: true,
      githubReadWithoutConfirmation: true,
    })
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences().githubReadWithoutConfirmation).toBe(true)
    await reopened.savePreferences({ ...reopened.preferences(), networkEnabled: false })
    expect((await storage.preferences())?.githubReadWithoutConfirmation).toBe(true)
    vi.spyOn(storage, 'savePreferences').mockRejectedValueOnce(new Error('写入失败'))
    await expect(
      reopened.savePreferences({ ...reopened.preferences(), githubReadWithoutConfirmation: false }),
    ).rejects.toThrow('写入失败')
    expect(reopened.preferences().githubReadWithoutConfirmation).toBe(true)
    expect(reopened.preferences().networkEnabled).toBe(false)
  })
  it('defaults tools on for older preferences and persists disabling through the original settings owner', async () => {
    const { workspace, storage, api, credentials } = setup()
    await storage.savePreferences({ name: '蒜惹菈', avatar: '', apiProfileId: '' })
    await workspace.initialize()
    expect(workspace.preferences().toolCallingEnabled).toBe(true)
    expect(workspace.preferences().toolCallLimit).toBeUndefined()
    await workspace.savePreferences({
      ...workspace.preferences(),
      toolCallingEnabled: false,
      networkEnabled: true,
      providerSearch: true,
      toolCallLimit: 32,
    })
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences()).toMatchObject({
      toolCallingEnabled: false,
      networkEnabled: true,
      providerSearch: true,
      toolCallLimit: 32,
    })
  })
  it('keeps page-script execution disabled by default and persists explicit opt-in', async () => {
    const { workspace, storage, api, credentials } = setup()
    await storage.savePreferences({ name: '蒜惹菈', avatar: '', apiProfileId: '' })
    await workspace.initialize()
    expect(workspace.preferences().allowPageScripts).toBe(false)
    await workspace.savePreferences({ ...workspace.preferences(), allowPageScripts: true })
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences().allowPageScripts).toBe(true)
    await reopened.savePreferences({ ...reopened.preferences(), allowPageScripts: false })
    expect((await storage.preferences())?.allowPageScripts).toBe(false)
  })
  it.each([0, -1, 101, 1.5, Number.NaN])(
    'refuses invalid tool budgets %s without changing saved preferences',
    async (toolCallLimit) => {
      const { workspace } = setup()
      await workspace.initialize()
      await expect(
        workspace.savePreferences({ ...workspace.preferences(), toolCallLimit }),
      ).rejects.toThrow('工具调用上限')
      expect(workspace.preferences().toolCallLimit).toBeUndefined()
    },
  )
  it('persists clearing a configured tool limit as unlimited through the original owner', async () => {
    const { workspace, storage, api, credentials } = setup()
    await workspace.initialize()
    expect(workspace.preferences().toolCallLimit).toBeUndefined()
    await workspace.savePreferences({ ...workspace.preferences(), toolCallLimit: 16 })
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    await reopened.initialize()
    expect(reopened.preferences().toolCallLimit).toBe(16)
    await reopened.savePreferences({
      ...reopened.preferences(),
      toolCallLimit: '' as unknown as number,
    })
    const cleared = new ProductAssistantWorkspaceService(storage, api, credentials)
    await cleared.initialize()
    expect(cleared.preferences().toolCallLimit).toBeUndefined()
    expect((await storage.preferences())?.toolCallLimit).toBeUndefined()
  })
  it('defaults missing compression thresholds to blank and round-trips a million tokens or a blank', async () => {
    const { workspace, storage, api } = setup()
    await workspace.initialize()
    expect(workspace.preferences().compressionTokenThreshold).toBeUndefined()
    await workspace.savePreferences({
      ...workspace.preferences(),
      compressionTokenThreshold: 1_000_000,
    })
    let reopened = new ProductAssistantWorkspaceService(storage, api)
    await reopened.initialize()
    expect(reopened.preferences().compressionTokenThreshold).toBe(1_000_000)
    await reopened.savePreferences({
      ...reopened.preferences(),
      compressionTokenThreshold: '' as unknown as number,
    })
    reopened = new ProductAssistantWorkspaceService(storage, api)
    await reopened.initialize()
    expect(reopened.preferences().compressionTokenThreshold).toBeUndefined()
    await reopened.savePreferences({ ...reopened.preferences(), compressionTokenThreshold: 12000 })
    const old = new ProductAssistantWorkspaceService(storage, api)
    await old.initialize()
    expect(old.preferences().compressionTokenThreshold).toBe(12000)
  })
  it.each([0, -1, 1.5, Infinity, Number.NaN])(
    'rejects invalid compression thresholds %s without changing preferences',
    async (compressionTokenThreshold) => {
      const { workspace } = setup()
      await workspace.initialize()
      await expect(
        workspace.savePreferences({ ...workspace.preferences(), compressionTokenThreshold }),
      ).rejects.toThrow('压缩阈值')
      expect(workspace.preferences().compressionTokenThreshold).toBeUndefined()
    },
  )
  it('migrates an old input budget into a compression threshold without reintroducing it after clearing', async () => {
    const { workspace, storage, api } = setup()
    await storage.savePreferences({
      name: '蒜惹菈',
      avatar: '',
      apiProfileId: '',
      contextTokenLimit: 16000,
    } as ReturnType<typeof workspace.preferences>)
    await workspace.initialize()
    expect(workspace.preferences().compressionTokenThreshold).toBe(16000)
    expect(workspace.preferences()).not.toHaveProperty('contextTokenLimit')
    await workspace.savePreferences({
      ...workspace.preferences(),
      compressionTokenThreshold: undefined,
    })
    expect(await storage.preferences()).not.toHaveProperty('contextTokenLimit')
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    await reopened.initialize()
    expect(reopened.preferences().compressionTokenThreshold).toBeUndefined()
  })
  async function draft(db: AppDatabase) {
    const session = new ProductAssistantAppSession(
      new ExternalAppService(new IndexedDbExternalAppStorage(db)),
    )
    await session.execute(
      {
        action: 'app',
        operation: 'create',
        args: {
          name: '接续日记',
          description: '跨聊天制作',
          permissions: '[]',
          files: JSON.stringify({
            'index.html': '<!doctype html><html><body>第一版</body></html>',
          }),
        },
      },
      undefined,
      new AbortController().signal,
      {
        showPreview: async () => {},
        diagnostics: () => ({ state: 'running', messages: [] }),
        confirmInstall: async () => false,
        exportFile: async () => {},
      },
    )
    return session.snapshot()!
  }
  it('shares the latest APP across chats without duplicating source, and keeps projects when deleting a chat', async () => {
    const { workspace, db, storage, api } = setup()
    const first = await workspace.initialize()
    first.draft = await draft(db)
    Object.assign(first, await workspace.save(first))
    const second = await workspace.continueProject(first.projectId!)
    expect(second.id).not.toBe(first.id)
    expect(second.history).toEqual([])
    expect(second.draft).toEqual(first.draft)
    expect((await db.settings.get('assistant.chat:' + first.id))?.value).not.toHaveProperty('draft')
    second.draft!.source['index.html'] = '<!doctype html><html><body>第二版</body></html>'
    Object.assign(second, await workspace.save(second))
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    const oldChat = await reopened.switch(first.id)
    expect(oldChat.draft!.source).toEqual(second.draft!.source)
    expect(oldChat.projectVersion).toBe(2)
    // Ephemeral session revision changes do not create a new project version.
    oldChat.draft!.revision += 10
    expect(await reopened.save(oldChat)).toMatchObject({ projectVersion: 2 })
    await reopened.remove(second.id)
    expect((await reopened.projects()).items).toEqual([
      expect.objectContaining({ id: first.projectId, version: 2 }),
    ])
    expect(await storage.project(first.projectId!)).toHaveProperty('draft')
  })
  it('rejects stale edits and rolls back chat/project changes atomically on storage failure', async () => {
    const { workspace, db, storage } = setup()
    const first = await workspace.initialize()
    first.draft = await draft(db)
    Object.assign(first, await workspace.save(first))
    const second = await workspace.continueProject(first.projectId!)
    second.draft!.source['index.html'] = '最新源码'
    await workspace.save(second)
    first.draft.source['index.html'] = '过期窗口的修改'
    await expect(workspace.save(first)).rejects.toThrow('项目已有更新')
    expect((await storage.project(first.projectId!))?.draft.source['index.html']).toBe('最新源码')
    const latest = (await storage.read(second.id))!
    latest.draft!.source['index.html'] = '写入失败的源码'
    const original = db.settings.bulkPut.bind(db.settings)
    const put = vi.spyOn(db.settings, 'bulkPut')
    put.mockImplementationOnce(original).mockRejectedValueOnce(new Error('disk full'))
    await expect(workspace.save(latest)).rejects.toThrow('disk full')
    put.mockRestore()
    expect((await storage.project(first.projectId!))?.version).toBe(2)
    expect((await storage.read(second.id))?.draft?.source['index.html']).toBe('最新源码')
    await db.settings.delete('assistant.project:' + first.projectId)
    await expect(storage.read(second.id)).rejects.toThrow('项目读取失败')
    expect(await db.settings.get('assistant.chat:' + second.id)).toBeDefined()
  })
  it('lazily promotes only an opened legacy draft and preserves the original on failure', async () => {
    const { workspace, db, storage } = setup()
    const old = { ...newAssistantConversation(), draft: await draft(db) }
    await db.settings.put({ id: 'assistant.chat:' + old.id, value: old, updatedAt: old.updatedAt })
    expect((await workspace.projects()).total).toBe(0)
    const read = (await storage.read(old.id))!
    vi.spyOn(db.settings, 'bulkPut').mockRejectedValueOnce(new Error('quota'))
    await expect(workspace.save(read)).rejects.toThrow('quota')
    expect((await db.settings.get('assistant.chat:' + old.id))?.value).toHaveProperty('draft')
    expect((await workspace.projects()).total).toBe(0)
    vi.restoreAllMocks()
    await workspace.save(read)
    expect((await workspace.projects()).total).toBe(1)
    expect((await db.settings.get('assistant.chat:' + old.id))?.value).not.toHaveProperty('draft')
  })
  it('persists template CRUD through the same settings owner and rejects invalid templates without changing stored values', async () => {
    const { workspace, storage, api } = setup()
    const one = { id: 'one', name: '检查按钮', steps: ['预览 APP', '点保存并重载检查'] }
    const two = { id: 'two', name: '修改配色', steps: ['先读取 CSS', '只修改颜色'] }
    await Promise.all([workspace.saveTemplate(one), workspace.saveTemplate(two)])
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    expect(await reopened.templates()).toEqual([one, two])
    expect(reopened.templateText(one)).toBe('检查按钮\n1. 预览 APP\n2. 点保存并重载检查')
    await expect(workspace.saveTemplate({ ...one, steps: [] })).rejects.toThrow('步骤')
    await reopened.saveTemplate({ ...one, name: '新的名称' })
    await reopened.removeTemplate(two.id)
    expect(await workspace.templates()).toEqual([{ ...one, name: '新的名称' }])
    vi.spyOn(storage, 'putTemplate').mockRejectedValueOnce(new Error('quota'))
    await expect(workspace.saveTemplate(one)).rejects.toThrow('quota')
    expect((await workspace.templates())[0]?.name).toBe('新的名称')
  })
  it('reopens a context checkpoint and its independent compression/animation preferences from the existing database', async () => {
    const { workspace, storage, api } = setup()
    const chat = await workspace.initialize()
    chat.history = [{ id: 'old', role: 'user', text: '制作日记APP' }]
    chat.contextSummary = { text: '用户在制作日记APP。', count: 1, digest: 'checkpoint-digest' }
    await workspace.save(chat)
    await workspace.savePreferences({
      ...workspace.preferences(),
      autoCompressContext: true,
      estimateInputTokens: true,
      compressionTokenThreshold: 16000,
      petWalkingAnimation: false,
    })
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    const restored = await reopened.initialize()
    expect(restored.contextSummary).toEqual(chat.contextSummary)
    expect(restored.history).toEqual(chat.history)
    expect(reopened.preferences()).toMatchObject({
      autoCompressContext: true,
      estimateInputTokens: true,
      compressionTokenThreshold: 16000,
      petWalkingAnimation: false,
    })
    await expect(
      reopened.savePreferences({ ...reopened.preferences(), compressionTokenThreshold: 0 }),
    ).rejects.toThrow()
  })
  it('persists separately managed preferences, filters manual modes and keeps committed values on failure', async () => {
    const { workspace, storage, api } = setup()
    await workspace.initialize()
    const memories = [
      { id: 'color', scope: 'appearance' as const, text: '  喜欢浅紫色  ' },
      { id: 'app', scope: 'creation' as const, text: 'APP 默认有搜索' },
      { id: 'common', scope: 'all' as const, text: '按钮放在底部' },
    ]
    await workspace.saveMemories(memories)
    expect(workspace.memories('appearance').map((item) => item.text)).toEqual([
      '喜欢浅紫色',
      '按钮放在底部',
    ])
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    await reopened.loadPreferences()
    expect(reopened.memories()).toHaveLength(3)
    vi.spyOn(storage, 'saveMemories').mockRejectedValueOnce(new Error('disk full'))
    await expect(reopened.saveMemories([])).rejects.toThrow('disk full')
    expect(reopened.memories()).toHaveLength(3)
    await reopened.saveMemories([{ ...memories[0]!, text: '喜欢绿色' }])
    expect(reopened.memories()).toEqual([{ id: 'color', scope: 'appearance', text: '喜欢绿色' }])
    await reopened.saveMemories([])
    expect(await storage.memories()).toEqual([])
    await expect(
      reopened.saveMemories([{ ...memories[0]!, text: '字'.repeat(501) }]),
    ).rejects.toThrow('500')
  })
  it('searches title and full message text without loading bodies, follows edits, favorites and deletions', async () => {
    const { workspace, storage, db } = setup()
    const chat = await workspace.initialize()
    chat.history = [
      { id: 'question', role: 'user', text: '我要做一个星星日记', favorite: true },
      { id: 'answer', role: 'assistant', text: '在扩展中继续制作星星日记', favorite: true },
    ]
    chat.images = [{ id: 'image', name: 'PRIVATE_IMAGE', dataUrl: 'PRIVATE_IMAGE_DATA' }]
    await workspace.save(chat)
    await workspace.rename(chat.id, '我的工具')
    const get = vi.spyOn(db.settings, 'get')
    const read = vi.spyOn(storage, 'read')
    const result = await workspace.search('星星')
    expect(result.items.map((item) => item.turnId)).toEqual(['answer', 'question'])
    expect(result.items.every((item) => item.title === '我的工具')).toBe(true)
    expect((await workspace.search('工具')).items[0]?.turnId).toBeUndefined()
    expect((await workspace.search('', true)).total).toBe(2)
    expect(read).not.toHaveBeenCalled()
    expect(get.mock.calls.some(([key]) => String(key).startsWith('assistant.chat:'))).toBe(false)
    const index = await db.settings.where('id').startsWith('assistant.message:').toArray()
    expect(JSON.stringify(index)).not.toContain('PRIVATE_IMAGE')
    chat.history[0]!.text = '改成月亮日记'
    chat.history[0]!.favorite = false
    chat.history.splice(1, 1)
    await workspace.save(chat)
    expect((await workspace.search('星星')).total).toBe(0)
    expect((await workspace.search('月亮')).items[0]?.turnId).toBe('question')
    expect((await workspace.search('', true)).total).toBe(0)
    await workspace.save(newAssistantConversation(), true)
    await workspace.remove(chat.id)
    expect((await workspace.search('月亮')).total).toBe(0)
  })
  it('migrates old search records only once without rewriting bodies and pages matching messages', async () => {
    const { workspace, db } = setup()
    const chat = await workspace.initialize()
    const legacy = {
      ...chat,
      history: Array.from({ length: 45 }, (_, i) => ({ role: 'user', text: `旧消息 ${i}` })),
    }
    await db.settings.put({ id: `assistant.chat:${chat.id}`, value: legacy, updatedAt: 1 })
    await db.settings.put({
      id: `assistant.summary:${chat.id}`,
      value: { id: chat.id, title: '历史', updatedAt: 1 },
      updatedAt: 1,
    })
    const before = await db.settings.get(`assistant.chat:${chat.id}`)
    expect((await workspace.search('旧消息')).items).toHaveLength(20)
    expect((await workspace.search('旧消息', false, 40)).items).toHaveLength(5)
    expect(await db.settings.get(`assistant.chat:${chat.id}`)).toEqual(before)
    const get = vi.spyOn(db.settings, 'get')
    await workspace.search('旧消息')
    expect(get.mock.calls.some(([key]) => String(key).startsWith('assistant.chat:'))).toBe(false)
  })
  it('initializes pet preferences once without reading any conversation body and persists modes/position', async () => {
    const { workspace, storage, api } = setup()
    const preferencesRead = vi.spyOn(storage, 'preferences')
    const read = vi.spyOn(storage, 'read')
    await Promise.all([workspace.loadPreferences(), workspace.loadPreferences()])
    expect(workspace.preferences().aiPetExpressions).toBe(false)
    expect(preferencesRead).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    const listener = vi.fn()
    const unsubscribe = workspace.onPreferencesChange(listener)
    await workspace.savePreferences({
      ...workspace.preferences(),
      mode: 'appearance',
      desktopPet: true,
      aiPetExpressions: true,
      petPosition: reactive({ x: 0.2, y: 0.5 }),
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'appearance', desktopPet: true, aiPetExpressions: true }),
    )
    const reopened = new ProductAssistantWorkspaceService(storage, api)
    expect(await reopened.loadPreferences()).toMatchObject({
      mode: 'appearance',
      desktopPet: true,
      petPosition: { x: 0.2, y: 0.5 },
    })
    await expect(
      workspace.savePreferences({ ...workspace.preferences(), petPosition: { x: 2, y: 0.5 } }),
    ).rejects.toThrow('位置无效')
    unsubscribe()
  })
  it('renames only lightweight metadata without reading or rewriting the chat body', async () => {
    const { workspace, storage, db } = setup()
    const chat = await workspace.initialize()
    chat.input = '保留输入'
    await workspace.save(chat)
    const body = await db.settings.get(`assistant.chat:${chat.id}`)
    const read = vi.spyOn(storage, 'read')
    const get = vi.spyOn(db.settings, 'get')
    await workspace.rename(chat.id, '轻量改名')
    expect(read).not.toHaveBeenCalled()
    expect(get.mock.calls.map(([key]) => key)).toEqual([`assistant.summary:${chat.id}`])
    get.mockRestore()
    expect(await db.settings.get(`assistant.chat:${chat.id}`)).toEqual(body)
    expect(await storage.read(chat.id)).toMatchObject({ title: '轻量改名', input: '保留输入' })
  })
  it('keeps manual titles across stale autosaves, repeated renames, archive and a fresh workspace', async () => {
    const { workspace, storage, api, credentials } = setup()
    const chat = await workspace.initialize()
    chat.history = [{ role: 'user', text: '自动标题' }]
    chat.input = '未发送内容'
    await workspace.save(chat)
    await workspace.rename(chat.id, '  我的 APP 项目  ')
    const oldSnapshot = structuredClone(chat)
    await workspace.rename(chat.id, '每日小记')
    oldSnapshot.history.push({ role: 'assistant', text: '继续制作' })
    await workspace.save(oldSnapshot)
    expect(await storage.read(chat.id)).toMatchObject({
      title: '每日小记',
      customTitle: '每日小记',
      input: '未发送内容',
    })
    expect((await workspace.list()).items[0]?.title).toBe('每日小记')
    const next = newAssistantConversation()
    await workspace.save(next, true)
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    expect((await reopened.initialize()).id).toBe(next.id)
    expect((await reopened.switch(chat.id)).title).toBe('每日小记')
    await expect(workspace.rename(chat.id, '  ')).rejects.toThrow('1–60')
    await expect(workspace.rename(chat.id, '字'.repeat(61))).rejects.toThrow('1–60')
    await expect(workspace.rename('missing', '名称')).rejects.toThrow('已不存在')
    expect((await storage.read(chat.id))?.title).toBe('每日小记')
  })
  it('archives by activating a new record, restores full history/input and deletes only the chosen historical record', async () => {
    const { db, storage, workspace, credentials, api } = setup()
    const first = await workspace.initialize()
    first.history = Array.from({ length: 85 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      text: `消息${i}`,
    }))
    first.history[0]!.toolCalls = [{ id: 'interrupted', label: '读取样式', state: 'running' }]
    first.input = '尚未发送的草稿'
    await workspace.save(first)
    const second = newAssistantConversation()
    await workspace.save(second, true)
    const reopened = new ProductAssistantWorkspaceService(storage, api, credentials)
    expect((await reopened.initialize()).id).toBe(second.id)
    expect((await reopened.switch(first.id)).history).toHaveLength(85)
    expect((await reopened.switch(first.id)).history[0]?.toolCalls?.[0]?.state).toBe('cancelled')
    expect((await reopened.switch(first.id)).input).toBe('尚未发送的草稿')
    await db.settings.put({ id: 'unrelated', value: 'KEEP', updatedAt: 1 })
    await expect(reopened.remove(first.id)).rejects.toThrow('先切换')
    await reopened.remove(second.id)
    expect(await storage.read(second.id)).toBeUndefined()
    expect((await reopened.list()).items.map((row) => row.id)).toEqual([first.id])
    expect((await db.settings.get('unrelated'))?.value).toBe('KEEP')
  })
  it('pages lightweight summaries without reading chat bodies and captures queued writes before edits', async () => {
    const { workspace, storage } = setup()
    await workspace.initialize()
    const read = vi.spyOn(storage, 'read')
    for (let i = 0; i < 23; i++) {
      const chat = newAssistantConversation()
      chat.history = [{ role: 'user', text: `聊天${i}` }]
      const saving = workspace.save(chat)
      chat.history[0]!.text = 'LATE'
      await saving
    }
    read.mockClear()
    const first = await workspace.list()
    expect(first.items).toHaveLength(20)
    expect((await workspace.list(20)).items).toHaveLength(4)
    expect(read).not.toHaveBeenCalled()
    expect(first.items.some((row) => row.title === 'LATE')).toBe(false)
  })
  it('uses the existing profile owner for independent configuration, protected credentials and fallback', async () => {
    const { workspace, api, storage, credentials, db } = setup()
    await workspace.initialize()
    const main = api.saveProfile({
      ...api.getActiveProfile(),
      url: 'https://main.example/v1',
      model: 'main',
      apiKey: 'MAIN',
    })
    await api.awaitCredentialWrites()
    const profile = api.saveProfile({
      ...DEFAULT_MAIN_API_CONFIG,
      id: 'assistant-test',
      name: '助手独立',
      url: 'https://assistant.example/v1',
      model: 'assistant',
      apiKey: 'PRIVATE_SECRET',
    })
    await api.awaitCredentialWrites()
    await workspace.savePreferences({
      ...workspace.preferences(),
      name: '小蒜',
      apiProfileId: profile.id,
    })
    expect(workspace.config(api.getConfig()).apiKey).toBe('PRIVATE_SECRET')
    expect(api.getActiveProfile()).toEqual(main)
    expect(JSON.stringify(await db.settings.toArray())).not.toContain('PRIVATE_SECRET')
    expect(localStorage.getItem('srl.mainApi.profiles.v2')).not.toContain('PRIVATE_SECRET')
    const restartedApi = new MainApiService(credentials)
    const reopened = new ProductAssistantWorkspaceService(storage, restartedApi, credentials)
    await reopened.initialize()
    expect(reopened.preferences()).toMatchObject({ name: '小蒜', apiProfileId: profile.id })
    expect(reopened.config(restartedApi.getConfig()).apiKey).toBe('PRIVATE_SECRET')
    restartedApi.deleteProfile(profile.id)
    await restartedApi.awaitCredentialWrites()
    expect(reopened.config(restartedApi.getConfig()).model).toBe('main')
    await reopened.savePreferences({ ...reopened.preferences(), apiProfileId: '' })
    expect(reopened.config(restartedApi.getConfig()).apiKey).toBe('MAIN')
  })
  it('migrates the earlier preview only after protected profile storage and ordinary preferences succeed', async () => {
    const { workspace, api, storage, secrets, db } = setup()
    secrets.set('product-assistant:custom-api', 'LEGACY_SECRET')
    await db.settings.put({
      id: 'assistant.preferences',
      updatedAt: 1,
      value: {
        name: '原来的小蒜',
        avatar: '/icons/assistant-avatar.png',
        customApi: {
          ...DEFAULT_MAIN_API_CONFIG,
          url: 'https://assistant.example/v1',
          model: 'assistant',
        },
        credentialPersistence: 'local',
      },
    })
    const saving = vi
      .spyOn(storage, 'savePreferences')
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(workspace.initialize()).rejects.toThrow('disk full')
    expect(secrets.get('product-assistant:custom-api')).toBe('LEGACY_SECRET')
    expect((await db.settings.get('assistant.preferences'))?.value).toHaveProperty('customApi')
    saving.mockRestore()
    await workspace.initialize()
    expect(workspace.preferences()).toMatchObject({
      name: '原来的小蒜',
      apiProfileId: 'product-assistant',
    })
    expect(workspace.config(api.getConfig()).apiKey).toBe('LEGACY_SECRET')
    expect(secrets.has('product-assistant:custom-api')).toBe(false)
    expect((await db.settings.get('assistant.preferences'))?.value).not.toHaveProperty('customApi')
    expect(api.getActiveProfile().id).toBe('default')
  })
  it('rejects unsafe avatars/missing profiles without changing preferences', async () => {
    const { workspace, storage } = setup()
    await workspace.initialize()
    const initial = workspace.preferences()
    await expect(
      workspace.savePreferences({ ...initial, avatar: 'javascript:alert(1)' }),
    ).rejects.toThrow('头像')
    await expect(
      workspace.savePreferences({ ...initial, apiProfileId: 'missing' }),
    ).rejects.toThrow('不存在')
    vi.spyOn(storage, 'savePreferences').mockRejectedValueOnce(new Error('disk full'))
    await expect(workspace.savePreferences({ ...initial, name: '失败的修改' })).rejects.toThrow(
      'disk full',
    )
    expect(workspace.preferences()).toEqual(initial)
  })
  it('exports only a saved GitHub read token through the credentials owner and restores it into protected storage', async () => {
    const { workspace, secrets } = setup()
    await workspace.initialize()
    await workspace.savePreferences(
      { ...workspace.preferences(), githubReadPersistence: 'local' },
      'ghp_saved',
    )
    expect(await workspace.exportPortableGitHubCredential()).toBe('ghp_saved')
    await workspace.savePreferences(
      { ...workspace.preferences(), githubReadPersistence: 'session' },
      'ghp_session',
    )
    expect(await workspace.exportPortableGitHubCredential()).toBeUndefined()
    expect(secrets.has('product-assistant:github-read')).toBe(false)
    await workspace.importPortableGitHubCredential('ghp_restored')
    expect(await workspace.readGitHubCredential()).toBe('ghp_restored')
    expect(secrets.get('product-assistant:github-read')).toBe('ghp_restored')
    await expect(workspace.importPortableGitHubCredential('bad-token')).rejects.toThrow('令牌格式')
    expect(await workspace.readGitHubCredential()).toBe('ghp_restored')
  })
  it('reloads imported assistant preferences instead of keeping the state initialized by credential restore', async () => {
    const { workspace, storage } = setup()
    await workspace.importPortableGitHubCredential('ghp_saved')
    await storage.importPortableState([
      {
        id: 'assistant.preferences',
        value: { ...workspace.preferences(), name: '原机助手', githubReadPersistence: 'local' },
        updatedAt: 100,
      },
    ])
    const listener = vi.fn()
    workspace.onPreferencesChange(listener)
    await workspace.reloadImportedPreferences()
    expect(workspace.preferences().name).toBe('原机助手')
    expect(await workspace.readGitHubCredential()).toBe('ghp_saved')
    expect(listener).toHaveBeenCalledOnce()
  })
})
