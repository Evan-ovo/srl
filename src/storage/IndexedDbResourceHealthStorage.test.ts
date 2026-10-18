import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import type { Resource } from '../types/Resource'
import { IndexedDbResourceHealthStorage } from './IndexedDbResourceHealthStorage'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import { nativeAppDatabase } from './NativeAppDatabaseBridge'
import {
  activateAndroidNativeAppDatabase,
  deactivateAndroidNativeAppDatabase,
} from './AndroidNativeDexieCore'

function resource(id: string, body = '{"ok":true}'): Resource {
  return {
    id,
    type: 'other',
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: body.length,
    contentHash: `hash-${id}`,
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    sourceLinks: [],
    tags: [],
    metadata: {},
    originalBlob: new Blob([body], { type: 'application/json' }),
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('IndexedDbResourceHealthStorage', () => {
  let database: AppDatabase
  let storage: IndexedDbResourceStorage
  let health: IndexedDbResourceHealthStorage

  beforeEach(() => {
    database = new AppDatabase(`health-${crypto.randomUUID()}`)
    storage = new IndexedDbResourceStorage(database)
    health = new IndexedDbResourceHealthStorage(database, storage)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
  })

  afterEach(async () => {
    deactivateAndroidNativeAppDatabase()
    vi.restoreAllMocks()
    await database.delete()
    vi.unstubAllGlobals()
  })

  it('audits 3000 native originals and measures their sizes without reading binary payloads', async () => {
    const rows = Array.from({ length: 3000 }, (_, index) => ({
      key: JSON.stringify(`native-${index.toString().padStart(4, '0')}`),
      value: {
        ...resource(`native-${index.toString().padStart(4, '0')}`),
        contentHash: 'a'.repeat(64),
        fileName: 'card.png',
        mimeType: 'image/png',
        fileSize: 1024 * 1024,
        originalBlob: {
          __srlAppDatabaseValueV1: 'blob',
          fieldPath: '$/originalBlob',
          size: 1024 * 1024,
          sha256: 'a'.repeat(64),
          mimeType: 'image/png',
        },
      },
    }))
    const getRecords = vi
      .spyOn(nativeAppDatabase, 'getRecords')
      .mockImplementation(async (store, after, limit = 250) => {
        const pending =
          store === 'resources' ? rows.filter((row) => after === undefined || row.key > after) : []
        const page = pending.slice(0, limit)
        return { rows: page, nextKey: pending.length > limit ? page.at(-1)!.key : undefined }
      })
    const binary = vi
      .spyOn(nativeAppDatabase, 'readBlob')
      .mockRejectedValue(new Error('Health metadata must not read originals'))
    activateAndroidNativeAppDatabase()
    const audit = await health.audit()
    expect(audit.currentSummaryDrift).toHaveLength(3000)
    const nativeAccounting = await health.storageAccounting({ browserDetails: true })
    expect(nativeAccounting.currentOriginalBytes).toBe(3000 * 1024 * 1024)
    expect(nativeAccounting.browserStores).toBeUndefined()
    expect((await health.nativeMirrorDuplicationSummary()).reclaimableBytes).toBe(
      3000 * 1024 * 1024,
    )
    expect(binary).not.toHaveBeenCalled()
    expect(getRecords.mock.calls.every((call) => call[2] === 100)).toBe(true)
    expect(getRecords.mock.calls.every((call) => Array.isArray(call[3]))).toBe(true)
    expect(getRecords.mock.calls.some((call) => call[3]?.includes('originalBlob'))).toBe(true)
    expect(getRecords.mock.calls.every((call) => !call[3]?.includes('metadata'))).toBe(true)
  })

  it('inventories browser records once by store without decoding binary payloads or writing data', async () => {
    const file = new Blob([new Uint8Array(1024)])
    await storage.save(resource('browser'))
    await database.resourceVersions.put({ ...resource('old'), versionGroupId: 'browser' })
    await database.externalAppData.put({
      id: 'app-data',
      appId: 'reader',
      key: 'books',
      value: { text: '中文😀', file },
      updatedAt: 1,
    })
    await database.externalAppRuntimes.put({
      id: 'reader',
      runtimeHtml: '<html/>',
      packageFiles: { 'data.bin': new Uint8Array(2048) },
      updatedAt: 1,
    })
    await database.assets.put({
      assetId: 'cover',
      contentHash: 'hash',
      mimeType: 'image/png',
      size: 1024,
      source: 'thumbnail',
      thumbnailRefs: {},
      createdAt: 1,
    })
    await database.assetFiles.put({ assetId: 'cover', blob: file, updatedAt: 1 })
    await database.settings.put({ id: 'native-recovery-link:pending', value: {}, updatedAt: 1 })
    const read = vi
      .spyOn(Blob.prototype, 'arrayBuffer')
      .mockRejectedValue(new Error('binary must not be read'))
    const text = vi
      .spyOn(Blob.prototype, 'text')
      .mockRejectedValue(new Error('binary must not be decoded'))
    const progress = vi.fn()
    const result = await health.storageAccounting({ browserDetails: true, onProgress: progress })
    expect(result.currentOriginalBytes).toBe(11)
    expect(result.versionOriginalBytes).toBe(11)
    expect(result.assetBytes).toBe(1024)
    expect(result.thumbnailAssetCount).toBe(1)
    expect(result.pendingNativeLinkCount).toBe(1)
    expect(result.browserStores).toHaveLength(database.tables.length)
    expect(result.browserStores!.find((part) => part.store === 'externalAppData')).toEqual({
      store: 'externalAppData',
      bytes: 1093,
      records: 1,
    })
    expect(
      result.browserStores!.find((part) => part.store === 'externalAppRuntimes')!.bytes,
    ).toBeGreaterThan(2048)
    expect(progress).toHaveBeenCalledTimes(database.tables.length)
    expect(read).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(await health.storageAccounting({ browserDetails: true })).toEqual(result)
    expect(await database.externalAppData.count()).toBe(1)
    expect((await database.externalAppData.get('app-data'))!.value).toHaveProperty('text', '中文😀')
  })

  it('stops between browser stores and never starts remaining stores or resumes automatically', async () => {
    const controller = new AbortController()
    const progress = vi.fn(() => controller.abort())
    await expect(
      health.storageAccounting({
        browserDetails: true,
        signal: controller.signal,
        onProgress: progress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toHaveBeenCalledOnce()
    await expect(
      health.storageAccounting({
        browserDetails: true,
        signal: controller.signal,
        onProgress: progress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toHaveBeenCalledOnce()
    expect((await health.storageAccounting({ browserDetails: true })).browserStores).toHaveLength(
      database.tables.length,
    )
  })

  it('pages 1000 APP data records and propagates unavailable stores instead of reporting zero', async () => {
    await database.externalAppData.bulkPut(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `app-${index}`,
        appId: 'reader',
        key: 'books',
        value: '中文😀',
        updatedAt: 1,
      })),
    )
    const result = await health.storageAccounting({ browserDetails: true })
    expect(result.browserStores!.find((part) => part.store === 'externalAppData')!.records).toBe(
      1000,
    )
    const table = vi.spyOn(Object.getPrototypeOf(database.resources), 'orderBy')
    table.mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    await expect(health.storageAccounting({ browserDetails: true })).rejects.toThrow(
      'storage unavailable',
    )
  })

  it('keeps 100-row browser pages complete across compound staging keys without decoding buffers', async () => {
    await database.restoreStagingChunks.bulkPut(
      Array.from({ length: 205 }, (_, index) => ({
        jobId: `job-${Math.floor(index / 150)}`,
        path: 'resource.bin',
        chunkIndex: index,
        data: new Uint8Array(1024).buffer,
        updatedAt: 1,
      })),
    )
    const pages = vi.spyOn(
      Object.getPrototypeOf(database.restoreStagingChunks.orderBy(':id')),
      'toArray',
    )
    const result = await health.storageAccounting({ browserDetails: true })
    expect(result.restoreStagingBytes).toBe(205 * 1024)
    expect(
      result.browserStores!.find((part) => part.store === 'restoreStagingChunks')!.records,
    ).toBe(205)
    const batches = await Promise.all(pages.mock.results.map((call) => call.value))
    expect(batches.every((batch) => batch.length <= 100)).toBe(true)
    expect(batches.filter((batch) => batch.length === 100)).toHaveLength(2)
  })

  it('keeps corrupt original parsing in explicit deep audits and skips it for quick scans', async () => {
    await storage.save(resource('corrupt', '{invalid json'))
    const quick = await health.audit({ deep: false })
    expect(quick.corruptJsonResources).toEqual([])
    const deep = await health.audit({ deep: true })
    expect(deep.corruptJsonResources).toEqual(['corrupt'])
  })

  it('does not rebuild already compact summaries or compact the native database again', async () => {
    await storage.save(resource('compact'))
    const rebuild = vi.spyOn(storage, 'repairDerivedIndexes')
    await expect(health.getSummaryCompactionStatus()).resolves.toBe(true)
    await expect(health.optimizeDerivedSummaries()).resolves.toMatchObject({ alreadyCompact: true })
    expect(rebuild).not.toHaveBeenCalled()
    expect((await storage.get('compact'))?.originalBlob.size).toBe(11)
  })

  it('clears only the confirmed whole-library history, preserving recycler, cloud records and resource versions', async () => {
    await database.backupRecords.bulkPut(
      [
        'local-history',
        'local-recycle-bin',
        'local-recycle-bin-persona-version',
        'github',
        'local-history-copy',
      ].map((adapter, index) => ({
        id: adapter,
        adapter,
        createdAt: index,
        objectKey: `${adapter}.zip`,
        resourceCount: 1,
        blob: new Blob(['old archive']),
        size: 11,
        encrypted: adapter === 'local-history',
        encryptionIv: 'old-iv',
      })),
    )
    await database.resourceVersions.put({ ...resource('version'), versionGroupId: 'current' })
    await storage.save(resource('current'))
    await database.settings.put({ id: 'history.snapshotLimit', value: 8, updatedAt: 1 })
    const plan = await health.legacyLibraryHistoryCleanup()
    expect(plan.records.map(({ id }) => id)).toEqual(['local-history'])
    expect(await health.clearLegacyLibraryHistory(plan)).toBe(11)
    expect(await database.backupRecords.count()).toBe(4)
    expect(await database.resources.count()).toBe(1)
    expect(await database.resourceVersions.count()).toBe(1)
    expect(await database.settings.get('history.snapshotLimit')).toBeUndefined()
  })

  it('rejects a changed deletion scope atomically and accepts a freshly confirmed scope', async () => {
    const record = {
      id: 'old',
      adapter: 'local-history',
      createdAt: 1,
      objectKey: 'old.zip',
      resourceCount: 1,
      size: 100,
    }
    await database.backupRecords.put(record)
    const plan = await health.legacyLibraryHistoryCleanup()
    await database.backupRecords.put({ ...record, id: 'another' })
    await expect(health.clearLegacyLibraryHistory(plan)).rejects.toThrow('范围已变化')
    expect(await database.backupRecords.count()).toBe(2)
    await health.clearLegacyLibraryHistory(await health.legacyLibraryHistoryCleanup())
    expect(await database.backupRecords.count()).toBe(0)
  })

  it('checks a vault migration checkpoint written by another connection before deletion', async () => {
    await database.backupRecords.put({
      id: 'old',
      adapter: 'local-history',
      createdAt: 1,
      objectKey: 'old.zip',
      resourceCount: 1,
      size: 100,
    })
    const plan = await health.legacyLibraryHistoryCleanup()
    const other = new AppDatabase(database.name)
    try {
      await other.settings.put({
        id: 'local-vault-migration',
        value: { status: 'paused' },
        updatedAt: 1,
      })
      await expect(health.clearLegacyLibraryHistory(plan)).rejects.toThrow('保险库转换尚未完成')
      expect(await database.backupRecords.get('old')).toBeDefined()
      await other.settings.delete('local-vault-migration')
      const otherHealth = new IndexedDbResourceHealthStorage(
        other,
        new IndexedDbResourceStorage(other),
      )
      const results = await Promise.allSettled([
        health.clearLegacyLibraryHistory(plan),
        otherHealth.clearLegacyLibraryHistory(plan),
      ])
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(await database.backupRecords.count()).toBe(0)
    } finally {
      other.close()
    }
  })

  it('reports derived-index drift and repairs only the derived tables', async () => {
    const source = resource('source')
    await storage.save(source)
    await database.resourceSummaries.update(source.id, { contentHash: 'stale' })
    await database.resourceListSummaries.delete(source.id)

    const audit = await health.audit()
    expect(audit.currentSummaryDrift).toEqual(['source'])
    expect(audit.listSummaryDrift).toEqual(['source'])

    await health.repairDerivedIndexes()
    const storedSource = await database.resources.get(source.id)
    expect(
      storedSource && 'originalBlob' in storedSource && storedSource.originalBlob,
    ).toBeInstanceOf(ArrayBuffer)
    expect((await database.resourceSummaries.get(source.id))?.contentHash).toBe('hash-source')
    expect((await database.resourceListSummaries.get(source.id))?.contentHash).toBe('hash-source')
  })

  it('reports corrupt JSON and both generated-image ownership failures without deleting files', async () => {
    await storage.save(resource('broken', '{'))
    await database.generatedImages.put({
      id: 'metadata-only',
      name: 'missing',
      source: 'generated',
      category: '',
      mimeType: 'image/png',
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await database.generatedImageFiles.put({
      id: 'file-only',
      originalBlob: new Blob(['x']),
      originalMimeType: 'image/png',
      updatedAt: 1,
    })

    const audit = await health.audit()
    expect(audit.corruptJsonResources).toEqual(['broken'])
    expect(audit.missingGeneratedImageFiles).toEqual(['metadata-only'])
    expect(audit.orphanGeneratedImageFiles).toEqual(['file-only'])
    expect(await database.generatedImageFiles.get('file-only')).toBeDefined()
  })

  it.each(['application/x-ndjson', ''])(
    'checks JSONL line by line with MIME %s',
    async (mimeType) => {
      const body =
        '\uFEFF{"chat_metadata":{}}\r\n\n' +
        JSON.stringify({ name: '角色', mes: '文字'.repeat(150000), is_user: false }) +
        '\n'
      const valid = { ...resource('chat', body), fileName: 'chat.jsonl', mimeType }
      const broken = { ...resource('broken-chat', body + '{'), fileName: 'broken.jsonl', mimeType }
      await storage.save(valid)
      await storage.save(broken)
      // Real chunk boundaries and trailing invalid lines, not just a two-line mock.
      const audit = await health.audit()
      expect(audit.corruptJsonResources).toEqual(['broken-chat'])
      for (const original of [valid, broken]) {
        const saved = (await storage.get(original.id))!
        expect(
          Buffer.compare(
            Buffer.from(await saved.originalBlob.arrayBuffer()),
            Buffer.from(await original.originalBlob.arrayBuffer()),
          ),
        ).toBe(0)
      }
    },
  )

  it('reports an empty JSONL file rather than silently treating it as healthy', async () => {
    await storage.save({ ...resource('empty', '\n  '), fileName: 'empty.jsonl' })
    expect((await health.audit()).corruptJsonResources).toEqual(['empty'])
  })
})
