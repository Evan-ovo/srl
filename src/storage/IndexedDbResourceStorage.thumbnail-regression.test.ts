import 'fake-indexeddb/auto'

import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: vi.fn(async () => new Blob(['generated-thumb'], { type: 'image/webp' })),
}))

import { AppDatabase } from '../database/AppDatabase'
import { VaultService } from '../services/VaultService'
import {
  RESOURCE_TYPE,
  toResourceListSummary,
  toResourceSummary,
  type Resource,
} from '../types/Resource'
import { IndexedDbResourceStorage } from './IndexedDbResourceStorage'
import { createImageThumbnail } from '../utils/createImageThumbnail'
import { IndexedDbAssetStore } from './IndexedDbAssetStore'

it('prepares existing covers without hydrating originals, checkpoints a stopped batch and resumes only explicitly', async () => {
  const database = new AppDatabase(`thumbnail-card-preparation-${crypto.randomUUID()}`)
  const assets = new IndexedDbAssetStore(database)
  const storage = new IndexedDbResourceStorage(database, undefined, assets)
  const ids: string[] = []
  for (const id of ['a', 'b']) {
    const asset = await assets.put(new Blob([`preview-${id}`], { type: 'image/webp' }), {
      source: 'thumbnail',
    })
    ids.push(asset.assetId)
    const resource = {
      ...createResource(1),
      id,
      thumbnailBlob: undefined,
      thumbnailAssetId: asset.assetId,
    }
    await database.resources.put(resource)
    await database.resourceSummaries.put(toResourceSummary(resource))
    await database.resourceListSummaries.put(toResourceListSummary(resource))
  }
  const originalRead = vi.spyOn(storage, 'get')
  const controller = new AbortController()
  vi.mocked(createImageThumbnail)
    .mockClear()
    .mockImplementationOnce(async () => {
      controller.abort()
      return new Blob(['prepared-card'], { type: 'image/webp' })
    })
  await expect(
    storage.repairMissingPngCharacterCardThumbnails({ signal: controller.signal }),
  ).rejects.toThrow()
  expect(createImageThumbnail).toHaveBeenCalledTimes(1)
  expect((await assets.get(ids[0]!))?.thumbnailRefs.card).toBeTruthy()
  expect((await assets.get(ids[1]!))?.thumbnailRefs.card).toBeUndefined()
  expect(
    (await database.settings.get('repair.resourceThumbnails.missingPng.v28'))?.value,
  ).toMatchObject({ status: 'running', checkpoint: 'a', repaired: 1 })
  await storage.repairMissingPngCharacterCardThumbnails({ signal: new AbortController().signal })
  expect((await assets.get(ids[1]!))?.thumbnailRefs.card).toBeTruthy()
  expect(originalRead).not.toHaveBeenCalled()
  expect(createImageThumbnail).toHaveBeenCalledTimes(2)
  expect(await storage.repairMissingPngCharacterCardThumbnails()).toBe(0)
  database.close()
  await database.delete()
})

function createResource(index: number): Resource {
  const original = new Uint8Array(64 * 1024)
  original[0] = index % 255
  return {
    id: `thumbnail-regression-${index}`,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: `缩略图回归 ${index}`,
    description: '模拟 PNG 角色卡',
    fileName: `thumbnail-regression-${index}.png`,
    mimeType: 'image/png',
    fileSize: original.byteLength,
    contentHash: index.toString(16).padStart(64, '0'),
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    tags: [],
    metadata: { parserVersion: 5 },
    thumbnailBlob: new Blob([new Uint8Array(128)], { type: 'image/webp' }),
    originalBlob: new Blob([original], { type: 'image/png' }),
    createdAt: index,
    updatedAt: index,
  }
}

describe('IndexedDbResourceStorage thumbnail regression', () => {
  it('uses AssetStore when a VaultService instance exists but the vault is disabled', async () => {
    const database = new AppDatabase(`thumbnail-disabled-vault-${crypto.randomUUID()}`)
    const vault = new VaultService(database)
    await vault.initialize()
    expect(vault.isEnabled()).toBe(false)

    const storage = new IndexedDbResourceStorage(database, vault)
    const resource = createResource(1)
    await storage.save(resource)

    const stored = await database.resources.get(resource.id)
    const summary = await database.resourceSummaries.get(resource.id)
    const listSummary = await database.resourceListSummaries.get(resource.id)
    const assetId = stored && !('encrypted' in stored) ? stored.thumbnailAssetId : undefined

    expect(assetId).toMatch(/^asset-/u)
    expect(stored).toMatchObject({ thumbnailAssetId: assetId })
    expect(stored && !('encrypted' in stored) ? stored.thumbnailBlob : undefined).toBeUndefined()
    expect(summary).toMatchObject({ thumbnailAssetId: assetId })
    expect(summary && !('encrypted' in summary) ? summary.thumbnailBlob : undefined).toBeUndefined()
    expect(listSummary).toMatchObject({ thumbnailAssetId: assetId })
    expect(
      listSummary && !('encrypted' in listSummary) ? listSummary.thumbnailBlob : undefined,
    ).toBeUndefined()
    expect(await database.assetFiles.count()).toBe(2)
    expect((await database.assets.get(assetId!))?.thumbnailRefs.card).toMatch(/^asset-/u)
    await expect(
      (await storage.get(resource.id))?.thumbnailBlob?.arrayBuffer(),
    ).resolves.toHaveProperty('byteLength', 128)

    database.close()
    await database.delete()
  })

  it('repairs v0.0.60 records created after the v23 migration had already completed', async () => {
    const database = new AppDatabase(`thumbnail-v24-repair-${crypto.randomUUID()}`)
    const current = createResource(2)
    const historical: Resource = {
      ...createResource(3),
      id: 'thumbnail-regression-history',
      versionGroupId: current.id,
      versionLabel: '历史 PNG',
    }

    await database.resources.put(current)
    await database.resourceSummaries.put(toResourceSummary(current))
    await database.resourceListSummaries.put(toResourceListSummary(current))
    await database.resourceVersions.put(historical)
    await database.resourceVersionSummaries.put(toResourceSummary(historical))
    await database.settings.put({
      id: 'migration.resourceThumbnails.asset.v23',
      value: {
        version: 23,
        status: 'complete',
        stage: 'complete',
        migrated: 0,
      },
      updatedAt: Date.now(),
    })

    const vault = new VaultService(database)
    await vault.initialize()
    const storage = new IndexedDbResourceStorage(database, vault)
    await storage.repairThumbnailAssets()

    const list = await storage.listResourceListSummaries()
    const versionSummaries = await storage.listVersionSummaries()
    const storedCurrent = await database.resources.get(current.id)
    const storedHistorical = await database.resourceVersions.get(historical.id)
    const storedSummary = await database.resourceSummaries.get(current.id)
    const storedListSummary = await database.resourceListSummaries.get(current.id)
    const storedVersionSummary = await database.resourceVersionSummaries.get(historical.id)
    const currentAssetId =
      storedCurrent && !('encrypted' in storedCurrent) ? storedCurrent.thumbnailAssetId : undefined
    const historicalAssetId =
      storedHistorical && !('encrypted' in storedHistorical)
        ? storedHistorical.thumbnailAssetId
        : undefined

    expect(currentAssetId).toMatch(/^asset-/u)
    expect(historicalAssetId).toBe(currentAssetId)
    expect(storedCurrent).toMatchObject({ thumbnailAssetId: currentAssetId })
    expect(
      storedCurrent && !('encrypted' in storedCurrent) ? storedCurrent.thumbnailBlob : undefined,
    ).toBeUndefined()
    expect(storedHistorical).toMatchObject({ thumbnailAssetId: historicalAssetId })
    expect(
      storedHistorical && !('encrypted' in storedHistorical)
        ? storedHistorical.thumbnailBlob
        : undefined,
    ).toBeUndefined()
    expect(storedSummary).toMatchObject({ thumbnailAssetId: currentAssetId })
    expect(
      storedSummary && !('encrypted' in storedSummary) ? storedSummary.thumbnailBlob : undefined,
    ).toBeUndefined()
    expect(storedListSummary).toMatchObject({ thumbnailAssetId: currentAssetId })
    expect(
      storedListSummary && !('encrypted' in storedListSummary)
        ? storedListSummary.thumbnailBlob
        : undefined,
    ).toBeUndefined()
    expect(storedVersionSummary).toMatchObject({ thumbnailAssetId: historicalAssetId })
    expect(
      storedVersionSummary && !('encrypted' in storedVersionSummary)
        ? storedVersionSummary.thumbnailBlob
        : undefined,
    ).toBeUndefined()
    expect(list.find((item) => item.id === current.id)?.thumbnailAssetId).toBe(currentAssetId)
    expect(versionSummaries.find((item) => item.id === historical.id)?.thumbnailAssetId).toBe(
      historicalAssetId,
    )
    expect(await database.assetFiles.count()).toBe(1)
    await expect(
      database.settings.get('repair.resourceThumbnails.asset.v24'),
    ).resolves.toMatchObject({
      value: {
        version: 24,
        status: 'complete',
        stage: 'complete',
        repaired: 2,
      },
    })
    await expect(
      (await storage.get(current.id))?.thumbnailBlob?.arrayBuffer(),
    ).resolves.toHaveProperty('byteLength', 128)

    database.close()
    await database.delete()
  })

  it('backfills missing previews for already-imported PNG character cards', async () => {
    const database = new AppDatabase(`thumbnail-v27-repair-${crypto.randomUUID()}`)
    const resource = createResource(4)
    resource.thumbnailBlob = undefined
    await database.resources.put(resource)
    await database.resourceSummaries.put(toResourceSummary(resource))
    await database.resourceListSummaries.put(toResourceListSummary(resource))
    await database.settings.put({
      id: 'repair.resourceThumbnails.missingPng.v26',
      value: { version: 26, status: 'complete', checkpoint: resource.id, repaired: 0 },
      updatedAt: Date.now(),
    })

    const vault = new VaultService(database)
    await vault.initialize()
    const storage = new IndexedDbResourceStorage(database, vault)
    vi.mocked(createImageThumbnail).mockClear()
    await storage.repairMissingPngCharacterCardThumbnails()
    expect(await storage.repairMissingPngCharacterCardThumbnails()).toBe(0)

    const stored = await database.resources.get(resource.id)
    const summary = await database.resourceSummaries.get(resource.id)
    const listSummary = await database.resourceListSummaries.get(resource.id)
    const assetId = stored && !('encrypted' in stored) ? stored.thumbnailAssetId : undefined

    expect(createImageThumbnail).toHaveBeenCalledWith(resource.originalBlob, {
      maxEdge: 640,
      allowImageElement: true,
    })
    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    expect(assetId).toMatch(/^asset-/u)
    expect(summary).toMatchObject({ thumbnailAssetId: assetId })
    expect(listSummary).toMatchObject({ thumbnailAssetId: assetId })
    expect((await storage.listResourceListSummaries())[0]?.thumbnailAssetId).toBe(assetId)
    await expect((await storage.get(resource.id))?.thumbnailBlob?.text()).resolves.toBe(
      'generated-thumb',
    )
    await expect(
      database.settings.get('repair.resourceThumbnails.missingPng.v28'),
    ).resolves.toMatchObject({ value: { version: 28, status: 'complete', repaired: 1 } })

    const later = createResource(1) // Its ID is below the completed scan's checkpoint.
    later.thumbnailBlob = undefined
    await database.resources.put(later)
    await database.resourceSummaries.put(toResourceSummary(later))
    await database.resourceListSummaries.put(toResourceListSummary(later))
    expect(await storage.repairMissingPngCharacterCardThumbnails()).toBe(0)
    expect(await storage.repairMissingPngCharacterCardThumbnails({ restart: true })).toBe(1)
    expect(createImageThumbnail).toHaveBeenCalledTimes(3)
    expect((await storage.listResourceListSummaries()).every((item) => item.thumbnailAssetId)).toBe(
      true,
    )
    expect(await database.resources.get(resource.id)).toMatchObject({ thumbnailAssetId: assetId })

    database.close()
    await database.delete()
  })

  it('keeps startup thumbnail maintenance from scanning old PNG originals', async () => {
    const database = new AppDatabase(`thumbnail-manual-only-${crypto.randomUUID()}`)
    const resource = createResource(5)
    resource.thumbnailBlob = undefined
    await database.resources.put(resource)
    await database.resourceSummaries.put(toResourceSummary(resource))
    await database.resourceListSummaries.put(toResourceListSummary(resource))
    await database.settings.put({
      id: 'repair.resourceThumbnails.missingPng.v27',
      value: { version: 27, status: 'complete', checkpoint: resource.id, repaired: 1 },
      updatedAt: Date.now(),
    })

    const vault = new VaultService(database)
    await vault.initialize()
    const storage = new IndexedDbResourceStorage(database, vault)
    vi.mocked(createImageThumbnail).mockClear()
    await storage.repairThumbnailAssets()

    expect(createImageThumbnail).not.toHaveBeenCalled()
    expect(await database.settings.get('repair.resourceThumbnails.missingPng.v28')).toBeUndefined()
    expect(await storage.getMissingPngThumbnailRepairStatus()).toEqual({
      status: 'not-started',
      repaired: 0,
    })

    database.close()
    await database.delete()
  })

  it('resumes a v27 interrupted scan from its saved checkpoint', async () => {
    const database = new AppDatabase(`thumbnail-resume-v27-${crypto.randomUUID()}`)
    const checkpoint = createResource(6)
    const pending = createResource(7)
    checkpoint.thumbnailBlob = undefined
    pending.thumbnailBlob = undefined
    for (const resource of [checkpoint, pending]) {
      await database.resources.put(resource)
      await database.resourceSummaries.put(toResourceSummary(resource))
      await database.resourceListSummaries.put(toResourceListSummary(resource))
    }
    await database.settings.put({
      id: 'repair.resourceThumbnails.missingPng.v27',
      value: {
        version: 27,
        status: 'running',
        checkpoint: checkpoint.id,
        repaired: 2,
      },
      updatedAt: Date.now(),
    })

    const vault = new VaultService(database)
    await vault.initialize()
    const storage = new IndexedDbResourceStorage(database, vault)
    vi.mocked(createImageThumbnail).mockClear()
    expect(await storage.repairMissingPngCharacterCardThumbnails()).toBe(3)

    expect(createImageThumbnail).toHaveBeenCalledTimes(2)
    expect(await database.settings.get('repair.resourceThumbnails.missingPng.v28')).toMatchObject({
      value: { status: 'complete', repaired: 3 },
    })
    expect((await storage.get(checkpoint.id))?.thumbnailAssetId).toBeUndefined()
    expect((await storage.get(pending.id))?.thumbnailAssetId).toMatch(/^asset-/u)

    database.close()
    await database.delete()
  })
})
