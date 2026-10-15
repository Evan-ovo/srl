import { createImageThumbnail } from '../utils/createImageThumbnail'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { ThumbnailService } from './ThumbnailService'
import type { Resource } from '../types/Resource'

vi.mock('../utils/createImageThumbnail', () => ({
  createImageThumbnail: vi.fn(
    async (_blob: Blob, options: { maxEdge: number }) =>
      new Blob([String(options.maxEdge)], { type: 'image/webp' }),
  ),
}))

const databases: AppDatabase[] = []

it('keeps both references when different tiers finish concurrently', async () => {
  const database = new AppDatabase(`thumbnail-tiers-${crypto.randomUUID()}`)
  databases.push(database)
  const assets = new IndexedDbAssetStore(database)
  const asset = await assets.put(new Blob(['preview'], { type: 'image/webp' }), {
    source: 'thumbnail',
  })
  await Promise.all([
    assets.thumbnails.getOrCreate(asset.assetId, 'tiny'),
    assets.thumbnails.getOrCreate(asset.assetId, 'card'),
  ])
  expect((await assets.get(asset.assetId))?.thumbnailRefs).toEqual({
    tiny: expect.any(String),
    card: expect.any(String),
  })
})

it('preserves the full preview when optional card generation fails', async () => {
  const database = new AppDatabase(`thumbnail-optional-${crypto.randomUUID()}`)
  databases.push(database)
  const assets = new IndexedDbAssetStore(database)
  vi.mocked(createImageThumbnail).mockRejectedValueOnce(new Error('unsupported image'))
  const prepared = await assets.externalizeResourceThumbnail({
    type: 'characterCard',
    thumbnailBlob: new Blob(['full-preview'], { type: 'image/webp' }),
  } as Resource)
  expect(prepared.thumbnailBlob).toBeUndefined()
  expect((await assets.get(prepared.thumbnailAssetId!))?.thumbnailRefs.card).toBeUndefined()
  expect(await (await assets.getBlob(prepared.thumbnailAssetId!))?.text()).toBe('full-preview')
})
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.delete()))
})

describe('ThumbnailService', () => {
  it('stores independent tiny/card/preview assets and reuses each tier', async () => {
    const database = new AppDatabase(`thumbnail-${crypto.randomUUID()}`)
    databases.push(database)
    const assets = new IndexedDbAssetStore(database)
    const service = new ThumbnailService(assets)
    const original = await assets.put(new Blob(['image'], { type: 'image/png' }), {
      source: 'import',
    })

    const tiny = await service.getOrCreate(original.assetId, 'tiny')
    const card = await service.getOrCreate(original.assetId, 'card')
    const repeatedTiny = await service.getOrCreate(original.assetId, 'tiny')

    expect(await tiny?.text()).toBe('128')
    expect(await card?.text()).toBe('320')
    expect(repeatedTiny).toEqual(tiny)
    expect((await assets.get(original.assetId))?.thumbnailRefs).toMatchObject({
      tiny: expect.stringContaining('asset-'),
      card: expect.stringContaining('asset-'),
    })
  })
})

it('shares concurrent generation and releases a failed task for an explicit retry', async () => {
  const database = new AppDatabase(`thumbnail-concurrent-${crypto.randomUUID()}`)
  databases.push(database)
  const assets = new IndexedDbAssetStore(database)
  const service = new ThumbnailService(assets)
  const original = await assets.put(new Blob(['large image'], { type: 'image/png' }), {
    source: 'import',
  })
  vi.mocked(createImageThumbnail).mockClear()
  const [a, b] = await Promise.all([
    service.getOrCreate(original.assetId, 'tiny'),
    service.getOrCreate(original.assetId, 'tiny'),
  ])
  expect(a).toBe(b)
  expect(createImageThumbnail).toHaveBeenCalledTimes(1)
  vi.mocked(createImageThumbnail).mockRejectedValueOnce(new Error('decode failed'))
  await expect(service.getOrCreate(original.assetId, 'preview')).rejects.toThrow('decode failed')
  expect(await (await service.getOrCreate(original.assetId, 'preview'))?.text()).toBe('640')
})
