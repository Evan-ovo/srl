<script setup lang="ts">
import type { AssistantResourceCitation } from '../services/ProductAssistantReferences'
import '../styles/ProductAssistantTask.css'
defineProps<{ citations: readonly AssistantResourceCitation[] }>()
const emit = defineEmits<{ source: [citation: AssistantResourceCitation] }>()
</script>
<template>
  <div class="assistant-resource-citations" aria-label="本机资料出处">
    <button v-if="citations.length === 1" type="button" @click="emit('source', citations[0]!)">
      查看来源<span aria-hidden="true">↗</span>
    </button>
    <details v-else-if="citations.length > 1">
      <summary>
        查看来源<span class="assistant-source-count">{{ citations.length }}</span>
      </summary>
      <div class="assistant-source-list">
        <button
          v-for="(citation, index) in citations"
          :key="index"
          type="button"
          @click="emit('source', citation)"
        >
          {{ citation.name }}<span aria-hidden="true">↗</span>
        </button>
      </div>
    </details>
  </div>
</template>
