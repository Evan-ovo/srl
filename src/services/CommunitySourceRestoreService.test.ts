import { describe, expect, it, vi } from 'vitest'

import type { ArchiveStorageAdapter } from '../storage/ArchiveStorageAdapter'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import type { ArchivePortableData, PreparedRestore } from '../types/Backup'
import type { CommunitySourceBackupData } from '../types/CommunitySource'
import { CommunitySourceRestoreService } from './CommunitySourceRestoreService'
import 'fake-indexeddb/auto'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { restoreCommunitySourceLocalAttachments } from './CommunitySourceAttachmentArchive'
import { hashCloudBlob } from './CloudArchiveCodec'
import { VaultService } from './VaultService'

function prepared(communitySourceData?: CommunitySourceBackupData): PreparedRestore {
  return {
    preview: {
      fileName: 'backup.zip',
      mode: 'full',
      createdAt: '2026-08-27T00:00:00.000Z',
      archiveResourceCount: 0,
      resourcesToAdd: 0,
      duplicatesToSkip: 0,
      conflictsToPreserve: 0,
      categoriesToCreate: 0,
      categoriesToReuse: 0,
    },
    resources: [],
    versions: [],
    categories: [],
    communitySourceData,
  }
}

function createService() {
  const storage: ArchiveStorageAdapter = {
    restore: vi.fn(async () => undefined),
    replace: vi.fn(async () => undefined),
  }
  const sourceOwner = {
    restoreBackup: vi.fn(async () => undefined),
    replaceAll: vi.fn(async () => undefined),
  }
  return {
    storage,
    sourceOwner,
    service: new CommunitySourceRestoreService(
      storage,
      new MemoryRestoreStagingStore(),
      sourceOwner,
    ),
  }
}

describe('CommunitySourceRestoreService', () => {
  it('repairs a missing encrypted attachment body without changing its existing references or protection', async () => {
    const database = new AppDatabase(`restore-protected-attachment-${crypto.randomUUID()}`)
    const vault = new VaultService(database)
    try {
      await vault.initialize()
      await vault.enable('fixture-password')
      const assets = new IndexedDbAssetStore(database, vault)
      const blob = new Blob(['private attachment body'], { type: 'text/plain' })
      const saved = await assets.put(blob, { source: 'remote', vaultProtected: true })
      await database.assets.update(saved.assetId, { thumbnailRefs: { card: 'preserved-card' } })
      await database.assetFiles.delete(saved.assetId)
      await restoreCommunitySourceLocalAttachments(assets, [{ assetId: saved.assetId, blob }])
      const restored = await assets.get(saved.assetId)
      expect(restored).toMatchObject({
        encrypted: true,
        vaultProtected: true,
        createdAt: saved.createdAt,
        thumbnailRefs: { card: 'preserved-card' },
      })
      expect(await (await assets.getBlob(saved.assetId))!.text()).toBe(await blob.text())
      expect(await (await database.assetFiles.get(saved.assetId))!.blob.text()).not.toBe(
        await blob.text(),
      )
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('reuses 77 verified local attachments, downloads only one addition, and repairs only missing or corrupt bodies', async () => {
    const database = new AppDatabase(`restore-attachment-reuse-${crypto.randomUUID()}`)
    const assets = new IndexedDbAssetStore(database)
    const entries: NonNullable<ArchivePortableData['communitySources']>['attachments'] = []
    const bodies = new Map<string, Blob>()
    try {
      for (let index = 0; index < 78; index++) {
        const blob = new Blob([new Uint8Array(1024).fill(index)], {
          type: 'application/octet-stream',
        })
        const hash = await hashCloudBlob(blob)
        bodies.set(hash, blob)
        entries.push({
          assetId: `asset-${hash}`,
          mimeType: blob.type,
          object: {
            format: 'srl-github-backup-bundle',
            version: 2,
            createdAt: new Date(1).toISOString(),
            fileName: `attachment-${index}.bin`,
            totalSize: blob.size,
            totalSha256: hash,
            parts: [],
          },
        })
        if (index < 77) await assets.put(blob, { source: 'remote', vaultProtected: true })
      }
      const service = new CommunitySourceRestoreService(
        {} as ArchiveStorageAdapter,
        new MemoryRestoreStagingStore(),
        { restoreBackup: async () => {}, replaceAll: async () => {} },
        (entries) => restoreCommunitySourceLocalAttachments(assets, entries),
        undefined,
        (id) => assets.getBlob(id),
      )
      const read = vi.fn(async (object: (typeof entries)[number]['object']) =>
        bodies.get(object.totalSha256)!,
      )
      const data: ArchivePortableData = {
        version: 1,
        communitySources: {
          data: { version: 1, sources: [], messages: [], bindings: [] },
          attachments: entries,
        },
      }
      await service.restoreStructuredCommunityAttachments(data, read)
      expect(read).toHaveBeenCalledTimes(1)
      expect(read.mock.calls[0]![0]).toBe(entries[77]!.object)
      read.mockClear()
      await service.restoreStructuredCommunityAttachments(data, read)
      expect(read).not.toHaveBeenCalled()
      await database.assetFiles.delete(entries[4]!.assetId)
      await database.assetFiles.update(entries[9]!.assetId, {
        blob: new Blob([new Uint8Array(1024).fill(255)]),
      })
      await service.restoreStructuredCommunityAttachments(data, read)
      expect(read.mock.calls.map(([object]) => object.fileName)).toEqual([
        'attachment-4.bin',
        'attachment-9.bin',
      ])
      database.close()
      await database.open()
      for (const entry of entries)
        expect(await hashCloudBlob((await assets.getBlob(entry.assetId))!)).toBe(
          entry.object.totalSha256,
        )
    } finally {
      database.close()
      await database.delete()
    }
  })
  it('preserves current community sources when a full replacement backup omitted them', async () => {
    const { service, sourceOwner } = createService()

    await service.replace(prepared())

    expect(sourceOwner.restoreBackup).not.toHaveBeenCalled()
    expect(sourceOwner.replaceAll).not.toHaveBeenCalled()
  })

  it('uses the archived community sources when the full replacement backup contains them', async () => {
    const { service, sourceOwner } = createService()
    const data: CommunitySourceBackupData = {
      version: 1,
      sources: [],
      messages: [],
      bindings: [],
    }

    await service.replace(prepared(data))

    expect(sourceOwner.restoreBackup).toHaveBeenCalledWith(data, 'replace')
    expect(sourceOwner.replaceAll).not.toHaveBeenCalled()
  })
})
