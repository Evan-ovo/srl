<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { resourceAttachmentService } from '../core/AppContainer'
import { createAsyncPanel } from '../core/AsyncPanel'
import type { Resource, ResourceSummary } from '../types/Resource'
import '../styles/ResourceAttachments.css'

const props = defineProps<{ resource: Resource; disabled?: boolean }>()
const emit = defineEmits<{ changed: [ids: string[]] }>()
const ResourceAttachmentPanel = createAsyncPanel(
  '资源附件',
  () => import('./ResourceAttachmentPanel.vue'),
  { modal: true },
)
const items = ref<ResourceSummary[]>([])
const opened = defineModel<boolean>('open', { default: false })
const loading = ref(false)
const error = ref('')
const panel = ref<{ requestBack: () => Promise<void> }>()
let generation = 0
async function load() {
  const token = ++generation
  loading.value = true
  error.value = ''
  try {
    const rows = await resourceAttachmentService.list(props.resource.id)
    if (token === generation) items.value = rows
  } catch (cause) {
    if (token === generation) error.value = cause instanceof Error ? cause.message : '附件读取失败'
  } finally {
    if (token === generation) loading.value = false
  }
}
function changed(rows: ResourceSummary[], ids: string[]) {
  items.value = rows
  emit('changed', ids)
}
watch(
  () => props.resource.id,
  () => {
    opened.value = false
    void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
})
function requestBack() {
  if (panel.value?.requestBack) return panel.value.requestBack()
  opened.value = false
}
defineExpose({ open: opened, requestBack })
</script>

<template>
  <div class="resource-attachment-entry">
    <span class="field__label">附件</span>
    <div class="resource-attachment-entry__trailing">
      <span class="resource-attachment-entry__count" aria-live="polite">
        {{ loading ? '…' : error ? '读取失败' : items.length }}
      </span>
      <button
        class="feature-header-action feature-header-action--icon"
        type="button"
        :disabled="disabled || loading"
        :title="error || '查看附件列表'"
        :aria-label="error ? '重新读取附件' : '查看附件列表'"
        @click="error ? load() : (opened = true)"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="m9 5 7 7-7 7"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  </div>
  <ResourceAttachmentPanel
    v-if="opened"
    ref="panel"
    :resource="resource"
    :initial-items="items"
    @close="opened = false"
    @changed="changed"
  />
</template>
