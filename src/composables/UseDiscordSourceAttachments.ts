import type { Ref } from 'vue'
import { ref } from 'vue'
import { communitySourceService } from '../core/CommunitySourceRuntime'
import {
  COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE,
  COMMUNITY_SOURCE_MESSAGE_KIND,
  type CommunitySourceMessage,
  type DiscordAttachmentMeta,
  type ResourceCommunitySourceView,
} from '../types/CommunitySource'
import type { DiscordCommunitySourcesProps } from '../types/DiscordCommunitySourcesView'
import {
  isImageAttachment,
  presentDiscordEmbed,
  type DiscordEmbedPresentation,
} from '../utils/DiscordMessagePresentation'

interface DiscordSourceAttachmentsContext {
  detailSource: Ref<ResourceCommunitySourceView | undefined>
  detailLoading: Ref<boolean, boolean>
  detailLoadGeneration: number
  props: Readonly<DiscordCommunitySourcesProps>
  embedCache: Map<string, DiscordEmbedPresentation[]>
  savingAttachmentKey: Ref<string, string>
  operationError: Ref<string, string>
  load: () => Promise<void>
  showTransientStatus: (message: string, timeoutMs?: number) => void
}

export function useDiscordSourceAttachments(getContext: () => DiscordSourceAttachmentsContext) {
  const localAttachmentUrls = ref<Record<string, string>>({})
  let attachmentHydrationGeneration = 0

  function revokeAttachmentObjectUrls(): void {
    for (const value of Object.values(localAttachmentUrls.value)) URL.revokeObjectURL(value)
    localAttachmentUrls.value = {}
  }

  function clearAttachmentObjectUrls(): void {
    attachmentHydrationGeneration += 1
    revokeAttachmentObjectUrls()
  }

  function handleBackgroundAttachmentUpdate(event: Event): void {
    const context = getContext()

    const sourceId =
      event instanceof CustomEvent &&
      event.detail &&
      typeof event.detail === 'object' &&
      'sourceId' in event.detail &&
      typeof event.detail.sourceId === 'string'
        ? event.detail.sourceId
        : ''
    const openSourceId = context.detailSource.value?.source.id
    if (!sourceId || sourceId !== openSourceId || context.detailLoading.value) return

    const generation = context.detailLoadGeneration
    void communitySourceService
      .getForResource(context.props.resourceId, sourceId)
      .then((view) => {
        if (
          !view ||
          generation !== context.detailLoadGeneration ||
          context.detailSource.value?.source.id !== sourceId
        ) {
          return
        }
        context.detailSource.value = view
        void hydrateLocalAttachments(view.messages)
      })
      .catch(() => undefined)
  }

  async function hydrateLocalAttachments(
    messages: readonly CommunitySourceMessage[],
  ): Promise<void> {
    const generation = ++attachmentHydrationGeneration
    revokeAttachmentObjectUrls()
    const assetIds = Array.from(
      new Set(
        messages.flatMap((message) =>
          message.attachments.flatMap((attachment) =>
            attachment.localAssetId ? [attachment.localAssetId] : [],
          ),
        ),
      ),
    )
    const next: Record<string, string> = {}
    for (const assetId of assetIds) {
      try {
        const blob = await communitySourceService.getAttachmentBlob(assetId)
        if (generation !== attachmentHydrationGeneration) {
          for (const value of Object.values(next)) URL.revokeObjectURL(value)
          return
        }
        if (blob) next[assetId] = URL.createObjectURL(blob)
      } catch {
        // 元数据仍保留；UI 会显示“本机副本不可用”，并允许用户重新保存。
      }
    }
    if (generation !== attachmentHydrationGeneration) {
      for (const value of Object.values(next)) URL.revokeObjectURL(value)
      return
    }
    localAttachmentUrls.value = next
  }

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '大小未知'
    if (value < 1024) return `${Math.round(value)} B`
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
    return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }

  function kindLabel(message: CommunitySourceMessage): string {
    if (message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.STARTER) return '原帖 / 首楼'
    if (message.pinned) return '已标注信息'
    if (message.authorBot) return 'Bot 消息'
    if (message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.AUTHOR_UPDATE) return '作者补充'
    return '精选评论'
  }

  function embedPresentations(message: CommunitySourceMessage): DiscordEmbedPresentation[] {
    const context = getContext()

    const cached = context.embedCache.get(message.id)
    if (cached) return cached
    const embeds = message.embeds.map(presentDiscordEmbed)
    context.embedCache.set(message.id, embeds)
    return embeds
  }

  function imageAttachments(message: CommunitySourceMessage): DiscordAttachmentMeta[] {
    return message.attachments.filter(isImageAttachment)
  }

  function fileAttachments(message: CommunitySourceMessage): DiscordAttachmentMeta[] {
    return message.attachments.filter((attachment) => !isImageAttachment(attachment))
  }

  function safeAttachmentUrl(attachment: DiscordAttachmentMeta): string | undefined {
    const candidate = attachment.proxyUrl || attachment.url
    try {
      const parsed = new URL(candidate)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
        ? parsed.toString()
        : undefined
    } catch {
      return undefined
    }
  }

  function attachmentDisplayUrl(attachment: DiscordAttachmentMeta): string | undefined {
    if (attachment.localAssetId) {
      const local = localAttachmentUrls.value[attachment.localAssetId]
      if (local) return local
    }
    return safeAttachmentUrl(attachment)
  }

  function attachmentIsLocal(attachment: DiscordAttachmentMeta): boolean {
    return Boolean(attachment.localAssetId && localAttachmentUrls.value[attachment.localAssetId])
  }

  function attachmentLocalLabel(attachment: DiscordAttachmentMeta): string {
    if (attachmentIsLocal(attachment)) return '已保存本机'
    if (attachment.localAssetId) return '本机副本不可用'
    if (attachment.localState === COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.FAILED)
      return '本机保存失败'
    if (attachment.localState === COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.REMOTE_ONLY)
      return '仅远端'
    return '仅远端'
  }

  function attachmentSaveKey(
    message: CommunitySourceMessage,
    attachment: DiscordAttachmentMeta,
  ): string {
    return `${message.id}:${attachment.id}`
  }

  async function saveAttachmentToLocal(
    message: CommunitySourceMessage,
    attachment: DiscordAttachmentMeta,
  ): Promise<void> {
    const context = getContext()

    if (!context.detailSource.value || context.savingAttachmentKey.value) return
    const key = attachmentSaveKey(message, attachment)
    context.savingAttachmentKey.value = key
    context.operationError.value = ''
    try {
      await communitySourceService.saveAttachmentToLocal(
        context.detailSource.value.source.id,
        message.messageId,
        attachment.id,
      )
      await context.load()
      context.showTransientStatus('附件已保存到本机')
    } catch (error) {
      context.operationError.value = error instanceof Error ? error.message : '附件保存到本机失败'
    } finally {
      context.savingAttachmentKey.value = ''
    }
  }
  return {
    revokeAttachmentObjectUrls,
    clearAttachmentObjectUrls,
    handleBackgroundAttachmentUpdate,
    hydrateLocalAttachments,
    formatBytes,
    kindLabel,
    embedPresentations,
    imageAttachments,
    fileAttachments,
    safeAttachmentUrl,
    attachmentDisplayUrl,
    attachmentIsLocal,
    attachmentLocalLabel,
    attachmentSaveKey,
    saveAttachmentToLocal,
  }
}
