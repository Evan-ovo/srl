import type { CategoryStorageAdapter } from '../storage/CategoryStorageAdapter'
import type { Category } from '../types/Resource'
import { isValidFolderCoverImage } from '../utils/FolderCover'

const MAX_CATEGORY_NAME_LENGTH = 40
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i

function normalizeName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error('文件夹名称不能为空')
  if (normalized.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new Error(`文件夹名称不能超过 ${MAX_CATEGORY_NAME_LENGTH} 个字符`)
  }
  return normalized
}

function normalizeColor(color: string): string {
  if (!COLOR_PATTERN.test(color)) throw new Error('文件夹颜色格式无效')
  return color.toLowerCase()
}

export class CategoryService {
  private readonly storage: CategoryStorageAdapter

  constructor(storage: CategoryStorageAdapter) {
    this.storage = storage
  }

  list(): Promise<Category[]> {
    return this.storage.list()
  }

  async create(name: string, color: string): Promise<void> {
    const normalizedName = normalizeName(name)
    const categories = await this.ensureUniqueName(normalizedName)
    const now = Date.now()
    await Promise.all(
      categories.flatMap((category, index) =>
        Number.isFinite(category.sortOrder)
          ? []
          : [this.storage.update(category.id, { sortOrder: index })],
      ),
    )
    const sortOrder = categories.length

    await this.storage.save({
      id: crypto.randomUUID(),
      name: normalizedName,
      color: normalizeColor(color),
      sortOrder,
      hidden: false,
      createdAt: now,
      updatedAt: now,
    })
  }

  async update(category: Category, name: string, color: string): Promise<void> {
    const normalizedName = normalizeName(name)
    await this.ensureUniqueName(normalizedName, category.id)

    await this.storage.update(category.id, {
      name: normalizedName,
      color: normalizeColor(color),
      updatedAt: Date.now(),
    })
  }

  async updateDetails(
    category: Category,
    details: { name: string; coverImage?: string },
  ): Promise<void> {
    const normalizedName = normalizeName(details.name)
    await this.ensureUniqueName(normalizedName, category.id)
    if (details.coverImage !== undefined && !isValidFolderCoverImage(details.coverImage)) {
      throw new Error('文件夹封面格式无效或文件过大')
    }
    await this.storage.update(category.id, {
      name: normalizedName,
      coverImage: details.coverImage,
      updatedAt: Date.now(),
    })
  }

  delete(id: string): Promise<void> {
    return this.storage.deleteAndUnassign(id)
  }

  setHidden(category: Category, hidden: boolean): Promise<void> {
    return this.storage.update(category.id, {
      hidden,
      updatedAt: Date.now(),
    })
  }

  async setCover(category: Category, coverImage?: string): Promise<void> {
    if (coverImage !== undefined && !isValidFolderCoverImage(coverImage)) {
      throw new Error('文件夹封面格式无效或文件过大')
    }
    await this.storage.update(category.id, {
      coverImage,
      updatedAt: Date.now(),
    })
  }

  async reorder(orderedIds: string[]): Promise<void> {
    const categories = await this.storage.list()
    const categoriesById = new Map(categories.map((category) => [category.id, category]))
    const seen = new Set<string>()
    const normalizedIds = orderedIds.filter((id) => {
      if (!categoriesById.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    for (const category of categories) {
      if (!seen.has(category.id)) normalizedIds.push(category.id)
    }

    const updatedAt = Date.now()
    await Promise.all(
      normalizedIds.flatMap((id, sortOrder) =>
        categoriesById.get(id)?.sortOrder === sortOrder
          ? []
          : [this.storage.update(id, { sortOrder, updatedAt })],
      ),
    )
  }

  private async ensureUniqueName(name: string, excludedId?: string): Promise<Category[]> {
    const normalizedName = name.toLocaleLowerCase()
    const categories = await this.storage.list()
    const duplicate = categories.some(
      (category) =>
        category.id !== excludedId && category.name.toLocaleLowerCase() === normalizedName,
    )
    if (duplicate) throw new Error('已存在同名文件夹')
    return categories
  }
}
