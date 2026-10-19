<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { frontendWorkshopImageHostingService as hosting } from '../core/ImageAlbumContainer'
import { confirmAction } from '../composables/UseConfirmDialog'
import type {
  SelfHostedFilePage,
  SelfHostedFileType,
  SelfHostedRemoteFile,
} from '../services/FrontendWorkshopImageHostingService'

const props = withDefaults(defineProps<{ revision?: number; origin?: string }>(), {
  revision: 0,
  origin: '',
})
const activeOrigin = computed(() => {
  try {
    return new URL(props.origin).host
  } catch {
    return '当前图床'
  }
})
const page = ref<SelfHostedFilePage>({ files: [], directories: [], total: 0 })
const directory = ref('')
const search = ref('')
const type = ref<SelfHostedFileType | ''>('')
const recursive = ref(true)
const offset = ref(0)
const loading = ref(false)
const loaded = ref(false)
const deleting = ref('')
const error = ref('')
const notice = ref('')
const failedPreviews = ref(new Set<string>())
const lifetime = new AbortController()
let request: AbortController | undefined
let version = 0
let alive = true
const hasNext = computed(() => offset.value + 50 < page.value.total)
const pageCount = computed(() => Math.max(1, Math.ceil(page.value.total / 50)))
const breadcrumbs = computed(() =>
  directory.value
    .split('/')
    .filter(Boolean)
    .map((name, index, all) => ({ name, path: all.slice(0, index + 1).join('/') })),
)
const labels: Record<SelfHostedFileType, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  other: '文件',
}

async function load(reset = false): Promise<void> {
  if (deleting.value) return
  if (reset) offset.value = 0
  request?.abort()
  const current = new AbortController()
  request = current
  const id = ++version
  loading.value = true
  loaded.value = false
  failedPreviews.value.clear()
  error.value = ''
  notice.value = ''
  page.value = { files: [], directories: [], total: 0 }
  try {
    const result = await hosting.listSelfHosted({
      start: offset.value,
      directory: directory.value,
      search: search.value,
      type: type.value,
      recursive: recursive.value,
      signal: current.signal,
    })
    if (alive && id === version && !current.signal.aborted) {
      page.value = result
      loaded.value = true
    }
  } catch (cause) {
    if (alive && id === version && !current.signal.aborted)
      error.value = cause instanceof Error ? cause.message : '读取远端文件失败'
  } finally {
    if (alive && id === version) loading.value = false
  }
}

function openDirectory(path: string): void {
  directory.value = path
  void load(true)
}

function changePage(delta: number): void {
  offset.value = Math.max(0, offset.value + delta * 50)
  void load()
}

function selectPageInput(event: FocusEvent): void {
  ;(event.currentTarget as HTMLInputElement).select()
}

function goToPage(event: Event): void {
  const input = event.currentTarget as HTMLInputElement
  const current = Math.floor(offset.value / 50) + 1
  const requested = /^\d+$/u.test(input.value) ? Number(input.value) : Number.NaN
  if (!Number.isSafeInteger(requested) || requested < 1 || loading.value || deleting.value) {
    input.value = String(current)
    return
  }
  const target = Math.min(requested, pageCount.value)
  input.value = String(target)
  if (target === current) return
  offset.value = (target - 1) * 50
  void load()
}

function size(bytes: number | null): string {
  if (bytes === null) return '大小未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function copy(file: SelfHostedRemoteFile): Promise<void> {
  try {
    await navigator.clipboard.writeText(file.url)
    if (alive) notice.value = `已复制“${file.name}”的直链`
  } catch {
    if (alive) error.value = '无法写入剪贴板，请长按文件直链手动复制。'
  }
}

async function remove(file: SelfHostedRemoteFile): Promise<void> {
  if (loading.value || deleting.value) return
  deleting.value = file.fileId
  error.value = ''
  notice.value = ''
  const revision = props.revision
  try {
    const confirmed = await confirmAction(
      {
        title: '永久删除远端文件',
        message: `将从 ${file.managementOrigin} 永久删除“${file.fileId}”。所有引用该直链的地方都会失效；本地相册和资源文件不会删除。`,
        confirmLabel: '永久删除',
        danger: true,
        centered: true,
      },
      lifetime.signal,
    )
    if (!confirmed || !alive || revision !== props.revision) return
    await hosting.deleteSelfHosted({
      url: file.url,
      managementOrigin: file.managementOrigin,
      upstreamFileId: file.fileId,
    })
    if (!alive || revision !== props.revision) return
    page.value.files = page.value.files.filter((item) => item.fileId !== file.fileId)
    page.value.total = Math.max(0, page.value.total - 1)
    notice.value = `已删除“${file.name}”，本地文件保留。`
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : '远端删除失败'
  } finally {
    if (alive) {
      deleting.value = ''
      if (revision !== props.revision) void load(true)
    }
  }
}

watch(
  () => props.revision,
  () => {
    // A changed saved connection must not keep the previous host's file list.
    directory.value = ''
    page.value = { files: [], directories: [], total: 0 }
    request?.abort()
    version++
    void load(true)
  },
)
onMounted(() => void load())
onBeforeUnmount(() => {
  alive = false
  version++
  request?.abort()
  lifetime.abort()
})
</script>

<template>
  <section class="remote-files" aria-label="远端文件" :aria-busy="loading" data-srl-controls>
    <header class="remote-files__heading">
      <div>
        <h3>
          远端文件
          <small :title="activeOrigin">{{ activeOrigin }}</small>
        </h3>
      </div>
      <button
        class="remote-files__icon"
        type="button"
        aria-label="刷新远端文件"
        title="刷新"
        :disabled="loading || Boolean(deleting)"
        @click="load()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 7M4 12l3 7a7 7 0 0 0 12-3" />
        </svg>
      </button>
    </header>
    <form class="remote-files__search" role="search" @submit.prevent="load(true)">
      <input
        v-model="search"
        type="search"
        aria-label="搜索远端文件"
        placeholder="搜索文件名"
        :disabled="Boolean(deleting)"
      />
      <button
        class="remote-files__icon"
        type="submit"
        aria-label="搜索"
        title="搜索"
        :disabled="Boolean(deleting)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </svg>
      </button>
      <select
        v-model="type"
        aria-label="远端文件类型"
        :disabled="Boolean(deleting)"
        @change="load(true)"
      >
        <option value="">全部类型</option>
        <option value="image">图片</option>
        <option value="video">视频</option>
        <option value="audio">音频</option>
        <option value="other">其他文件</option>
      </select>
    </form>
    <div class="remote-files__location">
      <nav aria-label="远端目录">
        <button type="button" :disabled="Boolean(deleting)" @click="openDirectory('')">
          全部文件</button
        ><template v-for="crumb in breadcrumbs" :key="crumb.path"
          ><span aria-hidden="true">/</span
          ><button type="button" :disabled="Boolean(deleting)" @click="openDirectory(crumb.path)">
            {{ crumb.name }}
          </button></template
        >
      </nav>
      <label
        ><input
          v-model="recursive"
          type="checkbox"
          :disabled="Boolean(deleting)"
          @change="load(true)"
        />包含子目录</label
      >
    </div>
    <p v-if="error" class="remote-files__feedback" role="alert">{{ error }}</p>
    <p v-if="notice" class="remote-files__feedback" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取远端文件…</p>
    <template v-else-if="loaded">
      <div v-if="page.directories.length" class="remote-files__folders" aria-label="子目录">
        <button
          v-for="folder in page.directories"
          :key="folder"
          type="button"
          :disabled="Boolean(deleting)"
          @click="openDirectory(folder)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7h7l2 2h9v11H3ZM3 7V4h7l2 3" /></svg
          >{{ folder.split('/').at(-1) }}
        </button>
      </div>
      <p v-if="!page.files.length" class="remote-files__empty">
        {{
          search || type ? '没有符合条件的远端文件。' : '此页没有远端文件，可切换目录或返回上一页。'
        }}
      </p>
      <ul v-else class="remote-files__list">
        <li v-for="file in page.files" :key="file.fileId" class="remote-files__file">
          <a
            class="remote-files__preview"
            :href="file.url"
            target="_blank"
            rel="noopener noreferrer"
            :aria-label="`打开 ${file.name}`"
          >
            <img
              v-if="file.type === 'image' && !failedPreviews.has(file.fileId)"
              :src="file.url"
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="failedPreviews.add(file.fileId)"
            />
            <span v-else>{{ labels[file.type] }}</span>
          </a>
          <div class="remote-files__info">
            <strong :title="file.name">{{ file.name }}</strong>
            <small
              >{{ labels[file.type] }} · {{ size(file.sizeBytes)
              }}<template v-if="file.createdAt">
                · {{ new Date(file.createdAt).toLocaleDateString() }}</template
              ></small
            >
            <a :href="file.url" target="_blank" rel="noopener noreferrer" :title="file.url">{{
              file.managementOrigin + '/file/' + file.fileId
            }}</a>
          </div>
          <div class="remote-files__actions">
            <button
              class="remote-files__icon"
              type="button"
              :aria-label="`复制 ${file.name} 的直链`"
              title="复制直链"
              @click="copy(file)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 8h12v13H8ZM16 8V3H3v13h5" />
              </svg>
            </button>
            <button
              type="button"
              class="remote-files__icon remote-files__delete"
              title="删除远端文件"
              :aria-label="`删除 ${file.name}`"
              :disabled="Boolean(deleting)"
              @click="remove(file)"
            >
              <svg v-if="deleting !== file.fileId" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg
              ><span v-else aria-label="处理中">…</span>
            </button>
          </div>
        </li>
      </ul>
      <footer class="remote-files__pagination">
        <span>{{ page.total }} 个文件</span>
        <div>
          <button type="button" :disabled="!offset || Boolean(deleting)" @click="changePage(-1)">
            上一页
          </button>
          <label class="remote-files__jump">
            <input
              class="inline-page-jump"
              :style="{ width: `max(32px, ${String(Math.floor(offset / 50) + 1).length}ch)` }"
              :value="Math.floor(offset / 50) + 1"
              type="text"
              inputmode="numeric"
              :maxlength="String(pageCount).length"
              aria-label="跳转页码"
              :disabled="Boolean(deleting)"
              @focus="selectPageInput"
              @change="goToPage"
              @keydown.enter.prevent="goToPage"
            />
            / {{ pageCount }}
          </label>
          <button type="button" :disabled="!hasNext || Boolean(deleting)" @click="changePage(1)">
            下一页
          </button>
        </div>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.remote-files {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.remote-files__heading,
.remote-files__pagination,
.remote-files__location {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  flex-wrap: wrap;
}
.remote-files__heading > div {
  min-width: 0;
  flex: 1;
}
.remote-files h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  white-space: nowrap;
}
.remote-files h3 small {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  font-weight: 400;
  color: var(--color-ink-soft);
}
.remote-files button,
.remote-files select,
.remote-files input[type='search'] {
  min-height: 44px;
  font: inherit;
  font-size: 12px;
}
.remote-files button {
  padding: 0 8px;
  cursor: pointer;
}
.remote-files button:disabled {
  opacity: 0.4;
  cursor: default;
}
.remote-files .remote-files__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.remote-files__icon svg,
.remote-files__folders svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.remote-files__icon:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -4px;
}
.remote-files__search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 94px;
  align-items: center;
  gap: 2px;
}
.remote-files__search input {
  min-width: 0;
  width: 100%;
  padding: 0 9px;
}
.remote-files__search select {
  min-width: 0;
  width: 100%;
  padding: 0 4px;
}
.remote-files__location nav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  gap: 2px;
}
.remote-files__location nav button {
  max-width: 100%;
  overflow-wrap: anywhere;
  background: transparent;
  border: 0;
  box-shadow: none;
  padding: 0 4px;
  color: var(--color-accent);
}
.remote-files__location label {
  display: flex;
  align-items: center;
  min-height: 44px;
  gap: 4px;
  font-size: 11px;
}
.remote-files__location input {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
}
.remote-files__folders {
  display: flex;
  flex-wrap: wrap;
  column-gap: 8px;
  border-top: 1px solid var(--color-line);
}
.remote-files__folders button {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  overflow-wrap: anywhere;
  padding: 0 4px;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.remote-files__folders svg {
  flex: none;
}
.remote-files__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--color-line);
}
.remote-files__file {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 88px;
  gap: 8px;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid var(--color-line);
}
.remote-files__preview {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: 8px;
  color: var(--color-ink-soft);
  text-decoration: none;
  overflow: hidden;
  font-size: 11px;
}
.remote-files__preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.remote-files__info {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.remote-files__info strong,
.remote-files__info a,
.remote-files__info small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remote-files__info strong {
  font-size: 13px;
  font-weight: 650;
}
.remote-files__info small {
  color: var(--color-ink-soft);
  font-size: 11px;
}
.remote-files__info a {
  color: var(--color-accent);
  font-size: 11px;
  text-decoration: none;
}
.remote-files__actions {
  display: flex;
  gap: 0;
}
.remote-files__delete {
  color: var(--color-danger, var(--color-ink));
}
.remote-files__feedback {
  margin: 0;
  padding: 4px 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.remote-files__empty {
  padding: 12px 0;
  margin: 0;
  color: var(--color-ink-soft);
  font-size: 12px;
}
.remote-files__pagination {
  font-size: 11px;
  color: var(--color-ink-soft);
}
.remote-files__pagination > div {
  display: flex;
  gap: 4px;
}
.remote-files__jump {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 4px;
  cursor: text;
}
.remote-files__jump .inline-page-jump {
  flex: none;
  height: 28px;
  min-height: 28px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 12px;
  box-shadow: none;
}
.remote-files__pagination {
  justify-content: flex-end;
}
.remote-files__pagination > span {
  margin-right: auto;
}
@media (max-width: 350px) {
  .remote-files__file {
    gap: 5px;
  }
}
</style>
