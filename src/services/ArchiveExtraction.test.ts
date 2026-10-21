import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { stageArchive } from './ArchiveExtraction'
import { hashBlob } from './HashService'

describe('archive staging window and cancellation', () => {
  it.each([
    [undefined, 2],
    [1024 * 1024, 9],
  ])('preserves bytes with staging window %s', async (chunkBytes, count) => {
    const db = new AppDatabase('archive-window-' + crypto.randomUUID()),
      store = new IndexedDbRestoreStagingStore(db)
    const data = new Uint8Array(8 * 1024 * 1024 + 123)
    data[data.length - 1] = 251
    const file = new File([zipSync({ 'original.bin': data }, { level: 0 })], 'backup.zip')
    try {
      const job = await stageArchive(file, store, undefined, undefined, undefined, { chunkBytes })
      expect(await db.restoreStagingChunks.count()).toBe(count)
      const entry = await store.get(job, 'original.bin')
      expect(await hashBlob(entry!.blob)).toBe(await hashBlob(new Blob([data])))
      expect(entry!.size).toBe(data.length)
      await store.deleteJob(job)
      expect(await db.restoreStagingChunks.count()).toBe(0)
    } finally {
      db.close()
      await db.delete()
    }
  })
  it('stops during extraction and releases all uncommitted chunks', async () => {
    const db = new AppDatabase('archive-cancel-' + crypto.randomUUID()),
      store = new IndexedDbRestoreStagingStore(db),
      controller = new AbortController()
    const file = new File(
      [zipSync({ 'original.bin': new Uint8Array(2 * 1024 * 1024) }, { level: 0 })],
      'backup.zip',
    )
    try {
      await expect(
        stageArchive(file, store, undefined, () => controller.abort(), controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(await db.restoreStaging.count()).toBe(0)
      expect(await db.restoreStagingChunks.count()).toBe(0)
    } finally {
      db.close()
      await db.delete()
    }
  })
})
