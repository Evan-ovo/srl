/** @vitest-environment jsdom */
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceSummary } from '../types/Resource'

const storage = {
  getSearchHistory: vi.fn(() => [] as string[]),
  saveSearch: vi.fn((query: string) => [query]),
  clearSearchHistory: vi.fn(),
}
const resources = { get: vi.fn() }

vi.mock('../core/AppContainer', () => ({
  browserStorageService: storage,
  resourceService: resources,
}))

const { useSearchIndex } = await import('./UseSearchIndex')

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
    release({ originalBlob: { size: 7, text: async () => 'old new' } })
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
    release({ originalBlob: { size: 6, text: async () => 'secret' } })
    await old
    resources.get.mockResolvedValue({ originalBlob: { size: 3, text: async () => 'new' } })
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
    release({ originalBlob: { text: async () => 'old' } })
    await old
    expect(resources.get).toHaveBeenCalledTimes(1)
    expect(search.contentSearchQuery.value).toBe('')
    expect(search.isSearchIndexing.value).toBe(false)
    items[0]!.contentHash = 'changed-content'
    resources.get.mockResolvedValue({ originalBlob: { text: async () => 'new' } })
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
    resources.get.mockResolvedValue({ originalBlob: { text: async () => '内部正文' } })
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
    resources.get.mockResolvedValue({ originalBlob: { text: async () => '内部正文' } })
    const index = useSearchIndex(items, () => false)
    index.searchQuery.value = '内部'
    await index.refreshSearchContentIndex(items.value)
    expect(index.contentSearchMatchIds.value.has('r1')).toBe(true)
    expect(index.searchIndexById.value.get('r1')?.content).not.toContain('内部正文')
    expect(resources.get).toHaveBeenCalledTimes(1)
  })

  it('单个资源读取失败时索引为空串而不是中断整轮', async () => {
    const items = ref([summary({ mimeType: 'application/json' })])
    resources.get.mockRejectedValue(new Error('blob missing'))
    const index = useSearchIndex(items, () => false)
    index.searchQuery.value = '内部'
    await index.refreshSearchContentIndex(items.value)
    expect(index.contentSearchMatchIds.value.has('r1')).toBe(false)
    expect(index.isSearchIndexing.value).toBe(false)
  })
})
