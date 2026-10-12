<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FrontendWorkshopInspectorItem } from '../utils/FrontendWorkshopInspectorRegistry'
import { SOURCE_INSPECTOR_CHOICES } from '../utils/FrontendWorkshopSourceInspectorFields'
const props = defineProps<{
  item: FrontendWorkshopInspectorItem
  value: string | number
  mixed?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ change: [value: string | number] }>()
const draft = ref(String(props.value))
watch(
  () => props.value,
  (value) => {
    draft.value = String(value)
  },
)
const options = computed(() => SOURCE_INSPECTOR_CHOICES[props.item.key] ?? [])
const isCustom = ref(false)
const isColor = computed(() => ['css.color', 'css.background-color'].includes(props.item.key))
const colorValue = computed(() =>
  /^#[\da-f]{6}$/i.test(draft.value)
    ? draft.value
    : /^#[\da-f]{3}$/i.test(draft.value)
      ? '#' +
        draft.value
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : '#000000',
)
const opacity = computed(() => props.item.key === 'css.opacity')
const percent = computed(() => {
  const raw = draft.value.trim()
  if (!/^(?:\d*\.)?\d+%?$/.test(raw)) return undefined
  const n = raw.endsWith('%') ? Number(raw.slice(0, -1)) : Number(raw) * 100
  return Math.max(0, Math.min(100, Math.round(n)))
})
const customChoice = computed(
  () => draft.value && !options.value.some(([value]) => value === draft.value),
)
function commit(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (props.item.control === 'number') {
    if (value.trim() && Number.isFinite(Number(value))) emit('change', Number(value))
  } else emit('change', value)
}
function choose(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === '__custom__') isCustom.value = true
  else {
    isCustom.value = false
    emit('change', value)
  }
}
function commitOpacity(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value.trim() && Number.isFinite(Number(value)))
    emit('change', String(Math.max(0, Math.min(100, Number(value))) / 100))
}
</script>
<template>
  <div class="source-property" :data-item-key="item.key">
    <label :for="`property-${item.key}`">{{ item.label }}<small v-if="mixed">多个值</small></label>
    <textarea
      v-if="item.control === 'textarea'"
      :id="`property-${item.key}`"
      v-model="draft"
      rows="4"
      :disabled="disabled"
      :placeholder="mixed ? '多个值；输入后统一修改' : ''"
      @change="commit"
    ></textarea>
    <div v-else-if="opacity && (mixed || percent !== undefined)" class="source-property__opacity">
      <input
        type="range"
        min="0"
        max="100"
        :value="percent ?? 50"
        :aria-label="`${item.label}滑杆`"
        :disabled="disabled"
        @change="commitOpacity"
      />
      <input
        :id="`property-${item.key}`"
        type="number"
        min="0"
        max="100"
        :value="mixed ? '' : percent"
        :placeholder="mixed ? '多个值' : ''"
        :disabled="disabled"
        @change="commitOpacity"
      /><span>%</span>
    </div>
    <div v-else-if="options.length" class="source-property__choice">
      <select
        :id="`property-${item.key}`"
        :value="mixed ? '' : isCustom ? '__custom__' : draft"
        :disabled="disabled"
        @change="choose"
      >
        <option v-if="mixed" value="" disabled>多个值</option>
        <option v-if="customChoice" :value="draft">{{ draft }}（当前值）</option>
        <option v-for="[optionValue, label] in options" :key="optionValue" :value="optionValue">
          {{ label }}
        </option>
        <option value="__custom__">自定义值…</option>
      </select>
      <input
        v-if="isCustom"
        v-model="draft"
        :aria-label="`${item.label}自定义值`"
        :disabled="disabled"
        @change="commit"
      />
    </div>
    <div v-else class="source-property__value" :class="{ 'has-color': isColor }">
      <input
        :id="`property-${item.key}`"
        v-model="draft"
        :type="item.control === 'number' ? 'number' : 'text'"
        :step="item.control === 'number' ? 'any' : undefined"
        :placeholder="mixed ? '多个值；输入后统一修改' : ''"
        :disabled="disabled"
        @change="commit"
      />
      <input
        v-if="isColor"
        type="color"
        :value="colorValue"
        :aria-label="`${item.label}选色`"
        :disabled="disabled"
        @change="commit"
      />
    </div>
  </div>
</template>
<style scoped>
.source-property {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 10px 0;
}
.source-property label {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--text-caption);
  color: var(--color-ink-soft);
}
.source-property small {
  color: var(--color-accent);
}
.source-property input,
.source-property select,
.source-property textarea {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  min-height: 40px;
  padding: 8px;
  font: inherit;
}
.source-property textarea {
  resize: vertical;
}
.source-property__value.has-color {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  gap: 8px;
}
.source-property input[type='color'] {
  padding: 4px;
  cursor: pointer;
}
.source-property__opacity {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 68px auto;
  gap: 8px;
  align-items: center;
}
.source-property input[type='range'] {
  padding: 0;
  accent-color: var(--color-accent);
  border: 0;
}
.source-property__choice {
  display: grid;
  gap: 6px;
}
</style>
