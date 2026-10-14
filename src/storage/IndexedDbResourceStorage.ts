import {
  getMissingPngThumbnailRepairStatus,
  repairMissingPngCharacterCardThumbnails,
  repairThumbnailAssets,
  type MissingPngThumbnailRepairStatus,
  type ResourceThumbnailMaintenanceContext,
  yieldMainThread,
} from './ResourceThumbnailMaintenance'

import { galleryOwnerId, isResourceGalleryImage } from '../types/ResourceGallery'

import Dexie from 'dexie'

import type { AppDatabase } from '../database/AppDatabase'

import type { VaultService } from '../services/VaultService'

import {
  RESOURCE_TYPE,
  normalizeResource,
  toResourceListSummary,
  toResourceSummary,
  type Resource,
  type ResourceListSummary,
  type ResourceSummary,
} from '../types/Resource'

import {
  isEncryptedResource,
  isEncryptedResourceSummary,
  isNativeBackedResource,
  type NativeBackedResourceRecord,
  type StoredResource,
  type StoredResourceSummary,
} from '../types/Vault'

import type {
  ResourceListSummaryFilter,
  ResourceStorageAdapter,
  ResourceMetadataPatch,
  ResourceVersionMatchFingerprintCache,
} from './ResourceStorageAdapter'

import { IndexedDbAssetStore } from './IndexedDbAssetStore'

import { readNativeResourceObject } from './NativeResourceFileMirror'
import { isAndroidNativeAppDatabaseActive, runAndroidNativeRead } from './AndroidNativeDexieCore'
import { decodeAppDatabaseValue, encodeAppDatabaseKey } from './AndroidAppDatabaseMigration'
import { nativeAppDatabase } from './NativeAppDatabaseBridge'
import {
  readResourceMetadata,
  readResourceMetadataBatch,
  readResourceSource,
} from './ResourceReadSource'

import {
  cloneResourceForStorage,
  hydrateResourceFromIndexedDb,
  materializeResourceForIndexedDb,
  stripStableResourceBinaryFields,
  stripStableSummaryBinaryFields,
} from './ResourceStorageClone'

const SUMMARY_READ_BATCH_SIZE = 250

const LIST_SUMMARY_INDEX_SETTING_ID = 'index.resourceListSummaries.v20'
const VERSION_MATCH_FINGERPRINT_CACHE_SETTING_ID = 'cache.resourceVersionMatchFingerprints.v1'

export class IndexedDbResourceStorage implements ResourceStorageAdapter {
  private readonly database: AppDatabase
  private readonly vault?: VaultService
  private readonly assets: IndexedDbAssetStore
  private thumbnailMigrationPromise?: Promise<number>
  private missingPngThumbnailRepairPromise?: Promise<number>

  constructor(
    database: AppDatabase,
    vault?: VaultService,
    assets = new IndexedDbAssetStore(database, vault),
  ) {
    this.database = database
    this.vault = vault
    this.assets = assets
  }

  async getVersionMatchFingerprintCache(): Promise<
    ResourceVersionMatchFingerprintCache | undefined
  > {
    const setting = await this.database.settings.get(VERSION_MATCH_FINGERPRINT_CACHE_SETTING_ID)
    const value = setting?.value as ResourceVersionMatchFingerprintCache | undefined
    return value?.schemaVersion === 1 && value.resources && value.versions ? value : undefined
  }

  async setVersionMatchFingerprintCache(
    cache: ResourceVersionMatchFingerprintCache,
  ): Promise<void> {
    await this.database.settings.put({
      id: VERSION_MATCH_FINGERPRINT_CACHE_SETTING_ID,
      value: cache,
      updatedAt: Date.now(),
    })
  }

  async clearVersionMatchFingerprintCache(): Promise<void> {
    await this.database.settings.delete(VERSION_MATCH_FINGERPRINT_CACHE_SETTING_ID)
  }

  async getThumbnail(id: string): Promise<Blob | undefined> {
    const summary = await this.getSummary(id)
    if (summary?.thumbnailAssetId) return this.assets.getBlob(summary.thumbnailAssetId)
    // Legacy embedded/encrypted records retain their established hydration route.
    return (await this.get(id))?.thumbnailBlob
  }

  repairThumbnailAssets(): Promise<number> {
    return repairThumbnailAssets(this.thumbnailContext())
  }

  getMissingPngThumbnailRepairStatus(): Promise<MissingPngThumbnailRepairStatus> {
    return getMissingPngThumbnailRepairStatus(this.thumbnailContext())
  }

  repairMissingPngCharacterCardThumbnails(options?: { restart?: boolean }): Promise<number> {
    if (this.missingPngThumbnailRepairPromise) return this.missingPngThumbnailRepairPromise
    const operation = repairMissingPngCharacterCardThumbnails(this.thumbnailContext(), options)
    this.missingPngThumbnailRepairPromise = operation
    void operation
      .finally(() => {
        if (this.missingPngThumbnailRepairPromise === operation)
          this.missingPngThumbnailRepairPromise = undefined
      })
      .catch(() => undefined)
    return operation
  }

  private async prepareResourceForStorage(resource: Resource): Promise<Resource> {
    return this.assets.externalizeResourceThumbnail(await cloneResourceForStorage(resource))
  }

  private hydrateResourceThumbnail(resource: Resource): Promise<Resource> {
    return this.assets.hydrateResourceThumbnail(resource)
  }

  private async decodeStoredResource(resource: StoredResource): Promise<Resource> {
    const decoded = isNativeBackedResource(resource)
      ? await (async () => {
          const { nativeOriginal, ...record } = resource
          return {
            ...record,
            originalBlob: await readNativeResourceObject(
              nativeOriginal.contentHash,
              nativeOriginal.size,
              resource.mimeType,
            ),
          }
        })()
      : this.vault
        ? await this.vault.decodeResource(resource)
        : hydrateResourceFromIndexedDb(resource)
    return this.hydrateResourceThumbnail(
      normalizeResource(hydrateResourceFromIndexedDb(decoded as StoredResource)),
    )
  }

  async list(): Promise<Resource[]> {
    const stored = await this.database.resources.toArray()
    const resources = await Promise.all(
      stored.map((resource) => this.decodeStoredResource(resource)),
    )
    return resources.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listSummaries(): Promise<ResourceSummary[]> {
    const table = this.database.resourceSummaries
    const ids = await table.toCollection().primaryKeys()
    const resources: ResourceSummary[] = []
    for (let start = 0; start < ids.length; start += SUMMARY_READ_BATCH_SIZE) {
      const stored = (
        await table.bulkGet(ids.slice(start, start + SUMMARY_READ_BATCH_SIZE))
      ).filter((resource): resource is StoredResourceSummary => resource !== undefined)
      resources.push(
        ...(await Promise.all(
          stored.map((resource) =>
            this.vault ? this.vault.decodeResourceSummary(resource) : (resource as ResourceSummary),
          ),
        )),
      )
      if (start + SUMMARY_READ_BATCH_SIZE < ids.length) await yieldMainThread()
    }
    resources.sort((left, right) => right.updatedAt - left.updatedAt)
    return resources
  }

  async listResourceListSummaries(
    filter?: ResourceListSummaryFilter,
  ): Promise<ResourceListSummary[]> {
    await this.repairResourceListSummaryIndex()
    const table = this.database.resourceListSummaries
    const ids = filter?.ids
      ? Array.from(new Set(filter.ids)).sort()
      : filter?.types && !this.vault?.isEnabled()
        ? filter.types.length
          ? (
              await table
                .where('type')
                .anyOf([...filter.types])
                .primaryKeys()
            ).sort()
          : []
        : await table.toCollection().primaryKeys()
    const types = filter?.types ? new Set(filter.types) : undefined
    const resources: ResourceListSummary[] = []
    for (let start = 0; start < ids.length; start += SUMMARY_READ_BATCH_SIZE) {
      const stored = (
        await table.bulkGet(ids.slice(start, start + SUMMARY_READ_BATCH_SIZE))
      ).filter((resource): resource is StoredResourceSummary => resource !== undefined)
      const decoded = await Promise.all(
        stored.map((resource) =>
          this.vault ? this.vault.decodeResourceSummary(resource) : (resource as ResourceSummary),
        ),
      )
      resources.push(
        ...decoded
          .filter((resource) => !types || types.has(resource.type))
          .map(toResourceListSummary),
      )
      if (start + SUMMARY_READ_BATCH_SIZE < ids.length) await yieldMainThread()
    }
    resources.sort((left, right) => right.updatedAt - left.updatedAt)
    return resources
  }

  async getResourceListSummary(id: string): Promise<ResourceListSummary | undefined> {
    const stored = await this.database.resourceListSummaries.get(id)
    if (!stored) return undefined
    const summary = this.vault
      ? await this.vault.decodeResourceSummary(stored)
      : (stored as ResourceSummary)
    return toResourceListSummary(summary)
  }

  async listRecentCharacterCardSummaries(limit = 100): Promise<ResourceListSummary[]> {
    const requested = Math.min(200, Math.max(1, Math.round(limit)))
    const table = this.database.resourceListSummaries
    if (!this.vault?.isEnabled()) {
      const stored = await table
        .orderBy('updatedAt')
        .reverse()
        .filter((resource) => 'type' in resource && resource.type === RESOURCE_TYPE.CHARACTER_CARD)
        .limit(requested)
        .toArray()
      return stored.map((resource) => toResourceListSummary(resource as ResourceSummary))
    }

    // Encrypted summaries hide their type. Scan recent keys in bounded batches until
    // enough decoded cards are found; newer resources of other types do not consume the limit.
    const ids = await table.orderBy('updatedAt').reverse().primaryKeys()
    const cards: ResourceListSummary[] = []
    const batchSize = Math.max(25, requested)
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const stored = await table.bulkGet(ids.slice(offset, offset + batchSize))
      for (const resource of stored) {
        if (!resource) continue
        const decoded = await this.vault.decodeResourceSummary(resource)
        if (decoded.type !== RESOURCE_TYPE.CHARACTER_CARD) continue
        cards.push(toResourceListSummary(decoded))
        if (cards.length === requested) return cards
      }
      if (offset + batchSize < ids.length) await yieldMainThread()
    }
    return cards
  }

  async listGalleryListSummaries(
    ownerId: string,
    includeSameType = false,
  ): Promise<ResourceListSummary[]> {
    // Vault encrypts type and ownership. Keep its existing decode path rather than
    // publishing those private fields in a new plaintext index.
    if (this.vault?.isEnabled()) {
      const summaries = await this.listResourceListSummaries()
      const owner = summaries.find((r) => r.id === ownerId && !isResourceGalleryImage(r))
      const ownerIds = includeSameType
        ? new Set(
            summaries
              .filter((r) => owner && r.type === owner.type && !isResourceGalleryImage(r))
              .map((r) => r.id),
          )
        : new Set([ownerId])
      return summaries.filter((r) => isResourceGalleryImage(r) && ownerIds.has(galleryOwnerId(r)))
    }

    return this.database.transaction('r', this.database.resourceSummaries, async () => {
      const table = this.database.resourceSummaries
      let ownerIds = new Set([ownerId])
      if (includeSameType) {
        const owner = await table.get(ownerId)
        if (!owner || isEncryptedResourceSummary(owner) || isResourceGalleryImage(owner)) return []
        const owners = table.where('type').equals(owner.type)
        // Gallery images are OTHER and encrypted rows have no type index. For
        // ordinary types keep this a keys-only query, avoiding their heavy metadata.
        ownerIds = new Set(
          await (
            owner.type === RESOURCE_TYPE.OTHER
              ? owners.filter((r) => !isEncryptedResourceSummary(r) && !isResourceGalleryImage(r))
              : owners
          ).primaryKeys(),
        )
      }
      // All gallery attachments are OTHER. Read only that existing type index and
      // retain matching rows; no global list repair, binary hydration or cache.
      const stored = await table
        .where('type')
        .equals(RESOURCE_TYPE.OTHER)
        .filter(
          (r) =>
            !isEncryptedResourceSummary(r) &&
            isResourceGalleryImage(r) &&
            ownerIds.has(galleryOwnerId(r)),
        )
        .toArray()
      return stored.map((r) => toResourceListSummary(r as ResourceSummary))
    })
  }

  private async repairResourceListSummaryIndex(force = false): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        this.database.settings,
      ],
      async () => {
        if (
          !force &&
          isAndroidNativeAppDatabaseActive() &&
          (await this.database.settings.get(LIST_SUMMARY_INDEX_SETTING_ID))?.value === true
        ) {
          let equal: boolean | undefined
          try {
            equal = await Dexie.waitFor(
              nativeAppDatabase.haveSameRecordKeys('resources', 'resourceListSummaries'),
            )
          } catch (error) {
            // Old APKs keep the full, exact check below; damaged data must remain an error.
            if ((error as { code?: string }).code !== 'UNIMPLEMENTED') throw error
          }
          if (equal === true) return
        }
        const ids = await this.database.resources.toCollection().primaryKeys()
        const listed = await this.database.resourceListSummaries.toCollection().primaryKeys()
        const indexed = new Set(listed)
        if (
          !force &&
          ids.length === listed.length &&
          ids.every((id) => indexed.has(id)) &&
          (await this.database.settings.get(LIST_SUMMARY_INDEX_SETTING_ID))?.value === true
        )
          return
        // A completed migration marker is not evidence that the derived index is intact.
        // Rebuild from authoritative records atomically; failure never publishes a partial/empty list.
        for (const id of ids) {
          const resource = await readResourceMetadata(this.database, id)
          if (!resource) throw new Error('资源索引修复期间原始记录缺失')
          const light = await Dexie.waitFor(this.compactStoredSummary(resource))
          await this.database.resourceSummaries.put(light)
          await this.database.resourceListSummaries.put(light)
        }
        const validIds = new Set(ids)
        const staleIds = listed.filter((id) => !validIds.has(id))
        if (staleIds.length) await this.database.resourceListSummaries.bulkDelete(staleIds)
        await this.database.settings.put({
          id: LIST_SUMMARY_INDEX_SETTING_ID,
          value: true,
          updatedAt: Date.now(),
        })
      },
    )
  }

  private async createStoredListSummariesFromSummaries(
    summaries: StoredResourceSummary[],
  ): Promise<StoredResourceSummary[]> {
    return Promise.all(
      summaries.map(async (summary) => {
        const decoded = this.vault
          ? await this.vault.decodeResourceSummary(summary)
          : (summary as ResourceSummary)
        const light = toResourceListSummary(decoded)
        return this.vault ? this.vault.encodeResourceSummary(light) : light
      }),
    )
  }

  async get(id: string): Promise<Resource | undefined> {
    const stored = await this.database.resources.get(id)
    if (!stored) return undefined
    return this.decodeStoredResource(stored)
  }

  async getSummary(id: string, historical = false): Promise<ResourceSummary | undefined> {
    const store = historical ? 'resourceVersions' : 'resources'
    const summary = await this.database.transaction(
      'r',
      this.database[store],
      async (transaction) => {
        const record = await readResourceMetadata(this.database, id, store)
        if (!record) return undefined
        const summary = this.toStoredSummary(record)
        if (isAndroidNativeAppDatabaseActive() && isEncryptedResourceSummary(summary)) {
          // Only the encrypted metadata payload is needed; original/thumbnail ciphertext stays native.
          return runAndroidNativeRead(transaction.idbtrans, async () => ({
            ...summary,
            payload: (await decodeAppDatabaseValue(
              summary.payload,
              store,
              encodeAppDatabaseKey(id),
              nativeAppDatabase,
            )) as typeof summary.payload,
          }))
        }
        return summary
      },
    )
    if (!summary) return undefined
    return this.vault ? this.vault.decodeResourceSummary(summary) : (summary as ResourceSummary)
  }

  getReadSource(id: string) {
    return readResourceSource(this.database, id, this.get.bind(this))
  }

  async findGalleryImage(
    ownerId: string,
    contentHash: string,
  ): Promise<ResourceSummary | undefined> {
    const ids = await this.database.resources.where('contentHash').equals(contentHash).primaryKeys()
    for (const id of ids) {
      const summary = await this.getSummary(id)
      if (summary && isResourceGalleryImage(summary) && summary.metadata.galleryOwnerId === ownerId)
        return summary
    }
    return undefined
  }

  async findByHash(contentHash: string): Promise<Resource | undefined> {
    const ids = await this.database.resources.where('contentHash').equals(contentHash).primaryKeys()
    for (const id of ids) {
      const stored = await this.database.resources.get(id)
      if (!stored) continue
      const resource = await this.decodeStoredResource(stored)
      if (!isResourceGalleryImage(resource)) return resource
    }
    return undefined
  }

  async findVersionByHash(contentHash: string): Promise<Resource | undefined> {
    const stored = await this.database.resourceVersions
      .where('contentHash')
      .equals(contentHash)
      .first()
    if (!stored) return undefined
    return this.decodeStoredResource(stored)
  }

  async getVersion(id: string): Promise<Resource | undefined> {
    const stored = await this.database.resourceVersions.get(id)
    if (!stored) return undefined
    return this.decodeStoredResource(stored)
  }

  async listVersions(resourceId: string): Promise<Resource[]> {
    const stored = await this.database.resourceVersions
      .where('versionGroupId')
      .equals(resourceId)
      .toArray()
    const resources = await Promise.all(
      stored.map((resource) => this.decodeStoredResource(resource)),
    )
    return resources.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listAllVersions(): Promise<Resource[]> {
    const stored = await this.database.resourceVersions.toArray()
    const resources = await Promise.all(
      stored.map((resource) => this.decodeStoredResource(resource)),
    )
    return resources.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async listVersionListSummaries(): Promise<ResourceListSummary[]> {
    const summaries: ResourceListSummary[] = []
    // Read authoritative versions one at a time; no full metadata/body array or repair scan.
    for (const id of await this.database.resourceVersions.toCollection().primaryKeys()) {
      const record = await this.database.resourceVersions.get(id)
      if (!record) continue
      const stored = this.toStoredSummary(record)
      const summary = this.vault
        ? await this.vault.decodeResourceSummary(stored)
        : (stored as ResourceSummary)
      summaries.push(toResourceListSummary(summary))
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async listVersionListSummariesForResources(ids: string[]): Promise<ResourceListSummary[]> {
    if (!ids.length) return []
    const keys = await this.database.resourceVersions
      .where('versionGroupId')
      .anyOf(ids)
      .primaryKeys()
    const summaries: ResourceListSummary[] = []
    for (const id of keys) {
      const record = await this.database.resourceVersionSummaries.get(id)
      const version = record ?? (await this.database.resourceVersions.get(id))
      if (!version) continue
      const stored = record ?? this.toStoredSummary(version as StoredResource)
      const summary = this.vault
        ? await this.vault.decodeResourceSummary(stored)
        : (stored as ResourceSummary)
      summaries.push(toResourceListSummary(summary))
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async listVersionSummaries(): Promise<ResourceSummary[]> {
    await this.repairVersionSummaryIndex()
    const stored = await this.database.resourceVersionSummaries.toArray()
    const resources = await Promise.all(
      stored.map((resource) =>
        this.vault ? this.vault.decodeResourceSummary(resource) : (resource as ResourceSummary),
      ),
    )
    return resources.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * `resourceVersions` 是历史版本的权威记录，摘要表只是可重建索引。
   *
   * 旧版恢复流程曾只写真实历史表，导致详情可见但重识别扫描不到；整库覆盖还
   * 可能留下已经不存在的摘要。更早的写入路径还可能留下“ID 存在，但哈希、
   * 时间线或更新时间已经过期”的摘要。每次读取历史摘要前以真实记录校正这些
   * 关键字段，补齐缺失项并删除幽灵项，避免详情页和重识别看到两套事实。
   */
  private async repairVersionSummaryIndex(): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.resourceVersions,
      this.database.resourceVersionSummaries,
      async () => {
        const ids = await this.database.resourceVersions.toCollection().primaryKeys()
        const existingIds = await this.database.resourceVersionSummaries
          .toCollection()
          .primaryKeys()
        const authoritativeIds = new Set(ids)
        const staleIds = existingIds.filter((id) => !authoritativeIds.has(id))
        if (staleIds.length) await this.database.resourceVersionSummaries.bulkDelete(staleIds)
        // Compare authoritative fields one version at a time. A scan must not retain every
        // original attachment in an array (native reads otherwise materialize several GiB).
        for (const id of ids) {
          const version = await readResourceMetadata(this.database, id, 'resourceVersions')
          if (!version) continue
          const summary = await this.database.resourceVersionSummaries.get(id)
          if (
            !summary ||
            summary.contentHash !== version.contentHash ||
            summary.versionGroupId !== version.versionGroupId ||
            summary.updatedAt !== version.updatedAt
          )
            await this.database.resourceVersionSummaries.put(
              await Dexie.waitFor(this.compactStoredSummary(version, 'resourceVersions')),
            )
        }
      },
    )
  }

  /**
   * 健康中心使用的显式安全修复：真实资源与历史版本表是唯一权威来源，这里只
   * 重建可以随时再生的摘要索引，不改动任何用户原件、版本或附件。
   */
  async repairDerivedIndexes(): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        this.database.resourceVersions,
        this.database.resourceVersionSummaries,
        this.database.settings,
      ],
      async () => {
        await Promise.all([
          this.database.resourceSummaries.clear(),
          this.database.resourceListSummaries.clear(),
          this.database.resourceVersionSummaries.clear(),
        ])
        for (const store of ['resources', 'resourceVersions'] as const) {
          const ids = await this.database[store].toCollection().primaryKeys()
          for (let offset = 0; offset < ids.length; offset += 64) {
            const records = await readResourceMetadataBatch(
              this.database,
              ids.slice(offset, offset + 64),
              store,
            )
            const lights: StoredResourceSummary[] = []
            for (const record of records) {
              if (!record) throw new Error('摘要精简期间原始记录缺失，未提交修改')
              const light = await Dexie.waitFor(this.compactStoredSummary(record, store))
              lights.push(light)
            }
            if (store === 'resources') {
              await this.database.resourceSummaries.bulkPut(lights)
              await this.database.resourceListSummaries.bulkPut(lights)
            } else await this.database.resourceVersionSummaries.bulkPut(lights)
          }
        }
        await this.database.settings.put({
          id: LIST_SUMMARY_INDEX_SETTING_ID,
          value: true,
          updatedAt: Date.now(),
        })
      },
    )
  }

  async areDerivedSummariesCompact(): Promise<boolean> {
    const tables = [
      this.database.resourceSummaries,
      this.database.resourceListSummaries,
      this.database.resourceVersionSummaries,
    ]
    return this.database.transaction(
      'r',
      [...tables, this.database.resources, this.database.resourceVersions],
      async () => {
        const currentCount = await this.database.resources.count(),
          versionCount = await this.database.resourceVersions.count()
        for (const table of tables) {
          const ids = await table.toCollection().primaryKeys()
          if (
            ids.length !==
            (table === this.database.resourceVersionSummaries ? versionCount : currentCount)
          )
            return false
          for (let offset = 0; offset < ids.length; offset += 64) {
            for (const stored of await table.bulkGet(ids.slice(offset, offset + 64))) {
              if (!stored) return false
              const summary = this.vault
                ? await Dexie.waitFor(this.vault.decodeResourceSummary(stored))
                : (stored as ResourceSummary)
              const compact = toResourceListSummary(summary)
              if (
                summary.thumbnailBlob ||
                'originalBlob' in summary ||
                JSON.stringify(summary.metadata) !== JSON.stringify(compact.metadata)
              )
                return false
            }
          }
        }
        return true
      },
    )
  }

  async saveVersionSummary(summary: ResourceSummary): Promise<void> {
    if (!summary.versionGroupId) throw new Error('历史版本摘要缺少资源组 ID')
    const withoutBinary = toResourceListSummary(summary)
    const stored = this.vault
      ? await this.vault.encodeResourceSummary(withoutBinary)
      : withoutBinary
    await this.database.resourceVersionSummaries.put(stored)
  }

  /**
   * Replace only a verified duplicate IndexedDB Blob with an Android native-object reference.
   * The caller must have checked the native entry and object SHA-256 immediately beforehand.
   */
  async convertToNativeReference(
    id: string,
    scope: 'current' | 'versions',
    contentHash: string,
    size: number,
  ): Promise<boolean> {
    const normalizedHash = contentHash.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalizedHash) || !Number.isSafeInteger(size) || size < 0)
      throw new Error('原生引用哈希或大小无效')
    const table = scope === 'current' ? this.database.resources : this.database.resourceVersions
    return this.database.transaction('rw', table, async () => {
      const record = await table.get(id)
      if (
        !record ||
        isEncryptedResource(record) ||
        isNativeBackedResource(record) ||
        record.contentHash.toLowerCase() !== normalizedHash ||
        record.fileSize !== size ||
        hydrateResourceFromIndexedDb(record).originalBlob.size !== size
      )
        return false
      const { originalBlob: _originalBlob, ...metadata } = record
      const nativeRecord = {
        ...metadata,
        nativeOriginal: { version: 1, contentHash: normalizedHash, size },
      } as NativeBackedResourceRecord
      await table.put(nativeRecord)
      return true
    })
  }

  async saveVersion(version: Resource): Promise<void> {
    if (!version.versionGroupId) throw new Error('历史版本缺少资源组 ID')
    const normalized = await this.prepareResourceForStorage(version)
    const encoded = this.vault ? await this.vault.encodeResource(normalized) : normalized
    const stored = await materializeResourceForIndexedDb(encoded)
    await this.database.transaction(
      'rw',
      this.database.resourceVersions,
      this.database.resourceVersionSummaries,
      async () => {
        await this.database.resourceVersions.put(stored)
        await this.database.resourceVersionSummaries.put(
          await Dexie.waitFor(this.compactStoredSummary(stored)),
        )
      },
    )
  }

  async updateVersion(versionId: string, changes: Partial<Resource>): Promise<void> {
    const stored = await this.database.resourceVersions.get(versionId)
    if (!stored) return
    const current = hydrateResourceFromIndexedDb(
      (this.vault ? await this.vault.decodeResource(stored) : stored) as StoredResource,
    )
    const merged = { ...current, ...changes }
    if (
      Object.prototype.hasOwnProperty.call(changes, 'thumbnailBlob') &&
      !(changes.thumbnailBlob instanceof Blob)
    ) {
      merged.thumbnailAssetId = undefined
    }
    const normalized = await this.prepareResourceForStorage(merged)
    const encoded = this.vault ? await this.vault.encodeResource(normalized) : normalized
    const updated = await materializeResourceForIndexedDb(encoded)
    await this.database.transaction(
      'rw',
      this.database.resourceVersions,
      this.database.resourceVersionSummaries,
      async () => {
        await this.database.resourceVersions.put(updated)
        await this.database.resourceVersionSummaries.put(
          await Dexie.waitFor(this.compactStoredSummary(updated)),
        )
      },
    )
  }

  async deleteVersion(versionId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.resourceVersions,
      this.database.resourceVersionSummaries,
      async () => {
        await this.database.resourceVersions.delete(versionId)
        await this.database.resourceVersionSummaries.delete(versionId)
      },
    )
  }

  async save(resource: Resource): Promise<void> {
    const normalized = await this.prepareResourceForStorage(resource)
    const stored = this.vault ? await this.vault.encodeResource(normalized) : normalized
    await this.putStoredResources([stored])
  }

  async saveMany(resources: Resource[]): Promise<void> {
    const normalized: Resource[] = []
    for (const resource of resources)
      normalized.push(await this.prepareResourceForStorage(resource))
    const stored = this.vault
      ? await Promise.all(normalized.map((resource) => this.vault!.encodeResource(resource)))
      : normalized
    await this.putStoredResources(stored)
  }

  async updateMetadata(
    id: string,
    changes: ResourceMetadataPatch,
    expectedPersonalDocument?: string,
  ): Promise<ResourceSummary> {
    if (changes.thumbnailBlob) {
      const asset = await this.assets.put(changes.thumbnailBlob, { source: 'thumbnail' })
      changes = { ...changes, thumbnailBlob: undefined, thumbnailAssetId: asset.assetId }
    }
    return this.database.transaction(
      'rw',
      [
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
      ],
      async () => {
        const current = await Dexie.waitFor(this.getSummary(id))
        if (!current) throw new Error('资源不存在，未修改资源')
        if (
          expectedPersonalDocument !== undefined &&
          JSON.stringify(current.metadata.personalDocument ?? null) !== expectedPersonalDocument
        )
          throw new Error('小手机内容已被其他操作修改，请重新打开后编辑')
        // Clone only the metadata. The original file never enters decryption, hashing or mirroring.
        const normalized = await cloneResourceForStorage({
          ...current,
          ...changes,
          metadata: { ...current.metadata, ...changes.metadata },
          originalBlob: new Blob(),
        })
        if ('thumbnailBlob' in changes) {
          normalized.thumbnailAssetId = changes.thumbnailAssetId
          normalized.thumbnailBlob = undefined
        }
        const summary = { ...toResourceSummary(normalized), thumbnailBlob: undefined }
        const encoded = this.vault
          ? await Dexie.waitFor(this.vault.encodeResourceSummary(summary))
          : summary
        const light = (
          await Dexie.waitFor(this.createStoredListSummariesFromSummaries([encoded]))
        )[0]!
        if (isAndroidNativeAppDatabaseActive()) {
          // Dexie.update() enumerates a primary-key range and hydrates the old
          // record before modify(). The keyed mutation keeps stored attachments
          // inside the same reserved transaction and still updates Dexie's indexes.
          const request = {
            trans: Dexie.currentTransaction!.idbtrans,
            type: 'put' as const,
            keys: [id],
            values: [encoded],
            upsert: false,
            updates: { keys: [id], changeSpecs: [encoded] },
            resourceMetadataOnly: true,
          }
          const result = await this.database.resources.core.mutate(request)
          if (result.numFailures) throw result.failures[0]
          if (!result.results?.length) throw new Error('资源已经不存在')
        } else if (!(await this.database.resources.update(id, encoded))) {
          throw new Error('资源已经不存在')
        }
        await this.database.resourceSummaries.put(light)
        await this.database.resourceListSummaries.put(light)
        return summary
      },
    )
  }

  async update(id: string, changes: Partial<Resource>): Promise<void> {
    if (
      !['originalBlob', 'contentHash', 'fileSize', 'fileName', 'mimeType', 'id', 'createdAt'].some(
        (key) => key in changes,
      )
    ) {
      await this.updateMetadata(id, changes)
      return
    }
    const stored = await this.database.resources.get(id)
    if (!stored) return
    const resource = hydrateResourceFromIndexedDb(
      (this.vault ? await this.vault.decodeResource(stored) : stored) as StoredResource,
    )
    const merged = { ...resource, ...changes }
    if (
      Object.prototype.hasOwnProperty.call(changes, 'thumbnailBlob') &&
      !(changes.thumbnailBlob instanceof Blob)
    ) {
      merged.thumbnailAssetId = undefined
    }
    const updated = await this.prepareResourceForStorage(merged)
    const encoded = this.vault ? await this.vault.encodeResource(updated) : updated
    const replaceStableBinaryIds = Object.prototype.hasOwnProperty.call(changes, 'thumbnailBlob')
      ? new Set([id])
      : undefined
    await this.putStoredResources([encoded], replaceStableBinaryIds)
  }

  async updateMetadataMany(
    patches: Array<{ id: string; changes: ResourceMetadataPatch }>,
  ): Promise<void> {
    if (!patches.length) return
    await this.database.transaction(
      'rw',
      [
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        this.database.assets,
        this.database.assetFiles,
      ],
      async () => {
        for (const { id, changes } of patches) await this.updateMetadata(id, changes)
      },
    )
  }

  async updateMany(ids: string[], changes: Partial<Resource>): Promise<void> {
    if (
      !['originalBlob', 'contentHash', 'fileSize', 'fileName', 'mimeType', 'id', 'createdAt'].some(
        (key) => key in changes,
      )
    ) {
      if (changes.thumbnailBlob) {
        const asset = await this.assets.put(changes.thumbnailBlob, { source: 'thumbnail' })
        changes = { ...changes, thumbnailBlob: undefined, thumbnailAssetId: asset.assetId }
      }
      // Keep all related indexes and the entire batch in one transaction.
      await this.database.transaction(
        'rw',
        [
          this.database.resources,
          this.database.resourceSummaries,
          this.database.resourceListSummaries,
          this.database.assets,
          this.database.assetFiles,
        ],
        async () => {
          for (const id of ids) await this.updateMetadata(id, changes)
        },
      )
      return
    }
    const stored = await this.database.resources.bulkGet(ids)
    const updated = await Promise.all(
      stored
        .flatMap((item) => (item ? [item] : []))
        .map(async (item) => {
          const resource = hydrateResourceFromIndexedDb(
            (this.vault ? await this.vault.decodeResource(item) : item) as StoredResource,
          )
          const merged = { ...resource, ...changes }
          if (
            Object.prototype.hasOwnProperty.call(changes, 'thumbnailBlob') &&
            !(changes.thumbnailBlob instanceof Blob)
          ) {
            merged.thumbnailAssetId = undefined
          }
          const normalized = await this.prepareResourceForStorage(merged)
          return this.vault ? this.vault.encodeResource(normalized) : normalized
        }),
    )
    if (updated.length) await this.putStoredResources(updated)
  }

  async delete(id: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.resources,
      this.database.resourceSummaries,
      this.database.resourceListSummaries,
      this.database.resourceVersions,
      this.database.resourceVersionSummaries,
      async () => {
        const versions = await this.database.resourceVersions
          .where('versionGroupId')
          .equals(id)
          .primaryKeys()
        if (versions.length) {
          await this.database.resourceVersions.bulkDelete(versions)
          await this.database.resourceVersionSummaries.bulkDelete(versions)
        }
        await this.database.resources.delete(id)
        await this.database.resourceSummaries.delete(id)
        await this.database.resourceListSummaries.delete(id)
      },
    )
  }

  async deleteMany(
    ids: string[],
    onProgress?: (progress: { completed: number; total: number }) => void,
  ): Promise<void> {
    const uniqueIds = Array.from(new Set(ids))
    if (!uniqueIds.length) return
    const versionsTable = this.database.resourceVersions
    // Dexie's anyOf().count() uses a value cursor; the native facade would load
    // every selected history attachment just to count it. Keys need no file reads.
    const versionCount = (
      await versionsTable.where('versionGroupId').anyOf(uniqueIds).primaryKeys()
    ).length
    const total = uniqueIds.length + versionCount
    const batchSize = 64
    let completed = 0
    onProgress?.({ completed, total })
    for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
      const batch = uniqueIds.slice(offset, offset + batchSize)
      let deletedVersions = 0
      await this.database.transaction(
        'rw',
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        versionsTable,
        this.database.resourceVersionSummaries,
        async () => {
          const versions = await versionsTable.where('versionGroupId').anyOf(batch).primaryKeys()
          deletedVersions = versions.length
          if (versions.length) {
            await versionsTable.bulkDelete(versions)
            await this.database.resourceVersionSummaries.bulkDelete(versions)
          }
          await this.database.resources.bulkDelete(batch)
          await this.database.resourceSummaries.bulkDelete(batch)
          await this.database.resourceListSummaries.bulkDelete(batch)
        },
      )
      completed += batch.length + deletedVersions
      onProgress?.({ completed, total })
    }
  }

  private async compactStoredSummary(
    resource: StoredResource,
    store: 'resources' | 'resourceVersions' = 'resources',
  ): Promise<StoredResourceSummary> {
    let summary = this.toStoredSummary(resource)
    if (
      isAndroidNativeAppDatabaseActive() &&
      isEncryptedResourceSummary(summary) &&
      !(summary.payload.data instanceof Blob)
    ) {
      const payload = summary.payload
      summary = {
        ...summary,
        payload: (await runAndroidNativeRead(Dexie.currentTransaction!.idbtrans, () =>
          decodeAppDatabaseValue(
            payload,
            store,
            encodeAppDatabaseKey(resource.id),
            nativeAppDatabase,
          ),
        )) as typeof summary.payload,
      }
    }
    return (await this.createStoredListSummariesFromSummaries([summary]))[0]!
  }

  private toStoredSummary(resource: StoredResource): StoredResourceSummary {
    if (isNativeBackedResource(resource)) {
      const { nativeOriginal: _nativeOriginal, ...summary } = resource
      return summary
    }
    if (!isEncryptedResource(resource))
      return { ...toResourceSummary(resource as Resource), thumbnailBlob: undefined }
    return {
      id: resource.id,
      contentHash: resource.contentHash,
      versionGroupId: resource.versionGroupId,
      updatedAt: resource.updatedAt,
      encrypted: true,
      payload: resource.payload,
    }
  }

  private async putStoredResources(
    resources: StoredResource[],
    replaceStableBinaryIds = new Set<string>(),
  ): Promise<void> {
    if (!resources.length) return
    const storedResources = await Promise.all(resources.map(materializeResourceForIndexedDb))
    const summaries = storedResources.map((resource) => this.toStoredSummary(resource))
    const listSummaries = await this.createStoredListSummariesFromSummaries(summaries)
    await this.database.transaction(
      'rw',
      this.database.resources,
      this.database.resourceSummaries,
      this.database.resourceListSummaries,
      async () => {
        for (const resource of storedResources) {
          const existing = await this.database.resources.get(resource.id)
          if (
            existing?.contentHash === resource.contentHash &&
            !replaceStableBinaryIds.has(resource.id)
          ) {
            await this.database.resources.update(
              resource.id,
              stripStableResourceBinaryFields(resource),
            )
          } else {
            await this.database.resources.put(resource)
          }
        }

        for (const summary of listSummaries) {
          const existing = await this.database.resourceSummaries.get(summary.id)
          if (
            existing?.contentHash === summary.contentHash &&
            !replaceStableBinaryIds.has(summary.id)
          ) {
            await this.database.resourceSummaries.update(
              summary.id,
              stripStableSummaryBinaryFields(summary),
            )
          } else {
            await this.database.resourceSummaries.put(summary)
          }
        }
        await this.database.resourceListSummaries.bulkPut(listSummaries)
      },
    )
  }

  private thumbnailContext(): ResourceThumbnailMaintenanceContext {
    const readThumbnailMigrationPromise = () => this.thumbnailMigrationPromise
    const writeThumbnailMigrationPromise = (
      value: ResourceThumbnailMaintenanceContext['thumbnailMigrationPromise'],
    ) => {
      this.thumbnailMigrationPromise = value
    }
    return {
      get thumbnailMigrationPromise() {
        return readThumbnailMigrationPromise()
      },
      set thumbnailMigrationPromise(value) {
        writeThumbnailMigrationPromise(value)
      },
      database: this.database,
      assets: this.assets,
      vault: this.vault,
      loadResource: (id) => this.get(id),
      toStoredSummary: this.toStoredSummary.bind(this),
      createStoredListSummariesFromSummaries:
        this.createStoredListSummariesFromSummaries.bind(this),
      repairResourceListSummaryIndex: this.repairResourceListSummaryIndex.bind(this),
    }
  }
}
