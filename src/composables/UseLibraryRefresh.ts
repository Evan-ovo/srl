import type { ComputedRef, Ref } from 'vue'
import { nextTick } from 'vue'
import { browserStorageService, categoryService, resourceService } from '../core/LibraryContainer'
import { markLibraryListRendered, markLibraryLoadStarted } from '../core/PerformanceMonitor'
import { rebuildResourceReferenceIndex } from '../core/ResourceReferenceIndex'
import type { ResourceVersionView } from '../services/ResourceService'
import { type Category, type Resource, type ResourceSummary } from '../types/Resource'

interface LibraryRefreshContext {
  resources: Ref<ResourceSummary[]>
  categories: Ref<Category[]>
  managedResources: ComputedRef<ResourceSummary[]>
  loadRecycleBin: () => Promise<void>
  organizingResource: Ref<Resource | undefined>
  closeResourceDetail: () => void
  organizingVersions: Ref<ResourceVersionView[]>
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
}

export function useLibraryRefresh(getContext: () => LibraryRefreshContext) {
  let generation = 0
  function publishResources(storedResources: ResourceSummary[], current: number): void {
    if (current !== generation) return
    getContext().resources.value = storedResources
    window.dispatchEvent(
      new CustomEvent('srl:library-resources-changed', { detail: storedResources }),
    )
  }

  /** Reuse a committed catalogue only if no newer refresh or local list edit intervened. */
  function prepareResourceRefresh(): (resources?: ResourceSummary[]) => Promise<void> {
    const current = generation
    const resources = getContext().resources.value
    return async (storedResources) => {
      if (
        !storedResources ||
        current !== generation ||
        resources !== getContext().resources.value
      ) {
        await loadResources()
        return
      }
      publishResources(storedResources, ++generation)
    }
  }

  async function loadResources(): Promise<void> {
    const context = getContext()

    const current = ++generation
    try {
      const storedResources = await resourceService.listResourceListSummaries()
      publishResources(storedResources, current)
    } catch (error) {
      context.showNotice('资源列表读取失败，已保留上次显示的资源')
      throw error
    }
  }

  async function loadLibrary(): Promise<void> {
    const context = getContext()

    const current = ++generation
    markLibraryLoadStarted()
    const [storedResources, storedCategories] = await Promise.all([
      resourceService.listResourceListSummaries(),
      categoryService.list(),
    ])
    if (current !== generation) return
    publishResources(storedResources, current)
    rebuildResourceReferenceIndex(storedResources, browserStorageService.getCabinetResourceIds())
    context.categories.value = storedCategories
    await nextTick()
    markLibraryListRendered(context.managedResources.value.length)
  }

  async function handleLibraryChanged(): Promise<void> {
    const context = getContext()

    await Promise.all([loadLibrary(), context.loadRecycleBin()])
  }

  async function refreshLibraryAndOpenVersions(): Promise<void> {
    const context = getContext()

    await loadLibrary()
    const openResourceId = context.organizingResource.value?.id
    if (!openResourceId) return
    const refreshed = await resourceService.get(openResourceId)
    if (!refreshed) {
      context.closeResourceDetail()
      return
    }
    context.organizingResource.value = refreshed
    context.organizingVersions.value = await resourceService.listVersions(openResourceId)
  }

  async function handleAiTagsApplied(details: {
    resourceCount: number
    tagCount: number
    action: 'apply' | 'undo'
  }): Promise<void> {
    const context = getContext()

    await loadLibrary()
    context.showNotice(
      details.action === 'undo'
        ? `已从 ${details.resourceCount} 项资源撤销 ${details.tagCount} 个 AI 新增标签`
        : `已为 ${details.resourceCount} 项资源注入 ${details.tagCount} 个审核标签`,
    )
  }
  return {
    prepareResourceRefresh,
    loadResources,
    loadLibrary,
    handleLibraryChanged,
    refreshLibraryAndOpenVersions,
    handleAiTagsApplied,
  }
}
