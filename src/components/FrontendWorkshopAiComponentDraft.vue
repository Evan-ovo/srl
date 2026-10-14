<script setup lang="ts">
import { computed, ref } from 'vue'
import { frontendWorkshopSourceComponentService } from '../core/FrontendWorkshopContainer'
import {
  createFrontendWorkshopSourceComponent,
  type FrontendWorkshopSourceComponentDraft,
} from '../types/FrontendWorkshopSourceComponent'
import { createFrontendWorkshopSourceComponentPreviewDocument } from '../utils/FrontendWorkshopSourceComponent'
import type { FrontendWorkshopSourceRuntimeNetworkMode } from '../utils/FrontendWorkshopSourceRuntime'
import FrontendWorkshopSourcePreview from './FrontendWorkshopSourcePreview.vue'
const props = defineProps<{
  draft: FrontendWorkshopSourceComponentDraft
  generationId: string
  networkMode: FrontendWorkshopSourceRuntimeNetworkMode
  disabled?: boolean
}>()
const open = ref(false)
const name = ref(props.draft.name)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
const runtimeError = ref('')
const preview = computed(() => {
  try {
    return {
      document: createFrontendWorkshopSourceComponentPreviewDocument(
        createFrontendWorkshopSourceComponent(props.draft, `draft-${props.generationId}`, 1),
      ),
    }
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : '草稿预览无法建立' }
  }
})
async function save() {
  if (saving.value || saved.value || props.disabled || !name.value.trim()) return
  saving.value = true
  error.value = ''
  try {
    const id = `ai-extract-${props.generationId}`
    // Stable generation identity makes reopening or repeated confirmation idempotent.
    if (!(await frontendWorkshopSourceComponentService.get(id)))
      await frontendWorkshopSourceComponentService.create(
        { ...props.draft, name: name.value },
        { id },
      )
    saved.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存失败，草稿仍保留'
  } finally {
    saving.value = false
  }
}
</script>
<template>
  <details
    class="fw-ai-component-draft"
    data-srl-controls
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>组件草稿 · {{ draft.name }}</summary>
    <template v-if="open">
      <p>这是脱离原页面的独立预览。确认后保存到“我的组件”；原作品保持原样。</p>
      <p v-if="draft.description">{{ draft.description }}</p>
      <label>组件名称 <input v-model="name" :disabled="saved || saving" /></label>
      <div class="fw-ai-component-draft__preview">
        <FrontendWorkshopSourcePreview
          v-if="preview.document"
          :source-document="preview.document"
          :network-mode="networkMode"
          sizing-mode="viewport"
          :viewport-height="320"
          @runtime-error="runtimeError = $event.message"
        />
        <p v-else role="alert">{{ preview.error }}</p>
      </div>
      <p v-if="runtimeError" role="alert">预览反馈：{{ runtimeError }}</p>
      <ul v-if="draft.dependencies?.length">
        <li v-for="dependency in draft.dependencies" :key="dependency.kind + dependency.specifier">
          {{ dependency.kind === 'host-api' ? '宿主接口' : '依赖' }}：{{ dependency.specifier }}
        </li>
      </ul>
      <p v-if="error" role="alert">{{ error }}</p>
      <button
        type="button"
        :disabled="disabled || saving || saved || !name.trim() || !preview.document"
        @click="save"
      >
        {{ saved ? '已保存到组件库' : saving ? '保存中…' : '确认保存到组件库' }}
      </button>
      <small>需要调整时，直接在对话中描述；AI 会继续修改草稿。</small>
    </template>
  </details>
</template>
<style scoped>
.fw-ai-component-draft {
  border: 1px solid var(--color-line);
  border-radius: 10px;
  padding: 10px;
  min-width: 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
}
p,
small,
li {
  font-size: 12px;
  overflow-wrap: anywhere;
}
label {
  display: flex;
  gap: 8px;
  align-items: center;
}
input {
  min-width: 0;
  flex: 1;
}
button,
input {
  padding: 8px;
}
small {
  display: block;
  margin-top: 8px;
}
.fw-ai-component-draft__preview {
  height: 320px;
  overflow: auto;
  margin: 10px 0;
  border: 1px solid var(--color-line);
}
</style>
