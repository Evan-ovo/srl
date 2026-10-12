<script setup lang="ts">
import '../styles/AppearanceOriginalCssActions.css'
import { onUnmounted, ref } from 'vue'
import type { AppearanceScope } from '../core/AppearanceScopes'
import { readOriginalCss } from '../services/AppearanceOriginalCssService'
import { downloadBlob } from '../utils/LibraryFormatting'

const props = defineProps<{ scope?: AppearanceScope }>()
const busy = ref(false)
const status = ref('')
const failed = ref(false)
let controller: AbortController | undefined
let statusTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

onUnmounted(() => {
  disposed = true
  controller?.abort()
  clearTimeout(statusTimer)
})

async function transfer(action: 'copy' | 'export'): Promise<void> {
  if (busy.value) return
  const scope = props.scope
  const title = scope ? `${scope.title}原始 CSS` : '原始 CSS'
  busy.value = true
  failed.value = false
  status.value = '正在读取原始 CSS…'
  clearTimeout(statusTimer)
  const request = new AbortController()
  controller = request
  try {
    const content = readOriginalCss(scope, request.signal)
    // Observe this promise even when clipboard creation itself throws synchronously.
    void content.catch(() => {})
    if (action === 'copy') {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const text = content.then(({ parts }) => new Blob(parts, { type: 'text/plain' }))
        void text.catch(() => {})
        // Start within the tap gesture (Safari), even if reading APP assets is asynchronous.
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })])
      } else {
        const { parts } = await content
        if (!navigator.clipboard?.writeText) throw new Error('无法使用剪贴板，请改用导出原始 CSS')
        await navigator.clipboard.writeText(parts.join(''))
      }
      status.value = `${title}已复制`
    } else {
      const { parts } = await content
      if (request.signal.aborted) return
      const suffix = scope ? `-${scope.value.replace(/[^a-zA-Z0-9_-]/gu, '-')}` : ''
      await downloadBlob(
        new Blob(parts, { type: 'text/css;charset=utf-8' }),
        `srl-original${suffix}.css`,
      )
      status.value = `${title}文件已导出`
    }
  } catch (error) {
    if (request.signal.aborted) return
    failed.value = true
    status.value =
      error instanceof Error && error.name !== 'NotAllowedError'
        ? error.message
        : action === 'copy'
          ? '浏览器未允许复制，请改用导出原始 CSS'
          : '原始 CSS 导出失败，请重试'
  } finally {
    request.abort()
    busy.value = false
    if (!disposed && !failed.value) statusTimer = setTimeout(() => (status.value = ''), 3000)
  }
}
</script>

<template>
  <div class="appearance-original-css-controls" :aria-busy="busy">
    <div
      class="appearance-original-css-actions"
      role="group"
      :aria-label="`${scope?.title ?? '全局'}原始 CSS`"
    >
      <button
        type="button"
        :disabled="busy"
        class="appearance-action-hit"
        @click="transfer('copy')"
      >
        <span class="appearance-action-face">复制原始 CSS</span>
      </button>
      <button
        type="button"
        :disabled="busy"
        class="appearance-action-hit"
        @click="transfer('export')"
      >
        <span class="appearance-action-face">导出原始 CSS</span>
      </button>
    </div>
    <p
      v-if="status"
      class="appearance-original-css-status"
      :class="{ 'is-error': failed }"
      role="status"
    >
      {{ status }}
    </p>
  </div>
</template>
