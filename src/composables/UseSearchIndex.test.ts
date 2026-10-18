/** @vitest-environment jsdom */
import { Blob } from 'node:buffer'
import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceSummary } from '../types/Resource'

const storage = {
  getSearchHistory: vi.fn(() => [] as string[]),
  saveSearch: vi.fn((query: string) => [query]),
  clearSearchHistory: vi.fn(),
}
const resources = { get: vi.fn() }
const notice = { push: vi.fn() }
vi.mock('../core/NoticeCenter', () => ({ noticeCenter: notice }))

vi.mock('../core/AppContainer', () => ({
  browserStorageService: storage,
  resourceService: resources,
}))

const { useSearchIndex: createSearchIndex } = await import('./UseSearchIndex')
const scopes: ReturnType<typeof effectScope>[] = []
function useSearchIndex(...args: Parameters<typeof createSearchIndex>) {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => createSearchIndex(...args))!
}
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function summary(overrides: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: 'r1',
    name: '夜航船',
    fileName: 'night.png',
    description: '一段简介',
    tags: ['古风'],
    metadata: { author: '某人', authorNote: '备注者' },
    contentHash: 'hash-1',
    mimeType: 'image/png',
    ...overrides,
  } as ResourceSummary
}

describe('useSearchIndex', () => {
  it('shares an in-flight original across changed queries without reading it twice', async () => {
    let release!: (value: unknown) => void
    resources.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const items = [summary({ fileName: 'one.json' })]
    const search = useSearchIndex(ref(items), () => false)
    search.searchQuery.value = 'old'
    const old = search.refreshSearchContentIndex(items)
    search.searchQuery.value = 'new'
    const next = search.refreshSearchContentIndex(items)
    expect(resources.get).toHaveBeenCalledTimes(1)
    release({ contentHash: 'hash-1', originalBlob: new Blob(['old new']) })
    await Promise.all([old, next])
    expect(search.contentSearchQuery.value).toBe('new')
    expect(search.contentSearchMatchIds.value.has('r1')).toBe(true)
    expect(resources.get).toHaveBeenCalledTimes(1)
  })
  it('locking during a pending read does not restore the read cache', async () => {
    let release!: (value: unknown) => void
    resources.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const items = [summary({ fileName: 'one.json' })]
    const search = useSearchIndex(ref(items), () => true)
    search.searchQuery.value = 'secret'
    const old = search.refreshSearchContentIndex(items)
    search.resetSearchState()
    release({ contentHash: 'hash-1', originalBlob: new Blob(['secret']) })
    await old
    resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: new Blob(['new']) })
    search.searchQuery.value = 'new'
    await search.refreshSearchContentIndex(items)
    expect(resources.get).toHaveBeenCalledTimes(2)
    expect(search.contentSearchMatchIds.value.has('r1')).toBe(true)
  })
  it('输入改变即停止旧任务，等待中的一次读取结束后不继续遍历其余资源', async () => {
    let release!: (value: unknown) => void
    resources.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const items = Array.from({ length: 500 }, (_, id) =>
      summary({ id: String(id), fileName: `${id}.json` }),
    )
    const search = useSearchIndex(ref(items), () => false)
    search.searchQuery.value = 'old'
    const old = search.refreshSearchContentIndex(items)
    expect(resources.get).toHaveBeenCalledTimes(1)
    search.searchQuery.value = 'new'
    release({ contentHash: 'hash-1', originalBlob: new Blob(['old']) })
    await old
    expect(resources.get).toHaveBeenCalledTimes(1)
    expect(search.contentSearchQuery.value).toBe('')
    expect(search.isSearchIndexing.value).toBe(false)
    items[0]!.contentHash = 'changed-content'
    resources.get.mockResolvedValue({
      contentHash: 'changed-content',
      originalBlob: new Blob(['new']),
    })
    await search.refreshSearchContentIndex(items.slice(0, 1))
    expect(search.contentSearchMatchIds.value.has('0')).toBe(true)
  })
  beforeEach(() => {
    vi.clearAllMocks()
    storage.getSearchHistory.mockReturnValue([])
  })

  it('名称索引只含名称与文件名，正文索引只加入轻量字段', () => {
    const items = ref([summary()])
    const { nameSearchIndexById, searchIndexById } = useSearchIndex(items, () => false)
    expect(nameSearchIndexById.value.get('r1')).toContain('夜航船')
    expect(nameSearchIndexById.value.get('r1')).toContain('night.png')
    expect(nameSearchIndexById.value.get('r1')).not.toContain('一段简介')
    const entry = searchIndexById.value.get('r1')
    expect(entry?.name).toContain('夜航船')
    expect(entry?.name).toContain('night.png')
    expect(entry?.name).not.toContain('一段简介')
    expect(entry?.content).toContain('一段简介')
    expect(entry?.content).toContain('古风')
    expect(entry?.content).toContain('某人')
    expect(entry?.content).toContain('备注者')
    expect(entry?.name).not.toContain('备注者')
  })

  it('正文索引也不序列化任意元数据对象', () => {
    const serializeMetadata = vi.fn(() => '正文元数据')
    const items = ref([
      summary({
        metadata: {
          toJSON: serializeMetadata,
        },
      }),
    ])
    const { nameSearchIndexById, searchIndexById } = useSearchIndex(items, () => false)

    expect(nameSearchIndexById.value.get('r1')).toContain('night.png')
    expect(serializeMetadata).not.toHaveBeenCalled()
    expect(searchIndexById.value.get('r1')?.content).not.toContain('正文元数据')
    expect(serializeMetadata).not.toHaveBeenCalled()
  })

  it('元数据无法序列化时不影响索引构建', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const items = ref([summary({ metadata: circular as never })])
    const { searchIndexById } = useSearchIndex(items, () => false)
    expect(searchIndexById.value.get('r1')?.content).toContain('夜航船')
  })

  it('未开启保险库时搜索历史写入浏览器存储', () => {
    const { searchQuery, commitSearch, searchHistory } = useSearchIndex(ref([]), () => false)
    searchQuery.value = '夜航'
    commitSearch()
    expect(storage.saveSearch).toHaveBeenCalledWith('夜航')
    expect(searchHistory.value).toEqual(['夜航'])
  })

  it('开启保险库后搜索历史只留在当前会话，不落浏览器存储', () => {
    const { searchQuery, commitSearch, searchHistory } = useSearchIndex(ref([]), () => true)
    searchQuery.value = '夜航'
    commitSearch()
    expect(storage.saveSearch).not.toHaveBeenCalled()
    expect(searchHistory.value).toEqual(['夜航'])
  })

  it('保险库模式下重复关键词去重并保持最新在前，上限 10 条', () => {
    const { searchQuery, commitSearch, searchHistory } = useSearchIndex(ref([]), () => true)
    for (const word of ['a', 'b', 'A']) {
      searchQuery.value = word
      commitSearch()
    }
    expect(searchHistory.value).toEqual(['A', 'b'])

    for (let i = 0; i < 12; i += 1) {
      searchQuery.value = `k${i}`
      commitSearch()
    }
    expect(searchHistory.value).toHaveLength(10)
  })

  it('空白关键词不进入保险库模式的历史', () => {
    const { searchQuery, commitSearch, searchHistory } = useSearchIndex(ref([]), () => true)
    searchQuery.value = '   '
    commitSearch()
    expect(searchHistory.value).toEqual([])
  })

  it('上锁时清空关键词、历史与正文索引', async () => {
    const items = ref([summary({ mimeType: 'application/json' })])
    resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: new Blob(['内部正文']) })
    const index = useSearchIndex(items, () => true)
    index.searchQuery.value = '内部'
    await index.refreshSearchContentIndex(items.value)
    expect(index.contentSearchMatchIds.value.has('r1')).toBe(true)
    expect(index.contentSearchQuery.value).toBe('内部')

    index.searchQuery.value = '夜航'
    index.resetSearchState()
    expect(index.searchQuery.value).toBe('')
    expect(index.searchHistory.value).toEqual([])
    expect(index.contentSearchMatchIds.value.size).toBe(0)
    expect(storage.clearSearchHistory).toHaveBeenCalled()
  })

  it('无 Worker 降级路径不会把正文字符串留在主线程索引', async () => {
    const items = ref([summary({ mimeType: 'application/json' })])
    resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: new Blob(['内部正文']) })
    const index = useSearchIndex(items, () => false)
    index.searchQuery.value = '内部'
    await index.refreshSearchContentIndex(items.value)
    expect(index.contentSearchMatchIds.value.has('r1')).toBe(true)
    expect(index.searchIndexById.value.get('r1')?.content).not.toContain('内部正文')
    expect(resources.get).toHaveBeenCalledTimes(1)
  })

  it('原件读取失败显式标为未完成并给出稳定代码，而不是假装成功', async () => {
    const items = ref([summary({ mimeType: 'application/json' })])
    resources.get.mockRejectedValue(new Error('blob missing'))
    const index = useSearchIndex(items, () => false)
    index.searchQuery.value = '内部'
    await index.refreshSearchContentIndex(items.value)
    expect(index.contentSearchMatchIds.value.has('r1')).toBe(false)
    expect(index.isSearchIndexing.value).toBe(false)
    expect(index.contentSearchQuery.value).toBe('')
    expect(index.contentSearchError.value).toContain('SRL-SEARCH-ORIGINAL-READ')
    expect(notice.push).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  it('reuses 10,050 exact answers, safely narrows a query and rereads only a changed identity', async () => {
    const items = ref(
      Array.from({ length: 10_050 }, (_, id) =>
        summary({
          id: String(id),
          contentHash: `hash-${id}`,
          fileName: `${id}.json`,
        }),
      ),
    )
    const original = (id: string) => `${Number(id) % 3 === 0 ? 'NEEDLE' : 'hay'} other`
    resources.get.mockImplementation(async (id: string) => ({
      contentHash: items.value[Number(id)]!.contentHash,
      originalBlob: new Blob([
        items.value[Number(id)]!.contentHash === 'changed' ? 'replacement' : original(id),
      ]),
    }))
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    const expected = items.value
      .filter((item) => original(item.id).toLocaleLowerCase().includes('needle'))
      .map((item) => item.id)
    expect([...search.contentSearchMatchIds.value]).toEqual(expected)
    expect(resources.get).toHaveBeenCalledTimes(10_050)
    await search.refreshSearchContentIndex(items.value)
    expect([...search.contentSearchMatchIds.value]).toEqual(expected)
    expect(resources.get).toHaveBeenCalledTimes(10_050)
    search.searchQuery.value = 'needle extended'
    await search.refreshSearchContentIndex(items.value)
    expect(search.contentSearchMatchIds.value.size).toBe(0)
    expect(resources.get).toHaveBeenCalledTimes(13_400)
    items.value[0] = { ...items.value[0]!, contentHash: 'changed' }
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    expect(search.contentSearchMatchIds.value.has('0')).toBe(false)
    expect(search.contentSearchMatchIds.value.size).toBe(expected.length - 1)
    expect(resources.get).toHaveBeenCalledTimes(13_401)
    items.value = items.value.map((item) => ({ ...item, name: 'renamed' }))
    await search.refreshSearchContentIndex(items.value)
    expect(resources.get).toHaveBeenCalledTimes(13_401)
    search.resetSearchState()
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    expect(resources.get).toHaveBeenCalledTimes(23_451)
  }, 20_000)

  it.each([
    undefined,
    { contentHash: 'different', originalBlob: new Blob(['needle']) },
    { contentHash: 'hash-1' },
  ])('missing/mismatched original is an explicit read failure: %j', async (stored) => {
    resources.get.mockResolvedValue(stored)
    const items = ref([summary({ fileName: 'a.json' })])
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    expect(search.contentSearchQuery.value).toBe('')
    expect(search.contentSearchError.value).toContain('SRL-SEARCH-ORIGINAL-READ')
    expect(search.isSearchIndexing.value).toBe(false)
  })

  it('distinguishes content decoding failures and allows an explicit successful retry', async () => {
    const blob = new Blob(['needle'])
    vi.spyOn(blob, 'text').mockImplementationOnce(() => {
      throw new Error('private source body')
    })
    resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: blob })
    const items = ref([summary({ fileName: 'a.json' })])
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    expect(search.contentSearchError.value).toContain('SRL-SEARCH-CONTENT-SCAN')
    expect(search.contentSearchQuery.value).toBe('')
    await search.retryContentSearch()
    expect(search.contentSearchError.value).toBe('')
    expect(search.contentSearchQuery.value).toBe('needle')
    expect(search.contentSearchMatchIds.value.has('r1')).toBe(true)
  })

  it('does not notify when a superseded original read rejects after a new query', async () => {
    let reject!: (error: Error) => void
    resources.get.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    const items = ref([summary({ fileName: 'a.json' })])
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'old'
    const pending = search.refreshSearchContentIndex(items.value)
    search.searchQuery.value = 'new'
    reject(new Error('late private failure'))
    await pending
    expect(search.contentSearchError.value).toBe('')
    expect(notice.push).not.toHaveBeenCalled()
  })

  it.each(['error', 'messageerror'])(
    'clears all resident claims after Worker %s and retries from original content',
    async (failureEvent) => {
      const workers: MockWorker[] = []
      class MockWorker {
        listeners = new Map<string, Set<(event: unknown) => void>>()
        terminate = vi.fn()
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (!this.listeners.has(type)) this.listeners.set(type, new Set())
          this.listeners.get(type)!.add(listener)
        }
        removeEventListener(type: string, listener: (event: unknown) => void) {
          this.listeners.get(type)?.delete(listener)
        }
        postMessage(message: { type: string; requestId: number }) {
          if (message.type !== 'search') return
          queueMicrotask(() => {
            const type = workers.length === 1 ? failureEvent : 'message'
            const event =
              type !== 'message'
                ? { error: new Error('private Worker failure') }
                : {
                    data: {
                      type: 'result',
                      requestId: message.requestId,
                      matchedIds: ['r1'],
                      indexedHashes: ['hash-1'],
                    },
                  }
            this.listeners.get(type)?.forEach((listener) => listener(event))
          })
        }
        constructor() {
          workers.push(this)
        }
      }
      vi.stubGlobal('Worker', MockWorker)
      resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: new Blob(['needle']) })
      const items = ref([summary({ fileName: 'a.json' })])
      const search = useSearchIndex(items, () => false)
      search.searchQuery.value = 'needle'
      await search.refreshSearchContentIndex(items.value)
      expect(search.contentSearchError.value).toContain('SRL-SEARCH-WORKER')
      expect(workers[0]!.terminate).toHaveBeenCalledOnce()
      await search.retryContentSearch()
      expect(resources.get).toHaveBeenCalledTimes(2)
      expect(workers).toHaveLength(2)
      expect(search.contentSearchQuery.value).toBe('needle')
      expect(search.contentSearchError.value).toBe('')
    },
  )

  it('refreshes active body matches when actual content changes, but not on metadata-only edits', async () => {
    const items = ref([summary({ fileName: 'a.json' })])
    resources.get.mockImplementation(async () => ({
      contentHash: items.value[0]!.contentHash,
      originalBlob: new Blob([items.value[0]!.contentHash === 'hash-1' ? 'needle' : 'replacement']),
    }))
    const search = useSearchIndex(items, () => false)
    search.searchScope.value = 'content'
    search.searchQuery.value = 'needle'
    await search.refreshSearchContentIndex(items.value)
    items.value = [{ ...items.value[0]!, name: 'renamed' }]
    expect(resources.get).toHaveBeenCalledTimes(1)
    items.value = [{ ...items.value[0]!, contentHash: 'changed' }]
    expect(search.contentSearchQuery.value).toBe('')
    await vi.waitFor(() => expect(search.contentSearchQuery.value).toBe('needle'))
    expect(search.contentSearchMatchIds.value.size).toBe(0)
    expect(resources.get).toHaveBeenCalledTimes(2)
  })

  it('rejects missing content hashes rather than sharing unrelated originals under an empty key', async () => {
    const items = ref(
      ['first', 'second'].map((id) => summary({ id, contentHash: '', fileName: `${id}.json` })),
    )
    resources.get.mockImplementation(async (id: string) => ({
      contentHash: '',
      originalBlob: new Blob([id]),
    }))
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'first'
    await search.refreshSearchContentIndex(items.value)
    expect(search.contentSearchError.value).toContain('SRL-SEARCH-ORIGINAL-READ')
    expect(search.contentSearchQuery.value).toBe('')
    expect(search.contentSearchMatchIds.value.size).toBe(0)
    expect(resources.get).not.toHaveBeenCalled()
  })

  it('keeps the active scan when a metadata refresh only reorders the same content identities', async () => {
    const items = ref(
      ['a', 'b'].map((id) => summary({ id, contentHash: id, fileName: `${id}.json` })),
    )
    let release!: () => void
    resources.get.mockImplementation(async (id: string) => {
      if (id === 'a')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return { contentHash: id, originalBlob: new Blob(['needle']) }
    })
    const search = useSearchIndex(items, () => false)
    search.searchScope.value = 'content'
    search.searchQuery.value = 'needle'
    const pending = search.refreshSearchContentIndex(items.value)
    items.value = [...items.value].reverse().map((item) => ({ ...item, name: 'renamed' }))
    release()
    await pending
    expect(resources.get).toHaveBeenCalledTimes(2)
    expect(search.contentSearchQuery.value).toBe('needle')
    expect([...search.contentSearchMatchIds.value]).toEqual(['a', 'b'])
  })

  it.each(['read', 'scan'])(
    'source AbortError during an active %s is incomplete, not user cancellation',
    async (phase) => {
      const blob = new Blob(['needle'])
      if (phase === 'read')
        resources.get.mockRejectedValue(new DOMException('Source aborted', 'AbortError'))
      else {
        vi.spyOn(blob, 'text').mockImplementation(() => {
          throw new DOMException('Source aborted', 'AbortError')
        })
        resources.get.mockResolvedValue({ contentHash: 'hash-1', originalBlob: blob })
      }
      const items = ref([summary({ fileName: 'a.json' })])
      const search = useSearchIndex(items, () => false)
      search.searchQuery.value = 'needle'
      await search.refreshSearchContentIndex(items.value)
      expect(search.contentSearchError.value).toContain(
        phase === 'read' ? 'SRL-SEARCH-ORIGINAL-READ' : 'SRL-SEARCH-CONTENT-SCAN',
      )
      expect(search.contentSearchQuery.value).toBe('')
      expect(notice.push).toHaveBeenCalledOnce()
    },
  )

  it('prunes supplied hashes when a Worker result is queued but cancelled before delivery', async () => {
    type Request = {
      type: string
      requestId?: number
      hashes?: string[]
      items?: Array<{ id: string; contentHash: string; blob?: Blob }>
    }
    const messages: Request[] = []
    const resident = new Set<string>()
    const workers: MockWorker[] = []
    class MockWorker {
      listeners = new Set<(event: unknown) => void>()
      terminate = vi.fn()
      constructor() {
        workers.push(this)
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (type === 'message') this.listeners.add(listener)
      }
      removeEventListener(type: string, listener: (event: unknown) => void) {
        if (type === 'message') this.listeners.delete(listener)
      }
      postMessage(message: Request) {
        messages.push(message)
        if (message.type === 'search')
          for (const item of message.items ?? []) resident.add(item.contentHash)
        if (message.type === 'prune') for (const hash of message.hashes ?? []) resident.delete(hash)
      }
      deliver(request: Request) {
        for (const listener of this.listeners)
          listener({
            data: {
              type: 'result',
              requestId: request.requestId,
              matchedIds: request.items!.map((item) => item.id),
              indexedHashes: request.items!.map((item) => item.contentHash),
            },
          })
      }
    }
    vi.stubGlobal('Worker', MockWorker)
    resources.get.mockImplementation(async (id: string) => ({
      contentHash: id,
      originalBlob: new Blob(['old new']),
    }))
    const items = ref([summary({ id: 'old', contentHash: 'old', fileName: 'a.json' })])
    const search = useSearchIndex(items, () => false)
    search.searchQuery.value = 'old'
    const pending = search.refreshSearchContentIndex(items.value)
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === 'search')).toHaveLength(1),
    )
    const oldRequest = messages.find((message) => message.type === 'search')!
    expect(resident.has('old')).toBe(true)
    search.searchQuery.value = 'new'
    await pending
    expect(resident.has('old')).toBe(false)
    const prune = messages.findIndex((message) => message.type === 'prune')
    expect(messages[prune]!.hashes).toEqual(['old'])
    items.value = [summary({ id: 'new', contentHash: 'new', fileName: 'b.json' })]
    const next = search.refreshSearchContentIndex(items.value)
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === 'search')).toHaveLength(2),
    )
    const newRequest = messages.filter((message) => message.type === 'search')[1]!
    expect(messages.indexOf(newRequest)).toBeGreaterThan(prune)
    workers[0]!.deliver(oldRequest)
    expect(search.contentSearchQuery.value).toBe('')
    workers[0]!.deliver(newRequest)
    await next
    expect(search.contentSearchQuery.value).toBe('new')
    expect([...search.contentSearchMatchIds.value]).toEqual(['new'])
    expect([...resident]).toEqual(['new'])
  })
})
