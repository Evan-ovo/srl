<script setup lang="ts">
import { ref } from 'vue'

export type FrontendWorkshopToolRailTool = 'quick-add' | 'layers' | 'ai' | 'more'

const props = defineProps<{
  activeTool?: FrontendWorkshopToolRailTool
  hideAi?: boolean
  hideQuickAdd?: boolean
  canUndo: boolean
  canRedo: boolean
}>()

const emit = defineEmits<{
  selectTool: [tool: FrontendWorkshopToolRailTool]
  undo: []
  redo: []
  collapsedChange: [collapsed: boolean]
}>()

const collapsed = ref(false)

function setCollapsed(value: boolean): void {
  if (collapsed.value === value) return
  if (value && props.activeTool) emit('selectTool', props.activeTool)
  collapsed.value = value
  emit('collapsedChange', value)
}
</script>

<template>
  <aside
    class="frontend-workbench__tool-rail is-left"
    data-srl-controls
    :class="{ 'is-collapsed': collapsed }"
    aria-label="快捷工具"
  >
    <button
      type="button"
      class="frontend-workbench__rail-toggle"
      :aria-expanded="!collapsed"
      :aria-label="collapsed ? '展开工具栏' : '收起工具栏'"
      @click="setCollapsed(!collapsed)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
    <div v-show="!collapsed" class="frontend-workbench__rail-tools">
      <slot name="selection-tools"></slot>
      <button
        v-if="!hideQuickAdd"
        type="button"
        aria-label="快速添加"
        title="快速添加"
        :class="{ 'is-active': activeTool === 'quick-add' }"
        @click="emit('selectTool', 'quick-add')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button
        type="button"
        aria-label="打开图层"
        title="打开图层"
        :class="{ 'is-active': activeTool === 'layers' }"
        @click="emit('selectTool', 'layers')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
        </svg>
      </button>
      <button
        v-if="!hideAi"
        type="button"
        aria-label="打开肘肘更健康"
        title="肘肘更健康"
        :class="{ 'is-active': activeTool === 'ai' }"
        @click="emit('selectTool', 'ai')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 8.5a4 4 0 0 1 8 0v1h1.5A2.5 2.5 0 0 1 20 12v5.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5V12a2.5 2.5 0 0 1 2.5-2.5H8v-1Z"
          />
          <circle cx="9" cy="14.5" r="1" />
          <circle cx="15" cy="14.5" r="1" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="撤销"
        title="撤销"
        :disabled="!canUndo"
        @click="emit('undo')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 7-5 5 5 5M5 12h8a6 6 0 0 1 6 6" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="重做"
        title="重做"
        :disabled="!canRedo"
        @click="emit('redo')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 7 5 5-5 5m4-5h-8a6 6 0 0 0-6 6" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="更多工具"
        title="更多工具"
        :class="{ 'is-active': activeTool === 'more' }"
        @click="emit('selectTool', 'more')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
    <slot v-if="!collapsed"></slot>
  </aside>
</template>

<style src="../styles/FrontendWorkshopToolRail.css"></style>
