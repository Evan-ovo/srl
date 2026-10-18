import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { ResourceService } from '../services/ResourceService'
import { VaultService } from '../services/VaultService'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'

async function fixture(encrypted: boolean) {
  const database = new AppDatabase(`version-metadata-${crypto.randomUUID()}`)
  const vault = encrypted ? new VaultService(database) : undefined
  await vault?.initialize()
  await vault?.enable('test-password')
  const storage = new IndexedDbResourceStorage(database, vault)
  const originalBlob = new Blob(['original '.repeat(1024)], { type: 'text/plain' })
  const current: Resource = {
    id: 'current',
    type: RESOURCE_TYPE.OTHER,
    name: '保留',
    description: '',
    fileName: 'file.txt',
    mimeType: 'text/plain',
    fileSize: originalBlob.size,
    originalBlob,
    contentHash: 'hash',
    tags: [],
    favorite: false,
    categoryId: null,
    metadata: { retained: 'value', remove: 'old' },
    createdAt: 1,
    updatedAt: 1,
  }
  await storage.save(current)
  const history = { ...current, id: 'history', versionGroupId: current.id, versionNote: 'old note' }
  const sibling = { ...history, id: 'unrelated-carrier' }
  await storage.saveVersion(history)
  await storage.saveVersion(sibling)
  return {
    database,
    vault,
    storage,
    current,
    history,
    service: new ResourceService(storage, new ResourceParserRegistry([])),
  }
}

it.each([false, true])(
  'saves only the selected history note without reading sibling files or materializing originals (vault=%s)',
  async (encrypted) => {
    const { database, vault, storage, service, history } = await fixture(encrypted)
    try {
      const allHistory = vi.spyOn(storage, 'listVersions')
      const fullSave = vi.spyOn(storage, 'saveVersion')
      const decrypt = vault ? vi.spyOn(vault, 'decodeResource') : undefined
      const writes = vi.spyOn(storage, 'updateVersion')
      let originalCopies = 0
      const arrayBuffer = Blob.prototype.arrayBuffer
      const bytes = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (
        this: Blob,
      ) {
        if (this.size === history.originalBlob.size) originalCopies++
        return arrayBuffer.call(this)
      })
      await service.updateVersionNote('current', history.id, '  changed note  ')
      expect(allHistory.mock.calls.length + fullSave.mock.calls.length).toBe(0)
      expect(decrypt?.mock.calls.length ?? 0).toBe(0)
      expect(originalCopies).toBe(0)
      expect(writes).toHaveBeenCalledExactlyOnceWith(history.id, { versionNote: 'changed note' })
      await service.updateVersionNote('current', history.id, 'changed note')
      expect(writes).toHaveBeenCalledOnce()
      bytes.mockRestore()
      database.close()
      await database.open()
      const saved = (await storage.getVersion(history.id))!
      expect(saved.versionNote).toBe('changed note')
      expect(saved.updatedAt).toBe(history.updatedAt)
      expect(saved.metadata).toEqual(history.metadata)
      expect(await saved.originalBlob.text()).toBe(await history.originalBlob.text())
      expect((await storage.getSummary('unrelated-carrier', true))?.versionNote).toBe('old note')
    } finally {
      vi.restoreAllMocks()
      await database.delete()
    }
  },
)

it.each([false, true])(
  'keeps metadata replacement semantics, attachments and rollback for a historical patch (vault=%s)',
  async (encrypted) => {
    const { database, vault, storage, history, current } = await fixture(encrypted)
    try {
      const thumbnailBlob = new Blob(['legacy thumbnail'], { type: 'image/webp' })
      const legacy = { ...history, thumbnailBlob, thumbnailAssetId: undefined }
      await database.resourceVersions.put(vault ? await vault.encodeResource(legacy) : legacy)
      const legacyCurrent = { ...current, thumbnailBlob, thumbnailAssetId: undefined }
      await database.resources.put(
        vault ? await vault.encodeResource(legacyCurrent) : legacyCurrent,
      )
      const decrypt = vault ? vi.spyOn(vault, 'decodeResource') : undefined
      const updateSummary = vi
        .spyOn(database.resourceVersionSummaries, 'put')
        .mockRejectedValueOnce(new Error('summary write failed'))
      await expect(
        storage.updateVersion(history.id, { metadata: { retained: 'new' } }),
      ).rejects.toThrow('summary write failed')
      updateSummary.mockRestore()
      expect((await storage.getSummary(history.id, true))?.metadata).toEqual(history.metadata)
      await storage.updateVersion(history.id, { metadata: { retained: 'new' } })
      expect(decrypt?.mock.calls.length ?? 0).toBe(0)
      database.close()
      await database.open()
      const saved = (await storage.getVersion(history.id))!
      expect(saved.metadata).toEqual({ retained: 'new' })
      expect(await saved.originalBlob.text()).toBe(await history.originalBlob.text())
      expect(await saved.thumbnailBlob?.text()).toBe('legacy thumbnail')
      await storage.updateMetadata('current', { metadata: { retained: 'new' } })
      expect((await storage.getSummary('current'))?.metadata).toEqual({
        retained: 'new',
        remove: 'old',
      })
      expect(await (await storage.get('current'))?.thumbnailBlob?.text()).toBe('legacy thumbnail')
      await storage.updateVersion(history.id, { thumbnailBlob: undefined })
      expect((await storage.getVersion(history.id))?.thumbnailBlob).toBeUndefined()
      await storage.updateVersion(history.id, { metadata: undefined })
      expect((await storage.getSummary(history.id, true))?.metadata).toEqual({})
      await storage.updateVersion('missing', { versionNote: 'not saved' })
      const assetCount = await database.assets.count()
      await storage.updateVersion('missing', { thumbnailBlob })
      expect(await database.assets.count()).toBe(assetCount)
      expect(await storage.getSummary('missing', true)).toBeUndefined()
      await expect(storage.updateMetadata('missing', { versionNote: 'not saved' })).rejects.toThrow(
        '资源不存在',
      )
    } finally {
      vi.restoreAllMocks()
      await database.delete()
    }
  },
)

it('rejects history from another resource group without a write', async () => {
  const { database, storage, service } = await fixture(false)
  try {
    const writes = vi.spyOn(storage, 'updateVersion')
    await expect(
      service.updateVersionNote('another-group', 'history', 'bad target'),
    ).rejects.toThrow('历史版本已经不存在')
    expect(writes).not.toHaveBeenCalled()
    expect((await storage.getSummary('history', true))?.versionNote).toBe('old note')
  } finally {
    await database.delete()
  }
})

it.each([false, true])(
  'still replaces a historical original explicitly (vault=%s)',
  async (encrypted) => {
    const { database, storage, history } = await fixture(encrypted)
    try {
      const originalBlob = new Blob(['explicit replacement'], { type: 'application/json' })
      await storage.updateVersion(history.id, {
        originalBlob,
        fileSize: originalBlob.size,
        fileName: 'replacement.json',
        mimeType: originalBlob.type,
        contentHash: 'replacement-hash',
        metadata: { replaced: true },
      })
      database.close()
      await database.open()
      const saved = (await storage.getVersion(history.id))!
      expect(await saved.originalBlob.text()).toBe('explicit replacement')
      expect(saved).toMatchObject({
        versionGroupId: history.versionGroupId,
        fileName: 'replacement.json',
        contentHash: 'replacement-hash',
        metadata: { replaced: true },
      })
    } finally {
      await database.delete()
    }
  },
)
