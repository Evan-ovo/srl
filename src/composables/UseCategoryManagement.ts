import { ref, type Ref } from 'vue'

import { categoryService } from '../core/AppContainer'
import { confirmAction } from './UseConfirmDialog'
import type { Category } from '../types/Resource'

interface CategoryManagementContext {
  /** 当前选中的文件夹；隐藏或删除后需要退回“全部文件夹”。 */
  activeCategoryId: Ref<string | null | undefined>
  /** 详情/管理类操作共用的忙碌标记。 */
  isOrganizing: Ref<boolean>
  showNotice: (message: string) => void
  loadCategories: () => Promise<void>
  loadLibrary: () => Promise<void>
}

/**
 * 文件夹（分类）管理。
 *
 * 隐藏只是本地展示与抽卡偏好，不删除资源、多分类关系与备份内容；
 * 删除文件夹只移除分类记录，其中资源退回“未放入文件夹”。
 */
export function useCategoryManagement(context: CategoryManagementContext) {
  // 管理面板使用非受控输入，完成一次操作后重建面板以清空草稿。
  const categoryManagerKey = ref(0)

  async function handleCategoryCreate(details: { name: string; color: string }): Promise<void> {
    context.isOrganizing.value = true
    try {
      await categoryService.create(details.name, details.color)
      await context.loadCategories()
      categoryManagerKey.value += 1
      context.showNotice('文件夹已创建')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '文件夹创建失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleCategoryUpdate(details: {
    category: Category
    name: string
    color: string
  }): Promise<void> {
    context.isOrganizing.value = true
    try {
      await categoryService.update(details.category, details.name, details.color)
      await context.loadCategories()
      categoryManagerKey.value += 1
      context.showNotice('文件夹已更新')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '文件夹更新失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleCategoryVisibility(category: Category): Promise<void> {
    context.isOrganizing.value = true
    const hidden = category.hidden !== true
    try {
      await categoryService.setHidden(category, hidden)
      if (hidden && context.activeCategoryId.value === category.id) {
        context.activeCategoryId.value = undefined
      }
      await context.loadCategories()
      categoryManagerKey.value += 1
      context.showNotice(
        hidden ? `“${category.name}”已从资源库和抽卡隐藏` : `“${category.name}”已恢复显示`,
      )
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '文件夹显示状态更新失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  async function handleCategoryDelete(category: Category): Promise<void> {
    const confirmed = await confirmAction({
      title: '删除文件夹',
      message: `确定删除文件夹“${category.name}”吗？其中资源会移到“未放入文件夹”。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!confirmed) return

    context.isOrganizing.value = true
    try {
      await categoryService.delete(category.id)
      if (context.activeCategoryId.value === category.id) {
        context.activeCategoryId.value = undefined
      }
      await context.loadLibrary()
      categoryManagerKey.value += 1
      context.showNotice('文件夹已删除，相关资源已移到未放入文件夹')
    } catch {
      context.showNotice('文件夹删除失败')
    } finally {
      context.isOrganizing.value = false
    }
  }

  return {
    categoryManagerKey,
    handleCategoryCreate,
    handleCategoryUpdate,
    handleCategoryVisibility,
    handleCategoryDelete,
  }
}
