import type { EmitFn } from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { type ActionSheetAction } from '../components/ActionSheet.vue'
import { useTransientStatus } from '../composables/UseTransientStatus'
import { communitySourceService } from '../core/CommunitySourceRuntime'
import {
  COMMUNITY_SOURCE_MESSAGE_KIND,
  type CommunitySourceMessage,
  type CommunitySourceRevision,
  type ResourceCommunitySourceSummary,
  type ResourceCommunitySourceView,
} from '../types/CommunitySource'
import type {
  DiscordCommunitySourcesEvents,
  DiscordCommunitySourcesProps,
  RevisionComparisonItem,
  RevisionViewMode,
  SourcePresentation,
} from '../types/DiscordCommunitySourcesView'
import {
  previewDiscordMessage,
  type DiscordEmbedPresentation,
} from '../utils/DiscordMessagePresentation'
import { useDiscordSourceAttachments } from './UseDiscordSourceAttachments'
export type {
  DiscordCommunitySourcesEvents,
  DiscordCommunitySourcesProps,
  RevisionComparisonItem,
  RevisionViewMode,
  SourcePresentation,
} from '../types/DiscordCommunitySourcesView'

export function useDiscordCommunitySources(
  props: Readonly<DiscordCommunitySourcesProps>,
  emit: EmitFn<DiscordCommunitySourcesEvents>,
) {
  const {
    clearAttachmentObjectUrls,
    handleBackgroundAttachmentUpdate,
    hydrateLocalAttachments,
    formatBytes,
    kindLabel,
    embedPresentations,
    imageAttachments,
    fileAttachments,
    attachmentDisplayUrl,
    attachmentIsLocal,
    attachmentLocalLabel,
    attachmentSaveKey,
    saveAttachmentToLocal,
  } = useDiscordSourceAttachments(() => ({
    detailSource,
    detailLoading,
    get detailLoadGeneration() {
      return detailLoadGeneration
    },
    set detailLoadGeneration(value: typeof detailLoadGeneration) {
      detailLoadGeneration = value
    },
    props,
    embedCache,
    savingAttachmentKey,
    operationError,
    load,
    showTransientStatus,
  }))

  const summaries = ref<ResourceCommunitySourceSummary[]>([])

  const loading = ref(false)

  const loadError = ref('')

  const detailSource = ref<ResourceCommunitySourceView>()

  const detailLoading = ref(false)

  const detailLoadError = ref('')

  const detailSelectedMessageId = ref('')

  const navigationOpen = ref(false)

  const actionMessage = ref<CommunitySourceMessage>()

  const actionSource = ref<ResourceCommunitySourceView>()

  const actionSheetOpen = ref(false)

  const deleteStarterModeOpen = ref(false)

  const operationError = ref('')

  const historyOpen = ref(false)

  const selectedRevision = ref<CommunitySourceRevision>()

  const revisionViewMode = ref<RevisionViewMode>('view')

  const revisionSheetOpen = ref(false)

  const revisionRestoreConfirmOpen = ref(false)

  const restoringRevision = ref(false)

  const managedSource = ref<ResourceCommunitySourceView>()

  const sourceManagementOpen = ref(false)

  const sourceDeleteConfirmOpen = ref(false)

  const sourceUsageCount = ref(0)

  const savingAttachmentKey = ref('')

  const { statusMessage, showTransientStatus } = useTransientStatus()

  const embedCache = new Map<string, DiscordEmbedPresentation[]>()

  let longPressTimer: number | undefined

  let longPressStartX = 0

  let longPressStartY = 0

  let detailLoadGeneration = 0

  const detailMessages = computed(() => sortMessages(detailSource.value?.messages ?? []))

  const detailRevisions = computed(() =>
    [...(detailSource.value?.source.revisions ?? [])].sort(
      (left, right) => right.createdAt - left.createdAt,
    ),
  )

  const selectedRevisionMessages = computed(() =>
    sortMessages(selectedRevision.value?.messages ?? []),
  )

  const navigationGroups = computed(() => {
    const messages = detailMessages.value
    return [
      {
        id: 'starter',
        label: '首楼',
        items: messages.filter((message) => message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.STARTER),
      },
      {
        id: 'pinned',
        label: '已标注信息',
        items: messages.filter((message) => message.pinned === true),
      },
      {
        id: 'bot',
        label: 'Bot 消息',
        items: messages.filter(
          (message) => message.authorBot && message.kind !== COMMUNITY_SOURCE_MESSAGE_KIND.STARTER,
        ),
      },
      {
        id: 'author-update',
        label: '作者补充',
        items: messages.filter(
          (message) =>
            !message.authorBot && message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.AUTHOR_UPDATE,
        ),
      },
      {
        id: 'selected-comment',
        label: '精选评论',
        items: messages.filter(
          (message) =>
            !message.authorBot && message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.SELECTED_COMMENT,
        ),
      },
    ].filter((group) => group.items.length > 0)
  })

  const detailSourceDate = computed(() => {
    const first = detailMessages.value[0]
    if (!first) return ''
    const date = new Date(first.timestamp)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN')
  })

  const actionSheetActions = computed<readonly ActionSheetAction[]>(() => {
    const message = actionMessage.value
    if (!message) return []
    return [
      { id: 'open', label: '打开 Discord 原消息' },
      { id: 'copy', label: '复制链接' },
      ...(message.kind !== COMMUNITY_SOURCE_MESSAGE_KIND.STARTER
        ? [
            {
              id: 'authorUpdate',
              label: '归类为作者补充',
              disabled: message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.AUTHOR_UPDATE,
            },
            {
              id: 'selectedComment',
              label: '归类为精选评论',
              disabled: message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.SELECTED_COMMENT,
            },
          ]
        : []),
      {
        id: 'delete',
        label: '删除这条保存内容',
        description: '只删除本机 SRL 副本，不会影响 Discord 原消息',
        danger: true,
      },
    ]
  })

  const sourceManagementActions = computed<readonly ActionSheetAction[]>(() => [
    {
      id: 'unbind',
      label: '从当前资源移除',
      description: '只解除当前资源的关联，不删除本地来源内容',
    },
    {
      id: 'delete-source',
      label: '永久删除本机来源',
      description:
        sourceUsageCount.value > 1
          ? `当前仍被 ${sourceUsageCount.value} 个资源使用；确认后所有关联都会删除`
          : '删除这个来源的本机消息、历史版本与全部资源关联',
      danger: true,
    },
  ])

  const revisionComparison = computed(() => {
    const revision = selectedRevision.value
    if (!revision)
      return {
        currentOnly: 0,
        revisionOnly: 0,
        changed: 0,
        same: 0,
        items: [] as RevisionComparisonItem[],
      }
    const currentById = new Map(detailMessages.value.map((message) => [message.messageId, message]))
    const revisionById = new Map(revision.messages.map((message) => [message.messageId, message]))
    const items: RevisionComparisonItem[] = []
    let currentOnly = 0
    let revisionOnly = 0
    let changed = 0
    let same = 0

    for (const message of detailMessages.value) {
      const old = revisionById.get(message.messageId)
      if (!old) {
        currentOnly += 1
        items.push({
          key: `current:${message.messageId}`,
          label: '当前新增',
          authorName: message.authorName,
          summary: navPreview(message),
        })
        continue
      }
      if (archiveMessageSignature(message) !== archiveMessageSignature(old)) {
        changed += 1
        items.push({
          key: `changed:${message.messageId}`,
          label: '内容不同',
          authorName: message.authorName,
          summary: navPreview(message),
        })
      } else {
        same += 1
      }
    }

    for (const message of revision.messages) {
      if (currentById.has(message.messageId)) continue
      revisionOnly += 1
      items.push({
        key: `revision:${message.messageId}`,
        label: '历史版本独有',
        authorName: message.authorName,
        summary: navPreview(message),
      })
    }
    return { currentOnly, revisionOnly, changed, same, items }
  })

  function sortMessages(messages: readonly CommunitySourceMessage[]): CommunitySourceMessage[] {
    return [...messages].sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime()
      const rightTime = new Date(right.timestamp).getTime()
      const safeLeft = Number.isNaN(leftTime) ? left.capturedAt : leftTime
      const safeRight = Number.isNaN(rightTime) ? right.capturedAt : rightTime
      return safeLeft - safeRight || left.capturedAt - right.capturedAt
    })
  }

  function archiveMessageSignature(message: CommunitySourceMessage): string {
    return JSON.stringify({
      kind: message.kind,
      authorId: message.authorId,
      authorName: message.authorName,
      authorBot: Boolean(message.authorBot),
      content: message.content,
      embeds: message.embeds,
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        contentType: attachment.contentType ?? '',
        width: attachment.width ?? null,
        height: attachment.height ?? null,
      })),
      timestamp: message.timestamp,
      editedTimestamp: message.editedTimestamp ?? '',
    })
  }

  function clearPresentationCaches(): void {
    embedCache.clear()
  }

  function placeholderView(summary: ResourceCommunitySourceSummary): ResourceCommunitySourceView {
    const { revisionCount: _revisionCount, ...source } = summary.source
    return {
      source: { ...source, forumTags: [] },
      messages: [],
      binding: summary.binding,
    }
  }

  async function load(): Promise<void> {
    if (!props.resourceId) return
    loading.value = true
    loadError.value = ''
    try {
      const nextSummaries = await communitySourceService.listSummariesForResource(props.resourceId)
      summaries.value = nextSummaries
      emit('count', nextSummaries.length)
      clearPresentationCaches()
      const openSourceId = detailSource.value?.source.id
      if (openSourceId && !detailLoading.value) {
        const summary = nextSummaries.find((item) => item.source.id === openSourceId)
        if (!summary) {
          closeDetail()
        } else {
          const refreshed = await communitySourceService.getForResource(
            props.resourceId,
            openSourceId,
          )
          if (refreshed) {
            detailSource.value = refreshed
            void hydrateLocalAttachments(refreshed.messages)
          } else {
            closeDetail()
          }
        }
      }
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : '无法读取 Discord 来源'
    } finally {
      loading.value = false
    }
  }

  watch(
    () => props.resourceId,
    () => {
      closeDetail()
      void load()
    },
  )

  onMounted(() => {
    window.addEventListener(
      'srl:community-source-attachments-updated',
      handleBackgroundAttachmentUpdate,
    )
    void load()
  })

  onBeforeUnmount(() => {
    detailLoadGeneration += 1
    clearLongPress()
    window.removeEventListener(
      'srl:community-source-attachments-updated',
      handleBackgroundAttachmentUpdate,
    )
    clearAttachmentObjectUrls()
  })

  function sourceTitle(view: SourcePresentation): string {
    return view.source.title || view.source.starterAuthorName || 'Discord 发布来源'
  }

  function sourceCommunityLabel(view: SourcePresentation): string {
    const parts = [
      view.source.guildName,
      view.source.channelName ? `#${view.source.channelName}` : '',
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'Discord 发布来源'
  }

  function sourcePreview(view: ResourceCommunitySourceSummary): string {
    return view.source.latestMessagePreview || '已保存来源内容'
  }

  function sourceBadge(): {
    label: string
    tone: 'neutral' | 'ok' | 'warn' | 'bad'
  } {
    return { label: '已保存', tone: 'neutral' }
  }

  function sourceMeta(view: ResourceCommunitySourceSummary): string {
    const revisions = view.source.revisionCount
    const countSuffix =
      typeof view.source.messageCount === 'number' ? ` · ${view.source.messageCount} 条内容` : ''
    const revisionSuffix = revisions ? ` · 历史版本 ${revisions}` : ''
    return `最近保存 ${formatDate(view.source.updatedAt)}${revisionSuffix}${countSuffix}`
  }

  function sourceInitialMessage(
    view: ResourceCommunitySourceView,
  ): CommunitySourceMessage | undefined {
    const messages = sortMessages(view.messages)
    return (
      messages.find((message) => message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.STARTER) ??
      messages[0]
    )
  }

  function messageElementId(message: CommunitySourceMessage): string {
    return `discord-saved-${message.messageKeyHash.slice(0, 24)}`
  }

  async function openSource(summary: ResourceCommunitySourceSummary): Promise<void> {
    const generation = ++detailLoadGeneration
    detailSource.value = placeholderView(summary)
    detailLoading.value = true
    detailLoadError.value = ''
    detailSelectedMessageId.value = ''
    navigationOpen.value = false
    historyOpen.value = false
    operationError.value = ''
    selectedRevision.value = undefined
    revisionSheetOpen.value = false
    clearAttachmentObjectUrls()
    try {
      const view = await communitySourceService.getForResource(props.resourceId, summary.source.id)
      if (generation !== detailLoadGeneration) return
      if (!view) throw new Error('这个 Discord 来源已经不在当前资源中')
      detailSource.value = view
      const initial = sourceInitialMessage(view)
      detailSelectedMessageId.value = initial?.id ?? ''
      void hydrateLocalAttachments(view.messages)
      if (initial) {
        await nextTick()
        if (generation === detailLoadGeneration) {
          document.getElementById(messageElementId(initial))?.scrollIntoView({ block: 'start' })
        }
      }
    } catch (error) {
      if (generation !== detailLoadGeneration) return
      detailLoadError.value =
        error instanceof Error ? error.message : '无法读取本机 Discord 帖子内容'
    } finally {
      if (generation === detailLoadGeneration) detailLoading.value = false
    }
  }

  async function scrollToMessage(message: CommunitySourceMessage): Promise<void> {
    detailSelectedMessageId.value = message.id
    await nextTick()
    document.getElementById(messageElementId(message))?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  function closeDetail(): void {
    detailLoadGeneration += 1
    detailSource.value = undefined
    detailLoading.value = false
    detailLoadError.value = ''
    detailSelectedMessageId.value = ''
    navigationOpen.value = false
    historyOpen.value = false
    operationError.value = ''
    selectedRevision.value = undefined
    revisionSheetOpen.value = false
    clearAttachmentObjectUrls()
  }

  function navigateToMessage(message: CommunitySourceMessage): void {
    navigationOpen.value = false
    void scrollToMessage(message)
  }

  async function navigateToHistory(): Promise<void> {
    navigationOpen.value = false
    historyOpen.value = true
    await nextTick()
    document.getElementById('discord-source-history')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  function clearLongPress(): void {
    if (longPressTimer !== undefined) window.clearTimeout(longPressTimer)
    longPressTimer = undefined
  }

  function startLongPress(
    event: PointerEvent,
    view: ResourceCommunitySourceView,
    message: CommunitySourceMessage,
  ): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    clearLongPress()
    longPressStartX = event.clientX
    longPressStartY = event.clientY
    longPressTimer = window.setTimeout(() => openActions(view, message), 540)
  }

  function moveLongPress(event: PointerEvent): void {
    if (
      Math.abs(event.clientX - longPressStartX) > 10 ||
      Math.abs(event.clientY - longPressStartY) > 10
    ) {
      clearLongPress()
    }
  }

  function finishLongPress(): void {
    clearLongPress()
  }

  function openActions(view: ResourceCommunitySourceView, message: CommunitySourceMessage): void {
    navigationOpen.value = false
    actionSource.value = view
    actionMessage.value = message
    actionSheetOpen.value = true
  }

  function handleContextMenu(
    event: MouseEvent,
    view: ResourceCommunitySourceView,
    message: CommunitySourceMessage,
  ): void {
    event.preventDefault()
    openActions(view, message)
  }

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const input = document.createElement('textarea')
      input.value = value
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.left = '-9999px'
      document.body.append(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    showTransientStatus('链接已复制')
  }

  async function handleAction(action: ActionSheetAction): Promise<void> {
    const view = actionSource.value
    const message = actionMessage.value
    if (!view || !message) return
    if (action.id === 'open') {
      window.open(message.canonicalUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (action.id === 'copy') {
      await copyText(message.canonicalUrl)
      return
    }
    if (action.id === 'authorUpdate' || action.id === 'selectedComment') {
      await communitySourceService.setMessageKind(
        view.source.id,
        message.messageId,
        action.id === 'authorUpdate'
          ? COMMUNITY_SOURCE_MESSAGE_KIND.AUTHOR_UPDATE
          : COMMUNITY_SOURCE_MESSAGE_KIND.SELECTED_COMMENT,
      )
      showTransientStatus(action.id === 'authorUpdate' ? '已归类为作者补充' : '已归类为精选评论')
      await load()
      return
    }
    if (action.id === 'delete') {
      if (message.kind === COMMUNITY_SOURCE_MESSAGE_KIND.STARTER) {
        const otherCount = view.messages.filter((item) => item.id !== message.id).length
        if (otherCount === 0) {
          await openSourceManagement(view)
          return
        }
        deleteStarterModeOpen.value = true
        return
      }
      await deleteMessage()
    }
  }

  async function deleteMessage(): Promise<void> {
    const view = actionSource.value
    const message = actionMessage.value
    if (!view || !message) return
    operationError.value = ''
    try {
      await communitySourceService.deleteSavedMessage(
        view.source.id,
        message.messageId,
        'message-only',
      )
      deleteStarterModeOpen.value = false
      closeDetail()
      showTransientStatus('已删除本机保存副本')
      await load()
      dispatchSourcesChanged()
    } catch (error) {
      operationError.value = error instanceof Error ? error.message : '删除本机保存副本失败'
    }
  }

  async function openSourceManagement(view = detailSource.value): Promise<void> {
    if (!view) return
    managedSource.value = view
    sourceUsageCount.value = (await communitySourceService.getSourceUsage(view.source.id)).length
    sourceManagementOpen.value = true
  }

  async function handleSourceManagementAction(action: ActionSheetAction): Promise<void> {
    const view = managedSource.value
    if (!view) return
    if (action.id === 'unbind') {
      await communitySourceService.unbindSource(props.resourceId, view.source.id)
      sourceManagementOpen.value = false
      closeDetail()
      await load()
      dispatchSourcesChanged()
      showTransientStatus('已从当前资源移除，Discord 来源内容仍保留在本机')
      return
    }
    if (action.id === 'delete-source') {
      sourceManagementOpen.value = false
      sourceDeleteConfirmOpen.value = true
    }
  }

  async function confirmPermanentSourceDelete(): Promise<void> {
    const view = managedSource.value
    if (!view) return
    await communitySourceService.deleteSource(view.source.id, { force: true })
    sourceDeleteConfirmOpen.value = false
    managedSource.value = undefined
    closeDetail()
    await load()
    dispatchSourcesChanged()
    showTransientStatus('已永久删除本机 Discord 来源')
  }

  function dispatchSourcesChanged(): void {
    window.dispatchEvent(new Event('srl:community-sources-changed'))
  }

  function formatDate(value: string | number): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
  }

  function revisionLabel(revision: CommunitySourceRevision, index: number): string {
    return `v${detailRevisions.value.length - index} · ${formatDate(revision.createdAt)}`
  }

  function openRevision(revision: CommunitySourceRevision, mode: RevisionViewMode): void {
    selectedRevision.value = revision
    revisionViewMode.value = mode
    revisionSheetOpen.value = true
  }

  function requestRevisionRestore(revision: CommunitySourceRevision): void {
    selectedRevision.value = revision
    revisionSheetOpen.value = false
    revisionRestoreConfirmOpen.value = true
  }

  async function confirmRevisionRestore(): Promise<void> {
    const view = detailSource.value
    const revision = selectedRevision.value
    if (!view || !revision || restoringRevision.value) return
    restoringRevision.value = true
    operationError.value = ''
    try {
      await communitySourceService.restoreRevision(view.source.id, revision.id)
      revisionRestoreConfirmOpen.value = false
      await load()
      historyOpen.value = true
      selectedRevision.value = undefined
      showTransientStatus('已恢复历史版本；恢复前状态已自动保存为新的历史版本')
    } catch (error) {
      operationError.value = error instanceof Error ? error.message : '恢复历史版本失败'
    } finally {
      restoringRevision.value = false
    }
  }

  function navPreview(message: CommunitySourceMessage): string {
    return previewDiscordMessage(message)
  }
  return {
    loading,
    loadError,
    summaries,
    openSource,
    sourceTitle,
    sourceBadge,
    sourcePreview,
    sourceCommunityLabel,
    sourceMeta,
    statusMessage,
    detailSource,
    closeDetail,
    detailSourceDate,
    formatDate,
    detailLoading,
    openSourceManagement,
    detailLoadError,
    operationError,
    detailMessages,
    messageElementId,
    detailSelectedMessageId,
    handleContextMenu,
    startLongPress,
    moveLongPress,
    finishLongPress,
    kindLabel,
    embedPresentations,
    imageAttachments,
    attachmentDisplayUrl,
    attachmentIsLocal,
    attachmentLocalLabel,
    savingAttachmentKey,
    saveAttachmentToLocal,
    attachmentSaveKey,
    fileAttachments,
    formatBytes,
    copyText,
    openActions,
    detailRevisions,
    historyOpen,
    revisionLabel,
    openRevision,
    requestRevisionRestore,
    navigationOpen,
    navigationGroups,
    navigateToMessage,
    navPreview,
    navigateToHistory,
    revisionSheetOpen,
    selectedRevision,
    revisionViewMode,
    selectedRevisionMessages,
    revisionComparison,
    actionSheetOpen,
    actionSheetActions,
    handleAction,
    deleteStarterModeOpen,
    actionSource,
    deleteMessage,
    sourceManagementOpen,
    sourceUsageCount,
    sourceManagementActions,
    handleSourceManagementAction,
    sourceDeleteConfirmOpen,
    confirmPermanentSourceDelete,
    revisionRestoreConfirmOpen,
    restoringRevision,
    confirmRevisionRestore,
  }
}
