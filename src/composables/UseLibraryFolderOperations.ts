import type { Ref } from 'vue'
import { browserStorageService, categoryService, resourceService } from '../core/LibraryContainer'
import { type Category, type ResourceSummary } from '../types/Resource'
import { createFolderCoverDataUrl, normalizeFolderCoverUrl } from '../utils/FolderCover'

interface LibraryFolderOperationsContext {
  isSettingsOpen: Ref<boolean, boolean>
  isCategoryManagerOpen: Ref<boolean, boolean>
  isFolderViewBusy: Ref<boolean, boolean>
  loadResources: (ids?: string[]) => Promise<void>
  cabinetResourceIds: Ref<string[], string[]>
  categories: Ref<Category[]>
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
  resources: Ref<ResourceSummary[]>
}

export function useLibraryFolderOperations(getContext: () => LibraryFolderOperationsContext) {
  function openFolderSettings(): void {
    const context = getContext()

    context.isSettingsOpen.value = false
    context.isCategoryManagerOpen.value = true
  }

  async function handleFolderAdd(details: {
    categoryId: string
    resourceIds: string[]
    removeFromCabinet?: boolean
  }): Promise<void> {
    const context = getContext()

    if (!details.resourceIds.length || context.isFolderViewBusy.value) return
    context.isFolderViewBusy.value = true
    try {
      await resourceService.moveManyToCategory(details.resourceIds, details.categoryId)
      await context.loadResources(details.resourceIds)
      if (details.removeFromCabinet) {
        const movedIds = new Set(details.resourceIds)
        context.cabinetResourceIds.value = context.cabinetResourceIds.value.filter(
          (id) => !movedIds.has(id),
        )
        browserStorageService.setCabinetResourceIds(context.cabinetResourceIds.value)
      }
      const folderName = context.categories.value.find(
        (category) => category.id === details.categoryId,
      )?.name
      context.showNotice(
        `已将 ${details.resourceIds.length} 项资源加入${folderName ? `“${folderName}”` : '文件夹'}`,
      )
    } catch {
      context.showNotice('资源加入文件夹失败')
    } finally {
      context.isFolderViewBusy.value = false
    }
  }

  async function handleFolderCover(details: {
    category: Category
    file?: File
    coverUrl?: string
  }): Promise<void> {
    const context = getContext()

    if (context.isFolderViewBusy.value) return
    context.isFolderViewBusy.value = true
    try {
      const coverImage = details.file
        ? await createFolderCoverDataUrl(details.file)
        : details.coverUrl
          ? normalizeFolderCoverUrl(details.coverUrl)
          : undefined
      await categoryService.setCover(details.category, coverImage)
      context.categories.value = await categoryService.list()
      context.showNotice(coverImage ? '文件夹封面已保存' : '已恢复自动文件夹封面')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '文件夹封面保存失败')
    } finally {
      context.isFolderViewBusy.value = false
    }
  }

  function handleCabinetPin(resourceIds: string[]): void {
    const context = getContext()

    const availableIds = new Set(context.resources.value.map((resource) => resource.id))
    context.cabinetResourceIds.value = Array.from(
      new Set([
        ...context.cabinetResourceIds.value.filter((id) => availableIds.has(id)),
        ...resourceIds.filter((id) => availableIds.has(id)),
      ]),
    )
    browserStorageService.setCabinetResourceIds(context.cabinetResourceIds.value)
    context.showNotice(`已将 ${resourceIds.length} 项资源放到收藏柜桌面`)
  }

  function handleCabinetUnpin(resourceId: string): void {
    const context = getContext()

    const nextResourceIds = context.cabinetResourceIds.value.filter((id) => id !== resourceId)
    if (nextResourceIds.length === context.cabinetResourceIds.value.length) return
    const resourceName = context.resources.value.find(
      (resource) => resource.id === resourceId,
    )?.name
    context.cabinetResourceIds.value = nextResourceIds
    browserStorageService.setCabinetResourceIds(nextResourceIds)
    context.showNotice(`已将“${resourceName ?? '资源'}”从收藏柜桌面移除，资源本身仍保留在资源库中`)
  }

  async function handleFolderRename(details: {
    category: Category
    name: string
    coverChanged?: boolean
    coverImage?: string
    file?: File
  }): Promise<void> {
    const context = getContext()

    if (context.isFolderViewBusy.value) return
    context.isFolderViewBusy.value = true
    try {
      const coverImage = details.coverChanged
        ? details.file
          ? await createFolderCoverDataUrl(details.file)
          : details.coverImage
            ? normalizeFolderCoverUrl(details.coverImage)
            : undefined
        : details.category.coverImage
      await categoryService.updateDetails(details.category, {
        name: details.name,
        coverImage,
      })
      context.categories.value = await categoryService.list()
      context.showNotice(details.coverChanged ? '文件夹名称和封面已更新' : '文件夹名称已更新')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '文件夹信息更新失败')
    } finally {
      context.isFolderViewBusy.value = false
    }
  }

  async function handleFolderReorder(categoryIds: string[]): Promise<void> {
    const context = getContext()

    if (context.isFolderViewBusy.value || !categoryIds.length) return
    context.isFolderViewBusy.value = true
    try {
      await categoryService.reorder(categoryIds)
      context.categories.value = await categoryService.list()
      context.showNotice('文件夹位置已保存')
    } catch {
      context.showNotice('文件夹位置保存失败')
    } finally {
      context.isFolderViewBusy.value = false
    }
  }

  function openFolderManagerFromFeatureHub(): void {
    const context = getContext()

    context.isCategoryManagerOpen.value = true
  }
  return {
    openFolderSettings,
    handleFolderAdd,
    handleFolderCover,
    handleCabinetPin,
    handleCabinetUnpin,
    handleFolderRename,
    handleFolderReorder,
    openFolderManagerFromFeatureHub,
  }
}
