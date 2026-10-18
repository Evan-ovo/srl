import 'fake-indexeddb/auto'

import { describe, expect, it, vi } from 'vitest'
import { GreetingResourceService } from './GreetingResourceService'
import { ResourceService } from './ResourceService'
import { RESOURCE_TYPE, toResourceListSummary, type Resource } from '../types/Resource'
import type { ImportResult } from '../types/Import'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { parseGreetingResource } from '../types/GreetingResource'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { VaultService } from './VaultService'

function hash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

function greeting(id: string, text: string): Resource {
  const json = JSON.stringify({
    format: 'srl-greeting',
    version: 1,
    name: id,
    first_mes: text,
    alternate_greetings: [],
    companion_scripts: [],
  })
  return {
    id,
    type: 'greeting',
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: new Blob([json]).size,
    categoryId: null,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    contentHash: hash(json),
    tags: [],
    metadata: {},
    originalBlob: new Blob([json]),
  }
}

function catalogue(resources: Resource[]) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]))
  const get = vi.fn(async (id: string) => byId.get(id))
  const list = vi.fn(async () => [...byId.values()].map(toResourceListSummary))
  const importPreparedFile = vi.fn(async () => ({
    status: 'imported',
    resource: greeting('new', 'new'),
  }))
  const service = new GreetingResourceService({
    get,
    importPreparedFile,
    listResourceListSummaries: list,
  } as unknown as ResourceService)
  return { service, get, list, importPreparedFile, byId }
}
describe('GreetingResourceService content reuse', () => {
  it('announces the committed ID only after import and serializes a duplicate save without another write', async () => {
    const item = greeting('committed', 'one')
    const committed: Resource[] = []
    let finish!: (result: ImportResult) => void
    const importPreparedFile = vi.fn(
      () =>
        new Promise<ImportResult>((resolve) => {
          finish = resolve
        }),
    )
    const service = new GreetingResourceService({
      get: async (id: string) => committed.find((resource) => resource.id === id),
      listResourceListSummaries: async () => committed.map(toResourceListSummary),
      importPreparedFile,
    } as unknown as ResourceService)
    const saved = vi.fn()
    const unsubscribe = service.onSaved(saved)
    const file = new File([item.originalBlob], 'one.json')
    const first = service.save(file)
    const second = service.save(file)
    await vi.waitFor(() => expect(importPreparedFile).toHaveBeenCalledOnce())
    expect(saved).not.toHaveBeenCalled()
    committed.push(item)
    finish({ status: 'imported', fileName: file.name, resource: item })
    await expect(Promise.all([first, second])).resolves.toEqual([item, item])
    expect(importPreparedFile).toHaveBeenCalledOnce()
    expect(saved.mock.calls).toEqual([
      ['committed', true],
      ['committed', false],
    ])
    unsubscribe()
    await expect(service.save(file)).resolves.toBe(item)
    expect(saved).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'preserves the import owner duplicate change flag (%s)',
    async (reclassified) => {
      const item = greeting('duplicate', 'one')
      const service = new GreetingResourceService({
        listResourceListSummaries: async () => [],
        importPreparedFile: async () => ({ status: 'duplicate', resource: item, reclassified }),
      } as unknown as ResourceService)
      const saved = vi.fn()
      service.onSaved(saved)
      await expect(service.save(new File([item.originalBlob], 'one.json'))).resolves.toBe(item)
      expect(saved).toHaveBeenCalledExactlyOnceWith(item.id, reclassified)
    },
  )

  it.each(['failed', 'versionCandidate'])(
    'does not announce uncommitted %s results and permits a later save',
    async (status) => {
      const item = greeting('retry', 'one')
      const importPreparedFile = vi
        .fn()
        .mockResolvedValueOnce({ status, message: 'synthetic failure' })
        .mockResolvedValueOnce({ status: 'imported', resource: item })
      const service = new GreetingResourceService({
        listResourceListSummaries: async () => [],
        importPreparedFile,
      } as unknown as ResourceService)
      const saved = vi.fn()
      service.onSaved(saved)
      const file = new File([item.originalBlob], 'one.json')
      await expect(service.save(file)).rejects.toThrow(
        status === 'failed' ? 'synthetic failure' : '开场白保存失败',
      )
      expect(saved).not.toHaveBeenCalled()
      await expect(service.save(file)).resolves.toBe(item)
      expect(saved).toHaveBeenCalledExactlyOnceWith(item.id, true)
    },
  )

  it.each(['version', 'new'] as const)(
    'reports the committed character ID when applying a greeting as %s',
    async (mode) => {
      const item = greeting('greeting', 'replacement')
      const character: Resource = {
        ...greeting('character', 'old'),
        type: RESOURCE_TYPE.CHARACTER_CARD,
        metadata: { card: { name: 'character', description: 'fixture', first_mes: 'old' } },
      }
      const committed = {
        ...character,
        id: mode === 'new' ? 'new-character' : character.id,
        contentHash: 'committed-hash',
      }
      const importAsVersion = vi
        .fn<ResourceService['importAsVersion']>()
        .mockResolvedValue(committed)
      const importPreparedFile = vi.fn<ResourceService['importPreparedFile']>().mockResolvedValue({
        status: 'imported',
        fileName: committed.fileName,
        resource: committed,
      })
      const service = new GreetingResourceService({
        get: async (id: string) => (id === item.id ? item : character),
        importAsVersion,
        importPreparedFile,
      } as unknown as ResourceService)
      const saved = vi.fn()
      service.onSaved(saved)
      await expect(service.apply(item.id, character.id, mode, character.contentHash)).resolves.toBe(
        committed,
      )
      expect(saved).toHaveBeenCalledExactlyOnceWith(committed.id, true)
      const writer = mode === 'version' ? importAsVersion : importPreparedFile
      expect(writer).toHaveBeenCalledOnce()
      const file = writer.mock.calls[0]![0]
      expect(JSON.parse(await file.text()).first_mes).toBe('replacement')
    },
  )

  it('reuses semantic digests, scopes the catalogue and reads the live matched resource', async () => {
    const first = greeting('a', 'one'),
      second = greeting('b', 'two')
    const firstText = vi.spyOn(first.originalBlob, 'text'),
      secondText = vi.spyOn(second.originalBlob, 'text')
    const get = vi.fn(async (id: string) => (id === 'a' ? first : second))
    const list = vi.fn(async () => [first, second].map(toResourceListSummary))
    const service = new GreetingResourceService({
      get,
      listResourceListSummaries: list,
    } as unknown as ResourceService)
    const saved = vi.fn()
    service.onSaved(saved)
    const file = new File([second.originalBlob], 'different-name.json')
    expect((await service.save(file)).id).toBe('b')
    expect((await service.save(file)).id).toBe('b')
    expect(list).toHaveBeenCalledWith({ types: ['greeting'] })
    expect(get).toHaveBeenCalledTimes(3)
    expect(firstText).toHaveBeenCalledTimes(1)
    expect(secondText).toHaveBeenCalledTimes(1)
    expect(saved.mock.calls).toEqual([
      ['b', false],
      ['b', false],
    ])
    const changed = greeting('a', 'changed')
    first.contentHash = 'new-hash'
    first.originalBlob = changed.originalBlob
    expect((await service.save(new File([changed.originalBlob], 'changed.json'))).id).toBe('a')
    expect(saved).toHaveBeenLastCalledWith('a', false)
  })
  it('does not return a cached match deleted after the catalogue was read', async () => {
    const item = greeting('a', 'one')
    const get = vi.fn(async () => item as Resource | undefined)
    const importPreparedFile = vi.fn(async () => ({
      status: 'imported',
      resource: greeting('new', 'one'),
    }))
    const service = new GreetingResourceService({
      get,
      importPreparedFile,
      listResourceListSummaries: async () => [toResourceListSummary(item)],
    } as unknown as ResourceService)
    const file = new File([item.originalBlob], 'one.json')
    expect((await service.save(file)).id).toBe('a')
    get.mockResolvedValue(undefined)
    expect((await service.save(file)).id).toBe('new')
    expect(importPreparedFile).toHaveBeenCalledTimes(1)
  })

  it('matches the phase-1 semantic result at 10k without its sequential LRU thrash', async () => {
    const resources = Array.from({ length: 10_000 }, (_, index) =>
      greeting(`g-${index}`, `body-${index}`),
    )
    const target = resources.at(-1)!
    const file = new File([target.originalBlob], 'renamed.json')
    // Exact phase-1 lookup/cache policy, retained only as a differential fixture.
    const baselineCache = new Map<string, string>()
    let baselineReads = 0
    const baseline = async () => {
      const signature = hash(JSON.stringify(['body-9999', [], []]))
      for (const resource of resources) {
        const cached = baselineCache.get(resource.contentHash)
        if (cached && cached !== signature) continue
        if (cached === signature) return resource.id
        baselineReads += 1
        const document = parseGreetingResource(JSON.parse(await resource.originalBlob.text()))
        const digest = hash(
          JSON.stringify([
            document.first_mes,
            document.alternate_greetings,
            document.companion_scripts,
          ]),
        )
        baselineCache.delete(resource.contentHash)
        baselineCache.set(resource.contentHash, digest)
        if (baselineCache.size > 512) baselineCache.delete(baselineCache.keys().next().value!)
        if (digest === signature) return resource.id
      }
    }
    expect(await baseline()).toBe(target.id)
    expect(await baseline()).toBe(target.id)
    expect(baselineReads).toBe(20_000)

    const { service, get, importPreparedFile } = catalogue(resources)
    const texts = resources.map((resource) => vi.spyOn(resource.originalBlob, 'text'))
    expect((await service.save(file)).id).toBe(target.id)
    expect(get).toHaveBeenCalledTimes(10_000)
    expect(texts.reduce((sum, text) => sum + text.mock.calls.length, 0)).toBe(10_000)
    get.mockClear()
    expect((await service.save(file)).id).toBe(target.id)
    expect(get).toHaveBeenCalledExactlyOnceWith(target.id)
    expect(texts.reduce((sum, text) => sum + text.mock.calls.length, 0)).toBe(10_000)
    expect(importPreparedFile).not.toHaveBeenCalled()
  }, 20_000)

  it('keeps admission bounded without evicting the reusable prefix when the catalogue exceeds capacity', async () => {
    const resources = Array.from({ length: 16_400 }, (_, index) =>
      greeting(`g-${index}`, `body-${index}`),
    )
    const target = resources.at(-1)!
    const { service, get, byId } = catalogue(resources)
    const file = new File([target.originalBlob], 'last.json')
    await service.save(file)
    get.mockClear()
    await service.save(file)
    expect(get).toHaveBeenCalledTimes(16)
    // A removed entry releases capacity for a changed/new original.
    byId.delete(resources[0]!.id)
    get.mockClear()
    await service.save(file)
    expect(get).toHaveBeenCalledTimes(16)
    get.mockClear()
    await service.save(file)
    expect(get).toHaveBeenCalledTimes(15)
  }, 20_000)

  it.each([true, false])(
    'ignores restored semantic hints for both positive and negative decisions (forgedMatch=%s)',
    async (forgedMatch) => {
      const item = greeting('a', 'one')
      const target = forgedMatch ? greeting('incoming', 'different') : item
      item.metadata = {
        greetingFingerprintVersion: 1,
        greetingSourceHash: item.contentHash,
        greetingSemanticHash: hash(
          JSON.stringify([forgedMatch ? 'different' : 'unrelated', [], []]),
        ),
      }
      const { service, get, importPreparedFile } = catalogue([item])
      const text = vi.spyOn(item.originalBlob, 'text')
      expect((await service.save(new File([target.originalBlob], 'incoming.json'))).id).toBe(
        forgedMatch ? 'new' : item.id,
      )
      expect(get).toHaveBeenCalledExactlyOnceWith(item.id)
      expect(text).toHaveBeenCalledOnce()
      expect(importPreparedFile).toHaveBeenCalledTimes(forgedMatch ? 1 : 0)
    },
  )

  it('does not return a cached positive when the live original or type has changed', async () => {
    const item = greeting('a', 'old')
    const { service, get, importPreparedFile } = catalogue([item])
    await service.save(new File([item.originalBlob], 'old.json'))
    const changed = greeting('a', 'changed')
    get.mockResolvedValue(changed)
    expect((await service.save(new File([item.originalBlob], 'old.json'))).id).toBe('new')
    expect(importPreparedFile).toHaveBeenCalledOnce()
    importPreparedFile.mockClear()
    get.mockResolvedValue({ ...item, type: RESOURCE_TYPE.WORLD_BOOK })
    expect((await service.save(new File([item.originalBlob], 'old.json'))).id).toBe('new')
    expect(importPreparedFile).toHaveBeenCalledOnce()
  })

  it('invalidates negative digests for a changed original and removes deleted catalogue hashes', async () => {
    const first = greeting('a', 'one')
    const second = greeting('b', 'two')
    const { service, byId, get } = catalogue([first, second])
    await service.save(new File([second.originalBlob], 'two.json'))
    const changed = greeting('a', 'changed')
    byId.set(changed.id, changed)
    byId.delete(second.id)
    get.mockClear()
    expect(await service.save(new File([changed.originalBlob], 'changed.json'))).toBe(changed)
    expect(get).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('skips malformed originals without caching a transient byte-read failure', async () => {
    const broken = {
      ...greeting('broken', 'ignored'),
      originalBlob: new Blob(['{']),
      contentHash: hash('{'),
    }
    const item = greeting('a', 'one')
    const { service, get, importPreparedFile } = catalogue([broken, item])
    const text = vi.spyOn(broken.originalBlob, 'text')
    const file = new File([item.originalBlob], 'one.json')
    await service.save(file)
    get.mockClear()
    await service.save(file)
    expect(get).toHaveBeenCalledExactlyOnceWith('a')
    expect(text).toHaveBeenCalledOnce()
    expect(importPreparedFile).not.toHaveBeenCalled()

    const next = greeting('transient', 'next')
    const transient = catalogue([next])
    vi.spyOn(next.originalBlob, 'text').mockRejectedValueOnce(new Error('synthetic read failed'))
    const nextFile = new File([next.originalBlob], 'next.json')
    await expect(transient.service.save(nextFile)).rejects.toThrow('synthetic read failed')
    expect(transient.importPreparedFile).not.toHaveBeenCalled()
    await expect(transient.service.save(nextFile)).resolves.toBe(next)
  })

  it('does not bypass vault catalogue/live-read rejection and retries after unlocking', async () => {
    const item = greeting('a', 'one')
    const { service, list, get, importPreparedFile } = catalogue([item])
    const file = new File([item.originalBlob], 'one.json')
    await service.save(file)
    list.mockRejectedValueOnce(new Error('本地保险库已锁定'))
    await expect(service.save(file)).rejects.toThrow('本地保险库已锁定')
    get.mockRejectedValueOnce(new Error('本地保险库已锁定'))
    await expect(service.save(file)).rejects.toThrow('本地保险库已锁定')
    expect(importPreparedFile).not.toHaveBeenCalled()
    await expect(service.save(file)).resolves.toBe(item)
  })

  it('retains verified digests after an invalid incoming file', async () => {
    const first = greeting('a', 'one'),
      second = greeting('b', 'two')
    const { service, get } = catalogue([first, second])
    const file = new File([second.originalBlob], 'two.json')
    await service.save(file)
    await expect(service.save(new File(['{'], 'invalid.json'))).rejects.toThrow()
    get.mockClear()
    await service.save(file)
    expect(get).toHaveBeenCalledExactlyOnceWith(second.id)
  })

  it.each([false, true])(
    'ignores forged restore hints through reopen and preserves encrypted vault access (vault=%s)',
    async (encrypted) => {
      const database = new AppDatabase(`greeting-signatures-${crypto.randomUUID()}`)
      const vault = new VaultService(database)
      try {
        await vault.initialize()
        if (encrypted) await vault.enable('synthetic-greeting-password')
        const storage = new IndexedDbResourceStorage(database, vault)
        const resources = new ResourceService(
          storage,
          new ResourceParserRegistry([new JsonResourceParser()]),
          async () => undefined,
        )
        const file = new File([greeting('source', 'one').originalBlob], 'source.json', {
          type: 'application/json',
        })
        const saved = await new GreetingResourceService(resources).save(file)
        saved.metadata = {
          ...saved.metadata,
          greetingFingerprintVersion: 1,
          greetingSourceHash: saved.contentHash,
          greetingSemanticHash: hash(JSON.stringify(['forged content', [], []])),
        }
        await storage.update(saved.id, { metadata: saved.metadata })
        const stored = await database.resourceListSummaries.get(saved.id)
        if (encrypted) {
          expect(stored).not.toHaveProperty('metadata')
          expect(stored).not.toHaveProperty('type')
        }
        database.close()
        await database.open()
        const reopened = new ResourceService(
          new IndexedDbResourceStorage(database, vault),
          new ResourceParserRegistry([new JsonResourceParser()]),
          async () => undefined,
        )
        const get = vi.spyOn(reopened, 'get')
        const service = new GreetingResourceService(reopened)
        const renamed = new File(
          [JSON.stringify({ ...JSON.parse(await file.text()), name: 'renamed' })],
          'renamed.json',
        )
        expect((await service.save(renamed)).id).toBe(saved.id)
        expect(get).toHaveBeenCalledExactlyOnceWith(saved.id)
        // A restore replacing the original invalidates the verified in-memory digest.
        const changed = greeting(saved.id, 'replacement')
        await storage.update(saved.id, {
          originalBlob: changed.originalBlob,
          contentHash: changed.contentHash,
          fileSize: changed.fileSize,
          metadata: saved.metadata,
        })
        const replacement = new File([changed.originalBlob], 'replacement.json')
        expect((await service.save(replacement)).id).toBe(saved.id)
        if (encrypted) {
          vault.lock()
          await expect(service.save(replacement)).rejects.toThrow('保险库已锁定')
          await vault.unlock('synthetic-greeting-password')
          expect((await service.save(replacement)).id).toBe(saved.id)
        }
        expect(await database.resources.count()).toBe(1)
      } finally {
        database.close()
        await database.delete()
      }
    },
  )

  it('refreshes a concurrent writer on the next save without claiming atomic catalogue-to-import semantics', async () => {
    const first = greeting('a', 'one'),
      second = greeting('b', 'two')
    const { service, list, byId, importPreparedFile } = catalogue([first, second])
    await service.save(new File([second.originalBlob], 'two.json'))
    const changed = greeting('a', 'replacement')
    const incoming = greeting('incoming', 'replacement')
    list.mockImplementationOnce(async () => {
      const snapshot = [...byId.values()].map(toResourceListSummary)
      // Another instance commits after the catalogue snapshot. The original
      // phase-1 cache has the same boundary; import remains its owner's job.
      byId.set(changed.id, changed)
      return snapshot
    })
    const file = new File([incoming.originalBlob], 'incoming.json')
    await service.save(file)
    expect(importPreparedFile).toHaveBeenCalledOnce()
    importPreparedFile.mockClear()
    expect(await service.save(file)).toBe(changed)
    expect(importPreparedFile).not.toHaveBeenCalled()
  })
})
