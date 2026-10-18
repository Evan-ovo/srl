import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { JSON_RESOURCE_PARSER_VERSION } from '../parser/JsonResourceParser'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { RESOURCE_TYPE, toResourceSummary, type Resource } from '../types/Resource'
import {
  CHARACTER_CARD_FINGERPRINT_VERSION,
  computeCardFingerprints,
} from '../utils/CharacterCardFingerprint'
import { ResourceService } from './ResourceService'
import { VaultService } from './VaultService'

async function card(id: string, legacy = false): Promise<Resource> {
  const metadata: Record<string, unknown> = {
    parserVersion: JSON_RESOURCE_PARSER_VERSION,
    card: {
      data: {
        name: 'same card',
        description: 'card body '.repeat(4000),
        creator: 'nested creator',
        uuid: 'nested-identity',
      },
    },
    retained: { private: ['keep', 'unknown'] },
  }
  const fingerprints = (await computeCardFingerprints(metadata))!
  if (!legacy)
    Object.assign(metadata, {
      cardContentHash: fingerprints.full,
      cardCoreHash: fingerprints.core,
      cardFingerprintVersion: CHARACTER_CARD_FINGERPRINT_VERSION,
    })
  const originalBlob = new Blob([`original ${id}`])
  return {
    id,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: id,
    description: '',
    fileName: `${id}.png`,
    mimeType: 'image/png',
    fileSize: originalBlob.size,
    contentHash: `file-${id}`,
    originalBlob,
    metadata,
    tags: [],
    categoryId: null,
    relatedResourceIds: [],
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    versionCount: legacy ? 2 : 1,
  }
}

async function fixture(encrypted: boolean, legacy = false) {
  const database = new AppDatabase(`maintenance-${crypto.randomUUID()}`)
  const vault = encrypted ? new VaultService(database) : undefined
  await vault?.initialize()
  await vault?.enable('test-password')
  const storage = new IndexedDbResourceStorage(database, vault)
  const current = await card('current', legacy)
  const history = { ...(await card('history', legacy)), versionGroupId: current.id }
  await storage.save(current)
  await storage.saveVersion(history)
  return {
    database,
    storage,
    current,
    history,
    vault,
    service: new ResourceService(storage, new ResourceParserRegistry([])),
  }
}

it.each([false, true])(
  'healthy maintenance reads light summaries while explicit matching keeps nested identity (vault=%s)',
  async (encrypted) => {
    const { database, storage, service, current, history, vault } = await fixture(encrypted)
    try {
      await storage.listResourceListSummaries()
      // Older derived summaries can still contain full metadata. Preserve that
      // explicit matching input; modern compact indexes do not promise card bodies.
      const currentSummary = toResourceSummary(current),
        historySummary = toResourceSummary(history)
      await database.resourceSummaries.put(
        vault ? await vault.encodeResourceSummary(currentSummary) : currentSummary,
      )
      await database.resourceVersionSummaries.put(
        vault ? await vault.encodeResourceSummary(historySummary) : historySummary,
      )
      const fullCurrent = vi.spyOn(storage, 'listSummaries')
      const fullHistory = vi.spyOn(storage, 'listVersionSummaries')
      const lightCurrent = vi.spyOn(storage, 'listResourceListSummaries')
      const lightHistory = vi.spyOn(storage, 'listVersionListSummaries')
      const original = vi.spyOn(storage, 'get')
      const version = vi.spyOn(storage, 'getVersion')
      expect(await service.backfillCardFingerprints(async () => undefined)).toBe(0)
      expect(fullCurrent.mock.calls.length).toBe(0)
      expect(fullHistory.mock.calls.length).toBe(0)
      expect(lightCurrent).toHaveBeenCalledOnce()
      expect(lightHistory).toHaveBeenCalledOnce()
      expect(original.mock.calls.length + version.mock.calls.length).toBe(0)
      const snapshot = await service.loadVersionRecognitionSnapshot(async () => undefined)
      expect(fullCurrent).toHaveBeenCalledOnce()
      expect(fullHistory).toHaveBeenCalledOnce()
      for (const row of [...snapshot.resources, ...snapshot.versions]) {
        expect(row.metadata.card).toMatchObject({
          data: { creator: 'nested creator', uuid: 'nested-identity' },
        })
        expect(row.metadata.retained).toEqual({ private: ['keep', 'unknown'] })
        expect(row.versionCount).toBe(1)
      }
    } finally {
      await database.delete()
    }
  },
)

it.each([false, true])(
  'repairs only legacy card metadata and keeps original files and logical carrier counts (vault=%s)',
  async (encrypted) => {
    const { database, storage, service, current, history } = await fixture(encrypted, true)
    try {
      const original = vi.spyOn(storage, 'get')
      const version = vi.spyOn(storage, 'getVersion')
      expect(await service.backfillCardFingerprints(async () => undefined)).toBe(2)
      expect(original.mock.calls.length + version.mock.calls.length).toBe(0)
      expect(await service.backfillCardFingerprints(async () => undefined)).toBe(0)
      database.close()
      await database.open()
      const saved = (await storage.get(current.id))!
      const savedHistory = (await storage.getVersion(history.id))!
      expect(saved.metadata.cardContentHash).toBe(savedHistory.metadata.cardContentHash)
      expect(saved.versionCount).toBe(1)
      for (const [row, input] of [
        [saved, current],
        [savedHistory, history],
      ]) {
        expect(row!.metadata.retained).toEqual(input!.metadata.retained)
        expect(row!.metadata.card).toEqual(input!.metadata.card)
        expect(await row!.originalBlob.text()).toBe(await input!.originalBlob.text())
      }
    } finally {
      await database.delete()
    }
  },
)

it('checks a pause/lock arriving during reads before committing maintenance writes', async () => {
  const { database, storage, service } = await fixture(false, true)
  try {
    let stopped = false
    const list = storage.listVersionListSummaries.bind(storage)
    const fullList = storage.listVersionSummaries.bind(storage)
    vi.spyOn(storage, 'listVersionSummaries').mockImplementation(async () => {
      const rows = await fullList()
      stopped = true
      return rows
    })
    vi.spyOn(storage, 'listVersionListSummaries').mockImplementation(async () => {
      const rows = await list()
      stopped = true
      return rows
    })
    const write = vi.spyOn(storage, 'update')
    const historyWrite = vi.spyOn(storage, 'updateVersion')
    const checkpoint = async () => {
      if (stopped) throw new DOMException('paused', 'AbortError')
    }
    await expect(service.backfillCardFingerprints(checkpoint)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(write.mock.calls.length + historyWrite.mock.calls.length).toBe(0)
    stopped = false
    vi.restoreAllMocks()
    expect(await service.backfillCardFingerprints(checkpoint)).toBe(2)
  } finally {
    await database.delete()
  }
})

it('repairs a legacy regex display name using only its metadata and preserves unknown fields', async () => {
  const { database, storage, service } = await fixture(false)
  try {
    const regex: Resource = {
      ...(await card('regex')),
      type: RESOURCE_TYPE.REGEX,
      name: '全局正则',
      fileName: '用户规则.json',
      metadata: {
        parserVersion: JSON_RESOURCE_PARSER_VERSION,
        detectedVariant: 'regexCollection',
        regexScope: 'global',
        itemCount: 1,
        sourceName: '全局正则',
        retained: { value: 'keep' },
      },
    }
    await storage.save(regex)
    const original = vi.spyOn(storage, 'get')
    expect(await service.upgradeLegacyJsonResources(async () => undefined)).toBe(1)
    expect(original.mock.calls.length).toBe(0)
    expect(await storage.getSummary(regex.id)).toMatchObject({
      name: '用户规则',
      metadata: { retained: { value: 'keep' }, legacyGlobalRegexNameRepaired: true },
    })
  } finally {
    await database.delete()
  }
})
