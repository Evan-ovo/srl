/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { taskCenter } from '../core/TaskCenter'
import { DiscordSetupService } from './DiscordSetupService'
import { saveDiscordSourceConnectionSettings } from './DiscordSourceSettingsService'
import { MissingDiscordSetupCardError, type DiscordSetupParameters } from './DiscordSetupParameters'
import {
  normalizeDiscordSetupState,
  DISCORD_SETUP_ROUTES,
  type DiscordSetupState,
} from './DiscordSetupWorkflow'
import {
  discordSetupSession,
  type DiscordBrowserSnapshot,
  type DiscordBrowserEvent,
  type DiscordSetupBrowser,
} from './NativeDiscordSetupBrowser'
import { getAssistantRequestTools } from './ProductAssistantService'
const permissionConfirm = vi.hoisted(() =>
  vi.fn(async (_options: { title?: string }, _signal?: AbortSignal) => true),
)
const existingChoice = vi.hoisted(() =>
  vi.fn(async () => 'alternative' as 'confirm' | 'cancel' | 'alternative' | 'additional'),
)
vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction: permissionConfirm,
  chooseAction: existingChoice,
}))

const saved = vi.hoisted(() => ({
  applicationId: '1234567890123456789',
  publicKey: 'a'.repeat(64),
  botToken: 'TEST_SECRET_NOT_FOR_MODEL',
  workerBaseUrl: 'https://example.account.workers.dev',
  commandRegistered: false,
  commandCheckedAt: 0,
  workerVerifiedAt: 0,
}))
vi.mock('./DiscordSourceSettingsService', () => ({
  loadDiscordSourceConnectionSettings: () => ({ ...saved }),
  saveDiscordSourceConnectionSettings: vi.fn(async (value) => {
    Object.assign(saved, value)
    return { ...saved }
  }),
  replaceDiscordSourceConnectionSettings: vi.fn(
    async (value, preserve, _signal, _store, databaseChanged) => {
      const previous = { ...saved }
      if (
        (databaseChanged ||
          ['applicationId', 'publicKey', 'botToken', 'workerBaseUrl'].some(
            (key) => previous[key as keyof typeof previous] !== value[key],
          )) &&
        !(await preserve(previous))
      )
        return undefined
      return saveDiscordSourceConnectionSettings(value)
    },
  ),
  saveDiscordSourceConnectionStatus: vi.fn((value) => {
    Object.assign(saved, value)
  }),
}))
function fixture(state?: DiscordSetupState) {
  let stored = state
  let listener: (event: DiscordBrowserEvent) => void = () => {}
  const page: DiscordBrowserSnapshot = {
    documentId: 1,
    url: 'https://discord.com/developers/applications/1234567890123456789/information',
    paused: false,
    forkOfTarget: false,
    controls: [{ target: '1', label: '保存', kind: 'button', sensitive: false }],
  }
  const browser: DiscordSetupBrowser = {
    open: vi.fn(async () => {}),
    pauseAgent: vi.fn(async () => {}),
    waitReady: vi.fn(async () => ({ ...page })),
    waitStatus: vi.fn(async () => ({ ...page })),
    cancelWait: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ ...page })),
    act: vi.fn(async () => ({ ok: true, formatOnly: true })),
    close: vi.fn(async () => {}),
    confirmSuccess: vi.fn(async () => ({ confirmed: true })),
    suspend: vi.fn(async () => ({ suspended: true })),
    restore: vi.fn(async () => {}),
    pet: vi.fn(async () => {}),
    message: vi.fn(async () => {}),
    addListener: vi.fn(async (_event, callback) => {
      listener = callback
      return { remove: async () => {} }
    }),
  }
  const storage = {
    read: vi.fn(async () => stored),
    save: vi.fn(async (value: DiscordSetupState) => {
      stored = normalizeDiscordSetupState(value)
    }),
  }
  const parameters = {
    prepare: vi.fn(async () => {}),
    read: vi.fn(async (_id: string): Promise<DiscordSetupParameters> => ({
      applicationId: saved.applicationId,
      publicKey: saved.publicKey,
      databaseId: '12345678-1234-5678-9abc-123456789abc',
      workerUrl: saved.workerBaseUrl,
    })),
    save: vi.fn(async (_values: unknown, _id?: string) => 'parameter-card'),
    backupConnection: vi.fn(async (_previous: unknown, id?: string) => id ?? 'old-connection-card'),
    captureBotSecret: vi.fn(
      async (
        _id: string,
        capture: (publicKey: string) => Promise<unknown>,
        _signal?: AbortSignal,
      ) => {
        await capture('EPHEMERAL_PUBLIC_KEY')
      },
    ),
    useBotSecret: vi.fn(
      async (_id: string, consume: (secret: string) => Promise<void>, _signal?: AbortSignal) => {
        await consume(saved.botToken)
      },
    ),
  }
  const service = new DiscordSetupService(storage, browser, parameters)
  return {
    service,
    page,
    browser,
    storage,
    parameters,
    emit: (event: DiscordBrowserEvent) => listener(event),
    stored: () => stored,
  }
}
beforeEach(() => {
  existingChoice.mockReset().mockResolvedValue('alternative')
  permissionConfirm.mockReset().mockResolvedValue(true)
  saved.applicationId = '1234567890123456789'
  saved.publicKey = 'a'.repeat(64)
  saved.botToken = 'TEST_SECRET_NOT_FOR_MODEL'
  discordSetupSession.active = false
  discordSetupSession.browserVisible = false
  discordSetupSession.agentRunning = false
  saved.commandRegistered = false
  saved.commandCheckedAt = 0
  saved.workerVerifiedAt = 0
  saved.workerBaseUrl = 'https://example.account.workers.dev'
})
describe('APK Discord setup workflow', () => {
  it('requires an old-connection backup before changing an update into a new Worker configuration', async () => {
    const f = fixture()
    await f.service.start('update-worker', 'cf-deploy', 'agent')
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/replacement/production'
    vi.mocked(f.browser.act).mockImplementation(async () => ({
      ok: true,
      workerUrl: 'https://replacement.account.workers.dev',
    }))
    await f.service.execute(
      { operation: 'collect-worker', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.backupConnection).toHaveBeenCalledOnce()
    expect(f.stored()).toMatchObject({
      task: 'configure',
      step: 'cf-deploy',
      workerUrl: 'https://replacement.account.workers.dev',
    })
    expect(saved.workerBaseUrl).toBe('https://example.account.workers.dev')
    expect(
      DISCORD_SETUP_ROUTES[f.stored()!.task][
        DISCORD_SETUP_ROUTES[f.stored()!.task].indexOf('cf-deploy') + 1
      ],
    ).toBe('cf-secret')
    expect(f.parameters.save).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: saved.applicationId, publicKey: saved.publicKey }),
      undefined,
    )
    await f.service.pauseAgent()
  })
  it('opens the existing pet quick chat while a page wait is pending, without cancelling the agent', async () => {
    const f = fixture()
    await f.service.start('update-worker', 'github-sync', 'agent')
    f.service.takeAssistantRequest()
    let release!: () => void
    vi.mocked(f.browser.waitReady).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...f.page })
        }),
    )
    const waiting = f.service.execute({ operation: 'wait-page' }, new AbortController().signal)
    await vi.waitFor(() => expect(f.browser.waitReady).toHaveBeenCalled())
    const open = vi.fn()
    const navigate = vi.fn()
    window.addEventListener('srl:discord-setup-quick-chat', open)
    window.addEventListener('srl:native-deep-link', navigate)
    try {
      f.emit({ action: 'quick-chat' })
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
      expect(f.browser.close).toHaveBeenCalledWith({ keepRunning: true })
      expect(discordSetupSession.agentRunning).toBe(true)
      expect(f.browser.cancelWait).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
      expect(f.service.takeAssistantRequest()).toBeUndefined()
    } finally {
      window.removeEventListener('srl:discord-setup-quick-chat', open)
      window.removeEventListener('srl:native-deep-link', navigate)
      release()
      await waiting
      await f.service.pauseAgent()
    }
  })
  it('exits the browser to the host already underneath instead of forcing another chat screen', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    const navigate = vi.fn()
    window.addEventListener('srl:native-deep-link', navigate)
    try {
      f.emit({ action: 'return' })
      await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalled())
      expect(navigate).not.toHaveBeenCalled()
      expect(discordSetupSession.agentRunning).toBe(false)
    } finally {
      window.removeEventListener('srl:native-deep-link', navigate)
    }
  })
  it('does not overwrite the current token with the previous task card when only updating commands', async () => {
    const f = fixture({
      task: 'configure',
      step: 'done',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    await f.service.start('update-commands-only', 'local-settings', 'agent')
    expect(f.parameters.useBotSecret).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toContain('原表单保存')
    await f.service.pauseAgent()
  })
  it.each(['update-commands', 'update-commands-only'] as const)(
    'continues %s after installation with existing credentials and no task card',
    async (task) => {
      const f = fixture()
      await f.service.start(task, 'discord-install', 'agent')
      f.service.takeAssistantRequest()
      f.emit({ action: 'resume' })
      await vi.waitFor(() => expect(f.stored()?.step).toBe('local-settings'))
      expect(f.service.takeAssistantRequest()).toContain('原表单保存')
      expect(f.parameters.save).not.toHaveBeenCalled()
      await f.service.pauseAgent()
    },
  )
  it('updates an existing Worker without creating a partial card that blocks later local settings', async () => {
    const f = fixture()
    const values: DiscordSetupParameters = {}
    f.parameters.read.mockImplementation(async () => ({ ...values }))
    f.parameters.save.mockImplementation(async (next) => {
      Object.assign(values, next)
      return 'parameter-card'
    })
    f.browser.act = vi.fn(async (options) =>
      options.operation === 'collect-worker'
        ? { ok: true, workerUrl: saved.workerBaseUrl }
        : { ok: true, verified: true },
    )
    await f.service.start('update-commands', 'cf-deploy', 'agent')
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/example/production'
    await f.service.execute(
      { operation: 'advance-step', from: 'cf-deploy', document_id: '1', target: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.save).not.toHaveBeenCalled()
    f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/installation`
    f.emit({ action: 'resume' })
    await vi.waitFor(() => expect(f.stored()?.step).toBe('local-settings'))
    await f.service.pauseAgent()
  })
  it('invalidates a diagnosis when the connection changes before choosing a repair', async () => {
    const f = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ database: false }))),
    )
    await f.service.start('diagnose', undefined, 'agent')
    await f.service.execute(
      { operation: 'diagnose', from: 'diagnose' },
      new AbortController().signal,
    )
    saved.workerBaseUrl = 'https://changed.account.workers.dev'
    await expect(
      f.service.execute(
        { operation: 'repair', task: 'configure', from: 'd1-create' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('连接配置已变化')
    expect(f.stored()?.step).toBe('diagnose')
    expect(f.browser.open).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('returns to the retained browser without starting a paused agent or sending a request', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-install',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      assistantConversationId: 'task-chat',
    })
    await f.service.resume()
    await f.service.pauseAgent()
    vi.mocked(f.browser.open).mockClear()
    f.storage.save.mockClear()
    await f.service.returnToBrowser()
    expect(f.browser.open).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCurrent: true,
        conversationId: 'task-chat',
        agentRunId: undefined,
      }),
    )
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(f.storage.save).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('notifies authorization completion without reviving a paused task and continues from the result page on explicit resume', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-install',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
    })
    f.page.url = 'https://discord.com/oauth2/authorized'
    await f.service.resume()
    await f.service.pauseAgent()
    f.page.installationCompleted = true
    expect(
      await f.service.execute({ operation: 'status' }, new AbortController().signal),
    ).toMatchObject({
      browserAvailable: true,
      installationCompleted: true,
      hint: expect.stringContaining('不再要求登录授权'),
    })
    f.emit({ action: 'installation-ready', applicationId: saved.applicationId })
    await vi.waitFor(() =>
      expect(f.browser.message).toHaveBeenCalledWith(
        expect.objectContaining({ phase: expect.stringContaining('授权完成') }),
      ),
    )
    expect(f.stored()?.step).toBe('discord-install')
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    f.emit({ action: 'resume' })
    await vi.waitFor(() => expect(f.stored()?.step).toBe('local-settings'))
    await f.service.pauseAgent()
  })
  it('preserves a verified old task-card UUID before replacing that card with a different database', async () => {
    const f = fixture({
      task: 'configure',
      step: 'd1-uuid',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      parameterResourceId: 'parameter-card',
    })
    await f.service.resume()
    const uuid = '22345678-1234-5678-9abc-123456789abc'
    f.page.url = 'https://dash.cloudflare.com/account/d1/' + uuid
    vi.mocked(f.browser.act).mockResolvedValue({ ok: true, parameters: { databaseId: uuid } })
    await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.backupConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: '12345678-1234-5678-9abc-123456789abc',
        botToken: saved.botToken,
      }),
      undefined,
      expect.anything(),
      expect.any(Function),
    )
    expect(f.parameters.backupConnection.mock.invocationCallOrder[0]).toBeLessThan(
      f.parameters.save.mock.invocationCallOrder[0]!,
    )
    await f.service.pauseAgent()
  })
  it('reuses the persisted backup association after the setup service is reopened', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-endpoint',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    const conflict = {
      ok: false,
      configurationConflict: true,
      previousEndpoint: 'https://old.workers.dev/interactions',
    }
    await f.service.resume()
    vi.mocked(f.browser.act)
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true, filled: true })
    await f.service.execute(
      { operation: 'fill-endpoint', document_id: '1' },
      new AbortController().signal,
    )
    const checkpoint = f.stored()!
    expect(checkpoint.connectionBackupResourceId).toBe('old-connection-card')
    expect(checkpoint.connectionBackupFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(checkpoint)).not.toContain(saved.botToken)
    await f.service.pauseAgent()
    const reopened = fixture(checkpoint)
    await reopened.service.resume()
    vi.mocked(reopened.browser.act)
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true, filled: true })
    await reopened.service.execute(
      { operation: 'fill-endpoint', document_id: '1' },
      new AbortController().signal,
    )
    expect(reopened.parameters.backupConnection).toHaveBeenCalledWith(
      expect.anything(),
      'old-connection-card',
      expect.anything(),
      expect.any(Function),
    )
    await reopened.service.pauseAgent()
  })

  it('offers to reuse a saved connection through the existing diagnostic route, rather than recreate it', async () => {
    const f = fixture()
    existingChoice.mockResolvedValue('confirm')
    await f.service.start('configure', undefined, 'agent')
    expect(f.stored()).toMatchObject({
      task: 'diagnose',
      step: 'diagnose',
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
    })
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(f.parameters.backupConnection).not.toHaveBeenCalled()
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toContain('diagnose')
    await f.service.pauseAgent()
  })
  it('starts no new task when the existing-connection dialog is cancelled', async () => {
    const f = fixture()
    existingChoice.mockResolvedValue('cancel')
    expect(await f.service.start('configure', undefined, 'agent')).toMatchObject({
      cancelled: true,
    })
    expect(f.stored()).toBeUndefined()
    expect(f.browser.open).not.toHaveBeenCalled()
  })
  it('does not overwrite a conflicting Discord endpoint when switching is declined', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-endpoint',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    await f.service.resume()
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: false,
      configurationConflict: true,
      previousEndpoint: 'https://old.workers.dev/interactions',
    })
    permissionConfirm.mockResolvedValue(false)
    const receipt = await f.service.execute(
      { operation: 'fill-endpoint', document_id: '1', target: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: false, cancelled: true })
    expect(f.browser.act).toHaveBeenCalledOnce()
    expect(f.parameters.backupConnection).not.toHaveBeenCalled()
    expect(discordSetupSession.agentRunning).toBe(false)
  })
  it('saves the old endpoint locally before confirming its exact old value to the browser', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-endpoint',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    await f.service.resume()
    vi.mocked(f.browser.act)
      .mockResolvedValueOnce({
        ok: false,
        configurationConflict: true,
        previousEndpoint: 'https://old.workers.dev/interactions',
      })
      .mockResolvedValueOnce({ ok: true, filled: true })
    const receipt = await f.service.execute(
      { operation: 'fill-endpoint', document_id: '1', target: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: true, filled: true })
    expect(f.parameters.backupConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionEndpointUrl: 'https://old.workers.dev/interactions',
        botToken: saved.botToken,
      }),
      undefined,
      expect.anything(),
      expect.any(Function),
    )
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        confirmedPreviousEndpoint: 'https://old.workers.dev/interactions',
      }),
    )
    expect(JSON.stringify(receipt)).not.toContain(saved.botToken)
    await f.service.pauseAgent()
  })
  it('reuses an existing Cloudflare Secret after the current encrypted Token actually authenticates', async () => {
    const f = fixture({
      task: 'configure',
      step: 'cf-secret',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/example/settings'
    f.page.secretStage = 'prepare'
    f.page.secretSavedOnPage = true
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              applicationId: saved.applicationId,
              applicationIdMatches: true,
              publicKeyMatches: true,
              commandRegistered: false,
            }),
          ),
      ),
    )
    await f.service.resume()
    const receipt = await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: true, secretAlreadySaved: true })
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.parameters.backupConnection).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('refuses to replace a pre-existing Cloudflare Secret when its old value cannot be recovered', async () => {
    const f = fixture({
      task: 'configure',
      step: 'cf-secret',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/new/settings'
    f.page.secretStage = 'prepare'
    f.page.secretSavedOnPage = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    )
    await f.service.resume()
    await expect(
      f.service.execute(
        { operation: 'prepare-secret', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('无法完整备份')
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.parameters.backupConnection).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })

  it('preserves a known old D1 target once and checkpoints the new target on repeated open', async () => {
    const oldId = '12345678-1234-5678-9abc-123456789abc'
    const newId = '22345678-1234-5678-9abc-123456789abc'
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
      appliedDatabaseId: oldId,
    })
    f.parameters.read.mockResolvedValue({
      applicationId: saved.applicationId,
      publicKey: saved.publicKey,
      workerUrl: saved.workerBaseUrl,
      databaseId: newId,
    })
    await f.service.resume()
    expect(f.parameters.backupConnection).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: oldId }),
      undefined,
      expect.anything(),
      expect.any(Function),
    )
    expect(f.stored()?.appliedDatabaseId).toBe(newId)
    await f.service.open()
    expect(f.parameters.backupConnection).toHaveBeenCalledOnce()
    await f.service.pauseAgent()
  })
  it('stops without writing when a different connection is declined', async () => {
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      botTokenReady: 'encrypted',
      startedAt: 1,
      applicationId: '2234567890123456789',
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    f.parameters.read.mockResolvedValue({
      applicationId: '2234567890123456789',
      publicKey: 'b'.repeat(64),
      workerUrl: 'https://new.workers.dev',
    })
    permissionConfirm.mockImplementation(
      async (options) => options.title !== '发现已有 Discord Bridge 配置',
    )
    const original = { ...saved }
    const result = await f.service.resume()
    expect(result).toMatchObject({ cancelled: true })
    expect(saved).toEqual(original)
    expect(f.parameters.backupConnection).not.toHaveBeenCalled()
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(permissionConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ centered: true, confirmLabel: '保存旧配置并切换' }),
      expect.anything(),
    )
  })
  it('preserves the old connection before saving a new target and reuses it on repeated open', async () => {
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      botTokenReady: 'encrypted',
      startedAt: 1,
      applicationId: '2234567890123456789',
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    f.parameters.read.mockResolvedValue({
      applicationId: '2234567890123456789',
      publicKey: 'b'.repeat(64),
      workerUrl: 'https://new.workers.dev',
    })
    const original = { ...saved }
    f.parameters.backupConnection.mockImplementation(async () => {
      expect(saved).toEqual(original)
      return 'old-connection-card'
    })
    await f.service.resume()
    expect(f.parameters.backupConnection).toHaveBeenCalledWith(
      original,
      undefined,
      expect.anything(),
      expect.any(Function),
    )
    expect(saved.workerBaseUrl).toBe('https://new.workers.dev')
    await f.service.open()
    expect(f.parameters.backupConnection).toHaveBeenCalledOnce()
    await f.service.pauseAgent()
  })
  it('keeps the original connection when encrypted backup fails', async () => {
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      botTokenReady: 'encrypted',
      startedAt: 1,
      applicationId: '2234567890123456789',
      workerUrl: 'https://new.workers.dev',
      parameterResourceId: 'parameter-card',
    })
    f.parameters.read.mockResolvedValue({
      applicationId: '2234567890123456789',
      publicKey: 'b'.repeat(64),
      workerUrl: 'https://new.workers.dev',
    })
    f.parameters.backupConnection.mockRejectedValue(new Error('备份失败'))
    const original = { ...saved }
    await expect(f.service.resume()).rejects.toThrow('备份失败')
    expect(saved).toEqual(original)
    await f.service.pauseAgent()
  })
  it.each(['srl-discord-source-bridge', 'renamed-bridge'])(
    'keeps the current-task root for %s when the production result tab does not repeat its link',
    async (workerName) => {
      const workerUrl = `https://${workerName}.account.workers.dev`
      const f = fixture({
        task: 'configure',
        step: 'cf-deploy',
        mode: 'agent',
        startedAt: 1,
        applicationId: saved.applicationId,
        parameterResourceId: 'parameter-card',
      })
      try {
        await f.service.resume()
        f.page.url = `https://dash.cloudflare.com/account/workers/services/view/${workerName}`
        vi.mocked(f.browser.act).mockResolvedValue({ ok: true, workerUrl })
        await f.service.execute(
          { operation: 'collect-worker', document_id: '1', target: '1' },
          new AbortController().signal,
        )
        expect(f.browser.act).toHaveBeenCalledWith(
          expect.objectContaining({ operation: 'collect-worker', target: '1' }),
        )
        f.parameters.read.mockResolvedValue({
          applicationId: saved.applicationId,
          publicKey: saved.publicKey,
          workerUrl,
        })
        f.page.url += '/deployments'
        vi.mocked(f.browser.act)
          .mockClear()
          .mockImplementation(async (options) =>
            options.operation === 'verify-step' ? { ok: true, verified: true } : { ok: false },
          )
        const receipt = await f.service.execute(
          {
            operation: 'advance-step',
            from: 'cf-deploy',
            document_id: '1',
            target: '1',
            deployment_assessment: 'deployed',
          },
          new AbortController().signal,
        )
        expect(f.stored()).toMatchObject({ step: 'cf-secret', workerUrl })
        expect(f.browser.act).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'verify-step',
            statusTarget: '1',
            deploymentAssessment: 'deployed',
          }),
        )
        expect(f.browser.act).not.toHaveBeenCalledWith(
          expect.objectContaining({ operation: 'collect-worker' }),
        )
        expect(JSON.stringify(receipt)).not.toContain(workerUrl)
      } finally {
        await f.service.pauseAgent()
      }
    },
  )
  it.each(['before-task', 'other-worker', 'different-card'])(
    'does not reuse a cached Worker root from %s for a new production result',
    async (reason) => {
      const workerUrl =
        reason === 'other-worker'
          ? 'https://different-worker.account.workers.dev'
          : 'https://srl-discord-source-bridge.account.workers.dev'
      const f = fixture({
        task: 'configure',
        step: 'cf-deploy',
        mode: 'agent',
        startedAt: 2,
        applicationId: saved.applicationId,
        parameterResourceId: 'parameter-card',
        workerUrl,
        workerConfirmedAt: reason === 'before-task' ? 1 : Date.now(),
      })
      try {
        await f.service.resume()
        f.parameters.read.mockResolvedValue({
          applicationId: saved.applicationId,
          workerUrl: reason === 'different-card' ? saved.workerBaseUrl : workerUrl,
        })
        f.page.url =
          'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/deployments'
        vi.mocked(f.browser.act).mockImplementation(async (options) =>
          options.operation === 'verify-step' ? { ok: true, verified: true } : { ok: false },
        )
        await expect(
          f.service.execute(
            { operation: 'advance-step', from: 'cf-deploy', document_id: '1', target: '1' },
            new AbortController().signal,
          ),
        ).rejects.toThrow('未找到唯一的 Worker 根链接')
        expect(f.stored()?.step).toBe('cf-deploy')
      } finally {
        await f.service.pauseAgent()
      }
    },
  )
  it('records a new deployment and reaches Secret while the old paired connection remains protected', async () => {
    const saveSettings = vi.mocked(saveDiscordSourceConnectionSettings)
    const original = saveSettings.getMockImplementation()!
    saveSettings.mockClear().mockImplementation(async () => {
      throw new Error('请先领取待收帖子及资源任务并断开云端收件配对')
    })
    const before = { ...saved }
    const nextUrl = 'https://new-worker.account.workers.dev'
    const changed = vi.fn()
    window.addEventListener('srl:discord-setup-worker', changed)
    const f = fixture({
      task: 'configure',
      step: 'cf-deploy',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      parameterResourceId: 'parameter-card',
    })
    try {
      await f.service.resume()
      f.page.url =
        'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production'
      vi.mocked(f.browser.act).mockImplementation(async (options) =>
        options.operation === 'collect-worker'
          ? { ok: true, workerUrl: nextUrl }
          : { ok: true, verified: true },
      )
      await f.service.execute(
        { operation: 'advance-step', from: 'cf-deploy', document_id: '1', target: '1' },
        new AbortController().signal,
      )
      expect(f.stored()).toMatchObject({ step: 'cf-secret', workerUrl: nextUrl })
      expect(f.parameters.save).toHaveBeenCalledWith({ workerUrl: nextUrl }, 'parameter-card')
      expect(saveSettings).not.toHaveBeenCalled()
      expect(saved).toEqual(before)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('srl:discord-setup-worker', changed)
      saveSettings.mockImplementation(original)
      await f.service.pauseAgent()
    }
  })
  it('advances a successful production deployment to Secret without requesting pre-Secret health', async () => {
    const f = fixture({
      task: 'configure',
      step: 'cf-deploy',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
    })
    await f.service.resume()
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production'
    vi.mocked(f.browser.act).mockImplementation(async (options) =>
      options.operation === 'collect-worker'
        ? { ok: true, workerUrl: saved.workerBaseUrl }
        : { ok: true, verified: true },
    )
    const fetch = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    await f.service.execute(
      { operation: 'advance-step', from: 'cf-deploy', document_id: '1', target: '1' },
      new AbortController().signal,
    )
    expect(f.stored()?.step).toBe('cf-secret')
    expect(fetch).not.toHaveBeenCalled()
    expect(f.stored()?.workerUrl).toBe(saved.workerBaseUrl)
  })
  it('allows an active agent to leave a failed public preview, without retrying it or overriding a user pause', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    f.service.takeAssistantRequest()
    Object.assign(f.page, {
      url: 'https://preview.bridge.account.workers.dev/',
      paused: true,
      failed: true,
      pageAccess: 'public',
    })
    f.page.controls = []
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toContain('navigate')
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    const signal = new AbortController().signal
    expect(await f.service.execute({ operation: 'wait-page' }, signal)).toMatchObject({
      waitingForUser: false,
      recoveryNavigation: true,
    })
    expect(await f.service.execute({ operation: 'inspect' }, signal)).toMatchObject({
      waitingForUser: false,
      recoveryNavigation: true,
    })
    vi.mocked(f.browser.act).mockClear()
    await f.service.execute({ operation: 'click', target: '1', document_id: '1' }, signal)
    expect(f.browser.act).not.toHaveBeenCalled()
    await expect(
      f.service.execute({ operation: 'navigate', url: f.page.url }, signal),
    ).rejects.toThrow('不自动重试')
    await f.service.execute(
      { operation: 'navigate', url: 'https://dash.cloudflare.com/account/workers' },
      signal,
    )
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'navigate',
        url: 'https://dash.cloudflare.com/account/workers',
      }),
    )
    await f.service.pauseAgent()
    vi.mocked(f.browser.act).mockClear()
    f.emit({ action: 'page-ready' })
    await f.service.execute(
      { operation: 'navigate', url: 'https://dash.cloudflare.com/account/workers' },
      signal,
    )
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('does not misclassify a queued page-ready event as user authorization when a new navigation is loading', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    f.service.takeAssistantRequest()
    f.page.loading = true
    f.page.paused = true
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    expect(f.browser.message).toHaveBeenCalledWith(
      expect.objectContaining({ phase: '正在等待网页加载，加载完成后继续' }),
    )
    expect(discordSetupSession.agentRunning).toBe(true)
    await f.service.pauseAgent()
  })
  it('does not queue another model turn just because the same page loaded again, but accepts changed content', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    f.service.takeAssistantRequest()
    f.page.url = 'https://dash.cloudflare.com/account/workers-and-pages/create'
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toContain('inspect')
    f.page.documentId++
    f.page.controls = [{ target: '101', label: '保存', kind: 'button', sensitive: false }]
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    const duplicate = f.service.takeAssistantRequest()
    f.page.controls = [
      { target: '201', label: 'Select repository', kind: 'button', sensitive: false },
    ]
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    const changed = f.service.takeAssistantRequest()
    await f.service.pauseAgent()
    expect(duplicate).toBeUndefined()
    expect(changed).toContain('inspect')
  })
  it.each(['wait-page', 'wait-status'])(
    'interrupts an in-flight %s before queuing the user problem',
    async (operation) => {
      const f = fixture()
      await f.service.start('configure', 'cf-deploy', 'agent')
      f.service.takeAssistantRequest()
      let respond!: (page: DiscordBrowserSnapshot) => void
      const wait = operation === 'wait-page' ? f.browser.waitReady : f.browser.waitStatus
      vi.mocked(wait).mockImplementationOnce(
        () =>
          new Promise<DiscordBrowserSnapshot>((resolve) => {
            respond = resolve
          }),
      )
      const waiting = f.service
        .execute({ operation, target: '1', document_id: '1' }, new AbortController().signal)
        .then(
          () => 'completed',
          (error: Error) => error.name,
        )
      await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
      f.emit({ action: 'assist', text: '仓库已经授权了，请检查部署失败原因' })
      const interrupted = vi.mocked(f.browser.cancelWait).mock.calls.length > 0
      respond({ ...f.page })
      const outcome = await waiting
      await f.service.execute({ operation: 'status' }, new AbortController().signal)
      const request = f.service.takeAssistantRequest()
      await f.service.pauseAgent()
      expect(interrupted).toBe(true)
      expect(outcome).toBe('AbortError')
      expect(request).toContain('仓库已经授权了，请检查部署失败原因')
      expect(f.stored()?.step).toBe('cf-deploy')
    },
  )
  it.each(['click', 'navigate'])(
    'does not treat the same %s in a reloaded document as new progress',
    async (operation) => {
      const f = fixture()
      await f.service.start('configure', 'cf-deploy', 'agent')
      f.service.takeAssistantRequest()
      f.page.url = 'https://dash.cloudflare.com/account/workers-and-pages/create'
      f.page.controls = [{ target: '1', label: 'Connect GitHub', kind: 'button', sensitive: false }]
      vi.mocked(f.browser.act).mockResolvedValue({ ok: true, dispatched: true, verified: false })
      const args = { operation, target: '1', document_id: '1', url: f.page.url }
      await f.service.execute(args, new AbortController().signal)
      const cursor = f.service.progressCursor()
      f.page.documentId = 2
      f.page.controls = [
        { target: '101', label: 'Connect GitHub', kind: 'button', sensitive: false },
      ]
      await f.service.execute(
        { ...args, target: '101', document_id: '2' },
        new AbortController().signal,
      )
      const progress = f.service.progressCursor()
      await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
      const request = f.service.takeAssistantRequest()
      await f.service.pauseAgent()
      expect(progress).toBe(cursor)
      expect(request).toBeUndefined()
    },
  )
  it('does not spend another model turn because unrelated public text changes', async () => {
    const f = fixture()
    try {
      await f.service.start('configure', 'cf-deploy', 'agent')
      f.service.takeAssistantRequest()
      f.page.controls = [
        { target: '1', label: 'Deployments', kind: 'button', sensitive: false },
        { target: '2', label: '42 requests', kind: 'public-text', sensitive: false },
      ]
      await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
      const cursor = f.service.progressCursor()
      f.page.controls[1]!.label = '43 requests'
      await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
      await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
      expect(f.service.progressCursor()).toBe(cursor)
      expect(f.service.takeAssistantRequest()).toBeUndefined()
    } finally {
      await f.service.pauseAgent()
    }
  })
  it('does not count scrolling a known control into view as new task progress', async () => {
    const f = fixture()
    try {
      await f.service.start('configure', 'cf-deploy', 'agent')
      f.service.takeAssistantRequest()
      f.page.controls = [
        { target: '1', label: 'Deploy', kind: 'button', sensitive: false, visible: false },
      ]
      await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
      const cursor = f.service.progressCursor()
      f.page.controls[0]!.visible = true
      f.page.controls[0]!.target = '101'
      await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
      await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
      expect(f.service.progressCursor()).toBe(cursor)
      expect(f.service.takeAssistantRequest()).toBeUndefined()
      // A website enabling the actual action remains meaningful progress.
      f.page.controls[0]!.disabled = true
      await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
      expect(f.service.progressCursor()).toBeGreaterThan(cursor)
    } finally {
      await f.service.pauseAgent()
    }
  })
  it('passes the verified Fork to authorization and continues after a dispatched page transition', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    f.service.takeAssistantRequest()
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge'
    f.page.forkOfTarget = true
    await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    f.page.url = 'https://github.com/apps/cloudflare-workers-and-pages/installations/new'
    f.page.forkOfTarget = false
    f.page.controls = [
      { target: '1', label: 'Install & Authorize', kind: 'button', sensitive: false },
    ]
    const cursor = f.service.progressCursor()
    vi.mocked(f.browser.act).mockResolvedValueOnce({
      ok: true,
      dispatched: true,
      verified: false,
      pageChanged: true,
    })
    const receipt = await f.service.execute(
      { operation: 'click', target: '1', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'click', expectedFork: 'test-user/SRL-Discord-Bridge' }),
    )
    expect(receipt).toMatchObject({
      dispatched: true,
      verified: false,
      pageChanged: true,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    expect(f.stored()?.step).toBe('cf-deploy')
    await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
    expect(f.service.takeAssistantRequest()).toContain('代理任务已取得新进展')
    await f.service.pauseAgent()
  })
  it('keeps the user problem ahead of page-ready and automatic progress prompts', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.service.takeAssistantRequest()
    f.emit({ action: 'assist', text: 'Application name cannot contain discord，请改名字' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.peekAssistantRequest()).toContain('Application name cannot contain discord')
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    const cursor = f.service.progressCursor()
    await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
    const request = f.service.takeAssistantRequest()!
    expect(request).toContain('Application name cannot contain discord')
    expect(request).toContain('先处理用户')
    expect(f.stored()?.step).toBe('discord-app')
    f.page.controls = [
      { target: '101', label: 'General Information', kind: 'button', sensitive: false },
    ]
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toContain('inspect')
    await f.service.pauseAgent()
  })
  it('resumes the actual deployment page when the user sends feedback or reopens the task', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ resumeCurrent: true }),
    )
    f.page.url = 'https://dash.cloudflare.com/account/workers-and-pages/create/workers/new'
    f.service.takeAssistantRequest()
    f.emit({ action: 'assist', text: '为什么跑去 Hello World 了？' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeCurrent: true }),
    )
    expect(f.service.takeAssistantRequest()).toContain('为什么跑去 Hello World')
    await f.service.execute({ operation: 'open' }, new AbortController().signal)
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeCurrent: true }),
    )
    await f.service.pauseAgent()
    await f.service.resume()
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeCurrent: true }),
    )
    await f.service.restart('configure', 'agent')
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ resumeCurrent: true }),
    )
    await f.service.pauseAgent()
  })
  it('returns the actual source deployment goal instead of treating a create URL as repository evidence', async () => {
    const f = fixture({
      task: 'configure',
      step: 'cf-deploy',
      mode: 'agent',
      startedAt: Date.now(),
      forkRepo: 'example-user/SRL-Discord-Bridge',
      githubRevision: 'a'.repeat(40),
    })
    const status = await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(status).toMatchObject({
      deploymentGoal: {
        repository: 'example-user/SRL-Discord-Bridge',
        branch: 'main',
        revision: 'a'.repeat(40),
        workerName: 'srl-discord-source-bridge',
        deployCommand: 'npm run deploy',
      },
    })
    expect(status.hint).toContain('Hello World')
    expect(status.hint).toContain('网址')
    expect(status.hint).toContain('构建命令')
  })
  it.each(['https://discord.com/login', 'https://accounts.google.com/signin'])(
    'accepts a problem on paused %s without reading or acting on it',
    async (url) => {
      const f = fixture()
      await f.service.start('configure', undefined, 'agent')
      f.service.takeAssistantRequest()
      f.page.url = url
      f.page.paused = true
      f.emit({ action: 'assist', text: '我登录了错误的账号，应该怎么办？' })
      await f.service.execute({ operation: 'status' }, new AbortController().signal)
      expect(f.service.takeAssistantRequest()).toContain('我登录了错误的账号')
      expect(f.browser.inspect).toHaveBeenLastCalledWith({ metadataOnly: true })
      expect(f.browser.act).not.toHaveBeenCalled()
      expect(f.stored()?.step).toBe('discord-app')
      await f.service.pauseAgent()
    },
  )
  it('pauses through the original owner without closing the page or losing the task', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.service.takeAssistantRequest()
    const before = f.stored()
    expect(
      await f.service.execute({ operation: 'pause' }, new AbortController().signal),
    ).toMatchObject({ ok: true, paused: true, waitingForUser: true })
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(f.browser.pauseAgent).toHaveBeenCalledOnce()
    expect(f.browser.close).not.toHaveBeenCalled()
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.stored()).toEqual(before)
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('rejects a secret-like question before restarting or interrupting an active run', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.service.takeAssistantRequest()
    const run = f.service.agentRunId()
    vi.mocked(f.browser.open).mockClear()
    f.emit({ action: 'assist', text: 'sk-' + 'SECRET_NOT_FOR_THE_MODEL'.repeat(2) })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    expect(f.service.agentRunId()).toBe(run)
    expect(f.browser.pauseAgent).not.toHaveBeenCalled()
    expect(f.browser.open).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('diagnoses without opening third-party pages or creating cards, then repairs in the same task conversation', async () => {
    const f = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, database: false }))),
    )
    await f.service.start('diagnose', undefined, 'agent')
    const conversation = f.stored()?.assistantConversationId
    expect(conversation).toBeTruthy()
    expect(f.browser.open).not.toHaveBeenCalled()
    await expect(
      f.service.execute(
        { operation: 'repair', task: 'configure', from: 'd1-create' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('完成 diagnose')
    const result = await f.service.execute(
      { operation: 'diagnose', from: 'diagnose' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ diagnosis: { state: 'd1-error' }, step: 'diagnose' })
    expect(JSON.stringify(result)).not.toContain(saved.botToken)
    await expect(f.service.next()).rejects.toThrow('排查结果不等于配置完成')
    await f.service.execute(
      { operation: 'repair', task: 'configure', from: 'd1-create' },
      new AbortController().signal,
    )
    expect(f.stored()).toMatchObject({
      task: 'configure',
      step: 'd1-create',
      assistantConversationId: conversation,
    })
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(permissionConfirm).toHaveBeenCalledOnce()
  })
  it('stops a pending diagnosis and discards a late health response', async () => {
    const f = fixture()
    await f.service.start('diagnose', undefined, 'agent')
    let respond!: (value: Response) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const request = f.service.execute(
      { operation: 'diagnose', from: 'diagnose' },
      new AbortController().signal,
    )
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    f.emit({ action: 'agent-pause' })
    await vi.waitFor(() => expect(discordSetupSession.agentRunning).toBe(false))
    respond(new Response(JSON.stringify({ ok: true, database: false })))
    await rejected
    expect(f.stored()?.step).toBe('diagnose')
    await expect(
      f.service.execute(
        { operation: 'repair', task: 'configure', from: 'd1-create' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('活动排查任务')
  })
  it('rejects diagnosis results after connection settings change instead of permitting repairs', async () => {
    const f = fixture()
    await f.service.start('diagnose', undefined, 'agent')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        saved.workerBaseUrl = 'https://changed.account.workers.dev'
        return new Response(JSON.stringify({ ok: true, database: false }))
      }),
    )
    await expect(
      f.service.execute({ operation: 'diagnose', from: 'diagnose' }, new AbortController().signal),
    ).rejects.toThrow('连接配置已变化')
    await expect(
      f.service.execute(
        { operation: 'repair', task: 'configure', from: 'd1-create' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('完成 diagnose')
  })
  it.each(['d1-create', 'github-fork', 'github-sync', 'cf-deploy', 'discord-endpoint'] as const)(
    'distinguishes page loading from a user handoff at %s and keeps the task running',
    async (step) => {
      const f = fixture()
      await f.service.start(step === 'github-sync' ? 'update-worker' : 'configure', step, 'agent')
      f.service.takeAssistantRequest()
      f.page.loading = true
      f.page.paused = true
      const controller = new AbortController()
      expect(await f.service.execute({ operation: 'inspect' }, controller.signal)).toMatchObject({
        ok: true,
        loading: true,
        waitingForPage: true,
        waitingForUser: false,
      })
      expect(await f.service.execute({ operation: 'wait-page' }, controller.signal)).toMatchObject({
        waitingForPage: true,
        waitingForUser: false,
      })
      expect(f.browser.act).not.toHaveBeenCalled()
      const run = f.service.agentRunId()
      await f.service.settleAssistantTurn(run)
      expect(discordSetupSession.agentRunning).toBe(true)
      expect(f.browser.pauseAgent).not.toHaveBeenCalled()
      f.page.loading = false
      f.page.paused = false
      f.emit({ action: 'page-ready' })
      await vi.waitFor(() => expect(f.service.takeAssistantRequest()).toContain('inspect'))
      await f.service.pauseAgent()
    },
  )
  it('uses a valid default App name through the actual field shortcut', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.page.controls = [{ target: '1', label: 'Application name', kind: 'input', sensitive: false }]
    await f.service.execute(
      { operation: 'fill', target: '1', document_id: '1', field: 'app-name' },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'fill', value: 'SRL Bridge' }),
    )
    await f.service.pauseAgent()
  })
  it('restarts with a fresh agent conversation and clears a deleted card and its stale Token status', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'deleted-card',
      botTokenReady: 'encrypted',
      assistantConversationId: 'old-agent-chat',
    })
    f.parameters.read.mockRejectedValueOnce(new MissingDiscordSetupCardError())
    await f.service.restart('configure', 'agent')
    expect(f.stored()?.parameterResourceId).toBeUndefined()
    expect(f.stored()?.botTokenReady).toBeUndefined()
    const chat = await f.service.assistantConversationId()
    expect(chat).toBeTruthy()
    expect(chat).not.toBe('old-agent-chat')
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.save).toHaveBeenCalledOnce()
    expect(f.parameters.save.mock.calls[0]?.[1]).toBeUndefined()
    await f.service.resume()
    expect(await f.service.assistantConversationId()).toBe(chat)
  })
  it('reports a missing card honestly and rebuilds it once after the native confirmation', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'deleted-card',
      botTokenReady: 'encrypted',
    })
    f.parameters.read.mockImplementation(async (id) => {
      if (id === 'deleted-card') throw new MissingDiscordSetupCardError()
      return { applicationId: saved.applicationId, publicKey: saved.publicKey }
    })
    const status = await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(status).toMatchObject({
      parameterCardState: 'missing',
      savedFields: [],
      parametersSaved: false,
      botSecretSaved: false,
    })
    await f.service.resume()
    permissionConfirm.mockClear()
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    const collect = () =>
      f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      )
    await Promise.all([collect(), collect()])
    expect(permissionConfirm).toHaveBeenCalledOnce()
    expect(permissionConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ centered: true, title: '重新建立部署密钥卡' }),
      expect.any(AbortSignal),
    )
    expect(f.parameters.save.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      'parameter-card',
    ])
    expect(f.stored()?.botTokenReady).toBeUndefined()
    const result = await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(result).toMatchObject({
      savedFields: ['applicationId', 'publicKey'],
      parameterCardState: 'available',
    })
    expect(JSON.stringify(result)).not.toContain(saved.publicKey)
    expect(JSON.stringify(result)).not.toContain(saved.applicationId)
  })
  it('keeps a deleted-card recovery cancelled without creating a card or advancing', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'deleted-card',
    })
    await f.service.resume()
    f.parameters.read.mockRejectedValue(new MissingDiscordSetupCardError())
    permissionConfirm.mockResolvedValueOnce(false)
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    await expect(
      f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('已取消')
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(f.stored()?.parameterResourceId).toBe('deleted-card')
    expect(f.stored()?.step).toBe('discord-app')
  })
  it('reuses the original card if it is restored while the recovery confirmation is open', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'restored-card',
      botTokenReady: 'encrypted',
    })
    await f.service.resume()
    f.parameters.read.mockRejectedValueOnce(new MissingDiscordSetupCardError())
    permissionConfirm.mockClear()
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.save.mock.calls[0]?.[1]).toBe('restored-card')
    expect(f.stored()?.botTokenReady).toBe('encrypted')
    expect(permissionConfirm).toHaveBeenCalledOnce()
  })
  it('does not recreate a card after pausing during its recovery confirmation', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'deleted-card',
    })
    await f.service.resume()
    f.parameters.read.mockRejectedValue(new MissingDiscordSetupCardError())
    let finish!: (confirmed: boolean) => void
    permissionConfirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    const pending = f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    await f.service.pauseAgent()
    finish(true)
    await rejected
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(f.stored()?.parameterResourceId).toBe('deleted-card')
  })
  it('advances a reopened App page from actual stored public fields without re-reading dynamic controls', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
      parameterResourceId: 'parameter-card',
      applicationId: saved.applicationId,
    })
    f.page.documentId = 27
    await f.service.resume()
    await f.service.execute(
      { operation: 'advance-step', from: 'discord-app', document_id: '27' },
      new AbortController().signal,
    )
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.stored()?.step).toBe('discord-token')
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `https://discord.com/developers/applications/${saved.applicationId}/bot`,
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())
  it('keeps progress and complete replies available when viewing full chat, releasing control when a turn cannot continue', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'wrangler-edit', startedAt: 1 })
    await f.service.resume()
    const run = f.service.agentRunId()
    const reply = '详细操作进度。'.repeat(100)
    f.emit({ action: 'fullscreen' })
    await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalledWith({ keepRunning: true }))
    expect(discordSetupSession.agentRunning).toBe(true)
    await f.service.showAssistantProgress('正在保存配置')
    await f.service.showAssistantReply(reply)
    expect(f.browser.message).toHaveBeenCalledWith({ text: reply })
    expect(f.browser.message).toHaveBeenCalledWith({ text: '', phase: '正在保存配置' })
    await f.service.settleAssistantTurn(run)
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(f.browser.pauseAgent).toHaveBeenCalled()
    expect(f.browser.message).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: expect.stringContaining('未返回后续操作且未核验到新进展') }),
    )
  })
  it('reuses one card across queued captures, a failed workflow write and a configuration restart', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    const collect = () =>
      f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      )
    // rememberPage already has this App, so the failure occurs after the card is created.
    await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    f.storage.save.mockRejectedValueOnce(new Error('workflow storage unavailable'))
    await expect(collect()).rejects.toThrow('storage unavailable')
    await Promise.all([collect(), collect()])
    expect(f.parameters.save.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      'parameter-card',
      'parameter-card',
    ])
    await f.service.restart('configure', 'agent')
    await collect()
    expect(f.parameters.save.mock.calls.at(-1)?.[1]).toBe('parameter-card')
    expect(f.stored()?.parameterResourceId).toBe('parameter-card')
  })
  it('keeps a successful field collection when advancing the same document after scrolling', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    vi.mocked(f.browser.act)
      .mockResolvedValueOnce({
        ok: true,
        parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
      })
      .mockResolvedValue({ ok: false })
    await f.service.execute(
      {
        operation: 'collect-config',
        document_id: '1',
        application_id_target: '7',
        public_key_target: '8',
      },
      new AbortController().signal,
    )
    await f.service.execute(
      { operation: 'advance-step', from: 'discord-app', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.stored()?.step).toBe('discord-token')
    expect(f.browser.act).toHaveBeenCalledOnce()
  })
  it('captures the explicitly confirmed Token through the local owners before going to D1', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-token',
      startedAt: 1,
      applicationId: saved.applicationId,
      parameterResourceId: 'parameter-card',
    })
    f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/bot`
    f.browser.captureBotSecret = vi.fn(async () => ({
      key: 'encrypted-key',
      iv: 'encrypted-iv',
      data: 'encrypted-data',
    }))
    await f.service.resume()
    f.emit({ action: 'capture-bot-secret' })
    await vi.waitFor(() => expect(f.stored()?.step).toBe('d1-create'))
    expect(f.parameters.captureBotSecret).toHaveBeenCalledOnce()
    expect(f.browser.captureBotSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: saved.applicationId,
        documentId: 1,
        publicKey: 'EPHEMERAL_PUBLIC_KEY',
      }),
    )
    expect(f.stored()?.botTokenReady).toBe('encrypted')
    expect(JSON.stringify(f.storage.save.mock.calls)).not.toContain(saved.botToken)
  })
  it('does not treat an old saved Token as the new one when confirmed recapture fails', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-token',
      startedAt: 1,
      applicationId: saved.applicationId,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/bot`
    f.browser.captureBotSecret = vi.fn(async () => {
      throw new Error('New Token was not recognized')
    })
    await f.service.resume()
    f.emit({ action: 'capture-bot-secret' })
    await vi.waitFor(() =>
      expect(f.browser.message).toHaveBeenCalledWith({ text: 'New Token was not recognized' }),
    )
    expect(f.stored()?.botTokenReady).toBeUndefined()
    expect(f.stored()?.step).toBe('discord-token')
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(
      await f.service.execute({ operation: 'status' }, new AbortController().signal),
    ).toMatchObject({ botSecretSaved: false })
  })
  it('blindly fills the prepared Worker form and does not put the Token into tool receipts', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/example/production/settings'
    f.page.paused = true
    f.page.secretStage = 'input'
    f.browser.fillBotSecret = vi.fn(async () => {
      f.page.secretStage = 'submit'
      return { ok: true }
    })
    vi.mocked(f.browser.act).mockResolvedValue({ ok: true, secretStage: 'submitted' })
    await f.service.resume()
    const result = await f.service.execute(
      { operation: 'transfer-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.browser.fillBotSecret).toHaveBeenCalledWith({ documentId: 1, secret: saved.botToken })
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'submit-secret' }),
    )
    expect(JSON.stringify(result)).not.toContain(saved.botToken)
  })
  it('asks centered permissions before preparing credentials or creating an agent task, leaving cancellation unchanged', async () => {
    const f = fixture()
    let approve!: (value: boolean) => void
    permissionConfirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve
        }),
    )
    const starting = f.service.start('configure', undefined, 'agent')
    await vi.waitFor(() => expect(permissionConfirm).toHaveBeenCalledOnce())
    expect(permissionConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        centered: true,
        confirmLabel: '确认权限并开启',
        message: expect.stringContaining('会修改当前账号配置'),
      }),
      expect.any(AbortSignal),
    )
    expect(f.parameters.prepare).not.toHaveBeenCalled()
    expect(f.storage.save).not.toHaveBeenCalled()
    expect(f.browser.open).not.toHaveBeenCalled()
    expect(discordSetupSession.agentRunning).toBe(false)
    approve(false)
    expect(await starting).toMatchObject({ cancelled: true })
    expect(f.stored()).toBeUndefined()
  })
  it('does not grant permissions after stop while a late confirmation is pending', async () => {
    const f = fixture()
    let approve!: (value: boolean) => void
    permissionConfirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve
        }),
    )
    const starting = f.service.start('configure', undefined, 'agent')
    await vi.waitFor(() => expect(permissionConfirm).toHaveBeenCalledOnce())
    await f.service.pauseAgent()
    approve(true)
    expect(await starting).toMatchObject({ cancelled: true })
    expect(f.browser.open).not.toHaveBeenCalled()
    expect(f.parameters.prepare).not.toHaveBeenCalled()
    expect(discordSetupSession.agentRunning).toBe(false)
  })
  it('also confirms model-start and saved-task tools before exposing the browser', async () => {
    permissionConfirm.mockResolvedValue(false)
    const f = fixture()
    expect(
      await f.service.execute(
        { operation: 'start', task: 'configure', mode: 'agent' },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, cancelled: true })
    expect(f.browser.open).not.toHaveBeenCalled()
    const savedTask = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'discord-app',
      startedAt: 1,
    })
    expect(
      await savedTask.service.execute({ operation: 'inspect' }, new AbortController().signal),
    ).toMatchObject({ ok: false, cancelled: true })
    expect(savedTask.browser.inspect).not.toHaveBeenCalled()
    expect(await savedTask.service.resume()).toMatchObject({ cancelled: true })
    expect(savedTask.browser.open).not.toHaveBeenCalled()
  })
  it('reuses session consent when explicitly resuming, and aborts a model permission request', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    await f.service.pauseAgent()
    await f.service.resume()
    expect(permissionConfirm).toHaveBeenCalledOnce()
    await f.service.pauseAgent()
    const other = fixture()
    let approve!: (value: boolean) => void
    permissionConfirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve
        }),
    )
    const controller = new AbortController()
    const pending = other.service.execute(
      { operation: 'start', task: 'configure', mode: 'agent' },
      controller.signal,
    )
    await vi.waitFor(() => expect(permissionConfirm).toHaveBeenCalledTimes(2))
    controller.abort()
    approve(true)
    expect(await pending).toMatchObject({ cancelled: true })
    expect(other.browser.open).not.toHaveBeenCalled()
  })
  it.each(['input', 'textarea', 'textbox', 'combobox', 'searchbox', 'spinbutton'])(
    'fills ordinary %s and locally bound parameters without returning either in receipts',
    async (kind) => {
      const f = fixture()
      await f.service.start('configure', undefined, 'agent')
      f.page.controls = [{ target: '1', label: 'Description', kind, sensitive: false }]
      vi.mocked(f.browser.act).mockResolvedValue({ ok: true, filled: true })
      const receipt = await f.service.execute(
        { operation: 'fill', target: '1', document_id: '1', value: 'A bridge for my resources' },
        new AbortController().signal,
      )
      expect(f.browser.act).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: 'A bridge for my resources' }),
      )
      expect(JSON.stringify(receipt)).not.toContain('A bridge for my resources')
      // Existing parameter resource reference is supplied by the normal local collect operation.
      vi.mocked(f.browser.act).mockResolvedValueOnce({
        ok: true,
        parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
      })
      await f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      )
      const filled = await f.service.execute(
        { operation: 'fill', target: '1', document_id: '1', source: 'public-key' },
        new AbortController().signal,
      )
      expect(f.browser.act).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: saved.publicKey }),
      )
      expect(JSON.stringify(filled)).not.toContain(saved.publicKey)
      await f.service.pauseAgent()
    },
  )
  it('does not fill after stopping while local parameters are being read', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    vi.mocked(f.browser.act).mockResolvedValueOnce({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    f.page.controls = [{ target: '1', label: 'Description', kind: 'input', sensitive: false }]
    let finish!: (value: Awaited<ReturnType<typeof f.parameters.read>>) => void
    f.parameters.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    vi.mocked(f.browser.act).mockClear()
    const pending = f.service.execute(
      { operation: 'fill', document_id: '1', target: '1', source: 'public-key' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(typeof finish).toBe('function'))
    await f.service.pauseAgent()
    finish({
      applicationId: saved.applicationId,
      publicKey: saved.publicKey,
      databaseId: '12345678-1234-5678-9abc-123456789abc',
      workerUrl: saved.workerBaseUrl,
    })
    await expect(pending).rejects.toThrow('代理任务已停止')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('blocks unapproved/secret fill and untrusted destinations while allowing the authorized sites', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.page.controls = [{ target: '1', label: 'Description', kind: 'input', sensitive: false }]
    const execute = (args: Record<string, string>) =>
      f.service.execute({ document_id: '1', target: '1', ...args }, new AbortController().signal)
    await expect(execute({ operation: 'fill', value: 'text', field: 'app-name' })).rejects.toThrow(
      '一个来源',
    )
    await expect(execute({ operation: 'fill', value: 'sk-proj-EXAMPLE' })).rejects.toThrow(
      '非秘密文本',
    )
    f.page.controls[0]!.sensitive = true
    await expect(execute({ operation: 'fill', value: 'text' })).rejects.toThrow('非秘密输入框')
    f.page.controls[0]!.sensitive = false
    await execute({ operation: 'navigate', url: 'https://github.com/test-user/repo' })
    await execute({ operation: 'navigate', url: 'https://preview-abc.bridge.account.workers.dev/' })
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'navigate',
        url: 'https://preview-abc.bridge.account.workers.dev/',
      }),
    )
    f.page.url = 'https://preview-abc.bridge.account.workers.dev/'
    await execute({ operation: 'navigate', url: 'https://dash.cloudflare.com/account/workers' })
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'navigate',
        url: 'https://dash.cloudflare.com/account/workers',
      }),
    )
    f.page.url = 'https://discord.com/developers/applications'
    await expect(
      execute({
        operation: 'navigate',
        url: 'https://user:pass@discord.com/developers/applications',
      }),
    ).rejects.toThrow('已授权')
    await execute({ operation: 'navigate', url: '/developers/applications' })
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'navigate',
        url: 'https://discord.com/developers/applications',
      }),
    )
    await f.service.pauseAgent()
    await expect(execute({ operation: 'fill', value: 'text' })).rejects.toThrow('确认代理权限')
  })
  it('navigates with current metadata even when the model supplies an old document number', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.page.documentId = 3
    f.page.url = 'https://dash.cloudflare.com/example-account/workers-and-pages/create'
    await f.service.execute(
      { operation: 'navigate', document_id: '2', url: '/example-account/workers-and-pages' },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenLastCalledWith({
      documentId: 3,
      operation: 'navigate',
      url: 'https://dash.cloudflare.com/example-account/workers-and-pages',
    })
    await f.service.execute(
      { operation: 'navigate', url: '/example-account/workers-and-pages/create' },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 3 }))
    await expect(
      f.service.execute(
        { operation: 'click', document_id: '2', target: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('网页已变化')
  })
  it('tells the model an unmatched search is not a blank page and keeps the real headings', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.page.url = 'https://dash.cloudflare.com/example-account/workers-and-pages/create'
    f.page.controls = []
    f.page.headings = ['Make something new']
    f.page.searchMatched = false
    const receipt = await f.service.execute(
      { operation: 'inspect', query: 'worker list deployments' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ searchMatched: false, headings: ['Make something new'] })
    expect(receipt.hint).toContain('不代表网页空白')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it.each([
    [
      'public',
      'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/home?code=PRIVATE_SECRET',
      '/' + 'a'.repeat(32) + '/home',
    ],
    ['authentication', 'https://github.com/login?code=PRIVATE_SECRET', '/login'],
    [
      'protected',
      'https://discord.com/developers/applications/1234567890123456789/bot',
      '/developers/applications/1234567890123456789/bot',
    ],
  ])(
    'reports the actual paused %s page without guessing an old authorization page',
    async (access, url, path) => {
      const f = fixture()
      await f.service.start('configure', undefined, 'agent')
      Object.assign(f.page, { paused: true, url, pageAccess: access })
      const receipt = await f.service.execute(
        { operation: 'inspect' },
        new AbortController().signal,
      )
      expect(receipt).toMatchObject({
        waitingForUser: true,
        browserPage: {
          host: new URL(url).hostname,
          path,
          access,
          state: 'paused',
          document_id: '1',
        },
      })
      expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SECRET')
      expect(f.browser.act).not.toHaveBeenCalled()
      if (access === 'public') expect(receipt.hint).toContain('不代表登录或授权未完成')
    },
  )
  it.each([false, true])(
    'handles unavailable location and connection failure %s without inventing authorization',
    async (failed) => {
      const f = fixture()
      await f.service.start('configure', undefined, 'agent')
      Object.assign(f.page, { paused: true, url: '', failed })
      const receipt = await f.service.execute(
        { operation: 'inspect' },
        new AbortController().signal,
      )
      expect(receipt).toMatchObject({
        waitingForUser: true,
        browserPage: {
          host: '',
          path: '/',
          access: 'unknown',
          state: failed ? 'connection-error' : 'paused',
        },
      })
      expect(receipt.hint).toContain(failed ? '当前网页连接失败' : '不代表登录或授权未完成')
      expect(f.browser.act).not.toHaveBeenCalled()
    },
  )
  it('exposes content search and application-list evidence through the original assistant tool', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'discord-app', startedAt: 1 })
    f.page.url = 'https://discord.com/developers/applications'
    f.page.pageKind = 'discord-app-list'
    f.page.applicationList = { state: 'empty', count: 0 }
    f.page.truncated = false
    f.page.controls = [
      { target: '1', label: 'New Application', kind: 'button', sensitive: false, visible: false },
    ]
    const receipt = await f.service.execute(
      { operation: 'inspect', query: '  New Application  ' },
      new AbortController().signal,
    )
    expect(f.browser.inspect).toHaveBeenCalledWith({
      metadataOnly: false,
      query: 'New Application',
    })
    expect(receipt).toMatchObject({
      applicationList: { state: 'empty', count: 0 },
      controls: [{ visible: false }],
      truncated: false,
    })
    expect(f.browser.act).not.toHaveBeenCalled()
    const tool = getAssistantRequestTools({
      canConfigureDiscordBrowser: true,
      mode: 'auto',
    } as Parameters<typeof getAssistantRequestTools>[0]).find(
      (item) => item.name === 'configure_discord_browser',
    )!
    expect(tool.parameters.properties).toHaveProperty('query')
    expect(tool.parameters.properties).toHaveProperty('direction')
    expect(tool.description).toContain('available默认复用')
    expect(tool.description).toContain('unknown不等于没有App')
    expect(tool.description).toContain('focus')
  })
  it('forwards focus and upward scrolling with document binding, rejecting stale targets and invalid directions', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'discord-app', startedAt: 1 })
    const execute = (args: Record<string, string>) =>
      f.service.execute(args, new AbortController().signal)
    await execute({ operation: 'focus', target: '1', document_id: '1' })
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'focus', target: '1', documentId: 1 }),
    )
    await execute({ operation: 'scroll', direction: 'up', document_id: '1' })
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'scroll', direction: 'up' }),
    )
    await expect(execute({ operation: 'focus', target: '1', document_id: '0' })).rejects.toThrow(
      '网页已变化',
    )
    await expect(
      execute({ operation: 'scroll', direction: 'left', document_id: '1' }),
    ).rejects.toThrow('滚动方向')
    expect(f.browser.act).toHaveBeenCalledTimes(2)
  })
  it('rejects credentials and invalid searches before reading the native page', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'discord-app', startedAt: 1 })
    for (const query of [
      'sk-' + 'a'.repeat(64),
      'a'.repeat(24) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(28),
      'a'.repeat(81),
      'name\nvalue',
    ])
      await expect(
        f.service.execute({ operation: 'inspect', query }, new AbortController().signal),
      ).rejects.toThrow('搜索')
    expect(f.browser.inspect).not.toHaveBeenCalled()
  })
  it.each(['', '/tree/main'])(
    'runs configuration through the actual Fork page %s and stops only for installation authorization',
    async (forkPath) => {
      const f = fixture()
      const oldWorker = saved.workerBaseUrl
      const nextWorker = 'https://fresh-worker.account.workers.dev'
      const card: DiscordSetupParameters = {}
      f.parameters.save.mockImplementation(async (values) => {
        Object.assign(card, values)
        return 'parameter-card'
      })
      f.parameters.read.mockImplementation(async () => ({ ...card }))
      await f.service.start('configure', undefined, 'agent')
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                applicationId: saved.applicationId,
                database: true,
                discordConfigured: true,
                applicationIdMatches: true,
                publicKeyMatches: true,
                commandRegistered: true,
              }),
            ),
        ),
      )
      vi.mocked(f.browser.act).mockImplementation(async (options) => {
        if (options.operation === 'collect-config')
          return {
            ok: true,
            parameters:
              options.step === 'discord-app'
                ? { applicationId: saved.applicationId, publicKey: saved.publicKey }
                : { databaseId: '12345678-1234-5678-9abc-123456789abc' },
          }
        if (options.operation === 'collect-worker') return { ok: true, workerUrl: nextWorker }
        if (options.operation === 'verify-step')
          return { ok: true, verified: true, revision: 'a'.repeat(40) }
        return { ok: true, formatOnly: true }
      })
      const advance = (from: string, operation = 'advance-step') =>
        f.service.execute(
          { operation, from, document_id: String(f.page.documentId), target: '1' },
          new AbortController().signal,
        )
      await advance('discord-app')
      expect(f.stored()?.step).toBe('discord-token')
      f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/bot`
      f.emit({ action: 'resume' })
      await vi.waitFor(() => expect(f.stored()?.step).toBe('d1-create'))
      f.page.url = 'https://dash.cloudflare.com/account/d1/database/detail'
      await advance('d1-create')
      await advance('d1-uuid')
      f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge' + forkPath
      f.page.forkOfTarget = true
      await advance('github-fork')
      f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc'
      await advance('wrangler-edit')
      await advance('wrangler-check')
      f.page.url = f.page.url.replace('/edit/', '/blob/')
      await advance('github-save')
      f.page.url =
        'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production'
      await advance('cf-deploy')
      expect(f.stored()?.githubRevision).toBe('a'.repeat(40))
      const productionProof = vi
        .mocked(f.browser.act)
        .mock.calls.find(
          ([options]) => options.operation === 'verify-step' && options.step === 'cf-deploy',
        )![0]
      expect(productionProof).toMatchObject({
        expectedFork: 'test-user/SRL-Discord-Bridge',
        expectedRevision: 'a'.repeat(40),
      })
      expect(saved.workerBaseUrl).toBe(oldWorker)
      expect(f.stored()?.workerUrl).toBe(nextWorker)
      await expect(advance('cf-secret')).rejects.toThrow('填写秘密')
      f.page.secretStage = 'submitted'
      f.page.paused = true
      await advance('cf-secret')
      f.page.paused = false
      await advance('worker-url')
      expect(saved.workerBaseUrl).toBe(oldWorker)
      f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/information`
      await advance('discord-endpoint')
      f.page.url = f.page.url.replace('/information', '/installation')
      await expect(advance('discord-install')).rejects.toThrow('授权由用户完成')
      f.emit({ action: 'resume' })
      await f.service.execute({ operation: 'status' }, new AbortController().signal)
      const saveForm = vi.fn(async () => {
        const draft = await f.service.localConnectionDraft()
        return !!(await f.service.saveLocalConnectionSettings({
          ...saved,
          applicationId: draft!.applicationId!,
          publicKey: draft!.publicKey!,
          workerBaseUrl: draft!.workerUrl!,
        }))
      })
      const detach = f.service.attachLocalForm(saveForm)
      expect(saved.workerBaseUrl).toBe(oldWorker)
      await advance('local-settings')
      expect(saved.workerBaseUrl).toBe(nextWorker)
      expect(saveForm).toHaveBeenCalledOnce()
      detach()
      await advance('register', 'verify-local')
      const result = await advance('verify', 'verify-local')
      expect(result).toMatchObject({ ok: true, verified: true, step: 'done' })
      expect(JSON.stringify(result)).not.toContain(saved.botToken)
      expect(f.browser.confirmSuccess).not.toHaveBeenCalled()
      expect(saved.commandRegistered).toBe(true)
    },
  )
  it('rejects a stale step or unproven success without advancing', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-endpoint',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
    })
    await f.service.resume()
    await expect(
      f.service.execute(
        { operation: 'advance-step', from: 'cf-deploy', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('步骤已变化')
    vi.mocked(f.browser.act).mockResolvedValue({ ok: true, dispatched: true, verified: false })
    await expect(
      f.service.execute(
        { operation: 'advance-step', from: 'discord-endpoint', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('成功证据')
    expect(f.stored()?.step).toBe('discord-endpoint')
  })
  it.each(['click', 'inspect'])(
    'continues after new %s progress but never duplicate observations or a paused run',
    async (operation) => {
      const f = fixture({ task: 'configure', step: 'discord-app', mode: 'agent', startedAt: 1 })
      await f.service.resume()
      const runId = f.service.agentRunId()
      const cursor = f.service.progressCursor()
      await f.service.continueAfterProgress(runId, cursor)
      expect(f.service.takeAssistantRequest()).toBeUndefined()
      f.page.controls = [{ target: '1', label: 'My App', kind: 'button', sensitive: false }]
      vi.mocked(f.browser.act).mockResolvedValue({ ok: true, dispatched: true })
      await f.service.execute(
        { operation, target: '1', document_id: '1' },
        new AbortController().signal,
      )
      await f.service.continueAfterProgress(runId, cursor)
      expect(f.service.takeAssistantRequest()).toContain('新进展')
      const newerCursor = f.service.progressCursor()
      // Native inspection renumbers controls; the same semantic action is still a repeat.
      f.page.controls = [{ target: '101', label: 'My App', kind: 'button', sensitive: false }]
      await f.service.execute(
        { operation, target: '101', document_id: '1' },
        new AbortController().signal,
      )
      await f.service.continueAfterProgress(runId, newerCursor)
      expect(f.service.takeAssistantRequest()).toBeUndefined()
      await f.service.pauseAgent()
      await f.service.continueAfterProgress(runId, cursor)
      expect(f.service.takeAssistantRequest()).toBeUndefined()
    },
  )
  it('continues after the final Worker page changes even without another model inspect', async () => {
    const f = fixture({ task: 'configure', step: 'cf-deploy', mode: 'agent', startedAt: 1 })
    await f.service.resume()
    f.page.url = 'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/workers-and-pages/create'
    f.page.headings = ['Create application']
    await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    const cursor = f.service.progressCursor()
    f.page.url = 'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/workers/new'
    f.page.headings = ['Create Worker']
    await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
    expect(f.service.takeAssistantRequest()).toContain('新进展')
    const receipt = await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    expect(receipt).toMatchObject({ browserPage: { path: '/' + 'a'.repeat(32) + '/workers/new' } })
    const newer = f.service.progressCursor()
    await f.service.continueAfterProgress(f.service.agentRunId(), newer)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    await f.service.pauseAgent()
  })
  it('ignores a final inspection arriving after the user pauses', async () => {
    const f = fixture({ task: 'configure', step: 'cf-deploy', mode: 'agent', startedAt: 1 })
    await f.service.resume()
    await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    const run = f.service.agentRunId()
    const cursor = f.service.progressCursor()
    let finish!: (page: DiscordBrowserSnapshot) => void
    vi.mocked(f.browser.inspect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const continuing = f.service.continueAfterProgress(run, cursor)
    await f.service.pauseAgent()
    finish({
      ...f.page,
      url: 'https://dash.cloudflare.com/account/workers/new',
      headings: ['Create Worker'],
    })
    await continuing
    expect(f.service.progressCursor()).toBe(cursor)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('reports a genuine tool limit from the executor separately from an idle model turn', async () => {
    const f = fixture({ task: 'configure', step: 'cf-deploy', mode: 'agent', startedAt: 1 })
    await f.service.resume()
    await f.service.settleAssistantTurn(f.service.agentRunId(), false, true)
    expect(f.browser.message).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: expect.stringContaining('你设置的工具上限') }),
    )
    expect(discordSetupSession.agentRunning).toBe(false)
  })
  it('aborts a local network check on task stop and discards a late response', async () => {
    const f = fixture({
      task: 'update-worker',
      step: 'verify',
      mode: 'agent',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
    })
    await f.service.resume()
    let complete: ((value: Response) => void) | undefined
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        requestSignal = options.signal
        return new Promise<Response>((resolve) => {
          complete = resolve
        })
      }),
    )
    const result = f.service.execute(
      { operation: 'verify-local', from: 'verify' },
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const rejected = expect(result).rejects.toThrow()
    f.emit({ action: 'agent-pause' })
    await vi.waitFor(() => expect(f.browser.pauseAgent).toHaveBeenCalled())
    expect(requestSignal!.aborted).toBe(true)
    complete!(new Response(JSON.stringify({ applicationId: saved.applicationId, database: true })))
    await rejected
    expect(saved.workerVerifiedAt).toBe(0)
    expect(f.stored()?.step).toBe('verify')
    expect(discordSetupSession.agentRunning).toBe(false)
  })
  it('starts a cancellable agent task and ignores public-page callbacks after manual handoff', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    const run = taskCenter.active().at(0)!
    expect(run.name).toContain('Discord')
    expect(vi.mocked(f.browser.open).mock.calls.at(-1)![0].agentRunId).toBe(run.operationId)
    f.emit({ action: 'visibility', visible: true })
    f.emit({ action: 'agent-pause' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.browser.pauseAgent).toHaveBeenCalledOnce()
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(taskCenter.list().find((item) => item.operationId === run.operationId)?.status).toBe(
      'cancelled',
    )
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    await f.service.resume()
    expect(discordSetupSession.agentRunning).toBe(true)
    f.emit({ action: 'page-ready' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toContain('inspect')
    await f.service.pauseAgent()
  })
  it.each([
    ['authentication', '等待你完成当前网页登录或验证'],
    ['protected', '等待你完成秘密操作'],
    ['external', '当前外部网页未开放代理操作，请返回配置页面'],
    ['public', '网页协助已暂停，请点桌宠查看或继续'],
  ] as const)(
    'reports the actual paused %s page without inventing authorization',
    async (access, phase) => {
      const f = fixture()
      await f.service.start('configure', 'cf-deploy', 'agent')
      f.service.takeAssistantRequest()
      f.page.paused = true
      f.page.pageAccess = access
      f.emit({ action: 'page-ready' })
      await vi.waitFor(() =>
        expect(
          taskCenter.list().find((task) => task.operationId === f.service.agentRunId())?.phase,
        ).toBe(phase),
      )
      expect(f.service.takeAssistantRequest()).toBeUndefined()
      await f.service.pauseAgent()
    },
  )
  it('uses one native page-load wait and cancels it on an aborted tool call', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'discord-app', startedAt: 1 })
    const controller = new AbortController()
    let finish!: (value: DiscordBrowserSnapshot) => void
    vi.mocked(f.browser.waitReady).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const waiting = f.service.execute({ operation: 'wait-page' }, controller.signal)
    await vi.waitFor(() => expect(f.browser.waitReady).toHaveBeenCalledOnce())
    controller.abort()
    expect(f.browser.cancelWait).toHaveBeenCalledOnce()
    finish({ ...f.page })
    await expect(waiting).rejects.toThrow()
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('cancels a deployment status wait immediately when the user stops the agent', async () => {
    const f = fixture()
    await f.service.start('configure', 'cf-deploy', 'agent')
    let finish!: (value: DiscordBrowserSnapshot) => void
    vi.mocked(f.browser.waitStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const waiting = f.service.execute(
      { operation: 'wait-status', document_id: '1', target: '1' },
      new AbortController().signal,
    )
    await vi.waitFor(() =>
      expect(f.browser.waitStatus).toHaveBeenCalledWith({ documentId: 1, target: '1' }),
    )
    f.emit({ action: 'agent-pause' })
    await vi.waitFor(() => expect(f.browser.cancelWait).toHaveBeenCalledOnce())
    finish({ ...f.page, paused: true })
    await expect(waiting).rejects.toThrow()
    expect(discordSetupSession.agentRunning).toBe(false)
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('does not let an old generation or a delayed pause acknowledgement cancel a resumed agent run', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    const old = f.service.agentRunId()!
    let finish!: () => void
    vi.mocked(f.browser.pauseAgent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const stopping = f.service.pauseAgent(old)
    await f.service.resume()
    const resumed = f.service.agentRunId()!
    expect(resumed).not.toBe(old)
    finish()
    await stopping
    await f.service.pauseAgent(old)
    expect(discordSetupSession.agentRunning).toBe(true)
    expect(taskCenter.list().find((item) => item.operationId === resumed)?.status).toBe('running')
    await f.service.pauseAgent(resumed)
  })
  it('opens the original full assistant and transfers only a draft, without resetting or generating', async () => {
    const f = fixture({ task: 'configure', mode: 'agent', step: 'wrangler-edit', startedAt: 1 })
    await f.service.current()
    const navigate = vi.fn()
    window.addEventListener('srl:native-deep-link', navigate)
    try {
      f.emit({ action: 'fullscreen', text: '这里卡住了' })
      await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
      expect(navigate.mock.calls[0]![0].detail).toEqual({ kind: 'assistant' })
      expect(f.browser.close).toHaveBeenCalledOnce()
      expect(f.browser.close).toHaveBeenCalledWith({ keepRunning: true })
      expect(f.service.takeAssistantDraft()).toBe('这里卡住了')
      expect(f.service.takeAssistantDraft()).toBeUndefined()
      expect(f.service.takeAssistantRequest()).toBeUndefined()
      expect(f.storage.save).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('srl:native-deep-link', navigate)
    }
  })
  it('does not transfer pasted configuration values to the full chat', async () => {
    const f = fixture()
    await f.service.current()
    f.emit({ action: 'fullscreen', text: 'sk-' + 'a'.repeat(64) })
    await vi.waitFor(() => expect(f.browser.message).toHaveBeenCalled())
    expect(f.browser.close).not.toHaveBeenCalled()
    expect(f.service.takeAssistantDraft()).toBeUndefined()
  })
  it.each([
    'discord-app',
    'discord-token',
    'd1-create',
    'd1-uuid',
    'github-fork',
    'wrangler-edit',
    'wrangler-check',
    'github-save',
    'cf-deploy',
    'cf-secret',
    'worker-url',
    'discord-endpoint',
    'discord-install',
    'local-settings',
    'register',
    'verify',
  ] as const)('allows actual public navigation controls during %s', async (step) => {
    const f = fixture({ task: 'configure', mode: 'agent', step, startedAt: 1 })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/bridge/settings'
    f.page.controls = [
      { target: '1', label: 'Variables and secrets', kind: 'tab', sensitive: false },
    ]
    vi.mocked(f.browser.act).mockResolvedValue({ ok: true, dispatched: true })
    await f.service.resume()
    const receipt = await f.service.execute(
      { operation: 'click', target: '1', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: true, dispatched: true })
    expect(f.stored()?.step).toBe(step)
    await f.service.pauseAgent()
  })
  it('continues independently after Secret locator failure and passes selected form handles for a renamed Worker', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://renamed-bridge.account.workers.dev',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/renamed-bridge/settings/variables'
    f.page.secretStage = 'prepare'
    await f.service.resume()
    f.service.takeAssistantRequest()
    vi.mocked(f.browser.act).mockResolvedValue({ ok: false })
    const failed = await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(failed).toMatchObject({ ok: false, recovery: true, waitingForUser: false })
    f.emit({ action: 'secret-prepare' })
    await vi.waitFor(() => expect(f.service.takeAssistantRequest()).toContain('自主定位'))
    f.page.controls = [{ target: '7', label: 'Add a secret', kind: 'button', sensitive: false }]
    expect(
      await f.service.execute({ operation: 'inspect', query: 'Add' }, new AbortController().signal),
    ).toMatchObject({ controls: f.page.controls, secretStage: 'prepare', waitingForUser: false })
    expect(f.browser.inspect).toHaveBeenCalledWith({ metadataOnly: false, query: 'Add' })
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      dispatched: true,
      secretStage: 'prepare',
    })
    await f.service.execute(
      {
        operation: 'prepare-secret',
        document_id: '1',
        secret_name_target: '11',
        secret_type_target: '12',
        secret_value_target: '13',
      },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        secretNameTarget: '11',
        secretTypeTarget: '12',
        secretValueTarget: '13',
      }),
    )
    f.page.url = f.page.url.replace('renamed-bridge', 'another-worker')
    await expect(
      f.service.execute(
        { operation: 'prepare-secret', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('其他 Worker')
    await f.service.pauseAgent()
  })
  it('continues from successful preparation to blind transfer, but stops for manual Secret entry', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://bridge.account.workers.dev',
      botTokenReady: 'encrypted',
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/bridge/settings'
    f.page.secretStage = 'prepare'
    await f.service.resume()
    f.service.takeAssistantRequest()
    const cursor = f.service.progressCursor()
    vi.mocked(f.browser.act).mockImplementation(async () => {
      f.page.secretStage = 'input'
      f.page.paused = true
      return { ok: true, secretStage: 'input', waitingForUser: true }
    })
    expect(
      await f.service.execute(
        { operation: 'prepare-secret', document_id: '1' },
        new AbortController().signal,
      ),
    ).toMatchObject({ waitingForUser: false })
    await f.service.continueAfterProgress(f.service.agentRunId(), cursor)
    expect(f.service.takeAssistantRequest()).toContain('新进展')
    await f.service.pauseAgent()
    const manual = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://bridge.account.workers.dev',
    })
    manual.page.url = f.page.url
    manual.page.secretStage = 'input'
    manual.page.paused = true
    await manual.service.resume()
    manual.service.takeAssistantRequest()
    await manual.service.continueAfterProgress(manual.service.agentRunId(), 0)
    expect(manual.service.takeAssistantRequest()).toBeUndefined()
    await manual.service.pauseAgent()
  })
  it('reuses the verified task root after Secret without requiring the settings page to repeat its address', async () => {
    const root = 'https://bridge.account.workers.dev'
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'worker-url',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: root,
      workerConfirmedAt: 2,
      parameterResourceId: 'parameter-card',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/bridge/settings/variables'
    f.parameters.read.mockResolvedValue({
      applicationId: saved.applicationId,
      publicKey: saved.publicKey,
      workerUrl: root,
    })
    vi.mocked(f.browser.act).mockRejectedValue(new Error('This settings page has no Worker URL'))
    await f.service.resume()
    await f.service.execute(
      { operation: 'advance-step', from: 'worker-url', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.stored()?.step).toBe('discord-endpoint')
    expect(f.browser.act).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('counts distinct preparation actions but not a repeated action, and recognizes actual password verification', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://bridge.account.workers.dev',
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/bridge/settings'
    f.page.secretStage = 'prepare'
    await f.service.resume()
    f.service.takeAssistantRequest()
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      dispatched: true,
      secretStage: 'prepare',
      preparedAction: 'add',
    })
    await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    const first = f.service.progressCursor()
    await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.service.progressCursor()).toBe(first)
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      dispatched: true,
      secretStage: 'prepare',
      preparedAction: 'type',
    })
    await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.service.progressCursor()).toBeGreaterThan(first)
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: false,
      pageAccess: 'authentication',
      waitingForUser: true,
    })
    expect(
      await f.service.execute(
        { operation: 'prepare-secret', document_id: '1' },
        new AbortController().signal,
      ),
    ).toMatchObject({ waitingForUser: true })
    await f.service.pauseAgent()
  })
  it.each(['submit', 'saved'] as const)(
    'allows public browser actions during Secret %s without a layout handoff',
    async (stage) => {
      const f = fixture({
        task: 'configure',
        mode: 'agent',
        step: 'cf-secret',
        startedAt: 1,
        workerUrl: 'https://srl-discord-source-bridge.account.workers.dev',
      })
      await f.service.resume()
      f.page.url =
        'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings'
      f.page.secretStage = stage
      f.page.paused = true
      f.page.controls = [
        { target: 'public-menu', label: 'More options', kind: 'button', sensitive: false },
      ]
      vi.mocked(f.browser.act).mockResolvedValue({ ok: true, dispatched: true })
      for (const operation of ['focus', 'scroll', 'click']) {
        expect(
          await f.service.execute(
            { operation, document_id: '1', target: 'public-menu' },
            new AbortController().signal,
          ),
        ).toMatchObject({ ok: true })
      }
      expect(f.browser.act).toHaveBeenCalledTimes(3)
      await f.service.pauseAgent()
      await expect(
        f.service.execute(
          { operation: 'click', document_id: '1', target: 'public-menu' },
          new AbortController().signal,
        ),
      ).rejects.toThrow()
      expect(f.browser.act).toHaveBeenCalledTimes(3)
    },
  )
  it('keeps Secret inspection metadata-only and rejects general controls or premature submission', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://srl-discord-source-bridge.account.workers.dev',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings'
    f.page.paused = true
    f.page.secretStage = 'input'
    const receipt = await f.service.execute({ operation: 'inspect' }, new AbortController().signal)
    expect(receipt).not.toHaveProperty('controls')
    expect(receipt.waitingForUser).toBe(true)
    expect(f.browser.inspect).toHaveBeenCalledExactlyOnceWith({ metadataOnly: true })
    await expect(
      f.service.execute(
        { operation: 'click', document_id: '1', target: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('输入阶段')
    await expect(
      f.service.execute(
        { operation: 'submit-secret', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('授权保存部署')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('stops at Secret input and after submission without resetting or auto advancing', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://srl-discord-source-bridge.account.workers.dev',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings'
    f.page.secretStage = 'prepare'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      secretStage: 'input',
      waitingForUser: true,
      value: 'INJECTED_SHOULD_NOT_LEAVE_NATIVE',
    })
    const receipt = await f.service.execute(
      { operation: 'prepare-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ secretStage: 'input', waitingForUser: true })
    expect(JSON.stringify(receipt)).not.toContain('INJECTED')
    f.page.secretStage = 'submit'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      secretStage: 'submitted',
      dispatched: true,
      waitingForUser: true,
    })
    f.emit({ action: 'secret-submit' })
    await vi.waitFor(() => expect(f.browser.act).toHaveBeenCalledTimes(2))
    expect(f.stored()?.step).toBe('cf-secret')
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('recovers a saved Secret from fresh public evidence and health instead of resubmitting a closed form', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/example/production/settings'
    await f.service.resume()
    f.page.secretStage = 'submit'
    vi.mocked(f.browser.inspect).mockImplementation(async (options) => ({
      ...f.page,
      secretSavedOnPage: options?.metadataOnly === false,
    }))
    const health = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            applicationId: saved.applicationId,
            database: true,
            discordConfigured: true,
            applicationIdMatches: true,
            publicKeyMatches: true,
            commandRegistered: true,
          }),
        ),
    )
    vi.stubGlobal('fetch', health)
    const result = await f.service.execute(
      { operation: 'advance-step', from: 'cf-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: true, verified: true, step: 'worker-url' })
    expect(health).toHaveBeenCalledOnce()
    expect(f.browser.act).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('keeps the actual Secret failure reason rather than renaming every failure missing-button', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: saved.workerBaseUrl,
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/example/production/settings'
    f.page.secretStage = 'submit'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: false,
      errors: ['当前待提交 Secret 表单已关闭；请核验列表结果'],
    })
    const result = await f.service.execute(
      { operation: 'submit-secret', document_id: '1' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      ok: false,
      recovery: true,
      waitingForUser: false,
      errors: ['当前待提交 Secret 表单已关闭；请核验列表结果'],
    })
    expect(result.hint).toContain('表单已关闭')
    expect(result.hint).not.toContain('未定位到保存部署按钮')
  })
  it('observes an already saved Secret before the automatic prepare event so it does not reopen the editor', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: saved.workerBaseUrl,
    })
    await f.service.resume()
    f.service.takeAssistantRequest()
    f.page.secretStage = 'prepare'
    Object.assign(f.page, { secretSavedOnPage: true })
    f.emit({ action: 'secret-prepare' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toContain('列表已有')
    await f.service.pauseAgent()
  })
  it.each([200, 403])(
    'checks the opaque locally stored token when recovering a saved Secret (%s)',
    async (status) => {
      const f = fixture({
        task: 'configure',
        mode: 'agent',
        step: 'cf-secret',
        startedAt: 1,
        applicationId: saved.applicationId,
        workerUrl: saved.workerBaseUrl,
        parameterResourceId: 'parameter-card',
        botTokenReady: 'encrypted',
      })
      f.page.url =
        'https://dash.cloudflare.com/account/workers/services/view/example/production/settings'
      await f.service.resume()
      f.page.secretStage = 'submit'
      Object.assign(f.page, { secretSavedOnPage: true })
      const fetcher = vi.fn(
        async (url: unknown) =>
          new Response(
            JSON.stringify({
              applicationId: saved.applicationId,
              database: true,
              discordConfigured: true,
              applicationIdMatches: true,
              publicKeyMatches: true,
              commandRegistered: false,
            }),
            { status: String(url).endsWith('/health') ? 200 : status },
          ),
      )
      vi.stubGlobal('fetch', fetcher)
      const operation = () =>
        f.service.execute(
          { operation: 'advance-step', from: 'cf-secret', document_id: '1' },
          new AbortController().signal,
        )
      if (status === 200) {
        const result = await operation()
        expect(result).toMatchObject({ ok: true, step: 'worker-url' })
        expect(JSON.stringify(result)).not.toContain(saved.botToken)
      } else {
        await expect(operation()).rejects.toThrow('HTTP 403')
        expect(f.stored()?.step).toBe('cf-secret')
      }
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(f.browser.act).not.toHaveBeenCalled()
      await f.service.pauseAgent()
    },
  )
  it('does not tell the assistant Save was dispatched when blind filling succeeded but submitting failed', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
    })
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/example/production/settings'
    await f.service.resume()
    f.service.takeAssistantRequest()
    f.page.secretStage = 'prepare'
    vi.mocked(f.browser.act).mockImplementation(async (options) => {
      if (options.operation === 'prepare-secret') {
        f.page.secretStage = 'input'
        return { ok: true, secretStage: 'input' }
      }
      return { ok: false, errors: ['当前保存部署按钮未确认'] }
    })
    f.browser.fillBotSecret = vi.fn(async () => {
      f.page.secretStage = 'submit'
      return { ok: true }
    })
    f.emit({ action: 'secret-prepare' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    const request = f.service.takeAssistantRequest()
    expect(request).toContain('尚未取得保存部署确认')
    expect(request).not.toContain('已取得 Secret 保存部署回执')
    await f.service.pauseAgent()
  })
  it.each(['wrong-worker', 'unhealthy', 'authentication'] as const)(
    'does not accept saved Secret evidence from %s as task completion',
    async (kind) => {
      const f = fixture({
        task: 'configure',
        mode: 'agent',
        step: 'cf-secret',
        startedAt: 1,
        applicationId: saved.applicationId,
        workerUrl: saved.workerBaseUrl,
        parameterResourceId: 'parameter-card',
      })
      f.page.url = `https://dash.cloudflare.com/account/workers/services/view/${kind === 'wrong-worker' ? 'other' : 'example'}/production/settings`
      await f.service.resume()
      f.page.secretStage = 'submit'
      Object.assign(f.page, { secretSavedOnPage: true })
      const health = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              applicationId: saved.applicationId,
              database: true,
              discordConfigured: false,
              applicationIdMatches: true,
              publicKeyMatches: true,
            }),
          ),
      )
      vi.stubGlobal('fetch', health)
      if (kind === 'authentication') {
        f.page.pageAccess = 'authentication'
        expect(
          await f.service.execute(
            { operation: 'click', document_id: '1', target: '1' },
            new AbortController().signal,
          ),
        ).toMatchObject({ ok: false, waitingForUser: true })
        expect(f.browser.act).not.toHaveBeenCalled()
      } else {
        await expect(
          f.service.execute(
            { operation: 'advance-step', from: 'cf-secret', document_id: '1' },
            new AbortController().signal,
          ),
        ).rejects.toThrow()
        expect(health).toHaveBeenCalledTimes(kind === 'unhealthy' ? 1 : 0)
        expect(f.stored()?.step).toBe('cf-secret')
      }
      await f.service.pauseAgent()
    },
  )
  it('resumes production verification after explicit Secret submission without asking the user to check deployment', async () => {
    const f = fixture({
      task: 'configure',
      mode: 'agent',
      step: 'cf-secret',
      startedAt: 1,
      workerUrl: 'https://srl-discord-source-bridge.account.workers.dev',
    })
    await f.service.resume()
    f.page.url =
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings'
    f.page.secretStage = 'submit'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      secretStage: 'submitted',
      dispatched: true,
      waitingForUser: true,
    })
    f.emit({ action: 'secret-submit' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.service.takeAssistantRequest()).toContain('advance-step')
    expect(f.stored()?.step).toBe('cf-secret')
    expect(f.browser.confirmSuccess).not.toHaveBeenCalled()
    await f.service.pauseAgent()
  })
  it('does not advance when the Worker was filled locally but not saved in the parameter card', async () => {
    const f = fixture({
      task: 'configure',
      step: 'worker-url',
      startedAt: 1,
      mode: 'agent',
      parameterResourceId: 'parameter-card',
      workerUrl: 'https://new.account.workers.dev',
      workerConfirmedAt: 2,
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/test/production'
    await expect(f.service.next()).rejects.toThrow('尚未保存')
    expect(f.stored()?.step).toBe('worker-url')
  })
  it('economy guidance does not request AI or allow model browser control', async () => {
    const f = fixture({ task: 'configure', step: 'discord-app', startedAt: 1, mode: 'economy' })
    await f.service.current()
    f.emit({ action: 'assist' })
    await vi.waitFor(() =>
      expect(f.browser.act).toHaveBeenCalledWith(expect.objectContaining({ operation: 'guide' })),
    )
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    for (const operation of ['inspect', 'collect-config', 'fill-config', 'click'])
      expect(
        await f.service.execute({ operation, document_id: '1' }, new AbortController().signal),
      ).toMatchObject({ ok: false, waitingForUser: true })
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(f.browser.inspect).toHaveBeenCalledExactlyOnceWith({ metadataOnly: true })
  })
  it('does not reset progress if agent password preparation fails', async () => {
    const f = fixture({ task: 'configure', step: 'd1-uuid', startedAt: 1, mode: 'economy' })
    f.parameters.prepare.mockRejectedValue(new Error('请先解锁'))
    await expect(f.service.restart('configure', 'agent')).rejects.toThrow('解锁')
    expect(f.stored()).toMatchObject({ step: 'd1-uuid', startedAt: 1, mode: 'economy' })
    expect(f.storage.save).not.toHaveBeenCalled()
  })
  it('captures only App/public-key parameters into a card and returns no values to AI', async () => {
    const f = fixture({ task: 'configure', step: 'discord-app', startedAt: 1, mode: 'agent' })
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: {
        applicationId: saved.applicationId,
        publicKey: saved.publicKey,
        botToken: 'INJECTED_SECRET',
      },
    })
    const receipt = await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.save).toHaveBeenCalledWith(
      { applicationId: saved.applicationId, publicKey: saved.publicKey },
      undefined,
    )
    expect(f.stored()?.parameterResourceId).toBe('parameter-card')
    for (const value of [saved.applicationId, saved.publicKey, 'INJECTED_SECRET'])
      expect(JSON.stringify(receipt)).not.toContain(value)
  })
  it('gives the model page kind and headings before it selects actual parameter fields', async () => {
    const f = fixture({ task: 'configure', step: 'discord-app', startedAt: 1, mode: 'agent' })
    f.page.pageKind = 'discord-app-information'
    f.page.headings = ['Client Identifier', 'Signature Verification Key']
    const observation = await f.service.execute(
      { operation: 'inspect' },
      new AbortController().signal,
    )
    expect(observation).toMatchObject({ pageKind: f.page.pageKind, headings: f.page.headings })
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      parameters: { applicationId: saved.applicationId, publicKey: saved.publicKey },
    })
    const receipt = await f.service.execute(
      {
        operation: 'collect-config',
        document_id: '1',
        application_id_target: '3',
        public_key_target: '7',
      },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'collect-config',
        applicationIdTarget: '3',
        publicKeyTarget: '7',
      }),
    )
    expect(f.parameters.save).toHaveBeenCalledOnce()
    expect(JSON.stringify(receipt)).not.toContain(saved.publicKey)
  })
  it('returns the field diagnosis and does not save or advance on a failed model-selected collection', async () => {
    const f = fixture({ task: 'configure', step: 'discord-app', startedAt: 1, mode: 'agent' })
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: false,
      errors: ['当前信息页没有识别到 Public Key 字段，请先核对页面。'],
    })
    await expect(
      f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Public Key')
    expect(f.parameters.save).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    expect(f.stored()?.step).toBe('discord-app')
  })
  it('writes the entire filled Wrangler with validation and never includes the Bot Token', async () => {
    const f = fixture({
      task: 'configure',
      step: 'wrangler-edit',
      startedAt: 1,
      mode: 'agent',
      parameterResourceId: 'parameter-card',
      applicationId: saved.applicationId,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc'
    const receipt = await f.service.execute(
      { operation: 'template', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: true, written: true, waitingForUser: true })
    const call = vi.mocked(f.browser.act).mock.calls.at(-1)![0]
    expect(call.validateTemplate).toBe(true)
    const template = JSON.parse(call.template!)
    expect(template.d1_databases[0].database_id).toBe('12345678-1234-5678-9abc-123456789abc')
    expect(template.vars.DISCORD_APPLICATION_ID).toBe(saved.applicationId)
    expect(template.vars.DISCORD_PUBLIC_KEY).toBe(saved.publicKey)
    expect(call.template).not.toContain(saved.botToken)
    expect(JSON.stringify(receipt)).not.toContain(saved.publicKey)
  })
  it('stages manual parameters without partially replacing the old connection', async () => {
    const before = { ...saved }
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      startedAt: 1,
      mode: 'agent',
      parameterResourceId: 'parameter-card',
      applicationId: saved.applicationId,
      workerUrl: 'https://new.account.workers.dev',
    })
    f.parameters.read.mockResolvedValue({
      applicationId: saved.applicationId,
      publicKey: 'b'.repeat(64),
      databaseId: '12345678-1234-5678-9abc-123456789abc',
      workerUrl: 'https://new.account.workers.dev',
    })
    await f.service.resume()
    expect(saved).toEqual(before)
    expect(await f.service.localConnectionDraft()).toMatchObject({
      publicKey: 'b'.repeat(64),
      workerUrl: 'https://new.account.workers.dev',
      needsToken: true,
    })
    expect(f.stored()?.step).toBe('local-settings')
  })
  it('does not replace the old connection when the new encrypted Token cannot be opened', async () => {
    const before = { ...saved }
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      startedAt: 1,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
      applicationId: saved.applicationId,
      workerUrl: 'https://new.account.workers.dev',
    })
    f.parameters.read.mockResolvedValue({
      applicationId: saved.applicationId,
      publicKey: 'b'.repeat(64),
      workerUrl: 'https://new.account.workers.dev',
    })
    f.parameters.useBotSecret.mockRejectedValue(new Error('新Token无法解锁'))
    vi.mocked(saveDiscordSourceConnectionSettings).mockClear()
    await expect(f.service.resume()).rejects.toThrow('新Token无法解锁')
    expect(saveDiscordSourceConnectionSettings).not.toHaveBeenCalled()
    expect(saved).toEqual(before)
    expect(f.stored()?.step).toBe('local-settings')
    await f.service.pauseAgent()
  })
  it('saves the new App, Worker and encrypted Token together after webpage configuration', async () => {
    const before = { ...saved }
    const nextId = '2234567890123456789'
    const nextUrl = 'https://new.account.workers.dev'
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      startedAt: 1,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'encrypted',
      applicationId: nextId,
      workerUrl: nextUrl,
    })
    f.parameters.read.mockResolvedValue({
      applicationId: nextId,
      publicKey: 'b'.repeat(64),
      workerUrl: nextUrl,
    })
    f.parameters.useBotSecret.mockImplementation(async (_id, consume) => {
      expect(saved).toEqual(before)
      await consume('NEW_TEST_SECRET_NOT_FOR_MODEL')
    })
    const saveSettings = vi.mocked(saveDiscordSourceConnectionSettings).mockClear()
    try {
      await f.service.resume()
      expect(saveSettings).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          applicationId: nextId,
          publicKey: 'b'.repeat(64),
          workerBaseUrl: nextUrl,
          botToken: 'NEW_TEST_SECRET_NOT_FOR_MODEL',
        }),
      )
      expect(f.stored()?.step).toBe('local-settings')
    } finally {
      Object.assign(saved, before)
      await f.service.pauseAgent()
    }
  })
  it('does not reuse the old App Token when the new App requires manual Token entry', async () => {
    const before = { ...saved }
    const nextId = '2234567890123456789'
    const nextUrl = 'https://new.account.workers.dev'
    const f = fixture({
      task: 'configure',
      step: 'local-settings',
      mode: 'agent',
      startedAt: 1,
      parameterResourceId: 'parameter-card',
      botTokenReady: 'manual',
      applicationId: nextId,
      workerUrl: nextUrl,
    })
    f.parameters.read.mockResolvedValue({
      applicationId: nextId,
      publicKey: 'b'.repeat(64),
      workerUrl: nextUrl,
    })
    try {
      await f.service.resume()
      expect(saved).toEqual(before)
      expect(await f.service.localConnectionDraft()).toMatchObject({
        applicationId: nextId,
        workerUrl: nextUrl,
        needsToken: true,
      })
      expect(f.stored()?.step).toBe('local-settings')
      expect(f.parameters.useBotSecret).not.toHaveBeenCalled()
      await expect(f.service.next()).rejects.toThrow('目标不一致')
      await expect(
        f.service.saveLocalConnectionSettings({
          ...before,
          applicationId: nextId,
          publicKey: 'b'.repeat(64),
          workerBaseUrl: nextUrl,
          botToken: '',
        }),
      ).rejects.toThrow('先填写本次 Bot Token')
      expect(saved).toEqual(before)
      f.parameters.backupConnection.mockImplementation(async () => {
        expect(saved).toEqual(before)
        return 'old-connection-card'
      })
      await f.service.saveLocalConnectionSettings({
        ...before,
        applicationId: nextId,
        publicKey: 'b'.repeat(64),
        workerBaseUrl: nextUrl,
        botToken: 'NEW_TEST_SECRET_NOT_FOR_MODEL',
      })
      expect(saved).toMatchObject({
        applicationId: nextId,
        workerBaseUrl: nextUrl,
        botToken: 'NEW_TEST_SECRET_NOT_FOR_MODEL',
      })
      expect(f.parameters.backupConnection).toHaveBeenCalledOnce()
    } finally {
      Object.assign(saved, before)
      await f.service.pauseAgent()
    }
  })
  it('preserves a saved step and refuses an accidental start from UI or model', async () => {
    const state: DiscordSetupState = {
      task: 'configure',
      step: 'wrangler-check',
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    }
    const f = fixture(state)
    await f.service.resume()
    expect(f.storage.save).not.toHaveBeenCalled()
    expect(f.stored()).toEqual(state)
    await expect(f.service.start('configure')).rejects.toThrow('已有未完成任务')
    await expect(
      f.service.execute({ operation: 'start', task: 'configure' }, new AbortController().signal),
    ).rejects.toThrow('已有未完成任务')
    expect(f.stored()).toEqual(state)
    await f.service.restart('configure')
    expect(f.stored()).toMatchObject({ step: 'discord-app', task: 'configure' })
    expect(f.stored()?.forkRepo).toBeUndefined()
    expect(f.stored()?.applicationId).toBeUndefined()
    expect(f.stored()?.workerUrl).toBeUndefined()
    expect(saved.botToken).toBe('TEST_SECRET_NOT_FOR_MODEL')
  })
  it.each([
    'github-sync',
    'github-save',
    'cf-deploy',
    'cf-secret',
    'discord-endpoint',
    'discord-install',
  ] as const)('does not accept clicks or page navigation alone as success at %s', async (step) => {
    const f = fixture({
      task: step === 'github-sync' ? 'update-worker' : 'configure',
      step,
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
      applicationId: saved.applicationId,
    })
    f.page.url = step.startsWith('github')
      ? `https://github.com/test-user/SRL-Discord-Bridge${step === 'github-save' ? '/blob/main/wrangler.jsonc' : ''}`
      : step.startsWith('cf')
        ? 'https://dash.cloudflare.com/account/workers/services/view/test/production'
        : `https://discord.com/developers/applications/${saved.applicationId}/installation`
    f.page.forkOfTarget = true
    vi.mocked(f.browser.confirmSuccess).mockResolvedValue({ confirmed: false })
    await expect(f.service.next()).rejects.toThrow('成功条件尚未确认')
    expect(f.stored()?.step).toBe(step)
    expect(f.browser.open).not.toHaveBeenCalled()
    expect(f.browser.confirmSuccess).toHaveBeenCalledWith({ documentId: 1, step })
  })
  it('requires return to the same App after installation, without reading OAuth forms', async () => {
    const f = fixture({
      task: 'update-commands-only',
      step: 'discord-install',
      startedAt: 1,
      applicationId: saved.applicationId,
    })
    f.page.url = 'https://discord.com/oauth2/authorize'
    f.page.paused = true
    await expect(f.service.next()).rejects.toThrow('同一个 Discord App')
    expect(f.browser.confirmSuccess).not.toHaveBeenCalled()
    expect(f.stored()?.step).toBe('discord-install')
  })
  it('keeps public URLs in pet replies and questions while blocking credentials', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.emit({ action: 'visibility', visible: true })
    await vi.waitFor(() => expect(discordSetupSession.browserVisible).toBe(true))
    const token = 'a'.repeat(24) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(28)
    const route = 'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/workers/new'
    await f.service.showAssistantReply(route)
    expect(f.browser.message).toHaveBeenLastCalledWith({ text: route })
    await f.service.showAssistantReply(route + '?code=PRIVATE_AUTH_CODE&tab=overview')
    expect(f.browser.message).toHaveBeenLastCalledWith({
      text: route + '?code=[已遮蔽]&tab=overview',
    })
    await f.service.showAssistantReply('请在这里填写 ' + token)
    expect(f.browser.message).toHaveBeenLastCalledWith({ text: '请在这里填写 [已遮蔽]' })
    f.emit({ action: 'assist', text: token })
    await vi.waitFor(() =>
      expect(f.browser.message).toHaveBeenLastCalledWith({
        text: '配置值请留在网页表单填写；这里只说明遇到的问题',
      }),
    )
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('starts command-only updates at installation without GitHub or Cloudflare', async () => {
    const f = fixture()
    await f.service.start('update-commands-only')
    expect(f.browser.open).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'discord-install', chooseStep: true, site: 'discord' }),
    )
  })
  it('queues one explicit request only after the user permits the current page', async () => {
    const f = fixture()
    await f.service.start('configure', undefined, 'agent')
    f.page.paused = true
    f.emit({ action: 'assist' })
    await vi.waitFor(() => expect(f.browser.message).toHaveBeenCalled())
    expect(f.service.takeAssistantRequest()).toBeUndefined()
    f.page.paused = false
    f.emit({ action: 'assist' })
    await vi.waitFor(() => expect(f.browser.message).toHaveBeenCalledTimes(2))
    const prompt = f.service.takeAssistantRequest()
    expect(prompt).toContain('status 核对任务')
    expect(prompt).not.toContain('1234567890123456789')
    expect(f.service.takeAssistantRequest()).toBeUndefined()
  })
  it('asks where the user is stuck before either update task and excludes done from selectable steps', async () => {
    for (const task of ['update-worker', 'update-commands'] as const) {
      const f = fixture()
      const receipt = await f.service.start(task)
      expect(receipt.needsUserStep).toBe(true)
      expect(f.browser.open).toHaveBeenCalledWith(
        expect.objectContaining({ chooseStep: true, step: 'github-sync' }),
      )
      expect(
        vi.mocked(f.browser.open).mock.calls[0]![0].steps.some((step) => step.id === 'done'),
      ).toBe(false)
    }
  })
  it('keeps worker updates separate from reinstalling and registering commands', () => {
    expect(DISCORD_SETUP_ROUTES['update-commands-only']).toEqual([
      'discord-install',
      'local-settings',
      'register',
      'verify',
      'done',
    ])
    expect(DISCORD_SETUP_ROUTES['update-worker']).not.toContain('discord-install')
    expect(DISCORD_SETUP_ROUTES['update-commands']).toEqual([
      'github-sync',
      'cf-deploy',
      'discord-install',
      'local-settings',
      'register',
      'verify',
      'done',
    ])
  })
  it.each(['update-worker', 'update-commands', 'update-commands-only'] as const)(
    'completes %s through fresh deployment/authorization/command evidence with one task owner',
    async (task) => {
      const f = fixture({
        task,
        mode: 'agent',
        step: 'done',
        startedAt: 1,
        applicationId: saved.applicationId,
        workerUrl: saved.workerBaseUrl,
        forkRepo: 'test-user/SRL-Discord-Bridge',
        parameterResourceId: 'parameter-card',
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                applicationId: saved.applicationId,
                database: true,
                discordConfigured: true,
                applicationIdMatches: true,
                publicKeyMatches: true,
                commandRegistered: true,
              }),
            ),
        ),
      )
      vi.mocked(f.browser.act).mockImplementation(async (options) =>
        options.operation === 'collect-worker'
          ? { ok: true, workerUrl: saved.workerBaseUrl }
          : { ok: true, verified: true, revision: 'a'.repeat(40) },
      )
      await f.service.start(task, DISCORD_SETUP_ROUTES[task][0], 'agent')
      const advance = (from: string, operation = 'advance-step') =>
        f.service.execute(
          { operation, from, document_id: '1', target: '1' },
          new AbortController().signal,
        )
      if (task !== 'update-commands-only') {
        f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/tree/main'
        f.page.forkOfTarget = true
        await advance('github-sync')
        expect(f.stored()?.step).toBe('cf-deploy')
        f.page.url =
          'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production'
        await advance('cf-deploy')
        expect(f.browser.act).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: 'verify-step',
            step: 'cf-deploy',
            expectedFork: 'test-user/SRL-Discord-Bridge',
            expectedRevision: 'a'.repeat(40),
          }),
        )
      }
      if (task !== 'update-worker') {
        f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/installation`
        await expect(advance('discord-install')).rejects.toThrow('授权由用户完成')
        f.emit({ action: 'resume' })
        await vi.waitFor(() => expect(f.stored()?.step).toBe('local-settings'))
        const saveForm = vi.fn(async () => true)
        const detach = f.service.attachLocalForm(saveForm)
        await advance('local-settings')
        detach()
        expect(saveForm).toHaveBeenCalledOnce()
        await advance('register', 'verify-local')
      }
      const result = await advance('verify', 'verify-local')
      expect(result).toMatchObject({ ok: true, verified: true, step: 'done' })
      if (task === 'update-commands-only') expect(f.parameters.save).not.toHaveBeenCalled()
      else
        expect(f.parameters.save).toHaveBeenCalledExactlyOnceWith(
          { workerUrl: saved.workerBaseUrl },
          'parameter-card',
        )
      expect(
        vi
          .mocked(f.browser.act)
          .mock.calls.some(([options]) => ['template', 'fill-config'].includes(options.operation)),
      ).toBe(false)
      expect(JSON.stringify(result)).not.toContain(saved.botToken)
    },
  )
  it('resumes a saved step without reading resources or transferring secrets', async () => {
    const f = fixture({ task: 'configure', step: 'd1-uuid', startedAt: 1 })
    expect(
      await f.service.execute({ operation: 'status' }, new AbortController().signal),
    ).toMatchObject({ step: 'd1-uuid' })
    expect(f.storage.read).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.stored())).not.toContain(saved.botToken)
    expect(f.browser.inspect).not.toHaveBeenCalled()
  })
  it('keeps the live editor and D1 details while opening the next step', async () => {
    const f = fixture({
      task: 'configure',
      step: 'wrangler-check',
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    await f.service.open()
    expect(f.browser.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: undefined, site: 'github' }),
    )
  })
  it('collects the D1 identity during creation and advances using the same saved receipt', async () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = fixture()
    await f.service.start('configure', 'd1-create', 'agent')
    f.page.url = `https://dash.cloudflare.com/account/d1/databases/${uuid}/settings`
    vi.mocked(f.browser.act).mockResolvedValue({ ok: true, parameters: { databaseId: uuid } })
    const receipt = await f.service.execute(
      { operation: 'collect-config', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt).toMatchObject({ ok: true, mode: 'agent', step: 'd1-create' })
    expect(JSON.stringify(receipt)).not.toContain(uuid)
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'collect-config',
        step: 'd1-uuid',
        allowParameters: true,
      }),
    )
    expect(f.parameters.save).toHaveBeenCalledWith({ databaseId: uuid }, undefined)
    await f.service.execute(
      { operation: 'advance-step', from: 'd1-create', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.stored()?.step).toBe('d1-uuid')
    expect(f.browser.act).toHaveBeenCalledOnce()
    expect(f.parameters.save).toHaveBeenCalledOnce()
  })
  it.each([
    'd1-create',
    'd1-uuid',
    'github-fork',
    'wrangler-edit',
    'wrangler-check',
    'github-save',
    'cf-deploy',
    'cf-secret',
    'worker-url',
    'discord-endpoint',
    'discord-install',
  ] as const)(
    'allows public D1 inspection and capture during %s without changing the task step',
    async (step) => {
      const f = fixture()
      await f.service.start('configure', step, 'agent')
      const uuid = '12345678-1234-5678-9abc-123456789abc'
      f.page.url = `https://dash.cloudflare.com/account/workers/d1/databases/${uuid}/settings`
      vi.mocked(f.browser.act).mockResolvedValue({ ok: true, parameters: { databaseId: uuid } })
      await f.service.execute(
        { operation: 'inspect', query: 'Database' },
        new AbortController().signal,
      )
      expect(f.browser.inspect).toHaveBeenCalledWith({ metadataOnly: false, query: 'Database' })
      const result = await f.service.execute(
        { operation: 'collect-config', document_id: '1' },
        new AbortController().signal,
      )
      expect(result).toMatchObject({ ok: true, step })
      expect(JSON.stringify(result)).not.toContain(uuid)
      expect(f.browser.act).toHaveBeenCalledWith(expect.objectContaining({ step: 'd1-uuid' }))
      expect(f.parameters.save).toHaveBeenCalledOnce()
    },
  )
  it('does not advance D1 creation merely because public App fields could be captured', async () => {
    const f = fixture()
    await f.service.start('configure', 'd1-create', 'agent')
    await expect(
      f.service.execute(
        { operation: 'advance-step', from: 'd1-create', document_id: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('无法核验此步骤')
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.stored()?.step).toBe('d1-create')
  })
  it('rejects stale document handles and untrusted sites', async () => {
    const f = fixture({ task: 'configure', step: 'd1-create', startedAt: 1 })
    f.page.url = 'https://dash.cloudflare.com/account/d1'
    await expect(
      f.service.execute(
        { operation: 'click', document_id: '0', target: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('网页已变化')
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge'
    await expect(
      f.service.execute(
        { operation: 'fill', document_id: '1', target: '1', field: 'database-name' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('不属于已授权')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('waits for the user while paused and never offers arbitrary secret filling', async () => {
    const f = fixture({ task: 'configure', step: 'd1-create', startedAt: 1 })
    f.page.url = 'https://dash.cloudflare.com/'
    f.page.paused = true
    expect(
      await f.service.execute(
        { operation: 'click', document_id: '1', target: '1' },
        new AbortController().signal,
      ),
    ).toMatchObject({ waitingForUser: true })
    f.page.paused = false
    await expect(
      f.service.execute(
        { operation: 'fill', document_id: '1', target: '1', field: 'bot-token' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('密钥')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('does not accept an unrelated repository as the configured Fork', async () => {
    const f = fixture({ task: 'configure', step: 'github-fork', startedAt: 1 })
    f.page.url = 'https://github.com/test-user/unrelated'
    await expect(f.service.next()).rejects.toThrow('自己 Fork')
    expect(f.stored()?.forkRepo).toBeUndefined()
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge'
    f.page.forkOfTarget = true
    await f.service.next()
    expect(f.stored()).toMatchObject({
      forkRepo: 'test-user/SRL-Discord-Bridge',
      step: 'wrangler-edit',
    })
    expect(f.browser.open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc',
      }),
    )
  })
  it('never writes a Wrangler template to the upstream repository', async () => {
    const f = fixture({
      task: 'configure',
      step: 'wrangler-edit',
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    f.page.url = 'https://github.com/jixiangruyi117/SRL-Discord-Bridge/edit/main/wrangler.jsonc'
    await expect(
      f.service.execute({ operation: 'template', document_id: '1' }, new AbortController().signal),
    ).rejects.toThrow('不能修改上游')
    expect(f.browser.act).not.toHaveBeenCalled()
  })
  it('does not advance after invalid Wrangler formatting or submit an unchecked editor', async () => {
    const f = fixture({
      task: 'configure',
      step: 'wrangler-check',
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc'
    vi.mocked(f.browser.act).mockResolvedValue({ ok: false, errors: ['公钥格式错误'] })
    await expect(f.service.next()).rejects.toThrow('公钥格式错误')
    expect(f.stored()?.step).toBe('wrangler-check')
    await f.service.select('github-save')
    await expect(
      f.service.execute(
        { operation: 'click', document_id: '1', target: '1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('公钥格式错误')
    expect(f.browser.act).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'click' }))
  })
  it('fills only fixed non-secret values and returns no saved token', async () => {
    const f = fixture({
      task: 'configure',
      step: 'discord-endpoint',
      startedAt: 1,
      applicationId: saved.applicationId,
      workerUrl: saved.workerBaseUrl,
    })
    const receipt = await f.service.execute(
      { operation: 'fill', document_id: '1', target: '1', field: 'interactions-url' },
      new AbortController().signal,
    )
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({ value: `${saved.workerBaseUrl}/interactions` }),
    )
    expect(JSON.stringify(receipt)).not.toContain(saved.botToken)
  })
  it('requires this task to collect a Worker URL and preserves an existing settings owner', async () => {
    const f = fixture({
      task: 'configure',
      step: 'worker-url',
      startedAt: Date.now(),
      workerUrl: saved.workerBaseUrl,
    })
    f.page.url = 'https://dash.cloudflare.com/'
    await expect(f.service.next()).rejects.toThrow('本次部署')
    f.emit({ action: 'worker-url', workerUrl: 'https://new-worker.account.workers.dev' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.stored()).toMatchObject({ workerUrl: 'https://new-worker.account.workers.dev' })
    expect(saved.botToken).toBe('TEST_SECRET_NOT_FOR_MODEL')
    await f.service.next()
    expect(f.stored()?.step).toBe('discord-endpoint')
  })
  it('collects a deployed Worker URL locally, returning only a presence flag to the model', async () => {
    const f = fixture({ task: 'configure', step: 'worker-url', startedAt: Date.now() })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/new-worker/production'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      workerUrl: 'https://new-worker.account.workers.dev',
    })
    const receipt = await f.service.execute(
      { operation: 'collect-worker', document_id: '1' },
      new AbortController().signal,
    )
    expect(receipt.workerKnown).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('new-worker.account')
    expect(f.stored()?.workerUrl).toBe('https://new-worker.account.workers.dev')
    expect(f.browser.inspect).toHaveBeenCalledWith({ metadataOnly: true })
  })
  it('hands help to the real agent rather than ending after a fixed URL-backfill action', async () => {
    const f = fixture({
      task: 'configure',
      step: 'worker-url',
      startedAt: Date.now(),
      mode: 'agent',
    })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/new-worker/production'
    vi.mocked(f.browser.act).mockResolvedValue({
      ok: true,
      workerUrl: 'https://new-worker.account.workers.dev',
    })
    await f.service.current()
    f.emit({ action: 'assist' })
    await f.service.execute({ operation: 'status' }, new AbortController().signal)
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.service.takeAssistantRequest()).toContain('公开页面 inspect')
    expect(discordSetupSession.agentRunning).toBe(true)
    const receipt = await f.service.execute(
      { operation: 'collect-worker', document_id: '1' },
      new AbortController().signal,
    )
    expect(f.parameters.save).toHaveBeenCalled()
    expect(JSON.stringify(receipt)).not.toContain('new-worker.account')
  })
  it.each([
    ['fill-endpoint', 'information', 'discord-endpoint'],
    ['open-install', 'installation', 'discord-install'],
    ['fill-endpoint', 'general-information', 'd1-create'],
    ['open-install', 'install', 'github-fork'],
  ] as const)(
    'performs %s on the actual %s page during %s and exposes only receipts',
    async (operation, route, step) => {
      const f = fixture({
        task: 'configure',
        step,
        mode: 'agent',
        startedAt: 1,
        applicationId: saved.applicationId,
        workerUrl: saved.workerBaseUrl,
      })
      f.page.url = `https://discord.com/developers/applications/${saved.applicationId}/${route}`
      vi.mocked(f.browser.act).mockResolvedValue({
        ok: true,
        installUrl: 'LOCAL_ONLY',
        value: saved.workerBaseUrl,
      })
      const receipt = await f.service.execute(
        { operation, document_id: '1', target: '1' },
        new AbortController().signal,
      )
      expect(receipt).toMatchObject({ ok: true, waitingForUser: true })
      expect(JSON.stringify(receipt)).not.toContain('LOCAL_ONLY')
      expect(JSON.stringify(receipt)).not.toContain(saved.workerBaseUrl)
      expect(f.stored()?.step).toBe(step)
      expect(f.browser.act).toHaveBeenCalledWith(
        expect.objectContaining({
          operation,
          expectedApplicationId: saved.applicationId,
          target: '1',
        }),
      )
      f.page.url = f.page.url.replace(saved.applicationId, '9876543210123456789')
      await expect(
        f.service.execute({ operation, document_id: '1' }, new AbortController().signal),
      ).rejects.toThrow('App')
    },
  )
  it('does not count an uncommitted editor as a saved GitHub file', async () => {
    const f = fixture({
      task: 'configure',
      step: 'github-save',
      startedAt: 1,
      forkRepo: 'test-user/SRL-Discord-Bridge',
    })
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc'
    await expect(f.service.next()).rejects.toThrow('仍在编辑页')
    f.page.url = 'https://github.com/test-user/SRL-Discord-Bridge/blob/main/wrangler.jsonc'
    await f.service.next()
    expect(f.stored()?.step).toBe('cf-deploy')
  })
  it('requires fresh connection and command checks before claiming done', async () => {
    const start = Date.now()
    const f = fixture({ task: 'update-worker', step: 'verify', startedAt: start })
    saved.commandRegistered = true
    saved.workerVerifiedAt = start - 1
    saved.commandCheckedAt = start - 1
    await expect(f.service.next()).rejects.toThrow('旧检查')
    saved.workerVerifiedAt = start + 1
    saved.commandCheckedAt = start + 1
    await f.service.next()
    expect(f.stored()?.step).toBe('done')
    await expect(f.service.start('update-worker', 'done')).rejects.toThrow('实际检查')
  })
  it('does not publish a new step after storage fails', async () => {
    const f = fixture({ task: 'configure', step: 'd1-create', startedAt: 1 })
    f.page.url = 'https://dash.cloudflare.com/'
    f.storage.save.mockRejectedValue(new Error('disk full'))
    await expect(f.service.next()).rejects.toThrow('disk full')
    expect(await f.service.current()).toMatchObject({ step: 'd1-create' })
  })
  it('rejects a fresh successful check for a different App or Worker', async () => {
    const start = Date.now()
    const f = fixture({
      task: 'update-worker',
      step: 'verify',
      startedAt: start,
      applicationId: saved.applicationId,
      workerUrl: 'https://another.account.workers.dev',
    })
    saved.commandRegistered = true
    saved.workerVerifiedAt = start + 1
    saved.commandCheckedAt = start + 1
    await expect(f.service.next()).rejects.toThrow('与本次任务不一致')
    expect(f.stored()?.step).toBe('verify')
  })
  it('continues only after an explicit successful-deployment confirmation', async () => {
    const f = fixture({ task: 'update-worker', step: 'cf-deploy', startedAt: 1 })
    f.page.url = 'https://dash.cloudflare.com/account/workers/services/view/test/production'
    await f.service.next()
    expect(f.browser.confirmSuccess).toHaveBeenCalledExactlyOnceWith({
      documentId: 1,
      step: 'cf-deploy',
    })
    expect(f.stored()?.step).toBe('verify')
  })
  it('hides the native tool in web and old APKs, and when tools are disabled', () => {
    const context = {
      mode: 'auto' as const,
      presetId: '',
      appliedCss: '',
      scopes: [],
      css: {},
      currentScope: '',
    }
    expect(
      getAssistantRequestTools(context).some((tool) => tool.name === 'configure_discord_browser'),
    ).toBe(false)
    expect(
      getAssistantRequestTools({ ...context, canConfigureDiscordBrowser: true }).some(
        (tool) => tool.name === 'configure_discord_browser',
      ),
    ).toBe(true)
    expect(
      getAssistantRequestTools({
        ...context,
        canConfigureDiscordBrowser: true,
        toolCallingEnabled: false,
      }),
    ).toEqual([])
  })
  it('drops injected secrets and invalid URLs from imported metadata', () => {
    const value = normalizeDiscordSetupState({
      task: 'configure',
      step: 'd1-uuid',
      startedAt: 1,
      botToken: saved.botToken,
      cookie: 'secret',
      editorSource: 'secret',
      workerUrl: 'https://example.com/?token=secret',
    })
    expect(value).toEqual({ task: 'configure', step: 'd1-uuid', startedAt: 1 })
  })
})
