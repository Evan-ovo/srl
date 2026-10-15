import 'fake-indexeddb/auto'

import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { ResourceService } from '../services/ResourceService'
import { VaultService } from '../services/VaultService'
import { findHistoricalDuplicateGroups } from '../services/ResourceVersionMatcher'
import {
  RESOURCE_LINK_TYPE,
  RESOURCE_TYPE,
  toResourceSummary,
  type Resource,
} from '../types/Resource'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'

function createResource(index: number): Resource {
  const original = new Uint8Array(64 * 1024)
  original[0] = index % 255
  return {
    id: `resource-${index}`,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: `角色 ${index}`,
    description: '压力测试资源',
    fileName: `character-${index}.png`,
    mimeType: 'image/png',
    fileSize: original.byteLength,
    contentHash: index.toString(16).padStart(64, '0'),
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    tags: ['压力测试'],
    metadata: { parserVersion: 5 },
    thumbnailBlob: new Blob([new Uint8Array(128)], { type: 'image/webp' }),
    originalBlob: new Blob([original], { type: 'image/png' }),
    createdAt: index,
    updatedAt: index,
  }
}

describe('IndexedDbResourceStorage', () => {
  it('repairs only selected keys, removes selected orphans, and leaves the global repair marker unset', async () => {
    const database = new AppDatabase(`scoped-repair-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbResourceStorage(database)
      await storage.saveMany([createResource(1), createResource(2), createResource(3)])
      await database.resourceListSummaries.bulkDelete(['resource-1', 'resource-2'])
      await database.resources.delete('resource-3')
      const globalKeys = vi.spyOn(database.resources, 'toCollection')
      expect(
        (
          await storage.listResourceListSummaries({ ids: ['resource-1', 'resource-3', 'missing'] })
        ).map((row) => row.id),
      ).toEqual(['resource-1'])
      expect(globalKeys).not.toHaveBeenCalled()
      expect(await database.resourceListSummaries.get('resource-2')).toBeUndefined()
      expect(await database.resourceListSummaries.get('resource-3')).toBeUndefined()
      expect(await database.settings.get('index.resourceListSummaries.v20')).toBeUndefined()
      expect(await storage.listResourceListSummaries()).toHaveLength(2)
      expect(await database.resourceListSummaries.get('resource-2')).toBeDefined()
    } finally {
      await database.delete()
    }
  })
  it('does no index work for an empty selected scope', async () => {
    const database = new AppDatabase(`empty-scoped-repair-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbResourceStorage(database)
      const transaction = vi.spyOn(database, 'transaction')
      expect(await storage.listResourceListSummaries({ ids: [] })).toEqual([])
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      await database.delete()
    }
  })
  it('persists sparse chat positions in existing settings and caps retained chat indexes', async () => {
    const database = new AppDatabase(`chat-read-position-cache-${crypto.randomUUID()}`)
    let timestamp = 100
    const now = vi.spyOn(Date, 'now').mockImplementation(() => timestamp++)
    try {
      const storage = new IndexedDbResourceStorage(database)
      const cache = (index: number) => ({
        schemaVersion: 1 as const,
        key: `content-${index}`,
        stride: 128,
        checkpoints: [
          {
            byteOffset: 0,
            line: 1,
            floor: 0,
            visible: 0,
            replies: 0,
            previousReply: null,
          },
        ],
      })
      for (let index = 0; index < 4; index++) {
        await storage.setChatReadPositionCache(`chat-${index}`, {
          ...cache(index),
        })
      }

      const reopenedStorage = new IndexedDbResourceStorage(database)
      expect(await reopenedStorage.getChatReadPositionCache('chat-0')).toMatchObject({
        key: 'content-0',
      })
      await reopenedStorage.setChatReadPositionCache('chat-4', cache(4))
      expect(await reopenedStorage.getChatReadPositionCache('chat-0')).toMatchObject({
        key: 'content-0',
      })
      expect(await reopenedStorage.getChatReadPositionCache('chat-1')).toBeUndefined()
      expect(await reopenedStorage.getChatReadPositionCache('chat-4')).toMatchObject({
        key: 'content-4',
        checkpoints: [{ floor: 0, byteOffset: 0 }],
      })
      await reopenedStorage.deleteChatReadPositionCache('chat-4')
      expect(await reopenedStorage.getChatReadPositionCache('chat-4')).toBeUndefined()
    } finally {
      now.mockRestore()
      database.close()
      await database.delete()
    }
  })

  it('reads background imports without tags without rewriting originals or losing existing tags', async () => {
    const database = new AppDatabase(`background-missing-tags-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbResourceStorage(database)
      const legacy = { ...createResource(901), tags: undefined } as unknown as Resource
      const tagged = createResource(902)
      await database.resources.bulkPut([legacy, tagged])
      await database.resourceListSummaries.bulkPut([
        { ...toResourceSummary(legacy), tags: undefined } as unknown as Resource,
        toResourceSummary(tagged),
      ])
      await database.settings.put({
        id: 'index.resourceListSummaries.v20',
        value: true,
        updatedAt: 1,
      })

      const listed = await storage.listResourceListSummaries()
      expect(listed.find((resource) => resource.id === legacy.id)?.tags).toEqual([])
      expect(listed.find((resource) => resource.id === tagged.id)?.tags).toEqual(tagged.tags)
      expect((await storage.get(legacy.id))?.tags).toEqual([])
      expect((await storage.getSummary(legacy.id))?.tags).toEqual([])
      const original = await database.resources.get(legacy.id)
      const originalSummary = await database.resourceListSummaries.get(legacy.id)
      expect(original && 'tags' in original ? original.tags : undefined).toBeUndefined()
      expect(
        originalSummary && 'tags' in originalSummary ? originalSummary.tags : undefined,
      ).toBeUndefined()
      expect((await database.resources.get(legacy.id))?.contentHash).toBe(legacy.contentHash)
    } finally {
      await database.delete()
    }
  })

  it('compacts old current/history summaries atomically while retaining full content and metadata edits', async () => {
    const database = new AppDatabase(`compact-summaries-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbResourceStorage(database)
      const current = createResource(900)
      current.metadata = {
        card: { data: { description: '正文'.repeat(100_000) } },
        personalDocument: { pages: ['完整文档'] },
        creator: '作者',
      }
      const history = { ...current, id: 'history-900', versionGroupId: current.id }
      await storage.save(current)
      await storage.saveVersion(history)
      await database.resourceSummaries.put(toResourceSummary(current))
      await database.resourceVersionSummaries.put(toResourceSummary(history))
      expect(await storage.areDerivedSummariesCompact()).toBe(false)
      await storage.repairDerivedIndexes()
      expect(await storage.areDerivedSummariesCompact()).toBe(true)
      for (const table of [database.resourceSummaries, database.resourceVersionSummaries]) {
        const rows = await table.toArray()
        expect(JSON.stringify(rows).length).toBeLessThan(3000)
        expect(rows).toHaveLength(1)
      }
      expect((await storage.getSummary(current.id))?.metadata).toEqual(current.metadata)
      expect((await storage.getVersion(history.id))?.metadata).toEqual(current.metadata)
      await storage.updateMetadata(current.id, { metadata: { edited: true }, favorite: true })
      expect((await storage.get(current.id))?.metadata).toEqual({
        ...current.metadata,
        edited: true,
      })
      expect((await storage.get(current.id))?.originalBlob.size).toBe(current.originalBlob.size)
      const put = vi
        .spyOn(database.resourceVersionSummaries, 'bulkPut')
        .mockRejectedValueOnce(new Error('write failed'))
      await expect(storage.repairDerivedIndexes()).rejects.toThrow('write failed')
      put.mockRestore()
      expect(await database.resourceSummaries.count()).toBe(1)
      expect(await database.resourceVersionSummaries.count()).toBe(1)
      await database.resourceVersionSummaries.put(toResourceSummary(history))
      expect(await storage.areDerivedSummariesCompact()).toBe(false)
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('keeps encrypted chat and targeted card summaries visible without exposing a plaintext type index', async () => {
    const database = new AppDatabase(`encrypted-reader-list-${crypto.randomUUID()}`)
    try {
      const vault = new VaultService(database)
      await vault.initialize()
      await vault.enable('test-password')
      const storage = new IndexedDbResourceStorage(database, vault)
      const chat = { ...createResource(2), type: RESOURCE_TYPE.CHAT }
      await storage.saveMany([createResource(1), chat])
      expect(
        (await storage.listResourceListSummaries({ types: [RESOURCE_TYPE.CHAT] })).map((r) => r.id),
      ).toEqual([chat.id])
      expect(
        (
          await storage.listResourceListSummaries({
            types: [RESOURCE_TYPE.CHARACTER_CARD],
            ids: ['resource-1'],
          })
        ).map((r) => r.id),
      ).toEqual(['resource-1'])
      expect(await database.resourceListSummaries.get(chat.id)).not.toHaveProperty('type')
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('reads only matching list rows for chat and bound-card queries with 200 unrelated cards', async () => {
    const database = new AppDatabase(`scoped-reader-list-${crypto.randomUUID()}`)
    try {
      const storage = new IndexedDbResourceStorage(database)
      const chat = { ...createResource(201), type: RESOURCE_TYPE.CHAT }
      await storage.saveMany([...Array.from({ length: 200 }, (_, i) => createResource(i)), chat])
      await storage.listResourceListSummaries()
      const bulkGet = vi.spyOn(database.resourceListSummaries, 'bulkGet')
      const getOriginal = vi.spyOn(database.resources, 'get')
      expect(
        (await storage.listResourceListSummaries({ types: [RESOURCE_TYPE.CHAT] })).map((r) => r.id),
      ).toEqual([chat.id])
      expect(bulkGet).toHaveBeenCalledExactlyOnceWith([chat.id])
      bulkGet.mockClear()
      expect(
        (
          await storage.listResourceListSummaries({
            types: [RESOURCE_TYPE.CHARACTER_CARD],
            ids: ['resource-8', chat.id, 'resource-8', 'missing'],
          })
        ).map((r) => r.id),
      ).toEqual(['resource-8'])
      expect(bulkGet).toHaveBeenCalledExactlyOnceWith(['missing', chat.id, 'resource-8'])
      expect(getOriginal).not.toHaveBeenCalled()
    } finally {
      database.close()
      await database.delete()
    }
  })
  it.each([0, 1000])(
    'reads only the selected history original with %s unrelated history records',
    async (unrelatedCount) => {
      const database = new AppDatabase(`scoped-history-${crypto.randomUUID()}`)
      try {
        const base = { ...createResource(1), originalBlob: new Blob(['abc']), fileSize: 3 }
        const selected = { ...base, id: 'selected-version', versionGroupId: 'selected' }
        await database.resourceVersions.bulkPut([
          selected,
          ...Array.from({ length: unrelatedCount }, (_, i) => ({
            ...base,
            id: `unrelated-${i}`,
            versionGroupId: `other-${i}`,
          })),
        ])
        const allOriginals = vi
          .spyOn(database.resourceVersions, 'toArray')
          .mockRejectedValue(new Error('unrelated originals must not be loaded'))
        const getOriginal = vi.spyOn(database.resourceVersions, 'get')
        const storage = new IndexedDbResourceStorage(database)
        expect(
          (await storage.listVersionListSummariesForResources(['selected'])).map((row) => row.id),
        ).toEqual(['selected-version'])
        expect(allOriginals).not.toHaveBeenCalled()
        expect(getOriginal).toHaveBeenCalledExactlyOnceWith('selected-version')
      } finally {
        database.close()
        await database.delete()
      }
    },
  )
  it('rebuilds a missing list-summary row from the authoritative resource without treating it as an empty library', async () => {
    const database = new AppDatabase(`resource-list-index-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(77)
    await storage.save(resource)
    await database.resourceListSummaries.clear()

    await expect(storage.listResourceListSummaries()).resolves.toMatchObject([{ id: resource.id }])
    expect(await database.resources.get(resource.id)).toBeDefined()
    database.close()
    await database.delete()
  })

  it('stores resources after removing uncloneable metadata values', async () => {
    const database = new AppDatabase(`resource-clone-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(1)
    resource.metadata = {
      safe: 'ok',
      nested: {
        keep: 1,
        drop: () => 'not cloneable',
      },
      missing: undefined,
      symbol: Symbol('not cloneable'),
      importedAt: new Date('2026-07-25T00:00:00.000Z'),
      amount: BigInt(12),
    }

    await expect(storage.save(resource)).resolves.toBeUndefined()
    const stored = await storage.get(resource.id)

    expect(stored?.metadata).toEqual({
      safe: 'ok',
      nested: { keep: 1 },
      importedAt: '2026-07-25T00:00:00.000Z',
      amount: '12',
    })

    database.close()
    await database.delete()
  })

  it('updates a Vue reactive resource without writing proxies to IndexedDB', async () => {
    const database = new AppDatabase(`resource-reactive-update-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = reactive(createResource(2))

    await storage.save(resource)
    resource.name = '改名后的角色'
    resource.description = '改名后保存'

    await expect(storage.save(resource)).resolves.toBeUndefined()
    const stored = await storage.get(resource.id)

    expect(stored?.name).toBe('改名后的角色')
    expect(stored?.description).toBe('改名后保存')
    expect(stored?.originalBlob).toBeInstanceOf(Blob)

    database.close()
    await database.delete()
  })

  it('preserves source links when cloning resources for IndexedDB', async () => {
    const database = new AppDatabase(`resource-source-links-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(21)
    resource.sourceLinks = [
      {
        id: 'github-release',
        label: 'GitHub Release',
        url: 'https://github.com/SillyTavern/SillyTavern/releases/tag/1.13.4',
        type: RESOURCE_LINK_TYPE.GITHUB,
        note: '移动端保存来源',
        createdAt: 21,
      },
    ]

    await storage.saveMany([resource])
    const stored = await storage.get(resource.id)

    expect(stored?.sourceLinks).toHaveLength(1)
    expect(stored?.sourceLinks?.[0]).toMatchObject({
      id: 'github-release',
      label: 'GitHub Release',
      url: 'https://github.com/SillyTavern/SillyTavern/releases/tag/1.13.4',
      type: RESOURCE_LINK_TYPE.GITHUB,
      note: '移动端保存来源',
    })

    database.close()
    await database.delete()
  })

  it('preserves stored blobs when only metadata changes', async () => {
    const database = new AppDatabase(`resource-metadata-update-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(3)

    await storage.save(resource)
    await storage.update(resource.id, {
      name: '鏀瑰悕鍚庣殑瑙掕壊',
      updatedAt: Date.now(),
    })
    const stored = await storage.get(resource.id)
    const summary = (await storage.listSummaries()).find((item) => item.id === resource.id)

    expect(stored?.name).toBe('鏀瑰悕鍚庣殑瑙掕壊')
    expect(stored?.originalBlob.size).toBe(64 * 1024)
    expect(stored?.thumbnailBlob?.size).toBe(128)
    expect(summary?.thumbnailBlob).toBeUndefined()
    expect(summary?.thumbnailAssetId).toBe(stored?.thumbnailAssetId)
    await expect(database.resources.get(resource.id)).resolves.toMatchObject({
      thumbnailAssetId: stored?.thumbnailAssetId,
      thumbnailBlob: undefined,
    })

    database.close()
    await database.delete()
  })

  it('persists an explicit thumbnail update without replacing the original file', async () => {
    const database = new AppDatabase(`resource-thumbnail-update-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(4)
    const nextThumbnail = new Blob([new Uint8Array(256)], { type: 'image/webp' })

    await storage.save(resource)
    await storage.update(resource.id, { thumbnailBlob: nextThumbnail, updatedAt: Date.now() })
    const stored = await storage.get(resource.id)
    const summary = (await storage.listSummaries()).find((item) => item.id === resource.id)

    expect(stored?.originalBlob.size).toBe(64 * 1024)
    expect(stored?.thumbnailBlob?.size).toBe(256)
    expect(summary?.thumbnailBlob).toBeUndefined()
    expect(summary?.thumbnailAssetId).toBe(stored?.thumbnailAssetId)

    await storage.update(resource.id, { thumbnailBlob: undefined, updatedAt: Date.now() })
    expect((await storage.get(resource.id))?.thumbnailBlob).toBeUndefined()
    expect(
      (await storage.listSummaries()).find((item) => item.id === resource.id)?.thumbnailBlob,
    ).toBeUndefined()
    expect(
      (await storage.listSummaries()).find((item) => item.id === resource.id)?.thumbnailAssetId,
    ).toBeUndefined()

    database.close()
    await database.delete()
  })

  it('resumes legacy duplicated thumbnails into the content-addressed asset store', async () => {
    const database = new AppDatabase(`resource-thumbnail-migration-${crypto.randomUUID()}`)
    const resource = createResource(41)
    const { originalBlob: _originalBlob, ...legacySummary } = resource
    await database.resources.put(resource)
    await database.resourceSummaries.put(legacySummary)
    await database.resourceListSummaries.put(legacySummary)

    const storage = new IndexedDbResourceStorage(database)
    await storage.repairThumbnailAssets()
    const summaries = await storage.listSummaries()
    const migratedResource = await database.resources.get(resource.id)
    const migratedSummary = await database.resourceSummaries.get(resource.id)
    const thumbnailAssetId =
      migratedResource && !('encrypted' in migratedResource)
        ? migratedResource.thumbnailAssetId
        : undefined

    expect(migratedResource).toMatchObject({
      thumbnailAssetId: expect.stringMatching(/^asset-/u),
      thumbnailBlob: undefined,
    })
    expect(migratedSummary).toMatchObject({
      thumbnailAssetId,
    })
    expect(migratedSummary).not.toHaveProperty('thumbnailBlob')
    expect(summaries[0]?.thumbnailBlob).toBeUndefined()
    await expect(
      (await storage.get(resource.id))?.thumbnailBlob?.arrayBuffer(),
    ).resolves.toHaveProperty('byteLength', 128)
    await expect(
      database.settings.get('migration.resourceThumbnails.asset.v23'),
    ).resolves.toMatchObject({ value: { status: 'complete', migrated: 1 } })

    database.close()
    await database.delete()
  })

  it('lists 500 lightweight summaries without returning original blobs', async () => {
    const database = new AppDatabase(`resource-summary-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resources = Array.from({ length: 500 }, (_, index) => createResource(index))

    await storage.saveMany(resources)
    const summaries = await storage.listSummaries()

    expect(summaries).toHaveLength(500)
    expect(summaries.every((resource) => !('originalBlob' in resource))).toBe(true)
    expect(summaries.every((resource) => !resource.thumbnailBlob)).toBe(true)
    expect(summaries.every((resource) => Boolean(resource.thumbnailAssetId))).toBe(true)
    await expect(database.assetFiles.count()).resolves.toBe(1)
    expect(await storage.get('resource-499')).toMatchObject({
      name: '角色 499',
      fileSize: 64 * 1024,
    })
    expect((await storage.get('resource-499'))?.originalBlob.size).toBe(64 * 1024)

    database.close()
    await database.delete()
  })

  it('persists a separate list index without full character-card metadata', async () => {
    const database = new AppDatabase(`resource-list-summary-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resource = createResource(700)
    resource.metadata = {
      creator: '测试作者',
      characterVersion: '2.0',
      card: { data: { description: '正文'.repeat(100_000), character_book: { entries: [] } } },
    }

    await storage.save(resource)
    const list = await storage.listResourceListSummaries()
    const storedList = await database.resourceListSummaries.get(resource.id)
    const fullSummary = await database.resourceSummaries.get(resource.id)

    expect(list).toHaveLength(1)
    expect(list[0]?.metadata).toEqual({ creator: '测试作者', characterVersion: '2.0' })
    expect(storedList && 'originalBlob' in storedList).toBe(false)
    expect(storedList && 'card' in (storedList as Resource).metadata).toBe(false)
    expect(fullSummary && 'card' in (fullSummary as Resource).metadata).toBe(false)
    expect((await storage.getSummary(resource.id))?.metadata.card).toEqual(resource.metadata.card)
    await storage.update(resource.id, { tags: ['新标签'] })
    expect((await storage.get(resource.id))?.metadata.card).toEqual(resource.metadata.card)

    database.close()
    await database.delete()
  })

  it('loads and sorts 5000 summary records without touching the original file table', async () => {
    const database = new AppDatabase(`resource-summary-stress-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const summaries = Array.from({ length: 5_000 }, (_, index) =>
      toResourceSummary(createResource(index)),
    )
    await database.resourceSummaries.bulkPut(summaries)
    const oneShotTableRead = vi.spyOn(database.resourceSummaries, 'toArray')

    const startedAt = performance.now()
    const loaded = await storage.listSummaries()
    const elapsedMs = performance.now() - startedAt

    expect(loaded).toHaveLength(5_000)
    expect(elapsedMs).toBeLessThan(3_000)
    expect(loaded[0]?.updatedAt).toBe(4_999)
    expect(loaded.at(-1)?.updatedAt).toBe(0)
    expect(loaded.every((resource) => !('originalBlob' in resource))).toBe(true)
    expect(oneShotTableRead).not.toHaveBeenCalled()
    expect(await database.resources.count()).toBe(0)

    database.close()
    await database.delete()
  })

  it('keeps a lightweight summary index for historical versions', async () => {
    const database = new AppDatabase(`resource-version-summary-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const version = {
      ...createResource(501),
      id: 'historical-version',
      versionGroupId: 'active-resource',
      versionLabel: '第一版',
    }

    await storage.saveVersion(version)
    const summaries = await storage.listVersionSummaries()

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: version.id,
      versionGroupId: version.versionGroupId,
      versionLabel: '第一版',
    })
    expect('originalBlob' in summaries[0]).toBe(false)

    await storage.deleteVersion(version.id)
    expect(await storage.listVersionSummaries()).toEqual([])

    database.close()
    await database.delete()
  })

  it('deletes selected resources in bounded batches and reports versions in progress', async () => {
    const database = new AppDatabase(`resource-delete-progress-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const resources = [createResource(601), createResource(602)]
    await storage.saveMany(resources)
    await storage.saveVersion({
      ...createResource(603),
      id: 'resource-601-history',
      versionGroupId: 'resource-601',
      versionLabel: '历史版本',
    })
    const progress: Array<{ completed: number; total: number }> = []

    await storage.deleteMany(
      resources.map((resource) => resource.id),
      (entry) => progress.push(entry),
    )

    expect(progress[0]).toEqual({ completed: 0, total: 3 })
    expect(progress.at(-1)).toEqual({ completed: 3, total: 3 })
    expect(await database.resources.count()).toBe(0)
    expect(await database.resourceVersions.count()).toBe(0)

    database.close()
    await database.delete()
  })

  it('repairs missing and ghost historical summaries from authoritative version records', async () => {
    const database = new AppDatabase(`resource-version-summary-repair-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const version = {
      ...createResource(502),
      id: 'real-history',
      versionGroupId: 'active-resource',
      versionLabel: '恢复得到的历史版',
    }
    const ghost = {
      ...createResource(503),
      id: 'ghost-history',
      versionGroupId: 'missing-resource',
    }

    // 模拟旧恢复逻辑：真实历史表有记录，摘要索引却缺失并残留无主摘要。
    await database.resourceVersions.put(version)
    await database.resourceVersionSummaries.put(toResourceSummary(ghost))

    const summaries = await storage.listVersionSummaries()

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: version.id,
      contentHash: version.contentHash,
      versionGroupId: version.versionGroupId,
    })
    expect('originalBlob' in summaries[0]).toBe(false)
    expect(await database.resourceVersionSummaries.get(ghost.id)).toBeUndefined()

    database.close()
    await database.delete()
  })

  it('uses the real historical table to repair stale hashes and actually removes duplicate versions', async () => {
    const database = new AppDatabase(`resource-version-stale-hash-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const service = new ResourceService(storage, new ResourceParserRegistry([]))
    const current = {
      ...createResource(504),
      id: 'current',
      contentHash: '1'.repeat(64),
      versionCount: 4,
      updatedAt: 40,
    }
    const duplicatedHash = '1503b4256460'.padEnd(64, '0')
    const firstCopy = {
      ...createResource(505),
      id: 'history-json',
      fileName: 'json',
      mimeType: 'application/json',
      contentHash: duplicatedHash,
      versionGroupId: current.id,
      updatedAt: 30,
    }
    const secondCopy = {
      ...createResource(506),
      id: 'history-1-json',
      fileName: '1.json',
      mimeType: 'application/json',
      contentHash: duplicatedHash,
      versionGroupId: current.id,
      updatedAt: 20,
    }
    const distinctHistory = {
      ...createResource(507),
      id: 'history-distinct',
      contentHash: '2'.repeat(64),
      versionGroupId: current.id,
      updatedAt: 10,
    }

    await storage.save(current)
    await database.resourceVersions.bulkPut([firstCopy, secondCopy, distinctHistory])
    // 模拟用户存量数据库：真实历史已经相同，但两个现有摘要仍保留旧哈希。
    await database.resourceVersionSummaries.bulkPut([
      { ...toResourceSummary(firstCopy), contentHash: 'a'.repeat(64) },
      { ...toResourceSummary(secondCopy), contentHash: 'b'.repeat(64) },
      toResourceSummary(distinctHistory),
    ])

    const repairedSummaries = await storage.listVersionSummaries()
    const duplicateGroups = findHistoricalDuplicateGroups(
      await storage.listSummaries(),
      repairedSummaries,
    )
    const exactGroup = duplicateGroups.find((group) => group.kind === 'exactFile')

    expect(
      repairedSummaries
        .filter((version) => ['history-json', 'history-1-json'].includes(version.id))
        .map((version) => version.contentHash),
    ).toEqual([duplicatedHash, duplicatedHash])
    expect(exactGroup?.keeper.id).toBe('history-json')
    expect(exactGroup?.duplicates.map((version) => version.id)).toEqual(['history-1-json'])

    const deleted = await service.deleteVersions(
      current.id,
      exactGroup!.duplicates.map((version) => version.id),
    )
    const finalVersions = await service.listVersions(current.id)
    const finalHashes = finalVersions.map((version) => version.resource.contentHash)

    expect(deleted).toBe(1)
    expect(finalVersions.map((version) => version.resource.id).sort()).toEqual([
      'current',
      'history-distinct',
      'history-json',
    ])
    expect(new Set(finalHashes).size).toBe(finalHashes.length)
    expect((await storage.get(current.id))?.versionCount).toBe(3)
    expect(await database.resourceVersions.get('history-1-json')).toBeUndefined()
    expect(await database.resourceVersionSummaries.get('history-1-json')).toBeUndefined()

    database.close()
    await database.delete()
  })

  it('从真实历史表回填语义指纹并把 JSON/PNG 封装收敛为一个版本', async () => {
    const database = new AppDatabase(`resource-logical-version-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const service = new ResourceService(storage, new ResourceParserRegistry([]))
    const data = {
      name: '同一角色',
      description: '相同内容',
      personality: '',
      scenario: '',
      first_mes: '你好',
      mes_example: '',
    }
    const current = {
      ...createResource(601),
      id: 'logical-current',
      fileName: 'card.png',
      versionCount: 2,
      metadata: {
        card: { spec: 'chara_card_v2', spec_version: '2.0', data },
        cardContentHash: 'legacy-png-hash',
      },
    }
    const jsonCarrier = {
      ...createResource(602),
      id: 'logical-json',
      fileName: 'card.json',
      mimeType: 'application/json',
      versionGroupId: current.id,
      metadata: { card: data, cardContentHash: 'legacy-json-hash' },
    }
    await storage.save(current)
    await storage.saveVersion(jsonCarrier)

    expect(await service.backfillCardFingerprints()).toBe(2)

    const storedCurrent = await storage.get(current.id)
    const [storedHistory] = await storage.listAllVersions()
    const [historySummary] = await storage.listVersionSummaries()
    const grouped = await service.listVersions(current.id)
    expect(storedHistory?.metadata.cardContentHash).toBe(storedCurrent?.metadata.cardContentHash)
    expect(historySummary?.metadata.cardContentHash).toBe(storedCurrent?.metadata.cardContentHash)
    expect(storedCurrent?.versionCount).toBe(1)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.carriers).toHaveLength(2)

    database.close()
    await database.delete()
  })
})

describe('backup metadata reads', () => {
  it('reads current and historical native metadata without fetching a 1 GiB original', async () => {
    const database = new AppDatabase(`backup-metadata-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const original = createResource(81)
    const { originalBlob: _originalBlob, ...metadata } = original
    const native = {
      ...metadata,
      fileSize: 1024 ** 3,
      metadata: { nested: { important: true } },
      nativeOriginal: { version: 1 as const, contentHash: original.contentHash, size: 1024 ** 3 },
    }
    await database.resources.put(native)
    await database.resourceVersions.put({ ...native, id: 'history', versionGroupId: original.id })
    const read = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not read original'))
    try {
      expect(await storage.getSummary(original.id)).toMatchObject({
        fileSize: 1024 ** 3,
        metadata: native.metadata,
      })
      expect(await storage.getSummary('history', true)).toMatchObject({
        id: 'history',
        versionGroupId: original.id,
        metadata: native.metadata,
      })
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      database.close()
      await database.delete()
    }
  })
})
