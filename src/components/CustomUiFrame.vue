<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePreviewPolicy } from '../composables/UsePreviewPolicy'
import type {
  CustomUiView,
  UiViewAction,
  UiViewSnapshot,
  UiNativePlacement,
} from '../types/UiCustomization'
import { compileCustomUiView, customUiSourceKey } from '../services/UiCustomizationService'
import { createUiViewDocument } from '../services/UiViewRuntime'

const props = defineProps<{
  view: CustomUiView
  snapshot: UiViewSnapshot
  css?: string
  invoke?: (action: UiViewAction) => void | Promise<void>
  prepared?: { key: string; source: string }
  recovery?: boolean
}>()
const emit = defineEmits<{
  ready: []
  error: [message: string]
  native: [regions: UiNativePlacement[]]
  layout: [height: number | null]
  recovery: []
}>()
const previewPolicy = usePreviewPolicy()
const frame = ref<HTMLIFrameElement>()
const documentUrl = ref('')
const error = ref('')
let port: MessagePort | undefined
let generation = 0
let nonce = ''
let lastSequence = 0
let disposed = false
let rendered = false

function release() {
  port?.close()
  port = undefined
  lastSequence = 0
  nonce = ''
  rendered = false
  if (documentUrl.value) URL.revokeObjectURL(documentUrl.value)
  documentUrl.value = ''
}
function fail(message: string) {
  error.value = message
  release()
  emit('error', message)
}
const post = (type: string, value: Record<string, unknown>) =>
  port?.postMessage({ type, nonce, ...value })
watch(
  [
    () => JSON.stringify(props.view),
    () => props.prepared,
    () => previewPolicy.value.allowRemoteResources,
  ],
  async () => {
    const version = ++generation
    release()
    error.value = ''
    try {
      const source =
        props.prepared && props.prepared.key === customUiSourceKey(props.view)
          ? props.prepared.source
          : await compileCustomUiView(props.view)
      if (disposed || version !== generation) return
      documentUrl.value = URL.createObjectURL(
        new Blob([createUiViewDocument(source, previewPolicy.value.allowRemoteResources)], {
          type: 'text/html',
        }),
      )
    } catch (cause) {
      if (disposed || version !== generation) return
      fail(cause instanceof Error ? cause.message : '界面源码编译失败')
    }
  },
  { immediate: true },
)
watch(
  () => props.snapshot,
  (state) => post('state', { state }),
)
watch(
  () => props.css,
  (css) => post('styles', { css: css || '' }),
)

function connect(event: MessageEvent) {
  if (!frame.value || event.source !== frame.value.contentWindow) return
  if (event.data?.type === 'srl:ui-navigation') {
    fail('界面源码不能导航或替换运行容器，原界面仍保留')
    return
  }
  if (event.data?.type !== 'srl:ui-ready' || port) return
  const channel = new MessageChannel()
  nonce = crypto.randomUUID()
  port = channel.port1
  const session = port
  const sessionNonce = nonce
  port.onmessage = async ({ data }) => {
    if (session !== port || data?.nonce !== sessionNonce) return
    if (data.type === 'ready') {
      post('styles', { css: props.css || '' })
      post('state', { state: props.snapshot })
      post('recovery-gesture', { enabled: props.recovery === true })
    } else if (data.type === 'rendered' && !rendered) {
      rendered = true
      emit('ready')
    } else if (data.type === 'reveal-recovery' && rendered && props.recovery) emit('recovery')
    else if (data.type === 'native' && Array.isArray(data.regions)) {
      if (
        data.hostScrollHeight === null ||
        (typeof data.hostScrollHeight === 'number' &&
          Number.isFinite(data.hostScrollHeight) &&
          data.hostScrollHeight >= 0)
      )
        emit('layout', data.hostScrollHeight)
      emit('native', data.regions)
    } else if (data.type === 'error') fail('自定义界面运行失败，原界面仍保留')
    else if (
      data.type === 'action' &&
      Number.isSafeInteger(data.sequence) &&
      data.sequence > lastSequence &&
      data.id === data.sequence
    ) {
      lastSequence = data.sequence
      try {
        if (!props.invoke) throw new Error('预览不执行真实业务操作')
        await props.invoke(data.action)
        if (port === session) post('result', { id: data.id, ok: true })
      } catch (cause) {
        if (port === session)
          post('result', {
            id: data.id,
            ok: false,
            error: cause instanceof Error ? cause.message : '原界面未执行该操作',
          })
      }
    }
  }
  port.start()
  frame.value.contentWindow?.postMessage({ type: 'srl:ui-connect', nonce }, '*', [channel.port2])
}
onMounted(() => window.addEventListener('message', connect))
onBeforeUnmount(() => {
  disposed = true
  ++generation
  release()
  window.removeEventListener('message', connect)
})
</script>

<template>
  <div class="custom-ui-frame">
    <p v-if="error" role="alert">{{ error }}</p>
    <iframe
      v-else-if="documentUrl"
      ref="frame"
      title="自定义界面"
      :src="documentUrl"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
    ></iframe>
    <p v-else role="status">正在编译界面源码…</p>
  </div>
</template>

<style scoped>
.custom-ui-frame {
  width: 100%;
  height: 100%;
  min-height: 12rem;
}
iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
p {
  padding: 1rem;
  overflow-wrap: anywhere;
  color: var(--color-ink);
}
</style>
