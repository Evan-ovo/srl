import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { nativeFileSize, nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import { canImportNativeResourceObjects } from './NativeResourceFileMirror'
import { isAndroidNativeAppDatabaseActive } from './AndroidNativeDexieCore'
import type { ArchiveStageProgress } from '../services/ArchiveExtraction'
import type { RestoreStagingEntry, RestoreStagingMetadata } from '../types/RestoreStaging'
import { IndexedDbRestoreStagingStore } from './IndexedDbRestoreStagingStore'
import { zipArchiveChunks } from '../utils/ZipArchiveStream'

interface NativeArchivePlugin {
  listArchiveEntries(options: { uri: string; size: number }): Promise<{ paths: string[] }>
  cancelArchiveStage(options: { requestId: string }): Promise<void>
  stageArchive(options: {
    uri: string
    size: number
    requestId: string
    selectedPaths?: string[]
  }): Promise<{ jobId: string; stagedBytes: number; completedEntries: number }>
  addListener(
    eventName: 'archiveProgress',
    listener: (event: {
      requestId: string
      completedEntries: number
      reusedEntries: number
      phase: 'hashing' | 'staging'
      readBytes: number
      totalBytes: number
      entryCount: number
      stagedBytes: number
      totalStagedBytes: number
    }) => void,
  ): Promise<PluginListenerHandle>
  readArchiveEntry(options: {
    jobId: string
    path: string
  }): Promise<{ entry?: RestoreStagingMetadata & { uri: string } }>
  deleteArchiveJob(options: { jobId: string }): Promise<void>
}
const plugin = registerPlugin<NativeArchivePlugin>('NativeArchive')

/** Native file staging only; manifest validation and restore transactions keep their owners. */
export class NativeRestoreStagingStore extends IndexedDbRestoreStagingStore {
  private nativeFilesAvailable?: Promise<boolean>

  async getNativeFile(jobId: string, path: string): Promise<RestoreStagingEntry | undefined> {
    if (!jobId.startsWith('native-zip-') || !isAndroidNativeAppDatabaseActive()) return undefined
    this.nativeFilesAvailable ??= canImportNativeResourceObjects()
    if (!(await this.nativeFilesAvailable)) return undefined
    const { entry } = await plugin.readArchiveEntry({ jobId, path })
    return entry
      ? { ...entry, blob: rememberNativeFile(new Blob(), entry.uri, entry.size) }
      : undefined
  }

  async stageNativeArchive(
    file: File,
    selectedPaths?: string[],
    onProgress?: (progress: ArchiveStageProgress) => void,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const uri = nativeFileSource(file)
    if (!uri) return undefined
    const sourceSize = nativeFileSize(file)
    try {
      // Browser-selected Files still get the JS central-directory overlap/ZIP64
      // preflight. Android share placeholders intentionally contain no WebView
      // bytes; NativeArchiveStaging is the authoritative safe-path/duplicate/
      // size/CRC owner for those files and must read the file:// source directly.
      if (file.size > 0) {
        for await (const _header of zipArchiveChunks(
          file,
          (plan) => {
            if (plan.uncompressedBytes > 4 * 1024 * 1024 * 1024)
              throw new Error('备份解压后超过支持的大小限制')
          },
          true,
          undefined,
          signal,
        )) {
          /* Native ZipFile owns payload reads and decompression. */
        }
      }
      if (signal?.aborted) throw abortError()
      const requestId = crypto.randomUUID()
      let listener: PluginListenerHandle | undefined
      const cancel = () => {
        void plugin.cancelArchiveStage({ requestId }).catch(() => undefined)
      }
      try {
        listener = await plugin.addListener('archiveProgress', (event) => {
          if (event.requestId !== requestId) return
          onProgress?.({
            phase: event.phase === 'hashing' ? 'reading' : 'staging',
            readBytes: event.readBytes,
            totalBytes: event.totalBytes,
            stagedBytes: event.stagedBytes,
            totalStagedBytes: event.totalStagedBytes,
            entries: event.entryCount || event.completedEntries,
            selectedEntries: event.entryCount || event.completedEntries,
            completedEntries: event.completedEntries,
          })
        })
        if (signal?.aborted) throw abortError()
        signal?.addEventListener('abort', cancel, { once: true })
        const result = await plugin.stageArchive({
          uri,
          size: sourceSize,
          requestId,
          ...(selectedPaths ? { selectedPaths } : {}),
        })
        if (signal?.aborted) {
          await plugin.deleteArchiveJob({ jobId: result.jobId })
          throw abortError()
        }
        onProgress?.({
          phase: 'complete',
          readBytes: selectedPaths ? result.stagedBytes : sourceSize,
          totalBytes: selectedPaths ? result.stagedBytes : sourceSize,
          stagedBytes: result.stagedBytes,
          totalStagedBytes: result.stagedBytes,
          entries: result.completedEntries,
          selectedEntries: result.completedEntries,
          completedEntries: result.completedEntries,
        })
        return result.jobId
      } finally {
        signal?.removeEventListener('abort', cancel)
        await listener?.remove()
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIMPLEMENTED') return undefined
      throw error
    }
  }

  async listNativeArchiveEntries(file: File): Promise<string[] | undefined> {
    const uri = nativeFileSource(file)
    if (!uri) return undefined
    try {
      return (await plugin.listArchiveEntries({ uri, size: nativeFileSize(file) })).paths
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIMPLEMENTED') return undefined
      throw error
    }
  }

  override async getMetadata(
    jobId: string,
    path: string,
  ): Promise<RestoreStagingMetadata | undefined> {
    if (!jobId.startsWith('native-zip-')) return super.getMetadata(jobId, path)
    return (await plugin.readArchiveEntry({ jobId, path })).entry
  }

  override async get(jobId: string, path: string): Promise<RestoreStagingEntry | undefined> {
    if (!jobId.startsWith('native-zip-')) return super.get(jobId, path)
    const { entry } = await plugin.readArchiveEntry({ jobId, path })
    if (!entry) return undefined
    const response = await fetch(Capacitor.convertFileSrc(entry.uri), { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取原生解压暂存文件')
    const blob = await response.blob()
    if (blob.size !== entry.size) throw new Error('原生解压暂存文件大小不一致')
    return { ...entry, blob: rememberNativeFile(blob, entry.uri) }
  }

  override async deleteJob(jobId: string): Promise<void> {
    if (!jobId.startsWith('native-zip-')) return super.deleteJob(jobId)
    await plugin.deleteArchiveJob({ jobId })
  }
}

function abortError(): Error {
  const error = new Error('已停止备份识别')
  error.name = 'AbortError'
  return error
}
