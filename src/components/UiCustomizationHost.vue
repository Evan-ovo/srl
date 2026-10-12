<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { appearanceScopes } from '../core/AppearanceScopes'
import { createProtectedHost } from '../core/AppearanceSafety'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiDomSession, UI_PRIVATE_SELECTOR } from '../services/UiViewDom'
import { sanitizeCssForPreview } from '../utils/PreviewSafety'
import { APPLIED_CSS_CHANGED_EVENT } from '../core/AppearanceScopes'
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
const view = computed(() => (scope.value ? props.views[scope.value] : undefined))
let session: ReturnType<typeof createUiDomSession> | undefined
let observer: MutationObserver | undefined
let stateObserver: MutationObserver | undefined
let stylesObserver: MutationObserver | undefined
let themeObserver: MutationObserver | undefined
let sizeObserver: ResizeObserver | undefined
let rescue: HTMLDivElement | undefined
let disposed = false
let queued = false
const nativeStyles = new Map<HTMLElement, string | null>()
const nativeAnchors = new Map<HTMLElement, HTMLElement>()
let nativePlacements: UiNativePlacement[] = []
let originalPosition: { value: string; priority: string } | undefined

function restoreNative() {
  for (const [node, style] of nativeStyles) {
    if (style === null) node.removeAttribute('style')
    else node.setAttribute('style', style)
  }
  nativeStyles.clear()
  for (const anchor of nativeAnchors.values()) anchor.remove()
  nativeAnchors.clear()
}
function placeNative(regions: UiNativePlacement[]) {
  if (!ready.value || !root.value || failed.value) return
  nativePlacements = regions
  const box = root.value.getBoundingClientRect()
  const used = new Set(regions.map((region) => session?.native(region.id)))
  for (const [node, style] of nativeStyles)
    if (!used.has(node)) {
      if (style === null) node.removeAttribute('style')
      else node.setAttribute('style', style)
      nativeStyles.delete(node)
      nativeAnchors.get(node)?.remove()
      nativeAnchors.delete(node)
    }
  for (const region of regions) {
    if (
      !region ||
      typeof region.id !== 'string' ||
      ![region.top, region.left, region.width, region.height].every(Number.isFinite)
    )
      continue
    const node = session?.native(region.id)
    if (!node) continue
    if (!nativeStyles.has(node)) {
      nativeStyles.set(node, node.getAttribute('style'))
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
    const styles: Record<string, string> = {
      position: 'absolute',
      width: `${Math.max(0, region.width)}px`,
      height: `${Math.max(0, region.height)}px`,
      visibility: 'visible',
      zIndex: '21',
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
    const top = (Number.parseFloat(node.style.top) || 0) + box.top + region.top - placed.top
    const left = (Number.parseFloat(node.style.left) || 0) + box.left + region.left - placed.left
    if (Math.abs(placed.top - box.top - region.top) > 0.5) node.style.top = `${top}px`
    if (Math.abs(placed.left - box.left - region.left) > 0.5) node.style.left = `${left}px`
  }
}

function restore() {
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
  if (nativePlacements.length) placeNative(nativePlacements)
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
  if (!rescue) {
    const layer = createProtectedHost('srl-custom-ui-rescue')
    rescue = layer.host
    layer.root.innerHTML =
      '<style>button{pointer-events:auto;min-height:44px;padding:8px 12px;border:1px solid #59727c;border-radius:12px;background:#f2f9fa;color:#183842;font:14px system-ui;cursor:pointer}</style><button type="button">恢复原界面</button>'
    layer.root.querySelector('button')!.addEventListener('click', disableCurrent)
  }
}
function disableCurrent() {
  if (!scope.value) return
  const storage = new BrowserStorageService()
  const saved = storage.getCustomUiViews()
  if (saved[scope.value]) saved[scope.value]!.enabled = false
  storage.setCustomUiViews(saved)
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
  const values: string[] = []
  for (const sheet of [...document.styleSheets]) {
    try {
      values.push([...sheet.cssRules].map((rule) => rule.cssText).join('\n'))
    } catch {
      /* Cross-origin author styles are not part of the native UI. */
    }
  }
  const tokens = [...getComputedStyle(document.documentElement)]
    .filter((property) => property.startsWith('--'))
    .map(
      (property) =>
        `${property}:${getComputedStyle(document.documentElement).getPropertyValue(property)}`,
    )
    .join(';')
  css.value = sanitizeCssForPreview(`${values.join('\n')}\n:root{${tokens}}`, {
    allowExternalResources: previewPolicy.value.allowRemoteResources,
    allowLocalResources: true,
    preserveLength: true,
  })
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
watch([ready, failed], hideController)
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
  window.addEventListener('scroll', updatePosition, true)
  window.addEventListener('keydown', escape)
  locate()
})
onBeforeUnmount(() => {
  disposed = true
  restore()
  observer?.disconnect()
  stateObserver?.disconnect()
  stylesObserver?.disconnect()
  themeObserver?.disconnect()
  sizeObserver?.disconnect()
  window.removeEventListener(APPLIED_CSS_CHANGED_EVENT, refreshStyles)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
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
    >
      <CustomUiFrame
        :view="view"
        :snapshot="state"
        :css="css"
        :invoke="invoke"
        @ready="ready = true"
        @error="failed = true"
        @native="placeNative"
      />
    </div>
  </Teleport>
</template>

<style>
.srl-ui-controller-hidden {
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
