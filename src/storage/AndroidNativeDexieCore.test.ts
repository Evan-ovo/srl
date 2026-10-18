import 'fake-indexeddb/auto'
import console from 'node:console'
import { Capacitor } from '@capacitor/core'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import { createStructuredSnapshot } from '../services/CloudStructuredSnapshot'

import { IndexedDbArchiveStorage } from './IndexedDbArchiveStorage'
import { IndexedDbCategoryStorage } from './IndexedDbCategoryStorage'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { UserPersonaService } from '../services/UserPersonaService'
import type { UserPersonaDraft } from '../types/UserPersona'
import { CategoryService } from '../services/CategoryService'
import { RestoreService } from '../services/RestoreService'
import { hashCloudBlob } from '../services/CloudArchiveCodec'
import {
  buildStructuredBackup,
  type CloudBackupSnapshotOperationsContext,
} from '../services/CloudBackupSnapshotOperations'

import Dexie, { liveQuery } from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { VaultService } from '../services/VaultService'
import { APP_DATABASE_STORES, nativeAppDatabase } from './NativeAppDatabaseBridge'
import {
  createAndroidNativeDexieCore,
  activateAndroidNativeAppDatabase,
  deactivateAndroidNativeAppDatabase,
  compactAndroidNativeAppDatabase,
} from './AndroidNativeDexieCore'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import { NativeMirroredResourceStorage } from './NativeMirroredResourceStorage'
import { IndexedDbProductAssistantStorage } from './IndexedDbProductAssistantStorage'
import { newAssistantConversation } from '../services/ProductAssistantWorkspaceService'
import { IndexedDbAssetStore } from './IndexedDbAssetStore'
import { RecycleBinService } from '../services/RecycleBinService'
import {
  RESOURCE_TYPE,
  toResourceListSummary,
  type Resource,
  type ResourceSummary,
} from '../types/Resource'
import {
  AndroidAppDatabaseMigrator,
  encodeAppDatabaseKey,
  decodeAppDatabaseKey,
  encodeAppDatabaseIndexes,
  fingerprintAppDatabaseStore,
} from './AndroidAppDatabaseMigration'
import { hashBlob } from '../services/HashService'
import { CHARACTER_CARD_FINGERPRINT_VERSION } from '../utils/CharacterCardFingerprint'
import { ChatReaderService } from '../services/ChatReaderService'
import { ResourceService } from '../services/ResourceService'
import { ResourceGalleryService, moveResourceGallery } from '../services/ResourceGalleryService'
import { RESOURCE_GALLERY_ASSET_KIND } from '../types/ResourceGallery'
import { cloudPlainSecretCopies } from '../services/PersonalResourceBackup'
import {
  updateDetails,
  moveManyToCategory,
  updateTagsMany,
  addTagsPerResource,
  undoAddedTags,
} from '../services/ResourceOrganizationOperations'
import {
  getRetainedIndexedDbCopy,
  clearRetainedIndexedDbCopy,
} from './AndroidNativeAppDatabaseRuntime'

function createNativeStore(keyPages = false, bridgeDelay = 0) {
  const bridgeTurn = async () => {
    if (bridgeDelay) await new Promise<void>((resolve) => setTimeout(resolve, bridgeDelay))
  }
  const stores = new Map<string, Map<string, Record<string, unknown>>>()
  const blobs = new Map<string, Blob>()
  const states = new Map<string, string>()
  const bump = (store: string) => {
    const key = `revision:appdb:v1:${store}`
    states.set(key, String(Number(states.get(key) ?? 0) + 1))
  }
  const indexes = new Map<string, Array<{ name: string; keys: string[] }>>()
  let failNextApplyBatch = false
  for (const name of APP_DATABASE_STORES) stores.set(name, new Map())
  const read = (store: string) => stores.get(store)!
  const blobKey = (store: string, key: string, path: string) => `${store}\0${key}\0${path}`
  const moveReferences = (value: unknown, store: string, key: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => moveReferences(item, store, key))
    if (!value || typeof value !== 'object') return value
    const row = { ...(value as Record<string, unknown>) }
    if (typeof row.blobOwnerKey === 'string' && typeof row.fieldPath === 'string') {
      const from = blobKey(store, row.blobOwnerKey, row.fieldPath)
      const to = blobKey(store, key, row.fieldPath)
      const blob = blobs.get(from)
      if (!blob) throw new Error('staged blob missing')
      blobs.set(to, blob)
      blobs.delete(from)
      delete row.blobOwnerKey
    }
    for (const [name, item] of Object.entries(row)) row[name] = moveReferences(item, store, key)
    return row
  }
  const native = {
    async getRecord(store: string, key: string) {
      await bridgeTurn()
      return read(store).get(key)
    },
    async getRecords(store: string, afterKey: string | undefined, limit: number) {
      await bridgeTurn()
      const rows = [...read(store).entries()]
        .filter(([key]) => afterKey === undefined || key > afterKey)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value }))
      const nextKey = rows.length === limit ? rows.at(-1)?.key : undefined
      return { rows, count: read(store).size, nextKey }
    },
    async getRecordKeys(store: string, afterKey: string | undefined, limit: number) {
      await bridgeTurn()
      const keys = [...read(store).keys()]
        .filter((key) => afterKey === undefined || key > afterKey)
        .sort()
        .slice(0, limit)
      return { keys, nextKey: keys.length === limit ? keys.at(-1) : undefined }
    },
    async countRecords(store: string) {
      return read(store).size
    },
    async getRecordsByKeys(store: string, keys: string[]) {
      await bridgeTurn()
      return keys.flatMap((key) => {
        const value = read(store).get(key)
        return value ? [{ key, value }] : []
      })
    },
    async getIndexEntries(store: string, indexName: string, indexKey?: string) {
      await bridgeTurn()
      const keyPaths = indexName.startsWith('[')
        ? indexName.slice(1, -1).split('+')
        : [indexName.replace(/^\*/u, '')]
      const rows: Array<{ indexKey: string; primaryKey: string }> = []
      for (const [primaryKey, value] of read(store)) {
        const saved = indexes.get(`${store}\0${primaryKey}`)
        if (saved) {
          for (const key of saved.find((index) => index.name === indexName)?.keys ?? [])
            if (indexKey === undefined || indexKey === key) rows.push({ indexKey: key, primaryKey })
          continue
        }
        const extracted: unknown =
          keyPaths.length === 1 ? value[keyPaths[0]!] : keyPaths.map((path) => value[path])
        const candidates =
          indexName.startsWith('*') && Array.isArray(extracted) ? extracted : [extracted]
        for (const candidate of candidates) {
          if (candidate === undefined || candidate === null) continue
          const encoded = JSON.stringify(candidate)
          if (indexKey === undefined || indexKey === encoded)
            rows.push({ indexKey: encoded, primaryKey })
        }
      }
      return rows
    },
    async countIndexEntries(store: string, indexName: string, indexKey?: string) {
      return (await native.getIndexEntries(store as never, indexName, indexKey)).length
    },
    async applyBatch(
      operations: Array<Record<string, unknown>>,
      options?: { expectedRevisions?: Record<string, number> },
    ) {
      await bridgeTurn()
      for (const [store, revision] of Object.entries(options?.expectedRevisions ?? {}))
        if (Number(states.get(`revision:appdb:v1:${store}`) ?? 0) !== revision)
          throw new Error('data changed during transaction')
      if (failNextApplyBatch) {
        failNextApplyBatch = false
        throw new Error('forced native commit failure')
      }
      for (const operation of operations) {
        const target = read(String(operation.store))
        if (operation.type === 'clear') target.clear()
        if (operation.type === 'delete') {
          for (const key of operation.keys as string[]) target.delete(key)
        }
        if (operation.type === 'put') {
          for (const row of operation.rows as Array<{
            key: string
            value: Record<string, unknown>
            indexes?: Array<{ name: string; keys: string[] }>
          }>) {
            target.set(
              row.key,
              moveReferences(row.value, String(operation.store), row.key) as Record<
                string,
                unknown
              >,
            )
            if (row.indexes) indexes.set(`${operation.store}\0${row.key}`, row.indexes)
          }
        }
        bump(String(operation.store))
      }
      return operations.length
    },
    async status() {
      return {
        schemaVersion: 1,
        counts: Object.fromEntries([...stores].map(([name, rows]) => [name, rows.size])),
      }
    },
    async getState(key: string) {
      return states.get(key)
    },
    async putState(key: string, value: string) {
      states.set(key, value)
    },
    async putRecordsWithState(
      store: string,
      rows: Array<{
        key: string
        value: Record<string, unknown>
        indexes?: Array<{ name: string; keys: string[] }>
      }>,
      key: string,
      value: string,
    ) {
      for (const row of rows) {
        read(store).set(row.key, row.value)
        if (row.indexes) indexes.set(`${store}\0${row.key}`, row.indexes)
      }
      states.set(key, value)
      return rows.length
    },
    async putRecords(store: string, rows: Array<{ key: string; value: Record<string, unknown> }>) {
      for (const row of rows) read(store).set(row.key, row.value)
      bump(store)
      return rows.length
    },
    async deleteRecords(store: string, keys: string[]) {
      for (const key of keys) read(store).delete(key)
      return keys.length
    },
    async clearStore(store: string) {
      read(store).clear()
    },
    async writeBlob(
      store: string,
      key: string,
      path: string,
      source: Blob,
      attachmentOwnerKey = key,
    ) {
      await bridgeTurn()
      blobs.set(blobKey(store, attachmentOwnerKey, path), source)
      return {
        sha256: await hashBlob(source),
        size: source.size,
        mimeType: source.type,
      }
    },
    async readBlob(store: string, key: string, path: string) {
      await bridgeTurn()
      return blobs.get(blobKey(store, key, path))
    },
    async deleteBlob(store: string, key: string, path: string) {
      await bridgeTurn()
      blobs.delete(blobKey(store, key, path))
    },
  } as unknown as typeof nativeAppDatabase
  if (keyPages) {
    const fixtureIndexes = native.getIndexEntries.bind(native)
    native.queryKeyPage = vi.fn(async (store, query) => {
      const revision = states.get(`revision:appdb:v1:${store}`) ?? '0'
      if (query.revision !== undefined && query.revision !== revision)
        throw new Error('原生查询期间数据已变化')
      const compare = (a: string, b: string) =>
        indexedDB.cmp(decodeAppDatabaseKey(a), decodeAppDatabaseKey(b))
      let rows = query.indexName
        ? await fixtureIndexes(store, query.indexName)
        : [...read(store).keys()].map((key) => ({ indexKey: key, primaryKey: key }))
      rows = rows.filter(
        (row) =>
          (query.lower === undefined ||
            compare(row.indexKey, query.lower) > (query.lowerOpen ? 0 : -1)) &&
          (query.upper === undefined ||
            compare(row.indexKey, query.upper) < (query.upperOpen ? 0 : 1)),
      )
      if (query.unique) {
        rows.sort((a, b) => compare(a.indexKey, b.indexKey) || compare(a.primaryKey, b.primaryKey))
        rows = rows.filter(
          (row, index) => !index || compare(row.indexKey, rows[index - 1]!.indexKey) !== 0,
        )
      }
      const sign = query.reverse ? -1 : 1
      rows.sort(
        (a, b) => sign * (compare(a.indexKey, b.indexKey) || compare(a.primaryKey, b.primaryKey)),
      )
      const tuple = (row: (typeof rows)[number], key: string, primary?: string) =>
        compare(row.indexKey, key) ||
        (primary === undefined || query.unique ? 0 : compare(row.primaryKey, primary))
      rows = rows.filter(
        (row) =>
          (query.afterKey === undefined ||
            sign * tuple(row, query.afterKey, query.afterPrimaryKey) > 0) &&
          (query.seekKey === undefined ||
            sign * tuple(row, query.seekKey, query.seekPrimaryKey) >= 0),
      )
      if (query.countOnly) return { count: rows.length, revision }
      return {
        rows: rows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)),
        revision,
      }
    })
  }
  return {
    stores,
    blobs,
    native,
    failNextNativeBatch() {
      failNextApplyBatch = true
    },
    blobKey,
  }
}

it.each([1000, 5000, 10000])(
  'measures bounded summary bridge reads for %i native rows',
  async (size) => {
    const database = new AppDatabase(`native-summary-perf-${crypto.randomUUID()}`)
    const { native, stores } = createNativeStore(true, 2)
    const ids = Array.from({ length: size }, (_, i) => `r-${i}`)
    for (const id of ids)
      stores
        .get('resourceListSummaries')!
        .set(JSON.stringify(id), { id, name: id, tags: ['keep'], metadata: {} })
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const batches = vi.spyOn(native, 'getRecordsByKeys')
    const originals = vi.spyOn(native, 'readBlob')
    try {
      const started = performance.now()
      const rows = await database.resourceListSummaries.bulkGet(ids)
      console.info(
        `NATIVE summaries ${size}: ${Math.round(performance.now() - started)}ms; bridge batches=${batches.mock.calls.length}; max rows=${Math.max(...batches.mock.calls.map(([, keys]) => keys.length))}`,
      )
      expect(rows.map((r) => r?.id)).toEqual(ids)
      expect(batches).toHaveBeenCalledTimes(Math.ceil(size / 250))
      expect(batches.mock.calls.every(([, keys]) => keys.length <= 250)).toBe(true)
      expect(originals).not.toHaveBeenCalled()
      batches.mockClear()
      const storage = new IndexedDbResourceStorage(database)
      expect(await storage.getResourceListSummaries([...ids, ids[0]!])).toEqual(rows)
      expect(batches).toHaveBeenCalledTimes(Math.ceil(size / 250))
      expect(batches.mock.calls.every(([, keys]) => keys.length <= 250)).toBe(true)
      expect(originals).not.toHaveBeenCalled()
      batches.mockClear()
      const keys = vi.spyOn(native, 'getRecordKeys')
      const service = new ResourceService(
        new NativeMirroredResourceStorage(storage, new VaultService(database)),
        new ResourceParserRegistry([]),
      )
      expect(
        (await service.getResourceListSummaries([ids[0]!, ids.at(-1)!, 'missing', ids[0]!])).map(
          (row) => row.id,
        ),
      ).toEqual([ids[0], ids.at(-1)])
      expect(batches).toHaveBeenCalledTimes(1)
      expect(batches.mock.calls[0]?.[1]).toHaveLength(3)
      expect(keys).not.toHaveBeenCalled()
      expect(originals).not.toHaveBeenCalled()
      expect(await database.resourceListSummaries.bulkGet(['r-0', 'missing', 'r-0'])).toEqual([
        rows[0],
        undefined,
        rows[0],
      ])
      batches.mockClear()
      const smaller = []
      const lowStarted = performance.now()
      for (let start = 0; start < ids.length; start += 100)
        smaller.push(
          ...(await database.resourceListSummaries.bulkGet(ids.slice(start, start + 100))),
        )
      console.info(
        `NATIVE caller batches 100 ${size}: ${Math.round(performance.now() - lowStarted)}ms; bridge batches=${batches.mock.calls.length}`,
      )
      expect(smaller).toEqual(rows)
      expect(batches).toHaveBeenCalledTimes(Math.ceil(size / 100))
      expect(batches.mock.calls.every(([, keys]) => keys.length <= 100)).toBe(true)
    } finally {
      database.close()
      await database.delete()
    }
  },
)

async function delayedDatabase() {
  const name = `native-core-routes-${crypto.randomUUID()}`
  const seed = new AppDatabase(name)
  await seed.open()
  seed.close()
  const fixture = createNativeStore(false, 1)
  const database = new AppDatabase(name)
  database.use(createAndroidNativeDexieCore({ enabled: () => true, native: fixture.native }))
  return {
    ...fixture,
    database,
    async close() {
      database.close()
      await database.delete()
    },
  }
}

it.each(['get', 'bulkGet', 'cursor'] as const)(
  'preserves native album and Discord file sources after %s without sharing mutable records',
  async (route) => {
    const fixture = await delayedDatabase()
    const { database, native } = fixture
    const platform = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    const readBlob = native.readBlob.bind(native)
    const reads = vi.spyOn(native, 'readBlob').mockImplementation(async (...args) => {
      const blob = await readBlob(...args)
      return blob ? rememberNativeFile(blob, `file:///fixture/${args[0]}/${args[2]}`) : undefined
    })
    const albumBlob = new Blob(['album-original'], { type: 'image/png' })
    const attachmentBlob = new Blob(['discord-original'], { type: 'text/plain' })
    try {
      await database.generatedImageFiles.put({
        id: 'album',
        originalBlob: albumBlob,
        originalMimeType: albumBlob.type,
        updatedAt: 1,
      })
      await database.assetFiles.put({ assetId: 'attachment', blob: attachmentBlob, updatedAt: 1 })
      reads.mockClear()
      const album =
        route === 'get'
          ? await database.generatedImageFiles.get('album')
          : route === 'bulkGet'
            ? (await database.generatedImageFiles.bulkGet(['album']))[0]
            : (await database.generatedImageFiles.toCollection().toArray())[0]
      const attachment =
        route === 'get'
          ? await database.assetFiles.get('attachment')
          : route === 'bulkGet'
            ? (await database.assetFiles.bulkGet(['attachment']))[0]
            : (await database.assetFiles.toCollection().toArray())[0]
      expect(reads).toHaveBeenCalledTimes(2)
      expect(nativeFileSource(album!.originalBlob!)).toBe(
        'file:///fixture/generatedImageFiles/$/originalBlob',
      )
      expect(nativeFileSource(attachment!.blob)).toBe('file:///fixture/assetFiles/$/blob')
      expect(await album!.originalBlob!.text()).toBe(await albumBlob.text())
      expect(await attachment!.blob.text()).toBe(await attachmentBlob.text())
      expect(nativeFileSource(album!.originalBlob!.slice(0, 2))).toBeUndefined()
      expect(nativeFileSource(new Blob([attachment!.blob, '!']))).toBeUndefined()
      const created = await createStructuredSnapshot(
        [],
        [],
        [],
        {
          version: 1,
          generatedImageAlbum: [
            {
              item: {
                id: 'album',
                name: 'album',
                source: 'imported',
                category: '',
                mimeType: 'image/png',
                sizeBytes: albumBlob.size,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
        },
        { readAlbumFile: async () => album!.originalBlob! },
      )
      expect(created.objectPlans[0]?.source).toEqual({
        kind: 'file',
        uri: 'file:///fixture/generatedImageFiles/$/originalBlob',
        offset: 0,
        size: albumBlob.size,
      })
      expect(created.chunks.size).toBe(0)
      expect(reads).toHaveBeenCalledTimes(2)
      album!.updatedAt = 999
      attachment!.updatedAt = 999
      expect((await database.generatedImageFiles.get('album'))!.updatedAt).toBe(1)
      expect((await database.assetFiles.get('attachment'))!.updatedAt).toBe(1)
    } finally {
      platform.mockRestore()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'reads prepared gallery previews and changes gallery metadata without native original IO (vault=%s)',
  async (encrypted) => {
    const fixture = await delayedDatabase()
    const { database, native } = fixture
    const vault = encrypted ? new VaultService(database) : undefined
    const binary = vi.spyOn(nativeAppDatabase, 'readBlob').mockImplementation(native.readBlob)
    try {
      await vault?.initialize()
      await vault?.enable('test-password')
      const assets = new IndexedDbAssetStore(database, vault)
      const storage = new IndexedDbResourceStorage(database, vault, assets)
      const owner = await routeResource('gallery-owner')
      await storage.saveMany([owner, { ...owner, id: 'other-owner' }])
      const picture = new Blob(['native picture'.repeat(10000)])
      const image = {
        ...owner,
        id: 'gallery-image',
        originalBlob: picture,
        fileSize: picture.size,
        contentHash: await hashCloudBlob(picture),
        thumbnailBlob: new Blob(['prepared thumbnail'], { type: 'image/webp' }),
        metadata: {
          assetKind: RESOURCE_GALLERY_ASSET_KIND,
          galleryOwnerId: owner.id,
          galleryStorage: 'local',
          retained: { nested: true },
        },
      }
      await storage.save(image)
      activateAndroidNativeAppDatabase()
      const gallery = new ResourceGalleryService(
        new NativeMirroredResourceStorage(storage, vault ?? new VaultService(database)),
        undefined,
        assets,
      )
      const originalGets = vi.spyOn(storage, 'get'),
        reads = vi.spyOn(native, 'readBlob'),
        writes = vi.spyOn(native, 'writeBlob')
      binary.mockClear()
      expect(await (await gallery.getImagePreview(owner.id, image.id)).blob?.text()).toBe(
        'prepared thumbnail',
      )
      await gallery.setCategories(owner.id, [image.id, image.id], ['category'])
      await moveResourceGallery(storage, owner.id, 'other-owner', [
        (await storage.getSummary(image.id))!,
      ])
      expect(originalGets).not.toHaveBeenCalled()
      for (const calls of [reads.mock.calls, writes.mock.calls, binary.mock.calls])
        expect(
          calls.some(
            ([store, , path]) =>
              store === 'resources' &&
              (path.startsWith('$/original') || path.startsWith('$/thumbnail')),
          ),
        ).toBe(false)
      database.close()
      await database.open()
      const saved = (await storage.get(image.id))!
      expect(await saved.originalBlob.text()).toBe(await image.originalBlob.text())
      expect(await saved.thumbnailBlob?.text()).toBe('prepared thumbnail')
      expect(saved.metadata).toMatchObject({
        galleryOwnerId: 'other-owner',
        retained: { nested: true },
      })
      expect(saved.tags).toEqual(['category'])
    } finally {
      deactivateAndroidNativeAppDatabase()
      binary.mockRestore()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'validates incoming bytes and reuses the native gallery original without changing it (vault=%s)',
  async (encrypted) => {
    const fixture = await delayedDatabase()
    const { database, native } = fixture
    const vault = encrypted ? new VaultService(database) : undefined
    const binary = vi.spyOn(nativeAppDatabase, 'readBlob').mockImplementation(native.readBlob)
    const thumbnail = vi.spyOn(
      await import('../utils/createImageThumbnail'),
      'createImageThumbnail',
    )
    try {
      await vault?.initialize()
      await vault?.enable('test-password')
      const storage = new IndexedDbResourceStorage(database, vault)
      const owner = await routeResource('gallery-owner')
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ),
        (value) => value.charCodeAt(0),
      )
      const file = new File([bytes], 'pixel.png', { type: 'image/png' })
      // PNG decoding is exercised by the real-browser audit; this test covers the native DB adapter.
      thumbnail.mockResolvedValue(new Blob([bytes], { type: 'image/png' }))
      const image = {
        ...owner,
        id: 'gallery-pixel',
        fileName: file.name,
        mimeType: file.type,
        originalBlob: file,
        thumbnailBlob: new Blob([bytes], { type: 'image/png' }),
        fileSize: file.size,
        contentHash: await hashCloudBlob(file),
        tags: ['keep'],
        metadata: {
          assetKind: RESOURCE_GALLERY_ASSET_KIND,
          galleryOwnerId: owner.id,
          galleryStorage: 'local',
          galleryVisible: true,
          retained: { nested: true },
        },
      }
      await storage.saveMany([owner, image])
      activateAndroidNativeAppDatabase()
      const gallery = new ResourceGalleryService(
        new NativeMirroredResourceStorage(storage, vault ?? new VaultService(database)),
      )
      const duplicate = await gallery.addFile(owner.id, file, ['keep'])
      expect(thumbnail).toHaveBeenCalledOnce()
      expect(duplicate.id).toBe(image.id)
      expect(new Uint8Array(await duplicate.originalBlob.arrayBuffer())).toEqual(bytes)
      expect(duplicate.metadata.retained).toEqual({ nested: true })
      expect(duplicate.tags).toEqual(['keep'])
      database.close()
      await database.open()
      expect((await storage.getSummary(image.id))?.contentHash).toBe(image.contentHash)
    } finally {
      deactivateAndroidNativeAppDatabase()
      binary.mockRestore()
      thumbnail.mockRestore()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'preserves migrated gallery slots through native atomic insertion (vault=%s)',
  async (encrypted) => {
    const fixture = await delayedDatabase(),
      { database, native } = fixture
    const vault = encrypted ? new VaultService(database) : undefined
    const binary = vi.spyOn(nativeAppDatabase, 'readBlob').mockImplementation(native.readBlob)
    const compare = vi
      .spyOn(nativeAppDatabase, 'haveSameRecordKeys')
      .mockImplementation(async (left, right) => {
        const a = fixture.stores.get(left)!,
          b = fixture.stores.get(right)!
        return a.size === b.size && [...a.keys()].every((key) => b.has(key))
      })
    try {
      await vault?.initialize()
      await vault?.enable('test-password')
      const storage = new IndexedDbResourceStorage(database, vault)
      await storage.saveMany([await routeResource('a'), await routeResource('b')])
      activateAndroidNativeAppDatabase()
      const wrapped = new NativeMirroredResourceStorage(
        storage,
        vault ?? new VaultService(database),
      )
      const gallery = new ResourceGalleryService(wrapped),
        url = 'https://example.com/native-image.png'
      const first = await gallery.addUrl('a', url, false, ['migrated'])
      await moveResourceGallery(wrapped, 'a', 'b')
      const second = await gallery.addUrl('a', url, false, ['new'])
      expect(second.id).not.toBe(first.id)
      database.close()
      await database.open()
      const old = await gallery.getImage('b', first.id)
      expect(old.tags).toEqual(['migrated'])
      expect(old.metadata.galleryUrl).toBe(url)
      expect(await hashCloudBlob(old.originalBlob)).toBe(first.contentHash)
      expect((await gallery.list('a')).galleryCount).toBe(1)
      expect((await gallery.list('b')).galleryCount).toBe(1)
    } finally {
      deactivateAndroidNativeAppDatabase()
      binary.mockRestore()
      compare.mockRestore()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'reads only selected plaintext backup originals through native scoped indexes (vault=%s)',
  async (encrypted) => {
    const fixture = await delayedDatabase(),
      { database, native } = fixture
    const vault = encrypted ? new VaultService(database) : undefined
    const binary = vi.spyOn(nativeAppDatabase, 'readBlob').mockImplementation(native.readBlob)
    const credentials = await import('../services/LocalCredentialStore')
    const grant = vi
      .spyOn(credentials.localCredentialStore, 'read')
      .mockResolvedValue('viewing-password')
    try {
      await vault?.initialize()
      await vault?.enable('test-password')
      const storage = new IndexedDbResourceStorage(database, vault),
        rows: Resource[] = []
      for (const id of ['selected', 'outside', 'excluded']) {
        const document = {
          format: 'srl-personal-resource',
          version: 1,
          kind: 'secret',
          name: id,
          text: '',
          url: '',
          attachments: [],
          fields: [],
        }
        const blob = new Blob([JSON.stringify(document)], { type: 'application/json' })
        rows.push({
          ...(await routeResource(id)),
          type: RESOURCE_TYPE.SECRET,
          originalBlob: blob,
          fileSize: blob.size,
          contentHash: await hashBlob(blob),
          metadata: id === 'excluded' ? { cloudBackupExcluded: true } : {},
        })
      }
      await storage.saveMany(rows)
      await database.resourceListSummaries.delete('selected')
      activateAndroidNativeAppDatabase()
      const full = vi.spyOn(storage, 'listSummaries'),
        read = vi.spyOn(storage, 'get')
      const wrapped = new NativeMirroredResourceStorage(
        storage,
        vault ?? new VaultService(database),
      )
      const resources = new ResourceService(wrapped, new ResourceParserRegistry([]))
      const copies = await cloudPlainSecretCopies(
        {
          provider: 'github',
          owner: 'test',
          repository: 'private',
          retention: 7,
          autoBackup: false,
        },
        resources,
        { secret: true, resourceIds: ['selected', 'excluded'] },
      )
      expect(copies.map((copy) => copy.document.name)).toEqual(['selected'])
      expect(full).not.toHaveBeenCalled()
      expect(read.mock.calls).toEqual([['selected']])
      expect((await storage.getResourceListSummary('selected'))?.type).toBe(RESOURCE_TYPE.SECRET)
    } finally {
      deactivateAndroidNativeAppDatabase()
      grant.mockRestore()
      binary.mockRestore()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'updates historical metadata without loading or rewriting native attachments (vault=%s)',
  async (encrypted) => {
    const fixture = await delayedDatabase()
    const { database, native } = fixture
    const vault = encrypted ? new VaultService(database) : undefined
    const binary = vi.spyOn(nativeAppDatabase, 'readBlob').mockImplementation(native.readBlob)
    try {
      await vault?.initialize()
      await vault?.enable('test-password')
      const storage = new IndexedDbResourceStorage(database, vault)
      const current = await routeResource('note-current')
      await storage.save(current)
      const history = {
        ...current,
        id: 'note-history',
        versionGroupId: current.id,
        thumbnailBlob: new Blob(['embedded thumbnail'], { type: 'image/webp' }),
      }
      await database.resourceVersions.put(vault ? await vault.encodeResource(history) : history)
      await database.resourceVersionSummaries.put(
        vault
          ? await vault.encodeResourceSummary(toResourceListSummary(history))
          : toResourceListSummary(history),
      )
      activateAndroidNativeAppDatabase()
      const reads = vi.spyOn(native, 'readBlob'),
        writes = vi.spyOn(native, 'writeBlob')
      binary.mockClear()
      await storage.updateVersion(history.id, {
        metadata: { retained: 'changed' },
        versionNote: 'note',
      })
      expect(
        reads.mock.calls.some(
          ([, , path]) => path.startsWith('$/original') || path.startsWith('$/thumbnail'),
        ),
      ).toBe(false)
      expect(
        binary.mock.calls.some(
          ([, , path]) => path.startsWith('$/original') || path.startsWith('$/thumbnail'),
        ),
      ).toBe(false)
      expect(
        writes.mock.calls.some(
          ([, , path]) => path.startsWith('$/original') || path.startsWith('$/thumbnail'),
        ),
      ).toBe(false)
      database.close()
      await database.open()
      expect(await storage.getSummary(history.id, true)).toMatchObject({
        versionNote: 'note',
        metadata: { retained: 'changed' },
      })
      const saved = (await storage.getVersion(history.id))!
      expect(await saved.originalBlob.text()).toBe(await current.originalBlob.text())
      expect(await saved.thumbnailBlob?.text()).toBe('embedded thumbnail')
    } finally {
      deactivateAndroidNativeAppDatabase()
      binary.mockRestore()
      await fixture.close()
    }
  },
)

it('maintains prepared native cards with light batched history reads and no original hydration', async () => {
  const fixture = await delayedDatabase()
  const { database, native } = fixture
  const storage = new IndexedDbResourceStorage(database)
  const compare = vi
    .spyOn(nativeAppDatabase, 'haveSameRecordKeys')
    .mockImplementation(async (left, right) => {
      const a = fixture.stores.get(left)!,
        b = fixture.stores.get(right)!
      return a.size === b.size && [...a.keys()].every((key) => b.has(key))
    })
  activateAndroidNativeAppDatabase()
  try {
    const current = {
      ...(await routeResource('prepared-card')),
      type: RESOURCE_TYPE.CHARACTER_CARD,
      versionCount: 1,
      metadata: {
        cardContentHash: 'a'.repeat(64),
        cardCoreHash: 'b'.repeat(64),
        cardFingerprintVersion: CHARACTER_CARD_FINGERPRINT_VERSION,
        card: { data: { creator: 'preserve' } },
      },
    }
    await storage.save(current)
    await storage.saveVersion({ ...current, id: 'prepared-history', versionGroupId: current.id })
    await storage.listResourceListSummaries()
    const binary = vi.spyOn(native, 'readBlob')
    const fullCurrent = vi.spyOn(storage, 'listSummaries')
    const fullHistory = vi.spyOn(storage, 'listVersionSummaries')
    const individualHistory = vi.spyOn(native, 'getRecord')
    const service = new ResourceService(storage, new ResourceParserRegistry([]))
    expect(await service.backfillCardFingerprints(async () => undefined)).toBe(0)
    expect(
      binary.mock.calls.length + fullCurrent.mock.calls.length + fullHistory.mock.calls.length,
    ).toBe(0)
    expect(
      individualHistory.mock.calls.filter(([store]) => store === 'resourceVersions').length,
    ).toBe(0)
    database.close()
    await database.open()
    expect((await storage.getSummary(current.id))?.metadata.card).toEqual(current.metadata.card)
    expect((await storage.getSummary(current.id))?.versionCount).toBe(1)
  } finally {
    compare.mockRestore()
    deactivateAndroidNativeAppDatabase()
    await fixture.close()
  }
})

it('deletes a folder through native metadata writes without hydrating originals', async () => {
  const fixture = await delayedDatabase()
  const { database, native } = fixture
  const resources = new IndexedDbResourceStorage(database)
  const categories = new IndexedDbCategoryStorage(database)
  const compare = vi
    .spyOn(nativeAppDatabase, 'haveSameRecordKeys')
    .mockImplementation(async (left, right) => {
      const a = fixture.stores.get(left)!,
        b = fixture.stores.get(right)!
      return a.size === b.size && [...a.keys()].every((key) => b.has(key))
    })
  activateAndroidNativeAppDatabase()
  try {
    const resource = await routeResource('folder-delete')
    await resources.save({ ...resource, categoryId: 'remove', categoryIds: ['remove', 'keep'] })
    await categories.save({
      id: 'remove',
      name: '删除',
      color: '#486b5d',
      createdAt: 1,
      updatedAt: 1,
    })
    await resources.listResourceListSummaries()
    const originals = vi.spyOn(native, 'readBlob')
    await categories.deleteAndUnassign('remove')
    expect(originals.mock.calls.length).toBe(0)
    expect(await resources.getResourceListSummary(resource.id)).toMatchObject({
      categoryId: 'keep',
      categoryIds: ['keep'],
    })
    database.close()
    await database.open()
    expect(await database.categories.get('remove')).toBeUndefined()
    expect(await (await resources.get(resource.id))?.originalBlob.text()).toBe(
      await resource.originalBlob.text(),
    )
  } finally {
    compare.mockRestore()
    deactivateAndroidNativeAppDatabase()
    await fixture.close()
  }
})

it('persists selected metadata edits in the native adapter without reading or replacing originals', async () => {
  const fixture = await delayedDatabase()
  const { database, native, stores } = fixture
  const storage = new IndexedDbResourceStorage(database)
  activateAndroidNativeAppDatabase()
  try {
    const selected = await routeResource('selected-organization')
    await storage.save(selected)
    for (let i = 0; i < 10000; i++) {
      const row = { ...toResourceListSummary(selected), id: `unrelated-${i}` }
      stores.get('resources')!.set(JSON.stringify(row.id), {
        ...row,
        originalBlob: { __srlAppDatabaseValueV1: 'blob', size: 1024 ** 3 },
      })
      stores.get('resourceSummaries')!.set(JSON.stringify(row.id), row)
      stores.get('resourceListSummaries')!.set(JSON.stringify(row.id), row)
    }
    const originals = vi.spyOn(native, 'readBlob')
    const full = vi.spyOn(storage, 'list')
    const rewrites = vi.spyOn(storage, 'saveMany')
    const companion = { ...selected, id: 'selected-companion' }
    await storage.save(companion)
    const service = new ResourceService(storage, new ResourceParserRegistry([]))
    await service.linkResources([selected.id, companion.id])
    await service.linkResources([selected.id, companion.id])
    await service.restoreRelatedLinks([{ ...selected, relatedResourceIds: [companion.id] }])
    await moveManyToCategory(storage, [selected.id, selected.id, 'missing'], 'folder')
    await updateTagsMany(storage, [selected.id], 'new', 'add')
    const added = await addTagsPerResource(storage, [{ resourceId: selected.id, tags: ['AI'] }])
    await undoAddedTags(storage, added.entries)
    expect(originals).not.toHaveBeenCalled()
    expect(full).not.toHaveBeenCalled()
    expect(rewrites).not.toHaveBeenCalled()
    database.close()
    await database.open()
    const loaded = (await storage.get(selected.id))!
    expect(loaded.tags).toEqual(['retain', 'new'])
    expect(loaded.categoryIds).toEqual(['folder'])
    expect(loaded.metadata).toEqual(selected.metadata)
    expect(await loaded.originalBlob.text()).toBe(await selected.originalBlob.text())
    expect((await storage.getSummary('unrelated-0'))!.tags).toEqual(['retain'])
  } finally {
    deactivateAndroidNativeAppDatabase()
    await fixture.close()
  }
})

async function routeResource(id: string): Promise<Resource> {
  const originalBlob = new Blob([JSON.stringify({ id, original: `preserve-${id}` })], {
    type: 'application/json',
  })
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: originalBlob.type,
    fileSize: originalBlob.size,
    contentHash: await hashCloudBlob(originalBlob),
    favorite: false,
    categoryId: null,
    tags: ['retain'],
    metadata: { nested: { original: id } },
    originalBlob,
    createdAt: 1,
    updatedAt: 1,
  }
}

it.each([1000, 5000, 10000])(
  'creates a persona in a %i-row native library without loading a character alias catalogue',
  async (size) => {
    const fixture = await delayedDatabase()
    const { database, native, stores } = fixture
    const storage = new IndexedDbResourceStorage(database)
    const parser = new JsonResourceParser()
    const parsed = vi.spyOn(parser, 'parse')
    const service = new ResourceService(storage, new ResourceParserRegistry([parser]))
    const personas = new UserPersonaService(service)
    const card = { ...(await routeResource('card')), type: RESOURCE_TYPE.CHARACTER_CARD }
    card.originalBlob = new Blob([new Uint8Array(1024 * 1024)])
    card.fileSize = card.originalBlob.size
    await storage.save(card)
    for (let i = 1; i < size; i++) {
      const value = { ...card, id: `unrelated-${i}`, originalBlob: undefined }
      for (const store of ['resources', 'resourceSummaries', 'resourceListSummaries'])
        stores.get(store)!.set(JSON.stringify(value.id), value)
    }
    const draft: UserPersonaDraft = {
      avatarId: 'me.png',
      name: 'New persona',
      title: '',
      description: 'My own description',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      connections: [],
      characterBindings: {},
      profile: {
        version: 1,
        sections: [{ id: 'base', name: '基础设定', text: 'My own description' }],
        variants: {},
      },
    }
    const scans = vi.spyOn(storage, 'listSummaries')
    const history = vi.spyOn(storage, 'listVersionSummaries')
    const keys = vi.spyOn(native, 'getRecordKeys')
    const binaries = vi.spyOn(native, 'readBlob')
    const cover = vi.spyOn(service, 'updateThumbnail')
    activateAndroidNativeAppDatabase()
    try {
      const started = performance.now()
      const result = await personas.create(draft, [card.id], null)
      console.info(
        `create ${size} persisted: ${Math.round(performance.now() - started)}ms; catalogues=${scans.mock.calls.length + history.mock.calls.length}; key pages=${keys.mock.calls.length}; binary reads=${binaries.mock.calls.length}`,
      )
      expect(scans).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      expect(keys).not.toHaveBeenCalled()
      expect(cover).not.toHaveBeenCalled()
      expect(binaries.mock.calls.some(([, key]) => key === JSON.stringify(card.id))).toBe(false)
      expect(result.relatedResourceIds).toEqual([card.id])
      expect((await storage.getSummary(card.id))?.relatedResourceIds).toEqual([result.id])
      // The app reloads the saved persona and asks which neighbours are avatar attachments.
      const loaded = await personas.load(result.id)
      expect(loaded.view.entries[0]?.description).toBe(draft.description)
      const beforeAvatarReads = binaries.mock.calls.length
      expect(await personas.loadAvatarResource(card.id)).toBeUndefined()
      expect(binaries).toHaveBeenCalledTimes(beforeAvatarReads)
      console.info(
        `native create ${size}: ${Math.round(performance.now() - started)}ms; full catalogues=0; related original reads=0`,
      )
      const repeated = await personas.create(draft, [card.id], null)
      expect(repeated.id).toBe(result.id)
      expect(stores.get('resources')?.size).toBe(size + 1)
      expect(parsed).toHaveBeenCalledTimes(1)
      const second = await personas.create({ ...draft, name: 'Another persona' }, [card.id], null)
      expect(second.id).not.toBe(result.id)
      expect(parsed).toHaveBeenCalledTimes(2)
      expect(scans).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
      expect(binaries.mock.calls.some(([, key]) => key === JSON.stringify(card.id))).toBe(false)
      database.close()
      await database.open()
      expect((await personas.load(result.id)).view.entries[0]?.description).toBe(draft.description)
      expect(await (await storage.get(card.id))!.originalBlob.arrayBuffer()).toEqual(
        await card.originalBlob.arrayBuffer(),
      )
    } finally {
      deactivateAndroidNativeAppDatabase()
      await fixture.close()
    }
  },
)

it.each([1000, 5000, 10000])(
  'binds and unbinds a persona in a %i-row native library without scanning or reading originals',
  async (size) => {
    const fixture = await delayedDatabase()
    const { database, native, stores } = fixture
    const storage = new IndexedDbResourceStorage(database)
    const persona = { ...(await routeResource('persona')), type: RESOURCE_TYPE.USER_PERSONA }
    const card = { ...(await routeResource('card')), type: RESOURCE_TYPE.CHARACTER_CARD }
    card.originalBlob = new Blob([new Uint8Array(1024 * 1024)])
    card.fileSize = card.originalBlob.size
    await storage.saveMany([persona, card])
    for (let i = 2; i < size; i++) {
      const id = `unrelated-${i}`
      stores
        .get('resources')!
        .set(JSON.stringify(id), { ...stores.get('resources')!.get('"card"')!, id })
    }
    const scans = vi.spyOn(native, 'getRecordKeys')
    const reads = vi.spyOn(native, 'readBlob')
    const writes = vi.spyOn(native, 'writeBlob')
    const fullReads = vi.spyOn(storage, 'get')
    const catalogue = vi.spyOn(storage, 'listSummaries')
    const saves = vi.spyOn(storage, 'saveMany')
    activateAndroidNativeAppDatabase()
    try {
      const details = {
        name: persona.name,
        description: '',
        type: persona.type,
        categoryIds: [],
        relatedResourceIds: [card.id, 'missing'],
        tags: persona.tags,
      }
      const started = performance.now()
      await updateDetails(storage, persona, details)
      expect(catalogue).not.toHaveBeenCalled()
      expect(fullReads).not.toHaveBeenCalled()
      expect(saves).not.toHaveBeenCalled()
      expect(scans).not.toHaveBeenCalled()
      expect(reads).not.toHaveBeenCalled()
      expect(writes).not.toHaveBeenCalled()
      const bound = (await storage.getSummary(persona.id))!
      expect(bound.relatedResourceIds).toEqual([card.id])
      expect(bound.metadata.manuallyBoundResourceIds).toEqual([card.id])
      expect((await storage.getSummary(card.id))?.relatedResourceIds).toEqual([persona.id])
      await updateDetails(storage, { ...persona, ...bound }, { ...details, relatedResourceIds: [] })
      expect((await storage.getSummary(card.id))?.relatedResourceIds).toEqual([])
      console.info(
        `native persona ${size}: ${Math.round(performance.now() - started)}ms; scans=${scans.mock.calls.length}; binary reads=${reads.mock.calls.length}; writes=${writes.mock.calls.length}`,
      )
      database.close()
      await database.open()
      expect((await storage.getSummary(persona.id))?.relatedResourceIds).toEqual([])
      expect(await (await storage.get(card.id))!.originalBlob.arrayBuffer()).toEqual(
        await card.originalBlob.arrayBuffer(),
      )
      fixture.failNextNativeBatch()
      await expect(updateDetails(storage, persona, details)).rejects.toThrow(
        'forced native commit failure',
      )
      expect((await storage.getSummary(persona.id))?.name).toBe(persona.name)
      expect((await storage.getSummary(persona.id))?.relatedResourceIds).toEqual([])
      expect((await storage.getSummary(card.id))?.relatedResourceIds).toEqual([])
      await database.transaction(
        'rw',
        [database.resources, database.resourceSummaries, database.resourceListSummaries],
        async () => {
          await storage.updateMetadata(card.id, { name: 'first edit' })
          expect(await (await storage.get(card.id))!.originalBlob.arrayBuffer()).toEqual(
            await card.originalBlob.arrayBuffer(),
          )
          await storage.updateMetadata(card.id, { name: 'second edit' })
          expect((await storage.getSummary(card.id))?.name).toBe('second edit')
        },
      )
      expect(await (await storage.get(card.id))!.originalBlob.arrayBuffer()).toEqual(
        await card.originalBlob.arrayBuffer(),
      )
    } finally {
      deactivateAndroidNativeAppDatabase()
      await fixture.close()
    }
  },
)

it.each([false, true])(
  'creates and reloads the real persona avatar while preserving unrelated card bytes (vault: %s)',
  async (sealed) => {
    const fixture = await delayedDatabase()
    const vault = new VaultService(fixture.database)
    const nativeBinary = vi
      .spyOn(nativeAppDatabase, 'readBlob')
      .mockImplementation(fixture.native.readBlob)
    try {
      await vault.initialize()
      if (sealed) await vault.enable('synthetic-persona-test-password')
      const storage = new IndexedDbResourceStorage(fixture.database, vault)
      const service = new ResourceService(
        storage,
        new ResourceParserRegistry([new JsonResourceParser()]),
      )
      const personas = new UserPersonaService(service)
      const card = { ...(await routeResource('bound-card')), type: RESOURCE_TYPE.CHARACTER_CARD }
      const avatar = {
        ...(await routeResource('avatar')),
        metadata: { assetKind: 'userPersonaAvatar', avatarId: 'me.png' },
        thumbnailBlob: new Blob(['avatar thumbnail'], { type: 'image/webp' }),
      }
      await storage.saveMany([card, avatar])
      activateAndroidNativeAppDatabase()
      const cardBytes = fixture.stores.get('resources')!.get(JSON.stringify(card.id))
      const binary = vi.spyOn(fixture.native, 'readBlob')
      const fullRead = vi.spyOn(service, 'get')
      const draft: UserPersonaDraft = {
        avatarId: 'me.png',
        name: 'Avatar persona',
        title: '',
        description: 'Persisted persona',
        position: 0,
        depth: 2,
        role: 0,
        lorebook: '',
        connections: [],
        characterBindings: {},
        profile: {
          version: 1,
          sections: [{ id: 'base', name: '基础设定', text: 'Persisted persona' }],
          variants: {},
        },
      }
      const created = await personas.create(draft, [card.id, avatar.id], avatar)
      expect(await created.thumbnailBlob!.text()).toBe('avatar thumbnail')
      expect(await personas.loadAvatarResource(card.id)).toBeUndefined()
      // Old restores can miss the derived list row. Avatar existence comes from
      // the original record's metadata, so a missing list entry must not hide it.
      await fixture.database.resourceListSummaries.delete(avatar.id)
      const loadedAvatar = await personas.loadAvatarResource(avatar.id)
      expect(await loadedAvatar!.originalBlob.text()).toBe(await avatar.originalBlob.text())
      expect(fullRead.mock.calls.some(([id]) => id === card.id)).toBe(false)
      expect(
        binary.mock.calls.some(
          ([, key, field]) => key === JSON.stringify(card.id) && field.startsWith('$/original'),
        ),
      ).toBe(false)
      expect(
        fixture.stores.get('resources')!.get(JSON.stringify(card.id))?.originalBlob ??
          fixture.stores.get('resources')!.get(JSON.stringify(card.id))?.original,
      ).toEqual(cardBytes?.originalBlob ?? cardBytes?.original)
      fixture.database.close()
      await fixture.database.open()
      expect((await personas.load(created.id)).view.entries[0]?.name).toBe(draft.name)
      expect(await (await personas.loadAvatarResource(avatar.id))!.originalBlob.text()).toBe(
        await avatar.originalBlob.text(),
      )
      expect(await (await storage.get(card.id))!.originalBlob.text()).toBe(
        await card.originalBlob.text(),
      )
    } finally {
      deactivateAndroidNativeAppDatabase()
      nativeBinary.mockRestore()
      await fixture.close()
    }
  },
)

it.each(
  [1000, 5000, 10000].flatMap((size) => [
    { size, single: false },
    { size, single: true },
  ]),
)(
  'deletes one native resource among $size unrelated histories with scoped reads (single=$single)',
  async ({ size, single }) => {
    const fixture = await delayedDatabase()
    const { database, native, stores } = fixture
    const storage = new IndexedDbResourceStorage(database)
    const selected = await routeResource('selected')
    const other = await routeResource('other')
    await storage.saveMany([selected, other])
    await storage.saveVersion({ ...selected, id: 'selected-history', versionGroupId: selected.id })
    const row = { ...other, originalBlob: undefined, versionGroupId: other.id }
    await native.putRecordsWithState(
      'resourceVersions',
      Array.from({ length: size }, (_, index) => {
        const value = { ...row, id: `other-history-${index}` }
        return {
          key: JSON.stringify(value.id),
          value,
          indexes: encodeAppDatabaseIndexes(value, database.resourceVersions.schema.indexes),
        }
      }),
      'fixture:history',
      'ready',
    )
    const mirror = new NativeMirroredResourceStorage(storage, new VaultService(database))
    const allVersions = vi.spyOn(storage, 'listVersionListSummaries')
    const keys = vi.spyOn(native, 'getRecordKeys')
    const binaryReads = vi.spyOn(native, 'readBlob')
    const reads = vi.spyOn(native, 'getRecord')
    try {
      const started = performance.now()
      if (single) await mirror.delete(selected.id)
      else await mirror.deleteMany([selected.id])
      expect(allVersions).not.toHaveBeenCalled()
      expect(keys.mock.calls.some(([store]) => store === 'resourceVersions')).toBe(false)
      expect(binaryReads).not.toHaveBeenCalled()
      expect(
        reads.mock.calls.filter(([store]) => store === 'resourceVersionSummaries'),
      ).toHaveLength(1)
      expect(stores.get('resourceVersions')?.size).toBe(size)
      expect(await storage.get(selected.id)).toBeUndefined()
      expect(await storage.getVersion('selected-history')).toBeUndefined()
      expect(await (await storage.get(other.id))!.originalBlob.text()).toBe(
        await other.originalBlob.text(),
      )
      console.info(
        `native deletion ${size} histories: ${Math.round(performance.now() - started)}ms; history summary reads=1; unrelated original reads=0`,
      )
      database.close()
      await database.open()
      expect(await storage.get(selected.id)).toBeUndefined()
      expect(stores.get('resourceVersions')?.size).toBe(size)
    } finally {
      await fixture.close()
    }
  },
)

describe('AndroidNativeDexieCore', () => {
  it('recovers the retained IndexedDB chat into the active native adapter and persists it after reopening', async () => {
    const { database, native, stores, close } = await delayedDatabase()
    const old = newAssistantConversation()
    old.title = '迁移后旧包写入的聊天'
    old.history = [{ id: 'old-turn', role: 'user', text: '仍在旧 IndexedDB' }]
    const source = new Dexie(database.name)
    await source.open()
    await source
      .table('settings')
      .put({ id: 'assistant.chat:' + old.id, value: old, updatedAt: old.updatedAt })
    const sourceBefore = await source.table('settings').toArray()
    source.close()
    activateAndroidNativeAppDatabase()
    try {
      const storage = new IndexedDbProductAssistantStorage(database)
      const current = newAssistantConversation()
      current.input = '新原生库中的输入'
      await storage.save(current, true)
      expect((await storage.list(0, 20)).total).toBe(1)
      await expect(storage.recoverHistory({})).resolves.toMatchObject({ recovered: 1, repaired: 0 })
      expect(await storage.active()).toBe(current.id)
      const recovered = (await storage.list(0, 20)).items.find((row) => row.id !== current.id)!
      expect((await storage.read(recovered.id))?.history).toEqual(old.history)
      expect(stores.get('settings')!.has(JSON.stringify('assistant.chat:' + recovered.id))).toBe(
        true,
      )
      database.close()
      await database.open()
      const reopened = new IndexedDbProductAssistantStorage(database)
      expect((await reopened.read(recovered.id))?.history).toEqual(old.history)
      await expect(reopened.recoverHistory({})).resolves.toMatchObject({ recovered: 0 })
      await source.open()
      expect(await source.table('settings').toArray()).toEqual(sourceBefore)
      source.close()
      expect(native.getRecord).toBeDefined()
    } finally {
      deactivateAndroidNativeAppDatabase()
      source.close()
      await close()
    }
  })
  it('paginates mirror scans with an unbounded upper key and supports an unbounded lower key', async () => {
    const name = `native-open-range-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const database = new AppDatabase(name)
    const { native, stores } = createNativeStore(true)
    for (const id of ['a', 'b', 'c']) stores.get('resources')!.set(JSON.stringify(id), { id })
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      expect(
        (await database.resources.where('id').above('').limit(2).toArray()).map((row) => row.id),
      ).toEqual(['a', 'b'])
      expect(
        (await database.resources.where('id').above('b').limit(2).toArray()).map((row) => row.id),
      ).toEqual(['c'])
      expect(await database.resources.where('id').below('b').primaryKeys()).toEqual(['a'])
    } finally {
      database.close()
      await new AppDatabase(name).delete()
    }
  })
  it.each(['page', 'attachment'] as const)(
    'does not revive a stopped cursor after an in-flight %s read',
    async (phase) => {
      const name = `native-cursor-stop-${crypto.randomUUID()}`
      const seed = new AppDatabase(name)
      await seed.open()
      seed.close()
      const database = new AppDatabase(name)
      const { native, stores, blobs, blobKey } = createNativeStore(true)
      let unblock!: () => void, started!: () => void
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve
      })
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const blob = new Blob(['abc'], { type: 'text/plain' })
      for (let i = 0; i < 120; i++) {
        const id = String(i).padStart(3, '0')
        stores.get('settings')!.set(JSON.stringify(id), {
          id,
          data: {
            __srlAppDatabaseValueV1: 'blob',
            fieldPath: '$/data',
            size: blob.size,
            mimeType: blob.type,
            sha256: await hashBlob(blob),
          },
        })
        blobs.set(blobKey('settings', JSON.stringify(id), '$/data'), blob)
      }
      if (phase === 'page') {
        const original = vi.mocked(native.queryKeyPage).getMockImplementation()!
        vi.mocked(native.queryKeyPage).mockImplementation(async (store, query) => {
          const result = await original(store, query)
          if (query.afterKey !== undefined) {
            started()
            await blocked
          }
          return result
        })
      } else {
        const read = native.readBlob.bind(native)
        vi.spyOn(native, 'readBlob').mockImplementation(async (...args) => {
          const value = await read(...args)
          started()
          await blocked
          return value
        })
      }
      database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
      let cursor: Awaited<ReturnType<typeof database.settings.core.openCursor>>
      let callbacks = 0
      try {
        const reading = database.transaction('r', database.settings, async (transaction) => {
          cursor = await database.settings.core.openCursor({
            trans: transaction.idbtrans,
            query: {
              index: database.settings.core.schema.primaryKey,
              range: { type: 3, lower: null, upper: null },
            },
            values: phase === 'attachment',
          })
          await cursor!.start(() => {
            callbacks++
            cursor!.continue()
          })
        })
        await ready
        cursor!.stop()
        await reading
        await database.settings.put({ id: 'after-stop', value: true, updatedAt: 1 })
        unblock()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(callbacks).toBe(phase === 'page' ? 100 : 0)
        expect(cursor!.value).toBeUndefined()
        expect(cursor!.done).toBe(true)
        expect(await database.settings.get('after-stop')).toMatchObject({ value: true })
      } finally {
        unblock()
        database.close()
        await new AppDatabase(name).delete()
      }
    },
  )

  it.each([1000, 10000])(
    'reads indexed ranges and cursor pages from a %i-row native library in bounded bridge pages',
    async (size) => {
      const name = `native-pages-${crypto.randomUUID()}`
      const seed = new AppDatabase(name)
      await seed.open()
      seed.close()
      const database = new AppDatabase(name)
      const { native, stores } = createNativeStore(true)
      for (let i = 0; i < size; i++) {
        const id = String(i).padStart(5, '0')
        stores
          .get('resourceListSummaries')!
          .set(JSON.stringify(id), { id, updatedAt: i, tags: ['shared', `tag-${i % 3}`] })
      }
      database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
      const fullKeys = vi.spyOn(native, 'getRecordKeys')
      const fullIndexes = vi.spyOn(native, 'getIndexEntries')
      const bytes = vi.spyOn(native, 'readBlob')
      const records = vi.spyOn(native, 'getRecordsByKeys')
      const record = vi.spyOn(native, 'getRecord')
      const pages = vi.mocked(native.queryKeyPage)
      try {
        const result = await database.resourceListSummaries
          .where('updatedAt')
          .between(9, 500, false, true)
          .reverse()
          .limit(7)
          .toArray()
        expect(result.map((row) => row.id)).toEqual(
          Array.from({ length: 7 }, (_, i) => String(500 - i).padStart(5, '0')),
        )
        expect(pages).toHaveBeenCalledTimes(1)
        await expect(pages.mock.results[0]!.value).resolves.toMatchObject({
          rows: expect.any(Array),
        })
        expect(records.mock.calls.flatMap((call) => call[1])).toHaveLength(7)
        pages.mockClear()
        records.mockClear()
        const last = await database.resourceListSummaries
          .orderBy('updatedAt')
          .offset(size - 8)
          .limit(8)
          .toArray()
        expect(last.map((row) => row.updatedAt)).toEqual(
          Array.from({ length: 8 }, (_, i) => size - 8 + i),
        )
        expect(pages.mock.calls.length).toBeLessThanOrEqual(2)
        expect(pages.mock.calls.every(([, query]) => (query.limit ?? 100) <= 100)).toBe(true)
        expect(record.mock.calls.length).toBeLessThanOrEqual(9)
        expect(records).not.toHaveBeenCalled()
        pages.mockClear()
        const selected = await database.resourceListSummaries
          .where('updatedAt')
          .anyOf([2, 110, 800])
          .primaryKeys()
        expect(selected).toEqual(['00002', '00110', '00800'])
        expect(pages.mock.calls.length).toBeLessThanOrEqual(4)
        pages.mockClear()
        expect(
          await database.resourceListSummaries
            .where('updatedAt')
            .between(10, 19, true, true)
            .count(),
        ).toBe(10)
        expect(pages.mock.calls[0]?.[1].countOnly).toBe(true)
        expect(fullKeys).not.toHaveBeenCalled()
        expect(fullIndexes).not.toHaveBeenCalled()
        expect(bytes).not.toHaveBeenCalled()
        // A failed optional API uses the established path; actual errors remain visible.
        pages.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
        expect(
          await database.resourceListSummaries.orderBy('updatedAt').limit(1).primaryKeys(),
        ).toEqual(['00000'])
        expect(fullIndexes).toHaveBeenCalledOnce()
        pages.mockRejectedValueOnce(new Error('SQLite failed'))
        await expect(
          database.resourceListSummaries.orderBy('updatedAt').limit(1).primaryKeys(),
        ).rejects.toThrow('SQLite failed')
      } finally {
        database.close()
        await new AppDatabase(name).delete()
      }
    },
  )

  it('keeps paged mixed keys, reverse unique keys and revision changes consistent', async () => {
    const name = `native-mixed-pages-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const database = new AppDatabase(name)
    const { native, stores } = createNativeStore(true)
    const keys: IDBValidKey[] = [
      2,
      10,
      -1,
      new Date('2020-01-01'),
      'a',
      'a"',
      'a\\',
      '🌧',
      '\ue000',
      new Uint8Array([0, 255]).buffer,
      [],
      ['a', 2],
      ['a', 10],
      [['a']],
    ]
    for (const key of keys)
      stores.get('settings')!.set(encodeAppDatabaseKey(key), { id: key, value: true })
    for (let i = 0; i < 230; i++) {
      const id = String(i).padStart(3, '0')
      stores
        .get('resourceListSummaries')!
        .set(JSON.stringify(id), { id, updatedAt: Math.floor(i / 2) })
    }
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      expect(await database.settings.toCollection().primaryKeys()).toEqual(
        [...keys].sort((a, b) => indexedDB.cmp(a, b)),
      )
      expect(await database.settings.where('id').anyOf([2, 10]).primaryKeys()).toEqual([2, 10])
      // IDB prevunique returns the lowest primary key, even though index keys descend.
      const result: string[] = []
      await database.transaction('r', database.resourceListSummaries, async (transaction) => {
        const cursor = await database.resourceListSummaries.core.openCursor({
          trans: transaction.idbtrans,
          query: {
            index: database.resourceListSummaries.core.schema.indexes.find(
              (index) => index.name === 'updatedAt',
            )!,
            range: { type: 3, lower: null, upper: null },
          },
          unique: true,
          reverse: true,
          values: false,
        })
        await cursor!.start(() => {
          result.push(String(cursor!.primaryKey))
          cursor!.continue()
        })
      })
      expect(result).toEqual(
        Array.from({ length: 115 }, (_, i) => String(228 - 2 * i).padStart(3, '0')),
      )
      const page = vi.mocked(native.queryKeyPage)
      const original = page.getMockImplementation()!
      let called = false
      page.mockImplementation(async (store, query) => {
        if (called && query.afterKey !== undefined) throw new Error('原生查询期间数据已变化')
        called = true
        return original(store, query)
      })
      await expect(
        database.resourceListSummaries
          .toCollection()
          .filter(() => true)
          .primaryKeys(),
      ).rejects.toThrow('已变化')
    } finally {
      database.close()
      await new AppDatabase(name).delete()
    }
  })

  it('lists large recycle archives without Blob reads and restores only the selected archive', async () => {
    const name = `native-recycle-metadata-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const database = new AppDatabase(name)
    const { native, stores, blobs, blobKey } = createNativeStore(true)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const selected = new Blob(['selected archive bytes'], { type: 'application/zip' })
    for (let index = 0; index < 250; index++) {
      const id = `archive-${String(index).padStart(3, '0')}`
      const key = encodeAppDatabaseKey(id)
      stores.get('backupRecords')!.set(key, {
        id,
        adapter: index % 2 ? 'local-recycle-bin-persona-version' : 'local-recycle-bin',
        objectKey: `${id}.zip`,
        resourceCount: index + 1,
        createdAt: index,
        ...(index % 3 ? { size: 77 } : {}),
        ...(index === 1 ? { encrypted: true, encryptionIv: 'retained-iv' } : {}),
        blob: {
          __srlAppDatabaseValueV1: 'blob',
          fieldPath: '/blob',
          size: index === 0 ? selected.size : 1024 ** 3,
          mimeType: 'application/zip',
          sha256: 'a'.repeat(64),
        },
      })
    }
    stores
      .get('backupRecords')!
      .set('"unrelated"', { id: 'unrelated', adapter: 'local-history', createdAt: 1000 })
    blobs.set(blobKey('backupRecords', '"archive-000"', '/blob'), selected)
    const reads = vi.spyOn(native, 'readBlob')
    const batch = vi.spyOn(native, 'getRecordsByKeys')
    const restore = vi.fn(async () => {})
    const prepare = vi.fn(async (file: File) => {
      expect(await file.text()).toBe('selected archive bytes')
      return { preview: { mode: 'partial' }, resources: [] }
    })
    type Args = ConstructorParameters<typeof RecycleBinService>
    const service = new RecycleBinService(
      database,
      {
        listResourceListSummaries: async () => [],
        restoreRelatedLinks: async () => {},
      } as unknown as Args[1],
      { list: async () => [] } as unknown as Args[2],
      {} as Args[3],
      { prepare, restore } as unknown as Args[4],
      {} as Args[5],
      {} as Args[6],
    )
    activateAndroidNativeAppDatabase()
    try {
      const records = await service.list()
      expect(records).toHaveLength(250)
      expect(records[0]?.id).toBe('archive-249')
      expect(records.find((record) => record.id === 'archive-001')).toMatchObject({
        size: 77,
        encrypted: true,
        encryptionIv: 'retained-iv',
      })
      expect(records.find((record) => record.id === 'archive-003')?.size).toBe(1024 ** 3)
      expect(records.every((record) => !('blob' in record))).toBe(true)
      expect(reads).not.toHaveBeenCalled()
      expect(batch).toHaveBeenCalledTimes(3)
      expect(batch.mock.calls.every(([, keys]) => keys.length <= 100)).toBe(true)
      await service.restore('archive-000')
      expect(prepare).toHaveBeenCalledOnce()
      expect(restore).toHaveBeenCalledOnce()
      expect(reads).toHaveBeenCalledExactlyOnceWith(
        'backupRecords',
        '"archive-000"',
        '/blob',
        'a'.repeat(64),
      )
      expect(stores.get('backupRecords')!.has('"archive-000"')).toBe(false)
      expect(stores.get('backupRecords')!.has('"archive-003"')).toBe(true)
      reads.mockClear()
      expect(await service.list()).toHaveLength(249)
      expect(reads).not.toHaveBeenCalled()
      batch.mockRejectedValueOnce(new Error('native metadata failure'))
      await expect(service.list()).rejects.toThrow('native metadata failure')
      expect(reads).not.toHaveBeenCalled()
      const progress = vi.fn()
      await service.purge('archive-002', progress)
      expect(progress.mock.calls.map(([value]) => value.completed)).toEqual([0, 1])
      expect(stores.get('backupRecords')!.has('"archive-002"')).toBe(false)
      expect(reads).not.toHaveBeenCalled()
      await expect(service.purge('unrelated')).rejects.toThrow('回收站记录已经不存在')
      await expect(service.purge('missing')).rejects.toThrow('回收站记录已经不存在')
      expect(stores.get('backupRecords')!.has('"unrelated"')).toBe(true)
      await service.empty()
      expect(await service.list()).toEqual([])
      expect(stores.get('backupRecords')!.has('"unrelated"')).toBe(true)
      expect(reads).not.toHaveBeenCalled()
    } finally {
      deactivateAndroidNativeAppDatabase()
      reads.mockRestore()
      batch.mockRestore()
      database.close()
      await new AppDatabase(name).delete()
    }
  })

  it.each([false, true])(
    'reads full card summaries without original/thumbnail hydration (encrypted=%s)',
    async (encrypted) => {
      const name = `native-role-summary-${crypto.randomUUID()}`
      const seed = new AppDatabase(name)
      await seed.open()
      seed.close()
      const database = new AppDatabase(name)
      const { native, stores, blobs, blobKey } = createNativeStore()
      database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
      const metadata = {
        card: { description: 'complete lore', extensions: { regex_scripts: ['rule'] } },
      }
      const payload = new Blob(
        [JSON.stringify({ type: RESOURCE_TYPE.CHARACTER_CARD, name: '角色', metadata })],
        { type: 'application/octet-stream' },
      )
      const descriptor = {
        __srlAppDatabaseValueV1: 'blob',
        fieldPath: '/originalBlob',
        size: 1024 ** 3,
        mimeType: 'image/png',
        sha256: 'a'.repeat(64),
      }
      const record = encrypted
        ? {
            id: 'card',
            contentHash: 'card-hash',
            updatedAt: 1,
            encrypted: true,
            payload: {
              iv: 'metadata-iv',
              data: {
                ...descriptor,
                fieldPath: '/payload/data',
                size: payload.size,
                mimeType: payload.type,
              },
            },
            original: { iv: 'original-iv', data: descriptor },
            thumbnail: {
              iv: 'thumbnail-iv',
              data: { ...descriptor, fieldPath: '/thumbnail/data' },
            },
          }
        : {
            id: 'card',
            contentHash: 'card-hash',
            type: RESOURCE_TYPE.CHARACTER_CARD,
            metadata,
            originalBlob: descriptor,
            thumbnailBlob: { ...descriptor, fieldPath: '/thumbnailBlob' },
          }
      stores.get('resources')!.set('"card"', record)
      blobs.set(blobKey('resources', '"card"', '/payload/data'), payload)
      const reads = vi.spyOn(native, 'readBlob')
      const payloadRead = vi
        .spyOn(nativeAppDatabase, 'readBlob')
        .mockImplementation(native.readBlob.bind(native))
      const decodeSummary = vi.fn(async (value: Record<string, unknown>) => {
        expect(value).not.toHaveProperty('original')
        expect(value).not.toHaveProperty('thumbnail')
        const content = value.payload as { data: Blob }
        return {
          id: value.id,
          contentHash: value.contentHash,
          ...JSON.parse(await content.data.text()),
        }
      })
      activateAndroidNativeAppDatabase()
      try {
        const vault = encrypted
          ? ({ decodeResourceSummary: decodeSummary } as unknown as VaultService)
          : undefined
        const storage = new IndexedDbResourceStorage(database, vault)
        const summary = await storage.getSummary('card')
        expect(summary?.metadata).toEqual(metadata)
        expect(summary?.type).toBe(RESOURCE_TYPE.CHARACTER_CARD)
        expect(summary).not.toHaveProperty('originalBlob')
        expect(summary?.thumbnailBlob).toBeUndefined()
        expect(await storage.getSummary('missing')).toBeUndefined()
        if (encrypted) {
          expect(payloadRead).toHaveBeenCalledOnce()
          expect(payloadRead.mock.calls[0]?.slice(0, 3)).toEqual([
            'resources',
            '"card"',
            '/payload/data',
          ])
          decodeSummary.mockRejectedValueOnce(new Error('保险库已锁定'))
          await expect(storage.getSummary('card')).rejects.toThrow('保险库已锁定')
        } else expect(reads).not.toHaveBeenCalled()
      } finally {
        deactivateAndroidNativeAppDatabase()
        payloadRead.mockRestore()
        reads.mockRestore()
        database.close()
        await new AppDatabase(name).delete()
      }
    },
  )

  it('preserves JSONL UTF-8 boundaries and fails a changed original between byte chunks', async () => {
    const name = `native-chat-utf8-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const database = new AppDatabase(name)
    const { native, blobs, blobKey } = createNativeStore()
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const rows = [
      { name: '角色', mes: '中🌧'.repeat(45000), is_user: false },
      { name: '用户', mes: '末楼', is_user: true },
    ]
    const originalBlob = new File(
      [
        '\uFEFF' +
          JSON.stringify({ chat_metadata: {} }) +
          '\r\n\r\n' +
          rows.map((row) => JSON.stringify(row)).join('\r\n'),
      ],
      'chat.jsonl',
      { type: 'application/x-ndjson' },
    )
    const resource: Resource = {
      id: 'chat',
      type: RESOURCE_TYPE.CHAT,
      name: 'chat',
      description: '',
      fileName: 'chat.jsonl',
      mimeType: originalBlob.type,
      fileSize: originalBlob.size,
      contentHash: 'chat',
      categoryId: null,
      favorite: false,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
      originalBlob,
      metadata: { format: 'jsonl', messageCount: 2, visibleMessageCount: 2 },
    }
    await database.resources.put(resource)
    const fullRead = vi.spyOn(native, 'readBlob')
    let changeAtSecondChunk = false
    const range = vi
      .spyOn(nativeAppDatabase, 'readBlobRange')
      .mockImplementation(async (store, key, path, offset, length, expected) => {
        if (changeAtSecondChunk && offset > 0) throw new Error('附件已变化')
        const blob = blobs.get(blobKey(store, key, path))!
        expect(await hashBlob(blob)).toBe(expected.sha256)
        return blob.slice(offset, offset + length).arrayBuffer()
      })
    activateAndroidNativeAppDatabase()
    try {
      const storage = new IndexedDbResourceStorage(database)
      const reader = new ChatReaderService({
        getReadSource: storage.getReadSource.bind(storage),
      } as unknown as ResourceService)
      const page = await reader.read('chat', 0, 2)
      expect(page.messages.map((entry) => entry.message)).toEqual(rows)
      expect(range.mock.calls.map((call) => call[3])).toEqual([0, 0, 256 * 1024])
      expect(fullRead).not.toHaveBeenCalled()
      const source = await storage.getReadSource('chat')
      expect(await source!.originalSource.text()).toBe(await originalBlob.text())
      changeAtSecondChunk = true
      // A different service has no cached floors; it must propagate a mid-read identity failure.
      const freshReader = new ChatReaderService({
        getReadSource: storage.getReadSource.bind(storage),
      } as unknown as ResourceService)
      await expect(freshReader.read('chat', 0, 2)).rejects.toThrow('已变化')
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      deactivateAndroidNativeAppDatabase()
      range.mockRestore()
      database.close()
      await new AppDatabase(name).delete()
    }
  })

  it('reads a small chat page without hydrating a declared 1 GiB original and guards cache identity', async () => {
    const name = `native-chat-range-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const database = new AppDatabase(name)
    const { native, stores } = createNativeStore()
    const descriptor = {
      __srlAppDatabaseValueV1: 'file',
      fieldPath: '/originalBlob',
      size: 1024 ** 3,
      mimeType: 'application/x-ndjson',
      sha256: 'a'.repeat(64),
    }
    const row = {
      id: 'chat',
      type: RESOURCE_TYPE.CHAT,
      name: 'chat',
      description: '',
      fileName: 'chat.jsonl',
      mimeType: descriptor.mimeType,
      fileSize: descriptor.size,
      contentHash: 'resource-identity',
      categoryId: null,
      tags: [],
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      originalBlob: descriptor,
      metadata: { format: 'jsonl', messageCount: 10000, visibleMessageCount: 10000 },
    }
    stores.get('resources')!.set('"chat"', row)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const fullRead = vi.spyOn(native, 'readBlob')
    let content = '旧楼'
    const range = vi
      .spyOn(nativeAppDatabase, 'readBlobRange')
      .mockImplementation(async (_store, _key, _path, offset, length, expected) => {
        if (expected.sha256 !== descriptor.sha256) throw new Error('附件已变化')
        const line = JSON.stringify({ name: '角色', mes: content, is_user: false }) + '\n'
        const bytes = new TextEncoder().encode(line.repeat(6000))
        return bytes.slice(offset, offset + length).buffer
      })
    activateAndroidNativeAppDatabase()
    try {
      const storage = new IndexedDbResourceStorage(database)
      const resources = {
        getReadSource: storage.getReadSource.bind(storage),
      } as unknown as ResourceService
      const reader = new ChatReaderService(resources)
      const page = await reader.read('chat', 0, 2)
      expect(page.messages.map((entry) => entry.message.mes)).toEqual(['旧楼', '旧楼'])
      expect(range.mock.calls.map((call) => call[4])).toEqual([1, 256 * 1024])
      range.mockClear()
      await reader.read('chat', 0, 2)
      expect(range.mock.calls.map((call) => call[4])).toEqual([1])
      // Resource contentHash can include other identities. The actual attachment SHA must evict floors.
      descriptor.sha256 = 'b'.repeat(64)
      content = '新楼'
      expect((await reader.read('chat', 0, 1)).messages[0]!.message.mes).toBe('新楼')
      expect(fullRead).not.toHaveBeenCalled()
      const source = await storage.getReadSource('chat')
      expect(source).not.toHaveProperty('originalBlob')
      expect(source?.originalSource).not.toBeInstanceOf(Blob)
      // Each byte read respects overlapping writers, without holding a whole reading session open.
      let release!: () => void, started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const writer = database.transaction('rw', database.resources, async () => {
        await database.resources.get('missing')
        started()
        await Dexie.waitFor(held)
      })
      await ready
      range.mockClear()
      const reading = Dexie.ignoreTransaction(() =>
        source!.originalSource.slice(0, 32).arrayBuffer(),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(range).not.toHaveBeenCalled()
      release()
      await writer
      expect((await reading).byteLength).toBe(32)
      stores.get('resources')!.delete('"chat"')
      await expect(reader.read('chat', 0, 1)).rejects.toThrow('不存在')
    } finally {
      deactivateAndroidNativeAppDatabase()
      range.mockRestore()
      database.close()
      await new AppDatabase(name).delete()
    }
  })

  it.each([1000, 10000])(
    'checks a healthy %i-item list index without transferring resource primary keys or attachments',
    async (size) => {
      const name = `native-list-check-${crypto.randomUUID()}`
      const seed = new AppDatabase(name)
      await seed.open()
      seed.close()
      const database = new AppDatabase(name)
      const { native, stores } = createNativeStore()
      for (let index = 0; index < size; index++) {
        const id = `card-${index}`
        const row = {
          id,
          type: RESOURCE_TYPE.CHARACTER_CARD,
          name: id,
          description: '',
          fileName: `${id}.png`,
          mimeType: 'image/png',
          fileSize: 1,
          contentHash: 'a'.repeat(64),
          favorite: false,
          categoryId: null,
          tags: [],
          metadata: {},
          createdAt: index,
          updatedAt: index,
        }
        stores.get('resources')!.set(JSON.stringify(id), row)
        stores.get('resourceListSummaries')!.set(JSON.stringify(id), row)
      }
      stores.get('settings')!.set(JSON.stringify('index.resourceListSummaries.v20'), {
        id: 'index.resourceListSummaries.v20',
        value: true,
        updatedAt: 1,
      })
      database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
      const compare = vi
        .spyOn(nativeAppDatabase, 'haveSameRecordKeys')
        .mockImplementation(async (left, right) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          const a = stores.get(left)!,
            b = stores.get(right)!
          return a.size === b.size && [...a.keys()].every((key) => b.has(key))
        })
      const keys = vi.spyOn(native, 'getRecordKeys')
      const binary = vi.spyOn(native, 'readBlob')
      const record = vi.spyOn(native, 'getRecord')
      activateAndroidNativeAppDatabase()
      try {
        const storage = new IndexedDbResourceStorage(database)
        for (let entry = 0; entry < 2; entry++) {
          const result = await storage.listResourceListSummaries()
          expect(result).toHaveLength(size)
          expect(result[0]?.id).toBe(`card-${size - 1}`)
        }
        expect(compare).toHaveBeenCalledTimes(2)
        expect(keys.mock.calls.every(([store]) => store === 'resourceListSummaries')).toBe(true)
        expect(record.mock.calls.some(([store]) => store === 'resources')).toBe(false)
        expect(binary).not.toHaveBeenCalled()
        if (size === 1000) {
          let release!: () => void
          let started!: () => void
          const ready = new Promise<void>((resolve) => {
            started = resolve
          })
          const blocked = new Promise<void>((resolve) => {
            release = resolve
          })
          const writer = database.transaction('rw', database.resources, async () => {
            await database.resources.get('card-0')
            started()
            await Dexie.waitFor(blocked)
          })
          await ready
          const reading = Dexie.ignoreTransaction(() => storage.listResourceListSummaries())
          await new Promise((resolve) => setTimeout(resolve, 10))
          expect(compare).toHaveBeenCalledTimes(2)
          release()
          await writer
          await expect(reading).resolves.toHaveLength(size)
          expect(compare).toHaveBeenCalledTimes(3)
        }
        compare.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
        await expect(storage.listResourceListSummaries()).resolves.toHaveLength(size)
        expect(keys.mock.calls.some(([store]) => store === 'resources')).toBe(true)
        compare.mockRejectedValueOnce(new Error('SQLite read failed'))
        await expect(storage.listResourceListSummaries()).rejects.toThrow('SQLite read failed')
      } finally {
        deactivateAndroidNativeAppDatabase()
        compare.mockRestore()
        database.close()
        await database.delete()
      }
    },
  )
  it.each([1000, 5000])(
    'preserves cabinet thumbnail references after migration and reads only four visible assets in a %i-item library on every entry',
    async (size) => {
      const database = new AppDatabase(`native-cabinet-thumbnails-${size}-${crypto.randomUUID()}`)
      const { native } = createNativeStore()
      let enabled = false
      database.use(createAndroidNativeDexieCore({ enabled: () => enabled, native }))
      const assets = new IndexedDbAssetStore(database)
      try {
        await database.open()
        const thumbnails = Array.from({ length: 4 }, (_, index) => {
          const bytes = new Uint8Array(32 * 1024).fill(index + 1)
          return new Blob([bytes], { type: 'image/webp' })
        })
        const ids: string[] = []
        for (const blob of thumbnails)
          ids.push((await assets.put(blob, { source: 'thumbnail' })).assetId)
        const summaries: ResourceSummary[] = Array.from({ length: size }, (_, index) => ({
          id: `card-${index}`,
          type: RESOURCE_TYPE.CHARACTER_CARD,
          name: `角色${index}`,
          description: '',
          fileName: `card-${index}.png`,
          mimeType: 'image/png',
          fileSize: 1024,
          contentHash: index.toString(16).padStart(64, '0'),
          favorite: false,
          categoryId: null,
          categoryIds: [],
          tags: [],
          metadata: {},
          thumbnailAssetId: ids[index % ids.length],
          createdAt: 1,
          updatedAt: 1,
        }))
        await database.resourceListSummaries.bulkPut(summaries)
        await new AndroidAppDatabaseMigrator({
          database,
          native,
          isQuiesced: () => true,
        }).migrateAllStores()
        enabled = true
        const scan = vi.spyOn(native, 'getRecords')
        const keys = vi.spyOn(native, 'getRecordKeys')
        const indexed = vi.spyOn(native, 'getIndexEntries')
        const bulk = vi.spyOn(native, 'getRecordsByKeys')
        const record = vi.spyOn(native, 'getRecord')
        const binary = vi.spyOn(native, 'readBlob')
        const visible = await database.resourceListSummaries.bulkGet([
          'card-0',
          'card-1',
          'card-2',
          'card-3',
        ])
        const visibleAssetIds = visible.map((row) => {
          if (!row || !('thumbnailAssetId' in row) || typeof row.thumbnailAssetId !== 'string')
            throw new Error('Expected an unencrypted thumbnail reference in this fixture')
          return row.thumbnailAssetId
        })
        expect(visibleAssetIds).toEqual(ids)
        expect(binary).not.toHaveBeenCalled()
        expect(bulk).toHaveBeenCalledTimes(1)
        for (let entry = 0; entry < 3; entry++) {
          if (entry === 2) {
            database.close()
            await database.open()
          }
          record.mockClear()
          binary.mockClear()
          bulk.mockClear()
          const loaded = await Promise.all(visibleAssetIds.map((id) => assets.getBlob(id)))
          expect(loaded).toHaveLength(4)
          for (let index = 0; index < loaded.length; index++) {
            expect(loaded[index]?.type).toBe('image/webp')
            expect(await hashBlob(loaded[index]!)).toBe(await hashBlob(thumbnails[index]!))
          }
          expect(binary).toHaveBeenCalledTimes(4)
          expect(binary.mock.calls.every(([store]) => store === 'assetFiles')).toBe(true)
          expect(record).toHaveBeenCalledTimes(8)
          expect(bulk).not.toHaveBeenCalled()
        }
        expect(scan).not.toHaveBeenCalled()
        expect(keys).not.toHaveBeenCalled()
        expect(indexed).not.toHaveBeenCalled()
      } finally {
        database.close()
        await database.delete()
        vi.restoreAllMocks()
      }
    },
    30000,
  )

  it('omits invalid secondary index values in pending writes like IndexedDB', async () => {
    const database = new AppDatabase(`native-core-invalid-index-${crypto.randomUUID()}`)
    const { native } = createNativeStore()
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await database.transaction('rw', database.settings, async () => {
        await database.settings.put({ id: 'invalid', value: 'kept', updatedAt: null } as never)
        await database.settings.put({ id: 'valid', value: 'kept', updatedAt: 1 })
        expect(await database.settings.orderBy('updatedAt').primaryKeys()).toEqual(['valid'])
        expect(await database.settings.get('invalid')).toBeDefined()
      })
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('rejects a foreground commit when the background changes its read data', async () => {
    const database = new AppDatabase(`native-core-background-conflict-${crypto.randomUUID()}`)
    const { native } = createNativeStore()
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await database.settings.put({ id: 'editing', value: 'before', updatedAt: 1 })
      await expect(
        database.transaction('rw', database.settings, async () => {
          const old = await database.settings.get('editing')
          await Dexie.waitFor(
            native.putRecords('settings', [
              {
                key: '"editing"',
                value: { id: 'editing', value: 'background update', updatedAt: 2 },
              },
            ]),
          )
          await database.settings.put({ ...old!, value: 'stale foreground edit' })
        }),
      ).rejects.toThrow('data changed during transaction')
      expect((await database.settings.get('editing'))!.value).toBe('background update')
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('serializes writers across connections and releases the reservation after abort', async () => {
    const name = `native-core-two-connections-${crypto.randomUUID()}`
    const { native } = createNativeStore()
    const first = new AppDatabase(name),
      second = new AppDatabase(name)
    first.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    second.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await first.settings.put({ id: 'counter', value: 0, updatedAt: 1 })
      const increment = (database: AppDatabase) =>
        database.transaction('rw', database.settings, async () => {
          const current = await database.settings.get('counter')
          await database.settings.put({ ...current!, value: Number(current!.value) + 1 })
        })
      const aborted = first.transaction('rw', first.settings, async () => {
        await first.settings.put({ id: 'counter', value: 99, updatedAt: 2 })
        throw new Error('abort this edit')
      })
      const queued = increment(second)
      await expect(aborted).rejects.toThrow('abort this edit')
      await queued
      await Promise.all([increment(first), increment(second)])
      expect((await first.settings.get('counter'))!.value).toBe(3)
    } finally {
      first.close()
      second.close()
      await first.delete()
    }
  })
  it('round-trips every AppDatabase table through migration, native writes and reopening without changing IndexedDB', async () => {
    const name = `native-all-tables-${crypto.randomUUID()}`
    const { native, stores } = createNativeStore()
    let enabled = false
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => enabled, native }))
    const writes = vi.spyOn(native, 'putRecordsWithState')
    try {
      await database.open()
      const tableNames = database.tables.map((table) => table.name)
      expect(
        new Set(
          APP_DATABASE_STORES.filter(
            (store) => !['cloudBackupJobs', 'cloudBackupOrphans'].includes(store),
          ),
        ),
      ).toEqual(new Set(tableNames))
      for (const table of database.tables) {
        const row = {
          id: `${table.name}-a`,
          assetId: `${table.name}-a`,
          projectId: `${table.name}-a`,
          jobId: 'job',
          path: '附件/中文.txt',
          chunkIndex: 0,
          type: 'characterCard',
          name: '完整数据',
          appId: 'app-a',
          sourceId: 'source-a',
          resourceId: 'card-a',
          sourceKeyHash: 'key-a',
          messageKeyHash: 'message-a',
          kind: 'thread',
          updatedAt: 2,
          createdAt: 1,
          categoryIds: ['one', 'two'],
          tags: ['中文', 'tag'],
          payload: {
            text: '内容',
            blob: new Blob(['完整附件'], { type: 'text/plain' }),
            bytes: new Uint16Array([12, 65000]),
            date: new Date(10),
            map: new Map([['key', '值']]),
            set: new Set(['a', 'b']),
            missing: undefined,
            regex: /中文/gi,
          },
          ...(table.name === 'externalAppRuntimes' ? { runtimeHtml: '模板'.repeat(140000) } : {}),
        }
        await table.put(row)
      }
      const baseline = new Map<string, { key: string | string[]; value: Record<string, unknown> }>()
      for (const table of database.tables)
        baseline.set(table.name, {
          key: (await table.toCollection().primaryKeys())[0]!,
          value: (await table.toArray())[0],
        })
      const result = await new AndroidAppDatabaseMigrator({
        database,
        native,
        isQuiesced: () => true,
      }).migrateAllStores()
      expect(result.stores).toHaveLength(tableNames.length)
      for (const [store, rows] of writes.mock.calls)
        for (const row of rows)
          expect(row.indexes).toEqual(
            encodeAppDatabaseIndexes(
              baseline.get(store)!.value,
              database.table(store).schema.indexes,
            ),
          )
      enabled = true
      for (const [store, { key, value }] of baseline) {
        const table = database.table(store)
        const actual = await table.get(key)
        expect(actual, store).toEqual(value)
        expect(await actual.payload.blob.text()).toBe('完整附件')
        expect(await table.count()).toBe(1)
        for (const index of encodeAppDatabaseIndexes(value, table.schema.indexes))
          for (const encoded of index.keys)
            expect(
              await table.where(index.name).equals(JSON.parse(encoded)).primaryKeys(),
              `${store}/${index.name}`,
            ).toEqual([key])
        await table.put({ ...actual, name: '原生修改', updatedAt: 3 })
        expect((await table.get(key)).name).toBe('原生修改')
        expect(stores.get(store)!.has(encodeAppDatabaseKey(key))).toBe(true)
      }
      database.close()
      await database.open()
      for (const [store, { key }] of baseline)
        expect((await database.table(store).get(key)).name).toBe('原生修改')
      const retained = new Dexie(name)
      try {
        await retained.open()
        for (const [store, { key }] of baseline)
          expect((await retained.table(store).get(key)).name).toBe('完整数据')
      } finally {
        retained.close()
      }
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('serializes overlapping read-modify-write transactions like IndexedDB', async () => {
    const database = new AppDatabase(`native-core-concurrent-${crypto.randomUUID()}`)
    const { native } = createNativeStore()
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await database.settings.put({ id: 'counter', value: 0, updatedAt: 1 })
      const increment = () =>
        database.transaction('rw', database.settings, async () => {
          const current = await database.settings.get('counter')
          await database.settings.put({
            id: 'counter',
            value: Number(current!.value) + 1,
            updatedAt: 2,
          })
        })
      await Promise.all([increment(), increment()])
      expect((await database.settings.get('counter'))!.value).toBe(2)
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('enumerates 3000 keys and counts without reading resource bodies or blobs, then batches summaries', async () => {
    const name = `native-core-bounded-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    for (let i = 0; i < 3000; i++) {
      const id = `card-${i.toString().padStart(4, '0')}`
      stores.get('resources')!.set(JSON.stringify(id), {
        id,
        type: 'characterCard',
        originalBlob: { __srlAppDatabaseValueV1: 'blob', size: 1024 * 1024 },
      })
      stores.get('resourceListSummaries')!.set(JSON.stringify(id), { id, name: id })
    }
    const eager = vi.spyOn(native, 'getRecords')
    const single = vi.spyOn(native, 'getRecord')
    const blobs = vi.spyOn(native, 'readBlob')
    const batches = vi.spyOn(native, 'getRecordsByKeys')
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const keys = await database.resources.toCollection().primaryKeys()
    expect(keys).toHaveLength(3000)
    expect(await database.resources.count()).toBe(3000)
    expect(await database.resourceListSummaries.bulkGet(keys.slice(0, 250))).toHaveLength(250)
    expect(batches).toHaveBeenCalledTimes(1)
    expect(eager).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
    expect(blobs).not.toHaveBeenCalled()
    database.close()
    await database.delete()
  })

  it('clears the old IndexedDB connection while the application keeps reading the active native library', async () => {
    const name = `native-core-cleanup-live-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.resources.put({ id: 'old-copy', type: 'characterCard' } as never)
    const plan = await getRetainedIndexedDbCopy(name)
    const { digest } = await fingerprintAppDatabaseStore(seed, 'resources')
    seed.close()
    const { native, stores } = createNativeStore()
    stores.get('resources')!.set('"native-new"', { id: 'native-new', type: 'characterCard' })
    const active = JSON.stringify({ version: 1, databaseVersion: 25, activatedAt: 1 })
    native.getState = async (key) =>
      key === 'migration:appdb:v1:active'
        ? active
        : key === 'migration:appdb:indexes:v1:active'
          ? 'verified-v1'
          : JSON.stringify({
              version: 1,
              status: 'verified',
              sourceCount: plan.counts[key.replace('migration:appdb:v1:', '')] ?? 0,
              copiedCount: plan.counts[key.replace('migration:appdb:v1:', '')] ?? 0,
              sourceDigest: key === 'migration:appdb:v1:resources' ? digest : undefined,
            })
    native.verifyStore = async () => ({ records: 1, files: 0, bytes: 0 })
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    expect(await database.resources.toCollection().primaryKeys()).toEqual(['native-new'])
    await clearRetainedIndexedDbCopy(name, plan, undefined, native)
    expect((await getRetainedIndexedDbCopy(name)).records).toBe(0)
    expect(await database.resources.toCollection().primaryKeys()).toEqual(['native-new'])
    database.close()
    await database.open()
    expect(await database.resources.get('native-new')).toBeDefined()
    database.close()
    await database.delete()
  })

  it('keeps IndexedDB key ordering, cursor seeks and range deletion using only keys', async () => {
    const name = `native-core-key-order-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    const keys = [2, 10, -1, 'a', 'a"', 'a\\', '中', ['a', 2], ['a', 10]]
    for (const key of keys)
      stores.get('settings')!.set(JSON.stringify(key), { id: key, value: true })
    const eager = vi.spyOn(native, 'getRecords')
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    expect(await database.settings.toCollection().primaryKeys()).toEqual([
      -1,
      2,
      10,
      'a',
      'a"',
      'a\\',
      '中',
      ['a', 2],
      ['a', 10],
    ])
    expect(await database.settings.where('id').anyOf([2, 10]).primaryKeys()).toEqual([2, 10])
    expect(
      await database.settings.where('id').between(2, 10, true, true).reverse().primaryKeys(),
    ).toEqual([10, 2])
    await database.settings.where('id').between(2, 10, true, false).delete()
    expect(await database.settings.get(2 as never)).toBeUndefined()
    expect(await database.settings.get(10 as never)).toBeDefined()
    expect(eager).not.toHaveBeenCalled()
    database.close()
    await database.delete()
  })

  it('preserves clear/read-your-writes and abort without scanning payloads', async () => {
    const name = `native-core-clear-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    stores.get('settings')!.set('"old"', { id: 'old', value: true })
    const eager = vi.spyOn(native, 'getRecords')
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    await expect(
      database.transaction('rw', database.settings, async () => {
        await database.settings.clear()
        expect(await database.settings.count()).toBe(0)
        expect(await database.settings.get('old')).toBeUndefined()
        await database.settings.put({ id: 'new', value: 1 } as never)
        expect(await database.settings.toCollection().primaryKeys()).toEqual(['new'])
        throw new Error('abort test')
      }),
    ).rejects.toThrow('abort test')
    expect(stores.get('settings')!.has('"old"')).toBe(true)
    await database.transaction('rw', database.settings, async () => {
      await database.settings.clear()
      await database.settings.put({ id: 'new', value: 2 } as never)
    })
    expect([...stores.get('settings')!.keys()]).toEqual(['"new"'])
    expect(eager).not.toHaveBeenCalled()
    database.close()
    await database.delete()
  })

  it('does not rerun resource liveQuery after an unrelated settings write', async () => {
    const name = `native-core-observe-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const query = vi.fn(() => database.resources.count())
    const values: number[] = []
    const errors: unknown[] = []
    const sub = liveQuery(query).subscribe({
      next: (value) => values.push(value),
      error: (error) => errors.push(error),
    })
    await vi.waitFor(() => expect(values).toEqual([0]))
    await database.settings.put({ id: 'unrelated', value: true } as never)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(query).toHaveBeenCalledTimes(1)
    await database.resources.put({ id: 'resource', type: 'characterCard' } as never)
    await vi.waitFor(() => expect(values.at(-1)).toBe(1))
    expect(errors).toEqual([])
    sub.unsubscribe()
    database.close()
    await database.delete()
  })

  it('keeps native transactions alive while Dexie.waitFor bridges asynchronous work', async () => {
    const name = `native-core-wait-for-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    await database.transaction('rw', database.settings, async () => {
      await Dexie.waitFor(new Promise((resolve) => setTimeout(resolve, 100)))
      await database.settings.put({ id: 'waited', value: true } as never)
    })

    expect(stores.get('settings')?.get('"waited"')).toMatchObject({ value: true })
    database.close()
    await database.delete()
  })

  it('waits for every concurrent native request before auto-completing a transaction', async () => {
    const name = `native-core-parallel-requests-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    const getRecordKeys = native.getRecordKeys.bind(native)
    native.getRecordKeys = async (store, afterKey, limit) => {
      if (store === 'categories') await new Promise((resolve) => setTimeout(resolve, 30))
      return getRecordKeys(store, afterKey, limit)
    }
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    await database.transaction('rw', database.settings, database.categories, async () => {
      await Promise.all([database.settings.toArray(), database.categories.toArray()])
      await database.settings.put({ id: 'parallel-read', value: true } as never)
    })

    expect(stores.get('settings')?.get('"parallel-read"')).toMatchObject({ value: true })
    database.close()
    await database.delete()
  })

  it('runs explicit compaction between overlapping transactions and releases its reservation', async () => {
    const name = `native-core-compaction-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native } = createNativeStore()
    let start!: () => void, release!: () => void, compactRelease!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const compactPaused = new Promise<void>((resolve) => {
      compactRelease = resolve
    })
    const compact = vi.fn(async () => {
      await compactPaused
      return { beforeBytes: 100, afterBytes: 50 }
    })
    const port = Object.assign(native, { compact })
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native: port }))
    activateAndroidNativeAppDatabase()
    try {
      const applyBatch = port.applyBatch.bind(port)
      port.applyBatch = async (...args) => {
        start()
        await paused
        return applyBatch(...args)
      }
      const writing = database.settings.put({ id: 'setting', value: 'retained', updatedAt: 1 })
      await started
      const compacting = compactAndroidNativeAppDatabase(port)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(compact).not.toHaveBeenCalled()
      release()
      await writing
      let finished = false
      const reading = database.settings.get('setting').then((value) => {
        finished = true
        return value
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(compact).toHaveBeenCalledOnce()
      expect(finished).toBe(false)
      compactRelease()
      expect(await compacting).toEqual({ beforeBytes: 100, afterBytes: 50 })
      expect(await reading).toMatchObject({ value: 'retained' })
    } finally {
      release()
      compactRelease()
      deactivateAndroidNativeAppDatabase()
      database.close()
      await database.delete()
    }
  })
  it('repairs the resource summary index while asynchronous vault work uses the native transaction', async () => {
    const name = `native-core-summary-repair-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    stores.get('resources')!.set('"card-a"', {
      id: 'card-a',
      type: 'characterCard',
      name: 'Card A',
      description: '',
      fileName: 'card-a.png',
      mimeType: 'image/png',
      fileSize: 1,
      contentHash: 'a'.repeat(64),
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      originalBlob: new Blob(['x'], { type: 'image/png' }),
      createdAt: 1,
      updatedAt: 1,
    })
    const asyncVault = {
      isEnabled: () => true,
      decodeResourceSummary: async (summary: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return summary
      },
      encodeResourceSummary: async (summary: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return summary
      },
    } as unknown as VaultService
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const storage = new IndexedDbResourceStorage(database, asyncVault)

    await expect(storage.listResourceListSummaries()).resolves.toMatchObject([
      { id: 'card-a', name: 'Card A' },
    ])

    expect(stores.get('resourceListSummaries')?.has('"card-a"')).toBe(true)
    database.close()
    await database.delete()
  })

  it('uses native reads, secondary-index queries, and cursor iteration', async () => {
    const name = `native-core-read-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()

    const { stores, native } = createNativeStore()
    stores.get('resources')!.set('"a"', { id: 'a', type: 'character', name: 'A' })
    stores.get('resources')!.set('"b"', { id: 'b', type: 'chat', name: 'B' })
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    const resource = await database.resources.get('a')
    expect(resource && 'name' in resource ? resource.name : undefined).toBe('A')
    expect(
      (await database.resources.where('type').equals('character').toArray()).map((row) => row.id),
    ).toEqual(['a'])
    const visited: string[] = []
    await database.resources.orderBy('id').each((row) => visited.push(row.id))
    expect(visited).toEqual(['a', 'b'])

    const modified = await database.resources
      .where('type')
      .equals('character')
      .modify({
        favorite: true,
      } as never)
    expect(modified).toBe(1)
    expect(await database.resources.get('a')).toMatchObject({ favorite: true })
    await database.resources.delete('b')
    expect(await database.resources.get('b')).toBeUndefined()

    database.close()
    await database.delete()
  })

  it('notifies Dexie live queries with valid mutation ranges after native writes', async () => {
    const name = `native-core-live-query-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    let latest: number | undefined
    let queryError: unknown
    const subscription = liveQuery(
      async () => (await database.resources.where('type').equals('character').toArray()).length,
    ).subscribe({
      next(value) {
        latest = value
      },
      error(error) {
        queryError = error
      },
    })

    await vi.waitFor(() => expect(latest).toBe(0))
    await database.transaction('rw', 'resources', () => database.resources.get('absent'))
    expect(queryError).toBeUndefined()
    await database.resources.put({ id: 'live', type: 'character' } as never)
    await vi.waitFor(() => expect(latest).toBe(1))
    expect(queryError).toBeUndefined()
    await database.resources.delete('live')
    await vi.waitFor(() => expect(latest).toBe(0))
    expect(queryError).toBeUndefined()

    subscription.unsubscribe()
    database.close()
    await database.delete()
  })

  it('does not hydrate unrelated attachments while scanning a native secondary index', async () => {
    const name = `native-core-lazy-blob-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, blobs, native, blobKey } = createNativeStore()
    const fieldPath = '$/originalBlob'
    const attachment = new Blob(['large attachment'], { type: 'image/png' })
    stores.get('resources')!.set('"match"', {
      id: 'match',
      type: 'character',
      name: 'matching row',
      originalBlob: {
        __srlAppDatabaseValueV1: 'blob',
        fieldPath,
        size: attachment.size,
        mimeType: attachment.type,
        sha256: `${attachment.size}`.padStart(64, '0'),
      },
    })
    stores.get('resources')!.set('"other"', {
      id: 'other',
      type: 'chat',
      name: 'unmatched row',
      originalBlob: {
        __srlAppDatabaseValueV1: 'blob',
        fieldPath,
        size: attachment.size,
        mimeType: attachment.type,
        sha256: `${attachment.size}`.padStart(64, '0'),
      },
    })
    blobs.set(blobKey('resources', '"match"', fieldPath), attachment)
    blobs.set(blobKey('resources', '"other"', fieldPath), attachment)
    const readBlob = vi.spyOn(native, 'readBlob')
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    expect(await database.resources.where('type').equals('character').count()).toBe(1)
    expect(readBlob).not.toHaveBeenCalled()
    const matching = await database.resources.where('type').equals('character').toArray()
    expect(matching).toHaveLength(1)
    expect(readBlob).toHaveBeenCalledTimes(1)

    database.close()
    await database.delete()
  })

  it('commits cross-store mutations atomically and leaves native rows unchanged on abort', async () => {
    const name = `native-core-transaction-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, native } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    await expect(
      database.transaction('rw', database.resources, database.resourceSummaries, async () => {
        await database.resources.put({
          id: 'discarded',
          type: 'character',
          name: 'discarded',
        } as never)
        await database.resourceSummaries.put({ id: 'discarded', type: 'character' } as never)
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')
    expect(stores.get('resources')!.size).toBe(0)
    expect(stores.get('resourceSummaries')!.size).toBe(0)

    await database.transaction('rw', database.resources, database.resourceSummaries, async () => {
      await database.resources.put({ id: 'saved', type: 'character', name: 'saved' } as never)
      await database.resourceSummaries.put({ id: 'saved', type: 'character' } as never)
    })
    expect(await database.resources.get('saved')).toMatchObject({ id: 'saved', name: 'saved' })
    expect(await database.resourceSummaries.get('saved')).toMatchObject({ id: 'saved' })

    database.close()
    await database.delete()
  })

  it('preserves unique secondary-index constraints', async () => {
    const name = `native-core-unique-index-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))

    await database.communitySources.put({
      id: 'source-1',
      platform: 'discord',
      sourceKeyHash: 'same-hash',
      updatedAt: 1,
    } as never)
    await expect(
      database.communitySources.put({
        id: 'source-2',
        platform: 'discord',
        sourceKeyHash: 'same-hash',
        updatedAt: 2,
      } as never),
    ).rejects.toMatchObject({ name: 'ConstraintError' })
    expect(stores.get('communitySources')?.size).toBe(1)

    database.close()
    await database.delete()
  })

  it('commits restore-sized writes above the former 1,000-row limit atomically', async () => {
    const name = `native-core-large-batch-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { native, stores } = createNativeStore()
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      id: `resource-${index}`,
      type: 'characterCard',
      name: `卡片 ${index}`,
    }))

    await database.resources.bulkPut(rows as never[])

    expect(stores.get('resources')?.size).toBe(1_001)
    expect(await database.resources.count()).toBe(1_001)
    database.close()
    await database.delete()
  })

  it('keeps the downstream Dexie core when native storage is not activated', async () => {
    const transaction = vi.fn(() => ({ abort() {} }))
    const downstream = { stack: 'dbcore', schema: {}, table: vi.fn(), transaction }
    const middleware = createAndroidNativeDexieCore({ enabled: () => false })
    const wrapped = middleware.create(downstream as never)
    expect(wrapped.transaction(['resources'], 'readonly')).toEqual({ abort: expect.any(Function) })
    expect(transaction).toHaveBeenCalledOnce()
  })

  it('keeps old native attachments intact if a new record commit fails', async () => {
    const name = `native-core-blob-rollback-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, blobs, native, failNextNativeBatch, blobKey } = createNativeStore()
    const key = '"blob-card"'
    const oldBlob = new Blob(['old attachment'], { type: 'image/png' })
    const fieldPath = '$/originalBlob'
    stores.get('resources')!.set(key, {
      id: 'blob-card',
      originalBlob: {
        __srlAppDatabaseValueV1: 'blob',
        fieldPath,
        size: oldBlob.size,
        mimeType: oldBlob.type,
        sha256: `${oldBlob.size}`.padStart(64, '0'),
      },
    })
    blobs.set(blobKey('resources', key, fieldPath), oldBlob)
    expect(await native.readBlob('resources', key, fieldPath)).toBe(oldBlob)
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const existing = await database.resources.get('blob-card')
    expect(existing && 'originalBlob' in existing ? await existing.originalBlob.text() : '').toBe(
      'old attachment',
    )

    failNextNativeBatch()
    await expect(
      database.transaction('rw', database.resources, async () => {
        await database.resources.put({
          ...(existing as unknown as Record<string, unknown>),
          originalBlob: new Blob(['replacement'], { type: 'image/png' }),
        } as never)
      }),
    ).rejects.toThrow('forced native commit failure')

    const afterFailure = await database.resources.get('blob-card')
    expect(
      afterFailure && 'originalBlob' in afterFailure ? await afterFailure.originalBlob.text() : '',
    ).toBe('old attachment')
    expect(blobs.get(blobKey('resources', key, fieldPath))?.size).toBe(oldBlob.size)
    expect([...blobs.keys()].some((storedKey) => storedKey.includes('__srl_tx_'))).toBe(false)

    database.close()
    await database.delete()
  })

  it('round-trips every native app table in one transaction across bridge turns', async () => {
    const fixture = await delayedDatabase()
    const { database, stores } = fixture
    // Cloud jobs/orphans use their own database owner, not AppDatabase's Dexie facade.
    const names = APP_DATABASE_STORES.filter(
      (name) => !['cloudBackupJobs', 'cloudBackupOrphans'].includes(name),
    )
    try {
      await database.transaction('rw', names, async () => {
        for (const name of names) {
          const table = database.table(name)
          const paths = table.schema.primKey.keyPath
          const row = Object.fromEntries(
            (Array.isArray(paths) ? paths : [paths]).map((path) => [path!, `key-${name}-${path}`]),
          )
          for (const index of table.schema.indexes.filter((index) => index.unique)) {
            for (const path of Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath]) {
              row[path!] = `unique-${name}-${path}`
            }
          }
          row.payload = `retain-${name}`
          const key = await table.put(row)
          expect(await table.get(key)).toEqual(row)
        }
      })
      for (const name of names) {
        expect(stores.get(name)!.size).toBe(1)
        expect(await database.table(name).toArray()).toMatchObject([{ payload: `retain-${name}` }])
      }
    } finally {
      await fixture.close()
    }
  })

  it('keeps nested metadata updates, history removal and waitFor rejection atomic', async () => {
    const fixture = await delayedDatabase()
    const { database } = fixture
    const storage = new IndexedDbResourceStorage(database)
    try {
      const a = await routeResource('a'),
        b = await routeResource('b')
      await storage.saveMany([a, b])
      await storage.saveVersion({ ...(await routeResource('old-a')), versionGroupId: a.id })
      await storage.updateMany([a.id, b.id], { favorite: true, metadata: { retained: true } })
      expect(await storage.listResourceListSummaries()).toHaveLength(2)
      expect(await storage.listVersionSummaries()).toHaveLength(1)
      await expect(
        database.transaction('rw', database.resources, async () => {
          await database.resources.update(a.id, (row) => {
            if (!('name' in row)) throw new Error('Expected a plain resource fixture')
            row.name = 'must roll back'
          })
          await Dexie.waitFor(
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error('external operation failed')), 10)
            }),
          )
        }),
      ).rejects.toThrow('external operation failed')
      expect((await storage.get(a.id))!.name).toBe(a.id)
      expect(await (await storage.get(a.id))!.originalBlob.text()).toBe(await a.originalBlob.text())
      await storage.deleteMany([a.id])
      expect(await storage.listVersionSummaries()).toEqual([])
      expect((await storage.listSummaries()).map((row) => row.id)).toEqual([b.id])
      expect(await (await storage.get(b.id))!.originalBlob.text()).toBe(await b.originalBlob.text())
    } finally {
      await fixture.close()
    }
  })

  it('backs up current/history metadata and restores staged originals through the real storage owners', async () => {
    const source = await delayedDatabase(),
      target = await delayedDatabase()
    const sourceStorage = new IndexedDbResourceStorage(source.database)
    const resourceService = new ResourceService(sourceStorage, new ResourceParserRegistry([]))
    const context = {
      resourceService,
      categoryService: new CategoryService(new IndexedDbCategoryStorage(source.database)),
    } as CloudBackupSnapshotOperationsContext
    try {
      const a = await routeResource('a'),
        b = await routeResource('b')
      const old = { ...(await routeResource('old-a')), versionGroupId: a.id }
      await sourceStorage.saveMany([a, b])
      await sourceStorage.saveVersion(old)
      const backup = await buildStructuredBackup(context, { version: 1 })
      expect(backup.snapshot.resources).toHaveLength(2)
      expect(backup.snapshot.versions).toHaveLength(1)
      expect(backup.snapshot.resources[0]!.metadata).toEqual(a.metadata)
      for (const update of backup.descriptorUpdates) {
        await resourceService.updateBackupDescriptor(
          update.id,
          update.descriptor,
          update.historical,
        )
      }
      const loadCurrent = vi.spyOn(resourceService, 'get')
      const loadVersion = vi.spyOn(resourceService, 'getVersion')
      const reused = await buildStructuredBackup(context, { version: 1 })
      expect(reused.localReadBytes).toBe(0)
      expect(loadCurrent).not.toHaveBeenCalled()
      expect(loadVersion).not.toHaveBeenCalled()
      const archive = new IndexedDbArchiveStorage(target.database)
      const existing = await routeResource('existing')
      await archive.restore([], [existing])
      const restored = await new RestoreService(archive).restoreStructured(
        backup.snapshot,
        async (object) =>
          new Blob(
            object.parts.map((part) => {
              const blob = backup.chunks.get(part.name)!
              return blob.slice(part.offset ?? 0, (part.offset ?? 0) + part.size)
            }),
          ),
        await new IndexedDbResourceStorage(target.database).listSummaries(),
        [],
        'fixture',
      )
      expect(restored).toMatchObject({ restoredResources: 2, restoredVersions: 1 })
      const targetStorage = new IndexedDbResourceStorage(target.database)
      for (const item of [a, b, existing]) {
        const row = (await targetStorage.get(item.id))!
        expect(await row.originalBlob.text()).toBe(await item.originalBlob.text())
        expect(row.metadata).toEqual(item.metadata)
      }
      const history = await targetStorage.listVersionSummaries()
      expect(history).toHaveLength(1)
      expect(history[0]!.versionGroupId).toBe(a.id)
      expect(await (await targetStorage.getVersion(history[0]!.id))!.originalBlob.text()).toBe(
        await old.originalBlob.text(),
      )
      expect(await target.database.restoreStaging.count()).toBe(0)
      // A snapshot containing only portable settings has no rows to commit.
      await archive.restore([], [], [])
      expect(await target.database.resources.count()).toBe(3)
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('preserves existing originals and permits retry after the final restore commit fails', async () => {
    const fixture = await delayedDatabase()
    const archive = new IndexedDbArchiveStorage(fixture.database)
    const storage = new IndexedDbResourceStorage(fixture.database)
    try {
      const existing = await routeResource('existing'),
        incoming = await routeResource('incoming')
      await archive.restore([], [existing])
      const applyBatch = fixture.native.applyBatch.bind(fixture.native)
      const apply = vi.spyOn(fixture.native, 'applyBatch').mockImplementation(async (...args) => {
        if (args[0].some((operation) => operation.store === 'resources'))
          throw new Error('final commit interrupted')
        return applyBatch(...args)
      })
      await expect(archive.restore([], [incoming])).rejects.toThrow('final commit interrupted')
      expect(await storage.get(incoming.id)).toBeUndefined()
      expect(await (await storage.get(existing.id))!.originalBlob.text()).toBe(
        await existing.originalBlob.text(),
      )
      expect(await fixture.database.restoreStaging.count()).toBe(0)
      apply.mockRestore()
      await archive.restore([], [incoming])
      expect(await (await storage.get(incoming.id))!.originalBlob.text()).toBe(
        await incoming.originalBlob.text(),
      )
      expect(await fixture.database.resources.count()).toBe(2)
    } finally {
      await fixture.close()
    }
  })

  it('keeps vault encryption and metadata updates working across native bridge turns', async () => {
    const fixture = await delayedDatabase()
    const vault = new VaultService(fixture.database)
    const binary = vi
      .spyOn(nativeAppDatabase, 'readBlob')
      .mockImplementation(fixture.native.readBlob)
    try {
      await vault.initialize()
      await vault.enable('synthetic-test-password')
      const storage = new IndexedDbResourceStorage(fixture.database, vault)
      const original = await routeResource('encrypted')
      await storage.save(original)
      activateAndroidNativeAppDatabase()
      const reads = vi.spyOn(fixture.native, 'readBlob')
      const writes = vi.spyOn(fixture.native, 'writeBlob')
      await storage.updateMetadata(original.id, { name: 'encrypted metadata update' })
      expect(reads.mock.calls.some(([, , path]) => path.startsWith('$/original'))).toBe(false)
      expect(writes.mock.calls.some(([, , path]) => path.startsWith('$/original'))).toBe(false)
      // Native summary validation remains scoped to this fixture's actual keys.
      const sameKeys = vi
        .spyOn(nativeAppDatabase, 'haveSameRecordKeys')
        .mockImplementation(
          async (a, b) => fixture.stores.get(a)!.size === fixture.stores.get(b)!.size,
        )
      expect((await storage.listResourceListSummaries())[0]!.name).toBe('encrypted metadata update')
      sameKeys.mockRestore()
      expect(await (await storage.get(original.id))!.originalBlob.text()).toBe(
        await original.originalBlob.text(),
      )
      expect(
        JSON.stringify(fixture.stores.get('resources')!.get(JSON.stringify(original.id))),
      ).not.toContain('preserve-encrypted')
    } finally {
      deactivateAndroidNativeAppDatabase()
      binary.mockRestore()
      await fixture.close()
    }
  })

  it.each(['r', 'rw'] as const)(
    'completes a %s transaction that has no database requests',
    async (mode) => {
      const name = `native-core-empty-${crypto.randomUUID()}`
      const seed = new AppDatabase(name)
      await seed.open()
      seed.close()
      const { native } = createNativeStore()
      const apply = vi.spyOn(native, 'applyBatch')
      const database = new AppDatabase(name)
      database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
      try {
        await expect(
          database.transaction(mode, database.resources, async () => 'empty'),
        ).resolves.toBe('empty')
        expect(apply).not.toHaveBeenCalled()
      } finally {
        database.close()
        await database.delete()
      }
    },
    1000,
  )

  it('keeps the cloud-backup summary transaction alive across native bridge turns', async () => {
    const name = `native-core-cloud-backup-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, native } = createNativeStore()
    for (let index = 0; index < 267; index++) {
      const id = `resource-${index}`
      const contentHash = index.toString(16).padStart(64, '0')
      stores.get('resources')!.set(JSON.stringify(id), {
        id,
        type: 'other',
        name: id,
        fileName: `${id}.bin`,
        mimeType: 'application/octet-stream',
        fileSize: 1024,
        contentHash,
        favorite: false,
        categoryId: null,
        tags: [],
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
        nativeOriginal: { version: 1, contentHash, size: 1024 },
      })
    }
    const getRecords = native.getRecords.bind(native)
    const read = vi.spyOn(native, 'getRecords').mockImplementation(async (...args) => {
      // Capacitor bridge calls complete in a later task, unlike an immediate Promise fixture.
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      return getRecords(...args)
    })
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    const storage = new IndexedDbResourceStorage(database)
    try {
      await expect(storage.listResourceListSummaries()).resolves.toHaveLength(267)
      expect(stores.get('resourceListSummaries')!.size).toBe(267)
      expect(stores.get('resources')!.size).toBe(267)
    } finally {
      read.mockRestore()
      database.close()
      await database.delete()
    }
  }, 15_000)

  it('does not publish staged writes if a later bridge read is followed by an abort', async () => {
    const name = `native-core-delayed-rollback-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, native } = createNativeStore()
    stores.get('resourceSummaries')!.set('"existing"', { id: 'existing', name: 'keep' })
    const getRecord = native.getRecord.bind(native)
    const read = vi.spyOn(native, 'getRecord').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      return getRecord(...args)
    })
    const apply = vi.spyOn(native, 'applyBatch')
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await expect(
        database.transaction('rw', database.resources, database.resourceSummaries, async () => {
          await database.resources.put({ id: 'uncommitted', name: 'discard' } as never)
          expect(await database.resourceSummaries.get('existing')).toMatchObject({ name: 'keep' })
          throw new Error('abort after bridge read')
        }),
      ).rejects.toThrow('abort after bridge read')
      expect(apply).not.toHaveBeenCalled()
      expect(stores.get('resources')!.size).toBe(0)
      expect(stores.get('resourceSummaries')!.get('"existing"')).toEqual({
        id: 'existing',
        name: 'keep',
      })
    } finally {
      read.mockRestore()
      database.close()
      await database.delete()
    }
  })

  it('holds parallel attachment reads and cursor decoding until their bridge calls finish', async () => {
    const name = `native-core-delayed-attachments-${crypto.randomUUID()}`
    const seed = new AppDatabase(name)
    await seed.open()
    seed.close()
    const { stores, blobs, native, blobKey } = createNativeStore()
    for (const id of ['a', 'b']) {
      const attachment = new Blob([`original-${id}`])
      const path = '$/originalBlob'
      stores.get('resources')!.set(JSON.stringify(id), {
        id,
        name: id,
        originalBlob: {
          __srlAppDatabaseValueV1: 'blob',
          fieldPath: path,
          size: attachment.size,
          mimeType: attachment.type,
          sha256: `${attachment.size}`.padStart(64, '0'),
        },
      })
      blobs.set(blobKey('resources', JSON.stringify(id), path), attachment)
    }
    const readBlob = native.readBlob.bind(native)
    const read = vi.spyOn(native, 'readBlob').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => setTimeout(resolve, args[1] === '"a"' ? 1 : 10))
      return readBlob(...args)
    })
    const database = new AppDatabase(name)
    database.use(createAndroidNativeDexieCore({ enabled: () => true, native }))
    try {
      await database.transaction('rw', database.resources, async () => {
        const resources = await database.resources.bulkGet(['a', 'b'])
        expect(resources.map((row) => row?.id)).toEqual(['a', 'b'])
        for (const row of resources) {
          const original = row && 'originalBlob' in row ? row.originalBlob : undefined
          expect(original).toBeInstanceOf(Blob)
        }
        await database.resources.update('b', (row) => {
          if (!('name' in row)) throw new Error('Expected a plain resource fixture')
          row.name = 'parallel read complete'
        })
      })
      const visited: string[] = []
      await database.transaction('rw', database.resources, async () => {
        await database.resources.orderBy('id').each((row) => visited.push(row.id))
        await database.resources.update('a', (row) => {
          if (!('name' in row)) throw new Error('Expected a plain resource fixture')
          row.name = 'cursor read complete'
        })
      })
      expect(visited).toEqual(['a', 'b'])
      expect(await database.resources.get('a')).toMatchObject({ name: 'cursor read complete' })
      expect(await database.resources.get('b')).toMatchObject({ name: 'parallel read complete' })
      expect(await native.readBlob('resources', '"a"', '$/originalBlob')).toBeInstanceOf(Blob)
      expect(await native.readBlob('resources', '"b"', '$/originalBlob')).toBeInstanceOf(Blob)
    } finally {
      read.mockRestore()
      database.close()
      await database.delete()
    }
  })
})

describe('recent card native read', () => {
  it('keeps encrypted history metadata on the payload-only vault decoder', async () => {
    const fixture = await delayedDatabase()
    const vault = new VaultService(fixture.database)
    const blobRead = vi
      .spyOn(nativeAppDatabase, 'readBlob')
      .mockImplementation(fixture.native.readBlob.bind(fixture.native))
    try {
      await vault.initialize()
      await vault.enable('synthetic-test-password')
      const storage = new IndexedDbResourceStorage(fixture.database, vault)
      const sample = await routeResource('encrypted-history')
      await storage.saveVersion({
        ...sample,
        versionGroupId: 'owner',
        metadata: { creator: 'private author' },
      })
      const read = vi.spyOn(fixture.native, 'readBlob')
      activateAndroidNativeAppDatabase()
      const rows = await storage.listVersionListSummaries()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.metadata.creator).toBe('private author')
      expect(rows[0]).not.toHaveProperty('originalBlob')
      expect(read.mock.calls.every((call) => !call[2].includes('originalBlob'))).toBe(true)
      expect(blobRead.mock.calls.every((call) => !call[2].includes('originalBlob'))).toBe(true)
    } finally {
      deactivateAndroidNativeAppDatabase()
      blobRead.mockRestore()
      await fixture.close()
    }
  })

  it('batches historical catalogue metadata without loading any original or thumbnail', async () => {
    const fixture = await delayedDatabase()
    const storage = new IndexedDbResourceStorage(fixture.database)
    const sample = await routeResource('version')
    for (let i = 0; i < 1001; i++)
      fixture.stores.get('resourceVersions')!.set(JSON.stringify(`v-${i}`), {
        ...sample,
        id: `v-${i}`,
        versionGroupId: 'owner',
        updatedAt: i,
        originalBlob: {
          __srlAppDatabaseValueV1: 'blob',
          fieldPath: '$/originalBlob',
          size: 1024 ** 3,
          sha256: 'a'.repeat(64),
          mimeType: 'application/json',
        },
        thumbnailBlob: {
          __srlAppDatabaseValueV1: 'blob',
          fieldPath: '$/thumbnailBlob',
          size: 100,
          sha256: 'b'.repeat(64),
          mimeType: 'image/png',
        },
      })
    const originals = vi.spyOn(fixture.native, 'readBlob')
    const batches = vi.spyOn(fixture.native, 'getRecordsByKeys')
    activateAndroidNativeAppDatabase()
    try {
      const rows = await storage.listVersionListSummaries()
      expect(rows).toHaveLength(1001)
      expect(rows[0]!.id).toBe('v-1000')
      expect(rows.at(-1)!.id).toBe('v-0')
      expect(rows.every((row) => !('originalBlob' in row) && !('thumbnailBlob' in row))).toBe(true)
      expect(originals).not.toHaveBeenCalled()
      expect(batches).toHaveBeenCalledTimes(13)
    } finally {
      deactivateAndroidNativeAppDatabase()
      await fixture.close()
    }
  })

  it('reopens sparse chat positions through ResourceService, mirror and the native settings adapter', async () => {
    const fixture = await delayedDatabase()
    const vault = new VaultService(fixture.database)
    const storage = new NativeMirroredResourceStorage(
      new IndexedDbResourceStorage(fixture.database),
      vault,
    )
    const sample = await routeResource('chat')
    const rows = Array.from({ length: 700 }, (_, floor) => ({
      name: '角色',
      mes: `第${floor}楼` + '中🌧'.repeat(80),
      is_user: floor % 3 === 1,
    }))
    const originalBlob = new File([rows.map((row) => JSON.stringify(row)).join('\n')], 'chat.jsonl')
    await storage.save({
      ...sample,
      type: RESOURCE_TYPE.CHAT,
      originalBlob,
      fileSize: originalBlob.size,
      metadata: { format: 'jsonl', messageCount: rows.length, visibleMessageCount: rows.length },
    })
    const range = vi
      .spyOn(nativeAppDatabase, 'readBlobRange')
      .mockImplementation(async (store, key, path, offset, length) =>
        fixture.blobs
          .get(fixture.blobKey(store, key, path))!
          .slice(offset, offset + length)
          .arrayBuffer(),
      )
    const full = vi.spyOn(fixture.native, 'readBlob')
    const reader = () =>
      new ChatReaderService(new ResourceService(storage, new ResourceParserRegistry([])))
    activateAndroidNativeAppDatabase()
    try {
      const cold = await reader().read('chat', 600, 20)
      expect(await storage.getChatReadPositionCache?.('chat')).toMatchObject({
        checkpoints: expect.arrayContaining([expect.objectContaining({ floor: 512 })]),
      })
      fixture.database.close()
      await fixture.database.open()
      range.mockClear()
      const reopened = reader()
      expect(await reopened.read('chat', 600, 20)).toEqual(cold)
      expect(range.mock.calls[0]!.slice(3, 5)).toEqual([0, 1])
      expect(range.mock.calls[1]![3]).toBeGreaterThan(0)
      expect(range.mock.calls.reduce((sum, call) => sum + call[4], 0)).toBeLessThan(
        originalBlob.size / 2,
      )
      range.mockClear()
      expect(await reopened.read('chat', 600, 20)).toEqual(cold)
      expect(range.mock.calls.map((call) => call.slice(3, 5))).toEqual([[0, 1]])
      expect(full).not.toHaveBeenCalled()
    } finally {
      deactivateAndroidNativeAppDatabase()
      range.mockRestore()
      await fixture.close()
    }
  })

  it('reads only five recent cards through the indexed bridge and waits for an in-flight writer', async () => {
    const fixture = await delayedDatabase()
    const storage = new IndexedDbResourceStorage(fixture.database)
    const sample = await routeResource('sample')
    for (let i = 0; i < 1000; i++) {
      const id = `other-${i}`
      fixture.stores.get('resourceListSummaries')!.set(JSON.stringify(id), {
        ...sample,
        id,
        updatedAt: 100 + i,
      })
    }
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await storage.save({
        ...sample,
        id,
        type: RESOURCE_TYPE.CHARACTER_CARD,
        thumbnailBlob: new Blob([id], { type: 'image/png' }),
        updatedAt: 1,
      })
    }
    const recent = vi
      .spyOn(nativeAppDatabase, 'getRecentRecordsByIndex')
      .mockImplementation(async (store, index, limit, filterIndex, filterKey) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(index).toBe('updatedAt')
        expect(filterIndex).toBe('type')
        expect(filterKey).toBe(encodeAppDatabaseKey(RESOURCE_TYPE.CHARACTER_CARD))
        return [...fixture.stores.get(store)!]
          .filter(([, row]) => row.type === JSON.parse(filterKey!))
          .sort(
            ([a, left], [b, right]) =>
              Number(right.updatedAt) - Number(left.updatedAt) || (a < b ? 1 : a > b ? -1 : 0),
          )
          .slice(0, limit)
          .map(([key, value]) => ({ key, value }))
      })
    const blobRead = vi
      .spyOn(nativeAppDatabase, 'readBlob')
      .mockImplementation(fixture.native.readBlob.bind(fixture.native))
    const payloadReads = vi.spyOn(fixture.native, 'getRecordsByKeys')
    const indexReads = vi.spyOn(fixture.native, 'getIndexEntries')
    activateAndroidNativeAppDatabase()
    try {
      const result = await storage.listRecentCharacterCardSummaries(5)
      expect(result.map((row) => row.id)).toEqual(['f', 'e', 'd', 'c', 'b'])
      expect(result[0]!.thumbnailAssetId).toEqual(expect.any(String))
      expect(result[0]).not.toHaveProperty('thumbnailBlob')
      expect(payloadReads).not.toHaveBeenCalled()
      expect(indexReads).not.toHaveBeenCalled()
      expect(blobRead).not.toHaveBeenCalled()

      let release!: () => void, entered!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const writer = fixture.database.transaction(
        'rw',
        fixture.database.resourceListSummaries,
        async () => {
          await fixture.database.resourceListSummaries.get('a')
          entered()
          await Dexie.waitFor(blocked)
          await fixture.database.resourceListSummaries.update('a', { updatedAt: 5000 })
        },
      )
      await ready
      const reading = Dexie.ignoreTransaction(() => storage.listRecentCharacterCardSummaries(1))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(recent).toHaveBeenCalledOnce()
      release()
      await writer
      expect((await reading).map((row) => row.id)).toEqual(['a'])

      // Keep old-interface parity independent of the intentionally slow 1 ms/record fixture.
      for (let i = 0; i < 1000; i++)
        fixture.stores.get('resourceListSummaries')!.delete(JSON.stringify(`other-${i}`))
      recent.mockRejectedValueOnce({ code: 'UNIMPLEMENTED' })
      const old = await storage.listRecentCharacterCardSummaries(5)
      expect(old.map((row) => row.id)).toEqual(['a', 'f', 'e', 'd', 'c'])
      expect(indexReads).toHaveBeenCalled()
      const recentCalls = recent.mock.calls.length
      await fixture.database.transaction('rw', fixture.database.resourceListSummaries, async () => {
        await fixture.database.resourceListSummaries.update('b', { updatedAt: 9000 })
        expect((await storage.listRecentCharacterCardSummaries(1)).map((row) => row.id)).toEqual([
          'b',
        ])
      })
      expect(recent).toHaveBeenCalledTimes(recentCalls)
      payloadReads.mockClear()
      recent.mockRejectedValueOnce(new Error('SQLite read failed'))
      await expect(storage.listRecentCharacterCardSummaries(5)).rejects.toThrow(
        'SQLite read failed',
      )
      expect(payloadReads).not.toHaveBeenCalled()
    } finally {
      deactivateAndroidNativeAppDatabase()
      recent.mockRestore()
      blobRead.mockRestore()
      await fixture.close()
    }
  })

  it('keeps private recent-card selection on the decoded vault route', async () => {
    const fixture = await delayedDatabase()
    const vault = new VaultService(fixture.database)
    const recent = vi
      .spyOn(nativeAppDatabase, 'getRecentRecordsByIndex')
      .mockRejectedValue(new Error('private type must not be queried'))
    try {
      await vault.initialize()
      await vault.enable('synthetic-test-password')
      const storage = new IndexedDbResourceStorage(fixture.database, vault)
      const sample = await routeResource('sample')
      await storage.saveMany([
        { ...sample, id: 'card-a', type: RESOURCE_TYPE.CHARACTER_CARD },
        { ...sample, id: 'card-b', type: RESOURCE_TYPE.CHARACTER_CARD },
        { ...sample, id: 'newer-other', updatedAt: 5000 },
      ])
      activateAndroidNativeAppDatabase()
      expect((await storage.listRecentCharacterCardSummaries(1)).map((row) => row.id)).toEqual([
        'card-b',
      ])
      expect(recent).not.toHaveBeenCalled()
      expect(fixture.stores.get('resourceListSummaries')!.get('"card-b"')).not.toHaveProperty(
        'type',
      )
    } finally {
      deactivateAndroidNativeAppDatabase()
      recent.mockRestore()
      await fixture.close()
    }
  })
})
