<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { resourceService, externalAppService } from '../core/AppContainer'
import { createChatReaderHost, type ChatReaderNavigation } from '../services/ChatReaderHostService'
import { mountChatReader } from '../reader/ChatReaderView.js'
import markup from '../reader/ChatReader.html?raw'
import css from '../reader/ChatReader.css?raw'
import { downloadBlob } from '../utils/LibraryFormatting'
import { readAppliedAppFrameCss } from '../services/AppearanceScopeService'
import {
  chatReaderAppearance,
  readChatReaderColors,
  rememberChatReaderColors,
} from '../utils/ChatReaderAppearance'
import { APPLIED_CSS_CHANGED_EVENT } from '../core/AppearanceScopes'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import FeatureAppHeader from './FeatureAppHeader.vue'
const emit = defineEmits<{ back: [] }>()
const view = ref<HTMLElement>()
const ready = ref(false)
const navigation = ref<ChatReaderNavigation>({
  page: 'roles',
  cover: false,
  colors: readChatReaderColors(),
})
const appearance = computed(() => chatReaderAppearance(navigation.value.colors))
let reader: ReturnType<typeof mountChatReader> | undefined
let closed = false
function action(value: 'back' | 'search' | 'cover') {
  if (reader) reader.action(value)
  else if (value === 'back') emit('back')
}
function keydown(event: KeyboardEvent) {
  if (closed || event.key !== 'Escape' || document.body.classList.contains('modal-open')) return
  event.preventDefault()
  event.stopImmediatePropagation()
  action('back')
}
function backRequest(event: Event) {
  if (closed || !(event instanceof CustomEvent)) return
  const detail = event.detail as SrlBackRequestDetail | undefined
  if (!detail || detail.handled) return
  detail.handled = true
  event.preventDefault()
  event.stopImmediatePropagation()
  action('back')
}
let appearanceVersion = 0
async function updateAppearance() {
  const version = ++appearanceVersion
  const css = await readAppliedAppFrameCss('chatReader')
  if (!closed && version === appearanceVersion) reader?.appearance(css)
}
onMounted(() => {
  window.addEventListener('keydown', keydown, { capture: true })
  window.addEventListener(SRL_BACK_REQUEST_EVENT, backRequest, { capture: true })
  window.addEventListener(APPLIED_CSS_CHANGED_EVENT, updateAppearance)

  const root = view.value!.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const surface = document.createElement('div')
  surface.className = 'chat-reader-surface builtin-shell'
  surface.setAttribute('data-reader-starting', '')
  surface.innerHTML = markup
  root.append(style, surface)
  reader = mountChatReader(
    root,
    createChatReaderHost(resourceService, externalAppService, {
      navigation(value) {
        if (closed) return
        navigation.value = value
        rememberChatReaderColors(value.colors)
      },
      ready() {
        if (!closed) ready.value = true
      },
      exit() {
        if (!closed) emit('back')
      },
      shareText: (name, text) =>
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), name),
      appearance: () => readAppliedAppFrameCss('chatReader'),
    }),
  )
})
onBeforeUnmount(() => {
  closed = true
  window.removeEventListener('keydown', keydown, { capture: true })
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, backRequest, { capture: true })
  window.removeEventListener(APPLIED_CSS_CHANGED_EVENT, updateAppearance)
  void reader?.dispose()
})
</script>
<template>
  <section
    class="chat-reader-app"
    :style="appearance"
    data-srl-feature-root="chatReader"
    :data-reader-page="navigation.page"
    :aria-busy="!ready"
  >
    <FeatureAppHeader
      v-if="navigation.page !== 'reader'"
      :title="navigation.page === 'roles' ? '读了么' : '聊天记录'"
      :back-label="navigation.page === 'roles' ? '返回功能桌面' : '返回角色列表'"
      @back="action('back')"
    >
      <template #actions>
        <button
          class="chat-reader-app__action"
          type="button"
          aria-label="搜索"
          @click="action('search')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
        </button>
        <button
          class="chat-reader-app__action"
          type="button"
          aria-label="角色沉浸背景"
          :aria-pressed="navigation.cover"
          @click="action('cover')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8" cy="8" r="1.5" />
            <path d="m3 17 6-6 4 4 3-3 5 5" />
          </svg>
        </button>
      </template>
    </FeatureAppHeader>
    <div ref="view" class="chat-reader-app__view" aria-label="读了么阅读工作区" />
  </section>
</template>
<style scoped>
.chat-reader-app {
  display: flex;
  flex-direction: column;
  position: fixed;
  z-index: 2000;
  inset: 0;
  height: var(--app-viewport-height, 100dvh);
  padding: var(--safe-top, 0px) var(--safe-right, 0px) var(--safe-bottom, 0px) var(--safe-left, 0px);
  box-sizing: border-box;
  min-height: 0;
  background: var(--reader-paper);
  color: var(--color-ink);
}
.chat-reader-app__view {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.chat-reader-app__action {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 0;
  background: transparent;
  color: inherit;
}
.chat-reader-app__action svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.chat-reader-app :deep(.feature-app-header) {
  --feature-header-viewport-width: calc(100% - 2 * var(--mobile-gutter));
  left: auto;
  margin-inline: auto;
  transform: none;
  border-bottom-color: color-mix(in srgb, var(--color-line) 45%, transparent);
}
</style>
