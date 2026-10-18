import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbGeneratedImageAlbumStorage } from './IndexedDbGeneratedImageAlbumStorage'
import type { GeneratedImageAlbumQuery } from '../types/GeneratedImageAlbum'

const MIGRATION_SETTING_ID = 'migration.generatedImageFiles.blob.v17'

function bytesToBase64(value: string): string {
  return btoa(value)
}

describe('IndexedDbGeneratedImageAlbumStorage', () => {
  it.each<{
    query: GeneratedImageAlbumQuery
    expectedIds: string[]
    total: number
    counts: number
  }>([
    { query: {}, expectedIds: ['item-5', 'item-4'], total: 6, counts: 1 },
    {
      query: { search: '  ', category: '', mimeType: '', hostedStatus: 'all', page: 99 },
      expectedIds: ['item-1', 'item-0'],
      total: 6,
      counts: 1,
    },
    { query: { sort: 'oldest' }, expectedIds: ['item-0', 'item-1'], total: 6, counts: 1 },
    { query: { category: 'portrait' }, expectedIds: ['item-5', 'item-3'], total: 3, counts: 2 },
    { query: { mimeType: 'image/png' }, expectedIds: ['item-3', 'item-0'], total: 2, counts: 2 },
    { query: { hostedStatus: 'hosted' }, expectedIds: ['item-4', 'item-2'], total: 3, counts: 2 },
    { query: { hostedStatus: 'local' }, expectedIds: ['item-5', 'item-3'], total: 3, counts: 2 },
    { query: { search: '  ITEM-2 ' }, expectedIds: ['item-2'], total: 1, counts: 2 },
    { query: { search: 'missing', page: 99 }, expectedIds: [], total: 0, counts: 2 },
  ])(
    'counts once only for an unfiltered page: $query',
    async ({ query, expectedIds, total, counts }) => {
      const database = new AppDatabase(`generated-image-count-${crypto.randomUUID()}`)
      const storage = new IndexedDbGeneratedImageAlbumStorage(database)
      const count = vi.spyOn(database.Collection.prototype, 'count')
      try {
        await database.generatedImages.bulkPut(
          Array.from({ length: 6 }, (_, index) => ({
            id: `item-${index}`,
            name: `item-${index}`,
            source: 'imported' as const,
            category: index % 2 ? 'portrait' : 'background',
            mimeType: index % 3 ? 'image/webp' : 'image/png',
            hostedUrl: index % 2 ? undefined : `https://example.invalid/image-${index}`,
            sizeBytes: index + 1,
            createdAt: index,
            updatedAt: index,
          })),
        )
        const result = await storage.query({ pageSize: 2, ...query })
        expect(result.items.map((item) => item.id)).toEqual(expectedIds)
        expect(result.total).toBe(total)
        expect(result.pageCount).toBe(Math.max(1, Math.ceil(total / 2)))
        expect(result.page).toBe(query.page ? result.pageCount : 1)
        expect(result.categories).toEqual(['background', 'portrait'])
        expect(result.mimeTypes).toEqual(['image/png', 'image/webp'])
        expect(count).toHaveBeenCalledTimes(counts)
      } finally {
        count.mockRestore()
        database.close()
        await database.delete()
      }
    },
  )

  it('does not open page or facet cursors when the album is empty', async () => {
    const database = new AppDatabase(`generated-image-empty-${crypto.randomUUID()}`)
    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    const orderBy = vi.spyOn(database.generatedImages, 'orderBy')

    await expect(storage.query({ page: 1, pageSize: 18, sort: 'newest' })).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 18,
      pageCount: 1,
      categories: [],
      mimeTypes: [],
    })
    expect(orderBy).not.toHaveBeenCalled()

    database.close()
    await database.delete()
  })

  it('uses IndexedDB count and compound indexes for real metadata pagination', async () => {
    const database = new AppDatabase(`generated-image-query-${crypto.randomUUID()}`)
    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    await database.generatedImages.bulkPut(
      Array.from({ length: 75 }, (_, index) => ({
        id: `item-${index.toString().padStart(3, '0')}`,
        name: `图片 ${index}`,
        source: 'imported' as const,
        category: index % 2 ? '人物' : '背景',
        mimeType: index % 3 ? 'image/webp' : 'image/png',
        sizeBytes: index + 1,
        createdAt: index,
        updatedAt: index,
      })),
    )

    await expect(storage.count()).resolves.toBe(75)
    const result = await storage.query({
      category: '背景',
      mimeType: 'image/webp',
      page: 2,
      pageSize: 7,
      sort: 'newest',
    })
    expect(result.total).toBe(25)
    expect(result.items).toHaveLength(7)
    expect(
      result.items.every((item) => item.category === '背景' && item.mimeType === 'image/webp'),
    ).toBe(true)
    expect(result.items[0]!.createdAt).toBeGreaterThan(result.items.at(-1)!.createdAt)
    expect(result.categories).toEqual(['人物', '背景'].sort())

    database.close()
    await database.delete()
  })

  it('migrates 100 legacy Base64 files to Blob without retaining expanded strings', async () => {
    const name = `generated-image-blob-migration-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(16).stores({
      generatedImages: 'id, createdAt, updatedAt',
      generatedImageFiles: 'id, updatedAt',
      settings: 'id, updatedAt',
    })
    const records = Array.from({ length: 100 }, (_, index) => {
      const id = `image-${index.toString().padStart(3, '0')}`
      return {
        id,
        originalBase64: bytesToBase64(`original-${id}`),
        originalMimeType: 'image/png',
        thumbnailBase64: bytesToBase64(`thumbnail-${id}`),
        thumbnailMimeType: 'image/webp',
        updatedAt: index,
      }
    })
    await legacy.table('generatedImageFiles').bulkPut(records)
    legacy.close()

    const database = new AppDatabase(name)
    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    await storage.list()

    const migrated = await database.generatedImageFiles.toArray()
    expect(migrated).toHaveLength(100)
    expect(migrated.every((file) => file.originalBlob instanceof Blob)).toBe(true)
    expect(migrated.every((file) => !file.originalBase64 && !file.thumbnailBase64)).toBe(true)
    await expect(migrated[73]?.originalBlob?.text()).resolves.toBe('original-image-073')
    await expect(migrated[73]?.thumbnailBlob?.text()).resolves.toBe('thumbnail-image-073')
    await expect(database.settings.get(MIGRATION_SETTING_ID)).resolves.toMatchObject({
      value: { version: 17, status: 'complete', migrated: 100 },
    })

    database.close()
    await database.delete()
  })

  it('resumes strictly after a committed checkpoint', async () => {
    const name = `generated-image-blob-resume-${crypto.randomUUID()}`
    const database = new AppDatabase(name)
    await database.generatedImageFiles.bulkPut([
      {
        id: 'image-001',
        originalBlob: new Blob(['already-migrated'], { type: 'image/png' }),
        originalMimeType: 'image/png',
        updatedAt: 1,
      },
      {
        id: 'image-002',
        originalBase64: bytesToBase64('resume-me'),
        originalMimeType: 'image/png',
        updatedAt: 2,
      },
    ])
    await database.settings.put({
      id: MIGRATION_SETTING_ID,
      value: {
        version: 17,
        status: 'running',
        checkpoint: 'image-001',
        migrated: 1,
      },
      updatedAt: 1,
    })

    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    await storage.list()

    await expect(database.generatedImageFiles.get('image-001')).resolves.toMatchObject({
      originalMimeType: 'image/png',
    })
    const resumed = await database.generatedImageFiles.get('image-002')
    await expect(resumed?.originalBlob?.text()).resolves.toBe('resume-me')
    expect(resumed?.originalBase64).toBeUndefined()
    await expect(database.settings.get(MIGRATION_SETTING_ID)).resolves.toMatchObject({
      value: { status: 'complete', migrated: 2 },
    })

    database.close()
    await database.delete()
  })

  it('keeps the committed checkpoint after a quota interruption and skips a corrupt record on resume', async () => {
    const name = `generated-image-blob-quota-${crypto.randomUUID()}`
    const database = new AppDatabase(name)
    await database.generatedImageFiles.bulkPut([
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `image-${index.toString().padStart(3, '0')}`,
        originalBase64: bytesToBase64(`image-${index}`),
        originalMimeType: 'image/png',
        updatedAt: index,
      })),
      { id: 'image-020', originalMimeType: '', updatedAt: 20 },
    ])
    const originalBulkPut = database.generatedImageFiles.bulkPut.bind(database.generatedImageFiles)
    let batch = 0
    const bulkPut = vi
      .spyOn(database.generatedImageFiles, 'bulkPut')
      .mockImplementation((...args): ReturnType<typeof originalBulkPut> => {
        batch += 1
        if (batch === 2) {
          return Promise.reject(
            new DOMException('Quota exceeded', 'QuotaExceededError'),
          ) as ReturnType<typeof originalBulkPut>
        }
        return originalBulkPut(...args)
      })

    const interrupted = new IndexedDbGeneratedImageAlbumStorage(database)
    await expect(interrupted.list()).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await expect(database.settings.get(MIGRATION_SETTING_ID)).resolves.toMatchObject({
      value: { status: 'running', checkpoint: 'image-009', migrated: 10 },
    })

    bulkPut.mockRestore()
    const resumed = new IndexedDbGeneratedImageAlbumStorage(database)
    await resumed.list()
    await expect(database.settings.get(MIGRATION_SETTING_ID)).resolves.toMatchObject({
      value: { status: 'complete', migrated: 20 },
    })
    expect((await database.generatedImageFiles.get('image-020'))?.originalBlob).toBeUndefined()

    database.close()
    await database.delete()
  })

  it('seeks duplicate facet runs with ordinary sequential key cursors at 1k', async () => {
    const database = new AppDatabase(`album-facet-budget-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbGeneratedImageAlbumStorage(database)
      await database.generatedImages.bulkPut(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `item-${String(index).padStart(5, '0')}`,
          name: `item-${index}`,
          source: 'imported' as const,
          category: `category-${index % 10}`,
          mimeType: ['image/png', 'image/webp', 'image/jpeg'][index % 3]!,
          sizeBytes: 1,
          createdAt: index,
          updatedAt: index,
        })),
      )
      // The phase-1 path materialized every index entry, not just distinct keys.
      const categoryKeys = await database.generatedImages.orderBy('category').keys()
      const mimeKeys = await database.generatedImages.orderBy('mimeType').keys()
      expect(categoryKeys.length + mimeKeys.length).toBe(2_000)
      const core = database.generatedImages.core
      const original = core.openCursor.bind(core)
      const visits: Record<string, number> = {}
      let active = 0
      let maximum = 0
      const cursor = vi.spyOn(core, 'openCursor').mockImplementation(async (request) => {
        const opened = await original(request)
        const name = request.query.index.name
        if (opened && (name === 'category' || name === 'mimeType')) {
          expect(request.unique).not.toBe(true)
          expect(request.values).toBe(false)
          const start = opened.start.bind(opened)
          opened.start = async (callback) => {
            active += 1
            maximum = Math.max(maximum, active)
            try {
              return await start(() => {
                visits[name] = (visits[name] ?? 0) + 1
                callback()
              })
            } finally {
              active -= 1
            }
          }
        }
        return opened
      })
      const result = await storage.query({ page: 1, pageSize: 18 })
      expect(result.categories).toEqual([...new Set(categoryKeys)])
      expect(result.mimeTypes).toEqual([...new Set(mimeKeys)])
      expect(result.page).toBe(1)
      expect(result.items).toHaveLength(18)
      expect(visits).toEqual({ category: 10, mimeType: 3 })
      expect(maximum).toBe(1)
      expect(cursor.mock.calls.filter(([request]) => request.values === false)).toHaveLength(2)
    } finally {
      database.close()
      await database.delete()
    }
  }, 20_000)

  it('preserves prefixes, empty/non-string legacy values, and arbitrarily many distinct facets', async () => {
    const database = new AppDatabase(`album-facet-keys-${crypto.randomUUID()}`)
    try {
      const values: unknown[] = [
        '',
        'a',
        'a\0',
        'a\0b',
        'aa',
        'a\uffff',
        '\0',
        '人物',
        0,
        new Date(0),
        new Uint8Array([0]),
        ['array'],
        ...Array.from({ length: 100 }, (_, index) => `distinct-${index}`),
      ]
      await database.generatedImages.bulkPut(
        values.map((category, index) => ({
          id: `item-${index}`,
          name: 'item',
          source: 'imported' as const,
          category: category as string,
          mimeType: 'image/png',
          sizeBytes: 1,
          createdAt: index,
          updatedAt: index,
        })),
      )
      const keys = await database.generatedImages.orderBy('category').keys()
      const expected = [
        ...new Set(keys.filter((key): key is string => typeof key === 'string' && Boolean(key))),
      ]
      const result = await new IndexedDbGeneratedImageAlbumStorage(database).query({})
      expect(result.categories).toEqual(expected)
      expect(result.categories).toHaveLength(107)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('observes same-count replacements, direct restore writes, other connections and deletion without cached facets', async () => {
    const name = `album-facet-mutations-${crypto.randomUUID()}`
    const database = new AppDatabase(name)
    const otherDatabase = new AppDatabase(name)
    const storage = new IndexedDbGeneratedImageAlbumStorage(database)
    const otherStorage = new IndexedDbGeneratedImageAlbumStorage(otherDatabase)
    const item = {
      id: 'item',
      name: 'item',
      source: 'imported' as const,
      category: 'before',
      mimeType: 'image/png',
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    try {
      await database.generatedImages.put(item)
      expect((await storage.query({})).categories).toEqual(['before'])
      await otherStorage.update({ ...item, category: 'after', mimeType: 'image/webp' })
      expect(await storage.query({})).toMatchObject({
        categories: ['after'],
        mimeTypes: ['image/webp'],
      })
      await otherDatabase.generatedImages.bulkPut([
        { ...item, category: 'restored', mimeType: 'image/jpeg' },
      ])
      expect(await storage.query({})).toMatchObject({
        categories: ['restored'],
        mimeTypes: ['image/jpeg'],
      })
      await otherStorage.delete(item.id)
      expect(await storage.query({})).toMatchObject({
        items: [],
        total: 0,
        categories: [],
        mimeTypes: [],
      })
    } finally {
      otherDatabase.close()
      database.close()
      await database.delete()
    }
  })

  it('does not retain failed or stale facet results on retry', async () => {
    const database = new AppDatabase(`album-facet-retry-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbGeneratedImageAlbumStorage(database)
      await database.generatedImages.put({
        id: 'item',
        name: 'item',
        source: 'imported',
        category: 'before',
        mimeType: 'image/png',
        sizeBytes: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      const cursor = vi
        .spyOn(database.generatedImages.core, 'openCursor')
        .mockRejectedValueOnce(new Error('synthetic cursor failure'))
      await expect(storage.query({})).rejects.toThrow('synthetic cursor failure')
      cursor.mockRestore()
      await database.generatedImages.update('item', { category: 'after' })
      expect((await storage.query({})).categories).toEqual(['after'])
    } finally {
      database.close()
      await database.delete()
    }
  })
})
