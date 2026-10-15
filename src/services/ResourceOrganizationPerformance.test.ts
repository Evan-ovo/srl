import 'fake-indexeddb/auto'
import console from 'node:console'
import { expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { RESOURCE_TYPE, toResourceListSummary, type Resource } from '../types/Resource'
import {
  moveManyToCategory,
  updateTagsMany,
  addTagsPerResource,
  undoAddedTags,
} from './ResourceOrganizationOperations'

it.each([1000, 5000, 10000])(
  'edits five selected items in a %i-item Web library without reading originals',
  async (size) => {
    const database = new AppDatabase(`organization-perf-${crypto.randomUUID()}`)
    const storage = new IndexedDbResourceStorage(database)
    const blob = new Blob(['original bytes '.repeat(600)])
    const rows: Resource[] = Array.from({ length: size }, (_, i) => ({
      id: `r-${i}`,
      type: RESOURCE_TYPE.OTHER,
      name: `资源${i}`,
      description: '',
      fileName: `${i}.txt`,
      mimeType: 'text/plain',
      fileSize: blob.size,
      contentHash: `${i}`,
      originalBlob: blob,
      metadata: { privateBody: 'keep' },
      tags: ['保留'],
      favorite: false,
      categoryId: null,
      createdAt: i,
      updatedAt: i,
    }))
    try {
      await database.resources.bulkPut(rows)
      await database.resourceSummaries.bulkPut(rows.map(toResourceListSummary))
      await database.resourceListSummaries.bulkPut(rows.map(toResourceListSummary))
      await database.settings.put({
        id: 'index.resourceListSummaries.v20',
        value: true,
        updatedAt: 1,
      })
      const scans = vi.spyOn(storage, 'list')
      const summaries = vi.spyOn(storage, 'listResourceListSummaries')
      const originals = vi.spyOn(storage, 'get')
      const rewrites = vi.spyOn(storage, 'saveMany')
      const ids = rows.slice(0, 5).map((r) => r.id)
      const start = performance.now()
      await moveManyToCategory(storage, [...ids, ids[0]!, 'missing'], 'folder')
      await updateTagsMany(storage, ids, ' new ', 'add')
      const added = await addTagsPerResource(
        storage,
        ids.map((resourceId) => ({ resourceId, tags: ['AI'] })),
      )
      await undoAddedTags(storage, added.entries)
      console.info(
        `WEB organization ${size}: ${Math.round(performance.now() - start)}ms; full scans=${scans.mock.calls.length}; original reads=${originals.mock.calls.length}; full rewrites=${rewrites.mock.calls.length}; summary scans=${summaries.mock.calls.length}`,
      )
      expect(scans).not.toHaveBeenCalled()
      expect(originals).not.toHaveBeenCalled()
      expect(rewrites).not.toHaveBeenCalled()
      expect(summaries).not.toHaveBeenCalled()
      database.close()
      await database.open()
      for (const id of ids) {
        const loaded = (await storage.get(id))!
        expect(loaded.tags).toEqual(['保留', 'new'])
        expect(loaded.categoryIds).toEqual(['folder'])
        expect(loaded.metadata).toEqual({ privateBody: 'keep' })
        expect(await loaded.originalBlob.text()).toBe(await blob.text())
      }
      expect((await storage.get('r-5'))!.tags).toEqual(['保留'])
    } finally {
      database.close()
      await database.delete()
    }
  },
  60_000,
)
