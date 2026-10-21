<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { usePreviewPolicy } from '../composables/UsePreviewPolicy'
import type { Resource } from '../types/Resource'
import {
  attachmentFormat,
  attachmentZipDirectory,
  readAttachmentText,
} from '../services/AttachmentDocument'
import { formatBytes } from '../utils/LibraryFormatting'
import AttachmentFilePreview from './AttachmentFilePreview.vue'

const props = withDefaults(defineProps<{ resource: Resource; active?: boolean }>(), {
  active: true,
})
const format = attachmentFormat(props.resource.fileName)
const filePreview = ['audio', 'video', 'image', 'code', 'table'].includes(format)
const previewPolicy = format === 'markdown' ? usePreviewPolicy() : undefined
const markdownSource = ref('')
const markdownHtml = computed(() => {
  const safe = DOMPurify.sanitize(markdownSource.value, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      'del',
      'blockquote',
      'ul',
      'ol',
      'li',
      'pre',
      'code',
      'hr',
      'a',
      'img',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'th',
      'td',
      'input',
      'sup',
      'sub',
    ],
    ALLOWED_ATTR: [
      'href',
      'src',
      'alt',
      'title',
      'type',
      'checked',
      'disabled',
      'start',
      'colspan',
      'rowspan',
    ],
    ALLOW_DATA_ATTR: false,
  })
  const template = document.createElement('template')
  template.innerHTML = safe
  for (const anchor of template.content.querySelectorAll('a')) {
    if (!/^(?:https?:|mailto:)/iu.test(anchor.getAttribute('href') ?? ''))
      anchor.removeAttribute('href')
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }
  for (const image of template.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? ''
    const embedded = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/iu.test(src)
    if (!embedded && !(previewPolicy?.value.allowRemoteResources && /^https?:\/\//iu.test(src)))
      image.removeAttribute('src')
  }
  for (const input of template.content.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove()
    else input.disabled = true
  }
  return template.innerHTML
})
const text = ref('')
const error = ref('')
const loading = ref(!filePreview)
const frame = ref('')
const page = ref(1)
const pageCount = ref(0)
const zoom = ref(1)
const canvas = ref<HTMLCanvasElement>()
const directory = ref<Array<{ name: string; size: number }>>([])
const directoryPage = ref(1)
const controller = new AbortController()
const urls = new Set<string>()
let pdf: import('pdfjs-dist').PDFDocumentProxy | undefined
let loadingTask: import('pdfjs-dist').PDFDocumentLoadingTask | undefined
let rendering: import('pdfjs-dist').RenderTask | undefined
let renderGeneration = 0

async function renderPage() {
  if (!pdf || !canvas.value) return
  const generation = ++renderGeneration
  rendering?.cancel()
  loading.value = true
  try {
    const documentPage = await pdf.getPage(page.value)
    if (controller.signal.aborted || generation !== renderGeneration) return
    const viewport = documentPage.getViewport({ scale: zoom.value * 1.4 })
    const ratio = Math.min(1, Math.sqrt(4_000_000 / (viewport.width * viewport.height)))
    const scaled = documentPage.getViewport({ scale: zoom.value * 1.4 * ratio })
    const target = canvas.value
    target.width = Math.ceil(scaled.width)
    target.height = Math.ceil(scaled.height)
    rendering = documentPage.render({ canvas: target, viewport: scaled })
    await rendering.promise
    documentPage.cleanup()
  } catch (cause) {
    if (
      !controller.signal.aborted &&
      generation === renderGeneration &&
      (cause as Error).name !== 'RenderingCancelledException'
    )
      error.value = cause instanceof Error ? cause.message : 'PDF 页面读取失败'
  } finally {
    if (generation === renderGeneration) loading.value = false
  }
}
async function turn(offset: number) {
  page.value += offset
  await renderPage()
}
async function changeZoom(value: string) {
  zoom.value = Number(value)
  await renderPage()
}
onMounted(async () => {
  if (filePreview) return
  const resource = props.resource
  const file = new File([resource.originalBlob], resource.fileName, { type: resource.mimeType })
  try {
    if (format === 'pdf') {
      const [renderer, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ])
      if (controller.signal.aborted) return
      renderer.GlobalWorkerOptions.workerSrc = worker.default
      const url = URL.createObjectURL(resource.originalBlob)
      urls.add(url)
      loadingTask = renderer.getDocument({ url, useSystemFonts: true })
      pdf = await loadingTask.promise
      if (controller.signal.aborted) {
        await loadingTask.destroy()
        return
      }
      pageCount.value = pdf.numPages
      await nextTick()
      await renderPage()
    } else if (format === 'zip') {
      directory.value = await attachmentZipDirectory(file, controller.signal)
    } else if (format === 'word' && /\.docx$/iu.test(file.name)) {
      if (file.size > 16 * 1024 * 1024)
        throw new Error('此 Word 超过 16 MiB 预览范围，仍可完整导出')
      const entries = await attachmentZipDirectory(file, controller.signal)
      if (entries.reduce((total, entry) => total + entry.size, 0) > 64 * 1024 * 1024)
        throw new Error('Word 展开内容超过 64 MiB 预览范围，仍可完整导出')
      const { renderAsync } = await import('docx-preview')
      if (controller.signal.aborted) return
      const detached = document.createElement('div')
      await renderAsync(file, detached, undefined, { renderAltChunks: false, useBase64URL: true })
      if (controller.signal.aborted) return
      const html = DOMPurify.sanitize(detached.innerHTML, {
        ADD_TAGS: ['style'],
        FORBID_TAGS: ['a', 'iframe', 'object', 'embed', 'script'],
      })
      // The document gets an isolated, script-free surface and cannot fetch remote content.
      frame.value = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:#e5e7eb} .docx-wrapper{padding:12px!important} section.docx{max-width:100%;box-sizing:border-box}</style></head><body>${html}</body></html>`
    } else if (format === 'markdown') {
      const source = await readAttachmentText(file, controller.signal)
      const { default: showdown } = await import('showdown')
      if (controller.signal.aborted) return
      markdownSource.value = new showdown.Converter({
        tables: true,
        strikethrough: true,
        tasklists: true,
        simplifiedAutoLink: true,
        noHeaderId: true,
      }).makeHtml(source)
    } else if (format === 'word' || format === 'txt') {
      text.value = await readAttachmentText(file, controller.signal)
    }
  } catch (cause) {
    if (!controller.signal.aborted)
      error.value = cause instanceof Error ? cause.message : '预览失败，仍可导出文件'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
})
onBeforeUnmount(() => {
  controller.abort()
  renderGeneration++
  rendering?.cancel()
  void loadingTask?.destroy()
  for (const url of urls) URL.revokeObjectURL(url)
})
</script>

<template>
  <div class="attachment-preview">
    <AttachmentFilePreview v-if="filePreview" :resource="resource" :active="active" />
    <p v-if="loading" role="status">正在读取…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="format === 'pdf'">
      <nav v-if="pageCount" class="attachment-preview__toolbar" aria-label="PDF 翻页">
        <button type="button" :disabled="loading || page <= 1" @click="turn(-1)">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button type="button" :disabled="loading || page >= pageCount" @click="turn(1)">
          下一页
        </button>
        <select
          aria-label="PDF 缩放"
          :value="zoom"
          :disabled="loading"
          @change="changeZoom(($event.target as HTMLSelectElement).value)"
        >
          <option :value="0.75">75%</option>
          <option :value="1">100%</option>
          <option :value="1.5">150%</option>
          <option :value="2">200%</option>
        </select>
      </nav>
      <canvas ref="canvas" :aria-label="`PDF 第 ${page} 页`"></canvas>
    </template>
    <iframe v-else-if="frame" title="Word 文档预览" sandbox="" :srcdoc="frame"></iframe>
    <template v-else-if="format === 'zip' && !loading && !error">
      <p>压缩包目录 · {{ directory.length }} 项</p>
      <ul class="attachment-directory">
        <li
          v-for="item in directory.slice((directoryPage - 1) * 100, directoryPage * 100)"
          :key="item.name"
        >
          <span>{{ item.name }}</span
          ><small>{{ formatBytes(item.size) }}</small>
        </li>
      </ul>
      <nav v-if="directory.length > 100" class="attachment-preview__toolbar" aria-label="目录翻页">
        <button type="button" :disabled="directoryPage === 1" @click="directoryPage--">
          上一页
        </button>
        <span>{{ directoryPage }} / {{ Math.ceil(directory.length / 100) }}</span>
        <button
          type="button"
          :disabled="directoryPage * 100 >= directory.length"
          @click="directoryPage++"
        >
          下一页
        </button>
      </nav>
    </template>
    <template v-else-if="format === 'markdown' && !loading && !error">
      <p class="attachment-preview__caption">Markdown · 只读</p>
      <!-- Only the allowlisted, sanitized Markdown enters this read-only surface. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <article class="attachment-markdown" aria-label="Markdown 文档预览" v-html="markdownHtml" />
    </template>
    <pre v-else-if="format === 'txt' || format === 'word'">{{ text }}</pre>
    <p v-else-if="!loading && !filePreview">此格式暂不支持预览，可导出后打开。</p>
  </div>
</template>
