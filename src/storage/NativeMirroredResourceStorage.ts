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
  type NativeMirrorHandle,
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
  readonly getReadSource?: ResourceStorageAdapter['getReadSource']
  readonly updateMetadataMany?: ResourceStorageAdapter['updateMetadataMany']

  constructor(delegate: ResourceStorageAdapter, vault: VaultService) {
    this.delegate = delegate
    this.vault = vault
    // Keep this optional so older delegates retain the service's summary fallback.
    this.listGalleryListSummaries = delegate.listGalleryListSummaries?.bind(delegate)
    this.getReadSource = delegate.getReadSource?.bind(delegate)
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

  repairMissingPngCharacterCardThumbnails(options?: { restart?: boolean }): Promise<number> {
    return this.enqueueMutation(() =>
      this.delegate.repairMissingPngCharacterCardThumbnails
        ? this.delegate.repairMissingPngCharacterCardThumbnails(options)
        : Promise.resolve(0),
    )
  }

  get(id: string): Promise<Resource | undefined> {
    return this.delegate.get(id)
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
      if (Object.keys(changes).every((key) => key === 'backupDescriptor')) return
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

  async update(id: string, changes: Partial<Resource>): Promise<void> {
    await this.enqueueMutation(async () => {
      if (!('originalBlob' in changes)) {
        await this.delegate.update(id, changes)
        return
      }
      const previous = await this.delegate.get(id)
      if (!previous) throw new Error('资源已经不存在')
      await this.saveWithMirror(
        { ...previous, ...changes },
        'current',
        () => this.delegate.update(id, changes),
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
      for (const id of ids) {
        const resource = await this.delegate.get(id)
        if (resource) await this.mirrorAfterWrite(resource, 'current')
      }
    })
  }

  async delete(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const versions = await this.delegate.listVersions(id)
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
      for (const resource of resources) await this.releaseVerifiedMirror(resource, 'current')
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.abort()))
      throw error
    }
  }

  private async saveWithMirror(
    resource: Resource,
    scope: 'current' | 'versions',
    save: () => Promise<void>,
    rollback?: () => Promise<void>,
  ): Promise<void> {
    if (this.vault.isEnabled()) {
      await save()
      return
    }
    const handle = await stageNativeResourceFile(resource, scope)
    let saved = false
    try {
      await save()
      saved = true
      await handle.commit()
      await this.releaseVerifiedMirror(resource, scope)
    } catch (error) {
      await handle.abort()
      if (saved && rollback) await rollback()
      throw error
    }
  }

  private async mirrorAfterWrite(resource: Resource, scope: 'current' | 'versions'): Promise<void> {
    if (this.vault.isEnabled()) {
      return
    }
    const handle = await stageNativeResourceFile(resource, scope)
    await handle.commit()
    await this.releaseVerifiedMirror(resource, scope)
  }

  private async releaseVerifiedMirror(
    resource: Resource,
    scope: 'current' | 'versions',
  ): Promise<void> {
    if (!isAndroidNativeResourceMirrorAvailable()) return
    // A failure here leaves two verified copies rather than risking the only readable original.
    // The explicit health-center cleanup can retry it and makes remaining reclaimable bytes visible.
    await this.delegate
      .convertToNativeReference?.(
        resource.id,
        scope,
        resource.contentHash,
        resource.originalBlob.size,
      )
      .catch(() => undefined)
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
