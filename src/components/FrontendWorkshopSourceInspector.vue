<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceHistoryService,
  frontendWorkshopSourceComponentService,
} from '../core/FrontendWorkshopContainer'
import { FrontendWorkshopSourceRevisionConflictError } from '../services/FrontendWorkshopSourceDocumentService'
import { FrontendWorkshopSourceHistoryStaleError } from '../services/FrontendWorkshopSourceHistoryService'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import { analyzeFrontendWorkshopSource } from '../utils/FrontendWorkshopSourceAnalysis'
import type { FrontendWorkshopInspectorTab } from '../utils/FrontendWorkshopInspectorRegistry'
import type { FrontendWorkshopInspectorItem } from '../utils/FrontendWorkshopInspectorRegistry'
import {
  createFrontendWorkshopSourceCanvasGesturePatch,
  FrontendWorkshopSourceCanvasGestureUnavailableError,
  type FrontendWorkshopSourceCanvasGesture,
} from '../utils/FrontendWorkshopSourceCanvasGesture'
import { requestFrontendWorkshopSourceLocate } from '../utils/FrontendWorkshopSourceNavigation'
import type { FrontendWorkshopSourceRuntimeDomSelection } from '../utils/FrontendWorkshopSourceRuntime'
import {
  encodeFrontendWorkshopSourceAttributeValue,
  listFrontendWorkshopSourceContent,
  type FrontendWorkshopExactSourceMapEntity,
  type FrontendWorkshopResolvedSourceSelection,
} from '../utils/FrontendWorkshopSourceSelection'
import {
  formatFrontendWorkshopSourceTransformValue,
  resolveFrontendWorkshopSourceTransformTargets,
  type FrontendWorkshopSourceTransformField,
  type FrontendWorkshopSourceTransformTargets,
} from '../utils/FrontendWorkshopSourceTransform'
import FrontendWorkshopSourcePropertyInput from './FrontendWorkshopSourcePropertyInput.vue'
import {
  SOURCE_INSPECTOR_ITEMS,
  SOURCE_INSPECTOR_ADVANCED_KEYS,
} from '../utils/FrontendWorkshopSourceInspectorFields'
import { useFrontendWorkshopInspectorDrawer } from '../composables/UseFrontendWorkshopInspectorDrawer'

const props = defineProps<{
  sourceDocument: FrontendWorkshopSourceDocument
  selection?: FrontendWorkshopResolvedSourceSelection
  selections?: readonly FrontendWorkshopResolvedSourceSelection[]
  transformTargets: FrontendWorkshopSourceTransformTargets
  externalBusy?: boolean
  status?: string
}>()

const emit = defineEmits<{
  busyChange: [busy: boolean]
  componentSaved: []
  aiRequested: []
  statusDismissed: []
  revisionAccepted: [source?: FrontendWorkshopSourceDocument, message?: string]
}>()

const activeTab = ref<FrontendWorkshopInspectorTab>('content')
const drawer = ref<HTMLElement>()
const { collapsed, drawerStyle, startDrag, moveDrag, endDrag, toggleDrawer, resizeWithKeyboard } =
  useFrontendWorkshopInspectorDrawer(drawer, () => Boolean(props.selection))
const utilityPanel = ref<'code' | 'save' | ''>('')
function selectTab(tab: FrontendWorkshopInspectorTab): void {
  collapsed.value = false
  activeTab.value = tab
}
const selected = computed(() =>
  props.selections?.length ? props.selections : props.selection ? [props.selection] : [],
)
const analysis = computed(() => analyzeFrontendWorkshopSource(props.sourceDocument))
const selectedTransforms = computed(() =>
  selected.value.map((selection) =>
    resolveFrontendWorkshopSourceTransformTargets(props.sourceDocument, analysis.value, selection),
  ),
)
const isCurrent = computed(
  () =>
    selected.value.length > 0 &&
    selected.value.every(
      (selection) =>
        selection.projectId === props.sourceDocument.projectId &&
        selection.sourceRevision === props.sourceDocument.revision &&
        selection.mappingConfidence === 'exact' &&
        selection.provenanceKind === 'static-source',
    ),
)

const SOURCE_TRANSFORM_FIELD_BY_KEY: Readonly<
  Partial<Record<string, FrontendWorkshopSourceTransformField>>
> = {
  'source.positionX': 'x',
  'source.positionY': 'y',
  'source.width': 'width',
  'source.height': 'height',
  'source.rotation': 'rotation',
}
const SOURCE_TRANSFORM_HISTORY_LABEL: Readonly<
  Record<FrontendWorkshopSourceTransformField, string>
> = {
  x: '修改 X',
  y: '修改 Y',
  width: '修改宽度',
  height: '修改高度',
  rotation: '修改旋转',
}
const SOURCE_GESTURE_HISTORY_LABEL = {
  move: '移动元素',
  resize: '调整元素尺寸',
  scale: '缩放元素',
  rotate: '旋转元素',
} as const satisfies Record<FrontendWorkshopSourceCanvasGesture['mode'], string>
const SOURCE_TRANSFORM_INSPECTOR_KEYS = Object.keys(SOURCE_TRANSFORM_FIELD_BY_KEY)

const writing = ref(false)
const writeStatus = ref('')
const componentName = ref('')
const componentSaving = ref(false)
const componentStatus = ref('')
const busy = computed(() => writing.value || props.externalBusy)
const canSaveAsComponent = computed(() => {
  const selection = props.selection
  return Boolean(
    selection &&
    selection.projectId === props.sourceDocument.projectId &&
    selection.sourceRevision === props.sourceDocument.revision &&
    selection.mappingConfidence === 'exact' &&
    selection.provenanceKind === 'static-source' &&
    selection.sourceRange,
  )
})
const suggestedComponentName = computed(
  () => props.selection?.elementId || props.selection?.tagName || '我的组件',
)
const title = computed(() => {
  const selection = props.selection
  if (!selection) return '选择元素'
  const names: Record<string, string> = {
    img: '图片',
    p: '文字',
    h1: '标题',
    h2: '标题',
    h3: '标题',
    button: '按钮',
    a: '链接',
    input: '输入框',
    textarea: '输入框',
    video: '视频',
    audio: '音频',
  }
  return selected.value.length > 1
    ? `已选 ${selected.value.length} 个元素`
    : (names[selection.tagName] ?? '内容容器')
})
const hint = computed(() => {
  if (!props.selection) return '点击预览中的元素开始检查，动态节点也可以选中。'
  if (props.selection.selectionOrigin === 'source')
    return '正在编辑选定的源码元素；脚本可能在运行时改变它的显示。'
  if (!isCurrent.value)
    return '这个元素由脚本生成或暂时无法准确定位。可用 AI 修改，或查看代码详情。'
  return selected.value.length > 1
    ? `只修改这 ${selected.value.length} 个元素的共同属性；不同值会标为“多个值”。`
    : '修改后自动保存，可撤销。复杂样式可通过 AI 修改或查看代码详情。'
})
const existingInteractions = computed(() => {
  const selectedRange = props.selection?.sourceRange
  if (!selectedRange || props.selection?.sourceRevision !== props.sourceDocument.revision) return []
  return analysis.value.sourceMap.entities.flatMap((entity) => {
    if (entity.semanticKind !== 'html.attribute' || entity.provenance.kind !== 'static-source')
      return []
    const range = entity.provenance.anchor.range
    if (range.start < selectedRange.start || range.end > selectedRange.end) return []
    const name = /^on[a-z]+(?=\s|=)/iu.exec(
      props.sourceDocument.authorSource.slice(range.start, range.end),
    )?.[0]
    return name ? [{ name, range }] : []
  })
})
const relatedSourceLocations = computed(() => {
  const id = props.selection?.elementId
  if (!id || props.selection?.sourceRevision !== props.sourceDocument.revision) return []
  return analysis.value.sourceMap.entities.flatMap((entity) => {
    if (entity.provenance.kind !== 'static-source' || entity.confidence !== 'exact') return []
    const range = entity.provenance.anchor.range
    const raw = props.sourceDocument.authorSource.slice(range.start, range.end).trim()
    const matches =
      entity.semanticKind === 'js.element-id-literal'
        ? raw === id
        : (entity.semanticKind === 'css.selector' ||
            entity.semanticKind === 'js.selector-literal') &&
          raw === `#${id}`
    return matches
      ? [
          {
            id: entity.id,
            range,
            label: entity.semanticKind === 'css.selector' ? 'CSS' : 'JavaScript',
          },
        ]
      : []
  })
})
function locateRelated(range: { start: number; end: number }): void {
  requestFrontendWorkshopSourceLocate({
    projectId: props.sourceDocument.projectId,
    sourceRevision: props.sourceDocument.revision,
    range,
    confidence: 'inferred',
  })
}

function targetsFor(key: string): FrontendWorkshopExactSourceMapEntity[] {
  if (!isCurrent.value) return []
  const targets = selected.value.map((selection, index) => {
    if (key === 'source.text') return selection.exactTextTarget
    if (key.startsWith('attribute.')) return selection.exactAttributeTargets?.[key.slice(10)]
    if (key.startsWith('css.'))
      return selectedTransforms.value[index]?.styles?.[key.slice(4)]?.target
    const field = SOURCE_TRANSFORM_FIELD_BY_KEY[key]
    return field ? selectedTransforms.value[index]?.fields[field]?.target : undefined
  })
  return targets.every((target) => target !== undefined) ? targets : []
}
const hiddenKeys = computed(() =>
  SOURCE_INSPECTOR_ITEMS.filter((item) => {
    if (item.key.startsWith('css.')) {
      const field =
        item.key === 'css.width' ? 'width' : item.key === 'css.height' ? 'height' : undefined
      if (field && targetsFor(`source.${field}`).length) return true
    }
    return (
      (item.key === 'source.text' ||
        item.key.startsWith('attribute.') ||
        item.key.startsWith('css.') ||
        SOURCE_TRANSFORM_INSPECTOR_KEYS.includes(item.key)) &&
      !targetsFor(item.key).length
    )
  }).map((item) => item.key),
)

const visibleItems = computed(() =>
  SOURCE_INSPECTOR_ITEMS.filter(
    (item) => item.tab === activeTab.value && !hiddenKeys.value.includes(item.key),
  ),
)
const primaryItems = computed(() =>
  visibleItems.value.filter((item) => !SOURCE_INSPECTOR_ADVANCED_KEYS.has(item.key)),
)
const advancedItems = computed(() =>
  visibleItems.value.filter((item) => SOURCE_INSPECTOR_ADVANCED_KEYS.has(item.key)),
)
const canLocate = computed(() =>
  Boolean(
    props.selection?.sourceRange &&
    props.selection.sourceRevision === props.sourceDocument.revision,
  ),
)
const contentFields = computed(() =>
  isCurrent.value && selected.value.length === 1 && props.selection
    ? listFrontendWorkshopSourceContent(props.sourceDocument, analysis.value, props.selection)
    : [],
)
function contentValue(target: FrontendWorkshopExactSourceMapEntity): string {
  const range = target.provenance.anchor.range
  const decoder = document.createElement('textarea')
  decoder.innerHTML = props.sourceDocument.authorSource.slice(range.start, range.end)
  return decoder.value
}
async function changeContent(field: (typeof contentFields.value)[number], event: Event) {
  if (busy.value || !isCurrent.value) return
  const value = (event.target as HTMLInputElement).value
  await saveExactReplacement(
    [field.target],
    (target) =>
      field.text
        ? value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        : encodeFrontendWorkshopSourceAttributeValue(props.sourceDocument, target, value),
    `修改${field.label}`,
  )
}
function mixedValue(item: FrontendWorkshopInspectorItem): boolean {
  const targets = targetsFor(item.key)
  const values = targets.map((target) =>
    props.sourceDocument.authorSource.slice(
      target.provenance.anchor.range.start,
      target.provenance.anchor.range.end,
    ),
  )
  return new Set(values).size > 1
}
function propertyValue(item: FrontendWorkshopInspectorItem): string | number {
  return mixedValue(item) ? '' : resolveValue(item)
}

watch(
  () => [props.selection?.sourceRevision, props.selection?.runtimeNodeId] as const,
  () => {
    componentName.value = ''
    componentStatus.value = ''
    writeStatus.value = ''
  },
)

watch(
  () => props.selection,
  (selection) => {
    if (selection) collapsed.value = false
  },
)

function dismissStatus(): void {
  writeStatus.value = ''
  emit('statusDismissed')
}

async function saveAsComponent(): Promise<void> {
  const selection = props.selection
  if (!selection || !canSaveAsComponent.value || componentSaving.value) return
  componentSaving.value = true
  componentStatus.value = ''
  try {
    const saved = await frontendWorkshopSourceComponentService.createFromSelection(
      props.sourceDocument,
      selection,
      { name: componentName.value.trim() || suggestedComponentName.value },
    )
    componentName.value = ''
    componentStatus.value = `“${saved.name}”已保存到组件库`
    emit('componentSaved')
  } catch (error) {
    componentStatus.value = error instanceof Error ? error.message : '保存组件失败'
  } finally {
    componentSaving.value = false
  }
}

function resolveValue(item: FrontendWorkshopInspectorItem) {
  const selection = props.selection
  if (!selection) return ''
  const targets = targetsFor(item.key)
  const target = targets.at(-1)
  if (target && !SOURCE_TRANSFORM_FIELD_BY_KEY[item.key]) {
    const range = target.provenance.anchor.range
    const raw = props.sourceDocument.authorSource.slice(range.start, range.end)
    if (item.key.startsWith('css.')) return raw
    const decoder = document.createElement('textarea')
    decoder.innerHTML = raw
    return decoder.value
  }
  const transformField = SOURCE_TRANSFORM_FIELD_BY_KEY[item.key]
  return transformField ? (props.transformTargets.fields[transformField]?.value ?? '') : ''
}

function locateSelection(): void {
  const selection = props.selection
  if (!selection?.sourceRange || selection.sourceRevision !== props.sourceDocument.revision) return
  if (selection.mappingConfidence !== 'exact' && selection.mappingConfidence !== 'inferred') return
  requestFrontendWorkshopSourceLocate({
    projectId: props.sourceDocument.projectId,
    sourceRevision: props.sourceDocument.revision,
    range: { ...selection.sourceRange },
    confidence: selection.mappingConfidence,
  })
}

async function saveExactReplacement(
  targets: FrontendWorkshopExactSourceMapEntity[],
  replacementFor: (target: FrontendWorkshopExactSourceMapEntity) => string,
  label: string,
): Promise<void> {
  const source = props.sourceDocument
  const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()]
  const edits = uniqueTargets
    .map((target) => {
      const range = target.provenance.anchor.range
      return {
        target,
        expectedText: source.authorSource.slice(range.start, range.end),
        replacement: replacementFor(target),
      }
    })
    .filter((edit) => edit.expectedText !== edit.replacement)
  if (!edits.length) {
    writeStatus.value = '没有变化'
    return
  }
  writing.value = true
  emit('busyChange', true)
  writeStatus.value = '保存中'
  try {
    const applied = await frontendWorkshopSourceHistoryService.applyAndRecord(
      {
        projectId: source.projectId,
        sourceRevision: source.revision,
        edits,
      },
      { label },
    )
    if (
      props.sourceDocument.projectId !== source.projectId ||
      props.sourceDocument.revision !== source.revision
    )
      return
    writeStatus.value = '已保存；可撤销，预览已按新 revision 重建'
    emit('revisionAccepted', applied.document, writeStatus.value)
  } catch (error) {
    if (
      error instanceof FrontendWorkshopSourceRevisionConflictError ||
      error instanceof FrontendWorkshopSourceHistoryStaleError
    ) {
      frontendWorkshopSourceHistoryService.clearProject(source.projectId)
      const latest = await frontendWorkshopSourceDocumentService.get(source.projectId)
      writeStatus.value = latest
        ? 'Source 已被更新，编辑历史已清空，请重新选择元素后再编辑'
        : 'Source 已不存在，编辑历史已清空'
      emit('revisionAccepted', latest, writeStatus.value)
    } else {
      writeStatus.value = error instanceof Error ? error.message : 'Source 写回失败'
    }
  } finally {
    writing.value = false
    emit('busyChange', false)
  }
}

async function handleChange(payload: {
  item: FrontendWorkshopInspectorItem
  value: string | number | boolean
}): Promise<void> {
  if (busy.value || !props.selection || !isCurrent.value) return
  const targets = targetsFor(payload.item.key)
  if (!targets.length) return
  const value = String(payload.value)
  if (payload.item.key.startsWith('css.')) {
    const property = payload.item.key.slice(4)
    if (!globalThis.CSS?.supports(property, value) || /[;{}<>]|!important|url\(/iu.test(value)) {
      writeStatus.value = '请输入有效的单个 CSS 属性值；复杂代码请定位源码修改'
      return
    }
    await saveExactReplacement(
      targets,
      (target) => encodeFrontendWorkshopSourceAttributeValue(props.sourceDocument, target, value),
      payload.item.label,
    )
  } else if (payload.item.key.startsWith('attribute.') || payload.item.key === 'source.text') {
    await saveExactReplacement(
      targets,
      (target) => encodeFrontendWorkshopSourceAttributeValue(props.sourceDocument, target, value),
      payload.item.label,
    )
  } else {
    const field = SOURCE_TRANSFORM_FIELD_BY_KEY[payload.item.key]
    const target = field ? props.transformTargets.fields[field] : undefined
    if (!target || typeof payload.value !== 'number') return
    await saveExactReplacement(
      targets,
      () => formatFrontendWorkshopSourceTransformValue(target, Number(payload.value)),
      SOURCE_TRANSFORM_HISTORY_LABEL[field!],
    )
  }
}

async function applyCanvasGesture(payload: {
  selection: FrontendWorkshopSourceRuntimeDomSelection
  gesture: FrontendWorkshopSourceCanvasGesture
}): Promise<void> {
  if (busy.value) return
  const source = props.sourceDocument
  const selection = props.selection
  if (
    !selection ||
    selection.projectId !== payload.selection.projectId ||
    selection.sourceRevision !== payload.selection.sourceRevision ||
    selection.instanceId !== payload.selection.instanceId ||
    selection.runtimeNonce !== payload.selection.runtimeNonce ||
    selection.runtimeNodeId !== payload.selection.runtimeNodeId
  ) {
    return
  }

  let patch
  try {
    patch = createFrontendWorkshopSourceCanvasGesturePatch(
      source,
      props.transformTargets,
      payload.gesture,
    )
  } catch (error) {
    writeStatus.value = error instanceof Error ? error.message : '当前元素不能安全执行这个手势'
    return
  }
  if (!patch) {
    writeStatus.value = '手势没有产生变化'
    return
  }

  writing.value = true
  emit('busyChange', true)
  writeStatus.value = '手势保存中'
  try {
    const label = SOURCE_GESTURE_HISTORY_LABEL[payload.gesture.mode]
    const applied = await frontendWorkshopSourceHistoryService.applyAndRecord(patch, { label })
    if (
      props.sourceDocument.projectId !== source.projectId ||
      props.sourceDocument.revision !== source.revision
    )
      return
    writeStatus.value = `${label}已保存；可撤销，预览已按新 revision 重建`
    emit('revisionAccepted', applied.document, writeStatus.value)
  } catch (error) {
    if (
      error instanceof FrontendWorkshopSourceRevisionConflictError ||
      error instanceof FrontendWorkshopSourceHistoryStaleError
    ) {
      frontendWorkshopSourceHistoryService.clearProject(source.projectId)
      const latest = await frontendWorkshopSourceDocumentService.get(source.projectId)
      writeStatus.value = latest
        ? 'Source 已被更新，编辑历史已清空，请重新选择元素后再编辑'
        : 'Source 已不存在，编辑历史已清空'
      emit('revisionAccepted', latest, writeStatus.value)
    } else if (error instanceof FrontendWorkshopSourceCanvasGestureUnavailableError) {
      writeStatus.value = error.message
    } else {
      writeStatus.value = error instanceof Error ? error.message : 'Source 手势写回失败'
    }
  } finally {
    writing.value = false
    emit('busyChange', false)
  }
}

defineExpose({ applyCanvasGesture })
</script>

<template>
  <aside
    ref="drawer"
    class="frontend-workshop-source-inspector"
    :class="{ 'is-empty': !selection, 'is-collapsed': collapsed }"
    :style="drawerStyle"
    aria-label="元素属性"
  >
    <button
      type="button"
      class="source-inspector-handle"
      :aria-label="collapsed ? '展开属性面板' : '收起属性面板'"
      :aria-expanded="!collapsed"
      aria-controls="source-inspector-body"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @lostpointercapture="endDrag"
      @click="toggleDrawer"
      @keydown="resizeWithKeyboard"
    >
      <span class="source-inspector-handle__grip" aria-hidden="true"></span>
      <template v-if="!collapsed">
        <span>{{ title }}</span>
        <small>拖动调大小 · 点按收起</small>
      </template>
    </button>
    <div
      v-show="!collapsed"
      id="source-inspector-body"
      class="source-inspector-body"
      data-srl-controls
    >
      <div v-if="status || writeStatus" class="source-inspector-feedback" role="status">
        <span>{{ status || writeStatus }}</span>
        <button type="button" aria-label="关闭操作提示" @click="dismissStatus">×</button>
      </div>
      <p v-if="!selection" class="source-inspector-empty">
        想手动修改：点左侧箭头“选择元素”，再点文字、图片或按钮。长按画布可拖动视角。想生成或修改整页：点“AI
        创作”。
      </p>
      <div class="source-inspector-actions">
        <button type="button" class="is-primary" :disabled="busy" @click="emit('aiRequested')">
          {{ selection ? 'AI 修改' : 'AI 创作' }}
        </button>
        <template v-if="selection">
          <button
            type="button"
            :aria-expanded="utilityPanel === 'code'"
            @click="utilityPanel = utilityPanel === 'code' ? '' : 'code'"
          >
            代码详情
          </button>
          <button
            type="button"
            :aria-expanded="utilityPanel === 'save'"
            @click="utilityPanel = utilityPanel === 'save' ? '' : 'save'"
          >
            存为组件
          </button>
        </template>
      </div>
      <template v-if="selection">
        <p class="source-inspector-hint">{{ hint }}</p>
        <section
          v-if="utilityPanel === 'code'"
          class="source-inspector-utility"
          aria-label="代码详情"
        >
          <dl>
            <dt>元素类型</dt>
            <dd>{{ selection.tagName }}</dd>
            <dt>代码标识</dt>
            <dd>{{ selection.elementId || '未设置' }}</dd>
            <dt>编辑状态</dt>
            <dd>{{ isCurrent ? '可直接修改' : '需要查看相关代码' }}</dd>
          </dl>
          <button type="button" :disabled="busy || !canLocate" @click="locateSelection">
            查看元素代码
          </button>
          <button
            v-for="location in relatedSourceLocations"
            :key="location.id"
            type="button"
            :disabled="busy"
            @click="locateRelated(location.range)"
          >
            查看{{ location.label === 'CSS' ? '样式' : '脚本' }} · 第
            {{ sourceDocument.authorSource.slice(0, location.range.start).split('\n').length }} 行
          </button>
          <p v-if="!canLocate">没有可定位的源码位置。可通过 AI 描述要修改的对象与效果。</p>
          <small>代码标识供样式和脚本引用；改名需同步更新相关代码。</small>
        </section>
        <form
          v-if="utilityPanel === 'save'"
          class="source-inspector-utility"
          @submit.prevent="saveAsComponent"
        >
          <label
            >组件名称<input
              v-model="componentName"
              aria-label="组件名称"
              :placeholder="suggestedComponentName"
              :disabled="!canSaveAsComponent || componentSaving"
          /></label>
          <p>保存选中的 HTML 片段。页面其他位置的样式和脚本不会自动收集。</p>
          <button type="submit" :disabled="!canSaveAsComponent || componentSaving">
            {{ componentSaving ? '保存中…' : '保存为组件' }}
          </button>
          <small v-if="!canSaveAsComponent">请从元素列表选择能够准确定位的源码元素。</small>
        </form>
        <nav class="source-inspector-tabs" data-srl-controls aria-label="手动属性">
          <button
            v-for="tab in [
              { id: 'content', label: '内容' },
              { id: 'appearance', label: '外观' },
              { id: 'layout', label: '布局' },
              { id: 'interaction', label: '交互' },
            ] as const"
            :key="tab.id"
            type="button"
            :data-tab="tab.id"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-pressed="activeTab === tab.id"
            @click="selectTab(tab.id)"
          >
            {{ tab.label }}
          </button>
        </nav>
        <div class="source-inspector-properties">
          <section
            v-if="activeTab === 'layout' && transformTargets.offset && selection"
            class="source-inspector-utility"
          >
            <p>拖动选框可微调位置，保留原布局与动效；也可以点按下方按钮，每次移动 10 像素。</p>
            <div class="source-inspector-actions">
              <button
                v-for="direction in [
                  { name: '向左', x: -10, y: 0 },
                  { name: '向右', x: 10, y: 0 },
                  { name: '向上', x: 0, y: -10 },
                  { name: '向下', x: 0, y: 10 },
                ]"
                :key="direction.name"
                type="button"
                :disabled="busy"
                @click="
                  applyCanvasGesture({
                    selection: { ...selection, rect: { x: 0, y: 0, width: 0, height: 0 } },
                    gesture: { mode: 'move', deltaX: direction.x, deltaY: direction.y },
                  })
                "
              >
                {{ direction.name }}
              </button>
            </div>
          </section>
          <template v-if="activeTab === 'content' && contentFields.length">
            <p class="source-inspector-hint">以下是选中区域里的内容，逐项修改会保留排版和动效。</p>
            <label
              v-for="(field, index) in contentFields"
              :key="field.target.id"
              class="source-inspector-content-field"
            >
              <span>{{ field.label }} {{ index + 1 }}</span>
              <textarea
                v-if="field.text"
                :value="contentValue(field.target)"
                :aria-label="`${field.label} ${index + 1}`"
                :disabled="busy"
                rows="2"
                @change="changeContent(field, $event)"
              />
              <input
                v-else
                :value="contentValue(field.target)"
                :aria-label="`${field.label} ${index + 1}`"
                :disabled="busy"
                @change="changeContent(field, $event)"
              />
            </label>
          </template>
          <FrontendWorkshopSourcePropertyInput
            v-for="item in primaryItems"
            :key="item.key"
            :item="item"
            :value="propertyValue(item)"
            :mixed="mixedValue(item)"
            :disabled="busy"
            @change="handleChange({ item, value: $event })"
          />
          <details v-if="advancedItems.length" :key="activeTab" class="source-inspector-advanced">
            <summary>
              更多{{
                activeTab === 'content' ? '内容' : activeTab === 'appearance' ? '文字' : '布局'
              }}设置
            </summary>
            <FrontendWorkshopSourcePropertyInput
              v-for="item in advancedItems"
              :key="item.key"
              :item="item"
              :value="propertyValue(item)"
              :mixed="mixedValue(item)"
              :disabled="busy"
              @change="handleChange({ item, value: $event })"
            />
          </details>
          <p
            v-if="
              !visibleItems.length &&
              activeTab !== 'interaction' &&
              !(activeTab === 'content' && contentFields.length) &&
              !(activeTab === 'layout' && transformTargets.offset)
            "
            class="source-inspector-empty"
          >
            这里没有可直接修改的{{
              activeTab === 'content'
                ? '文字或素材'
                : activeTab === 'appearance'
                  ? '外观属性'
                  : '布局属性'
            }}。它可能由共享样式或脚本控制，请用上方“AI 修改”或“代码详情”。
          </p>
          <section v-if="activeTab === 'interaction'" class="source-inspector-interactions">
            <p>
              {{
                existingInteractions.length
                  ? '已识别到以下事件；完整行为可能还由其他脚本控制。'
                  : '没有识别到直接写在元素上的事件，不代表没有交互。'
              }}
            </p>
            <ul v-if="existingInteractions.length">
              <li v-for="interaction in existingInteractions" :key="interaction.range.start">
                {{ interaction.name }}
              </li>
            </ul>
            <p>要改点击、动效或酒馆跳转，使用上方“AI 修改”描述效果；手动编辑请进入“代码详情”。</p>
          </section>
        </div>
        <p v-if="componentStatus" class="source-inspector-feedback" role="status">
          {{ componentStatus }}
        </p>
      </template>
    </div>
  </aside>
</template>
<style scoped src="../styles/FrontendWorkshopSourceInspector.css"></style>
