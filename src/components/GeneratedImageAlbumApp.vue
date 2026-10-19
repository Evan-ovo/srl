<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { confirmAction } from '../composables/UseConfirmDialog'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import {
  frontendWorkshopImageHostingService,
  generatedImageAlbumService,
} from '../core/ImageAlbumContainer'
import { isNativeFileExportAvailable, saveBlobToNativeDestination } from '../core/NativeFileExport'
import type {
  GeneratedImageAlbumItem,
  GeneratedImageAlbumPage,
  GeneratedImageAlbumQuery,
  GeneratedImageHostedStatus,
  GeneratedImageHostingMode,
} from '../types/GeneratedImageAlbum'
import FeatureAppHeader from './FeatureAppHeader.vue'
import ImageHostingConnectionForm from './ImageHostingConnectionForm.vue'
import SelfHostedFileBrowser from './SelfHostedFileBrowser.vue'

defineEmits<{ back: [] }>()

const importInput = ref<HTMLInputElement>()
const page = ref<GeneratedImageAlbumPage>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 18,
  pageCount: 1,
  categories: [],
  mimeTypes: [],
})
const search = ref('')
const mimeType = ref('')
const category = ref('')
const hostedStatus = ref<GeneratedImageHostedStatus>('all')
const settingsOpen = ref(false)
const settingsMode = ref<'filters' | 'hosting'>('filters')
const hostingSettingsLoading = ref(false)
let settingsRequest = 0
let settingsReturnFocus: HTMLElement | undefined
const settingsButton = ref<HTMLButtonElement>()
const settingsPanel = ref<HTMLElement>()
const settingsInitialFocus = ref<HTMLElement>()
const statusOptions: { id: GeneratedImageHostedStatus; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'hosted', label: '已有直链' },
  { id: 'local', label: '仅本地' },
]
const sort = ref<'newest' | 'oldest'>('newest')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const previewUrls = ref(new Map<string, string>())
const selectedId = ref('')
const selectedUrl = ref('')
const detailCloseButton = ref<HTMLButtonElement>()
const detailName = ref('')
const detailCategory = ref('')
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-hosting-mode
const hostingMode = ref<GeneratedImageHostingMode>('self-hosted')
// SRL-PUBLIC-SYNC: END REPLACE id=generated-album-hosting-mode
const rememberedImageBed = frontendWorkshopImageHostingService.getSelfHostedConfiguration()
const selfHostedOrigin = ref(rememberedImageBed?.origin ?? '')
const selfHostedToken = ref(rememberedImageBed?.token ?? '')
const rememberSelfHosted = ref(rememberedImageBed?.remember ?? false)
const selfHostedReady = ref(Boolean(rememberedImageBed))
const selfHostedRevision = ref(0)
let searchTimer: number | undefined
let swipeStartX = 0
let detailTrigger: HTMLElement | null = null
const PREVIEW_CONCURRENCY = 4
let disposed = false
let detailRequest = 0
let preparingPreviewUrls: Map<string, string> | undefined
let pageRequest = 0
let requestedPage = 1
let pendingPage: { query: GeneratedImageAlbumQuery; request: number } | undefined
let pageLoad: Promise<void> | undefined

const selectedItem = computed(() => page.value.items.find((item) => item.id === selectedId.value))
const selectedIndex = computed(() =>
  page.value.items.findIndex((item) => item.id === selectedId.value),
)
const canShowPrevious = computed(() => selectedIndex.value > 0)
const canShowNext = computed(
  () => selectedIndex.value >= 0 && selectedIndex.value < page.value.items.length - 1,
)
const canSaveToPhone = computed(() => isNativeFileExportAvailable())

function revokeUrls(urls: Map<string, string>): void {
  urls.forEach((url) => URL.revokeObjectURL(url))
  urls.clear()
}

function revokePreviewUrls(): void {
  revokeUrls(previewUrls.value)
  previewUrls.value = new Map()
}

function revokeSelectedUrl(): void {
  detailRequest++
  if (selectedUrl.value) URL.revokeObjectURL(selectedUrl.value)
  selectedUrl.value = ''
}

async function loadPreviewUrls(
  items: GeneratedImageAlbumItem[],
  current: () => boolean,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  preparingPreviewUrls = urls
  let nextIndex = 0
  const worker = async () => {
    while (current() && nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      if (!item) continue
      try {
        const blob = await generatedImageAlbumService.getPreviewBlob(item.id)
        if (current()) urls.set(item.id, URL.createObjectURL(blob))
      } catch {
        // 单张损坏时保留其他图片可用，卡片会显示占位信息。
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PREVIEW_CONCURRENCY, items.length) }, () => worker()),
  )
  if (preparingPreviewUrls === urls) preparingPreviewUrls = undefined
  return urls
}

function loadPage(targetPage = requestedPage): Promise<void> {
  if (disposed) return Promise.resolve()
  requestedPage = targetPage
  pendingPage = {
    request: ++pageRequest,
    query: {
      search: search.value,
      mimeType: mimeType.value,
      category: category.value,
      hostedStatus: hostedStatus.value,
      sort: sort.value,
      page: targetPage,
      pageSize: page.value.pageSize,
    },
  }
  if (preparingPreviewUrls) revokeUrls(preparingPreviewUrls)
  error.value = ''
  if (!pageLoad) {
    loading.value = true
    pageLoad = Promise.resolve().then(async () => {
      try {
        while (!disposed && pendingPage) {
          const next = pendingPage
          pendingPage = undefined
          await loadPageRequest(next.query, next.request)
        }
      } finally {
        pageLoad = undefined
        loading.value = false
      }
    })
  }
  return pageLoad
}

async function loadPageRequest(query: GeneratedImageAlbumQuery, request: number): Promise<void> {
  const current = () => !disposed && request === pageRequest
  try {
    if (searchTimer !== undefined && search.value === query.search) {
      window.clearTimeout(searchTimer)
      searchTimer = undefined
    }
    const result = await generatedImageAlbumService.list(query)
    if (!current()) return
    const urls = await loadPreviewUrls(result.items, current)
    if (!current()) {
      revokeUrls(urls)
      return
    }
    const previousUrls = previewUrls.value
    previewUrls.value = urls
    page.value = result
    requestedPage = result.page
    revokeUrls(previousUrls)
    if (selectedId.value && !result.items.some((item) => item.id === selectedId.value))
      closeDetail()
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : '相册暂时无法读取'
  }
}

async function openDetail(item: GeneratedImageAlbumItem, event?: MouseEvent): Promise<void> {
  if (disposed) return
  const trigger = event?.currentTarget
  if (trigger instanceof HTMLElement) detailTrigger = trigger
  revokeSelectedUrl()
  const request = detailRequest
  selectedId.value = item.id
  detailName.value = item.name
  detailCategory.value = item.category
  try {
    const blob = await generatedImageAlbumService.getOriginalBlob(item.id)
    if (disposed || request !== detailRequest) return
    selectedUrl.value = URL.createObjectURL(blob)
    await nextTick()
    if (!disposed && request === detailRequest)
      detailCloseButton.value?.focus({ preventScroll: true })
  } catch (cause) {
    if (!disposed && request === detailRequest)
      error.value = cause instanceof Error ? cause.message : '原图暂时无法打开'
  }
}

function closeDetail(): void {
  selectedId.value = ''
  revokeSelectedUrl()
  const trigger = detailTrigger
  detailTrigger = null
  if (trigger?.isConnected) void nextTick(() => trigger.focus({ preventScroll: true }))
}

async function importImages(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || busy.value) return
  busy.value = true
  error.value = ''
  let imported = 0
  try {
    for (const file of files) {
      await generatedImageAlbumService.importFile(file, category.value)
      imported += 1
    }
    notice.value = `已导入 ${imported} 张图片。`
    await loadPage(1)
  } catch (cause) {
    error.value = `${imported ? `已导入 ${imported} 张；` : ''}${cause instanceof Error ? cause.message : '导入失败'}`
  } finally {
    busy.value = false
  }
}

async function saveDetails(): Promise<void> {
  const item = selectedItem.value
  if (!item || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await generatedImageAlbumService.updateDetails(item.id, detailName.value, detailCategory.value)
    notice.value = '图片名称和分类已保存。'
    await loadPage()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    busy.value = false
  }
}

function extensionFor(item: GeneratedImageAlbumItem): string {
  return item.mimeType === 'image/jpeg' ? 'jpg' : item.mimeType.split('/')[1] || 'png'
}

async function saveToPhone(item: GeneratedImageAlbumItem): Promise<void> {
  if (!canSaveToPhone.value) {
    error.value = '当前不是支持原生相册写入的 Android APP，没有执行普通下载替代。'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const blob = await generatedImageAlbumService.getOriginalBlob(item.id)
    await saveBlobToNativeDestination(blob, `${item.name}.${extensionFor(item)}`, 'pictures')
    notice.value = '原图已保存到手机相册的 Pictures/SRL。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存到手机相册失败'
  } finally {
    busy.value = false
  }
}

async function convertToUrl(item: GeneratedImageAlbumItem): Promise<void> {
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-upload-flow
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const blob = await generatedImageAlbumService.getOriginalBlob(item.id)
    const hosted = await frontendWorkshopImageHostingService.uploadBlobSelfHosted(blob, item.name)
    await generatedImageAlbumService.setHostedUrl(item.id, hosted, hostingMode.value)
    notice.value = '图片已转成稳定 HTTPS 直链，并记录在相册中。'
    await loadPage(page.value.page)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '转直链失败'
  } finally {
    busy.value = false
  }
  // SRL-PUBLIC-SYNC: END REPLACE id=generated-album-upload-flow
}

async function copyUrl(item: GeneratedImageAlbumItem): Promise<void> {
  if (!item.hostedUrl) return
  try {
    await navigator.clipboard.writeText(item.hostedUrl)
    notice.value = '直链已复制。'
  } catch {
    error.value = '系统拒绝读取剪贴板，请长按直链手动复制。'
  }
}

async function deleteSelfHostedCopy(item: GeneratedImageAlbumItem): Promise<void> {
  if (!item.hostedUrl || item.hostingMode !== 'self-hosted' || busy.value) return
  const confirmed = await confirmAction({
    title: '永久删除自建图床文件',
    message:
      '将从你自己的 ImgBed 永久删除这张远端图片，当前直链会立即失效且无法恢复；资源库里的本地原图仍会保留。',
    confirmLabel: '永久删除图床文件',
    danger: true,
  })
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await frontendWorkshopImageHostingService.deleteSelfHosted({
      url: item.hostedUrl,
      managementOrigin: item.hostedOrigin,
      upstreamFileId: item.hostedFileId,
    })
    await generatedImageAlbumService.clearHostedUrl(item.id)
    notice.value = '自建图床文件已永久删除，本地原图仍保留在相册。'
    await loadPage()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '自建图床删除失败'
  } finally {
    busy.value = false
  }
}

async function deleteItem(item: GeneratedImageAlbumItem): Promise<void> {
  const confirmed = await confirmAction({
    title: '删除本地相册图片',
    message: item.hostedUrl
      ? '只删除资源库里的原图与记录；已经上传到图床的文件和直链不会被删除。'
      : '将删除资源库里的原图与记录，无法恢复。',
    confirmLabel: '删除本地图片',
    danger: true,
  })
  if (!confirmed) return
  busy.value = true
  try {
    await generatedImageAlbumService.delete(item.id)
    closeDetail()
    notice.value = '本地相册图片已删除。'
    await loadPage()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败'
  } finally {
    busy.value = false
  }
}

async function saveSelfHostedConnection(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const saved = await frontendWorkshopImageHostingService.saveSelfHostedConfiguration({
      origin: selfHostedOrigin.value,
      token: selfHostedToken.value,
      remember: rememberSelfHosted.value,
    })
    selfHostedOrigin.value = saved.origin
    selfHostedToken.value = saved.token
    selfHostedReady.value = true
    selfHostedRevision.value++
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '自建图床连接无效'
  } finally {
    busy.value = false
  }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

function formatType(value: string): string {
  return value.replace('image/', '').replace('jpeg', 'jpg').toUpperCase()
}

function showSibling(offset: number): void {
  const next = page.value.items[selectedIndex.value + offset]
  if (next) void openDetail(next)
}

function startSwipe(event: TouchEvent): void {
  swipeStartX = event.touches[0]?.clientX ?? 0
}

function endSwipe(event: TouchEvent): void {
  const delta = (event.changedTouches[0]?.clientX ?? swipeStartX) - swipeStartX
  if (Math.abs(delta) >= 48) showSibling(delta < 0 ? 1 : -1)
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || (!settingsOpen.value && !selectedItem.value)) return
  event.preventDefault()
  event.stopPropagation()
  if (settingsOpen.value) closeSettings()
  else closeDetail()
}

async function openSettings(
  mode: 'filters' | 'hosting' = 'filters',
  opener: HTMLElement | undefined = settingsButton.value,
): Promise<void> {
  if (!settingsOpen.value) settingsReturnFocus = opener
  settingsMode.value = mode
  settingsOpen.value = true
  const request = ++settingsRequest
  hostingSettingsLoading.value = mode === 'hosting'
  void nextTick(() => settingsInitialFocus.value?.focus({ preventScroll: true }))
  if (mode !== 'hosting') return
  error.value = ''
  notice.value = ''
  try {
    await frontendWorkshopImageHostingService.initializeCredentials()
    if (disposed || request !== settingsRequest || !settingsOpen.value) return
    const config = frontendWorkshopImageHostingService.getSelfHostedConfiguration()
    selfHostedOrigin.value = config?.origin ?? ''
    selfHostedToken.value = config?.token ?? ''
    rememberSelfHosted.value = config?.remember ?? false
    selfHostedReady.value = Boolean(config)
  } catch (cause) {
    if (!disposed && request === settingsRequest)
      error.value = cause instanceof Error ? cause.message : '读取自建图床连接失败'
  } finally {
    if (request === settingsRequest) hostingSettingsLoading.value = false
  }
}

function closeSettings(): void {
  settingsOpen.value = false
  settingsRequest++
  void nextTick(() => (settingsReturnFocus ?? settingsButton.value)?.focus({ preventScroll: true }))
}

function selectHostedStatus(status: GeneratedImageHostedStatus): void {
  hostedStatus.value = status
  closeSettings()
}

function keepSettingsFocus(event: KeyboardEvent): void {
  const buttons = Array.from(
    settingsPanel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary',
    ) ?? [],
  ).filter((element) => {
    const collapsed = element.closest('details:not([open])')
    return !collapsed || collapsed.querySelector('summary') === element
  })
  const index = buttons.findIndex((button) => button === document.activeElement)
  event.preventDefault()
  buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
}

function handleSettingsBack(event: Event): void {
  if (!settingsOpen.value) return
  const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
  if (detail.handled) return
  detail.handled = true
  event.stopImmediatePropagation()
  closeSettings()
}

watch([mimeType, category, sort, hostedStatus], () => void loadPage(1))
watch(search, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined
    void loadPage(1)
  }, 220)
})

onMounted(async () => {
  document.addEventListener('keydown', handleEscape)
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleSettingsBack, true)
  await loadPage(1)
  if (disposed) return
})

onUnmounted(() => {
  disposed = true
  pendingPage = undefined
  document.removeEventListener('keydown', handleEscape)
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleSettingsBack, true)
  window.clearTimeout(searchTimer)
  if (preparingPreviewUrls) revokeUrls(preparingPreviewUrls)
  revokePreviewUrls()
  revokeSelectedUrl()
})
</script>

<template>
  <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-page-root -->
  <section
    v-if="settingsOpen && settingsMode === 'hosting'"
    ref="settingsInitialFocus"
    class="generated-album generated-album__hosting-page"
    tabindex="-1"
    aria-label="自建图床"
    data-srl-controls
  >
    <FeatureAppHeader title="自建图床" back-label="返回相册" @back="closeSettings" />
    <main class="generated-album__hosting-content">
      <p v-if="hostingSettingsLoading" role="status">正在读取本机图床连接…</p>
      <details :open="!selfHostedReady" class="generated-album__connection">
        <summary>连接设置</summary>
        <ImageHostingConnectionForm
          v-model:origin="selfHostedOrigin"
          v-model:token="selfHostedToken"
          v-model:remember="rememberSelfHosted"
          :connected="selfHostedReady"
          :busy="hostingSettingsLoading || busy"
          @submit="saveSelfHostedConnection"
        />
      </details>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="notice" role="status">{{ notice }}</p>
      <SelfHostedFileBrowser
        v-if="selfHostedReady && !hostingSettingsLoading"
        :revision="selfHostedRevision"
        :origin="frontendWorkshopImageHostingService.getSelfHostedConfiguration()?.origin ?? ''"
      />
    </main>
  </section>
  <section
    v-show="!(settingsOpen && settingsMode === 'hosting')"
    class="generated-album"
    data-srl-controls
  >
    <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-album-page-root -->
    <FeatureAppHeader title="生图相册" @back="$emit('back')">
      <template #actions>
        <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-shared-hosting-entry -->
        <button
          class="feature-header-action"
          type="button"
          aria-label="自建图床设置"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen && settingsMode === 'hosting'"
          :disabled="busy"
          @click="openSettings('hosting', $event.currentTarget as HTMLElement)"
        >
          自建图床
        </button>
        <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-album-shared-hosting-entry -->
        <button
          ref="settingsButton"
          class="feature-header-action feature-header-action--icon"
          type="button"
          aria-label="相册设置"
          title="相册设置"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen"
          @click="openSettings()"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4 7h3m6 0h7M4 17h7m6 0h3" />
            <circle cx="10" cy="7" r="3" />
            <circle cx="14" cy="17" r="3" />
          </svg>
        </button>
      </template>
    </FeatureAppHeader>
    <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-settings-presentation -->
    <Teleport to="body">
      <div
        v-if="settingsOpen && settingsMode === 'filters'"
        class="generated-album__settings-backdrop"
        role="presentation"
        @click.self="closeSettings"
      >
        <section
          ref="settingsPanel"
          class="generated-album__settings"
          data-srl-controls
          data-srl-dialog
          role="dialog"
          aria-modal="true"
          aria-label="相册设置"
          @keydown.tab="keepSettingsFocus"
        >
          <header>
            <h2>相册设置</h2>
            <button
              ref="settingsInitialFocus"
              type="button"
              aria-label="关闭相册设置"
              @click="closeSettings"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
            </button>
          </header>
          <button type="button" @click="openSettings('hosting')">自建图床连接</button>
          <p>直链状态</p>
          <div class="generated-album__status-options">
            <button
              v-for="option in statusOptions"
              :key="option.id"
              type="button"
              :aria-pressed="hostedStatus === option.id"
              :disabled="loading"
              @click="selectHostedStatus(option.id)"
            >
              <span>{{ option.label }}</span>
              <svg v-if="hostedStatus === option.id" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m5 12 4 4L19 6" />
              </svg>
            </button>
          </div>
        </section>
      </div>
    </Teleport>
    <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-album-settings-presentation -->

    <section class="generated-album__toolbar" aria-label="查找和导入图片">
      <label class="generated-album__search">
        <span class="generated-album__sr-only">搜索</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          v-model="search"
          type="search"
          :placeholder="page.total ? `搜索 ${page.total} 张图片` : '搜索图片'"
        />
      </label>
      <button
        class="generated-album__import"
        type="button"
        :disabled="busy"
        @click="importInput?.click()"
      >
        <span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 16V4m0 0L8 8m4-4 4 4" />
            <path d="M5 13v6h14v-6" />
          </svg>
          导入
        </span>
      </button>
      <input
        ref="importInput"
        class="generated-album__file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        @change="importImages"
      />
      <div class="generated-album__filters">
        <label>
          <span class="generated-album__sr-only">保存时间排序</span>
          <select v-model="sort" aria-label="保存时间排序">
            <option value="newest">最新</option>
            <option value="oldest">最早</option>
          </select>
        </label>
        <label>
          <span class="generated-album__sr-only">图片类型</span>
          <select v-model="mimeType" aria-label="图片类型">
            <option value="">格式</option>
            <option v-for="type in page.mimeTypes" :key="type" :value="type">
              {{ formatType(type) }}
            </option>
          </select>
        </label>
        <label>
          <span class="generated-album__sr-only">自定义分类</span>
          <select v-model="category" aria-label="自定义分类">
            <option value="">分类</option>
            <option v-for="item in page.categories" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
    </section>

    <template v-if="!(settingsOpen && settingsMode === 'hosting')">
      <p v-if="error" class="generated-album__message is-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="generated-album__message" role="status">{{ notice }}</p>
    </template>

    <Teleport to="body">
      <div
        v-if="selectedItem"
        class="generated-album__detail-backdrop mobile-dialog-viewport"
        @click.self="closeDetail"
      >
        <section
          class="generated-album__detail"
          data-srl-controls
          data-srl-dialog
          role="dialog"
          aria-modal="true"
          aria-labelledby="generated-album-detail-title"
          @touchstart.passive="startSwipe"
          @touchend.passive="endSwipe"
        >
          <header class="generated-album__detail-bar">
            <button
              ref="detailCloseButton"
              type="button"
              aria-label="关闭图片详情"
              @click="closeDetail"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
            <span>
              <strong id="generated-album-detail-title">{{ selectedItem.name }}</strong>
              <small
                >{{ selectedIndex + 1 }} / {{ page.items.length }} ·
                {{ formatType(selectedItem.mimeType) }}</small
              >
            </span>
            <button type="button" :disabled="busy" @click="saveDetails">保存</button>
          </header>

          <div class="generated-album__detail-body">
            <div class="generated-album__viewer">
              <button
                type="button"
                aria-label="上一张"
                :disabled="!canShowPrevious"
                @click="showSibling(-1)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg>
              </button>
              <img v-if="selectedUrl" :src="selectedUrl" :alt="selectedItem.name" />
              <button
                type="button"
                aria-label="下一张"
                :disabled="!canShowNext"
                @click="showSibling(1)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>
              </button>
            </div>

            <div class="generated-album__detail-copy">
              <div class="generated-album__edit-fields">
                <label><span>名称</span><input v-model="detailName" maxlength="100" /></label>
                <label
                  ><span>分类</span
                  ><input v-model="detailCategory" maxlength="40" placeholder="背景 / 角色 / 装饰"
                /></label>
              </div>
              <small class="generated-album__date"
                >保存于 {{ formatDate(selectedItem.createdAt) }}</small
              >
              <details v-if="selectedItem.prompt" class="generated-album__prompt">
                <summary>生成提示词与参数</summary>
                <p>{{ selectedItem.prompt }}</p>
                <code>{{ JSON.stringify(selectedItem.generationParameters, null, 2) }}</code>
              </details>
              <div v-if="selectedItem.hostedUrl" class="generated-album__url">
                <span>当前直链</span>
                <a :href="selectedItem.hostedUrl" target="_blank" rel="noopener">{{
                  selectedItem.hostedUrl
                }}</a>
                <button type="button" @click="copyUrl(selectedItem)">复制</button>
              </div>
              <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-hosting-controls -->
              <div class="generated-album__hosting">
                <span>直链来源</span>
                <span>我的 ImgBed</span>
              </div>
              <ImageHostingConnectionForm
                v-model:origin="selfHostedOrigin"
                v-model:token="selfHostedToken"
                v-model:remember="rememberSelfHosted"
                :connected="selfHostedReady"
                :busy="busy"
                @submit="saveSelfHostedConnection"
              />
              <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-album-hosting-controls -->
              <div class="generated-album__actions">
                <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-album-create-link-button -->
                <button
                  type="button"
                  :disabled="busy || !canSaveToPhone"
                  @click="saveToPhone(selectedItem)"
                >
                  存手机
                </button>
                <button
                  type="button"
                  :disabled="busy || !selfHostedReady"
                  @click="convertToUrl(selectedItem)"
                >
                  {{ selectedItem.hostedUrl ? '更新直链' : '转成直链' }}
                </button>
                <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-album-create-link-button -->
                <button
                  v-if="selectedItem.hostedUrl && selectedItem.hostingMode === 'self-hosted'"
                  type="button"
                  class="is-danger"
                  :disabled="busy"
                  @click="deleteSelfHostedCopy(selectedItem)"
                >
                  删除图床文件
                </button>
                <button
                  type="button"
                  class="is-danger"
                  :disabled="busy"
                  @click="deleteItem(selectedItem)"
                >
                  删除本地
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Teleport>

    <section v-if="page.items.length" class="generated-album__grid" aria-label="图片列表">
      <button
        v-for="item in page.items"
        :key="item.id"
        type="button"
        :class="{ 'is-selected': item.id === selectedId }"
        :aria-label="`打开图片：${item.name}`"
        @click="openDetail(item, $event)"
      >
        <span class="generated-album__thumb">
          <img
            v-if="previewUrls.get(item.id)"
            :src="previewUrls.get(item.id)"
            :alt="item.name"
            loading="lazy"
          />
          <small v-else>预览不可用</small>
          <i>{{ item.hostedUrl ? '已有直链' : '仅本地' }}</i>
        </span>
        <span class="generated-album__caption">
          <strong>{{ item.name }}</strong>
          <small>{{ formatType(item.mimeType) }} · {{ item.category || '未分类' }}</small>
        </span>
      </button>
    </section>
    <section v-else class="generated-album__empty">
      <strong>{{ loading ? '正在整理相册…' : '这里还没有图片' }}</strong>
      <p>生图时勾选“保存到资源库相册”，或从手机手动导入图片。</p>
      <button type="button" :disabled="busy" @click="importInput?.click()">导入图片</button>
    </section>

    <nav v-if="page.pageCount > 1" class="generated-album__pagination" aria-label="相册分页">
      <button type="button" :disabled="page.page <= 1 || loading" @click="loadPage(page.page - 1)">
        上一页
      </button>
      <span>{{ page.page }} / {{ page.pageCount }}</span>
      <button
        type="button"
        :disabled="page.page >= page.pageCount || loading"
        @click="loadPage(page.page + 1)"
      >
        下一页
      </button>
    </nav>
  </section>
</template>

<style scoped src="../styles/GeneratedImageAlbumApp.css"></style>

<style scoped>
.generated-album__settings-backdrop {
  position: fixed;
  z-index: 260;
  inset: 0;
  display: grid;
  box-sizing: border-box;
  padding: max(1rem, var(--safe-top)) max(1rem, var(--safe-right)) max(1rem, var(--safe-bottom))
    max(1rem, var(--safe-left));
  place-items: center;
  background: var(--overlay-background);
}

.generated-album__settings {
  box-sizing: border-box;
  width: min(100%, 20rem);
  max-height: 100%;
  overflow: auto;
  padding: 0.75rem;
  border-radius: var(--dialog-radius, var(--glass-radius-panel));
  color: var(--color-ink);
}

.generated-album__settings--hosting {
  width: min(100%, 52rem);
}

.generated-album__settings--hosting > header {
  position: sticky;
  top: -0.75rem;
  z-index: 1;
  margin: -0.75rem -0.75rem 0;
  padding: 0.75rem;
  background: var(--color-surface-raised);
}

.generated-album__connection {
  margin: 0.4rem 0 0.8rem;
  border-bottom: 1px solid var(--color-line);
}

.generated-album__connection > summary {
  min-height: 44px;
  padding: 0.65rem 0.25rem;
  cursor: pointer;
  font-size: var(--text-body);
}

.generated-album__settings header,
.generated-album__settings button {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.generated-album__settings h2 {
  margin: 0 0 0 0.5rem;
  font-size: var(--text-title-sm);
}

.generated-album__settings p {
  margin: 0.25rem 0.5rem 0.5rem;
  color: var(--color-ink-soft);
  font-size: var(--text-caption);
}

.generated-album__settings button {
  min-height: var(--size-touch);
  padding: 0 0.75rem;
  font: inherit;
  cursor: pointer;
}

.generated-album__settings header button {
  width: var(--size-touch);
  justify-content: center;
}

.generated-album__settings svg {
  width: var(--icon-sm);
  height: var(--icon-sm);
  fill: none;
  stroke: currentColor;
  stroke-width: var(--icon-stroke);
  stroke-linecap: round;
  stroke-linejoin: round;
}

.generated-album__status-options {
  display: grid;
  gap: 0.25rem;
}

.generated-album__settings button:hover,
.generated-album__settings button[aria-pressed='true'] {
  color: var(--selection-color, var(--color-accent));
  background: var(--selection-background, var(--color-accent-soft));
}
/* SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-self-hosted-full-page */
.generated-album__hosting-page {
  display: flex;
  flex-direction: column;
  height: var(--app-viewport-height, 100dvh);
  min-height: 0;
  overflow: hidden;
  outline: none;
}
.generated-album__hosting-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 0.5rem max(0.5rem, var(--safe-bottom));
}
.generated-album__hosting-content > p {
  margin: 4px 0;
  font-size: 12px;
  color: var(--color-ink-soft);
}
/* SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-self-hosted-full-page */
</style>
