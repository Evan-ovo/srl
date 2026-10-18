import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { RESOURCE_TYPE, type Category, type Resource } from '../types/Resource'
import { IndexedDbCategoryStorage } from './IndexedDbCategoryStorage'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import { VaultService } from '../services/VaultService'

const databaseNames: string[] = []

function createDatabase(): AppDatabase {
  const name = `category-storage-${crypto.randomUUID()}`
  databaseNames.push(name)
  return new AppDatabase(name)
}

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => indexedDB.deleteDatabase(name)))
})

describe('IndexedDbCategoryStorage', () => {
  it.each([false, true])(
    'keeps files and all summaries consistent across reopen (vault=%s)',
    async (encrypted) => {
      const database = createDatabase()
      const vault = encrypted ? new VaultService(database) : undefined
      await vault?.initialize()
      await vault?.enable('test-password')
      const categories = new IndexedDbCategoryStorage(database, vault)
      const resources = new IndexedDbResourceStorage(database, vault)
      const blob = new Blob(['original bytes'])
      const resource: Resource = {
        id: 'selected',
        type: RESOURCE_TYPE.OTHER,
        name: '保留',
        description: '',
        fileName: 'file.txt',
        fileSize: blob.size,
        mimeType: 'text/plain',
        contentHash: 'hash',
        favorite: false,
        tags: ['tag'],
        metadata: { untouched: 'body' },
        categoryId: 'remove',
        categoryIds: ['remove', 'keep'],
        originalBlob: blob,
        createdAt: 1,
        updatedAt: 1,
      }
      try {
        await categories.save({
          id: 'remove',
          name: '删除',
          color: '#486b5d',
          createdAt: 1,
          updatedAt: 1,
        })
        await resources.saveMany([
          resource,
          { ...resource, id: 'unrelated', categoryId: null, categoryIds: [] },
          ...Array.from({ length: 250 }, (_, index) => ({
            ...resource,
            id: `unrelated-${index}`,
            categoryId: null,
            categoryIds: [],
          })),
        ])
        const decodeOriginal = vault ? vi.spyOn(vault, 'decodeResource') : undefined
        const scan = vi.spyOn(database.resources, 'toArray')
        const deleteCategory = vi
          .spyOn(database.categories, 'delete')
          .mockRejectedValueOnce(new Error('delete failed'))
        await expect(categories.deleteAndUnassign('remove')).rejects.toThrow('delete failed')
        expect((await resources.getResourceListSummary('selected'))?.categoryIds).toEqual([
          'remove',
          'keep',
        ])
        expect(await database.categories.get('remove')).toBeDefined()
        deleteCategory.mockRestore()
        await categories.deleteAndUnassign('remove')
        expect(scan.mock.calls.length).toBe(0)
        expect(decodeOriginal?.mock.calls.length ?? 0).toBe(0)
        database.close()
        await database.open()
        expect(await database.categories.get('remove')).toBeUndefined()
        expect(await resources.getResourceListSummary('selected')).toMatchObject({
          categoryId: 'keep',
          categoryIds: ['keep'],
        })
        expect((await resources.getSummary('selected'))?.categoryIds).toEqual(['keep'])
        expect(await (await resources.get('selected'))?.originalBlob.text()).toBe('original bytes')
        expect((await resources.getSummary('selected'))?.metadata.untouched).toBe('body')
        expect((await resources.getSummary('unrelated'))?.updatedAt).toBe(1)
      } finally {
        database.close()
      }
    },
  )

  it('lists manually ordered folders before legacy creation-order folders', async () => {
    const database = createDatabase()
    const storage = new IndexedDbCategoryStorage(database)
    const orderedCategories: Category[] = [
      { id: 'legacy', name: '旧文件夹', color: '#486b5d', createdAt: 1, updatedAt: 1 },
      {
        id: 'second',
        name: '第二个',
        color: '#486b5d',
        sortOrder: 1,
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: 'first',
        name: '第一个',
        color: '#486b5d',
        sortOrder: 0,
        createdAt: 2,
        updatedAt: 2,
      },
    ]
    await database.categories.bulkPut(orderedCategories)

    expect((await storage.list()).map((category) => category.id)).toEqual([
      'first',
      'second',
      'legacy',
    ])
    database.close()
  })

  it('deletes a category and unassigns its resources in one operation', async () => {
    const database = createDatabase()
    const storage = new IndexedDbCategoryStorage(database)
    const now = Date.now()
    const category: Category = {
      id: 'favorite-lore',
      name: '常用设定',
      color: '#486b5d',
      createdAt: now,
      updatedAt: now,
    }
    const resource: Resource = {
      id: 'atlas',
      type: RESOURCE_TYPE.WORLD_BOOK,
      name: 'Atlas',
      description: '',
      fileName: 'Atlas.json',
      mimeType: 'application/json',
      fileSize: 2,
      contentHash: 'hash',
      favorite: false,
      categoryId: category.id,
      categoryIds: [category.id, 'keep-folder'],
      tags: [],
      metadata: {},
      originalBlob: new Blob(['{}']),
      createdAt: now,
      updatedAt: now,
    }

    await database.categories.put(category)
    await database.resources.put(resource)
    const scan = vi.spyOn(database.resources, 'toArray')
    await storage.deleteAndUnassign(category.id)

    expect(await database.categories.get(category.id)).toBeUndefined()
    const updatedResource = await database.resources.get(resource.id)
    expect(
      updatedResource && 'categoryId' in updatedResource ? updatedResource.categoryId : undefined,
    ).toBe('keep-folder')
    expect(
      updatedResource && 'categoryIds' in updatedResource ? updatedResource.categoryIds : undefined,
    ).toEqual(['keep-folder'])
    expect(scan.mock.calls.length).toBe(0)
    expect(await database.resourceListSummaries.get(resource.id)).toMatchObject({
      categoryId: 'keep-folder',
      categoryIds: ['keep-folder'],
    })
    database.close()
  })
})
