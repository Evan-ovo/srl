import { normalizedConfig, type MainApiConfig, type MainApiService } from './MainApiService'
import { localCredentialStore, type LocalCredentialRepository } from './LocalCredentialStore'
import type {
  AssistantTurn,
  AssistantImage,
  AssistantDesignReference,
} from './ProductAssistantService'
import type { AssistantAppDraft } from './ProductAssistantAppSession'
import {
  normalizeAssistantPromptOverrides,
  type AssistantPromptOverrides,
  type AssistantMode,
} from '../core/ProductAssistantKnowledge'
import type { AssistantContextSummary } from './ProductAssistantContext'
import {
  normalizeAssistantToolCallLimit,
  MAX_ASSISTANT_TOOL_CALL_LIMIT,
} from './ProductAssistantTools'
import { taskCenter } from '../core/TaskCenter'
import { normalizeAssistantTaskTemplate } from './ProductAssistantTask'
import type { AssistantCapability } from './ProductAssistantTools'
import type { AssistantReferenceResource } from './ProductAssistantReferences'

export interface AssistantHistoryRecoveryResult {
  scanned: number
  total: number
  recovered: number
  repaired: number
  conflicts: number
  invalid: number
  missingProjects: number
  cancelled: boolean
}
export interface AssistantHistoryRecoveryOptions {
  signal?: AbortSignal
  onProgress?: (result: AssistantHistoryRecoveryResult) => void
}

export const DEFAULT_ASSISTANT_AVATAR = '/icons/assistant-avatar.png'
export interface AssistantMemory {
  id: string
  scope: 'all' | 'appearance' | 'features' | 'creation'
  text: string
}
export interface AssistantMessageMatch {
  conversationId: string
  title: string
  turnId?: string
  text: string
  updatedAt: number
  favorite?: boolean
}
export interface AssistantPreferences {
  name: string
  avatar: string
  apiProfileId: string
  networkEnabled?: boolean
  toolCallingEnabled?: boolean
  allowPageScripts?: boolean
  toolCallLimit?: number
  providerSearch?: boolean
  githubReadWithoutConfirmation?: boolean
  githubReadPersistence?: 'local' | 'session'
  mode?: AssistantMode
  promptOverrides?: AssistantPromptOverrides
  desktopPet?: boolean
  petAssetMode?: 'images' | 'svg'
  aiPetExpressions?: boolean
  allowScreenshots?: boolean
  petWalkingAnimation?: boolean
  autoCompressContext?: boolean
  estimateInputTokens?: boolean
  compressionTokenThreshold?: number
  petPosition?: { x: number; y: number }
}
export interface AssistantConversation {
  id: string
  title: string
  customTitle?: string
  updatedAt: number
  history: AssistantTurn[]
  input: string
  images: AssistantImage[]
  designReferences?: AssistantDesignReference[]
  draft?: AssistantAppDraft
  projectId?: string
  projectVersion?: number
  contextSummary?: AssistantContextSummary
  taskSkill?: AssistantTaskTemplate
  referenceResources?: AssistantReferenceResource[]
}
export interface AssistantProjectReference {
  projectId: string
  projectVersion: number
}
export interface AssistantProjectSummary {
  id: string
  name: string
  updatedAt: number
  version: number
}
export interface AssistantProject extends AssistantProjectSummary {
  draft: AssistantAppDraft
}
export interface AssistantTaskTemplate {
  id: string
  name: string
  steps: string[]
  description?: string
  mode?: AssistantMode
  capabilities?: AssistantCapability[]
  version?: number
}
export type AssistantConversationChangeListener = (
  conversation: AssistantConversation,
  sourceId?: string,
) => void
export type AssistantConversationActivityListener = (
  conversationId: string,
  sourceId: string,
  active: boolean,
) => void
export type AssistantConversationSummary = Pick<
  AssistantConversation,
  'id' | 'title' | 'customTitle' | 'updatedAt'
>
export interface ProductAssistantStorage {
  recoverHistory(options: AssistantHistoryRecoveryOptions): Promise<AssistantHistoryRecoveryResult>
  preferences(): Promise<AssistantPreferences | undefined>
  savePreferences(value: AssistantPreferences): Promise<void>
  active(): Promise<string | undefined>
  read(id: string): Promise<AssistantConversation | undefined>
  save(
    value: AssistantConversation,
    activate?: boolean,
  ): Promise<AssistantProjectReference | undefined>
  project(id: string): Promise<AssistantProject | undefined>
  projects(
    offset: number,
    limit: number,
  ): Promise<{ items: AssistantProjectSummary[]; total: number }>
  templates(): Promise<AssistantTaskTemplate[]>
  putTemplate(value: AssistantTaskTemplate): Promise<void>
  removeTemplate(id: string): Promise<void>
  list(
    offset: number,
    limit: number,
  ): Promise<{ items: AssistantConversationSummary[]; total: number }>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  memories(): Promise<AssistantMemory[]>
  saveMemories(value: AssistantMemory[]): Promise<void>
  search(
    query: string,
    favorites: boolean,
    offset: number,
    limit: number,
  ): Promise<{
    items: AssistantMessageMatch[]
    total: number
  }>
}
const credentialId = 'product-assistant:custom-api'
const githubCredentialId = 'product-assistant:github-read'
export function newAssistantConversation(): AssistantConversation {
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    updatedAt: Date.now(),
    history: [],
    input: '',
    images: [],
  }
}
export class ProductAssistantWorkspaceService {
  private readonly storage: ProductAssistantStorage
  private readonly credentials: LocalCredentialRepository
  private readonly api: MainApiService
  private preferencesValue: AssistantPreferences = {
    name: '蒜惹菈',
    avatar: DEFAULT_ASSISTANT_AVATAR,
    apiProfileId: '',
    mode: 'auto',
    toolCallingEnabled: true,
    allowPageScripts: false,
    toolCallLimit: normalizeAssistantToolCallLimit(),
    githubReadWithoutConfirmation: false,
    desktopPet: false,
    aiPetExpressions: false,
    allowScreenshots: true,
    petWalkingAnimation: true,
    autoCompressContext: false,
    estimateInputTokens: false,
  }
  private githubSessionToken = ''
  private writes: Promise<void> = Promise.resolve()
  private historyRecovery?: Promise<AssistantHistoryRecoveryResult>
  private initialized = false
  private initializing?: Promise<void>
  private readonly preferenceListeners = new Set<(value: AssistantPreferences) => void>()
  private readonly conversationListeners = new Set<AssistantConversationChangeListener>()
  private readonly activityListeners = new Set<AssistantConversationActivityListener>()
  private readonly activeConversations = new Map<string, string>()
  private memoriesValue: AssistantMemory[] = []
  constructor(
    storage: ProductAssistantStorage,
    api: MainApiService,
    credentials: LocalCredentialRepository = localCredentialStore,
  ) {
    this.storage = storage
    this.api = api
    this.credentials = credentials
  }
  async initialize(): Promise<AssistantConversation> {
    await this.initializePreferences()
    const id = await this.storage.active()
    const current = id ? await this.storage.read(id) : undefined
    if (current) return current
    const created = newAssistantConversation()
    await this.storage.save(created, true)
    return created
  }
  async loadPreferences(): Promise<AssistantPreferences> {
    await this.initializePreferences()
    return this.preferences()
  }
  onPreferencesChange(listener: (value: AssistantPreferences) => void): () => void {
    this.preferenceListeners.add(listener)
    return () => this.preferenceListeners.delete(listener)
  }
  onConversationChange(listener: AssistantConversationChangeListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }
  onConversationActivityChange(listener: AssistantConversationActivityListener): () => void {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }
  setConversationActivity(conversationId: string, sourceId: string, active: boolean): boolean {
    if (!conversationId || !sourceId) return false
    const owner = this.activeConversations.get(conversationId)
    if (active && owner && owner !== sourceId) return false
    if (active) this.activeConversations.set(conversationId, sourceId)
    else if (owner === sourceId) this.activeConversations.delete(conversationId)
    else return true
    for (const listener of this.activityListeners) listener(conversationId, sourceId, active)
    return true
  }
  conversationActivityOwner(conversationId: string): string | undefined {
    return this.activeConversations.get(conversationId)
  }
  private async initializePreferences(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing
    this.initializing = this.readPreferences()
    try {
      await this.initializing
    } finally {
      this.initializing = undefined
    }
  }
  private async readPreferences(): Promise<void> {
    if (!this.initialized) {
      await this.api.initializeCredentials()
      const stored = await this.storage.preferences()
      this.memoriesValue = await this.storage.memories()
      if (stored) {
        const threshold =
          'compressionTokenThreshold' in stored
            ? stored.compressionTokenThreshold
            : (stored as AssistantPreferences & { contextTokenLimit?: number }).contextTokenLimit
        this.preferencesValue = {
          name: stored.name || '蒜惹菈',
          promptOverrides: normalizeAssistantPromptOverrides(stored.promptOverrides),
          avatar: stored.avatar || DEFAULT_ASSISTANT_AVATAR,
          apiProfileId: stored.apiProfileId || '',
          mode: ['auto', 'appearance', 'features', 'creation'].includes(stored.mode ?? '')
            ? stored.mode
            : 'auto',
          networkEnabled: stored.networkEnabled === true,
          toolCallingEnabled: stored.toolCallingEnabled !== false,
          allowPageScripts: stored.allowPageScripts === true,
          toolCallLimit: normalizeAssistantToolCallLimit(stored.toolCallLimit),
          providerSearch: stored.providerSearch === true,
          githubReadWithoutConfirmation: stored.githubReadWithoutConfirmation === true,
          githubReadPersistence: stored.githubReadPersistence === 'session' ? 'session' : 'local',
          desktopPet: stored.desktopPet === true,
          petAssetMode:
            stored.petAssetMode === 'images'
              ? 'images'
              : stored.petAssetMode === 'svg'
                ? 'svg'
                : undefined,
          aiPetExpressions: stored.aiPetExpressions === true,
          allowScreenshots: stored.allowScreenshots !== false,
          petWalkingAnimation: stored.petWalkingAnimation !== false,
          autoCompressContext: stored.autoCompressContext === true,
          estimateInputTokens: stored.estimateInputTokens === true,
          compressionTokenThreshold:
            Number.isSafeInteger(threshold) && threshold! > 0 ? threshold : undefined,
          petPosition: stored.petPosition,
        }
        // Upgrade the earlier local preview through the existing API profile owner.
        const legacy = stored as AssistantPreferences & {
          customApi?: MainApiConfig
          credentialPersistence?: 'local' | 'session'
        }
        if (legacy.customApi?.url && legacy.customApi.model && !stored.apiProfileId) {
          const config = normalizedConfig(legacy.customApi)
          if (legacy.credentialPersistence !== 'session')
            config.apiKey = await this.credentials.read(credentialId)
          await this.importApiProfile(config, legacy.credentialPersistence)
          await this.credentials.clear(credentialId)
        }
      }
      this.initialized = true
    }
  }
  async importCustomConfiguration(
    value: MainApiConfig,
    persistence: 'local' | 'session' = 'local',
  ): Promise<void> {
    await this.initializePreferences()
    await this.importApiProfile(value, persistence)
  }
  private async importApiProfile(value: MainApiConfig, persistence: 'local' | 'session' = 'local') {
    const profile = this.api.saveProfile({
      ...normalizedConfig(value),
      id: 'product-assistant',
      name: '助手 API',
      credentialPersistence: persistence,
    })
    await this.api.awaitCredentialWrites()
    await this.savePreferences({ ...this.preferences(), apiProfileId: profile.id })
  }
  preferences(): AssistantPreferences {
    const value = structuredClone(this.preferencesValue)
    if (!this.api.getProfiles().some((profile) => profile.id === value.apiProfileId))
      value.apiProfileId = ''
    return value
  }
  config(fallback: MainApiConfig): MainApiConfig {
    const id = this.preferencesValue.apiProfileId
    if (!id) return { ...fallback }
    const api = this.api.getProfilesState().profiles.find((profile) => profile.id === id)
    if (!api) return { ...fallback }
    if (!api.url || !api.model) throw new Error('请填写助手 API 地址和模型，或选择使用主 API')
    return normalizedConfig(api)
  }
  async reloadImportedPreferences(): Promise<void> {
    await this.initializing
    this.initialized = false
    await this.initializePreferences()
    for (const listener of this.preferenceListeners) listener(this.preferences())
  }
  async exportPortableGitHubCredential(): Promise<string | undefined> {
    await this.initializePreferences()
    return this.preferencesValue.githubReadPersistence === 'session'
      ? undefined
      : (await this.credentials.read(githubCredentialId)) || undefined
  }
  async importPortableGitHubCredential(token: string): Promise<void> {
    await this.initializePreferences()
    await this.savePreferences({ ...this.preferencesValue, githubReadPersistence: 'local' }, token)
  }
  async readGitHubCredential(): Promise<string> {
    await this.initializePreferences()
    return this.preferencesValue.githubReadPersistence === 'session'
      ? this.githubSessionToken
      : this.credentials.read(githubCredentialId)
  }
  async savePreferences(
    value: AssistantPreferences,
    githubToken?: string,
  ): Promise<AssistantPreferences> {
    const next: AssistantPreferences = {
      name: value.name.trim().slice(0, 40) || '蒜惹菈',
      promptOverrides: normalizeAssistantPromptOverrides(value.promptOverrides),
      avatar: value.avatar.trim() || DEFAULT_ASSISTANT_AVATAR,
      apiProfileId: value.apiProfileId || '',
      mode: value.mode || 'auto',
      networkEnabled: value.networkEnabled === true,
      toolCallingEnabled: value.toolCallingEnabled !== false,
      allowPageScripts: value.allowPageScripts === true,
      toolCallLimit:
        (value.toolCallLimit as unknown) === '' || value.toolCallLimit == null
          ? undefined
          : value.toolCallLimit,
      providerSearch: value.providerSearch === true,
      githubReadWithoutConfirmation: value.githubReadWithoutConfirmation === true,
      githubReadPersistence:
        value.githubReadPersistence === 'session' ? ('session' as const) : ('local' as const),
      desktopPet: value.desktopPet === true,
      petAssetMode:
        value.petAssetMode === 'images'
          ? 'images'
          : value.petAssetMode === 'svg'
            ? 'svg'
            : undefined,
      aiPetExpressions: value.aiPetExpressions === true,
      allowScreenshots: value.allowScreenshots !== false,
      petWalkingAnimation: value.petWalkingAnimation !== false,
      autoCompressContext: value.autoCompressContext === true,
      estimateInputTokens: value.estimateInputTokens === true,
      compressionTokenThreshold:
        (value.compressionTokenThreshold as unknown) === '' ||
        value.compressionTokenThreshold == null
          ? undefined
          : value.compressionTokenThreshold,
      ...(value.petPosition
        ? { petPosition: { x: value.petPosition.x, y: value.petPosition.y } }
        : {}),
    }
    if (!['auto', 'appearance', 'features', 'creation'].includes(next.mode ?? 'auto'))
      throw new Error('助手模式无效')
    if (next.toolCallLimit !== normalizeAssistantToolCallLimit(next.toolCallLimit))
      throw new Error(`工具调用上限需为 1–${MAX_ASSISTANT_TOOL_CALL_LIMIT} 的整数`)
    if (
      next.compressionTokenThreshold !== undefined &&
      (!Number.isSafeInteger(next.compressionTokenThreshold) || next.compressionTokenThreshold <= 0)
    )
      throw new Error('压缩阈值需为正整数，或留空不自动压缩')
    if (
      next.petPosition &&
      Object.values(next.petPosition).some(
        (position) => !Number.isFinite(position) || position < 0 || position > 1,
      )
    )
      throw new Error('桌宠位置无效')
    if (!(
      next.avatar === DEFAULT_ASSISTANT_AVATAR ||
      /^https?:\/\//iu.test(next.avatar) ||
      /^data:image\/(?:png|jpeg|webp);base64,/u.test(next.avatar)
    ))
      throw new Error('头像请使用图片或 HTTP / HTTPS 地址')
    if (next.avatar.length > 6_000_000) throw new Error('头像不能超过 4 MB')
    if (
      next.apiProfileId &&
      !this.api.getProfilesState().profiles.some((p) => p.id === next.apiProfileId)
    )
      throw new Error('这套 API 配置已不存在，请重新选择')
    if (
      githubToken !== undefined &&
      ((!/^(?:github_pat_|ghp_)[A-Za-z0-9_]+$/u.test(githubToken.trim()) &&
        githubToken.trim() !== '') ||
        githubToken.length > 4096)
    )
      throw new Error('GitHub 令牌格式无效')
    if (
      githubToken === undefined &&
      next.githubReadPersistence !== (this.preferencesValue.githubReadPersistence || 'local')
    )
      throw new Error('请先载入GitHub 令牌，再修改保存方式')
    const key = githubToken?.trim()
    const previousLocal =
      key === undefined ? undefined : await this.credentials.read(githubCredentialId)
    if (key !== undefined) {
      if (next.githubReadPersistence === 'local' && key)
        await this.credentials.save(githubCredentialId, key)
      else await this.credentials.clear(githubCredentialId)
    }
    try {
      await this.storage.savePreferences(next)
    } catch (cause) {
      if (previousLocal !== undefined) {
        try {
          if (previousLocal) await this.credentials.save(githubCredentialId, previousLocal)
          else await this.credentials.clear(githubCredentialId)
        } catch {
          throw new Error('设置保存失败，GitHub 令牌恢复失败，请重新核对密钥')
        }
      }
      throw cause
    }
    if (key !== undefined)
      this.githubSessionToken = next.githubReadPersistence === 'session' ? key : ''
    this.preferencesValue = next
    for (const listener of this.preferenceListeners) listener(this.preferences())
    return this.preferences()
  }
  save(
    value: AssistantConversation,
    activate = false,
    sourceId?: string,
  ): Promise<AssistantProjectReference | undefined> {
    // Capture immediately: later chat edits must not change a queued write.
    const snapshot = JSON.parse(JSON.stringify(value)) as AssistantConversation
    snapshot.updatedAt = Date.now()
    snapshot.title =
      snapshot.customTitle ||
      snapshot.history.find((turn) => turn.role === 'user')?.text.slice(0, 36) ||
      snapshot.draft?.manifest.name ||
      '新对话'
    // The snapshot already owns its content; only persisted tool states differ from live views.
    const storedSnapshot = {
      ...snapshot,
      history: snapshot.history.map((turn) => ({
        ...turn,
        ...(turn.toolCalls
          ? {
              toolCalls: turn.toolCalls.map((call) =>
                call.state === 'running' ? { ...call, state: 'cancelled' as const } : call,
              ),
            }
          : {}),
      })),
    }
    const result = this.writes.then(async () => {
      const reference = await this.storage.save(storedSnapshot, activate)
      for (const listener of this.conversationListeners)
        listener(structuredClone(snapshot), sourceId)
      return reference
    })
    this.writes = result.then(
      () => {},
      () => {},
    )
    return result
  }
  async flush(): Promise<void> {
    await this.writes
  }
  async switch(id: string): Promise<AssistantConversation> {
    await this.flush()
    const value = await this.storage.read(id)
    if (!value) throw new Error('这条对话已不存在')
    const reference = await this.save(value, true)
    return { ...value, ...reference }
  }
  async continueDiscordSetupConversation(id: string): Promise<AssistantConversation> {
    if (!/^[\w-]{1,100}$/u.test(id)) throw new Error('网页协助对话标识无效')
    await this.flush()
    const value = (await this.storage.read(id)) ?? {
      ...newAssistantConversation(),
      id,
      customTitle: 'Discord Bridge 网页协助',
    }
    const reference = await this.save(value, true)
    return { ...value, ...reference }
  }
  list(offset = 0) {
    return this.storage.list(Math.max(0, offset), 20)
  }
  recoverHistory(
    options: AssistantHistoryRecoveryOptions = {},
  ): Promise<AssistantHistoryRecoveryResult> {
    if (this.historyRecovery) return this.historyRecovery
    const controller = new AbortController()
    const stop = () => controller.abort()
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
    const operationId = taskCenter.start({
      name: '找回蒜惹菈历史',
      cancelable: true,
      cancel: async () => {
        stop()
        await this.historyRecovery?.catch(() => {})
      },
    })
    const run = this.writes.then(async () => {
      try {
        const result = await this.storage.recoverHistory({
          signal: controller.signal,
          onProgress: (progress) => {
            taskCenter.update(operationId, {
              phase: `已找回 ${progress.recovered} 条，修复列表 ${progress.repaired} 条`,
              itemProgress: { completed: progress.scanned, total: progress.total },
            })
            options.onProgress?.(progress)
          },
        })
        if (result.cancelled) taskCenter.cancelled(operationId)
        else taskCenter.complete(operationId)
        return result
      } catch (cause) {
        taskCenter.fail(operationId, cause)
        throw cause
      } finally {
        options.signal?.removeEventListener('abort', stop)
        this.historyRecovery = undefined
      }
    })
    this.historyRecovery = run
    // Recovery and autosaves use the same writer queue; each record still commits atomically.
    this.writes = run.then(
      () => {},
      () => {},
    )
    return run
  }
  async projects(offset = 0) {
    await this.flush()
    return this.storage.projects(Math.max(0, offset), 20)
  }
  async continueProject(id: string): Promise<AssistantConversation> {
    await this.flush()
    const project = await this.storage.project(id)
    if (!project) throw new Error('项目已不存在，当前聊天保留')
    const chat = {
      ...newAssistantConversation(),
      projectId: project.id,
      projectVersion: project.version,
      draft: project.draft,
    }
    await this.save(chat, true)
    return chat
  }
  templates(): Promise<AssistantTaskTemplate[]> {
    return this.storage.templates()
  }
  async saveTemplate(value: AssistantTaskTemplate): Promise<void> {
    const next = normalizeAssistantTaskTemplate(value)
    await this.storage.putTemplate(next)
  }
  removeTemplate(id: string): Promise<void> {
    return this.storage.removeTemplate(id)
  }
  templateText(value: AssistantTaskTemplate): string {
    return `${value.name}\n${value.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`
  }
  memories(mode: AssistantMode = 'auto'): AssistantMemory[] {
    return structuredClone(
      this.memoriesValue.filter(
        (item) => mode === 'auto' || item.scope === 'all' || item.scope === mode,
      ),
    )
  }
  async saveMemories(value: AssistantMemory[]): Promise<AssistantMemory[]> {
    if (value.length > 20) throw new Error('最多保存 20 条偏好')
    const next = value.map((item) => ({ id: item.id, scope: item.scope, text: item.text.trim() }))
    if (
      new Set(next.map((item) => item.id)).size !== next.length ||
      next.some(
        (item) =>
          !item.id ||
          !['all', 'appearance', 'features', 'creation'].includes(item.scope) ||
          !item.text ||
          item.text.length > 500,
      )
    )
      throw new Error('每条偏好需为 1–500 个字，类型和标识不可重复或无效')
    await this.storage.saveMemories(next)
    this.memoriesValue = next
    return this.memories()
  }
  async search(query: string, favorites = false, offset = 0) {
    await this.flush()
    return this.storage.search(query.trim().slice(0, 100), favorites, Math.max(0, offset), 20)
  }
  rename(id: string, title: string): Promise<void> {
    const name = title.trim()
    if (!name || name.length > 60) return Promise.reject(new Error('对话名称需为 1–60 个字'))
    const result = this.writes.then(() => this.storage.rename(id, name))
    this.writes = result.catch(() => {})
    return result
  }
  async remove(id: string): Promise<void> {
    await this.flush()
    await this.storage.remove(id)
  }
}
