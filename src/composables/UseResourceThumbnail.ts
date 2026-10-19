import { onMounted, onScopeDispose, shallowRef, watch, type Ref } from 'vue'

import { assetStore, resourceGalleryService } from '../core/AppContainer'
import { galleryOwnerId, isResourceGalleryImage, resourceCoverId } from '../types/ResourceGallery'
import type { ResourceReference } from '../types/Resource'

const nearViewport = new Map<Element, (near: boolean) => void>()
let visibilityObserver: IntersectionObserver | undefined
const resizeCallbacks = new Map<Element, () => void>()
let thumbnailResizeObserver: ResizeObserver | undefined
const readQueue: Array<{ read: () => Promise<void>; priority?: () => number }> = []
let activeReads = 0
let drainScheduled = false
function scheduleReads(): void {
  if (drainScheduled) return
  drainScheduled = true
  queueMicrotask(drainReads)
}
function drainReads(): void {
  drainScheduled = false
  // Read geometry once per drain, never on a scroll listener or every animation frame.
  const priorities = new Map(readQueue.map((entry) => [entry, entry.priority?.() ?? 1]))
  readQueue.sort((a, b) => priorities.get(b)! - priorities.get(a)!)
  while (activeReads < 4 && readQueue.length) {
    const { read } = readQueue.shift()!
    activeReads++
    void read().finally(() => {
      activeReads--
      scheduleReads()
    })
  }
}

export function enqueueThumbnailRead(
  read: () => Promise<void>,
  priority?: () => number,
): () => void {
  const entry = { read, priority }
  readQueue.push(entry)
  scheduleReads()
  return () => {
    const index = readQueue.indexOf(entry)
    if (index >= 0) readQueue.splice(index, 1)
  }
}

export interface NativeThumbnailDisplay {
  url: Ref<string>
  failedUrl: Ref<string>
}

export function thumbnailLevelForDisplay(
  width: number,
  height: number,
  density: number,
): 'card' | 'preview' {
  return width > 0 &&
    height > 0 &&
    Number.isFinite(density) &&
    density > 0 &&
    Math.ceil(Math.max(width, height) * density) <= 320
    ? 'card'
    : 'preview'
}

export function useResourceThumbnail(
  source: () => ResourceReference | undefined,
  host?: Readonly<Ref<Element | null>>,
  remoteCoverUrl?: Ref<string>,
  nativeDisplay?: NativeThumbnailDisplay,
): Ref<Blob | undefined> {
  const thumbnail = shallowRef<Blob | undefined>(source()?.thumbnailBlob)
  const ready = shallowRef(!host)
  const displayLevel = shallowRef<'card' | 'preview'>('preview')
  let resizeTarget: Element | undefined
  let generation = 0
  let cancelRead: (() => void) | undefined
  let observedHost: Element | undefined
  let failedAssetId = ''
  function cancelQueued(): void {
    generation++
    cancelRead?.()
    cancelRead = undefined
  }
  function stopObserving(): void {
    if (!observedHost) return
    nearViewport.delete(observedHost)
    visibilityObserver?.unobserve(observedHost)
    observedHost = undefined
  }
  function readPriority(): number {
    const rect = host?.value?.getBoundingClientRect()
    if (!rect) return 1
    const height = window.innerHeight
    return rect.bottom > 0 && rect.top < height
      ? 3
      : rect.bottom > -300 && rect.top < height + 300
        ? 2
        : 0
  }
  if (host)
    onMounted(() => {
      if (!host.value) {
        ready.value = true
        return
      }
      if (nativeDisplay && assetStore.supportsImageUrls) {
        resizeTarget = host.value.querySelector('.resource-card__preview') ?? host.value
        const updateLevel = () => {
          if (!assetStore.supportsImageUrls) return
          const rect = resizeTarget!.getBoundingClientRect()
          displayLevel.value = thumbnailLevelForDisplay(
            rect.width,
            rect.height,
            window.devicePixelRatio,
          )
        }
        updateLevel()
        if (typeof ResizeObserver === 'function') {
          thumbnailResizeObserver ??= new ResizeObserver((entries) => {
            for (const entry of entries) resizeCallbacks.get(entry.target)?.()
          })
          resizeCallbacks.set(resizeTarget, updateLevel)
          thumbnailResizeObserver.observe(resizeTarget)
        }
      }
      if (typeof IntersectionObserver !== 'function') {
        ready.value = true
        return
      }
      visibilityObserver ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) nearViewport.get(entry.target)?.(entry.isIntersecting)
        },
        { rootMargin: '300px' },
      )
      observedHost = host.value
      nearViewport.set(host.value, (near) => {
        ready.value = near
      })
      visibilityObserver.observe(host.value)
    })
  onScopeDispose(() => {
    cancelQueued()
    stopObserving()
    if (resizeTarget) {
      resizeCallbacks.delete(resizeTarget)
      thumbnailResizeObserver?.unobserve(resizeTarget)
    }
    if (!resizeCallbacks.size) {
      thumbnailResizeObserver?.disconnect()
      thumbnailResizeObserver = undefined
    }
    if (!nearViewport.size) {
      visibilityObserver?.disconnect()
      visibilityObserver = undefined
    }
  })

  watch(
    () => {
      const resource = source()
      return {
        resource,
        blob: resource?.thumbnailBlob,
        assetId: resource?.thumbnailAssetId,
        contentHash: resource?.contentHash,
        ready: ready.value,
        coverId: resource ? resourceCoverId(resource) : '',
        failedUrl: nativeDisplay?.failedUrl.value,
        level: displayLevel.value,
      }
    },
    ({ resource, blob, assetId, ready, coverId, failedUrl, level }, previous) => {
      const sameImage = Boolean(
        !coverId &&
        previous &&
        previous.resource?.id === resource?.id &&
        previous.blob === blob &&
        previous.assetId === assetId &&
        previous.contentHash === resource?.contentHash &&
        previous.level === level &&
        !previous.coverId,
      )
      const nativeFailed = Boolean(
        sameImage &&
        failedUrl !== previous?.failedUrl &&
        nativeDisplay?.url.value &&
        failedUrl === nativeDisplay.url.value,
      )
      if (
        !nativeFailed &&
        sameImage &&
        (thumbnail.value instanceof Blob || nativeDisplay?.url.value)
      )
        return
      if (!sameImage) failedAssetId = ''
      if (nativeFailed) failedAssetId = assetId ?? ''
      cancelQueued()
      const currentGeneration = generation
      if (!ready) return
      if (remoteCoverUrl) remoteCoverUrl.value = ''
      if (nativeDisplay) nativeDisplay.url.value = ''
      thumbnail.value = blob
      if (
        !resource ||
        (!coverId && (blob instanceof Blob || (!assetId && !isResourceGalleryImage(resource))))
      ) {
        stopObserving()
        return
      }
      const read = async () => {
        if (currentGeneration !== generation) return
        stopObserving()
        try {
          if (coverId) {
            const cover = await resourceGalleryService.getImagePreview(resource.id, coverId)
            if (currentGeneration !== generation) return
            if (remoteCoverUrl) remoteCoverUrl.value = cover.url
            thumbnail.value = cover.blob
            return
          }
          if (assetId && nativeDisplay && failedAssetId !== assetId) {
            const url = await assetStore.getImageUrl(assetId, level)
            if (currentGeneration !== generation) return
            if (url) {
              nativeDisplay.url.value = url
              return
            }
          }
          let preview = assetId
            ? { blob: await assetStore.getBlob(assetId), url: '' }
            : await resourceGalleryService.getImagePreview(galleryOwnerId(resource), resource.id)
          if (currentGeneration !== generation) return
          // Cloud descriptors can retain a thumbnail asset ID from the former device.
          // Repair through the existing gallery owner, inside the same visible-image queue.
          if (assetId && !preview.blob && isResourceGalleryImage(resource))
            preview = await resourceGalleryService.getImagePreview(
              galleryOwnerId(resource),
              resource.id,
            )
          if (currentGeneration === generation) {
            thumbnail.value = preview.blob
            if (remoteCoverUrl) remoteCoverUrl.value = preview.url
          }
        } catch {
          // A missing cover must not prevent browsing or surface as an unhandled app error.
        }
      }
      cancelRead = enqueueThumbnailRead(read, readPriority)
    },
    { immediate: true },
  )

  return thumbnail
}
