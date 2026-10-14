import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createPublicKey, publicEncrypt, constants } from 'node:crypto'
import { discordSetupParameterResources as owner } from './DiscordSetupParameters'
import { secretResourceService } from './SecretResourceService'
import type { PersonalResourceDocument } from '../types/PersonalResource'
const state = vi.hoisted(() => ({
  credentials: new Map<string, string>(),
  documents: new Map<string, PersonalResourceDocument>(),
  saved: vi.fn(),
  confirm: vi.fn(async () => false),
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: state.confirm }))
vi.mock('./LocalCredentialStore', () => ({
  localCredentialStore: {
    read: async (id: string) => state.credentials.get(id) ?? '',
    save: async (id: string, text: string) => {
      state.credentials.set(id, text)
    },
    clear: async (id: string) => {
      state.credentials.delete(id)
    },
  },
}))
vi.mock('../core/LibraryContainer', () => ({
  resourceService: {
    listResourceListSummaries: async () =>
      [...state.documents].map(([id, doc]) => ({
        id,
        name: doc.name,
        type: 'secret',
        updatedAt: 1,
      })),
    getResourceListSummary: async (id: string) =>
      state.documents.has(id)
        ? { id, type: 'secret', name: state.documents.get(id)!.name }
        : undefined,
    get: async (id: string) => (state.documents.has(id) ? { id, type: 'secret' } : undefined),
  },
}))
vi.mock('../core/PersonalResourceContainer', () => ({
  personalResourceService: {
    read: async ({ id }: { id: string }) => structuredClone(state.documents.get(id)),
    save: async (document: PersonalResourceDocument, _files: unknown, current?: { id: string }) => {
      const { validateSecretResource } = await import('./PersonalResourceImport')
      await validateSecretResource(new Blob([JSON.stringify(document)]))
      const id = current?.id ?? `card-${state.documents.size + 1}`
      state.documents.set(id, structuredClone(document))
      state.saved(document, id)
      return { id }
    },
  },
}))
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
  state.credentials.clear()
  state.documents.clear()
  state.saved.mockClear()
  state.confirm.mockReset().mockResolvedValue(false)
  secretResourceService.lock()
})
describe('deployment parameters reuse personal secret resources', () => {
  const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
  it('finds saved cards using only summaries and decrypts one selected snapshot locally', async () => {
    await secretResourceService.setPassword('test-password')
    const value = {
      applicationId: '1234567890123456789',
      publicKey: 'a'.repeat(64),
      workerBaseUrl: 'https://old.example.workers.dev',
      botToken: token,
      inboxLibraryId: 'old-inbox-123',
      inboxSecret: 'old-inbox-secret',
      inboxName: '原收件箱',
    }
    const id = await owner.backupConnection!(value)
    const list = await owner.listSavedConnections!('旧连接')
    expect(list.cards).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(token)
    expect(JSON.stringify(list)).not.toContain(value.inboxSecret)
    expect(await owner.savedConnectionName!(id)).toContain('旧连接')
    expect(await owner.readSavedConnection!(id)).toMatchObject(value)
    secretResourceService.lock()
    await expect(owner.readSavedConnection!(id)).rejects.toThrow('未解锁')
  })
  it('rejects incomplete selected deployment cards without inventing a Token or picking another card', async () => {
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({
      applicationId: '1234567890123456789',
      publicKey: 'a'.repeat(64),
      workerUrl: 'https://old.example.workers.dev',
    })
    await expect(owner.readSavedConnection!(id)).rejects.toThrow('缺少有效')
    expect(state.documents.size).toBe(1)
  })
  function transport(publicKey: string, value = token) {
    const key = crypto.getRandomValues(new Uint8Array(32)),
      iv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('srl-discord-bot-transfer-v1'))
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return {
      key: publicEncrypt(
        {
          key: createPublicKey({
            key: Buffer.from(publicKey, 'base64'),
            format: 'der',
            type: 'spki',
          }),
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        key,
      ).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      data: data.toString('base64'),
    }
  }
  it('decrypts only inside the existing credential owner, persists encrypted and locally transfers after unlock', async () => {
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({ applicationId: '1234567890123456789' })
    await owner.captureBotSecret!(id, async (publicKey) => transport(publicKey))
    expect(state.documents.size).toBe(1)
    expect(JSON.stringify(state.documents.get(id))).not.toContain(token)
    expect(JSON.stringify(await owner.read(id))).not.toContain(token)
    const consume = vi.fn(async () => {})
    await owner.useBotSecret!(id, consume)
    expect(consume).toHaveBeenCalledWith(token)
    secretResourceService.lock()
    await expect(owner.useBotSecret!(id, consume)).rejects.toThrow('解锁')
    expect(consume).toHaveBeenCalledOnce()
  })
  it('replaces a previously saved Token on the same card after reset and preserves it if a later capture fails', async () => {
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({ applicationId: '1234567890123456789' })
    await owner.captureBotSecret!(id, async (publicKey) => transport(publicKey))
    const next = `${'D'.repeat(24)}.${'E'.repeat(6)}.${'F'.repeat(32)}`
    await owner.captureBotSecret!(id, async (publicKey) => transport(publicKey, next))
    expect(state.documents.size).toBe(1)
    const consume = vi.fn(async () => {})
    await owner.useBotSecret!(id, consume)
    expect(consume).toHaveBeenLastCalledWith(next)
    const saved = structuredClone(state.documents.get(id))
    expect(JSON.stringify(saved)).not.toContain(next)
    await expect(
      owner.captureBotSecret!(id, async () => {
        throw new Error('Token not recognized')
      }),
    ).rejects.toThrow('Token not recognized')
    expect(state.documents.get(id)).toEqual(saved)
  })
  it('rejects tampered transport, cancelled capture and concurrent edits without replacing the card', async () => {
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({ applicationId: '1234567890123456789' })
    const initial = structuredClone(state.documents.get(id))
    await expect(
      owner.captureBotSecret!(id, async (key) => ({
        ...transport(key),
        data: Buffer.alloc(32).toString('base64'),
      })),
    ).rejects.toThrow()
    expect(state.documents.get(id)).toEqual(initial)
    const controller = new AbortController()
    await expect(
      owner.captureBotSecret!(
        id,
        async (key) => {
          controller.abort()
          return transport(key)
        },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(state.documents.get(id)).toEqual(initial)
    await expect(
      owner.captureBotSecret!(id, async (key) => {
        state.documents.get(id)!.name = '用户新名称'
        return transport(key)
      }),
    ).rejects.toThrow('未覆盖')
    expect(state.documents.get(id)!.name).toBe('用户新名称')
    expect(state.documents.size).toBe(1)
  })
  it('requires the existing unified password without setting one silently', async () => {
    await expect(owner.prepare()).rejects.toThrow('未解锁')
    expect(state.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ centered: true, secretUnlock: true, title: '先设置密钥统一密码' }),
      undefined,
    )
    expect(state.credentials.size).toBe(0)
    await secretResourceService.setPassword('test-password')
    await owner.prepare()
    secretResourceService.lock()
    await expect(owner.prepare()).rejects.toThrow('解锁')
    expect(state.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '先解锁部署密钥' }),
      undefined,
    )
  })
  it('keeps four non-secret fields readable and preserves a manually encrypted Bot Token when updating', async () => {
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({
      applicationId: '1234567890123456789',
      publicKey: 'a'.repeat(64),
      botToken: 'INJECTED_SECRET',
    } as never)
    let document = state.documents.get(id)!
    expect(document.fields).toHaveLength(5)
    expect(document.fields.at(-1)).toMatchObject({ private: true, value: '' })
    expect(document.protected).toBeTruthy()
    expect(JSON.stringify(document)).not.toContain('INJECTED_SECRET')
    document = await secretResourceService.protect({
      ...document,
      fields: document.fields.map((field) =>
        field.id === 'discord-bot-secret'
          ? { ...field, value: 'MANUALLY_ENTERED_BOT_TOKEN' }
          : field,
      ),
    })
    state.documents.set(id, document)
    const envelope = document.protected
    await owner.save(
      {
        databaseId: '12345678-1234-5678-9abc-123456789abc',
        workerUrl: 'https://test.account.workers.dev',
      },
      id,
    )
    const updated = state.documents.get(id)!
    expect(updated.protected).toEqual(envelope)
    expect(JSON.stringify(updated)).not.toContain('MANUALLY_ENTERED_BOT_TOKEN')
    expect(await owner.read(id)).toEqual({
      applicationId: '1234567890123456789',
      publicKey: 'a'.repeat(64),
      databaseId: '12345678-1234-5678-9abc-123456789abc',
      workerUrl: 'https://test.account.workers.dev',
    })
    expect(
      (await secretResourceService.reveal(updated)).find(
        (field) => field.id === 'discord-bot-secret',
      )?.value,
    ).toBe('MANUALLY_ENTERED_BOT_TOKEN')
    expect(state.documents.size).toBe(1)
  })
  it('does not recreate deleted cards or overwrite user parameters marked private', async () => {
    await expect(
      owner.save({ workerUrl: 'https://test.account.workers.dev' }, 'missing'),
    ).rejects.toThrow('软件重新建立')
    await secretResourceService.setPassword('test-password')
    const id = await owner.save({ applicationId: '1234567890123456789' })
    const document = state.documents.get(id)!
    document.fields[0]!.private = true
    state.documents.set(id, document)
    await expect(owner.read(id)).rejects.toThrow('不解密')
    await expect(owner.save({ applicationId: '1234567890123456789' }, id)).rejects.toThrow('未覆盖')
  })
})

describe('old connection encrypted resource', () => {
  const old = {
    applicationId: '1234567890123456789',
    publicKey: 'a'.repeat(64),
    botToken: 'OLD_TOKEN_PRIVATE',
    workerBaseUrl: 'https://old.workers.dev',
    inboxLibraryId: 'old-inbox',
    inboxSecret: 'OLD_PAIRING_PRIVATE',
  }
  it('creates a separate resource, decrypts and verifies the full prior connection, and reuses the backup', async () => {
    await secretResourceService.setPassword('test-password')
    const deployment = await owner.save({ applicationId: old.applicationId })
    const checkpoint = vi.fn()
    const backup = await owner.backupConnection!(old, undefined, undefined, checkpoint)
    expect(backup).not.toBe(deployment)
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith(backup)
    expect(state.documents.size).toBe(2)
    const stored = state.documents.get(backup)!
    expect(JSON.stringify(stored)).not.toContain(old.botToken)
    expect(JSON.stringify(stored)).not.toContain(old.inboxSecret)
    const fields = await secretResourceService.reveal(stored)
    expect(
      JSON.parse(fields.find((field) => field.id === 'discord-connection-snapshot')!.value),
    ).toEqual(old)
    expect(await owner.backupConnection!(old, backup)).toBe(backup)
    expect(
      await owner.backupConnection!(
        { ...old, workerVerifiedAt: 123, commandCheckedAt: 124 },
        backup,
      ),
    ).toBe(backup)
    expect(state.documents.size).toBe(2)
    await owner.backupConnection!(
      { ...old, interactionEndpointUrl: 'https://other.workers.dev/interactions' },
      backup,
    )
    await owner.backupConnection!(
      {
        ...old,
        interactionEndpointUrl: 'https://other.workers.dev/interactions',
        databaseId: '12345678-1234-5678-9abc-123456789abc',
      },
      backup,
    )
    expect((await owner.read(backup)).databaseId).toBe('12345678-1234-5678-9abc-123456789abc')
    expect(state.documents.size).toBe(2)
    expect(state.documents.get(deployment)?.name).toBe('Discord Bridge 部署配置')
  })
  it('refuses changed backups, a locked password, and cancelled writes without creating another card', async () => {
    await secretResourceService.setPassword('test-password')
    const backup = await owner.backupConnection!(old)
    await expect(owner.backupConnection!({ ...old, botToken: 'CHANGED' }, backup)).rejects.toThrow(
      '不一致',
    )
    expect(state.documents.size).toBe(1)
    const controller = new AbortController()
    controller.abort()
    await expect(owner.backupConnection!(old, undefined, controller.signal)).rejects.toThrow()
    secretResourceService.lock()
    await expect(owner.backupConnection!(old)).rejects.toThrow('解锁')
    expect(state.documents.size).toBe(1)
  })
})
