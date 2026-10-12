<script setup lang="ts">
import { computed } from 'vue'

export interface StorageUsageSlice {
  id: string
  label: string
  bytes: number
  color: string
}
const props = defineProps<{ slices: StorageUsageSlice[]; totalLabel: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const total = computed(() => props.slices.reduce((sum, slice) => sum + slice.bytes, 0))
const parts = computed(() => {
  let angle = -Math.PI / 2
  return props.slices
    .filter((slice) => slice.bytes > 0)
    .map((slice) => {
      const portion = slice.bytes / total.value
      const end = angle + portion * Math.PI * 2
      const point = (a: number) => `${80 + 70 * Math.cos(a)} ${80 + 70 * Math.sin(a)}`
      const d =
        portion >= 1
          ? 'M 80 10 A 70 70 0 1 1 80 150 A 70 70 0 1 1 80 10 Z'
          : `M 80 80 L ${point(angle)} A 70 70 0 ${portion > 0.5 ? 1 : 0} 1 ${point(end)} Z`
      angle = end
      const percent = portion * 100
      const size =
        slice.bytes >= 1024 ** 3
          ? `${(slice.bytes / 1024 ** 3).toFixed(1)} GiB`
          : slice.bytes >= 1024 ** 2
            ? `${(slice.bytes / 1024 ** 2).toFixed(1)} MiB`
            : slice.bytes >= 1024
              ? `${(slice.bytes / 1024).toFixed(1)} KiB`
              : `${slice.bytes} B`
      return { ...slice, d, size, percent: percent < 1 ? '<1%' : `${percent.toFixed(0)}%` }
    })
})
</script>

<template>
  <section class="storage-usage" aria-label="数据占用饼图">
    <div class="storage-usage__visual">
      <svg viewBox="0 0 160 160" role="group" aria-label="点击占用部分查看详情">
        <path
          v-for="part in parts"
          :key="part.id"
          :d="part.d"
          :fill="part.color"
          role="button"
          tabindex="0"
          :aria-label="`${part.label}，${part.size}，查看详情`"
          @click="emit('select', part.id)"
          @keydown.enter.prevent="emit('select', part.id)"
          @keydown.space.prevent="emit('select', part.id)"
        >
          <title>{{ part.label }} · {{ part.size }}</title>
        </path>
      </svg>
      <strong>{{ totalLabel }}</strong>
      <small>点扇区或下方项目查看详情</small>
    </div>
    <div class="storage-usage__legend">
      <button v-for="part in parts" :key="part.id" type="button" @click="emit('select', part.id)">
        <i :style="{ background: part.color }" aria-hidden="true"></i>
        <span>{{ part.label }}</span
        ><strong>{{ part.size }}</strong
        ><small>{{ part.percent }}</small>
      </button>
    </div>
  </section>
</template>

<style scoped>
.storage-usage {
  display: grid;
  gap: 0.85rem;
  padding: 0.75rem 0;
}
.storage-usage__visual {
  display: grid;
  justify-items: center;
  gap: 0.2rem;
}
svg {
  width: min(11rem, 65%);
  height: auto;
  overflow: visible;
}
path {
  cursor: pointer;
  stroke: var(--color-surface);
  stroke-width: 1.5;
}
path:hover,
path:focus-visible {
  opacity: 0.8;
  stroke: var(--color-ink);
  stroke-width: 3;
  outline: none;
}
.storage-usage__visual > small {
  color: var(--color-ink-soft);
  font-size: 0.75rem;
}
.storage-usage__legend {
  display: grid;
}
button {
  display: grid;
  grid-template-columns: 0.65rem minmax(0, 1fr) auto 2.1rem;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.2rem;
  border: 0;
  border-bottom: 1px solid var(--color-line);
  background: var(--button-background, transparent);
  color: var(--button-color, var(--color-ink));
  text-align: left;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
button:hover {
  background: var(--button-background, var(--color-surface));
}
button i {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
}
button span {
  overflow-wrap: anywhere;
}
button strong {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
button small {
  color: var(--color-ink-soft);
  text-align: right;
}
@media (min-width: 44rem) {
  .storage-usage {
    grid-template-columns: minmax(11rem, 0.7fr) minmax(0, 1fr);
    align-items: center;
  }
  svg {
    width: 11rem;
  }
}
</style>
