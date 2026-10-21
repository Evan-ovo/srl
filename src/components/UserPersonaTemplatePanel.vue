<script setup lang="ts">
import type { UserPersonaTemplate } from '../types/UserPersona'

defineProps<{
  builtinTemplates: UserPersonaTemplate[]
  customTemplates: UserPersonaTemplate[]
  canDelete: boolean
  targetLabel: string
}>()
const selectedTemplateId = defineModel<string>('selectedTemplateId', { required: true })
const creating = defineModel<boolean>('creating', { required: true })
const templateName = defineModel<string>('templateName', { required: true })
const emit = defineEmits<{ apply: []; save: []; delete: [] }>()
function saveOnEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  event.preventDefault()
  emit('save')
}
</script>

<template>
  <div id="persona-templates" class="persona-app__templates">
    <small>填入：{{ targetLabel }} · 其他内容保持不变</small>
    <div class="persona-app__toolbar">
      <select v-model="selectedTemplateId" aria-label="人物模板">
        <optgroup label="内置模板">
          <option v-for="template in builtinTemplates" :key="template.id" :value="template.id">
            {{ template.name }}
          </option>
        </optgroup>
        <optgroup v-if="customTemplates.length" label="我的模板">
          <option v-for="template in customTemplates" :key="template.id" :value="template.id">
            {{ template.name }}
          </option>
        </optgroup>
      </select>
      <button class="button button--quiet" type="button" @click="emit('apply')">应用模板</button>
    </div>
    <div class="persona-app__actions">
      <button class="button button--quiet" type="button" @click="creating = !creating">
        存为模板
      </button>
      <button v-if="canDelete" class="button button--quiet" type="button" @click="emit('delete')">
        删除模板
      </button>
    </div>
    <div v-if="creating" class="persona-app__toolbar">
      <input
        v-model="templateName"
        aria-label="模板名称"
        placeholder="模板名称"
        maxlength="80"
        @keydown.enter="saveOnEnter"
      />
      <button class="button button--quiet" type="button" @click="emit('save')">保存模板</button>
    </div>
  </div>
</template>
