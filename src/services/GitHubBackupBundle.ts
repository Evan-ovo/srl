import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { hashCloudBlob } from './CloudArchiveCodec'
import type { ResourceByteSource } from '../types/ResourceReadSource'
import { withAbort } from '../utils/Abortable'

export interface BundleReadOptions {
  signal?: AbortSignal
  onRead?: (bytes: number, total: number) => void
}
export const BUNDLE_READ_BYTES = 1024 * 1024

export const GITHUB_BUNDLE_FORMAT = 'srl-github-backup-bundle'
export const GITHUB_BUNDLE_VERSION = 2
const LEGACY_GITHUB_BUNDLE_VERSION = 1
// CF Worker 同源代理 body 上限为 64 MiB，任何内容定义分块都不会超过 32 MiB。
// 平均边界约 16 MiB；文件中间增删数据后会很快重新同步边界，避免后续分卷全部重传。
export const GITHUB_PART_SIZE = 32 * 1024 * 1024
export const GITHUB_MIN_PART_SIZE = 8 * 1024 * 1024
export const GITHUB_AVERAGE_PART_SIZE = 16 * 1024 * 1024

export interface GitHubBundlePart {
  name: string
  /** 逻辑对象在该存储块中的字节数。 */
  size: number
  /** 存储块 SHA-256；普通分块同时也是逻辑片段 SHA-256。 */
  sha256: string
  /** 小对象聚合包中的起始偏移；旧清单和普通分块不设置。 */
  offset?: number
  /** 远端聚合包的完整大小；旧清单和普通分块不设置。 */
  storedSize?: number
  /** V3 transport locator. V1/V2 manifests infer the legacy container. */
  storage?: {
    kind: 'github-release' | 'koofr-path'
    container: string
    objectKey: string
  }
}

export interface GitHubBundleManifest {
  format: typeof GITHUB_BUNDLE_FORMAT
  version: typeof GITHUB_BUNDLE_VERSION | typeof LEGACY_GITHUB_BUNDLE_VERSION
  createdAt: string
  fileName: string
  totalSize: number
  totalSha256: string
  parts: GitHubBundlePart[]
}

export function bundleManifestName(fileName: string): string {
  return `${fileName}.srlbundle.json`
}

const CONTENT_BOUNDARY_MASK = GITHUB_AVERAGE_PART_SIZE - 1
const GEAR_TABLE = (() => {
  const values = new Uint32Array(256)
  let state = 0x9e3779b9
  for (let index = 0; index < values.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    values[index] = state >>> 0
  }
  return values
})()

async function contentDefinedParts(
  blob: ResourceByteSource,
  computeTotal: boolean,
  options: BundleReadOptions = {},
  fixedPartSize?: number,
): Promise<{
  parts: GitHubBundlePart[]
  totalSha256?: string
}> {
  const parts: GitHubBundlePart[] = []
  let start = 0
  let offset = 0
  let rolling = 0
  const totalHash = computeTotal ? sha256.create() : undefined
  const singlePart = computeTotal && fixedPartSize !== undefined && blob.size <= fixedPartSize
  let partHash = singlePart ? totalHash! : sha256.create()
  let singlePartHash: string | undefined
  const signal = options.signal
  signal?.throwIfAborted()
  let readOffset = 0
  const reader = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal?.throwIfAborted()
          if (readOffset >= blob.size) {
            controller.close()
            return
          }
          const end = Math.min(blob.size, readOffset + BUNDLE_READ_BYTES)
          const value = new Uint8Array(
            await withAbort(blob.slice(readOffset, end).arrayBuffer(signal), signal),
          )
          signal?.throwIfAborted()
          if (value.byteLength !== end - readOffset)
            throw new Error('云备份分块读取长度与原件不一致')
          readOffset = end
          controller.enqueue(value)
        } catch (error) {
          controller.error(error)
        }
      },
    },
    { highWaterMark: 0 },
  ).getReader()
  let yieldedAt = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await withAbort(reader.read(), signal)
      signal?.throwIfAborted()
      if (done) break
      totalHash?.update(value)
      if (singlePart) offset += value.byteLength
      else {
        let segmentStart = 0
        const valueOffset = offset
        for (const byte of value) {
          rolling = (Math.imul(rolling, 2) + (GEAR_TABLE[byte] ?? 0)) >>> 0
          offset += 1
          const size = offset - start
          if (
            fixedPartSize !== undefined
              ? size >= fixedPartSize
              : size >= GITHUB_MIN_PART_SIZE &&
                ((rolling & CONTENT_BOUNDARY_MASK) === 0 || size >= GITHUB_PART_SIZE)
          ) {
            const segmentEnd = offset - valueOffset
            partHash.update(value.subarray(segmentStart, segmentEnd))
            const hash = bytesToHex(partHash.digest())
            parts.push({ name: `srl-chunk--sha256-${hash}`, size: offset - start, sha256: hash })
            start = offset
            rolling = 0
            partHash = sha256.create()
            segmentStart = segmentEnd
          }
        }
        partHash.update(value.subarray(segmentStart))
      }
      // Preserve UI opportunities during large-file planning without a second read/hash pass.
      if (offset - yieldedAt >= BUNDLE_READ_BYTES || offset === blob.size) {
        options.onRead?.(offset - yieldedAt, offset)
        await withAbort(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal)
        yieldedAt = offset
      }
    }
    if (offset !== blob.size) throw new Error('云备份分块读取长度与原件不一致')
    if (start < offset || !parts.length) {
      const hash = bytesToHex(partHash.digest())
      if (singlePart) singlePartHash = hash
      parts.push({ name: `srl-chunk--sha256-${hash}`, size: offset - start, sha256: hash })
    }
  } finally {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }
  signal?.throwIfAborted()
  return {
    parts,
    totalSha256: singlePartHash ?? (totalHash ? bytesToHex(totalHash.digest()) : undefined),
  }
}

/** Plan immutable parts from the existing read-only byte source without retaining originals. */
export async function planGitHubBundle(
  source: ResourceByteSource,
  fileName: string,
  options: BundleReadOptions = {},
  fixedPartSize?: number,
): Promise<GitHubBundleManifest> {
  options.signal?.throwIfAborted()
  const native = source.planParts
    ? await withAbort(source.planParts({ ...options, fixedPartSize }), options.signal)
    : undefined
  options.signal?.throwIfAborted()
  const planned = native
    ? {
        totalSha256: native.totalSha256,
        parts: native.parts.map((part) => ({
          ...part,
          name: `srl-chunk--sha256-${part.sha256}`,
        })),
      }
    : await contentDefinedParts(source, true, options, fixedPartSize)
  return {
    format: GITHUB_BUNDLE_FORMAT,
    version: GITHUB_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    fileName,
    totalSize: source.size,
    totalSha256: planned.totalSha256!,
    parts: planned.parts,
  }
}

export async function createGitHubBundle(
  blob: Blob,
  fileName: string,
  partSize?: number,
  knownTotalSha256?: string,
  options: BundleReadOptions = {},
): Promise<{ manifest: GitHubBundleManifest; blobs: Blob[] }> {
  if (partSize !== undefined && (!Number.isFinite(partSize) || partSize <= 0))
    throw new Error('GitHub 分包大小无效')
  if (knownTotalSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(knownTotalSha256))
    throw new Error('云备份总哈希无效')
  const streamed =
    partSize === undefined
      ? await contentDefinedParts(blob, knownTotalSha256 === undefined, options)
      : undefined
  const blobs =
    (streamed
      ? (() => {
          let offset = 0
          return streamed.parts.map((part) => {
            const start = offset
            offset += part.size
            return blob.slice(start, offset)
          })
        })()
      : undefined) ??
    Array.from({ length: Math.max(1, Math.ceil(blob.size / partSize!)) }, (_, index) =>
      blob.slice(index * partSize!, Math.min(blob.size, (index + 1) * partSize!)),
    )
  const parts: GitHubBundlePart[] = streamed?.parts ?? []
  if (!streamed) {
    for (const part of blobs) {
      options.signal?.throwIfAborted()
      const hash = await withAbort(hashCloudBlob(part), options.signal)
      parts.push({ name: `srl-chunk--sha256-${hash}`, size: part.size, sha256: hash })
      await withAbort(new Promise<void>((resolve) => setTimeout(resolve, 0)), options.signal)
    }
  }

  options.signal?.throwIfAborted()
  return {
    blobs,
    manifest: {
      format: GITHUB_BUNDLE_FORMAT,
      version: GITHUB_BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      fileName,
      totalSize: blob.size,
      totalSha256: knownTotalSha256 ?? streamed?.totalSha256 ?? (await hashCloudBlob(blob)),
      parts,
    },
  }
}

export function parseGitHubBundleManifest(value: unknown): GitHubBundleManifest {
  if (!value || typeof value !== 'object') throw new Error('GitHub 分包清单无效')
  const manifest = value as Partial<GitHubBundleManifest>
  if (
    manifest.format !== GITHUB_BUNDLE_FORMAT ||
    ![LEGACY_GITHUB_BUNDLE_VERSION, GITHUB_BUNDLE_VERSION].includes(manifest.version ?? 0) ||
    typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    typeof manifest.fileName !== 'string' ||
    !manifest.fileName ||
    typeof manifest.totalSize !== 'number' ||
    !Number.isFinite(manifest.totalSize) ||
    manifest.totalSize < 0 ||
    !/^[a-f0-9]{64}$/i.test(manifest.totalSha256 ?? '') ||
    !Array.isArray(manifest.parts) ||
    !manifest.parts.length
  ) {
    throw new Error('GitHub 分包清单格式不受支持')
  }
  const names = new Set<string>()
  let summedSize = 0
  for (const part of manifest.parts) {
    if (
      !part ||
      typeof part.name !== 'string' ||
      (manifest.version === LEGACY_GITHUB_BUNDLE_VERSION
        ? !part.name.startsWith(`${manifest.fileName}.part-`)
        : part.name !== `srl-chunk--sha256-${part.sha256}`) ||
      typeof part.size !== 'number' ||
      !Number.isFinite(part.size) ||
      part.size < 0 ||
      !/^[a-f0-9]{64}$/i.test(part.sha256) ||
      (part.offset !== undefined && (!Number.isSafeInteger(part.offset) || part.offset < 0)) ||
      (part.storedSize !== undefined &&
        (!Number.isSafeInteger(part.storedSize) ||
          part.storedSize < part.size ||
          part.storedSize < (part.offset ?? 0) + part.size)) ||
      (part.offset === undefined) !== (part.storedSize === undefined) ||
      (part.storage !== undefined &&
        (!['github-release', 'koofr-path'].includes(part.storage.kind) ||
          typeof part.storage.container !== 'string' ||
          !part.storage.container ||
          typeof part.storage.objectKey !== 'string' ||
          !part.storage.objectKey))
    ) {
      throw new Error('GitHub 分包清单包含无效分卷')
    }
    if (manifest.version === LEGACY_GITHUB_BUNDLE_VERSION && names.has(part.name))
      throw new Error('GitHub 分包清单包含重复分卷')
    names.add(part.name)
    summedSize += part.size
  }
  if (summedSize !== manifest.totalSize) throw new Error('GitHub 分包清单总大小不一致')
  return manifest as GitHubBundleManifest
}
