import { startAssistantGuidance } from '../core/ProductAssistantGuidance'
import type { EmitFn } from 'vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { type ActionSheetAction } from '../components/ActionSheet.vue'
import {
  SRL_BACK_REQUEST_EVENT,
  useBackStack,
  type SrlBackRequestDetail,
} from '../composables/UseBackStack'

import { characterDrawService, externalAppService } from '../core/AppContainer'
import { readAppResumeState, writeAppResumeState } from '../core/AppResumeState'
import { createAsyncPanel } from '../core/AsyncPanel'
import {
  FEATURE_APP_REGISTRY,
  getFeatureAppBadge,
  getFeatureAppDescriptor,
  getAssistantNavigationTargets,
  type BuiltInFeatureAppId,
  type BuiltInFeatureAppPage,
  type FeatureAppDescriptor,
  type FeatureAppDescriptorContext,
} from '../core/FeatureAppRegistry'
import { getFeatureAppLoader } from '../core/FeatureAppLoaders'
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-runtime-imports
import { officialAppService } from '../core/OfficialAppRuntime'
import { isOfficialAppId } from '../types/OfficialApp'
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-runtime-imports
import { featureAppUsageStore } from '../core/FeatureAppUsageStore'
import type {
  LayoutMode,
  MobileCardOrientation,
  MobileCardFitMode,
  ResourceCardHeightMode,
  NoImageResourceCoverMode,
  UiFontScale,
} from '../services/BrowserStorageService'
import {
  createEmptyCharacterDrawState,
  type CharacterDrawState,
} from '../services/CharacterDrawService'
import type { InstalledExternalAppSummary } from '../types/ExternalApp'
import { RESOURCE_TYPE, type Category, type ResourceSummary } from '../types/Resource'
import type { AssistantNavigationTarget } from '../services/ProductAssistantService'
import { getHiddenCategoryIds, isResourceHiddenByCategory } from '../utils/CategoryVisibility'

// SRL-PUBLIC-SYNC: BEGIN REPLACE id=official-app-feature-page
export type FeaturePage = 'home' | BuiltInFeatureAppPage | 'externalApp' | 'officialApps'
// SRL-PUBLIC-SYNC: END REPLACE id=official-app-feature-page

// Only pages with a fixed viewport and an explicit internal scroll owner may
// lock the host document. Ordinary feature pages (for example Appearance)
// intentionally continue to use document scrolling on mobile Safari.
const FEATURE_PAGES_WITH_INTERNAL_SCROLL: ReadonlySet<FeaturePage> = new Set(['imageGeneration'])

export type FeatureDesktopEntry =
  | { kind: 'builtIn'; app: FeatureAppDescriptor }
  | { kind: 'external'; app: InstalledExternalAppSummary }

export type FeatureHubProps = {
  active?: boolean
  resources: ResourceSummary[]
  categories: Category[]
  theme: 'light' | 'dark'
  layoutMode: LayoutMode
  mobileCardOrientation?: MobileCardOrientation
  mobileCardFitMode?: MobileCardFitMode
  resourceCardHeightMode?: ResourceCardHeightMode
  noImageResourceCoverMode?: NoImageResourceCoverMode
  uiFontScale: UiFontScale
  customCss: string
  folderBusy: boolean
  cabinetResourceIds: string[]
  sharedAppFiles?: File[]
  navigateLibrary?: (id: string) => Promise<void>
  assistantDestination?: string
}

export type FeatureHubEvents = {
  close: []
  openResource: [resource: ResourceSummary]
  openPersonaHistory: [resource: ResourceSummary]
  manageFolders: []
  folderAdd: [details: { categoryId: string; resourceIds: string[]; removeFromCabinet?: boolean }]
  folderCover: [details: { category: Category; file?: File; coverUrl?: string }]
  folderRename: [
    details: {
      category: Category
      name: string
      coverChanged?: boolean
      coverImage?: string
      file?: File
    },
  ]
  folderReorder: [categoryIds: string[]]
  cabinetPin: [resourceIds: string[]]
  cabinetUnpin: [resourceId: string]
  'update:theme': [value: 'light' | 'dark']
  'update:layoutMode': [value: LayoutMode]
  'update:mobileCardOrientation': [value: MobileCardOrientation]
  'update:mobileCardFitMode': [value: MobileCardFitMode]
  'update:resourceCardHeightMode': [value: ResourceCardHeightMode]
  'update:noImageResourceCoverMode': [value: NoImageResourceCoverMode]
  'update:uiFontScale': [value: UiFontScale]
  'save-css': [value: string, options?: import('../types/UiCustomization').UiApplyOptions]
  'save-assistant-css': [value: string]
  'library-changed': []
  'import-files': [files: File[], onComplete?: () => void]
  'feature-app-active': [active: boolean]
  'shared-app-files-consumed': []
  'assistant-visibility': [value: boolean]
  'assistant-activity': [value: boolean]
  'assistant-retained': []
  'assistant-destination-consumed': []
}

export function useFeatureHub(props: Readonly<FeatureHubProps>, emit: EmitFn<FeatureHubEvents>) {
  function createRegisteredAsyncPanel(id: BuiltInFeatureAppId) {
    const descriptor = getFeatureAppDescriptor(id)
    return createAsyncPanel(descriptor.name, getFeatureAppLoader(id))
  }

  // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-manager-panel
  const OfficialAppManager = createAsyncPanel(
    'APP 管理',
    () => import('../components/OfficialAppManager.vue'),
  )
  // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-manager-panel

  const DrawApp = createRegisteredAsyncPanel('draw')

  const AppearanceStudio = createRegisteredAsyncPanel('appearance')

  const CloudBackupCenter = createRegisteredAsyncPanel('cloud')
  const DiscordInboxCenter = createRegisteredAsyncPanel('inbox')

  const TavernBridgeCenter = createRegisteredAsyncPanel('tavernBridge')

  const PresetStitcherApp = createRegisteredAsyncPanel('stitch')

  const FrontendWorkshopApp = createRegisteredAsyncPanel('frontendWorkshop')

  const ImageGenerationApp = createRegisteredAsyncPanel('imageGeneration')

  const GeneratedImageAlbumApp = createRegisteredAsyncPanel('imageAlbum')

  const UserPersonaApp = createRegisteredAsyncPanel('userPersona')

  const ChatReaderApp = createRegisteredAsyncPanel('chatReader')

  const ExternalAppManager = createRegisteredAsyncPanel('extensions')

  const ExternalAppHost = createAsyncPanel(
    '第三方 APP',
    () => import('../components/ExternalAppHost.vue'),
  )

  const FEATURE_DESKTOP_PAGE_SIZE = 12

  const FEATURE_DESKTOP_LONG_PRESS_MS = 550

  const FEATURE_DESKTOP_LONG_PRESS_MOVE_TOLERANCE = 10

  const activePage = ref<FeaturePage>('home')

  watch(
    () => props.sharedAppFiles?.length ?? 0,
    (count) => {
      if (count) activePage.value = 'extensions'
    },
    { immediate: true },
  )

  const desktopFilter = ref<'all' | 'pinned' | 'recent'>('all')

  const desktopFilterOpen = ref(false)

  function handleNativeShortcut(event?: Event): void {
    const detail = event instanceof CustomEvent ? String(event.detail ?? '') : ''
    const action = detail || sessionStorage.getItem('srl.native.shortcut') || ''
    if (action !== 'cloud' && action !== 'inbox' && action !== 'assistant') return
    activePage.value = action
    sessionStorage.removeItem('srl.native.shortcut')
  }

  const drawState = ref<CharacterDrawState>(createEmptyCharacterDrawState())

  const externalApps = ref<InstalledExternalAppSummary[]>([])
  // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-install-state
  const installedOfficialIds = ref(
    new Set<string>(officialAppService.installedSnapshot.map((app) => app.id)),
  )
  const unsubscribeInstalled = officialAppService.subscribeInstalled((apps) => {
    installedOfficialIds.value = new Set(apps.map((app) => app.id))
  })
  async function reloadOfficialApps() {
    installedOfficialIds.value = new Set(
      (await officialAppService.loadInstalled()).map((app) => app.id),
    )
  }
  // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-install-state

  const activeExternalAppId = ref('')

  const desktopPage = ref(0)

  const featureUsage = ref(featureAppUsageStore.read())

  const hiddenCategoryIds = computed(() => getHiddenCategoryIds(props.categories))

  const drawResources = computed(() =>
    props.resources.filter(
      (resource) => !isResourceHiddenByCategory(resource, hiddenCategoryIds.value),
    ),
  )

  const presetCount = computed(
    () => drawResources.value.filter((resource) => resource.type === RESOURCE_TYPE.PRESET).length,
  )

  const enabledExternalApps = computed(() => externalApps.value.filter((app) => app.enabled))

  const visibleBuiltInFeatureApps = computed(() =>
    FEATURE_APP_REGISTRY.filter((app) => {
      if (!app.visible) return false
      // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-filter
      if (isOfficialAppId(app.id) && !installedOfficialIds.value.has(app.id)) return false
      // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-filter
      return true
    })
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder),
  )

  const featureDesktopEntries = computed<FeatureDesktopEntry[]>(() => [
    ...visibleBuiltInFeatureApps.value.map((app) => ({ kind: 'builtIn' as const, app })),
    ...enabledExternalApps.value.map((app) => ({ kind: 'external' as const, app })),
  ])

  const filteredFeatureDesktopEntries = computed(() => {
    if (desktopFilter.value === 'all') return featureDesktopEntries.value
    const ids =
      desktopFilter.value === 'pinned' ? featureUsage.value.pinned : featureUsage.value.recent
    const byId = new Map(
      featureDesktopEntries.value.map((entry) => [featureDesktopEntryKey(entry), entry]),
    )
    return ids.flatMap((id) => {
      const entry = byId.get(id)
      return entry ? [entry] : []
    })
  })

  const featureDesktopPageCount = computed(() =>
    Math.max(1, Math.ceil(filteredFeatureDesktopEntries.value.length / FEATURE_DESKTOP_PAGE_SIZE)),
  )

  const currentFeatureDesktopEntries = computed(() => {
    const start = desktopPage.value * FEATURE_DESKTOP_PAGE_SIZE
    return filteredFeatureDesktopEntries.value.slice(start, start + FEATURE_DESKTOP_PAGE_SIZE)
  })

  const desktopFilterActions = computed<readonly ActionSheetAction[]>(() => [
    { id: 'all', label: '全部功能', description: `${featureDesktopEntries.value.length} 项` },
    { id: 'pinned', label: '仅收藏', description: `${featureUsage.value.pinned.length} 项` },
    { id: 'recent', label: '最近使用', description: `${featureUsage.value.recent.length} 项` },
  ])

  const desktopFilterButtonLabel = computed(() => {
    if (desktopFilter.value === 'pinned') return '筛选 · 收藏'
    if (desktopFilter.value === 'recent') return '筛选 · 最近'
    return '筛选'
  })

  function getFeatureAppDescriptorContext(): FeatureAppDescriptorContext {
    return {
      drawCount: drawState.value.totalDraws,
      folderCount: props.categories.length,
      presetCount: presetCount.value,
      userPersonaCount: props.resources.filter(
        (resource) => resource.type === RESOURCE_TYPE.USER_PERSONA,
      ).length,
      enabledExternalAppCount: enabledExternalApps.value.length,
    }
  }

  function getBuiltInFeatureAppBadge(descriptor: FeatureAppDescriptor): string {
    return getFeatureAppBadge(descriptor, getFeatureAppDescriptorContext())
  }

  function openBuiltInFeatureApp(id: BuiltInFeatureAppId): void {
    const descriptor = getFeatureAppDescriptor(id)
    activePage.value = descriptor.page
  }

  function openExternalApp(appId: string): void {
    activeExternalAppId.value = appId
    activePage.value = 'externalApp'
  }

  function openFeatureDesktopEntry(entry: FeatureDesktopEntry): void {
    featureUsage.value = featureAppUsageStore.markOpened(featureDesktopEntryKey(entry))
    if (entry.kind === 'builtIn') openBuiltInFeatureApp(entry.app.id)
    else openExternalApp(entry.app.id)
  }

  const assistantNavigationTargets = computed<AssistantNavigationTarget[]>(() =>
    getAssistantNavigationTargets(Boolean(props.navigateLibrary)),
  )
  async function navigateAssistant(id: string, guide?: string): Promise<void> {
    if (!assistantNavigationTargets.value.some((target) => target.id === id))
      throw new Error('这个界面不能由助手打开')
    const app = FEATURE_APP_REGISTRY.find((item) => item.id === id && item.visible)
    if (app) openFeatureDesktopEntry({ kind: 'builtIn', app })
    else if (id === 'home') activePage.value = id
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=official-app-feature-navigation
    else if (id === 'officialApps') activePage.value = id
    // SRL-PUBLIC-SYNC: END REPLACE id=official-app-feature-navigation
    else if (props.navigateLibrary) await props.navigateLibrary(id)
    else throw new Error('这个界面的入口暂不可用')
    if (guide) startAssistantGuidance(guide, id)
  }

  function toggleFeatureDesktopPin(entry: FeatureDesktopEntry): void {
    featureUsage.value = featureAppUsageStore.togglePinned(featureDesktopEntryKey(entry))
  }

  function selectDesktopFilter(action: ActionSheetAction): void {
    if (action.id !== 'all' && action.id !== 'pinned' && action.id !== 'recent') return
    desktopFilter.value = action.id
    desktopPage.value = 0
  }

  function isFeatureDesktopEntryPinned(entry: FeatureDesktopEntry): boolean {
    return featureUsage.value.pinned.includes(featureDesktopEntryKey(entry))
  }

  function featureDesktopEntryKey(entry: FeatureDesktopEntry): string {
    return `${entry.kind}:${entry.app.id}`
  }

  function featureDesktopEntryClass(entry: FeatureDesktopEntry): string {
    return entry.kind === 'builtIn' ? `feature-app--${entry.app.icon}` : 'feature-app--external'
  }

  function featureDesktopEntryIconClass(entry: FeatureDesktopEntry): string | undefined {
    if (entry.kind === 'external')
      return entry.app.iconDataUrl
        ? 'feature-app__icon--external-image'
        : 'feature-app__icon--external'
    return entry.app.icon === 'draw' ? undefined : `feature-app__icon--${entry.app.icon}`
  }

  function featureDesktopEntryName(entry: FeatureDesktopEntry): string {
    return entry.kind === 'external' ? entry.app.manifest.name : entry.app.name
  }

  function featureDesktopEntryDescription(entry: FeatureDesktopEntry): string {
    return entry.kind === 'external'
      ? entry.app.manifest.description || '第三方 APP'
      : entry.app.description
  }

  function featureDesktopEntryBadge(entry: FeatureDesktopEntry): string {
    return entry.kind === 'external'
      ? `第三方 APP · v${entry.app.manifest.version}`
      : getBuiltInFeatureAppBadge(entry.app)
  }

  function setFeatureDesktopPage(nextPage: number): void {
    desktopPage.value = Math.min(Math.max(nextPage, 0), featureDesktopPageCount.value - 1)
  }

  let desktopPointerStart: { x: number; y: number } | undefined

  let featureDesktopLongPress:
    | {
        entryKey: string
        pointerId: number
        startX: number
        startY: number
        timer: number
      }
    | undefined

  let suppressedFeatureDesktopClickKey: string | undefined

  let resumeTrackingReady = false
  async function consumeAssistantDestination(id: string) {
    if (id === 'assistant')
      openFeatureDesktopEntry({ kind: 'builtIn', app: getFeatureAppDescriptor('assistant') })
    else await navigateAssistant(id)
    emit('assistant-destination-consumed')
  }
  watch(
    () => props.assistantDestination,
    async (id) => {
      if (!resumeTrackingReady || !id) return
      await consumeAssistantDestination(id)
    },
  )

  function clearFeatureDesktopLongPress(): void {
    if (!featureDesktopLongPress) return
    window.clearTimeout(featureDesktopLongPress.timer)
    featureDesktopLongPress = undefined
  }

  function handleFeatureDesktopEntryPointerDown(
    entry: FeatureDesktopEntry,
    event: PointerEvent,
  ): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    clearFeatureDesktopLongPress()
    const entryKey = featureDesktopEntryKey(entry)
    const press = {
      entryKey,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
    }
    press.timer = window.setTimeout(() => {
      if (featureDesktopLongPress !== press) return
      toggleFeatureDesktopPin(entry)
      suppressedFeatureDesktopClickKey = entryKey
      featureDesktopLongPress = undefined
    }, FEATURE_DESKTOP_LONG_PRESS_MS)
    featureDesktopLongPress = press
  }

  function handleFeatureDesktopEntryPointerMove(event: PointerEvent): void {
    const press = featureDesktopLongPress
    if (!press || press.pointerId !== event.pointerId) return
    if (
      Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >
      FEATURE_DESKTOP_LONG_PRESS_MOVE_TOLERANCE
    ) {
      clearFeatureDesktopLongPress()
    }
  }

  function handleFeatureDesktopEntryPointerEnd(event: PointerEvent): void {
    if (featureDesktopLongPress?.pointerId !== event.pointerId) return
    clearFeatureDesktopLongPress()
  }

  function handleFeatureDesktopEntryClick(entry: FeatureDesktopEntry): void {
    const entryKey = featureDesktopEntryKey(entry)
    if (suppressedFeatureDesktopClickKey === entryKey) {
      suppressedFeatureDesktopClickKey = undefined
      return
    }
    openFeatureDesktopEntry(entry)
  }

  function handleDesktopPointerDown(event: PointerEvent): void {
    desktopPointerStart = { x: event.clientX, y: event.clientY }
  }

  function handleDesktopPointerUp(event: PointerEvent): void {
    if (!desktopPointerStart) return
    const deltaX = event.clientX - desktopPointerStart.x
    const deltaY = event.clientY - desktopPointerStart.y
    desktopPointerStart = undefined
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY)) return
    setFeatureDesktopPage(desktopPage.value + (deltaX < 0 ? 1 : -1))
  }

  async function reloadExternalApps(): Promise<void> {
    try {
      externalApps.value = await externalAppService.list()
    } catch {
      externalApps.value = []
    }
  }

  function handleExternalAppsChanged(): void {
    void reloadExternalApps()
  }

  async function handleExternalAppInstalled(appId: string): Promise<void> {
    await reloadExternalApps()
    const index = featureDesktopEntries.value.findIndex(
      (entry) => entry.kind === 'external' && entry.app.id === appId,
    )
    if (index >= 0) setFeatureDesktopPage(Math.floor(index / FEATURE_DESKTOP_PAGE_SIZE))
  }

  const backStack = useBackStack([
    {
      id: 'feature-page',
      isActive: () => activePage.value !== 'home',
      back: () => (activePage.value = 'home'),
    },
    { id: 'feature-hub', isActive: () => true, back: () => emit('close') },
  ])

  function handleKeydown(event: KeyboardEvent): void {
    if (
      props.active === false ||
      event.key !== 'Escape' ||
      document.body.classList.contains('modal-open')
    )
      return
    backStack.back()
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function handleBackRequest(event: Event): void {
    if (
      props.active === false ||
      !(event instanceof CustomEvent) ||
      document.body.classList.contains('modal-open')
    )
      return
    const detail = event.detail as SrlBackRequestDetail | undefined
    if (!detail || detail.handled) return
    const result = backStack.back()
    if (result === 'none') return
    detail.handled = true
    detail.blocked = result === 'blocked'
    event.stopImmediatePropagation()
  }

  watch(
    [activePage, () => props.active],
    ([page, active]) => {
      emit('feature-app-active', active !== false && page !== 'home')
      // Only fixed-viewport apps with an explicit internal scroll owner may
      // lock the host document. Pages such as Appearance use document scroll;
      // locking html/body for every feature page makes them impossible to pan.
      const locksHostScroll = active !== false && FEATURE_PAGES_WITH_INTERNAL_SCROLL.has(page)
      document.body.classList.toggle('feature-app-scroll-lock', locksHostScroll)
      document.documentElement.classList.toggle('feature-app-scroll-lock', locksHostScroll)
      document.body.classList.toggle('folder-desktop-open', active !== false && page === 'folders')
      if (resumeTrackingReady && active !== false)
        writeAppResumeState({
          feature: page === 'frontendWorkshop' ? 'frontendWorkshop' : 'featureHub',
          subpage: page,
        })
    },
    { immediate: true },
  )

  watch(featureDesktopPageCount, () => {
    setFeatureDesktopPage(desktopPage.value)
  })

  onMounted(async () => {
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-manager-initial-load
    await reloadOfficialApps().catch(() => {})
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-manager-initial-load
    window.addEventListener('keydown', handleKeydown)
    window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest)
    window.addEventListener('srl:native-shortcut', handleNativeShortcut)
    handleNativeShortcut()
    const resume = readAppResumeState()
    if (resume?.feature === 'frontendWorkshop') {
      activePage.value = 'frontendWorkshop'
    } else if (
      resume?.feature === 'featureHub' &&
      resume.subpage &&
      resume.subpage !== 'home' &&
      FEATURE_APP_REGISTRY.some((descriptor) => descriptor.page === resume.subpage)
    ) {
      activePage.value = resume.subpage as BuiltInFeatureAppPage
    }
    resumeTrackingReady = true
    if (props.assistantDestination) {
      await consumeAssistantDestination(props.assistantDestination)
    }
    if (new URLSearchParams(window.location.search).has('srlBridge'))
      activePage.value = 'tavernBridge'
    try {
      drawState.value = await characterDrawService.load()
    } catch {
      // The draw app reports its own loading errors when opened.
    }
    await reloadExternalApps()
  })

  onUnmounted(() => {
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-install-unsubscribe
    unsubscribeInstalled()
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-install-unsubscribe
    clearFeatureDesktopLongPress()
    document.body.classList.remove('feature-app-scroll-lock')
    document.documentElement.classList.remove('feature-app-scroll-lock')
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest)
    window.removeEventListener('srl:native-shortcut', handleNativeShortcut)
    document.body.classList.remove('folder-desktop-open')
  })
  return {
    activePage,
    desktopFilterOpen,
    desktopFilterButtonLabel,
    currentFeatureDesktopEntries,
    handleDesktopPointerDown,
    handleDesktopPointerUp,
    get desktopPointerStart() {
      return desktopPointerStart
    },
    set desktopPointerStart(value: typeof desktopPointerStart) {
      desktopPointerStart = value
    },
    featureDesktopEntryKey,
    featureDesktopEntryClass,
    isFeatureDesktopEntryPinned,
    featureDesktopEntryName,
    handleFeatureDesktopEntryClick,
    openFeatureDesktopEntry,
    assistantNavigationTargets,
    navigateAssistant,
    handleFeatureDesktopEntryPointerDown,
    handleFeatureDesktopEntryPointerMove,
    handleFeatureDesktopEntryPointerEnd,
    featureDesktopEntryIconClass,
    featureDesktopEntryDescription,
    featureDesktopEntryBadge,
    featureDesktopPageCount,
    desktopPage,
    setFeatureDesktopPage,
    desktopFilterActions,
    selectDesktopFilter,
    DrawApp,
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-panel-export
    OfficialAppManager,
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-panel-export
    AppearanceStudio,
    TavernBridgeCenter,
    PresetStitcherApp,
    FrontendWorkshopApp,
    ImageGenerationApp,
    GeneratedImageAlbumApp,
    UserPersonaApp,
    ChatReaderApp,
    ExternalAppManager,
    handleExternalAppsChanged,
    handleExternalAppInstalled,
    activeExternalAppId,
    openExternalApp,
    ExternalAppHost,
    CloudBackupCenter,
    DiscordInboxCenter,
  }
}
