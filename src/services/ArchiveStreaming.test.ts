import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { hydrateResourceFromIndexedDb } from '../storage/ResourceStorageClone'
import { toResourceListSummary, RESOURCE_TYPE, type Resource } from '../types/Resource'
import { ExportService } from './ExportService'
import { RestoreService } from './RestoreService'
import { hashBlob } from './HashService'

async function resource(id: string): Promise<Resource> {
  const originalBlob = new Blob([JSON.stringify({ id, body: 'body'.repeat(1000) })])
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: originalBlob.size,
    contentHash: await hashBlob(originalBlob),
    originalBlob,
    metadata: { completeBody: 'not in list summary' },
    favorite: false,
    categoryId: null,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('streamed archive round trip', () => {
  it.each(['original', 'modified'] as const)(
    'passes native file capability only for original bytes (%s)',
    async (resourceContent) => {
      const row = await resource('native-request')
      const read = vi.fn(async () => row)
      await new ExportService().createArchivesFromSource(
        { resources: [toResourceListSummary(row)], versions: [], read },
        [],
        { mode: 'full', resourceContent },
        async () => ({
          write: async () => {
            throw Error('Native encoder required')
          },
          encode: async (options) => {
            await options.read(options.resources[0]!, false, true)
            return 1
          },
          commit: async () => {},
          abort: async () => {},
        }),
      )
      expect(read.mock.calls[0]).toEqual(
        resourceContent === 'original'
          ? [expect.anything(), false, true]
          : [expect.anything(), false],
      )
    },
  )

  it('exports a large local album original as one ZIP entry and restores its complete SHA', async () => {
    const blob = new Blob([new Uint8Array(33 * 1024 * 1024 + 19).fill(0x63)], { type: 'image/png' })
    const hash = await hashBlob(blob)
    const archive = await new ExportService().createArchive([], [], {
      mode: 'full',
      portableData: {
        version: 1,
        generatedImageAlbum: [
          {
            item: {
              id: 'large-album',
              name: 'large.png',
              source: 'imported',
              category: '',
              mimeType: 'image/png',
              sizeBytes: blob.size,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
      },
      readAlbumFile: async () => blob,
    })
    const object = archive.manifest.portableData!.generatedImageAlbum![0]!.object!
    expect(object.totalSha256).toBe(hash)
    expect(object.parts).toEqual([
      { name: `srl-chunk--sha256-${hash}`, size: blob.size, sha256: hash },
    ])
    const db = new AppDatabase(`album-zip-${crypto.randomUUID()}`)
    const staging = new IndexedDbRestoreStagingStore(db)
    try {
      const service = new RestoreService(new IndexedDbArchiveStorage(db), staging)
      const prepared = await service.prepare(
        new File([archive.blob], archive.fileName),
        [],
        [],
        true,
      )
      const entry = await staging.get(prepared.staging!.jobId, `app-data/album/${hash}.bin`)
      expect(entry!.size).toBe(blob.size)
      expect(entry!.sha256).toBe(hash)
      expect(await hashBlob(entry!.blob)).toBe(hash)
      await prepared.dispose!()
    } finally {
      db.close()
      await db.delete()
    }
  })
  it('exports lazy originals/history and restores from a body-free preview', async () => {
    const records = [await resource('b'), await resource('a')]
    const version = { ...(await resource('old')), versionGroupId: 'b' }
    const read = vi.fn(async (summary: { id: string }) =>
      [...records, version].find((r) => r.id === summary.id)!,
    )
    const archive = (
      await new ExportService().createArchivesFromSource(
        {
          resources: records.map(toResourceListSummary),
          versions: [toResourceListSummary(version)],
          read,
        },
        [],
        { mode: 'full' },
      )
    )[0]!
    expect(read.mock.calls.map(([summary]) => summary.id).sort()).toEqual(['a', 'b', 'old'])
    const zip = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
    expect(manifest.resources.map((r: Resource) => r.metadata.completeBody)).toEqual([
      'not in list summary',
      'not in list summary',
    ])
    expect(manifest.versions[0].metadata.completeBody).toBe('not in list summary')
    const db = new AppDatabase(`lazy-zip-${crypto.randomUUID()}`)
    const service = new RestoreService(
      new IndexedDbArchiveStorage(db),
      new IndexedDbRestoreStagingStore(db),
    )
    try {
      const prepared = await service.prepare(
        new File([archive.blob], archive.fileName),
        [],
        [],
        true,
      )
      expect(prepared.resources.every((r) => r.originalBlob.size === 0)).toBe(true)
      expect(prepared.versions[0]?.originalBlob.size).toBe(0)
      // The lazy restore preview keeps staged bytes until the user confirms it;
      // this avoids copying a large archive into RAM before commit.
      expect(await db.restoreStaging.count()).toBeGreaterThan(0)
      expect(await db.restoreStagingChunks.count()).toBeGreaterThan(0)
      const progress: Array<{ transferredBytes?: number; totalBytes?: number }> = []
      await service.replace(prepared, (entry) => progress.push(entry))
      expect(progress.some((entry) => (entry.totalBytes ?? 0) > 0)).toBe(true)
      expect(progress.some((entry) => (entry.transferredBytes ?? 0) > 0)).toBe(true)
      for (const expected of records) {
        const stored = hydrateResourceFromIndexedDb((await db.resources.get(expected.id))!)
        expect(await hashBlob(stored.originalBlob)).toBe(expected.contentHash)
        expect(stored.metadata).toEqual(expected.metadata)
      }
      const old = hydrateResourceFromIndexedDb((await db.resourceVersions.toArray())[0]!)
      expect(await hashBlob(old.originalBlob)).toBe(version.contentHash)
      expect(old.versionGroupId).toBe('b')
      expect(await db.restoreStaging.count()).toBe(0)
      expect(await db.restoreStagingChunks.count()).toBe(0)
    } finally {
      db.close()
      await db.delete()
    }
  })

  it('loads a bound greeting outside the export selection for modified cards', async () => {
    const card = {
      ...(await resource('card')),
      type: RESOURCE_TYPE.CHARACTER_CARD,
      metadata: {
        card: { name: 'Card', first_mes: 'old' },
        characterOverrides: { greetingResourceId: 'greeting' },
      },
    }
    const greeting = {
      ...(await resource('greeting')),
      originalBlob: new Blob(['{"first_mes":"replacement"}']),
    }
    greeting.fileSize = greeting.originalBlob.size
    greeting.contentHash = await hashBlob(greeting.originalBlob)
    const read = vi.fn(async (summary: { id: string }) =>
      summary.id === card.id ? card : greeting,
    )
    const archive = (
      await new ExportService().createArchivesFromSource(
        { resources: [card, greeting].map(toResourceListSummary), versions: [], read },
        [],
        { mode: 'partial', resourceIds: [card.id], resourceContent: 'modified' },
      )
    )[0]!
    const entries = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']))
    expect(manifest.resources).toHaveLength(1)
    expect(manifest.resources[0].metadata.card.first_mes).toBe('replacement')
    const output = entries[manifest.resources[0].archivePath]!
    expect(JSON.parse(new TextDecoder().decode(output)).first_mes).toBe('replacement')
    expect(await hashBlob(new Blob([output]))).toBe(manifest.resources[0].contentHash)
    expect(card.metadata.card.first_mes).toBe('old')
    expect(read.mock.calls.map(([summary]) => summary.id)).toEqual(['card', 'greeting'])
  })

  it('bounds synthetic Response bodies while preserving one complete ZIP', async () => {
    const NativeResponse = globalThis.Response
    const sizes: number[] = []
    vi.stubGlobal(
      'Response',
      class extends NativeResponse {
        override async blob() {
          const blob = await super.blob()
          sizes.push(blob.size)
          return blob
        }
      },
    )
    try {
      const record = {
        ...(await resource('segments')),
        mimeType: 'image/png',
        fileName: 'segments.png',
        originalBlob: new Blob([new Uint8Array(34 * 1024 * 1024)]),
      }
      record.fileSize = record.originalBlob.size
      record.contentHash = await hashBlob(record.originalBlob)
      const archive = await new ExportService().createArchive([record], [], { mode: 'full' })
      expect(sizes.length).toBeGreaterThan(1)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(32 * 1024 * 1024)
      const files = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))
      expect(await hashBlob(new Blob([files['files/other/segments-segments.png']!]))).toBe(
        record.contentHash,
      )
    } finally {
      vi.stubGlobal('Response', NativeResponse)
    }
  })

  it('does not clear the library when replacement hydration or final commit fails', async () => {
    const db = new AppDatabase(`replace-rollback-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(db)
    const original = await resource('original')
    const replacement = await resource('replacement')
    try {
      await storage.restore([], [original])
      await expect(
        storage.replace([], [replacement], [], async () => {
          throw new Error('read failed')
        }),
      ).rejects.toThrow('read failed')
      expect(await db.resources.get(original.id)).toBeDefined()
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('copy failed'))
      vi.stubGlobal('navigator', { userAgent: 'AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15' })
      try {
        // Only WebKit needs the compatibility copy; exercise its failure explicitly.
        const originalBlob = new Blob([new Uint8Array(1024 * 1024 + 1)])
        await expect(
          storage.replace([], [{ ...replacement, originalBlob, fileSize: originalBlob.size }]),
        ).rejects.toThrow('copy failed')
      } finally {
        fetch.mockRestore()
        vi.unstubAllGlobals()
      }
      expect(await db.resources.get(original.id)).toBeDefined()
      expect(await db.resources.get(replacement.id)).toBeUndefined()
      expect(await db.restoreStaging.count()).toBe(0)
    } finally {
      db.close()
      await db.delete()
    }
  })

  it('aborts a destination and stops reading when a streaming write fails', async () => {
    const records = [await resource('a'), await resource('b')]
    const read = vi.fn(async (summary: { id: string }) => records.find((r) => r.id === summary.id)!)
    const abort = vi.fn(async () => {})
    const commit = vi.fn(async () => {})
    await expect(
      new ExportService().createArchivesFromSource(
        {
          resources: records.map(toResourceListSummary),
          versions: [],
          read,
        },
        [],
        { mode: 'full' },
        async () => ({
          write: async () => {
            throw new Error('disk full')
          },
          abort,
          commit,
        }),
      ),
    ).rejects.toThrow('disk full')
    expect(read).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('passes opt-in prefetch cancellation through lazy export and drains its source reads', async () => {
    const records = await Promise.all(['a', 'b', 'c', 'd'].map(resource))
    const controller = new AbortController()
    const drained: string[] = []
    const read = vi.fn(async (summary: { id: string }) => {
      if (summary.id === 'a') return records[0]!
      return new Promise<Resource>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            drained.push(summary.id)
            reject(controller.signal.reason)
          },
          { once: true },
        )
      })
    })
    const failure = new Error('prefetched destination full')
    const onFailure = vi.fn((reason: unknown) => controller.abort(reason))
    const abort = vi.fn(async () => {})
    const commit = vi.fn(async () => {})
    await expect(
      new ExportService().createArchivesFromSource(
        { resources: records.map(toResourceListSummary), versions: [], read },
        [],
        { mode: 'full' },
        async () => ({
          write: async () => {
            throw failure
          },
          abort,
          commit,
        }),
        { signal: controller.signal, readAhead: { onFailure } },
      ),
    ).rejects.toBe(failure)
    expect(read.mock.calls.map(([summary]) => summary.id)).toEqual(['a', 'b', 'c'])
    expect(drained).toEqual(['b', 'c'])
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })
})
