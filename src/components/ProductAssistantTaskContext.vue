<script setup lang="ts">
import type { AssistantTaskTemplate } from '../services/ProductAssistantWorkspaceService'
import type { AssistantReferenceResource } from '../services/ProductAssistantReferences'
import '../styles/ProductAssistantTask.css'
defineProps<{
  skill?: AssistantTaskTemplate
  resources: readonly AssistantReferenceResource[]
  disabled?: boolean
}>()
const emit = defineEmits<{ select: []; clearResources: []; clearSkill: [] }>()
</script>
<template>
  <div class="assistant-task-context chat-settings-links" aria-label="本次聊天资料与技能">
    <button type="button" :disabled="disabled" aria-label="选择资料" @click="emit('select')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3h7l4 4v14H7zM14 3v5h4M10 12h5m-5 4h5" />
      </svg>
      <span>参考资料</span
      ><small class="chat-settings-value">{{
        resources.length ? `已选 ${resources.length}份` : '未选择'
      }}</small
      ><span aria-hidden="true">›</span>
    </button>
    <button
      v-if="resources.length"
      type="button"
      :disabled="disabled"
      aria-label="移除所有助手资料"
      @click="emit('clearResources')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg
      ><span>清除资料选择</span><span aria-hidden="true">›</span>
    </button>
    <button
      v-if="skill"
      type="button"
      :disabled="disabled"
      :aria-label="`退出技能 ${skill.name}`"
      @click="emit('clearSkill')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg
      ><span>退出当前技能</span><small class="chat-settings-value">{{ skill.name }}</small
      ><span aria-hidden="true">›</span>
    </button>
  </div>
</template>
