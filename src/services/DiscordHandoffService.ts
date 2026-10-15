import { normalizeDiscordWorkerBaseUrl } from './DiscordSourceConnectionService'
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=discord-handoff-client-id-provider
import { getDiscordClientId } from './DiscordSourceSettingsService'
// SRL-PUBLIC-SYNC: END REPLACE id=discord-handoff-client-id-provider
import type { DiscordAttachmentMeta, DiscordCapture } from '../types/CommunitySource'
import {
  clearLocalDiscordInboxPairing,
  loadDiscordSourceConnectionSettings,
  saveDiscordInboxPairing,
} from './DiscordSourceSettingsService'

export interface DiscordHandoffRequest {
  workerUrl: string
  token: string
}

export type DiscordInboxReceiptState = 'saved' | 'waiting_binding'

export interface DiscordDeliveryReceipt {
  id: string
  libraryId?: string | null
  /** 未配对手动领取后的安装身份；与具备收件凭据的 libraryId 分开。 */
  claimedLibraryId?: string | null
  capturedAt: number
}

export interface DiscordHandoffEnvelope {
  capture: DiscordCapture
  delivery?: DiscordDeliveryReceipt
}

export interface DiscordInboxJob {
  id: string
  createdAt: number
  state: 'pending' | DiscordInboxReceiptState
  title?: string
}

export interface DiscordInboxStatus {
  libraryId: string
  name: string
  paired: boolean
  isDefault: boolean
  expiresInDays: number
}

export interface DiscordInboxTarget {
  workerUrl: string
  libraryId: string
}

function readString(
  record: Record<string, unknown>,
  key: string,
  required = false,
): string | undefined {
  const value = record[key]
  const result = typeof value === 'string' ? value.trim() : ''
  if (required && !result) throw new Error(`Discord handoff 缺少 ${key}`)
  return result || undefined
}

function readAttachment(value: unknown): DiscordAttachmentMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = readString(record, 'id', true)!
  const name = readString(record, 'name', true)!
  const url = readString(record, 'url', true)!
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0
  return {
    id,
    name,
    url,
    size,
    proxyUrl: readString(record, 'proxyUrl'),
    contentType: readString(record, 'contentType'),
    textContent: typeof record.textContent === 'string' ? record.textContent : undefined,
    width:
      typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : undefined,
    height:
      typeof record.height === 'number' && Number.isFinite(record.height)
        ? record.height
        : undefined,
  }
}

export function parseDiscordCapture(value: unknown): DiscordCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord handoff 内容无效')
  }
  const record = value as Record<string, unknown>
  const canonicalUrl = readString(record, 'canonicalUrl', true)!
  let parsedUrl: URL
  try {
    parsedUrl = new URL(canonicalUrl)
  } catch {
    throw new Error('Discord 原消息链接无效')
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('Discord 原消息链接无效')
  }

  const embeds = Array.isArray(record.embeds)
    ? record.embeds.flatMap((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? [structuredClone(item as Record<string, unknown>)]
          : [],
      )
    : []
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.flatMap((item) => {
        const attachment = readAttachment(item)
        return attachment ? [attachment] : []
      })
    : []

  return {
    guildId: readString(record, 'guildId'),
    guildName: readString(record, 'guildName'),
    channelId: readString(record, 'channelId', true)!,
    channelName: readString(record, 'channelName'),
    threadId: readString(record, 'threadId'),
    messageId: readString(record, 'messageId', true)!,
    starterMessageId: readString(record, 'starterMessageId'),
    isStarter: record.isStarter === true,
    canonicalUrl: parsedUrl.toString(),
    authorId: readString(record, 'authorId', true)!,
    authorName: readString(record, 'authorName', true)!,
    authorBot: record.authorBot === true,
    ...(typeof record.pinned === 'boolean' ? { pinned: record.pinned } : {}),
    content: typeof record.content === 'string' ? record.content : '',
    timestamp: readString(record, 'timestamp', true)!,
    editedTimestamp: readString(record, 'editedTimestamp'),
    title: readString(record, 'title'),
    forumTags: Array.isArray(record.forumTags)
      ? Array.from(
          new Set(record.forumTags.filter((item): item is string => typeof item === 'string')),
        )
      : [],
    embeds,
    attachments,
  }
}

export function normalizeDiscordHandoffRequest(
  value: DiscordHandoffRequest,
): DiscordHandoffRequest | undefined {
  const workerUrl = normalizeDiscordWorkerBaseUrl(value.workerUrl)
  const token = value.token.trim()
  if (!workerUrl || !/^[A-Za-z0-9_-]{30,160}$/u.test(token)) return undefined
  return { workerUrl, token }
}

export function readDiscordHandoffFromLocation(
  location: Location = window.location,
): DiscordHandoffRequest | undefined {
  const params = new URLSearchParams(location.search)
  const workerUrl = params.get('discordWorker') ?? ''
  const token = params.get('discordHandoff') ?? ''
  return normalizeDiscordHandoffRequest({ workerUrl, token })
}

export function parseDiscordHandoffLink(value: string): DiscordHandoffRequest | undefined {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined

  const openRoute = /^\/open\/([A-Za-z0-9_-]{30,160})\/?$/u.exec(url.pathname)
  if (openRoute) {
    return normalizeDiscordHandoffRequest({ workerUrl: url.origin, token: openRoute[1]! })
  }
  const workerUrl = url.searchParams.get('discordWorker') ?? ''
  let worker: URL
  try {
    worker = new URL(workerUrl)
  } catch {
    return undefined
  }
  if (worker.protocol !== 'https:') return undefined
  return normalizeDiscordHandoffRequest({
    workerUrl: worker.toString(),
    token: url.searchParams.get('discordHandoff') ?? '',
  })
}

export function clearDiscordHandoffFromLocation(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('discordWorker') && !url.searchParams.has('discordHandoff')) return
  url.searchParams.delete('discordWorker')
  url.searchParams.delete('discordHandoff')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function parseHandoffEnvelope(value: unknown): DiscordHandoffEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord 收件内容无效')
  }
  const record = value as Record<string, unknown>
  const capture = parseDiscordCapture(record.capture)
  if (record.delivery === undefined) return { capture }
  if (!record.delivery || typeof record.delivery !== 'object' || Array.isArray(record.delivery)) {
    throw new Error('Discord 收件凭据无效')
  }
  const delivery = record.delivery as Record<string, unknown>
  const id = readString(delivery, 'id', true)!
  const libraryId = readString(delivery, 'libraryId')
  const claimedLibraryId = readString(delivery, 'claimedLibraryId')
  if (
    id.length > 80 ||
    (delivery.libraryId !== undefined && delivery.libraryId !== null && !libraryId) ||
    (delivery.claimedLibraryId !== undefined &&
      delivery.claimedLibraryId !== null &&
      !claimedLibraryId) ||
    typeof delivery.capturedAt !== 'number' ||
    !Number.isSafeInteger(delivery.capturedAt) ||
    delivery.capturedAt <= 0
  ) {
    throw new Error('Discord 收件凭据无效')
  }
  return { capture, delivery: { id, libraryId, claimedLibraryId, capturedAt: delivery.capturedAt } }
}

function verifyDeliveryTarget(
  delivery: DiscordDeliveryReceipt | undefined,
  workerUrl: string,
): void {
  const libraryId = delivery?.libraryId
  if (!libraryId) {
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=discord-handoff-claimed-library-id
    if (delivery?.claimedLibraryId && delivery.claimedLibraryId !== getDiscordClientId()) {
      throw new Error('这条临时消息已经由另一份资源库领取，请重新保存消息。')
    }
    // SRL-PUBLIC-SYNC: END REPLACE id=discord-handoff-claimed-library-id
    return
  }
  const settings = loadDiscordSourceConnectionSettings()
  if (settings.workerBaseUrl !== workerUrl || settings.inboxLibraryId !== libraryId) {
    throw new Error('这条消息发往另一份资源库，请在已配对的资源库领取；云端任务仍保留。')
  }
}

export async function receiveDiscordHandoff(
  value: DiscordHandoffRequest,
  signal?: AbortSignal,
): Promise<DiscordHandoffEnvelope> {
  const request = normalizeDiscordHandoffRequest(value)
  if (!request) throw new Error('Discord 临时链接无效')
  const settings = loadDiscordSourceConnectionSettings()
  const headers =
    settings.workerBaseUrl === request.workerUrl && settings.inboxLibraryId && settings.inboxSecret
      ? {
          Authorization: `Bearer ${settings.inboxSecret}`,
          'X-SRL-Library-ID': settings.inboxLibraryId,
        }
      : undefined
  const response = await fetch(
    `${request.workerUrl}/handoff/${encodeURIComponent(request.token)}`,
    {
      method: 'GET',
      headers,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    },
  )
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('这条消息发往另一份资源库，或当前配对已失效；云端任务仍保留。')
    }
    if (response.status === 409) {
      const receipt = (await response.json().catch(() => undefined)) as
        { error?: string } | undefined
      if (receipt?.error === 'delivery_already_saved')
        throw new Error(
          '这条帖子已经领取并保存在本机，云端正文已清理；需要关联时请查看待整理来源。',
        )
    }
    if (response.status === 404 || response.status === 409) {
      throw new Error('这条 Discord 临时链接已过期或已经领取')
    }
    throw new Error(`无法从 Worker 领取消息（HTTP ${response.status}）`)
  }
  const envelope = parseHandoffEnvelope(await response.json())
  verifyDeliveryTarget(envelope.delivery, request.workerUrl)
  return envelope
}

export async function acknowledgeDiscordHandoff(
  value: DiscordHandoffRequest,
  delivery: DiscordDeliveryReceipt,
  state: DiscordInboxReceiptState,
): Promise<void> {
  const request = normalizeDiscordHandoffRequest(value)
  if (!request) throw new Error('Discord 临时链接无效')
  // 只在已验证本机持久化后由统一领取入口调用；旧 Worker 无 receipt，继续兼容旧协议。
  verifyDeliveryTarget(delivery, request.workerUrl)
  const settings = loadDiscordSourceConnectionSettings()
  const response = await fetch(
    `${request.workerUrl}/handoff/${encodeURIComponent(request.token)}/ack`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(delivery.libraryId
          ? {
              Authorization: `Bearer ${settings.inboxSecret ?? ''}`,
              'X-SRL-Library-ID': delivery.libraryId,
            }
          : {}),
      },
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=discord-handoff-ack-library-id
      body: JSON.stringify({ libraryId: delivery.libraryId ?? getDiscordClientId(), state }),
      // SRL-PUBLIC-SYNC: END REPLACE id=discord-handoff-ack-library-id
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    },
  )
  if (!response.ok) throw new Error('消息已保存在本机，但云端尚未确认，请稍后刷新收件进度。')
}

export function inboxConnection(): { workerUrl: string; libraryId: string; secret: string } {
  const settings = loadDiscordSourceConnectionSettings()
  if (!settings.workerBaseUrl || !settings.inboxLibraryId || !settings.inboxSecret) {
    throw new Error('尚未配对云端收件库')
  }
  return {
    workerUrl: settings.workerBaseUrl,
    libraryId: settings.inboxLibraryId,
    secret: settings.inboxSecret,
  }
}

export class DiscordInboxTaskExpiredError extends Error {
  readonly kind: 'resource' | 'delivery'
  constructor(kind: 'resource' | 'delivery') {
    super('云端任务已过期或已不存在。')
    this.name = 'DiscordInboxTaskExpiredError'
    this.kind = kind
  }
}

export async function inboxRequest(
  path: string,
  method = 'GET',
  body?: unknown,
  expected?: DiscordInboxTarget,
  signal?: AbortSignal,
): Promise<Response> {
  const connection = inboxConnection()
  if (
    expected &&
    (connection.workerUrl !== expected.workerUrl || connection.libraryId !== expected.libraryId)
  ) {
    throw new Error('本机收件库已变更，未确认旧目标任务。')
  }
  const response = await fetch(`${connection.workerUrl}/inbox${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.secret}`,
      'X-SRL-Library-ID': connection.libraryId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('云端收件配对已失效，请重新绑定资源库。')
    }
    if (response.status === 404) {
      const payload = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null
      if (
        payload?.error === 'delivery_not_found_or_expired' ||
        payload?.error === 'resource_task_not_found_or_expired'
      ) {
        throw new DiscordInboxTaskExpiredError(
          payload.error === 'resource_task_not_found_or_expired' ? 'resource' : 'delivery',
        )
      }
      if (path === '/cleanup-scoped') {
        throw new Error(
          'Worker 未提供分类清理接口（DELETE /inbox/cleanup-scoped，HTTP 404），本次没有删除记录。请同步并部署包含此路由的 Discord Bridge；若要使用旧版兼容接口，可选择“帖子和资源都清理”。',
        )
      }
      if (path === '/jobs') {
        throw new Error(
          '当前 Worker 未提供收件箱任务列表接口（GET /inbox/jobs，HTTP 404）。收件箱状态接口可用，但需要将包含该路由的 Discord Bridge Worker 部署到此连接地址。',
        )
      }
      throw new Error(
        `云端收件接口未找到（HTTP 404${typeof payload?.error === 'string' ? `：${payload.error}` : ''}）`,
      )
    }
    if (
      response.status === 409 &&
      (/^\/resources\/[a-f\d-]{36}(?:\/file)?$/u.test(path) ||
        (/^\/resources\/[a-f\d-]{36}\/ack$/u.test(path) &&
          (body as { state?: unknown } | undefined)?.state === 'imported'))
    ) {
      const payload = await response.json().catch(() => null)
      if (payload?.error === 'resource_already_imported' && payload?.state === 'imported') {
        if (/^\/resources\/[a-f\d-]{36}\/ack$/u.test(path)) return response
        throw new Error('该云端任务已确认导入，无需重复领取；请在资源列表查看。')
      }
    }
    if (response.status === 405) {
      const route = `/inbox${path.split('?')[0]}`.replace(/[a-f\d-]{36}(?=\/|$)/giu, ':id')
      const allowedMethods = [
        ...new Set(
          (response.headers.get('Allow') ?? '')
            .split(',')
            .map((value) => value.trim().toUpperCase())
            .filter((value) =>
              /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)$/u.test(value),
            ),
        ),
      ]
      const details = [
        '云端收件失败（HTTP 405）：服务器拒绝了本次请求方法。',
        `请求：${method.toUpperCase()} ${route}。`,
        allowedMethods.length
          ? `服务端声明允许：${allowedMethods.join('、')}。`
          : '未获取到服务端允许的方法。',
      ]
      if (response.redirected) details.push('请求发生过地址跳转，请核对连接地址和跳转规则。')
      if (response.headers.get('Content-Type')?.toLowerCase().includes('text/html'))
        details.push('服务端返回了网页，请核对该地址是否指向收件接口。')
      details.push('请在 Worker 实时日志中核对上述方法、路径和状态码，并检查接口路由及代理配置。')
      throw new Error(details.join(' '))
    }
    throw new Error(`云端收件请求失败（HTTP ${response.status}）`)
  }
  return response
}

export async function pairDiscordInbox(
  name: string,
): Promise<{ libraryId: string; secret: string; code: string; expiresAt: number }> {
  const settings = loadDiscordSourceConnectionSettings()
  const libraryName = name.trim().slice(0, 80)
  if (!libraryName) throw new Error('请填写这份资源库的名称')
  if (!settings.workerBaseUrl || !settings.botToken)
    throw new Error('请先保存并核验自己的 Worker 配置')
  if (settings.inboxLibraryId && settings.inboxSecret) {
    throw new Error('当前已有收件配对，请先解除后再生成新配对口令。')
  }
  const response = await fetch(`${settings.workerBaseUrl}/inbox/pair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: libraryName }),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok)
    throw new Error(`无法生成配对口令，请核对 Worker 版本与配置（HTTP ${response.status}）`)
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('配对响应无效')
  const record = payload as Record<string, unknown>
  const libraryId = readString(record, 'libraryId', true)!
  const secret = readString(record, 'secret', true)!
  const code = readString(record, 'code', true)!
  const expiresAt = record.expiresAt
  if (
    !/^[a-zA-Z0-9-]{1,80}$/u.test(libraryId) ||
    !/^[A-Za-z0-9_-]{30,160}$/u.test(secret) ||
    !/^[A-Za-z0-9_-]{6,32}$/u.test(code) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw new Error('配对响应无效')
  try {
    const current = loadDiscordSourceConnectionSettings()
    if (
      current.workerBaseUrl !== settings.workerBaseUrl ||
      current.applicationId !== settings.applicationId
    ) {
      throw new Error('Worker 配置已改变，请重新生成配对口令')
    }
    await saveDiscordInboxPairing(
      { libraryId, name: libraryName, secret, code, expiresAt },
      undefined,
      { workerBaseUrl: settings.workerBaseUrl, applicationId: settings.applicationId },
    )
  } catch (error) {
    // 保护存储失败时撤销尚未使用的新收件地址；不留下拿不到密钥的配对。
    await fetch(`${settings.workerBaseUrl}/inbox/pair`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${secret}`, 'X-SRL-Library-ID': libraryId },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).catch(() => undefined)
    throw error
  }
  return { libraryId, secret, code, expiresAt }
}

export async function readDiscordInboxStatus(): Promise<DiscordInboxStatus> {
  const connection = inboxConnection()
  const record = (await (await inboxRequest('/status')).json()) as Partial<DiscordInboxStatus>
  if (
    record.libraryId !== connection.libraryId ||
    typeof record.paired !== 'boolean' ||
    typeof record.name !== 'string' ||
    (record.isDefault !== undefined && typeof record.isDefault !== 'boolean')
  ) {
    throw new Error('云端收件状态无效')
  }
  return {
    libraryId: record.libraryId,
    name: record.name,
    paired: record.paired,
    isDefault: record.isDefault ?? record.paired,
    expiresInDays: 7,
  }
}

export async function clearDiscordInboxPairing(): Promise<void> {
  const initial = loadDiscordSourceConnectionSettings()
  if (loadDiscordSourceConnectionSettings().inboxSecret) {
    // 网络失败时保留凭据供重试；已经撤销的地址仍允许本机清除。
    try {
      await inboxRequest('/pair', 'DELETE')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('配对已失效')) throw error
    }
  }
  const current = loadDiscordSourceConnectionSettings()
  if (
    current.workerBaseUrl !== initial.workerBaseUrl ||
    current.inboxLibraryId !== initial.inboxLibraryId
  )
    return
  await clearLocalDiscordInboxPairing(undefined, {
    workerBaseUrl: initial.workerBaseUrl,
    libraryId: initial.inboxLibraryId,
  })
}

function parseInboxJobs(value: unknown, pending: boolean): DiscordInboxJob[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('云端收件列表无效')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('云端收件列表无效')
    const record = item as Record<string, unknown>
    const id = readString(record, 'id', true)!
    const state = record.state
    if (
      !/^[a-zA-Z0-9-]{1,80}$/u.test(id) ||
      typeof record.createdAt !== 'number' ||
      !Number.isSafeInteger(record.createdAt) ||
      (pending ? state !== 'pending' : state !== 'saved' && state !== 'waiting_binding')
    )
      throw new Error('云端收件列表无效')
    return {
      id,
      createdAt: record.createdAt,
      state: state as DiscordInboxJob['state'],
      title: readString(record, 'title'),
    }
  })
}

export async function listDiscordInboxJobs(
  after?: string,
  signal?: AbortSignal,
): Promise<{
  jobs: DiscordInboxJob[]
  recent: DiscordInboxJob[]
  hasMore: boolean
}> {
  if (after !== undefined && !/^\d{1,13}:[a-f\d-]{36}$/u.test(after))
    throw new Error('云端帖子分页游标无效')
  const payload = (await (
    await inboxRequest(
      `/jobs${after ? '?after=' + encodeURIComponent(after) : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    )
  ).json()) as Record<string, unknown>
  if (typeof payload.hasMore !== 'boolean') throw new Error('云端收件列表无效')
  return {
    jobs: parseInboxJobs(payload.jobs, true),
    recent: parseInboxJobs(payload.recent, false),
    hasMore: payload.hasMore,
  }
}

export async function cancelDiscordInboxJob(
  id: string,
  expected?: DiscordInboxTarget,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,80}$/u.test(id)) throw new Error('云端收件任务无效')
  await inboxRequest(`/jobs/${encodeURIComponent(id)}`, 'DELETE', undefined, expected)
}

export async function clearDiscordInboxCloudHistory(
  scope: 'posts' | 'resources' | 'both' = 'both',
): Promise<{
  posts: number
  resources: number
}> {
  // Older deployed Workers already implement the unscoped route; keep the default
  // “clear both” action compatible while requiring the scoped route for narrower cleanup.
  const path = scope === 'both' ? '/cleanup' : '/cleanup-scoped'
  const payload = (await (
    await inboxRequest(path, 'DELETE', scope === 'both' ? undefined : { scope })
  ).json()) as Record<string, unknown>
  if (
    !Number.isSafeInteger(payload.posts) ||
    !Number.isSafeInteger(payload.resources) ||
    Number(payload.posts) < 0 ||
    Number(payload.resources) < 0
  )
    throw new Error('云端清理结果无效')
  return { posts: Number(payload.posts), resources: Number(payload.resources) }
}

export async function receiveDiscordInboxJob(
  id: string,
  signal?: AbortSignal,
): Promise<DiscordHandoffEnvelope> {
  if (!/^[a-zA-Z0-9-]{1,80}$/u.test(id)) throw new Error('云端收件任务无效')
  const connection = inboxConnection()
  const envelope = parseHandoffEnvelope(
    await (
      await inboxRequest(`/jobs/${encodeURIComponent(id)}`, 'GET', undefined, undefined, signal)
    ).json(),
  )
  if (envelope.delivery?.id !== id || envelope.delivery.libraryId !== connection.libraryId) {
    throw new Error('云端收件目标不匹配，任务尚未确认。')
  }
  verifyDeliveryTarget(envelope.delivery, connection.workerUrl)
  return envelope
}

export async function acknowledgeDiscordInboxJob(
  id: string,
  state: DiscordInboxReceiptState,
  expected?: DiscordInboxTarget,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,80}$/u.test(id)) throw new Error('云端收件任务无效')
  await inboxRequest(`/jobs/${encodeURIComponent(id)}/ack`, 'POST', { state }, expected)
}

export async function acknowledgeDiscordInboxSourceBound(
  sourceKeyHash: string,
  expected?: DiscordInboxTarget,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(sourceKeyHash)) throw new Error('帖子来源身份无效')
  await inboxRequest(`/sources/${sourceKeyHash}/ack-bound`, 'POST', undefined, expected)
}

export async function listDiscordInboxWaitingSources(after?: string): Promise<{
  sourceKeyHashes: string[]
  nextCursor: string | null
}> {
  if (after !== undefined && !/^[a-f0-9]{64}$/u.test(after)) throw new Error('待关联进度游标无效')
  const record = (await (
    await inboxRequest(`/waiting-sources${after ? `?after=${after}` : ''}`)
  ).json()) as Record<string, unknown>
  if (
    !Array.isArray(record.sourceKeyHashes) ||
    record.sourceKeyHashes.length > 20 ||
    record.sourceKeyHashes.some((key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) ||
    (record.nextCursor !== null &&
      (typeof record.nextCursor !== 'string' || !/^[a-f0-9]{64}$/u.test(record.nextCursor)))
  ) {
    throw new Error('待关联收件进度无效')
  }
  return {
    sourceKeyHashes: record.sourceKeyHashes as string[],
    nextCursor: record.nextCursor as string | null,
  }
}
