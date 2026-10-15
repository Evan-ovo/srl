import { describe, expect, it, vi } from 'vitest'

import { ResourceParserRegistry } from '../parser/ResourceParser'
import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'
import { RESOURCE_TYPE, toResourceSummary, type Resource } from '../types/Resource'
import { ResourceService } from './ResourceService'

function resource(id: string, tags: string[]): Resource {
  return {
    id,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: 1,
    contentHash: id,
    favorite: false,
    categoryId: null,
    categoryIds: [],
    tags,
    metadata: {},
    originalBlob: new Blob(['{}']),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('ResourceService.addTagsPerResource', () => {
  it('写入前重新读取资源，只追加新标签而不覆盖审核期间的变化', async () => {
    const first = resource('r1', ['原标签', '审核期间新增'])
    const second = resource('r2', ['已有'])
    const saveMany = vi.fn(async (_resources: Resource[]) => undefined)
    const update = vi.fn(async () => undefined)
    const storage = {
      get: vi.fn(async (id: string) => (id === 'r1' ? first : id === 'r2' ? second : undefined)),
      getSummary: vi.fn(async (id: string) =>
        id === 'r1'
          ? toResourceSummary(first)
          : id === 'r2'
            ? toResourceSummary(second)
            : undefined,
      ),
      listSummaries: vi.fn(async () => [first, second].map(toResourceSummary)),
      update,
      saveMany,
    } as unknown as ResourceStorageAdapter
    const service = new ResourceService(storage, new ResourceParserRegistry([]))

    const result = await service.addTagsPerResource([
      { resourceId: 'r1', tags: ['甜宠', '原标签', '甜宠'] },
      { resourceId: 'r2', tags: ['已有'] },
      { resourceId: 'missing', tags: ['现代'] },
    ])

    expect(result).toEqual({
      resourceCount: 1,
      tagCount: 1,
      entries: [{ resourceId: 'r1', resourceName: 'r1', tags: ['甜宠'] }],
    })
    expect(saveMany).not.toHaveBeenCalled()
    expect(storage.get).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ tags: ['原标签', '审核期间新增', '甜宠'] }),
    )
  })

  it('没有有效建议时不写入', async () => {
    const saveMany = vi.fn()
    const storage = { get: vi.fn(), saveMany } as unknown as ResourceStorageAdapter
    const service = new ResourceService(storage, new ResourceParserRegistry([]))

    await expect(service.addTagsPerResource([{ resourceId: 'r1', tags: [] }])).resolves.toEqual({
      resourceCount: 0,
      tagCount: 0,
      entries: [],
    })
    expect(saveMany).not.toHaveBeenCalled()
  })

  it('撤销只删除上次真实新增且仍保持原名的标签', async () => {
    const first = resource('r1', ['原标签', '甜宠', 'AI后手动新增'])
    const second = resource('r2', ['古风改名'])
    const saveMany = vi.fn(async (_resources: Resource[]) => undefined)
    const updateMetadataMany = vi.fn(async () => undefined)
    const storage = {
      get: vi.fn(async (id: string) => (id === 'r1' ? first : id === 'r2' ? second : undefined)),
      getSummary: vi.fn(async (id: string) =>
        id === 'r1'
          ? toResourceSummary(first)
          : id === 'r2'
            ? toResourceSummary(second)
            : undefined,
      ),
      updateMetadataMany,
      saveMany,
    } as unknown as ResourceStorageAdapter
    const service = new ResourceService(storage, new ResourceParserRegistry([]))

    const result = await service.undoAddedTags([
      { resourceId: 'r1', resourceName: 'r1', tags: ['甜宠'] },
      { resourceId: 'r2', resourceName: 'r2', tags: ['古风'] },
    ])

    expect(result).toEqual({
      resourceCount: 1,
      tagCount: 1,
      entries: [{ resourceId: 'r1', resourceName: 'r1', tags: ['甜宠'] }],
    })
    expect(storage.get).not.toHaveBeenCalled()
    expect(saveMany).not.toHaveBeenCalled()
    expect(updateMetadataMany).toHaveBeenCalledWith([
      { id: 'r1', changes: expect.objectContaining({ tags: ['原标签', 'AI后手动新增'] }) },
    ])
  })
})
