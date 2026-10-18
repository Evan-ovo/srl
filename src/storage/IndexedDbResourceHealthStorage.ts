import { isResourceOwnedFile } from '../types/ResourceAttachment'
import type { IndexableType } from 'dexie'
import type { ParsedResource } from '../types/Import'
import { chatLines } from '../parser/ChatResourceParser'
import type { NativeResourceLinkRecord } from './NativeResourceFileMirror'
import type { AppDatabase } from '../database/AppDatabase'
import {
  RESOURCE_TYPE,
  toResourceListSummary,
  isUserPersonaAvatarAttachment,
  type Resource,
  type ResourceSummary,
} from '../types/Resource'
import {
  isEncryptedResource,
  isNativeBackedResource,
  type NativeBackedResourceRecord,
  type StoredResource,
  type StoredResourceSummary,
} from '../types/Vault'
import type { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import { storedResourceBinarySize } from './ResourceStorageClone'
import { decodeAppDatabaseValue } from './AndroidAppDatabaseMigration'
import {
  compactAndroidNativeAppDatabase,
  isAndroidNativeAppDatabaseActive,
} from './AndroidNativeDexieCore'
import { nativeAppDatabase, type NativeAppDatabaseStore } from './NativeAppDatabaseBridge'

export interface NativeRecoveryInput {
  contentHash: string
  size: number
  nativeId?: string
  nativeScope?: 'current'
  fileName?: string
}

export interface LegacyLibraryHistoryCleanup {
  records: Array<{ id: string; size: number; createdAt: number }>
  bytes: number
}

export interface RecoveredNativeResource {
  link: NativeResourceLinkRecord
  outcome: 'created' | 'updated' | 'existing'
}

export interface ResourceStorageAccounting {
  browserStores?: Array<{ store: string; bytes: number; records: number }>
  currentOriginalBytes: number
  versionOriginalBytes: number
  nativeReferenceBytes: number
  localSnapshotBytes: number
  restoreStagingBytes: number
  assetBytes: number
  thumbnailAssetBytes: number
  assetCount: number
  thumbnailAssetCount: number
  recoveredPlaceholderCount: number
  recoveredPlaceholderBytes: number
  pendingNativeLinkCount: number
}

export interface StorageAccountingOptions {
  browserDetails?: boolean
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

// Logical payload estimate, not IndexedDB disk allocation. Never decode binary contents or
// stringify whole records (APP packages can contain large typed arrays and shared references).
function payloadBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'string') {
    let bytes = 0
    for (const character of value) {
      const point = character.codePointAt(0)!
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    }
    return bytes
  }
  if (typeof value === 'number') return 8
  if (typeof value === 'boolean') return 1
  if (typeof value === 'bigint') return payloadBytes(value.toString())
  if (!value || typeof value !== 'object' || seen.has(value)) return 0
  seen.add(value)
  if (value instanceof Blob) return value.size
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
  if (value instanceof Date) return 8
  if (value instanceof Map) {
    let bytes = 0
    for (const [key, item] of value) bytes += payloadBytes(key, seen) + payloadBytes(item, seen)
    return bytes
  }
  if (value instanceof Set) {
    let bytes = 0
    for (const item of value) bytes += payloadBytes(item, seen)
    return bytes
  }
  return Object.entries(value).reduce(
    (bytes, [key, item]) => bytes + payloadBytes(key) + payloadBytes(item, seen),
    0,
  )
}

export interface NativeMirrorDuplicationSummary {
  currentCount: number
  versionCount: number
  /** Logical IndexedDB Blob bytes. Actual quota/OS reclamation can be deferred by WebView. */
  reclaimableBytes: number
}

export interface NativeMirrorOffloadReport extends NativeMirrorDuplicationSummary {
  convertedCurrent: number
  convertedVersions: number
}

export interface ResourceHealthAudit {
  currentSummaryDrift: string[]
  listSummaryDrift: string[]
  versionSummaryDrift: string[]
  orphanVersions: string[]
  missingGeneratedImageFiles: string[]
  orphanGeneratedImageFiles: string[]
  corruptJsonResources: string[]
  unreachableExternalLinks: Array<{ resourceId: string; linkId: string; location: string }>
}

type IndexIdentity = Pick<StoredResource, 'id' | 'contentHash' | 'updatedAt' | 'versionGroupId'>
function indexDrift(sources: IndexIdentity[], summaries: StoredResourceSummary[]): string[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]))
  const drift = sources
    .filter((source) => {
      const summary = summaryById.get(source.id)
      return (
        !summary ||
        summary.contentHash !== source.contentHash ||
        summary.updatedAt !== source.updatedAt ||
        summary.versionGroupId !== source.versionGroupId
      )
    })
    .map((source) => source.id)
  drift.push(...summaries.filter((summary) => !sourceById.has(summary.id)).map(({ id }) => id))
  return [...new Set(drift)]
}

function safeLocation(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`.slice(0, 240)
  } catch {
    return '无效地址'
  }
}

async function isExternalLinkReachable(value: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), 5000)
  try {
    await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    globalThis.clearTimeout(timer)
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      output[index] = await mapper(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return output
}

export class IndexedDbResourceHealthStorage {
  private readonly database: AppDatabase
  private readonly resourceStorage: IndexedDbResourceStorage

  constructor(database: AppDatabase, resourceStorage: IndexedDbResourceStorage) {
    this.database = database
    this.resourceStorage = resourceStorage
  }

  private async *metadataRecords(
    store: NativeAppDatabaseStore,
    fields: readonly string[],
  ): AsyncGenerator<Record<string, unknown>> {
    const project = (record: Record<string, unknown>) =>
      Object.fromEntries(
        fields.map((field) => [
          field,
          field === 'metadata'
            ? {
                recoveredFromNativeObject: (record.metadata as Record<string, unknown> | undefined)
                  ?.recoveredFromNativeObject,
              }
            : record[field],
        ]),
      )
    if (isAndroidNativeAppDatabaseActive()) {
      let after: string | undefined
      do {
        const page = await nativeAppDatabase.getRecords(
          store,
          after,
          100,
          fields.map((field) =>
            field === 'metadata' ? 'metadata.recoveredFromNativeObject' : field,
          ),
        )
        for (const row of page.rows)
          yield (await decodeAppDatabaseValue(
            project(row.value),
            store,
            row.key,
            nativeAppDatabase,
            false,
          )) as Record<string, unknown>
        after = page.nextKey ?? undefined
      } while (after !== undefined)
      return
    }
    const table = this.database.table(store)
    const keys = await table.toCollection().primaryKeys()
    for (let offset = 0; offset < keys.length; offset += 100)
      for (const record of await table.bulkGet(keys.slice(offset, offset + 100)))
        if (record) yield project(record)
  }

  private async indexIdentities(store: 'resources' | 'resourceVersions'): Promise<IndexIdentity[]> {
    const identities: IndexIdentity[] = []
    for await (const row of this.metadataRecords(store, [
      'id',
      'contentHash',
      'updatedAt',
      'versionGroupId',
    ]))
      identities.push(row as IndexIdentity)
    return identities
  }

  async audit(options: { deep?: boolean } = {}): Promise<ResourceHealthAudit> {
    const [
      rawResources,
      summaries,
      listSummaries,
      versions,
      versionSummaries,
      generatedImageIds,
      generatedFileIds,
      summariesDecoded,
    ] = await Promise.all([
      this.indexIdentities('resources'),
      this.database.resourceSummaries.toArray(),
      this.database.resourceListSummaries.toArray(),
      this.indexIdentities('resourceVersions'),
      this.database.resourceVersionSummaries.toArray(),
      this.database.generatedImages.toCollection().primaryKeys(),
      this.database.generatedImageFiles.toCollection().primaryKeys(),
      options.deep === false ? Promise.resolve([]) : this.resourceStorage.listSummaries(),
    ])
    const resourceIds = new Set(rawResources.map(({ id }) => id))
    const imageIds = new Set(generatedImageIds.map(String))
    const fileIds = new Set(generatedFileIds.map(String))
    const jsonCandidates = summariesDecoded.filter((resource) => this.isJsonResource(resource))
    const jsonChecks = await mapWithConcurrency(jsonCandidates, 2, async (summary) => {
      const resource = await this.resourceStorage.get(summary.id)
      if (!resource) return summary.id
      try {
        if (this.isJsonLinesResource(summary)) {
          // JSONL is a sequence of JSON values, not one JSON document. Reuse the
          // bounded UTF-8 reader so long chats do not require a second full text copy.
          let lines = 0
          for await (const { text } of chatLines(resource.originalBlob)) {
            const source = text.replace(/^\uFEFF/, '').trim()
            if (!source) continue
            JSON.parse(source)
            lines++
          }
          if (!lines) return summary.id
        } else {
          JSON.parse(await resource.originalBlob.text())
        }
        return undefined
      } catch {
        return summary.id
      }
    })
    const corruptJsonResources = jsonChecks.filter((id): id is string => Boolean(id))

    // Link reachability only needs summary metadata. Do not materialize every original Blob
    // during a routine health scan; large APK/ZIP libraries must remain cheap to diagnose.
    const links = summariesDecoded.flatMap((resource) =>
      (resource.sourceLinks ?? []).map((link) => ({
        resourceId: resource.id,
        linkId: link.id,
        url: link.url,
      })),
    )
    const checkedLinks = await mapWithConcurrency(links, 4, async (link) => ({
      ...link,
      reachable: await isExternalLinkReachable(link.url),
    }))

    return {
      currentSummaryDrift: indexDrift(rawResources, summaries),
      listSummaryDrift: indexDrift(rawResources, listSummaries as StoredResourceSummary[]),
      versionSummaryDrift: indexDrift(versions, versionSummaries),
      orphanVersions: versions
        .filter((version) => !version.versionGroupId || !resourceIds.has(version.versionGroupId))
        .map(({ id }) => id),
      missingGeneratedImageFiles: [...imageIds].filter((id) => !fileIds.has(id)),
      orphanGeneratedImageFiles: [...fileIds].filter((id) => !imageIds.has(id)),
      corruptJsonResources,
      unreachableExternalLinks: checkedLinks
        .filter(({ reachable }) => !reachable)
        .map(({ resourceId, linkId, url }) => ({
          resourceId,
          linkId,
          location: safeLocation(url),
        })),
    }
  }

  /**
   * Fast-path a native object whose content already exists in the authoritative resource tables.
   * This runs before parsing/thumbnail generation so an orphan scan cannot create unused assets
   * merely to rediscover an already-known file. Old generic recovery placeholders deliberately
   * fall through so they can be reparsed and repaired in place.
   */
  async prepareExistingNativeCandidate(
    candidate: NativeRecoveryInput,
  ): Promise<NativeResourceLinkRecord | undefined> {
    const contentHash = candidate.contentHash.toLowerCase()
    if (
      !/^[a-f0-9]{64}$/.test(contentHash) ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0
    ) {
      throw new Error('找回原件哈希或大小无效')
    }
    return this.database.transaction(
      'rw',
      [this.database.resources, this.database.resourceVersions, this.database.settings],
      async () => {
        const current = await this.database.resources
          .where('contentHash')
          .equals(contentHash)
          .first()
        const existing =
          current ??
          (await this.database.resourceVersions.where('contentHash').equals(contentHash).first())
        if (!existing) return undefined
        if (isEncryptedResource(existing)) throw new Error('保险箱记录不能挂接明文原件')
        if (existing.fileSize !== candidate.size) throw new Error('已有记录与找回原件大小不一致')
        if (
          current &&
          existing.type === RESOURCE_TYPE.OTHER &&
          existing.metadata.recoveredFromNativeObject === true &&
          isNativeBackedResource(existing)
        ) {
          return undefined
        }
        const link: NativeResourceLinkRecord = {
          scope: current ? 'current' : 'versions',
          id: existing.id,
          fileName: existing.fileName,
          mimeType: existing.mimeType,
          resourceType: existing.type,
          hiddenFromDocuments:
            isUserPersonaAvatarAttachment(existing) || isResourceOwnedFile(existing),
          contentHash,
          size: candidate.size,
          updatedAt: existing.updatedAt,
        }
        await this.database.settings.put({
          id: this.nativeLinkKey(link),
          value: link,
          updatedAt: Date.now(),
        })
        return link
      },
    )
  }

  async nativeRecoveryCurrentIds(): Promise<string[]> {
    return (await this.database.resources.toCollection().primaryKeys()).map(String)
  }

  async nativeMirrorDuplicationSummary(): Promise<NativeMirrorDuplicationSummary> {
    const result: NativeMirrorDuplicationSummary = {
      currentCount: 0,
      versionCount: 0,
      reclaimableBytes: 0,
    }
    for (const [store, countKey] of [
      ['resources', 'currentCount'],
      ['resourceVersions', 'versionCount'],
    ] as const) {
      for await (const row of this.metadataRecords(store, [
        'encrypted',
        'original',
        'originalBlob',
        'nativeOriginal',
        'fileSize',
        'contentHash',
      ])) {
        const record = row as unknown as StoredResource
        if (
          !isEncryptedResource(record) &&
          !isNativeBackedResource(record) &&
          storedResourceBinarySize(record) === record.fileSize &&
          /^[a-f0-9]{64}$/i.test(record.contentHash)
        ) {
          result[countKey]++
          result.reclaimableBytes += storedResourceBinarySize(record)
        }
      }
    }
    return result
  }

  async *listNativeMirrorDuplicates(): AsyncGenerator<{
    scope: 'current' | 'versions'
    id: string
    contentHash: string
    size: number
  }> {
    for (const [table, scope] of [
      [this.database.resources, 'current'],
      [this.database.resourceVersions, 'versions'],
    ] as const) {
      let after = ''
      while (true) {
        const page = await table.where('id').above(after).limit(100).toArray()
        if (!page.length) break
        for (const record of page) {
          if (
            !isEncryptedResource(record) &&
            !isNativeBackedResource(record) &&
            storedResourceBinarySize(record) === record.fileSize &&
            /^[a-f0-9]{64}$/i.test(record.contentHash)
          ) {
            yield {
              scope,
              id: record.id,
              contentHash: record.contentHash.toLowerCase(),
              size: record.fileSize,
            }
          }
        }
        after = page[page.length - 1]!.id
      }
    }
  }

  async convertVerifiedNativeMirrors(
    records: Iterable<{
      scope: 'current' | 'versions'
      id: string
      contentHash: string
      size: number
    }>,
  ): Promise<NativeMirrorOffloadReport> {
    const report: NativeMirrorOffloadReport = {
      currentCount: 0,
      versionCount: 0,
      reclaimableBytes: 0,
      convertedCurrent: 0,
      convertedVersions: 0,
    }
    for (const item of records) {
      const table =
        item.scope === 'current' ? this.database.resources : this.database.resourceVersions
      const converted = await this.database.transaction('rw', table, async () => {
        const record = await table.get(item.id)
        if (
          !record ||
          isEncryptedResource(record) ||
          isNativeBackedResource(record) ||
          record.contentHash.toLowerCase() !== item.contentHash ||
          record.fileSize !== item.size ||
          storedResourceBinarySize(record) !== item.size
        )
          return false
        const { originalBlob: _originalBlob, ...metadata } = record
        const nativeRecord = {
          ...metadata,
          nativeOriginal: { version: 1, contentHash: item.contentHash, size: item.size },
        } as NativeBackedResourceRecord
        await table.put(nativeRecord)
        return true
      })
      if (!converted) continue
      if (item.scope === 'current') {
        report.currentCount++
        report.convertedCurrent++
      } else {
        report.versionCount++
        report.convertedVersions++
      }
      report.reclaimableBytes += item.size
    }
    return report
  }

  /** Commit one parsed descriptor and its indexes together; never persist/re-read the original. */
  async recoverNativeCandidate(
    candidate: NativeRecoveryInput,
    parsed: ParsedResource,
    fileName: string,
    mimeType: string,
    thumbnailAssetId?: string,
  ): Promise<RecoveredNativeResource> {
    const contentHash = candidate.contentHash.toLowerCase()
    if (
      !/^[a-f0-9]{64}$/.test(contentHash) ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0
    ) {
      throw new Error('找回原件哈希或大小无效')
    }
    return this.database.transaction(
      'rw',
      [
        this.database.resources,
        this.database.resourceVersions,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        this.database.settings,
      ],
      async () => {
        const current = await this.database.resources
          .where('contentHash')
          .equals(contentHash)
          .first()
        if (current && isEncryptedResource(current)) throw new Error('保险箱记录不能挂接明文原件')
        const existing =
          current ??
          (await this.database.resourceVersions.where('contentHash').equals(contentHash).first())
        if (existing && isEncryptedResource(existing)) throw new Error('保险箱记录不能挂接明文原件')
        if (existing && existing.fileSize !== candidate.size)
          throw new Error('已有记录与找回原件大小不一致')
        const placeholder =
          existing?.type === RESOURCE_TYPE.OTHER &&
          existing.metadata.recoveredFromNativeObject === true &&
          isNativeBackedResource(existing)
        const outcome = !existing ? 'created' : current && placeholder ? 'updated' : 'existing'
        const now = Date.now()
        const record =
          outcome === 'existing'
            ? existing!
            : ({
                ...(current ?? {}),
                id:
                  current?.id ??
                  (candidate.nativeScope === 'current' &&
                  candidate.nativeId &&
                  !(await this.database.resources.get(candidate.nativeId)) &&
                  !(await this.database.resourceVersions.get(candidate.nativeId))
                    ? candidate.nativeId
                    : crypto.randomUUID()),
                type: parsed.type,
                name:
                  current && current.name !== `找回文件 ${contentHash.slice(0, 8)}`
                    ? current.name
                    : parsed.name,
                description:
                  current && !current.description.startsWith('从 Android 本地对象库找回')
                    ? current.description
                    : parsed.description,
                fileName:
                  current && !/^recovered-[a-f0-9]+\.bin$/i.test(current.fileName)
                    ? current.fileName
                    : fileName,
                mimeType,
                fileSize: candidate.size,
                contentHash,
                favorite: current?.favorite ?? false,
                categoryId: current?.categoryId ?? null,
                categoryIds: current?.categoryIds ?? [],
                relatedResourceIds: current?.relatedResourceIds ?? [],
                sourceLinks: current?.sourceLinks ?? [],
                tags: [...new Set([...(current?.tags ?? []), ...(parsed.tags ?? []), '灾难恢复'])],
                metadata: {
                  ...parsed.metadata,
                  ...current?.metadata,
                  recoveredFromNativeObject: true,
                  nativeRecoveryParserVersion: 1,
                },
                thumbnailAssetId: current?.thumbnailAssetId ?? thumbnailAssetId,
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
                nativeOriginal: { version: 1 as const, contentHash, size: candidate.size },
              } satisfies NativeBackedResourceRecord)
        if (outcome !== 'existing') {
          await this.database.resources.put(record)
        }
        if (!existing || current) {
          // Also repair a partial prior attempt. Do not rebuild or clear unrelated tables.
          const {
            nativeOriginal: _native,
            thumbnailBlob: _thumbnail,
            originalBlob: _original,
            ...summary
          } = record as NativeBackedResourceRecord & Partial<Pick<Resource, 'originalBlob'>>
          await this.database.resourceSummaries.put(summary)
          await this.database.resourceListSummaries.put(toResourceListSummary(summary))
        }
        const link: NativeResourceLinkRecord = {
          scope: existing && !current ? 'versions' : 'current',
          id: record.id,
          fileName: record.fileName,
          mimeType: record.mimeType,
          resourceType: record.type,
          hiddenFromDocuments: isUserPersonaAvatarAttachment(record) || isResourceOwnedFile(record),
          contentHash,
          size: candidate.size,
          updatedAt: record.updatedAt,
        }
        await this.database.settings.put({
          id: this.nativeLinkKey(link),
          value: link,
          updatedAt: now,
        })
        return { outcome, link }
      },
    )
  }

  private nativeLinkKey(link: NativeResourceLinkRecord): string {
    return `native-recovery-link:${link.scope}:${link.id}`
  }

  async isNativeRecoveryLinkCurrent(link: NativeResourceLinkRecord): Promise<boolean> {
    const table =
      link.scope === 'current' ? this.database.resources : this.database.resourceVersions
    const record = await table.get(link.id)
    return Boolean(
      record &&
      !isEncryptedResource(record) &&
      record.contentHash === link.contentHash &&
      record.fileSize === link.size &&
      record.updatedAt === link.updatedAt &&
      record.type === link.resourceType,
    )
  }

  async completeNativeRecoveryLink(link: NativeResourceLinkRecord): Promise<void> {
    await this.database.transaction('rw', this.database.settings, async () => {
      const key = this.nativeLinkKey(link)
      const pending = await this.database.settings.get(key)
      // Do not acknowledge a newer concurrent repair's descriptor.
      if (pending && JSON.stringify(pending.value) === JSON.stringify(link)) {
        await this.database.settings.delete(key)
      }
    })
  }

  async *listPendingNativeLinks(): AsyncGenerator<NativeResourceLinkRecord> {
    const prefix = 'native-recovery-link:'
    let after = prefix
    while (true) {
      const page = await this.database.settings
        .where('id')
        .between(after, `${prefix}\uffff`, false, true)
        .limit(100)
        .toArray()
      if (!page.length) return
      for (const item of page) {
        const value = item.value as Partial<NativeResourceLinkRecord> | null
        if (
          value &&
          typeof value === 'object' &&
          (value.scope === 'current' || value.scope === 'versions') &&
          typeof value.id === 'string' &&
          typeof value.contentHash === 'string' &&
          /^[a-f0-9]{64}$/.test(value.contentHash) &&
          Number.isSafeInteger(value.size) &&
          typeof value.fileName === 'string' &&
          typeof value.mimeType === 'string' &&
          typeof value.resourceType === 'string' &&
          typeof value.updatedAt === 'number'
        ) {
          yield value as NativeResourceLinkRecord
        }
      }
      after = page[page.length - 1]!.id
    }
  }

  async *listRecoveredCandidates(): AsyncGenerator<NativeRecoveryInput> {
    let after = ''
    while (true) {
      const page = await this.database.resources.where('id').above(after).limit(100).toArray()
      if (!page.length) return
      for (const record of page) {
        if (
          !isEncryptedResource(record) &&
          isNativeBackedResource(record) &&
          record.type === RESOURCE_TYPE.OTHER &&
          record.metadata.recoveredFromNativeObject === true
        ) {
          yield { contentHash: record.contentHash, size: record.nativeOriginal.size }
        }
      }
      after = page[page.length - 1]!.id
    }
  }

  /** Logical payload bytes only. These are not disk usage and must not be added to native totals. */
  async legacyLibraryHistoryCleanup(): Promise<LegacyLibraryHistoryCleanup> {
    const records: LegacyLibraryHistoryCleanup['records'] = []
    let bytes = 0
    // Read metadata one record at a time; never decrypt or materialize a ZIP.
    await this.database.backupRecords
      .where('adapter')
      .equals('local-history')
      .each((record) => {
        const size = record.blob?.size ?? record.size ?? 0
        records.push({ id: record.id, size, createdAt: record.createdAt })
        bytes += size
      })
    records.sort((left, right) => left.id.localeCompare(right.id))
    return { records, bytes }
  }

  async clearLegacyLibraryHistory(plan: LegacyLibraryHistoryCleanup): Promise<number> {
    return this.database.transaction(
      'rw',
      this.database.backupRecords,
      this.database.settings,
      async () => {
        // Vault migration reads ZIPs outside its commit transaction. Its durable checkpoint
        // must be checked inside this transaction to prevent a converted record being put back.
        if ((await this.database.settings.get('local-vault-migration'))?.value) {
          throw new Error('保险库转换尚未完成，请完成转换后再清理旧整库快照')
        }
        const current = await this.legacyLibraryHistoryCleanup()
        if (JSON.stringify(current) !== JSON.stringify(plan)) {
          throw new Error('旧整库快照范围已变化，请重新确认清理')
        }
        await this.database.backupRecords.bulkDelete(current.records.map(({ id }) => id))
        await this.database.settings.delete('history.snapshotLimit')
        return current.bytes
      },
    )
  }

  async storageAccounting(
    options: StorageAccountingOptions = {},
  ): Promise<ResourceStorageAccounting> {
    const result: ResourceStorageAccounting = {
      currentOriginalBytes: 0,
      versionOriginalBytes: 0,
      nativeReferenceBytes: 0,
      localSnapshotBytes: 0,
      restoreStagingBytes: 0,
      assetBytes: 0,
      thumbnailAssetBytes: 0,
      assetCount: 0,
      thumbnailAssetCount: 0,
      recoveredPlaceholderCount: 0,
      recoveredPlaceholderBytes: 0,
      pendingNativeLinkCount: 0,
    }
    if (options.browserDetails && !isAndroidNativeAppDatabaseActive()) {
      result.browserStores = []
      // Read bounded pages: one cursor IPC per row is very slow in WebKit. APP program
      // records retain a cursor because each may contain a large in-memory typed-array package.
      // A cancelled/failed inventory never publishes a partial total as a complete result.
      for (const table of this.database.tables) {
        const store = table.name
        options.signal?.throwIfAborted()
        const part = { store, bytes: 0, records: 0 }
        const collect = (record: Record<string, unknown>) => {
          options.signal?.throwIfAborted()
          part.bytes += payloadBytes(record)
          part.records++
          if (store === 'resources' || store === 'resourceVersions') {
            const resource = record as unknown as StoredResource
            const key = store === 'resources' ? 'currentOriginalBytes' : 'versionOriginalBytes'
            if (isEncryptedResource(resource)) result[key] += resource.original.data.size
            else if (isNativeBackedResource(resource))
              result.nativeReferenceBytes += resource.nativeOriginal.size
            else result[key] += storedResourceBinarySize(resource)
            if (
              store === 'resources' &&
              !isEncryptedResource(resource) &&
              resource.type === RESOURCE_TYPE.OTHER &&
              resource.metadata?.recoveredFromNativeObject === true
            ) {
              result.recoveredPlaceholderCount++
              result.recoveredPlaceholderBytes += isNativeBackedResource(resource)
                ? resource.nativeOriginal.size
                : storedResourceBinarySize(resource)
            }
          } else if (store === 'backupRecords')
            result.localSnapshotBytes += (record.blob as Blob | undefined)?.size ?? 0
          else if (store === 'restoreStagingChunks')
            result.restoreStagingBytes +=
              (record.data as ArrayBuffer | undefined)?.byteLength ??
              (record.data as Blob | undefined)?.size ??
              (record.blob as Blob | undefined)?.size ??
              0
          else if (store === 'assets') {
            result.assetBytes += record.size as number
            result.assetCount++
            if (record.source === 'thumbnail') {
              result.thumbnailAssetBytes += record.size as number
              result.thumbnailAssetCount++
            }
          } else if (store === 'settings' && String(record.id).startsWith('native-recovery-link:'))
            result.pendingNativeLinkCount++
        }
        if (store === 'externalAppRuntimes') await table.toCollection().each(collect)
        else {
          let after: IndexableType | undefined
          for (;;) {
            options.signal?.throwIfAborted()
            const page: Record<string, unknown>[] = await (
              after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
            )
              .limit(100)
              .toArray()
            for (const record of page) collect(record)
            if (page.length < 100) break
            const last = page[page.length - 1]!
            const keyPath = table.schema.primKey.keyPath!
            after = (
              Array.isArray(keyPath) ? keyPath.map((key) => last[key]) : last[keyPath]
            ) as typeof after
          }
        }
        result.browserStores.push(part)
        options.onProgress?.(result.browserStores.length, this.database.tables.length)
      }
      options.signal?.throwIfAborted()
      return result
    }
    for (const [store, key] of [
      ['resources', 'currentOriginalBytes'],
      ['resourceVersions', 'versionOriginalBytes'],
    ] as const) {
      for await (const row of this.metadataRecords(store, [
        'encrypted',
        'original',
        'originalBlob',
        'nativeOriginal',
        'type',
        'metadata',
      ])) {
        const record = row as unknown as StoredResource
        if (isEncryptedResource(record)) result[key] += record.original.data.size
        else if (isNativeBackedResource(record))
          result.nativeReferenceBytes += record.nativeOriginal.size
        else result[key] += storedResourceBinarySize(record)
        if (
          key === 'currentOriginalBytes' &&
          !isEncryptedResource(record) &&
          record.type === RESOURCE_TYPE.OTHER &&
          record.metadata?.recoveredFromNativeObject === true
        ) {
          result.recoveredPlaceholderCount++
          result.recoveredPlaceholderBytes += isNativeBackedResource(record)
            ? record.nativeOriginal.size
            : storedResourceBinarySize(record)
        }
      }
    }
    for await (const record of this.metadataRecords('backupRecords', ['blob']))
      result.localSnapshotBytes += (record.blob as { size?: number } | undefined)?.size ?? 0
    for await (const record of this.metadataRecords('restoreStagingChunks', ['data', 'blob']))
      result.restoreStagingBytes +=
        (record.data as { byteLength?: number; size?: number } | undefined)?.byteLength ??
        (record.data as { size?: number } | undefined)?.size ??
        (record.blob as { size?: number } | undefined)?.size ??
        0
    await this.database.assets.toCollection().each((record) => {
      result.assetBytes += record.size
      result.assetCount++
      if (record.source === 'thumbnail') {
        result.thumbnailAssetBytes += record.size
        result.thumbnailAssetCount++
      }
    })
    result.pendingNativeLinkCount = await this.database.settings
      .where('id')
      .startsWith('native-recovery-link:')
      .count()
    return result
  }

  repairDerivedIndexes(): Promise<void> {
    return this.resourceStorage.repairDerivedIndexes()
  }

  async optimizeDerivedSummaries() {
    if (await this.getSummaryCompactionStatus())
      return { alreadyCompact: true, beforeBytes: 0, afterBytes: 0 }
    await this.resourceStorage.repairDerivedIndexes()
    return compactAndroidNativeAppDatabase()
  }

  getSummaryCompactionStatus(): Promise<boolean> {
    return this.resourceStorage.areDerivedSummariesCompact()
  }

  private isJsonResource(resource: Pick<ResourceSummary, 'mimeType' | 'fileName'>): boolean {
    return (
      resource.mimeType.includes('json') ||
      resource.fileName.toLocaleLowerCase().endsWith('.json') ||
      this.isJsonLinesResource(resource)
    )
  }

  private isJsonLinesResource(resource: Pick<ResourceSummary, 'mimeType' | 'fileName'>): boolean {
    return (
      /\.(jsonl|ndjson)$/i.test(resource.fileName) ||
      /(?:ndjson|jsonl|jsonlines)/i.test(resource.mimeType)
    )
  }
}
