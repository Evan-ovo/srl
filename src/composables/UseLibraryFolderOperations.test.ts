/** @vitest-environment jsdom */
import { ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import { useLibraryFolderOperations } from './UseLibraryFolderOperations'
import type { Category } from '../types/Resource'

const service = vi.hoisted(() => ({
  list: vi.fn(),
  setCover: vi.fn(),
  updateDetails: vi.fn(),
  reorder: vi.fn(),
}))
vi.mock('../core/LibraryContainer', () => ({ categoryService: service }))
beforeEach(() => {
  vi.resetAllMocks()
  service.list.mockResolvedValue([{ id: 'folder', name: 'saved', coverImage: undefined }])
})
it.each(['cover', 'rename', 'reorder'])(
  'refreshes only categories after %s, preserving the resource catalogue',
  async (operation) => {
    const resources = ref(Array.from({ length: 10000 }, (_, i) => ({ id: `r-${i}` })))
    const previous = resources.value
    const context = {
      resources,
      categories: ref<Category[]>([]),
      isFolderViewBusy: ref(false),
      showNotice: vi.fn(),
      loadLibrary: vi.fn(),
    }
    const owner = useLibraryFolderOperations(() => context as never)
    const category = { id: 'folder', name: 'old' } as Category
    if (operation === 'cover') await owner.handleFolderCover({ category })
    if (operation === 'rename') await owner.handleFolderRename({ category, name: 'saved' })
    if (operation === 'reorder') await owner.handleFolderReorder(['folder'])
    expect(service.list).toHaveBeenCalledOnce()
    expect(context.loadLibrary).not.toHaveBeenCalled()
    expect(resources.value).toBe(previous)
    expect(context.categories.value[0]?.name).toBe('saved')
    expect(context.isFolderViewBusy.value).toBe(false)
  },
)
it('keeps the displayed categories when persistence fails', async () => {
  const categories = ref([{ id: 'folder', name: 'old' }] as Category[])
  const previous = categories.value
  const context = { categories, isFolderViewBusy: ref(false), showNotice: vi.fn() }
  service.setCover.mockRejectedValue(new Error('write failed'))
  await useLibraryFolderOperations(() => context as never).handleFolderCover({
    category: previous[0]!,
  })
  expect(categories.value).toBe(previous)
  expect(service.list).not.toHaveBeenCalled()
  expect(context.isFolderViewBusy.value).toBe(false)
})
