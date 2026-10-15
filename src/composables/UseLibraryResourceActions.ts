import type { Ref } from 'vue'
import { RESOURCE_TYPE } from '../types/Resource'
import type { DetailTab } from './UseResourceOrganizer'
import { confirmAction } from '../composables/UseConfirmDialog'
import { exportService, resourceService } from '../core/LibraryContainer'
import { createNativeResourceDeepLink } from '../core/NativeRuntime'
import { referenceIndex } from '../core/ReferenceIndex'
import type { ResourceVersionView } from '../services/ResourceService'
import { createResourceArchiveSource } from '../services/ExportService'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import {
  getRelatedResourceIds,
  isUserPersonaAvatarAttachment,
  type Category,
  type Resource,
  type ResourceLink,
  type ResourceReference,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'
import { type CharacterCardOverrides } from '../utils/CharacterCardCustomization'
import { downloadBlob } from '../utils/LibraryFormatting'

interface LibraryResourceActionsContext {
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
  organizingResource: Ref<Resource | undefined>
  organizingInitialTab: Ref<'overview' | 'versions'>
  organizingBoundResources: Ref<Resource[]>
  organizingVersions: Ref<ResourceVersionView[]>
  layoutMode: Ref<'grid' | 'list' | 'split', 'grid' | 'list' | 'split'>
  isSplitWide: Ref<boolean, boolean>
  isBatchMode: Ref<boolean, boolean>
  selectedSplitResourceId: Ref<string | undefined>
  resources: Ref<ResourceSummary[]>
  moveResourcesToRecycleBin: (ids: string[]) => Promise<void>
  isOrganizing: Ref<boolean, boolean>
  loadResources: (ids?: string[]) => Promise<void>
  categories: Ref<Category[]>
}

export function useLibraryResourceActions(getContext: () => LibraryResourceActionsContext) {
  let isFavoriteBusy = false
  let detailGeneration = 0
  const detailReads = new Map<string, Promise<void>>()

  async function openResourceDetail(
    resource: ResourceReference,
    initialTab: 'overview' | 'versions' = 'overview',
  ): Promise<void> {
    const context = getContext()

    const generation = ++detailGeneration
    const fullResource =
      'originalBlob' in resource ? resource : await resourceService.get(resource.id)
    if (generation !== detailGeneration) return
    if (!fullResource) {
      context.showNotice('资源文件不存在或已被删除')
      return
    }
    context.organizingInitialTab.value = initialTab
    context.organizingResource.value = fullResource
    context.organizingBoundResources.value = []
    context.organizingVersions.value = []
  }

  async function prepareResourceDetail(tab: DetailTab): Promise<void> {
    const context = getContext(),
      resource = context.organizingResource.value
    if (!resource) return
    const versions = tab === 'versions'
    const related =
      tab === 'content' || (tab === 'overview' && resource.type === RESOURCE_TYPE.USER_PERSONA)
    if (!versions && !related) return
    const generation = detailGeneration
    const key = JSON.stringify([
      generation,
      resource.id,
      resource.contentHash,
      resource.updatedAt,
      versions,
    ])
    const existing = detailReads.get(key)
    if (existing) return existing
    const pending = (async () => {
      const valid = () =>
        generation === detailGeneration && context.organizingResource.value === resource
      if (versions) {
        const result = await resourceService.listVersions(resource.id)
        if (valid()) context.organizingVersions.value = result
      } else {
        const result: Resource[] = [],
          ids = getRelatedResourceIds(resource)
        for (let start = 0; start < ids.length; start += 4) {
          if (!valid()) return
          const batch = await Promise.all(
            ids.slice(start, start + 4).map((id) => resourceService.get(id)),
          )
          result.push(
            ...batch.flatMap((item) =>
              item && !isUserPersonaAvatarAttachment(item) ? [item] : [],
            ),
          )
        }
        if (valid()) context.organizingBoundResources.value = result
      }
    })().finally(() => {
      if (detailReads.get(key) === pending) detailReads.delete(key)
    })
    detailReads.set(key, pending)
    return pending
  }

  async function copyResourceDeepLink(resource: ResourceSummary): Promise<void> {
    const context = getContext()

    const link = createNativeResourceDeepLink(resource.id)
    if (!link) {
      context.showNotice('该资源编号不可用于生成本机链接')
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      context.showNotice('已复制本机链接；只在安装 SRL 的本机上可用')
    } catch {
      context.showNotice(`本机链接：${link}`, 8000)
    }
  }

  function closeResourceDetail(): void {
    const context = getContext()

    detailGeneration++
    context.organizingResource.value = undefined
    context.organizingBoundResources.value = []
    context.organizingVersions.value = []
  }

  function openResourceFromLayout(resource: ResourceSummary): void {
    const context = getContext()

    if (
      context.layoutMode.value === 'split' &&
      context.isSplitWide.value &&
      !context.isBatchMode.value
    ) {
      context.selectedSplitResourceId.value = resource.id
      return
    }
    void openResourceDetail(resource)
  }

  async function handleFavorite(resource: ResourceSummary, favorite: boolean): Promise<void> {
    const context = getContext()

    // iOS IndexedDB 事务慢，防双击冲突
    if (isFavoriteBusy) return
    isFavoriteBusy = true

    // 先乐观更新 UI，避免点击后无反馈
    const updatedAt = Date.now()
    context.resources.value = context.resources.value.map((item) =>
      item.id === resource.id ? { ...item, favorite, updatedAt } : item,
    )

    try {
      await resourceService.setFavorite(resource, favorite)
    } catch {
      // 持久化失败，回退 UI
      context.resources.value = context.resources.value.map((item) =>
        item.id === resource.id ? { ...item, favorite: !favorite, updatedAt } : item,
      )
      context.showNotice('收藏保存失败，请稍后重试')
    } finally {
      isFavoriteBusy = false
    }
  }

  async function handleDelete(resource: ResourceSummary): Promise<void> {
    const context = getContext()

    const impacts = referenceIndex.impacts('resource', resource.id)
    const impactSummary = impacts.length
      ? `\n\n引用影响：${impacts
          .slice(0, 4)
          .map(
            (impact) =>
              `${impact.label}（${impact.strength === 'strong' ? '强关系' : impact.strength === 'weak' ? '装配引用' : '仅界面固定'}）`,
          )
          .join(
            '；',
          )}${impacts.length > 4 ? `；另有 ${impacts.length - 4} 项` : ''}。移入回收站不会静默改写这些引用。`
      : ''
    const deleteConfirmed = await confirmAction({
      title: '删除资源',
      message: `确定将“${resource.name}”移入回收站吗？你可在“数据保护 → 回收站”中恢复或彻底删除。${impactSummary}`,
      confirmLabel: '移入回收站',
      danger: true,
    })
    if (!deleteConfirmed) return

    try {
      await context.moveResourcesToRecycleBin([resource.id])
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '移入回收站失败，请稍后重试')
    }
  }

  async function handleDetailSave(details: {
    name: string
    authorNote?: string
    description: string
    type: ResourceType
    categoryIds: string[]
    relatedResourceIds: string[]
    tags: string[]
    sourceLinks: ResourceLink[]
    characterOverrides?: CharacterCardOverrides
    characterContentEdits?: CharacterCardContentEdit[]
  }): Promise<void> {
    const context = getContext()

    const resource = context.organizingResource.value
    if (!resource) return

    context.isOrganizing.value = true
    try {
      await resourceService.updateDetails(resource, details)
      await context.loadResources([
        ...new Set([
          resource.id,
          ...getRelatedResourceIds(resource),
          ...details.relatedResourceIds,
        ]),
      ])
      if (context.organizingResource.value !== resource) return
      closeResourceDetail()
      context.showNotice('资源详情已保存')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '资源详情保存失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleRelatedDownload(resourceIds: string[]): Promise<void> {
    const context = getContext()

    const source = context.organizingResource.value
    if (!source || !resourceIds.length) return
    context.isOrganizing.value = true
    try {
      const archiveSource = await createResourceArchiveSource(resourceService, resourceIds)
      const [archive] = await exportService.createArchivesFromSource(
        archiveSource,
        context.categories.value,
        {
          mode: 'partial',
          resourceIds,
          includeAllCategories: false,
        },
      )
      if (!archive) throw new Error('所选关联文件已不存在')
      const safeName = source.name.replace(/[<>:"/\\|?*]/g, '_').trim() || '资源'
      downloadBlob(archive.blob, `${safeName}-配套文件.zip`)
      context.showNotice(`已打包下载 ${resourceIds.length} 个关联文件`)
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '关联文件下载失败')
    } finally {
      context.isOrganizing.value = false
    }
  }
  return {
    openResourceDetail,
    prepareResourceDetail,
    copyResourceDeepLink,
    closeResourceDetail,
    openResourceFromLayout,
    handleFavorite,
    handleDelete,
    handleDetailSave,
    handleRelatedDownload,
  }
}
