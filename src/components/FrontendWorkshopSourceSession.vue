<script setup lang="ts">
import '../FeatureStyles.css'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import {
  APP_RESUME_STATE_CHANGE_EVENT,
  readAppResumeState,
  type AppResumeState,
} from '../core/AppResumeState'
import { browserStorageService } from '../core/AppContainer'
import {
  frontendWorkshopSourceComponentService,
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceHistoryService,
} from '../core/FrontendWorkshopContainer'
import { FrontendWorkshopSourceRevisionConflictError } from '../services/FrontendWorkshopSourceDocumentService'
import { FrontendWorkshopSourceHistoryStaleError } from '../services/FrontendWorkshopSourceHistoryService'
import {
  diagnoseFrontendWorkshopSourceCompatibility,
  type FrontendWorkshopSourceCompatibilityCategory,
  type FrontendWorkshopSourceRuntimeErrorEvidence,
  type FrontendWorkshopSourceRuntimeFixIntent,
} from '../services/FrontendWorkshopSourceCompatibilityDiagnosticsService'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import type { FrontendWorkshopSourceCanvasGesture } from '../utils/FrontendWorkshopSourceCanvasGesture'
import type { FrontendWorkshopResolvedSourceSelection } from '../utils/FrontendWorkshopSourceSelection'
import type { FrontendWorkshopLayerView } from '../utils/FrontendWorkshopSourceLayers'
import FrontendWorkshopSourceLayerPanel from './FrontendWorkshopSourceLayerPanel.vue'
import { analyzeFrontendWorkshopSource } from '../utils/FrontendWorkshopSourceAnalysis'
import {
  resolveFrontendWorkshopSourceTransformTargets,
  type FrontendWorkshopSourceTransformTargets,
} from '../utils/FrontendWorkshopSourceTransform'
import type {
  FrontendWorkshopSourceRuntimeDomSelection,
  FrontendWorkshopSourceRuntimeNetworkMode,
} from '../utils/FrontendWorkshopSourceRuntime'
import type { RenderCompatibilityDiagnostic } from '../utils/RenderCompatibilityRuntime'
import { createFrontendWorkshopSourceInsertionPatch } from '../utils/FrontendWorkshopSourceComponent'
import type {
  FrontendWorkshopNodeKind,
  FrontendWorkshopAssetLink,
} from '../types/FrontendWorkshopProject'
import FrontendWorkshopGreetingStrip from './FrontendWorkshopGreetingStrip.vue'
import FrontendWorkshopSourcePreview from './FrontendWorkshopSourcePreview.vue'
import FrontendWorkshopSourceInspector from './FrontendWorkshopSourceInspector.vue'
import FrontendWorkshopSourceHistoryPanel from './FrontendWorkshopSourceHistoryPanel.vue'
import FrontendWorkshopSourceComponentLibrary from './FrontendWorkshopSourceComponentLibrary.vue'
import FrontendWorkshopSourceWorkspace from './FrontendWorkshopSourceWorkspace.vue'
import FrontendWorkshopWorkbench from './FrontendWorkshopWorkbench.vue'
import type { FrontendWorkshopViewportAction } from './FrontendWorkshopProjectBar.vue'
import FeatureBackButton from './FeatureBackButton.vue'

const emit = defineEmits<{
  back: []
  libraryChanged: []
  sourceAvailabilityChanged: [available: boolean]
  sourceRequested: []
  sourceAiRequested: [instruction?: string]
  sourceRuntimeFixRequested: [intent: FrontendWorkshopSourceRuntimeFixIntent]
}>()

type SourceLookupState = 'idle' | 'loading' | 'source' | 'legacy' | 'error'

const sourceDocument = shallowRef<FrontendWorkshopSourceDocument>()
function requestSourceViewport(action: FrontendWorkshopViewportAction): void {
  const owner = sourceWorkspace.value
  if (action === 'phone' || action === 'wide') owner?.setCanvasMode(action)
  else if (action === 'zoom-out') owner?.adjustZoom(-0.1)
  else if (action === 'zoom-in') owner?.adjustZoom(0.1)
  else if (action === 'reset') owner?.resetViewport()
  else if (action === 'fit-canvas') owner?.fitCanvas()
  else owner?.fitSelection()
}
const sourceProjectId = ref('')
const sourceLookupState = ref<SourceLookupState>('idle')
const sourceLookupError = ref('')
const sourcePreviewOpen = ref(false)
const sourceRuntimeError = ref('')
const sourceCompatibilityOpen = ref(false)
const sourceRuntimeDiagnostics = shallowRef<RenderCompatibilityDiagnostic[]>([])
const sourceRuntimeErrors = shallowRef<FrontendWorkshopSourceRuntimeErrorEvidence[]>([])
const sourceSelectionMode = ref(false)
const sourceMultiSelectMode = ref(false)
const activeGreeting = ref(0)
const sourceEditStatus = ref('')
const sourceEditSaving = ref(false)
const sourceHistoryStatus = shallowRef(frontendWorkshopSourceHistoryService.status(''))
const sourceSelections = shallowRef<FrontendWorkshopResolvedSourceSelection[]>([])
const sourceComponentLibraryOpen = ref(false)
const sourceComponentInsertBusyId = ref('')
const sourceTransformTargets = shallowRef<FrontendWorkshopSourceTransformTargets>({ fields: {} })
const sourceWorkspace = ref<InstanceType<typeof FrontendWorkshopSourceWorkspace>>()
const sourceInspector = ref<InstanceType<typeof FrontendWorkshopSourceInspector>>()
const sourceComponentLibrary = ref<InstanceType<typeof FrontendWorkshopSourceComponentLibrary>>()
const networkMode = ref<FrontendWorkshopSourceRuntimeNetworkMode>(
  browserStorageService.getPreviewPolicy().allowRemoteResources ? 'host' : 'offline',
)
const sourceSelection = computed(() => sourceSelections.value.at(-1))
const layerView = ref<FrontendWorkshopLayerView>({ hidden: [], locked: [] })
watch(sourceProjectId, () => {
  layerView.value = { hidden: [], locked: [] }
})
async function selectLayerElements(
  selections: FrontendWorkshopResolvedSourceSelection[],
): Promise<void> {
  activeGreeting.value = 0
  await nextTick()
  const source = sourceDocument.value
  if (!selections.length || !source) return
  sourceWorkspace.value?.clearSelections()
  await nextTick()
  sourceSelectionMode.value = true
  if (
    selections.length === 1 &&
    selections[0]?.sourceEntityId &&
    (await sourceWorkspace.value?.selectSourceElement(selections[0].sourceEntityId))
  )
    return
  updateSourceSelections(selections)
  sourceTransformTargets.value = resolveFrontendWorkshopSourceTransformTargets(
    source,
    analyzeFrontendWorkshopSource(source),
    selections.at(-1)!,
  )
}
async function requestLayerAi(
  instruction: string,
  selections: FrontendWorkshopResolvedSourceSelection[],
): Promise<void> {
  if (selections.length) await selectLayerElements(selections)
  else {
    sourceWorkspace.value?.clearSelections()
    updateSourceSelections([])
    await nextTick()
  }
  emit('sourceAiRequested', instruction)
}
function updateLayerView(view: FrontendWorkshopLayerView): void {
  layerView.value = view
  sourceWorkspace.value?.clearSelections()
  updateSourceSelections([])
}
let sourceLoadGeneration = 0
let sourceLookupPromise: Promise<void> = Promise.resolve()
let previewRequestGeneration = 0
let stopPreviewPolicyListener: (() => void) | undefined
let previousBodyOverflow = ''

const sourcePreviewLabel = computed(() =>
  networkMode.value === 'host' ? '外部资源按浏览器规则加载' : '离线预览',
)
const visibleSourceError = computed(() => sourceLookupError.value || sourceRuntimeError.value)
const sourceCompatibilityReport = computed(() => {
  const source = sourceDocument.value
  if (!source) return undefined
  return diagnoseFrontendWorkshopSourceCompatibility(source, {
    runtimeDiagnostics: sourceRuntimeDiagnostics.value,
    runtimeErrors: sourceRuntimeErrors.value,
  })
})
const SOURCE_COMPATIBILITY_CATEGORY_LABELS: Readonly<
  Record<FrontendWorkshopSourceCompatibilityCategory, string>
> = {
  syntax: '语法',
  'host-api': '宿主能力',
  'multi-instance': '多实例',
  'global-selector': '选择范围',
  viewport: '视口',
  'rerender-cleanup': '重复渲染',
  'mobile-overflow': '移动端',
  'external-resource': '外部资源',
  'external-host': '外部宿主',
  'module-build': 'Browser 编译',
  lifecycle: '生命周期',
  'mvu-optionality': 'MVU 可选性',
  runtime: '运行时',
}
const workbenchSourceOwnerState = computed<'visual' | 'pending' | 'source'>(() => {
  if (!sourceProjectId.value) return 'visual'
  if (sourceLookupState.value === 'source') return 'source'
  if (sourceLookupState.value === 'legacy') return 'visual'
  return 'pending'
})
function projectIdFromResumeState(state: AppResumeState | null): string {
  return state?.feature === 'frontendWorkshop' ? (state.projectId ?? '') : ''
}

function resetSourceRuntimeSelection(clearMode = false): void {
  sourceSelections.value = []
  sourceTransformTargets.value = { fields: {} }
  if (clearMode) {
    sourceSelectionMode.value = false
    sourceMultiSelectMode.value = false
  }
  sourceWorkspace.value?.resetSelection(clearMode)
}

function resetSourceCompatibilityEvidence(): void {
  sourceRuntimeDiagnostics.value = []
  sourceRuntimeErrors.value = []
}

function refreshSourceHistoryStatus(source = sourceDocument.value): void {
  if (!source) {
    sourceHistoryStatus.value = frontendWorkshopSourceHistoryService.status('')
    return
  }
  const status = frontendWorkshopSourceHistoryService.status(source.projectId)
  if (status.expectedRevision !== undefined && status.expectedRevision !== source.revision)
    frontendWorkshopSourceHistoryService.clearProject(source.projectId)
  sourceHistoryStatus.value = frontendWorkshopSourceHistoryService.status(source.projectId)
}

async function syncSourceDocument(state: AppResumeState | null): Promise<void> {
  const projectId = projectIdFromResumeState(state)
  const generation = ++sourceLoadGeneration
  previewRequestGeneration += 1
  sourceProjectId.value = projectId
  activeGreeting.value = 0
  sourceDocument.value = undefined
  refreshSourceHistoryStatus()
  emit('sourceAvailabilityChanged', false)
  sourceLookupError.value = ''
  sourceRuntimeError.value = ''
  sourceCompatibilityOpen.value = false
  resetSourceCompatibilityEvidence()
  sourceEditStatus.value = ''
  sourcePreviewOpen.value = false
  sourceComponentLibraryOpen.value = false
  sourceComponentInsertBusyId.value = ''
  resetSourceRuntimeSelection(true)

  if (!projectId) {
    sourceLookupState.value = 'idle'
    return
  }

  sourceLookupState.value = 'loading'
  try {
    const document = await frontendWorkshopSourceDocumentService.get(projectId)
    if (generation !== sourceLoadGeneration || sourceProjectId.value !== projectId) return
    sourceDocument.value = document
    refreshSourceHistoryStatus(document)
    sourceLookupState.value = document ? 'source' : 'legacy'
    emit('sourceAvailabilityChanged', Boolean(document))
  } catch (error) {
    if (generation !== sourceLoadGeneration || sourceProjectId.value !== projectId) return
    sourceLookupState.value = 'error'
    sourceLookupError.value = error instanceof Error ? error.message : '源码暂时无法读取'
    emit('sourceAvailabilityChanged', false)
  }
}

function scheduleSourceSync(state: AppResumeState | null = readAppResumeState()): void {
  const projectId = projectIdFromResumeState(state)
  if (
    projectId &&
    projectId === sourceProjectId.value &&
    (sourceLookupState.value === 'loading' || sourceLookupState.value === 'source')
  ) {
    return
  }
  sourceLookupPromise = syncSourceDocument(state)
}

function handleResumeStateChange(event: Event): void {
  scheduleSourceSync((event as CustomEvent<AppResumeState>).detail ?? readAppResumeState())
}

interface WorkbenchPreviewRequest {
  handled: boolean
  openLegacyPreview: () => void
}

async function resolvePreviewAfterLookup(
  request: WorkbenchPreviewRequest,
  projectId: string,
  requestGeneration: number,
): Promise<void> {
  await sourceLookupPromise
  if (requestGeneration !== previewRequestGeneration || sourceProjectId.value !== projectId) return

  if (sourceLookupState.value === 'source' && sourceDocument.value) {
    sourceRuntimeError.value = ''
    sourcePreviewOpen.value = true
    return
  }
  if (sourceLookupState.value === 'legacy' || sourceLookupState.value === 'idle') {
    request.openLegacyPreview()
    return
  }
  if (sourceLookupState.value === 'error') sourcePreviewOpen.value = true
}

function handlePreviewRequest(request: WorkbenchPreviewRequest): void {
  if (sourceLookupState.value === 'legacy' || sourceLookupState.value === 'idle') return

  request.handled = true
  if (sourceLookupState.value === 'source' && sourceDocument.value) {
    sourceRuntimeError.value = ''
    sourcePreviewOpen.value = true
    return
  }
  if (sourceLookupState.value === 'error') {
    sourcePreviewOpen.value = true
    return
  }

  const projectId = sourceProjectId.value
  const requestGeneration = ++previewRequestGeneration
  void resolvePreviewAfterLookup(request, projectId, requestGeneration)
}

function closeSourcePreview(): void {
  sourcePreviewOpen.value = false
  sourceCompatibilityOpen.value = false
  sourceRuntimeError.value = ''
  sourceEditStatus.value = ''
}

function handleBackRequest(event: Event): void {
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (sourceComponentLibraryOpen.value) {
    if (detail) detail.handled = true
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!sourceComponentLibrary.value?.handleBack()) sourceComponentLibraryOpen.value = false
    return
  }
  if (sourceCompatibilityOpen.value) {
    if (detail) detail.handled = true
    event.preventDefault()
    event.stopImmediatePropagation()
    sourceCompatibilityOpen.value = false
    return
  }
  if (!sourcePreviewOpen.value) return
  if (detail) detail.handled = true
  event.preventDefault()
  event.stopImmediatePropagation()
  closeSourcePreview()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (sourceComponentLibraryOpen.value) {
    event.preventDefault()
    if (!sourceComponentLibrary.value?.handleBack()) sourceComponentLibraryOpen.value = false
    return
  }
  if (sourceCompatibilityOpen.value) {
    event.preventDefault()
    sourceCompatibilityOpen.value = false
    return
  }
  if (!sourcePreviewOpen.value) return
  event.preventDefault()
  closeSourcePreview()
}

function openSourceComponentLibrary(): void {
  if (sourceLookupState.value !== 'source' || !sourceDocument.value) return
  sourceComponentLibraryOpen.value = true
}

function openSourceCompatibilityDiagnostics(): void {
  if (sourceLookupState.value !== 'source' || !sourceDocument.value) return
  resetSourceCompatibilityEvidence()
  sourceRuntimeError.value = ''
  sourceCompatibilityOpen.value = true
  sourcePreviewOpen.value = true
}

async function insertBasicSourceContent(
  kind: FrontendWorkshopNodeKind | 'button',
  image?: FrontendWorkshopAssetLink,
): Promise<void> {
  const source = sourceDocument.value
  if (!source || sourceEditSaving.value) return
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const markup: Record<FrontendWorkshopNodeKind | 'button', string> = {
    button: '<button type="button">按钮</button>',
    text: '<p style="font-size:16px;color:#263238">新文字</p>',
    image: `<img src="${escape(image?.url ?? '')}" alt="${escape(image?.name ?? '图片')}" style="width:200px;object-fit:contain">`,
    block:
      '<section style="display:flex;flex-direction:column;padding:16px;gap:8px"><p>新区块</p></section>',
    divider: '<hr>',
    control: '<input type="text" placeholder="请输入内容" value="">',
  }
  sourceEditSaving.value = true
  try {
    const applied = await frontendWorkshopSourceHistoryService.applyAndRecord(
      createFrontendWorkshopSourceInsertionPatch(source, markup[kind]),
      { label: '添加内容' },
    )
    acceptSourceRevision(applied.document, '已添加到源码；可撤销')
  } catch (error) {
    sourceEditStatus.value = error instanceof Error ? error.message : '添加失败'
  } finally {
    sourceEditSaving.value = false
  }
}

async function insertCurrentProjectComponent(componentId: string): Promise<void> {
  const source = sourceDocument.value
  if (!source || sourceComponentInsertBusyId.value) return
  sourceComponentInsertBusyId.value = componentId
  try {
    const result = await frontendWorkshopSourceComponentService.insertIntoProject(
      componentId,
      source.projectId,
      source.revision,
    )
    acceptSourceRevision(result.document, '已插入组件；可撤销')
  } catch (reason) {
    sourceEditStatus.value = reason instanceof Error ? reason.message : '组件插入失败'
  } finally {
    sourceComponentInsertBusyId.value = ''
  }
}

function quickUseSourceComponent(componentId: string): void {
  sourceComponentLibraryOpen.value = false
  void insertCurrentProjectComponent(componentId)
}

function handleRuntimeError(payload: { kind: string; message: string }): void {
  const message = payload.message.trim()
  if (message) {
    const evidence = { kind: payload.kind.trim() || 'error', message }
    sourceRuntimeErrors.value = [
      ...sourceRuntimeErrors.value.filter(
        (candidate) => candidate.kind !== evidence.kind || candidate.message !== evidence.message,
      ),
      evidence,
    ].slice(-50)
  }
  sourceRuntimeError.value = message
    ? `源码运行提示：${message.slice(0, 240)}`
    : '源码运行时出现未提供详情的错误'
}

function handleCompatibilityDiagnostic(diagnostic: RenderCompatibilityDiagnostic): void {
  sourceRuntimeDiagnostics.value = [
    ...sourceRuntimeDiagnostics.value.filter(
      (candidate) =>
        candidate.capability !== diagnostic.capability || candidate.source !== diagnostic.source,
    ),
    {
      ...diagnostic,
      ...(diagnostic.parityEvidence
        ? { parityEvidence: diagnostic.parityEvidence.map((evidence) => ({ ...evidence })) }
        : {}),
    },
  ].slice(-50)
}

function requestSourceRuntimeFix(): void {
  const source = sourceDocument.value
  const report = sourceCompatibilityReport.value
  const runtimeError = sourceRuntimeErrors.value.at(-1)
  if (!source || !report || !runtimeError) return
  const intent: FrontendWorkshopSourceRuntimeFixIntent = {
    projectId: source.projectId,
    sourceRevision: source.revision,
    sourceCreatedAt: source.createdAt,
    runtimeError: { ...runtimeError },
    diagnostics: report.findings.map((finding) => ({
      ...finding,
      ...(finding.sourceRange ? { sourceRange: { ...finding.sourceRange } } : {}),
    })),
  }
  closeSourcePreview()
  void nextTick(() => emit('sourceRuntimeFixRequested', intent))
}

function updateSourceSelections(
  selections: readonly FrontendWorkshopResolvedSourceSelection[],
): void {
  sourceSelections.value = selections.map((selection) => ({
    ...selection,
    ...(selection.sourceRange ? { sourceRange: { ...selection.sourceRange } } : {}),
  }))
  if (selections.length) sourceEditStatus.value = ''
}

function updateSourceTransformTargets(targets: FrontendWorkshopSourceTransformTargets): void {
  sourceTransformTargets.value = targets
}

function acceptSourceOwnerRevision(source?: FrontendWorkshopSourceDocument, message = ''): void {
  if (!source) {
    sourceDocument.value = undefined
    sourceLookupState.value = 'legacy'
    emit('sourceAvailabilityChanged', false)
    resetSourceRuntimeSelection()
    sourceEditStatus.value = message
    return
  }
  if (source.projectId !== sourceProjectId.value) return
  acceptSourceRevision(source, message)
}

function toggleSourceSelectionMode(): void {
  sourceEditStatus.value = ''
  sourceWorkspace.value?.toggleSelectionMode()
}

function toggleSourceMultiSelectMode(): void {
  sourceEditStatus.value = ''
  sourceWorkspace.value?.toggleMultiSelectMode()
}

function acceptSourceRevision(source: FrontendWorkshopSourceDocument, message: string): void {
  sourceDocument.value = source
  resetSourceCompatibilityEvidence()
  refreshSourceHistoryStatus(source)
  resetSourceRuntimeSelection()
  sourceEditStatus.value = message
  emit('libraryChanged')
}

async function runSourceHistoryAction(direction: 'undo' | 'redo'): Promise<void> {
  const source = sourceDocument.value
  if (!source || sourceEditSaving.value) return
  refreshSourceHistoryStatus(source)
  const status = sourceHistoryStatus.value
  if ((direction === 'undo' && !status.canUndo) || (direction === 'redo' && !status.canRedo)) return
  sourceEditSaving.value = true
  sourceEditStatus.value = direction === 'undo' ? '撤销中' : '重做中'
  try {
    const next =
      direction === 'undo'
        ? await frontendWorkshopSourceHistoryService.undo(source.projectId)
        : await frontendWorkshopSourceHistoryService.redo(source.projectId)
    if (!next || sourceProjectId.value !== source.projectId) return
    acceptSourceRevision(
      next,
      direction === 'undo'
        ? '已撤销；预览已按新 revision 重建'
        : '已重做；预览已按新 revision 重建',
    )
  } catch (reason) {
    if (
      reason instanceof FrontendWorkshopSourceRevisionConflictError ||
      reason instanceof FrontendWorkshopSourceHistoryStaleError
    ) {
      frontendWorkshopSourceHistoryService.clearProject(source.projectId)
      const latest = await frontendWorkshopSourceDocumentService.get(source.projectId)
      if (sourceProjectId.value !== source.projectId) return
      if (latest) acceptSourceRevision(latest, 'Source 已被更新，编辑历史已清空，请重新操作')
      else {
        sourceDocument.value = undefined
        sourceLookupState.value = 'legacy'
        refreshSourceHistoryStatus()
        sourceEditStatus.value = 'Source 已不存在，编辑历史已清空'
        emit('sourceAvailabilityChanged', false)
      }
    } else sourceEditStatus.value = reason instanceof Error ? reason.message : 'Source 历史操作失败'
  } finally {
    sourceEditSaving.value = false
    refreshSourceHistoryStatus()
  }
}

function acceptSourceComponentRevision(
  source: FrontendWorkshopSourceDocument,
  message: string,
): void {
  acceptSourceRevision(source, message)
}

function getCurrentSourceAiSelections(): FrontendWorkshopResolvedSourceSelection[] {
  const source = sourceDocument.value
  if (!source) return []
  const current = sourceSelections.value
  return current.map((selection) => ({
    ...selection,
    ...(selection.sourceRange ? { sourceRange: { ...selection.sourceRange } } : {}),
  }))
}

function acceptAppliedSourceAiRevision(
  source: FrontendWorkshopSourceDocument,
  message: string,
): boolean {
  if (source.projectId !== sourceProjectId.value) return false
  const current = sourceDocument.value
  if (current?.createdAt !== undefined && current.createdAt !== source.createdAt) return false
  if (current && source.revision <= current.revision) return false
  sourceLookupState.value = 'source'
  sourceLookupError.value = ''
  sourceRuntimeError.value = ''
  acceptSourceRevision(source, message)
  return true
}

defineExpose({ getCurrentSourceAiSelections, acceptAppliedSourceAiRevision })

function handleSourceCanvasGesture(payload: {
  selection: FrontendWorkshopSourceRuntimeDomSelection
  gesture: FrontendWorkshopSourceCanvasGesture
}): void {
  void sourceInspector.value?.applyCanvasGesture(payload)
}

watch(sourcePreviewOpen, (open) => {
  if (typeof document === 'undefined') return
  if (open) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = previousBodyOverflow
  }
})

onMounted(() => {
  window.addEventListener(APP_RESUME_STATE_CHANGE_EVENT, handleResumeStateChange)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest, true)
  window.addEventListener('keydown', handleKeydown)
  stopPreviewPolicyListener = browserStorageService.onPreviewPolicyChange((policy) => {
    networkMode.value = policy.allowRemoteResources ? 'host' : 'offline'
  })
  scheduleSourceSync()
})

onUnmounted(() => {
  sourceLoadGeneration += 1
  previewRequestGeneration += 1
  window.removeEventListener(APP_RESUME_STATE_CHANGE_EVENT, handleResumeStateChange)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBackRequest, true)
  window.removeEventListener('keydown', handleKeydown)
  stopPreviewPolicyListener?.()
  if (typeof document !== 'undefined' && sourcePreviewOpen.value) {
    document.body.style.overflow = previousBodyOverflow
  }
})
</script>

<template>
  <div class="frontend-workshop-source-session">
    <FrontendWorkshopWorkbench
      :source-owner-state="workbenchSourceOwnerState"
      :source-can-undo="sourceHistoryStatus.canUndo && !sourceEditSaving"
      :source-can-redo="sourceHistoryStatus.canRedo && !sourceEditSaving"
      :source-markup="sourceDocument?.authorSource"
      :source-saving="sourceEditSaving"
      :source-viewport="{
        mode: sourceWorkspace?.canvasMode ?? 'phone',
        zoomPercent: sourceWorkspace?.zoomPercent ?? 100,
        hasSelection: sourceSelections.length > 0,
      }"
      @source-viewport-requested="requestSourceViewport"
      @back="emit('back')"
      @library-changed="emit('libraryChanged')"
      @source-requested="emit('sourceRequested')"
      @source-component-library-requested="openSourceComponentLibrary"
      @source-undo-requested="runSourceHistoryAction('undo')"
      @source-add-requested="insertBasicSourceContent"
      @source-redo-requested="runSourceHistoryAction('redo')"
      @source-ai-requested="emit('sourceAiRequested', $event)"
      @source-compatibility-requested="openSourceCompatibilityDiagnostics"
      @preview-requested="handlePreviewRequest"
    >
      <template #source-selection-tools>
        <button
          v-if="sourceDocument"
          type="button"
          aria-label="选择元素"
          title="选择元素；长按画布可拖动视角"
          :disabled="activeGreeting > 0"
          :class="{ 'is-active': sourceSelectionMode && !sourceMultiSelectMode }"
          :aria-pressed="sourceSelectionMode && !sourceMultiSelectMode"
          @click="toggleSourceSelectionMode"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 14 10-7 1-3 7-4-18Z" /></svg>
        </button>
        <button
          v-if="sourceDocument"
          type="button"
          aria-label="多选元素"
          title="多选元素；再次点击元素取消选择"
          :disabled="activeGreeting > 0"
          :class="{ 'is-active': sourceMultiSelectMode }"
          :aria-pressed="sourceMultiSelectMode"
          @click="toggleSourceMultiSelectMode"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 3 14 10-7 1-3 7-4-18Z M17 17v6m-3-3h6" />
          </svg>
        </button>
      </template>
      <template #source-canvas>
        <div
          v-if="sourceDocument"
          v-show="!sourcePreviewOpen"
          class="frontend-workshop-source-session__editor-canvas"
        >
          <FrontendWorkshopGreetingStrip
            v-model="activeGreeting"
            :source-document="sourceDocument"
            :busy="sourceEditSaving"
            @busy-change="sourceEditSaving = $event"
            @revision-accepted="acceptSourceOwnerRevision"
          />
          <div
            class="frontend-workshop-source-session__workspace"
            :class="{ 'has-inspector': sourceSelectionMode }"
          >
            <FrontendWorkshopSourceWorkspace
              ref="sourceWorkspace"
              :source-document="sourceDocument"
              :network-mode="networkMode"
              :gesture-disabled="sourceEditSaving"
              :layer-view="layerView"
              :greeting-index="activeGreeting"
              @runtime-error="handleRuntimeError"
              @compatibility-diagnostic="handleCompatibilityDiagnostic"
              @selection-mode-change="sourceSelectionMode = $event"
              @multi-select-mode-change="sourceMultiSelectMode = $event"
              @greeting-change="activeGreeting = $event"
              @selections-change="updateSourceSelections"
              @transform-targets-change="updateSourceTransformTargets"
              @source-gesture="handleSourceCanvasGesture"
            />
            <FrontendWorkshopSourceInspector
              v-if="sourceDocument && activeGreeting === 0"
              ref="sourceInspector"
              :source-document="sourceDocument"
              :selection="sourceSelection"
              :selections="sourceSelections"
              :transform-targets="sourceTransformTargets"
              :external-busy="sourceEditSaving"
              :status="sourceEditStatus"
              @status-dismissed="sourceEditStatus = ''"
              @busy-change="sourceEditSaving = $event"
              @ai-requested="emit('sourceAiRequested')"
              @revision-accepted="acceptSourceOwnerRevision"
            />
          </div>
        </div>
      </template>
      <template #source-layers="{ close }">
        <FrontendWorkshopSourceLayerPanel
          v-if="sourceDocument"
          :source-document="sourceDocument"
          :selections="sourceSelections"
          :allow-remote-resources="networkMode === 'host'"
          :runtime-elements="sourceWorkspace?.layerEntries ?? []"
          :view-state="layerView"
          :busy="sourceEditSaving"
          @close="close"
          @select="selectLayerElements"
          @runtime-select="sourceWorkspace?.selectLayer($event)"
          @refresh="sourceWorkspace?.refreshLayers()"
          @view-change="updateLayerView"
          @revision-accepted="acceptSourceOwnerRevision"
          @busy-change="sourceEditSaving = $event"
          @ai-requested="requestLayerAi"
        />
      </template>
    </FrontendWorkshopWorkbench>
  </div>

  <Teleport to="body">
    <section
      v-if="sourcePreviewOpen && (sourceDocument || sourceLookupState === 'error')"
      class="frontend-workshop-source-session__preview"
      data-srl-controls
      role="dialog"
      aria-modal="true"
      aria-label="源码运行预览"
    >
      <header class="frontend-workshop-source-session__bar">
        <FeatureBackButton
          class="frontend-workshop-source-session__back"
          label="返回工作台"
          @click="closeSourcePreview"
        />
        <strong>源码运行预览</strong>
        <div class="frontend-workshop-source-session__bar-actions">
          <FrontendWorkshopSourceHistoryPanel
            v-if="sourceDocument"
            :source-document="sourceDocument"
            :external-busy="sourceEditSaving"
            @busy-change="sourceEditSaving = $event"
            @revision-accepted="acceptSourceOwnerRevision"
          />
          <small>{{ sourcePreviewLabel }}</small>
        </div>
      </header>
      <div class="frontend-workshop-source-session__notices" aria-live="polite">
        <p v-if="visibleSourceError" class="frontend-workshop-source-session__error" role="status">
          {{ visibleSourceError }}
        </p>
        <p
          v-if="sourceEditStatus"
          class="frontend-workshop-source-session__edit-status frontend-workshop-source-session__edit-status--global"
          role="status"
        >
          {{ sourceEditStatus }}
        </p>
      </div>
      <FrontendWorkshopGreetingStrip
        v-if="sourceDocument"
        v-model="activeGreeting"
        :source-document="sourceDocument"
        readonly
      />
      <main
        class="frontend-workshop-source-session__workspace"
        :class="{ 'has-inspector': sourceSelectionMode }"
      >
        <FrontendWorkshopSourcePreview
          v-if="sourceDocument"
          :source-document="sourceDocument"
          :network-mode="networkMode"
          :greeting-index="activeGreeting"
          @greeting-change="activeGreeting = $event"
          @runtime-error="handleRuntimeError"
          @compatibility-diagnostic="handleCompatibilityDiagnostic"
        />
        <aside
          v-if="sourceCompatibilityOpen && sourceCompatibilityReport"
          class="frontend-workshop-source-session__compatibility"
          role="dialog"
          aria-label="兼容检查"
        >
          <header>
            <div>
              <strong>兼容检查</strong>
              <small>Source revision {{ sourceCompatibilityReport.sourceRevision }}</small>
            </div>
            <button
              type="button"
              aria-label="关闭兼容检查"
              @click="sourceCompatibilityOpen = false"
            >
              ×
            </button>
          </header>
          <div class="frontend-workshop-source-session__compatibility-summary" aria-live="polite">
            <span class="is-error">{{ sourceCompatibilityReport.counts.error }} 个错误</span>
            <span class="is-warning">{{ sourceCompatibilityReport.counts.warning }} 个风险</span>
            <span>{{ sourceCompatibilityReport.counts.info }} 个提示</span>
          </div>
          <div class="frontend-workshop-source-session__compatibility-list">
            <p v-if="!sourceCompatibilityReport.findings.length" class="is-empty">
              当前已收集范围内没有发现兼容风险。
            </p>
            <article
              v-for="finding in sourceCompatibilityReport.findings"
              :key="finding.id"
              :class="`is-${finding.severity}`"
            >
              <header>
                <span>{{ SOURCE_COMPATIBILITY_CATEGORY_LABELS[finding.category] }}</span>
                <small v-if="finding.sourceRange">
                  Source {{ finding.sourceRange.start }}–{{ finding.sourceRange.end }}
                </small>
              </header>
              <strong>{{ finding.title }}</strong>
              <p>{{ finding.message }}</p>
            </article>
          </div>
          <footer>
            <small v-if="!sourceRuntimeErrors.length">先在预览中复现运行错误后再修复</small>
            <button
              type="button"
              class="button button--primary"
              :disabled="!sourceRuntimeErrors.length"
              @click="requestSourceRuntimeFix"
            >
              AI 修复
            </button>
          </footer>
        </aside>
      </main>
    </section>
    <FrontendWorkshopSourceComponentLibrary
      v-if="sourceDocument && sourceComponentLibraryOpen"
      ref="sourceComponentLibrary"
      :source-document="sourceDocument"
      :network-mode="networkMode"
      @close="sourceComponentLibraryOpen = false"
      @quick-use="quickUseSourceComponent"
      @revision-accepted="acceptSourceComponentRevision"
      @status="sourceEditStatus = $event"
    />
  </Teleport>
</template>

<style scoped src="../styles/FrontendWorkshopSourceSession.css"></style>
