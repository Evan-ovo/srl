<script setup lang="ts">
import { computed, onUnmounted, ref, useTemplateRef, watch, type ShallowUnwrapRef } from 'vue'
import type { usePresetStitcherApp } from '../composables/UsePresetStitcherApp'

type ToolsModel = Pick<
  ShallowUnwrapRef<ReturnType<typeof usePresetStitcherApp>>,
  | 'canUndo'
  | 'canRedo'
  | 'checkpoint'
  | 'singleColumn'
  | 'undoWorkbench'
  | 'redoWorkbench'
  | 'saveCheckpoint'
  | 'restoreCheckpoint'
  | 'toggleSingleColumn'
  | 'mainSide'
  | 'toggleMainSide'
  | 'readingMode'
  | 'toggleReadingMode'
  | 'fullWorkspaceActive'
  | 'editor'
  | 'sourcePickerOpen'
  | 'candidateSheetOpen'
  | 'variableWriterOpen'
  | 'slotWriterOpen'
  | 'busy'
>
const props = defineProps<{ model: ToolsModel }>()
const surface = useTemplateRef<HTMLElement>('surface')
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const open = ref(false)
const blocked = computed(() =>
  Boolean(
    props.model.busy ||
    props.model.editor ||
    props.model.sourcePickerOpen ||
    props.model.candidateSheetOpen ||
    props.model.variableWriterOpen ||
    props.model.slotWriterOpen,
  ),
)
const actions = computed(() => [
  { id: 'undo', label: '撤销', disabled: !props.model.canUndo, run: props.model.undoWorkbench },
  { id: 'redo', label: '重做', disabled: !props.model.canRedo, run: props.model.redoWorkbench },
  { id: 'save', label: '保存工作台检查点', disabled: false, run: props.model.saveCheckpoint },
  {
    id: 'restore',
    label: '恢复检查点',
    disabled: !props.model.checkpoint,
    run: props.model.restoreCheckpoint,
  },
  {
    id: 'single',
    label: props.model.singleColumn ? '双列显示' : '单列显示',
    disabled: false,
    run: props.model.toggleSingleColumn,
  },
])
function close() {
  open.value = false
}
function activate(action: (typeof actions.value)[number]) {
  if (action.disabled) return
  action.run()
  close()
}
function dismissOutside(event: PointerEvent) {
  if (event.target instanceof Node && !surface.value?.contains(event.target)) close()
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return
  event.preventDefault()
  event.stopPropagation()
  close()
  trigger.value?.focus({ preventScroll: true })
}
function handleFocusout(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !surface.value?.contains(event.relatedTarget)) close()
}
watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', dismissOutside, true)
  else document.removeEventListener('pointerdown', dismissOutside, true)
})
watch(blocked, (value) => {
  if (value) close()
})
onUnmounted(() => document.removeEventListener('pointerdown', dismissOutside, true))
</script>

<template>
  <div
    ref="surface"
    class="stitch-tools"
    :class="{ 'is-compact': model.fullWorkspaceActive }"
    @keydown="handleKeydown"
    @focusout="handleFocusout"
  >
    <button
      type="button"
      class="feature-header-action feature-header-action--icon stitch__header-action stitch__focus-swap"
      :aria-label="`将主预设调到${model.mainSide === 'right' ? '左侧' : '右侧'}`"
      :title="`主预设调到${model.mainSide === 'right' ? '左侧' : '右侧'}`"
      :disabled="blocked"
      @click="model.toggleMainSide"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h12l-3-3m3 3-3 3M20 17H8l3 3m-3-3 3-3" />
      </svg>
    </button>
    <button
      v-if="!model.fullWorkspaceActive || model.readingMode"
      type="button"
      class="feature-header-action feature-header-action--icon stitch__header-action stitch__focus-exit"
      :aria-label="model.readingMode ? '退出全屏工作区' : '进入全屏工作区'"
      :aria-pressed="model.readingMode"
      :title="model.readingMode ? '退出全屏工作区' : '全屏工作区：保留全部操作'"
      :disabled="blocked"
      @click="model.toggleReadingMode"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path v-if="model.readingMode" d="M4 8h4V4m12 4h-4V4M8 20v-4H4m12 4v-4h4" />
        <path v-else d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
      </svg>
    </button>
    <button
      ref="trigger"
      type="button"
      class="feature-header-action feature-header-action--icon stitch__header-action stitch-tools__toggle"
      aria-label="工作台更多操作"
      title="更多操作"
      :aria-expanded="open"
      :disabled="blocked"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </svg>
    </button>
    <div v-if="open" class="stitch-tools__menu" role="group" aria-label="工作台历史与检查点">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="button button--quiet stitch-tools__action"
        :disabled="action.disabled"
        :aria-pressed="action.id === 'single' ? model.singleColumn : undefined"
        @click="activate(action)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.stitch-tools {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.stitch-tools .stitch__header-action {
  color: var(--button-color, var(--color-accent));
}
.stitch-tools.is-compact .feature-header-action {
  min-width: 32px;
  min-height: 32px;
  width: 32px;
  padding: 0;
}
.stitch-tools svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.stitch-tools__menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + 4px);
  right: 0;
  display: grid;
  box-sizing: border-box;
  width: 176px;
  padding: 4px;
}
.stitch-tools .stitch-tools__action {
  display: flex;
  width: 100%;
  min-height: 40px;
  justify-content: flex-start;
  text-align: left;
  padding: 6px 10px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--text-caption);
  line-height: 1.3;
  font-family: var(--font-body);
  font-weight: var(--weight-ui);
}
.stitch-tools__action:not(:disabled):hover,
.stitch-tools__action:focus-visible {
  background: color-mix(
    in srgb,
    var(--button-background, var(--color-surface-raised)) 87%,
    var(--color-accent) 13%
  );
}
</style>
