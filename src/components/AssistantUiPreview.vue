<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import CustomUiFrame from './CustomUiFrame.vue'
import type { AssistantUiPreview } from '../composables/UseAssistantUiCustomization'
import type { UiViewAction } from '../types/UiCustomization'

defineProps<{ preview: AssistantUiPreview }>()
const emit = defineEmits<{
  close: []
  ready: [id: string]
  error: [id: string, message: string]
  action: [value: UiViewAction]
}>()
const dialog = ref<HTMLDialogElement>()
let disposed = false
function closed() {
  if (!disposed) emit('close')
}
onMounted(() => {
  if (typeof dialog.value?.showModal === 'function') dialog.value.showModal()
  else dialog.value?.setAttribute('open', '')
})
onBeforeUnmount(() => {
  disposed = true
  dialog.value?.close?.()
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="assistant-ui-preview"
      data-srl-dialog
      data-ui-protected
      aria-labelledby="assistant-ui-preview-title"
      @cancel.prevent="emit('close')"
      @close="closed"
    >
      <header>
        <h2 id="assistant-ui-preview-title">{{ preview.scope.title }} · Vue 预览</h2>
        <button type="button" aria-label="关闭Vue预览" @click="emit('close')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div class="assistant-ui-preview__canvas">
        <CustomUiFrame
          :key="preview.id"
          :view="preview.view"
          :prepared="preview.prepared"
          :snapshot="preview.snapshot"
          :css="preview.css"
          :invoke="(action) => emit('action', action)"
          @ready="emit('ready', preview.id)"
          @error="(message) => emit('error', preview.id, message)"
        />
      </div>
      <footer>{{ preview.live ? '当前界面只读预览' : '示例界面预览' }} · 按钮不执行真实业务</footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.assistant-ui-preview {
  position: fixed;
  inset: var(--visual-viewport-offset-top, 0px) 0
    calc(100% - var(--visual-viewport-offset-top, 0px) - var(--app-viewport-height, 100dvh));
  margin: auto;
  padding: 0;
  width: min(34rem, calc(100vw - 1.5rem));
  max-width: calc(100vw - 1.5rem);
  max-height: calc(var(--app-viewport-height, 100dvh) - 2rem);
  border: 1px solid var(--dialog-border, var(--color-line));
  border-radius: var(--dialog-radius, var(--radius-panel));
  color: var(--color-ink);
  background: var(--dialog-background, var(--color-surface));
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
  overflow: hidden;
}
.assistant-ui-preview::backdrop {
  background: var(--overlay-background);
}
/* Native dialog is the top layer; this fallback is only for hosts without showModal. */
.assistant-ui-preview[open]:not(:modal) {
  z-index: var(--layer-ui-preview, 1260);
}
header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--color-line);
}
h2 {
  flex: 1;
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
header button {
  flex: 0 0 2.75rem;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0.5rem;
  background: transparent;
  border: 0;
  color: inherit;
}
svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
}
.assistant-ui-preview__canvas {
  height: min(34rem, calc(var(--app-viewport-height, 100dvh) - 8rem));
  min-height: min(12rem, calc(var(--app-viewport-height, 100dvh) - 8rem));
  overflow: hidden;
}
footer {
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--color-line);
  color: var(--color-ink-soft);
  font-size: 0.75rem;
}
</style>
