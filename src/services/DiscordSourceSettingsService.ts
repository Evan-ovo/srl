import { normalizeDiscordWorkerBaseUrl } from './DiscordSourceConnectionService'
import { localCredentialStore, type LocalCredentialRepository } from './LocalCredentialStore'

export interface DiscordSourceConnectionSettings {
  applicationId: string
  publicKey: string
  botToken: string
  workerBaseUrl: string
  credentialPersistence?: 'local' | 'session'
  /** 最近一次真实 /health 成功时间；只用于本机状态恢复，不代表当前时刻必然在线。 */
  workerVerifiedAt?: number
  /** 最近一次向 Discord API 核验消息命令的时间。 */
  commandCheckedAt?: number
  /** 最近一次真实核验时消息命令是否存在。 */
  commandRegistered?: boolean
  /** 云端收件地址；secret 始终经现有受保护凭据仓库存储。 */
  inboxLibraryId?: string
  inboxName?: string
  inboxSecret?: string
  /** 配对口令只留在当前会话，不写入普通设置。 */
  inboxPairCode?: string
  inboxPairExpiresAt?: number
}

export interface DiscordSourceConnectionStatusPatch {
  workerVerifiedAt?: number
  commandCheckedAt?: number
  commandRegistered?: boolean
}

const STORAGE_KEY = 'srl.discord-source.connection.v1'
const CREDENTIAL_IDENTIFIER = 'discord-source:bot-token'
const INBOX_CREDENTIAL_IDENTIFIER = 'discord-source:inbox-secret'

const EMPTY_SETTINGS: DiscordSourceConnectionSettings = {
  applicationId: '',
  publicKey: '',
  botToken: '',
  workerBaseUrl: '',
  credentialPersistence: 'local',
}

// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=discord-local-installation-identity
let clientId: string | undefined
/** Local installation identity for handoff receipts; independent of official accounts. */
export function getDiscordClientId(): string {
  try {
    const target = storage()
    const saved = target?.getItem('srl.discord-source.client-id.v1')
    if (saved && /^[A-Za-z0-9_-]{8,100}$/u.test(saved)) return saved
    clientId ??= crypto.randomUUID()
    target?.setItem('srl.discord-source.client-id.v1', clientId)
    return clientId
  } catch {
    clientId ??= crypto.randomUUID()
    return clientId
  }
}
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=discord-local-installation-identity
let currentSettings: DiscordSourceConnectionSettings | undefined
let settingsWrites: Promise<unknown> = Promise.resolve()

function withSettingsWrite<T>(write: () => Promise<T>): Promise<T> {
  const pending = settingsWrites.catch(() => undefined).then(write)
  settingsWrites = pending
  return pending
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function readOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeSettings(
  value: Partial<DiscordSourceConnectionSettings>,
): DiscordSourceConnectionSettings {
  return {
    applicationId: readString(value.applicationId, 64),
    publicKey: readString(value.publicKey, 256),
    botToken: readString(value.botToken, 512),
    workerBaseUrl: normalizeDiscordWorkerBaseUrl(readString(value.workerBaseUrl, 2_000)),
    credentialPersistence: value.credentialPersistence === 'session' ? 'session' : 'local',
    workerVerifiedAt: readOptionalTimestamp(value.workerVerifiedAt),
    commandCheckedAt: readOptionalTimestamp(value.commandCheckedAt),
    commandRegistered:
      typeof value.commandRegistered === 'boolean' ? value.commandRegistered : undefined,
    inboxLibraryId: readString(value.inboxLibraryId, 80) || undefined,
    inboxName: readString(value.inboxName, 80) || undefined,
    inboxSecret: readString(value.inboxSecret, 160) || undefined,
    inboxPairCode: readString(value.inboxPairCode, 32) || undefined,
    inboxPairExpiresAt: readOptionalTimestamp(value.inboxPairExpiresAt),
  }
}

function readStoredSettings(): DiscordSourceConnectionSettings {
  const target = storage()
  if (!target) return { ...EMPTY_SETTINGS }
  try {
    return normalizeSettings(
      JSON.parse(target.getItem(STORAGE_KEY) ?? '{}') as Partial<DiscordSourceConnectionSettings>,
    )
  } catch {
    return { ...EMPTY_SETTINGS }
  }
}

function writeSanitizedSettings(value: DiscordSourceConnectionSettings): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent('srl:discord-inbox-target-changed', {
        detail: { workerUrl: value.workerBaseUrl, libraryId: value.inboxLibraryId ?? '' },
      }),
    )
  storage()?.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...value, botToken: '', inboxSecret: '', inboxPairCode: undefined }),
  )
}

function connectionIdentityChanged(
  previous: DiscordSourceConnectionSettings,
  next: DiscordSourceConnectionSettings,
): boolean {
  return (
    previous.applicationId !== next.applicationId ||
    previous.publicKey !== next.publicKey ||
    previous.workerBaseUrl !== next.workerBaseUrl ||
    previous.botToken !== next.botToken
  )
}

export async function initializeDiscordSourceCredentials(
  credentialStore: LocalCredentialRepository = localCredentialStore,
): Promise<void> {
  return withSettingsWrite(() => initializeStoredCredentials(credentialStore))
}

async function initializeStoredCredentials(
  credentialStore: LocalCredentialRepository,
): Promise<void> {
  const settings = currentSettings ?? readStoredSettings()
  if (settings.credentialPersistence === 'session') {
    await credentialStore.clear(CREDENTIAL_IDENTIFIER)
    await credentialStore.clear(INBOX_CREDENTIAL_IDENTIFIER)
  } else if (settings.botToken) {
    // 旧明文只有在受保护存储成功后才会从 localStorage 删除。
    await credentialStore.save(CREDENTIAL_IDENTIFIER, settings.botToken)
  } else {
    settings.botToken = await credentialStore.read(CREDENTIAL_IDENTIFIER)
  }
  if (settings.credentialPersistence !== 'session' && settings.inboxLibraryId) {
    settings.inboxSecret = await credentialStore.read(INBOX_CREDENTIAL_IDENTIFIER)
  }
  currentSettings = settings
  writeSanitizedSettings(settings)
}

export function loadDiscordSourceConnectionSettings(): DiscordSourceConnectionSettings {
  currentSettings ??= readStoredSettings()
  return { ...currentSettings }
}

export async function saveDiscordSourceConnectionSettings(
  value: DiscordSourceConnectionSettings,
  credentialStore: LocalCredentialRepository = localCredentialStore,
): Promise<DiscordSourceConnectionSettings> {
  return withSettingsWrite(() => persistDiscordSourceConnectionSettings(value, credentialStore))
}

/** The setup owner supplies consent and a verified encrypted resource before replacing a target. */
export async function replaceDiscordSourceConnectionSettings(
  value: DiscordSourceConnectionSettings,
  preserve: (previous: DiscordSourceConnectionSettings) => Promise<boolean>,
  signal?: AbortSignal,
  credentialStore: LocalCredentialRepository = localCredentialStore,
  databaseChanged = false,
): Promise<DiscordSourceConnectionSettings | undefined> {
  return withSettingsWrite(async () => {
    await initializeStoredCredentials(credentialStore)
    const previous = loadDiscordSourceConnectionSettings()
    const next = normalizeSettings(value)
    signal?.throwIfAborted()
    const configured = Boolean(
      previous.applicationId || previous.publicKey || previous.botToken || previous.workerBaseUrl,
    )
    if (configured && (databaseChanged || connectionIdentityChanged(previous, next))) {
      if (!(await preserve({ ...previous }))) return undefined
      signal?.throwIfAborted()
      const current = loadDiscordSourceConnectionSettings()
      if (
        connectionIdentityChanged(previous, current) ||
        current.credentialPersistence !== previous.credentialPersistence ||
        current.inboxLibraryId !== previous.inboxLibraryId ||
        current.inboxSecret !== previous.inboxSecret
      )
        throw new Error('原连接在确认期间已变化，未切换；请重新核对')
    }
    try {
      return await persistDiscordSourceConnectionSettings(
        next,
        credentialStore,
        true,
        databaseChanged,
      )
    } catch (error) {
      // Credentials and ordinary settings cannot share a transaction. Restore the old target.
      try {
        if (previous.credentialPersistence !== 'session' && previous.botToken)
          await credentialStore.save(CREDENTIAL_IDENTIFIER, previous.botToken)
        else await credentialStore.clear(CREDENTIAL_IDENTIFIER)
        if (previous.credentialPersistence !== 'session' && previous.inboxSecret)
          await credentialStore.save(INBOX_CREDENTIAL_IDENTIFIER, previous.inboxSecret)
        else await credentialStore.clear(INBOX_CREDENTIAL_IDENTIFIER)
        currentSettings = previous
        writeSanitizedSettings(previous)
      } catch {
        throw new Error('连接写入和回滚未能全部完成；旧配置密钥资源已保留，请恢复后再继续')
      }
      throw error
    }
  })
}

async function persistDiscordSourceConnectionSettings(
  value: DiscordSourceConnectionSettings,
  credentialStore: LocalCredentialRepository,
  preservedSwitch = false,
  databaseChanged = false,
): Promise<DiscordSourceConnectionSettings> {
  const previous = currentSettings ?? readStoredSettings()
  const sameInboxOwner =
    !databaseChanged &&
    previous.applicationId === readString(value.applicationId, 64) &&
    previous.workerBaseUrl === normalizeDiscordWorkerBaseUrl(value.workerBaseUrl)
  if (previous.inboxLibraryId && !sameInboxOwner && !preservedSwitch) {
    throw new Error(
      '请先领取待收帖子及资源任务并断开云端收件配对，再更改 Worker 地址或 Application ID。',
    )
  }
  const normalized = normalizeSettings({
    ...value,
    inboxLibraryId: sameInboxOwner ? previous.inboxLibraryId : undefined,
    inboxName: sameInboxOwner ? previous.inboxName : undefined,
    inboxSecret: sameInboxOwner ? previous.inboxSecret : undefined,
    inboxPairCode: sameInboxOwner ? previous.inboxPairCode : undefined,
    inboxPairExpiresAt: sameInboxOwner ? previous.inboxPairExpiresAt : undefined,
  })
  const changedIdentity = databaseChanged || connectionIdentityChanged(previous, normalized)
  if (!changedIdentity) {
    normalized.workerVerifiedAt ??= previous.workerVerifiedAt
    normalized.commandCheckedAt ??= previous.commandCheckedAt
    normalized.commandRegistered ??= previous.commandRegistered
  } else {
    normalized.workerVerifiedAt = undefined
    normalized.commandCheckedAt = undefined
    normalized.commandRegistered = undefined
  }

  if (normalized.credentialPersistence === 'local' && normalized.botToken) {
    await credentialStore.save(CREDENTIAL_IDENTIFIER, normalized.botToken)
  } else {
    await credentialStore.clear(CREDENTIAL_IDENTIFIER)
  }
  if (!sameInboxOwner || normalized.credentialPersistence === 'session') {
    await credentialStore.clear(INBOX_CREDENTIAL_IDENTIFIER)
  } else if (normalized.inboxSecret) {
    await credentialStore.save(INBOX_CREDENTIAL_IDENTIFIER, normalized.inboxSecret)
  }
  currentSettings = normalized
  writeSanitizedSettings(normalized)
  return { ...normalized }
}

export function saveDiscordSourceConnectionStatus(
  patch: DiscordSourceConnectionStatusPatch,
): DiscordSourceConnectionSettings {
  const current = currentSettings ?? readStoredSettings()
  const next = normalizeSettings({
    ...current,
    ...(patch.workerVerifiedAt !== undefined ? { workerVerifiedAt: patch.workerVerifiedAt } : {}),
    ...(patch.commandCheckedAt !== undefined ? { commandCheckedAt: patch.commandCheckedAt } : {}),
    ...(patch.commandRegistered !== undefined
      ? { commandRegistered: patch.commandRegistered }
      : {}),
  })
  currentSettings = next
  writeSanitizedSettings(next)
  return { ...next }
}

export async function clearDiscordSourceConnectionSettings(
  credentialStore: LocalCredentialRepository = localCredentialStore,
): Promise<void> {
  return withSettingsWrite(async () => {
    const current = currentSettings ?? readStoredSettings()
    if (current.inboxLibraryId) {
      throw new Error('请先领取待收帖子及资源任务并断开云端收件配对，再清除 Worker 配置。')
    }
    await credentialStore.clear(CREDENTIAL_IDENTIFIER)
    await credentialStore.clear(INBOX_CREDENTIAL_IDENTIFIER)
    currentSettings = { ...EMPTY_SETTINGS }
    storage()?.removeItem(STORAGE_KEY)
  })
}

export async function saveDiscordInboxPairing(
  value: { libraryId: string; name: string; secret: string; code: string; expiresAt: number },
  credentialStore: LocalCredentialRepository = localCredentialStore,
  expected = {
    workerBaseUrl: loadDiscordSourceConnectionSettings().workerBaseUrl,
    applicationId: loadDiscordSourceConnectionSettings().applicationId,
  },
): Promise<void> {
  return withSettingsWrite(async () => {
    const current = currentSettings ?? readStoredSettings()
    if (
      current.workerBaseUrl !== expected.workerBaseUrl ||
      current.applicationId !== expected.applicationId
    ) {
      throw new Error('Worker 配置已改变，未保存旧目标的配对')
    }
    if (current.credentialPersistence !== 'session') {
      await credentialStore.save(INBOX_CREDENTIAL_IDENTIFIER, value.secret)
    }
    const next = normalizeSettings({
      ...current,
      inboxLibraryId: value.libraryId,
      inboxName: value.name,
      inboxSecret: value.secret,
      inboxPairCode: value.code,
      inboxPairExpiresAt: value.expiresAt,
    })
    writeSanitizedSettings(next)
    currentSettings = next
  })
}

export async function clearLocalDiscordInboxPairing(
  credentialStore: LocalCredentialRepository = localCredentialStore,
  expected = {
    workerBaseUrl: loadDiscordSourceConnectionSettings().workerBaseUrl,
    libraryId: loadDiscordSourceConnectionSettings().inboxLibraryId,
  },
): Promise<void> {
  return withSettingsWrite(async () => {
    const current = currentSettings ?? readStoredSettings()
    if (
      current.workerBaseUrl !== expected.workerBaseUrl ||
      current.inboxLibraryId !== expected.libraryId
    )
      return
    await credentialStore.clear(INBOX_CREDENTIAL_IDENTIFIER)
    const next = {
      ...current,
      inboxLibraryId: undefined,
      inboxName: undefined,
      inboxSecret: undefined,
      inboxPairCode: undefined,
      inboxPairExpiresAt: undefined,
    }
    currentSettings = next
    writeSanitizedSettings(next)
  })
}
