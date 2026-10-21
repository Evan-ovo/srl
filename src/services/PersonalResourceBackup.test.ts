import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { VaultService } from './VaultService'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { hashBlob } from './HashService'
import {
  savePlainSecretExportGrant,
  readPlainSecretExportGrant,
  clearPlainSecretExportGrant,
  selectCloudResources,
  cloudPlainSecretCopies,
  plaintextSecretCopies,
} from './PersonalResourceBackup'
import { RESOURCE_TYPE, toResourceListSummary, type Resource } from '../types/Resource'
import { ResourceService } from './ResourceService'
import type { PersonalResourceDocument } from '../types/PersonalResource'
import { secretResourceService, SecretResourceService } from './SecretResourceService'
const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('./LocalCredentialStore', () => ({
  localCredentialStore: {
    save: async (key: string, value: string) => {
      stored.set(key, value)
    },
    read: async (key: string) => stored.get(key) ?? '',
    clear: async (key: string) => {
      stored.delete(key)
    },
  },
}))
beforeEach(() => stored.clear())

const target = {
  provider: 'github' as const,
  owner: 'Owner',
  repository: 'private-backup',
  retention: 7,
  autoBackup: false,
}
function secret(id: string, text = ''): Resource {
  const document: PersonalResourceDocument = {
    format: 'srl-personal-resource',
    version: 1,
    kind: 'secret',
    name: id,
    text,
    url: '',
    attachments: [],
    fields: [{ id: 'key', label: '测试🔑', value: 'test-value', private: false }],
  }
  const blob = new Blob([JSON.stringify(document)], { type: 'application/json' })
  return {
    id,
    type: RESOURCE_TYPE.SECRET,
    name: id,
    description: '',
    fileName: id + '.json',
    mimeType: blob.type,
    fileSize: blob.size,
    contentHash: id,
    originalBlob: blob,
    metadata: {},
    tags: [],
    favorite: false,
    categoryId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}
function backend(rows: Resource[], fast = true) {
  const full = vi.fn(async () => rows.map(toResourceListSummary))
  const light = fast ? vi.fn(async () => rows.map(toResourceListSummary)) : undefined
  const read = vi.fn(async (id: string) => rows.find((row) => row.id === id))
  return {
    full,
    light,
    read,
    resources: {
      listSummaries: full,
      listResourceListSummaries: light,
      get: read,
    } as unknown as ResourceService,
  }
}

describe('selected plaintext cloud copies', () => {
  it.each([false, true])(
    'repairs selected missing list rows without reading unselected originals (vault=%s)',
    async (encrypted) => {
      const db = new AppDatabase('plain-copy-selection-' + crypto.randomUUID()),
        vault = new VaultService(db)
      try {
        await vault.initialize()
        if (encrypted) await vault.enable('vault-test-password')
        const storage = new IndexedDbResourceStorage(db, vault)
        const rows = [
          secret('selected'),
          secret('outside'),
          { ...secret('excluded'), metadata: { cloudBackupExcluded: true } },
        ]
        for (const row of rows) row.contentHash = await hashBlob(row.originalBlob)
        await storage.saveMany(rows)
        await db.resourceListSummaries.delete('selected')
        await savePlainSecretExportGrant(target, 'viewing-password')
        const full = vi.spyOn(storage, 'listSummaries'),
          read = vi.spyOn(storage, 'get')
        const resources = new ResourceService(storage, new ResourceParserRegistry([]))
        const copies = await cloudPlainSecretCopies(target, resources, {
          secret: true,
          resourceIds: ['selected', 'excluded'],
        })
        expect(copies.map((copy) => copy.document.name)).toEqual(['selected'])
        expect(copies[0]?.contentHash).toBe(rows[0]!.contentHash)
        expect(full).not.toHaveBeenCalled()
        expect(read.mock.calls).toEqual([['selected']])
        expect((await storage.getResourceListSummary('selected'))?.type).toBe(RESOURCE_TYPE.SECRET)
      } finally {
        db.close()
        await db.delete()
      }
    },
  )
  it('reads only selected secrets through the light index even if a provider returns extra rows', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const data = backend([
      secret('selected'),
      secret('other'),
      { ...secret('card'), type: RESOURCE_TYPE.CHARACTER_CARD },
    ])
    const copies = await cloudPlainSecretCopies(target, data.resources, {
      secret: true,
      resourceIds: ['selected'],
    })
    expect(copies.map((copy) => copy.document.name)).toEqual(['selected'])
    expect(data.full).not.toHaveBeenCalled()
    expect(data.light).toHaveBeenCalledWith(
      expect.objectContaining({ types: [RESOURCE_TYPE.SECRET], ids: ['selected'] }),
    )
    expect(data.read.mock.calls).toEqual([['selected']])
  })

  it('applies the same selection on the legacy summary fallback', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const data = backend([secret('selected'), secret('other')], false)
    expect(
      (
        await cloudPlainSecretCopies(target, data.resources, {
          secret: true,
          resourceIds: ['selected'],
        })
      ).map((copy) => copy.document.name),
    ).toEqual(['selected'])
    expect(data.full).toHaveBeenCalledOnce()
    expect(data.read.mock.calls).toEqual([['selected']])
  })

  it('rechecks an exclusion changed after the summary was read', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const row = secret('selected'),
      data = backend([row])
    data.read.mockResolvedValue({ ...row, metadata: { cloudBackupExcluded: true } })
    expect(
      await cloudPlainSecretCopies(target, data.resources, {
        secret: true,
        resourceIds: ['selected'],
      }),
    ).toEqual([])
  })

  it('keeps explicit empty selection empty without requiring a destination grant', async () => {
    const data = backend([secret('other')])
    expect(
      await cloudPlainSecretCopies(target, data.resources, { secret: true, resourceIds: [] }),
    ).toEqual([])
    expect(data.full).not.toHaveBeenCalled()
    expect(data.light).not.toHaveBeenCalled()
    await savePlainSecretExportGrant(target, 'viewing-password')
    expect(
      await cloudPlainSecretCopies(target, data.resources, { secret: true, resourceIds: [] }),
    ).toEqual([])
    expect(data.read).not.toHaveBeenCalled()
  })
  it('does not read originals or require a plaintext grant for explicitly unencrypted cards', async () => {
    const row = secret('plain')
    row.metadata.secretProtection = 'none'
    const data = backend([row])
    expect(await cloudPlainSecretCopies(target, data.resources, { secret: true })).toEqual([])
    expect(data.read).not.toHaveBeenCalled()
    expect(stored.size).toBe(0)
  })

  it('does no credential or resource work when secret copies are explicitly excluded', async () => {
    const data = backend([secret('other')])
    expect(await cloudPlainSecretCopies(target, data.resources, { secret: false })).toEqual([])
    expect(data.read).not.toHaveBeenCalled()
    expect(data.full).not.toHaveBeenCalled()
    expect(data.light).not.toHaveBeenCalled()
  })

  it('preserves the all-secrets behavior for callers without a selection', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const data = backend([
      secret('one'),
      secret('two'),
      { ...secret('excluded'), metadata: { cloudBackupExcluded: true } },
    ])
    expect(
      (await cloudPlainSecretCopies(target, data.resources)).map((copy) => copy.document.name),
    ).toEqual(['one', 'two'])
    expect(data.read.mock.calls).toEqual([['one'], ['two']])
  })

  it('stops reading later secrets as soon as their combined output exceeds the existing limit', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const data = backend(
      ['one', 'two', 'three', 'four'].map((id) => secret(id, 'x'.repeat(700000))),
    )
    await expect(cloudPlainSecretCopies(target, data.resources, { secret: true })).rejects.toThrow(
      '超过 2 MB',
    )
    expect(data.read.mock.calls).toEqual([['one'], ['two'], ['three']])
  })

  it('preserves the exact UTF-8 JSON limit including commas and brackets', async () => {
    await savePlainSecretExportGrant(target, 'viewing-password')
    const first = secret('one', 'x'.repeat(700000)),
      second = secret('two', 'x'.repeat(700000)),
      third = secret('three')
    const base = await Promise.all(
      [first, second, third].map(async (row) => ({
        contentHash: row.contentHash,
        document: JSON.parse(await row.originalBlob.text()),
      })),
    )
    const padding = 2 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(base)).length
    const exact = backend([first, second, secret('three', 'x'.repeat(padding))])
    const copies = await cloudPlainSecretCopies(target, exact.resources, { secret: true })
    expect(new TextEncoder().encode(JSON.stringify(copies)).length).toBe(2 * 1024 * 1024)
    const over = backend([first, second, secret('three', 'x'.repeat(padding + 1))])
    await expect(cloudPlainSecretCopies(target, over.resources, { secret: true })).rejects.toThrow(
      '超过 2 MB',
    )
  })
})
describe('plaintext companion target consent', () => {
  it('asks once for foreign imported cards across separate export calls and asks again after an explicit lock', async () => {
    secretResourceService.lock()
    const values = new Map<string, string>()
    const origin = new SecretResourceService({
      read: async (id) => values.get(id) ?? '',
      save: async (id, value) => {
        values.set(id, value)
      },
      clear: async (id) => {
        values.delete(id)
      },
    })
    await origin.setPassword('old-device-password')
    const rows = []
    for (const id of ['one', 'two']) {
      const row = secret(id)
      const document = JSON.parse(await row.originalBlob.text())
      document.fields[0].private = true
      row.originalBlob = new Blob([JSON.stringify(await origin.protect(document))])
      rows.push(row)
    }
    const prompt = vi.fn(async () => 'old-device-password')
    for (const row of rows)
      expect(
        (await plaintextSecretCopies([row], undefined, prompt))[0]?.document.fields[0]?.value,
      ).toBe('test-value')
    expect(prompt).toHaveBeenCalledOnce()
    secretResourceService.lock()
    prompt.mockResolvedValueOnce('')
    await expect(plaintextSecretCopies([rows[0]!], undefined, prompt)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(prompt).toHaveBeenCalledTimes(2)
  })
  it('authorizes the chosen target with the already verified session and cannot reuse it after locking', async () => {
    secretResourceService.lock()
    await secretResourceService.setPassword('verified-test-password')
    await savePlainSecretExportGrant(target)
    expect(await readPlainSecretExportGrant(target)).toBe('verified-test-password')
    secretResourceService.lock()
    await expect(savePlainSecretExportGrant({ ...target, repository: 'other' })).rejects.toThrow(
      '解锁',
    )
    expect(await readPlainSecretExportGrant({ ...target, repository: 'other' })).toBe('')
  })
  it('does not carry an authorization to a different destination and clears it explicitly', async () => {
    const target = {
      provider: 'github' as const,
      owner: 'Owner',
      repository: 'private-backup',
      retention: 7,
      autoBackup: true,
    }
    await savePlainSecretExportGrant(target, 'viewing-password')
    expect(await readPlainSecretExportGrant({ ...target, owner: 'owner' })).toBe('viewing-password')
    expect(await readPlainSecretExportGrant({ ...target, repository: 'other' })).toBe('')
    await clearPlainSecretExportGrant(target)
    expect(await readPlainSecretExportGrant(target)).toBe('')
    expect(stored.size).toBe(0)
  })
})

describe('cloud resource selection', () => {
  it('按统一选择树的资源 ID 限制云快照内容', () => {
    const resources = [
      { id: 'card', type: 'characterCard', metadata: {} },
      { id: 'extra', type: 'extraStory', metadata: {} },
      { id: 'excluded', type: 'characterCard', metadata: { cloudBackupExcluded: true } },
    ] as never[]
    expect(
      selectCloudResources(resources, { resourceIds: ['extra'] }).map((item) => item.id),
    ).toEqual(['extra'])
  })
})
