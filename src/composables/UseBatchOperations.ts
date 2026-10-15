import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'

import { resourceService } from '../core/AppContainer'
import { confirmAction } from './UseConfirmDialog'
import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'

interface BatchOperationsContext {
  /** 资源库轻量索引，批量收藏后就地更新，避免整库重读。 */
  resources: Ref<ResourceSummary[]>
  /** 当前页资源，决定“选择本页”的范围。 */
  paginatedResources: ComputedRef<ResourceSummary[]>
  /** 当前筛选结果，未选中文件夹时作为“全选”范围。 */
  filteredResources: ComputedRef<ResourceSummary[]>
  /** 已排除隐藏文件夹的资源，选中文件夹时按文件夹取全集。 */
  visibleLibraryResources: ComputedRef<ResourceSummary[]>
  activeCategoryId: Ref<string | null | undefined>
  activeCategoryLabel: ComputedRef<string>
  matchesCategory: (resource: ResourceSummary, categoryId: string | null | undefined) => boolean
  showNotice: (message: string) => void
  loadResources: (ids?: string[]) => Promise<void>
  moveToRecycleBin: (ids: string[]) => Promise<void>
}

/**
 * 多选模式与批量操作。
 *
 * 选择集合以资源 ID 保存，切换筛选不会丢失其他分类中已选中的项；
 * 批量删除进入回收站，支持恢复本次删除的资源。
 */
export function useBatchOperations(context: BatchOperationsContext) {
  const isBatchMode = ref(false)
  const isBatchBusy = ref(false)
  const selectedResourceIds = shallowRef(new Set<string>())

  const allVisibleSelected = computed(
    () =>
      context.paginatedResources.value.length > 0 &&
      context.paginatedResources.value.every((resource) =>
        selectedResourceIds.value.has(resource.id),
      ),
  )
  const batchSelectionScope = computed(() =>
    context.activeCategoryId.value === undefined
      ? context.filteredResources.value
      : context.visibleLibraryResources.value.filter((resource) =>
          context.matchesCategory(resource, context.activeCategoryId.value),
        ),
  )
  const allBatchScopeSelected = computed(
    () =>
      batchSelectionScope.value.length > 0 &&
      batchSelectionScope.value.every((resource) => selectedResourceIds.value.has(resource.id)),
  )
  const batchSelectionScopeLabel = computed(() =>
    context.activeCategoryId.value === undefined
      ? '筛选结果'
      : context.activeCategoryLabel.value || '当前文件夹',
  )
  const selectedCharacterCount = computed(() => {
    const ids = selectedResourceIds.value
    return context.resources.value.filter(
      (resource) =>
        ids.has(resource.id) &&
        (resource.type === RESOURCE_TYPE.CHARACTER_CARD || resource.type === RESOURCE_TYPE.PRESET),
    ).length
  })

  function toggleBatchMode(): void {
    isBatchMode.value = !isBatchMode.value
    selectedResourceIds.value = new Set()
  }

  function toggleResourceSelection(resource: ResourceSummary): void {
    const ids = new Set(selectedResourceIds.value)
    if (ids.has(resource.id)) ids.delete(resource.id)
    else ids.add(resource.id)
    selectedResourceIds.value = ids
  }

  function toggleVisibleSelection(): void {
    const ids = new Set(selectedResourceIds.value)
    if (allVisibleSelected.value) {
      for (const resource of context.paginatedResources.value) ids.delete(resource.id)
    } else {
      for (const resource of context.paginatedResources.value) ids.add(resource.id)
    }
    selectedResourceIds.value = ids
  }

  function toggleBatchScopeSelection(): void {
    const ids = new Set(selectedResourceIds.value)
    if (allBatchScopeSelected.value) {
      for (const resource of batchSelectionScope.value) ids.delete(resource.id)
    } else {
      for (const resource of batchSelectionScope.value) ids.add(resource.id)
    }
    selectedResourceIds.value = ids
  }

  function finishBatch(message: string): void {
    selectedResourceIds.value = new Set()
    isBatchMode.value = false
    context.showNotice(message)
  }

  async function handleBatchTag(details: { tag: string; action: 'add' | 'remove' }): Promise<void> {
    const ids = Array.from(selectedResourceIds.value)
    if (!ids.length) return
    isBatchBusy.value = true
    try {
      await resourceService.updateTagsMany(ids, details.tag, details.action)
      await context.loadResources(ids)
      finishBatch(
        details.action === 'add'
          ? `已为 ${ids.length} 项资源添加标签“${details.tag.trim()}”`
          : `已从 ${ids.length} 项资源移除标签“${details.tag.trim()}”`,
      )
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '批量标签保存失败')
    } finally {
      isBatchBusy.value = false
    }
  }

  async function handleBatchFavorite(favorite: boolean): Promise<void> {
    const ids = Array.from(selectedResourceIds.value)
    if (!ids.length) return
    isBatchBusy.value = true
    try {
      await resourceService.setFavoriteMany(ids, favorite)
      const selectedIds = new Set(ids)
      const updatedAt = Date.now()
      context.resources.value = context.resources.value.map((resource) =>
        selectedIds.has(resource.id) ? { ...resource, favorite, updatedAt } : resource,
      )
      finishBatch(favorite ? `已收藏 ${ids.length} 项资源` : `已取消收藏 ${ids.length} 项资源`)
    } catch {
      context.showNotice('批量收藏状态保存失败')
    } finally {
      isBatchBusy.value = false
    }
  }

  async function handleBatchMove(categoryId: string | null): Promise<void> {
    const ids = Array.from(selectedResourceIds.value)
    if (!ids.length) return
    isBatchBusy.value = true
    try {
      await resourceService.moveManyToCategory(ids, categoryId)
      await context.loadResources(ids)
      finishBatch(
        categoryId
          ? `已将 ${ids.length} 项资源加入文件夹`
          : `已清除 ${ids.length} 项资源的全部文件夹归属`,
      )
    } catch {
      context.showNotice('批量移动失败')
    } finally {
      isBatchBusy.value = false
    }
  }

  async function handleBatchExtractCharacterAssets(): Promise<void> {
    const ids = Array.from(selectedResourceIds.value)
    if (!selectedCharacterCount.value) return
    isBatchBusy.value = true
    try {
      const report = await resourceService.extractCharacterAssetsMany(ids)
      await context.loadResources()
      const existingCount = Math.max(0, report.assetCount - report.createdCount)
      finishBatch(
        report.assetCount
          ? `已拆分 ${report.characterCount} 张角色卡、${report.presetCount} 个预设：新增 ${report.createdCount} 项配套资源${existingCount ? `，复用并绑定 ${existingCount} 项` : ''}`
          : `已检查 ${report.characterCount} 张角色卡、${report.presetCount} 个预设，没有发现可拆分的内嵌世界书或整组正则`,
      )
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '配套资源拆分失败')
    } finally {
      isBatchBusy.value = false
    }
  }

  async function handleBatchDelete(): Promise<void> {
    const ids = Array.from(selectedResourceIds.value)
    if (!ids.length) return
    const confirmed = await confirmAction({
      title: '批量删除',
      message: `确定将选中的 ${ids.length} 项资源移入回收站吗？你可在“数据保护 → 回收站”中恢复或彻底删除。`,
      confirmLabel: '移入回收站',
      danger: true,
    })
    if (!confirmed) return
    isBatchBusy.value = true
    try {
      await context.moveToRecycleBin(ids)
      finishBatch(`已将 ${ids.length} 项资源移入回收站`)
    } catch {
      context.showNotice('批量删除失败')
    } finally {
      isBatchBusy.value = false
    }
  }

  return {
    isBatchMode,
    isBatchBusy,
    selectedResourceIds,
    allVisibleSelected,
    batchSelectionScope,
    allBatchScopeSelected,
    batchSelectionScopeLabel,
    selectedCharacterCount,
    toggleBatchMode,
    toggleResourceSelection,
    toggleVisibleSelection,
    toggleBatchScopeSelection,
    finishBatch,
    handleBatchTag,
    handleBatchFavorite,
    handleBatchMove,
    handleBatchExtractCharacterAssets,
    handleBatchDelete,
  }
}
