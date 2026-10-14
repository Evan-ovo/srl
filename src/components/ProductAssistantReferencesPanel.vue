<script setup lang="ts">
import { nextTick, ref, onBeforeUnmount } from 'vue'
import { resourceService } from '../core/AppContainer'
import ResourcePicker from './ResourcePicker.vue'
import {
  ProductAssistantReferenceReader,
  isAssistantReferenceResource,
  ASSISTANT_REFERENCE_TYPES,
  MAX_ASSISTANT_REFERENCE_RESOURCES,
  type AssistantReferenceResource,
  type AssistantResourceCitation,
} from '../services/ProductAssistantReferences'
import type { ResourceSummary } from '../types/Resource'
import '../styles/ProductAssistantTask.css'
const props = defineProps<{ selected: AssistantReferenceResource[]; disabled?: boolean }>()
const emit = defineEmits<{ select: [value: AssistantReferenceResource[]] }>()
const dialog = ref<HTMLDialogElement>()
const sourceDialog = ref<HTMLDialogElement>()
const rows = ref<ResourceSummary[]>([])
const ids = ref<string[]>([])
const error = ref('')
const sourceError = ref('')
const loading = ref(false)
const selectionOpen = ref(false)
const citation = ref<AssistantResourceCitation>()
const text = ref('')
const nextOffset = ref<number>()
const sourceLoading = ref(false)
let selectionRevision = 0
let sourceController: AbortController | undefined
let localReader: ProductAssistantReferenceReader | undefined
async function open() {
  if (props.disabled || loading.value) return
  const revision = ++selectionRevision
  selectionOpen.value = true
  loading.value = true
  error.value = ''
  ids.value = props.selected.map((item) => item.id)
  await nextTick()
  dialog.value?.showModal()
  try {
    const available = await resourceService.listResourceListSummaries({
      types: ASSISTANT_REFERENCE_TYPES,
    })
    if (revision === selectionRevision) rows.value = available.filter(isAssistantReferenceResource)
  } catch (cause) {
    if (revision === selectionRevision)
      error.value = cause instanceof Error ? cause.message : '资料目录读取失败'
  } finally {
    if (revision === selectionRevision) loading.value = false
  }
}
function close() {
  ++selectionRevision
  loading.value = false
  selectionOpen.value = false
  dialog.value?.close()
  rows.value = []
}
async function select(selectedIds: string[]) {
  if (props.disabled || loading.value) return
  const revision = selectionRevision
  if (selectedIds.length > MAX_ASSISTANT_REFERENCE_RESOURCES) {
    error.value = '一次最多选择20份资料'
    return
  }
  const selected: AssistantReferenceResource[] = []
  try {
    for (const id of selectedIds) {
      const summary = await resourceService.getSummary(id)
      if (revision !== selectionRevision || props.disabled) return
      if (!summary || !isAssistantReferenceResource(summary))
        throw new Error('所选资料已删除或变化，请重新选择')
      selected.push({ id: summary.id, name: summary.name, contentHash: summary.contentHash })
    }
    emit('select', selected)
    close()
  } catch (cause) {
    if (revision === selectionRevision)
      error.value = cause instanceof Error ? cause.message : '选择失败'
  }
}
function closeSource() {
  sourceController?.abort()
  localReader?.clear()
  localReader = undefined
  sourceDialog.value?.close()
  text.value = ''
  nextOffset.value = undefined
  sourceLoading.value = false
}
async function readSource(offset = 0) {
  if (!citation.value || !localReader || !sourceController || sourceLoading.value) return
  sourceLoading.value = true
  const signal = sourceController.signal
  try {
    const value = citation.value
    const result = await localReader.read(
      value.id,
      value.contentHash,
      value.locator,
      offset,
      signal,
    )
    if (signal.aborted) return
    text.value = offset ? text.value + result.citation.excerpt : result.citation.excerpt
    nextOffset.value = result.nextOffset
  } catch (cause) {
    if (!signal.aborted) sourceError.value = cause instanceof Error ? cause.message : '原文读取失败'
  } finally {
    if (!signal.aborted) sourceLoading.value = false
  }
}
async function showCitation(value: AssistantResourceCitation) {
  closeSource()
  citation.value = value
  sourceError.value = ''
  sourceController = new AbortController()
  localReader = new ProductAssistantReferenceReader(resourceService, () => [value])
  await nextTick()
  sourceDialog.value?.showModal()
  await readSource()
}
onBeforeUnmount(() => {
  close()
  closeSource()
})
defineExpose({ open, showCitation, close })
</script>
<template>
  <dialog
    ref="dialog"
    data-sensitive
    class="assistant-reference-dialog"
    aria-label="选择助手资料"
    @cancel="close"
    @click.self="close"
  >
    <header>
      <strong>选择助手资料</strong
      ><button type="button" aria-label="关闭资料选择" @click="close">×</button>
    </header>
    <p>
      仅所选资料的名称及按需检索片段会发送到当前模型，发送前沿原确认检查。取消选择不删除原资源；密钥资料不在此入口。支持文本、JSON及PNG内嵌角色卡，不执行代码。
    </p>
    <p>一次最多20份；单份文本/JSON与本轮正文缓存各约32MiB。较大资料请选取本次需要的部分。</p>
    <p v-if="loading" role="status">正在读取资源目录…</p>
    <ResourcePicker
      v-else-if="selectionOpen"
      v-model="ids"
      :resources="rows"
      title="本机资料"
      :disabled="disabled"
      @confirm="select"
      @cancel="close"
    />
    <p v-if="error" role="alert">{{ error }}</p>
  </dialog>
  <dialog
    ref="sourceDialog"
    data-sensitive
    class="assistant-reference-dialog"
    aria-label="资料原文"
    @cancel="closeSource"
    @click.self="closeSource"
  >
    <header>
      <strong>{{ citation?.name }} · 原文</strong
      ><button type="button" aria-label="关闭资料原文" @click="closeSource">×</button>
    </header>
    <p>{{ citation?.locator }} · 读取时核对引用内容版本；此查看仅在本机，不发送模型。</p>
    <p v-if="sourceError" role="alert">{{ sourceError }}</p>
    <pre v-else>{{ text }}</pre>
    <button
      v-if="nextOffset !== undefined && !sourceError"
      type="button"
      class="assistant-task-text-button"
      :disabled="sourceLoading"
      @click="readSource(nextOffset)"
    >
      继续读取此处原文
    </button>
  </dialog>
</template>
