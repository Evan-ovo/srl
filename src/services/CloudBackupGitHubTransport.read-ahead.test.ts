/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import type { GitHubBackupConfig } from '../types/CloudBackup'
import { RESOURCE_TYPE } from '../types/Resource'
import { hashCloudBlob } from './CloudArchiveCodec'
import { CloudRequestTimeoutError } from './CloudBackupHttp'
import { CloudBackupTransport } from './CloudBackupTransport'
import { createGitHubObjectReader, listGitHub } from './CloudBackupGitHubTransport'
import {
  buildNativeRestorePlan,
  reuseUnchangedStructuredBackup,
  type CloudBackupSnapshotOperationsContext,
} from './CloudBackupSnapshotOperations'
import type { CloudBackupTransportContext, GitHubAsset } from './CloudBackupTransportContext'
import { structuredPartIdentity } from './CloudBackupPolicy'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import type { StructuredResource, StructuredSnapshot } from './CloudStructuredSnapshot'

const config: GitHubBackupConfig = {
  provider: 'github',
  owner: 'fixture',
  repository: 'backup',
  retention: 7,
  autoBackup: false,
}
const container = 'srl-cloud-objects-0001'
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-1
const workerStorageKey = 'srl.publicWorker.baseUrl.v1'
function useCustomWorkerForProxyTests() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>([[workerStorageKey, 'https://relay.example.com']])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    },
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}
// SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-1
async function until(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 1_000, interval: 1 })
}

async function fixture(texts: string[][], signal?: AbortSignal) {
  const bodies = new Map<number, Blob>()
  const assets: GitHubAsset[] = []
  const objects: GitHubBundleManifest[] = []
  for (const [index, chunks] of texts.entries()) {
    const parts: GitHubBundleManifest['parts'] = []
    for (const text of chunks) {
      const body = new Blob([text])
      const hash = await hashCloudBlob(body)
      let asset = assets.find((value) => value.name === `srl-chunk--sha256-${hash}`)
      if (!asset) {
        asset = {
          id: assets.length + 1,
          name: `srl-chunk--sha256-${hash}`,
          size: body.size,
          state: 'uploaded',
          created_at: '',
          url: '',
        }
        assets.push(asset)
        bodies.set(asset.id, body)
      }
      parts.push({
        name: asset.name,
        storage: { kind: 'github-release', container, objectKey: asset.name },
        size: body.size,
        sha256: hash,
      })
    }
    const body = new Blob(chunks)
    objects.push({
      format: 'srl-github-backup-bundle',
      version: 2,
      createdAt: '2026-10-17T00:00:00Z',
      fileName: `fixture-${index}.bin`,
      totalSize: body.size,
      totalSha256: await hashCloudBlob(body),
      parts,
    })
  }
  const gates = new Map<
    number,
    { resolve: (response: Response) => void; reject: (reason: unknown) => void }
  >()
  const started: number[] = [],
    aborted: number[] = []
  let automatic = false,
    delayedAbort = false,
    active = 0,
    peak = 0
  const delayed: Array<() => void> = []
  const githubFetch = vi.fn(
    async (_config: unknown, _secret: string, path: string, init?: RequestInit) => {
      const id = Number(path.split('/').at(-1))
      started.push(id)
      active++
      peak = Math.max(peak, active)
      const requestSignal = init?.signal
      let onAbort: () => void = () => undefined
      try {
        return await new Promise<Response>((resolve, reject) => {
          gates.set(id, { resolve, reject })
          onAbort = () => {
            aborted.push(id)
            const fail = () => reject(requestSignal?.reason)
            if (delayedAbort) delayed.push(fail)
            else fail()
          }
          if (requestSignal?.aborted) onAbort()
          else requestSignal?.addEventListener('abort', onAbort, { once: true })
          if (automatic) resolve(new Response(bodies.get(id)))
        })
      } finally {
        requestSignal?.removeEventListener('abort', onAbort)
        gates.delete(id)
        active--
      }
    },
  )
  const context = {
    signal,
    githubFetch,
    getGitHubRelease: vi.fn(async () => ({
      id: 1,
      assets: [],
      tag_name: container,
    })),
    listGitHubAssets: vi.fn(async () => assets),
    readResponseBlob: vi.fn((response: Response) => response.blob()),
  } as unknown as CloudBackupTransportContext
  return {
    context,
    objects,
    assets,
    bodies,
    started,
    aborted,
    githubFetch,
    active: () => active,
    peak: () => peak,
    respond: (id: number, response: Response) => gates.get(id)!.resolve(response),
    finish: (id: number, body = bodies.get(id)!) => gates.get(id)!.resolve(new Response(body)),
    finishAll: () => {
      automatic = true
      for (const [id, gate] of gates) gate.resolve(new Response(bodies.get(id)))
    },
    delayAborts: () => {
      delayedAbort = true
    },
    releaseAborts: () => {
      for (const fail of delayed.splice(0)) fail()
    },
  }
}

function snapshot(object: GitHubBundleManifest): StructuredSnapshot {
  return {
    format: 'srl-structured-cloud-snapshot',
    version: 3,
    createdAt: object.createdAt,
    categories: [],
    versions: [],
    portableData: { version: 1 },
    resources: [
      {
        id: 'fixture',
        type: RESOURCE_TYPE.OTHER,
        name: object.fileName,
        fileName: object.fileName,
        fileSize: object.totalSize,
        object,
      } as StructuredResource,
    ],
  }
}

describe('bounded GitHub chunk read ahead', () => {
  it('keeps byte-budget permits until ordered consumption, then assembles identical bytes', async () => {
    const test = await fixture([['aaaa', 'bbbb', 'cccc', 'dddd']])
    const reader = await createGitHubObjectReader(test.context, config, 'fixture', {
      byteBudget: 8,
    })
    const result = reader(test.objects[0]!)
    await until(() => test.started.length === 2)
    test.finish(2)
    await until(() => vi.mocked(test.context.readResponseBlob).mock.calls.length === 1)
    await tick()
    expect(test.started).toEqual([1, 2])
    test.finish(1)
    await until(() => test.started.length >= 3)
    test.finishAll()
    expect(await (await result).text()).toBe('aaaabbbbccccdddd')
    expect(test.peak()).toBe(2)
  })

  it('shares a maximum of three requests across concurrent resource reads', async () => {
    const test = await fixture([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
      ['c1', 'c2', 'c3'],
    ])
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    const result = Promise.all(test.objects.map(reader))
    await until(() => test.started.length === 3)
    expect(test.active()).toBe(3)
    test.finishAll()
    expect(await Promise.all((await result).map((blob) => blob.text()))).toEqual([
      'a1a2a3',
      'b1b2b3',
      'c1c2c3',
    ])
    expect(test.peak()).toBe(3)
    expect(test.started).toHaveLength(9)
  })

  it('shares the stored-byte budget across separate resource reads', async () => {
    const test = await fixture([['aaaa'], ['bbbb'], ['cccc']])
    const reader = await createGitHubObjectReader(test.context, config, 'fixture', {
      byteBudget: 8,
    })
    const result = Promise.all(test.objects.map(reader))
    await until(() => test.started.length === 2)
    await tick()
    expect(test.started).toHaveLength(2)
    test.finishAll()
    expect(await Promise.all((await result).map((blob) => blob.text()))).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ])
    expect(test.peak()).toBe(2)
  })

  it('runs an oversized part alone and supports a serial lower-budget fallback', async () => {
    for (const concurrency of [1, 3]) {
      const test = await fixture([['oversized', 'two', 'three']])
      const reader = await createGitHubObjectReader(test.context, config, 'fixture', {
        concurrency,
        byteBudget: 4,
      })
      const result = reader(test.objects[0]!)
      await until(() => test.started.length === 1)
      await tick()
      expect(test.started).toEqual([1])
      test.finishAll()
      expect(await (await result).text()).toBe('oversizedtwothree')
      expect(test.peak()).toBe(1)
    }
  })

  it('deduplicates shared reads, retains the larger verified chunk, and evicts it for a larger one', async () => {
    const test = await fixture([['shared'], ['shared'], ['other'], ['larger-chunk']])
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    const first = reader(test.objects[0]!),
      second = reader(test.objects[1]!)
    await until(() => test.started.length === 1)
    test.finishAll()
    expect(await (await first).text()).toBe('shared')
    expect(await (await second).text()).toBe('shared')
    await reader(test.objects[0]!)
    expect(test.started).toEqual([1])
    await reader(test.objects[2]!)
    await reader(test.objects[0]!)
    expect(test.started).toEqual([1, 2])
    await reader(test.objects[3]!)
    await reader(test.objects[0]!)
    expect(test.started).toEqual([1, 2, 3, 1])
  })

  it('does not deadlock shared chunks referenced in a different resource order', async () => {
    const test = await fixture([
      ['head', 'shared', 'tail'],
      ['oversized', 'shared'],
    ])
    const reader = await createGitHubObjectReader(test.context, config, 'fixture', {
      byteBudget: 8,
    })
    test.finishAll()
    const results = await Promise.all(test.objects.map(reader))
    expect(await Promise.all(results.map((blob) => blob.text()))).toEqual([
      'headsharedtail',
      'oversizedshared',
    ])
    expect(test.started.filter((id) => id === 2)).toHaveLength(1)
  })

  it('isolates corruption to its resource, drains its reads and leaves other resources running', async () => {
    const test = await fixture([['head', 'next', 'tail', 'more'], ['else']])
    test.delayAborts()
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    let settled = false
    const results = Promise.allSettled(test.objects.map(reader)).then((result) => {
      settled = true
      return result
    })
    await until(() => test.started.length === 3)
    expect(test.started).toContain(2)
    test.finish(2, new Blob(['BAD!']))
    await until(() => test.aborted.length >= 1)
    expect(test.aborted).not.toContain(5)
    expect(settled).toBe(false)
    test.releaseAborts()
    await until(() => test.started.includes(5))
    test.finish(5)
    const failures = await results
    expect(failures[0]!.status).toBe('rejected')
    expect(failures[1]!.status).toBe('fulfilled')
    if (failures[0]!.status === 'rejected')
      expect(failures[0]!.reason.message).toContain('分块校验失败')
    expect(test.active()).toBe(0)
    test.finishAll()
    expect(await (await reader(test.objects[0]!)).text()).toBe('headnexttailmore')
    expect(test.started.filter((id) => id === 1)).toHaveLength(2)
  })

  it('preserves a stalled-body timeout, aborts sibling lookahead and starts an explicit retry cleanly', async () => {
    const test = await fixture([['one', 'two', 'three', 'four']])
    test.delayAborts()
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    let settled = false
    const result = reader(test.objects[0]!).catch((error: unknown) => {
      settled = true
      return error as Error
    })
    await until(() => test.started.length === 3)
    let body!: ReadableStreamDefaultController<Uint8Array>
    test.respond(
      2,
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
          },
        }),
      ),
    )
    await until(() => vi.mocked(test.context.readResponseBlob).mock.calls.length === 1)
    const timeout = new CloudRequestTimeoutError(45_000)
    body.error(timeout)
    await until(() => test.aborted.length === 2)
    expect(settled).toBe(false)
    test.releaseAborts()
    const failure = await result
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toBe(timeout)
    expect((failure as Error).message).toContain('45 秒没有收到响应或新数据')
    expect(test.started).toEqual([1, 2, 3])
    expect(test.active()).toBe(0)
    test.finishAll()
    expect(await (await reader(test.objects[0]!)).text()).toBe('onetwothreefour')
    expect(test.started.filter((id) => id === 2)).toHaveLength(2)
  })

  it('cancels active and queued chunks without scheduling later work or returning before requests drain', async () => {
    const controller = new AbortController()
    const test = await fixture([['one', 'two', 'three', 'four']], controller.signal)
    test.delayAborts()
    const reader = await createGitHubObjectReader(test.context, config, 'fixture', {
      byteBudget: 6,
    })
    let settled = false
    const result = reader(test.objects[0]!).catch((error: unknown) => {
      settled = true
      return error
    })
    await until(() => test.started.length === 2)
    const stop = new Error('User stopped')
    controller.abort(stop)
    await until(() => test.aborted.length === 2)
    expect(settled).toBe(false)
    test.releaseAborts()
    expect(await result).toBe(stop)
    expect(test.active()).toBe(0)
    expect(test.started).toEqual([1, 2])
    await expect(reader(test.objects[0]!)).rejects.toBe(stop)
  })

  it('shares one stale-container refresh across concurrent 404s and rebinds every matching chunk', async () => {
    const test = await fixture([['one', 'two', 'three']])
    const fresh = test.assets.map((asset) => ({ ...asset, id: asset.id + 100 }))
    vi.mocked(test.context.listGitHubAssets)
      .mockResolvedValueOnce(test.assets)
      .mockResolvedValue(fresh)
    test.githubFetch.mockImplementation(async (_config, _secret, path) => {
      const id = Number(path.split('/').at(-1))
      if (id < 100) throw Object.assign(new Error('old attachment'), { status: 404 })
      return new Response(test.bodies.get(id - 100))
    })
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    expect(await (await reader(test.objects[0]!)).text()).toBe('onetwothree')
    expect(test.context.listGitHubAssets).toHaveBeenCalledTimes(2)
    expect(test.githubFetch).toHaveBeenCalledTimes(6)
  })

  it('uses the real scoped transport without AbortSignal.any and still cancels streaming bodies', async () => {
    const test = await fixture([['one', 'two']])
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-2
    const restoreWorker = useCustomWorkerForProxyTests()
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-2
    class Probe extends CloudBackupTransport {
      reader(signal: AbortSignal) {
        return this.createGitHubObjectReader(config, 'fixture', { signal })
      }
    }
    const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
    const signals: AbortSignal[] = []
    const cancelled: number[] = []
    const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
    const originalFetch = globalThis.fetch
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid')
      const target = new URL(url.searchParams.get('url')!)
      const headers = { 'x-srl-cloud-proxy': '1' }
      if (target.pathname.includes('/releases/tags/'))
        return new Response(JSON.stringify({ id: 1, assets: [] }), { headers })
      if (target.pathname.endsWith('/releases/1/assets'))
        return new Response(JSON.stringify(test.assets), { headers })
      const id = Number(target.pathname.split('/').at(-1))
      signals.push(init!.signal!)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.set(id, controller)
          },
          cancel() {
            cancelled.push(id)
          },
        }),
        { headers },
      )
    }
    try {
      const controller = new AbortController()
      const reader = await new Probe().reader(controller.signal)
      const result = reader(test.objects[0]!).catch((error: unknown) => error)
      await until(() => streams.size === 2)
      const stop = new Error('stop streaming')
      controller.abort(stop)
      expect(await result).toBe(stop)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(cancelled.sort()).toEqual([1, 2])
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(AbortSignal, 'any', originalAny)
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-3
      restoreWorker()
      // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-3
    }
  })

  it('aborts a stalled 404 metadata refresh when a sibling fails SHA, without aborting the parent', async () => {
    const test = await fixture([['one', 'two']])
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-4
    const restoreWorker = useCustomWorkerForProxyTests()
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-4
    class Probe extends CloudBackupTransport {
      reader(signal: AbortSignal) {
        return this.createGitHubObjectReader(config, 'fixture', { signal })
      }
    }
    const parent = new AbortController()
    let listings = 0,
      refreshStarted = false,
      metadataCancelled = false
    let firstBody!: ReadableStreamDefaultController<Uint8Array>
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), 'https://fixture.invalid')
      const target = new URL(url.searchParams.get('url')!)
      const headers = { 'x-srl-cloud-proxy': '1' }
      if (target.pathname.includes('/releases/tags/'))
        return new Response(JSON.stringify({ id: 1, assets: [] }), { headers })
      if (target.pathname.endsWith('/releases/1/assets')) {
        if (++listings === 1) return new Response(JSON.stringify(test.assets), { headers })
        refreshStarted = true
        return new Response(
          new ReadableStream({
            cancel() {
              metadataCancelled = true
            },
          }),
          { headers },
        )
      }
      if (target.pathname.endsWith('/assets/1'))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              firstBody = controller
            },
          }),
          { headers },
        )
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers })
    }
    try {
      const reader = await new Probe().reader(parent.signal)
      let settled = false
      const result = reader(test.objects[0]!).catch((error: unknown) => {
        settled = true
        return error as Error
      })
      await until(() => refreshStarted && !!firstBody)
      firstBody.enqueue(new TextEncoder().encode('BAD'))
      firstBody.close()
      await until(() => settled)
      expect(((await result) as Error).message).toContain('分块校验失败')
      expect(metadataCancelled).toBe(true)
      expect(parent.signal.aborted).toBe(false)
      expect(listings).toBe(2)
    } finally {
      parent.abort()
      globalThis.fetch = originalFetch
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-5
      restoreWorker()
      // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-5
    }
  })

  it('disposes successful batch signal links while the parent operation stays live', async () => {
    const test = await fixture([['one'], ['two']])
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-6
    const restoreWorker = useCustomWorkerForProxyTests()
    // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-6
    class Probe extends CloudBackupTransport {
      reader(signal: AbortSignal) {
        return this.createGitHubObjectReader(config, 'fixture', { signal })
      }
    }
    const controller = new AbortController()
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    const added = vi
      .spyOn(controller.signal, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) listeners.add(listener)
        add(type, listener, options)
      })
    const removed = vi
      .spyOn(controller.signal, 'removeEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'abort' && listener) listeners.delete(listener)
        remove(type, listener, options)
      })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), 'https://fixture.invalid')
      const target = new URL(url.searchParams.get('url')!)
      const headers = { 'x-srl-cloud-proxy': '1' }
      if (target.pathname.includes('/releases/tags/'))
        return new Response(JSON.stringify({ id: 1, assets: [] }), { headers })
      if (target.pathname.endsWith('/releases/1/assets'))
        return new Response(JSON.stringify(test.assets), { headers })
      return new Response(test.bodies.get(Number(target.pathname.split('/').at(-1))), { headers })
    }
    try {
      const reader = await new Probe().reader(controller.signal)
      for (let index = 0; index < 20; index++) {
        expect(await (await reader(test.objects[index % 2]!)).text()).toBe(
          index % 2 ? 'two' : 'one',
        )
        // Only the bounded last-chunk cache's operation-lifetime cleanup remains.
        expect(listeners.size).toBe(1)
      }
      expect(controller.signal.aborted).toBe(false)
    } finally {
      controller.abort()
      added.mockRestore()
      removed.mockRestore()
      globalThis.fetch = originalFetch
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-7
      restoreWorker()
      // SRL-PUBLIC-SYNC: END REPLACE id=public-cloudbackupgithubtransport-read-ahead-test-ts-7
    }
  })

  it('validates all references before downloading and rejects missing, wrong-size and starter chunks', async () => {
    for (const kind of ['missing', 'size', 'starter']) {
      const test = await fixture([['one', 'two']])
      if (kind === 'missing') test.assets.pop()
      else if (kind === 'size') test.assets[1]!.size++
      else test.assets[1]!.state = 'starter'
      const reader = await createGitHubObjectReader(test.context, config, 'fixture')
      await expect(reader(test.objects[0]!)).rejects.toThrow(
        kind === 'starter' ? '上传未完成' : '缺少分块',
      )
      expect(test.githubFetch).not.toHaveBeenCalled()
    }
  })

  it('preserves slice and whole-object SHA checks and does not retain a cache after failure', async () => {
    const test = await fixture([['0123456789']])
    const original = test.objects[0]!,
      part = original.parts[0]!
    const sliced = {
      ...original,
      totalSize: 4,
      totalSha256: await hashCloudBlob(new Blob(['2345'])),
      parts: [{ ...part, storedSize: 10, offset: 2, size: 4 }],
    }
    test.finishAll()
    const reader = await createGitHubObjectReader(test.context, config, 'fixture')
    expect(await (await reader(sliced)).text()).toBe('2345')
    await expect(reader({ ...sliced, totalSha256: '0'.repeat(64) })).rejects.toThrow(
      '完整性校验失败',
    )
    expect(await (await reader(original)).text()).toBe('0123456789')
    expect(test.started).toEqual([1, 1])
  })
})

describe('GitHub incomplete-asset guard consistency', () => {
  it.each(['starter', 'new'])(
    'hides %s references from lists and reuse, and isolates native preflight failures',
    async (state) => {
      const test = await fixture([['body']])
      test.assets[0]!.state = state
      const saved = snapshot(test.objects[0]!)
      const manifest = {
        id: 10,
        name: 'fixture.srlmanifest.v3.json.gz',
        size: 100,
        state: 'uploaded',
        created_at: '',
        url: '',
      }
      const inventory = new Map([
        [structuredPartIdentity(test.objects[0]!.parts[0]!), test.assets[0]!],
      ])
      const context = {
        ...test.context,
        getGitHubRelease: vi.fn(
          async (_config: unknown, _secret: string, _create: boolean, tag: string) =>
            tag === 'srl-backups'
              ? undefined
              : { id: tag === 'srl-cloud-snapshots' ? 10 : 1, assets: [] },
        ),
        listGitHubAssets: vi.fn(async (_config: unknown, _secret: string, id: number) =>
          id === 10 ? [manifest] : test.assets,
        ),
        readGitHubStructuredSnapshot: vi.fn(async () => saved),
        readGitHubPartInventory: vi.fn(async () => inventory),
      }
      expect(
        await listGitHub(context as unknown as CloudBackupTransportContext, config, 'fixture'),
      ).toEqual([])
      const plan = await buildNativeRestorePlan(
        context as unknown as CloudBackupSnapshotOperationsContext,
        saved,
        config,
        'fixture',
      )
      expect(plan.resources).toEqual([])
      expect(plan.resourceFailures).toEqual([
        expect.objectContaining({ error: expect.stringMatching(/上传未完成.*附件 1/u) }),
      ])
      expect(
        await reuseUnchangedStructuredBackup(
          context as unknown as CloudBackupSnapshotOperationsContext,
          config,
          'fixture',
          manifest.name,
        ),
      ).toBeUndefined()
      expect(test.githubFetch).not.toHaveBeenCalled()
    },
  )

  it.each(['uploaded', undefined])(
    'accepts %s metadata while preserving native segment size and order',
    async (state) => {
      const test = await fixture([['one', 'two']])
      for (const asset of test.assets) asset.state = state
      const saved = snapshot(test.objects[0]!)
      const result = await buildNativeRestorePlan(
        test.context as unknown as CloudBackupSnapshotOperationsContext,
        saved,
        config,
        'fixture',
      )
      expect(result.objects.map((value) => value.size)).toEqual([3, 3])
      expect(result.resources[0]!.segments.map((value) => value.hash)).toEqual(
        test.objects[0]!.parts.map((part) => part.sha256),
      )
      expect(test.githubFetch).not.toHaveBeenCalled()
    },
  )
})
