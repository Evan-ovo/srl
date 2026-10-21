<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  buildRichContentPreview,
  buildArchivedChatFrontendDocument,
} from '../utils/RichContentPreview'
import { formatSillyTavernMessage } from '../utils/SillyTavernMessageFormatter'
import {
  OPAQUE_PREVIEW_DOCUMENT_URL,
  seedOpaquePreviewDocument,
} from '../utils/OpaquePreviewDocument'
import { loadPreviewVendorLibsForSource } from '../utils/PreviewVendorLibs'

const props = defineProps<{
  source: string
  title: string
  remote: boolean
  snapshot: import('../utils/RenderCompatibilityRuntime').ArchivedMessageSnapshot
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const scripts = ref(false)
const toolsOpen = ref(false)
const blockIndex = ref(0)
const formatted = computed(() =>
  formatSillyTavernMessage(props.source, { allowExternalMedia: props.remote }),
)
const documentSource = ref('')
const error = ref('')
let generation = 0
async function render() {
  const current = ++generation
  documentSource.value = ''
  error.value = ''
  try {
    const vendorLibs = scripts.value
      ? await loadPreviewVendorLibsForSource(props.source)
      : undefined
    if (generation !== current) return
    const frontend = formatted.value.frontendBlocks[blockIndex.value]
    if (frontend !== undefined) {
      documentSource.value = buildArchivedChatFrontendDocument(
        frontend,
        { allowScripts: scripts.value, allowRemoteResources: props.remote },
        vendorLibs,
        props.snapshot,
      )
      return
    }
    documentSource.value = buildRichContentPreview(
      props.source,
      props.title,
      { allowScripts: scripts.value, allowRemoteResources: props.remote },
      [],
      {
        renderShell: 'content',
        vendorLibs,
        preparedMessage: {
          source: props.source,
          previewSource: props.source,
          substitutedSource: props.source,
          formatted: formatted.value,
        },
        // A historical floor is not message zero / a greeting swipe. No fictitious host chat state.
        previewSessionContext: {},
      },
    ).document
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '预览失败'
  }
}
onBeforeUnmount(() => {
  generation++
})
watch([scripts, blockIndex], () => void render())
onMounted(() => {
  dialog.value?.showModal()
  void render()
})
</script>
<template>
  <dialog
    ref="dialog"
    class="chat-reader-preview"
    :aria-label="title"
    @cancel.prevent="emit('close')"
  >
    <p v-if="error" class="preview-message" role="alert">{{ error }}</p>
    <iframe
      v-else-if="documentSource"
      :key="generation"
      :src="OPAQUE_PREVIEW_DOCUMENT_URL"
      @load="seedOpaquePreviewDocument($event.target as HTMLIFrameElement, documentSource)"
      sandbox="allow-scripts allow-same-origin"
      :title="title"
    />
    <p v-else class="preview-message">正在加载预览…</p>
    <button
      v-if="toolsOpen"
      class="preview-scrim"
      aria-label="收起预览设置"
      @click="toolsOpen = false"
    />
    <section v-if="toolsOpen" id="preview-settings" class="preview-settings" aria-label="预览设置">
      <header>
        <strong>{{ title }}</strong
        ><span>完整预览</span>
      </header>
      <label v-if="formatted.frontendBlocks.length > 1" class="preview-setting">
        <span>切换状态栏</span>
        <select v-model="blockIndex" aria-label="选择状态栏">
          <option v-for="(_, index) in formatted.frontendBlocks" :key="index" :value="index">
            状态栏 {{ index + 1 }}
          </option>
        </select>
      </label>
      <label class="preview-setting"
        ><span>启用此楼交互脚本</span><input v-model="scripts" type="checkbox"
      /></label>
      <p>脚本仅在当前预览中运行。可读取此楼已保存的变量快照；不重放变量更新，也不写回酒馆。</p>
      <p v-if="!remote">远程图片已关闭，可在阅读设置中开启。</p>
    </section>
    <nav class="preview-tools" aria-label="状态栏工具">
      <button type="button" aria-label="返回阅读" title="返回阅读" @click="emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg>
      </button>
      <button
        type="button"
        aria-label="预览设置"
        title="预览设置"
        :aria-expanded="toolsOpen"
        aria-controls="preview-settings"
        @click="toolsOpen = !toolsOpen"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>
      </button>
    </nav>
  </dialog>
</template>
<style scoped>
.chat-reader-preview {
  position: fixed;
  inset: var(--visual-viewport-offset-top, 0px) 0 auto;
  width: 100vw;
  max-width: none;
  height: var(--app-viewport-height, 100dvh);
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: var(--panel-bg, #f6f3ec);
  color: var(--text-color, #303a32);
  overflow: hidden;
}
.preview-tools {
  position: absolute;
  bottom: calc(18px + var(--safe-bottom, 0px));
  right: calc(18px + var(--safe-right, 0px));
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid color-mix(in srgb, var(--text-color, #303a32) 12%, transparent);
  border-radius: 28px;
  background: color-mix(in srgb, var(--panel-bg, #f6f3ec) 82%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.preview-tools button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  display: grid;
  place-items: center;
}
.preview-tools button[aria-expanded='true'] {
  background: var(--hover-bg, #e8ebdf);
}
svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.preview-scrim {
  position: absolute;
  inset: 0;
  border: 0;
  background: #0002;
}
.preview-settings {
  position: absolute;
  bottom: calc(80px + var(--safe-bottom, 0px));
  right: calc(18px + var(--safe-right, 0px));
  width: min(340px, calc(100% - 36px));
  max-height: calc(var(--app-viewport-height, 100dvh) - 120px);
  overflow-y: auto;
  padding: 20px;
  border-radius: 20px;
  background: var(--panel-bg, #f6f3ec);
  box-shadow: 0 12px 40px #0002;
}
.preview-settings header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.preview-settings header span,
.preview-settings p {
  font-size: 12px;
  opacity: 0.65;
}
.preview-settings p {
  line-height: 1.7;
  margin: 12px 0 0;
}
.preview-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 52px;
  font-size: 14px;
}
.preview-setting select {
  max-width: 55%;
  padding: 8px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--border-color, #dddfd3);
  border-radius: 8px;
}
.preview-setting input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent-color, #586c4e);
}
.preview-message {
  padding: 24px;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent-color, #586c4e);
  outline-offset: 2px;
}
iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
</style>
