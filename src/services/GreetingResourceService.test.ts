import { describe, expect, it, vi } from 'vitest'
import { GreetingResourceService } from './GreetingResourceService'
import type { ResourceService } from './ResourceService'
import { toResourceListSummary, type Resource } from '../types/Resource'

function greeting(id: string, text: string): Resource {
  return {
    id,
    type: 'greeting',
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: 1,
    categoryId: null,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    contentHash: id,
    tags: [],
    metadata: {},
    originalBlob: new Blob([
      JSON.stringify({
        format: 'srl-greeting',
        version: 1,
        name: id,
        first_mes: text,
        alternate_greetings: [],
        companion_scripts: [],
      }),
    ]),
  }
}
describe('GreetingResourceService content reuse', () => {
  it('reuses semantic digests, scopes the catalogue and reads the live matched resource', async () => {
    const first = greeting('a', 'one'),
      second = greeting('b', 'two')
    const firstText = vi.spyOn(first.originalBlob, 'text'),
      secondText = vi.spyOn(second.originalBlob, 'text')
    const get = vi.fn(async (id: string) => (id === 'a' ? first : second))
    const list = vi.fn(async () => [first, second].map(toResourceListSummary))
    const service = new GreetingResourceService({
      get,
      listResourceListSummaries: list,
    } as unknown as ResourceService)
    const file = new File([second.originalBlob], 'different-name.json')
    expect((await service.save(file)).id).toBe('b')
    expect((await service.save(file)).id).toBe('b')
    expect(list).toHaveBeenCalledWith({ types: ['greeting'] })
    expect(get).toHaveBeenCalledTimes(3)
    expect(firstText).toHaveBeenCalledTimes(1)
    expect(secondText).toHaveBeenCalledTimes(1)
    const changed = greeting('a', 'changed')
    first.contentHash = 'new-hash'
    first.originalBlob = changed.originalBlob
    expect((await service.save(new File([changed.originalBlob], 'changed.json'))).id).toBe('a')
  })
  it('does not return a cached match deleted after the catalogue was read', async () => {
    const item = greeting('a', 'one')
    const get = vi.fn(async () => item as Resource | undefined)
    const importPreparedFile = vi.fn(async () => ({
      status: 'imported',
      resource: greeting('new', 'one'),
    }))
    const service = new GreetingResourceService({
      get,
      importPreparedFile,
      listResourceListSummaries: async () => [toResourceListSummary(item)],
    } as unknown as ResourceService)
    const file = new File([item.originalBlob], 'one.json')
    expect((await service.save(file)).id).toBe('a')
    get.mockResolvedValue(undefined)
    expect((await service.save(file)).id).toBe('new')
    expect(importPreparedFile).toHaveBeenCalledTimes(1)
  })
})
