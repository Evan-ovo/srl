<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { AssistantTokenPart, AssistantTokenReview } from '../services/ProductAssistantContext'

const props = defineProps<{ review: AssistantTokenReview }>()
const emit = defineEmits<{ details: [open: boolean] }>()
const selected = ref<AssistantTokenPart>()
const backButton = ref<HTMLButtonElement>()
const root = ref<HTMLElement>()
let returnPart: string | undefined
let returnToPie = false
const colors = ['#368b94', '#9888c7', '#729fbf', '#c98a9f', '#c7a358', '#83a89a']
const slices = computed(() => {
  let start = -Math.PI / 2
  return props.review.parts
    .filter((part) => part.tokens > 0)
    .map((part, index) => {
      const angle = (part.tokens / props.review.total) * Math.PI * 2
      const end = start + angle
      const point = (value: number) => `${100 + Math.cos(value) * 92},${100 + Math.sin(value) * 92}`
      const path =
        angle >= Math.PI * 2 - 0.000001
          ? 'M100,8 A92,92 0 1,1 100,192 A92,92 0 1,1 100,8 Z'
          : `M100,100 L${point(start)} A92,92 0 ${angle > Math.PI ? 1 : 0},1 ${point(end)} Z`
      const slice = {
        ...part,
        path,
        angle: start + angle / 2,
        color: colors[index % colors.length],
        percent: ((part.tokens / props.review.total) * 100).toFixed(1),
      }
      start = end
      return slice
    })
})
async function showDetail(part: AssistantTokenPart, event: Event) {
  returnPart = part.id
  returnToPie = event.currentTarget instanceof SVGElement
  selected.value = part
  emit('details', true)
  await nextTick()
  backButton.value?.focus({ preventScroll: true })
}
async function closeDetail() {
  selected.value = undefined
  emit('details', false)
  await nextTick()
  const target = [
    ...(root.value?.querySelectorAll<HTMLElement | SVGElement>(
      returnToPie ? 'path[data-part]' : 'button[data-part]',
    ) ?? []),
  ].find((element) => element.dataset.part === returnPart)
  target?.focus({ preventScroll: true })
}
defineExpose({ closeDetail })
</script>

<template>
  <div ref="root" class="assistant-token-review">
    <template v-if="selected">
      <header class="assistant-token-review__detail-header">
        <button ref="backButton" type="button" aria-label="返回 token 预估" @click="closeDetail">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <div>
          <strong>{{ selected.title }}</strong
          ><span>{{ selected.tokens.toLocaleString() }} tokens</span>
        </div>
      </header>
      <pre class="assistant-token-review__content" tabindex="0">{{ selected.content }}</pre>
    </template>
    <template v-else>
      <svg class="assistant-token-review__pie" viewBox="0 0 200 200" aria-label="输入 token 占比">
        <path
          v-for="slice in slices"
          :key="slice.id"
          :d="slice.path"
          :fill="slice.color"
          role="button"
          tabindex="0"
          :data-part="slice.id"
          :data-angle="slice.angle"
          :data-tokens="slice.tokens"
          :aria-label="`${slice.title}，${slice.tokens.toLocaleString()} tokens，${slice.percent}%`"
          @click="showDetail(slice, $event)"
          @keydown.enter.prevent="showDetail(slice, $event)"
          @keydown.space.prevent="showDetail(slice, $event)"
        />
      </svg>
      <div class="assistant-token-review__legend">
        <button
          v-for="slice in slices"
          :key="slice.id"
          :data-part="slice.id"
          type="button"
          @click="showDetail(slice, $event)"
        >
          <i :style="{ background: slice.color }" aria-hidden="true" />
          <span
            >{{ slice.title }}<small>{{ slice.tokens.toLocaleString() }} tokens</small></span
          >
          <b>{{ slice.percent }}%</b>
        </button>
      </div>
      <p v-if="review.compression" class="assistant-token-review__compression">
        {{ review.compression }}
      </p>
      <div class="assistant-token-review__meta">
        <span :title="review.model">{{ review.model }}</span
        ><span :title="review.destination">{{ review.destination }}</span>
      </div>
      <p class="assistant-token-review__estimate">近似估算 · 后续工具调用另计</p>
    </template>
  </div>
</template>

<style scoped>
.assistant-token-review {
  margin: 0.25rem 0 1rem;
  font-size: 0.8125rem;
}
.assistant-token-review__pie {
  display: block;
  width: 160px;
  height: 160px;
  margin: 0.6rem auto 0.75rem;
  overflow: visible;
}
.assistant-token-review__pie path {
  cursor: pointer;
  stroke: var(--color-surface);
  stroke-width: 1.5;
  transition: opacity 120ms;
}
.assistant-token-review__pie path:hover {
  opacity: 0.8;
}
.assistant-token-review__pie path:focus-visible {
  outline: 2px solid var(--color-ink);
  outline-offset: 2px;
}
.assistant-token-review__legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem 0.8rem;
}
.assistant-token-review__legend button {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  min-height: 44px;
  padding: 0.25rem 0;
  border: 0;
  background: var(--button-background, none);
  color: var(--button-color, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.assistant-token-review__legend i {
  flex: 0 0 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.assistant-token-review__legend span {
  min-width: 0;
  font-size: 0.75rem;
}
.assistant-token-review__legend small {
  display: block;
  margin-top: 2px;
  font-size: 0.625rem;
  opacity: 0.68;
}
.assistant-token-review__legend b {
  margin-left: auto;
  font-size: 0.6875rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.assistant-token-review__meta {
  display: grid;
  gap: 3px;
  margin-top: 0.7rem;
  font-size: 0.6875rem;
  opacity: 0.7;
}
.assistant-token-review__meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.assistant-token-review__estimate {
  margin: 0.5rem 0 0;
  font-size: 0.625rem;
  opacity: 0.65;
}
.assistant-token-review__compression {
  margin: 0.4rem 0;
  font-size: 0.75rem;
  color: var(--color-accent);
}
.assistant-token-review__detail-header {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  margin: -0.3rem 0 0.65rem;
}
.assistant-token-review__detail-header button {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--button-border, var(--color-line));
  border-radius: var(--button-radius, 12px);
  color: var(--button-color, inherit);
  background: var(--button-background, transparent);
  cursor: pointer;
}
.assistant-token-review__detail-header svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.assistant-token-review__detail-header strong {
  font-size: 0.9375rem;
}
.assistant-token-review__detail-header span {
  display: block;
  margin-top: 4px;
  font-size: 0.6875rem;
  opacity: 0.65;
}
.assistant-token-review__content {
  margin: 0;
  padding: 0.8rem;
  height: min(54svh, 28rem);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-line);
  border-radius: 12px;
  background: var(--color-surface-raised);
  font:
    0.75rem/1.65 ui-monospace,
    monospace;
}
@media (prefers-reduced-motion: reduce) {
  .assistant-token-review__pie path {
    transition: none;
  }
}
</style>
