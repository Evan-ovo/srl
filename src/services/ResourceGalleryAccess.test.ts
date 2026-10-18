import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import type { ResourceStorageAdapter } from '../storage/ResourceStorageAdapter'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { RESOURCE_GALLERY_ASSET_KIND } from '../types/ResourceGallery'
import { createImageThumbnail } from '../utils/createImageThumbnail'
import { hashBlob } from './HashService'
import { ResourceGalleryService, moveResourceGallery } from './ResourceGalleryService'
import { VaultService } from './VaultService'

vi.mock('../utils/createImageThumbnail', () => ({ createImageThumbnail: vi.fn() }))
const databases: AppDatabase[] = []
beforeEach(() => {
  vi.mocked(createImageThumbnail)
    .mockReset()
    .mockResolvedValue(new Blob(['regenerated'], { type: 'image/webp' }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.delete()
})

async function fixture(encrypted: boolean) {
  const database = new AppDatabase(`gallery-access-${crypto.randomUUID()}`)
  databases.push(database)
  const vault = encrypted ? new VaultService(database) : undefined
  await vault?.initialize()
  await vault?.enable('test-password')
  const assets = new IndexedDbAssetStore(database, vault)
  const storage = new IndexedDbResourceStorage(database, vault, assets)
  const gallery = new ResourceGalleryService(storage, undefined, assets)
  const base: Resource = {
    id: 'a',
    type: RESOURCE_TYPE.OTHER,
    name: 'owner',
    description: '',
    fileName: 'owner.txt',
    mimeType: 'text/plain',
    fileSize: 1,
    contentHash: await hashBlob(new Blob(['a'])),
    originalBlob: new Blob(['a']),
    tags: [],
    favorite: false,
    categoryId: null,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  await storage.saveMany([base, { ...base, id: 'b' }, { ...base, id: 'c' }])
  const file = new File(['pixels'.repeat(10000)], 'image.png', { type: 'image/png' })
  const image: Resource = {
    ...base,
    id: 'image-a',
    name: ' image name ',
    description: 'd'.repeat(5001),
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    contentHash: await hashBlob(file),
    originalBlob: file,
    thumbnailBlob: new Blob(['prepared thumbnail'], { type: 'image/webp' }),
    tags: ['keep'],
    metadata: {
      assetKind: RESOURCE_GALLERY_ASSET_KIND,
      galleryOwnerId: 'a',
      galleryVisible: false,
      galleryStorage: 'local',
      retained: { nested: true },
    },
  }
  await storage.save(image)
  return { database, vault, assets, storage, gallery, image, file }
}

it.each([false, true])(
  'uses an atomic Web metadata read without an extra explicit read transaction (vault=%s)',
  async (encrypted) => {
    const { database, storage, image } = await fixture(encrypted)
    await storage.saveVersion({ ...image, id: 'history', versionGroupId: 'a' })
    const transactions = vi.spyOn(database, 'transaction')
    const originals = vi.spyOn(storage, 'get')
    expect((await storage.getSummary(image.id))?.metadata.retained).toEqual({ nested: true })
    expect((await storage.getSummary('history', true))?.metadata.retained).toEqual({ nested: true })
    expect(await storage.getSummary('missing')).toBeUndefined()
    expect(transactions).not.toHaveBeenCalled()
    expect(originals).not.toHaveBeenCalled()
    const name = (await storage.getSummary(image.id))!.name
    await expect(
      database.transaction(
        'rw',
        [database.resources, database.resourceSummaries, database.resourceListSummaries],
        async () => {
          await storage.updateMetadata(image.id, { name: 'uncommitted name' })
          expect((await Dexie.waitFor(storage.getSummary(image.id)))?.name).toBe('uncommitted name')
          throw new Error('rollback')
        },
      ),
    ).rejects.toThrow('rollback')
    expect((await storage.getSummary(image.id))?.name).toBe(name)
  },
)

it.each([false, true])(
  'reads prepared gallery previews without hydrating originals and rejects a changed owner (vault=%s)',
  async (encrypted) => {
    const { database, vault, assets, storage, gallery, image } = await fixture(encrypted)
    const originals = vi.spyOn(storage, 'get')
    const assetReads = vi.spyOn(assets, 'getBlob')
    const decrypt = vault ? vi.spyOn(vault, 'decodeResource') : undefined
    const preview = await gallery.getImagePreview('a', image.id)
    expect(await preview.blob?.text()).toBe('prepared thumbnail')
    expect(preview.url).toBe('')
    expect(originals).not.toHaveBeenCalled()
    expect(decrypt?.mock.calls.length ?? 0).toBe(0)
    expect(assetReads).toHaveBeenCalledOnce()
    await storage.updateMetadata(image.id, { metadata: { galleryOwnerId: 'b' } })
    assetReads.mockClear()
    await expect(gallery.getImagePreview('a', image.id)).rejects.toThrow('不属于')
    await expect(gallery.getImagePreview('a', 'missing')).rejects.toThrow('已移除')
    expect(assetReads).not.toHaveBeenCalled()
    expect(originals).not.toHaveBeenCalled()
    database.close()
    await database.open()
    expect(await (await storage.get(image.id))?.originalBlob.text()).toBe(
      await image.originalBlob.text(),
    )
  },
)

it('reads a linked preview without loading its JSON body or a thumbnail asset', async () => {
  const { storage, gallery, assets, image } = await fixture(false)
  await storage.updateMetadata(image.id, {
    metadata: { galleryStorage: 'url', galleryUrl: 'https://example.com/image.png' },
  })
  const originals = vi.spyOn(storage, 'get'),
    reads = vi.spyOn(assets, 'getBlob')
  expect(await gallery.getImagePreview('a', image.id)).toEqual({
    url: 'https://example.com/image.png',
  })
  expect(originals).not.toHaveBeenCalled()
  expect(reads).not.toHaveBeenCalled()
})

it.each([false, true])(
  'repairs a missing derived image through the original route and preserves file bytes (vault=%s)',
  async (encrypted) => {
    const { storage, gallery, database, image } = await fixture(encrypted)
    const saved = (await storage.getSummary(image.id))!
    await database.assetFiles.delete(saved.thumbnailAssetId!)
    const originals = vi.spyOn(storage, 'get')
    const preview = await gallery.getImagePreview('a', image.id)
    expect(await preview.blob?.text()).toBe('regenerated')
    expect(originals).toHaveBeenCalledExactlyOnceWith(image.id)
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    database.close()
    await database.open()
    expect(await (await storage.getThumbnail(image.id))?.text()).toBe('regenerated')
    expect(await (await storage.get(image.id))?.originalBlob.text()).toBe(
      await image.originalBlob.text(),
    )
  },
)

it('keeps a legacy adapter on one full read and propagates a genuine asset error without extra work', async () => {
  const { storage, image, assets, gallery } = await fixture(false)
  const get = vi.fn(storage.get.bind(storage))
  const legacy = new ResourceGalleryService({ get } as unknown as ResourceStorageAdapter)
  expect(await (await legacy.getImagePreview('a', image.id)).blob?.text()).toBe(
    'prepared thumbnail',
  )
  expect(get).toHaveBeenCalledExactlyOnceWith(image.id)
  const originals = vi.spyOn(storage, 'get')
  vi.spyOn(assets, 'getBlob').mockRejectedValueOnce(new Error('asset failed'))
  await expect(gallery.getImagePreview('a', image.id)).rejects.toThrow('asset failed')
  expect(originals).not.toHaveBeenCalled()
})

it.each([false, true])(
  'edits, categorizes and moves gallery metadata without loading pictures or changing unrelated text (vault=%s)',
  async (encrypted) => {
    const { storage, gallery, database, image } = await fixture(encrypted)
    const before = (await storage.getSummary(image.id))!
    const originals = vi.spyOn(storage, 'get')
    await gallery.setCategories('a', [image.id, image.id], [' new ', 'new'], true)
    const categorized = (await storage.getSummary(image.id))!
    expect(categorized.tags).toEqual(['keep', 'new'])
    expect(categorized.name).toBe(before.name)
    expect(categorized.description).toBe(before.description)
    await gallery.edit('a', image.id, {
      name: ' edited ',
      description: 'new description',
      tags: ['old'],
    })
    await gallery.renameCategory('a', 'old', 'renamed')
    await moveResourceGallery(storage, 'a', 'b')
    expect(originals).not.toHaveBeenCalled()
    database.close()
    await database.open()
    const saved = (await storage.get(image.id))!
    expect(saved).toMatchObject({
      name: 'edited',
      description: 'new description',
      tags: ['renamed'],
      metadata: { galleryOwnerId: 'b', galleryVisible: true, retained: { nested: true } },
    })
    expect(await saved.originalBlob.text()).toBe(await image.originalBlob.text())
    expect(await saved.thumbnailBlob?.text()).toBe('prepared thumbnail')
  },
)

it('does not move a picture already reassigned after the supplied snapshot', async () => {
  const { storage, image } = await fixture(false)
  const snapshot = [(await storage.getSummary(image.id))!]
  await storage.updateMetadata(image.id, { metadata: { galleryOwnerId: 'b' } })
  const writes = vi.spyOn(storage, 'updateMetadata')
  await moveResourceGallery(storage, 'a', 'c', snapshot)
  expect(writes).not.toHaveBeenCalled()
  expect((await storage.getSummary(image.id))?.metadata.galleryOwnerId).toBe('b')
})

it('keeps original-returning cover APIs while avoiding image payloads for selection and removal', async () => {
  const { gallery, storage, image } = await fixture(false)
  const originals = vi.spyOn(storage, 'get')
  const selected = await gallery.setCover('a', image.id)
  expect(await selected.originalBlob.text()).toBe('a')
  expect(originals.mock.calls.map(([id]) => id)).toEqual(['a'])
  originals.mockClear()
  await gallery.remove('a', [image.id])
  expect(originals).not.toHaveBeenCalled()
  expect((await storage.getSummary(image.id))?.metadata.galleryVisible).toBe(false)
  const restored = await gallery.restoreDefaultCover('a')
  expect(await restored.originalBlob.text()).toBe('a')
  expect(originals.mock.calls.map(([id]) => id)).toEqual(['a'])
  expect(await storage.getSummary(image.id)).toBeUndefined()
})

it.each([false, true])(
  'does not rewrite unchanged gallery metadata and keeps normalization and returned originals (vault=%s)',
  async (encrypted) => {
    const { gallery, storage, image, file } = await fixture(encrypted)
    const current = (await storage.getSummary(image.id))!
    const writes = vi.spyOn(storage, 'updateMetadata')
    await gallery.renameCategory('a', 'keep', ' keep ')
    expect(writes).not.toHaveBeenCalled()
    await gallery.setCategories('a', [image.id], ['keep'])
    await gallery.edit('a', image.id, {
      name: current.name,
      description: current.description.slice(0, 5000),
      tags: current.tags,
    })
    // The long legacy description is normalized once, then identical edits are a no-op.
    expect(writes).toHaveBeenCalledTimes(1)
    writes.mockClear()
    await gallery.edit('a', image.id, {
      name: current.name,
      description: current.description.slice(0, 5000),
      tags: ['keep'],
    })
    const duplicate = await gallery.addFile('a', file, ['keep'], false)
    expect(await duplicate.originalBlob.text()).toBe(await file.text())
    expect(writes).not.toHaveBeenCalled()
    await gallery.setCover('a', image.id)
    writes.mockClear()
    await gallery.setCover('a', image.id)
    expect(writes).not.toHaveBeenCalled()
    await gallery.remove('a', [image.id])
    writes.mockClear()
    await gallery.remove('a', [image.id])
    expect(writes).not.toHaveBeenCalled()
    await gallery.restoreDefaultCover('a')
    writes.mockClear()
    await gallery.restoreDefaultCover('a')
    expect(writes).not.toHaveBeenCalled()
    const extra = {
      ...image,
      id: 'self-move',
      metadata: { ...image.metadata, galleryVisible: true },
    }
    await storage.save(extra)
    writes.mockClear()
    await moveResourceGallery(storage, 'a', 'a', [(await storage.getSummary(extra.id))!])
    expect(writes).not.toHaveBeenCalled()
  },
)

it.each([false, true])(
  'reads a repeated image original only once for its Resource return contract (vault=%s)',
  async (encrypted) => {
    const { gallery, storage, image, file } = await fixture(encrypted)
    const originals = vi.spyOn(storage, 'get')
    const result = await gallery.addFile('a', file, ['new'])
    expect(result.id).toBe(image.id)
    expect(result.tags).toEqual(['keep', 'new'])
    expect(result.metadata.retained).toEqual({ nested: true })
    expect(result.metadata.galleryVisible).toBe(true)
    expect(await result.originalBlob.text()).toBe(await file.text())
    expect(originals.mock.calls.filter(([id]) => id === image.id)).toHaveLength(1)
  },
)
