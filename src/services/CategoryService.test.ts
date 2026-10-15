import { describe, expect, it, vi } from 'vitest'

import type { CategoryStorageAdapter } from '../storage/CategoryStorageAdapter'
import type { Category } from '../types/Resource'
import { CategoryService } from './CategoryService'

class MemoryCategoryStorage implements CategoryStorageAdapter {
  readonly categories = new Map<string, Category>()
  deletedId = ''

  async list(): Promise<Category[]> {
    return Array.from(this.categories.values())
  }

  async save(category: Category): Promise<void> {
    this.categories.set(category.id, category)
  }

  async update(id: string, changes: Partial<Category>): Promise<void> {
    const category = this.categories.get(id)
    if (category) this.categories.set(id, { ...category, ...changes })
  }

  async deleteAndUnassign(id: string): Promise<void> {
    this.deletedId = id
    this.categories.delete(id)
  }
}

describe('CategoryService', () => {
  it('uses one category snapshot for uniqueness and legacy ordering when creating a folder', async () => {
    const storage = new MemoryCategoryStorage()
    await storage.save({
      id: 'old',
      name: '旧文件夹',
      color: '#486b5d',
      createdAt: 1,
      updatedAt: 1,
    })
    await storage.save({
      id: 'ordered',
      name: '已有排序',
      color: '#486b5d',
      sortOrder: 7,
      createdAt: 2,
      updatedAt: 2,
    })
    const list = vi.spyOn(storage, 'list')
    const service = new CategoryService(storage)

    await service.create(' 新文件夹 ', '#486b5d')

    expect(list).toHaveBeenCalledTimes(1)
    expect(storage.categories.get('old')?.sortOrder).toBe(0)
    expect(storage.categories.get('ordered')?.sortOrder).toBe(7)
    expect(
      [...storage.categories.values()].find((item) => item.name === '新文件夹')?.sortOrder,
    ).toBe(2)
    await expect(service.create('新文件夹', '#486b5d')).rejects.toThrow('已存在同名文件夹')
    expect(storage.categories.size).toBe(3)
  })

  it('creates a trimmed category with normalized color', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)

    await service.create('  常用角色  ', '#A56B52')

    const [category] = await service.list()
    expect(category?.name).toBe('常用角色')
    expect(category?.color).toBe('#a56b52')
    expect(category?.sortOrder).toBe(0)
    expect(category?.hidden).toBe(false)
  })

  it('rejects duplicate category names regardless of case', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('Lore', '#486b5d')

    await expect(service.create('lore', '#8a6a47')).rejects.toThrow('已存在同名文件夹')
  })

  it('does not persist a category when the shared validation snapshot cannot be read', async () => {
    const storage = new MemoryCategoryStorage()
    vi.spyOn(storage, 'list').mockRejectedValueOnce(new Error('read failed'))
    const save = vi.spyOn(storage, 'save')
    await expect(new CategoryService(storage).create('新文件夹', '#486b5d')).rejects.toThrow(
      'read failed',
    )
    expect(save).not.toHaveBeenCalled()
    expect(storage.categories.size).toBe(0)
  })

  it('updates and deletes an existing category', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('待整理', '#486b5d')
    const [category] = await service.list()
    expect(category).toBeDefined()
    if (!category) return

    await service.update(category, '已整理', '#8A6A47')
    await service.delete(category.id)

    expect(storage.deletedId).toBe(category.id)
    expect(await service.list()).toHaveLength(0)
  })

  it('can hide and restore a category without deleting it', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('恐怖角色', '#486b5d')
    const [category] = await service.list()
    expect(category).toBeDefined()
    if (!category) return

    await service.setHidden(category, true)
    expect((await service.list())[0]?.hidden).toBe(true)

    await service.setHidden({ ...category, hidden: true }, false)
    expect((await service.list())[0]?.hidden).toBe(false)
  })

  it('stores and clears a compact raster folder cover', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('封面测试', '#486b5d')
    const [category] = await service.list()
    expect(category).toBeDefined()
    if (!category) return

    const coverImage = `data:image/webp;base64,${btoa('folder-cover')}`
    await service.setCover(category, coverImage)
    expect((await service.list())[0]?.coverImage).toBe(coverImage)

    const remoteCover = 'https://images.example.com/folder.webp'
    await service.setCover({ ...category, coverImage }, remoteCover)
    expect((await service.list())[0]?.coverImage).toBe(remoteCover)

    await service.setCover({ ...category, coverImage: remoteCover }, undefined)
    expect((await service.list())[0]?.coverImage).toBeUndefined()
  })

  it('updates the folder name and cover in one storage mutation', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('旧名称', '#486b5d')
    const [category] = await service.list()
    expect(category).toBeDefined()
    if (!category) return
    const update = vi.spyOn(storage, 'update')

    await service.updateDetails(category, {
      name: '新名称',
      coverImage: 'https://images.example.com/folder.webp',
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect((await service.list())[0]).toMatchObject({
      name: '新名称',
      coverImage: 'https://images.example.com/folder.webp',
    })
  })

  it('persists a complete manual folder order and appends omitted folders', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('一号', '#486b5d')
    await service.create('二号', '#486b5d')
    await service.create('三号', '#486b5d')
    const ids = (await service.list()).map((category) => category.id)

    await service.reorder([ids[2]!, ids[0]!])

    const byOrder = (await service.list()).sort(
      (left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
    )
    expect(byOrder.map((category) => category.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(byOrder.map((category) => category.sortOrder)).toEqual([0, 1, 2])
  })

  it('rejects unsafe folder cover data URLs', async () => {
    const storage = new MemoryCategoryStorage()
    const service = new CategoryService(storage)
    await service.create('封面测试', '#486b5d')
    const [category] = await service.list()
    expect(category).toBeDefined()
    if (!category) return

    await expect(service.setCover(category, 'data:image/svg+xml;base64,PHN2Zy8+')).rejects.toThrow(
      '文件夹封面格式无效',
    )
    await expect(service.setCover(category, 'http://example.com/folder.png')).rejects.toThrow(
      '文件夹封面格式无效',
    )
  })
})
