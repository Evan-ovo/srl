import { describe, expect, it, vi } from 'vitest'
import { createCloudObjectReader, type CloudReadPart } from './CloudBackupObjectReader'
import { planGitHubBundle } from './GitHubBackupBundle'
import type { CloudBackupTransportContext } from './CloudBackupTransportContext'

describe('verified native original reuse in the shared cloud reader', () => {
  it.each([
    [3, 32768, 1],
    [1, 32768, 1],
    [1, 16384, 6],
  ])(
    'bounds the shared-chunk cache with concurrency %s and budget %s',
    async (concurrency, byteBudget, expectedDownloads) => {
      const shared = new Blob([new Uint8Array(32768)])
      const bodies = [shared, new Blob(['one']), new Blob(['two']), new Blob(['end'])]
      const hashes = await Promise.all(
        bodies.map(async (body) => (await planGitHubBundle(body, 'part')).totalSha256),
      )
      const downloads = bodies.map((body) => vi.fn(async () => new Response(body)))
      const context = {
        readResponseBlob: (response: Response) => response.blob(),
      } as unknown as CloudBackupTransportContext
      const read = createCloudObjectReader(
        context,
        'test',
        async (object) =>
          object.parts.map((part) => {
            const index = hashes.indexOf(part.sha256)
            return {
              key: part.sha256,
              size: part.size,
              sha256: part.sha256,
              download: downloads[index]!,
            }
          }),
        concurrency!,
        byteBudget!,
      )
      for (const tail of [1, 2, 3]) {
        const original = new Blob([shared, shared, bodies[tail]!])
        const object = await planGitHubBundle(original, 'original')
        object.parts = [0, 0, tail].map((index) => ({
          name: hashes[index]!,
          size: bodies[index]!.size,
          sha256: hashes[index]!,
        }))
        expect(await (await read(object)).arrayBuffer()).toEqual(await original.arrayBuffer())
      }
      expect(downloads[0]).toHaveBeenCalledTimes(expectedDownloads!)
      for (const download of downloads.slice(1)) expect(download).toHaveBeenCalledOnce()
    },
  )
  it('checks remote locations/state before reusing local bytes and makes no binary request', async () => {
    const blob = new Blob(['verified-original']),
      object = await planGitHubBundle(blob, 'file.bin')
    const download = vi.fn(async () => new Response(blob)),
      events: string[] = []
    const resolve = vi.fn(async (): Promise<CloudReadPart[]> => {
      events.push('remote-metadata')
      return [{ key: 'part', size: blob.size, sha256: object.totalSha256, download }]
    })
    const readLocalObject = vi.fn(async () => {
      events.push('verified-native-original')
      return blob
    })
    const context = { readLocalObject } as unknown as CloudBackupTransportContext
    const read = createCloudObjectReader(context, 'test', resolve, 3, 32 * 1024 * 1024)
    expect(await read(object)).toBe(blob)
    expect(events).toEqual(['remote-metadata', 'verified-native-original'])
    expect(download).not.toHaveBeenCalled()
  })
  it('does not bypass missing or unfinished remote object validation', async () => {
    const blob = new Blob(['body']),
      object = await planGitHubBundle(blob, 'file.bin')
    const readLocalObject = vi.fn(async () => blob)
    const context = { readLocalObject } as unknown as CloudBackupTransportContext
    const read = createCloudObjectReader(
      context,
      'test',
      async () => {
        throw Error('上传未完成')
      },
      3,
      32 * 1024 * 1024,
    )
    await expect(read(object)).rejects.toThrow('上传未完成')
    expect(readLocalObject).not.toHaveBeenCalled()
  })
  it('downloads and verifies the original when native reuse is unavailable or rejected', async () => {
    const blob = new Blob(['remote-original']),
      object = await planGitHubBundle(blob, 'file.bin')
    const download = vi.fn(async () => new Response(blob))
    const context = {
      readLocalObject: async () => undefined,
      readResponseBlob: (response: Response) => response.blob(),
    } as unknown as CloudBackupTransportContext
    const read = createCloudObjectReader(
      context,
      'test',
      async () => [{ key: 'part', size: blob.size, sha256: object.totalSha256, download }],
      3,
      32 * 1024 * 1024,
    )
    expect(await (await read(object)).text()).toBe('remote-original')
    expect(download).toHaveBeenCalledOnce()
  })
  it('ignores a late local result after cancellation', async () => {
    const blob = new Blob(['body']),
      object = await planGitHubBundle(blob, 'file.bin'),
      controller = new AbortController()
    let finish!: (blob: Blob) => void
    const context = {
      signal: controller.signal,
      readLocalObject: () =>
        new Promise<Blob>((resolve) => {
          finish = resolve
        }),
    } as unknown as CloudBackupTransportContext
    const download = vi.fn(async () => new Response(blob))
    const read = createCloudObjectReader(
      context,
      'test',
      async () => [{ key: 'part', size: blob.size, sha256: object.totalSha256, download }],
      3,
      32 * 1024 * 1024,
    )
    const pending = read(object)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    controller.abort()
    finish(blob)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(download).not.toHaveBeenCalled()
  })
})
