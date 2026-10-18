<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import {
  frontendWorkshopImageHostingService,
  generatedImageAlbumService,
} from '../core/ImageAlbumContainer'
import type { FrontendWorkshopAssetLink } from '../types/FrontendWorkshopProject'
import type {
  GeneratedImageAlbumItem,
  GeneratedImageAlbumPage,
  GeneratedImageHostedStatus,
  GeneratedImageHostingMode,
} from '../types/GeneratedImageAlbum'
import FeatureAppHeader from './FeatureAppHeader.vue'

const emit = defineEmits<{
  close: []
  insertAsset: [asset: FrontendWorkshopAssetLink]
}>()

type PickerTab = 'album' | 'url'

const tab = ref<PickerTab>('album')
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
const category = ref('')
const mimeType = ref('')
const sort = ref<'newest' | 'oldest'>('newest')
const hostedStatus = ref<GeneratedImageHostedStatus>('all')
const loading = ref(false)
const busyId = ref('')
const error = ref('')
const notice = ref('')
const previewUrls = ref(new Map<string, string>())
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-image-picker-hosting-mode
const hostingMode = ref<GeneratedImageHostingMode>('self-hosted')
// SRL-PUBLIC-SYNC: END REPLACE id=generated-image-picker-hosting-mode
const selfHostedReady = ref(false)
const manualUrl = ref('')
const manualName = ref('')
let searchTimer: number | undefined
let loadGeneration = 0

const canUseSelfHosted = computed(() => selfHostedReady.value)

function revokePreviewUrls(): void {
  for (const url of previewUrls.value.values()) URL.revokeObjectURL(url)
  previewUrls.value = new Map()
}

async function buildPreviews(items: GeneratedImageAlbumItem[], generation: number): Promise<void> {
  const urls = new Map<string, string>()
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      if (!item) continue
      try {
        urls.set(
          item.id,
          URL.createObjectURL(await generatedImageAlbumService.getPreviewBlob(item.id)),
        )
      } catch {
        // 单张损坏不阻塞其余素材。
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()))
  if (generation !== loadGeneration) {
    for (const url of urls.values()) URL.revokeObjectURL(url)
    return
  }
  revokePreviewUrls()
  previewUrls.value = urls
}

async function loadPage(targetPage = 1): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  const generation = ++loadGeneration
  try {
    const result = await generatedImageAlbumService.list({
      search: search.value,
      category: category.value,
      mimeType: mimeType.value,
      sort: sort.value,
      hostedStatus: hostedStatus.value,
      page: targetPage,
      pageSize: page.value.pageSize,
    })
    if (generation !== loadGeneration) return
    page.value = result
    await buildPreviews(result.items, generation)
  } catch (cause) {
    if (generation === loadGeneration)
      error.value = cause instanceof Error ? cause.message : '生图相册暂时无法读取。'
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

function createAsset(name: string, url: string): FrontendWorkshopAssetLink {
  return {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 80) || '图片素材',
    url,
    createdAt: Date.now(),
  }
}

function insertHosted(item: GeneratedImageAlbumItem): void {
  if (!item.hostedUrl) return
  emit('insertAsset', createAsset(item.name, item.hostedUrl))
  notice.value = `已导入“${item.name}”的直链。`
}

async function hostAndInsert(item: GeneratedImageAlbumItem): Promise<void> {
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-image-picker-upload
  if (busyId.value) return
  busyId.value = item.id
  error.value = ''
  notice.value = ''
  try {
    if (hostingMode.value === 'self-hosted' && !canUseSelfHosted.value)
      throw new Error('尚未配置自建图床，请先在 AI 生图 APP 的“云端”页保存连接。')
    const blob = await generatedImageAlbumService.getOriginalBlob(item.id)
    const hosted = await frontendWorkshopImageHostingService.uploadBlobSelfHosted(blob, item.name)
    const updated = await generatedImageAlbumService.setHostedUrl(
      item.id,
      hosted,
      hostingMode.value,
    )
    emit('insertAsset', createAsset(updated.name, updated.hostedUrl!))
    notice.value = `已为“${item.name}”生成直链并导入。`
    await loadPage(page.value.page)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '生成直链失败。'
  } finally {
    busyId.value = ''
  }
  // SRL-PUBLIC-SYNC: END REPLACE id=generated-image-picker-upload
}

function insertManualUrl(): void {
  error.value = ''
  notice.value = ''
  let normalized: string
  try {
    const parsed = new URL(manualUrl.value.trim())
    if (parsed.protocol !== 'https:') throw new Error()
    normalized = parsed.toString()
  } catch {
    error.value = '请输入浏览器可直接访问的 HTTPS 图片直链。'
    return
  }
  emit('insertAsset', createAsset(manualName.value, normalized))
  notice.value = '图片直链已导入。'
}

function back(): void {
  if (tab.value === 'url') tab.value = 'album'
  else emit('close')
}

defineExpose({ back })

watch([category, mimeType, sort, hostedStatus], () => void loadPage(1))
watch(search, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void loadPage(1), 220)
})

onMounted(async () => {
  void loadPage(1)
  try {
    await frontendWorkshopImageHostingService.initializeCredentials()
    selfHostedReady.value = Boolean(
      frontendWorkshopImageHostingService.getSelfHostedConfiguration(),
    )
  } catch {
    error.value = '读取图床凭据失败，可重新打开图片选择器后再试。'
  }
})
onUnmounted(() => {
  window.clearTimeout(searchTimer)
  loadGeneration += 1
  revokePreviewUrls()
})
</script>

<template>
  <section
    class="frontend-image-picker mobile-dialog-viewport"
    data-srl-controls
    role="dialog"
    aria-modal="true"
    aria-label="图片素材"
  >
    <FeatureAppHeader
      layout="panel"
      title="图片素材"
      back-label="返回前端了么"
      @back="$emit('close')"
    >
    </FeatureAppHeader>

    <nav class="frontend-image-picker__tabs">
      <button type="button" :class="{ 'is-active': tab === 'album' }" @click="tab = 'album'">
        生图相册
      </button>
      <button type="button" :class="{ 'is-active': tab === 'url' }" @click="tab = 'url'">
        手动直链
      </button>
    </nav>

    <main v-if="tab === 'album'" class="frontend-image-picker__body">
      <section class="frontend-image-picker__toolbar">
        <input
          v-model="search"
          type="search"
          :placeholder="page.total ? `搜索 ${page.total} 张图片` : '搜索图片'"
        />
        <select v-model="category" aria-label="分类">
          <option value="">全部分类</option>
          <option v-for="item in page.categories" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="mimeType" aria-label="图片类型">
          <option value="">全部类型</option>
          <option v-for="item in page.mimeTypes" :key="item" :value="item">
            {{ item.replace('image/', '').toUpperCase() }}
          </option>
        </select>
        <select v-model="hostedStatus" aria-label="直链状态">
          <option value="all">全部状态</option>
          <option value="hosted">已有直链</option>
          <option value="local">仅本地</option>
        </select>
        <select v-model="sort" aria-label="排序">
          <option value="newest">最新</option>
          <option value="oldest">最早</option>
        </select>
      </section>

      <!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-image-picker-hosting-controls -->
      <p class="frontend-image-picker__hint">图片直链通过你自己配置的 ImgBed 生成。</p>
      <!-- SRL-PUBLIC-SYNC: END REPLACE id=generated-image-picker-hosting-controls -->

      <p v-if="loading" class="frontend-image-picker__state">正在读取生图相册…</p>
      <p v-else-if="!page.items.length" class="frontend-image-picker__state">
        当前筛选条件下没有图片。
      </p>
      <section v-else class="frontend-image-picker__grid">
        <article v-for="item in page.items" :key="item.id" class="frontend-image-picker__card">
          <div class="frontend-image-picker__thumb">
            <img
              v-if="previewUrls.get(item.id)"
              :src="previewUrls.get(item.id)"
              :alt="item.name"
              loading="lazy"
              decoding="async"
            />
            <span v-else>无预览</span>
            <em :class="{ 'is-hosted': Boolean(item.hostedUrl) }">{{
              item.hostedUrl ? '已有直链' : '仅本地'
            }}</em>
          </div>
          <div class="frontend-image-picker__copy">
            <strong>{{ item.name }}</strong>
            <small
              >{{ item.category || '未分类' }} ·
              {{ item.mimeType.replace('image/', '').toUpperCase() }}</small
            >
          </div>
          <button
            v-if="item.hostedUrl"
            type="button"
            class="frontend-image-picker__primary"
            @click="insertHosted(item)"
          >
            导入直链
          </button>
          <button
            v-else
            type="button"
            class="frontend-image-picker__primary"
            :disabled="Boolean(busyId)"
            @click="hostAndInsert(item)"
          >
            {{ busyId === item.id ? '生成直链中…' : '生成直链并导入' }}
          </button>
        </article>
      </section>

      <nav v-if="page.pageCount > 1" class="frontend-image-picker__pagination">
        <button type="button" :disabled="page.page <= 1" @click="loadPage(page.page - 1)">
          上一页
        </button>
        <span>{{ page.page }} / {{ page.pageCount }}</span>
        <button
          type="button"
          :disabled="page.page >= page.pageCount"
          @click="loadPage(page.page + 1)"
        >
          下一页
        </button>
      </nav>
    </main>

    <main v-else class="frontend-image-picker__manual">
      <label
        ><span>图片直链</span
        ><input v-model="manualUrl" type="url" placeholder="https://example.com/image.png"
      /></label>
      <label
        ><span>素材名称（可选）</span
        ><input v-model="manualName" type="text" placeholder="例如：雨夜背景"
      /></label>
      <div v-if="manualUrl" class="frontend-image-picker__manual-preview">
        <img :src="manualUrl" alt="直链预览" />
      </div>
      <button type="button" class="frontend-image-picker__primary" @click="insertManualUrl">
        使用此图片
      </button>
    </main>

    <p v-if="notice" class="frontend-image-picker__notice">{{ notice }}</p>
    <p v-if="error" class="frontend-image-picker__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped src="../styles/FrontendWorkshopImagePicker.css"></style>
