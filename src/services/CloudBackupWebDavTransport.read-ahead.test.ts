/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import process from 'node:process'
import console from 'node:console'
import { createWebDavObjectReader } from './CloudBackupWebDavTransport'
import { hashCloudBlob } from './CloudArchiveCodec'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import type { CloudBackupTransportContext } from './CloudBackupTransportContext'

const config = {
  provider: 'webdav' as const,
  baseUrl: 'https://dav.example.com',
  folder: 'backup',
  username: 'fixture',
  retention: 2,
  autoBackup: false,
}

async function fixture(texts: string[]) {
  const bodies = texts.map((text) => new Blob([text]))
  const parts = await Promise.all(
    bodies.map(async (blob, index) => ({
      name: `part-${index}`,
      size: blob.size,
      sha256: await hashCloudBlob(blob),
    })),
  )
  const object: GitHubBundleManifest = {
    format: 'srl-github-backup-bundle',
    version: 2,
    createdAt: '',
    fileName: 'fixture.bin',
    totalSize: bodies.reduce((n, b) => n + b.size, 0),
    totalSha256: await hashCloudBlob(new Blob(bodies)),
    parts,
  }
  const controller = new AbortController()
  const gates = new Map<
    number,
    { resolve: (response: Response) => void; reject: (error: unknown) => void }
  >()
  let active = 0,
    peak = 0
  const started: number[] = [],
    aborted: number[] = []
  const context = {
    signal: controller.signal,
    cloudFetch: vi.fn(async (url: string, init: RequestInit) => {
      const id = Number(url.split('-').at(-1))
      started.push(id)
      peak = Math.max(peak, ++active)
      const signal = init.signal!
      let stop!: () => void
      try {
        return await new Promise<Response>((resolve, reject) => {
          gates.set(id, { resolve, reject })
          stop = () => {
            aborted.push(id)
            reject(signal.reason)
          }
          signal.addEventListener('abort', stop, { once: true })
          if (signal.aborted) stop()
        })
      } finally {
        active--
        signal.removeEventListener('abort', stop)
      }
    }),
    readResponseBlob: (response: Response) => response.blob(),
  } as unknown as CloudBackupTransportContext
  return {
    object,
    context,
    controller,
    started,
    aborted,
    peak: () => peak,
    active: () => active,
    resolve: (id: number, blob = bodies[id]!) => gates.get(id)!.resolve(new Response(blob)),
  }
}
const until = async (check: () => boolean) =>
  vi.waitFor(() => expect(check()).toBe(true), { interval: 1 })

describe('Koofr bounded object read-ahead', () => {
  it('preserves a 256 MiB original in both serial and default windows with exactly one request per part', async () => {
    const part = new Blob([new Uint8Array(4 * 1024 * 1024).fill(73)])
    const count = 64
    const sha = await hashCloudBlob(part)
    const object: GitHubBundleManifest = {
      format: 'srl-github-backup-bundle',
      version: 2,
      createdAt: '',
      fileName: 'large.bin',
      totalSize: part.size * count,
      totalSha256: await hashCloudBlob(new Blob(Array.from({ length: count }, () => part))),
      parts: Array.from({ length: count }, (_, index) => ({
        name: `chunk-${index}`,
        size: part.size,
        sha256: sha,
      })),
    }
    for (const concurrency of [1, 2]) {
      const controller = new AbortController()
      let active = 0,
        peak = 0,
        requests = 0,
        sampledRss = 0,
        sampledHeap = 0
      const context = {
        signal: controller.signal,
        cloudFetch: async () => {
          requests++
          peak = Math.max(peak, ++active)
          try {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return new Response(part)
          } finally {
            active--
          }
        },
        readResponseBlob: async (response: Response) => {
          const blob = await response.blob()
          const memory = process.memoryUsage()
          sampledRss = Math.max(sampledRss, memory.rss)
          sampledHeap = Math.max(sampledHeap, memory.heapUsed)
          return blob
        },
      } as unknown as CloudBackupTransportContext
      const read = createWebDavObjectReader(context, config, 'fixture', { concurrency })
      const started = performance.now()
      const blob = await read(object)
      const ms = performance.now() - started
      expect(blob.size).toBe(256 * 1024 * 1024)
      expect(await hashCloudBlob(blob)).toBe(object.totalSha256)
      expect(requests).toBe(count)
      expect(peak).toBe(concurrency)
      expect(active).toBe(0)
      console.info(
        JSON.stringify({
          fixture: 'Koofr 256MiB; simulated 20ms response latency',
          concurrency,
          requests,
          ms,
          sampledRss,
          sampledHeap,
        }),
      )
      controller.abort()
    }
  }, 30_000)
  it('overlaps two chunks, retains ready slots and assembles exact descriptor order', async () => {
    const f = await fixture(['aaa', 'bbb', 'ccc', 'ddd'])
    const read = createWebDavObjectReader(f.context, config, 'fixture')
    const result = read(f.object)
    await until(() => f.started.length === 2)
    f.resolve(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.started).toEqual([0, 1])
    f.resolve(0)
    await until(() => f.started.length === 4)
    f.resolve(3)
    f.resolve(2)
    expect(await (await result).text()).toBe('aaabbbcccddd')
    expect(f.peak()).toBe(2)
    expect(f.active()).toBe(0)
    f.controller.abort()
  })

  it.each([1, 2])(
    'shares one byte budget across resource reads, including oversized parts (concurrency=%s)',
    async (concurrency) => {
      const f = await fixture(['1234567', 'abcd'])
      const read = createWebDavObjectReader(f.context, config, 'fixture', {
        concurrency,
        byteBudget: 6,
      })
      const single = (index: number) => ({
        ...f.object,
        parts: [f.object.parts[index]!],
        totalSize: f.object.parts[index]!.size,
        totalSha256: f.object.parts[index]!.sha256,
      })
      const first = read(single(0)),
        second = read(single(1))
      await until(() => f.started.length === 1)
      expect(f.started).toEqual([0])
      f.resolve(0)
      expect(await (await first).text()).toBe('1234567')
      await until(() => f.started.length === 2)
      f.resolve(1)
      expect(await (await second).text()).toBe('abcd')
      expect(f.peak()).toBe(1)
      f.controller.abort()
    },
  )

  it('shares an in-flight legacy pack across ranges without redownloading it', async () => {
    const f = await fixture(['abcdef'])
    const read = createWebDavObjectReader(f.context, config, 'fixture')
    const range = async (offset: number, text: string) => ({
      ...f.object,
      totalSize: 3,
      totalSha256: await hashCloudBlob(new Blob([text])),
      parts: [{ ...f.object.parts[0]!, storedSize: 6, offset, size: 3 }],
    })
    const a = await range(0, 'abc'),
      b = await range(3, 'def')
    const first = read(a),
      second = read(b)
    await until(() => f.started.length === 1)
    f.resolve(0)
    expect(await (await first).text()).toBe('abc')
    expect(await (await second).text()).toBe('def')
    expect(await (await read(a)).text()).toBe('abc')
    expect(f.started).toEqual([0])
    f.controller.abort()
  })

  it('aborts an earlier blocked chunk on a later SHA failure and drains the window', async () => {
    const f = await fixture(['aaa', 'bbb', 'ccc'])
    const read = createWebDavObjectReader(f.context, config, 'fixture')
    const result = read(f.object)
    const rejected = expect(result).rejects.toThrow('分块校验失败')
    await until(() => f.started.length === 2)
    f.resolve(1, new Blob(['bad']))
    await rejected
    expect(f.aborted).toContain(0)
    expect(f.started).toEqual([0, 1])
    expect(f.active()).toBe(0)
    const retry = read(f.object)
    await until(() => f.started.length === 4)
    f.resolve(0)
    f.resolve(1)
    await until(() => f.started.length === 5)
    f.resolve(2)
    expect(await (await retry).text()).toBe('aaabbbccc')
  })

  it('stops active/queued work on cancellation and never resumes from a late response', async () => {
    const f = await fixture(['aaa', 'bbb', 'ccc'])
    const read = createWebDavObjectReader(f.context, config, 'fixture')
    const result = read(f.object)
    const stopped = new DOMException('stopped', 'AbortError')
    const rejected = expect(result).rejects.toBe(stopped)
    await until(() => f.started.length === 2)
    f.controller.abort(stopped)
    await rejected
    f.resolve(0)
    f.resolve(1)
    await expect(read(f.object)).rejects.toBe(stopped)
    expect(f.started).toEqual([0, 1])
    expect(f.active()).toBe(0)
  })
})
