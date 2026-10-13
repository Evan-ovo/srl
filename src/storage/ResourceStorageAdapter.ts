import type {
  Resource,
  ResourceListSummary,
  ResourceSummary,
  ResourceType,
} from '../types/Resource'
import type { ResourceReadSource } from '../types/ResourceReadSource'
import type { MissingPngThumbnailRepairStatus } from './ResourceThumbnailMaintenance'

export type ResourceMetadataPatch = Partial<
  Omit<
    Resource,
    'id' | 'originalBlob' | 'contentHash' | 'fileSize' | 'fileName' | 'mimeType' | 'createdAt'
  >
>

export interface ResourceVersionMatchFingerprintCache {
  schemaVersion: 1
  resources: Record<string, { signature: string; full: string; core: string }>
  versions: Record<string, { signature: string; full: string; core: string }>
}

export interface ResourceListSummaryFilter {
  types?: readonly ResourceType[]
  ids?: readonly string[]
}

export interface ResourceStorageAdapter {
  getVersionMatchFingerprintCache?(): Promise<ResourceVersionMatchFingerprintCache | undefined>
  setVersionMatchFingerprintCache?(cache: ResourceVersionMatchFingerprintCache): Promise<void>
  clearVersionMatchFingerprintCache?(): Promise<void>
  list(): Promise<Resource[]>
  listSummaries(): Promise<ResourceSummary[]>
  listResourceListSummaries?(filter?: ResourceListSummaryFilter): Promise<ResourceListSummary[]>
  /** Targeted lightweight reads for settling a completed logical import batch. */
  getResourceListSummary?(id: string): Promise<ResourceListSummary | undefined>
  /** Bounded newest-first character-card summaries for inbox auto-binding only. */
  listRecentCharacterCardSummaries?(limit?: number): Promise<ResourceListSummary[]>
  /** Current gallery images; same-type scope also supplies shared category candidates. */
  listGalleryListSummaries?(
    ownerId: string,
    includeSameType?: boolean,
  ): Promise<ResourceListSummary[]>
  repairThumbnailAssets?(): Promise<number>
  getMissingPngThumbnailRepairStatus?(): Promise<MissingPngThumbnailRepairStatus>
  repairMissingPngCharacterCardThumbnails?(options?: { restart?: boolean }): Promise<number>
  get(id: string): Promise<Resource | undefined>
  getReadSource?(id: string): Promise<ResourceReadSource | undefined>
  getSummary?(id: string, historical?: boolean): Promise<ResourceSummary | undefined>
  findGalleryImage?(ownerId: string, contentHash: string): Promise<ResourceSummary | undefined>
  updateMetadata?(
    id: string,
    changes: ResourceMetadataPatch,
    expectedPersonalDocument?: string,
  ): Promise<ResourceSummary>
  /** Commit distinct metadata patches together without rewriting original files. */
  updateMetadataMany?(patches: Array<{ id: string; changes: ResourceMetadataPatch }>): Promise<void>
  /**
   * Android 已经由原生库按哈希落盘后，释放 IndexedDB 中同一原件的重复 Blob。
   * 这是可选能力：非原生存储和测试替身无需实现。
   */
  convertToNativeReference?(
    id: string,
    scope: 'current' | 'versions',
    contentHash: string,
    size: number,
  ): Promise<boolean>
  getVersion?(id: string): Promise<Resource | undefined>
  findByHash(contentHash: string): Promise<Resource | undefined>
  findVersionByHash(contentHash: string): Promise<Resource | undefined>
  listVersions(resourceId: string): Promise<Resource[]>
  listAllVersions(): Promise<Resource[]>
  listVersionListSummaries?(): Promise<ResourceListSummary[]>
  listVersionListSummariesForResources?(ids: string[]): Promise<ResourceListSummary[]>
  listVersionSummaries(): Promise<ResourceSummary[]>
  saveVersionSummary(summary: ResourceSummary): Promise<void>
  saveVersion(version: Resource): Promise<void>
  updateVersion(versionId: string, changes: Partial<Resource>): Promise<void>
  deleteVersion(versionId: string): Promise<void>
  save(resource: Resource): Promise<void>
  saveMany(resources: Resource[]): Promise<void>
  update(id: string, changes: Partial<Resource>): Promise<void>
  updateMany(ids: string[], changes: Partial<Resource>): Promise<void>
  delete(id: string): Promise<void>
  deleteMany(
    ids: string[],
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<void>
}
