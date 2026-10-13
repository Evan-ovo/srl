import 'fake-indexeddb/auto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppDatabase } from '../database/AppDatabase'
import { decodeAppDatabaseValue } from '../storage/AndroidAppDatabaseMigration'
import {
  clearRetainedIndexedDbCopy,
  getRetainedIndexedDbCopy,
  type RetainedIndexedDbRecoverySource,
} from '../storage/AndroidNativeAppDatabaseRuntime'
import type { NativeAppDatabaseStore } from '../storage/NativeAppDatabaseBridge'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbCategoryStorage } from '../storage/IndexedDbCategoryStorage'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { CategoryService } from './CategoryService'
import { ExportService } from './ExportService'
import { ResourceService } from './ResourceService'
import { RestoreService } from './RestoreService'
import { VaultService } from './VaultService'
import { RecycleBinService } from './RecycleBinService'
import { ResourceGalleryService } from './ResourceGalleryService'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { UserPersonaService } from './UserPersonaService'
import type { UserPersonaDraft } from '../types/UserPersona'

const databases: AppDatabase[] = []

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close()
      await database.delete()
    }),
  )
})

async function createResource(
  id: string,
  name: string,
  content: string,
  relatedResourceIds: string[] = [],
): Promise<Resource> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const contentHash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return {
    id,
    type: RESOURCE_TYPE.WORLD_BOOK,
    name,
    description: '',
    fileName: `${name}.json`,
    mimeType: 'application/json',
    fileSize: bytes.byteLength,
    contentHash,
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds,
    tags: [],
    metadata: {},
    originalBlob: new Blob([content], { type: 'application/json' }),
    createdAt: 1,
    updatedAt: 1,
  }
}

async function createServices() {
  const database = new AppDatabase(`recycle-bin-${crypto.randomUUID()}`)
  databases.push(database)
  const vault = new VaultService(database)
  await vault.initialize()
  const resourceStorage = new IndexedDbResourceStorage(database, vault)
  const resourceService = new ResourceService(
    resourceStorage,
    new ResourceParserRegistry([new JsonResourceParser()]),
  )
  const userPersonaService = new UserPersonaService(resourceService)
  const categoryService = new CategoryService(new IndexedDbCategoryStorage(database, vault))
  const restoreService = new RestoreService(new IndexedDbArchiveStorage(database, vault))
  const recycleBin = new RecycleBinService(
    database,
    resourceService,
    categoryService,
    new ExportService(),
    restoreService,
    vault,
    userPersonaService,
  )
  return { database, recycleBin, resourceService, resourceStorage, vault, userPersonaService }
}

describe('RecycleBinService', () => {
  const recoverySource = (value: unknown): RetainedIndexedDbRecoverySource => ({
    databaseName: 'old-library',
    stores: [{ name: 'settings', count: 1, keyPath: 'id' }],
    async readRecords(visit) {
      await visit({ store: 'settings', key: '"feature.characterDraw"', value })
    },
  })

  it.each([false, true])(
    'persists every supported old value and attachment through reopen/restore without overwriting current data (vault: %s)',
    async (sealed) => {
      const { recycleBin, database, resourceService, vault } = await createServices()
      const value = {
        id: 'feature.characterDraw',
        updatedAt: 1,
        value: {
          oldPreference: 'old',
          bytes: new Uint16Array([0, 65535, 127]),
          blob: new Blob(['unique old original'], { type: 'application/octet-stream' }),
          buffer: new Uint8Array([0, 127, 255]).buffer,
          map: new Map([['nested', new Set([1, 2])]]),
          date: new Date('2026-10-01T00:00:00Z'),
          regex: /hello/gi,
          longText: '中😀'.repeat(100_000) + '\ud800',
          missing: undefined,
          integer: 12345678901234567890n,
          negativeZero: -0,
          nan: Number.NaN,
          infinity: Number.POSITIVE_INFINITY,
          __srlAppDatabaseValueV1: 'user field stays literal',
        },
      }
      const current = { id: value.id, value: 'current native preference', updatedAt: 2 }
      await database.settings.put(current)
      if (sealed) await vault.enable('correct horse battery staple')
      await recycleBin.preserveLegacyDatabaseCopy(recoverySource(value))
      database.close()
      await database.open()
      const [record] = await recycleBin.list()
      expect(record?.encrypted).toBe(sealed)
      await recycleBin.restore(record!.id)
      const resources = await resourceService.list()
      const catalogueResource = resources.find(
        (resource) => resource.fileName === 'legacy-indexeddb-recovery.json',
      )!
      const catalogue = JSON.parse(await catalogueResource.originalBlob.text()) as {
        records: Array<{ store: NativeAppDatabaseStore; key: string; resourceId: string }>
        binaries: Array<{ store: string; key: string; fieldPath: string; resourceId: string }>
      }
      const row = catalogue.records[0]!
      const rowResource = resources.find((resource) => resource.id === row.resourceId)!
      const encoded = JSON.parse(await rowResource.originalBlob.text()).value
      const decoded = (await decodeAppDatabaseValue(encoded, row.store, row.key, {
        async readBlob(store: NativeAppDatabaseStore, key: string, fieldPath: string) {
          const binary = catalogue.binaries.find(
            (entry) => entry.store === store && entry.key === key && entry.fieldPath === fieldPath,
          )!
          return resources.find((resource) => resource.id === binary.resourceId)!.originalBlob
        },
      } as never)) as typeof value
      expect({ ...decoded, value: { ...decoded.value, blob: undefined } }).toEqual({
        ...value,
        value: { ...value.value, blob: undefined },
      })
      expect(await decoded.value.blob.text()).toBe('unique old original')
      expect(await database.settings.get(value.id)).toEqual(current)
      expect(await recycleBin.list()).toEqual([])
    },
  )

  it.each([false, true])(
    'runs source locking, archive persistence/readback, and clearing together with old settings and unique original bytes (vault: %s)',
    async (sealed) => {
      const { recycleBin, database, vault, resourceService } = await createServices()
      const old = new AppDatabase(`recovery-source-${crypto.randomUUID()}`)
      databases.push(old)
      await old.open()
      await old.settings.put({ id: 'feature.characterDraw', value: 'old', updatedAt: 1 })
      await old.resources.put({
        id: 'old-original',
        type: RESOURCE_TYPE.OTHER,
        originalBlob: new Blob(['never discard these bytes']),
      } as never)
      await database.settings.put({ id: 'feature.characterDraw', value: 'current', updatedAt: 2 })
      const native = {
        async getState(key: string) {
          if (key === 'migration:appdb:v1:active')
            return JSON.stringify({ version: 1, databaseVersion: 25, activatedAt: 1 })
          if (key === 'migration:appdb:indexes:v1:active') return 'verified-v1'
          return undefined
        },
        async verifyStore() {
          return { records: 0, files: 0, bytes: 0 }
        },
      }
      if (sealed) await vault.enable('correct horse battery staple')
      await clearRetainedIndexedDbCopy(
        old.name,
        await getRetainedIndexedDbCopy(old.name),
        undefined,
        native as never,
        (source) => recycleBin.preserveLegacyDatabaseCopy(source),
      )
      expect((await getRetainedIndexedDbCopy(old.name)).records).toBe(0)
      expect(await recycleBin.list()).toHaveLength(1)
      expect(await database.settings.get('feature.characterDraw')).toEqual({
        id: 'feature.characterDraw',
        value: 'current',
        updatedAt: 2,
      })
      const [record] = await recycleBin.list()
      await recycleBin.restore(record!.id)
      const recovered = await resourceService.list()
      const binary = recovered.find((resource) => resource.fileName.startsWith('legacy-binary-'))!
      expect(await binary.originalBlob.text()).toBe('never discard these bytes')
    },
  )

  it('refuses cleanup when the persisted recovery archive is damaged', async () => {
    const { database, recycleBin } = await createServices()
    const read = database.backupRecords.get.bind(database.backupRecords)
    vi.spyOn(database.backupRecords, 'get').mockImplementation((id) =>
      read(id).then(
        (record) => ({ ...record, blob: new Blob([new Uint8Array(record!.blob!.size)]) }) as never,
      ),
    )
    await expect(
      recycleBin.preserveLegacyDatabaseCopy(
        recoverySource({ id: 'feature.characterDraw', value: 'old' }),
      ),
    ).rejects.toThrow('未通过保存校验')
  })

  it('keeps the actual old IndexedDB source when recovery readback fails', async () => {
    const { recycleBin, database } = await createServices()
    const old = new AppDatabase(`failed-recovery-source-${crypto.randomUUID()}`)
    databases.push(old)
    await old.open()
    await old.settings.put({ id: 'feature.characterDraw', value: 'unique old value', updatedAt: 1 })
    const native = {
      async getState(key: string) {
        if (key === 'migration:appdb:v1:active')
          return JSON.stringify({ version: 1, databaseVersion: 25, activatedAt: 1 })
        if (key === 'migration:appdb:indexes:v1:active') return 'verified-v1'
        return undefined
      },
      async verifyStore() {
        return { records: 0, files: 0, bytes: 0 }
      },
    }
    const read = database.backupRecords.get.bind(database.backupRecords)
    vi.spyOn(database.backupRecords, 'get').mockImplementation((id) =>
      read(id).then(
        (record) => ({ ...record, blob: new Blob([new Uint8Array(record!.blob!.size)]) }) as never,
      ),
    )
    await expect(
      clearRetainedIndexedDbCopy(
        old.name,
        await getRetainedIndexedDbCopy(old.name),
        undefined,
        native as never,
        (source) => recycleBin.preserveLegacyDatabaseCopy(source),
      ),
    ).rejects.toThrow('未通过保存校验')
    expect((await getRetainedIndexedDbCopy(old.name)).records).toBe(1)
    expect((await old.settings.get('feature.characterDraw'))!.value).toBe('unique old value')
  })

  it('does not accept an incomplete source iterator as a saved recovery', async () => {
    const { recycleBin } = await createServices()
    const source = recoverySource({ id: 'feature.characterDraw' })
    source.stores[0]!.count = 2
    await expect(recycleBin.preserveLegacyDatabaseCopy(source)).rejects.toThrow('未包含完整记录')
    expect(await recycleBin.list()).toEqual([])
  })
  it('moves a nested persona version to recycle bin and restores it without resource history snapshots', async () => {
    const { recycleBin, resourceService, userPersonaService } = await createServices()
    const draft: UserPersonaDraft = {
      avatarId: 'me.png',
      name: '同一个我',
      title: '',
      description: '全局人设',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      connections: [],
      characterBindings: {},
      profile: {
        version: 1,
        sections: [{ id: 'base', name: '基础设定', text: '全局人设' }],
        variants: {
          'detective.png': {
            defaultVersionId: 'v1',
            chatVersions: { chatA: 'v1', chatB: 'v2' },
            versions: {
              v1: { name: '初遇', overrides: {}, addition: '初遇补充' },
              v2: { name: '重逢', overrides: {}, addition: '重逢补充' },
            },
          },
        },
      },
    }
    const resource = await userPersonaService.create(draft)

    const recycled = await recycleBin.movePersonaVersionToRecycleBin({
      resourceId: resource.id,
      avatarId: draft.avatarId,
      characterId: 'detective.png',
      characterName: '雨夜侦探',
      versionId: 'v1',
    })

    expect(recycled.itemKind).toBe('persona-version')
    expect(recycled.reason).toContain('雨夜侦探')
    expect(await resourceService.listVersions(resource.id)).toHaveLength(1)
    let current = await userPersonaService.load(resource.id)
    expect(current.view.entries[0]?.profile.variants['detective.png']?.versions).toEqual({
      v2: { name: '重逢', overrides: {}, addition: '重逢补充' },
    })
    expect((await recycleBin.list()).map((entry) => entry.id)).toContain(recycled.id)

    await recycleBin.restore(recycled.id)

    current = await userPersonaService.load(resource.id)
    expect(current.view.entries[0]?.profile.variants['detective.png']).toMatchObject({
      defaultVersionId: 'v1',
      chatVersions: { chatA: 'v1', chatB: 'v2' },
      versions: {
        v1: { name: '初遇', addition: '初遇补充' },
        v2: { name: '重逢', addition: '重逢补充' },
      },
    })
    expect(await resourceService.listVersions(resource.id)).toHaveLength(1)
    expect(await recycleBin.list()).toEqual([])
  })

  it('moves a whole character persona and all its versions to recycle bin without resource history snapshots', async () => {
    const { recycleBin, resourceService, userPersonaService } = await createServices()
    const draft: UserPersonaDraft = {
      avatarId: 'me.png',
      name: '同一个我',
      title: '',
      description: '全局人设',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      connections: [],
      characterBindings: {},
      profile: {
        version: 1,
        sections: [{ id: 'base', name: '基础设定', text: '全局人设' }],
        variants: {
          'detective.png': {
            defaultVersionId: 'v1',
            chatVersions: { chatA: 'v1', chatB: 'v2' },
            versions: {
              v1: { name: '初遇', overrides: {}, addition: '初遇补充' },
              v2: { name: '重逢', overrides: {}, addition: '重逢补充' },
            },
          },
        },
      },
    }
    const resource = await userPersonaService.create(draft)

    const recycled = await recycleBin.movePersonaCharacterToRecycleBin({
      resourceId: resource.id,
      avatarId: draft.avatarId,
      characterId: 'detective.png',
      characterName: '雨夜侦探',
    })

    expect(recycled.itemKind).toBe('persona-character')
    expect(await resourceService.listVersions(resource.id)).toHaveLength(1)
    let current = await userPersonaService.load(resource.id)
    expect(current.view.entries[0]?.profile.variants['detective.png']).toBeUndefined()
    expect((await recycleBin.list()).map((entry) => entry.id)).toContain(recycled.id)

    await recycleBin.restore(recycled.id)

    current = await userPersonaService.load(resource.id)
    expect(current.view.entries[0]?.profile.variants['detective.png']).toEqual(
      draft.profile.variants['detective.png'],
    )
    expect(await resourceService.listVersions(resource.id)).toHaveLength(1)
    expect(await recycleBin.list()).toEqual([])
  })

  it('restores gallery categories and custom cover together with the deleted resource', async () => {
    const { recycleBin, resourceStorage, resourceService } = await createServices()
    const owner = await createResource('gallery-owner', '图库资源', '{}')
    await resourceStorage.save(owner)
    const gallery = new ResourceGalleryService(resourceStorage)
    const image = await gallery.addUrl(owner.id, 'https://example.com/preview.png', false, ['预览'])
    await gallery.setCover(owner.id, image.id)
    const { record: entry, resources } = await recycleBin.moveToRecycleBin([owner.id])
    expect(
      resources?.some((resource) => resource.id === owner.id || resource.id === image.id),
    ).toBe(false)
    expect(await resourceStorage.get(image.id)).toBeUndefined()
    await recycleBin.restore(entry.id)
    const restoredOwner = (await resourceService.get(owner.id))!
    expect(restoredOwner.metadata.resourceCoverId).toBe(image.id)
    expect((await gallery.list(owner.id)).items[0]?.tags).toEqual(['预览'])
  })
  it('stores only selected resources and their versions, then restores links', async () => {
    const { database, recycleBin, resourceService, resourceStorage } = await createServices()
    const atlas = await createResource('atlas', 'Atlas', '{"name":"Atlas"}', ['companion'])
    const atlasVersion = {
      ...(await createResource('atlas-version', 'Atlas', '{"name":"Atlas v1"}', ['companion'])),
      versionGroupId: atlas.id,
      versionImportedAt: 0,
      versionLabel: 'v1',
    }
    const companion = await createResource('companion', 'Companion', '{"name":"Companion"}', [
      atlas.id,
    ])
    const untouched = await createResource('untouched', 'Untouched', '{"name":"Untouched"}')
    await resourceStorage.saveMany([atlas, companion, untouched])
    await resourceStorage.saveVersion(atlasVersion)

    const eagerVersions = vi
      .spyOn(resourceService, 'listVersions')
      .mockRejectedValue(new Error('must not load all originals'))
    const catalogueReads = vi.spyOn(resourceStorage, 'listResourceListSummaries')
    const { record: entry, resources } = await recycleBin.moveToRecycleBin([atlas.id])
    expect(catalogueReads.mock.calls.filter(([filter]) => !filter)).toHaveLength(2)
    expect(catalogueReads).toHaveBeenCalledWith({ ids: [atlas.id] })
    expect(catalogueReads).toHaveBeenCalledWith({ types: [RESOURCE_TYPE.OTHER] })
    expect(resources?.map((resource) => resource.id).sort()).toEqual(['companion', 'untouched'])
    expect(resources?.find((resource) => resource.id === companion.id)?.relatedResourceIds).toEqual(
      [],
    )
    expect(resources?.every((resource) => !('originalBlob' in resource))).toBe(true)
    expect(eagerVersions).not.toHaveBeenCalled()
    eagerVersions.mockRestore()

    expect(entry.resourceCount).toBe(1)
    expect(await resourceService.get(atlas.id)).toBeUndefined()
    expect(await database.resourceVersions.get(atlasVersion.id)).toBeUndefined()
    expect(await resourceService.get(untouched.id)).toBeTruthy()
    expect((await resourceService.get(companion.id))?.relatedResourceIds).toEqual([])

    await recycleBin.restore(entry.id)

    expect(await resourceService.get(atlas.id)).toMatchObject({ name: 'Atlas' })
    const restoredVersions = (await resourceService.listVersions(atlas.id)).flatMap(
      (view) => view.carriers ?? [view.resource],
    )
    expect(restoredVersions).toHaveLength(2)
    expect(restoredVersions.map((resource) => resource.contentHash)).toContain(
      atlasVersion.contentHash,
    )
    expect((await resourceService.get(companion.id))?.relatedResourceIds).toEqual([atlas.id])
    expect(await recycleBin.list()).toEqual([])
  })

  it('protects recycle archives when the local vault is enabled', async () => {
    const { database, recycleBin, resourceService, resourceStorage, vault } = await createServices()
    const resource = await createResource('sealed', 'Sealed', '{"name":"Sealed"}')
    await resourceStorage.save(resource)
    await vault.enable('correct horse battery staple')

    const { record: entry } = await recycleBin.moveToRecycleBin([resource.id])

    expect(entry.encrypted).toBe(true)
    expect(entry.encryptionIv).toBeTruthy()
    expect((await database.backupRecords.get(entry.id))?.encrypted).toBe(true)
    await recycleBin.restore(entry.id)
    expect(await resourceService.get(resource.id)).toMatchObject({ name: 'Sealed' })
  })
})
