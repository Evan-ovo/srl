/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { Blob as StructuredCloneBlob } from 'node:buffer'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { ResourceService } from './ResourceService'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbExternalAppStorage } from '../storage/IndexedDbExternalAppStorage'
import { ExternalAppService } from './ExternalAppService'
import { createChatReaderHost } from './ChatReaderHostService'
import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import { externalAppDataId } from '../types/ExternalApp'

const databases: AppDatabase[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
const ui = {
  navigation: vi.fn(),
  ready: vi.fn(),
  exit: vi.fn(),
  shareText: vi.fn(),
  appearance: async () => '',
}
const summary = (id: string, type: 'chat' | 'characterCard') => ({
  id,
  type,
  name: id,
  description: '',
  tags: [],
  favorite: false,
  categoryIds: [],
  relatedResourceIds: type === 'chat' ? ['role'] : [],
  updatedAt: 1,
  metadata: { messageCount: 12 },
})

describe('native reader direct service access', () => {
  it.each([1000, 5000, 10000])(
    'reads one scoped chat directory and only its associated cards for %i chats',
    async (count) => {
      const resources = {
        listResourceListSummaries: vi.fn(async (filter: { types: string[]; ids?: string[] }) =>
          filter.types[0] === 'chat'
            ? Array.from({ length: count }, (_, i) => summary('chat-' + i, 'chat'))
            : [summary('role', 'characterCard')],
        ),
        get: vi.fn(),
      }
      const data = { readReaderData: vi.fn(), writeReaderData: vi.fn() }
      const api = createChatReaderHost(resources as never, data as never, ui)
      const start = performance.now(),
        before = process.memoryUsage().heapUsed
      const directory = await api.resources.directory()
      console.info('native-directory', {
        count,
        ms: performance.now() - start,
        heapDelta: process.memoryUsage().heapUsed - before,
        queries: resources.listResourceListSummaries.mock.calls.length,
      })
      expect(directory.chats).toHaveLength(count)
      expect(directory.characters).toHaveLength(1)
      expect(resources.listResourceListSummaries.mock.calls).toEqual([
        [{ types: ['chat'] }],
        [{ types: ['characterCard'], ids: ['role'] }],
      ])
      expect(resources.get).not.toHaveBeenCalled()
    },
  )

  it('reads and writes the original reader keys without an installed executable, preserving unknown fields and backups', async () => {
    const db = new AppDatabase('native-reader-' + crypto.randomUUID())
    databases.push(db)
    const storage = new IndexedDbExternalAppStorage(db),
      service = new ExternalAppService(storage)
    await storage.setData({
      id: externalAppDataId(CHAT_READER_APP_ID, 'chat:one'),
      appId: CHAT_READER_APP_ID,
      key: 'chat:one',
      value: { note: '旧备注', position: { floor: 91 }, marks: [{ floor: 3 }], future: { x: 1 } },
      updatedAt: 1,
    })
    const single = vi.spyOn(storage, 'getData'),
      batch = vi.spyOn(storage, 'getDataMany')
    const keys = Array.from({ length: 30 }, (_, i) => (i === 0 ? 'chat:one' : 'chat:' + i))
    const values = await service.readReaderData(keys)
    expect(batch).toHaveBeenCalledExactlyOnceWith(CHAT_READER_APP_ID, keys)
    expect(single).not.toHaveBeenCalled()
    expect(values['chat:one']).toEqual({
      note: '旧备注',
      position: { floor: 91 },
      marks: [{ floor: 3 }],
      future: { x: 1 },
    })
    expect(values['chat:1']).toBeNull()
    await service.writeReaderData('chat:one', { ...(values['chat:one'] as object), note: '新备注' })
    const reopened = new ExternalAppService(new IndexedDbExternalAppStorage(db))
    expect((await reopened.readReaderData(['chat:one']))['chat:one']).toMatchObject({
      note: '新备注',
      position: { floor: 91 },
      future: { x: 1 },
    })
    expect(
      (await reopened.exportReaderData()).some(
        (r) => r.key === 'chat:one' && (r.value as { note: string }).note === '新备注',
      ),
    ).toBe(true)
    expect(await storage.getSummary(CHAT_READER_APP_ID)).toBeUndefined()
    await expect(service.getData(CHAT_READER_APP_ID, 'chat:one')).rejects.toThrow('权限')
  })

  it('returns fresh directory metadata on explicit refresh rather than retaining a stale catalog', async () => {
    const resources = {
      listResourceListSummaries: vi
        .fn()
        .mockResolvedValueOnce([summary('one', 'chat')])
        .mockResolvedValueOnce([summary('role', 'characterCard')])
        .mockResolvedValueOnce([]),
    }
    const api = createChatReaderHost(resources as never, {} as never, ui)
    expect((await api.resources.directory()).chats).toHaveLength(1)
    expect((await api.resources.directory()).chats).toHaveLength(0)
    expect(resources.listResourceListSummaries).toHaveBeenCalledTimes(3)
  })
})

it('reads only actual indexed summaries and batches persisted states without loading originals', async () => {
  const db = new AppDatabase('native-directory-db-' + crypto.randomUUID())
  databases.push(db)
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    ...summary('chat-' + i, 'chat'),
    contentHash: 'hash-' + i,
    fileName: 'chat.jsonl',
    fileSize: 1024,
    createdAt: 1,
  }))
  rows.push({
    ...summary('role', 'characterCard'),
    contentHash: 'role-hash',
    fileName: 'role.png',
    fileSize: 4096,
    createdAt: 1,
  })
  await db.resources.bulkPut(
    rows.map((r) => ({ ...r, originalBlob: new Blob(['原件不得读取']) })) as never,
  )
  await db.resourceListSummaries.bulkPut(rows as never)
  await db.settings.put({ id: 'index.resourceListSummaries.v20', value: true, updatedAt: 1 })
  const storage = new IndexedDbResourceStorage(db),
    resources = new ResourceService(storage, {} as never)
  const full = vi.spyOn(storage, 'get'),
    scoped = vi.spyOn(storage, 'listResourceListSummaries')
  const api = createChatReaderHost(
    resources,
    new ExternalAppService(new IndexedDbExternalAppStorage(db)),
    ui,
  )
  const start = performance.now()
  const result = await api.resources.directory()
  console.info('actual-indexeddb-directory', {
    count: result.chats.length,
    ms: performance.now() - start,
    summaryQueries: scoped.mock.calls.length,
  })
  expect(result.chats).toHaveLength(1000)
  expect(result.characters).toHaveLength(1)
  expect(scoped).toHaveBeenCalledTimes(2)
  expect(full).not.toHaveBeenCalled()
})

it.each([4, 2])(
  'keeps thumbnail reads bounded at %i while preserving every result',
  async (concurrency) => {
    let active = 0,
      peak = 0
    const resources = {
      getSummary: vi.fn(async (id: string) => summary(id, 'characterCard')),
      get: vi.fn(),
      getThumbnail: vi.fn(async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        return new Blob(['thumb'], { type: 'image/png' })
      }),
    }
    const api = createChatReaderHost(resources as never, {} as never, ui, {
      thumbnailConcurrency: concurrency,
    })
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => api.resources.thumbnail('role-' + i)),
    )
    expect(results.every((blob) => blob?.size === 5)).toBe(true)
    expect(resources.getThumbnail).toHaveBeenCalledTimes(20)
    expect(peak).toBeLessThanOrEqual(concurrency)
    expect(resources.get).not.toHaveBeenCalled()
  },
)
it('releases queued thumbnail reads on close without starting more database reads', async () => {
  const releases: Array<(value: Blob) => void> = []
  const resources = {
    getSummary: vi.fn(async (id: string) => summary(id, 'characterCard')),
    get: vi.fn(),
    getThumbnail: vi.fn(() => new Promise<Blob>((resolve) => releases.push(resolve))),
  }
  const api = createChatReaderHost(resources as never, {} as never, ui)
  const pending = Array.from({ length: 20 }, (_, i) => api.resources.thumbnail('role-' + i))
  await vi.waitFor(() => expect(resources.getThumbnail).toHaveBeenCalledTimes(4))
  api.dispose()
  releases.forEach((resolve) => resolve(new Blob(['thumb'], { type: 'image/png' })))
  const results = await Promise.all(pending)
  expect(results.filter(Boolean)).toHaveLength(4)
  expect(resources.getThumbnail).toHaveBeenCalledTimes(4)
})

it('loads a card thumbnail asset without hydrating the original PNG', async () => {
  const db = new AppDatabase('native-thumbnail-db-' + crypto.randomUUID())
  databases.push(db)
  const assets = new IndexedDbAssetStore(db)
  const asset = await assets.put(
    new StructuredCloneBlob(['thumb'], { type: 'image/png' }) as unknown as Blob,
    { source: 'thumbnail' },
  )
  await db.resources.put({
    ...summary('role', 'characterCard'),
    thumbnailAssetId: asset.assetId,
    originalBlob: new Blob(['original']),
  } as never)
  const storage = new IndexedDbResourceStorage(db, undefined, assets),
    full = vi.spyOn(storage, 'get')
  const blob = await storage.getThumbnail('role')
  expect(blob?.size).toBe(5)
  expect(blob?.type).toBe('image/png')
  expect(full).not.toHaveBeenCalled()
})
