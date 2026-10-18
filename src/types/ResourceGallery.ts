export type GalleryCategoryCatalog = Partial<Record<import('./Resource').ResourceType, string[]>>
import type { ResourceReference } from './Resource'
import { includeResourceAttachmentIds } from './ResourceAttachment'

/** Images use the existing resource binary/backup/vault pipeline, like persona attachments. */
export const RESOURCE_GALLERY_ASSET_KIND = 'resource-gallery-image'

export type ResourceGalleryQuality = 'original' | 'thumbnail'

export function isResourceGalleryImage(resource: Pick<ResourceReference, 'metadata'>): boolean {
  return resource.metadata?.assetKind === RESOURCE_GALLERY_ASSET_KIND
}

export function galleryOwnerId(resource: Pick<ResourceReference, 'metadata'>): string {
  return isResourceGalleryImage(resource) && typeof resource.metadata.galleryOwnerId === 'string'
    ? resource.metadata.galleryOwnerId
    : ''
}

export function resourceCoverId(resource: Pick<ResourceReference, 'metadata'>): string {
  return typeof resource.metadata?.resourceCoverId === 'string'
    ? resource.metadata.resourceCoverId
    : ''
}

export function normalizeGalleryUrl(value: string): string {
  const raw = value.trim()
  if (!raw || raw.length > 2_000) throw new Error('请输入有效的图片直链（不超过 2000 字符）')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('请输入完整的 HTTPS 图片直链')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('图片直链必须使用 HTTPS，且不能含登录信息')
  }
  if (url.href.length > 2_000) throw new Error('图片直链过长，请使用较短的链接')
  return url.href
}

export function galleryImageUrl(resource: Pick<ResourceReference, 'metadata'>): string {
  if (!isResourceGalleryImage(resource) || resource.metadata.galleryStorage !== 'url') return ''
  try {
    return normalizeGalleryUrl(String(resource.metadata.galleryUrl ?? ''))
  } catch {
    return ''
  }
}

/** Always include a selected resource's cover, even when its gallery is unchecked. */
export function includeResourceGalleryIds<T extends Pick<ResourceReference, 'id' | 'metadata'>>(
  resources: readonly T[],
  selectedIds: Set<string>,
  includeGallery: boolean,
  includeAttachments = true,
  allowDetachedAttachments = false,
): void {
  includeResourceAttachmentIds(resources, selectedIds, includeAttachments, allowDetachedAttachments)
  const owners = new Map(resources.filter((r) => !isResourceGalleryImage(r)).map((r) => [r.id, r]))
  for (const image of resources) {
    if (!isResourceGalleryImage(image)) continue
    const owner = owners.get(galleryOwnerId(image))
    // Attachment IDs never grant access to an unselected owner's private gallery.
    selectedIds.delete(image.id)
    if (
      owner &&
      selectedIds.has(owner.id) &&
      (resourceCoverId(owner) === image.id ||
        (includeGallery && image.metadata.galleryVisible !== false))
    ) {
      selectedIds.add(image.id)
    }
  }
}

export function remapGalleryMetadata(
  metadata: Record<string, unknown>,
  ids: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const next = { ...metadata }
  for (const key of ['galleryOwnerId', 'resourceCoverId', 'attachmentOwnerId']) {
    if (typeof next[key] === 'string') next[key] = ids.get(next[key]) ?? next[key]
  }
  return next
}

export interface ResourceGalleryQuery {
  search?: string
  category?: string
  source?: '' | 'local' | 'url'
  sort?: 'newest' | 'oldest' | 'name'
  page?: number
  pageSize?: number
}
