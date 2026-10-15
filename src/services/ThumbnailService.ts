import type { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import type { ThumbnailLevel } from '../types/Asset'
import { createImageThumbnail } from '../utils/createImageThumbnail'

const EDGE: Record<Exclude<ThumbnailLevel, 'original'>, number> = {
  tiny: 128,
  card: 320,
  preview: 640,
}

export class ThumbnailService {
  private readonly assets: IndexedDbAssetStore
  private readonly pending = new Map<string, Promise<Blob | undefined>>()

  constructor(assets: IndexedDbAssetStore) {
    this.assets = assets
  }

  getOrCreate(assetId: string, level: ThumbnailLevel): Promise<Blob | undefined> {
    const key = `${assetId}:${level}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.createThumbnail(assetId, level).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  /** Optional derived image: failure preserves the already stored full preview. */
  async prepareCard(assetId: string): Promise<boolean> {
    try {
      return Boolean(await this.getOrCreate(assetId, 'card'))
    } catch {
      return false
    }
  }

  private async createThumbnail(assetId: string, level: ThumbnailLevel): Promise<Blob | undefined> {
    const asset = await this.assets.get(assetId)
    if (!asset) return undefined
    if (level === 'original') return this.assets.getBlob(assetId)
    const existingId = asset.thumbnailRefs[level]
    if (existingId) return this.assets.getBlob(existingId)
    const original = await this.assets.getBlob(assetId)
    if (!original?.type.startsWith('image/')) return undefined
    const thumbnail = await createImageThumbnail(original, { maxEdge: EDGE[level] })
    if (!thumbnail) return undefined
    const stored = await this.assets.put(thumbnail, { source: 'thumbnail' })
    await this.assets.setThumbnailRef(assetId, level, stored.assetId)
    return thumbnail
  }
}
