import type { AppDatabase } from '../database/AppDatabase'
import type {
  RestoreStagingChunk,
  RestoreStagingEntry,
  RestoreStagingMetadata,
} from '../types/RestoreStaging'
import type { RestoreStagingStore } from './RestoreStagingStore'

export class IndexedDbRestoreStagingStore implements RestoreStagingStore {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  async putChunk(chunk: RestoreStagingChunk): Promise<void> {
    // Keep bounded binary chunks out of WebKit's SQLite value quota. Detach before
    // writing and again on read: IDB-backed Blobs must not escape into rebuilt files.
    const { blob, ...metadata } = chunk
    const data = await blob.arrayBuffer()
    await this.database.restoreStagingChunks.put({ ...metadata, blob: new Blob([data]) })
  }

  async complete(entry: RestoreStagingMetadata): Promise<void> {
    await this.database.restoreStaging.put(entry)
  }

  async getMetadata(jobId: string, path: string): Promise<RestoreStagingMetadata | undefined> {
    return this.database.restoreStaging.get([jobId, path])
  }

  async get(jobId: string, path: string): Promise<RestoreStagingEntry | undefined> {
    const entry = await this.database.restoreStaging.get([jobId, path])
    if (!entry) return undefined
    const chunks = await this.database.restoreStagingChunks
      .where('[jobId+path]')
      .equals([jobId, path])
      .sortBy('chunkIndex')
    const parts: Blob[] = []
    for (const chunk of chunks) {
      if (chunk.data) parts.push(new Blob([chunk.data]))
      else if (chunk.blob) parts.push(new Blob([await chunk.blob.arrayBuffer()]))
      else throw new Error('压缩包暂存分块缺少内容')
    }
    return {
      ...entry,
      blob: new Blob(parts),
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.restoreStaging,
      this.database.restoreStagingChunks,
      async () => {
        await this.database.restoreStaging.where('jobId').equals(jobId).delete()
        await this.database.restoreStagingChunks.where('jobId').equals(jobId).delete()
      },
    )
  }
}
