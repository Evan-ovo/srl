/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import {
  ProductAssistantReferenceReader,
  isAssistantReferenceResource,
  type AssistantReferenceResource,
} from './ProductAssistantReferences'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
function fixture(
  value: unknown = {
    entries: { 'a/b~c': { content: '森林中的记录员，不执行<script>代码</script>' } },
  },
  changes: Partial<Resource> = {},
) {
  const resource = {
    id: 'selected',
    name: '世界书',
    contentHash: 'hash',
    type: RESOURCE_TYPE.WORLD_BOOK,
    fileName: 'book.json',
    mimeType: 'application/json',
    originalBlob: new Blob([JSON.stringify(value)]),
    ...changes,
  } as Resource
  let selected: AssistantReferenceResource[] = [
    { id: resource.id, name: resource.name, contentHash: resource.contentHash },
  ]
  const resources = {
    getSummary: vi.fn(async (_id: string) => resource),
    get: vi.fn(async (_id: string) => resource),
  }
  const reader = new ProductAssistantReferenceReader(resources, () => selected)
  return {
    resource,
    resources,
    reader,
    setSelected: (value: AssistantReferenceResource[]) => {
      selected = value
    },
  }
}
describe('selected resource retrieval', () => {
  it('reuses a failed parse for the same identity instead of repeatedly reading a corrupt original', async () => {
    const { reader, resources } = fixture({}, { originalBlob: new Blob(['{bad json']) })
    await expect(reader.search('a', 0)).rejects.toThrow()
    await expect(reader.search('b', 0)).rejects.toThrow()
    expect(resources.get).toHaveBeenCalledOnce()
    reader.clear()
    await expect(reader.search('a', 0)).rejects.toThrow()
    expect(resources.get).toHaveBeenCalledTimes(2)
  })
  it('reads embedded PNG card data through the existing parser without a whole-image arrayBuffer', async () => {
    const chunk = (type: string, data = new Uint8Array()) => {
      const bytes = new Uint8Array(data.length + 12)
      new DataView(bytes.buffer).setUint32(0, data.length)
      bytes.set(new TextEncoder().encode(type), 4)
      bytes.set(data, 8)
      return bytes
    }
    const card = { data: { name: '记录员', description: '森林设定' } }
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(card))))
    const blob = new Blob([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IDAT', new Uint8Array(4 * 1024 * 1024)),
      chunk('tEXt', new TextEncoder().encode(`chara\0${encoded}`)),
      chunk('IEND'),
    ])
    const fullRead = vi
      .spyOn(File.prototype, 'arrayBuffer')
      .mockRejectedValue(new Error('must not read full PNG'))
    try {
      const { reader } = fixture(
        {},
        {
          type: RESOURCE_TYPE.CHARACTER_CARD,
          fileName: 'card.png',
          mimeType: 'image/png',
          originalBlob: blob,
        },
      )
      expect((await reader.search('森林', 0)).items[0]).toMatchObject({
        locator: '#/data/description',
        excerpt: '森林设定',
      })
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      fullRead.mockRestore()
    }
  })
  it('returns escaped JSON locations and exact excerpts, reusing parsed content across search and read', async () => {
    const { reader, resources } = fixture()
    const result = await reader.search('森林 记录员', 0)
    expect(result.items).toHaveLength(1)
    const citation = result.items[0]!
    expect(citation.locator).toBe('#/entries/a~1b~0c/content')
    expect(citation.excerpt).toContain('<script>')
    expect(
      (await reader.read(citation.id, citation.contentHash, citation.locator)).citation,
    ).toEqual(citation)
    await reader.search('记录员', 0)
    expect(resources.get).toHaveBeenCalledOnce()
    expect(resources.getSummary.mock.calls.every(([id]) => id === 'selected')).toBe(true)
    await expect(reader.read('unselected', 'hash', citation.locator)).rejects.toThrow('未选定')
    expect(resources.get).toHaveBeenCalledOnce()
  })
  it('rejects stale/deleted resources before reading their bodies', async () => {
    const { reader, resource, resources } = fixture()
    resource.contentHash = 'new-hash'
    await expect(reader.search('森林', 0)).rejects.toThrow('变化')
    expect(resources.get).not.toHaveBeenCalled()
  })
  it.each([{}, { secretProtection: 'none' }])(
    'excludes credentials even if their ID is supplied directly (metadata=%j)',
    async (metadata) => {
      const { reader, resource, resources } = fixture(
        { key: 'private' },
        { type: RESOURCE_TYPE.SECRET, metadata },
      )
      expect(isAssistantReferenceResource(resource)).toBe(false)
      await expect(reader.search('private', 0)).rejects.toThrow('不支持')
      expect(resources.get).not.toHaveBeenCalled()
    },
  )
  it('retains original line positions and paginates exact field text', async () => {
    const lines = Array.from(
      { length: 43 },
      (_, i) => `原行${i + 1}：${i === 25 ? 'needle' : '正文'}`,
    ).join('\n')
    const { reader, resource } = fixture(
      {},
      {
        type: RESOURCE_TYPE.OTHER,
        fileName: 'guide.md',
        mimeType: 'text/markdown',
        originalBlob: new Blob([lines]),
      },
    )
    const citation = (await reader.search('needle', 0)).items[0]!
    expect(citation.locator).toBe('行21–40')
    expect(citation.excerpt).toContain('原行26：needle')
    const text = (await reader.read(resource.id, resource.contentHash, citation.locator)).citation
      .excerpt
    expect(text).toBe(lines.split('\n').slice(20, 40).join('\n'))
    const long = fixture({ content: 'x'.repeat(9000) })
    const first = await long.reader.read('selected', 'hash', '#/content')
    expect(first.nextOffset).toBe(4000)
    expect(first.complete).toBe(false)
    const end = await long.reader.read('selected', 'hash', '#/content', 8000)
    expect(end.citation.excerpt).toHaveLength(1000)
    expect(end.nextOffset).toBeUndefined()
  })
  it('stops on cancellation and rejects late results after the selection is reset', async () => {
    const { reader, resources, resource, setSelected } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(reader.search('森林', 0, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(resources.get).not.toHaveBeenCalled()
    let finish!: (value: Resource) => void
    resources.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const run = reader.search('森林', 0)
    await vi.waitFor(() => expect(resources.get).toHaveBeenCalledOnce())
    reader.clear()
    setSelected([])
    finish(resource)
    await expect(run).rejects.toHaveProperty('name', 'AbortError')
  })
  it('pages 5000 fields while reading only the selected source once', async () => {
    const values = Array.from({ length: 5000 }, (_, i) => ({ content: `目标条目${i}` }))
    const { reader, resources } = fixture({ entries: values })
    const first = await reader.search('目标条目', 0)
    const next = await reader.search('目标条目', first.nextOffset!)
    expect(first.total).toBe(5000)
    expect(first.items).toHaveLength(10)
    expect(next.items[0]?.locator).toBe('#/entries/10/content')
    expect(resources.get).toHaveBeenCalledOnce()
    reader.clear()
    await reader.search('目标条目4999', 0)
    expect(resources.get).toHaveBeenCalledTimes(2)
  })
})
