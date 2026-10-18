/** @vitest-environment jsdom */
import { computed, ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import { useLibraryRefresh } from './UseLibraryRefresh'
import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'

const reads = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  batch: vi.fn(),
  categories: vi.fn(),
  references: vi.fn(),
}))
vi.mock('../core/LibraryContainer', () => ({
  resourceService: {
    listResourceListSummaries: reads.list,
    getResourceListSummary: reads.get,
    getResourceListSummaries: reads.batch,
  },
  categoryService: { list: reads.categories },
  browserStorageService: { getCabinetResourceIds: () => [] },
}))
vi.mock('../core/ResourceReferenceIndex', () => ({
  rebuildResourceReferenceIndex: reads.references,
}))

beforeEach(() => {
  reads.list.mockReset()
  reads.get.mockReset()
  reads.batch.mockReset()
  reads.categories.mockReset().mockResolvedValue([])
  reads.references.mockClear()
})

function setup(resources = ref<ResourceSummary[]>([])) {
  const showNotice = vi.fn()
  const categories = ref([])
  const context = {
    resources,
    categories,
    showNotice,
    managedResources: computed(() => resources.value),
  }
  return { resources, categories, showNotice, refresh: useLibraryRefresh(() => context as never) }
}

it('reads 501 committed summaries in three bounded queries instead of 501 individual requests', async () => {
  const initial = Array.from({ length: 10000 }, (_, index) => ({
    id: `r-${index}`,
    updatedAt: index,
  })) as ResourceSummary[]
  const { resources, refresh } = setup(ref(initial))
  const untouched = resources.value[9999]
  reads.batch.mockImplementation(async (ids) => ids.map((id: string) => ({ id, updatedAt: 10001 })))
  reads.get.mockImplementation(async (id: string) => ({ id, updatedAt: 10001 }))
  const ids = initial.slice(0, 501).map((resource) => resource.id)
  await refresh.loadResources([...ids, ids[0]!])
  expect(reads.get.mock.calls.length).toBe(0)
  expect(reads.batch.mock.calls.map(([ids]) => ids.length)).toEqual([250, 250, 1])
  expect(reads.list).not.toHaveBeenCalled()
  expect(resources.value).toHaveLength(10000)
  expect(resources.value.filter((resource) => resource.updatedAt === 10001)).toHaveLength(501)
  expect(resources.value.find((resource) => resource.id === 'r-9999')).toBe(untouched)
})

it('consumes the cloud restore commit scope without reloading unrelated rows, categories or recycle bin', async () => {
  const initial = Array.from({ length: 10000 }, (_, index) => ({
    id: `r-${index}`,
    updatedAt: index,
  })) as ResourceSummary[]
  const { refresh, resources } = setup(ref(initial))
  reads.batch.mockResolvedValue([{ id: 'restored', updatedAt: 10001 }])
  await refresh.handleLibraryChanged({ resourceIds: ['restored'], categoriesChanged: false })
  expect(reads.batch).toHaveBeenCalledExactlyOnceWith(['restored'])
  expect(reads.list).not.toHaveBeenCalled()
  expect(reads.categories).not.toHaveBeenCalled()
  expect(resources.value).toHaveLength(10001)
  expect(reads.references).toHaveBeenCalledExactlyOnceWith(resources.value, [])
  await refresh.handleLibraryChanged({ resourceIds: [], categoriesChanged: false })
  expect(reads.batch).toHaveBeenCalledOnce()
  await refresh.handleLibraryChanged({ resourceIds: [], categoriesChanged: true })
  expect(reads.categories).toHaveBeenCalledOnce()
})

it.each(['apply', 'undo'] as const)(
  'refreshes only committed AI tag IDs for %s and keeps other rows',
  async (action) => {
    const initial = Array.from({ length: 10000 }, (_, i) => ({
      id: `r-${i}`,
      tags: ['old'],
      updatedAt: i,
    })) as ResourceSummary[]
    const { resources, refresh, showNotice } = setup(ref(initial))
    const untouched = resources.value[100]
    reads.batch.mockImplementation(async (ids) =>
      ids.map((id: string) => ({
        id,
        tags: [action === 'apply' ? 'new' : 'old'],
        updatedAt: 10001,
      })),
    )
    await refresh.handleAiTagsApplied({
      resourceCount: 2,
      tagCount: 2,
      resourceIds: ['r-0', 'r-1', 'r-0'],
      action,
    })
    expect(reads.get).not.toHaveBeenCalled()
    expect(reads.batch).toHaveBeenCalledExactlyOnceWith(['r-0', 'r-1'])
    expect(reads.list).not.toHaveBeenCalled()
    expect(reads.categories).not.toHaveBeenCalled()
    expect(resources.value.find((row) => row.id === 'r-100')).toBe(untouched)
    expect(resources.value[0]?.tags).toEqual([action === 'apply' ? 'new' : 'old'])
    expect(showNotice).toHaveBeenCalledWith(
      expect.stringContaining(action === 'apply' ? '注入' : '撤销'),
    )
  },
)

it('does no reads when the writer reports no changed IDs; legacy callers retain a full refresh', async () => {
  const { refresh } = setup()
  await refresh.handleAiTagsApplied({
    resourceCount: 0,
    tagCount: 0,
    resourceIds: [],
    action: 'apply',
  })
  expect(reads.get).not.toHaveBeenCalled()
  expect(reads.list).not.toHaveBeenCalled()
  reads.list.mockResolvedValue([])
  await refresh.handleAiTagsApplied({ resourceCount: 1, tagCount: 1, action: 'apply' })
  expect(reads.list).toHaveBeenCalledOnce()
  expect(reads.categories).toHaveBeenCalledOnce()
})

it('does not show a successful refresh or replace the list when a committed tag receipt cannot be read', async () => {
  const { resources, refresh, showNotice } = setup(
    ref([{ id: 'r-0', tags: ['old'] }] as ResourceSummary[]),
  )
  const original = resources.value
  reads.batch.mockRejectedValue(new Error('read failed'))
  await expect(
    refresh.handleAiTagsApplied({
      resourceCount: 1,
      tagCount: 1,
      resourceIds: ['r-0'],
      action: 'apply',
    }),
  ).rejects.toThrow('read failed')
  expect(resources.value).toBe(original)
  expect(showNotice).toHaveBeenCalledOnce()
  expect(showNotice).toHaveBeenCalledWith(expect.stringContaining('读取失败'))
})

it('refreshes only selected committed summaries and removes missing selected rows', async () => {
  const initial = Array.from({ length: 10000 }, (_, i) => ({
    id: `r-${i}`,
    tags: ['old'],
  })) as ResourceSummary[]
  const { resources, refresh } = setup(ref(initial))
  const untouched = resources.value[2]
  reads.batch.mockResolvedValue([{ id: 'r-0', tags: ['saved'] }])
  await refresh.loadResources(['r-0', 'r-1', 'r-0'])
  expect(reads.get).not.toHaveBeenCalled()
  expect(reads.batch).toHaveBeenCalledExactlyOnceWith(['r-0', 'r-1'])
  expect(reads.list).not.toHaveBeenCalled()
  expect(resources.value[0]?.tags).toEqual(['saved'])
  expect(resources.value.some((r) => r.id === 'r-1')).toBe(false)
  expect(resources.value[1]).toBe(untouched)
})

it('never publishes a stale targeted refresh over a newer full refresh', async () => {
  const { resources, refresh } = setup(ref([{ id: 'r-0' }] as ResourceSummary[]))
  let finish!: (value: ResourceSummary[]) => void
  reads.batch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = refresh.loadResources(['r-0'])
  reads.list.mockResolvedValue([{ id: 'new-import' }])
  await refresh.loadResources()
  finish([{ id: 'r-0', tags: ['stale'] }] as ResourceSummary[])
  await pending
  expect(resources.value.map((r) => r.id)).toEqual(['new-import'])
})

it('adds committed new rows while updating existing rows and dropping missing selected IDs', async () => {
  const { resources, refresh } = setup(
    ref([
      { id: 'existing', updatedAt: 1 },
      { id: 'untouched', updatedAt: 2 },
    ] as ResourceSummary[]),
  )
  reads.batch.mockResolvedValue([
    { id: 'existing', updatedAt: 3 },
    { id: 'new', updatedAt: 4 },
  ])
  await refresh.loadResources(['existing', 'new', 'missing', 'new'])
  expect(resources.value.map((row) => row.id)).toEqual(['new', 'existing', 'untouched'])
  expect(reads.list).not.toHaveBeenCalled()
  expect(reads.batch).toHaveBeenCalledExactlyOnceWith(['existing', 'new', 'missing'])
})

it.each([true, false])(
  'merges disjoint concurrent commits regardless of completion order: %s',
  async (firstFinishesFirst) => {
    const { resources, refresh } = setup(
      ref([{ id: 'existing', updatedAt: 0 }] as ResourceSummary[]),
    )
    const complete: Array<(rows: ResourceSummary[]) => void> = []
    reads.batch.mockImplementation(() => new Promise((resolve) => complete.push(resolve)))
    const first = refresh.loadResources(['new-a'])
    const second = refresh.loadResources(['new-b'])
    const finish = async (index: number) => {
      complete[index]!([
        { id: index === 0 ? 'new-a' : 'new-b', updatedAt: index + 1 },
      ] as ResourceSummary[])
      await (index === 0 ? first : second)
    }
    await finish(firstFinishesFirst ? 0 : 1)
    await finish(firstFinishesFirst ? 1 : 0)
    expect(resources.value.map((row) => row.id)).toEqual(['new-b', 'new-a', 'existing'])
    expect(reads.list).not.toHaveBeenCalled()
    expect(reads.batch.mock.calls.map(([ids]) => ids)).toEqual([['new-a'], ['new-b']])
  },
)

it('keeps the newest same-ID read while still accepting an older disjoint result', async () => {
  const { resources, refresh } = setup(
    ref([
      { id: 'a', updatedAt: 0 },
      { id: 'b', updatedAt: 0 },
    ] as ResourceSummary[]),
  )
  let finish!: (rows: ResourceSummary[]) => void
  reads.batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const older = refresh.loadResources(['a', 'b'])
  reads.batch.mockResolvedValueOnce([{ id: 'b', updatedAt: 3, name: 'latest' }])
  await refresh.loadResources(['b'])
  finish([
    { id: 'a', updatedAt: 2 },
    { id: 'b', updatedAt: 1, name: 'stale' },
  ] as ResourceSummary[])
  await older
  expect(resources.value.map((row) => [row.id, row.updatedAt])).toEqual([
    ['b', 3],
    ['a', 2],
  ])
  expect(resources.value[0]?.name).toBe('latest')
  expect(reads.list).not.toHaveBeenCalled()
})

it('retains unknown rows from an overlapping full catalogue when a targeted commit follows', async () => {
  let finish!: (rows: ResourceSummary[]) => void
  reads.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const newest = [
    { id: 'unknown-from-background', updatedAt: 2 },
    { id: 'new', updatedAt: 3 },
  ] as ResourceSummary[]
  reads.list.mockResolvedValueOnce(newest)
  reads.batch.mockResolvedValue([{ id: 'new', updatedAt: 3 }])
  const { resources, refresh } = setup()
  const full = refresh.loadResources()
  await refresh.loadResources(['new'])
  reads.batch.mockResolvedValueOnce([{ id: 'new', updatedAt: 4 }])
  await refresh.loadResources(['new'])
  expect(reads.batch).toHaveBeenCalledExactlyOnceWith(['new'])
  expect(resources.value.find((row) => row.id === 'new')?.updatedAt).toBe(4)
  finish([{ id: 'older-full' }] as ResourceSummary[])
  await full
  expect(resources.value.map((row) => row.id)).toEqual(['new', 'unknown-from-background'])
})

it('does not read remaining old batches after all their IDs are superseded', async () => {
  const { resources, refresh } = setup()
  const ids = Array.from({ length: 501 }, (_, index) => String(index))
  let finish!: (rows: ResourceSummary[]) => void
  reads.batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const older = refresh.loadResources(ids)
  reads.batch.mockImplementation(async (selected) =>
    selected.map((id: string) => ({ id, updatedAt: 2 })),
  )
  await refresh.loadResources(ids)
  finish(ids.slice(0, 250).map((id) => ({ id, updatedAt: 1 })) as ResourceSummary[])
  await older
  expect(reads.batch.mock.calls.map(([selected]) => selected.length)).toEqual([250, 250, 250, 1])
  expect(resources.value).toHaveLength(501)
  expect(resources.value.every((row) => row.updatedAt === 2)).toBe(true)
})

it('releases a failed targeted read so an explicit retry can publish its new row', async () => {
  const { resources, refresh } = setup()
  reads.batch.mockRejectedValueOnce(new Error('failed'))
  await expect(refresh.loadResources(['new'])).rejects.toThrow('failed')
  reads.batch.mockResolvedValueOnce([{ id: 'new', updatedAt: 1 }])
  await refresh.loadResources(['new'])
  expect(resources.value.map((row) => row.id)).toEqual(['new'])
  expect(reads.list).not.toHaveBeenCalled()
})

it('keeps categories and reference initialization when a commit overlaps loadLibrary', async () => {
  const { resources, categories, refresh } = setup()
  let finish!: (rows: ResourceSummary[]) => void
  reads.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  reads.list.mockResolvedValueOnce([{ id: 'new', updatedAt: 2 }])
  reads.categories.mockResolvedValue([{ id: 'folder' }])
  const full = refresh.loadLibrary()
  await refresh.loadResources(['new'])
  finish([{ id: 'stale' }] as ResourceSummary[])
  await full
  expect(resources.value.map((row) => row.id)).toEqual(['new'])
  expect(reads.categories).toHaveBeenCalledTimes(2)
  expect(categories.value).toEqual([{ id: 'folder' }])
  expect(reads.references).toHaveBeenCalledExactlyOnceWith(resources.value, [])
})

it('refreshes categories without reading resources, rebuilding references or discarding an in-flight committed row', async () => {
  const { resources, categories, refresh } = setup()
  let finish!: (rows: ResourceSummary[]) => void
  reads.batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const row = refresh.loadResources(['new'])
  reads.categories.mockResolvedValue([{ id: 'folder', hidden: true }])
  await refresh.loadCategories()
  finish([{ id: 'new', updatedAt: 1 }] as ResourceSummary[])
  await row
  expect(categories.value).toEqual([{ id: 'folder', hidden: true }])
  expect(resources.value.map((row) => row.id)).toEqual(['new'])
  expect(reads.list).not.toHaveBeenCalled()
  expect(reads.references).not.toHaveBeenCalled()
})

it('does not let old full initialization overwrite newer category readback', async () => {
  const { resources, categories, refresh } = setup()
  let finish!: (rows: unknown[]) => void
  reads.categories.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  reads.list.mockResolvedValue([{ id: 'initial' }])
  const initial = refresh.loadLibrary()
  reads.categories.mockResolvedValueOnce([{ id: 'folder', name: 'new' }])
  await refresh.loadCategories()
  finish([{ id: 'folder', name: 'stale' }])
  await initial
  expect(categories.value).toEqual([{ id: 'folder', name: 'new' }])
  expect(resources.value.map((row) => row.id)).toEqual(['initial'])
})

it('keeps the newest category read and preserves it after an explicit refresh failure', async () => {
  const { categories, refresh } = setup()
  let finish!: (rows: unknown[]) => void
  reads.categories.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const old = refresh.loadCategories()
  reads.categories.mockResolvedValueOnce([{ id: 'new' }])
  await refresh.loadCategories()
  finish([{ id: 'stale' }])
  await old
  reads.categories.mockRejectedValueOnce(new Error('failed'))
  await expect(refresh.loadCategories()).rejects.toThrow('failed')
  expect(categories.value).toEqual([{ id: 'new' }])
  expect(reads.list).not.toHaveBeenCalled()
})

it('keeps both old lists when a full refresh cannot read resources', async () => {
  const { resources, categories, refresh } = setup(
    ref([{ id: 'old-resource' }] as ResourceSummary[]),
  )
  reads.categories.mockResolvedValue([{ id: 'old-folder' }])
  await refresh.loadCategories()
  reads.categories.mockResolvedValue([{ id: 'new-folder' }])
  reads.list.mockRejectedValue(new Error('resource catalogue failed'))
  await expect(refresh.loadLibrary()).rejects.toThrow('resource catalogue failed')
  expect(resources.value.map((row) => row.id)).toEqual(['old-resource'])
  expect(categories.value).toEqual([{ id: 'old-folder' }])
})

it('invalidates an old targeted read when an optimistic edit is followed by another targeted publication', async () => {
  const { resources, refresh } = setup(ref([{ id: 'a', updatedAt: 0 }] as ResourceSummary[]))
  let finish!: (rows: ResourceSummary[]) => void
  reads.batch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const old = refresh.loadResources(['a'])
  resources.value = [{ id: 'a', updatedAt: 5, name: 'optimistic' }] as ResourceSummary[]
  reads.batch.mockResolvedValueOnce([{ id: 'b', updatedAt: 6 }])
  await refresh.loadResources(['b'])
  finish([{ id: 'a', updatedAt: 1, name: 'stale' }] as ResourceSummary[])
  await old
  expect(resources.value.map((row) => row.id)).toEqual(['b', 'a'])
  expect(resources.value[1]?.name).toBe('optimistic')
  expect(reads.list).not.toHaveBeenCalled()
})

it('falls back to a fresh catalogue if an optimistic edit intervenes', async () => {
  const { resources, refresh } = setup(ref([{ id: 'r-0' }] as ResourceSummary[]))
  reads.batch.mockImplementationOnce(async () => {
    resources.value = [{ id: 'concurrent' }] as ResourceSummary[]
    return [{ id: 'r-0' }]
  })
  reads.list.mockResolvedValue([{ id: 'latest' }])
  await refresh.loadResources(['r-0'])
  expect(resources.value.map((r) => r.id)).toEqual(['latest'])
  expect(reads.list).toHaveBeenCalledOnce()
})

it.each([1000, 10000])(
  'reuses a complete %i-item committed catalogue without another database read',
  async (size) => {
    const original: ResourceSummary[] = Array.from({ length: size }, (_, index) => ({
      id: `r-${index}`,
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name: `角色${index}`,
      fileName: `${index}.png`,
      mimeType: 'image/png',
      fileSize: index,
      contentHash: String(index).padStart(64, '0'),
      description: '',
      tags: ['保留标签'],
      categoryId: null,
      favorite: index % 2 === 0,
      createdAt: index,
      updatedAt: index,
      metadata: { manuallyBoundResourceIds: ['r-1'] },
    }))
    const { resources, refresh } = setup(ref(original))
    const apply = refresh.prepareResourceRefresh()
    const remaining = original.slice(1)
    await apply(remaining)
    expect(reads.list).not.toHaveBeenCalled()
    expect(resources.value).toHaveLength(size - 1)
    expect(resources.value.map((resource) => resource.id)).toEqual(
      remaining.map((resource) => resource.id),
    )
    expect(resources.value[0]?.metadata).toEqual(remaining[0]?.metadata)
  },
)

it('invalidates an older in-flight read when a committed catalogue is published', async () => {
  let finish!: (resources: ResourceSummary[]) => void
  reads.list.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const { resources, refresh } = setup()
  const old = refresh.loadResources()
  const apply = refresh.prepareResourceRefresh()
  const committed = [{ id: 'survivor' }] as ResourceSummary[]
  await apply(committed)
  finish([{ id: 'deleted' }] as ResourceSummary[])
  await old
  expect(resources.value).toEqual(committed)
  expect(reads.list).toHaveBeenCalledOnce()
})

it('rereads when a newer refresh starts during deletion, without later reviving an old read', async () => {
  let finish!: (resources: ResourceSummary[]) => void
  const newest = [{ id: 'imported' }] as ResourceSummary[]
  reads.list
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockResolvedValueOnce(newest)
  const { resources, refresh } = setup()
  const apply = refresh.prepareResourceRefresh()
  const overlapping = refresh.loadResources()
  await apply([{ id: 'stale-survivor' }] as ResourceSummary[])
  finish([{ id: 'old' }] as ResourceSummary[])
  await overlapping
  expect(resources.value).toEqual(newest)
  expect(reads.list).toHaveBeenCalledTimes(2)
})

it('rereads after a direct optimistic list replacement, and keeps it if the reread fails', async () => {
  const newest = [{ id: 'updated' }] as ResourceSummary[]
  const { resources, showNotice, refresh } = setup()
  const apply = refresh.prepareResourceRefresh()
  resources.value = newest
  reads.list.mockRejectedValueOnce(new Error('read failed'))
  await expect(apply([{ id: 'stale' }] as ResourceSummary[])).rejects.toThrow('read failed')
  expect(resources.value).toEqual(newest)
  expect(showNotice).toHaveBeenCalledOnce()
})

it('keeps the full-read compatibility path when no committed catalogue is supplied', async () => {
  const newest = [{ id: 'existing' }] as ResourceSummary[]
  reads.list.mockResolvedValueOnce(newest)
  const { resources, refresh } = setup()
  await refresh.prepareResourceRefresh()()
  expect(resources.value).toEqual(newest)
  expect(reads.list).toHaveBeenCalledOnce()
})

it('only publishes the newest accepted summary read, without reloading original files', async () => {
  let finishOld!: (resources: ResourceSummary[]) => void
  const newest = [{ id: 'new' }] as ResourceSummary[]
  reads.list
    .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
    .mockResolvedValueOnce(newest)
  const resources = ref<ResourceSummary[]>([])
  const context = {
    resources,
    showNotice: vi.fn(),
    managedResources: computed(() => resources.value),
  }
  const refresh = useLibraryRefresh(() => context as never)
  const published = vi.fn()
  window.addEventListener('srl:library-resources-changed', published)
  try {
    const old = refresh.loadResources()
    await refresh.loadResources()
    finishOld([{ id: 'old' }] as ResourceSummary[])
    await old
    expect(resources.value).toEqual(newest)
    expect(published).toHaveBeenCalledOnce()
    expect((published.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(newest)
    expect(reads.list).toHaveBeenCalledTimes(2)
  } finally {
    window.removeEventListener('srl:library-resources-changed', published)
  }
})
