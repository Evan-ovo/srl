import { IndexedDbResourceGalleryCategoryStorage } from '../storage/ResourceGalleryCategoryStorage'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import {
  galleryOwnerId,
  includeResourceGalleryIds,
  normalizeGalleryUrl,
} from '../types/ResourceGallery'
import { moveResourceGallery, ResourceGalleryService } from './ResourceGalleryService'
import { createImageThumbnail } from '../utils/createImageThumbnail'
import { VaultService } from './VaultService'
import { hashBlob } from './HashService'
import { ExportService } from './ExportService'
import { RestoreService } from './RestoreService'
import { selectPreparedRestore, selectStructuredSnapshot } from './BackupRestoreSelection'
import { selectCloudResources } from './PersonalResourceBackup'
import { createStructuredSnapshot } from './CloudStructuredSnapshot'
import {
  createDefaultBackupSelection,
  toArchivePortableSelection,
  toCloudContentSelection,
} from './BackupScopeRegistry'
import { normalizeContentSelection } from './CloudBackupPolicy'
import { deleteMany } from './ResourceOrganizationOperations'
import { activateVersion, mergeExistingResourceAsVersion } from './ResourceVersionOperations'
vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: vi.fn(async (blob: Blob) =>
    blob.size ? new Blob(['thumbnail'], { type: 'image/webp' }) : undefined,
  ),
}))
const databases: AppDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
    await db.delete()
  }
})
async function fixture(onDatabase?: (db: AppDatabase) => void) {
  const db = new AppDatabase(`gallery-${crypto.randomUUID()}`)
  onDatabase?.(db)
  databases.push(db)
  const storage = new IndexedDbResourceStorage(db)
  const gallery = new ResourceGalleryService(
    storage,
    new IndexedDbResourceGalleryCategoryStorage(db),
  )
  const create = async (
    id: string,
    type: Resource['type'] = RESOURCE_TYPE.OTHER,
  ): Promise<Resource> => {
    const blob = new Blob([id], { type: 'application/octet-stream' })
    const r: Resource = {
      id,
      type,
      name: id,
      description: '',
      fileName: `${id}.bin`,
      mimeType: blob.type,
      fileSize: blob.size,
      contentHash: await hashBlob(blob),
      originalBlob: blob,
      favorite: false,
      categoryId: null,
      tags: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    await storage.save(r)
    return r
  }
  await create('a')
  await create('b')
  return {
    db,
    storage,
    gallery,
    create,
    restore: new RestoreService(
      new IndexedDbArchiveStorage(db),
      new IndexedDbRestoreStagingStore(db),
    ),
  }
}
const file = () => new File(['pixels'], '同人图.png', { type: 'image/png' })
describe('resource gallery lifecycle and backup', () => {
  it('queries only the required types in a mixed library and keeps gallery pages fresh', async () => {
    const keyQueries: Array<{ values: boolean | undefined; index: string | null; type: unknown }> =
      []
    const cursorTypes: unknown[] = []
    const { db, gallery, storage, create } = await fixture((db) => {
      db.use({
        stack: 'dbcore',
        name: 'gallery-query-evidence',
        create: (core) => ({
          ...core,
          table: (name) => {
            const table = core.table(name)
            if (name !== 'resourceSummaries') return table
            return {
              ...table,
              query: (request) => {
                keyQueries.push({
                  values: request.values,
                  index: request.query.index.name,
                  type: request.query.range.lower,
                })
                return table.query(request)
              },
              openCursor: (request) => {
                cursorTypes.push(request.query.range.lower)
                expect(request.query.index.name).toBe('type')
                return table.openCursor(request)
              },
            }
          },
        }),
      })
    })
    const owner = await create('card-1', RESOURCE_TYPE.CHARACTER_CARD)
    await create('card-2', RESOURCE_TYPE.CHARACTER_CARD)
    await create('theme', RESOURCE_TYPE.BEAUTIFICATION)
    await storage.saveMany(
      Array.from({ length: 1_000 }, (_, index) => ({
        ...owner,
        id: `unrelated-${index}`,
        type:
          index % 4 === 0
            ? RESOURCE_TYPE.CHARACTER_CARD
            : index % 2
              ? RESOURCE_TYPE.CHAT
              : RESOURCE_TYPE.WORLD_BOOK,
        metadata: { nested: { body: 'unrelated body'.repeat(200) } },
      })),
    )
    const first = await gallery.addUrl('card-1', 'https://example.com/first.png', false, ['本页'])
    const second = await gallery.addUrl('card-1', 'https://example.com/second.png', false, ['次页'])
    await gallery.addUrl('card-2', 'https://example.com/shared.png', false, ['同类型分类'])
    await gallery.addUrl('theme', 'https://example.com/theme.png', false, ['其它类型分类'])

    const globalList = vi
      .spyOn(storage, 'listResourceListSummaries')
      .mockRejectedValue(new Error('全库读取'))
    const fullSummaries = vi
      .spyOn(storage, 'listSummaries')
      .mockRejectedValue(new Error('全库摘要'))
    const fullResources = vi.spyOn(storage, 'list').mockRejectedValue(new Error('原件读取'))
    const globalKeys = vi.spyOn(db.resources, 'toCollection')
    const readIds = new Set<string>()
    const recordRead = (r: { id: string }) => {
      readIds.add(r.id)
      return r
    }
    db.resourceSummaries.hook('reading', recordRead)
    keyQueries.length = 0
    cursorTypes.length = 0
    const page = await gallery.list('card-1', { pageSize: 1, page: 2, sort: 'name' })
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.availableCategories).toEqual(['本页', '次页', '同类型分类'])
    expect([...readIds].some((id) => id.startsWith('unrelated-'))).toBe(false)
    expect(readIds.has(first.id)).toBe(true)
    expect(readIds.has(second.id)).toBe(true)
    expect(await db.resourceSummaries.count()).toBe(1_009)
    expect(readIds.size).toBeLessThan(10)
    expect(keyQueries).toContainEqual({
      values: false,
      index: 'type',
      type: RESOURCE_TYPE.CHARACTER_CARD,
    })
    expect(cursorTypes).toEqual([RESOURCE_TYPE.OTHER])
    expect(globalList).not.toHaveBeenCalled()
    expect(fullSummaries).not.toHaveBeenCalled()
    expect(fullResources).not.toHaveBeenCalled()
    expect(globalKeys).not.toHaveBeenCalled()
    db.resourceSummaries.hook('reading').unsubscribe(recordRead)

    await gallery.edit('card-2', (await gallery.list('card-2')).items[0]!.id, {
      name: '共享图片',
      description: '',
      tags: ['刚修改的分类'],
    })
    expect((await gallery.list('card-1')).availableCategories).toContain('刚修改的分类')
    await gallery.remove('card-1', [first.id])
    expect((await gallery.list('card-1', { pageSize: 1, page: 2 })).page).toBe(1)
    await moveResourceGallery(storage, 'card-1', 'card-2')
    expect((await gallery.list('card-1')).total).toBe(0)
    expect((await gallery.list('card-2')).items.map((r) => r.id)).toContain(second.id)
    await storage.updateMetadata('card-2', { type: RESOURCE_TYPE.BEAUTIFICATION })
    expect((await gallery.list('card-1')).availableCategories).not.toContain('刚修改的分类')
    expect((await gallery.list('theme')).availableCategories).toContain('刚修改的分类')
    await storage.delete('card-2')
    expect((await gallery.list('theme')).availableCategories).not.toContain('刚修改的分类')
    expect(globalList).not.toHaveBeenCalled()
  })

  it('keeps the existing summary fallback for adapters without the indexed gallery query', async () => {
    const { gallery, storage } = await fixture()
    const image = await gallery.addUrl('a', 'https://example.com/fallback.png', false, ['分类'])
    Object.defineProperty(storage, 'listGalleryListSummaries', { value: undefined })
    const fallback = vi.spyOn(storage, 'listResourceListSummaries')
    expect((await gallery.list('a')).items.map((r) => r.id)).toEqual([image.id])
    await moveResourceGallery(storage, 'a', 'b')
    expect((await gallery.list('b')).items.map((r) => r.id)).toEqual([image.id])
    expect(fallback).toHaveBeenCalled()
  })

  it('reads the maintained gallery summaries even when the separate library list index needs repair', async () => {
    const { db, gallery, storage } = await fixture()
    const image = await gallery.addUrl('a', 'https://example.com/repair.png', false)
    await db.resourceListSummaries.clear()
    expect((await gallery.list('a')).items.map((r) => r.id)).toEqual([image.id])
    expect(await db.resourceListSummaries.count()).toBe(0)
    expect((await storage.listResourceListSummaries()).map((r) => r.id)).toContain(image.id)
    expect(await db.resourceListSummaries.count()).toBe(3)
  })

  it('deleting a shared category retains images, unrelated categories, originals and covers', async () => {
    const { gallery, storage } = await fixture()
    const a = await gallery.addFile('a', file(), ['误填分类', '同人图'])
    const b = await gallery.addFile('b', file(), ['误填分类'])
    await gallery.setCover('a', a.id)
    await gallery.renameCategory('a', '误填分类', '')
    expect((await gallery.list('a')).availableCategories).not.toContain('误填分类')
    expect((await gallery.getImage('a', a.id)).tags).toEqual(['同人图'])
    expect((await gallery.getImage('b', b.id)).tags).toEqual([])
    expect((await gallery.list('b', { category: '__unclassified__' })).total).toBe(1)
    expect(await (await gallery.getImage('a', a.id)).originalBlob.text()).toBe('pixels')
    expect((await storage.get('a'))?.metadata.resourceCoverId).toBe(a.id)
  })
  it('shares categories within a resource type and isolates rename/delete across types', async () => {
    const { gallery, create } = await fixture()
    await create('card-1', RESOURCE_TYPE.CHARACTER_CARD)
    await create('card-2', RESOURCE_TYPE.CHARACTER_CARD)
    await create('theme', RESOURCE_TYPE.BEAUTIFICATION)
    const card = await gallery.addFile('card-1', file(), ['同人图', '共享名字'])
    const theme = await gallery.addFile('theme', file(), ['预览图', '共享名字'])
    expect((await gallery.list('card-2')).availableCategories).toEqual(['共享名字', '同人图'])
    expect((await gallery.list('theme')).availableCategories).not.toContain('同人图')
    expect((await gallery.list('a')).availableCategories).toEqual([])
    await gallery.renameCategory('card-2', '共享名字', '聊天截图')
    expect((await gallery.getImage('card-1', card.id)).tags).toEqual(['同人图', '聊天截图'])
    expect((await gallery.getImage('theme', theme.id)).tags).toEqual(['预览图', '共享名字'])
    await gallery.renameCategory('card-2', '同人图', '')
    expect((await gallery.list('card-1')).availableCategories).toEqual(['聊天截图'])
    expect((await gallery.list('theme')).availableCategories).toContain('预览图')
    await expect(gallery.renameCategory('missing', '预览图', '')).rejects.toThrow('不存在')
  })
  it('classifying reimported images appends choices without clearing existing categories', async () => {
    const { gallery } = await fixture()
    const image = await gallery.addFile('a', file(), ['已有分类'])
    const duplicate = await gallery.addFile('a', file())
    await gallery.setCategories('a', [duplicate.id, duplicate.id], ['新建分类'], true)
    expect((await gallery.getImage('a', image.id)).tags).toEqual(['已有分类', '新建分类'])
    await gallery.setCategories('a', [image.id], [], true)
    expect((await gallery.getImage('a', image.id)).tags).toHaveLength(2)
  })
  it('persists empty categories per type and includes them only in selected gallery backup/restore scope', async () => {
    const { gallery, storage, create } = await fixture()
    await create('card', RESOURCE_TYPE.CHARACTER_CARD)
    await gallery.createCategory('a', '  空分类  ')
    await gallery.createCategory('a', '空分类')
    expect((await gallery.list('b')).availableCategories).toEqual(['空分类'])
    expect((await gallery.list('card')).availableCategories).toEqual([])
    const reopened = new ResourceGalleryService(
      storage,
      new IndexedDbResourceGalleryCategoryStorage(databases.at(-1)!),
    )
    expect((await reopened.list('a')).availableCategories).toEqual(['空分类'])
    const portableData = {
      version: 1 as const,
      resourceGalleryCategories: await gallery.exportCategories(),
    }
    const backup = await new ExportService().createArchive(await storage.list(), [], {
      mode: 'full',
      portableData,
      portableSelection: { resourceGallery: true },
    })
    const target = await fixture()
    const prepared = await target.restore.prepare(
      new File([backup.blob], backup.fileName),
      [],
      [],
      true,
    )
    expect(
      selectPreparedRestore(prepared, new Set(['a']), false).portableData
        ?.resourceGalleryCategories,
    ).toBeUndefined()
    await target.gallery.importCategories(prepared.portableData?.resourceGalleryCategories)
    expect((await target.gallery.list('b')).availableCategories).toContain('空分类')
    const excluded = await new ExportService().createArchive(await storage.list(), [], {
      mode: 'full',
      portableData,
      portableSelection: { resourceGallery: false },
    })
    expect(excluded.manifest.portableData?.resourceGalleryCategories).toBeUndefined()
    await gallery.renameCategory('b', '空分类', '新名字')
    expect((await gallery.list('a')).availableCategories).toEqual(['新名字'])
    await gallery.renameCategory('a', '新名字', '')
    expect((await gallery.list('b')).availableCategories).toEqual([])
    await expect(gallery.createCategory('a', '  ')).rejects.toThrow()
  })
  it('keeps original bytes by default; thumbnail imports never replace the original and survive ZIP restore', async () => {
    const { gallery, storage } = await fixture()
    const original = await gallery.addFile('a', file())
    const small = await gallery.addFile('a', file(), ['同人图'], true, 'thumbnail')
    expect(small.id).not.toBe(original.id)
    expect(await (await storage.get(original.id))!.originalBlob.text()).toBe('pixels')
    expect(small.metadata.galleryQuality).toBe('thumbnail')
    expect(small.fileName).toBe('同人图-缩略图.webp')
    expect(small.mimeType).toBe('image/webp')
    expect(small.fileSize).toBe(small.originalBlob.size)
    expect(small.contentHash).toBe(await hashBlob(small.originalBlob))
    expect(await small.originalBlob.text()).toBe('thumbnail')
    expect((await gallery.addFile('a', file(), [], true, 'thumbnail')).id).toBe(small.id)
    expect((await gallery.list('a')).total).toBe(2)
    const backup = await new ExportService().createArchive(await storage.list(), [], {
      mode: 'partial',
      resourceIds: ['a'],
      portableSelection: { resourceGallery: true },
    })
    const target = await fixture()
    const prepared = await target.restore.prepare(
      new File([backup.blob], backup.fileName),
      [],
      [],
      true,
    )
    await target.restore.restore(prepared)
    const restored = await target.storage.get(small.id)
    expect(restored?.metadata.galleryQuality).toBe('thumbnail')
    expect(await restored?.originalBlob.text()).toBe('thumbnail')
    expect(await (await target.storage.get(original.id))?.originalBlob.text()).toBe('pixels')
  })
  it('uses the actual thumbnail encoder format and does not save when decoding fails', async () => {
    const { gallery } = await fixture()
    vi.mocked(createImageThumbnail).mockResolvedValueOnce(
      new Blob(['png-thumb'], { type: 'image/png' }),
    )
    const small = await gallery.addFile(
      'a',
      new File(['gif'], '动图.gif', { type: 'image/gif' }),
      [],
      true,
      'thumbnail',
    )
    expect(small.fileName).toBe('动图-缩略图.png')
    expect(small.mimeType).toBe('image/png')
    vi.mocked(createImageThumbnail).mockResolvedValueOnce(undefined)
    await expect(gallery.addFile('a', file(), [], true, 'thumbnail')).rejects.toThrow('无法读取')
    expect((await gallery.list('a')).total).toBe(1)
  })
  it('applies thumbnail quality to downloaded copies and leaves link-only imports as links', async () => {
    const { gallery } = await fixture()
    const fetchMock = vi.fn(
      async () => new Response(new Blob(['downloaded-original'], { type: 'image/png' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const small = await gallery.addUrl(
        'a',
        'https://example.com/art.png',
        true,
        [],
        false,
        'thumbnail',
      )
      expect(await small.originalBlob.text()).toBe('thumbnail')
      expect(small.metadata.galleryVisible).toBe(false)
      const original = await gallery.addUrl('a', 'https://example.com/art.png', true)
      expect(await original.originalBlob.text()).toBe('downloaded-original')
      const link = await gallery.addUrl(
        'a',
        'https://example.com/link.png',
        false,
        [],
        true,
        'thumbnail',
      )
      expect(link.metadata.galleryStorage).toBe('url')
      expect(link.metadata.galleryQuality).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('removes images whose imports finish between the owner deletion scan and commit', async () => {
    const { gallery, storage } = await fixture()
    const remove = storage.deleteMany.bind(storage)
    vi.spyOn(storage, 'deleteMany').mockImplementationOnce(async (ids, progress) => {
      await gallery.addFile('a', file())
      await remove(ids, progress)
    })
    const remaining = await deleteMany(storage, ['a'])
    expect(remaining?.some((resource) => galleryOwnerId(resource) === 'a')).toBe(false)
    expect(remaining?.some((resource) => resource.id === 'a')).toBe(false)
    expect(await storage.get('a')).toBeUndefined()
    expect((await gallery.list('a')).galleryCount).toBe(0)
  })
  it('serializes concurrent imports, recovers after quota failure, and does not orphan a deleted owner', async () => {
    const { gallery, storage } = await fixture()
    const images = await Promise.all(
      Array.from({ length: 8 }, (_, i) => gallery.addFile('a', file(), [`分类${i}`])),
    )
    expect(new Set(images.map((image) => image.id)).size).toBe(1)
    expect((await gallery.list('a')).items[0]?.tags).toHaveLength(8)
    const realInsert = storage.insertIfAbsent.bind(storage)
    vi.spyOn(storage, 'insertIfAbsent').mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(gallery.addUrl('a', 'https://example.com/fail.png', false)).rejects.toThrow(
      'quota',
    )
    await expect(
      gallery.addUrl('a', 'https://example.com/recovered.png', false),
    ).resolves.toBeDefined()
    vi.mocked(storage.insertIfAbsent).mockImplementationOnce(async (image) => {
      await storage.delete('b')
      return realInsert(image)
    })
    await expect(gallery.addFile('b', file())).rejects.toThrow('不存在')
    expect((await gallery.list('b')).total).toBe(0)
  })
  it('preserves vault encryption, locking, categories and image bytes after unlocking', async () => {
    const { db } = await fixture()
    const vault = new VaultService(db)
    await vault.initialize()
    await vault.enable('gallery-test-password')
    const encryptedStorage = new IndexedDbResourceStorage(db, vault)
    const gallery = new ResourceGalleryService(encryptedStorage)
    const image = await gallery.addFile('a', file(), ['私人截图'])
    await gallery.setCover('a', image.id)
    vi.mocked(createImageThumbnail).mockClear()
    expect((await gallery.addFile('a', file(), ['私人截图'])).id).toBe(image.id)
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect(await db.resources.get(image.id)).toHaveProperty('encrypted', true)
    expect(JSON.stringify(await db.resourceSummaries.get(image.id))).not.toContain('私人截图')
    vault.lock()
    await expect(gallery.list('a')).rejects.toThrow()
    await expect(gallery.addFile('a', file())).rejects.toThrow()
    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    await vault.unlock('gallery-test-password')
    const encryptedFallback = vi.spyOn(encryptedStorage, 'listResourceListSummaries')
    expect((await gallery.list('a')).items[0]?.tags).toEqual(['私人截图'])
    expect(encryptedFallback).toHaveBeenCalled()
    const storedSummary = await db.resourceSummaries.get(image.id)
    expect(storedSummary).not.toHaveProperty('type')
    expect(storedSummary).not.toHaveProperty('metadata')
    expect(await (await gallery.getImage('a', image.id)).originalBlob.text()).toBe('pixels')
  })
  it('restores new gallery images onto an existing owner and is idempotent on repeated restores', async () => {
    const source = await fixture()
    await source.gallery.addFile('a', file(), ['同人'])
    const backup = await new ExportService().createArchive(await source.storage.list(), [], {
      mode: 'partial',
      resourceIds: ['a'],
      portableSelection: { resourceGallery: true },
    })
    const target = await fixture()
    const prepared = await target.restore.prepare(
      new File([backup.blob], backup.fileName),
      await target.storage.listSummaries(),
      [],
      true,
    )
    expect(prepared.galleryOwners?.map((r) => r.id)).toEqual(['a'])
    expect(prepared.resources.every((r) => Boolean(galleryOwnerId(r)))).toBe(true)
    await target.restore.restore(selectPreparedRestore(prepared, new Set(['a']), true))
    expect((await target.gallery.list('a')).total).toBe(1)
    const repeated = await target.restore.prepare(
      new File([backup.blob], backup.fileName),
      await target.storage.listSummaries(),
      [],
      true,
    )
    expect(repeated.resources).toHaveLength(0)
    await repeated.dispose?.()
  })
  it('does not allow image attachments to block normal imports and cleans replaced cover-only images', async () => {
    const { gallery, storage } = await fixture()
    const first = await gallery.addFile('a', file(), [], false)
    expect(await storage.findByHash(first.contentHash)).toBeUndefined()
    await gallery.setCover('a', first.id)
    const second = await gallery.addUrl('a', 'https://example.com/cover.png', false, [], false)
    await gallery.setCover('a', second.id)
    expect(await storage.get(first.id)).toBeUndefined()
    await gallery.restoreDefaultCover('a')
    expect(await storage.get(second.id)).toBeUndefined()
    expect((await gallery.list('a')).total).toBe(0)
    expect(() => normalizeGalleryUrl(`https://example.com/${'图'.repeat(400)}`)).toThrow('过长')
  })
  it('registers local opt-in defaults and cloud privacy defaults through both adapters', async () => {
    const { storage } = await fixture()
    const all = await storage.listSummaries()
    expect(
      toArchivePortableSelection(createDefaultBackupSelection(all, 'local')).resourceGallery,
    ).toBe(true)
    expect(
      toCloudContentSelection(createDefaultBackupSelection(all, 'cloud')).resourceGallery,
    ).toBe(false)
    expect(
      normalizeContentSelection({ resourceGallery: true }).personalResources?.resourceGallery,
    ).toBe(true)
  })
  it('paginates larger galleries without reading the owning original during image import', async () => {
    const { gallery, storage } = await fixture()
    const get = vi.spyOn(storage, 'get')
    for (let index = 0; index < 65; index++)
      await gallery.addUrl('a', `https://example.com/${index}.png`, false, ['批量'])
    expect(get.mock.calls.some(([id]) => id === 'a')).toBe(false)
    const second = await gallery.list('a', { pageSize: 60, page: 2 })
    expect(second.total).toBe(65)
    expect(second.items).toHaveLength(5)
    await gallery.remove(
      'a',
      second.items.map((r) => r.id),
    )
    expect((await gallery.list('a', { pageSize: 60, page: 2 })).page).toBe(1)
  })
  it('validates serial original imports while preserving other owners and new bytes', async () => {
    const { gallery } = await fixture()
    const image = await gallery.addFile('a', file())
    vi.mocked(createImageThumbnail).mockClear()
    const duplicate = await gallery.addFile('a', file(), ['new tag'])
    expect(duplicate.id).toBe(image.id)
    expect(duplicate.tags).toContain('new tag')
    expect(await duplicate.originalBlob.text()).toBe('pixels')
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    await gallery.addFile('b', file())
    await gallery.addFile('a', new File(['different pixels'], 'other.png', { type: 'image/png' }))
    expect(createImageThumbnail).toHaveBeenCalledTimes(3)
  })

  it('does one authoritative lookup per serial original import without a preflight query', async () => {
    const { gallery, storage } = await fixture()
    const lookup = vi.spyOn(storage, 'findGalleryImage')
    const first = await gallery.addFile('a', file())
    expect(lookup).toHaveBeenCalledTimes(1)
    const second = await gallery.addFile('a', file(), ['again'])
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(second.id).toBe(first.id)
    expect(second.tags).toContain('again')
  })

  it('validates concurrent duplicate originals and merges them through the existing commit queue', async () => {
    const { gallery } = await fixture()
    vi.mocked(createImageThumbnail).mockClear()
    const images = await Promise.all(
      Array.from({ length: 4 }, (_, i) => gallery.addFile('a', file(), ['tag-' + i])),
    )
    expect(createImageThumbnail).toHaveBeenCalledTimes(4)
    expect(new Set(images.map((image) => image.id)).size).toBe(1)
    expect((await gallery.getImage('a', images[0]!.id)).tags).toHaveLength(4)
  })

  it('prepares different new originals concurrently before their serialized commits', async () => {
    const { gallery } = await fixture()
    let started!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const finish: ((blob: Blob) => void)[] = []
    vi.mocked(createImageThumbnail)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish.push(resolve)
            if (finish.length === 2) started()
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish.push(resolve)
            if (finish.length === 2) started()
          }),
      )
    const pending = Promise.all([
      gallery.addFile('a', file()),
      gallery.addFile('a', new File(['other'], 'other.png', { type: 'image/png' })),
    ])
    await bothStarted
    for (const complete of finish) complete(new Blob(['thumbnail'], { type: 'image/webp' }))
    expect(new Set((await pending).map((image) => image.id)).size).toBe(2)
  })

  it('rejects invalid concurrent inputs and permits a later explicit import', async () => {
    const { gallery } = await fixture()
    vi.mocked(createImageThumbnail).mockClear().mockResolvedValue(undefined)
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => gallery.addFile('a', file())),
    )
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(createImageThumbnail).toHaveBeenCalledTimes(4)
    vi.mocked(createImageThumbnail).mockResolvedValue(
      new Blob(['thumbnail'], { type: 'image/webp' }),
    )
    await gallery.addFile('a', file())
    expect(createImageThumbnail).toHaveBeenCalledTimes(5)
  })

  it('does not retain a completed preparation after the saved item is removed', async () => {
    const { gallery, storage } = await fixture()
    const image = await gallery.addFile('a', file())
    await storage.delete(image.id)
    vi.mocked(createImageThumbnail).mockClear()
    await gallery.addFile('a', file())
    expect(createImageThumbnail).toHaveBeenCalledOnce()
  })

  it('validates the incoming original if the known stored copy disappears before commit', async () => {
    const { gallery, storage } = await fixture()
    const image = await gallery.addFile('a', file())
    vi.mocked(createImageThumbnail)
      .mockClear()
      .mockImplementationOnce(async () => {
        await storage.delete(image.id)
        return new Blob(['thumbnail'], { type: 'image/webp' })
      })
    const saved = await gallery.addFile('a', file())
    expect(saved.id).toBe(image.id)
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect(await saved.originalBlob.text()).toBe('pixels')
  })

  it('repairs a missing saved thumbnail once instead of decoding both the new input and saved original', async () => {
    const { gallery, storage } = await fixture()
    const image = await gallery.addFile('a', file())
    await storage.updateMetadata(image.id, {
      thumbnailBlob: undefined,
      thumbnailAssetId: undefined,
    })
    vi.mocked(createImageThumbnail).mockClear()
    const duplicate = await gallery.addFile('a', file())
    expect(duplicate.id).toBe(image.id)
    expect(duplicate.thumbnailBlob).toBeInstanceOf(Blob)
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect(await duplicate.originalBlob.text()).toBe('pixels')
  })

  it('still validates bytes that match a link document instead of treating that document as a local image', async () => {
    const { gallery } = await fixture()
    const url = 'https://example.com/image.png'
    const link = await gallery.addUrl('a', url, false)
    vi.mocked(createImageThumbnail).mockClear().mockResolvedValueOnce(undefined)
    const invalid = new File([JSON.stringify({ version: 1, imageUrl: url })], 'invalid.png', {
      type: 'image/png',
    })
    await expect(gallery.addFile('a', invalid, ['must not add'])).rejects.toThrow('无法读取图片')
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect((await gallery.getImage('a', link.id)).tags).not.toContain('must not add')
  })

  it('keeps transformed thumbnail identity and validates each requested conversion', async () => {
    const { gallery } = await fixture()
    vi.mocked(createImageThumbnail).mockClear()
    const first = await gallery.addFile('a', file(), [], true, 'thumbnail')
    const second = await gallery.addFile('a', file(), [], true, 'thumbnail')
    expect(first.id).toBe(second.id)
    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    expect(await second.originalBlob.text()).toBe('thumbnail')
  })

  it('validates a legacy local item with non-image metadata instead of trusting its bytes as an image', async () => {
    const { gallery, db } = await fixture()
    const image = await gallery.addFile('a', file())
    await db.resources.update(image.id, (record) => {
      if ('mimeType' in record) record.mimeType = 'application/json'
    })
    vi.mocked(createImageThumbnail).mockClear().mockResolvedValueOnce(undefined)
    await expect(gallery.addFile('a', file(), ['must not add'])).rejects.toThrow('无法读取图片')
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect((await gallery.getImage('a', image.id)).tags).not.toContain('must not add')
  })

  it('recovers the same owner queue after a new original fails decoding', async () => {
    const { gallery } = await fixture()
    vi.mocked(createImageThumbnail).mockClear().mockResolvedValueOnce(undefined)
    await expect(gallery.addFile('a', file())).rejects.toThrow('无法读取图片')
    expect((await gallery.list('a')).total).toBe(0)
    const saved = await gallery.addFile('a', file())
    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    expect(await saved.originalBlob.text()).toBe('pixels')
  })

  it('does not leave an orphan if the owner disappears while a new original is decoded', async () => {
    const { gallery, storage } = await fixture()
    vi.mocked(createImageThumbnail).mockImplementationOnce(async () => {
      await storage.delete('a')
      return new Blob(['thumbnail'], { type: 'image/webp' })
    })
    await expect(gallery.addFile('a', file())).rejects.toThrow('不存在')
    expect((await storage.listSummaries()).some((row) => galleryOwnerId(row) === 'a')).toBe(false)
  })

  it('releases pending preparation when the vault locks before commit', async () => {
    const { db } = await fixture()
    const vault = new VaultService(db)
    await vault.initialize()
    await vault.enable('gallery-test-password')
    const storage = new IndexedDbResourceStorage(db, vault)
    const gallery = new ResourceGalleryService(storage)
    let started!: () => void
    const decoding = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: (blob: Blob) => void
    vi.mocked(createImageThumbnail).mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = gallery.addFile('a', file())
    const rejected = expect(pending).rejects.toThrow()
    await decoding
    vault.lock()
    finish(new Blob(['thumbnail'], { type: 'image/webp' }))
    await rejected
    await vault.unlock('gallery-test-password')
    expect((await gallery.list('a')).total).toBe(0)
    vi.mocked(createImageThumbnail).mockClear()
    const saved = await gallery.addFile('a', file())
    expect(createImageThumbnail).toHaveBeenCalledOnce()
    expect(await saved.originalBlob.text()).toBe('pixels')
  })

  it.each(['original', 'thumbnail', 'url'] as const)(
    'preserves migrated images when the old owner is restored and imports the same %s again',
    async (quality) => {
      const { gallery, storage, create } = await fixture()
      const add = (tags: string[]) =>
        quality === 'url'
          ? gallery.addUrl('a', 'https://example.com/migrated.png', false, tags)
          : gallery.addFile('a', file(), tags, true, quality)
      const first = await add(['migrated'])
      await moveResourceGallery(storage, 'a', 'b')
      await storage.delete('a')
      await create('a')
      const restored = await add(['restored'])
      expect(restored.id).not.toBe(first.id)
      expect((await gallery.getImage('b', first.id)).tags).toEqual(['migrated'])
      expect((await gallery.list('a')).galleryCount).toBe(1)
      expect((await gallery.list('b')).galleryCount).toBe(1)
    },
  )

  it('walks occupied deterministic slots without taking images back from other owners', async () => {
    const { gallery, storage, create } = await fixture()
    await create('c')
    const first = await gallery.addFile('a', file(), ['first'])
    await moveResourceGallery(storage, 'a', 'b')
    const second = await gallery.addFile('a', file(), ['second'])
    await moveResourceGallery(storage, 'a', 'c')
    const insert = vi.spyOn(storage, 'insertIfAbsent')
    const third = await gallery.addFile('a', file(), ['third'])
    expect(insert).toHaveBeenCalledTimes(2)
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect((await gallery.getImage('b', first.id)).tags).toEqual(['first'])
    expect((await gallery.getImage('c', second.id)).tags).toEqual(['second'])
    expect((await gallery.getImage('a', third.id)).tags).toEqual(['third'])
  })

  it('preserves encrypted migrated images and their original bytes on reimport', async () => {
    const { db } = await fixture(),
      vault = new VaultService(db)
    await vault.initialize()
    await vault.enable('gallery-test-password')
    const storage = new IndexedDbResourceStorage(db, vault),
      gallery = new ResourceGalleryService(storage)
    const first = await gallery.addFile('a', file(), ['private'])
    await moveResourceGallery(storage, 'a', 'b')
    const second = await gallery.addFile('a', file(), ['new'])
    expect(second.id).not.toBe(first.id)
    expect((await gallery.getImage('b', first.id)).tags).toEqual(['private'])
    expect(await (await gallery.getImage('b', first.id)).originalBlob.text()).toBe('pixels')
    expect(await db.resources.get(second.id)).toHaveProperty('encrypted', true)
  })

  it('keeps migrated cover references and supports adapters without atomic insert', async () => {
    const { gallery, storage } = await fixture()
    const first = await gallery.addFile('a', file(), ['migrated'])
    await moveResourceGallery(storage, 'a', 'b')
    await gallery.setCover('b', first.id)
    Object.defineProperty(storage, 'insertIfAbsent', { value: undefined })
    const second = await gallery.addFile('a', file(), ['new'])
    expect(second.id).not.toBe(first.id)
    expect((await storage.getSummary('b'))?.metadata.resourceCoverId).toBe(first.id)
    expect((await gallery.getImage('b', first.id)).tags).toEqual(['migrated'])
  })

  it('shares the alternate slot across service instances without overwriting the migrated image', async () => {
    const { gallery, storage } = await fixture()
    const first = await gallery.addFile('a', file(), ['migrated'])
    await moveResourceGallery(storage, 'a', 'b')
    let arrived = 0,
      release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const insert = storage.insertIfAbsent.bind(storage)
    vi.spyOn(storage, 'insertIfAbsent').mockImplementation(async (image) => {
      if (image.id !== first.id) {
        if (++arrived === 2) release()
        await ready
      }
      return insert(image)
    })
    const other = new ResourceGalleryService(storage)
    const images = await Promise.all([
      gallery.addFile('a', file(), ['one'], false),
      other.addFile('a', file(), ['two']),
    ])
    expect(images[0]!.id).toBe(images[1]!.id)
    const saved = await gallery.getImage('a', images[0]!.id)
    expect([...saved.tags].sort()).toEqual(['one', 'two'])
    expect(saved.metadata.galleryVisible).toBe(true)
    expect((await gallery.getImage('b', first.id)).tags).toEqual(['migrated'])
  })

  it('rejects a slot occupied by another writer immediately before the atomic insert', async () => {
    const { gallery, storage } = await fixture()
    let occupied: Resource | undefined
    const insert = storage.insertIfAbsent.bind(storage)
    vi.spyOn(storage, 'insertIfAbsent').mockImplementationOnce(async (image) => {
      occupied = {
        ...image,
        tags: ['other writer'],
        metadata: { ...image.metadata, galleryOwnerId: 'b' },
      }
      await storage.save(occupied)
      return insert(image)
    })
    const saved = await gallery.addFile('a', file(), ['current'])
    expect(saved.id).not.toBe(occupied!.id)
    expect((await gallery.getImage('b', occupied!.id)).tags).toEqual(['other writer'])
    expect(saved.tags).toEqual(['current'])
  })

  it('deduplicates within one gallery while preserving same pixels attached to different owners', async () => {
    const { gallery } = await fixture()
    const a = await gallery.addFile('a', file(), ['同人'])
    expect((await gallery.addFile('a', file(), ['截图'])).id).toBe(a.id)
    expect((await gallery.addFile('b', file())).id).not.toBe(a.id)
    expect((await gallery.list('a')).items[0]!.tags).toEqual(['同人', '截图'])
    await expect(gallery.setCover('b', a.id)).rejects.toThrow('不属于')
  })
  it('keeps original bytes/version/default thumbnail untouched and retains a removed cover', async () => {
    const { gallery, storage } = await fixture()
    const before = (await storage.get('a'))!
    const image = await gallery.addFile('a', file())
    await gallery.setCover('a', image.id)
    await gallery.remove('a', [image.id])
    expect((await gallery.list('a')).total).toBe(0)
    expect(await gallery.getImage('a', image.id)).toBeDefined()
    expect((await storage.get('a'))?.contentHash).toBe(before.contentHash)
    expect(await storage.listVersions('a')).toHaveLength(0)
    await gallery.restoreDefaultCover('a')
    expect((await storage.get('a'))?.metadata.resourceCoverId).toBeUndefined()
    expect(await storage.get(image.id)).toBeUndefined()
    expect(await (await storage.get('a'))?.originalBlob.text()).toBe('a')
  })
  it('filters by multiple categories/search/source and clamps pagination after removal', async () => {
    const { gallery } = await fixture()
    const image = await gallery.addFile('a', file(), ['同人', '截图'])
    await gallery.addUrl('a', 'https://example.com/preview.webp', false, ['预览'])
    await gallery.edit('a', image.id, {
      name: '夜景',
      description: '第十回',
      tags: ['同人', '截图'],
    })
    expect(
      (await gallery.list('a', { search: '第十回', category: '截图', source: 'local' })).total,
    ).toBe(1)
    expect((await gallery.list('a', { source: 'url' })).total).toBe(1)
    await gallery.renameCategory('a', '截图', '聊天')
    expect((await gallery.list('a', { category: '聊天', page: 99 })).page).toBe(1)
    await gallery.renameCategory('a', '聊天', '')
    expect((await gallery.list('a')).total).toBe(2)
  })
  it('does not persist failed downloads or accept executable/credential URLs', async () => {
    const { gallery } = await fixture()
    for (const url of [
      'javascript:alert(1)',
      'data:image/png,x',
      'http://example.com/a.png',
      'https://user:pass@example.com/a',
    ])
      expect(() => normalizeGalleryUrl(url)).toThrow()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 403 })),
    )
    try {
      await expect(gallery.addUrl('a', 'https://example.com/a.png', true)).rejects.toThrow(
        '尚未保存',
      )
      expect((await gallery.list('a')).total).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it.each([true, false])(
    'ZIP round trip scopes gallery=%s but always restores cover and remaps ID conflicts',
    async (includeGallery) => {
      const { gallery, storage } = await fixture()
      const cover = await gallery.addFile('a', file())
      await gallery.setCover('a', cover.id)
      await gallery.addUrl('a', 'https://example.com/chat.png', false, ['截图'])
      await gallery.addUrl('b', 'https://example.com/private.png', false)
      const backup = await new ExportService().createArchive(await storage.list(), [], {
        mode: 'partial',
        resourceIds: ['a'],
        portableSelection: { resourceGallery: includeGallery },
      })
      expect(backup.manifest.resources).toHaveLength(includeGallery ? 3 : 2)
      const target = await fixture()
      await target.storage.update('a', { contentHash: 'f'.repeat(64) })
      const prepared = await target.restore.prepare(
        new File([backup.blob], backup.fileName),
        await target.storage.listSummaries(),
        [],
        true,
      )
      const restoredOwner = prepared.resources.find((r) => !galleryOwnerId(r))!
      expect(restoredOwner.id).not.toBe('a')
      const selected = selectPreparedRestore(prepared, new Set([restoredOwner.id]), includeGallery)
      await target.restore.restore(selected)
      const image = await target.gallery.getImage(
        restoredOwner.id,
        String(restoredOwner.metadata.resourceCoverId),
      )
      expect(await image.originalBlob.text()).toBe('pixels')
      expect(galleryOwnerId(image)).toBe(restoredOwner.id)
      expect((await target.gallery.list(restoredOwner.id)).total).toBe(includeGallery ? 2 : 1)
    },
  )
  it('cloud selection and snapshot include only selected gallery data and cover dependency', async () => {
    const { gallery, storage } = await fixture()
    const cover = await gallery.addFile('a', file())
    await gallery.setCover('a', cover.id)
    const screenshot = await gallery.addUrl('a', 'https://example.com/private.png', false)
    const all = await storage.listSummaries()
    const selection = normalizeContentSelection({ resourceIds: ['a'], resourceGallery: false })
    expect(
      selectCloudResources(all, selection.personalResources)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', cover.id].sort())
    await gallery.createCategory('a', '云端空分类')
    const snapshot = await createStructuredSnapshot(await storage.list(), [], [], {
      version: 1,
      resourceGalleryCategories: await gallery.exportCategories(),
    })
    expect(
      selectStructuredSnapshot(snapshot.snapshot, new Set(['a']), true).portableData
        .resourceGalleryCategories?.other,
    ).toContain('云端空分类')
    const filtered = selectStructuredSnapshot(snapshot.snapshot, new Set(['a']), false)
    expect(filtered.portableData.resourceGalleryCategories).toBeUndefined()
    expect(filtered.resources.map((r) => r.id)).toContain(cover.id)
    expect(filtered.resources.map((r) => r.id)).not.toContain(screenshot.id)
    expect(snapshot.snapshot.resources.find((r) => r.id === cover.id)?.object.totalSha256).toBe(
      cover.contentHash,
    )
  })
  it('version activation preserves cover and gallery; merging moves the source gallery', async () => {
    const { gallery, storage } = await fixture()
    const cover = await gallery.addFile('a', file())
    await gallery.setCover('a', cover.id)
    const version = { ...(await storage.get('b'))!, id: 'historical', versionGroupId: 'a' }
    await storage.saveVersion(version)
    await activateVersion(storage, 'a', 'historical')
    expect((await storage.get('a'))?.metadata.resourceCoverId).toBe(cover.id)
    const other = await gallery.addUrl('b', 'https://example.com/other.png', false)
    await mergeExistingResourceAsVersion(
      storage,
      async (id) => {
        await deleteMany(storage, [id])
      },
      'a',
      'b',
    )
    expect(galleryOwnerId((await storage.get(other.id))!)).toBe('a')
    expect((await gallery.list('a')).total).toBe(2)
    await deleteMany(storage, ['a'])
    expect(await storage.get(other.id)).toBeUndefined()
    expect(await storage.get(cover.id)).toBeUndefined()
  })
  it('cannot export an attachment by selecting its ID without selecting its owner', async () => {
    const { gallery, storage } = await fixture()
    const image = await gallery.addFile('a', file())
    const ids = new Set([image.id])
    includeResourceGalleryIds(await storage.listSummaries(), ids, true)
    expect(ids.size).toBe(0)
  })
})
