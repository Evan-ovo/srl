<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import '../styles/ResourceGallery.css'
import { useGalleryImageGestures } from '../composables/UseGalleryImageGestures'
import NativeImageTiles from './NativeImageTiles.vue'
const props = defineProps<{
  src: string
  nativeSource?: string
  name: string
  position?: string
  hasPrevious?: boolean
  hasNext?: boolean
  loading?: boolean
  cover?: boolean
  minimal?: boolean
  teleportTo?: string | HTMLElement
}>()
const emit = defineEmits<{ close: []; previous: []; next: []; loaded: [] }>()
const stage = ref<HTMLElement>()
function turn(direction: number) {
  if (props.loading) return
  if (direction < 0 && props.hasPrevious) emit('previous')
  if (direction > 0 && props.hasNext) emit('next')
}
const gestures = useGalleryImageGestures(stage, () => props.src, turn)
const { scale, style, ready, isLongImage } = gestures
// Touch can omit its compatibility click immediately after a drag. Handle a real
// stationary touch release once, while keeping mouse and keyboard click semantics.
let controlStart: { button: HTMLButtonElement; x: number; y: number; id: number } | undefined
let completedTouch: HTMLButtonElement | undefined
function controlDown(event: PointerEvent) {
  completedTouch = undefined
  const button = (event.target as Element).closest<HTMLButtonElement>('button[data-viewer-action]')
  controlStart =
    event.pointerType === 'touch' && event.isPrimary && button && !button.disabled
      ? { button, x: event.clientX, y: event.clientY, id: event.pointerId }
      : undefined
}
function controlMove(event: PointerEvent) {
  if (
    controlStart &&
    Math.hypot(event.clientX - controlStart.x, event.clientY - controlStart.y) > 8
  )
    controlStart = undefined
}
function controlUp(event: PointerEvent) {
  const start = controlStart
  controlStart = undefined
  if (!start || start.id !== event.pointerId || start.button.disabled) return
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return
  completedTouch = start.button
  if (start.button.dataset.viewerAction === 'close') consumeClosingClick()
  activateControl(start.button.dataset.viewerAction!)
}
function consumeClosingClick() {
  // Removing the sheet on touch release can retarget its compatibility click to
  // the cover underneath. Keep this guard through unmount, only until that click
  // or the next pointer sequence (including browsers that omit the click).
  const clear = () => {
    document.removeEventListener('click', consume, true)
    document.removeEventListener('pointerdown', clear, true)
  }
  const consume = (event: MouseEvent) => {
    clear()
    if (event.detail === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('click', consume, true)
  document.addEventListener('pointerdown', clear, true)
}
function controlClick(event: MouseEvent) {
  if (event.detail !== 0 && completedTouch?.contains(event.target as Node)) {
    completedTouch = undefined
    event.preventDefault()
    event.stopPropagation()
  }
}
function activateControl(action: string) {
  if (action === 'close') emit('close')
  else if (action === 'fit') {
    if (scale.value > 1) gestures.reset()
    else gestures.fitWidth()
  }
}
function imageLoaded(event: Event) {
  gestures.loaded(event)
  emit('loaded')
}
const failed = ref(false)
const nativeUnavailable = ref(false)
const panel = ref<HTMLElement>()
function imageFailed() {
  failed.value = true
  emit('loaded')
}
let previousFocus: HTMLElement | null = null
watch(
  () => props.src,
  () => {
    failed.value = false
    nativeUnavailable.value = false
  },
)
function key(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    const buttons = [
      ...(panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ]
    const first = buttons[0],
      last = buttons.at(-1)
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === panel.value)
    ) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    emit('close')
  }
  if (event.key === 'ArrowLeft') turn(-1)
  if (event.key === 'ArrowRight') turn(1)
}
function back(event: Event) {
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (detail.handled) return
  detail.handled = true
  emit('close')
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  panel.value?.focus({ preventScroll: true })
  window.addEventListener('keydown', key, true)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, back)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', key, true)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, back)
  previousFocus?.focus({ preventScroll: true })
})
</script>
<template>
  <Teleport :to="teleportTo ?? 'body'">
    <div
      class="resource-image-viewer"
      :class="{ 'resource-image-viewer--minimal': minimal }"
      role="presentation"
      @click.self="emit('close')"
    >
      <section
        ref="panel"
        class="resource-image-viewer__sheet"
        role="dialog"
        aria-modal="true"
        :aria-label="name"
        tabindex="-1"
        @pointerdown.capture="controlDown"
        @pointermove.capture="controlMove"
        @pointerup.capture="controlUp"
        @pointercancel.capture="controlStart = undefined"
        @click.capture="controlClick"
      >
        <header class="resource-image-viewer__header">
          <span v-if="loading" class="resource-image-viewer__title" role="status"
            >正在读取原图…</span
          >
          <span v-else-if="!cover" class="resource-image-viewer__title"
            >{{ name }}<small v-if="position"> · {{ position }}</small></span
          >
          <button
            v-if="!cover && isLongImage"
            class="resource-image-viewer__action"
            type="button"
            :disabled="loading || !ready"
            data-viewer-action="fit"
            @click="activateControl('fit')"
          >
            {{ scale > 1 ? '适应画面' : '按宽度' }}
          </button>
          <button
            class="resource-image-viewer__action"
            type="button"
            :aria-label="minimal ? '关闭图片' : '收起完整原图'"
            data-viewer-action="close"
            @click="activateControl('close')"
          >
            {{ minimal ? '×' : '收起完整原图' }}
          </button>
        </header>
        <div
          ref="stage"
          class="resource-image-viewer__canvas"
          :aria-busy="loading"
          @pointerdown="!loading && gestures.down($event)"
          @pointermove="gestures.move"
          @pointerup="gestures.up"
          @pointercancel="gestures.cancel"
          @lostpointercapture="gestures.lost"
          @wheel.prevent="!loading && gestures.wheel($event)"
          @contextmenu.prevent
        >
          <p v-if="failed" role="status">图片暂时无法加载</p>
          <NativeImageTiles
            v-else-if="nativeSource && !nativeUnavailable"
            :source="nativeSource"
            :geometry="gestures.geometry.value"
            @dimensions="gestures.dimensions"
            @loaded="emit('loaded')"
            @unavailable="nativeUnavailable = true"
          />
          <img
            v-else
            :src="src"
            :alt="name"
            referrerpolicy="no-referrer"
            :style="style"
            draggable="false"
            @load="imageLoaded"
            @error="imageFailed"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>
