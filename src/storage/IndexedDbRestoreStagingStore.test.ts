import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbRestoreStagingStore } from './IndexedDbRestoreStagingStore'

describe('binary restore staging and legacy byte compatibility', () => {
  it('persists detached Blob chunks, reopens, reads exact bytes, and clears the job', async () => {
    const db = new AppDatabase('staging-blob-' + crypto.randomUUID()),
      store = new IndexedDbRestoreStagingStore(db)
    const bytes = new Uint8Array(1024 * 1024 + 7)
    bytes[bytes.length - 1] = 251
    try {
      await store.putChunk({
        jobId: 'job',
        path: 'file',
        chunkIndex: 0,
        blob: new Blob([bytes]),
        updatedAt: 1,
      })
      await store.complete({
        jobId: 'job',
        path: 'file',
        size: bytes.length,
        sha256: 'a'.repeat(64),
        updatedAt: 1,
      })
      const saved = await db.restoreStagingChunks.get(['job', 'file', 0])
      expect(saved?.blob).toBeInstanceOf(Blob)
      expect(saved?.data).toBeUndefined()
      db.close()
      await db.open()
      expect(await (await store.get('job', 'file'))!.blob.arrayBuffer()).toEqual(bytes.buffer)
      await store.deleteJob('job')
      expect(await db.restoreStaging.count()).toBe(0)
      expect(await db.restoreStagingChunks.count()).toBe(0)
    } finally {
      db.close()
      await db.delete()
    }
  })
  it('rebuilds old ArrayBuffer and Blob chunks in numeric order', async () => {
    const db = new AppDatabase('staging-legacy-' + crypto.randomUUID()),
      store = new IndexedDbRestoreStagingStore(db)
    try {
      await db.restoreStagingChunks.bulkPut([
        {
          jobId: 'job',
          path: 'file',
          chunkIndex: 1,
          blob: new Blob([new Uint8Array([3, 4])]),
          updatedAt: 1,
        },
        {
          jobId: 'job',
          path: 'file',
          chunkIndex: 0,
          data: new Uint8Array([1, 2]).buffer,
          updatedAt: 1,
        },
      ])
      await store.complete({
        jobId: 'job',
        path: 'file',
        size: 4,
        sha256: 'a'.repeat(64),
        updatedAt: 1,
      })
      expect(new Uint8Array(await (await store.get('job', 'file'))!.blob.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      )
    } finally {
      db.close()
      await db.delete()
    }
  })
})
