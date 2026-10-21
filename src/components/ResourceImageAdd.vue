<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import type { ResourceGalleryQuality } from '../types/ResourceGallery'
const props = defineProps<{ busy?: boolean; multiple?: boolean }>()
const emit = defineEmits<{
  files: [files: File[], quality: ResourceGalleryQuality]
  url: [url: string, download: boolean, quality: ResourceGalleryQuality]
}>()
const input = useTemplateRef<HTMLInputElement>('input')
const mode = ref<'file' | 'url'>('file')
const pendingFiles = ref<File[]>([])
const url = ref('')
const download = ref(false)
const quality = ref<ResourceGalleryQuality>('original')
defineExpose({ hasDraft: computed(() => Boolean(url.value.trim() || pendingFiles.value.length)) })
function chooseFiles() {
  if (props.busy) return
  mode.value = 'file'
  input.value?.click()
}
function importFiles() {
  if (props.busy || !pendingFiles.value.length) return
  const selected = pendingFiles.value
  pendingFiles.value = []
  emit('files', selected, quality.value)
}
function files(event: Event) {
  const target = event.target as HTMLInputElement
  const selected = Array.from(target.files ?? [])
  target.value = ''
  if (selected.length && !props.busy) pendingFiles.value = selected
}
function addUrlOnEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  event.preventDefault()
  event.stopPropagation()
  if (!props.busy && url.value.trim()) emit('url', url.value, download.value, quality.value)
}
</script>
<template>
  <div class="resource-gallery__input">
    <div class="resource-gallery__sources" role="group" aria-label="导入方式">
      <button
        class="button"
        type="button"
        :disabled="busy"
        :aria-pressed="mode === 'file'"
        @click="chooseFiles"
      >
        本地图片
      </button>
      <button
        class="button"
        type="button"
        :disabled="busy"
        :aria-pressed="mode === 'url'"
        @click="mode = 'url'"
      >
        图片直链
      </button>
    </div>
    <input
      ref="input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
      :multiple="multiple"
      :disabled="busy"
      hidden
      @change="files"
    />
    <template v-if="mode === 'url'">
      <label class="field"
        ><span class="field__label">图片直链</span
        ><input
          v-model="url"
          type="url"
          class="field__control"
          inputmode="url"
          autocapitalize="off"
          :spellcheck="false"
          placeholder="https://…"
          :disabled="busy"
          @keydown.enter="addUrlOnEnter"
      /></label>
    </template>
    <div v-if="mode === 'file' || download" class="resource-gallery__bar">
      <label class="resource-gallery__quality">
        <span class="field__label">保存画质</span>
        <select v-model="quality" class="field__control" :disabled="busy">
          <option value="original">原图</option>
          <option value="thumbnail">缩略图</option>
        </select>
      </label>
      <button
        v-if="mode === 'file' && pendingFiles.length"
        class="button button--primary"
        type="button"
        :disabled="busy"
        @click="importFiles"
      >
        导入 {{ pendingFiles.length }} 张
      </button>
    </div>
    <div v-if="mode === 'url'" class="resource-gallery__bar">
      <label class="resource-gallery__check resource-gallery__title"
        ><input v-model="download" type="checkbox" :disabled="busy" />保存本地副本</label
      >
      <button
        class="button button--primary"
        type="button"
        :disabled="busy || !url.trim()"
        @click="emit('url', url, download, quality)"
      >
        {{ download ? '下载并添加' : '保存链接' }}
      </button>
    </div>
    <p
      v-if="(mode === 'file' || download) && quality === 'thumbnail'"
      class="resource-gallery__status"
    >
      仅保存最长边 640px 的图片，动图转静态
    </p>
  </div>
</template>
