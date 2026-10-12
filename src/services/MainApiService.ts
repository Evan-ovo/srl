import { localCredentialStore, type LocalCredentialRepository } from './LocalCredentialStore'
import { requestMainApiText } from './MainApiTextTransport'
import {
  anthropicMessages,
  estimateMainApiTokens,
  estimateTextTokens,
  openAiMessages,
  normalizeDsmlToolReply,
  readNativeSearchResult,
  responseFinishReason,
  responseReasoningFromJson,
  responseTextFromJson,
  responseToolCalls,
  streamedReasoningFromEvent,
  streamedTextFromEvent,
  textOnly,
  tokenUsageFromJson,
} from './MainApiProtocol'
export { estimateMainApiTokens } from './MainApiProtocol'

export type MainApiProtocol = 'openai-compatible' | 'anthropic-compatible'
export type MainApiCredentialPersistence = 'local' | 'session'
export type MainApiReasoningEffort =
  'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface MainApiModelOption {
  id: string
  name: string
}

export interface MainApiConfig {
  protocol: MainApiProtocol
  url: string
  apiKey: string
  model: string
  stream: boolean
  reasoningEffort: MainApiReasoningEffort
  temperature: number
  topP: number
  maxTokens: number
  frequencyPenalty: number
  presencePenalty: number
}

export interface MainApiProfile extends MainApiConfig {
  id: string
  name: string
  credentialPersistence?: MainApiCredentialPersistence
}

export interface MainApiProfilesState {
  activeProfileId: string
  profiles: MainApiProfile[]
}

export interface MainApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | MainApiContentPart[]
  toolCalls?: MainApiToolCall[]
  toolCallId?: string
  toolError?: boolean
  /** Preserve signed Anthropic thinking blocks during a tool round trip. */
  providerContent?: Array<Record<string, unknown>>
  reasoning?: string
}

export interface MainApiToolCall {
  id: string
  name: string
  arguments: string
}

export interface MainApiTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: 'string'; description?: string; maxLength?: number }>
    required: string[]
    additionalProperties: false
  }
}

export type MainApiContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface MainApiTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: 'provider' | 'estimated'
}

export interface MainApiCompletionResult {
  sources?: Array<{ title: string; url: string }>
  text: string
  usage: MainApiTokenUsage
  reasoning?: string
  finishReason?: string
  toolCalls?: MainApiToolCall[]
  providerContent?: Array<Record<string, unknown>>
}

export interface MainApiRequestOptions {
  /** Query-only native search: Responses web_search or Anthropic server tool. */
  webSearch?: boolean
  /** Native function calling. Tool requests use complete JSON responses before execution. */
  tools?: readonly MainApiTool[]
  /** Per-request timeout; null disables the deadline. Does not affect saved API settings. */
  timeoutMs?: number | null
  /** Allows long-running callers to cancel the in-flight fetch immediately. */
  signal?: AbortSignal
  /** Opt-in native cancellation for complete-text batch jobs. */
  cancellableNative?: boolean
  /** Received text before parsing; used by editors to retain interrupted replies. */
  onText?: (text: string) => void
}

const MAIN_API_KEY = 'srl.mainApi.config.v1'
const MAIN_API_PROFILES_KEY = 'srl.mainApi.profiles.v2'
export const DEFAULT_MAIN_API_CONFIG: MainApiConfig = {
  protocol: 'openai-compatible',
  url: '',
  apiKey: '',
  model: '',
  stream: false,
  reasoningEffort: 'auto',
  temperature: 0.7,
  topP: 1,
  maxTokens: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
}

function normalizedReasoningEffort(value: unknown): MainApiReasoningEffort {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : 'auto'
}

function normalizedRequestTimeout(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return Math.max(1, Math.round(value))
}

function migrateLegacyConfig<T extends Partial<MainApiConfig>>(value: T): T {
  if (value.stream === undefined && value.reasoningEffort === undefined && value.maxTokens === 4096)
    return { ...value, maxTokens: 0 }
  return value
}

export function normalizedConfig(value?: Partial<MainApiConfig>): MainApiConfig {
  return {
    protocol:
      value?.protocol === 'anthropic-compatible' ? 'anthropic-compatible' : 'openai-compatible',
    url: String(value?.url ?? '').trim(),
    apiKey: String(value?.apiKey ?? '').trim(),
    model: String(value?.model ?? '').trim(),
    stream: value?.stream === true,
    reasoningEffort: normalizedReasoningEffort(value?.reasoningEffort),
    temperature: Math.min(2, Math.max(0, Number(value?.temperature ?? 0.7))),
    topP: Math.min(1, Math.max(0, Number(value?.topP ?? 1))),
    maxTokens: Number.isFinite(Number(value?.maxTokens))
      ? Math.max(0, Math.round(Number(value?.maxTokens)))
      : 0,
    frequencyPenalty: Math.min(2, Math.max(-2, Number(value?.frequencyPenalty ?? 0))),
    presencePenalty: Math.min(2, Math.max(-2, Number(value?.presencePenalty ?? 0))),
  }
}

function normalizedProfile(
  value: Partial<MainApiProfile> | undefined,
  fallbackId: string = crypto.randomUUID(),
  fallbackName = '主 API',
): MainApiProfile {
  const requestedId = String(value?.id ?? '').trim()
  return {
    id: /^[a-z0-9][a-z0-9._:-]{0,80}$/iu.test(requestedId) ? requestedId : fallbackId,
    name:
      String(value?.name ?? '')
        .trim()
        .slice(0, 40) || fallbackName,
    ...normalizedConfig(value),
    credentialPersistence: value?.credentialPersistence === 'session' ? 'session' : 'local',
  }
}

function defaultState(): MainApiProfilesState {
  return {
    activeProfileId: 'default',
    profiles: [normalizedProfile(undefined, 'default')],
  }
}

function endpointFor(config: MainApiConfig): string {
  const url = config.url.replace(/\/+$/g, '')
  if (!url) throw new Error('请先填写主 API 地址')
  if (config.protocol === 'anthropic-compatible') {
    return /\/messages$/i.test(url) ? url : `${url}/messages`
  }
  return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`
}

function modelsEndpointFor(config: MainApiConfig): string {
  const url = config.url
    .replace(/\/+$/g, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
  if (!url) throw new Error('请先填写主 API 地址')
  return /\/models$/i.test(url) ? url : `${url}/models`
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `${response.status} ${response.statusText}`.trim()
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string }
      message?: string
    }
    return parsed.error?.message || parsed.message || body.slice(0, 500)
  } catch {
    return body.slice(0, 500)
  }
}

export class MainApiService {
  private readonly credentialStore: LocalCredentialRepository
  private state: MainApiProfilesState
  private credentialWrites: Promise<void> = Promise.resolve()
  private credentialsInitialized = false

  constructor(credentialStore: LocalCredentialRepository = localCredentialStore) {
    this.credentialStore = credentialStore
    this.state = this.readProfilesState()
  }

  async initializeCredentials(): Promise<void> {
    if (this.credentialsInitialized) return
    const hydratedProfiles: MainApiProfile[] = []
    for (const profile of this.state.profiles) {
      const identifier = this.credentialIdentifier(profile.id)
      if (profile.credentialPersistence === 'session') {
        await this.credentialStore.clear(identifier)
        hydratedProfiles.push(profile)
        continue
      }
      if (profile.apiKey) {
        // 旧版明文只有在受保护存储成功后才会从 localStorage 删除。
        await this.credentialStore.save(identifier, profile.apiKey)
        hydratedProfiles.push(profile)
      } else {
        hydratedProfiles.push({
          ...profile,
          apiKey: await this.credentialStore.read(identifier),
        })
      }
    }
    this.state = { ...this.state, profiles: hydratedProfiles }
    this.credentialsInitialized = true
    this.writeProfilesState(this.state, false)
  }

  async awaitCredentialWrites(): Promise<void> {
    await this.credentialWrites
  }

  importProfilesState(value: MainApiProfilesState): MainApiProfilesState {
    const profiles = Array.isArray(value?.profiles)
      ? value.profiles.map((profile, index) =>
          normalizedProfile(profile, crypto.randomUUID(), `API ${index + 1}`),
        )
      : []
    if (!profiles.length) throw new Error('导入的主 API 配置为空或格式无效')
    const uniqueProfiles = profiles.reduce<MainApiProfile[]>((items, profile) => {
      if (items.some((item) => item.id === profile.id)) profile.id = crypto.randomUUID()
      items.push(profile)
      return items
    }, [])
    const activeProfileId = uniqueProfiles.some((profile) => profile.id === value.activeProfileId)
      ? value.activeProfileId
      : uniqueProfiles[0]!.id
    const state = { activeProfileId, profiles: uniqueProfiles }
    this.writeProfilesState(state)
    return state
  }

  getProfilesState(): MainApiProfilesState {
    return {
      activeProfileId: this.state.activeProfileId,
      profiles: this.state.profiles.map((profile) => ({ ...profile })),
    }
  }

  private readProfilesState(): MainApiProfilesState {
    try {
      const stored = JSON.parse(
        localStorage.getItem(MAIN_API_PROFILES_KEY) ?? 'null',
      ) as Partial<MainApiProfilesState> | null
      if (stored && Array.isArray(stored.profiles) && stored.profiles.length) {
        const seen = new Set<string>()
        const profiles = stored.profiles.map((profile, index) => {
          const normalized = normalizedProfile(
            migrateLegacyConfig(profile),
            crypto.randomUUID(),
            `API ${index + 1}`,
          )
          while (seen.has(normalized.id)) normalized.id = crypto.randomUUID()
          seen.add(normalized.id)
          return normalized
        })
        const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
          ? String(stored.activeProfileId)
          : profiles[0]!.id
        return { activeProfileId, profiles }
      }
    } catch {
      // 继续尝试读取旧版单配置。
    }
    try {
      const legacyRaw = localStorage.getItem(MAIN_API_KEY)
      if (legacyRaw) {
        const legacy = normalizedProfile(
          migrateLegacyConfig(JSON.parse(legacyRaw) as Partial<MainApiConfig>),
          'migrated-default',
          '原主 API',
        )
        const migrated = { activeProfileId: legacy.id, profiles: [legacy] }
        return migrated
      }
    } catch {
      // 损坏的本地配置回退为空白默认项。
    }
    return defaultState()
  }

  getProfiles(): MainApiProfile[] {
    return this.getProfilesState().profiles
  }

  getActiveProfile(): MainApiProfile {
    const state = this.getProfilesState()
    return (
      state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0]!
    )
  }

  getConfig(): MainApiConfig {
    return normalizedConfig(this.getActiveProfile())
  }

  saveConfig(config: MainApiConfig): MainApiConfig {
    const normalized = normalizedConfig(config)
    const active = this.getActiveProfile()
    this.saveProfile({ ...active, ...normalized })
    return normalized
  }

  createProfile(name = '新 API'): MainApiProfile {
    const state = this.getProfilesState()
    const profile = normalizedProfile(
      { ...DEFAULT_MAIN_API_CONFIG, name },
      crypto.randomUUID(),
      name,
    )
    this.writeProfilesState({
      activeProfileId: state.activeProfileId,
      profiles: [...state.profiles, profile],
    })
    return profile
  }

  saveProfile(profile: MainApiProfile): MainApiProfile {
    const state = this.getProfilesState()
    const normalized = normalizedProfile(profile, profile.id, profile.name)
    const index = state.profiles.findIndex((item) => item.id === normalized.id)
    const profiles =
      index >= 0
        ? state.profiles.map((item) => (item.id === normalized.id ? normalized : item))
        : [...state.profiles, normalized]
    this.writeProfilesState({
      activeProfileId: state.activeProfileId || normalized.id,
      profiles,
    })
    return normalized
  }

  setActiveProfile(profileId: string): MainApiProfile {
    const state = this.getProfilesState()
    const profile = state.profiles.find((item) => item.id === profileId)
    if (!profile) throw new Error('找不到要启用的 API 配置')
    this.writeProfilesState({ ...state, activeProfileId: profile.id })
    return profile
  }

  deleteProfile(profileId: string): MainApiProfile {
    const state = this.getProfilesState()
    if (state.profiles.length <= 1) throw new Error('至少保留一个 API 配置')
    const profiles = state.profiles.filter((profile) => profile.id !== profileId)
    if (profiles.length === state.profiles.length) throw new Error('找不到要删除的 API 配置')
    const activeProfileId =
      state.activeProfileId === profileId ? profiles[0]!.id : state.activeProfileId
    this.writeProfilesState({ activeProfileId, profiles })
    this.queueCredentialWrite(() =>
      this.credentialStore.clear(this.credentialIdentifier(profileId)),
    )
    return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]!
  }

  async testConnection(config = this.getConfig()): Promise<string> {
    const startedAt = performance.now()
    const text = await this.complete(
      [
        { role: 'system', content: '你是连接测试。' },
        { role: 'user', content: '只回复 OK' },
      ],
      { ...config, maxTokens: 8, temperature: 0 },
    )
    const latency = Math.round(performance.now() - startedAt)
    return `连接成功 · ${config.model || '服务端默认模型'} · ${latency} ms · ${text.trim().slice(0, 20)}`
  }

  async listModels(config = this.getConfig()): Promise<MainApiModelOption[]> {
    const normalized = normalizedConfig(config)
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(modelsEndpointFor(normalized), {
        headers:
          normalized.protocol === 'anthropic-compatible'
            ? {
                'anthropic-version': '2023-06-01',
                ...(normalized.apiKey ? { 'x-api-key': normalized.apiKey } : {}),
              }
            : normalized.apiKey
              ? { Authorization: `Bearer ${normalized.apiKey}` }
              : {},
        signal: controller.signal,
      })
      if (!response.ok)
        throw new Error(`模型列表返回 ${response.status}：${await readError(response)}`)
      const body = (await response.json()) as
        | Array<Record<string, unknown>>
        | { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> }
      const entries = Array.isArray(body) ? body : (body.data ?? body.models ?? [])
      const seen = new Set<string>()
      return entries
        .map((item) => {
          const id = String(item.id ?? item.model ?? '').trim()
          const name = String(item.display_name ?? item.name ?? id).trim() || id
          return { id, name }
        })
        .filter((item) => {
          if (!item.id || seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
        .sort((left, right) => left.id.localeCompare(right.id))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        throw new Error('拉取模型超过 30 秒，已取消', { cause: error })
      if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
        throw new Error(
          '无法拉取模型列表。该服务可能未开放 /models，或网页端被 CORS 拦截；仍可手动填写模型名。',
          { cause: error },
        )
      }
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  async complete(
    messages: MainApiMessage[],
    override?: Partial<MainApiConfig>,
    options?: MainApiRequestOptions,
  ): Promise<string> {
    return (await this.completeWithUsage(messages, override, options)).text
  }

  async completeWithUsage(
    messages: MainApiMessage[],
    override?: Partial<MainApiConfig>,
    options?: MainApiRequestOptions,
  ): Promise<MainApiCompletionResult> {
    const config = normalizedConfig({
      ...this.getConfig(),
      ...override,
      ...(options?.tools?.length || options?.webSearch ? { stream: false } : {}),
    })
    if (!config.model) throw new Error('请先填写模型名称')
    const timeoutMs = normalizedRequestTimeout(options?.timeoutMs)
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(options?.signal?.reason)
    if (options?.signal?.aborted) abortFromCaller()
    else options?.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout =
      timeoutMs === null ? undefined : globalThis.setTimeout(() => controller.abort(), timeoutMs)
    try {
      if (
        options?.webSearch &&
        (options.tools?.length ||
          messages.some((message) => message.role === 'tool' || message.toolCalls?.length))
      )
        throw new Error('原生搜索仅接收独立查询，不与客户端工具回合混合')
      const response = options?.webSearch
        ? await this.requestWebSearch(config, messages, controller.signal)
        : config.protocol === 'anthropic-compatible'
          ? await this.requestAnthropic(
              config,
              messages,
              controller.signal,
              options?.tools,
              options?.cancellableNative,
            )
          : await this.requestOpenAi(
              config,
              messages,
              controller.signal,
              options?.tools,
              options?.cancellableNative,
            )
      if (!response.ok) throw new Error(`API 返回 ${response.status}：${await readError(response)}`)
      const result = config.stream
        ? await this.readStream(response, config.protocol, options?.onText)
        : (() => {
            return response.json().then((rawBody) => {
              const body = rawBody as Record<string, unknown>
              if (options?.webSearch) return readNativeSearchResult(body, config.protocol)
              const text = responseTextFromJson(body, config.protocol)
              const toolCalls = responseToolCalls(body, config.protocol)
              const completion =
                config.protocol === 'openai-compatible'
                  ? normalizeDsmlToolReply(text, toolCalls, options?.tools ?? [])
                  : { text, toolCalls }
              return {
                sources: undefined,
                ...completion,
                usage: tokenUsageFromJson(body, config.protocol),
                reasoning: responseReasoningFromJson(body, config.protocol),
                finishReason: responseFinishReason(body, config.protocol),
                providerContent:
                  config.protocol === 'anthropic-compatible' && Array.isArray(body.content)
                    ? (body.content as Array<Record<string, unknown>>)
                    : undefined,
              }
            })
          })()
      const { text, usage, reasoning, finishReason, toolCalls, providerContent, sources } =
        await result
      if (!config.stream) options?.onText?.(text)
      if (text || toolCalls?.length) {
        const estimatedInput =
          estimateMainApiTokens(messages) +
          (options?.tools?.length ? estimateTextTokens(JSON.stringify(options.tools)) : 0)
        const estimatedOutput = estimateTextTokens(
          text + (toolCalls?.length ? JSON.stringify(toolCalls) : ''),
        )
        const normalizedUsage: MainApiTokenUsage = usage
          ? { ...usage, source: 'provider' }
          : {
              inputTokens: estimatedInput,
              outputTokens: estimatedOutput,
              totalTokens: estimatedInput + estimatedOutput,
              source: 'estimated',
            }
        return {
          text,
          ...(sources?.length ? { sources } : {}),
          usage: normalizedUsage,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...(toolCalls?.length ? { toolCalls } : {}),
          ...(providerContent && toolCalls?.length ? { providerContent } : {}),
        }
      }
      throw new Error('API 已响应，但没有返回可读取的文本内容')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (options?.signal?.aborted) throw new DOMException('API 请求已由用户取消', 'AbortError')
        if (timeoutMs === null) throw new Error('API 请求已中断', { cause: error })
        throw new Error(`API 请求超过 ${Math.ceil(timeoutMs / 1000)} 秒，已取消`, {
          cause: error,
        })
      }
      if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
        throw new Error(
          '无法连接该 API。网页端要求接口允许浏览器 CORS；APK 会通过原生 HTTP 通道请求，不受浏览器 CORS 限制。',
          { cause: error },
        )
      }
      throw error
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private requestWebSearch(
    config: MainApiConfig,
    messages: MainApiMessage[],
    signal: AbortSignal,
  ): Promise<Response> {
    const anthropic = config.protocol === 'anthropic-compatible'
    if (anthropic && config.maxTokens <= 0)
      throw new Error('Anthropic Messages 协议要求明确填写输出 Token 上限，不能留空')
    const base = config.url
      .replace(/\/+$/u, '')
      .replace(/\/chat\/completions$/iu, '')
      .replace(/\/responses$/iu, '')
    const url = anthropic ? endpointFor(config) : `${base}/responses`
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anthropic
          ? {
              'anthropic-version': '2023-06-01',
              ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
            }
          : config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
      },
      body: JSON.stringify(
        anthropic
          ? {
              model: config.model,
              system: messages
                .filter((message) => message.role === 'system')
                .map((message) => textOnly(message.content))
                .join('\n'),
              messages: anthropicMessages(messages),
              stream: false,
              max_tokens: config.maxTokens,
              tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
            }
          : {
              model: config.model,
              input: openAiMessages(messages),
              stream: false,
              store: false,
              tools: [{ type: 'web_search', search_context_size: 'low' }],
              tool_choice: 'required',
              max_tool_calls: 3,
              ...(config.maxTokens > 0 ? { max_output_tokens: config.maxTokens } : {}),
            },
      ),
      signal,
    })
  }

  private requestOpenAi(
    config: MainApiConfig,
    messages: MainApiMessage[],
    signal: AbortSignal,
    tools?: readonly MainApiTool[],
    cancellableNative = false,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      model: config.model,
      // Older plain-text chat has no recoverable thinking. Include the empty
      // protocol field for DeepSeek tools; never fabricate the lost content.
      messages: openAiMessages(
        messages,
        /^https:\/\/api\.deepseek\.com(?:\/|$)/iu.test(config.url) &&
          Boolean(tools?.length || messages.some((message) => message.toolCalls?.length)),
      ),
      temperature: config.temperature,
      top_p: config.topP,
      stream: config.stream,
      frequency_penalty: config.frequencyPenalty,
      presence_penalty: config.presencePenalty,
    }
    if (tools?.length) {
      body.tools = tools.map((tool) => ({ type: 'function', function: { ...tool, strict: true } }))
      body.tool_choice = 'auto'
      body.parallel_tool_calls = false
    }
    if (config.maxTokens > 0) body.max_tokens = config.maxTokens
    if (config.reasoningEffort !== 'auto') body.reasoning_effort = config.reasoningEffort
    return requestMainApiText(
      endpointFor(config),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      },
      cancellableNative && !config.stream,
    )
  }

  private requestAnthropic(
    config: MainApiConfig,
    messages: MainApiMessage[],
    signal: AbortSignal,
    tools?: readonly MainApiTool[],
    cancellableNative = false,
  ): Promise<Response> {
    if (config.maxTokens <= 0)
      throw new Error('Anthropic Messages 协议要求明确填写输出 Token 上限，不能留空')
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => textOnly(message.content))
      .join('\n\n')
    return requestMainApiText(
      endpointFor(config),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          system,
          messages: anthropicMessages(messages),
          ...(tools?.length
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters,
                })),
                tool_choice: { type: 'auto', disable_parallel_tool_use: true },
              }
            : {}),
          temperature: config.temperature,
          top_p: config.topP,
          max_tokens: config.maxTokens,
          stream: config.stream,
        }),
        signal,
      },
      cancellableNative && !config.stream,
    )
  }

  private async readStream(
    response: Response,
    protocol: MainApiProtocol,
    onText?: (text: string) => void,
  ): Promise<{
    text: string
    usage?: Omit<MainApiTokenUsage, 'source'>
    reasoning?: string
    finishReason?: string
    toolCalls?: MainApiToolCall[]
    providerContent?: Array<Record<string, unknown>>
    sources?: Array<{ title: string; url: string }>
  }> {
    if (!response.body) throw new Error('API 声称使用流式传输，但没有返回可读取的数据流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let output = ''
    let reasoning = ''
    let hasReasoning = false
    let terminated = false
    let finishReason: string | undefined
    let usage: Omit<MainApiTokenUsage, 'source'> | undefined
    const consume = (block: string): boolean => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) return false
      if (data.trim() === '[DONE]') {
        terminated = true
        return true
      }
      try {
        const body = JSON.parse(data) as Record<string, unknown>
        output += streamedTextFromEvent(body, protocol)
        const reasoningDelta = streamedReasoningFromEvent(body, protocol)
        if (reasoningDelta !== undefined) {
          hasReasoning = true
          reasoning += reasoningDelta
        }
        finishReason = responseFinishReason(body, protocol) ?? finishReason
        if (body.type === 'message_stop') terminated = true
        const eventUsage = tokenUsageFromJson(body, protocol)
        if (eventUsage) {
          usage = {
            inputTokens: Math.max(usage?.inputTokens ?? 0, eventUsage.inputTokens),
            outputTokens: Math.max(usage?.outputTokens ?? 0, eventUsage.outputTokens),
            totalTokens: Math.max(
              usage?.totalTokens ?? 0,
              eventUsage.totalTokens,
              Math.max(usage?.inputTokens ?? 0, eventUsage.inputTokens) +
                Math.max(usage?.outputTokens ?? 0, eventUsage.outputTokens),
            ),
          }
        }
      } catch {
        // 部分兼容接口会混入心跳或非 JSON 事件，忽略后继续读取。
      }
      onText?.(output)
      return false
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() ?? ''
        if (blocks.some(consume)) break
        if (done) {
          if (buffer.trim()) consume(buffer)
          break
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    return {
      text: output,
      usage,
      ...(hasReasoning ? { reasoning } : {}),
      finishReason: finishReason ?? (terminated ? 'stop' : 'incomplete'),
    }
  }

  private writeProfilesState(state: MainApiProfilesState, persistCredentials = true): void {
    this.state = {
      activeProfileId: state.activeProfileId,
      profiles: state.profiles.map((profile) => ({ ...profile })),
    }
    const portableState = {
      activeProfileId: state.activeProfileId,
      profiles: state.profiles.map((profile) => ({ ...profile, apiKey: '' })),
    }
    localStorage.setItem(MAIN_API_PROFILES_KEY, JSON.stringify(portableState))
    localStorage.removeItem(MAIN_API_KEY)
    if (!persistCredentials || !this.credentialsInitialized) return
    for (const profile of state.profiles) {
      const identifier = this.credentialIdentifier(profile.id)
      this.queueCredentialWrite(() =>
        profile.credentialPersistence === 'session' || !profile.apiKey
          ? this.credentialStore.clear(identifier)
          : this.credentialStore.save(identifier, profile.apiKey),
      )
    }
  }

  private credentialIdentifier(profileId: string): string {
    return `main-api:${profileId.toLowerCase()}`
  }

  private queueCredentialWrite(operation: () => Promise<void>): void {
    if (!this.credentialsInitialized) return
    const next = this.credentialWrites.catch(() => undefined).then(operation)
    this.credentialWrites = next
  }
}
