<script setup lang="ts">
import OfficialAppGate from './OfficialAppGate.vue'

defineOptions({ inheritAttrs: false })
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <OfficialAppGate app-id="assistant" app-name="蒜惹菈" v-bind="$attrs" @back="emit('back')">
    <template #task-preview><slot name="task-preview" /></template>
  </OfficialAppGate>
</template>
