import type { AppDatabase } from '../database/AppDatabase'
import type { VaultService } from '../services/VaultService'
import { getResourceCategoryIds, type Category } from '../types/Resource'
import type { CategoryStorageAdapter } from './CategoryStorageAdapter'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'

export class IndexedDbCategoryStorage implements CategoryStorageAdapter {
  private readonly database: AppDatabase
  private readonly vault?: VaultService

  constructor(database: AppDatabase, vault?: VaultService) {
    this.database = database
    this.vault = vault
  }

  async list(): Promise<Category[]> {
    const stored = await this.database.categories.toArray()
    const categories = await Promise.all(
      stored.map((category) =>
        this.vault ? this.vault.decodeCategory(category) : (category as Category),
      ),
    )
    return categories.sort((left, right) => {
      const leftOrder = Number.isFinite(left.sortOrder) ? (left.sortOrder ?? 0) : undefined
      const rightOrder = Number.isFinite(right.sortOrder) ? (right.sortOrder ?? 0) : undefined
      if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
        return leftOrder - rightOrder
      }
      if (leftOrder !== undefined) return -1
      if (rightOrder !== undefined) return 1
      return left.createdAt - right.createdAt
    })
  }

  async save(category: Category): Promise<void> {
    await this.database.categories.put(
      this.vault ? await this.vault.encodeCategory(category) : category,
    )
  }

  async update(id: string, changes: Partial<Category>): Promise<void> {
    const stored = await this.database.categories.get(id)
    if (!stored) return
    const category = this.vault ? await this.vault.decodeCategory(stored) : (stored as Category)
    const updated = { ...category, ...changes }
    await this.database.categories.put(
      this.vault ? await this.vault.encodeCategory(updated) : updated,
    )
  }

  async deleteAndUnassign(id: string): Promise<void> {
    const updatedAt = Date.now()
    const resources = new IndexedDbResourceStorage(this.database, this.vault)
    await this.database.transaction(
      'rw',
      [
        this.database.categories,
        this.database.resources,
        this.database.resourceSummaries,
        this.database.resourceListSummaries,
        this.database.settings,
        this.database.assets,
        this.database.assetFiles,
      ],
      async () => {
        // Reuse the category indexes; encrypted rows retain a lightweight scan.
        const summaries = await resources.listResourceListSummaries({ categoryId: id })
        await resources.updateMetadataMany(
          summaries.flatMap((resource) => {
            const categoryIds = getResourceCategoryIds(resource)
            if (!categoryIds.includes(id)) return []
            const remaining = categoryIds.filter((categoryId) => categoryId !== id)
            return [
              {
                id: resource.id,
                changes: { categoryId: remaining[0] ?? null, categoryIds: remaining, updatedAt },
              },
            ]
          }),
        )
        await this.database.categories.delete(id)
      },
    )
  }
}
