import type { ComputedRef, Ref } from 'vue'
import { nextTick } from 'vue'
import { browserStorageService, categoryService, resourceService } from '../core/LibraryContainer'
import { markLibraryListRendered, markLibraryLoadStarted } from '../core/PerformanceMonitor'
import { rebuildResourceReferenceIndex } from '../core/ResourceReferenceIndex'
import type { ResourceVersionView } from '../services/ResourceService'
import { type Category, type Resource, type ResourceSummary } from '../types/Resource'
import type { RestoreReport } from '../types/Backup'

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
  let categoryGeneration = 0
  let fullReadGeneration = 0
  let libraryReadGeneration = 0
  const activeFullReads = new Set<number>()
  let knownResources: ResourceSummary[] | undefined
  const targetedReads = new Map<string, number>()
  function publishResources(storedResources: ResourceSummary[], current: number): void {
    if (current !== generation) return
    getContext().resources.value = storedResources
    knownResources = getContext().resources.value
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
      fullReadGeneration = ++generation
      publishResources(storedResources, generation)
    }
  }

  async function loadResources(ids?: string[]): Promise<void> {
    const context = getContext()
    const previous = context.resources.value
    if (knownResources && knownResources !== previous) targetedReads.clear()
    knownResources = previous
    // An unfinished full read may contain rows absent from our current catalogue.
    if (ids && activeFullReads.has(fullReadGeneration)) {
      if (fullReadGeneration === libraryReadGeneration) return loadLibrary()
      ids = undefined
    }
    const current = ++generation
    const selected = ids ? Array.from(new Set(ids)) : []
    if (ids) for (const id of selected) targetedReads.set(id, current)
    else {
      fullReadGeneration = current
      activeFullReads.add(current)
    }
    try {
      if (ids) {
        const replacements = new Map<string, ResourceSummary | undefined>()
        for (let start = 0; start < selected.length; start += 250) {
          if (fullReadGeneration > current) return
          const batch = selected
            .slice(start, start + 250)
            .filter((id) => targetedReads.get(id) === current)
          if (!batch.length) continue
          const summaries = new Map(
            (await resourceService.getResourceListSummaries(batch)).map((summary) => [
              summary.id,
              summary,
            ]),
          )
          if (fullReadGeneration > current) return
          for (const id of batch) replacements.set(id, summaries.get(id))
        }
        for (const id of replacements.keys())
          if (targetedReads.get(id) !== current) replacements.delete(id)
        if (!replacements.size) return
        // A concurrent optimistic edit must not be overwritten by our captured list.
        if (knownResources !== context.resources.value) return loadResources()
        const merged = context.resources.value.flatMap((resource) => {
          if (!replacements.has(resource.id)) return [resource]
          const next = replacements.get(resource.id)
          replacements.delete(resource.id)
          return next ? [next] : []
        })
        merged.push(...Array.from(replacements.values()).flatMap((row) => (row ? [row] : [])))
        // Per-ID revisions allow disjoint reads to merge without replaying either query.
        publishResources(
          merged.sort((left, right) => right.updatedAt - left.updatedAt),
          generation,
        )
        return
      }
      const storedResources = await resourceService.listResourceListSummaries()
      publishResources(storedResources, current)
    } catch (error) {
      context.showNotice('资源列表读取失败，已保留上次显示的资源')
      throw error
    } finally {
      if (!ids) activeFullReads.delete(current)
      for (const id of selected) if (targetedReads.get(id) === current) targetedReads.delete(id)
    }
  }

  async function prepareCategoryRefresh(): Promise<() => void> {
    const current = ++categoryGeneration
    const categories = await categoryService.list()
    return () => {
      if (current === categoryGeneration) getContext().categories.value = categories
    }
  }

  async function loadCategories(): Promise<void> {
    const publishCategories = await prepareCategoryRefresh()
    publishCategories()
  }

  async function loadLibrary(): Promise<void> {
    const context = getContext()

    const current = ++generation
    fullReadGeneration = current
    libraryReadGeneration = current
    activeFullReads.add(current)
    markLibraryLoadStarted()
    try {
      const [storedResources, publishCategories] = await Promise.all([
        resourceService.listResourceListSummaries(),
        prepareCategoryRefresh(),
      ])
      if (current !== generation) return
      publishResources(storedResources, current)
      rebuildResourceReferenceIndex(storedResources, browserStorageService.getCabinetResourceIds())
      publishCategories()
      await nextTick()
      markLibraryListRendered(context.managedResources.value.length)
    } finally {
      activeFullReads.delete(current)
    }
  }

  async function handleLibraryChanged(
    changes?: Pick<RestoreReport, 'resourceIds' | 'categoriesChanged'>,
  ): Promise<void> {
    const context = getContext()
    if (changes?.resourceIds) {
      await Promise.all([
        changes.resourceIds.length ? loadResources(changes.resourceIds) : undefined,
        changes.categoriesChanged ? loadCategories() : undefined,
      ])
      if (changes.resourceIds.length)
        rebuildResourceReferenceIndex(
          context.resources.value,
          browserStorageService.getCabinetResourceIds(),
        )
      return
    }
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
    resourceIds?: string[]
    action: 'apply' | 'undo'
  }): Promise<void> {
    const context = getContext()

    // The writer reports committed IDs; old callers without this receipt retain a full reload.
    if (details.resourceIds) {
      if (details.resourceIds.length) await loadResources(details.resourceIds)
    } else await loadLibrary()
    context.showNotice(
      details.action === 'undo'
        ? `已从 ${details.resourceCount} 项资源撤销 ${details.tagCount} 个 AI 新增标签`
        : `已为 ${details.resourceCount} 项资源注入 ${details.tagCount} 个审核标签`,
    )
  }
  return {
    loadCategories,
    prepareResourceRefresh,
    loadResources,
    loadLibrary,
    handleLibraryChanged,
    refreshLibraryAndOpenVersions,
    handleAiTagsApplied,
  }
}
