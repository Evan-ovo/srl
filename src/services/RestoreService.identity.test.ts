import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { StructuredResource } from './CloudStructuredSnapshot'
import { ExportService } from './ExportService'
import { hashBlob } from './HashService'
import { RestoreService } from './RestoreService'
import { VaultService } from './VaultService'
import { summarizeRestoreSelection } from '../utils/RestoreIdentity'

async function fixture(): Promise<Resource[]> {
  const create = async (id: string, body: string): Promise<Resource> => {
    const originalBlob = new Blob([body])
    return {
      id,
      type: RESOURCE_TYPE.OTHER,
      name: id,
      fileName: `${id}.bin`,
      mimeType: 'application/octet-stream',
      description: '',
      originalBlob,
      fileSize: originalBlob.size,
      contentHash: await hashBlob(originalBlob),
      metadata: {},
      categoryId: null,
      favorite: false,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }
  }
  const persona = {
    ...(await create('persona', 'persona')),
    type: RESOURCE_TYPE.USER_PERSONA,
    relatedResourceIds: ['a', 'b'],
  }
  const avatars = await Promise.all(
    ['a', 'b'].map(async (id) => ({
      ...(await create(id, 'same-pixels')),
      metadata: { assetKind: 'userPersonaAvatar', avatarId: `${id}.png` },
      relatedResourceIds: [persona.id],
    })),
  )
  return [persona, ...avatars]
}

function structured(resource: Resource): StructuredResource {
  const { originalBlob: _blob, ...record } = resource
  return {
    ...record,
    object: {
      format: 'srl-github-backup-bundle',
      version: 2,
      createdAt: new Date(1).toISOString(),
      fileName: resource.fileName,
      totalSize: resource.fileSize,
      totalSha256: resource.contentHash,
      parts: [
        {
          name: `srl-chunk--sha256-${resource.contentHash}`,
          size: resource.fileSize,
          sha256: resource.contentHash,
        },
      ],
    },
  }
}

describe('restore the same backup repeatedly', () => {
  it('replans verified ZIP staging against new conflicts without re-extracting or reading original bodies', async () => {
    const db = new AppDatabase(`zip-replan-${crypto.randomUUID()}`)
    const staging = new IndexedDbRestoreStagingStore(db)
    const service = new RestoreService(new IndexedDbArchiveStorage(db), staging)
    const records = await fixture()
    const archive = await new ExportService().createArchive(records, [], { mode: 'full' })
    const initial = await service.prepare(new File([archive.blob], archive.fileName), [], [], true)
    const write = vi.spyOn(staging, 'putChunk')
    const body = vi.spyOn(staging, 'get')
    try {
      const existing = [{ ...records[0]!, contentHash: 'f'.repeat(64) }]
      const replanned = await initial.replan!(existing, [])
      expect(replanned.resources).toHaveLength(records.length)
      expect(replanned.resources[0]!.id).not.toBe(records[0]!.id)
      expect(new Map(replanned.sourceResourceIds).get(records[0]!.id)).toBe(
        replanned.resources[0]!.id,
      )
      expect(replanned.staging?.jobId).toBe(initial.staging?.jobId)
      expect(write).not.toHaveBeenCalled()
      expect(body).not.toHaveBeenCalled()
    } finally {
      await initial.dispose?.()
      write.mockRestore()
      body.mockRestore()
      db.close()
      await db.delete()
    }
  })
  it.each(['zip', 'structured', 'native', 'encrypted'] as const)(
    '%s adds no hidden avatars or history on repeat',
    async (mode) => {
      const db = new AppDatabase(`restore-identity-${crypto.randomUUID()}`)
      const vault = mode === 'encrypted' ? new VaultService(db) : undefined
      if (vault) {
        await vault.initialize()
        await vault.enable('restore-test-password')
      }
      const storage = new IndexedDbArchiveStorage(db, vault)
      const library = new IndexedDbResourceStorage(db, vault)
      const service = new RestoreService(storage, new IndexedDbRestoreStagingStore(db))
      const records = await fixture()
      const version = {
        ...records[0]!,
        id: 'history',
        versionGroupId: 'persona',
        versionImportedAt: 1,
      }
      const archive = await new ExportService().createArchive(records, [], { mode: 'full' }, [
        version,
      ])
      try {
        for (let round = 0; round < 3; round++) {
          const existing = await library.listResourceListSummaries()
          const prepared =
            mode === 'zip'
              ? await service.prepare(
                  new File([archive.blob], archive.fileName),
                  existing,
                  [],
                  true,
                )
              : mode === 'native'
                ? await service.prepareStructuredNative(
                    records.map(structured),
                    [structured(version)],
                    [],
                    { version: 1 },
                    existing,
                    [],
                    'backup',
                  )
                : await service.prepareStructured(
                    records,
                    [version],
                    [],
                    { version: 1 },
                    existing,
                    [],
                    'backup',
                  )
          expect(summarizeRestoreSelection(existing, records).added).toBe(prepared.resources.length)
          expect(prepared.resources.length).toBe(round === 0 ? 3 : 0)
          expect(prepared.versions.length).toBe(round === 0 ? 1 : 0)
          const report =
            mode === 'native'
              ? await service.restoreNative(
                  prepared as Awaited<ReturnType<typeof service.prepareStructuredNative>>,
                )
              : await service.restore(prepared as Awaited<ReturnType<typeof service.prepare>>)
          expect(report.restoredResources).toBe(round === 0 ? 3 : 0)
          expect(await db.resources.count()).toBe(3)
          expect(await db.resourceVersions.count()).toBe(1)
          const summaries = await library.listResourceListSummaries()
          expect(summaries.find((r) => r.id === 'persona')?.relatedResourceIds).toEqual(['a', 'b'])
          expect(
            summaries
              .filter((r) => r.metadata.assetKind === 'userPersonaAvatar')
              .map((r) => r.metadata.avatarId)
              .sort(),
          ).toEqual(['a.png', 'b.png'])
        }
      } finally {
        db.close()
        await db.delete()
      }
    },
  )
  it('preserves previously added rows and separate history metadata while preventing more copies', async () => {
    const db = new AppDatabase(`restore-existing-copies-${crypto.randomUUID()}`)
    const storage = new IndexedDbArchiveStorage(db)
    const library = new IndexedDbResourceStorage(db)
    const service = new RestoreService(storage)
    const records = await fixture()
    const copies = records.slice(1).map((record) => ({ ...record, id: `copy-${record.id}` }))
    const version = {
      ...records[0]!,
      id: 'old',
      versionGroupId: 'persona',
      metadata: { custom: 'one' },
    }
    try {
      await storage.restore([], [...records, ...copies], [version, { ...version, id: 'old-copy' }])
      const existing = await library.listResourceListSummaries()
      const prepared = await service.prepareStructured(
        records,
        [version, { ...version, id: 'different', metadata: { custom: 'two' } }],
        [],
        { version: 1 },
        existing,
        [],
        'same backup',
      )
      expect(prepared.resources).toHaveLength(0)
      expect(prepared.versions).toHaveLength(1)
      expect(prepared.versions[0]?.metadata.custom).toBe('two')
      await service.restore(prepared)
      expect(await db.resources.count()).toBe(5)
      expect(await db.resourceVersions.count()).toBe(3)
      expect(await db.resources.get('copy-a')).toBeDefined()
      expect(await db.resources.get('copy-b')).toBeDefined()
    } finally {
      db.close()
      await db.delete()
    }
  })

  it('maps avatar identity across persona ID conflicts without merging different owners', async () => {
    const service = new RestoreService({ restore: async () => {}, replace: async () => {} })
    const original = await fixture()
    const remapped = original.map((record) => ({
      ...record,
      id: `local-${record.id}`,
      relatedResourceIds: record.relatedResourceIds?.map((id) => `local-${id}`),
    }))
    const existing = remapped.filter((record) => record.id !== 'local-b')
    const prepared = await service.prepareStructured(
      original,
      [],
      [],
      { version: 1 },
      existing,
      [],
      'backup',
    )
    expect(prepared.resources).toHaveLength(1)
    expect(prepared.resources[0]?.metadata.avatarId).toBe('b.png')
    expect(prepared.resources[0]?.relatedResourceIds).toEqual(['local-persona'])
    const otherOwner = {
      ...original[0]!,
      id: 'other-owner',
      contentHash: 'f'.repeat(64),
      relatedResourceIds: ['other-avatar'],
    }
    const otherAvatar = { ...original[1]!, id: 'other-avatar', relatedResourceIds: [otherOwner.id] }
    const another = await service.prepareStructured(
      [otherOwner, otherAvatar],
      [],
      [],
      { version: 1 },
      remapped,
      [],
      'other backup',
    )
    expect(another.resources).toHaveLength(2)
  })
})
