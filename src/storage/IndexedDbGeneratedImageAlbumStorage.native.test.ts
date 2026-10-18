import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import type { AppDatabase } from '../database/AppDatabase'
import type { GeneratedImageAlbumItem } from '../types/GeneratedImageAlbum'
import { createAndroidNativeDexieCore } from './AndroidNativeDexieCore'
import { decodeAppDatabaseKey, encodeAppDatabaseKey } from './AndroidAppDatabaseMigration'
import { IndexedDbGeneratedImageAlbumStorage } from './IndexedDbGeneratedImageAlbumStorage'
import type { nativeAppDatabase } from './NativeAppDatabaseBridge'

type NativePort = typeof nativeAppDatabase

function fixture(categories: string[], keyPages = true) {
  const database = new Dexie(`album-native-seek-${crypto.randomUUID()}`)
  database.version(1).stores({
    generatedImages:
      'id,createdAt,category,mimeType,[category+createdAt],[mimeType+createdAt],[category+mimeType+createdAt]',
    generatedImageFiles: 'id',
    settings: 'id',
  })
  const images: GeneratedImageAlbumItem[] = categories.map((category, index) => ({
    id: `image-${String(index).padStart(5, '0')}`,
    name: `Synthetic ${index}`,
    source: 'imported',
    category,
    mimeType: index % 2 ? 'image/webp' : 'image/png',
    sizeBytes: 1,
    createdAt: index,
    updatedAt: index,
  }))
  const stores = new Map<string, Map<string, Record<string, unknown>>>([
    ['generatedImages', new Map(images.map((row) => [encodeAppDatabaseKey(row.id), { ...row }]))],
    [
      'settings',
      new Map([
        [
          encodeAppDatabaseKey('migration.generatedImageFiles.blob.v17'),
          {
            id: 'migration.generatedImageFiles.blob.v17',
            value: { version: 17, status: 'complete', migrated: 0 },
            updatedAt: 0,
          },
        ],
      ]),
    ],
    ['generatedImageFiles', new Map()],
  ])
  const read = (store: string) => stores.get(store)!
  const compare = (left: string, right: string) =>
    indexedDB.cmp(decodeAppDatabaseKey(left), decodeAppDatabaseKey(right))
  const entries = (store: string, indexName?: string) =>
    [...read(store)].map(([primaryKey, value]) => ({
      primaryKey,
      indexKey: indexName ? encodeAppDatabaseKey(value[indexName] as IDBValidKey) : primaryKey,
    }))
  const getRecord = vi.fn<NativePort['getRecord']>(async (store, key) => read(store).get(key))
  const getRecordsByKeys = vi.fn<NativePort['getRecordsByKeys']>(async (store, keys) =>
    keys.flatMap((key) => {
      const value = read(store).get(key)
      return value ? [{ key, value }] : []
    }),
  )
  const getIndexEntries = vi.fn<NativePort['getIndexEntries']>(async (store, indexName, key) =>
    entries(store, indexName).filter((row) => key === undefined || row.indexKey === key),
  )
  let revision = 0
  const queryKeyPage = vi.fn<NativePort['queryKeyPage']>(async (store, query) => {
    let rows = entries(store, query.indexName).filter(
      (row) =>
        (query.lower === undefined ||
          compare(row.indexKey, query.lower) > (query.lowerOpen ? 0 : -1)) &&
        (query.upper === undefined ||
          compare(row.indexKey, query.upper) < (query.upperOpen ? 0 : 1)),
    )
    const sign = query.reverse ? -1 : 1
    rows.sort(
      (left, right) =>
        sign *
        (compare(left.indexKey, right.indexKey) || compare(left.primaryKey, right.primaryKey)),
    )
    const tuple = (row: (typeof rows)[number], key: string, primary?: string) =>
      compare(row.indexKey, key) || (primary === undefined ? 0 : compare(row.primaryKey, primary))
    rows = rows.filter(
      (row) =>
        (query.afterKey === undefined ||
          sign * tuple(row, query.afterKey, query.afterPrimaryKey) > 0) &&
        (query.seekKey === undefined ||
          sign * tuple(row, query.seekKey, query.seekPrimaryKey) >= 0),
    )
    if (query.countOnly) return { count: rows.length, revision: String(revision) }
    return {
      rows: rows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)),
      revision: String(revision),
    }
  })
  const native = {
    getRecord,
    getRecordsByKeys,
    getIndexEntries,
    countRecords: async (store: string) => read(store).size,
    countIndexEntries: async (store: string, indexName: string) => entries(store, indexName).length,
    getRecordKeys: async (store: string) => ({ keys: [...read(store).keys()] }),
    ...(keyPages ? { queryKeyPage } : {}),
  } as unknown as NativePort
  database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
  const storage = new IndexedDbGeneratedImageAlbumStorage(database as AppDatabase)
  return {
    database,
    storage,
    getRecord,
    getRecordsByKeys,
    getIndexEntries,
    queryKeyPage,
    changeCategory(index: number, category: string) {
      read('generatedImages').get(encodeAppDatabaseKey(images[index]!.id))!.category = category
      revision += 1
    },
  }
}

describe('album facets through the native DBCore adapter', () => {
  it.each([true, false])(
    'preserves prefix and embedded-NUL facets with key pages=%s',
    async (keyPages) => {
      const categories = ['', 'a', 'a', 'a\0', 'a\0', 'a\0b', 'a\0\0', '\0', 'b']
      const { database, storage, getRecord, getRecordsByKeys, queryKeyPage } = fixture(
        categories,
        keyPages,
      )
      try {
        const result = await storage.query({ pageSize: 2 })
        expect(result.categories).toEqual(['\0', 'a', 'a\0', 'a\0\0', 'a\0b', 'b'])
        expect(result.items.map((row) => row.id)).toEqual(['image-00008', 'image-00007'])
        expect(result.mimeTypes).toEqual(['image/png', 'image/webp'])
        expect(getRecord.mock.calls.filter(([store]) => store === 'generatedImages')).toHaveLength(
          0,
        )
        expect(getRecordsByKeys.mock.calls.flatMap(([, keys]) => keys)).toHaveLength(2)
        if (keyPages) {
          expect(queryKeyPage.mock.calls.every(([, query]) => !query.unique)).toBe(true)
        }
      } finally {
        database.close()
        await database.delete()
      }
    },
  )

  it('seeks across 10,000 duplicate index keys without reading facet values', async () => {
    const { database, storage, getRecord, getRecordsByKeys, queryKeyPage } = fixture(
      Array.from({ length: 10000 }, (_, index) => `category-${index % 17}`),
    )
    try {
      const result = await storage.query({ pageSize: 18 })
      expect(result.categories).toHaveLength(17)
      expect(result.mimeTypes).toHaveLength(2)
      expect(result.total).toBe(10000)
      expect(getRecord.mock.calls.filter(([store]) => store === 'generatedImages')).toHaveLength(0)
      expect(getRecordsByKeys.mock.calls.flatMap(([, keys]) => keys)).toHaveLength(18)
      const facets = queryKeyPage.mock.calls.filter(([, query]) =>
        ['category', 'mimeType'].includes(query.indexName ?? ''),
      )
      expect(facets).toHaveLength(21)
      expect(facets.filter(([, query]) => query.seekKey !== undefined)).toHaveLength(19)
      expect(facets.every(([, query]) => !query.unique)).toBe(true)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it('rejects changed revisions during a seek and reads fresh facets on retry', async () => {
    const { database, storage, queryKeyPage, changeCategory } = fixture([
      ...Array<string>(225).fill('a'),
      'b',
    ])
    const original = queryKeyPage.getMockImplementation()!
    let changed = false
    queryKeyPage.mockImplementation(async (store, query) => {
      if (!changed && query.indexName === 'category' && query.seekKey !== undefined) {
        changed = true
        changeCategory(0, 'c')
      }
      return original(store, query)
    })
    try {
      await expect(storage.query({ pageSize: 2 })).rejects.toThrow('原生查询期间数据已变化')
      expect(changed).toBe(true)
      await expect(storage.query({ pageSize: 2 })).resolves.toMatchObject({
        categories: ['a', 'b', 'c'],
        total: 226,
      })
    } finally {
      database.close()
      await database.delete()
    }
  })

  it.each([
    { keyPages: true, escaped: false },
    { keyPages: false, escaped: false },
    { keyPages: true, escaped: true },
    { keyPages: false, escaped: true },
  ])(
    'keeps native keys at the encoded length limit: $keyPages/$escaped',
    async ({ keyPages, escaped }) => {
      const longestNativeKey = escaped ? '\0'.repeat(341) : 'a'.repeat(2046)
      expect(encodeAppDatabaseKey(longestNativeKey)).toHaveLength(2048)
      const { database, storage } = fixture(
        [...Array<string>(225).fill(longestNativeKey), 'b'],
        keyPages,
      )
      try {
        const oldKeys = await database.table('generatedImages').orderBy('category').keys()
        expect([...new Set(oldKeys)]).toEqual([longestNativeKey, 'b'])
        await expect(storage.query({ pageSize: 2 })).resolves.toMatchObject({
          categories: [longestNativeKey, 'b'],
          mimeTypes: ['image/png', 'image/webp'],
          total: 226,
        })
      } finally {
        database.close()
        await database.delete()
      }
    },
  )
})
