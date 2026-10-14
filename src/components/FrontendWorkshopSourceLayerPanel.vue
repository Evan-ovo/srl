<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import { frontendWorkshopSourceHistoryService } from '../core/FrontendWorkshopContainer'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import type { FrontendWorkshopResolvedSourceSelection } from '../utils/FrontendWorkshopSourceSelection'
import {
  createFrontendWorkshopLayerPatch,
  readFrontendWorkshopSourceLayers,
  type FrontendWorkshopSourceLayer,
  type FrontendWorkshopLayerView,
} from '../utils/FrontendWorkshopSourceLayers'
const props = defineProps<{
  sourceDocument: FrontendWorkshopSourceDocument
  selections: readonly FrontendWorkshopResolvedSourceSelection[]
  runtimeElements: readonly { id: string; label: string }[]
  viewState: FrontendWorkshopLayerView
  busy?: boolean
  allowRemoteResources?: boolean
}>()
const emit = defineEmits<{
  close: []
  select: [selections: FrontendWorkshopResolvedSourceSelection[]]
  runtimeSelect: [id: string]
  refresh: []
  viewChange: [view: FrontendWorkshopLayerView]
  revisionAccepted: [source: FrontendWorkshopSourceDocument, message: string]
  aiRequested: [instruction: string, selections: FrontendWorkshopResolvedSourceSelection[]]
  busyChange: [busy: boolean]
}>()
const outline = computed(() => readFrontendWorkshopSourceLayers(props.sourceDocument))
const search = ref('')
const runtime = ref(false)
const view = computed({
  get: () => props.viewState,
  set: (value: FrontendWorkshopLayerView) => emit('viewChange', value),
})
const error = ref('')
const saving = ref(false)
const newName = ref('')
const names = ref<Record<string, string>>({})
const failedImages = ref<Record<string, boolean>>({})
function canThumbnail(item: (typeof outline.value.elements)[number]) {
  return (
    item.thumbnail &&
    !failedImages.value[item.id] &&
    (props.allowRemoteResources || item.thumbnail.startsWith('data:image/'))
  )
}
function selectedElement(id: string) {
  return props.selections.some((selection) => selection.sourceEntityId === id)
}
function groupDepth(group: FrontendWorkshopSourceLayer) {
  return outline.value.groups.filter(
    (parent) =>
      parent.id !== group.id &&
      group.ranges.every((range) =>
        parent.ranges.some((outer) => outer.start < range.start && outer.end >= range.end),
      ),
  ).length
}
function groupSummary(group: FrontendWorkshopSourceLayer) {
  return (
    group.elements
      .filter((item) => !['容器', '区域', '内容组'].includes(item.kind))
      .slice(0, 3)
      .map((item) => item.label)
      .join(' / ') || `${group.elements.length} 个元素`
  )
}
const matches = (label: string) =>
  label.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())

watch(
  () => props.sourceDocument.projectId,
  () => {
    view.value = { hidden: [], locked: [] }
    names.value = {}
    error.value = ''
  },
)
watch(outline, (value) => {
  const ids = new Set(value.groups.map((group) => group.id))
  view.value = {
    hidden: view.value.hidden.filter((id) => ids.has(id)),
    locked: view.value.locked.filter((id) => ids.has(id)),
    ...(view.value.solo && ids.has(view.value.solo) ? { solo: view.value.solo } : {}),
  }
})
function createGroup() {
  void apply(props.selections, {
    kind: 'group',
    id: 'layer-' + crypto.randomUUID(),
    name: newName.value,
  })
}
function toggle(kind: 'hidden' | 'locked', id: string) {
  const values = view.value[kind]
  view.value = {
    ...view.value,
    [kind]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id],
  }
}
function isLocked(selection: FrontendWorkshopResolvedSourceSelection) {
  return outline.value.groups.some(
    (group) =>
      view.value.locked.includes(group.id) &&
      group.ranges.some(
        (range) =>
          selection.sourceRange &&
          selection.sourceRange.start >= range.start &&
          selection.sourceRange.end <= range.end,
      ),
  )
}
function groupLocked(group: FrontendWorkshopSourceLayer) {
  return group.roots.some(isLocked)
}
async function apply(
  selections: readonly FrontendWorkshopResolvedSourceSelection[],
  action: Parameters<typeof createFrontendWorkshopLayerPatch>[2],
) {
  if (saving.value || props.busy) return
  if (selections.some(isLocked)) {
    error.value = '请先解锁所在图层'
    return
  }
  saving.value = true
  emit('busyChange', true)
  error.value = ''
  try {
    const result = await frontendWorkshopSourceHistoryService.applyAndRecord(
      createFrontendWorkshopLayerPatch(props.sourceDocument, selections, action),
      { label: action.kind === 'delete' ? '删除图层内容' : '整理图层' },
    )
    emit('revisionAccepted', result.document, '图层已更新；可撤销')
    names.value = {}
    newName.value = ''
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '图层修改失败'
  } finally {
    saving.value = false
    emit('busyChange', false)
  }
}
async function remove(group: FrontendWorkshopSourceLayer) {
  if (
    await confirmAction({
      message: `删除“${group.name}”中的元素及其子内容？可撤销；共享样式和脚本保留。`,
      title: '删除图层内容',
      confirmLabel: '删除',
      danger: true,
    })
  )
    await apply(group.roots, { kind: 'delete' })
}
function requestGroupAi(group: FrontendWorkshopSourceLayer, extract = false) {
  emit('close')
  emit(
    'aiRequested',
    extract
      ? `请把 data-fw-layer="${group.id}"（${group.name}）提取为可独立使用的组件。收集必要样式、脚本和资源依赖，先给我组件草稿预览，不修改原作品。`
      : `请只修改“${group.name}”图层（data-fw-layer="${group.id}"）：`,
    extract ? [] : group.roots,
  )
}
function organize() {
  emit('close')
  emit(
    'aiRequested',
    '请按这份作品的内容和复杂度整理图层，用适量的中文分组名称。只添加或修正分组标记，保留现有布局、样式和交互。',
    [],
  )
}
</script>
<template>
  <Teleport to="body">
    <section class="fw-layer-panel" data-srl-controls role="dialog" aria-label="作品图层">
      <header>
        <strong>图层</strong
        ><button type="button" :disabled="busy || saving" @click="organize">AI 整理图层</button>
      </header>
      <input v-model="search" aria-label="搜索图层或元素" placeholder="搜索图层或元素" />
      <div v-if="selections.length" class="fw-layer-panel__row">
        <input v-model="newName" aria-label="新图层名称" placeholder="所选元素的组名" /><button
          :disabled="busy || saving || !newName.trim()"
          @click="createGroup"
        >
          建组
        </button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <details
        v-for="group in outline.groups.filter(
          (group) => matches(group.name) || group.elements.some((item) => matches(item.label)),
        )"
        :key="group.id"
        class="fw-layer-panel__group"
        :style="{ marginLeft: `${Math.min(3, groupDepth(group)) * 10}px` }"
      >
        <summary>
          <strong>{{ group.name }}</strong>
          <small class="fw-layer-panel__summary">{{ groupSummary(group) }}</small>
        </summary>
        <div class="fw-layer-panel__actions">
          <button
            :aria-label="(view.hidden.includes(group.id) ? '显示' : '隐藏') + group.name"
            :aria-pressed="view.hidden.includes(group.id)"
            @click="toggle('hidden', group.id)"
          >
            {{ view.hidden.includes(group.id) ? '显示' : '隐藏' }}
          </button>
          <button
            :aria-label="(view.locked.includes(group.id) ? '解锁' : '锁定') + group.name"
            :aria-pressed="view.locked.includes(group.id)"
            @click="toggle('locked', group.id)"
          >
            {{ view.locked.includes(group.id) ? '解锁' : '锁定' }}
          </button>
        </div>
        <details class="fw-layer-panel__more">
          <summary>更多操作</summary>
          <div class="fw-layer-panel__actions">
            <button
              :aria-label="'单独查看' + group.name"
              :aria-pressed="view.solo === group.id"
              @click="view = { ...view, solo: view.solo === group.id ? undefined : group.id }"
            >
              单独查看
            </button>
            <button
              :disabled="groupLocked(group) || busy || saving"
              @click="emit('select', group.roots)"
            >
              选择整组
            </button>
            <button :disabled="groupLocked(group) || busy || saving" @click="requestGroupAi(group)">
              AI 修改
            </button>
            <button :disabled="busy || saving" @click="requestGroupAi(group, true)">
              提取组件
            </button>
          </div>
          <div class="fw-layer-panel__row">
            <input
              :value="names[group.id] ?? group.name"
              :aria-label="'图层名称 ' + group.name"
              @input="names[group.id] = ($event.target as HTMLInputElement).value"
            /><button
              :disabled="
                !names[group.id]?.trim() ||
                names[group.id] === group.name ||
                busy ||
                saving ||
                groupLocked(group)
              "
              @click="apply(group.roots, { kind: 'group', id: group.id, name: names[group.id]! })"
            >
              改名</button
            ><button :disabled="busy || saving || groupLocked(group)" @click="remove(group)">
              删除
            </button>
          </div>
        </details>
        <button
          v-for="item in group.elements.filter(
            (item) => matches(group.name) || matches(item.label),
          )"
          :key="item.id"
          class="fw-layer-panel__element"
          :aria-pressed="selectedElement(item.id)"
          :disabled="isLocked(item.selection)"
          @click="emit('select', [item.selection])"
        >
          <img
            v-if="canThumbnail(item)"
            :src="item.thumbnail"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="failedImages[item.id] = true"
          />
          <span v-else class="fw-layer-panel__kind" aria-hidden="true">{{ item.kind }}</span>
          <span>{{ item.label }}</span>
        </button>
      </details>
      <details :open="!outline.groups.length">
        <summary>未分组元素 · {{ outline.ungrouped.length }}</summary>
        <p v-if="!outline.groups.length">作品还没有图层标记，可以让 AI 整理；不影响正常显示。</p>
        <button
          v-for="item in outline.ungrouped.filter((item) => matches(item.label))"
          :key="item.id"
          class="fw-layer-panel__element"
          :aria-pressed="selectedElement(item.id)"
          @click="emit('select', [item.selection])"
        >
          <img
            v-if="canThumbnail(item)"
            :src="item.thumbnail"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="failedImages[item.id] = true"
          />
          <span v-else class="fw-layer-panel__kind" aria-hidden="true">{{ item.kind }}</span>
          <span>{{ item.label }}</span>
        </button>
      </details>
      <details @toggle="runtime = ($event.target as HTMLDetailsElement).open">
        <summary>动态元素</summary>
        <template v-if="runtime"
          ><button @click="emit('refresh')">更新元素列表</button
          ><button
            v-for="item in runtimeElements.filter((item) => matches(item.label))"
            :key="item.id"
            class="fw-layer-panel__element"
            @click="emit('runtimeSelect', item.id)"
          >
            {{ item.label }}
          </button></template
        >
      </details>
      <button
        v-if="view.hidden.length || view.locked.length || view.solo"
        @click="view = { hidden: [], locked: [] }"
      >
        恢复全部查看与选择
      </button>
    </section>
  </Teleport>
</template>
<style scoped>
.fw-layer-panel {
  position: fixed;
  z-index: 1300;
  left: calc(var(--safe-left, 0px) + 62px);
  top: calc(var(--safe-top, 0px) + 76px);
  width: min(340px, calc(100vw - var(--safe-left, 0px) - var(--safe-right, 0px) - 78px));
  max-height: calc(
    var(--visual-viewport-height, 100dvh) - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 92px
  );
  overflow: auto;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  box-shadow: var(--glass-shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  color: var(--color-ink);
}
header,
.fw-layer-panel__row,
.fw-layer-panel__actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
header {
  justify-content: space-between;
}
p,
small {
  font-size: 12px;
  color: var(--color-ink-soft);
}
p {
  margin: 0;
}
summary {
  padding: 8px 0;
  cursor: pointer;
  overflow-wrap: anywhere;
}
details {
  border-top: 1px solid var(--color-line);
}
button,
input {
  min-height: 36px;
  padding: 6px;
}
input {
  min-width: 0;
  max-width: 100%;
}
.fw-layer-panel__row input {
  flex: 1;
}
button[aria-pressed='true'] {
  color: var(--selection-color, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
}
.fw-layer-panel__element {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  overflow-wrap: anywhere;
  margin: 4px 0;
}
.fw-layer-panel__element img,
.fw-layer-panel__kind {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  object-fit: cover;
  border-radius: 5px;
  background: var(--color-accent-soft);
}
.fw-layer-panel__kind {
  display: grid;
  place-items: center;
  font-size: 12px;
}
.fw-layer-panel__summary {
  display: block;
  margin: 4px 0 0 16px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.fw-layer-panel__more {
  border: 0;
}
.fw-layer-panel__row {
  margin: 8px 0;
}
@media (pointer: coarse) {
  button,
  input,
  summary {
    min-height: 44px;
  }
}
</style>
