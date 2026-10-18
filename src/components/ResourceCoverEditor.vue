<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Resource } from '../types/Resource'
import { RESOURCE_TYPE, RESOURCE_TYPE_LABELS } from '../types/Resource'
import { galleryImageUrl, resourceCoverId, normalizeGalleryUrl } from '../types/ResourceGallery'
import { resourceGalleryService as gallery } from '../core/AppContainer'
import { nativeFileSource } from '../core/NativeFileSource'
import { useLoadedObjectUrl } from '../composables/UseLoadedObjectUrl'
import ResourceImageViewer from './ResourceImageViewer.vue'
import '../styles/ResourceGallery.css'
const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ saved: [resource: Resource] }>()
const viewing = ref(false),
  busy = ref(false),
  failed = ref(false)
const error = ref('')
const originalSource = ref<string>()
defineExpose({
  busy,
  editing: computed(() => viewing.value),
  requestBack: closeViewer,
  restoreDefault: () => save((owner) => gallery.restoreDefaultCover(owner)),
})
const { previewUrl, replacePreview, confirmPreviewLoaded } = useLoadedObjectUrl()
let generation = 0
let mounted = true

function closeViewer() {
  viewing.value = false
}
function openOriginal() {
  if (viewing.value || busy.value || !previewUrl.value || failed.value) return
  viewing.value = true
  error.value = ''
}
watch(
  [
    () => props.resource.id,
    () => props.resource.contentHash,
    () => resourceCoverId(props.resource),
    () => props.resource.type,
    () => props.resource.mimeType,
    () => !resourceCoverId(props.resource) && props.resource.thumbnailAssetId,
    () =>
      !resourceCoverId(props.resource) &&
      !props.resource.thumbnailAssetId &&
      props.resource.thumbnailBlob,
    () => !resourceCoverId(props.resource) && props.resource.metadata.phoneIconUrl,
  ],
  async () => {
    const token = ++generation,
      resource = props.resource
    closeViewer()
    originalSource.value = undefined
    failed.value = false
    error.value = ''
    replacePreview('')
    try {
      const cover = resourceCoverId(resource)
      if (cover) {
        const image = await gallery.getImage(resource.id, cover)
        if (token !== generation) return
        const url = galleryImageUrl(image)
        originalSource.value = !url ? nativeFileSource(image.originalBlob) : undefined
        replacePreview(url || URL.createObjectURL(image.originalBlob))
      } else if (
        resource.type === RESOURCE_TYPE.CHARACTER_CARD &&
        resource.mimeType.startsWith('image/')
      ) {
        originalSource.value = nativeFileSource(resource.originalBlob)
        replacePreview(URL.createObjectURL(resource.originalBlob))
      } else if (resource.thumbnailBlob) {
        replacePreview(URL.createObjectURL(resource.thumbnailBlob))
      } else if (resource.type === RESOURCE_TYPE.POCKET_PHONE && resource.metadata.phoneIconUrl) {
        replacePreview(normalizeGalleryUrl(String(resource.metadata.phoneIconUrl)))
      }
    } catch (cause) {
      if (token === generation)
        error.value = cause instanceof Error ? cause.message : '封面加载失败'
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
  mounted = false
  closeViewer()
})
async function save(operation: (owner: string) => Promise<Resource>) {
  if (busy.value) return
  const owner = props.resource.id
  busy.value = true
  error.value = ''
  try {
    const saved = await operation(owner)
    if (mounted && props.resource.id === owner) {
      emit('saved', saved)
    }
  } catch (cause) {
    if (mounted && props.resource.id === owner)
      error.value = cause instanceof Error ? cause.message : '封面更新失败'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <button
    class="resource-cover"
    type="button"
    aria-label="查看封面原图"
    :aria-busy="busy"
    :disabled="busy || !previewUrl || failed"
    @click="openOriginal"
  >
    <img
      v-if="previewUrl && !failed"
      :src="previewUrl"
      :alt="`${resource.name} 封面`"
      referrerpolicy="no-referrer"
      @load="confirmPreviewLoaded"
      @error="failed = true"
    />
    <span v-if="!previewUrl || failed">{{ RESOURCE_TYPE_LABELS[resource.type] }}</span>
  </button>
  <p v-if="error" class="resource-gallery__status resource-gallery__error" role="alert">
    {{ error }}
  </p>
  <ResourceImageViewer
    v-if="viewing && previewUrl"
    cover
    :src="previewUrl"
    :native-source="originalSource"
    :name="resource.name"
    @close="closeViewer"
    @loaded="confirmPreviewLoaded"
  />
</template>
