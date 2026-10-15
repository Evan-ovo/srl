import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})
it('reports evicted text hashes so the next query can reload them instead of losing matches', async () => {
  const worker = {
    onmessage: undefined as unknown as (event: { data: unknown }) => Promise<void>,
    postMessage: vi.fn(),
  }
  vi.stubGlobal('self', worker)
  await import('./ContentSearchWorker')
  for (const hash of ['a', 'b'])
    await worker.onmessage({
      data: {
        type: 'search',
        requestId: hash,
        query: 'needle',
        items: [
          {
            id: hash,
            contentHash: hash,
            blob: { text: async () => 'needle' + 'x'.repeat(3 * 1024 * 1024) },
          },
        ],
      },
    })
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: ['b'], indexedHashes: ['b'], evictedHashes: ['a'] }),
  )
  await worker.onmessage({
    data: { type: 'search', requestId: 3, query: 'needle', items: [{ id: 'a', contentHash: 'a' }] },
  })
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: [], indexedHashes: [] }),
  )
})
it('parses identical content once inside a batch', async () => {
  const worker = {
    onmessage: undefined as unknown as (event: { data: unknown }) => Promise<void>,
    postMessage: vi.fn(),
  }
  vi.stubGlobal('self', worker)
  await import('./ContentSearchWorker')
  const text = vi.fn(async () => 'needle')
  await worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'needle',
      items: ['a', 'b'].map((id) => ({ id, contentHash: 'same', blob: { text } })),
    },
  })
  expect(text).toHaveBeenCalledTimes(1)
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: ['a', 'b'] }),
  )
})
it('上锁清空索引后，尚未结束的 Blob 读取不能复活私密缓存或返回旧结果', async () => {
  const worker = {
    onmessage: undefined as unknown as (event: { data: unknown }) => Promise<void>,
    postMessage: vi.fn(),
  }
  vi.stubGlobal('self', worker)
  await import('./ContentSearchWorker')
  let release!: (value: string) => void
  const pending = worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'secret',
      items: [
        {
          id: 'a',
          contentHash: 'h',
          blob: {
            text: () =>
              new Promise<string>((resolve) => {
                release = resolve
              }),
          },
        },
      ],
    },
  })
  await worker.onmessage({ data: { type: 'reset' } })
  release('secret')
  await pending
  expect(worker.postMessage).not.toHaveBeenCalled()
  await worker.onmessage({
    data: { type: 'search', requestId: 2, query: 'secret', items: [{ id: 'a', contentHash: 'h' }] },
  })
  expect(worker.postMessage).toHaveBeenCalledWith({
    type: 'result',
    requestId: 2,
    matchedIds: [],
    indexedHashes: [],
  })
})
