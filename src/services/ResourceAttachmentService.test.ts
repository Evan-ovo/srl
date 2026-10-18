import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbCategoryStorage } from '../storage/IndexedDbCategoryStorage'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { type Resource, RESOURCE_TYPE, toResourceListSummary } from '../types/Resource'
import { isResourceAttachment, resourceOwnedFileOwnerId } from '../types/ResourceAttachment'
import { ResourceAttachmentService } from './ResourceAttachmentService'
import { ResourceService } from './ResourceService'
import { CategoryService } from './CategoryService'
import { ExportService, createResourceArchiveSource } from './ExportService'
import { RestoreService } from './RestoreService'
import { RecycleBinService } from './RecycleBinService'
import { VaultService } from './VaultService'
import { UserPersonaService } from './UserPersonaService'
import { hashBlob } from './HashService'
import { selectCloudResources } from './PersonalResourceBackup'
import { normalizeContentSelection } from './CloudBackupPolicy'
import { createStructuredSnapshot, materializeStructuredResources } from './CloudStructuredSnapshot'
import { selectPreparedRestore, selectStructuredSnapshot } from './BackupRestoreSelection'
import {
  createDefaultBackupSelection,
  resourceRestoreScopeIds,
  toArchivePortableSelection,
} from './BackupScopeRegistry'
import { moveResourceGallery } from './ResourceGalleryService'

const databases: AppDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) await db.delete()
})
async function fixture(encrypted = false) {
  const db = new AppDatabase(`attachments-${crypto.randomUUID()}`)
  databases.push(db)
  const vault = new VaultService(db)
  await vault.initialize()
  if (encrypted) await vault.enable('attachment-fixture-password')
  const storage = new IndexedDbResourceStorage(db, vault)
  const service = new ResourceService(
    storage,
    new ResourceParserRegistry([new JsonResourceParser()]),
  )
  const categories = new CategoryService(new IndexedDbCategoryStorage(db, vault))
  const restore = new RestoreService(new IndexedDbArchiveStorage(db, vault))
  const exporter = new ExportService()
  const recycle = new RecycleBinService(
    db,
    service,
    categories,
    exporter,
    restore,
    vault,
    new UserPersonaService(service),
  )
  const attachments = new ResourceAttachmentService(storage)
  const originalBlob = new Blob(['{"spec":"chara_card_v2","data":{"name":"角色"}}'], {
    type: 'application/json',
  })
  const owner: Resource = {
    id: 'card',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: '角色',
    description: '',
    fileName: '角色.json',
    mimeType: originalBlob.type,
    originalBlob,
    fileSize: originalBlob.size,
    contentHash: await hashBlob(originalBlob),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  await storage.save(owner)
  return { db, storage, service, attachments, owner, exporter, restore, recycle, vault }
}
describe('resource attachment lifecycle', () => {
  it.each([false, true])(
    'persists arbitrary bytes and edited history after reopen, vault=%s',
    async (encrypted) => {
      const f = await fixture(encrypted)
      const file = new File([new Uint8Array([0, 255, 128, 30])], '作者附件.unknown')
      const attachment = await f.attachments.add('card', file)
      expect(
        await (await f.attachments.get('card', attachment.id)).originalBlob.arrayBuffer(),
      ).toEqual(await file.arrayBuffer())
      await expect(f.attachments.get('other', attachment.id)).rejects.toThrow()
      await f.attachments.replace(
        'card',
        attachment.id,
        new File(['修改内容'], '正文.txt'),
        attachment.contentHash,
      )
      await expect(
        f.attachments.replace(
          'card',
          attachment.id,
          new File(['覆盖'], '正文.txt'),
          attachment.contentHash,
        ),
      ).rejects.toThrow('已被修改')
      await f.attachments.rename('card', attachment.id, '说明.txt')
      f.db.close()
      await f.db.open()
      expect((await f.attachments.list('card'))[0]?.fileName).toBe('说明.txt')
      const edited = await f.attachments.get('card', attachment.id)
      expect(await edited.originalBlob.text()).toBe('修改内容')
      expect((await f.storage.listVersions(attachment.id))[0]?.contentHash).toBe(
        attachment.contentHash,
      )
      expect(await (await f.storage.get('card'))!.originalBlob.text()).toBe(
        await f.owner.originalBlob.text(),
      )
    },
  )

  it('lists only OTHER summaries without reading bodies in a 10000-resource library', async () => {
    const f = await fixture()
    const stored = await f.db.resources.get(f.owner.id)
    if (!stored) throw new Error('stored fixture missing')
    const fillers = Array.from({ length: 9999 }, (_, i) => ({ ...f.owner, id: `card-${i}` }))
    const summaries = fillers.map(toResourceListSummary)
    // This regression measures scoped list reads, not 9999 repetitions of binary preparation.
    await f.db.transaction(
      'rw',
      [f.db.resources, f.db.resourceSummaries, f.db.resourceListSummaries],
      async () => {
        await f.db.resources.bulkPut(fillers.map(({ id }) => ({ ...stored, id })))
        await f.db.resourceSummaries.bulkPut(summaries)
        await f.db.resourceListSummaries.bulkPut(summaries)
      },
    )
    expect(await f.db.resources.count()).toBe(10000)
    expect(await f.db.resourceSummaries.count()).toBe(10000)
    expect(await f.db.resourceListSummaries.count()).toBe(10000)
    const a = await f.attachments.add('card', new File(['说明'], '说明.txt'))
    const get = vi.spyOn(f.storage, 'get').mockRejectedValue(new Error('不应读取原件'))
    const global = vi.spyOn(f.storage, 'listSummaries').mockRejectedValue(new Error('不应全库扫描'))
    const rows = await f.attachments.list('card')
    expect(rows.map((r) => r.id)).toEqual([a.id])
    expect(rows[0]).not.toHaveProperty('originalBlob')
    expect(get).not.toHaveBeenCalled()
    expect(global).not.toHaveBeenCalled()
  })

  it('registers explicit local/cloud selection and excludes unchecked attachments', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['作者资料'], '资料.txt'))
    const rows = await f.storage.listSummaries()
    const local = createDefaultBackupSelection(rows, 'local')
    expect(local.resourceIds.has(a.id)).toBe(false)
    expect(toArchivePortableSelection(local).resourceAttachments).toBe(true)
    expect(resourceRestoreScopeIds(rows)).toContain('extra.resourceAttachments')
    for (const include of [false, true]) {
      const selection = normalizeContentSelection({
        resourceIds: ['card'],
        resourceAttachments: include,
      })
      expect(
        selectCloudResources(rows, selection.personalResources).some((r) => r.id === a.id),
      ).toBe(include)
      const archive = await f.exporter.createArchive(await f.storage.list(), [], {
        mode: 'partial',
        resourceIds: ['card'],
        portableSelection: { resourceAttachments: include },
      })
      expect(archive.manifest.resources.some((r) => r.id === a.id)).toBe(include)
    }
  })

  it('restores attachment owner IDs after conflicts and repeated backup import', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['作者资料'], '资料.txt'))
    const archive = await f.exporter.createArchive(await f.storage.list(), [], { mode: 'full' })
    const target = await fixture()
    await target.storage.update('card', { contentHash: 'f'.repeat(64) })
    // Read summaries before prepare; the restore API intentionally accepts a snapshot.
    const prepared = await target.restore.prepare(
      new File([archive.blob], archive.fileName),
      await target.storage.listSummaries(),
      [],
    )
    const owner = prepared.resources.find((r) => !isResourceAttachment(r))!
    expect(owner.id).not.toBe('card')
    expect(
      selectPreparedRestore(prepared, new Set([owner.id]), true, undefined, false).resources,
    ).toHaveLength(1)
    await target.restore.restore(prepared)
    const restored = (await target.attachments.list(owner.id))[0]!
    expect(restored.contentHash).toBe(a.contentHash)
    expect(await (await target.attachments.get(owner.id, restored.id)).originalBlob.text()).toBe(
      '作者资料',
    )
    const again = await target.restore.prepare(
      new File([archive.blob], archive.fileName),
      await target.storage.listSummaries(),
      [],
    )
    await target.restore.restore(again)
    expect(await target.attachments.list(owner.id)).toHaveLength(1)
  })

  it('round-trips cloud immutable objects to an empty library and excludes unchecked attachments', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['云端附件'], '资料.txt'))
    await f.attachments.replace('card', a.id, new File(['云端修改'], '资料.txt'), a.contentHash)
    const created = await createStructuredSnapshot(
      await f.storage.list(),
      await f.storage.listAllVersions(),
      [],
      { version: 1 },
    )
    const selected = selectStructuredSnapshot(created.snapshot, new Set(['card']), false, true)
    expect(selected.resources.some((r) => r.id === a.id)).toBe(true)
    expect(
      selectStructuredSnapshot(created.snapshot, new Set(['card']), true, false).resources,
    ).toHaveLength(1)
    const read = async (object: (typeof selected.resources)[number]['object']) =>
      new Blob(
        object.parts.map((part) =>
          created.chunks.get(part.name)!.slice(part.offset ?? 0, (part.offset ?? 0) + part.size),
        ),
      )
    const target = await fixture()
    await target.storage.delete('card')
    const resources = await materializeStructuredResources(selected.resources, read)
    const versions = await materializeStructuredResources(selected.versions, read)
    const prepared = await target.restore.prepareStructured(
      resources,
      versions,
      [],
      { version: 1 },
      [],
      [],
      'cloud-fixture',
    )
    await target.restore.restore(prepared)
    target.db.close()
    await target.db.open()
    expect(await (await target.attachments.get('card', a.id)).originalBlob.text()).toBe('云端修改')
    expect(await target.storage.listVersions(a.id)).toHaveLength(1)
  })

  it('recycles and restores one attachment, its history, and then the whole card', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['原文'], '说明.txt'))
    await f.attachments.replace('card', a.id, new File(['新文'], '说明.txt'), a.contentHash)
    const { record } = await f.recycle.moveToRecycleBin([a.id])
    expect(await f.storage.get(a.id)).toBeUndefined()
    expect(await f.storage.get('card')).toBeDefined()
    await f.recycle.restore(record.id)
    expect(await f.attachments.list('card')).toHaveLength(1)
    expect(await f.storage.listVersions(a.id)).toHaveLength(1)
    const removed = await f.recycle.moveToRecycleBin(['card'])
    expect(await f.attachments.list('card')).toHaveLength(0)
    await f.recycle.restore(removed.record.id)
    const restored = (await f.attachments.list('card'))[0]!
    expect(resourceOwnedFileOwnerId(restored)).toBe('card')
    expect(await (await f.attachments.get('card', restored.id)).originalBlob.text()).toBe('新文')
  })

  it('keeps attachments with the selected owner in split archives and consolidation', async () => {
    const f = await fixture()
    await f.storage.save({ ...f.owner, id: 'other-card' })
    const a = await f.attachments.add('card', new File(['附件'], '附件.txt'))
    const source = await createResourceArchiveSource(f.service, ['card'])
    expect(source.resources.map((r) => r.id)).toContain(a.id)
    await moveResourceGallery(f.storage, 'card', 'other-card')
    expect(await f.attachments.list('card')).toHaveLength(0)
    expect(await f.attachments.list('other-card')).toHaveLength(1)
    await f.service.deleteMany(['card'])
    expect(await f.storage.get(a.id)).toBeDefined()
  })

  it('does not let a concurrent content change or owner deletion get overwritten', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['原件'], '说明.txt'))
    const update = f.storage.update.bind(f.storage)
    const newer = new File(['其他窗口的新内容'], '说明.txt')
    const newerHash = await hashBlob(newer)
    vi.spyOn(f.storage, 'update').mockImplementationOnce(async (id, changes, expected) => {
      await update(id, { originalBlob: newer, fileSize: newer.size, contentHash: newerHash })
      await update(id, changes, expected)
    })
    await expect(
      f.attachments.replace('card', a.id, new File(['迟到覆盖'], '说明.txt'), a.contentHash),
    ).rejects.toThrow('已被修改')
    expect(await (await f.attachments.get('card', a.id)).originalBlob.text()).toBe(
      '其他窗口的新内容',
    )
    expect(await f.storage.listVersions(a.id)).toHaveLength(0)
  })

  it('keeps attachment originals/history out of ordinary resource-file duplicate detection', async () => {
    const f = await fixture()
    const a = await f.attachments.add('card', new File(['独立原件'], '说明.txt'))
    await f.attachments.replace('card', a.id, new File(['新附件'], '说明.txt'), a.contentHash)
    expect(await f.storage.findByHash(a.contentHash)).toBeUndefined()
    expect(await f.storage.findVersionByHash(a.contentHash)).toBeUndefined()
    const current = await f.attachments.get('card', a.id)
    expect(await f.storage.findByHash(current.contentHash)).toBeUndefined()
    expect(await (await f.attachments.original('card', a.id)).originalBlob.text()).toBe('独立原件')
  })

  it('cancels before persistence and removes a late write when the owner disappeared', async () => {
    const f = await fixture()
    const c = new AbortController()
    c.abort()
    await expect(f.attachments.add('card', new File(['x'], 'x.txt'), c.signal)).rejects.toThrow()
    expect(await f.attachments.list('card')).toHaveLength(0)
    const save = f.storage.save.bind(f.storage)
    vi.spyOn(f.storage, 'save').mockImplementation(async (r) => {
      await save(r)
      await f.storage.delete('card')
    })
    await expect(f.attachments.add('card', new File(['x'], 'x.txt'))).rejects.toThrow('所属资源')
    expect(await f.storage.listSummaries()).toHaveLength(0)
  })
})
