import type { FrontendWorkshopGeneratedImage } from './FrontendWorkshopImageGenerationService'
import type { GeneratedImageAlbumStorage } from '../storage/GeneratedImageAlbumStorage'
import type {
  GeneratedImageAlbumItem,
  GeneratedImageAlbumPage,
  GeneratedImageAlbumQuery,
  GeneratedImageHostingMode,
} from '../types/GeneratedImageAlbum'
import { createImageThumbnail } from '../utils/createImageThumbnail'

const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024
const DEFAULT_PAGE_SIZE = 18
const MAX_PAGE_SIZE = 48

function cleanName(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]/gu, '-')
      .slice(0, 100) || fallback
  )
}

function mimeTypeForFile(file: File): string {
  if (SUPPORTED_MIME_TYPES.has(file.type)) return file.type
  const extension = file.name.split('.').pop()?.toLocaleLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return file.type
}

function validateBlob(blob: Blob, mimeType = blob.type): void {
  if (!SUPPORTED_MIME_TYPES.has(mimeType))
    throw new Error('相册目前支持 PNG、JPG、WebP 和 GIF 图片')
  if (blob.size < 1) throw new Error('图片文件是空的')
  if (blob.size > MAX_LOCAL_IMAGE_BYTES) throw new Error('单张图片不能超过 25 MiB')
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export class GeneratedImageAlbumService {
  private readonly storage: GeneratedImageAlbumStorage
  private readonly resolveGeneratedBlob: (image: FrontendWorkshopGeneratedImage) => Promise<Blob>

  constructor(
    storage: GeneratedImageAlbumStorage,
    resolveGeneratedBlob: (image: FrontendWorkshopGeneratedImage) => Promise<Blob>,
  ) {
    this.storage = storage
    this.resolveGeneratedBlob = resolveGeneratedBlob
  }

  async count(): Promise<number> {
    return this.storage.count ? this.storage.count() : (await this.storage.list()).length
  }

  async exportPortableState(): Promise<
    NonNullable<import('../types/Backup').ArchivePortableData['generatedImageAlbum']>
  > {
    return (await this.storage.list()).map((item) => ({ item }))
  }

  async importPortableState(
    entries: import('./GeneratedImageAlbumBackup').AlbumBackup,
    read: (entry: import('./GeneratedImageAlbumBackup').AlbumBackup[number]) => Promise<Blob>,
    signal?: AbortSignal,
    onPrepared?: (fileName: string) => void,
    onFailure?: (
      entry: import('./GeneratedImageAlbumBackup').AlbumBackup[number],
      error: unknown,
    ) => void,
  ): Promise<void> {
    const { hashCloudBlob } = await import('./CloudArchiveCodec')
    const { hashBytes } = await import('./HashService')
    const { canonicalizeFingerprintValue } = await import('./CloudBackupPolicy')
    const { nativeFileSource, rememberNativeFile } = await import('../core/NativeFileSource')
    const equal = (a: unknown, b: unknown) =>
      JSON.stringify(canonicalizeFingerprintValue(a)) ===
      JSON.stringify(canonicalizeFingerprintValue(b))
    const ids = new Map<string, string>(),
      fallbackIds = new Map<string, string>()
    const existing = new Map<string, GeneratedImageAlbumItem>()
    const children = new Map<string, typeof entries>()
    const withoutParent = (value: GeneratedImageAlbumItem) => {
      const clone = structuredClone(value)
      if (clone.generationManifest) delete clone.generationManifest.parentImageId
      return clone
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      const digest = await hashBytes(
        new TextEncoder().encode(
          JSON.stringify(
            canonicalizeFingerprintValue({ item: entry.item, hash: entry.object!.totalSha256 }),
          ),
        ),
      )
      fallbackIds.set(entry.item.id, entry.item.id + '-restored-' + digest.slice(0, 16))
      const local = await this.storage.get(entry.item.id)
      if (local) existing.set(entry.item.id, local)
      const same =
        !local ||
        (equal(withoutParent(local), withoutParent(entry.item)) &&
          (await hashCloudBlob(await this.getOriginalBlob(local.id))).toLowerCase() ===
            entry.object!.totalSha256.toLowerCase())
      ids.set(entry.item.id, same ? entry.item.id : fallbackIds.get(entry.item.id)!)
      const parent = entry.item.generationManifest?.parentImageId
      if (parent) {
        const group = children.get(parent) ?? []
        group.push(entry)
        children.set(parent, group)
      }
    }
    // Each identity can change once; descendants follow the same parent mapping without repeated full scans.
    const queue = [...entries]
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]!,
        local = existing.get(entry.item.id)
      if (!local || ids.get(entry.item.id) !== entry.item.id) continue
      const parent = entry.item.generationManifest?.parentImageId
      if (parent && local.generationManifest?.parentImageId !== (ids.get(parent) ?? parent)) {
        ids.set(entry.item.id, fallbackIds.get(entry.item.id)!)
        queue.push(...(children.get(entry.item.id) ?? []))
      }
    }
    for (const entry of entries) {
      const id = ids.get(entry.item.id)!
      if (id !== entry.item.id) {
        const target = await this.storage.get(id)
        if (target) existing.set(id, target)
      }
    }
    const failed = new Set<string>()
    for (const entry of entries) {
      try {
        const parent = entry.item.generationManifest?.parentImageId
        if (parent && failed.has(parent)) throw new Error('相册父图尚未恢复，请重试该组图片')
        signal?.throwIfAborted()
        const id = ids.get(entry.item.id)!
        const item = structuredClone(entry.item)
        item.id = id
        if (item.generationManifest?.parentImageId)
          item.generationManifest.parentImageId =
            ids.get(item.generationManifest.parentImageId) ?? item.generationManifest.parentImageId
        const local = existing.get(id)
        if (local) {
          if (
            !equal(local, item) ||
            (await hashCloudBlob(await this.getOriginalBlob(id))).toLowerCase() !==
              entry.object!.totalSha256.toLowerCase()
          )
            throw new Error(`相册恢复身份冲突：${item.name}`)
          onPrepared?.(item.name)
          continue
        }
        const original = await read(entry)
        signal?.throwIfAborted()
        if (
          original.size !== item.sizeBytes ||
          (await hashCloudBlob(original)).toLowerCase() !== entry.object!.totalSha256.toLowerCase()
        )
          throw new Error(`相册原图完整性校验失败：${item.name}`)
        signal?.throwIfAborted()
        const uri = nativeFileSource(original)
        const blob =
          original.type === item.mimeType ? original : new Blob([original], { type: item.mimeType })
        const preserved = uri ? rememberNativeFile(blob, uri) : blob
        const thumbnail = await createImageThumbnail(preserved)
        signal?.throwIfAborted()
        // Recheck only this target after asynchronous preparation, never overwrite a concurrent save.
        if (await this.storage.get(id)) throw new Error(`相册恢复期间目标发生变化：${item.name}`)
        await this.storage.put(item, {
          id,
          originalBlob: preserved,
          originalMimeType: item.mimeType,
          thumbnailBlob: thumbnail ?? undefined,
          thumbnailMimeType: thumbnail?.type,
          updatedAt: item.updatedAt,
        })
        if (
          !equal(await this.storage.get(id), item) ||
          (await hashCloudBlob(await this.getOriginalBlob(id))).toLowerCase() !==
            entry.object!.totalSha256.toLowerCase()
        )
          throw new Error(`相册原图保存后读回失败：${item.name}`)
        onPrepared?.(item.name)
      } catch (error) {
        signal?.throwIfAborted()
        if (!onFailure) throw error
        failed.add(entry.item.id)
        onFailure(entry, error)
      }
    }
  }

  async list(query: GeneratedImageAlbumQuery = {}): Promise<GeneratedImageAlbumPage> {
    if (this.storage.query) return this.storage.query(query)
    const all = await this.storage.list()
    const categories = Array.from(new Set(all.map((item) => item.category).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b, 'zh-CN'),
    )
    const mimeTypes = Array.from(new Set(all.map((item) => item.mimeType))).sort()
    const needle = query.search?.trim().toLocaleLowerCase() ?? ''
    const filtered = all.filter((item) => {
      if (query.mimeType && item.mimeType !== query.mimeType) return false
      if (query.category && item.category !== query.category) return false
      if (query.hostedStatus === 'hosted' && !item.hostedUrl) return false
      if (query.hostedStatus === 'local' && item.hostedUrl) return false
      if (!needle) return true
      return `${item.name} ${item.category} ${item.prompt ?? ''} ${item.hostedUrl ?? ''}`
        .toLocaleLowerCase()
        .includes(needle)
    })
    filtered.sort((a, b) =>
      query.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt,
    )
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.round(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    )
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
    const page = Math.min(pageCount, Math.max(1, Math.round(query.page ?? 1)))
    const offset = (page - 1) * pageSize
    return {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize,
      pageCount,
      categories,
      mimeTypes,
    }
  }

  async get(id: string): Promise<GeneratedImageAlbumItem | undefined> {
    return this.storage.get(id)
  }

  async getOriginalBlob(id: string): Promise<Blob> {
    const file = await this.storage.getFile(id)
    if (!file) throw new Error('相册原图不存在或已被删除')
    if (file.originalBlob instanceof Blob) return file.originalBlob
    if (file.originalBytes) return new Blob([file.originalBytes], { type: file.originalMimeType })
    if (file.originalBase64) {
      return new Blob([base64ToBytes(file.originalBase64)], { type: file.originalMimeType })
    }
    throw new Error('相册原图数据损坏，请从备份恢复或重新导入')
  }

  async getPreviewBlob(id: string): Promise<Blob> {
    const file = await this.storage.getFile(id)
    if (!file) throw new Error('相册图片不存在或已被删除')
    if (file.thumbnailBlob instanceof Blob) return file.thumbnailBlob
    if (file.thumbnailBytes) {
      return new Blob([file.thumbnailBytes], { type: file.thumbnailMimeType || 'image/webp' })
    }
    if (file.thumbnailBase64) {
      return new Blob([base64ToBytes(file.thumbnailBase64)], {
        type: file.thumbnailMimeType || 'image/webp',
      })
    }
    return this.getOriginalBlob(id)
  }

  async saveGenerated(
    image: FrontendWorkshopGeneratedImage,
    options: { name?: string; category?: string } = {},
  ): Promise<GeneratedImageAlbumItem> {
    const existing = await this.storage.get(image.id)
    if (existing) return existing
    const blob = await this.resolveGeneratedBlob(image)
    validateBlob(blob)
    const now = Date.now()
    const item: GeneratedImageAlbumItem = {
      id: image.id,
      name: cleanName(options.name ?? image.prompt.slice(0, 42), '生成图片'),
      source: 'generated',
      provider: image.provider,
      prompt: image.prompt,
      negativePrompt: image.negativePrompt,
      generationParameters: { ...image.parameters },
      generationManifest: image.manifest ? JSON.parse(JSON.stringify(image.manifest)) : undefined,
      category: options.category?.trim().slice(0, 40) ?? '',
      mimeType: blob.type || image.mimeType,
      sizeBytes: blob.size,
      width: image.width,
      height: image.height,
      createdAt: image.createdAt,
      updatedAt: now,
    }
    const thumbnail = await createImageThumbnail(blob)
    await this.storage.put(item, {
      id: item.id,
      originalBlob: blob,
      originalMimeType: blob.type,
      thumbnailBlob: thumbnail,
      thumbnailMimeType: thumbnail?.type,
      updatedAt: now,
    })
    return item
  }

  async importFile(file: File, category = ''): Promise<GeneratedImageAlbumItem> {
    const mimeType = mimeTypeForFile(file)
    validateBlob(file, mimeType)
    const now = Date.now()
    const id = crypto.randomUUID()
    const originalBlob = file.type === mimeType ? file : new Blob([file], { type: mimeType })
    const item: GeneratedImageAlbumItem = {
      id,
      name: cleanName(file.name.replace(/\.[^.]+$/u, ''), '导入图片'),
      source: 'imported',
      category: category.trim().slice(0, 40),
      mimeType,
      sizeBytes: file.size,
      createdAt: now,
      updatedAt: now,
    }
    const thumbnail = await createImageThumbnail(originalBlob)
    await this.storage.put(item, {
      id,
      originalBlob,
      originalMimeType: mimeType,
      thumbnailBlob: thumbnail,
      thumbnailMimeType: thumbnail?.type,
      updatedAt: now,
    })
    return item
  }

  async updateDetails(
    id: string,
    name: string,
    category: string,
  ): Promise<GeneratedImageAlbumItem> {
    const item = await this.storage.get(id)
    if (!item) throw new Error('图片记录不存在')
    const updated = {
      ...item,
      name: cleanName(name, item.name),
      category: category.trim().slice(0, 40),
      updatedAt: Date.now(),
    }
    await this.storage.update(updated)
    return updated
  }

  async setHostedUrl(
    id: string,
    hosted: {
      url: string
      id?: string
      managementOrigin?: string
      upstreamFileId?: string
    },
    hostingMode: GeneratedImageHostingMode,
  ): Promise<GeneratedImageAlbumItem> {
    const item = await this.storage.get(id)
    if (!item) throw new Error('图片记录不存在')
    const updated = {
      ...item,
      hostedUrl: hosted.url,
      hostedImageId: hosted.id,
      hostingMode,
      hostedOrigin: hostingMode === 'self-hosted' ? hosted.managementOrigin : undefined,
      hostedFileId: hostingMode === 'self-hosted' ? hosted.upstreamFileId : undefined,
      updatedAt: Date.now(),
    }
    await this.storage.update(updated)
    return updated
  }

  async clearHostedUrl(id: string): Promise<GeneratedImageAlbumItem> {
    const item = await this.storage.get(id)
    if (!item) throw new Error('图片记录不存在')
    const updated: GeneratedImageAlbumItem = { ...item, updatedAt: Date.now() }
    delete updated.hostedUrl
    delete updated.hostedImageId
    delete updated.hostingMode
    delete updated.hostedOrigin
    delete updated.hostedFileId
    await this.storage.update(updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(id)
  }
}
