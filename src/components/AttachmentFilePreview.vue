<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Resource } from '../types/Resource'
import {
  attachmentFormat,
  attachmentMediaType,
  attachmentTablePage,
  readAttachmentText,
} from '../services/AttachmentDocument'
import '../styles/ResourceAttachments.css'

const props = withDefaults(defineProps<{ resource: Resource; active?: boolean }>(), {
  active: true,
})
const format = attachmentFormat(props.resource.fileName)
const url = ref(''),
  text = ref(''),
  error = ref(''),
  loading = ref(true)
const media = ref<HTMLMediaElement>()
const imageWidth = ref(0),
  imageZoom = ref('fit')
const raw = ref(false),
  wrap = ref(false),
  page = ref(1)
const cursors = ref([0])
const copied = ref('')
const controller = new AbortController()
// The history panel hides its parent with v-show; hidden media must not keep playing.
watch(
  () => props.active,
  (active) => {
    if (active === false) media.value?.pause()
  },
)
const textPages = computed(() => Math.max(1, Math.ceil(text.value.length / 32768)))
// Keep surrogate pairs together across the bounded text pages.
function textBoundary(index: number) {
  const offset = Math.min(index * 32768, text.value.length)
  const code = text.value.charCodeAt(offset)
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset
}
const visibleText = computed(() =>
  text.value.slice(textBoundary(page.value - 1), textBoundary(page.value)),
)
const table = computed(() => {
  try {
    return {
      ...attachmentTablePage(
        text.value,
        /\.tsv$/iu.test(props.resource.fileName) ? '\t' : ',',
        cursors.value[page.value - 1],
      ),
      error: '',
    }
  } catch (cause) {
    return { rows: [], next: 0, hasMore: false, error: (cause as Error).message }
  }
})
const tableView = computed(() => format === 'table' && !raw.value)
function turn(offset: number) {
  if (tableView.value && offset > 0) cursors.value[page.value] = table.value.next
  page.value += offset
}
function toggleRaw() {
  raw.value = !raw.value
  page.value = 1
  cursors.value = [0]
}
async function copyText() {
  try {
    await navigator.clipboard.writeText(text.value)
    if (!controller.signal.aborted) copied.value = '已复制全文'
  } catch {
    if (!controller.signal.aborted) copied.value = '复制失败，可选中文本复制或从更多菜单导出'
  }
}
function mediaError() {
  error.value =
    media.value?.error?.code === 2
      ? '媒体读取失败，仍可从更多菜单导出后打开。'
      : '当前浏览器或系统无法播放此文件的格式或编码，仍可从更多菜单导出后打开。'
}
onMounted(async () => {
  try {
    const resource = props.resource
    if (['audio', 'video', 'image'].includes(format)) {
      // A typed Blob view keeps bytes local; no arrayBuffer, Base64 or transcoding.
      url.value = URL.createObjectURL(
        resource.originalBlob.slice(
          0,
          resource.originalBlob.size,
          attachmentMediaType(resource.fileName),
        ),
      )
    } else
      text.value = await readAttachmentText(
        new File([resource.originalBlob], resource.fileName),
        controller.signal,
      )
  } catch (cause) {
    if (!controller.signal.aborted) error.value = (cause as Error).message
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
})
onBeforeUnmount(() => {
  controller.abort()
  if (media.value) {
    media.value.pause()
    media.value.removeAttribute('src')
    media.value.load()
  }
  if (url.value) URL.revokeObjectURL(url.value)
})
</script>

<template>
  <div class="attachment-file-preview">
    <p v-if="loading" role="status">正在读取…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="url">
      <audio
        v-if="format === 'audio'"
        ref="media"
        :src="url"
        controls
        preload="metadata"
        aria-label="附件音频"
        @error="mediaError"
      />
      <video
        v-else-if="format === 'video'"
        ref="media"
        :src="url"
        controls
        playsinline
        preload="metadata"
        aria-label="附件视频"
        @error="mediaError"
      />
      <template v-else>
        <nav class="attachment-preview__toolbar" aria-label="图片工具">
          <label
            >缩放
            <select v-model="imageZoom" aria-label="图片缩放">
              <option value="fit">适应窗口</option>
              <option value="1">100%</option>
              <option value="2">200%</option>
            </select>
          </label>
          <span v-if="imageWidth">{{ imageWidth }} 像素宽</span>
        </nav>
        <div class="attachment-image" :class="{ 'attachment-image--fit': imageZoom === 'fit' }">
          <img
            :src="url"
            :alt="resource.fileName"
            :style="
              imageZoom === 'fit'
                ? undefined
                : { width: `${imageWidth * Number(imageZoom)}px`, maxWidth: 'none' }
            "
            @load="imageWidth = ($event.target as HTMLImageElement).naturalWidth"
            @error="error = '图片无法解码，仍可导出后打开。'"
          />
        </div>
      </template>
    </template>
    <template v-else-if="!loading && !error">
      <nav class="attachment-preview__toolbar" aria-label="文本工具">
        <span>只读</span>
        <button v-if="format === 'table'" type="button" @click="toggleRaw">
          {{ raw ? '表格视图' : '查看原文' }}
        </button>
        <button v-if="!tableView" type="button" :aria-pressed="wrap" @click="wrap = !wrap">
          自动换行
        </button>
        <button type="button" @click="copyText">复制全文</button>
        <div class="attachment-preview__paging" role="group" aria-label="文件翻页">
          <button type="button" :disabled="page === 1" @click="turn(-1)">上一页</button>
          <span>{{ page }}{{ tableView ? '' : ` / ${textPages}` }}</span>
          <button
            type="button"
            :disabled="tableView ? !table.hasMore : page >= textPages"
            @click="turn(1)"
          >
            下一页
          </button>
        </div>
      </nav>
      <p v-if="copied" role="status">{{ copied }}</p>
      <template v-if="tableView">
        <p v-if="table.error" role="alert">{{ table.error }}</p>
        <p v-else-if="!table.rows.length">空表格</p>
        <div
          v-else
          class="attachment-table"
          tabindex="0"
          role="region"
          aria-label="附件表格，可横向滚动"
        >
          <table>
            <tbody>
              <tr v-for="(row, index) in table.rows" :key="index">
                <th scope="row">{{ (page - 1) * 50 + index + 1 }}</th>
                <td v-for="(cell, column) in row" :key="column">
                  {{
                    cell.length > 2000 ? cell.slice(0, 2000) + '…（查看原文可读完整单元格）' : cell
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <pre
        v-else
        class="attachment-code"
        :class="{ 'attachment-code--wrap': wrap }"
        tabindex="0"
        aria-label="附件文本，只读"
      ><code>{{ visibleText || '空文件' }}</code></pre>
    </template>
  </div>
</template>
