export {
  ORPHAN_CHUNK_GRACE_MS,
  isVerifiedChunkObjectName,
  isVerifiedChunkIdentity,
  listRetentionBackups,
  referencedPartIdentities,
  prune,
} from './CloudBackupRetentionOperations'
import { selectCloudResources, type PersonalResourceSelection } from './PersonalResourceBackup'

import type { ArchivePortableData } from '../types/Backup'
import { remapCommunitySourceBackupBindings } from './CommunitySourceBackupService'
import type { Category, ResourceSummary } from '../types/Resource'

import type { CloudBackupConfig, CloudBackupItem, GitHubBackupConfig } from '../types/CloudBackup'

import type { CategoryService } from './CategoryService'

import { hashCloudBlob } from './CloudArchiveCodec'

import { isCloudRequestTimeout } from './CloudBackupHttp'
import { assertGitHubDownloadableAsset } from './CloudBackupGitHubTransport'

import {
  LEGACY_RELEASE_TAG,
  canonicalizeFingerprintValue,
  joinUrl,
  normalizeContentSelection,
  normalizeFolder,
  structuredPartContainer,
  structuredPartIdentity,
  structuredPartObjectKey,
} from './CloudBackupPolicy'

import {
  SNAPSHOT_RELEASE_TAG,
  type CloudBackupProgressCallback,
  type GitHubAsset,
  type GitHubRelease,
} from './CloudBackupTransportContext'

import {
  createStructuredSnapshot,
  isStructuredSnapshotObjectKey,
  materializeStructuredResource,
  structuredSnapshotArchiveName,
  structuredSnapshotParts,
  structuredSnapshotObjects,
  type CreatedStructuredSnapshot,
  type StructuredSnapshot,
} from './CloudStructuredSnapshot'

import type { ExportService } from './ExportService'
import type { CloudDownloadOptions, RestoreTransferOptions } from './CloudBackupTransport'

import { type NativeRestoreObject, type NativeRestoreResource } from './NativeCloudTransfer'

import type { ResourceService } from './ResourceService'

export interface CloudBackupSnapshotOperationsContext {
  signal?: AbortSignal
  listRetentionBackups: (config: CloudBackupConfig, secret: string) => Promise<CloudBackupItem[]>
  referencedPartIdentities: (
    config: CloudBackupConfig,
    secret: string,
    backups: CloudBackupItem[],
  ) => Promise<Set<string>>
  getGitHubRelease: (
    config: GitHubBackupConfig,
    secret: string,
    create: boolean,
    tag?: string,
  ) => Promise<GitHubRelease | undefined>
  listGitHubAssets: (
    config: GitHubBackupConfig,
    secret: string,
    releaseId: number,
  ) => Promise<GitHubAsset[]>
  readGitHubStructuredSnapshot: (
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ) => Promise<StructuredSnapshot>
  readWebDavStructuredSnapshot: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ) => Promise<StructuredSnapshot>
  createGitHubObjectReader: (
    config: GitHubBackupConfig,
    secret: string,
    options?: RestoreTransferOptions,
  ) => Promise<(object: import('./GitHubBackupBundle').GitHubBundleManifest) => Promise<Blob>>
  createWebDavObjectReader: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
    options?: RestoreTransferOptions,
  ) => (object: import('./GitHubBackupBundle').GitHubBundleManifest) => Promise<Blob>
  exportService: ExportService
  resourceService: ResourceService
  categoryService: CategoryService
  readCommunityAttachment?: (assetId: string) => Promise<Blob | undefined>
  readAlbumFile?: (id: string) => Promise<Blob>
  transportState: Pick<
    import('./CloudBackupTransportContext').CloudBackupTransportContext,
    | 'webDavCapabilities'
    | 'activeMetrics'
    | 'activeGitHubInventory'
    | 'activeWebDavInventory'
    | 'jobStore'
  >
  readGitHubPartInventory: (
    config: GitHubBackupConfig,
    secret: string,
    parts: import('./GitHubBackupBundle').GitHubBundleManifest['parts'],
  ) => Promise<Map<string, GitHubAsset>>
  listWebDavObjects: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
  ) => Promise<import('./CloudBackupTransportContext').WebDavObject[]>
  listWebDavRetentionObjects: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
  ) => Promise<import('./CloudBackupTransportContext').WebDavObject[]>
  readGitHubBundleManifest: (
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ) => Promise<import('./GitHubBackupBundle').GitHubBundleManifest>
  readWebDavBundleManifest: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ) => Promise<import('./GitHubBackupBundle').GitHubBundleManifest>
  githubFetch: (
    config: GitHubBackupConfig,
    secret: string,
    path: string,
    init?: RequestInit,
  ) => Promise<Response>
  deleteWebDavObject: (
    config: import('../types/CloudBackup').WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ) => Promise<void>
}
export async function buildNativeRestorePlan(
  context: CloudBackupSnapshotOperationsContext,
  snapshot: StructuredSnapshot,
  config: CloudBackupConfig,
  secret: string,
): Promise<{
  objects: NativeRestoreObject[]
  resources: NativeRestoreResource[]
  resourceFailures?: Array<{ hash: string; error: string }>
}> {
  const objectUrls = new Map<string, NativeRestoreObject>()
  const githubInventories = new Map<string, Promise<Map<string, GitHubAsset>>>()
  const githubInventory = (container: string): Promise<Map<string, GitHubAsset>> => {
    let pending = githubInventories.get(container)
    if (!pending) {
      if (config.provider !== 'github') throw new Error('GitHub 原生恢复配置无效')
      pending = context.getGitHubRelease(config, secret, false, container).then(async (release) => {
        if (!release) throw new Error(`GitHub 对象容器不存在：${container}`)
        return new Map(
          (await context.listGitHubAssets(config, secret, release.id)).map((asset) => [
            asset.name,
            asset,
          ]),
        )
      })
      githubInventories.set(container, pending)
    }
    return pending
  }
  const resources: NativeRestoreResource[] = []
  const records = [
    ...snapshot.resources,
    ...snapshot.versions,
    ...(snapshot.portableData.generatedImageAlbum?.map((entry) => ({
      object: entry.object!,
      type: 'other',
      fileName: entry.item.name,
    })) ?? []),
    ...(snapshot.portableData.communitySources?.attachments.map((entry) => ({
      object: entry.object,
      type: 'other',
      fileName: entry.assetId,
    })) ?? []),
  ]
  const resourceFailures: Array<{ hash: string; error: string }> = []
  for (const resource of records) {
    try {
      const segments: NativeRestoreResource['segments'] = []
      for (const part of resource.object.parts) {
        const hash = part.sha256.toLowerCase()
        const storedSize = part.storedSize ?? part.size
        let url: string
        if (config.provider === 'github') {
          const container = structuredPartContainer(part)
          const objectKey = structuredPartObjectKey(part)
          const asset = (await githubInventory(container)).get(objectKey)
          assertGitHubDownloadableAsset(
            asset,
            storedSize,
            `资源 ${resource.fileName} 的分块 ${container}/${objectKey}`,
          )
          url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/releases/assets/${asset.id}`
        } else {
          url = joinUrl(
            config.baseUrl,
            normalizeFolder(config.folder),
            structuredPartObjectKey(part),
          )
        }
        const existing = objectUrls.get(hash)
        if (existing && existing.size !== storedSize) {
          throw new Error(`云对象哈希对应了不同大小：${hash}`)
        }
        if (!existing) objectUrls.set(hash, { url, hash, size: storedSize })
        segments.push({ hash, offset: part.offset ?? 0, size: part.size })
      }
      resources.push({
        hash: resource.object.totalSha256.toLowerCase(),
        size: resource.object.totalSize,
        type: resource.type,
        fileName: resource.fileName,
        segments,
      })
    } catch (error) {
      context.signal?.throwIfAborted()
      resourceFailures.push({
        hash: resource.object.totalSha256.toLowerCase(),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    objects: [...objectUrls.values()],
    resources,
    ...(resourceFailures.length ? { resourceFailures } : {}),
  }
}

export async function materializeStructuredArchive(
  context: CloudBackupSnapshotOperationsContext,
  item: CloudBackupItem,
  config: CloudBackupConfig,
  secret: string,
  options?: {
    onReceivedBytes?: RestoreTransferOptions['onReceivedBytes']
    onProgress?: (progress: { completed: number; total: number; writtenBytes: number }) => void
    onReadFailures?: CloudDownloadOptions['onReadFailures']
    writerFactory?: CloudDownloadOptions['writerFactory']
  },
) {
  const controller = new AbortController()
  const abort = () => controller.abort(context.signal?.reason)
  if (context.signal?.aborted) abort()
  else context.signal?.addEventListener('abort', abort, { once: true })
  try {
    controller.signal.throwIfAborted()
    const snapshot =
      config.provider === 'github'
        ? await context.readGitHubStructuredSnapshot(config, secret, item)
        : await context.readWebDavStructuredSnapshot(config, secret, item.objectKey)
    controller.signal.throwIfAborted()
    const transfer = { signal: controller.signal, onReceivedBytes: options?.onReceivedBytes }
    const providerReader =
      config.provider === 'github'
        ? await context.createGitHubObjectReader(config, secret, transfer)
        : context.createWebDavObjectReader(config, secret, transfer)
    const index = (records: typeof snapshot.resources) => {
      const byId = new Map<string, (typeof records)[number]>()
      for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record)
      return byId
    }
    const resources = index(snapshot.resources),
      versions = index(snapshot.versions)
    const album = new Map(
      snapshot.portableData.generatedImageAlbum?.map((entry) => [entry.item.id, entry]),
    )
    let completed = 0
    const completedEntries = new Set<string>()
    let writtenBytes = 0
    const total =
      snapshot.resources.length +
      snapshot.versions.length +
      album.size +
      (snapshot.portableData.communitySources?.attachments.length ?? 0)
    const report = () => options?.onProgress?.({ completed, total, writtenBytes })
    const complete = (key: string) => {
      if (completedEntries.has(key)) return
      completedEntries.add(key)
      completed++
      report()
    }
    const read = async (object: import('./GitHubBackupBundle').GitHubBundleManifest) => {
      const blob = await providerReader(object)
      controller.signal.throwIfAborted()
      return blob
    }
    report()
    const { communitySources, ...portableData } = snapshot.portableData
    const attachments = new Map(
      communitySources?.attachments.map((entry) => [entry.assetId, entry]),
    )
    const placeholder = new Blob()
    const communitySourceAttachments = [...attachments.keys()].map((assetId) => ({
      assetId,
      blob: placeholder,
    }))
    return (
      await context.exportService.createArchivesFromSource(
        {
          resources: snapshot.resources,
          versions: snapshot.versions,
          read: async (planned, historical) => {
            controller.signal.throwIfAborted()
            const record = (historical ? versions : resources).get(planned.id)
            if (!record) throw new Error(`备份缺少资源描述：${planned.fileName}`)
            const resource = await materializeStructuredResource(record, read)
            complete(`${historical ? 'version' : 'resource'}:${planned.id}`)
            return resource
          },
        },
        snapshot.categories,
        {
          mode: 'full',
          portableData,
          readAlbumFile: async (id) => {
            const entry = album.get(id)
            if (!entry?.object) throw new Error('云备份缺少相册原图描述')
            const blob = await read(entry.object)
            complete(`album:${id}`)
            return blob
          },
          ...(communitySources
            ? {
                communitySourceData: remapCommunitySourceBackupBindings(
                  communitySources.data,
                  new Map(snapshot.resources.map((record) => [record.id, record.id])),
                ),
                communitySourceAttachments,
              }
            : {}),
        },
        options?.writerFactory,
        {
          signal: controller.signal,
          readAhead: { onFailure: (error: unknown) => controller.abort(error) },
          onReadFailures: options?.onReadFailures,
          readCommunityAttachment: async (assetId) => {
            const entry = attachments.get(assetId)
            if (!entry) throw new Error(`云备份缺少来源附件描述：${assetId}`)
            const blob = new Blob([await read(entry.object)], { type: entry.mimeType })
            complete(`attachment:${assetId}`)
            return blob
          },
          onProgress: (progress) => {
            writtenBytes = progress.writtenBytes
            report()
          },
        },
      )
    )[0]!
  } finally {
    // Also release the reader's last verified chunk when the ZIP has been written.
    controller.abort()
    context.signal?.removeEventListener('abort', abort)
  }
}

export interface StructuredBackupIndex {
  resources: ResourceSummary[]
  versions: ResourceSummary[]
  categories: Category[]
  resourceCount: number
}

export async function readStructuredBackupIndex(
  context: CloudBackupSnapshotOperationsContext,
  personalResources?: PersonalResourceSelection,
): Promise<StructuredBackupIndex> {
  const [all, versions, categories] = await Promise.all([
    context.resourceService.listResourceListSummaries?.() ??
      context.resourceService.listSummaries(),
    context.resourceService.listVersionSummaries?.(true) ?? Promise.resolve([]),
    context.categoryService.list(),
  ])
  return {
    resources: selectCloudResources(all, personalResources),
    versions,
    categories,
    resourceCount: all.length,
  }
}

export async function createStructuredFingerprint(
  context: CloudBackupSnapshotOperationsContext,
  config: CloudBackupConfig,
  portableData: ArchivePortableData,
  index?: StructuredBackupIndex,
): Promise<string> {
  index ??= await readStructuredBackupIndex(
    context,
    normalizeContentSelection(config.contentSelection).personalResources,
  )
  const summaries = index.resources
  const includedIds = new Set(summaries.map((resource) => resource.id))
  const versionSummaries = index.versions.filter((resource) =>
    includedIds.has(resource.versionGroupId ?? ''),
  )
  const compact = (resource: (typeof summaries)[number]) => ({
    id: resource.id,
    contentHash: resource.contentHash,
    fileSize: resource.fileSize,
    updatedAt: resource.updatedAt,
    versionGroupId: resource.versionGroupId,
  })
  const destination =
    config.provider === 'github'
      ? { provider: config.provider, owner: config.owner, repository: config.repository }
      : {
          provider: config.provider,
          baseUrl: config.baseUrl.replace(/\/+$/u, ''),
          folder: normalizeFolder(config.folder),
          username: config.username,
        }
  const fingerprintValue = canonicalizeFingerprintValue({
    version: 1,
    destination,
    resources: summaries.map(compact).sort((left, right) => left.id.localeCompare(right.id)),
    versions: versionSummaries.map(compact).sort((left, right) => left.id.localeCompare(right.id)),
    categories: [...index.categories].sort((left, right) => left.id.localeCompare(right.id)),
    portableData,
  })
  const fingerprintBlob = new Blob([JSON.stringify(fingerprintValue)], {
    type: 'application/json',
  })
  context.transportState.activeMetrics?.add('hashedBytes', fingerprintBlob.size)
  return hashCloudBlob(fingerprintBlob)
}

export async function reuseUnchangedStructuredBackup(
  context: CloudBackupSnapshotOperationsContext,
  config: CloudBackupConfig,
  secret: string,
  objectKey: string,
): Promise<CloudBackupItem | undefined> {
  if (!isStructuredSnapshotObjectKey(objectKey)) return undefined
  if (config.provider === 'github') {
    const release =
      (await context.getGitHubRelease(config, secret, false, SNAPSHOT_RELEASE_TAG)) ??
      (await context.getGitHubRelease(config, secret, false, LEGACY_RELEASE_TAG))
    if (!release) return undefined
    const assets = await context.listGitHubAssets(config, secret, release.id)
    const manifest = assets.find((asset) => asset.name === objectKey)
    if (!manifest) return undefined
    try {
      assertGitHubDownloadableAsset(manifest, manifest.size, manifest.name)
    } catch {
      return undefined
    }
    let snapshot: StructuredSnapshot
    try {
      snapshot = await context.readGitHubStructuredSnapshot(config, secret, {
        id: String(manifest.id),
        objectKey: manifest.name,
        size: manifest.size,
        createdAt: Date.parse(manifest.created_at) || 0,
        kind: 'githubSnapshot',
      })
    } catch (error) {
      if (isCloudRequestTimeout(error)) throw error
      return undefined
    }
    const parts = structuredSnapshotParts(snapshot)
    const partAssets = await context.readGitHubPartInventory(config, secret, parts)
    try {
      for (const part of parts)
        assertGitHubDownloadableAsset(
          partAssets.get(structuredPartIdentity(part)),
          part.size,
          `${structuredPartContainer(part)}/${structuredPartObjectKey(part)}`,
        )
    } catch {
      return undefined
    }
    return {
      id: String(manifest.id),
      objectKey,
      size: structuredSnapshotObjects(snapshot).reduce(
        (total, object) => total + object.totalSize,
        0,
      ),
      createdAt: Date.parse(manifest.created_at) || Date.parse(snapshot.createdAt) || Date.now(),
      kind: 'githubSnapshot',
      partCount: parts.length,
      archiveName: structuredSnapshotArchiveName(objectKey),
    }
  }

  const objects = await context.listWebDavObjects(config, secret)
  const manifest = objects.find((object) => object.objectKey === objectKey)
  if (!manifest) return undefined
  let snapshot: StructuredSnapshot
  try {
    snapshot = await context.readWebDavStructuredSnapshot(config, secret, objectKey)
  } catch (error) {
    if (isCloudRequestTimeout(error)) throw error
    return undefined
  }
  const byName = new Map(objects.map((object) => [object.objectKey, object.size]))
  const parts = structuredSnapshotParts(snapshot)
  if (parts.some((part) => byName.get(structuredPartObjectKey(part)) !== part.size)) {
    return undefined
  }
  return {
    id: objectKey,
    objectKey,
    size: structuredSnapshotObjects(snapshot).reduce(
      (total, object) => total + object.totalSize,
      0,
    ),
    createdAt: manifest.createdAt || Date.parse(snapshot.createdAt) || Date.now(),
    kind: 'webdavSnapshot',
    partCount: parts.length,
    archiveName: structuredSnapshotArchiveName(objectKey),
  }
}

export async function buildStructuredBackup(
  context: CloudBackupSnapshotOperationsContext,
  portableData: ArchivePortableData,
  onProgress?: CloudBackupProgressCallback,
  personalResources?: PersonalResourceSelection,
  index?: StructuredBackupIndex,
): Promise<CreatedStructuredSnapshot> {
  onProgress?.('正在逐项读取资源，构建对象级快照…')
  index ??= await readStructuredBackupIndex(context, personalResources)
  const summaries = index.resources
  const resourceService = context.resourceService
  async function* resources() {
    for (const summary of summaries) {
      context.signal?.throwIfAborted()
      yield {
        summary,
        summaryIsPartial: true,
        loadSummary: resourceService.getSummary
          ? async () => {
              context.signal?.throwIfAborted()
              const metadata = await resourceService.getSummary(summary.id, false)
              if (!metadata) throw new Error(`云备份期间资源已不存在：${summary.fileName}`)
              return metadata
            }
          : undefined,
        load: async () => {
          context.signal?.throwIfAborted()
          const resource = await resourceService.get(summary.id)
          if (!resource) throw new Error(`云备份规划期间资源已不存在：${summary.fileName}`)
          return resource
        },
        loadSource: resourceService.getReadSource
          ? async (signal?: AbortSignal) => {
              const source = await resourceService.getReadSource(summary.id, false, signal)
              if (!source) throw new Error(`云备份规划期间资源已不存在：${summary.fileName}`)
              return source
            }
          : undefined,
      }
    }
  }
  async function* versions() {
    const currentIds = new Set(summaries.map((summary) => summary.id))
    for (const summary of index!.versions) {
      context.signal?.throwIfAborted()
      if (
        currentIds.has(summary.id) ||
        !summary.versionGroupId ||
        !currentIds.has(summary.versionGroupId) ||
        summary.metadata.cloudBackupExcluded === true
      ) {
        continue
      }
      yield {
        summary,
        summaryIsPartial: true,
        loadSummary: resourceService.getSummary
          ? async () => {
              context.signal?.throwIfAborted()
              const metadata = await resourceService.getSummary(summary.id, true)
              if (!metadata) throw new Error(`云备份期间资源已不存在：${summary.fileName}`)
              return metadata
            }
          : undefined,
        load: async () => {
          context.signal?.throwIfAborted()
          const resource = await resourceService.getVersion(summary.id)
          if (!resource) throw new Error(`云备份规划期间历史版本已不存在：${summary.fileName}`)
          return resource
        },
        loadSource: resourceService.getReadSource
          ? async (signal?: AbortSignal) => {
              const source = await resourceService.getReadSource(summary.id, true, signal)
              if (!source) throw new Error(`云备份规划期间历史版本已不存在：${summary.fileName}`)
              return source
            }
          : undefined,
      }
    }
  }
  return createStructuredSnapshot(resources(), versions(), index.categories, portableData, {
    readAttachment: context.readCommunityAttachment,
    readAlbumFile: context.readAlbumFile,
    signal: context.signal,
    onProgress,
  })
}
