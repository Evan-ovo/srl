import { registerPlugin } from '@capacitor/core'
import { nativeFileSource, nativeFileSize } from './NativeFileSource'
import { transferNativeStream } from './NativeStreamTransfer'
import { writeArchiveEntries, type ArchiveEntryInfo } from '../services/ArchiveZipWriter'
import type { ArchiveStreamWriter } from '../services/ExportService'
import type { ArchivedResource } from '../types/Backup'

interface Entry {
  bytes: number
  descriptor?: ArchivedResource
}
interface State {
  id: string
  bytes?: number
  saved?: boolean
}
interface Plugin {
  beginArchive(options: { taskId: string; fileName: string }): Promise<State>
  getArchiveEntry(options: { id: string; path: string }): Promise<{ entry?: Entry }>
  resetArchiveInput(options: { id: string; path: string }): Promise<void>
  appendArchiveInput(options: {
    id: string
    path: string
    offset: number
    data: string
  }): Promise<void>
  compressArchiveEntry(
    options: ArchiveEntryInfo & { id: string; path: string; uri?: string; size: number },
  ): Promise<Entry>
  assembleArchive(options: { id: string; paths: string[] }): Promise<State>
  publishArchive(options: { id: string }): Promise<State>
  discardArchiveTask(options: { taskId: string }): Promise<void>
}
const plugin = registerPlugin<Plugin>('NativeSafBackup')

export async function openCheckpointArchiveWriter(
  taskId: string,
  fileName: string,
): Promise<ArchiveStreamWriter> {
  const state = await plugin.beginArchive({ taskId, fileName })
  const id = state.id
  return {
    write: async () => {
      throw new Error('原生归档按文件写入')
    },
    encode: async (options) => {
      if (state.saved) return state.bytes ?? 0
      let writtenBytes = 0
      const progress = (bytes: number) => {
        writtenBytes += bytes
        options.onProgress?.({ writtenBytes })
      }
      let missingPath: string | undefined
      const paths = await writeArchiveEntries(
        { ...options, read: (resource, historical) => options.read(resource, historical, true) },
        {
          cached: async (path) => {
            const { entry } = await plugin.getArchiveEntry({ id, path })
            missingPath = entry ? undefined : path
            if (entry?.descriptor) progress(entry.bytes)
            return entry?.descriptor
          },
          write: async (path, blob, info) => {
            // Traversal is sequential; native compression rechecks the checkpoint
            // after preparation, including one created since cached() missed it.
            const missing = missingPath === path
            missingPath = undefined
            if (!missing) {
              const { entry } = await plugin.getArchiveEntry({ id, path })
              if (entry) {
                progress(entry.bytes)
                return
              }
            }
            const uri = nativeFileSource(blob)
            if (!uri) {
              await plugin.resetArchiveInput({ id, path })
              let offset = 0
              await transferNativeStream(blob, {
                signal: options.signal,
                append: async (data) => {
                  await plugin.appendArchiveInput({ id, path, offset, data })
                  offset +=
                    Math.floor((data.length * 3) / 4) -
                    (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
                },
              })
            }
            const result = await plugin.compressArchiveEntry({
              id,
              path,
              uri,
              size: nativeFileSize(blob),
              ...info,
            })
            progress(result.bytes)
          },
        },
      )
      return (await plugin.assembleArchive({ id, paths })).bytes ?? writtenBytes
    },
    commit: async () => {
      await plugin.publishArchive({ id })
    },
    // Errors and process death retain verified entries; only explicit discard removes them.
    abort: async () => {},
  }
}

export async function discardCheckpointArchive(taskId: string): Promise<void> {
  await plugin.discardArchiveTask({ taskId })
}
