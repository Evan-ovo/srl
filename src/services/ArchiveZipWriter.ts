import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { createGitHubBundle } from './GitHubBackupBundle'
import { hashCloudBlob } from './CloudArchiveCodec'
import { albumArchivePath, parseAlbumBackup } from './GeneratedImageAlbumBackup'
import {
  COMMUNITY_SOURCE_ARCHIVE_PATH,
  COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX,
  type ArchiveManifest,
  type ArchivedResource,
} from '../types/Backup'
import type { Resource } from '../types/Resource'
import type {
  CommunitySourceAttachmentArchiveEntry,
  CommunitySourceBackupData,
} from '../types/CommunitySource'

/** ZIP encoding owns backpressure; selection and resource mutation stay in ExportService. */
export interface ArchiveTransferOptions {
  createdAt?: string
  signal?: AbortSignal
  onProgress?: (progress: { writtenBytes: number; fileName?: string }) => void
  /** Opt in only when onFailure aborts the source reads using the same signal. */
  readAhead?: {
    concurrency?: number
    maxPreparedBytes?: number
    onFailure(error: unknown): void
  }
}

export function throwIfArchiveAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('归档已取消', 'AbortError')
}

export interface ArchiveEncoding extends ArchiveTransferOptions {
  readAlbumFile?: (id: string) => Promise<Blob>
  resources: Resource[]
  versions: Resource[]
  manifest: ArchiveManifest
  communitySourceData?: CommunitySourceBackupData
  communitySourceAttachments: readonly CommunitySourceAttachmentArchiveEntry[]
  path(resource: Resource, historical: boolean): string
  read(resource: Resource, historical: boolean): Promise<Resource>
  describe(resource: Resource, historical: boolean): ArchivedResource
}

export async function encodeArchive(
  options: ArchiveEncoding,
  sink: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>,
): Promise<number> {
  throwIfArchiveAborted(options.signal)
  options.onProgress?.({ writtenBytes: 0 })
  let bytes = 0
  let writtenBytes = 0
  let writeChain = Promise.resolve()
  let encodingError: unknown
  const archive = new Zip((error, data) => {
    if (error) {
      encodingError = error
      return
    }
    const copy = new Uint8Array(data)
    bytes += copy.length
    writeChain = writeChain.then(async () => {
      throwIfArchiveAborted(options.signal)
      await sink(copy)
      writtenBytes += copy.length
      options.onProgress?.({ writtenBytes })
      throwIfArchiveAborted(options.signal)
    })
    void writeChain.catch(() => undefined)
  })
  const push = async (entry: ZipPassThrough | ZipDeflate, blob: Blob) => {
    throwIfArchiveAborted(options.signal)
    archive.add(entry)
    const reader = blob.stream().getReader()
    const abort = (): void => {
      void reader.cancel(options.signal?.reason).catch(() => undefined)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        throwIfArchiveAborted(options.signal)
        const { done, value } = await reader.read()
        throwIfArchiveAborted(options.signal)
        entry.push(value ?? new Uint8Array(), done)
        await writeChain
        if (encodingError) throw encodingError
        if (done) break
      }
    } catch (error) {
      void reader.cancel(error).catch(() => undefined)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
      reader.releaseLock()
    }
  }
  try {
    await writeArchiveEntries(options, {
      write: async (path, blob, info) => {
        const entry = info.compress ? new ZipDeflate(path, { level: 1 }) : new ZipPassThrough(path)
        entry.mtime = new Date(info.mtime)
        await push(entry, blob)
      },
    })
    throwIfArchiveAborted(options.signal)
    archive.end()
    await writeChain
    throwIfArchiveAborted(options.signal)
    if (encodingError) throw encodingError
    return bytes
  } catch (error) {
    archive.terminate()
    await writeChain.catch(() => undefined)
    throw error
  }
}

export async function streamArchive(options: ArchiveEncoding): Promise<Blob> {
  // Consume bounded segments in the browser's Blob loader. WebKit can return a Blob
  // whose slices never resolve when one synthetic Response grows beyond 1 GiB.
  const limit = 32 * 1024 * 1024
  const parts: Blob[] = []
  let segmentBytes = 0
  let writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | undefined
  let result: Promise<Blob> | undefined
  const flush = async () => {
    if (!writer || !result) return
    await writer.close()
    parts.push(await result)
    writer.releaseLock()
    writer = undefined
    result = undefined
    segmentBytes = 0
  }
  try {
    await encodeArchive(options, async (chunk) => {
      for (let offset = 0; offset < chunk.length;) {
        if (!writer) {
          const stream = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>()
          writer = stream.writable.getWriter()
          result = new Response(stream.readable).blob()
          void result.catch(() => undefined)
        }
        const end = Math.min(chunk.length, offset + limit - segmentBytes)
        await writer.write(chunk.subarray(offset, end))
        segmentBytes += end - offset
        offset = end
        if (segmentBytes === limit) await flush()
      }
    })
    await flush()
    return new Blob(parts, { type: 'application/zip' })
  } catch (error) {
    await writer?.abort(error).catch(() => undefined)
    throw error
  } finally {
    writer?.releaseLock()
  }
}

export interface ArchiveEntryInfo {
  mtime: number
  compress: boolean
  descriptor?: ArchivedResource
}
export interface ArchiveEntryWriter {
  cached?(path: string): Promise<ArchivedResource | undefined>
  write(path: string, blob: Blob, info: ArchiveEntryInfo): Promise<void>
}

/** Both native checkpoint compression and web ZIP encoding use the same manifest traversal. */
export async function writeArchiveEntries(
  options: ArchiveEncoding,
  writer: ArchiveEntryWriter,
): Promise<string[]> {
  const paths: string[] = []
  const emit = async (path: string, blob: Blob, info: ArchiveEntryInfo) => {
    throwIfArchiveAborted(options.signal)
    await writer.write(path, blob, info)
    throwIfArchiveAborted(options.signal)
    paths.push(path)
  }
  const descriptors = [new Map<string, Blob>(), new Map<string, Blob>()] as const
  const entries: [Resource, boolean][] = [
    ...options.resources.map((resource): [Resource, boolean] => [resource, false]),
    ...options.versions.map((resource): [Resource, boolean] => [resource, true]),
  ]
  entries.sort(([a, av], [b, bv]) => options.path(a, av).localeCompare(options.path(b, bv)))
  const requestedConcurrency = options.readAhead?.concurrency ?? 3
  const concurrency = options.readAhead
    ? Math.max(1, Math.min(3, Math.floor(requestedConcurrency) || 1))
    : 1
  const requestedBytes = options.readAhead?.maxPreparedBytes ?? 32 * 1024 * 1024
  const byteLimit = Math.max(1, Math.min(32 * 1024 * 1024, requestedBytes || 1))
  type Prepared = { path: string } & ({ cached: ArchivedResource } | { resource: Resource })
  const pending = new Map<number, { promise: Promise<Prepared>; bytes: number }>()
  let next = 0
  let retainedBytes = 0
  let stopped = false
  let failure: unknown
  const stop = (error: unknown) => {
    if (stopped) return
    stopped = true
    failure = error
    try {
      options.readAhead?.onFailure(error)
    } catch {
      // A cancellation callback cannot replace the original read/write failure.
    }
  }
  const check = () => {
    if (stopped) throw failure
    throwIfArchiveAborted(options.signal)
  }
  const abort = () => stop(options.signal?.reason ?? new DOMException('归档已取消', 'AbortError'))
  const fill = () => {
    while (!stopped && next < entries.length && pending.size < concurrency) {
      check()
      const [planned, historical] = entries[next]!
      // This is a declared-original budget, not a claim about total process memory.
      // Unknown sizes and a single oversize original run alone.
      const bytes =
        Number.isFinite(planned.fileSize) && planned.fileSize >= 0
          ? planned.fileSize
          : byteLimit + 1
      if (pending.size && retainedBytes + bytes > byteLimit) break
      const path = options.path(planned, historical)
      const promise = (async (): Promise<Prepared> => {
        const cached = await writer.cached?.(path)
        check()
        if (cached) return { path, cached }
        const resource = await options.read(planned, historical)
        check()
        return { path, resource }
      })().catch((error: unknown) => {
        stop(error)
        throw error
      })
      // A later read may reject before its sorted entry is consumed.
      void promise.catch(() => undefined)
      pending.set(next++, { promise, bytes })
      retainedBytes += bytes
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    for (const [index, [planned, historical]] of entries.entries()) {
      check()
      fill()
      const entry = pending.get(index)!
      const ready = await entry.promise
      check()
      if ('cached' in ready) {
        descriptors[historical ? 1 : 0].set(planned.id, new Blob([JSON.stringify(ready.cached)]))
        paths.push(ready.path)
      } else {
        const { resource } = ready
        const descriptor = options.describe(resource, historical)
        const compress = !(
          /^(image\/(png|jpeg|webp|gif)|audio\/|video\/)/i.test(resource.mimeType) ||
          /\.(png|jpe?g|webp|gif|zip|gz|7z|rar|mp[34]|ogg|webm)$/i.test(resource.fileName)
        )
        const mtime = Number.isFinite(resource.updatedAt)
          ? Math.min(Date.UTC(2107, 11, 31), Math.max(Date.UTC(1980, 0, 1), resource.updatedAt))
          : Date.UTC(1980, 0, 1)
        await emit(ready.path, resource.originalBlob, {
          compress,
          mtime,
          descriptor,
        })
        check()
        descriptors[historical ? 1 : 0].set(resource.id, new Blob([JSON.stringify(descriptor)]))
      }
      // Keep both the slot and bytes reserved until the sorted sink write finishes.
      retainedBytes -= entry.bytes
      pending.delete(index)
    }
  } catch (error) {
    stop(error)
    throw failure
  } finally {
    stopped = true
    await Promise.allSettled([...pending.values()].map((entry) => entry.promise))
    pending.clear()
    options.signal?.removeEventListener('abort', abort)
  }
  const albumPaths = new Set<string>()
  for (const entry of options.manifest.portableData?.generatedImageAlbum ?? []) {
    throwIfArchiveAborted(options.signal)
    const blob = await options.readAlbumFile?.(entry.item.id)
    throwIfArchiveAborted(options.signal)
    if (!blob || blob.size !== entry.item.sizeBytes)
      throw new Error(`相册原图缺失或已变化：${entry.item.name}`)
    if (entry.object) {
      if ((await hashCloudBlob(blob)).toLowerCase() !== entry.object.totalSha256.toLowerCase())
        throw new Error(`相册原图校验失败：${entry.item.name}`)
    } else entry.object = (await createGitHubBundle(blob, entry.item.name)).manifest
    const path = albumArchivePath(entry.object.totalSha256)
    if (!albumPaths.has(path))
      await emit(path, blob, { compress: false, mtime: Date.parse(options.manifest.createdAt) })
    albumPaths.add(path)
  }
  if (options.manifest.portableData?.generatedImageAlbum)
    parseAlbumBackup(options.manifest.portableData.generatedImageAlbum)
  for (const attachment of options.communitySourceAttachments) {
    await emit(COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX + attachment.assetId, attachment.blob, {
      compress: false,
      mtime: Date.parse(options.manifest.createdAt),
    })
  }
  if (options.communitySourceData)
    await emit(
      COMMUNITY_SOURCE_ARCHIVE_PATH,
      new Blob([JSON.stringify(options.communitySourceData)]),
      { compress: true, mtime: Date.parse(options.manifest.createdAt) },
    )
  const { resources: _resources, versions: _versions, ...header } = options.manifest
  const parts: BlobPart[] = [JSON.stringify(header).slice(0, -1)]
  for (const [index, key] of ['resources', 'versions'].entries()) {
    parts.push(`,"${key}":[`)
    for (const [position, resource] of (index ? options.versions : options.resources).entries()) {
      const descriptor = descriptors[index]!.get(resource.id)!
      if (position) parts.push(',')
      parts.push(descriptor)
    }
    parts.push(']')
  }
  parts.push('}')
  await emit('manifest.json', new Blob(parts), {
    compress: true,
    mtime: Date.parse(options.manifest.createdAt),
  })
  return paths
}
