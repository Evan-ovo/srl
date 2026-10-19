/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { createGitHubBundle } from './GitHubBackupBundle'
import type { ArchivedResource } from '../types/Backup'
import type { Resource } from '../types/Resource'
import {
  encodeArchive,
  writeArchiveEntries,
  type ArchiveEncoding,
  type ArchiveEntryWriter,
} from './ArchiveZipWriter'

const MiB = 1024 * 1024
const createdAt = '2026-10-17T00:00:00.000Z'
function resource(id: string, fileSize = 1): Resource {
  return {
    id,
    type: 'other',
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize,
    contentHash: id,
    originalBlob: new Blob([JSON.stringify({ id })]),
    metadata: { complete: id },
    favorite: false,
    categoryId: null,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  } as Resource
}
function encoding(resources: Resource[], versions: Resource[] = []): ArchiveEncoding {
  const path = (record: Resource, historical: boolean) =>
    `${historical ? 'versions' : 'files'}/${record.id}-${record.fileName}`
  return {
    resources,
    versions,
    manifest: {
      format: 'srl-archive',
      version: 4,
      mode: 'full',
      createdAt,
      resourceCount: resources.length,
      categoryCount: 0,
      resources: [],
      versions: [],
      categories: [],
    },
    communitySourceAttachments: [],
    path,
    read: async (record) => record,
    describe: (record, historical) => {
      const { originalBlob: _blob, ...descriptor } = record
      return {
        ...descriptor,
        archivePath: path(record, historical),
      } as ArchivedResource
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Promise.resolve()
  }
  expect(check()).toBe(true)
}
function prefetch(
  options: ArchiveEncoding,
  limits: { concurrency?: number; maxPreparedBytes?: number } = {},
) {
  const controller = new AbortController()
  const onFailure = vi.fn((error: unknown) => controller.abort(error))
  return {
    ...options,
    signal: controller.signal,
    readAhead: { ...limits, onFailure },
    controller,
  }
}

// All fixtures are synthetic. Declared byte budgets are tested without allocating large originals.
describe('bounded archive resource prefetch', () => {
  it('continues after an album SHA failure and never writes the corrupt image into the ZIP', async () => {
    const options = prefetch(encoding([resource('resource')]))
    const blobs = new Map([
      ['a', new Blob(['Aa'])],
      ['b', new Blob(['Bb'])],
    ])
    const albums = await Promise.all(
      [...blobs].map(async ([id, blob]) => ({
        item: {
          id,
          name: `${id}.png`,
          source: 'imported' as const,
          category: '',
          mimeType: 'image/png',
          sizeBytes: blob.size,
          createdAt: 1,
          updatedAt: 1,
        },
        object: (await createGitHubBundle(blob, `${id}.png`)).manifest,
      })),
    )
    options.manifest.portableData = { version: 1, generatedImageAlbum: albums }
    let corrupt = true
    const readAlbumFile = vi.fn(async (id: string) => {
      if (id === 'a' && corrupt) {
        corrupt = false
        return new Blob(['xx'])
      }
      return blobs.get(id)!
    })
    const writes = new Map<string, Blob>()
    const onReadFailures = vi.fn(
      async (failures: readonly { fileName: string; error: string }[]) => {
        expect(failures).toEqual([{ fileName: 'a.png', error: '相册原图校验失败：a.png' }])
        expect(writes.size).toBe(2)
        expect(writes.has('manifest.json')).toBe(false)
      },
    )
    await writeArchiveEntries(
      { ...options, readAlbumFile, onReadFailures },
      {
        write: async (path, blob) => {
          writes.set(path, blob)
        },
      },
    )
    expect(onReadFailures).toHaveBeenCalledOnce()
    expect(readAlbumFile.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a'])
    expect(writes.size).toBe(4)
    expect(await writes.get(`app-data/album/${albums[0]!.object.totalSha256}.bin`)!.text()).toBe(
      'Aa',
    )
    expect(
      JSON.parse(await writes.get('manifest.json')!.text()).portableData.generatedImageAlbum,
    ).toHaveLength(2)
  })

  it('retains encoded successes across explicit retries and only finalizes a complete ZIP (1000 synthetic originals)', async () => {
    // 1000 x 1 MiB are declarations only; payloads are tiny, not a real GB memory benchmark.
    const records = Array.from({ length: 1000 }, (_, index) =>
      resource(String(index).padStart(4, '0'), MiB),
    )
    const options = prefetch(encoding(records))
    const attempts = new Map<string, number>()
    options.read = async (record) => {
      const count = (attempts.get(record.id) ?? 0) + 1
      attempts.set(record.id, count)
      if (record.id === '0000' && count < 3) throw new Error('network stalled')
      return record
    }
    const retries = [deferred<void>(), deferred<void>()]
    const failuresSeen = [deferred<void>(), deferred<void>()]
    const onReadFailures = vi.fn(() => {
      const index = onReadFailures.mock.calls.length - 1
      failuresSeen[index]!.resolve()
      return retries[index]!.promise
    })
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const running = encodeArchive({ ...options, onReadFailures }, async (chunk) => {
      chunks.push(chunk)
    })
    await Promise.race([failuresSeen[0]!.promise, running])
    expect(onReadFailures).toHaveBeenCalledTimes(1)
    expect(onReadFailures.mock.calls[0]).toEqual([
      [{ fileName: '0000.json', error: 'network stalled' }],
    ])
    expect(attempts.size).toBe(1000)
    expect(options.controller.signal.aborted).toBe(false)
    const written = chunks.reduce((total, chunk) => total + chunk.length, 0)
    expect(written).toBeGreaterThan(0)
    retries[0]!.resolve()
    await Promise.race([failuresSeen[1]!.promise, running])
    expect(onReadFailures).toHaveBeenCalledTimes(2)
    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(written)
    expect(attempts.get('0000')).toBe(2)
    retries[1]!.resolve()
    await running
    expect(options.readAhead.onFailure).not.toHaveBeenCalled()
    expect(attempts.get('0000')).toBe(3)
    expect([...attempts].filter(([id]) => id !== '0000').every(([, count]) => count === 1)).toBe(
      true,
    )
    const zip = unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer()))
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
    expect(manifest.resources).toHaveLength(1000)
    expect(
      new Set(manifest.resources.map((record: ArchivedResource) => record.archivePath)).size,
    ).toBe(1000)
    for (const record of records)
      expect(new TextDecoder().decode(zip[options.path(record, false)])).toBe(
        await record.originalBlob.text(),
      )
  })

  it('aborts a manual retry wait even if the UI callback never settles; late approval cannot restart reads', async () => {
    const options = prefetch(encoding([resource('a'), resource('b')]))
    options.read = vi.fn(async (record) => {
      if (record.id === 'a') throw new Error('failed a')
      return record
    })
    const retry = deferred<void>()
    const onReadFailures = vi.fn(() => retry.promise)
    const write = vi.fn(async () => {})
    const running = writeArchiveEntries({ ...options, onReadFailures }, { write })
    const stopped = expect(running).rejects.toThrow('user stopped')
    await vi.waitFor(() => expect(onReadFailures).toHaveBeenCalledOnce())
    expect(write.mock.calls).toHaveLength(1)
    options.controller.abort(new Error('user stopped'))
    await stopped
    retry.resolve()
    await Promise.resolve()
    expect(options.read).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('reads attachments lazily, continues after a failed attachment and retries only that body', async () => {
    const options = prefetch(encoding([resource('a')]))
    options.communitySourceAttachments = ['one', 'two', 'three'].map((assetId) => ({
      assetId,
      blob: new Blob(),
    }))
    let failed = false
    const readCommunityAttachment = vi.fn(async (assetId: string) => {
      if (assetId === 'one' && !failed) {
        failed = true
        throw new Error('attachment disconnected')
      }
      return new Blob([assetId])
    })
    const write = vi.fn(async () => {})
    const onReadFailures = vi.fn(async () => {
      expect(readCommunityAttachment.mock.calls.map(([id]) => id)).toEqual(['one', 'two', 'three'])
      expect(write.mock.calls).toHaveLength(3)
    })
    await writeArchiveEntries({ ...options, readCommunityAttachment, onReadFailures }, { write })
    expect(onReadFailures).toHaveBeenCalledExactlyOnceWith([
      { fileName: 'one', error: 'attachment disconnected' },
    ])
    expect(readCommunityAttachment.mock.calls.map(([id]) => id)).toEqual([
      'one',
      'two',
      'three',
      'one',
    ])
    expect(write).toHaveBeenCalledTimes(5)
  })

  it('keeps ZIP sink errors fatal even when read recovery is enabled', async () => {
    const options = prefetch(encoding([resource('a')]))
    const onReadFailures = vi.fn(async () => {})
    const failure = new Error('disk quota')
    await expect(
      writeArchiveEntries(
        { ...options, onReadFailures },
        {
          write: async () => {
            throw failure
          },
        },
      ),
    ).rejects.toBe(failure)
    expect(options.readAhead.onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(onReadFailures).not.toHaveBeenCalled()
  })

  it('starts at most three reads and preserves sorted writes under sink backpressure', async () => {
    const records = ['e', 'c', 'a', 'b', 'd'].map((id) => resource(id))
    const options = prefetch(encoding(records), { concurrency: 100 })
    const reads = new Map<string, ReturnType<typeof deferred<Resource>>>()
    options.read = vi.fn((record) => {
      const read = deferred<Resource>()
      reads.set(record.id, read)
      return read.promise
    })
    const firstWrite = deferred<void>()
    const writes: string[] = []
    let manifest: { resources: Resource[] } | undefined
    const running = writeArchiveEntries(options, {
      write: async (path, blob) => {
        writes.push(path)
        if (path === options.path(resource('a'), false)) await firstWrite.promise
        if (path === 'manifest.json') manifest = JSON.parse(await blob.text())
      },
    })
    await until(() => reads.size === 3)
    expect([...reads.keys()]).toEqual(['a', 'b', 'c'])
    reads.get('c')!.resolve(records[1]!)
    reads.get('b')!.resolve(records[3]!)
    await Promise.resolve()
    expect(writes).toEqual([])
    reads.get('a')!.resolve(records[2]!)
    await until(() => writes.length === 1)
    expect(reads.size).toBe(3)
    firstWrite.resolve()
    await until(() => reads.size === 5)
    reads.get('e')!.resolve(records[0]!)
    reads.get('d')!.resolve(records[4]!)
    const paths = await running
    expect(paths).toEqual(
      ['a', 'b', 'c', 'd', 'e']
        .map((id) => options.path(resource(id), false))
        .concat('manifest.json'),
    )
    expect(writes).toEqual(paths)
    expect(manifest!.resources.map((record) => record.id)).toEqual(['e', 'c', 'a', 'b', 'd'])
    expect(options.readAhead.onFailure).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'default ceiling',
      sizes: [20, 12, 1, 40, 1].map((size) => size * MiB),
      limit: 32 * MiB,
      requested: Number.MAX_SAFE_INTEGER,
    },
    {
      name: 'operation downgrade',
      sizes: [5, 3, 1, 10, 1],
      limit: 8,
      requested: 8,
    },
  ])(
    'reserves declared originals through writes and admits oversize alone ($name)',
    async ({ sizes, limit, requested }) => {
      const records = sizes.map((size, index) => resource(String(index), size))
      const options = prefetch(encoding(records), {
        maxPreparedBytes: requested,
      })
      const gates = records.map(() => deferred<void>())
      const started: string[] = []
      const writing: string[] = []
      const retained = new Map<string, number>()
      const reservations: number[][] = []
      options.read = vi.fn(async (record) => {
        started.push(record.id)
        retained.set(record.id, record.fileSize)
        reservations.push([...retained.values()])
        return record
      })
      const running = writeArchiveEntries(options, {
        write: async (_path, _blob, info) => {
          if (!info.descriptor) return
          const id = info.descriptor.id
          writing.push(id)
          await gates[Number(id)]!.promise
          retained.delete(id)
        },
      })
      await until(() => writing.length === 1)
      expect(started).toEqual(['0', '1'])
      gates[0]!.resolve()
      await until(() => writing.length === 2)
      expect(started).toEqual(['0', '1', '2'])
      gates[1]!.resolve()
      await until(() => writing.length === 3)
      expect(started).toEqual(['0', '1', '2'])
      gates[2]!.resolve()
      await until(() => writing.length === 4)
      expect(started).toEqual(['0', '1', '2', '3'])
      gates[3]!.resolve()
      await until(() => writing.length === 5)
      gates[4]!.resolve()
      await running
      expect(
        reservations.every(
          (sizes) =>
            sizes.length <= 3 &&
            (sizes.length === 1 || sizes.reduce((sum, size) => sum + size, 0) <= limit),
        ),
      ).toBe(true)
    },
  )

  it('keeps invalid declared sizes alone and permits a serial operation downgrade', async () => {
    for (const fileSize of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const records = [resource('a', fileSize), resource('b')]
      const options = prefetch(encoding(records))
      const gate = deferred<void>()
      options.read = vi.fn(async (record) => record)
      const write = vi.fn(async (_path, _blob, info) => {
        if (info.descriptor?.id === 'a') await gate.promise
      })
      const running = writeArchiveEntries(options, { write })
      await until(() => write.mock.calls.length === 1)
      expect(options.read).toHaveBeenCalledTimes(1)
      gate.resolve()
      await running
    }
    const options = prefetch(encoding([resource('a'), resource('b')]), {
      concurrency: 1,
    })
    options.read = vi.fn(async (record) => record)
    await expect(
      writeArchiveEntries(options, {
        write: async () => {
          throw new Error('full')
        },
      }),
    ).rejects.toThrow('full')
    expect(options.read).toHaveBeenCalledTimes(1)
  })

  it('skips checkpoint originals while preserving current/history identity and manifest order', async () => {
    const options = prefetch(encoding([resource('b'), resource('a')], [resource('a')]))
    options.read = vi.fn(async (record) => record)
    const cachedCurrent = {
      ...options.describe(options.resources[1]!, false),
      name: 'cached current',
    }
    const cachedVersion = {
      ...options.describe(options.versions[0]!, true),
      name: 'cached history',
    }
    let manifest: { resources: ArchivedResource[]; versions: ArchivedResource[] } | undefined
    const write = vi.fn(async (path: string, blob: Blob) => {
      if (path === 'manifest.json') manifest = JSON.parse(await blob.text())
    })
    const cached = vi.fn(async (path: string) =>
      path.startsWith('versions/')
        ? cachedVersion
        : path.includes('/a-')
          ? cachedCurrent
          : undefined,
    )
    expect(await writeArchiveEntries(options, { cached, write })).toEqual([
      options.path(options.resources[1]!, false),
      options.path(options.resources[0]!, false),
      options.path(options.versions[0]!, true),
      'manifest.json',
    ])
    expect(options.read).toHaveBeenCalledTimes(1)
    expect(options.read).toHaveBeenCalledWith(options.resources[0], false)
    expect(cached).toHaveBeenCalledTimes(3)
    expect(write.mock.calls.map(([path]) => path)).toEqual([
      options.path(options.resources[0]!, false),
      'manifest.json',
    ])
    expect(manifest!.resources.map((record) => record.id)).toEqual(['b', 'a'])
    expect(manifest!.resources[1]).toEqual(cachedCurrent)
    expect(manifest!.versions).toEqual([cachedVersion])
  })

  it('produces byte-identical ZIPs to serial encoding with originals, history and sidecars', async () => {
    const options = encoding([resource('b'), resource('a')], [resource('old')])
    options.resources[0]!.fileName = 'b.png'
    options.resources[0]!.mimeType = 'image/png'
    options.communitySourceAttachments = [{ assetId: 'attachment', blob: new Blob(['attachment']) }]
    options.communitySourceData = { version: 1, sources: [], messages: [], bindings: [] }
    const encode = async (value: ArchiveEncoding) => {
      const chunks: Uint8Array<ArrayBuffer>[] = []
      await encodeArchive(value, async (chunk) => {
        chunks.push(chunk)
      })
      return new Uint8Array(await new Blob(chunks).arrayBuffer())
    }
    const serial = await encode(options)
    const pipelined = await encode(prefetch(options))
    expect(pipelined).toEqual(serial)
    const entries = unzipSync(pipelined)
    expect(Object.keys(entries).at(-1)).toBe('manifest.json')
    expect(entries[options.path(options.resources[0]!, false)]).toEqual(
      new Uint8Array(await options.resources[0]!.originalBlob.arrayBuffer()),
    )
  })

  it('keeps uncancellable ordinary exports serial on sink failure', async () => {
    const options = encoding([resource('a'), resource('b'), resource('c')])
    options.read = vi.fn(async (record) => record)
    const write = vi.fn(async () => {
      throw new Error('disk full')
    })
    await expect(writeArchiveEntries(options, { write })).rejects.toThrow('disk full')
    expect(options.read).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('aborts prefetched reads when the real ZIP sink fails and never emits later chunks', async () => {
    const records = ['a', 'b', 'c', 'd'].map((id) => resource(id))
    const options = prefetch(encoding(records))
    const drained: string[] = []
    options.read = vi.fn(async (record) => {
      if (record.id === 'a') return record
      return new Promise<Resource>((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            drained.push(record.id)
            reject(options.signal.reason)
          },
          { once: true },
        )
      })
    })
    const failure = new Error('ZIP destination full')
    const sink = vi.fn(async () => {
      throw failure
    })
    await expect(encodeArchive(options, sink)).rejects.toBe(failure)
    expect(options.read).toHaveBeenCalledTimes(3)
    expect(drained).toEqual(['b', 'c'])
    expect(sink).toHaveBeenCalledTimes(1)
    expect(options.readAhead.onFailure).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it.each(['read', 'sink', 'cancel', 'cached'] as const)(
    'stops, cancels and drains pending work after %s failure without late writes',
    async (kind) => {
      const records = ['a', 'b', 'c', 'd'].map((id) => resource(id))
      const options = prefetch(encoding(records))
      const gates = new Map(records.map((record) => [record.id, deferred<Resource>()]))
      const aborted: string[] = []
      const started: string[] = []
      const failure = new Error(`${kind} failed`)
      const cacheGate = deferred<ArchivedResource | undefined>()
      options.read = vi.fn((record) => {
        started.push(record.id)
        options.signal.addEventListener(
          'abort',
          () => {
            aborted.push(record.id)
          },
          { once: true },
        )
        return gates.get(record.id)!.promise
      })
      const write = vi.fn(async () => {
        if (kind === 'sink') throw failure
      })
      const writer: ArchiveEntryWriter = {
        write,
        ...(kind === 'cached'
          ? {
              cached: (path: string) =>
                path.includes('/b-') ? cacheGate.promise : Promise.resolve(undefined),
            }
          : {}),
      }
      let settled = false
      const running = writeArchiveEntries(options, writer).finally(() => {
        settled = true
      })
      const rejected = expect(running).rejects.toBe(failure)
      await until(() => started.length === (kind === 'cached' ? 2 : 3))
      if (kind === 'read') gates.get('b')!.reject(failure)
      if (kind === 'cached') cacheGate.reject(failure)
      if (kind === 'sink') gates.get('a')!.resolve(records[0]!)
      if (kind === 'cancel') options.controller.abort(failure)
      await until(() => options.signal.aborted)
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(started).not.toContain('d')
      expect(aborted).toEqual(started)
      // One late fulfillment and the other rejections must all be consumed before returning.
      gates.get('a')!.reject(new Error('aborted a'))
      if (kind !== 'read' && kind !== 'cached') gates.get('b')!.reject(new Error('aborted b'))
      gates.get('c')!.resolve(records[2]!)
      await rejected
      expect(settled).toBe(true)
      expect(options.readAhead.onFailure).toHaveBeenCalledExactlyOnceWith(failure)
      expect(write).toHaveBeenCalledTimes(kind === 'sink' ? 1 : 0)
    },
  )

  it('cancels before launching any read for an already-aborted operation', async () => {
    const options = prefetch(encoding([resource('a')]))
    const reason = new Error('cancelled')
    options.read = vi.fn(async (record) => record)
    const write = vi.fn(async () => {})
    options.controller.abort(reason)
    await expect(writeArchiveEntries(options, { write })).rejects.toBe(reason)
    expect(options.read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('overlaps synthetic 20 ms reads with 10 ms writes without changing output (virtual clock only)', async () => {
    vi.useFakeTimers()
    try {
      const measure = async (ahead: boolean) => {
        const options = encoding(Array.from({ length: 9 }, (_, index) => resource(String(index))))
        options.read = async (record) => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return record
        }
        const output: string[] = []
        const start = Date.now()
        const running = writeArchiveEntries(ahead ? prefetch(options) : options, {
          write: async (path, _blob, info) => {
            if (info.descriptor) await new Promise((resolve) => setTimeout(resolve, 10))
            output.push(path)
          },
        })
        await vi.runAllTimersAsync()
        await running
        return { elapsed: Date.now() - start, output }
      }
      const serial = await measure(false)
      const pipelined = await measure(true)
      expect(serial.elapsed).toBe(270)
      expect(pipelined.elapsed).toBe(110)
      expect(pipelined.output).toEqual(serial.output)
    } finally {
      vi.useRealTimers()
    }
  })
})
