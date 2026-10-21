import { Unzip, UnzipInflate } from 'fflate'
import { zipArchiveChunks } from '../utils/ZipArchiveStream'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { RestoreStagingStore } from '../storage/RestoreStagingStore'

export const RESTORE_STAGING_CHUNK_BYTES = 8 * 1024 * 1024

export interface ArchiveStageProgress {
  phase: 'reading' | 'staging' | 'complete'
  readBytes: number
  totalBytes: number
  stagedBytes: number
  totalStagedBytes: number
  entries: number
  selectedEntries: number
  completedEntries: number
}

function isSafeArchivePath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[a-z]:/iu.test(path) &&
    !path.split(/[\\/]/u).includes('..')
  )
}

export async function stageArchive(
  file: File,
  staging: RestoreStagingStore,
  selectEntry?: (path: string) => boolean,
  onProgress?: (progress: ArchiveStageProgress) => void,
  signal?: AbortSignal,
  options: { chunkBytes?: number } = {},
): Promise<string> {
  const requested = options.chunkBytes ?? RESTORE_STAGING_CHUNK_BYTES
  const chunkBytes =
    Number.isSafeInteger(requested) && requested > 0
      ? Math.min(RESTORE_STAGING_CHUNK_BYTES, requested)
      : RESTORE_STAGING_CHUNK_BYTES
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const error = new Error('已停止备份识别')
      error.name = 'AbortError'
      throw error
    }
  }
  throwIfAborted()
  if (staging.stageNativeArchive) {
    let selectedPaths: string[] | undefined
    if (selectEntry) {
      const nativePaths = await staging.listNativeArchiveEntries?.(file)
      if (nativePaths) selectedPaths = nativePaths.filter(selectEntry)
    }
    throwIfAborted()
    if (!selectEntry || selectedPaths) {
      const nativeJob = await staging.stageNativeArchive(file, selectedPaths, onProgress, signal)
      if (nativeJob) {
        if (signal?.aborted) {
          await staging.deleteJob(nativeJob)
          throwIfAborted()
        }
        return nativeJob
      }
    }
  }
  const jobId = crypto.randomUUID()
  const entries: Promise<void>[] = []
  const pendingWrites = new Set<Promise<void>>()
  const paths = new Set<string>()
  const selectedPaths = new Set<string>()
  const excludedPaths = new Set<string>()
  let archiveSize = 0
  let readBytes = 0
  let stagedBytes = 0
  let totalStagedBytes = 0
  let lastStagingProgressAt = 0
  let selectedEntries = 0
  let completedEntries = 0
  let failure: unknown
  const archive = new Unzip((entry) => {
    if (!isSafeArchivePath(entry.name) || paths.has(entry.name)) {
      throw new Error(`备份包含不安全或重复的路径：${entry.name}`)
    }
    paths.add(entry.name)
    if (paths.size > 100_000) throw new Error('备份文件数量超过限制')
    if (selectEntry && excludedPaths.has(entry.name)) return
    if (selectEntry && !selectedPaths.has(entry.name)) {
      throw new Error(`ZIP 解压器返回了目录中不存在的路径：${entry.name}`)
    }
    selectedEntries++
    const completion = new Promise<void>((resolve, reject) => {
      let totalLength = 0
      let chunkIndex = 0
      let writeChain = Promise.resolve()
      const hash = sha256.create()
      let buffered: BlobPart[] = []
      let bufferedBytes = 0
      const flush = () => {
        if (!bufferedBytes) return
        const blob = new Blob(buffered)
        buffered = []
        bufferedBytes = 0
        const index = chunkIndex++
        const operation = writeChain.then(() =>
          staging.putChunk({
            jobId,
            path: entry.name,
            chunkIndex: index,
            blob,
            updatedAt: Date.now(),
          }),
        )
        writeChain = operation
        pendingWrites.add(operation)
        void operation.then(
          () => pendingWrites.delete(operation),
          () => pendingWrites.delete(operation),
        )
      }
      entry.ondata = (error, data, final) => {
        if (error) {
          reject(error)
          return
        }
        totalLength += data.length
        stagedBytes += data.length
        archiveSize += data.length
        if (totalLength > 2 * 1024 * 1024 * 1024 || archiveSize > 4 * 1024 * 1024 * 1024) {
          reject(new Error('备份解压后超过支持的大小限制'))
          return
        }
        hash.update(data)
        const now = Date.now()
        if (now - lastStagingProgressAt >= 250 || final) {
          lastStagingProgressAt = now
          onProgress?.({
            phase: 'staging',
            readBytes,
            totalBytes: file.size,
            stagedBytes,
            totalStagedBytes,
            entries: paths.size,
            selectedEntries,
            completedEntries,
          })
        }
        if (final && entry.originalSize !== undefined && totalLength !== entry.originalSize) {
          reject(new Error('ZIP 条目大小与目录不一致'))
          return
        }
        for (let offset = 0; offset < data.length;) {
          const end = Math.min(data.length, offset + chunkBytes - bufferedBytes)
          buffered.push(new Uint8Array(data.subarray(offset, end)))
          bufferedBytes += end - offset
          offset = end
          if (bufferedBytes === chunkBytes) flush()
        }
        if (!final) return
        flush()
        writeChain
          .then(() =>
            staging.complete({
              jobId,
              path: entry.name,
              size: totalLength,
              sha256: bytesToHex(hash.digest()),
              updatedAt: Date.now(),
            }),
          )
          .then(() => {
            completedEntries += 1
            onProgress?.({
              phase: 'staging',
              readBytes,
              totalBytes: file.size,
              stagedBytes,
              totalStagedBytes,
              entries: paths.size,
              selectedEntries,
              completedEntries,
            })
            resolve()
          }, reject)
      }
      entry.start()
    })
    entries.push(completion)
    void completion.catch((error) => {
      failure = error
    })
  })
  archive.register(UnzipInflate)

  try {
    const shouldSelect = selectEntry
      ? (path: string) => {
          const selected = selectEntry(path)
          if (selected) selectedPaths.add(path)
          else excludedPaths.add(path)
          return selected
        }
      : undefined
    for await (const chunk of zipArchiveChunks(
      file,
      (plan) => {
        totalStagedBytes = plan.uncompressedBytes
        if (totalStagedBytes > 4 * 1024 * 1024 * 1024) {
          throw new Error('备份解压后超过支持的大小限制')
        }
      },
      false,
      shouldSelect,
      signal,
    )) {
      throwIfAborted()
      readBytes = Math.min(file.size, readBytes + chunk.byteLength)
      archive.push(chunk, false)
      if (pendingWrites.size) await Promise.all(Array.from(pendingWrites))
      if (failure) throw failure
      onProgress?.({
        phase: 'reading',
        readBytes,
        totalBytes: file.size,
        stagedBytes,
        totalStagedBytes,
        entries: paths.size,
        selectedEntries,
        completedEntries,
      })
    }
    onProgress?.({
      phase: 'staging',
      readBytes: file.size,
      totalBytes: file.size,
      stagedBytes,
      totalStagedBytes,
      entries: paths.size,
      selectedEntries,
      completedEntries,
    })
    archive.push(new Uint8Array(), true)
    await Promise.all(entries)
    throwIfAborted()
    onProgress?.({
      phase: 'complete',
      readBytes: file.size,
      totalBytes: file.size,
      stagedBytes,
      totalStagedBytes,
      entries: paths.size,
      selectedEntries,
      completedEntries,
    })
    return jobId
  } catch (error) {
    await Promise.allSettled([...pendingWrites])
    await staging.deleteJob(jobId)
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const cancelled = new Error('已停止备份识别')
      cancelled.name = 'AbortError'
      throw cancelled
    }
    if (
      error instanceof Error &&
      (error.message.startsWith('备份包含') || error.message.startsWith('备份解压后超过'))
    )
      throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`ZIP 读取、解压或暂存失败：${detail || '未知错误'}`, { cause: error })
  }
}
