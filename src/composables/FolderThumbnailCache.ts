import type { InjectionKey } from 'vue'
import type { ResourceSummary } from '../types/Resource'

type Source = Pick<ResourceSummary, 'contentHash' | 'thumbnailAssetId' | 'thumbnailBlob'>
type Entry = {
  source: Source
  bytes: number
  native: boolean
  url: string
  users: number
  retained: boolean
}

function matches(a: Source, b: Source): boolean {
  return (
    a.contentHash === b.contentHash &&
    a.thumbnailAssetId === b.thumbnailAssetId &&
    a.thumbnailBlob === b.thumbnailBlob
  )
}

// The feature desktop owns this cache, not the database or the whole library.
// 96 recent thumbnails cover several cabinet pages; compressed bytes stop at 8 MiB.
export function createFolderThumbnailCache(maxEntries = 96, maxBytes = 8 * 1024 * 1024) {
  const entries = new Map<string, Entry>()
  let bytes = 0
  function discard(id: string, entry: Entry) {
    entries.delete(id)
    bytes -= entry.bytes
    entry.retained = false
    if (!entry.users && !entry.native) URL.revokeObjectURL(entry.url)
  }
  return {
    acquire(source: ResourceSummary, image?: Blob | string) {
      let entry = entries.get(source.id)
      if (entry && !matches(entry.source, source)) {
        discard(source.id, entry)
        entry = undefined
      }
      if (!entry) {
        if (!image) return undefined
        const size = typeof image === 'string' ? 0 : image.size
        if (size <= maxBytes)
          for (const [id, candidate] of entries) {
            if (entries.size < maxEntries && bytes + size <= maxBytes) break
            if (!candidate.users) discard(id, candidate)
          }
        const retained = entries.size < maxEntries && bytes + size <= maxBytes
        entry = {
          source: {
            contentHash: source.contentHash,
            thumbnailAssetId: source.thumbnailAssetId,
            thumbnailBlob: source.thumbnailBlob,
          },
          bytes: size,
          native: typeof image === 'string',
          url: typeof image === 'string' ? image : URL.createObjectURL(image),
          users: 0,
          retained,
        }
        if (retained) {
          entries.set(source.id, entry)
          bytes += size
        }
      } else {
        entries.delete(source.id)
        entries.set(source.id, entry)
      }
      const acquired = entry
      acquired.users++
      let released = false
      return {
        url: acquired.url,
        native: acquired.native,
        release() {
          if (released) return
          released = true
          acquired.users--
          if (!acquired.retained && !acquired.users && !acquired.native)
            URL.revokeObjectURL(acquired.url)
        },
      }
    },
    invalidate(source: ResourceSummary, url: string) {
      const entry = entries.get(source.id)
      if (entry?.url === url && matches(entry.source, source)) discard(source.id, entry)
    },
    prune(resources: readonly ResourceSummary[]) {
      const current = new Map(resources.map((resource) => [resource.id, resource]))
      for (const [id, entry] of entries) {
        const source = current.get(id)
        if (!source || !matches(entry.source, source)) discard(id, entry)
      }
    },
    clear() {
      for (const [id, entry] of entries) discard(id, entry)
    },
  }
}

export const folderThumbnailCacheKey: InjectionKey<ReturnType<typeof createFolderThumbnailCache>> =
  Symbol('folder-thumbnail-cache')
