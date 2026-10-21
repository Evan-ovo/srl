import { withCaptureSave } from './CommunityCaptureLock'

import type { CommunitySourceStorage } from '../storage/CommunitySourceStorage'

import type { ResourceListSummary } from '../types/Resource'

import { isResourceGalleryImage } from '../types/ResourceGallery'

import {
  COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE,
  COMMUNITY_SOURCE_MESSAGE_KIND,
  COMMUNITY_SOURCE_PLATFORM,
  createCommunitySourceId,
  createCommunitySourceMessageId,
  createDiscordSourceKey,
  createResourceSourceBindingId,
  toCommunitySourceSummary,
  type CommunitySource,
  type CommunitySourceAutoBindScan,
  type CommunitySourceBackupData,
  type CommunitySourceMessage,
  type CommunitySourceMessageKind,
  type CommunitySourceSummary,
  type DiscordAttachmentMeta,
  type DiscordCapture,
  type ResourceCommunitySourceSummary,
  type ResourceCommunitySourceView,
  type ResourceSourceBinding,
} from '../types/CommunitySource'

import {
  clean,
  normalizeStringList,
  safeHttpUrl,
  normalizeAttachments,
  hashIdentity,
  messageKeyHash,
  normalizeCapture,
  makeRevision,
  attachmentIdentityMatches,
  discordMessageChanged,
  olderDiscordDelivery,
  sourceMetadataCapturedAt,
  withDiscordSourceMetadata,
  withMessageSummary,
  sourceSummaryMatches,
} from './CommunitySourceCapture'

const AUTO_LOCAL_ATTACHMENT_BYTES = 8 * 1024 * 1024

const MAX_MANUAL_LOCAL_ATTACHMENT_BYTES = 64 * 1024 * 1024

const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000

type CommunitySourceAssetStore = {
  put(
    blob: Blob,
    options: {
      source: 'remote'
      remoteUrl?: string
      vaultProtected?: boolean
    },
  ): Promise<{ assetId: string }>
  getBlob(assetId: string): Promise<Blob | undefined>
}

type DiscordCaptureSaveOptions = {
  resourceId?: string
  kind?: CommunitySourceMessageKind
  note?: string
  /** Server snapshot time in milliseconds; manual capture defaults to the current time. */
  capturedAt?: number
  /** Persist text first, then use the existing attachment owner in the background. */
  deferAttachmentLocalization?: boolean
}

export class CommunitySourceService {
  private readonly storage: CommunitySourceStorage
  private readonly assetStore?: CommunitySourceAssetStore
  private readonly shouldDownloadPostMedia: () => boolean | Promise<boolean>

  async downloadedMediaUsage() {
    return this.storage.downloadedMediaUsage?.() ?? { count: 0, bytes: 0 }
  }

  async clearDownloadedMedia() {
    if (!this.storage.clearDownloadedMedia) throw new Error('当前存储未提供帖子媒体清理')
    return withCaptureSave('discord-local-media', () => this.storage.clearDownloadedMedia!())
  }

  constructor(
    storage: CommunitySourceStorage,
    assetStore?: CommunitySourceAssetStore,
    shouldDownloadPostMedia: () => boolean | Promise<boolean> = () => true,
  ) {
    this.storage = storage
    this.assetStore = assetStore
    this.shouldDownloadPostMedia = shouldDownloadPostMedia
  }

  private async getSourceSummary(sourceId: string): Promise<CommunitySourceSummary | undefined> {
    if (this.storage.getSourceSummary) return this.storage.getSourceSummary(sourceId)
    const source = await this.storage.getSource(sourceId)
    return source ? toCommunitySourceSummary(source) : undefined
  }

  async listSummariesForResource(resourceId: string): Promise<ResourceCommunitySourceSummary[]> {
    const bindings = await this.storage.listBindingsForResource(resourceId)
    const summaries = await Promise.all(
      bindings.map(async (binding) => {
        const source = await this.getSourceSummary(binding.sourceId)
        return source ? { source, binding } : undefined
      }),
    )
    return summaries
      .flatMap((summary) => (summary ? [summary] : []))
      .sort((left, right) => right.source.updatedAt - left.source.updatedAt)
  }

  async listUnboundResources<T extends ResourceListSummary>(resources: readonly T[]): Promise<T[]> {
    let boundIds = await this.storage.listBoundResourceIds?.()
    if (!boundIds) {
      boundIds = []
      for (const resource of resources) {
        if ((await this.storage.listBindingsForResource(resource.id)).length)
          boundIds.push(resource.id)
      }
    }
    const bound = new Set(boundIds)
    return resources.filter((resource) => !bound.has(resource.id))
  }

  async getForResource(
    resourceId: string,
    sourceId: string,
  ): Promise<ResourceCommunitySourceView | undefined> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const binding = (await this.storage.listBindingsForResource(resourceId)).find(
          (candidate) => candidate.sourceId === sourceId,
        )
        if (!binding) return undefined
        const source = await this.storage.getSource(sourceId)
        if (!source) return undefined
        const messages = await this.storage.listMessages(sourceId)
        const summarized = withMessageSummary(source, messages)
        if (!sourceSummaryMatches(source, messages)) await this.storage.putSource(summarized)
        return { source: summarized, messages, binding }
      },
      'shared',
    )
  }

  /** 兼容其它调用方；高频来源目录必须使用 listSummariesForResource。 */
  async listForResource(resourceId: string): Promise<ResourceCommunitySourceView[]> {
    const summaries = await this.listSummariesForResource(resourceId)
    const views: ResourceCommunitySourceView[] = []
    for (const summary of summaries) {
      const view = await this.getForResource(resourceId, summary.source.id)
      if (view) views.push(view)
    }
    return views
  }

  async repairInvalidResourceBindings(resources: readonly ResourceListSummary[]): Promise<number> {
    if (!this.storage.repairInvalidResourceBindings) return 0
    const validResourceIds = new Set<string>()
    const galleryVersions = new Map<string, number>()
    for (const resource of resources) {
      if (isResourceGalleryImage(resource)) galleryVersions.set(resource.id, resource.updatedAt)
      else validResourceIds.add(resource.id)
    }
    return this.storage.repairInvalidResourceBindings(validResourceIds, galleryVersions)
  }

  async listPendingSources(
    limit = 30,
  ): Promise<Array<{ source: CommunitySource; messages: CommunitySourceMessage[] }>> {
    const sources = await this.storage.listUnboundSources(limit)
    const views: Array<{ source: CommunitySource; messages: CommunitySourceMessage[] }> = []
    for (const source of sources) {
      views.push({ source, messages: await this.storage.listMessages(source.id) })
    }
    return views
  }

  async countPendingSources(): Promise<number> {
    if (this.storage.countUnboundSources) return this.storage.countUnboundSources()
    return (await this.storage.listUnboundSources(100)).length
  }

  async listUnboundForAutomation(
    limit = 5,
    includeUntracked = false,
  ): Promise<Array<{ source: CommunitySource; starter?: CommunitySourceMessage }>> {
    const sources = await this.storage.listUnboundSources(Math.min(100, Math.max(1, limit)))
    const views: Array<{ source: CommunitySource; starter?: CommunitySourceMessage }> = []
    for (const source of sources) {
      if (!includeUntracked && !source.autoBindScan && !source.autoBindPendingPng) continue
      views.push({
        source,
        starter: this.storage.getStarterMessage
          ? await this.storage.getStarterMessage(source.id)
          : (await this.storage.listMessages(source.id)).find(
              (message) => message.kind === 'starter',
            ),
      })
    }
    return views
  }

  async listAutoBindReviews(limit = 50): Promise<
    Array<{
      source: CommunitySource
      candidates: NonNullable<CommunitySourceAutoBindScan['reviewCandidates']>
    }>
  > {
    const sources = await this.storage.listUnboundSources(Math.min(100, Math.max(1, limit * 2)))
    const reviews: Array<{
      source: CommunitySource
      candidates: NonNullable<CommunitySourceAutoBindScan['reviewCandidates']>
    }> = []
    for (const source of sources) {
      const candidates = source.autoBindScan?.reviewCandidates
      if (!candidates?.length) continue
      reviews.push({ source, candidates })
      if (reviews.length >= limit) break
    }
    return reviews
  }

  async updateAutoBindScan(
    sourceId: string,
    scan: CommunitySourceAutoBindScan | undefined,
  ): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const source = await this.storage.getSource(sourceId)
        if (!source) return
        if (scan) source.autoBindScan = structuredClone(scan)
        else delete source.autoBindScan
        source.updatedAt = Date.now()
        await this.storage.putSource(source)
      },
      'shared',
    )
  }

  async chooseAutoBindCandidate(sourceId: string, resourceId: string): Promise<void> {
    const source = await this.storage.getSource(sourceId)
    const candidate = source?.autoBindScan?.reviewCandidates?.find(
      (item) => item.resourceId === resourceId,
    )
    if (!source || !candidate) throw new Error('自动匹配候选已变化，请刷新收件箱。')
    await this.bindSource(
      resourceId,
      sourceId,
      `自动关联：${candidate.rule === 'same-name' ? '同名' : '同作者'} · ${candidate.reason}`,
      candidate.rule,
    )
  }

  async dismissAutoBindReview(sourceId: string): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const source = await this.storage.getSource(sourceId)
        if (!source) return
        delete source.autoBindScan
        delete source.autoBindPendingPng
        source.updatedAt = Date.now()
        await this.storage.putSource(source)
      },
      'shared',
    )
  }

  async getSourceForAutomation(sourceId: string): Promise<CommunitySource | undefined> {
    return this.storage.getSource(sourceId)
  }

  async updateAutomationPendingPng(sourceId: string, pending: boolean): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const source = await this.storage.getSource(sourceId)
        if (!source) return
        if (pending) source.autoBindPendingPng = true
        else delete source.autoBindPendingPng
        source.updatedAt = Date.now()
        await this.storage.putSource(source)
      },
      'shared',
    )
  }

  async findDiscordSourceForCapture(captureInput: DiscordCapture): Promise<
    | {
        source: CommunitySource
        messages: CommunitySourceMessage[]
        bindings: ResourceSourceBinding[]
      }
    | undefined
  > {
    const capture = normalizeCapture(captureInput)
    const sourceKeyHash = await hashIdentity(createDiscordSourceKey(capture))
    const source = await this.storage.getSourceByKeyHash(sourceKeyHash)
    if (!source) return undefined
    const [messages, bindings] = await Promise.all([
      this.storage.listMessages(source.id),
      this.storage.listBindingsForSource(source.id),
    ])
    return { source, messages, bindings }
  }

  async getSourceUsage(sourceId: string): Promise<ResourceSourceBinding[]> {
    return this.storage.listBindingsForSource(sourceId)
  }

  async getSavedNativeDiscordDelivery(
    captureInput: DiscordCapture,
    delivery: { id: string; libraryId: string; capturedAt: number },
    workerUrl: string,
  ): Promise<
    | {
        view: ResourceCommunitySourceView
        notificationPosted: boolean
        messageKey: string
        attachmentState?: 'pending' | 'complete' | 'foreground_required'
      }
    | undefined
  > {
    const capture = normalizeCapture(captureInput)
    const retained = await this.findDiscordSourceForCapture(capture)
    const message = retained?.messages.find((item) => item.messageId === capture.messageId)
    const receipt = message?.nativeInboxReceipt
    if (
      !retained ||
      !message ||
      !receipt ||
      receipt.id !== delivery.id ||
      receipt.libraryId !== delivery.libraryId ||
      receipt.workerUrl !== workerUrl ||
      message.deliveryCapturedAt !== delivery.capturedAt ||
      message.authorId !== capture.authorId ||
      message.canonicalUrl !== capture.canonicalUrl ||
      discordMessageChanged(message, capture).changed
    )
      return undefined
    return {
      view: {
        source: retained.source,
        messages: retained.messages,
        binding: retained.bindings[0] ?? {
          id: '',
          sourceId: retained.source.id,
          resourceId: '',
          createdAt: retained.source.createdAt,
        },
      },
      notificationPosted: Boolean(receipt.notificationState),
      messageKey: message.id,
      attachmentState: receipt.attachmentState,
    }
  }

  async getSourceUsageByKeyHash(sourceKeyHash: string): Promise<ResourceSourceBinding[]> {
    if (!/^[a-f0-9]{64}$/iu.test(sourceKeyHash)) throw new Error('社区来源哈希无效')
    const source = await this.storage.getSourceByKeyHash(sourceKeyHash.toLowerCase())
    return source ? this.storage.listBindingsForSource(source.id) : []
  }

  async getAttachmentBlob(assetId: string): Promise<Blob | undefined> {
    return this.assetStore?.getBlob(assetId)
  }

  async saveDiscordCapture(
    captureInput: DiscordCapture,
    options: DiscordCaptureSaveOptions = {},
  ): Promise<ResourceCommunitySourceView> {
    const capture = normalizeCapture(captureInput)
    const capturedAt = options.capturedAt ?? Date.now()
    if (!Number.isFinite(capturedAt) || capturedAt < 0) throw new Error('Discord 快照时间无效')
    const sourceKeyHash = await hashIdentity(createDiscordSourceKey(capture))
    return withCaptureSave(
      'discord-local-media',
      () =>
        withCaptureSave(sourceKeyHash, () =>
          this.persistDiscordCapture(capture, sourceKeyHash, capturedAt, options),
        ),
      'shared',
    )
  }

  private async persistDiscordCapture(
    capture: DiscordCapture,
    sourceKeyHash: string,
    capturedAt: number,
    options: DiscordCaptureSaveOptions,
  ): Promise<ResourceCommunitySourceView> {
    const now = Date.now()
    let source = await this.storage.getSourceByKeyHash(sourceKeyHash)
    const existingMessage = source
      ? await this.storage.getMessage(source.id, await messageKeyHash(source.id, capture.messageId))
      : undefined
    const stale = existingMessage && olderDiscordDelivery(existingMessage, capture, capturedAt)

    if (!source) {
      source = {
        id: createCommunitySourceId(),
        platform: COMMUNITY_SOURCE_PLATFORM.DISCORD,
        sourceKeyHash,
        guildId: capture.guildId,
        guildName: capture.guildName,
        channelId: capture.channelId,
        channelName: capture.channelName,
        threadId: capture.threadId,
        starterMessageId:
          capture.isStarter || capture.starterMessageId
            ? (capture.starterMessageId ?? capture.messageId)
            : undefined,
        canonicalUrl: capture.canonicalUrl,
        title: capture.title,
        starterAuthorId: capture.isStarter ? capture.authorId : undefined,
        starterAuthorName: capture.isStarter ? capture.authorName : undefined,
        forumTags: normalizeStringList(capture.forumTags),
        metadataCapturedAt: capturedAt,
        createdAt: now,
        updatedAt: now,
      }
    } else {
      source = withDiscordSourceMetadata(source, capture, capturedAt, now)
      if (!stale) {
        source.updatedAt = now
        if (capture.isStarter) {
          source.starterMessageId = capture.messageId
          source.starterAuthorId = capture.authorId
        } else if (!source.starterMessageId && capture.starterMessageId) {
          source.starterMessageId = capture.starterMessageId
        }
      }
    }

    const sourceId = source.id
    const keyHash = await messageKeyHash(sourceId, capture.messageId)
    const inferredKind: CommunitySourceMessageKind =
      options.kind ??
      (capture.isStarter || capture.messageId === source.starterMessageId
        ? COMMUNITY_SOURCE_MESSAGE_KIND.STARTER
        : source.starterAuthorId && capture.authorId === source.starterAuthorId
          ? COMMUNITY_SOURCE_MESSAGE_KIND.AUTHOR_UPDATE
          : COMMUNITY_SOURCE_MESSAGE_KIND.SELECTED_COMMENT)
    const unchanged = existingMessage && !discordMessageChanged(existingMessage, capture).changed
    const needsLocalization =
      this.assetStore &&
      (!unchanged ||
        (capture.attachments ?? []).some(
          (attachment) =>
            attachment.size <= AUTO_LOCAL_ATTACHMENT_BYTES &&
            !existingMessage.attachments.some(
              (previous) =>
                previous.localAssetId && attachmentIdentityMatches(previous, attachment),
            ),
        ))
    const attachments = stale
      ? existingMessage.attachments
      : options.deferAttachmentLocalization || !needsLocalization
        ? this.prepareDeferredAttachments(
            capture.attachments ?? [],
            existingMessage?.attachments ?? [],
          )
        : await this.localizeAttachments(
            capture.attachments ?? [],
            existingMessage?.attachments ?? [],
            AUTO_LOCAL_ATTACHMENT_BYTES,
          )
    let message: CommunitySourceMessage = {
      id: createCommunitySourceMessageId(sourceId, keyHash),
      sourceId,
      messageKeyHash: keyHash,
      messageId: capture.messageId,
      kind: options.kind ?? existingMessage?.kind ?? inferredKind,
      authorId: capture.authorId,
      authorName: capture.authorName,
      authorBot: capture.authorBot === true,
      pinned: capture.pinned ?? existingMessage?.pinned,
      content: capture.content,
      embeds: structuredClone(capture.embeds ?? []),
      attachments,
      canonicalUrl: capture.canonicalUrl,
      timestamp: capture.timestamp,
      editedTimestamp: capture.editedTimestamp,
      remoteState: existingMessage?.remoteState,
      lastRemoteCheckedAt: existingMessage?.lastRemoteCheckedAt,
      capturedAt: existingMessage?.capturedAt ?? now,
      deliveryCapturedAt: capturedAt,
      updatedAt: now,
    }
    if (stale) {
      message = { ...existingMessage, kind: options.kind ?? existingMessage.kind }
    }
    if (this.storage.putSourceWithMessages)
      await this.storage.putSourceWithMessages(source, [message])
    else {
      await this.storage.putSource(source)
      await this.storage.putMessage(message)
    }

    let binding: ResourceSourceBinding
    if (options.resourceId) {
      const existingBinding = (await this.storage.listBindingsForResource(options.resourceId)).find(
        (candidate) => candidate.sourceId === sourceId,
      )
      binding =
        existingBinding ??
        ({
          id: createResourceSourceBindingId(options.resourceId, sourceId),
          resourceId: options.resourceId,
          sourceId,
          note: clean(options.note, 2_000),
          createdAt: now,
        } satisfies ResourceSourceBinding)
      if (!existingBinding) await this.storage.putBinding(binding)
    } else {
      binding = {
        id: '',
        resourceId: '',
        sourceId,
        createdAt: now,
      }
    }

    const messages = await this.storage.listMessages(sourceId)
    const savedMessage = messages.find((item) => item.messageId === capture.messageId)
    if (
      !savedMessage ||
      (discordMessageChanged(savedMessage, message).changed &&
        !olderDiscordDelivery(
          savedMessage,
          message,
          message.deliveryCapturedAt ?? message.updatedAt,
        ))
    ) {
      throw new Error('Discord 消息保存后无法读回，请重试领取')
    }
    source = withMessageSummary(source, messages)
    await this.storage.putSource(source)
    const savedSource = await this.storage.getSource(sourceId)
    if (!savedSource) throw new Error('Discord 来源保存后无法读回，请重试领取')
    return { source: savedSource, messages, binding }
  }

  async localizeSavedMessageAttachments(
    sourceId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.assetStore || signal?.aborted) return
    const source = await this.storage.getSource(sourceId)
    if (!source) return
    await withCaptureSave(
      'discord-local-media',
      () =>
        withCaptureSave(source.sourceKeyHash, () =>
          this.persistSavedMessageAttachments(sourceId, messageId, signal),
        ),
      'shared',
    )
  }

  private async persistSavedMessageAttachments(
    sourceId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const keyHash = await messageKeyHash(sourceId, messageId)
    const message = await this.storage.getMessage(sourceId, keyHash)
    if (!message?.attachments.length) return
    const attachments = await this.localizeAttachments(
      message.attachments,
      message.attachments,
      AUTO_LOCAL_ATTACHMENT_BYTES,
      false,
      signal,
    )
    await this.storage.putMessage({ ...message, attachments, updatedAt: Date.now() })
  }

  async localizeSavedMessagesAttachments(
    sourceId: string,
    messageIds: readonly string[],
  ): Promise<void> {
    // 跨消息也串行，避免多个 8 MB 附件在移动端同时 response.blob()。
    for (const messageId of Array.from(new Set(messageIds))) {
      await this.localizeSavedMessageAttachments(sourceId, messageId)
    }
  }

  async bindSource(
    resourceId: string,
    sourceId: string,
    note?: string,
    autoBindingRule?: ResourceSourceBinding['autoBindingRule'],
  ): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const source = await this.storage.getSource(sourceId)
        if (!source) throw new Error('社区来源不存在')
        const existing = (await this.storage.listBindingsForResource(resourceId)).some(
          (binding) => binding.sourceId === sourceId,
        )
        if (!existing) {
          const binding = {
            id: createResourceSourceBindingId(resourceId, sourceId),
            resourceId,
            sourceId,
            note: clean(note, 2_000),
            ...(autoBindingRule ? { autoBindingRule } : {}),
            createdAt: Date.now(),
          }
          if (autoBindingRule) {
            delete source.autoBindScan
            delete source.autoBindPendingPng
            source.updatedAt = Date.now()
            if (this.storage.putSourceWithBinding)
              await this.storage.putSourceWithBinding(source, binding)
            else {
              await this.storage.putSource(source)
              await this.storage.putBinding(binding)
            }
          } else await this.storage.putBinding(binding)
        }
        if (typeof window !== 'undefined')
          window.dispatchEvent(
            new CustomEvent('srl:community-source-bound', {
              detail: { sourceKeyHash: source.sourceKeyHash },
            }),
          )
      },
      'shared',
    )
  }

  async unbindSource(resourceId: string, sourceId: string): Promise<void> {
    await this.storage.deleteBinding(createResourceSourceBindingId(resourceId, sourceId))
  }

  async listRecentAutoBindings(limit = 100): Promise<ResourceCommunitySourceSummary[]> {
    const bindings = await this.storage.listRecentAutoBindings?.(limit)
    if (!bindings?.length) return []
    const summaries = await Promise.all(
      bindings.map(async (binding) => {
        const source = await this.getSourceSummary(binding.sourceId)
        return source ? { source, binding } : undefined
      }),
    )
    return summaries.flatMap((summary) => (summary ? [summary] : []))
  }

  async clearRecentAutoBindings(limit = 100): Promise<number> {
    const bindings = await this.storage.listRecentAutoBindings?.(limit)
    if (!bindings?.length) return 0
    for (const binding of bindings) await this.storage.deleteBinding(binding.id)
    return bindings.length
  }

  async confirmAutoBinding(resourceId: string, sourceId: string): Promise<void> {
    const binding = (await this.storage.listBindingsForResource(resourceId)).find(
      (candidate) => candidate.sourceId === sourceId && candidate.autoBindingRule,
    )
    if (!binding) throw new Error('这条自动关联已处理或不存在。')
    const confirmed = { ...binding }
    delete confirmed.autoBindingRule
    delete confirmed.note
    await this.storage.putBinding(confirmed)
  }

  async replaceAutoBinding(
    currentResourceId: string,
    nextResourceId: string,
    sourceId: string,
  ): Promise<void> {
    if (currentResourceId === nextResourceId) {
      await this.confirmAutoBinding(currentResourceId, sourceId)
      return
    }
    const binding = (await this.storage.listBindingsForResource(currentResourceId)).find(
      (candidate) => candidate.sourceId === sourceId && candidate.autoBindingRule,
    )
    if (!binding) throw new Error('这条自动关联已处理或不存在。')
    if (!(await this.storage.getSource(sourceId))) throw new Error('社区来源不存在')

    await this.bindSource(nextResourceId, sourceId)
    await this.unbindSource(currentResourceId, sourceId)
    const replacement = (await this.storage.listBindingsForResource(nextResourceId)).find(
      (candidate) => candidate.sourceId === sourceId,
    )
    if (replacement?.autoBindingRule) {
      const confirmed = { ...replacement }
      delete confirmed.autoBindingRule
      delete confirmed.note
      await this.storage.putBinding(confirmed)
    }
  }

  async setMessageKind(
    sourceId: string,
    messageId: string,
    kind: CommunitySourceMessageKind,
  ): Promise<CommunitySourceMessage> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        const keyHash = await messageKeyHash(sourceId, messageId)
        const message = await this.storage.getMessage(sourceId, keyHash)
        if (!message) throw new Error('已保存的 Discord 消息不存在')
        const updated = { ...message, kind, updatedAt: Date.now() }
        await this.storage.putMessage(updated)
        return updated
      },
      'shared',
    )
  }

  async restoreRevision(
    sourceId: string,
    revisionId: string,
  ): Promise<{ source: CommunitySource; messages: CommunitySourceMessage[] }> {
    const source = await this.storage.getSource(sourceId)
    if (!source) throw new Error('社区来源不存在')
    return withCaptureSave(
      'discord-local-media',
      () => withCaptureSave(source.sourceKeyHash, () => this.persistRevision(sourceId, revisionId)),
      'shared',
    )
  }

  private async persistRevision(
    sourceId: string,
    revisionId: string,
  ): Promise<{ source: CommunitySource; messages: CommunitySourceMessage[] }> {
    const source = await this.storage.getSource(sourceId)
    if (!source) throw new Error('社区来源不存在')
    const target = source.revisions?.find((revision) => revision.id === revisionId)
    if (!target) throw new Error('历史版本不存在')
    const currentMessages = await this.storage.listMessages(sourceId)
    const currentByMessageId = new Map(
      currentMessages.map((message) => [message.messageId, message]),
    )
    const now = Date.now()
    const rollbackRevision = makeRevision(source, currentMessages, now)
    let restoredSource: CommunitySource = {
      ...source,
      canonicalUrl: target.source.canonicalUrl,
      title: target.source.title,
      starterMessageId: target.source.starterMessageId ?? source.starterMessageId,
      starterAuthorId: target.source.starterAuthorId,
      starterAuthorName: target.source.starterAuthorName,
      forumTags: structuredClone(target.source.forumTags),
      remoteState: undefined,
      hasRemoteUpdate: false,
      lastCheckedAt: undefined,
      remoteScanCursor: undefined,
      savedMessageCheckCursor: undefined,
      revisions: [...(source.revisions ?? []), rollbackRevision],
      metadataCapturedAt: Math.max(sourceMetadataCapturedAt(source), now),
      updatedAt: now,
    }
    const restoredMessages = target.messages.map((message) => ({
      ...structuredClone(message),
      sourceId,
      remoteState: undefined,
      lastRemoteCheckedAt: undefined,
      deliveryCapturedAt: Math.max(
        currentByMessageId.get(message.messageId)?.deliveryCapturedAt ?? 0,
        message.deliveryCapturedAt ?? message.updatedAt,
        now,
      ),
      updatedAt: now,
    }))
    restoredSource = withMessageSummary(restoredSource, restoredMessages)

    if (this.storage.replaceSourceWithMessages) {
      await this.storage.replaceSourceWithMessages(restoredSource, restoredMessages)
    } else {
      const existing = await this.storage.listMessages(sourceId)
      await this.storage.putSource(restoredSource)
      for (const message of existing) await this.storage.deleteMessage(message.id)
      for (const message of restoredMessages) await this.storage.putMessage(message)
    }
    return { source: restoredSource, messages: restoredMessages }
  }

  async saveAttachmentToLocal(
    sourceId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<CommunitySourceMessage> {
    const source = await this.storage.getSource(sourceId)
    if (!source) throw new Error('社区来源不存在')
    return withCaptureSave(
      'discord-local-media',
      () =>
        withCaptureSave(source.sourceKeyHash, () =>
          this.persistAttachmentToLocal(sourceId, messageId, attachmentId),
        ),
      'shared',
    )
  }

  private async persistAttachmentToLocal(
    sourceId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<CommunitySourceMessage> {
    if (!this.assetStore) throw new Error('当前环境没有可用的本地附件存储')
    const keyHash = await messageKeyHash(sourceId, messageId)
    const message = await this.storage.getMessage(sourceId, keyHash)
    if (!message) throw new Error('已保存的 Discord 消息不存在')
    const index = message.attachments.findIndex((attachment) => attachment.id === attachmentId)
    if (index < 0) throw new Error('Discord 附件不存在')
    const target = message.attachments[index]
    const [localized] = await this.localizeAttachments(
      [target],
      [],
      MAX_MANUAL_LOCAL_ATTACHMENT_BYTES,
      true,
    )
    const attachments = [...message.attachments]
    if (localized) attachments[index] = localized
    const updated = { ...message, attachments, updatedAt: Date.now() }
    await this.storage.putMessage(updated)
    if (!localized?.localAssetId) {
      if (target.size > MAX_MANUAL_LOCAL_ATTACHMENT_BYTES) {
        throw new Error('附件超过 64 MB，为避免移动端内存峰值暂不支持直接缓存到本机')
      }
      throw new Error('附件保存到本机失败，请检查网络后重试')
    }
    return updated
  }

  async deleteSavedMessage(
    sourceId: string,
    messageId: string,
    mode: 'message-only' | 'entire-source' = 'message-only',
  ): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        if (mode === 'entire-source') {
          await this.deleteSource(sourceId)
          return
        }
        const keyHash = await messageKeyHash(sourceId, messageId)
        const message = await this.storage.getMessage(sourceId, keyHash)
        if (!message) return

        const messages = await this.storage.listMessages(sourceId)
        if (messages.length <= 1) {
          const bindings = await this.storage.listBindingsForSource(sourceId)
          if (bindings.length) {
            throw new Error(
              '这是这个 Discord 来源最后一条本地内容，请使用“来源管理”解除关联或永久删除来源。',
            )
          }
          await this.storage.deleteSource(sourceId)
          return
        }

        await this.storage.deleteMessage(message.id)
        const source = await this.storage.getSource(sourceId)
        if (source) {
          await this.storage.putSource(
            withMessageSummary(
              source,
              messages.filter((candidate) => candidate.id !== message.id),
            ),
          )
        }
      },
      'shared',
    )
  }

  async deleteSource(sourceId: string, options: { force?: boolean } = {}): Promise<void> {
    const bindings = await this.storage.listBindingsForSource(sourceId)
    if (bindings.length && options.force !== true) {
      throw new Error(
        `这个 Discord 来源仍被 ${bindings.length} 个资源使用，请先解除关联或确认永久删除。`,
      )
    }
    await this.storage.deleteSource(sourceId)
  }

  exportAll(): Promise<CommunitySourceBackupData> {
    return this.storage.exportAll()
  }

  restoreBackup(data: CommunitySourceBackupData, mode: 'merge' | 'replace'): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        return mode === 'replace' ? this.storage.replaceAll(data) : this.storage.mergeAll(data)
      },
      'shared',
    )
  }

  replaceAll(data: CommunitySourceBackupData): Promise<void> {
    return withCaptureSave(
      'discord-local-media',
      async () => {
        return this.storage.replaceAll(data)
      },
      'shared',
    )
  }

  private prepareDeferredAttachments(
    remoteAttachments: readonly DiscordAttachmentMeta[],
    existingAttachments: readonly DiscordAttachmentMeta[],
  ): DiscordAttachmentMeta[] {
    const normalized = normalizeAttachments([...remoteAttachments])
    const existingById = new Map(
      existingAttachments.map((attachment) => [attachment.id, attachment]),
    )
    return normalized.map((attachment) => {
      const previous = existingById.get(attachment.id)
      if (previous?.localAssetId && attachmentIdentityMatches(previous, attachment)) {
        return {
          ...attachment,
          localAssetId: previous.localAssetId,
          localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.LOCAL,
        }
      }
      return { ...attachment, localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY }
    })
  }

  private async localizeAttachments(
    remoteAttachments: readonly DiscordAttachmentMeta[],
    existingAttachments: readonly DiscordAttachmentMeta[],
    maxBytes: number,
    force = false,
    signal?: AbortSignal,
  ): Promise<DiscordAttachmentMeta[]> {
    const normalized = normalizeAttachments([...remoteAttachments])
    if (!force && !(await this.shouldDownloadPostMedia())) {
      return this.prepareDeferredAttachments(normalized, existingAttachments)
    }
    if (!this.assetStore) return normalized
    const existingById = new Map(
      existingAttachments.map((attachment) => [attachment.id, attachment]),
    )
    const result: DiscordAttachmentMeta[] = []

    // 串行下载：Discord 单条消息可能有多个接近 8 MB 的附件；并发 response.blob() 会在移动端
    // 叠加峰值内存。这里宁愿略慢，也不同时把多份二进制驻留内存。
    for (const attachment of normalized) {
      const previous = existingById.get(attachment.id)
      if (signal?.aborted) {
        // Commit completed attachment references, leave the rest remote for explicit continuation.
        result.push(
          previous ?? {
            ...attachment,
            localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY,
          },
        )
        continue
      }
      if (previous?.localAssetId && attachmentIdentityMatches(previous, attachment)) {
        result.push({
          ...attachment,
          localAssetId: previous.localAssetId,
          localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.LOCAL,
        })
        continue
      }
      if (attachment.size > maxBytes) {
        result.push({
          ...attachment,
          localState: force
            ? COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.FAILED
            : COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY,
        })
        continue
      }
      try {
        const blob = await this.downloadAttachment(attachment, maxBytes, signal)
        const asset = await this.assetStore.put(blob, {
          source: 'remote',
          remoteUrl: attachment.url,
          vaultProtected: true,
        })
        result.push({
          ...attachment,
          localAssetId: asset.assetId,
          localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.LOCAL,
        })
      } catch {
        if (previous?.localAssetId) {
          result.push({
            ...attachment,
            localAssetId: previous.localAssetId,
            localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.LOCAL,
          })
        } else {
          result.push({
            ...attachment,
            localState: force
              ? COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.FAILED
              : COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY,
          })
        }
      }
    }
    return result
  }

  private async downloadAttachment(
    attachment: DiscordAttachmentMeta,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const candidates = [safeHttpUrl(attachment.url), safeHttpUrl(attachment.proxyUrl)].filter(
      (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
    )
    if (!candidates.length) throw new Error('Discord 附件链接无效')
    if (attachment.size > maxBytes) throw new Error('Discord 附件超过本次本地保存限制')

    let lastError: unknown
    for (const remoteUrl of candidates) {
      signal?.throwIfAborted()
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS)
      try {
        const response = await fetch(remoteUrl, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Discord 附件读取失败（HTTP ${response.status}）`)
        const contentLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          throw new Error('Discord 附件超过本次本地保存限制')
        }
        const blob = await response.blob()
        if (blob.size > maxBytes) throw new Error('Discord 附件超过本次本地保存限制')
        return blob.type || !attachment.contentType
          ? blob
          : new Blob([blob], { type: attachment.contentType })
      } catch (error) {
        signal?.throwIfAborted()
        lastError = error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Discord 附件读取失败')
  }
}
