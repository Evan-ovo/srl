import { appDatabase as database } from './AppDatabaseInstance'
import { PersonalResourceParser } from '../parser/PersonalResourceParser'
import { PngResourceParser } from '../parser/PngResourceParser'
import { ChatResourceParser } from '../parser/ChatResourceParser'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { TextBeautificationParser } from '../parser/TextBeautificationParser'
import { ResourceParserRegistry } from '../parser/ResourceParser'
import { ResourceService } from '../services/ResourceService'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { VaultService } from '../services/VaultService'
import { ResourceGalleryService } from '../services/ResourceGalleryService'
import { GreetingResourceService } from '../services/GreetingResourceService'
import { CommunitySourceService } from '../services/CommunitySourceService'
import { DiscordInboxAutomationSettingsService } from '../services/DiscordInboxAutomationSettings'
import { CommunitySourceRestoreService } from '../services/CommunitySourceRestoreService'
import { ResourceArchiveService } from '../services/ResourceArchiveService'
import { ArchiveRecoveryService } from '../services/ArchiveRecoveryService'
import { CategoryService } from '../services/CategoryService'
import { CharacterDrawService } from '../services/CharacterDrawService'
import { ExportService } from '../services/ExportService'
import { RecycleBinService } from '../services/RecycleBinService'
import { UserPersonaService } from '../services/UserPersonaService'
import { NativeResourceRecoveryService } from '../services/NativeResourceRecoveryService'
import {
  exportCommunitySourceLocalAttachments,
  restoreCommunitySourceLocalAttachments,
} from '../services/CommunitySourceAttachmentArchive'
import { IndexedDbAssetStore } from '../storage/IndexedDbAssetStore'
import { IndexedDbResourceStorage } from '../storage/IndexedDbResourceStorage'
import { IndexedDbResourceHealthStorage } from '../storage/IndexedDbResourceHealthStorage'
import { IndexedDbCategoryStorage } from '../storage/IndexedDbCategoryStorage'
import { IndexedDbResourceGalleryCategoryStorage } from '../storage/ResourceGalleryCategoryStorage'
import { IndexedDbArchiveStorage } from '../storage/IndexedDbArchiveStorage'
import { IndexedDbCommunitySourceStorage } from '../storage/IndexedDbCommunitySourceStorage'
import { NativeMirroredResourceStorage } from '../storage/NativeMirroredResourceStorage'
import { NativeRestoreStagingStore } from '../storage/NativeRestoreStagingStore'
import { hashBytes } from '../services/HashService'
import { isCapacitorApp } from '../utils/CapacitorDetection'

export { database }

export const vaultService = new VaultService(database)
let vaultInitializationPromise: ReturnType<VaultService['initialize']> | undefined
export function initializeVaultOnce(): ReturnType<VaultService['initialize']> {
  vaultInitializationPromise ??= vaultService.initialize()
  return vaultInitializationPromise
}

export const assetStore = new IndexedDbAssetStore(database, vaultService)
export const thumbnailService = assetStore.thumbnails
export const indexedDbStorage = new IndexedDbResourceStorage(database, vaultService, assetStore)
export const resourceHealthStorage = new IndexedDbResourceHealthStorage(database, indexedDbStorage)
export const storage = new NativeMirroredResourceStorage(indexedDbStorage, vaultService)
export const categoryStorage = new IndexedDbCategoryStorage(database, vaultService)
export const restoreStagingStore = new NativeRestoreStagingStore(database)
export const parserRegistry = new ResourceParserRegistry([
  new PersonalResourceParser(restoreStagingStore),
  new PngResourceParser(),
  new ChatResourceParser(),
  new JsonResourceParser(),
  new TextBeautificationParser(),
])

export const resourceService = new ResourceService(storage, parserRegistry)
export const browserStorageService = new BrowserStorageService(resourceHealthStorage)
export const archiveRecoveryService = new ArchiveRecoveryService()
const archiveStorage = new IndexedDbArchiveStorage(database, vaultService, assetStore)
export const resourceArchiveService = new ResourceArchiveService(restoreStagingStore)
const communitySourceStorageOwner = new IndexedDbCommunitySourceStorage(database, vaultService)
export const communitySourceStorage = communitySourceStorageOwner
export const nativeResourceRecoveryService = new NativeResourceRecoveryService(
  resourceHealthStorage,
  parserRegistry,
  assetStore,
  () => vaultService.isEnabled(),
)
export const resourceGalleryService = new ResourceGalleryService(
  storage,
  new IndexedDbResourceGalleryCategoryStorage(database),
)
export const greetingResourceService = new GreetingResourceService(resourceService)
export const discordInboxAutomationSettingsService = new DiscordInboxAutomationSettingsService(
  database,
)
export const communitySourceService = new CommunitySourceService(
  communitySourceStorageOwner,
  assetStore,
  async () => (await discordInboxAutomationSettingsService.load()).downloadPostMedia === true,
)
export const userPersonaService = new UserPersonaService(resourceService)
export const categoryService = new CategoryService(categoryStorage)
export const characterDrawService = new CharacterDrawService(database)
export const exportService = new ExportService(
  () => communitySourceService.exportAll(),
  () => exportCommunitySourceLocalAttachments(communitySourceService),
)
export const restoreService = new CommunitySourceRestoreService(
  archiveStorage,
  restoreStagingStore,
  communitySourceService,
  (entries) => restoreCommunitySourceLocalAttachments(assetStore, entries),
)
export const recycleBinService = new RecycleBinService(
  database,
  resourceService,
  categoryService,
  exportService,
  restoreService,
  vaultService,
  userPersonaService,
)

let nativeResourceSync: Promise<void> | undefined
export function syncNativeResourceFiles(): Promise<void> {
  if (!isCapacitorApp()) return Promise.resolve()
  if (nativeResourceSync) return nativeResourceSync
  const pending = syncNativeResourceFilesOnce()
  const shared = pending.finally(() => {
    if (nativeResourceSync === shared) nativeResourceSync = undefined
  })
  nativeResourceSync = shared
  return shared
}

async function syncNativeResourceFilesOnce(): Promise<void> {
  const { getNativeResourceStorageInfo, mirrorNativeResourceFile } =
    await import('../storage/NativeResourceFileMirror')
  const nativeStorage = await getNativeResourceStorageInfo(false)
  if (!nativeStorage || vaultService.isEnabled()) return
  const [current, versions] = await Promise.all([
    indexedDbStorage.listResourceListSummaries(),
    indexedDbStorage.listVersionListSummaries(),
  ])
  const manifestHash = (items: Array<{ id: string; contentHash: string }>) =>
    hashBytes(
      new TextEncoder().encode(
        [...items]
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .map((item) => `${item.id}\0${item.contentHash.toLowerCase()}\n`)
          .join(''),
      ),
    )
  const [currentManifestHash, versionManifestHash] = await Promise.all([
    manifestHash(current),
    manifestHash(versions),
  ])
  if (
    nativeStorage.storageVersion >= 4 &&
    nativeStorage.currentCount === current.length &&
    nativeStorage.versionCount === versions.length &&
    nativeStorage.currentManifestHash === currentManifestHash &&
    nativeStorage.versionManifestHash === versionManifestHash
  )
    return
  if (nativeStorage.currentCount > current.length || nativeStorage.versionCount > versions.length) {
    throw new Error(
      `Android 端仍有未被数据库登记的索引（数据库 ${current.length}/${versions.length}，Android ${nativeStorage.currentCount}/${nativeStorage.versionCount}）；已停止自动对账并保留这些记录，请在“资源库健康与修复”中找回。`,
    )
  }
  for (const summary of current) {
    const resource = await indexedDbStorage.get(summary.id)
    if (resource) await mirrorNativeResourceFile(resource, 'current')
  }
  for (const summary of versions) {
    const version = await indexedDbStorage.getVersion(summary.id)
    if (version) await mirrorNativeResourceFile(version, 'versions')
  }
  const repaired = await getNativeResourceStorageInfo(false)
  if (repaired) {
    const missingExpectedEntries =
      repaired.currentCount < current.length || repaired.versionCount < versions.length
    const exactCardinality =
      repaired.currentCount === current.length && repaired.versionCount === versions.length
    const exactManifestMismatch =
      exactCardinality &&
      (repaired.currentManifestHash !== currentManifestHash ||
        repaired.versionManifestHash !== versionManifestHash)
    if (missingExpectedEntries || exactManifestMismatch) {
      throw new Error(
        `Android 镜像修复未收敛：IndexedDB ${current.length}/${versions.length}，Android ${repaired.currentCount}/${repaired.versionCount}`,
      )
    }
  }
}

export interface NativeMirrorHealth {
  mismatch: boolean
  details: string
  safeRepair: boolean
}

export async function getNativeMirrorHealth(): Promise<NativeMirrorHealth | null> {
  if (!isCapacitorApp()) return null
  const { getNativeResourceStorageInfo } = await import('../storage/NativeResourceFileMirror')
  const nativeStorage = await getNativeResourceStorageInfo()
  if (!nativeStorage) return null
  if (vaultService.isEnabled()) {
    const mismatch = nativeStorage.currentCount > 0 || nativeStorage.versionCount > 0
    return {
      mismatch,
      details: mismatch
        ? '资源库保险箱已启用，但 Android 明文镜像仍有残留；不会由普通镜像同步自动删除。'
        : '保险箱模式下未保留 Android 明文镜像。',
      safeRepair: false,
    }
  }
  const [current, versions] = await Promise.all([
    indexedDbStorage.listSummaries(),
    indexedDbStorage.listVersionSummaries(),
  ])
  const manifestHash = (items: Array<{ id: string; contentHash: string }>) =>
    hashBytes(
      new TextEncoder().encode(
        [...items]
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .map((item) => `${item.id}\0${item.contentHash.toLowerCase()}\n`)
          .join(''),
      ),
    )
  const [currentManifestHash, versionManifestHash] = await Promise.all([
    manifestHash(current),
    manifestHash(versions),
  ])
  const mismatch =
    nativeStorage.storageVersion < 4 ||
    nativeStorage.currentCount !== current.length ||
    nativeStorage.versionCount !== versions.length ||
    nativeStorage.currentManifestHash !== currentManifestHash ||
    nativeStorage.versionManifestHash !== versionManifestHash
  const hasSurplusNativeEntries =
    nativeStorage.currentCount > current.length || nativeStorage.versionCount > versions.length
  return {
    mismatch,
    details: mismatch
      ? hasSurplusNativeEntries
        ? `IndexedDB 为 ${current.length} 个当前资源、${versions.length} 个历史版本；Android 镜像为 ${nativeStorage.currentCount} / ${nativeStorage.versionCount}。多出的原生索引会保留并进入找回检查，不会自动删除。`
        : `IndexedDB 为 ${current.length} 个当前资源、${versions.length} 个历史版本；Android 镜像为 ${nativeStorage.currentCount} / ${nativeStorage.versionCount}。`
      : `Android 镜像与 ${current.length} 个当前资源、${versions.length} 个历史版本一致。`,
    safeRepair: mismatch && !hasSurplusNativeEntries,
  }
}
