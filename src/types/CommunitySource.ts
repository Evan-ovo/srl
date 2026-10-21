import type { EncryptedValue } from './Vault'

export const COMMUNITY_SOURCE_PLATFORM = {
  DISCORD: 'discord',
} as const

export type CommunitySourcePlatform =
  (typeof COMMUNITY_SOURCE_PLATFORM)[keyof typeof COMMUNITY_SOURCE_PLATFORM]

export const COMMUNITY_SOURCE_MESSAGE_KIND = {
  STARTER: 'starter',
  AUTHOR_UPDATE: 'authorUpdate',
  SELECTED_COMMENT: 'selectedComment',
} as const

export type CommunitySourceMessageKind =
  (typeof COMMUNITY_SOURCE_MESSAGE_KIND)[keyof typeof COMMUNITY_SOURCE_MESSAGE_KIND]

export const COMMUNITY_SOURCE_REMOTE_STATE = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
} as const

export type CommunitySourceRemoteState =
  (typeof COMMUNITY_SOURCE_REMOTE_STATE)[keyof typeof COMMUNITY_SOURCE_REMOTE_STATE]

export const COMMUNITY_SOURCE_REFRESH_MODE = {
  MANUAL: 'manual',
} as const

export type CommunitySourceRefreshMode =
  (typeof COMMUNITY_SOURCE_REFRESH_MODE)[keyof typeof COMMUNITY_SOURCE_REFRESH_MODE]

export const COMMUNITY_SOURCE_MESSAGE_REMOTE_STATE = {
  AVAILABLE: 'available',
  MISSING: 'missing',
} as const

export type CommunitySourceMessageRemoteState =
  (typeof COMMUNITY_SOURCE_MESSAGE_REMOTE_STATE)[keyof typeof COMMUNITY_SOURCE_MESSAGE_REMOTE_STATE]

export const COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE = {
  LOCAL: 'local',
  REMOTE_ONLY: 'remoteOnly',
  FAILED: 'failed',
} as const

export type CommunitySourceAttachmentLocalState =
  (typeof COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE)[keyof typeof COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE]

export type DiscordSourceRemoteScanCursor =
  | {
      /** 已完整扫描到的 Discord message snowflake 高水位。 */
      lastSeenMessageId: string
      pendingBeforeMessageId?: never
      pendingHighWaterMessageId?: never
    }
  | {
      /** continuation 仍以这个已确认高水位为下界。 */
      lastSeenMessageId: string
      /** 一次最多扫描 3 页；下次从这里继续向旧消息方向读取。 */
      pendingBeforeMessageId: string
      /** continuation 所属那轮扫描最顶部的 message id；追完后才提交为 lastSeen。 */
      pendingHighWaterMessageId: string
    }

export interface DiscordAttachmentMeta {
  id: string
  name: string
  size: number
  url: string
  proxyUrl?: string
  contentType?: string
  /** 小型纯文本附件的本地快照；只由用户自己的 Discord Bridge 提取。 */
  textContent?: string
  width?: number
  height?: number
  /** 指向 SRL 通用 assets/assetFiles；有值时读取优先使用本机副本。 */
  localAssetId?: string
  /** 不把远端下载失败当作整条消息保存失败。 */
  localState?: CommunitySourceAttachmentLocalState
}

export interface CommunitySourceRevisionSource {
  canonicalUrl: string
  title?: string
  starterMessageId?: string
  starterAuthorId?: string
  starterAuthorName?: string
  forumTags: string[]
  updatedAt: number
}

export interface CommunitySourceRevision {
  /** 本机随机 revision id；不包含 Discord 标识。 */
  id: string
  createdAt: number
  source: CommunitySourceRevisionSource
  messages: CommunitySourceMessage[]
}

export interface CommunitySourceAutoBindCandidate {
  resourceId: string
  resourceName: string
  rule: 'same-name' | 'same-author'
  reason: string
}

export interface CommunitySourceAutoBindScan {
  version: 1
  status: 'scanning' | 'exhausted' | 'review'
  /** Logical current resource IDs already inspected, including the five-card initial window. */
  scannedResourceIds: string[]
  /** At most five new logical resources inspected after the post was saved. */
  futureResourceIds: string[]
  reviewCandidates?: CommunitySourceAutoBindCandidate[]
}

export interface CommunitySource {
  /** 本机随机 ID；不包含 Discord guild/thread/message 标识。 */
  id: string
  platform: CommunitySourcePlatform
  /** 由临时 source key 计算的 SHA-256，仅用于本机去重/查找。 */
  sourceKeyHash: string
  guildId?: string
  /** Discord 服务器显示名；只用于展示，真实身份仍由 guildId 决定。 */
  guildName?: string
  channelId: string
  /** Discord 频道显示名；只用于展示，真实身份仍由 channelId 决定。 */
  channelName?: string
  threadId?: string
  starterMessageId?: string
  canonicalUrl: string
  title?: string
  starterAuthorId?: string
  starterAuthorName?: string
  forumTags: string[]
  /** 目录轻量摘要；旧数据允许为空，首次按需读取后回填。 */
  messageCount?: number
  missingMessageCount?: number
  latestMessagePreview?: string
  /** LEGACY-REQUIRED：旧版检查状态，仅为存量来源和备份兼容保留，不再发起远端检查。 */
  remoteState?: CommunitySourceRemoteState
  /** LEGACY-REQUIRED：旧版刷新模式，不参与 source identity。 */
  discordRefreshMode?: CommunitySourceRefreshMode
  /** LEGACY-REQUIRED：旧版远端检查结果。 */
  hasRemoteUpdate?: boolean
  lastCheckedAt?: number
  /** LEGACY-REQUIRED：旧版忽略列表，仅为存量数据/备份兼容保留。 */
  ignoredRemoteMessageIds?: string[]
  /** LEGACY-REQUIRED：旧版增量扫描进度，不再执行扫描。 */
  remoteScanCursor?: DiscordSourceRemoteScanCursor
  /** LEGACY-REQUIRED：旧版消息健康检查位置，不再执行检查。 */
  savedMessageCheckCursor?: string
  /** 旧版已有历史及恢复前的回退版本；随 Source 一起进入 Vault / Backup。 */
  revisions?: CommunitySourceRevision[]
  /** Snapshot time of the source display metadata, independent from message edit versions. */
  metadataCapturedAt?: number
  /** Inbox-only marker consumed by the next imported character-card PNG. */
  autoBindPendingPng?: boolean
  /** Bounded, resumable scan state for post-first automatic resource matching. */
  autoBindScan?: CommunitySourceAutoBindScan
  createdAt: number
  updatedAt: number
}

/** 来源目录专用小对象。Vault 开启时独立加密，避免仅列目录就解密 revisions。 */
export interface CommunitySourceSummary {
  id: string
  platform: CommunitySourcePlatform
  sourceKeyHash: string
  guildId?: string
  guildName?: string
  channelId: string
  channelName?: string
  threadId?: string
  starterMessageId?: string
  canonicalUrl: string
  title?: string
  starterAuthorId?: string
  starterAuthorName?: string
  remoteState?: CommunitySourceRemoteState
  discordRefreshMode?: CommunitySourceRefreshMode
  hasRemoteUpdate?: boolean
  lastCheckedAt?: number
  messageCount?: number
  missingMessageCount?: number
  latestMessagePreview?: string
  revisionCount: number
  createdAt: number
  updatedAt: number
}

export function toCommunitySourceSummary(source: CommunitySource): CommunitySourceSummary {
  return {
    id: source.id,
    platform: source.platform,
    sourceKeyHash: source.sourceKeyHash,
    guildId: source.guildId,
    guildName: source.guildName,
    channelId: source.channelId,
    channelName: source.channelName,
    threadId: source.threadId,
    starterMessageId: source.starterMessageId,
    canonicalUrl: source.canonicalUrl,
    title: source.title,
    starterAuthorId: source.starterAuthorId,
    starterAuthorName: source.starterAuthorName,
    remoteState: source.remoteState,
    discordRefreshMode: source.discordRefreshMode,
    hasRemoteUpdate: source.hasRemoteUpdate,
    lastCheckedAt: source.lastCheckedAt,
    messageCount: source.messageCount,
    missingMessageCount: source.missingMessageCount,
    latestMessagePreview: source.latestMessagePreview,
    revisionCount: source.revisions?.length ?? 0,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

export interface CommunitySourceMessage {
  /** 由 sourceId + messageKeyHash 组成，不暴露 Discord messageId。 */
  id: string
  sourceId: string
  /** 由 sourceId + Discord messageId 计算的 SHA-256。 */
  messageKeyHash: string
  messageId: string
  kind: CommunitySourceMessageKind
  authorId: string
  authorName: string
  authorBot?: boolean
  /** Discord 已标注／置顶状态；旧快照缺失表示尚未获知。 */
  pinned?: boolean
  content: string
  embeds: Record<string, unknown>[]
  attachments: DiscordAttachmentMeta[]
  canonicalUrl: string
  timestamp: string
  editedTimestamp?: string
  /** 单条远端状态只表示 Discord 上是否还能找到；缺失绝不触发本地删除。 */
  remoteState?: CommunitySourceMessageRemoteState
  lastRemoteCheckedAt?: number
  capturedAt: number
  /** Snapshot delivery time, separate from Discord's message creation time; older deliveries cannot replace it. */
  deliveryCapturedAt?: number
  /** Local native receive receipt; never accepted from a remote capture. */
  nativeInboxReceipt?: {
    id: string
    libraryId: string
    workerUrl: string
    captureHash: string
    notificationState?: string
    attachmentState?: 'pending' | 'complete' | 'foreground_required'
  }
  updatedAt: number
}

export interface ResourceSourceBinding {
  id: string
  resourceId: string
  sourceId: string
  note?: string
  /** Set only for reversible, inbox automation bindings. */
  autoBindingRule?: 'same-name' | 'same-author' | 'next-png'
  createdAt: number
}

export interface DiscordCapture {
  guildId?: string
  guildName?: string
  channelId: string
  channelName?: string
  threadId?: string
  messageId: string
  starterMessageId?: string
  isStarter?: boolean
  canonicalUrl: string
  authorId: string
  authorName: string
  authorBot?: boolean
  /** Discord 已标注／置顶状态；旧快照缺失表示尚未获知。 */
  pinned?: boolean
  content: string
  timestamp: string
  editedTimestamp?: string
  title?: string
  forumTags?: string[]
  embeds?: Record<string, unknown>[]
  attachments?: DiscordAttachmentMeta[]
}

export interface ResourceCommunitySourceSummary {
  source: CommunitySourceSummary
  binding: ResourceSourceBinding
}

export interface ResourceCommunitySourceView {
  source: CommunitySource
  messages: CommunitySourceMessage[]
  binding: ResourceSourceBinding
}

/** ZIP 内独立 community-sources.json 的稳定格式。连接凭据永远不属于这里。 */
export interface CommunitySourceBackupData {
  version: 1
  sources: CommunitySource[]
  messages: CommunitySourceMessage[]
  bindings: ResourceSourceBinding[]
}

/** ZIP/Restore 内存态的二进制 sidecar；不会被 JSON.stringify 进 community-sources.json。 */
export interface CommunitySourceAttachmentArchiveEntry {
  assetId: string
  blob: Blob
}

export interface EncryptedCommunitySourceRecord {
  id: string
  platform: CommunitySourcePlatform
  sourceKeyHash: string
  updatedAt: number
  encrypted: true
  payload: EncryptedValue
  /** 新数据附带独立小摘要；旧记录没有时由 Storage 单次回填。 */
  summaryPayload?: EncryptedValue
}

export interface EncryptedCommunitySourceMessageRecord {
  id: string
  sourceId: string
  messageKeyHash: string
  kind: CommunitySourceMessageKind
  capturedAt: number
  updatedAt: number
  encrypted: true
  payload: EncryptedValue
}

export interface EncryptedResourceSourceBindingRecord {
  id: string
  resourceId: string
  sourceId: string
  createdAt: number
  encrypted: true
  payload: EncryptedValue
}

export type StoredCommunitySource = CommunitySource | EncryptedCommunitySourceRecord
export type StoredCommunitySourceMessage =
  CommunitySourceMessage | EncryptedCommunitySourceMessageRecord
export type StoredResourceSourceBinding =
  ResourceSourceBinding | EncryptedResourceSourceBindingRecord

export function isEncryptedCommunitySource(
  value: StoredCommunitySource,
): value is EncryptedCommunitySourceRecord {
  return 'encrypted' in value && value.encrypted === true
}

export function isEncryptedCommunitySourceMessage(
  value: StoredCommunitySourceMessage,
): value is EncryptedCommunitySourceMessageRecord {
  return 'encrypted' in value && value.encrypted === true
}

export function isEncryptedResourceSourceBinding(
  value: StoredResourceSourceBinding,
): value is EncryptedResourceSourceBindingRecord {
  return 'encrypted' in value && value.encrypted === true
}

/** 只在内存中短暂存在，用于计算 sourceKeyHash；不得直接持久化。 */
export function createDiscordSourceKey(capture: DiscordCapture): string {
  const container =
    capture.threadId?.trim() || capture.starterMessageId?.trim() || capture.messageId.trim()
  const guild = capture.guildId?.trim() || '@me'
  return `discord:${guild}:${container}`
}

export function createCommunitySourceId(): string {
  return crypto.randomUUID()
}

export function createCommunitySourceMessageId(sourceId: string, messageKeyHash: string): string {
  return `${sourceId}:message:${messageKeyHash}`
}

export function createResourceSourceBindingId(resourceId: string, sourceId: string): string {
  return `${resourceId}:source:${sourceId}`
}
