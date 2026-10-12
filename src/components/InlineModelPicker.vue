<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import type { MainApiModelOption } from '../services/MainApiService'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: MainApiModelOption[]
    loading?: boolean
    buttonLabel?: string
  }>(),
  {
    loading: false,
    buttonLabel: '拉取模型',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  load: []
}>()

const root = ref<HTMLElement>()
const open = ref(false)
const query = ref('')

const filteredOptions = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  if (!keyword) return props.options
  return props.options.filter((option) =>
    `${option.id} ${option.name}`.toLocaleLowerCase().includes(keyword),
  )
})

watch(
  () => props.options,
  (options, previous) => {
    if (options.length && options !== previous) {
      query.value = ''
      open.value = true
    }
  },
)

function updateValue(value: string): void {
  emit('update:modelValue', value)
}

function choose(option: MainApiModelOption): void {
  updateValue(option.id)
  open.value = false
}

function requestModels(): void {
  open.value = false
  emit('load')
}

function handleOutside(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => window.addEventListener('pointerdown', handleOutside))
onUnmounted(() => window.removeEventListener('pointerdown', handleOutside))
</script>

<template>
  <div ref="root" class="inline-model-picker">
    <div class="inline-model-picker__field">
      <input
        :value="modelValue"
        autocomplete="off"
        placeholder="拉取后选择，或手动输入"
        @input="updateValue(($event.target as HTMLInputElement).value)"
        @focus="open = options.length > 0"
      />
      <button type="button" :disabled="loading" @click="requestModels">
        {{ loading ? '拉取中…' : buttonLabel }}
      </button>
      <button
        v-if="options.length"
        type="button"
        class="inline-model-picker__toggle"
        :aria-expanded="open"
        aria-label="展开模型列表"
        @click="open = !open"
      >
        {{ open ? '收起' : `选择（${options.length}）` }}
      </button>
    </div>

    <div v-if="open" class="inline-model-picker__menu">
      <label>
        <span>筛选已拉取的 {{ options.length }} 个模型</span>
        <input v-model="query" type="search" autocomplete="off" placeholder="输入名称筛选" />
      </label>
      <div role="listbox" aria-label="可用模型">
        <button
          v-for="option in filteredOptions"
          :key="option.id"
          type="button"
          role="option"
          :aria-selected="option.id === modelValue"
          :class="{ 'is-selected': option.id === modelValue }"
          @click="choose(option)"
        >
          <strong>{{ option.name || option.id }}</strong>
          <small v-if="option.name && option.name !== option.id">{{ option.id }}</small>
        </button>
        <p v-if="!filteredOptions.length">没有匹配模型，可继续手动输入。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inline-model-picker {
  position: relative;
  width: 100%;
}
.inline-model-picker__field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.4rem;
}
.inline-model-picker input {
  width: 100%;
  min-width: 0;
  min-height: var(--size-touch);
  padding: 0 0.625rem;
  font: inherit;
  font-size: 0.68rem;
}
.inline-model-picker button {
  min-height: var(--size-touch);
  padding: 0 0.65rem;
  cursor: pointer;
  white-space: nowrap;
}
.inline-model-picker button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.inline-model-picker .inline-model-picker__toggle {
  border-color: var(--button-border, var(--color-line));
  color: var(--button-color, var(--color-ink-soft));
}
.inline-model-picker__menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 0.3rem);
  right: 0;
  left: 0;
  padding: 0.55rem;
  border: 1px solid var(--dialog-border, var(--glass-border));
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
  background: var(--dialog-background);
  box-shadow: var(--dialog-shadow, var(--glass-shadow));
}
.inline-model-picker__menu label {
  display: grid;
  gap: 0.25rem;
  margin-bottom: 0.45rem;
}
.inline-model-picker__menu label span {
  color: var(--color-ink-soft);
  font-size: 0.56rem;
}
.inline-model-picker__menu label input {
  width: 100%;
}
.inline-model-picker__menu > div {
  display: grid;
  max-height: min(18rem, 45vh);
  overflow: auto;
  overscroll-behavior: contain;
}
.inline-model-picker__menu > div button {
  display: grid;
  min-height: 2.7rem;
  padding: 0.45rem 0.6rem;
  border-width: 0 0 1px;
  border-color: var(--button-border, var(--color-line));
  border-radius: var(--button-radius, 0);
  color: var(--button-color, var(--color-ink));
  text-align: left;
}
.inline-model-picker__menu > div button.is-selected {
  color: var(--selection-color, var(--color-ink));
  background: var(--selection-background, var(--color-accent-soft));
}
.inline-model-picker__menu strong,
.inline-model-picker__menu small {
  overflow: hidden;
  text-overflow: ellipsis;
}
.inline-model-picker__menu small {
  color: var(--color-ink-soft);
  font-size: 0.54rem;
}
.inline-model-picker__menu p {
  margin: 0;
  padding: 0.8rem;
  color: var(--color-ink-soft);
  font-size: 0.62rem;
  text-align: center;
}
@media (max-width: 34rem) {
  .inline-model-picker__field {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .inline-model-picker .inline-model-picker__toggle {
    grid-column: var(--button-border, var(--color-line));
    min-height: var(--button-border, var(--color-line));
  }
}
</style>
