import { isResourceAttachment, resourceOwnedFileOwnerId } from '../types/ResourceAttachment'
import type { VaultService } from '../services/VaultService'
import {
  toResourceListSummary,
  type Resource,
  type ResourceListSummary,
  type ResourceSummary,
} from '../types/Resource'
import {
  isAndroidNativeResourceMirrorAvailable,
  removeNativeResourceFile,
  removeNativeResourceFiles,
  stageNativeResourceFile,
  releaseReplacedNativeObjects,
  type NativeMirrorHandle,
  type NativeObjectReplacement,
} from './NativeResourceFileMirror'
import type {
  ResourceListSummaryFilter,
  ResourceStorageAdapter,
  ResourceMetadataPatch,
  ResourceVersionMatchFingerprintCache,
} from './ResourceStorageAdapter'

/**
 * 保留 IndexedDB 的既有事务/索引语义，同时把未加密资源原件镜像到 Android 文件目录。
 * 本地保险库开启时不创建明文镜像；清理仅由 VaultService 在迁移提交后执行，
 * 避免这里清空尚待迁移的 nativeOriginal 原件。资源仍由既有加密 IndexedDB 保存。
 */
export class NativeMirroredResourceStorage implements ResourceStorageAdapter {
  private readonly delegate: ResourceStorageAdapter
  private readonly vault: VaultService
  private mutationQueue: Promise<void> = Promise.resolve()
  readonly listGalleryListSummaries?: ResourceStorageAdapter['listGalleryListSummaries']
  readonly getChatReadPositionCache?: ResourceStorageAdapter['getChatReadPositionCache']
  readonly setChatReadPositionCache?: ResourceStorageAdapter['setChatReadPositionCache']
  readonly deleteChatReadPositionCache?: ResourceStorageAdapter['deleteChatReadPositionCache']
  readonly getReadSource?: ResourceStorageAdapter['getReadSource']
  readonly updateMetadataMany?: ResourceStorageAdapter['updateMetadataMany']
  readonly insertIfAbsent?: ResourceStorageAdapter['insertIfAbsent']

  constructor(delegate: ResourceStorageAdapter, vault: VaultService) {
    this.delegate = delegate
    this.vault = vault
    // Keep this optional so older delegates retain the service's summary fallback.
    this.listGalleryListSummaries = delegate.listGalleryListSummaries?.bind(delegate)
    this.getChatReadPositionCache = delegate.getChatReadPositionCache?.bind(delegate)
    this.setChatReadPositionCache = delegate.setChatReadPositionCache?.bind(delegate)
    this.deleteChatReadPositionCache = delegate.deleteChatReadPositionCache?.bind(delegate)
    this.getReadSource = delegate.getReadSource?.bind(delegate)
    const insertIfAbsent = delegate.insertIfAbsent?.bind(delegate)
    if (insertIfAbsent)
      this.insertIfAbsent = (resource) =>
        this.enqueueMutation(() =>
          this.saveWithMirror(resource, 'current', () => insertIfAbsent(resource)),
        )
    if (delegate.updateMetadataMany)
      this.updateMetadataMany = (patches) =>
        this.enqueueMutation(() => delegate.updateMetadataMany!(patches))
  }

  getVersionMatchFingerprintCache(): Promise<ResourceVersionMatchFingerprintCache | undefined> {
    return this.delegate.getVersionMatchFingerprintCache?.() ?? Promise.resolve(undefined)
  }

  setVersionMatchFingerprintCache(cache: ResourceVersionMatchFingerprintCache): Promise<void> {
    return this.delegate.setVersionMatchFingerprintCache?.(cache) ?? Promise.resolve()
  }

  clearVersionMatchFingerprintCache(): Promise<void> {
    return this.delegate.clearVersionMatchFingerprintCache?.() ?? Promise.resolve()
  }

  list(): Promise<Resource[]> {
    return this.delegate.list()
  }

  listSummaries(): Promise<ResourceSummary[]> {
    return this.delegate.listSummaries()
  }

  listResourceListSummaries(filter?: ResourceListSummaryFilter): Promise<ResourceListSummary[]> {
    return this.delegate.listResourceListSummaries
      ? this.delegate.listResourceListSummaries(filter)
      : this.delegate.listSummaries()
  }

  listRecentCharacterCardSummaries(limit = 100): Promise<ResourceListSummary[]> {
    return this.delegate.listRecentCharacterCardSummaries
      ? this.delegate.listRecentCharacterCardSummaries(limit)
      : this.listResourceListSummaries().then((resources) =>
          resources.filter((resource) => resource.type === 'characterCard').slice(0, limit),
        )
  }

  repairThumbnailAssets(): Promise<number> {
    return this.enqueueMutation(() =>
      this.delegate.repairThumbnailAssets
        ? this.delegate.repairThumbnailAssets()
        : Promise.resolve(0),
    )
  }

  getMissingPngThumbnailRepairStatus(): Promise<
    import('./ResourceThumbnailMaintenance').MissingPngThumbnailRepairStatus
  > {
    return (
      this.delegate.getMissingPngThumbnailRepairStatus?.() ??
      Promise.resolve({ status: 'not-started', repaired: 0 })
    )
  }

  repairMissingPngCharacterCardThumbnails(options?: {
    restart?: boolean
    signal?: AbortSignal
  }): Promise<number> {
    return this.enqueueMutation(() =>
      this.delegate.repairMissingPngCharacterCardThumbnails
        ? this.delegate.repairMissingPngCharacterCardThumbnails(options)
        : Promise.resolve(0),
    )
  }

  get(id: string): Promise<Resource | undefined> {
    return this.delegate.get(id)
  }

  getThumbnail(id: string): Promise<Blob | undefined> {
    return this.delegate.getThumbnail
      ? this.delegate.getThumbnail(id)
      : this.delegate.get(id).then((resource) => resource?.thumbnailBlob)
  }

  getSummary(id: string, historical = false): Promise<ResourceSummary | undefined> {
    return (
      this.delegate.getSummary?.(id, historical) ??
      (historical ? this.getVersion(id) : this.delegate.get(id))
    )
  }

  async getResourceListSummary(id: string): Promise<ResourceListSummary | undefined> {
    if (this.delegate.getResourceListSummary) return this.delegate.getResourceListSummary(id)
    const summary = await this.getSummary(id)
    return summary ? toResourceListSummary(summary) : undefined
  }

  async getResourceListSummaries(ids: readonly string[]): Promise<ResourceListSummary[]> {
    if (this.delegate.getResourceListSummaries) return this.delegate.getResourceListSummaries(ids)
    const result: ResourceListSummary[] = []
    const selected = Array.from(new Set(ids))
    for (let start = 0; start < selected.length; start += 250) {
      const rows = await Promise.all(
        selected.slice(start, start + 250).map((id) => this.getResourceListSummary(id)),
      )
      result.push(...rows.flatMap((row) => (row ? [row] : [])))
    }
    return result
  }

  async listAttachmentListSummaries(ownerId: string): Promise<ResourceListSummary[]> {
    if (this.delegate.listAttachmentListSummaries)
      return this.delegate.listAttachmentListSummaries(ownerId)
    return (await this.listResourceListSummaries({ types: ['other'] })).filter(
      (r) => isResourceAttachment(r) && resourceOwnedFileOwnerId(r) === ownerId,
    )
  }

  async findGalleryImage(
    ownerId: string,
    contentHash: string,
  ): Promise<ResourceSummary | undefined> {
    if (this.delegate.findGalleryImage) return this.delegate.findGalleryImage(ownerId, contentHash)
    return (await this.listResourceListSummaries()).find(
      (r) =>
        r.metadata.assetKind === 'resource-gallery-image' &&
        r.metadata.galleryOwnerId === ownerId &&
        r.contentHash === contentHash,
    )
  }

  getVersion(id: string): Promise<Resource | undefined> {
    return this.delegate.getVersion
      ? this.delegate.getVersion(id)
      : this.delegate.listAllVersions().then((versions) => versions.find((item) => item.id === id))
  }

  findByHash(contentHash: string): Promise<Resource | undefined> {
    return this.delegate.findByHash(contentHash)
  }

  findVersionByHash(contentHash: string): Promise<Resource | undefined> {
    return this.delegate.findVersionByHash(contentHash)
  }

  listVersions(resourceId: string): Promise<Resource[]> {
    return this.delegate.listVersions(resourceId)
  }

  listAllVersions(): Promise<Resource[]> {
    return this.delegate.listAllVersions()
  }

  listVersionListSummaries(): Promise<ResourceListSummary[]> {
    return this.delegate.listVersionListSummaries
      ? this.delegate.listVersionListSummaries()
      : this.delegate.listVersionSummaries()
  }

  async listVersionListSummariesForResources(ids: string[]): Promise<ResourceListSummary[]> {
    return this.delegate.listVersionListSummariesForResources
      ? this.delegate.listVersionListSummariesForResources(ids)
      : (await this.listVersionListSummaries()).filter((version) =>
          ids.includes(version.versionGroupId ?? ''),
        )
  }

  listVersionSummaries(): Promise<ResourceSummary[]> {
    return this.delegate.listVersionSummaries()
  }

  saveVersionSummary(summary: ResourceSummary): Promise<void> {
    return this.enqueueMutation(() => this.delegate.saveVersionSummary(summary))
  }

  async saveVersion(version: Resource): Promise<void> {
    await this.enqueueMutation(() =>
      this.saveWithMirror(version, 'versions', () => this.delegate.saveVersion(version)),
    )
  }

  async updateVersion(versionId: string, changes: Partial<Resource>): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.delegate.updateVersion(versionId, changes)
      if (Object.keys(changes).every((key) => key === 'backupDescriptor' || key === 'versionNote'))
        return
      const version = await this.getVersion(versionId)
      if (version) await this.mirrorAfterWrite(version, 'versions')
    })
  }

  async deleteVersion(versionId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.delegate.deleteVersion(versionId)
      await removeNativeResourceFile(versionId, 'versions')
    })
  }

  async save(resource: Resource): Promise<void> {
    await this.enqueueMutation(() =>
      this.saveWithMirror(resource, 'current', () => this.delegate.save(resource)),
    )
  }

  async saveMany(resources: Resource[]): Promise<void> {
    await this.enqueueMutation(() => this.saveManyWithMirror(resources))
  }

  async update(
    id: string,
    changes: Partial<Resource>,
    expectedContentHash?: string,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      if (!('originalBlob' in changes)) {
        await this.delegate.update(id, changes, expectedContentHash)
        return
      }
      const previous = await this.delegate.get(id)
      if (!previous) throw new Error('资源已经不存在')
      await this.saveWithMirror(
        { ...previous, ...changes },
        'current',
        () => this.delegate.update(id, changes, expectedContentHash),
        () => this.delegate.save(previous),
      )
    })
  }

  updateMetadata(
    id: string,
    changes: ResourceMetadataPatch,
    expectedPersonalDocument?: string,
  ): Promise<ResourceSummary> {
    return this.enqueueMutation(() => {
      if (!this.delegate.updateMetadata) throw new Error('当前存储不支持局部更新')
      return this.delegate.updateMetadata(id, changes, expectedPersonalDocument)
    })
  }

  async updateMany(ids: string[], changes: Partial<Resource>): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.delegate.updateMany(ids, changes)
      if (!('originalBlob' in changes)) return
      const replacements: NativeObjectReplacement[] = []
      for (const id of ids) {
        const resource = await this.delegate.get(id)
        if (resource) {
          const replacement = await this.mirrorAfterWrite(resource, 'current', false)
          if (replacement) replacements.push(replacement)
        }
      }
      if (replacements.length)
        await releaseReplacedNativeObjects(replacements).catch(() => undefined)
    })
  }

  async delete(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const versions = await this.listVersionListSummariesForResources([id])
      await this.delegate.delete(id)
      await removeNativeResourceFile(id, 'current')
      for (const version of versions) await removeNativeResourceFile(version.id, 'versions')
    })
  }

  async deleteMany(
    ids: string[],
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      const versionResources = await this.listVersionListSummariesForResources(ids)
      const fileCount = ids.length + versionResources.length
      const total = fileCount * 2
      await this.delegate.deleteMany(ids, (progress) => {
        onProgress?.({ completed: Math.min(fileCount, progress.completed), total })
      })
      onProgress?.({ completed: fileCount, total })
      await removeNativeResourceFiles(
        [
          ...ids.map((id) => ({ id, scope: 'current' as const })),
          ...versionResources.map(({ id }) => ({ id, scope: 'versions' as const })),
        ],
        (completed) => onProgress?.({ completed: fileCount + completed, total }),
      )
    })
  }

  private async saveManyWithMirror(resources: Resource[]): Promise<void> {
    if (this.vault.isEnabled()) {
      await this.delegate.saveMany(resources)
      return
    }
    const handles: NativeMirrorHandle[] = []
    try {
      for (const resource of resources) {
        handles.push(await stageNativeResourceFile(resource, 'current'))
      }
      await this.delegate.saveMany(resources)
      for (const handle of handles) await handle.commit()
      const replacements: NativeObjectReplacement[] = []
      for (const [index, resource] of resources.entries()) {
        if (await this.releaseVerifiedMirror(resource, 'current')) {
          const replacement = handles[index]?.replacement
          if (replacement) replacements.push(replacement)
        }
      }
      if (replacements.length)
        await releaseReplacedNativeObjects(replacements).catch(() => undefined)
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.abort()))
      throw error
    }
  }

  private async saveWithMirror<T>(
    resource: Resource,
    scope: 'current' | 'versions',
    save: () => Promise<T>,
    rollback?: () => Promise<void>,
  ): Promise<T> {
    if (this.vault.isEnabled()) {
      return save()
    }
    const handle = await stageNativeResourceFile(resource, scope)
    let saved = false
    let result: T
    try {
      result = await save()
      saved = result !== false
      if (saved) {
        await handle.commit()
        if ((await this.releaseVerifiedMirror(resource, scope)) && handle.replacement)
          await releaseReplacedNativeObjects([handle.replacement]).catch(() => undefined)
      }
    } catch (error) {
      await handle.abort()
      if (saved && rollback) await rollback()
      throw error
    }
    if (!saved) await handle.abort()
    return result
  }

  private async mirrorAfterWrite(
    resource: Resource,
    scope: 'current' | 'versions',
    release = true,
  ): Promise<NativeObjectReplacement | undefined> {
    if (this.vault.isEnabled()) {
      return
    }
    const handle = await stageNativeResourceFile(resource, scope)
    await handle.commit()
    if (!(await this.releaseVerifiedMirror(resource, scope))) return
    if (release && handle.replacement)
      await releaseReplacedNativeObjects([handle.replacement]).catch(() => undefined)
    return handle.replacement
  }

  private async releaseVerifiedMirror(
    resource: Resource,
    scope: 'current' | 'versions',
  ): Promise<boolean> {
    if (!isAndroidNativeResourceMirrorAvailable()) return false
    // A failure here leaves two verified copies rather than risking the only readable original.
    // The explicit health-center cleanup can retry it and makes remaining reclaimable bytes visible.
    const converted = await this.delegate
      .convertToNativeReference?.(
        resource.id,
        scope,
        resource.contentHash,
        resource.originalBlob.size,
      )
      .catch(() => undefined)
    if (converted === true) return true
    if (converted !== false) return false
    // Already-native records need no conversion, but still require authoritative identity.
    const summary = await this.delegate
      .getSummary?.(resource.id, scope === 'versions')
      .catch(() => undefined)
    return summary?.contentHash === resource.contentHash && summary.fileSize === resource.fileSize
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
