<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import CharacterCardContentWorkbench from './CharacterCardContentWorkbench.vue'
import { resourceService } from '../core/AppContainer'
import type { Resource } from '../types/Resource'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import { createStructuredContentDraft } from '../utils/StructuredResourceContent'

const props = defineProps<{ resource: Resource; content: unknown; disabled?: boolean }>()
const emit = defineEmits<{
  saved: [resource: Resource]
  'draft-change': [dirty: boolean]
  'workbench-open': [open: boolean]
  busy: [busy: boolean]
}>()
const draft = computed(() => {
  try {
    return { value: createStructuredContentDraft(props.content, props.resource.type), error: '' }
  } catch (reason) {
    return {
      value: undefined,
      error: reason instanceof Error ? reason.message : '无法编辑此文件。',
    }
  }
})
const edits = ref<CharacterCardContentEdit[]>([])
const editorDirty = ref(false)
const open = ref(false)
const saving = ref(false)
const error = ref('')
const scope = ref('global')
const workbench = ref<{ prepareSave: () => Promise<boolean> }>()
const dirty = computed(() => editorDirty.value || edits.value.length > 0)
watch(dirty, (value) => emit('draft-change', value), { flush: 'sync' })
watch(open, (value) => emit('workbench-open', value), { flush: 'sync' })
async function prepareSave(): Promise<boolean> {
  if (saving.value || props.disabled) return false
  if (workbench.value && !(await workbench.value.prepareSave())) return false
  await nextTick()
  if (!edits.value.length) return true
  saving.value = true
  emit('busy', true)
  error.value = ''
  try {
    const saved = await resourceService.saveStructuredContent(
      props.resource.id,
      props.resource.contentHash,
      edits.value,
      scope.value,
    )
    edits.value = []
    editorDirty.value = false
    open.value = false
    emit('saved', saved)
    return true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '内容保存失败，请保留草稿后重试。'
    return false
  } finally {
    saving.value = false
    emit('busy', false)
  }
}
defineExpose({ prepareSave })
</script>

<template>
  <p v-if="error" role="alert">{{ error }}</p>
  <template v-if="open && draft.value">
    <p class="structured-content-editor__note">保存修改会生成新版本，原文件可在“版本”中恢复。</p>
    <label v-if="draft.value.grouped" class="structured-content-editor__scope">
      新增规则作用域
      <select v-model="scope" :disabled="disabled || saving">
        <option value="global">全局</option>
        <option value="scoped">角色</option>
        <option value="preset">预设</option>
      </select>
    </label>
    <CharacterCardContentWorkbench
      ref="workbench"
      v-model:edits="edits"
      :card="draft.value.card"
      :standalone-section="draft.value.section"
      :disabled="disabled || saving"
      @draft-change="editorDirty = $event"
      @back="open = false"
    />
  </template>
  <template v-else>
    <div class="structured-content-editor__toolbar">
      <button
        type="button"
        class="button button--quiet"
        :disabled="disabled || saving || !draft.value"
        @click="open = true"
      >
        {{ dirty ? '继续编辑内容' : '编辑内容' }}
      </button>
      <small v-if="dirty">有未保存修改</small>
    </div>
    <p v-if="content !== undefined && draft.error" role="status">{{ draft.error }}</p>
    <slot />
  </template>
</template>

<style scoped>
.structured-content-editor__note {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--color-ink-soft);
}
.structured-content-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.structured-content-editor__toolbar button {
  min-height: 32px;
  padding: 4px 10px;
  font-size: 14px;
}
.structured-content-editor__toolbar small {
  color: var(--color-ink-soft);
}
.structured-content-editor__scope {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 13px;
}
.structured-content-editor__scope select {
  min-height: 32px;
  font-size: 16px;
}
</style>
