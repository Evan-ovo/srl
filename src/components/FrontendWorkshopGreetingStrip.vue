<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import { readFrontendWorkshopCharacterData } from '../utils/FrontendWorkshopSourceDelivery'
import { createFrontendWorkshopGreetingPatch } from '../utils/FrontendWorkshopSourceGreetings'
import { frontendWorkshopSourceHistoryService } from '../core/FrontendWorkshopContainer'

const props = defineProps<{
  sourceDocument: FrontendWorkshopSourceDocument
  modelValue: number
  readonly?: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [index: number]
  revisionAccepted: [source: FrontendWorkshopSourceDocument, message: string]
  busyChange: [busy: boolean]
}>()
const greetings = computed(() => {
  try {
    return (readFrontendWorkshopCharacterData(props.sourceDocument.authorSource)
      ?.alternate_greetings ?? []) as string[]
  } catch {
    return []
  }
})
const drafts = ref<Record<number, string>>({})
const baseline = ref(props.sourceDocument)
const error = ref('')
const saving = ref(false)
const edited = computed(() =>
  Object.keys(drafts.value).some(
    (key) => drafts.value[Number(key)] !== greetings.value[Number(key) - 1],
  ),
)
watch(
  () => props.sourceDocument,
  (source) => {
    if (!edited.value) {
      baseline.value = source
      drafts.value = {}
    }
    if (props.modelValue > greetings.value.length) emit('update:modelValue', 0)
  },
)
const draft = computed({
  get: () => drafts.value[props.modelValue] ?? greetings.value[props.modelValue - 1] ?? '',
  set: (value) => {
    drafts.value[props.modelValue] = value
  },
})
function discardDrafts() {
  drafts.value = {}
  baseline.value = props.sourceDocument
  error.value = ''
}
async function save() {
  if (saving.value || props.busy) return
  saving.value = true
  emit('busyChange', true)
  error.value = ''
  try {
    if (
      baseline.value.revision !== props.sourceDocument.revision ||
      baseline.value.projectId !== props.sourceDocument.projectId
    )
      throw new Error('作品已在别处更新。正文草稿已保留，请复制后重新载入，避免覆盖其他修改。')
    const edits = Object.entries(drafts.value)
      .filter(([key, text]) => text !== greetings.value[Number(key) - 1])
      .flatMap(
        ([key, text]) =>
          createFrontendWorkshopGreetingPatch(baseline.value, Number(key), text).edits,
      )
    if (!edits.length) return
    const result = await frontendWorkshopSourceHistoryService.applyAndRecord(
      { projectId: baseline.value.projectId, sourceRevision: baseline.value.revision, edits },
      { label: '修改备用开场白' },
    )
    drafts.value = {}
    baseline.value = result.document
    emit('revisionAccepted', result.document, '备用开场白已保存；可撤销')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '开场白保存失败'
  } finally {
    saving.value = false
    emit('busyChange', false)
  }
}
</script>

<template>
  <section v-if="greetings.length" class="fw-greeting-strip" data-srl-controls>
    <nav aria-label="开场白列表">
      <button
        v-for="(_, index) in greetings.length + 1"
        :key="index"
        type="button"
        :aria-pressed="modelValue === index"
        :disabled="saving"
        @click="emit('update:modelValue', index)"
      >
        {{ index === 0 ? '主开场白' : `备用 ${index}`
        }}{{
          drafts[index] !== undefined && drafts[index] !== greetings[index - 1] ? ' · 未保存' : ''
        }}
      </button>
    </nav>
    <details v-if="modelValue > 0 && !readonly" :key="modelValue" class="fw-greeting-strip__fold">
      <summary>编辑备用 {{ modelValue }} 正文{{ edited ? ' · 有未保存草稿' : '' }}</summary>
      <div class="fw-greeting-strip__editor">
        <label :for="`greeting-${sourceDocument.projectId}`">备用 {{ modelValue }} 正文</label>
        <textarea
          :id="`greeting-${sourceDocument.projectId}`"
          v-model="draft"
          rows="4"
          :disabled="busy || saving"
          placeholder="填写正文，也可以粘贴 HTML 或酒馆前端代码"
        ></textarea>
        <div>
          <small>保存后更新下方预览和导出的备用开场白。</small>
          <button type="button" :disabled="!edited || busy || saving" @click="save">
            {{ saving ? '保存中…' : '保存开场白' }}
          </button>
          <button v-if="edited" type="button" :disabled="saving" @click="discardDrafts">
            放弃草稿
          </button>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
      </div>
    </details>
  </section>
</template>

<style scoped>
.fw-greeting-strip {
  min-width: 0;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
}
nav {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 5px 8px;
}
button {
  flex-shrink: 0;
  min-height: 32px;
  padding: 4px 10px;
}
button[aria-pressed='true'] {
  color: var(--selection-color, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
}
.fw-greeting-strip__fold {
  padding: 0 8px 4px 76px;
}
summary {
  padding: 5px 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--button-color, var(--color-ink-soft));
}
.fw-greeting-strip__editor {
  display: grid;
  gap: 6px;
  padding: 4px 0;
  max-height: 35vh;
  overflow: auto;
}
textarea {
  width: 100%;
  min-height: 72px;
  box-sizing: border-box;
  resize: vertical;
}
.fw-greeting-strip__editor > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
small {
  color: var(--color-ink-soft);
}
p {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
