import type { PersonalResourceDocument } from '../types/PersonalResource'
import { checkedSetupWorkerUrl } from './DiscordSetupWorkflow'
import { secretResourceService, type SecretBrowserTransfer } from './SecretResourceService'
import { confirmAction } from '../composables/UseConfirmDialog'
import type { DiscordSourceConnectionSettings } from './DiscordSourceSettingsService'
export type DiscordSetupConnectionBackup = DiscordSourceConnectionSettings & {
  interactionEndpointUrl?: string
  databaseId?: string
}
/** Status refreshes and temporary pairing codes do not create another connection backup. */
export function discordConnectionBackupIdentity(value: DiscordSetupConnectionBackup): string {
  const identity = { ...value }
  delete identity.workerVerifiedAt
  delete identity.commandCheckedAt
  delete identity.commandRegistered
  delete identity.inboxPairCode
  delete identity.inboxPairExpiresAt
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(identity)
        .sort()
        .map((key) => [key, identity[key as keyof DiscordSetupConnectionBackup]]),
    ),
  )
}

export interface DiscordSetupParameters {
  applicationId?: string
  publicKey?: string
  databaseId?: string
  workerUrl?: string
}
const fields = {
  applicationId: 'Application ID',
  publicKey: 'Public Key',
  databaseId: 'D1 UUID',
  workerUrl: 'Worker 根网址',
} as const
export class MissingDiscordSetupCardError extends Error {
  constructor() {
    super('部署密钥资源已移除；采集时可由软件重新建立资料卡，不需要用户手动建卡')
    this.name = 'MissingDiscordSetupCardError'
  }
}
export function checkedSetupParameters(input: DiscordSetupParameters): DiscordSetupParameters {
  const value: DiscordSetupParameters = {}
  for (const key of ['applicationId', 'publicKey', 'databaseId'] as const) {
    if (input[key] === undefined || input[key] === '') continue
    const pattern =
      key === 'applicationId'
        ? /^\d{17,20}$/u
        : key === 'publicKey'
          ? /^[a-f0-9]{64}$/iu
          : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu
    if (typeof input[key] !== 'string' || !pattern.test(input[key]!))
      throw new Error(`${fields[key]} 格式错误，请在网页核对`)
    value[key] = input[key]
  }
  if (input.workerUrl) value.workerUrl = checkedSetupWorkerUrl(input.workerUrl)
  return value
}
/** This adapter uses the existing resource and encryption owners, never another credential store. */
export interface DiscordSetupParameterResources {
  savedConnectionName?(id: string): Promise<string>
  listSavedConnections?(
    query?: string,
    offset?: number,
  ): Promise<{
    cards: Array<{ id: string; name: string; createdAt?: number; updatedAt?: number }>
    nextOffset: number | null
  }>
  readSavedConnection?(id: string, signal?: AbortSignal): Promise<DiscordSetupConnectionBackup>
  needsUnlock?(): boolean
  prepare(signal?: AbortSignal): Promise<void>
  read(id: string): Promise<DiscordSetupParameters>
  save(values: DiscordSetupParameters, id?: string): Promise<string>
  backupConnection?(
    previous: DiscordSetupConnectionBackup,
    id?: string,
    signal?: AbortSignal,
    onSaved?: (id: string) => void | Promise<void>,
  ): Promise<string>
  captureBotSecret?(
    id: string,
    capture: (publicKey: string) => Promise<SecretBrowserTransfer>,
    signal?: AbortSignal,
  ): Promise<void>
  useBotSecret?(
    id: string,
    consume: (secret: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>
}
export const discordSetupParameterResources: DiscordSetupParameterResources = {
  async savedConnectionName(id) {
    const { resourceService } = await import('../core/LibraryContainer')
    const resource = await resourceService.getResourceListSummary(id)
    if (!resource || resource.type !== 'secret') throw new MissingDiscordSetupCardError()
    return resource.name
  },
  async listSavedConnections(query = '', offset = 0) {
    const { resourceService } = await import('../core/LibraryContainer')
    const cards = (await resourceService.listResourceListSummaries({ types: ['secret'] }))
      .filter((card) => !query || card.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('密钥列表页码无效')
    return {
      cards: cards
        .slice(offset, offset + 30)
        .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })),
      nextOffset: cards.length > offset + 30 ? offset + 30 : null,
    }
  },
  async readSavedConnection(id, signal) {
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const resource = await resourceService.get(id)
    if (!resource || resource.type !== 'secret') throw new MissingDiscordSetupCardError()
    const document = await personalResourceService.read(resource)
    await this.prepare(signal)
    signal?.throwIfAborted()
    const revealed = await secretResourceService.reveal(document)
    const snapshot = revealed.find((field) => field.id === 'discord-connection-snapshot')
    let connection: DiscordSetupConnectionBackup
    if (snapshot) {
      if (!snapshot.private) throw new Error('完整连接备份必须保持加密')
      try {
        connection = JSON.parse(snapshot.value)
      } catch {
        throw new Error('旧连接备份格式无效，未修改设置')
      }
    } else {
      const aliases: Record<string, string[]> = {
        'discord-applicationId': [
          'applicationid',
          'discordapplicationid',
          'appid',
          '应用id',
          '应用程序id',
        ],
        'discord-publicKey': ['publickey', 'discordpublickey', '公钥'],
        'discord-workerUrl': [
          'workerurl',
          'workerbaseurl',
          'worker根网址',
          'worker网址',
          'worker链接',
        ],
        'discord-bot-secret': ['bottoken', 'discordbottoken', '机器人令牌', '机器人token'],
      }
      const value = (id: string) => {
        const exact = revealed.find((field) => field.id === id)
        if (exact) {
          if (id === 'discord-bot-secret' && !exact.private)
            throw new Error('Bot Token 必须保存在私密字段')
          return exact.value
        }
        const candidates = revealed.filter((field) =>
          aliases[id]?.includes(field.label.replace(/[\s_-]/gu, '').toLocaleLowerCase()),
        )
        if (candidates.length > 1)
          throw new Error('所选密钥卡有多个同名字段，请先在原卡中明确对应字段')
        if (id === 'discord-bot-secret' && candidates[0] && !candidates[0].private)
          throw new Error('Bot Token 必须保存在私密字段')
        return candidates[0]?.value ?? ''
      }

      connection = {
        applicationId: value('discord-applicationId'),
        publicKey: value('discord-publicKey'),
        workerBaseUrl: value('discord-workerUrl'),
        botToken: value('discord-bot-secret'),
      }
    }
    if (!connection || typeof connection !== 'object' || Array.isArray(connection))
      throw new Error('旧连接备份不完整')
    const checked = checkedSetupParameters({
      applicationId: connection.applicationId,
      publicKey: connection.publicKey,
      workerUrl: connection.workerBaseUrl,
    })
    if (
      !checked.applicationId ||
      !checked.publicKey ||
      !checked.workerUrl ||
      typeof connection.botToken !== 'string' ||
      !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/u.test(connection.botToken)
    )
      throw new Error('密钥卡缺少有效的 App、公钥、Token 或 Worker，未切换')
    if (
      (connection.inboxLibraryId || connection.inboxSecret) &&
      (!/^[A-Za-z0-9_-]{8,100}$/u.test(connection.inboxLibraryId ?? '') ||
        typeof connection.inboxSecret !== 'string' ||
        !connection.inboxSecret)
    )
      throw new Error('备份的收件配对资料不完整')
    const current = await resourceService.get(id)
    if (
      !current ||
      JSON.stringify(await personalResourceService.read(current)) !== JSON.stringify(document)
    )
      throw new Error('解锁期间密钥卡已变化，未采用旧内容')
    signal?.throwIfAborted()
    return {
      applicationId: checked.applicationId,
      publicKey: checked.publicKey,
      workerBaseUrl: checked.workerUrl,
      botToken: connection.botToken,
      credentialPersistence: connection.credentialPersistence === 'session' ? 'session' : 'local',
      ...(connection.inboxLibraryId
        ? {
            inboxLibraryId: connection.inboxLibraryId,
            inboxSecret: connection.inboxSecret,
            inboxName: connection.inboxName,
          }
        : {}),
    }
  },
  needsUnlock: () => !secretResourceService.isUnlocked(),
  async backupConnection(previous, id, signal, onSaved) {
    if (!secretResourceService.isUnlocked()) throw new Error('请先解锁统一密码，再保存旧连接')
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const snapshot = JSON.stringify(previous)
    const verify = async (resourceId: string) => {
      const resource = await resourceService.get(resourceId)
      if (!resource || resource.type !== 'secret') throw new MissingDiscordSetupCardError()
      const document = await personalResourceService.read(resource)
      const restored = await secretResourceService.reveal(document)
      const stored = restored.find((field) => field.id === 'discord-connection-snapshot')?.value
      if (
        !stored ||
        discordConnectionBackupIdentity(JSON.parse(stored)) !==
          discordConnectionBackupIdentity(previous)
      )
        throw new Error('旧连接备份读回不一致，未切换')
    }
    signal?.throwIfAborted()
    if (id) {
      const resource = await resourceService.get(id)
      if (!resource || resource.type !== 'secret') throw new MissingDiscordSetupCardError()
      const document = await personalResourceService.read(resource)
      const restored = await secretResourceService.reveal(document)
      const savedSnapshot = restored.find(
        (field) => field.id === 'discord-connection-snapshot',
      )?.value
      if (
        savedSnapshot &&
        discordConnectionBackupIdentity(JSON.parse(savedSnapshot)) !==
          discordConnectionBackupIdentity(previous) &&
        (previous.interactionEndpointUrl || previous.databaseId)
      ) {
        const original = JSON.parse(savedSnapshot ?? '{}') as DiscordSetupConnectionBackup
        const connection = { ...previous },
          originalConnection = { ...original }
        delete connection.interactionEndpointUrl
        delete connection.databaseId
        delete originalConnection.interactionEndpointUrl
        delete originalConnection.databaseId
        if (
          discordConnectionBackupIdentity(connection) !==
          discordConnectionBackupIdentity(originalConnection)
        )
          throw new Error('旧连接备份已变化，未覆盖')
        for (const key of ['interactionEndpointUrl', 'databaseId'] as const)
          if (original[key] && previous[key] !== original[key])
            throw new Error('原部署参数备份已存在，未覆盖')
        const updated = await secretResourceService.protect({
          ...document,
          fields: [
            ...restored.map((field) =>
              field.id === 'discord-connection-snapshot' ? { ...field, value: snapshot } : field,
            ),
            ...(!original.interactionEndpointUrl && previous.interactionEndpointUrl
              ? [
                  {
                    id: 'discord-old-endpoint',
                    label: '原 Discord 交互地址',
                    value: previous.interactionEndpointUrl,
                    private: false,
                  },
                ]
              : []),
            ...(!original.databaseId && previous.databaseId
              ? [
                  {
                    id: 'discord-databaseId',
                    label: 'D1 UUID',
                    value: previous.databaseId,
                    private: false,
                  },
                ]
              : []),
          ],
        })
        signal?.throwIfAborted()
        const latest = await resourceService.get(id)
        if (
          !latest ||
          JSON.stringify(await personalResourceService.read(latest)) !== JSON.stringify(document)
        )
          throw new Error('旧连接备份在保存期间已变化，未覆盖')
        await personalResourceService.save(updated, new Map(), latest)
      }
      await verify(id)
      return id
    }
    const document = await secretResourceService.protect({
      format: 'srl-personal-resource',
      version: 1,
      kind: 'secret',
      name: `Discord Bridge 旧连接 ${new Date().toLocaleString()}`,
      text: '切换前保存的原连接。含 App ID、公钥、Worker、加密 Bot Token 和原收件配对资料；旧云端资源未删除。D1 UUID 只在原部署卡与原连接 App、公钥、Worker 一致时保留，不猜测补写。',
      url: previous.workerBaseUrl,
      attachments: [],
      fields: [
        {
          id: 'discord-applicationId',
          label: 'Application ID',
          value: previous.applicationId,
          private: false,
        },
        { id: 'discord-publicKey', label: 'Public Key', value: previous.publicKey, private: false },
        {
          id: 'discord-workerUrl',
          label: 'Worker 根网址',
          value: previous.workerBaseUrl,
          private: false,
        },
        ...(previous.databaseId
          ? [
              {
                id: 'discord-databaseId',
                label: 'D1 UUID',
                value: previous.databaseId,
                private: false,
              },
            ]
          : []),
        ...(previous.interactionEndpointUrl
          ? [
              {
                id: 'discord-old-endpoint',
                label: '原 Discord 交互地址',
                value: previous.interactionEndpointUrl,
                private: false,
              },
            ]
          : []),
        { id: 'discord-bot-secret', label: 'Bot Token', value: previous.botToken, private: true },
        {
          id: 'discord-connection-snapshot',
          label: '完整旧连接及收件配对资料',
          value: snapshot,
          private: true,
        },
      ],
    })
    signal?.throwIfAborted()
    const resource = await personalResourceService.save(document, new Map())
    await onSaved?.(resource.id)
    await verify(resource.id)
    signal?.throwIfAborted()
    window.dispatchEvent(new Event('srl:library-changed'))
    return resource.id
  },
  async captureBotSecret(id, capture, signal) {
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const resource = await resourceService.get(id)
    if (!resource || resource.type !== 'secret') throw new Error('部署密钥资源不存在')
    const document = await personalResourceService.read(resource)
    if (document.fields.find((field) => field.id === 'discord-bot-secret')?.private !== true)
      throw new Error('Bot Token 必须保持私密字段')
    await secretResourceService.receiveBrowserSecret(capture, async (value) => {
      signal?.throwIfAborted()
      if (
        !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/u.test(value) ||
        value.length > 512
      )
        throw new Error('当前页未显示有效 Bot Token，请先在 Bot 页面完成验证并显示 Token')
      const fields = await secretResourceService.reveal(document)
      const protectedDocument = await secretResourceService.protect({
        ...document,
        fields: fields.map((field) =>
          field.id === 'discord-bot-secret' ? { ...field, value } : field,
        ),
      })
      signal?.throwIfAborted()
      const latest = await resourceService.get(id)
      if (
        !latest ||
        latest.type !== 'secret' ||
        JSON.stringify(await personalResourceService.read(latest)) !== JSON.stringify(document)
      )
        throw new Error('部署卡已变化，未覆盖用户修改')
      signal?.throwIfAborted()
      await personalResourceService.save(protectedDocument, new Map(), latest)
    })
    window.dispatchEvent(new Event('srl:library-changed'))
  },
  async useBotSecret(id, consume, signal) {
    if (!secretResourceService.isUnlocked()) throw new Error('请先解锁统一密码')
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const resource = await resourceService.get(id)
    if (!resource || resource.type !== 'secret') throw new Error('部署密钥资源不存在')
    const document = await personalResourceService.read(resource)
    if (document.fields.find((field) => field.id === 'discord-bot-secret')?.private !== true)
      throw new Error('Bot Token 必须保持私密字段')
    const value = (await secretResourceService.reveal(document)).find(
      (field) => field.id === 'discord-bot-secret',
    )?.value
    signal?.throwIfAborted()
    if (
      !value ||
      !/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/u.test(value) ||
      value.length > 512
    )
      throw new Error('部署卡尚未保存有效 Bot Token，请在 Bot 页面点桌宠加密保存，或手动填写')
    await consume(value)
  },
  async prepare(signal) {
    if (secretResourceService.isUnlocked()) return
    const configured = await secretResourceService.hasPassword()
    const confirmed = await confirmAction(
      {
        title: configured ? '先解锁部署密钥' : '先设置密钥统一密码',
        message:
          '配置资料使用资源库原有统一密码保护。密码只在本机处理，不发送给蒜惹菈；完成后可继续当前任务。',
        centered: true,
        secretUnlock: true,
        confirmLabel: '继续配置',
        cancelLabel: '暂不配置',
      },
      signal,
    )
    if (!confirmed || !secretResourceService.isUnlocked())
      throw new Error('未解锁部署密钥，任务尚未继续')
  },
  async read(id) {
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const resource = await resourceService.get(id)
    if (!resource) throw new MissingDiscordSetupCardError()
    if (resource.type !== 'secret') throw new Error('部署资源类型已变化，未覆盖用户修改')
    const document = await personalResourceService.read(resource)
    const values: DiscordSetupParameters = {}
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const field = document.fields.find((item) => item.id === `discord-${key}`)
      if (field?.private) throw new Error('部署参数已改为私密字段，请自己填写；助手不解密读取秘密')
      if (field) values[key] = field.value
    }
    return checkedSetupParameters(values)
  },
  async save(values, id) {
    values = checkedSetupParameters(values)
    const { resourceService } = await import('../core/LibraryContainer')
    const { personalResourceService } = await import('../core/PersonalResourceContainer')
    const current = id ? await resourceService.get(id) : undefined
    if (id && !current) throw new MissingDiscordSetupCardError()
    if (current && current.type !== 'secret') throw new Error('部署资源类型已变化，未覆盖用户修改')
    let document: PersonalResourceDocument = current
      ? await personalResourceService.read(current)
      : {
          format: 'srl-personal-resource',
          version: 1,
          kind: 'secret',
          name: 'Discord Bridge 部署配置',
          text: 'Application ID、Public Key、D1 UUID、Worker 网址是部署参数，可自动读取回填。Bot Token 是私密字段，可手填或单独确认本机加密保存与转填；不发给模型，不写 GitHub。',
          url: '',
          attachments: [],
          fields: [
            ...Object.entries(fields).map(([key, label]) => ({
              id: `discord-${key}`,
              label,
              value: '',
              private: false,
            })),
            { id: 'discord-bot-secret', label: 'Bot Token', value: '', private: true },
          ],
        }
    if (!current) document = await secretResourceService.protect(document)
    if (
      document.kind !== 'secret' ||
      document.fields.find((field) => field.id === 'discord-bot-secret')?.private !== true
    )
      throw new Error('部署卡的 Bot Token 字段必须保持私密，未覆盖用户修改')
    document = {
      ...document,
      fields: document.fields.map((field) => {
        const key = (Object.keys(fields) as Array<keyof typeof fields>).find(
          (key) => field.id === `discord-${key}`,
        )
        if (!key || values[key] === undefined) return field
        if (field.private) throw new Error('部署参数已改为私密字段，未覆盖用户修改')
        return { ...field, value: values[key]! }
      }),
    }
    const result = await personalResourceService.save(document, new Map(), current)
    window.dispatchEvent(new Event('srl:library-changed'))
    return result.id
  },
}
