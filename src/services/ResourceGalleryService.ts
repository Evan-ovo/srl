import type { ResourceGalleryCategoryStorage } from '../storage/ResourceGalleryCategoryStorage'
import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import {
  RESOURCE_GALLERY_ASSET_KIND,
  galleryOwnerId,
  isResourceGalleryImage,
  normalizeGalleryUrl,
  resourceCoverId,
  type ResourceGalleryQuery,
  type ResourceGalleryQuality,
} from '../types/ResourceGallery'
import { createImageThumbnail } from '../utils/createImageThumbnail'
import { hashBlob } from './HashService'

function categories(values: readonly string[]): string[] {
  return [...new Set(values.map((s) => s.trim().slice(0, 60)).filter(Boolean))].slice(0, 32)
}

/** Merge/move images before removing a resource so its gallery survives version consolidation. */
export async function moveResourceGallery(
  storage: ResourceStorageAdapter,
  from: string,
  to: string,
  snapshot?: ResourceSummary[],
): Promise<void> {
  const summaries =
    snapshot ??
    (await (storage.listGalleryListSummaries?.(from) ??
      storage.listResourceListSummaries?.() ??
      storage.listSummaries()))
  for (const summary of summaries) {
    if (galleryOwnerId(summary) !== from) continue
    const image = await storage.get(summary.id)
    if (!image) continue
    const changes = {
      metadata: { ...image.metadata, galleryOwnerId: to, galleryVisible: true },
      updatedAt: Date.now(),
    }
    if (storage.updateMetadata) await storage.updateMetadata(image.id, changes)
    else await storage.update(image.id, changes)
  }
}

export class ResourceGalleryService {
  private readonly categoryStorage?: ResourceGalleryCategoryStorage
  private readonly storage: ResourceStorageAdapter
  private readonly imports = new Map<string, Promise<Resource>>()
  constructor(storage: ResourceStorageAdapter, categoryStorage?: ResourceGalleryCategoryStorage) {
    this.storage = storage
    this.categoryStorage = categoryStorage
  }

  private summaries(): Promise<ResourceSummary[]> {
    return this.storage.listResourceListSummaries?.() ?? this.storage.listSummaries()
  }

  private async imagesOfType(ownerId: string, requireOwner = false): Promise<ResourceSummary[]> {
    if (this.storage.listGalleryListSummaries) {
      const owner = await (this.storage.getSummary?.(ownerId) ?? this.storage.get(ownerId))
      if (!owner || isResourceGalleryImage(owner)) {
        if (requireOwner) throw new Error('资源已经不存在，请返回资源库')
        return []
      }
      return this.storage.listGalleryListSummaries(ownerId, true)
    }
    const summaries = await this.summaries()
    const owner = summaries.find((r) => r.id === ownerId && !isResourceGalleryImage(r))
    if (!owner) {
      if (requireOwner) throw new Error('资源已经不存在，请返回资源库')
      return []
    }
    const owners = new Set(
      summaries.filter((r) => !isResourceGalleryImage(r) && r.type === owner.type).map((r) => r.id),
    )
    return summaries.filter((r) => isResourceGalleryImage(r) && owners.has(galleryOwnerId(r)!))
  }

  async list(ownerId: string, query: ResourceGalleryQuery = {}) {
    const all = await this.imagesOfType(ownerId)
    const owner = this.categoryStorage
      ? await (this.storage.getSummary?.(ownerId) ?? this.storage.get(ownerId))
      : undefined
    const savedCategories = owner ? await this.categoryStorage!.list(owner.type) : []
    const owned = all.filter(
      (r) => galleryOwnerId(r) === ownerId && r.metadata.galleryVisible !== false,
    )
    const search = query.search?.trim().toLocaleLowerCase()
    const filtered = owned
      .filter(
        (r) =>
          (!search || `${r.name}\n${r.description}`.toLocaleLowerCase().includes(search)) &&
          (!query.category ||
            (query.category === '__unclassified__'
              ? !r.tags.length
              : r.tags.includes(query.category))) &&
          (!query.source || r.metadata.galleryStorage === query.source),
      )
      .sort((a, b) =>
        query.sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : query.sort === 'oldest'
            ? a.createdAt - b.createdAt || a.id.localeCompare(b.id)
            : b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      )
    const pageSize = Math.max(1, Math.min(60, Math.floor(query.pageSize || 30)))
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
    const page = Math.max(1, Math.min(pageCount, Math.floor(query.page || 1)))
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      galleryCount: owned.length,
      page,
      pageCount,
      categories: [...new Set(owned.flatMap((r) => r.tags))].sort((a, b) =>
        a.localeCompare(b, 'zh-CN'),
      ),
      availableCategories: [...new Set([...savedCategories, ...all.flatMap((r) => r.tags)])].sort(
        (a, b) => a.localeCompare(b, 'zh-CN'),
      ),
    }
  }

  /** Export plans visible image attachments without loading unrelated image bodies. */
  async listExportImages(ownerId: string): Promise<ResourceSummary[]> {
    return (await this.imagesOfType(ownerId)).filter(
      (image) => galleryOwnerId(image) === ownerId && image.metadata.galleryVisible !== false,
    )
  }

  private async owner(id: string): Promise<Resource> {
    const owner = await this.storage.get(id)
    if (!owner || isResourceGalleryImage(owner)) throw new Error('资源已经不存在，请返回资源库')
    return owner
  }

  private async requireOwner(id: string): Promise<void> {
    const owner = await (this.storage.getSummary?.(id) ?? this.storage.get(id))
    if (!owner || isResourceGalleryImage(owner)) throw new Error('资源已经不存在，请返回资源库')
  }

  async getImage(ownerId: string, imageId: string): Promise<Resource> {
    const image = await this.storage.get(imageId)
    if (!image || galleryOwnerId(image) !== ownerId)
      throw new Error('这张图片已移除或不属于当前资源')
    if (!image.thumbnailBlob && image.metadata.galleryStorage === 'local') {
      const thumbnailBlob = await createImageThumbnail(image.originalBlob, {
        allowImageElement: true,
      })
      if (thumbnailBlob) {
        if (this.storage.updateMetadata)
          await this.storage.updateMetadata(image.id, { thumbnailBlob })
        else await this.storage.update(image.id, { thumbnailBlob })
        return { ...image, thumbnailBlob }
      }
    }
    return image
  }

  async addFile(
    ownerId: string,
    file: File,
    tags: string[] = [],
    visible = true,
    quality: ResourceGalleryQuality = 'original',
  ): Promise<Resource> {
    if (!file.size) throw new Error('图片文件为空')
    if (file.type && !/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(file.type))
      throw new Error('请选择 PNG、JPEG、WebP、GIF、AVIF 或 BMP 图片')
    const thumbnailBlob = await createImageThumbnail(file, { allowImageElement: true })
    if (!thumbnailBlob) throw new Error('无法读取图片，请选择有效的 PNG、JPEG、WebP 或 GIF 图片')
    if (quality === 'thumbnail') {
      // Canvas may fall back to PNG on platforms without a WebP encoder.
      const extension = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[
        thumbnailBlob.type
      ]
      if (!extension) throw new Error('无法保存缩略图，请改用原图')
      const name = `${file.name.replace(/\.[^.]+$/, '') || '图片'}-缩略图.${extension}`
      file = new File([thumbnailBlob], name, { type: thumbnailBlob.type })
    }
    return this.storeImage(ownerId, file, thumbnailBlob, tags, visible, undefined, quality)
  }

  async addUrl(
    ownerId: string,
    input: string,
    download: boolean,
    tags: string[] = [],
    visible = true,
    quality: ResourceGalleryQuality = 'original',
  ): Promise<Resource> {
    const url = normalizeGalleryUrl(input)
    if (download) {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) throw new Error(`图片下载失败（${response.status}），尚未保存本地副本`)
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) throw new Error('链接返回的不是图片，尚未保存本地副本')
      const name = new URL(url).pathname.split('/').pop() || '链接图片'
      return this.addFile(
        ownerId,
        new File([blob], name, { type: blob.type }),
        tags,
        visible,
        quality,
      )
    }
    // A link is a small portable document; never pretend it is a downloaded image.
    const file = new File([JSON.stringify({ version: 1, imageUrl: url })], '图片直链.json', {
      type: 'application/json',
    })
    return this.storeImage(ownerId, file, undefined, tags, visible, url)
  }

  private async storeImage(
    ownerId: string,
    file: File,
    thumbnailBlob: Blob | undefined,
    tags: string[],
    visible: boolean,
    url?: string,
    quality?: ResourceGalleryQuality,
  ): Promise<Resource> {
    const previous = this.imports.get(ownerId)
    const pending = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.persistImage(ownerId, file, thumbnailBlob, tags, visible, url, quality),
    )
    this.imports.set(ownerId, pending)
    try {
      return await pending
    } finally {
      if (this.imports.get(ownerId) === pending) this.imports.delete(ownerId)
    }
  }

  private async persistImage(
    ownerId: string,
    file: File,
    thumbnailBlob: Blob | undefined,
    tags: string[],
    visible: boolean,
    url?: string,
    quality?: ResourceGalleryQuality,
  ): Promise<Resource> {
    await this.requireOwner(ownerId)
    const hash = await hashBlob(file)
    const existing = this.storage.findGalleryImage
      ? await this.storage.findGalleryImage(ownerId, hash)
      : (await this.summaries()).find(
          (r) => galleryOwnerId(r) === ownerId && r.contentHash === hash,
        )
    if (existing) {
      const image = await this.getImage(ownerId, existing.id)
      const metadata = {
        ...image.metadata,
        galleryVisible: visible || image.metadata.galleryVisible !== false,
      }
      const changes = {
        tags: categories([...image.tags, ...tags]),
        metadata,
        updatedAt: Date.now(),
      }
      if (this.storage.updateMetadata) await this.storage.updateMetadata(image.id, changes)
      else await this.storage.update(image.id, changes)
      return this.getImage(ownerId, image.id)
    }
    const now = Date.now()
    // Deterministic IDs also prevent duplicate records when two tabs import the same image.
    const id = `gallery-${await hashBlob(new Blob([JSON.stringify([ownerId, hash])]))}`
    const image: Resource = {
      id,
      type: RESOURCE_TYPE.OTHER,
      name: url ? new URL(url).pathname.split('/').pop() || '链接图片' : file.name,
      description: '',
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
      contentHash: hash,
      favorite: false,
      categoryId: null,
      categoryIds: [],
      tags: categories(tags),
      metadata: {
        assetKind: RESOURCE_GALLERY_ASSET_KIND,
        galleryOwnerId: ownerId,
        galleryImageIdentity: id,
        galleryVisible: visible,
        galleryStorage: url ? 'url' : 'local',
        ...(quality ? { galleryQuality: quality } : {}),
        ...(url ? { galleryUrl: url } : {}),
      },
      originalBlob: file,
      thumbnailBlob,
      createdAt: now,
      updatedAt: now,
    }
    await this.storage.save(image)
    // A resource can be deleted in another window while image decoding/persistence is pending.
    try {
      await this.requireOwner(ownerId)
    } catch (cause) {
      await this.storage.delete(image.id)
      throw cause
    }
    return image
  }

  async edit(
    ownerId: string,
    id: string,
    values: { name: string; description: string; tags: string[] },
  ): Promise<void> {
    const image = await this.getImage(ownerId, id)
    const name = values.name.trim()
    if (!name) throw new Error('请输入图片名称')
    const changes = {
      name: name.slice(0, 160),
      description: values.description.slice(0, 5_000),
      tags: categories(values.tags),
      updatedAt: Date.now(),
    }
    if (this.storage.updateMetadata) await this.storage.updateMetadata(image.id, changes)
    else await this.storage.update(image.id, changes)
  }

  async setCategories(
    ownerId: string,
    ids: string[],
    tags: string[],
    append = false,
  ): Promise<void> {
    for (const id of new Set(ids)) {
      const image = await this.getImage(ownerId, id)
      await this.edit(ownerId, id, {
        name: image.name,
        description: image.description,
        tags: append ? [...image.tags, ...tags] : tags,
      })
    }
  }

  async createCategory(ownerId: string, name: string): Promise<string> {
    const value = name.trim()
    if (!value || value.length > 60 || value === '__unclassified__')
      throw new Error('请输入 1–60 字的分类名称')
    const owner = await (this.storage.getSummary?.(ownerId) ?? this.storage.get(ownerId))
    if (!owner || isResourceGalleryImage(owner)) throw new Error('资源已经不存在')
    if (!this.categoryStorage) throw new Error('分类存储尚未初始化')
    await this.categoryStorage.change(owner.type, (current) => [...current, value])
    return value
  }

  exportCategories() {
    return this.categoryStorage?.export() ?? Promise.resolve({})
  }
  async importCategories(value: unknown) {
    await this.categoryStorage?.import(value)
  }

  async renameCategory(ownerId: string, from: string, to: string): Promise<void> {
    const owner = await this.owner(ownerId)
    const replacement = to.trim().slice(0, 60)
    for (const image of (await this.imagesOfType(ownerId, true)).filter((r) =>
      r.tags.includes(from),
    )) {
      const changes = {
        tags: categories(
          image.tags.flatMap((tag) => (tag === from ? (replacement ? [replacement] : []) : [tag])),
        ),
        updatedAt: Date.now(),
      }
      if (this.storage.updateMetadata) await this.storage.updateMetadata(image.id, changes)
      else await this.storage.update(image.id, changes)
    }
    await this.categoryStorage?.change(owner.type, (current) =>
      current.flatMap((name) => (name === from ? (replacement ? [replacement] : []) : [name])),
    )
  }

  async setCover(ownerId: string, id: string): Promise<Resource> {
    const owner = await this.owner(ownerId)
    await this.getImage(ownerId, id)
    const changes = { metadata: { resourceCoverId: id }, updatedAt: Date.now() }
    if (this.storage.updateMetadata) await this.storage.updateMetadata(ownerId, changes)
    else
      await this.storage.update(ownerId, {
        ...changes,
        metadata: { ...owner.metadata, ...changes.metadata },
      })
    const previousId = resourceCoverId(owner)
    if (previousId && previousId !== id) {
      const previous = await this.storage.get(previousId)
      if (
        previous &&
        galleryOwnerId(previous) === ownerId &&
        previous.metadata.galleryVisible === false
      )
        await this.storage.delete(previousId)
    }
    return this.owner(ownerId)
  }

  async restoreDefaultCover(ownerId: string): Promise<Resource> {
    const owner = await this.owner(ownerId)
    const oldId = resourceCoverId(owner)
    const metadata = { resourceCoverId: undefined }
    if (this.storage.updateMetadata)
      await this.storage.updateMetadata(ownerId, { metadata, updatedAt: Date.now() })
    else
      await this.storage.update(ownerId, {
        metadata: { ...owner.metadata, ...metadata },
        updatedAt: Date.now(),
      })
    if (oldId) {
      const previous = await this.storage.get(oldId)
      if (
        previous &&
        galleryOwnerId(previous) === ownerId &&
        previous.metadata.galleryVisible === false
      )
        await this.storage.delete(oldId)
    }
    return this.owner(ownerId)
  }

  async remove(ownerId: string, ids: string[]): Promise<void> {
    const owner = await this.owner(ownerId)
    for (const id of new Set(ids)) {
      const image = await this.getImage(ownerId, id)
      if (resourceCoverId(owner) === id) {
        const changes = {
          metadata: { ...image.metadata, galleryVisible: false },
          updatedAt: Date.now(),
        }
        if (this.storage.updateMetadata) await this.storage.updateMetadata(id, changes)
        else await this.storage.update(id, changes)
      } else await this.storage.delete(id)
    }
  }
}
