import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { MemoryRestoreStagingStore } from '../storage/RestoreStagingStore'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { PersonalResourceParser } from '../parser/PersonalResourceParser'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { ResourceService } from './ResourceService'
import { PersonalResourceService } from './PersonalResourceService'
import { SecretResourceService } from './SecretResourceService'
import { ExportService } from './ExportService'
import { RestoreService } from './RestoreService'
import { plaintextSecretCopies } from './PersonalResourceBackup'
import type { PersonalResourceDocument } from '../types/PersonalResource'
import { zipSync, strToU8 } from 'fflate'
import { CloudBackupService } from './CloudBackupService'
import type { CategoryService } from './CategoryService'
import type { CreatedStructuredSnapshot } from './CloudStructuredSnapshot'
import { RestoreDuplicateIndex } from '../utils/RestoreIdentity'

const databases: AppDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
  vi.unstubAllGlobals()
})
function setup(indexedStaging = false) {
  const database = new AppDatabase(`personal-${crypto.randomUUID()}`)
  databases.push(database)
  const staging = indexedStaging
    ? new IndexedDbRestoreStagingStore(database)
    : new MemoryRestoreStagingStore()
  const resources = new ResourceService(
    new IndexedDbResourceStorage(database),
    new ResourceParserRegistry([new PersonalResourceParser(staging), new JsonResourceParser()]),
  )
  return { database, resources, personal: new PersonalResourceService(resources, staging) }
}
const document = (kind: PersonalResourceDocument['kind']): PersonalResourceDocument => ({
  format: 'srl-personal-resource',
  version: 1,
  kind,
  name: '部署记录',
  text: '',
  url: '',
  fields: [],
  attachments: [],
})
function secrets() {
  const data = new Map<string, string>()
  return new SecretResourceService({
    read: async (key) => data.get(key) ?? '',
    save: async (key, value) => {
      data.set(key, value)
    },
    clear: async (key) => {
      data.delete(key)
    },
  })
}

describe('personal resource lifecycle', () => {
  it('recognizes a restored secret after local re-encryption, but invalidates that identity after a real edit', async () => {
    const { personal, resources, database } = setup()
    const origin = secrets(),
      local = secrets()
    await origin.setPassword('origin-password')
    await local.setPassword('local-password')
    const plain = {
      ...document('secret'),
      fields: [{ id: 'key', label: 'Key', value: 'synthetic-private-value', private: true }],
    }
    const source = await personal.save(await origin.protect(plain), new Map())
    const migrated = await personal.save(
      await local.protect(plain),
      new Map(),
      source,
      source.contentHash,
    )
    expect(migrated.contentHash).not.toBe(source.contentHash)
    database.close()
    await database.open()
    let existing = await resources.listResourceListSummaries()
    expect(new RestoreDuplicateIndex(existing, [source]).find(source)).toBe(migrated.id)
    expect(
      (
        await new RestoreService(new IndexedDbArchiveStorage(database)).prepareStructured(
          [source],
          [],
          [],
          { version: 1 },
          existing,
          [],
          'same-backup',
        )
      ).resources,
    ).toHaveLength(0)
    const changed = { ...plain, fields: [{ ...plain.fields[0]!, value: 'edited-private-value' }] }
    const updated = await personal.save(await local.protect(changed), new Map(), migrated)
    existing = await resources.listResourceListSummaries()
    expect(new RestoreDuplicateIndex(existing, [source]).find(source)).toBeUndefined()
    expect(updated.metadata.restoredSecretSourceHash).toBeUndefined()
    expect((await local.reveal(await personal.read(updated)))[0]?.value).toBe(
      'edited-private-value',
    )
  })
  it('retains multi-chunk APK bytes during a second save using IndexedDB staging', async () => {
    const { personal } = setup(true)
    const bytes = zipSync(
      { 'nested/data.bin': new Uint8Array(2 * 1024 * 1024 + 13).fill(37) },
      { level: 0 },
    )
    const draft = {
      ...document('pocketPhone'),
      attachments: [
        { path: 'attachments/large', name: 'phone.apk', kind: 'apk' as const, size: bytes.length },
      ],
    }
    const first = await personal.save(
      draft,
      new Map([['attachments/large', new File([bytes], 'phone.apk')]]),
    )
    expect((await personal.attachment(first, 'attachments/large')).size).toBe(bytes.length)
    const edited = await personal.save({ ...draft, text: 'second' }, new Map(), first)
    const restored = await personal.attachment(edited, 'attachments/large')
    expect(restored.size).toBe(bytes.length)
    expect(await crypto.subtle.digest('SHA-256', await restored.arrayBuffer())).toEqual(
      await crypto.subtle.digest('SHA-256', bytes),
    )
  })

  it('updates a pocket-phone URL without reading, hashing, or replacing its retained APK', async () => {
    const { personal, resources } = setup(true)
    const apk = new File([new Uint8Array(5 * 1024 * 1024).fill(17)], 'phone.apk')
    const draft = {
      ...document('pocketPhone'),
      url: 'https://one.example',
      attachments: [
        { path: 'attachments/apk', name: apk.name, kind: 'apk' as const, size: apk.size },
      ],
    }
    const first = await personal.save(draft, new Map([['attachments/apk', apk]]))
    const original = first.originalBlob
    Object.defineProperty(original, 'arrayBuffer', {
      value: () => Promise.reject(new Error('metadata edit must not materialize the APK archive')),
    })

    const updated = await personal.save({ ...draft, url: 'https://two.example' }, new Map(), first)

    expect(updated.contentHash).toBe(first.contentHash)
    expect(updated.originalBlob).toBe(original)
    expect((await personal.read(updated)).url).toBe('https://two.example')
    await expect(resources.list()).resolves.toHaveLength(1)
  })

  it('keeps one active secret while repeatedly editing encrypted fields', async () => {
    const { personal, resources } = setup()
    const owner = secrets()
    await owner.setPassword('one-password')
    let current: import('../types/Resource').Resource | undefined
    for (const value of ['first', 'second', 'third']) {
      current = await personal.save(
        await owner.protect({
          ...document('secret'),
          fields: [{ id: 'field', label: '密钥', private: true, value }],
        }),
        new Map(),
        current,
      )
    }
    expect((await owner.reveal(await personal.read(current!)))[0]?.value).toBe('third')
    expect(current?.versionCount).toBe(1)
    expect(await resources.listAllVersions()).toHaveLength(0)
    expect(await resources.list()).toHaveLength(1)
  })

  it('persists selected phone icons through JSON export/import and updates thumbnail without history', async () => {
    const { personal, resources } = setup()
    const draft: PersonalResourceDocument = {
      ...document('pocketPhone'),
      icons: [{ source: 'image', origin: 'icon.png', dataUrl: 'data:image/png;base64,aWNvbg==' }],
      iconSource: 'image',
    }
    const first = await personal.save(draft, new Map())
    expect(first.thumbnailBlob?.type).toBe('image/png')
    const target = setup()
    const [imported] = await target.resources.importFiles([
      new File([first.originalBlob], first.fileName, { type: first.mimeType }),
    ])
    expect(imported?.status).toBe('imported')
    const [restored] = await target.resources.list()
    expect((await target.personal.read(restored!)).iconSource).toBe('image')
    expect(restored!.thumbnailBlob?.size).toBe(4)
    const cleared = await personal.save({ ...draft, iconSource: undefined }, new Map(), first)
    expect(cleared.thumbnailBlob).toBeUndefined()
    expect(await resources.listAllVersions()).toHaveLength(0)
  })
  it('updates a story in place without manufacturing versions, preserving organization', async () => {
    const { personal, resources } = setup()
    const first = await personal.save({ ...document('extraStory'), text: '番外原文' }, new Map())
    await resources.updateMetadata(first.id, { authorNote: '备注作者' })
    await resources.setFavorite(first, true)
    const edited = await personal.save(
      { ...document('extraStory'), text: '新的番外' },
      new Map(),
      first,
    )
    expect((await personal.read(edited)).text).toBe('新的番外')
    expect(await resources.listAllVersions()).toHaveLength(0)
    expect(edited.id).toBe(first.id)
    expect(edited.versionCount).toBe(1)
    expect(edited.favorite).toBe(true)
    expect(edited.metadata.authorNote).toBe('备注作者')
    expect((await resources.list()).length).toBe(1)
  })

  it('keeps URL, APK and source-folder paths together across edits and ZIP restore', async () => {
    const { personal, resources } = setup()
    const draft = {
      ...document('pocketPhone'),
      url: 'https://example.com/phone',
      attachments: [
        { path: 'attachments/apk', name: 'app.apk', kind: 'apk' as const, size: 3 },
        { path: 'attachments/source', name: 'src/main.js', kind: 'source' as const, size: 4 },
      ],
    }
    const first = await personal.save(
      draft,
      new Map([
        ['attachments/apk', new File(['apk'], 'app.apk')],
        ['attachments/source', new File(['code'], 'main.js')],
      ]),
    )
    const edited = await personal.save({ ...draft, text: '备注' }, new Map(), first)
    expect(await resources.listAllVersions()).toHaveLength(0)
    expect(await (await personal.attachment(edited, 'attachments/source')).text()).toBe('code')
    const archive = await new ExportService().createArchive(
      await resources.list(),
      [],
      { mode: 'full' },
      await resources.listAllVersions(),
    )
    const target = setup()
    const restore = new RestoreService(new IndexedDbArchiveStorage(target.database))
    await restore.restore(await restore.prepare(new File([archive.blob], archive.fileName), [], []))
    const [restored] = await target.resources.list()
    expect((await target.personal.read(restored!)).attachments[1]?.name).toBe('src/main.js')
    expect(await (await target.personal.attachment(restored!, 'attachments/apk')).text()).toBe(
      'apk',
    )
  })

  it('backs up locked encrypted keys without needing a password and unlocks on another device', async () => {
    const { personal, resources } = setup()
    const secretOwner = secrets()
    await secretOwner.setPassword('password-123')
    const protectedDocument = await secretOwner.protect(
      {
        ...document('secret'),
        fields: [
          { id: 'url', label: 'Worker', value: 'https://example.com', private: false },
          { id: 'key', label: '密钥', value: 'sensitive-test-value', private: true },
        ],
      },
      'password-123',
    )
    expect(JSON.stringify(protectedDocument)).not.toContain('sensitive-test-value')
    await personal.save(protectedDocument, new Map())
    const all = await resources.list()
    expect(JSON.stringify(await resources.listSummaries())).not.toContain('sensitive-test-value')
    const archive = await new ExportService().createArchive(all, [], {
      mode: 'full',
      personalResources: { secret: true },
    })
    const target = setup()
    const restore = new RestoreService(new IndexedDbArchiveStorage(target.database))
    await restore.restore(await restore.prepare(new File([archive.blob], archive.fileName), [], []))
    const [restored] = await target.resources.list()
    const restoredDoc = await target.personal.read(restored!)
    await expect(secrets().reveal(restoredDoc, 'wrong-password')).rejects.toThrow('密码不正确')
    expect((await secrets().reveal(restoredDoc, 'password-123'))[1]?.value).toBe(
      'sensitive-test-value',
    )
    const excluded = await new ExportService().createArchive(all, [], {
      mode: 'full',
      personalResources: { secret: false },
    })
    expect(excluded.manifest.resources).toHaveLength(0)
    const plain = await plaintextSecretCopies(all, 'password-123')
    expect(plain[0]?.document.fields[1]?.value).toBe('sensitive-test-value')
    expect(await all[0]!.originalBlob.text()).not.toContain('sensitive-test-value')
  })

  it('does not overwrite the viewing password after a failed save', async () => {
    const owner = secrets()
    const draft = {
      ...document('secret'),
      fields: [{ id: 'x', label: 'Key', value: 'one', private: true }],
    }
    await owner.setPassword('password-123')
    await owner.protect(draft, 'password-123')
    await expect(owner.protect(draft, 'wrong-password')).rejects.toThrow()
    const again = await owner.protect(draft, 'password-123')
    expect((await owner.reveal(again, 'password-123'))[0]?.value).toBe('one')
  })

  it('rejects missing phone attachments, oversized documents and unencrypted private values before storage', async () => {
    const { personal, resources } = setup()
    const draft = {
      ...document('pocketPhone'),
      attachments: [
        { path: 'attachments/missing', name: 'src/main.js', kind: 'source' as const, size: 3 },
      ],
    }
    const broken = new File(
      [new Uint8Array(zipSync({ 'srl-resource.json': strToU8(JSON.stringify(draft)) }))],
      'renamed.zip',
    )
    const [result] = await resources.importFiles([broken])
    expect(result?.status).toBe('failed')
    await expect(
      personal.save({ ...document('extraStory'), text: '中'.repeat(800_000) }, new Map()),
    ).rejects.toThrow('2 MB')
    await expect(
      personal.save(
        {
          ...document('secret'),
          fields: [{ id: 'key', label: 'Key', value: 'plain', private: true }],
        },
        new Map(),
      ),
    ).rejects.toThrow('加密')
    expect(await resources.list()).toHaveLength(0)
  })

  it('builds V3 cloud objects for encrypted keys without an unlock and honors all new category filters', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => undefined })
    vi.stubGlobal('sessionStorage', { removeItem: () => undefined })
    const { personal, resources, database } = setup()
    await personal.save({ ...document('extraStory'), text: '番外' }, new Map())
    await personal.save(document('pocketPhone'), new Map())
    const cloudSecrets = secrets()
    await cloudSecrets.setPassword('cloud-password')
    await personal.save(
      await cloudSecrets.protect(
        {
          ...document('secret'),
          fields: [{ id: 'key', label: 'Key', value: 'cloud-private-value', private: true }],
        },
        'cloud-password',
      ),
      new Map(),
    )
    const cloud = new CloudBackupService(
      resources,
      { list: async () => [] } as unknown as CategoryService,
      new ExportService(),
      new RestoreService(new IndexedDbArchiveStorage(database)),
    ) as unknown as {
      initializeCredentials: () => Promise<void>
      buildStructuredBackup: (
        portable: { version: 1 },
        progress?: undefined,
        selection?: { extraStory?: boolean; pocketPhone?: boolean; secret?: boolean },
      ) => Promise<CreatedStructuredSnapshot>
    }
    await cloud.initializeCredentials()
    const defaultSnapshot = await cloud.buildStructuredBackup({ version: 1 })
    expect(defaultSnapshot.snapshot.resources.map((resource) => resource.type).sort()).toEqual([
      'extraStory',
      'pocketPhone',
    ])
    const secretSnapshot = await cloud.buildStructuredBackup({ version: 1 }, undefined, {
      extraStory: false,
      pocketPhone: false,
      secret: true,
    })
    expect(secretSnapshot.snapshot.resources.map((resource) => resource.type)).toEqual(['secret'])
    expect(JSON.stringify(secretSnapshot.snapshot)).not.toContain('cloud-private-value')
    expect(secretSnapshot.objectPlans.length).toBeGreaterThan(0)
    for (const plan of secretSnapshot.objectPlans) {
      const blob = plan.blob ?? (await plan.loadBlob?.())
      expect(blob).toBeDefined()
      expect(await blob!.text()).not.toContain('cloud-private-value')
    }
  })
})
