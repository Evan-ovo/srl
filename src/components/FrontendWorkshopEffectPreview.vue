<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { WorkshopEffect } from '../utils/FrontendWorkshopEffectCatalog'
import FrontendWorkshopSpatialEffect from './FrontendWorkshopSpatialEffect.vue'
import FrontendWorkshopMotionEffect from './FrontendWorkshopMotionEffect.vue'
import FrontendWorkshopComplexEffect from './FrontendWorkshopComplexEffect.vue'

const props = defineProps<{ effect: WorkshopEffect }>()
const step = ref(0)
const position = ref(props.effect.control === 'scroll' ? 0 : 50)
const run = ref(0)
const running = ref(false)
const reduceMotion = ref(false)
const finalText = computed(() =>
  props.effect.id === 'decode'
    ? 'UNKNOWN'
    : props.effect.id === 'count'
      ? '87'
      : props.effect.id === 'typewriter'
        ? '潮汐之外，故事未完。'
        : '潮汐之外',
)
const text = ref(finalText.value)
let timer: ReturnType<typeof setInterval> | undefined
let media: MediaQueryList | undefined
function stop(): void {
  clearInterval(timer)
  timer = undefined
  running.value = false
  text.value = finalText.value
}
function preferenceChanged(): void {
  reduceMotion.value = Boolean(media?.matches)
  if (reduceMotion.value) stop()
}
function visibilityChanged(): void {
  if (document.hidden) stop()
}
function play(): void {
  stop()
  run.value++
  if (reduceMotion.value) return
  const animatedText = ['count', 'decode', 'typewriter'].includes(props.effect.id)
  const duration =
    props.effect.id === 'aurora'
      ? 3000
      : props.effect.id === 'decode'
        ? 600
        : props.effect.id === 'count'
          ? 800
          : 1100
  const start = performance.now()
  running.value = true
  timer = setInterval(() => {
    const progress = Math.min(1, (performance.now() - start) / duration)
    if (animatedText) {
      if (props.effect.id === 'count')
        text.value = String(Math.round(87 * (1 - (1 - progress) ** 3)))
      else if (props.effect.id === 'typewriter')
        text.value = finalText.value.slice(0, Math.ceil(progress * finalText.value.length))
      else
        text.value = [...finalText.value]
          .map((c, i) =>
            i < Math.floor(progress * finalText.value.length)
              ? c
              : 'XQ#12?'[Math.floor(Math.random() * 6)],
          )
          .join('')
    }
    if (progress >= 1) stop()
  }, 40)
}
onMounted(() => {
  media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  preferenceChanged()
  media?.addEventListener('change', preferenceChanged)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  stop()
  media?.removeEventListener('change', preferenceChanged)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <div class="fw-effect-preview">
    <FrontendWorkshopComplexEffect
      v-if="
        ['perspective-gallery', 'zoom-journey', 'constellation-morph', 'curled-poster'].includes(
          effect.id,
        )
      "
      :effect="effect.id"
      :position="position"
      :step="step"
    />
    <FrontendWorkshopSpatialEffect
      v-else-if="effect.category === 'space'"
      :effect="effect.id"
      :step="step"
      :position="position"
      @select="step = $event"
    />
    <FrontendWorkshopMotionEffect
      v-else
      :effect="effect.id"
      :run="run"
      :position="position"
      :text="text"
      :active="running"
      @progress="position = $event"
    />
    <div class="fw-effect-preview__controls">
      <template v-if="effect.control === 'step'"
        ><span>点按切换，观察空间层次</span>
        <div>
          <button type="button" aria-label="上一步效果" @click="step--">上一项</button
          ><button type="button" aria-label="下一步效果" @click="step++">下一项</button>
        </div></template
      >
      <label v-else-if="effect.control === 'range'"
        >拖动滑块体验效果<input
          v-model.number="position"
          type="range"
          min="0"
          max="100"
          aria-label="效果演示进度"
      /></label>
      <template v-else-if="effect.control === 'scroll'"
        ><span>在演示区域上下滚动</span><output>{{ Math.round(position) }}%</output></template
      >
      <template v-else
        ><span>{{ reduceMotion ? '已跟随系统减少动态效果' : '点按播放，不自动循环' }}</span
        ><button type="button" @click="running ? stop() : play()">
          {{ running ? '立即完成' : '播放效果' }}
        </button></template
      >
    </div>
  </div>
</template>

<style scoped>
.fw-effect-preview__controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--color-ink-soft);
  font-size: var(--text-caption);
}
.fw-effect-preview__controls div {
  display: flex;
  gap: 6px;
}
.fw-effect-preview__controls label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.fw-effect-preview__controls input {
  width: 45%;
  accent-color: var(--color-accent);
  min-height: 44px;
}
.fw-effect-preview__controls button {
  border: 1px solid var(--button-border, var(--color-line));
  background: var(--button-background, var(--color-surface-raised));
  color: var(--button-color, var(--color-ink));
  border-radius: var(--button-radius, var(--radius-control));
  padding: 6px 10px;
  min-height: 36px;
}
@media (max-width: 48rem) {
  .fw-effect-preview__controls button {
    min-height: 44px;
  }
}
</style>
