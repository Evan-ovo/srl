import type { AppDatabase } from '../database/AppDatabase'
import type { VaultService } from '../services/VaultService'
import { hashBlob } from '../services/HashService'
import type { AssetRecord, AssetSource, ThumbnailLevel } from '../types/Asset'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { Capacitor } from '@capacitor/core'
import { isAndroidNativeAppDatabaseActive, runAndroidNativeRead } from './AndroidNativeDexieCore'
import { nativeAppDatabase } from './NativeAppDatabaseBridge'
import { ThumbnailService } from '../services/ThumbnailService'

type AssetVault = Pick<VaultService, 'isEnabled' | 'protectBlob' | 'revealBlob'>

export class IndexedDbAssetStore {
  readonly thumbnails = new ThumbnailService(this)
  private readonly database: AppDatabase
  private readonly vault?: AssetVault
  private imageSourcesAvailable = true
  private readonly imageRequests = new Map<
    string,
    {
      assetId: string
      level: 'card' | 'preview'
      promise: Promise<string | undefined>
      resolve: (url?: string) => void
      reject: (error: unknown) => void
    }
  >()
  private imageBatchScheduled = false

  constructor(database: AppDatabase, vault?: AssetVault) {
    this.database = database
    this.vault = vault
  }

  get supportsImageUrls(): boolean {
    return (
      isAndroidNativeAppDatabaseActive() && this.imageSourcesAvailable && !this.vault?.isEnabled()
    )
  }

  async put(
    blob: Blob,
    options: {
      source: AssetSource
      remoteUrl?: string
      nativeRef?: string
      vaultProtected?: boolean
    },
  ): Promise<AssetRecord> {
    const contentHash = await hashBlob(blob)
    const existing = await this.database.assets.where('contentHash').equals(contentHash).first()
    if (existing) {
      return this.promoteExisting(
        existing,
        blob,
        options.source,
        options.vaultProtected === true,
        options.remoteUrl,
      )
    }

    const assetId = `asset-${contentHash}`
    const vaultProtected = options.vaultProtected === true || options.source === 'thumbnail'
    let storedBlob = blob
    let encrypted = false
    let encryptionIv: string | undefined
    if (vaultProtected && this.vault?.isEnabled()) {
      const protectedValue = await this.vault.protectBlob(blob)
      storedBlob = protectedValue.data
      encrypted = true
      encryptionIv = protectedValue.iv
    }
    const record: AssetRecord = {
      assetId,
      contentHash,
      mimeType: blob.type || 'application/octet-stream',
      size: blob.size,
      source: options.source,
      thumbnailRefs: {},
      webStorageRef: assetId,
      nativeRef: options.nativeRef,
      remoteUrl: options.remoteUrl,
      vaultProtected,
      encrypted,
      encryptionIv,
      createdAt: Date.now(),
    }
    await this.database.transaction(
      'rw',
      this.database.assets,
      this.database.assetFiles,
      async () => {
        await this.database.assets.put(record)
        await this.database.assetFiles.put({ assetId, blob: storedBlob, updatedAt: Date.now() })
      },
    )
    return record
  }

  get(assetId: string): Promise<AssetRecord | undefined> {
    return this.database.assets.get(assetId)
  }

  async getBlob(assetId: string): Promise<Blob | undefined> {
    const [asset, file] = await Promise.all([
      this.database.assets.get(assetId),
      this.database.assetFiles.get(assetId),
    ])
    if (!file) return undefined
    if (!asset?.encrypted) return file.blob
    if (!asset.encryptionIv || !this.vault) {
      throw new Error('加密素材缺少可用的本地保险库')
    }
    return this.vault.revealBlob(
      { iv: asset.encryptionIv, data: file.blob },
      asset.mimeType || 'application/octet-stream',
    )
  }

  /** Same-turn native display reads share metadata, never hydrate or cache image bytes in JS. */
  getImageUrl(assetId: string, level: 'card' | 'preview' = 'preview'): Promise<string | undefined> {
    if (!this.supportsImageUrls) return Promise.resolve(undefined)
    const requestKey = JSON.stringify([assetId, level])
    const existing = this.imageRequests.get(requestKey)
    if (existing) return existing.promise
    let resolve!: (url?: string) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<string | undefined>((accept, fail) => {
      resolve = accept
      reject = fail
    })
    this.imageRequests.set(requestKey, { assetId, level, promise, resolve, reject })
    if (!this.imageBatchScheduled) {
      this.imageBatchScheduled = true
      queueMicrotask(() => void this.readImageUrls())
    }
    return promise
  }

  private async readImageUrls(): Promise<void> {
    // Capture the pending generation: callers arriving during a bridge call own the next batch.
    const pending = [...this.imageRequests.entries()]
    const batches: (typeof pending)[] = []
    for (const level of ['card', 'preview']) {
      const group = pending.filter(([, request]) => request.level === level)
      for (let offset = 0; offset < group.length; offset += 32)
        batches.push(group.slice(offset, offset + 32))
    }
    for (const batch of batches) {
      try {
        if (
          !isAndroidNativeAppDatabaseActive() ||
          !this.imageSourcesAvailable ||
          this.vault?.isEnabled()
        ) {
          for (const [, request] of batch) request.resolve()
          continue
        }
        const rows = await this.database.transaction(
          'r',
          this.database.assets,
          this.database.assetFiles,
          (transaction) =>
            runAndroidNativeRead(transaction.idbtrans, () =>
              nativeAppDatabase.getAssetImageSources(
                batch.map(([, request]) => JSON.stringify(request.assetId)),
                batch
                  .filter(([, request]) => request.level === 'card')
                  .map(([, request]) => JSON.stringify(request.assetId)),
              ),
            ),
        )
        const byKey = new Map(rows.map((row) => [row.key, row]))
        for (const [, request] of batch) {
          const row = byKey.get(JSON.stringify(request.assetId))
          if (!row) {
            request.reject(new Error('原生图片读取结果缺失'))
            continue
          }
          if (row.error) {
            request.reject(new Error(row.error))
            continue
          }
          if (row.fallback || this.vault?.isEnabled() || !isAndroidNativeAppDatabaseActive()) {
            request.resolve()
            continue
          }
          const blob = row.blob
          if (
            !blob ||
            !blob.path.startsWith('file:///') ||
            !blob.mimeType.startsWith('image/') ||
            !Number.isSafeInteger(blob.size) ||
            blob.size < 0 ||
            !/^[a-f0-9]{64}$/.test(blob.sha256)
          ) {
            request.reject(new Error('原生图片描述无效'))
            continue
          }
          request.resolve(Capacitor.convertFileSrc(blob.path))
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'UNIMPLEMENTED') {
          this.imageSourcesAvailable = false
          for (const [, request] of batch) request.resolve()
        } else for (const [, request] of batch) request.reject(error)
      } finally {
        for (const [id, request] of batch)
          if (this.imageRequests.get(id) === request) this.imageRequests.delete(id)
      }
    }
    this.imageBatchScheduled = false
    if (this.imageRequests.size) {
      this.imageBatchScheduled = true
      queueMicrotask(() => void this.readImageUrls())
    }
  }

  async externalizeResourceThumbnail(resource: Resource): Promise<Resource> {
    if (!(resource.thumbnailBlob instanceof Blob)) return resource
    const asset = await this.put(resource.thumbnailBlob, { source: 'thumbnail' })
    if (resource.type === RESOURCE_TYPE.CHARACTER_CARD)
      await this.thumbnails.prepareCard(asset.assetId)
    return { ...resource, thumbnailAssetId: asset.assetId, thumbnailBlob: undefined }
  }

  async hydrateResourceThumbnail(resource: Resource): Promise<Resource> {
    if (resource.thumbnailBlob instanceof Blob || !resource.thumbnailAssetId) return resource
    const thumbnailBlob = await this.getBlob(resource.thumbnailAssetId)
    return thumbnailBlob ? { ...resource, thumbnailBlob } : resource
  }

  async setThumbnailRef(
    assetId: string,
    level: ThumbnailLevel,
    thumbnailAssetId: string,
  ): Promise<void> {
    await this.database.transaction('rw', this.database.assets, async () => {
      const asset = await this.database.assets.get(assetId)
      if (!asset) throw new Error('原始素材已经不存在')
      await this.database.assets.update(assetId, {
        thumbnailRefs: { ...asset.thumbnailRefs, [level]: thumbnailAssetId },
      })
    })
  }

  private async promoteExisting(
    existing: AssetRecord,
    plaintext: Blob,
    source: AssetSource,
    requestedVaultProtection: boolean,
    remoteUrl?: string,
  ): Promise<AssetRecord> {
    const vaultProtected =
      existing.vaultProtected === true || source === 'thumbnail' || requestedVaultProtection
    const nextRemoteUrl = existing.remoteUrl ?? remoteUrl

    if (!vaultProtected) {
      if (!existing.remoteUrl && nextRemoteUrl) {
        const updated = { ...existing, remoteUrl: nextRemoteUrl }
        await this.database.assets.put(updated)
        return updated
      }
      return existing
    }

    if (this.vault?.isEnabled() && existing.encrypted !== true) {
      const protectedValue = await this.vault.protectBlob(plaintext)
      const updated: AssetRecord = {
        ...existing,
        remoteUrl: nextRemoteUrl,
        vaultProtected: true,
        encrypted: true,
        encryptionIv: protectedValue.iv,
      }
      await this.database.transaction(
        'rw',
        this.database.assets,
        this.database.assetFiles,
        async () => {
          await this.database.assets.put(updated)
          await this.database.assetFiles.put({
            assetId: existing.assetId,
            blob: protectedValue.data,
            updatedAt: Date.now(),
          })
        },
      )
      return updated
    }

    if (existing.vaultProtected !== true || (!existing.remoteUrl && nextRemoteUrl)) {
      const updated = { ...existing, remoteUrl: nextRemoteUrl, vaultProtected: true }
      await this.database.assets.put(updated)
      return updated
    }
    return existing
  }
}
