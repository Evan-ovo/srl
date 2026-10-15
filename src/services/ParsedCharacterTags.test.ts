import { describe, expect, it, vi } from 'vitest'
import { ResourceService } from './ResourceService'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import {
  RESOURCE_TYPE,
  toResourceListSummary,
  toResourceSummary,
  type Resource,
} from '../types/Resource'
import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'

function fixture() {
  const card = {
    id: 'card',
    name: '测试卡',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    tags: ['原生', '手动'],
    contentHash: 'hash-v1',
    originalBlob: new Blob(['{}']),
    fileName: 'card.json',
    mimeType: 'application/json',
    metadata: {},
  } as Resource
  const get = vi.fn(async () => card)
  const update = vi.fn(async (_id: string, changes: Partial<Resource>) => {
    Object.assign(card, changes)
  })
  const parse = vi.fn(async () => ({
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: '测试卡',
    tags: ['原生'],
    description: '',
    metadata: {},
  }))
  const storage = {
    get,
    getSummary: vi.fn(async () => toResourceSummary(card)),
    update,
    saveMany: vi.fn(),
    listResourceListSummaries: async () => [toResourceListSummary(card)],
  } as unknown as ResourceStorageAdapter
  return {
    card,
    get,
    update,
    parse,
    storage,
    service: new ResourceService(
      storage,
      new ResourceParserRegistry([{ supports: () => true, parse }]),
    ),
  }
}

describe('解析标签清理', () => {
  it('requests only the selected summaries after scanning, and an empty selection reads nothing', async () => {
    const { service, storage } = fixture()
    await service.findParsedCharacterTags()
    const list = vi.spyOn(storage, 'listResourceListSummaries')
    expect(
      (await service.removeParsedCharacterTags([{ resourceId: 'card', tags: ['原生'] }])).tagCount,
    ).toBe(1)
    expect(list).toHaveBeenCalledExactlyOnceWith({ ids: ['card'] })
    list.mockClear()
    expect((await service.removeParsedCharacterTags([])).resourceCount).toBe(0)
    expect(list).not.toHaveBeenCalled()
  })
  it('清理删除资源的反向关联时只更新摘要，不读取其它大原件', async () => {
    const { service, storage, card, get, update } = fixture()
    card.relatedResourceIds = ['removed', 'kept']
    storage.deleteMany = vi.fn(async () => undefined)
    get.mockRejectedValue(new Error('此路径不应读取原件'))
    await service.deleteMany(['removed'])
    expect(card.relatedResourceIds).toEqual(['kept'])
    expect(get).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(
      'card',
      expect.objectContaining({ relatedResourceIds: ['kept'] }),
    )
    expect(storage.deleteMany).toHaveBeenCalledWith(['removed'], undefined)
  })
  it('扫描后清理复用相同哈希的解析结果，仅写标签；撤销不读取原件', async () => {
    const { service, get, parse, update, card } = fixture()
    const original = card.originalBlob
    const progress = vi.fn()
    await service.findParsedCharacterTags(progress)
    const result = await service.removeParsedCharacterTags(
      [{ resourceId: 'card', tags: ['原生', '手动'] }],
      progress,
    )
    expect(result.tagCount).toBe(1)
    expect(result.failed).toBe(0)
    expect(card.tags).toEqual(['手动'])
    expect(card.originalBlob).toBe(original)
    expect(get).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![1]).not.toHaveProperty('originalBlob')
    await service.restoreParsedCharacterTags(result.entries)
    expect(card.tags).toEqual(['手动', '原生'])
    expect(get).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 1, total: 1, failed: 0 }),
    )
  })

  it('原件哈希变化后重新核对，不删除新版不再自带的标签', async () => {
    const { service, card, parse } = fixture()
    await service.findParsedCharacterTags()
    card.contentHash = 'hash-v2'
    parse.mockResolvedValueOnce({
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name: '测试卡',
      tags: ['新版'],
      description: '',
      metadata: {},
    })
    expect(
      (await service.removeParsedCharacterTags([{ resourceId: 'card', tags: ['原生'] }])).tagCount,
    ).toBe(0)
    expect(card.tags).toEqual(['原生', '手动'])
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('撤销完整恢复超过 40 字的原有标签，不应用 AI 新标签的截断规则', async () => {
    const { service, card } = fixture()
    const tag = '很长的原始解析标签'.repeat(10)
    await service.restoreParsedCharacterTags([{ resourceId: card.id, tags: [tag] }])
    expect(card.tags).toContain(tag)
  })

  it('读取和写入失败如实计数，不把失败项记作已清理', async () => {
    const { service, parse, update } = fixture()
    parse.mockRejectedValueOnce(new Error('文件不可读'))
    const progress = vi.fn()
    expect(await service.findParsedCharacterTags(progress)).toEqual([])
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ completed: 1, failed: 1 }))
    update.mockRejectedValueOnce(new Error('写入失败'))
    const result = await service.removeParsedCharacterTags([{ resourceId: 'card', tags: ['原生'] }])
    expect(result).toMatchObject({ failed: 1, entries: [], tagCount: 0 })
  })
})
