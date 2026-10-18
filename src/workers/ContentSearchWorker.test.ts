import { Blob } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'

async function createWorker() {
  const worker = {
    onmessage: undefined as unknown as (event: { data: unknown }) => Promise<void>,
    postMessage: vi.fn(),
  }
  vi.stubGlobal('self', worker)
  await import('./ContentSearchWorker')
  return worker
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('keeps 2048 resident texts through two 10k scans instead of cyclically thrashing', async () => {
  const worker = await createWorker()
  const items = Array.from({ length: 10_000 }, (_, id) => ({
    id: String(id),
    contentHash: `hash-${id}`,
    blob: new Blob([`needle first second ${id}`]),
  }))
  for (const [requestId, query] of [
    [1, 'first'],
    [2, 'second'],
  ] as const) {
    const reloads = items.map((item, index) => ({
      ...item,
      blob: requestId === 2 && index < 2048 ? undefined : item.blob,
    }))
    await worker.onmessage({ data: { type: 'search', requestId, query, items: reloads } })
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'result',
        matchedIds: items.map((item) => item.id),
        indexedHashes: items.slice(0, 2048).map((item) => item.contentHash),
      }),
    )
    expect(reloads.filter((item) => item.blob).length).toBe(requestId === 1 ? 10_000 : 7952)
  }
}, 15_000)

it('respects the 8MiB total text budget without evicting useful residents', async () => {
  const worker = await createWorker()
  const items = Array.from({ length: 80 }, (_, id) => ({
    id: String(id),
    contentHash: String(id),
    blob: new Blob(['x'.repeat(128 * 1024)]),
  }))
  items.push({ id: 'large', contentHash: 'large', blob: new Blob(['x'.repeat(2 * 1024 * 1024)]) })
  await worker.onmessage({ data: { type: 'search', requestId: 1, query: 'x', items } })
  const result = worker.postMessage.mock.lastCall![0]
  expect(result.indexedHashes).toEqual(items.slice(0, 32).map((item) => item.contentHash))
  expect(result.matchedIds).toHaveLength(81)
  await worker.onmessage({ data: { type: 'prune', hashes: ['0'] } })
  await worker.onmessage({ data: { type: 'search', requestId: 2, query: 'x', items: [items[32]] } })
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ indexedHashes: ['32'] }),
  )
})

it('scans identical content once inside a batch, including non-admitted large text', async () => {
  const worker = await createWorker()
  const blob = new Blob(['needle', 'x'.repeat(4 * 1024 * 1024)])
  const read = vi.spyOn(blob, 'text')
  await worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'needle',
      items: ['a', 'b'].map((id) => ({ id, contentHash: 'same', blob })),
    },
  })
  expect(read).toHaveBeenCalledOnce()
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: ['a', 'b'] }),
  )
})

it.each(['reset', 'cancel'])(
  '%s during a pending read cannot revive private cached text or send late results',
  async (action) => {
    const worker = await createWorker()
    const blob = new Blob(['secret'])
    let release!: () => void
    const read = blob.text.bind(blob)
    vi.spyOn(blob, 'text').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return read()
    })
    const pending = worker.onmessage({
      data: {
        type: 'search',
        requestId: 1,
        query: 'secret',
        items: [{ id: 'a', contentHash: 'h', blob }],
      },
    })
    await worker.onmessage({ data: { type: action } })
    release()
    await pending
    expect(worker.postMessage).not.toHaveBeenCalled()
    await worker.onmessage({
      data: {
        type: 'search',
        requestId: 2,
        query: 'secret',
        items: [{ id: 'a', contentHash: 'h' }],
      },
    })
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }))
  },
)

it('reports read failures explicitly without emitting a false complete result or private text', async () => {
  const worker = await createWorker()
  const blob = new Blob(['private-content'])
  vi.spyOn(blob, 'text').mockImplementation(() => {
    throw new Error('private-content https://private/')
  })
  await worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'private',
      items: [{ id: 'private-id', contentHash: 'h', blob }],
    },
  })
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'error',
    requestId: 1,
    code: 'SRL-SEARCH-CONTENT-SCAN',
    errorName: 'Error',
  })
})

it('preserves baseline reuse of a 1MiB original for a different query', async () => {
  const worker = await createWorker()
  const blob = new Blob(['first second ', 'x'.repeat(1024 * 1024)])
  const read = vi.spyOn(blob, 'text')
  await worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'first',
      items: [{ id: 'a', contentHash: 'h', blob }],
    },
  })
  await worker.onmessage({
    data: { type: 'search', requestId: 2, query: 'second', items: [{ id: 'a', contentHash: 'h' }] },
  })
  expect(read).toHaveBeenCalledOnce()
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: ['a'], indexedHashes: ['h'] }),
  )
})

it('prunes unacknowledged admissions before cancellation so obsolete text cannot pin the cache', async () => {
  const worker = await createWorker()
  const old = new Blob(['x'.repeat(4 * 1024 * 1024)])
  const blocked = new Blob(['blocked'])
  let release!: () => void
  let entered!: () => void
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  vi.spyOn(blocked, 'text').mockImplementation(async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return 'blocked'
  })
  const pending = worker.onmessage({
    data: {
      type: 'search',
      requestId: 1,
      query: 'x',
      items: [
        { id: 'old', contentHash: 'old', blob: old },
        { id: 'blocked', contentHash: 'blocked', blob: blocked },
      ],
    },
  })
  await reading
  await worker.onmessage({ data: { type: 'prune', hashes: ['old', 'blocked'] } })
  await worker.onmessage({ data: { type: 'cancel' } })
  release()
  await pending
  expect(worker.postMessage).not.toHaveBeenCalled()
  await worker.onmessage({
    data: {
      type: 'search',
      requestId: 2,
      query: 'x',
      items: [{ id: 'new', contentHash: 'new', blob: old }],
    },
  })
  expect(worker.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ matchedIds: ['new'], indexedHashes: ['new'] }),
  )
})

it.each(['en', 'tr', 'az', 'lt', 'el'])(
  'keeps native default-locale/includes semantics: %s',
  async (locale) => {
    const native = String.prototype.toLocaleLowerCase
    const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return native.call(this, locale)
    })
    try {
      const worker = await createWorker()
      const blob = new Blob([
        'AΣ',
        '\u200d'.repeat(70_000),
        'A I',
        '\u0323'.repeat(70_000),
        '\u0307 J\u0301 😀𐐀\ud800\uFEFF',
      ])
      const text = (await blob.text()).toLocaleLowerCase()
      for (const [index, query] of [text.slice(-90), '\udc00', 'absent', text].entries()) {
        await worker.onmessage({
          data: {
            type: 'search',
            requestId: index,
            query,
            items: [{ id: 'a', contentHash: 'h', blob }],
          },
        })
        expect(worker.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ matchedIds: text.includes(query) ? ['a'] : [] }),
        )
      }
    } finally {
      lower.mockRestore()
    }
  },
)
