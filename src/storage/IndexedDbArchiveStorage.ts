import { isResourceOwnedFile } from '../types/ResourceAttachment'
import { restoreVersionKey } from '../utils/RestoreIdentity'
import Dexie from 'dexie'
import type { AppDatabase } from '../database/AppDatabase'
import type { VaultService } from '../services/VaultService'
import {
  isUserPersonaAvatarAttachment,
  toResourceListSummary,
  toResourceSummary,
  type Category,
  type Resource,
  type ResourceSummary,
  type BackupRecord,
  type BackupRecordSummary,
} from '../types/Resource'
import {
  isEncryptedResource,
  isNativeBackedResource,
  type NativeBackedResourceRecord,
  type StoredResource,
  type StoredResourceSummary,
} from '../types/Vault'
import type { ArchiveRestoreProgress, ArchiveStorageAdapter } from './ArchiveStorageAdapter'
import type { StagedArchiveRecord } from '../types/RestoreStaging'
import { materializeResourceForIndexedDb } from './ResourceStorageClone'
import { IndexedDbAssetStore } from './IndexedDbAssetStore'
import {
  linkNativeResourceObjects,
  releaseReplacedNativeObjects,
  type NativeObjectReplacement,
} from './NativeResourceFileMirror'
import { isAndroidNativeAppDatabaseActive } from './AndroidNativeDexieCore'
import { isEncodedBlobValue } from './AndroidAppDatabaseMigration'
import { readResourceMetadataBatch } from './ResourceReadSource'

function toBackupRecordSummary(record: BackupRecord): BackupRecordSummary {
  const { blob, ...summary } = record
  return {
    ...summary,
    size: summary.size ?? (blob instanceof Blob || isEncodedBlobValue(blob) ? blob.size : 0),
  }
}

export async function getBackupRecordSummary(
  database: AppDatabase,
  id: string,
): Promise<BackupRecordSummary | undefined> {
  const table = database.backupRecords
  return database.transaction('r', table, async (transaction) => {
    const request = { trans: transaction.idbtrans, key: id, loadBinary: false }
    const record = isAndroidNativeAppDatabaseActive()
      ? ((await table.core.get(request)) as BackupRecord | undefined)
      : await table.get(id)
    return record ? toBackupRecordSummary(record) : undefined
  })
}

/** Archive lists retain metadata only; normal get()/restore still hydrate the selected Blob. */
export async function listBackupRecordSummaries(
  database: AppDatabase,
  adapters: string[],
): Promise<BackupRecordSummary[]> {
  const table = database.backupRecords
  return database.transaction('r', table, async (transaction) => {
    const collection = table.where('adapter').anyOf(adapters)
    if (!isAndroidNativeAppDatabaseActive())
      return (await collection.toArray()).map(toBackupRecordSummary)
    const keys = await collection.primaryKeys()
    const summaries: BackupRecordSummary[] = []
    for (let offset = 0; offset < keys.length; offset += 100) {
      const request = {
        trans: transaction.idbtrans,
        keys: keys.slice(offset, offset + 100),
        loadBinary: false,
      }
      const records = (await table.core.getMany(request)) as Array<BackupRecord | undefined>
      for (const record of records) if (record) summaries.push(toBackupRecordSummary(record))
    }
    return summaries
  })
}

const RESTORE_INLINE_ORIGINAL_LIMIT = 1024 * 1024

async function detachStoredBlob(
  blob: Blob,
  onProgress?: (transferredBytes: number, totalBytes: number) => void,
  fileName?: string,
): Promise<Blob> {
  // Use the browser's local Blob loader. Response(blob.stream()) can stall in WebKit
  // when copying a large IDB-backed file while its write transaction is active.
  const url = URL.createObjectURL(blob)
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error('无法读取恢复暂存原文件')
    const reader = response.body?.getReader()
    let detached: Blob
    if (!reader) {
      detached = await response.blob()
      onProgress?.(blob.size, blob.size)
    } else {
      const chunks: ArrayBuffer[] = []
      let transferredBytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const chunk = new ArrayBuffer(value.byteLength)
        new Uint8Array(chunk).set(value)
        chunks.push(chunk)
        transferredBytes += value.byteLength
        onProgress?.(transferredBytes, blob.size)
      }
      detached = new Blob(chunks, { type: blob.type })
    }
    if (detached.size !== blob.size) throw new Error('恢复暂存原文件读取不完整')
    return detached.slice(0, detached.size, blob.type)
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'QuotaExceededError'].includes(error.name))
      throw error
    throw new Error(
      `读取本机恢复暂存原文件失败${fileName ? `：${fileName}` : ''}。这是本机暂存读取阶段，不能据此判断 GitHub 或浏览器网络断开。${error instanceof Error ? `\n${error.message}` : ''}`,
      { cause: error },
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}

export class IndexedDbArchiveStorage implements ArchiveStorageAdapter {
  private readonly database: AppDatabase
  private readonly vault?: VaultService
  private readonly assets: IndexedDbAssetStore

  constructor(
    database: AppDatabase,
    vault?: VaultService,
    assets = new IndexedDbAssetStore(database, vault),
  ) {
    this.database = database
    this.vault = vault
    this.assets = assets
  }

  async listRestoreVersionKeys(groupIds?: readonly string[]): Promise<string[]> {
    const keys: string[] = []
    if (groupIds && !groupIds.length) return keys
    const table = this.database.resourceVersions
    const ids = await (
      groupIds ? table.where('versionGroupId').anyOf([...new Set(groupIds)]) : table.toCollection()
    ).primaryKeys()
    for (let offset = 0; offset < ids.length; offset += 250) {
      const records = await readResourceMetadataBatch(
        this.database,
        ids.slice(offset, offset + 250),
        'resourceVersions',
      )
      for (const record of records) {
        if (!record) continue
        const stored = toStoredSummary(record)
        if (isEncryptedResource(record) && !this.vault)
          throw new Error('请先解锁保险箱再恢复历史版本')
        const summary = this.vault
          ? await this.vault.decodeResourceSummary(stored)
          : (stored as ResourceSummary)
        keys.push(restoreVersionKey(summary))
      }
    }
    return keys
  }

  canRestoreNative(): boolean {
    return this.vault?.isEnabled() !== true
  }

  async isRestoreCommitted(checkpointId: string): Promise<boolean> {
    return (
      (await this.database.settings.get(`archive-restore-commit:${checkpointId}`))?.value === true
    )
  }

  async clearRestoreCheckpoint(checkpointId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.settings,
      this.database.restoreStaging,
      async () => {
        await this.database.settings.delete(`archive-restore-commit:${checkpointId}`)
        await this.database.restoreStaging.where('jobId').equals(`commit:${checkpointId}`).delete()
      },
    )
  }

  async restore(
    categories: Category[],
    resources: Resource[],
    versions: Resource[] = [],
    hydrate: (resource: Resource) => Promise<Resource> = async (resource) => resource,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void> {
    await this.writeResources(
      categories,
      resources,
      versions,
      hydrate,
      false,
      onProgress,
      checkpointId,
    )
  }

  private async writeResources(
    categories: Category[],
    resources: Resource[],
    versions: Resource[],
    hydrate: (resource: Resource) => Promise<Resource>,
    replace = false,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void> {
    await this.restoreStaged(
      categories,
      resources,
      versions,
      async (resource) => {
        const ready = await this.assets.externalizeResourceThumbnail(await hydrate(resource))
        const stored = this.vault ? await this.vault.encodeResource(ready) : ready
        const light = toResourceListSummary(ready)
        return {
          resource: stored,
          listSummary: this.vault ? await this.vault.encodeResourceSummary(light) : light,
        }
      },
      undefined,
      replace,
      onProgress,
      checkpointId,
    )
  }

  async restoreNative(
    categories: Category[],
    resources: NativeBackedResourceRecord[],
    versions: NativeBackedResourceRecord[] = [],
    hydrate: (resource: NativeBackedResourceRecord) => Promise<NativeBackedResourceRecord> = async (
      resource,
    ) => resource,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
  ): Promise<void> {
    if (!this.canRestoreNative()) {
      throw new Error('资源库保险箱开启时不能保存 Android 原生明文引用')
    }
    let replacements: NativeObjectReplacement[] = []
    await this.restoreStaged(
      categories,
      resources,
      versions,
      async (resource) => {
        const record = await hydrate(resource)
        return {
          resource: record,
          listSummary: toNativeListSummary(record),
        }
      },
      () =>
        linkNativeResourceObjects(
          [
            ...resources.map((resource) => nativeLinkRecord(resource, 'current')),
            ...versions.map((resource) => nativeLinkRecord(resource, 'versions')),
          ],
          (records) => {
            replacements = records
          },
        ),
      false,
      onProgress,
    )
    // Native links are prepared before the database transaction. GC belongs after its commit.
    await releaseReplacedNativeObjects(replacements).catch(() => undefined)
  }

  private async stageOriginal(record: StagedArchiveRecord): Promise<StagedArchiveRecord> {
    const resource = record.resource
    if (isEncryptedResource(resource) || isNativeBackedResource(resource)) return record
    const original = resource.originalBlob as Blob | ArrayBuffer
    if (!(original instanceof Blob) || original.size > RESTORE_INLINE_ORIGINAL_LIMIT) return record
    // Reuse ordinary byte-backed resource storage for small bodies, before the commit transaction.
    return { ...record, resource: await materializeResourceForIndexedDb(resource) }
  }

  private async restoreStaged<T extends Resource | NativeBackedResourceRecord>(
    categories: Category[],
    resources: T[],
    versions: T[],
    prepare: (resource: T) => Promise<StagedArchiveRecord>,
    beforeCommit?: () => Promise<unknown>,
    replace = false,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void> {
    if (checkpointId && (await this.isRestoreCommitted(checkpointId))) return
    const storedCategories = this.vault
      ? await Promise.all(categories.map((category) => this.vault!.encodeCategory(category)))
      : categories
    const jobId = checkpointId ? `commit:${checkpointId}` : crypto.randomUUID()
    try {
      // Small byte-backed originals avoid the local Blob loader; large originals retain its established path.
      const total = resources.length + versions.length
      const totalBytes = [...resources, ...versions].reduce(
        (sum, resource) => sum + Math.max(0, resource.fileSize),
        0,
      )
      let prepared = 0
      for (const [scope, records] of [
        ['current', resources],
        ['versions', versions],
      ] as const) {
        for (let index = 0; index < records.length; index++) {
          onProgress?.({
            phase: 'prepare',
            completed: prepared,
            total,
            fileName: records[index]!.fileName,
          })
          // Older runtimes keep their legacy checkpoint paths and can rehydrate safely.
          const path = `prepared/${scope}/${index}`
          const previous = checkpointId
            ? ((await this.database.restoreStaging.get([jobId, path])) ??
              (await this.database.restoreStaging.get([jobId, `${scope}/${index}`])))
            : undefined
          const planned = records[index]!
          if (
            previous &&
            (previous.sha256 !== planned.contentHash ||
              previous.size !== planned.fileSize ||
              previous.record?.resource.id !== planned.id ||
              previous.record.resource.updatedAt !== planned.updatedAt)
          ) {
            throw new Error('恢复检查点与当前计划不一致，请重新预检')
          }
          if (!previous?.record || previous.path !== path) {
            const record = await this.stageOriginal(previous?.record ?? (await prepare(planned)))
            await this.database.restoreStaging.put({
              jobId,
              path,
              size: records[index]!.fileSize,
              sha256: records[index]!.contentHash,
              updatedAt: Date.now(),
              record,
            })
          }
          prepared += 1
          onProgress?.({
            phase: 'prepare',
            completed: prepared,
            total,
            fileName: records[index]!.fileName,
          })
        }
      }
      await beforeCommit?.()
      await this.database.transaction(
        'rw',
        [
          this.database.categories,
          this.database.resources,
          this.database.resourceSummaries,
          this.database.resourceListSummaries,
          this.database.resourceVersions,
          this.database.resourceVersionSummaries,
          this.database.restoreStaging,
          this.database.settings,
        ],
        async () => {
          if (checkpointId && (await this.isRestoreCommitted(checkpointId))) return
          if (replace) {
            await this.database.categories.clear()
            await this.database.resources.clear()
            await this.database.resourceSummaries.clear()
            await this.database.resourceListSummaries.clear()
            await this.database.resourceVersions.clear()
            await this.database.resourceVersionSummaries.clear()
          }
          if (storedCategories.length) await this.database.categories.bulkPut(storedCategories)
          // Small originals already use ordinary byte storage; larger Blob backing keeps its compatibility copy.
          let committed = 0
          let committedBytes = 0
          for (const [scope, records] of [
            ['current', resources],
            ['versions', versions],
          ] as const) {
            for (let index = 0; index < records.length; index++) {
              onProgress?.({
                phase: 'commit',
                completed: committed,
                total,
                fileName: records[index]!.fileName,
              })
              const path = `prepared/${scope}/${index}`
              const staged = await this.database.restoreStaging
                .get([jobId, path])
                .catch((error: unknown) => {
                  if (
                    error instanceof Error &&
                    ['AbortError', 'QuotaExceededError'].includes(error.name)
                  )
                    throw error
                  throw new Error(`读取本机恢复暂存记录失败：${records[index]!.fileName}`, {
                    cause: error,
                  })
                })
              const record = staged?.record
              if (!record) throw new Error('恢复暂存记录缺失，已取消索引提交')
              if (
                !isEncryptedResource(record.resource) &&
                !isNativeBackedResource(record.resource) &&
                record.resource.originalBlob instanceof Blob
              ) {
                record.resource.originalBlob = await Dexie.waitFor(
                  detachStoredBlob(
                    record.resource.originalBlob,
                    (bytes) =>
                      onProgress?.({
                        phase: 'commit',
                        completed: committed,
                        total,
                        fileName: records[index]!.fileName,
                        transferredBytes: committedBytes + bytes,
                        totalBytes,
                      }),
                    records[index]!.fileName,
                  ),
                )
              }
              if (scope === 'current') {
                await this.database.resources.put(record.resource)
                await this.database.resourceSummaries.put(toStoredSummary(record.resource))
                await this.database.resourceListSummaries.put(record.listSummary)
              } else {
                await this.database.resourceVersions.put(record.resource)
                await this.database.resourceVersionSummaries.put(toStoredSummary(record.resource))
              }
              await this.database.restoreStaging.delete([jobId, path])
              if (checkpointId)
                await this.database.restoreStaging.delete([jobId, `${scope}/${index}`])
              committed += 1
              committedBytes += records[index]!.fileSize
              onProgress?.({
                phase: 'commit',
                completed: committed,
                total,
                fileName: records[index]!.fileName,
                transferredBytes: committedBytes,
                totalBytes,
              })
            }
          }
          if (checkpointId)
            await this.database.settings.put({
              id: `archive-restore-commit:${checkpointId}`,
              value: true,
              updatedAt: Date.now(),
            })
        },
      )
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        (error.name === 'QuotaExceededError' ||
          ('message' in error &&
            typeof error.message === 'string' &&
            error.message.includes('QuotaExceededError')))
      ) {
        throw new Error('浏览器可用存储空间不足，导入未完成，原有资源未改变。请释放空间后重试。', {
          cause: error,
        })
      }
      throw error
    } finally {
      if (!checkpointId) await this.database.restoreStaging.where('jobId').equals(jobId).delete()
    }
  }

  async replace(
    categories: Category[],
    resources: Resource[],
    versions: Resource[] = [],
    hydrate: (resource: Resource) => Promise<Resource> = async (resource) => resource,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void> {
    await this.writeResources(
      categories,
      resources,
      versions,
      hydrate,
      true,
      onProgress,
      checkpointId,
    )
  }
}

function toStoredSummary(resource: StoredResource): StoredResourceSummary {
  if (isNativeBackedResource(resource)) {
    const { nativeOriginal: _nativeOriginal, ...summary } = resource
    return toResourceSummary(summary as Resource)
  }
  if (!isEncryptedResource(resource)) return toResourceSummary(resource)
  return {
    id: resource.id,
    contentHash: resource.contentHash,
    versionGroupId: resource.versionGroupId,
    updatedAt: resource.updatedAt,
    encrypted: true,
    payload: resource.payload,
  }
}

function toNativeListSummary(resource: NativeBackedResourceRecord): StoredResourceSummary {
  const { nativeOriginal: _nativeOriginal, ...summary } = resource
  return toResourceListSummary(summary as Resource)
}

function nativeLinkRecord(resource: NativeBackedResourceRecord, scope: 'current' | 'versions') {
  return {
    scope,
    id: resource.id,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
    resourceType: resource.type,
    hiddenFromDocuments: isUserPersonaAvatarAttachment(resource) || isResourceOwnedFile(resource),
    contentHash: resource.nativeOriginal.contentHash,
    size: resource.nativeOriginal.size,
    updatedAt: resource.updatedAt,
  } as const
}
