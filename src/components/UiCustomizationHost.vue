<script setup lang="ts">
import recoveryCss from '../styles/RecoveryControls.css?inline'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { appearanceScopes } from '../core/AppearanceScopes'
import { appearanceTransaction, createProtectedHost } from '../core/AppearanceSafety'
import { installUiRecoveryGesture } from '../core/UiRecoveryGesture'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiDomSession, UI_PRIVATE_SELECTOR } from '../services/UiViewDom'
import { readUiViewPreviewCss } from '../core/UiViewPreview'
import { APPLIED_CSS_CHANGED_EVENT } from '../core/AppearanceScopes'
import { noticeCenter } from '../core/NoticeCenter'
import type { CustomCssScope } from '../types/BrowserPreferences'
import type { CustomUiViews, UiViewSnapshot, UiNativePlacement } from '../types/UiCustomization'
import CustomUiFrame from './CustomUiFrame.vue'
import { usePreviewPolicy } from '../composables/UsePreviewPolicy'

const props = defineProps<{ views: CustomUiViews }>()
const previewPolicy = usePreviewPolicy()
const root = shallowRef<HTMLElement>()
const scope = ref<CustomCssScope>()
const state = shallowRef<UiViewSnapshot>({ html: '', controls: [], theme: 'light' })
const css = ref('')
const ready = ref(false)
const failed = ref(false)
const hostScrollHeight = ref<number | null>(null)
const hostViewportHeight = ref(0)
const hostSurfaceHeight = computed(() =>
  hostScrollHeight.value === null
    ? null
    : Math.max(hostViewportHeight.value, Math.ceil(hostScrollHeight.value)),
)
const view = computed(() => (scope.value ? props.views[scope.value] : undefined))
let session: ReturnType<typeof createUiDomSession> | undefined
let observer: MutationObserver | undefined
let stateObserver: MutationObserver | undefined
let stylesObserver: MutationObserver | undefined
let themeObserver: MutationObserver | undefined
let sizeObserver: ResizeObserver | undefined
let rescue: HTMLDivElement | undefined
let stopRecoveryGesture: (() => void) | undefined
let disposed = false
let queued = false
const nativeStyles = new Map<HTMLElement, { attribute: string | null; clipPath: string }>()
const nativeAnchors = new Map<HTMLElement, HTMLElement>()
let nativePlacements: UiNativePlacement[] = []
let originalPosition: { value: string; priority: string } | undefined
let originalScroll: { top: number; left: number } | undefined

function applyLayout(height: number | null) {
  if (!root.value) return
  if (height !== null) {
    originalScroll ??= { top: root.value.scrollTop, left: root.value.scrollLeft }
    root.value.dataset.srlCustomScroll = 'host'
    hostViewportHeight.value = root.value.clientHeight
    hostScrollHeight.value = height
  } else {
    delete root.value.dataset.srlCustomScroll
    hostScrollHeight.value = null
    if (originalScroll) {
      root.value.scrollTop = originalScroll.top
      root.value.scrollLeft = originalScroll.left
      originalScroll = undefined
    }
  }
}

function restoreNative() {
  for (const [node, saved] of nativeStyles) {
    if (saved.attribute === null) node.removeAttribute('style')
    else node.setAttribute('style', saved.attribute)
  }
  nativeStyles.clear()
  for (const anchor of nativeAnchors.values()) anchor.remove()
  nativeAnchors.clear()
}
function placeNative(regions: UiNativePlacement[]) {
  if (!ready.value || !root.value || failed.value) return
  regions = regions.filter(
    (region) =>
      region &&
      typeof region.id === 'string' &&
      [region.top, region.left, region.width, region.height].every(Number.isFinite) &&
      region.width >= 0 &&
      region.height >= 0 &&
      (region.visibleRects === undefined ||
        (Array.isArray(region.visibleRects) &&
          region.visibleRects.every(
            (rect) =>
              rect &&
              [rect.top, rect.left, rect.width, rect.height].every(Number.isFinite) &&
              rect.width >= 0 &&
              rect.height >= 0,
          ))),
  )
  nativePlacements = regions
  const box = root.value.getBoundingClientRect()
  const scrollTop = hostScrollHeight.value === null ? 0 : root.value.scrollTop
  const scrollLeft = hostScrollHeight.value === null ? 0 : root.value.scrollLeft
  const used = new Set(regions.map((region) => session?.native(region.id)))
  for (const [node, saved] of nativeStyles)
    if (!used.has(node)) {
      if (saved.attribute === null) node.removeAttribute('style')
      else node.setAttribute('style', saved.attribute)
      nativeStyles.delete(node)
      nativeAnchors.get(node)?.remove()
      nativeAnchors.delete(node)
    }
  for (const region of regions) {
    const node = session?.native(region.id)
    if (!node) continue
    if (!nativeStyles.has(node)) {
      nativeStyles.set(node, {
        attribute: node.getAttribute('style'),
        clipPath: node.style.clipPath,
      })
      const anchor = document.createElement('div')
      anchor.dataset.srlNativeAnchor = ''
      const computed = getComputedStyle(node)
      Object.assign(anchor.style, {
        width: `${node.clientWidth}px`,
        height: `${node.clientHeight}px`,
        visibility: 'hidden',
        display: computed.display,
        flex: computed.flex,
        margin: computed.margin,
        gridArea: computed.gridArea,
      })
      node.before(anchor)
      nativeAnchors.set(node, anchor)
    }
    const pieces = region.visibleRects
    const fullyVisible =
      pieces?.length === 1 &&
      pieces[0]!.left === 0 &&
      pieces[0]!.top === 0 &&
      pieces[0]!.width === region.width &&
      pieces[0]!.height === region.height
    const clipPath =
      pieces && !fullyVisible && pieces.length
        ? `path('${pieces.map((rect) => `M${rect.left} ${rect.top}h${rect.width}v${rect.height}h${-rect.width}Z`).join(' ')}')`
        : nativeStyles.get(node)!.clipPath
    const styles: Record<string, string> = {
      position: 'absolute',
      width: `${Math.max(0, region.width)}px`,
      height: `${Math.max(0, region.height)}px`,
      visibility: pieces?.length === 0 ? 'hidden' : 'visible',
      zIndex: '21',
      clipPath,
    }
    if (node.matches('img, .fa-solid, .fa-regular, .fa-brands, .fa-duotone'))
      styles.pointerEvents = 'none'
    for (const [key, value] of Object.entries(styles))
      if (
        node.style.getPropertyValue(
          key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
        ) !== value
      )
        node.style.setProperty(
          key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
          value,
        )
    const placed = node.getBoundingClientRect()
    const targetTop = box.top + region.top - scrollTop
    const targetLeft = box.left + region.left - scrollLeft
    const top = (Number.parseFloat(node.style.top) || 0) + targetTop - placed.top
    const left = (Number.parseFloat(node.style.left) || 0) + targetLeft - placed.left
    if (Math.abs(placed.top - targetTop) > 0.5) node.style.top = `${top}px`
    if (Math.abs(placed.left - targetLeft) > 0.5) node.style.left = `${left}px`
  }
}

function restore() {
  applyLayout(null)
  if (root.value?.classList.contains('srl-ui-controller-hidden'))
    root.value.classList.remove('srl-ui-controller-hidden')
  if (originalPosition && root.value) {
    if (originalPosition.value)
      root.value.style.setProperty('position', originalPosition.value, originalPosition.priority)
    else root.value.style.removeProperty('position')
    originalPosition = undefined
  }
  restoreNative()
  rescue?.remove()
  rescue = undefined
}
function updatePosition() {
  if (!root.value) return
  hostViewportHeight.value = root.value.clientHeight
  if (nativePlacements.length) placeNative(nativePlacements)
}
function updateScrolledPosition(event: Event) {
  // Shared-container scrolling moves both layers in the compositor; no position chase is needed.
  if (hostScrollHeight.value !== null && event.target === root.value) return
  updatePosition()
}
function hideController() {
  if (!ready.value || failed.value) {
    restore()
    return
  }
  if (root.value && !root.value.classList.contains('srl-ui-controller-hidden'))
    root.value.classList.add('srl-ui-controller-hidden')
  if (root.value && getComputedStyle(root.value).position === 'static') {
    originalPosition = {
      value: root.value.style.getPropertyValue('position'),
      priority: root.value.style.getPropertyPriority('position'),
    }
    root.value.style.setProperty('position', 'relative')
  }
}
function revealRecovery() {
  if (!ready.value || failed.value || !view.value?.enabled) return false
  if (!rescue) {
    const layer = createProtectedHost('srl-custom-ui-rescue')
    rescue = layer.host
    layer.root.innerHTML = `<style>${recoveryCss}</style><div class="actions"><button type="button" class="ui-recovery-button">恢复原界面</button><button type="button" data-dismiss>收起</button></div>`
    layer.root.querySelector('.ui-recovery-button')!.addEventListener('click', disableCurrent)
    layer.root.querySelector('[data-dismiss]')!.addEventListener('click', () => {
      rescue?.remove()
      rescue = undefined
    })
  }
  return true
}
function disableCurrent() {
  if (!scope.value) return
  if (appearanceTransaction.disablePreviewView(scope.value)) return
  const storage = new BrowserStorageService()
  const saved = storage.getCustomUiViews()
  if (saved[scope.value]) saved[scope.value]!.enabled = false
  storage.setCustomUiViews(saved)
}
function failCurrent(message: string) {
  failed.value = true
  disableCurrent()
  noticeCenter.push({
    id: 'custom-ui-failed',
    type: 'error',
    message: `${message}；已停用当前Vue，源码仍保留，可在外观中重新应用。`,
  })
}
function refreshState() {
  if (!session) return
  const next = session.read()
  if (JSON.stringify(next) !== JSON.stringify(state.value)) state.value = next
  hideController()
}
async function invoke(action: import('../types/UiCustomization').UiViewAction) {
  if (!session) throw new Error('原界面已关闭')
  session.invoke(action)
  await nextTick()
  refreshState()
}
function refreshStyles() {
  css.value = readUiViewPreviewCss(previewPolicy.value.allowRemoteResources)
}
function visible(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    if (node.hidden || getComputedStyle(node).display === 'none') return false
  return true
}
function locate() {
  if (disposed) return
  const scopes = appearanceScopes()
    .filter((item) => item.value !== 'shell')
    .reverse()
  const selected = [...scopes, ...appearanceScopes().filter((item) => item.value === 'shell')]
    .map((item) => ({ item, element: document.querySelector<HTMLElement>(item.selector) }))
    .find(({ item, element }) => props.views[item.value]?.enabled && element && visible(element))
  if (selected?.element === root.value && selected?.item.value === scope.value) return
  restore()
  stateObserver?.disconnect()
  sizeObserver?.disconnect()
  ready.value = false
  failed.value = false
  root.value = selected?.element ?? undefined
  scope.value = selected?.item.value
  session = root.value ? createUiDomSession(root.value, UI_PRIVATE_SELECTOR) : undefined
  if (!root.value || !session) return
  refreshState()
  refreshStyles()
  updatePosition()
  stateObserver = new MutationObserver((records) => {
    if (
      records.every((record) => (record.target as Element).closest?.('[data-srl-custom-surface]'))
    )
      return
    if (
      records.every(
        (record) =>
          record.type === 'attributes' &&
          record.attributeName === 'style' &&
          nativeStyles.has(record.target as HTMLElement),
      )
    )
      return
    refreshState()
    updatePosition()
  })
  stateObserver.observe(root.value, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'disabled',
      'value',
      'checked',
      'selected',
      'style',
      'class',
      'hidden',
      'open',
    ],
  })
  sizeObserver = new ResizeObserver(updatePosition)
  sizeObserver.observe(root.value)
}
function queueLocate() {
  if (queued) return
  queued = true
  void nextTick(() => {
    queued = false
    locate()
  })
}
watch(() => props.views, queueLocate)
watch([() => JSON.stringify(view.value), () => previewPolicy.value.allowRemoteResources], () => {
  ready.value = false
  failed.value = false
  nativePlacements = []
  restore()
  refreshStyles()
})
watch([ready, failed], () => {
  stopRecoveryGesture?.()
  stopRecoveryGesture = undefined
  hideController()
  if (ready.value && !failed.value)
    stopRecoveryGesture = installUiRecoveryGesture(
      document,
      revealRecovery,
      (event) =>
        ready.value &&
        !failed.value &&
        !!view.value?.enabled &&
        !event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLElement &&
              ['srl-custom-ui-rescue', 'srl-appearance-safe-layer'].includes(node.id),
          ),
    )
})
function escape(event: KeyboardEvent) {
  if (event.altKey && event.shiftKey && event.code === 'Digit0') disableCurrent()
}
onMounted(() => {
  observer = new MutationObserver(queueLocate)
  const shell = document.querySelector('.app-shell')
  if (shell)
    observer.observe(shell, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-feature-page', 'data-official-app-ready', 'style'],
    })
  stylesObserver = new MutationObserver(refreshStyles)
  stylesObserver.observe(document.head, { childList: true })
  themeObserver = new MutationObserver(() => {
    refreshState()
    refreshStyles()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      'data-theme',
      'data-font-scale',
      'data-mobile-card-orientation',
      'data-resource-card-height',
      'data-no-image-resource-cover',
      'data-display-mode',
    ],
  })
  window.addEventListener(APPLIED_CSS_CHANGED_EVENT, refreshStyles)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updateScrolledPosition, true)
  window.addEventListener('keydown', escape)
  locate()
})
onBeforeUnmount(() => {
  disposed = true
  stopRecoveryGesture?.()
  restore()
  observer?.disconnect()
  stateObserver?.disconnect()
  stylesObserver?.disconnect()
  themeObserver?.disconnect()
  sizeObserver?.disconnect()
  window.removeEventListener(APPLIED_CSS_CHANGED_EVENT, refreshStyles)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updateScrolledPosition, true)
  window.removeEventListener('keydown', escape)
})
</script>

<template>
  <Teleport v-if="root" :to="root">
    <div
      v-if="view && !failed"
      :key="scope"
      data-srl-custom-surface
      class="srl-custom-ui-surface"
      :class="{ 'is-ready': ready }"
      :style="
        hostSurfaceHeight === null
          ? undefined
          : { height: `${hostSurfaceHeight}px`, bottom: 'auto' }
      "
    >
      <CustomUiFrame
        :view="view"
        :snapshot="state"
        :css="css"
        :invoke="invoke"
        recovery
        @recovery="revealRecovery"
        @ready="ready = true"
        @error="failCurrent"
        @native="placeNative"
        @layout="applyLayout"
      />
    </div>
  </Teleport>
</template>

<style>
.srl-ui-controller-hidden {
  visibility: hidden;
}
/* The iframe and original native elements must share the compositor's scroll layer. */
.srl-ui-controller-hidden[data-srl-custom-scroll='host'] {
  visibility: visible;
  overflow-x: hidden !important;
  overflow-y: auto !important;
  scrollbar-width: none;
}
.srl-ui-controller-hidden[data-srl-custom-scroll='host']::-webkit-scrollbar {
  display: none;
}
.srl-ui-controller-hidden[data-srl-custom-scroll='host'] > :where(:not([data-srl-custom-surface])) {
  visibility: hidden;
}
.srl-custom-ui-surface {
  position: absolute;
  inset: 0;
  z-index: 20;
  visibility: hidden;
}
.srl-custom-ui-surface.is-ready {
  visibility: visible;
}
</style>
