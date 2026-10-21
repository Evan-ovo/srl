import { describe, expect, it, vi } from 'vitest'

import {
  GITHUB_PART_SIZE,
  GITHUB_AVERAGE_PART_SIZE,
  GITHUB_MIN_PART_SIZE,
  bundleManifestName,
  createGitHubBundle,
  planGitHubBundle,
  BUNDLE_READ_BYTES,
  parseGitHubBundleManifest,
} from './GitHubBackupBundle'
import type { ResourceByteSource } from '../types/ResourceReadSource'

describe('cancellable range planning', () => {
  it('uses a verified native plan without reading binary windows and preserves its part identities', async () => {
    const blob = new Blob(['native-body']),
      expected = await planGitHubBundle(blob, 'file.bin')
    const slice = vi.fn(() => {
      throw new Error('Must not bridge bytes')
    })
    const source: ResourceByteSource = {
      size: blob.size,
      slice,
      text: async () => '',
      planParts: async () => ({
        totalSha256: expected.totalSha256,
        parts: expected.parts.map(({ size, sha256 }) => ({ size, sha256 })),
      }),
    }
    const planned = await planGitHubBundle(source, 'file.bin')
    expect(planned.parts).toEqual(expected.parts)
    expect(planned.totalSha256).toBe(expected.totalSha256)
    expect(slice).not.toHaveBeenCalled()
  })
  it('keeps bounded JS planning when the optional native planner is unavailable', async () => {
    const blob = new Blob(['compatible']),
      slice = vi.fn(blob.slice.bind(blob))
    const source: ResourceByteSource = {
      size: blob.size,
      slice,
      text: () => blob.text(),
      planParts: async () => undefined,
    }
    const planned = await planGitHubBundle(source, 'file.bin')
    expect(planned.totalSha256).toBe((await planGitHubBundle(blob, 'file.bin')).totalSha256)
    expect(slice).toHaveBeenCalledOnce()
  })
  it('cancels a pending native plan without starting a fallback or accepting its late result', async () => {
    const controller = new AbortController(),
      slice = vi.fn(() => {
        throw Error('Unexpected fallback')
      })
    let finish!: (value: undefined) => void
    const source: ResourceByteSource = {
      size: 1,
      slice,
      text: async () => '',
      planParts: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    }
    const planned = planGitHubBundle(source, 'file.bin', { signal: controller.signal })
    controller.abort()
    await expect(planned).rejects.toMatchObject({ name: 'AbortError' })
    finish(undefined)
    await Promise.resolve()
    expect(slice).not.toHaveBeenCalled()
  })
  it.each([0, BUNDLE_READ_BYTES + 19, 4 * BUNDLE_READ_BYTES])(
    'keeps fixed single-part SHA and bounded reads identical for %i bytes',
    async (size) => {
      const blob = new Blob([new Uint8Array(size).fill(0x63)])
      const onRead = vi.fn()
      const planned = await planGitHubBundle(blob, 'one.bin', { onRead }, 4 * BUNDLE_READ_BYTES)
      const legacy = await createGitHubBundle(blob, 'one.bin', 4 * BUNDLE_READ_BYTES)
      expect(planned.parts).toEqual(legacy.manifest.parts)
      expect(planned.totalSha256).toBe(legacy.manifest.totalSha256)
      expect(planned.totalSha256).toBe(planned.parts[0]!.sha256)
      expect(onRead.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBe(size)
      expect(onRead.mock.calls.every(([bytes]) => bytes <= BUNDLE_READ_BYTES)).toBe(true)
    },
  )
  it('cancels single-part planning before reading the next window', async () => {
    const controller = new AbortController()
    const blob = new Blob([new Uint8Array(4 * BUNDLE_READ_BYTES)])
    let readBytes = 0
    await expect(
      planGitHubBundle(
        blob,
        'one.bin',
        {
          signal: controller.signal,
          onRead: (bytes) => {
            readBytes += bytes
            controller.abort()
          },
        },
        4 * BUNDLE_READ_BYTES,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(readBytes).toBe(BUNDLE_READ_BYTES)
  })
  it('stops within the current read and never starts another range after cancellation', async () => {
    const controller = new AbortController()
    let finish!: (value: ArrayBuffer) => void
    const slice = vi.fn(() => ({
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve
        }),
    }))
    const source: ResourceByteSource = {
      size: 10 * BUNDLE_READ_BYTES,
      slice,
      text: async () => {
        throw new Error('no full text')
      },
    }
    const pending = planGitHubBundle(source, 'large.mp4', { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    finish(new ArrayBuffer(BUNDLE_READ_BYTES))
    await Promise.resolve()
    expect(slice).toHaveBeenCalledOnce()
    expect(slice.mock.calls[0]).toEqual([0, BUNDLE_READ_BYTES])
  })
  it('stops a Blob stream as soon as the caller cancels during progress', async () => {
    const controller = new AbortController()
    let lastRead = 0
    const original = new Blob([new Uint8Array(20 * BUNDLE_READ_BYTES)])
    await expect(
      createGitHubBundle(original, 'video.mp4', undefined, undefined, {
        signal: controller.signal,
        onRead: (_, total) => {
          lastRead = total
          controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(lastRead).toBeLessThan(original.size)
  })
})

describe('GitHubBackupBundle', () => {
  it('keeps every provider part below the Cloudflare Free request limit', () => {
    expect(GITHUB_PART_SIZE).toBe(32 * 1024 * 1024)
    expect(GITHUB_MIN_PART_SIZE).toBe(8 * 1024 * 1024)
    expect(GITHUB_AVERAGE_PART_SIZE).toBe(16 * 1024 * 1024)
    expect(GITHUB_PART_SIZE).toBeLessThan(100 * 1024 * 1024)
  })

  it('splits a backup into independently verifiable ordered parts', async () => {
    const source = new Blob(['abcdefghijklmnop'])
    const { blobs, manifest } = await createGitHubBundle(source, 'backup.zip', 5)

    expect(blobs.map((part) => part.size)).toEqual([5, 5, 5, 1])
    expect(manifest.parts).toHaveLength(4)
    expect(manifest.parts[0]?.name).toMatch(/^srl-chunk--sha256-[a-f0-9]{64}$/)
    expect(manifest.version).toBe(2)
    expect(manifest.totalSize).toBe(source.size)
    expect(parseGitHubBundleManifest(manifest)).toEqual(manifest)
    expect(bundleManifestName('backup.zip')).toBe('backup.zip.srlbundle.json')
  })

  it('reuses content-addressed names for identical chunks across snapshots', async () => {
    const first = await createGitHubBundle(new Blob(['abcdefgh']), 'first.zip', 4)
    const second = await createGitHubBundle(new Blob(['abcdefgh']), 'second.zip', 4)

    expect(second.manifest.parts.map((part) => part.name)).toEqual(
      first.manifest.parts.map((part) => part.name),
    )
  })

  it('reuses unchanged CDC chunks when only a local range of a large resource changes', async () => {
    const originalBytes = new Uint8Array(40 * 1024 * 1024)
    const changedBytes = originalBytes.slice()
    changedBytes.fill(0x7f, 35 * 1024 * 1024, 35 * 1024 * 1024 + 64 * 1024)

    const first = await createGitHubBundle(new Blob([originalBytes]), 'large.bin')
    const second = await createGitHubBundle(new Blob([changedBytes]), 'large.bin')
    const previous = new Set(first.manifest.parts.map((part) => part.name))
    const reused = second.manifest.parts.filter((part) => previous.has(part.name))
    const changed = second.manifest.parts.filter((part) => !previous.has(part.name))

    expect(reused.length).toBeGreaterThan(0)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.length).toBeLessThan(second.manifest.parts.length)
    expect(changed.reduce((total, part) => total + part.size, 0)).toBeLessThan(changedBytes.length)
  }, 15000)

  it('可复用外层已经计算过的整包哈希，避免上传前重复扫描大文件', async () => {
    const knownHash = 'a'.repeat(64)
    const { manifest } = await createGitHubBundle(
      new Blob(['abcdefgh']),
      'backup.zip',
      4,
      knownHash,
    )

    expect(manifest.totalSha256).toBe(knownHash)
  })

  it('rejects an incomplete or forged manifest', () => {
    expect(() =>
      parseGitHubBundleManifest({ format: 'srl-github-backup-bundle', version: 1, parts: [] }),
    ).toThrow('格式不受支持')
  })

  it('allows repeated content references but rejects inconsistent total sizes', async () => {
    const { manifest } = await createGitHubBundle(new Blob(['123456']), 'backup.zip', 3)

    expect(() =>
      parseGitHubBundleManifest({ ...manifest, parts: [manifest.parts[0], manifest.parts[0]] }),
    ).not.toThrow()
    expect(() => parseGitHubBundleManifest({ ...manifest, totalSize: 99 })).toThrow('总大小不一致')
  })
})

describe('single-pass CDC byte integrity', () => {
  it('reads a 40 MiB source once and preserves independently verifiable chunks and total hash', async () => {
    const source = new Blob([new Uint8Array(40 * 1024 * 1024)])
    let sourceBytes = 0,
      peakRead = 0
    const slice = source.slice.bind(source)
    source.slice = (start, end, type) => {
      const part = slice(start, end, type)
      const read = part.arrayBuffer.bind(part)
      part.arrayBuffer = () => {
        sourceBytes += part.size
        peakRead = Math.max(peakRead, part.size)
        return read()
      }
      return part
    }
    const { blobs, manifest } = await createGitHubBundle(source, 'single-pass.bin')
    expect(sourceBytes).toBe(source.size)
    expect(peakRead).toBeLessThanOrEqual(BUNDLE_READ_BYTES)
    expect(blobs.map((part) => part.size)).toEqual([32 * 1024 * 1024, 8 * 1024 * 1024])
    for (const [index, blob] of blobs.entries()) {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      expect(manifest.parts[index]!.sha256).toBe(hex)
    }
    const digest = await crypto.subtle.digest('SHA-256', await source.arrayBuffer())
    expect(manifest.totalSha256).toBe(
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    )
  })
  it('encodes an empty streamed source as one verifiable empty object', async () => {
    const { manifest, blobs } = await createGitHubBundle(new Blob(), 'empty')
    expect(blobs.map((blob) => blob.size)).toEqual([0])
    expect(manifest.parts[0]!.sha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(manifest.totalSha256).toBe(manifest.parts[0]!.sha256)
  })
})
