import 'fake-indexeddb/auto'

import { describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { findHistoricalDuplicateGroups } from '../services/ResourceVersionMatcher'
import { RESOURCE_TYPE, toResourceSummary, type Category, type Resource } from '../types/Resource'
import {
  IndexedDbArchiveStorage,
  getBackupRecordSummary,
  listBackupRecordSummaries,
} from './IndexedDbArchiveStorage'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import type { NativeBackedResourceRecord } from '../types/Vault'
import * as nativeMirror from './NativeResourceFileMirror'
import { restoreVersionKey } from '../utils/RestoreIdentity'

describe('IndexedDbArchiveStorage', () => {
  it.each([1000, 5000, 10000])(
    'reads only 501 relevant historical metadata rows from %i rows in three batches',
    async (count) => {
      const database = new AppDatabase(`scoped-history-${crypto.randomUUID()}`)
      const storage = new IndexedDbArchiveStorage(database)
      const body = new Blob(['history original'])
      const records: Resource[] = Array.from({ length: count }, (_, index) => ({
        id: `history-${index}`,
        versionGroupId: index < 501 ? 'selected' : 'unrelated',
        type: RESOURCE_TYPE.OTHER,
        name: `history-${index}`,
        description: '',
        fileName: 'history.bin',
        mimeType: 'application/octet-stream',
        fileSize: body.size,
        originalBlob: body,
        contentHash: index.toString(16).padStart(64, '0'),
        favorite: false,
        categoryId: null,
        tags: [],
        metadata: { custom: index },
        createdAt: 1,
        updatedAt: 1,
      }))
      try {
        await database.resourceVersions.bulkPut(records)
        const get = vi.spyOn(database.resourceVersions, 'get')
        const batch = vi.spyOn(database.resourceVersions, 'bulkGet')
        const keys = await storage.listRestoreVersionKeys(['selected', 'selected'])
        expect(new Set(keys)).toEqual(
          new Set(
            records.slice(0, 501).map((record) => restoreVersionKey(toResourceSummary(record))),
          ),
        )
        expect(get).not.toHaveBeenCalled()
        expect(batch.mock.calls.map(([ids]) => ids.length)).toEqual([250, 250, 1])
        expect(await storage.listRestoreVersionKeys([])).toEqual([])
        expect(batch).toHaveBeenCalledTimes(3)
      } finally {
        vi.restoreAllMocks()
        database.close()
        await database.delete()
      }
    },
  )
  it('releases replaced native objects only after the restore transaction commits, retaining them on rollback', async () => {
    const database = new AppDatabase(`restore-replacement-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const hash = 'b'.repeat(64)
    const record: NativeBackedResourceRecord = {
      id: 'restored',
      type: RESOURCE_TYPE.WORLD_BOOK,
      name: 'world',
      description: '',
      fileName: 'world.json',
      mimeType: 'application/json',
      fileSize: 4,
      contentHash: hash,
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 2,
      nativeOriginal: { version: 1, contentHash: hash, size: 4 },
    }
    const replacement = {
      scope: 'current' as const,
      id: record.id,
      contentHash: hash,
      size: 4,
      replacedHashes: ['a'.repeat(64)],
    }
    const link = vi
      .spyOn(nativeMirror, 'linkNativeResourceObjects')
      .mockImplementation(async (_records, onReplaced) => {
        onReplaced?.([replacement])
        return 1
      })
    const release = vi
      .spyOn(nativeMirror, 'releaseReplacedNativeObjects')
      .mockImplementation(async (records) => {
        expect((await database.resources.get('restored'))?.contentHash).toBe(hash)
        expect(records).toEqual([replacement])
      })
    try {
      await storage.restoreNative([], [record])
      expect(release).toHaveBeenCalledOnce()
      const put = vi
        .spyOn(database.resources, 'put')
        .mockRejectedValueOnce(new Error('commit failed'))
      try {
        await expect(storage.restoreNative([], [record])).rejects.toThrow('commit failed')
      } finally {
        put.mockRestore()
      }
      expect(release).toHaveBeenCalledOnce()
      expect(link).toHaveBeenCalledTimes(2)
    } finally {
      link.mockRestore()
      release.mockRestore()
      database.close()
      await database.delete()
    }
  })
  it('lists only archive metadata and keeps legacy size fallback without changing stored blobs', async () => {
    const database = new AppDatabase(`archive-metadata-${crypto.randomUUID()}`)
    const blob = new Blob(['archive bytes'], { type: 'application/zip' })
    try {
      await database.backupRecords.bulkPut([
        {
          id: 'old',
          adapter: 'local-recycle-bin',
          objectKey: 'old.zip',
          resourceCount: 1,
          createdAt: 1,
          blob,
        },
        {
          id: 'sealed',
          adapter: 'local-recycle-bin',
          objectKey: 'sealed.zip',
          resourceCount: 2,
          createdAt: 2,
          blob,
          size: 99,
          encrypted: true,
          encryptionIv: 'iv',
        },
        {
          id: 'other',
          adapter: 'local-history',
          objectKey: 'other.zip',
          resourceCount: 3,
          createdAt: 3,
          blob,
        },
      ])
      const records = await listBackupRecordSummaries(database, ['local-recycle-bin'])
      expect(records).toHaveLength(2)
      expect(records.find((record) => record.id === 'old')?.size).toBe(blob.size)
      expect(records.find((record) => record.id === 'sealed')).toMatchObject({
        size: 99,
        encrypted: true,
        encryptionIv: 'iv',
      })
      expect(records.every((record) => !('blob' in record))).toBe(true)
      expect(await getBackupRecordSummary(database, 'old')).toMatchObject({
        id: 'old',
        size: blob.size,
      })
      expect(await getBackupRecordSummary(database, 'old')).not.toHaveProperty('blob')
      expect(await getBackupRecordSummary(database, 'missing')).toBeUndefined()
      expect(await (await database.backupRecords.get('old'))?.blob?.text()).toBe('archive bytes')
      expect(await listBackupRecordSummaries(database, [])).toEqual([])
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('resumes completed staging and commits its marker atomically, without replaying replacement', async () => {
    const name = `checkpoint-${crypto.randomUUID()}`
    let database = new AppDatabase(name)
    let storage = new IndexedDbArchiveStorage(database)
    const records: Resource[] = [0, 1].map((index) => ({
      id: `resume-${index}`,
      type: RESOURCE_TYPE.OTHER,
      name: `resume-${index}`,
      description: '',
      fileName: `${index}.txt`,
      mimeType: 'text/plain',
      fileSize: 1,
      contentHash: String(index).padStart(64, '0'),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      originalBlob: new Blob(['x']),
    }))
    const checkpoint = crypto.randomUUID()
    try {
      await expect(
        storage.replace(
          [],
          records,
          [],
          async (r) => {
            if (r.id === 'resume-1') throw new Error('interrupted')
            return r
          },
          undefined,
          checkpoint,
        ),
      ).rejects.toThrow('interrupted')
      expect(await database.resources.count()).toBe(0)
      expect(await database.restoreStaging.count()).toBe(1)
      database.close()
      database = new AppDatabase(name)
      storage = new IndexedDbArchiveStorage(database)
      const read = vi.fn(async (r: Resource) => r)
      const failCommit = vi
        .spyOn(database.resourceListSummaries, 'put')
        .mockRejectedValueOnce(new Error('commit interrupted'))
      await expect(storage.replace([], records, [], read, undefined, checkpoint)).rejects.toThrow(
        'commit interrupted',
      )
      expect(await storage.isRestoreCommitted(checkpoint)).toBe(false)
      expect(await database.resources.count()).toBe(0)
      failCommit.mockRestore()
      await storage.replace([], records, [], read, undefined, checkpoint)
      expect(read).toHaveBeenCalledTimes(1)
      expect(read.mock.calls[0]![0].id).toBe('resume-1')
      expect(await storage.isRestoreCommitted(checkpoint)).toBe(true)
      await database.resources.put({ ...records[0]!, id: 'created-after-commit' })
      database.close()
      database = new AppDatabase(name)
      storage = new IndexedDbArchiveStorage(database)
      await storage.replace([], records, [], read, undefined, checkpoint)
      expect(await database.resources.count()).toBe(3)
      expect(read).toHaveBeenCalledTimes(1)
      await storage.clearRestoreCheckpoint(checkpoint)
      expect(await storage.isRestoreCommitted(checkpoint)).toBe(false)
    } finally {
      await database.delete()
    }
  })

  it('stages Web restore bodies serially and rolls back when storage runs out', async () => {
    const database = new AppDatabase(`web-staged-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const records: Resource[] = Array.from({ length: 3 }, (_, index) => ({
      id: `web-${index}`,
      type: RESOURCE_TYPE.OTHER,
      name: `web-${index}`,
      description: '',
      fileName: `${index}.bin`,
      mimeType: 'application/octet-stream',
      fileSize: 1024,
      contentHash: index.toString(16).padStart(64, '0'),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      originalBlob: new Blob([]),
    }))
    let reads = 0
    const hydrate = async (record: Resource) => {
      expect(await database.resources.count()).toBe(0)
      expect(await database.restoreStaging.count()).toBe(reads++)
      return { ...record, originalBlob: new Blob(['x'.repeat(1024)]) }
    }
    try {
      await storage.restore([], records, [], hydrate)
      expect(reads).toBe(3)
      expect(await database.resources.get('web-2')).toHaveProperty('originalBlob.size', 1024)
      expect(await database.restoreStaging.count()).toBe(0)
      const before = await database.resources.count()
      let attempts = 0
      await expect(
        storage.restore(
          [],
          records.map((r) => ({ ...r, id: `new-${r.id}` })),
          [],
          async (r) => {
            if (++attempts === 2) throw new DOMException('No storage space', 'QuotaExceededError')
            return r
          },
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('存储空间不足'),
        cause: { name: 'QuotaExceededError' },
      })
      expect(await database.resources.count()).toBe(before)
      expect(await database.restoreStaging.count()).toBe(0)
      const fetchBlob = globalThis.fetch.bind(globalThis)
      const read = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(fetchBlob)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      try {
        await expect(
          storage.restore(
            [],
            records.map((r) => ({ ...r, id: `new-${r.id}` })),
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining('本机恢复暂存'),
          cause: { message: 'Failed to fetch' },
        })
        expect(await database.resources.count()).toBe(before)
        expect(await database.restoreStaging.count()).toBe(0)
      } finally {
        read.mockRestore()
      }
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('stages native card bodies one at a time before publishing current and historical indexes', async () => {
    const database = new AppDatabase(`native-staged-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const records = Array.from({ length: 6 }, (_, index): NativeBackedResourceRecord => ({
      id: `card-${index}`,
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name: `Card ${index}`,
      description: '',
      fileName: `${index}.json`,
      mimeType: 'application/json',
      fileSize: 1024,
      contentHash: index.toString(16).padStart(64, '0'),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      nativeOriginal: { version: 1, contentHash: index.toString(16).padStart(64, '0'), size: 1024 },
      ...(index === 5 ? { versionGroupId: 'card-0' } : {}),
    }))
    let hydrated = 0
    const hydrate = vi.fn(async (record: NativeBackedResourceRecord) => {
      expect(await database.resources.count()).toBe(0)
      expect(await database.resourceVersions.count()).toBe(0)
      expect(await database.restoreStaging.count()).toBe(hydrated++)
      return {
        ...record,
        metadata: { card: { name: record.name, description: 'x'.repeat(256 * 1024) } },
      }
    })
    try {
      await storage.restoreNative([], records.slice(0, 5), records.slice(5), hydrate)
      expect(hydrate).toHaveBeenCalledTimes(6)
      expect(await database.resources.count()).toBe(5)
      expect(await database.resourceVersions.count()).toBe(1)
      expect(await database.resourceVersionSummaries.get('card-5')).toMatchObject({
        versionGroupId: 'card-0',
      })
      expect(await database.resources.get('card-0')).toHaveProperty(
        'metadata.card.description',
        'x'.repeat(256 * 1024),
      )
      expect(await database.restoreStaging.count()).toBe(0)
      expect(records[0]?.metadata).toEqual({})
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('does not publish any native indexes when card hydration or final index commit fails', async () => {
    const database = new AppDatabase(`native-staged-failure-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const record: NativeBackedResourceRecord = {
      id: 'incoming',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name: 'Incoming',
      description: '',
      fileName: 'incoming.json',
      mimeType: 'application/json',
      fileSize: 2,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
      nativeOriginal: { version: 1, contentHash: 'a'.repeat(64), size: 2 },
    }
    const existing = { ...record, id: 'existing', metadata: { card: { name: 'Keep' } } }
    await database.resources.put(existing)
    const category: Category = {
      id: 'new-category',
      name: 'New',
      color: '#123456',
      createdAt: 1,
      updatedAt: 1,
    }
    try {
      const hydrate = vi
        .fn()
        .mockResolvedValueOnce(record)
        .mockRejectedValueOnce(new Error('bad card'))
      await expect(
        storage.restoreNative([category], [record], [{ ...record, id: 'history' }], hydrate),
      ).rejects.toThrow('bad card')
      expect(await database.resources.toArray()).toEqual([existing])
      expect(await database.categories.count()).toBe(0)
      expect(await database.restoreStaging.count()).toBe(0)

      const failCommit = () => {
        throw new Error('index write failed')
      }
      database.resourceListSummaries.hook('creating', failCommit)
      await expect(
        storage.restoreNative([category], [record], [], async (value) => value),
      ).rejects.toThrow('index write failed')
      expect(await database.resources.toArray()).toEqual([existing])
      expect(await database.categories.count()).toBe(0)
      expect(await database.resourceSummaries.count()).toBe(0)
      expect(await database.restoreStaging.count()).toBe(0)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('writes restored categories and resources together', async () => {
    const database = new AppDatabase(`archive-storage-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const now = Date.now()
    const category: Category = {
      id: 'lore',
      name: '设定',
      color: '#486b5d',
      createdAt: now,
      updatedAt: now,
    }
    const resource: Resource = {
      id: 'atlas',
      type: RESOURCE_TYPE.WORLD_BOOK,
      name: 'Atlas',
      description: '',
      fileName: 'Atlas.json',
      mimeType: 'application/json',
      fileSize: 2,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: category.id,
      tags: [],
      metadata: {},
      originalBlob: new Blob(['{}']),
      createdAt: now,
      updatedAt: now,
    }

    await storage.restore([category], [resource])

    expect(await database.categories.get(category.id)).toEqual(category)
    const restoredResource = await database.resources.get(resource.id)
    expect(
      restoredResource && 'categoryId' in restoredResource
        ? restoredResource.categoryId
        : undefined,
    ).toBe(category.id)
    database.close()
    await database.delete()
  })

  it('restores historical records and their recognition summaries atomically', async () => {
    const database = new AppDatabase(`archive-version-summary-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const now = Date.now()
    const resource: Resource = {
      id: 'current',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name: '当前版本',
      description: '',
      fileName: 'current.png',
      mimeType: 'image/png',
      fileSize: 7,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      originalBlob: new Blob(['current']),
      createdAt: now,
      updatedAt: now,
    }
    const version: Resource = {
      ...resource,
      id: 'history',
      fileName: 'history.png',
      versionGroupId: resource.id,
      originalBlob: new Blob(['history']),
    }

    await storage.restore([], [resource], [version])

    expect(await database.resourceVersions.get(version.id)).toBeDefined()
    expect(await database.resourceVersionSummaries.get(version.id)).toMatchObject({
      id: version.id,
      contentHash: version.contentHash,
      versionGroupId: resource.id,
    })
    const resourceStorage = new IndexedDbResourceStorage(database)
    const duplicateGroups = findHistoricalDuplicateGroups(
      await resourceStorage.listSummaries(),
      await resourceStorage.listVersionSummaries(),
    )
    expect(duplicateGroups[0]).toMatchObject({
      kind: 'exactFile',
      keeper: { id: resource.id },
      duplicates: [{ id: version.id }],
    })

    database.close()
    await database.delete()
  })

  it('replace clears ghost historical summaries before writing the restored timeline', async () => {
    const database = new AppDatabase(`archive-version-replace-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const now = Date.now()
    await database.resourceVersionSummaries.put(
      toResourceSummary({
        id: 'ghost-history',
        type: RESOURCE_TYPE.OTHER,
        name: '幽灵摘要',
        description: '',
        fileName: 'ghost.json',
        mimeType: 'application/json',
        fileSize: 2,
        contentHash: 'f'.repeat(64),
        favorite: false,
        categoryId: null,
        tags: [],
        metadata: {},
        versionGroupId: 'missing-owner',
        originalBlob: new Blob(['{}']),
        createdAt: now,
        updatedAt: now,
      }),
    )

    await storage.replace([], [], [])

    expect(await database.resourceVersions.toArray()).toEqual([])
    expect(await database.resourceVersionSummaries.toArray()).toEqual([])

    database.close()
    await database.delete()
  })

  it('APK 原生恢复只把已校验 NativeLibrary 引用提交到 IndexedDB', async () => {
    const database = new AppDatabase(`archive-native-restore-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(database)
    const resource: NativeBackedResourceRecord = {
      id: 'native-large',
      type: RESOURCE_TYPE.OTHER,
      name: '原生大资源',
      description: '',
      fileName: 'large.bin',
      mimeType: 'application/octet-stream',
      fileSize: 3 * 1024 * 1024 * 1024,
      contentHash: 'c'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      nativeOriginal: {
        version: 1,
        contentHash: 'c'.repeat(64),
        size: 3 * 1024 * 1024 * 1024,
      },
      createdAt: 1,
      updatedAt: 2,
    }

    await storage.restoreNative([], [resource])

    const stored = await database.resources.get(resource.id)
    expect(stored).toMatchObject({ nativeOriginal: resource.nativeOriginal })
    expect(stored && 'originalBlob' in stored).toBe(false)
    expect(await database.resourceSummaries.get(resource.id)).not.toHaveProperty('nativeOriginal')
    database.close()
    await database.delete()
  })
})
