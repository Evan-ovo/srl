import type { EmitFn } from 'vue'
import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
  type ComponentPublicInstance,
} from 'vue'
import { usePresetSourceDrag } from '../composables/UsePresetSourceDrag'
import { browserStorageService } from '../core/AppContainer'
import type { PresetStitchDraft, PresetStitchTemplate } from '../services/BrowserStorageService'
import type {
  EditScope,
  PresetStitcherAppEvents,
  PresetStitcherAppProps,
  SourceMode,
  Step,
  WorkbenchSnapshot,
} from '../types/PresetStitcherAppView'
import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'
import { getHiddenCategoryIds, isResourceHiddenByCategory } from '../utils/CategoryVisibility'
import { PresetPromptAnalysisCache } from '../utils/PresetPromptAnalysisCache'
import {
  getPromptDisplayTokens,
  listPresetRegexScripts,
  listPresetSegments,
  readPresetPromptSlots,
  type AssemblyEntry,
  type PresetFavoriteSnapshot,
  type RegexGroupPick,
} from '../utils/PresetStitcher'
import { usePresetAssemblyAnalysis } from './UsePresetAssemblyAnalysis'
import { usePresetCandidates } from './UsePresetCandidates'
import { usePresetDelivery } from './UsePresetDelivery'
import { usePresetDraftHistory } from './UsePresetDraftHistory'
import { usePresetEntryEditing } from './UsePresetEntryEditing'
import { usePresetEntryInsertion } from './UsePresetEntryInsertion'
import { usePresetSelection } from './UsePresetSelection'
export type {
  EditScope,
  PresetStitcherAppEvents,
  PresetStitcherAppProps,
  SourceMode,
  Step,
  WorkbenchSnapshot,
} from '../types/PresetStitcherAppView'

export function usePresetStitcherApp(
  props: Readonly<PresetStitcherAppProps>,
  emit: EmitFn<PresetStitcherAppEvents>,
) {
  const {
    sourceKey,
    findSourceEntry,
    buildCurrentSourceEntry,
    insertFavorite,
    insertManualEntry,
    selectInsertionIndex,
    toggleRegexGroup,
    toggleExpanded,
    removePickByKey,
    moveEntry,
    commitSourceDrop,
    toggleSegmentFromAction,
    insertFavoriteFromAction,
  } = usePresetEntryInsertion(() => ({
    sourceSummary,
    assembly,
    sourceJson,
    sourceOverrides,
    insertionIndex,
    notice,
    targetPage,
    PAGE_SIZE,
    regexPicks,
    sourceRegexScripts,
    expandedSourceKeys,
    expandedTargetKeys,
    favorites,
    consumeSuppressedSourceAction,
  }))

  const { openReview, generate } = usePresetDelivery(() => ({
    productName,
    errorMessage,
    reviewItems,
    blockingPromptIssues,
    editor,
    step,
    busy,
    baseSummary,
    baseJson,
    assembly,
    regexPicks,
    baseIsStitched,
    saveAsVersion,
    versionNote,
    recentIds,
    successName,
    emit,
  }))
  const promptSlotCount = computed(
    () =>
      new Set(
        assembly.value.flatMap((entry) =>
          readPresetPromptSlots(entry.content).map((slot) => slot.id),
        ),
      ).size,
  )

  const { loadPresetJson, chooseBase, chooseSource, chooseFavoriteSource } = usePresetSelection(
    () => ({
      presetJsonCache,
      busy,
      errorMessage,
      baseSummary,
      baseJson,
      assembly,
      insertionIndex,
      regexPicks,
      sourceOverrides,
      productName,
      saveAsVersion,
      sourceSummary,
      sourcePickerOpen,
      presetSearch,
      presetPage,
      step,
      resetWorkbenchHistory,
      sourceMode,
      segmentSearch,
      roleFilter,
      roleFiltersOpen,
      sourcePage,
      favoritePage,
    }),
  )

  const {
    isCandidate,
    toggleCandidateFromSource,
    toggleCandidateFromFavorite,
    removeCandidate,
    insertCandidate,
    insertAllCandidates,
    saveCandidateTemplate,
    applyCandidateTemplate,
    removeCandidateTemplate,
  } = usePresetCandidates(() => ({
    candidates,
    buildCurrentSourceEntry,
    notice,
    compareCandidateId,
    assembly,
    insertFavorite,
    insertionIndex,
    candidateSheetOpen,
    templateName,
    stitchTemplates,
  }))

  const {
    beginSourceEdit,
    beginNewEntry,
    beginTargetEdit,
    beginFavoriteEdit,
    rememberEditorSelection,
    insertVariable,
    openVariableWriter,
    openSlotWriter,
    openSlotWriterForVariable,
    insertPromptSlot,
    insertVariableWrite,
    insertUnreadWrittenVariable,
    copyEntryContent,
    saveEdit,
    cancelEdit,
    isFavorite,
    toggleFavorite,
    removeFavorite,
  } = usePresetEntryEditing(() => ({
    editor,
    sourceKey,
    editorSelection,
    editorTextarea,
    variableName,
    variableValue,
    variableValueSelection,
    variableWriterOpen,
    slotName,
    slotId,
    slotWriterError,
    slotWriterOpen,
    unreadWrittenVariables,
    notice,
    errorMessage,
    assembly,
    sourceOverrides,
    favorites,
    sourceSummary,
    buildCurrentSourceEntry,
    insertNewEntry: insertManualEntry,
  }))

  const {
    resetWorkbenchHistory,
    recordWorkbenchHistory,
    undoWorkbench,
    redoWorkbench,
    saveDraftNow,
    saveCheckpoint,
    restoreCheckpoint,
    queueDraftSave,
    restoreDraft,
    discardDraft,
  } = usePresetDraftHistory(() => ({
    assembly,
    regexPicks,
    candidates,
    sourceOverrides,
    workbenchHistory,
    workbenchHistoryIndex,
    baseSummary,
    step,
    insertionIndex,
    canUndo,
    canRedo,
    productName,
    mainSide,
    saveAsVersion,
    versionNote,
    hasDraftChanges,
    checkpoint,
    notice,
    get draftTimer() {
      return draftTimer
    },
    set draftTimer(value: typeof draftTimer) {
      draftTimer = value
    },
    pendingDraft,
    busy,
    props,
    loadPresetJson,
    baseJson,
    favorites,
    errorMessage,
  }))

  const PAGE_SIZE = 10

  const PRESET_PAGE_SIZE = 8

  const ROLE_OPTIONS = [
    { value: 'system', label: '系统' },
    { value: 'user', label: '用户' },
    { value: 'assistant', label: '助手' },
  ] as const

  const ROLE_FILTERS = [
    { value: '', label: '全部' },
    ...ROLE_OPTIONS,
    { value: 'regex', label: '正则组' },
  ]

  const QUICK_VARIABLES = [
    { label: '用户名', value: '{{user}}', placeholder: undefined },
    { label: '角色名', value: '{{char}}', placeholder: undefined },
    { label: '读取聊天变量', value: '{{getvar::变量名}}', placeholder: '变量名' },
  ] as const

  const step = ref<Step>('base')

  const baseSummary = ref<ResourceSummary>()

  const baseJson = ref<Record<string, unknown>>()

  const sourceSummary = ref<ResourceSummary>()

  const assembly = ref<AssemblyEntry[]>([])

  const regexPicks = ref<RegexGroupPick[]>([])

  const favorites = ref<PresetFavoriteSnapshot[]>([])

  const candidates = ref<PresetFavoriteSnapshot[]>([])

  const stitchTemplates = ref<PresetStitchTemplate[]>([])

  const sourceOverrides = ref<Map<string, { name: string; role: string; content: string }>>(
    new Map(),
  )

  const insertionIndex = ref(0)

  const expandedSourceKeys = ref<Set<string>>(new Set())

  const expandedTargetKeys = ref<Set<string>>(new Set())

  const editor = ref<{
    scope: EditScope
    key: string
    name: string
    role: string
    content: string
  }>()

  const editorTextarea = shallowRef<HTMLTextAreaElement | null>(null)
  function setEditorTextarea(element: Element | ComponentPublicInstance | null): void {
    editorTextarea.value = element instanceof HTMLTextAreaElement ? element : null
  }

  const editorSelection = ref({ start: 0, end: 0 })

  const editorViewportHeight = ref(0)

  const editorKeyboardOffset = ref(0)

  const mobileEditorOverlay = ref(false)

  const variableWriterOpen = ref(false)

  const variableValueSelection = ref({ start: 0, end: 0 })

  const slotWriterOpen = ref(false)

  const slotName = ref('')

  const slotId = ref('')

  const slotWriterError = ref('')

  const variableName = ref('')

  const variableValue = ref('')

  const mainSide = ref<'left' | 'right'>('right')

  const sourceMode = ref<SourceMode>('preset')

  const sourcePickerOpen = ref(false)

  const candidateSheetOpen = ref(false)

  const compareCandidateId = ref('')

  const templateName = ref('')

  const presetSearch = ref('')

  const segmentSearch = ref('')

  const roleFilter = ref('')

  const roleFiltersOpen = ref(false)

  const showEnabledOnly = ref(false)

  const showModifiedOnly = ref(false)

  const showVariableReadsOnly = ref(false)

  const showVariableWritesOnly = ref(false)

  const targetFiltersOpen = ref(false)

  const singleColumn = ref(false)
  const sourceDrawerOpen = ref(false)
  function toggleSingleColumn(): void {
    singleColumn.value = !singleColumn.value
    sourceDrawerOpen.value = false
  }

  const readingMode = ref(false)

  const landscapeWorkbench = ref(false)

  const presetPage = ref(1)

  const sourcePage = ref(1)

  const targetPage = ref(1)

  const favoritePage = ref(1)

  const productName = ref('')

  const versionNote = ref('')

  const saveAsVersion = ref(true)

  const busy = ref(false)

  const notice = ref('')

  const errorMessage = ref('')

  const successName = ref('')

  const pendingDraft = ref<PresetStitchDraft>()

  const checkpoint = ref<PresetStitchDraft>()

  const recentIds = ref<string[]>([])

  const presetJsonCache = new Map<string, Record<string, unknown>>()

  const promptAnalysisCache = new PresetPromptAnalysisCache()

  let draftTimer = 0

  const {
    sourceDrag,
    guardDragTouch,
    startSourceDrag,
    cancelSourceDrag,
    consumeSuppressedSourceAction,
  } = usePresetSourceDrag({
    busy,
    notice,
    insertionIndex,
    commitSourceDrop,
    onPickup: () => {
      if (singleColumn.value) sourceDrawerOpen.value = false
    },
  })

  let editorVisualViewport: VisualViewport | undefined

  let editorViewportFrame: number | undefined

  let mobileEditorMedia: MediaQueryList | undefined

  let landscapeWorkbenchMedia: MediaQueryList | undefined

  const workbenchHistory = ref<WorkbenchSnapshot[]>([])

  const workbenchHistoryIndex = ref(-1)

  const editorOverlayStyle = computed(() => ({
    '--stitch-editor-viewport': editorViewportHeight.value
      ? `${editorViewportHeight.value}px`
      : 'var(--app-viewport-height)',
    '--stitch-editor-keyboard-offset': `${editorKeyboardOffset.value}px`,
  }))

  const fullWorkspaceActive = computed(
    () => step.value === 'workbench' && (readingMode.value || landscapeWorkbench.value),
  )

  const roleLabels: Record<string, string> = { system: '系统', user: '用户', assistant: '助手' }

  const hiddenCategoryIds = computed(() => getHiddenCategoryIds(props.categories))

  const presetList = computed(() => {
    const query = presetSearch.value.trim().toLocaleLowerCase()
    const list = props.resources.filter(
      (resource) =>
        resource.type === RESOURCE_TYPE.PRESET &&
        !isResourceHiddenByCategory(resource, hiddenCategoryIds.value) &&
        (!query ||
          resource.name.toLocaleLowerCase().includes(query) ||
          resource.fileName.toLocaleLowerCase().includes(query)),
    )
    const recentRank = new Map(recentIds.value.map((id, index) => [id, index]))
    return [...list].sort((left, right) => {
      const leftRank = recentRank.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = recentRank.get(right.id) ?? Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      const leftStitched = Array.isArray(left.metadata.stitchedFrom) ? 1 : 0
      const rightStitched = Array.isArray(right.metadata.stitchedFrom) ? 1 : 0
      if (leftStitched !== rightStitched) return leftStitched - rightStitched
      return right.updatedAt - left.updatedAt
    })
  })

  const sourcePresetList = computed(() =>
    presetList.value.filter((resource) => resource.id !== baseSummary.value?.id),
  )

  const presetPageCount = computed(() =>
    Math.max(1, Math.ceil(presetList.value.length / PRESET_PAGE_SIZE)),
  )

  const presetPageItems = computed(() =>
    presetList.value.slice(
      (presetPage.value - 1) * PRESET_PAGE_SIZE,
      presetPage.value * PRESET_PAGE_SIZE,
    ),
  )

  const sourcePresetPageCount = computed(() =>
    Math.max(1, Math.ceil(sourcePresetList.value.length / PRESET_PAGE_SIZE)),
  )

  const sourcePresetPageItems = computed(() =>
    sourcePresetList.value.slice(
      (presetPage.value - 1) * PRESET_PAGE_SIZE,
      presetPage.value * PRESET_PAGE_SIZE,
    ),
  )

  const sourceJson = computed(() =>
    sourceSummary.value ? presetJsonCache.get(sourceSummary.value.id) : undefined,
  )

  const sourceSegments = computed(() => {
    if (!sourceJson.value || !sourceSummary.value) return []
    const query = segmentSearch.value.trim().toLocaleLowerCase()
    return listPresetSegments(sourceJson.value)
      .filter(
        (segment) =>
          segment.stitchable &&
          (!roleFilter.value || roleFilter.value === 'regex' || segment.role === roleFilter.value),
      )
      .map((segment) => {
        const override = sourceOverrides.value.get(
          `${sourceSummary.value!.id}:${segment.identifier}`,
        )
        return override ? { ...segment, ...override, charCount: override.content.length } : segment
      })
      .filter(
        (segment) =>
          !query ||
          segment.name.toLocaleLowerCase().includes(query) ||
          segment.content.toLocaleLowerCase().includes(query),
      )
  })

  const sourcePageCount = computed(() =>
    Math.max(1, Math.ceil(sourceSegments.value.length / PAGE_SIZE)),
  )

  const sourcePageItems = computed(() =>
    sourceSegments.value.slice((sourcePage.value - 1) * PAGE_SIZE, sourcePage.value * PAGE_SIZE),
  )

  const favoritePageCount = computed(() =>
    Math.max(1, Math.ceil(favorites.value.length / PAGE_SIZE)),
  )

  const favoritePageItems = computed(() =>
    favorites.value.slice((favoritePage.value - 1) * PAGE_SIZE, favoritePage.value * PAGE_SIZE),
  )

  const sourceRegexScripts = computed(() =>
    sourceJson.value ? listPresetRegexScripts(sourceJson.value) : [],
  )

  const sourceRegexPicked = computed(() =>
    regexPicks.value.some((pick) => pick.sourceResourceId === sourceSummary.value?.id),
  )

  const pickedKeys = computed(
    () =>
      new Set(assembly.value.filter((entry) => entry.origin === 'pick').map((entry) => entry.key)),
  )

  const candidateCharacterCount = computed(() =>
    candidates.value.reduce((total, candidate) => total + candidate.content.length, 0),
  )

  const selectedComparisonEntry = computed(
    () =>
      assembly.value[Math.max(0, Math.min(insertionIndex.value - 1, assembly.value.length - 1))],
  )

  const comparisonCandidate = computed(() =>
    candidates.value.find((candidate) => candidate.id === compareCandidateId.value),
  )
  const {
    candidateConflicts,
    baseIsStitched,
    draftBaseName,
    reviewItems,
    reviewGroups,
    getEntryChangeKind,
    unreadWrittenVariables,
    activeTargetFilterCount,
    targetPageCount,
    targetPageItems,
    blockingPromptIssues,
    reviewAddedMacros,
    reviewRemovedMacros,
  } = usePresetAssemblyAnalysis({
    assembly,
    candidates,
    promptAnalysisCache,
    baseSummary,
    pendingDraft,
    props,
    baseJson,
    regexPicks,
    showVariableReadsOnly,
    showVariableWritesOnly,
    showEnabledOnly,
    showModifiedOnly,
    PAGE_SIZE,
    targetPage,
  })

  const canUndo = computed(() => workbenchHistoryIndex.value > 0)

  const canRedo = computed(
    () =>
      workbenchHistoryIndex.value >= 0 &&
      workbenchHistoryIndex.value < workbenchHistory.value.length - 1,
  )

  const hasDraftChanges = computed(
    () =>
      reviewItems.value.length > 0 || sourceOverrides.value.size > 0 || candidates.value.length > 0,
  )

  function presetSegmentCount(resource: ResourceSummary): number {
    const count = resource.metadata.promptCount ?? resource.metadata.itemCount
    return typeof count === 'number' ? count : 0
  }

  function formatDate(value: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
    }).format(value)
  }

  function setPage(target: 'preset' | 'source' | 'target' | 'favorite', page: number): void {
    const state = {
      preset: presetPage,
      source: sourcePage,
      target: targetPage,
      favorite: favoritePage,
    }[target]
    const count = {
      preset: step.value === 'base' ? presetPageCount : sourcePresetPageCount,
      source: sourcePageCount,
      target: targetPageCount,
      favorite: favoritePageCount,
    }[target]
    state.value = Math.min(Math.max(page, 1), count.value)
  }

  function toggleMainSide(): void {
    mainSide.value = browserStorageService.setStitchMainSide(
      mainSide.value === 'right' ? 'left' : 'right',
    )
  }

  function toggleReadingMode(): void {
    if (step.value !== 'workbench') return
    readingMode.value = !readingMode.value
  }

  function resetAll(): void {
    step.value = 'base'
    readingMode.value = false
    baseSummary.value = undefined
    baseJson.value = undefined
    sourceSummary.value = undefined
    assembly.value = []
    regexPicks.value = []
    candidates.value = []
    candidateSheetOpen.value = false
    compareCandidateId.value = ''
    sourceOverrides.value = new Map()
    insertionIndex.value = 0
    productName.value = ''
    versionNote.value = ''
    notice.value = ''
    errorMessage.value = ''
    successName.value = ''
    editor.value = undefined
    variableWriterOpen.value = false
    slotWriterOpen.value = false
    slotWriterError.value = ''
    showEnabledOnly.value = false
    showModifiedOnly.value = false
    showVariableReadsOnly.value = false
    showVariableWritesOnly.value = false
    targetFiltersOpen.value = false
    workbenchHistory.value = []
    workbenchHistoryIndex.value = -1
  }

  function requestBack(): void {
    if (readingMode.value) {
      readingMode.value = false
      return
    }
    saveDraftNow()
    if (step.value === 'review') step.value = 'workbench'
    else if (step.value === 'workbench') step.value = 'base'
    else emit('back')
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (event.target instanceof Element && event.target.closest('.stitch-tools')) return
    if (sourceDrag.value) {
      cancelSourceDrag()
      event.preventDefault()
      return
    }
    if (sourceDrawerOpen.value) {
      sourceDrawerOpen.value = false
      event.preventDefault()
      return
    }
    if (readingMode.value) readingMode.value = false
    else if (variableWriterOpen.value) variableWriterOpen.value = false
    else if (slotWriterOpen.value) slotWriterOpen.value = false
    else if (sourcePickerOpen.value) sourcePickerOpen.value = false
    else if (candidateSheetOpen.value) candidateSheetOpen.value = false
    else if (editor.value) cancelEdit()
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function scheduleEditorViewportSync(): void {
    if (editorViewportFrame !== undefined) return
    editorViewportFrame = window.requestAnimationFrame(() => {
      editorViewportFrame = undefined
      const viewport = window.visualViewport
      const height = viewport ? Math.round(viewport.height) : 0
      const offset = viewport
        ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
        : 0
      if (editorViewportHeight.value !== height) editorViewportHeight.value = height
      if (editorKeyboardOffset.value !== offset) editorKeyboardOffset.value = offset
    })
  }

  function syncMobileEditorOverlay(): void {
    mobileEditorOverlay.value = Boolean(mobileEditorMedia?.matches)
  }

  function syncLandscapeWorkbench(): void {
    const nextLandscapeWorkbench = Boolean(landscapeWorkbenchMedia?.matches)
    const changed = landscapeWorkbench.value !== nextLandscapeWorkbench
    landscapeWorkbench.value = nextLandscapeWorkbench
    if (landscapeWorkbench.value) {
      roleFiltersOpen.value = false
      targetFiltersOpen.value = false
    } else if (changed) {
      targetFiltersOpen.value = false
    }
  }

  watch(presetSearch, () => (presetPage.value = 1))

  watch([segmentSearch, roleFilter], () => (sourcePage.value = 1))

  watch(
    [showEnabledOnly, showModifiedOnly, showVariableReadsOnly, showVariableWritesOnly],
    () => (targetPage.value = 1),
  )

  watch(
    [sourcePickerOpen, candidateSheetOpen, editor, variableWriterOpen, slotWriterOpen],
    ([sourceOpen, candidateOpen, activeEditor, variableOpen, slotOpen]) => {
      document.body.classList.toggle(
        'modal-open',
        sourceOpen || candidateOpen || Boolean(activeEditor) || variableOpen || slotOpen,
      )
    },
  )

  watch(
    [() => step.value === 'workbench', fullWorkspaceActive],
    ([workbenchOpen, fullWorkspaceOpen]) => {
      document.body.classList.toggle('stitch-workbench-open', workbenchOpen && !fullWorkspaceOpen)
    },
    { immediate: true },
  )

  watch(sourcePageCount, (count) => (sourcePage.value = Math.min(sourcePage.value, count)))

  watch(targetPageCount, (count) => (targetPage.value = Math.min(targetPage.value, count)))

  watch(favoritePageCount, (count) => (favoritePage.value = Math.min(favoritePage.value, count)))

  watch(
    [
      assembly,
      regexPicks,
      candidates,
      productName,
      versionNote,
      saveAsVersion,
      sourceOverrides,
      mainSide,
    ],
    queueDraftSave,
    { deep: true },
  )

  watch([assembly, regexPicks, candidates, sourceOverrides], recordWorkbenchHistory, {
    deep: true,
    flush: 'post',
  })

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown, true)
    window.addEventListener('pagehide', saveDraftNow)
    editorVisualViewport = window.visualViewport ?? undefined
    scheduleEditorViewportSync()
    editorVisualViewport?.addEventListener('resize', scheduleEditorViewportSync)
    editorVisualViewport?.addEventListener('scroll', scheduleEditorViewportSync)
    if (typeof window.matchMedia === 'function') {
      mobileEditorMedia = window.matchMedia('(max-width: 52rem)')
      syncMobileEditorOverlay()
      mobileEditorMedia.addEventListener?.('change', syncMobileEditorOverlay)
      landscapeWorkbenchMedia = window.matchMedia(
        '(orientation: landscape) and (max-height: 34rem)',
      )
      syncLandscapeWorkbench()
      landscapeWorkbenchMedia.addEventListener?.('change', syncLandscapeWorkbench)
    }
    recentIds.value = browserStorageService.getStitchRecentIds()
    favorites.value = browserStorageService.getStitchFavorites()
    stitchTemplates.value = browserStorageService.getStitchTemplates()
    mainSide.value = browserStorageService.getStitchMainSide()
    const storedCheckpoint = browserStorageService.getPresetStitchCheckpoint()
    if (
      storedCheckpoint &&
      props.resources.some((resource) => resource.id === storedCheckpoint.baseId)
    ) {
      checkpoint.value = storedCheckpoint
    }
    const draft = browserStorageService.getPresetStitchDraft()
    if (draft && props.resources.some((resource) => resource.id === draft.baseId))
      pendingDraft.value = draft
  })

  onUnmounted(() => {
    saveDraftNow()
    window.removeEventListener('keydown', handleKeydown, true)
    window.removeEventListener('pagehide', saveDraftNow)
    editorVisualViewport?.removeEventListener('resize', scheduleEditorViewportSync)
    editorVisualViewport?.removeEventListener('scroll', scheduleEditorViewportSync)
    if (editorViewportFrame !== undefined) window.cancelAnimationFrame(editorViewportFrame)
    mobileEditorMedia?.removeEventListener?.('change', syncMobileEditorOverlay)
    landscapeWorkbenchMedia?.removeEventListener?.('change', syncLandscapeWorkbench)
    if (draftTimer) window.clearTimeout(draftTimer)
    cancelSourceDrag()
    document.body.classList.remove('modal-open')
    document.body.classList.remove('stitch-workbench-open')
  })
  return {
    singleColumn,
    sourceDrawerOpen,
    toggleSingleColumn,
    guardDragTouch,
    setEditorTextarea,
    fullWorkspaceActive,
    step,
    requestBack,
    readingMode,
    toggleReadingMode,
    mainSide,
    toggleMainSide,
    baseSummary,
    errorMessage,
    notice,
    pendingDraft,
    draftBaseName,
    busy,
    restoreDraft,
    discardDraft,
    presetSearch,
    presetPageItems,
    chooseBase,
    presetSegmentCount,
    formatDate,
    presetPageCount,
    presetPage,
    setPage,
    sourceDrag,
    sourcePickerOpen,
    sourceMode,
    sourceSummary,
    favoritePageItems,
    expandedSourceKeys,
    toggleExpanded,
    startSourceDrag,
    cancelSourceDrag,
    insertFavoriteFromAction,
    editor,
    editorOverlayStyle,
    mobileEditorOverlay,
    ROLE_OPTIONS,
    rememberEditorSelection,
    QUICK_VARIABLES,
    insertVariable,
    openVariableWriter,
    openSlotWriter,
    openSlotWriterForVariable,
    slotName,
    slotId,
    slotWriterError,
    slotWriterOpen,
    insertPromptSlot,
    unreadWrittenVariables,
    insertUnreadWrittenVariable,
    saveEdit,
    cancelEdit,
    getPromptDisplayTokens,
    beginFavoriteEdit,
    copyEntryContent,
    isCandidate,
    toggleCandidateFromFavorite,
    removeFavorite,
    favorites,
    favoritePageCount,
    favoritePage,
    segmentSearch,
    roleFiltersOpen,
    ROLE_FILTERS,
    roleFilter,
    sourcePageItems,
    pickedKeys,
    roleLabels,
    findSourceEntry,
    toggleSegmentFromAction,
    sourceKey,
    beginSourceEdit,
    isFavorite,
    toggleFavorite,
    toggleCandidateFromSource,
    sourceRegexScripts,
    sourceRegexPicked,
    toggleRegexGroup,
    sourcePageCount,
    sourcePage,
    candidateSheetOpen,
    candidates,
    candidateCharacterCount,
    targetFiltersOpen,
    activeTargetFilterCount,
    showEnabledOnly,
    showModifiedOnly,
    showVariableReadsOnly,
    showVariableWritesOnly,
    targetPage,
    targetPageItems,
    insertionIndex,
    selectInsertionIndex,
    getEntryChangeKind,
    expandedTargetKeys,
    beginTargetEdit,
    beginNewEntry,
    moveEntry,
    assembly,
    promptSlotCount,
    removePickByKey,
    targetPageCount,
    canUndo,
    undoWorkbench,
    canRedo,
    redoWorkbench,
    saveCheckpoint,
    checkpoint,
    restoreCheckpoint,
    blockingPromptIssues,
    reviewItems,
    openReview,
    reviewGroups,
    reviewAddedMacros,
    reviewRemovedMacros,
    productName,
    baseIsStitched,
    saveAsVersion,
    versionNote,
    generate,
    successName,
    resetAll,
    variableWriterOpen,
    variableName,
    variableValue,
    variableValueSelection,
    insertVariableWrite,
    chooseFavoriteSource,
    sourcePresetPageItems,
    chooseSource,
    sourcePresetPageCount,
    candidateConflicts,
    compareCandidateId,
    insertCandidate,
    removeCandidate,
    comparisonCandidate,
    selectedComparisonEntry,
    templateName,
    saveCandidateTemplate,
    stitchTemplates,
    applyCandidateTemplate,
    removeCandidateTemplate,
    insertAllCandidates,
  }
}
