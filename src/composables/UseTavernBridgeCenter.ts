import {
  type TavernBridgeCenterProps,
  type TavernBridgeCenterEvents,
  type LocalSendFilter,
  type TavernReceiveFilter,
  type TransferQueueItem,
  type PersonaAvatarMode,
  type PersonaAvatarPlan,
  type PersonaSendPlan,
} from './../types/TavernBridgeCenter'

export {
  type TavernBridgeCenterProps,
  type TavernBridgeCenterEvents,
  type LocalSendFilter,
  type TavernReceiveFilter,
  type TransferQueueItem,
} from './../types/TavernBridgeCenter'
import {
  beginTransfer as beginTransferOperation,
  endTransfer as endTransferOperation,
  cancelTransfer as cancelTransferOperation,
  bindDirectory as bindDirectoryOperation,
  recordReport as recordReportOperation,
  handleState as handleStateOperation,
  setLocalDirectEnabled as setLocalDirectEnabledOperation,
  acceptPairing as acceptPairingOperation,
  joinDeviceRelay as joinDeviceRelayOperation,
  connectLocalTavern as connectLocalTavernOperation,
  disconnectTavern as disconnectTavernOperation,
  refreshTavernResources as refreshTavernResourcesOperation,
  runPullQueue as runPullQueueOperation,
  pullFromTavern as pullFromTavernOperation,
  retryFailedTransfers as retryFailedTransfersOperation,
  confirmDirectoryWrite as confirmDirectoryWriteOperation,
  sendToTavern as sendToTavernOperation,
  preparePersonaSendPlans as preparePersonaSendPlansOperation,
  preparePersonaAvatarPlans as preparePersonaAvatarPlansOperation,
  runSendQueue as runSendQueueOperation,
  type UseTavernTransferActionsContext,
} from './UseTavernTransferActions'

import type { EmitFn } from 'vue'

import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import { browserStorageService } from '../core/AppContainer'
import type { TavernSendContent } from '../types/BrowserPreferences'

import { tavernConnectionStore, type TavernConnectionSnapshot } from '../core/TavernConnectionStore'

import { canUseLocalTavernDirect } from '../services/LanDirectService'

import { type ChatReturnPlan } from '../services/TavernChatReturn'

import type {
  TavernConflictPolicy,
  TavernResourceItem,
  TavernResourceKind,
} from '../services/TavernBridgeProtocol'

import { tavernBridgeService } from '../services/TavernBridgeService'

import { getResourceCategoryIds, RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'

import { LOCAL_DIRECT_BRIDGE_EXTENSION_VERSION } from '../utils/BridgeInstall'

import {
  buildLocalNameIndex,
  buildTavernNameIndex,
  localResourceExistsInTavern,
  tavernItemExistsLocally,
} from '../utils/TavernBridgeDiff'

import { buildTavernSyncPlan, summarizeTavernSyncPlan } from '../utils/TavernSyncPlan'

export function useTavernBridgeCenter(
  props: Readonly<
    TavernBridgeCenterProps &
      Required<Pick<TavernBridgeCenterProps, 'categories' | 'initialLocalIds'>>
  >,
  emit: EmitFn<TavernBridgeCenterEvents>,
) {
  const state = ref<TavernConnectionSnapshot>(tavernConnectionStore.getSnapshot())
  let disposed = false

  const activeDirection = ref<'fromTavern' | 'toTavern'>('fromTavern')

  const tavernItems = ref<TavernResourceItem[]>([])

  const selectedTavernIds = ref(new Set<string>())
  const selectedLocalIds = ref(new Set<string>())

  const tavernReceiveFilter = ref<TavernReceiveFilter>(props.initialKind ?? 'all')

  const tavernSearch = ref('')

  const localSendFilter = ref<LocalSendFilter>(props.initialKind ?? 'all')

  const search = ref('')

  const conflictPolicy = ref<TavernConflictPolicy>(
    props.initialKind === 'userPersona' ? 'skip' : 'copy',
  )
  const personaAvatarMode = ref<PersonaAvatarMode>(
    state.value.status === 'connected' &&
      !state.value.capabilities?.includes('persona-avatar-check-v1')
      ? 'none'
      : 'missing',
  )

  const busy = ref(false)
  const sendContent = ref<TavernSendContent>(browserStorageService.getTavernSendContent())
  const transferSettingsDialog = ref<HTMLDialogElement>()
  const includeChatScripts = ref(browserStorageService.getTavernChatCarryScripts())
  function openTransferSettings(): void {
    if (!busy.value) transferSettingsDialog.value?.showModal()
  }
  function setSendContent(content: TavernSendContent): void {
    sendContent.value = content
    browserStorageService.setTavernSendContent(content)
  }
  function saveChatCarryScripts(): void {
    browserStorageService.setTavernChatCarryScripts(includeChatScripts.value)
  }
  const canCancelTransfer = ref(false)
  const activeAbortController = shallowRef<AbortController | null>(null)
  function beginTransfer(): AbortSignal {
    return beginTransferOperation(getUseTavernTransferActionsContext())
  }
  function endTransfer(): void {
    return endTransferOperation(getUseTavernTransferActionsContext())
  }
  function cancelTransfer(): void {
    return cancelTransferOperation(getUseTavernTransferActionsContext())
  }
  const canBindDirectory = tavernBridgeService.canBindDirectory()
  async function bindDirectory(reuse = true): Promise<void> {
    return bindDirectoryOperation(getUseTavernTransferActionsContext(), reuse)
  }

  const progress = ref('')

  const error = ref('')

  const reports = ref<string[]>(browserStorageService.getBridgeTransferLog())

  const localDirectEnabled = ref(false)

  const bridgeFolderFilter = ref('')

  const bridgeTagFilter = ref('')

  const bridgeFavoritesOnly = ref(false)

  const showOnlyMissingTavern = ref(false)

  const showOnlyMissingLocal = ref(false)

  const showOnlySelectedTavern = ref(false)

  const showOnlySelectedLocal = ref(false)

  const authorToolsDialog = ref<
    'list' | 'reloadGuard' | 'sceneSwitcher' | 'characterLorebooks' | null
  >(null)

  const installGuideOpen = ref(false)

  const copiedAuthorToolId = ref<string | null>(null)

  let authorToolsTrigger: HTMLElement | null = null

  const AUTHOR_TOOLS = [
    {
      id: 'reloadGuard',
      name: '聊天重载保护器',
      eyebrow: 'CHAT RELOAD GUARD',
      summary: '防止切换正则或预设时，聊天重载失败把原聊天覆盖为只剩开场白。',
      details: [
        '仅在单次当前聊天重载期间保留内存快照，并阻止已确认的危险覆盖保存。',
        '不改写正则、预设、角色卡或正常聊天内容；不支持的酒馆版本会停止接管。',
        '当前已审计支持 SillyTavern 1.18.0。',
      ],
      repository: 'https://github.com/jixiangruyi117/SillyTavern-ChatReloadGuard',
    },
    {
      id: 'sceneSwitcher',
      name: '场景切换器',
      eyebrow: 'SCENE SWITCHER',
      summary: '把常用的连接配置、角色、预设和主题保存成组合，之后一项快速切换。',
      details: [
        '只改动组合中明确勾选的项目，未勾选项保持当前状态。',
        '支持常用组合、角色与聊天记录搜索，以及可选的聊天页快速切换悬浮球。',
        '不会保存 API 密钥、代理密码或聊天记录，也不替代酒馆原生连接档案。',
      ],
      repository: 'https://github.com/jixiangruyi117/SillyTavern-SceneSwitcher',
    },
    {
      id: 'characterLorebooks',
      name: '角色世界书',
      eyebrow: 'CHARACTER LOREBOOKS',
      summary: '按角色归属整理世界书，当前角色聊天时不再被其他角色的世界书淹没。',
      details: [
        '只读取酒馆已有的主世界书、附加世界书与公共世界书绑定，不移动或改写世界书文件。',
        '可查看当前角色、公共和全部世界书，并标记共享、聊天、人设与全局启用状态。',
        '可在明确确认后关闭其他角色的全局启用世界书；当前角色书和公共书保持原样。',
      ],
      repository: 'https://github.com/jixiangruyi117/SillyTavern-CharacterLorebooks',
    },
  ] as const

  const selectedAuthorTool = computed(() =>
    authorToolsDialog.value && authorToolsDialog.value !== 'list'
      ? AUTHOR_TOOLS.find((tool) => tool.id === authorToolsDialog.value)
      : undefined,
  )

  const restoredDraft = browserStorageService.getBridgeTransferDraft()
  const transferQueue = ref<TransferQueueItem[]>(
    restoredDraft?.items.map((item) => ({
      ...item,
      ...(item.status === 'active' || item.status === 'pending'
        ? { status: 'failed' as const, detail: '上次传输中断，请连接原酒馆后重试' }
        : {}),
    })) ?? [],
  )

  const failedTransferKeys = computed(() =>
    transferQueue.value
      .filter((item) => item.status === 'failed' || item.status === 'pending')
      .map((item) => item.key),
  )

  let lastTransferDirection: 'pull' | 'send' = restoredDraft?.direction ?? 'pull'
  let transferOrigin = restoredDraft?.origin ?? ''
  if (restoredDraft) conflictPolicy.value = restoredDraft.policy
  let transferDraftTimer = 0
  const persistTransferDraft = () => {
    browserStorageService.setBridgeTransferDraft({
      direction: lastTransferDirection,
      origin: transferOrigin,
      policy: conflictPolicy.value,
      at: Date.now(),
      // Keep resumable entries first. The storage contract retains at most 200 items.
      items: transferQueue.value
        .filter((item) => item.status !== 'done')
        .slice(0, 200)
        .map((item) => ({
          ...item,
          name: item.name.slice(0, 200),
          detail: item.detail.slice(0, 240),
        })),
    })
  }
  watch(
    transferQueue,
    () => {
      window.clearTimeout(transferDraftTimer)
      transferDraftTimer = window.setTimeout(persistTransferDraft, 2_000)
    },
    { deep: true, flush: 'sync' },
  )

  const localNameIndex = computed(() => buildLocalNameIndex(props.resources))

  const tavernNameIndex = computed(() => buildTavernNameIndex(tavernItems.value))

  const itemExistsLocally = (item: TavernResourceItem) =>
    tavernItemExistsLocally(item, localNameIndex.value)

  const resourceExistsInTavern = (resource: ResourceSummary) =>
    localResourceExistsInTavern(resource, tavernNameIndex.value)

  const bridgeSyncPlan = computed(() =>
    buildTavernSyncPlan(supportedLocalResources.value, tavernItems.value),
  )

  const bridgeDiffSummary = computed(() => {
    if (!tavernItems.value.length) return undefined
    const summary = summarizeTavernSyncPlan(bridgeSyncPlan.value)
    return {
      tavernOnly: summary['tavern-only'],
      localOnly: summary['local-only'],
      localNewer: summary['local-newer'],
      tavernNewer: summary['tavern-newer'],
      consistent: summary.consistent,
      unverified: summary['unverified-match'],
    }
  })

  function selectSyncEntries(direction: 'fromTavern' | 'toTavern', statuses: string[]): void {
    const selected = bridgeSyncPlan.value.flatMap((entry) => {
      if (!statuses.includes(entry.status)) return []
      const id = direction === 'fromTavern' ? entry.tavernId : entry.localId
      return id ? [id] : []
    })
    activeDirection.value = direction
    if (direction === 'fromTavern') selectedTavernIds.value = new Set(selected)
    else selectedLocalIds.value = new Set(selected)
  }

  const sendConflictCount = computed(
    () =>
      supportedLocalResources.value.filter(
        (resource) => selectedLocalIds.value.has(resource.id) && resourceExistsInTavern(resource),
      ).length,
  )
  const selectedPersonaCount = computed(
    () =>
      supportedLocalResources.value.filter(
        (resource) =>
          resource.type === RESOURCE_TYPE.USER_PERSONA && selectedLocalIds.value.has(resource.id),
      ).length,
  )
  const canCheckPersonaAvatars = computed(() =>
    state.value.capabilities?.includes('persona-avatar-check-v1'),
  )
  const deviceCode = ref('')

  const canShowDeviceJoin = computed(
    () => !tavernBridgeService.hasInvitation() || state.value.status === 'error',
  )

  const canUseLocalTavernHost = computed(() => canUseLocalTavernDirect())

  const localDirectAvailable = computed(() => {
    void state.value.status
    return tavernBridgeService.isLocalTavernDirectAvailable()
  })

  const supportedLocalResources = computed(() =>
    props.resources.filter(
      (resource) =>
        (resource.type === RESOURCE_TYPE.CHAT && state.value.transport !== 'directory') ||
        resource.type === RESOURCE_TYPE.USER_PERSONA ||
        resource.type === RESOURCE_TYPE.CHARACTER_CARD ||
        resource.type === RESOURCE_TYPE.WORLD_BOOK ||
        resource.type === RESOURCE_TYPE.PRESET ||
        resource.type === RESOURCE_TYPE.REGEX ||
        resource.type === RESOURCE_TYPE.QUICK_REPLY ||
        resource.type === RESOURCE_TYPE.SCRIPT ||
        (resource.type === RESOURCE_TYPE.BEAUTIFICATION &&
          resource.metadata.detectedVariant === 'theme'),
    ),
  )
  const includeChatRegex = ref(false)
  const chatReturnPlans = new Map<string, ChatReturnPlan>()
  const selectedChatCount = computed(
    () =>
      supportedLocalResources.value.filter(
        (item) => item.type === RESOURCE_TYPE.CHAT && selectedLocalIds.value.has(item.id),
      ).length,
  )
  watch(selectedPersonaCount, (count) => {
    if (count && conflictPolicy.value === 'copy') conflictPolicy.value = 'skip'
    if (!count) personaAvatarMode.value = 'missing'
  })
  watch(
    () => state.value.status,
    (status) => {
      if (status === 'connected' && !canCheckPersonaAvatars.value) personaAvatarMode.value = 'none'
    },
  )

  const filteredLocalResources = computed(() => {
    const keyword = search.value.trim().toLocaleLowerCase()
    const typedResources = supportedLocalResources.value.filter(
      (resource) =>
        matchesLocalSendFilter(resource, localSendFilter.value) &&
        (!showOnlyMissingLocal.value || !resourceExistsInTavern(resource)) &&
        (!showOnlySelectedLocal.value || selectedLocalIds.value.has(resource.id)) &&
        (!bridgeFolderFilter.value ||
          getResourceCategoryIds(resource).includes(bridgeFolderFilter.value)) &&
        (!bridgeTagFilter.value || resource.tags.includes(bridgeTagFilter.value)) &&
        (!bridgeFavoritesOnly.value || resource.favorite),
    )
    if (!keyword) return typedResources
    return typedResources.filter(
      (resource) =>
        resource.name.toLocaleLowerCase().includes(keyword) ||
        resource.fileName.toLocaleLowerCase().includes(keyword),
    )
  })

  const localSendFilters = computed<Array<{ key: LocalSendFilter; label: string; count: number }>>(
    () => {
      const filters: Array<{ key: LocalSendFilter; label: string }> = [
        { key: 'all', label: '全部' },
        { key: 'userPersona', label: '用户人设' },
        { key: 'character', label: '角色卡' },
        { key: 'chat', label: '聊天记录' },
        { key: 'worldBook', label: '世界书' },
        { key: 'preset', label: '预设' },
        { key: 'regex', label: '正则' },
        { key: 'quickReply', label: '快速回复' },
        { key: 'script', label: '助手脚本' },
        { key: 'theme', label: '美化主题' },
      ]
      return filters.map((filter) => ({
        ...filter,
        count: supportedLocalResources.value.filter((resource) =>
          matchesLocalSendFilter(resource, filter.key),
        ).length,
      }))
    },
  )

  const visibleTavernItems = computed(() => {
    const keyword = tavernSearch.value.trim().toLocaleLowerCase()
    return tavernItems.value.filter(
      (item) =>
        (tavernReceiveFilter.value === 'all' || item.kind === tavernReceiveFilter.value) &&
        (!showOnlyMissingTavern.value || !itemExistsLocally(item)) &&
        (!showOnlySelectedTavern.value || selectedTavernIds.value.has(item.id)) &&
        (!keyword ||
          item.name.toLocaleLowerCase().includes(keyword) ||
          item.fileName.toLocaleLowerCase().includes(keyword) ||
          (item.kind === 'chat' && item.detail.toLocaleLowerCase().includes(keyword))),
    )
  })
  const tavernPageSize = 10
  const tavernPage = ref(1)
  const tavernPageCount = computed(() =>
    Math.max(1, Math.ceil(visibleTavernItems.value.length / tavernPageSize)),
  )
  const pagedVisibleTavernItems = computed(() => {
    const start = (tavernPage.value - 1) * tavernPageSize
    return visibleTavernItems.value.slice(start, start + tavernPageSize)
  })
  watch([tavernSearch, tavernReceiveFilter, showOnlyMissingTavern, showOnlySelectedTavern], () => {
    tavernPage.value = 1
  })

  const localPageSize = 10
  const localPage = ref(1)
  const localPageCount = computed(() =>
    Math.max(1, Math.ceil(filteredLocalResources.value.length / localPageSize)),
  )
  const pagedFilteredLocalResources = computed(() => {
    const start = (localPage.value - 1) * localPageSize
    return filteredLocalResources.value.slice(start, start + localPageSize)
  })
  watch(
    [
      search,
      localSendFilter,
      showOnlyMissingLocal,
      showOnlySelectedLocal,
      bridgeFolderFilter,
      bridgeTagFilter,
      bridgeFavoritesOnly,
    ],
    () => {
      localPage.value = 1
    },
  )

  const tavernReceiveFilters = computed<
    Array<{ key: TavernReceiveFilter; label: string; count: number }>
  >(() => {
    const filters: Array<{ key: TavernReceiveFilter; label: string }> = [
      { key: 'all', label: '全部' },
      { key: 'userPersona', label: '用户人设' },
      { key: 'character', label: '角色卡' },
      { key: 'chat', label: '聊天记录' },
      { key: 'worldBook', label: '世界书' },
      { key: 'preset', label: '预设' },
      { key: 'regexGlobal', label: '全局正则' },
      { key: 'regexCharacter', label: '角色正则' },
      { key: 'regexPreset', label: '预设正则' },
      { key: 'quickReply', label: '快速回复' },
      { key: 'scriptGlobal', label: '全局脚本' },
      { key: 'scriptCharacter', label: '角色脚本' },
      { key: 'scriptPreset', label: '预设脚本' },
      { key: 'theme', label: '主题' },
    ]
    return filters
      .map((filter) => ({
        ...filter,
        count:
          filter.key === 'all'
            ? tavernItems.value.length
            : tavernItems.value.filter((item) => item.kind === filter.key).length,
      }))
      .filter(
        (filter) =>
          filter.key === 'all' ||
          filter.key === tavernReceiveFilter.value ||
          filter.count > 0 ||
          (filter.key === 'chat' && state.value.capabilities?.includes('chat-archive-v1')),
      )
  })

  const bridgeTagOptions = computed(() => {
    const counts = new Map<string, number>()
    for (const resource of supportedLocalResources.value) {
      for (const tag of resource.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return Array.from(counts.keys()).sort((left, right) => left.localeCompare(right, 'zh-CN'))
  })

  function recordReport(entry: string): void {
    return recordReportOperation(getUseTavernTransferActionsContext(), entry)
  }

  function handleState(event: Event): void {
    return handleStateOperation(getUseTavernTransferActionsContext(), event)
  }

  function setLocalDirectEnabled(): void {
    return setLocalDirectEnabledOperation(getUseTavernTransferActionsContext())
  }

  function acceptPairing(): void {
    return acceptPairingOperation(getUseTavernTransferActionsContext())
  }

  async function joinDeviceRelay(): Promise<void> {
    return joinDeviceRelayOperation(getUseTavernTransferActionsContext())
  }

  async function connectLocalTavern(): Promise<void> {
    return connectLocalTavernOperation(getUseTavernTransferActionsContext())
  }

  function disconnectTavern(): void {
    return disconnectTavernOperation(getUseTavernTransferActionsContext())
  }

  async function refreshTavernResources(kind?: 'chat'): Promise<void> {
    return refreshTavernResourcesOperation(getUseTavernTransferActionsContext(), kind)
  }

  function selectTavernReceiveFilter(filter: TavernReceiveFilter): void {
    tavernReceiveFilter.value = filter
    if (
      filter === 'chat' &&
      state.value.capabilities?.includes('chat-archive-v1') &&
      !state.value.chatInventoryLoaded
    ) {
      void refreshTavernResources('chat')
    }
  }

  function toggleSelection(target: 'tavern' | 'local', id: string): void {
    const source = target === 'tavern' ? selectedTavernIds : selectedLocalIds
    const next = new Set(source.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    source.value = next
  }

  function selectAllTavern(): void {
    const visibleIds = visibleTavernItems.value.map((item) => item.id)
    const allSelected = visibleIds.every((id) => selectedTavernIds.value.has(id))
    const next = new Set(selectedTavernIds.value)
    for (const id of visibleIds) {
      if (allSelected) next.delete(id)
      else next.add(id)
    }
    selectedTavernIds.value = next
  }

  function selectAllLocal(): void {
    const visibleIds = filteredLocalResources.value.map((resource) => resource.id)
    const allSelected = visibleIds.every((id) => selectedLocalIds.value.has(id))
    const next = new Set(selectedLocalIds.value)
    for (const id of visibleIds) {
      if (allSelected) next.delete(id)
      else next.add(id)
    }
    selectedLocalIds.value = next
  }

  function tavernResourceLabel(kind: TavernResourceKind): string {
    const labels: Record<TavernResourceKind, string> = {
      chat: '聊天记录',
      character: '角色卡',
      worldBook: '世界书',
      preset: '预设',
      regexGlobal: '全局正则',
      regexCharacter: '角色正则',
      regexPreset: '预设正则',
      quickReply: '快速回复',
      theme: '主题',
      scriptGlobal: '全局脚本',
      scriptCharacter: '角色脚本',
      scriptPreset: '预设脚本',
      userPersona: '用户人设',
      userAvatar: '用户头像',
    }
    return labels[kind]
  }

  async function runPullQueue(items: TavernResourceItem[], signal?: AbortSignal): Promise<void> {
    return runPullQueueOperation(getUseTavernTransferActionsContext(), items, signal)
  }

  async function pullFromTavern(): Promise<void> {
    return pullFromTavernOperation(getUseTavernTransferActionsContext())
  }

  async function retryFailedTransfers(): Promise<void> {
    return retryFailedTransfersOperation(getUseTavernTransferActionsContext())
  }

  function bridgeKind(resource: ResourceSummary): TavernResourceKind {
    if (resource.type === RESOURCE_TYPE.CHAT) return 'chat'
    if (resource.type === RESOURCE_TYPE.USER_PERSONA) return 'userPersona'
    if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) return 'character'
    if (resource.type === RESOURCE_TYPE.WORLD_BOOK) return 'worldBook'
    if (resource.type === RESOURCE_TYPE.PRESET) return 'preset'
    if (resource.type === RESOURCE_TYPE.REGEX) {
      if (typeof resource.metadata.extractedFromCharacterId === 'string') return 'regexCharacter'
      if (typeof resource.metadata.extractedFromPresetId === 'string') return 'regexPreset'
      if (resource.metadata.regexScope === 'character') return 'regexCharacter'
      if (resource.metadata.regexScope === 'preset') return 'regexPreset'
      return 'regexGlobal'
    }
    if (resource.type === RESOURCE_TYPE.QUICK_REPLY) return 'quickReply'
    if (resource.type === RESOURCE_TYPE.SCRIPT) return 'scriptGlobal'
    return 'theme'
  }

  function matchesLocalSendFilter(resource: ResourceSummary, filter: LocalSendFilter): boolean {
    if (filter === 'chat') return resource.type === RESOURCE_TYPE.CHAT
    if (filter === 'userPersona') return resource.type === RESOURCE_TYPE.USER_PERSONA
    if (filter === 'all') return true
    if (filter === 'character') return resource.type === RESOURCE_TYPE.CHARACTER_CARD
    if (filter === 'worldBook') return resource.type === RESOURCE_TYPE.WORLD_BOOK
    if (filter === 'preset') return resource.type === RESOURCE_TYPE.PRESET
    if (filter === 'regex') return resource.type === RESOURCE_TYPE.REGEX
    if (filter === 'quickReply') return resource.type === RESOURCE_TYPE.QUICK_REPLY
    if (filter === 'script') return resource.type === RESOURCE_TYPE.SCRIPT
    return (
      resource.type === RESOURCE_TYPE.BEAUTIFICATION &&
      resource.metadata.detectedVariant === 'theme'
    )
  }

  async function confirmDirectoryWrite(): Promise<boolean> {
    return confirmDirectoryWriteOperation(getUseTavernTransferActionsContext())
  }

  async function sendToTavern(): Promise<void> {
    return sendToTavernOperation(getUseTavernTransferActionsContext())
  }

  async function preparePersonaSendPlans(
    summaries: ResourceSummary[],
    signal?: AbortSignal,
  ): Promise<Map<string, PersonaSendPlan> | null> {
    return preparePersonaSendPlansOperation(getUseTavernTransferActionsContext(), summaries, signal)
  }

  async function preparePersonaAvatarPlans(
    summaries: ResourceSummary[],
    personaPlans = new Map<string, PersonaSendPlan>(),
    signal?: AbortSignal,
  ): Promise<Map<string, PersonaAvatarPlan> | null> {
    return preparePersonaAvatarPlansOperation(
      getUseTavernTransferActionsContext(),
      summaries,
      personaPlans,
      signal,
    )
  }

  async function runSendQueue(
    summaries: ResourceSummary[],
    avatarPlans = new Map<string, PersonaAvatarPlan>(),
    personaPlans = new Map<string, PersonaSendPlan>(),
    signal?: AbortSignal,
  ): Promise<void> {
    return runSendQueueOperation(
      getUseTavernTransferActionsContext(),
      summaries,
      avatarPlans,
      personaPlans,
      signal,
    )
  }

  function resourceLabel(resource: ResourceSummary): string {
    if (resource.type === RESOURCE_TYPE.CHAT) return '聊天记录'
    if (resource.type === RESOURCE_TYPE.USER_PERSONA) return '用户人设'
    if (resource.type === RESOURCE_TYPE.CHARACTER_CARD) return '角色卡'
    if (resource.type === RESOURCE_TYPE.WORLD_BOOK) return '世界书'
    if (resource.type === RESOURCE_TYPE.PRESET) return '预设'
    if (resource.type === RESOURCE_TYPE.REGEX) return '正则'
    if (resource.type === RESOURCE_TYPE.QUICK_REPLY) return '快速回复'
    if (resource.type === RESOURCE_TYPE.SCRIPT) return '助手脚本'
    return '主题'
  }

  function openAuthorTools(event: MouseEvent): void {
    authorToolsTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
    copiedAuthorToolId.value = null
    authorToolsDialog.value = 'list'
  }

  function closeAuthorTools(): void {
    authorToolsDialog.value = null
    copiedAuthorToolId.value = null
    void nextTick(() => authorToolsTrigger?.focus({ preventScroll: true }))
  }

  function showAuthorToolDetails(toolId: (typeof AUTHOR_TOOLS)[number]['id']): void {
    copiedAuthorToolId.value = null
    authorToolsDialog.value = toolId
  }

  async function copyAuthorToolRepository(tool: (typeof AUTHOR_TOOLS)[number]): Promise<void> {
    try {
      await navigator.clipboard.writeText(tool.repository)
      copiedAuthorToolId.value = tool.id
    } catch {
      copiedAuthorToolId.value = null
      error.value = '无法复制仓库地址，请手动复制链接。'
    }
  }

  onMounted(() => {
    tavernConnectionStore.addEventListener('change', handleState)
    state.value = tavernConnectionStore.getSnapshot()
    tavernItems.value = state.value.inventory
    const supportedIds = new Set(supportedLocalResources.value.map((resource) => resource.id))
    selectedLocalIds.value = new Set(
      props.initialLocalIds.filter((resourceId) => supportedIds.has(resourceId)),
    )
    if (selectedLocalIds.value.size) activeDirection.value = 'toTavern'
    // 离开“功能 → 酒馆互传”只会卸载页面，不会关闭 Service 的中继端口。
    // 此时不会再收到新的 connected 事件，必须主动恢复目录，不能显示为空列表。
    if (state.value.status === 'connected' && !state.value.lastSyncAt) void refreshTavernResources()
  })

  onUnmounted(() => {
    disposed = true
    activeAbortController.value?.abort(new DOMException('页面已关闭，停止当前传输', 'AbortError'))
    endTransfer()
    window.clearTimeout(transferDraftTimer)
    persistTransferDraft()
    tavernConnectionStore.removeEventListener('change', handleState)
  })
  return {
    canBindDirectory,
    bindDirectory,
    state,
    busy,
    canCancelTransfer,
    cancelTransfer,
    acceptPairing,
    canShowDeviceJoin,
    joinDeviceRelay,
    deviceCode,
    canUseLocalTavernHost,
    connectLocalTavern,
    installGuideOpen,
    error,
    progress,
    localDirectEnabled,
    setLocalDirectEnabled,
    localDirectAvailable,
    LOCAL_DIRECT_BRIDGE_EXTENSION_VERSION,
    refreshTavernResources,
    disconnectTavern,
    activeDirection,
    bridgeDiffSummary,
    selectSyncEntries,
    showOnlyMissingTavern,
    showOnlyMissingLocal,
    tavernReceiveFilters,
    tavernReceiveFilter,
    selectTavernReceiveFilter,
    tavernSearch,
    visibleTavernItems,
    pagedVisibleTavernItems,
    tavernPage,
    tavernPageCount,
    selectAllTavern,
    selectedTavernIds,
    showOnlySelectedTavern,
    toggleSelection,
    tavernResourceLabel,
    itemExistsLocally,
    pullFromTavern,
    localSendFilters,
    includeChatRegex,
    selectedChatCount,
    localSendFilter,
    search,
    bridgeFolderFilter,
    bridgeTagFilter,
    bridgeTagOptions,
    bridgeFavoritesOnly,
    selectAllLocal,
    selectedLocalIds,
    filteredLocalResources,
    pagedFilteredLocalResources,
    localPage,
    localPageCount,
    tavernItems,
    showOnlySelectedLocal,
    resourceLabel,
    resourceExistsInTavern,
    conflictPolicy,
    personaAvatarMode,
    sendContent,
    setSendContent,
    includeChatScripts,
    saveChatCarryScripts,
    transferSettingsDialog,
    openTransferSettings,
    selectedPersonaCount,
    canCheckPersonaAvatars,
    sendConflictCount,
    sendToTavern,
    reports,
    transferQueue,
    failedTransferKeys,
    retryFailedTransfers,
    openAuthorTools,
    authorToolsDialog,
    closeAuthorTools,
    AUTHOR_TOOLS,
    showAuthorToolDetails,
    selectedAuthorTool,
    copyAuthorToolRepository,
    copiedAuthorToolId,
  }

  function getUseTavernTransferActionsContext(): UseTavernTransferActionsContext {
    return {
      activeAbortController,
      canCancelTransfer,
      progress,
      busy,
      error,
      reports,
      state,
      tavernItems,
      refreshTavernResources,
      localDirectEnabled,
      deviceCode,
      selectedTavernIds,
      includeChatScripts,
      tavernReceiveFilter,
      tavernReceiveFilters,
      get lastTransferDirection(): UseTavernTransferActionsContext['lastTransferDirection'] {
        return lastTransferDirection
      },
      set lastTransferDirection(value) {
        lastTransferDirection = value
      },
      get disposed(): UseTavernTransferActionsContext['disposed'] {
        return disposed
      },
      set disposed(value) {
        disposed = value
      },
      emit,
      transferQueue,
      recordReport,
      get transferOrigin(): UseTavernTransferActionsContext['transferOrigin'] {
        return transferOrigin
      },
      set transferOrigin(value) {
        transferOrigin = value
      },
      beginTransfer,
      runPullQueue,
      endTransfer,
      failedTransferKeys,
      supportedLocalResources,
      confirmDirectoryWrite,
      preparePersonaSendPlans,
      preparePersonaAvatarPlans,
      runSendQueue,
      selectedLocalIds,
      chatReturnPlans,
      includeChatRegex,
      conflictPolicy,
      props,
      personaAvatarMode,
      sendContent,
      canCheckPersonaAvatars,
      bridgeKind,
    }
  }
}
