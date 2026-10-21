import { gzip, gunzip, strFromU8, strToU8 } from 'fflate'

import type { ArchivePortableData } from '../types/Backup'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { PngResourceParser } from '../parser/PngResourceParser'
import {
  RESOURCE_TYPE,
  type Category,
  type Resource,
  type ResourceBackupDescriptor,
  type ResourceReference,
  type ResourceSummary,
} from '../types/Resource'
import { isRecord } from '../utils/UnknownValue'
import {
  createGitHubBundle,
  planGitHubBundle,
  type BundleReadOptions,
  parseGitHubBundleManifest,
  type GitHubBundleManifest,
  type GitHubBundlePart,
} from './GitHubBackupBundle'
import { hashCloudBlob } from './CloudArchiveCodec'
import { nativeFileSource } from '../core/NativeFileSource'
import type { ResourceReadSource } from '../types/ResourceReadSource'
import { withAbort } from '../utils/Abortable'
import { collectCommunitySourceLocalAssetIds } from './CommunitySourceAttachmentArchive'
import { parseAlbumBackup } from './GeneratedImageAlbumBackup'
import { parseFrontendWorkshopBackup } from '../storage/FrontendWorkshopProjectStorage'
import { parseCommunitySourceBackupData } from './CommunitySourceBackupService'

export const STRUCTURED_SNAPSHOT_FORMAT = 'srl-structured-cloud-snapshot'
export const STRUCTURED_SNAPSHOT_VERSION = 3
// Keep the V3 object namespace/filename visible to old retention inventories, but make
// their strict manifest decoder reject new attachment references before any deletion.
export const STRUCTURED_SNAPSHOT_COMMUNITY_VERSION = 4
export const STRUCTURED_SNAPSHOT_APPLICATION_VERSION = 5
const LEGACY_STRUCTURED_SNAPSHOT_VERSION = 1
const LEGACY_STRUCTURED_SNAPSHOT_VERSION_2 = 2
const SMALL_OBJECT_LIMIT = 4 * 1024 * 1024

export function structuredSnapshotName(createdAt = new Date(), compressed = true): string {
  return `srl-snapshot-${createdAt.toISOString().replace(/[:.]/g, '-').slice(0, 23)}.srlmanifest.v3.json${compressed ? '.gz' : ''}`
}

export function isStructuredSnapshotObjectKey(objectKey: string): boolean {
  return /\.(?:srlsnapshot|srlmanifest\.v3)\.json(?:\.gz)?$/iu.test(objectKey)
}

export function structuredSnapshotArchiveName(objectKey: string): string {
  return objectKey.replace(/\.(?:srlsnapshot|srlmanifest\.v3)\.json(?:\.gz)?$/iu, '.zip')
}

export type CloudObjectSource =
  | { kind: 'file'; uri: string; offset: number; size: number }
  | { kind: 'range'; contentHash: string; offset: number; size: number }
  | {
      kind: 'concat'
      segments: Array<{ contentHash: string; offset: number; size: number }>
    }
  | { kind: 'inline'; blob: Blob }

export interface CloudObjectPlan {
  name: string
  hash: string
  size: number
  blob?: Blob
  loadBlob?: (signal?: AbortSignal) => Promise<Blob>
  source: CloudObjectSource
  contentType: string
}

export interface StructuredResourceCandidate {
  summary: ResourceSummary
  summaryIsPartial?: boolean
  loadSummary?: () => Promise<ResourceSummary>
  load: () => Promise<Resource>
  loadSource?: (signal?: AbortSignal) => Promise<ResourceReadSource>
}

type StructuredResourceInput = Resource | StructuredResourceCandidate

export interface StructuredResource extends Omit<Resource, 'originalBlob' | 'thumbnailBlob'> {
  object: GitHubBundleManifest
}

export interface StructuredSnapshot {
  format: typeof STRUCTURED_SNAPSHOT_FORMAT
  version:
    | typeof STRUCTURED_SNAPSHOT_VERSION
    | typeof STRUCTURED_SNAPSHOT_COMMUNITY_VERSION
    | typeof STRUCTURED_SNAPSHOT_APPLICATION_VERSION
    | typeof LEGACY_STRUCTURED_SNAPSHOT_VERSION
    | typeof LEGACY_STRUCTURED_SNAPSHOT_VERSION_2
  createdAt: string
  categories: Category[]
  resources: StructuredResource[]
  versions: StructuredResource[]
  portableData: ArchivePortableData
  objectContract?: {
    algorithm: 'SHA-256'
    immutable: true
    naming: 'srl-chunk--sha256-{hash}'
  }
}

export interface CreatedStructuredSnapshot {
  snapshot: StructuredSnapshot
  chunks: Map<string, Blob>
  nativeSources: Map<string, CloudObjectSource>
  objectPlans: CloudObjectPlan[]
  totalSize: number
  partCount: number
  localReadBytes: number
  descriptorUpdates: Array<{
    id: string
    historical: boolean
    descriptor: ResourceBackupDescriptor
  }>
}

function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gzip(bytes, { level: 6 }, (error, compressed) => {
      if (error) reject(error)
      else resolve(compressed)
    })
  })
}

function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, decompressed) => {
      if (error) reject(error)
      else resolve(decompressed)
    })
  })
}

export async function encodeStructuredSnapshot(snapshot: StructuredSnapshot): Promise<Blob> {
  const compressed = await gzipBytes(strToU8(JSON.stringify(snapshot)))
  const owned = new Uint8Array(compressed.byteLength)
  owned.set(compressed)
  return new Blob([owned.buffer], { type: 'application/gzip' })
}

export async function decodeStructuredSnapshot(blob: Blob): Promise<StructuredSnapshot> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const jsonBytes = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipBytes(bytes) : bytes
  try {
    return parseStructuredSnapshot(JSON.parse(strFromU8(jsonBytes)) as unknown)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('对象级云备份')) throw error
    throw new Error('对象级云备份清单 JSON 无效', { cause: error })
  }
}

function withoutBlobs(
  resource: ResourceReference,
  object: GitHubBundleManifest,
): StructuredResource {
  const {
    originalBlob: _originalBlob,
    thumbnailBlob: _thumbnailBlob,
    ...record
  } = resource as Resource
  const metadata = { ...record.metadata }
  if (resource.type === RESOURCE_TYPE.CHARACTER_CARD && isRecord(metadata.card)) {
    delete metadata.card
  }
  return { ...record, metadata, object }
}

function reusableObject(resource: ResourceReference): GitHubBundleManifest | undefined {
  const descriptor = resource.backupDescriptor
  if (
    !descriptor ||
    ![1, 2].includes(descriptor.version) ||
    descriptor.resourceId !== resource.id ||
    descriptor.contentHash !== resource.contentHash.toLowerCase() ||
    descriptor.size !== resource.fileSize ||
    !descriptor.parts?.length
  ) {
    return undefined
  }
  let expectedOffset = 0
  const parts: GitHubBundlePart[] = []
  for (const part of descriptor.parts) {
    if (
      part.offset !== expectedOffset ||
      part.size < 0 ||
      part.storedSize !== undefined ||
      part.name !== `srl-chunk--sha256-${part.sha256}`
    ) {
      return undefined
    }
    parts.push({ name: part.name, size: part.size, sha256: part.sha256 })
    expectedOffset += part.size
  }
  if (expectedOffset !== resource.fileSize) return undefined
  return {
    format: 'srl-github-backup-bundle',
    version: 2,
    createdAt: new Date().toISOString(),
    fileName: resource.fileName,
    totalSize: resource.fileSize,
    totalSha256: resource.contentHash.toLowerCase(),
    parts,
  }
}

async function restoreStructuredMetadata(
  resource: Omit<StructuredResource, 'object'>,
  originalBlob: Blob,
): Promise<Record<string, unknown>> {
  if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD || isRecord(resource.metadata.card)) {
    return resource.metadata
  }
  const file = new File([originalBlob], resource.fileName, { type: resource.mimeType })
  const parser =
    resource.mimeType === 'image/png' || /\.png$/iu.test(resource.fileName)
      ? new PngResourceParser()
      : new JsonResourceParser()
  const parsed = await parser.parse(file)
  const card = parsed.metadata?.card
  if (parsed.type !== RESOURCE_TYPE.CHARACTER_CARD || !isRecord(card)) {
    throw new Error(`无法从已校验原文件重建角色卡清单：${resource.fileName}`)
  }
  return { ...parsed.metadata, ...resource.metadata, card }
}

type SourceIdentity = Pick<
  ResourceSummary,
  'id' | 'contentHash' | 'updatedAt' | 'fileSize' | 'fileName' | 'mimeType'
>

async function openCandidateSource(
  candidate: StructuredResourceCandidate,
  expected: SourceIdentity,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const source = await withAbort(candidate.loadSource!(signal), signal)
  if (
    source.id !== expected.id ||
    source.contentHash !== expected.contentHash ||
    source.updatedAt !== expected.updatedAt ||
    source.originalSource.size !== expected.fileSize
  )
    throw new Error(`云备份期间资源发生变化：${expected.fileName}`)
  return source
}

function candidateChunkLoader(
  candidate: StructuredResourceCandidate,
  resource: ResourceReference,
  offset: number,
  size: number,
) {
  const expected: SourceIdentity = {
    id: resource.id,
    contentHash: resource.contentHash,
    updatedAt: resource.updatedAt,
    fileSize: resource.fileSize,
    fileName: resource.fileName,
    mimeType: resource.mimeType,
  }
  return async (signal?: AbortSignal): Promise<Blob> => {
    signal?.throwIfAborted()
    if (candidate.loadSource) {
      const source = (await openCandidateSource(candidate, expected, signal)).originalSource
      if (source instanceof Blob) return source.slice(offset, offset + size)
      const bytes = await withAbort(source.slice(offset, offset + size).arrayBuffer(signal), signal)
      signal?.throwIfAborted()
      return new Blob([bytes], { type: expected.mimeType })
    }
    const hydrated = await withAbort(candidate.load(), signal)
    signal?.throwIfAborted()
    if (hydrated.contentHash !== expected.contentHash || hydrated.updatedAt !== expected.updatedAt)
      throw new Error(`云备份期间资源发生变化：${expected.fileName}`)
    return hydrated.originalBlob.slice(offset, offset + size)
  }
}

async function addResource(
  input: StructuredResourceInput,
  target: StructuredResource[],
  chunks: Map<string, Blob>,
  nativeSources: Map<string, CloudObjectSource>,
  objectPlans: Map<string, CloudObjectPlan>,
  descriptorUpdates: CreatedStructuredSnapshot['descriptorUpdates'],
  historical: boolean,
  options: BundleReadOptions = {},
): Promise<number> {
  options.signal?.throwIfAborted()
  const candidate = 'summary' in input ? (input as StructuredResourceCandidate) : undefined
  let resource: ResourceReference = candidate ? candidate.summary : (input as Resource)
  if (candidate?.summaryIsPartial) {
    const full = await withAbort(candidate.loadSummary?.() ?? candidate.load(), options.signal)
    if (
      full.id !== resource.id ||
      full.contentHash !== resource.contentHash ||
      full.updatedAt !== resource.updatedAt
    )
      throw new Error(`云备份期间资源发生变化：${resource.fileName}`)
    resource = full
  }
  const reusable = reusableObject(resource)
  if (reusable) {
    target.push(withoutBlobs(resource, reusable))
    let offset = 0
    for (const part of reusable.parts) {
      const source: CloudObjectSource = {
        kind: 'range',
        contentHash: resource.contentHash.toLowerCase(),
        offset,
        size: part.size,
      }
      const loaded = candidate
        ? undefined
        : (resource as Resource).originalBlob.slice(offset, offset + part.size)
      if (loaded) chunks.set(part.name, loaded)
      nativeSources.set(part.name, source)
      if (!objectPlans.has(part.name)) {
        const partOffset = offset
        objectPlans.set(part.name, {
          name: part.name,
          hash: part.sha256,
          size: part.size,
          blob: loaded,
          loadBlob: candidate
            ? candidateChunkLoader(candidate, resource, partOffset, part.size)
            : undefined,
          source,
          contentType: 'application/octet-stream',
        })
      }
      offset += part.size
    }
    return 0
  }
  if (candidate?.loadSource) {
    const opened = await openCandidateSource(candidate, resource, options.signal)
    const source = opened.originalSource
    if (opened.requiresWholeRead) {
      // Keep the established single materialization for legacy/encrypted records instead of
      // repeating whole-file reads/decryption once per part. New plain Blob/native rows are ranged.
      if (!(source instanceof Blob)) throw new Error('完整读取来源缺少原件')
      const { originalSource: _source, requiresWholeRead: _whole, ...summary } = opened
      return addResource(
        { ...summary, originalBlob: source },
        target,
        chunks,
        nativeSources,
        objectPlans,
        descriptorUpdates,
        historical,
        options,
      )
    }
    const manifest = await planGitHubBundle(
      source,
      resource.fileName,
      options,
      source.size <= SMALL_OBJECT_LIMIT ? SMALL_OBJECT_LIMIT : undefined,
    )
    if (manifest.totalSha256 !== resource.contentHash.toLowerCase())
      throw new Error(`资源原文件摘要与索引不一致：${resource.fileName}`)
    target.push(withoutBlobs(resource, manifest))
    let offset = 0
    const parts: NonNullable<ResourceBackupDescriptor['parts']> = []
    for (const part of manifest.parts) {
      const range: CloudObjectSource = {
        kind: 'range',
        contentHash: manifest.totalSha256,
        offset,
        size: part.size,
      }
      nativeSources.set(part.name, range)
      if (!objectPlans.has(part.name))
        objectPlans.set(part.name, {
          name: part.name,
          hash: part.sha256,
          size: part.size,
          loadBlob: candidateChunkLoader(candidate, resource, offset, part.size),
          source: range,
          contentType: 'application/octet-stream',
        })
      parts.push({ name: part.name, size: part.size, sha256: part.sha256, offset })
      offset += part.size
    }
    descriptorUpdates.push({
      id: resource.id,
      historical,
      descriptor: {
        version: 2,
        resourceId: resource.id,
        contentHash: manifest.totalSha256,
        size: resource.fileSize,
        updatedAt: resource.updatedAt,
        parts,
      },
    })
    return source.size
  }
  if (candidate && !('originalBlob' in resource)) {
    const full = await withAbort(candidate.load(), options.signal)
    if (
      full.id !== resource.id ||
      full.contentHash !== resource.contentHash ||
      full.updatedAt !== resource.updatedAt
    )
      throw new Error(`云备份期间资源发生变化：${resource.fileName}`)
    resource = full
  }
  const hydrated = resource as Resource
  if (hydrated.originalBlob.size <= SMALL_OBJECT_LIMIT) {
    const actualHash = await withAbort(hashCloudBlob(hydrated.originalBlob), options.signal)
    if (actualHash !== hydrated.contentHash.toLowerCase()) {
      throw new Error(`资源原文件摘要与索引不一致：${hydrated.fileName}`)
    }
    const name = `srl-chunk--sha256-${actualHash}`
    const object: GitHubBundleManifest = {
      format: 'srl-github-backup-bundle',
      version: 2,
      createdAt: new Date().toISOString(),
      fileName: hydrated.fileName,
      totalSize: hydrated.fileSize,
      totalSha256: actualHash,
      parts: [{ name, size: hydrated.fileSize, sha256: actualHash }],
    }
    target.push(withoutBlobs(hydrated, object))
    chunks.set(name, hydrated.originalBlob)
    const source: CloudObjectSource = {
      kind: 'range',
      contentHash: actualHash,
      offset: 0,
      size: hydrated.fileSize,
    }
    nativeSources.set(name, source)
    objectPlans.set(name, {
      name,
      hash: actualHash,
      size: hydrated.fileSize,
      blob: hydrated.originalBlob,
      source,
      contentType: 'application/octet-stream',
    })
    descriptorUpdates.push({
      id: hydrated.id,
      historical,
      descriptor: {
        version: 2,
        resourceId: hydrated.id,
        contentHash: actualHash,
        size: hydrated.fileSize,
        updatedAt: hydrated.updatedAt,
        parts: [{ name, offset: 0, size: hydrated.fileSize, sha256: actualHash }],
      },
    })
    return hydrated.originalBlob.size
  }
  const { manifest, blobs } = await createGitHubBundle(
    hydrated.originalBlob,
    hydrated.fileName,
    undefined,
    hydrated.contentHash,
    options,
  )
  target.push(withoutBlobs(hydrated, manifest))
  let offset = 0
  const descriptorParts: NonNullable<ResourceBackupDescriptor['parts']> = []
  for (const [index, part] of manifest.parts.entries()) {
    chunks.set(part.name, blobs[index]!)
    const source: CloudObjectSource = {
      kind: 'range',
      contentHash: hydrated.contentHash.toLowerCase(),
      offset,
      size: part.size,
    }
    nativeSources.set(part.name, source)
    objectPlans.set(part.name, {
      name: part.name,
      hash: part.sha256,
      size: part.size,
      blob: blobs[index]!,
      source,
      contentType: 'application/octet-stream',
    })
    descriptorParts.push({
      name: part.name,
      offset,
      size: part.size,
      sha256: part.sha256,
    })
    offset += part.size
  }
  descriptorUpdates.push({
    id: hydrated.id,
    historical,
    descriptor: {
      version: 2,
      resourceId: hydrated.id,
      contentHash: hydrated.contentHash.toLowerCase(),
      size: hydrated.fileSize,
      updatedAt: hydrated.updatedAt,
      parts: descriptorParts,
    },
  })
  return hydrated.originalBlob.size * 2
}

export async function createStructuredSnapshot(
  resources: Iterable<StructuredResourceInput> | AsyncIterable<StructuredResourceInput>,
  versions: Iterable<StructuredResourceInput> | AsyncIterable<StructuredResourceInput>,
  categories: Category[],
  portableData: ArchivePortableData,
  community: {
    readAttachment?: (assetId: string) => Promise<Blob | undefined>
    readAlbumFile?: (id: string) => Promise<Blob>
    signal?: AbortSignal
    onProgress?: (message: string) => void
  } = {},
): Promise<CreatedStructuredSnapshot> {
  const chunks = new Map<string, Blob>()
  const nativeSources = new Map<string, CloudObjectSource>()
  const objectPlans = new Map<string, CloudObjectPlan>()
  const current: StructuredResource[] = []
  const historic: StructuredResource[] = []
  const descriptorUpdates: CreatedStructuredSnapshot['descriptorUpdates'] = []
  let localReadBytes = 0
  for await (const resource of resources)
    localReadBytes += await addResource(
      resource,
      current,
      chunks,
      nativeSources,
      objectPlans,
      descriptorUpdates,
      false,
      {
        signal: community.signal,
        onRead: (_, bytes) =>
          community.onProgress?.(
            `正在分块：${'summary' in resource ? resource.summary.fileName : resource.fileName}（${(bytes / 1048576).toFixed(1)} MiB）`,
          ),
      },
    )
  for await (const version of versions)
    localReadBytes += await addResource(
      version,
      historic,
      chunks,
      nativeSources,
      objectPlans,
      descriptorUpdates,
      true,
      {
        signal: community.signal,
        onRead: (_, bytes) =>
          community.onProgress?.(
            `正在分块历史：${'summary' in version ? version.summary.fileName : version.fileName}（${(bytes / 1048576).toFixed(1)} MiB）`,
          ),
      },
    )
  const addPortableParts = (original: Blob, manifest: GitHubBundleManifest, blobs: Blob[]) => {
    const uri = nativeFileSource(original)
    let offset = 0
    for (const [index, part] of manifest.parts.entries()) {
      const source: CloudObjectSource = uri
        ? { kind: 'file', uri, offset, size: part.size }
        : { kind: 'inline', blob: blobs[index]! }
      if (!objectPlans.has(part.name)) {
        if (!uri) chunks.set(part.name, blobs[index]!)
        nativeSources.set(part.name, source)
        objectPlans.set(part.name, {
          name: part.name,
          hash: part.sha256,
          size: part.size,
          blob: uri ? undefined : blobs[index]!,
          source,
          contentType: 'application/octet-stream',
        })
      }
      offset += part.size
    }
  }
  if (portableData.generatedImageAlbum) {
    const album = []
    for (const entry of portableData.generatedImageAlbum) {
      community.signal?.throwIfAborted()
      const original = await community.readAlbumFile?.(entry.item.id)
      community.signal?.throwIfAborted()
      if (!original || original.size !== entry.item.sizeBytes)
        throw new Error(`相册原图缺失或已变化，未提交备份：${entry.item.name}`)
      const { manifest, blobs } = await createGitHubBundle(
        original,
        entry.item.name,
        undefined,
        undefined,
        { signal: community.signal },
      )
      community.signal?.throwIfAborted()
      addPortableParts(original, manifest, blobs)
      album.push({ item: entry.item, object: manifest })
      localReadBytes += original.size
    }
    portableData = { ...portableData, generatedImageAlbum: parseAlbumBackup(album) }
  }
  if (portableData.communitySources) {
    const data = parseCommunitySourceBackupData(portableData.communitySources.data)
    const attachments: NonNullable<ArchivePortableData['communitySources']>['attachments'] = []
    for (const assetId of collectCommunitySourceLocalAssetIds(data)) {
      community.signal?.throwIfAborted()
      const original = await community.readAttachment?.(assetId)
      community.signal?.throwIfAborted()
      if (!original) throw new Error(`Discord 本地附件缺失，未提交备份：${assetId}`)
      const { manifest, blobs } = await createGitHubBundle(
        original,
        assetId,
        undefined,
        undefined,
        { signal: community.signal },
      )
      community.signal?.throwIfAborted()
      if (assetId !== `asset-${manifest.totalSha256}`)
        throw new Error(`Discord 本地附件完整性校验失败：${assetId}`)
      addPortableParts(original, manifest, blobs)
      attachments.push({
        assetId,
        mimeType: original.type || 'application/octet-stream',
        object: manifest,
      })
      localReadBytes += original.size
    }
    portableData = { ...portableData, communitySources: { data, attachments } }
  }
  const parts: GitHubBundlePart[] = [...objectPlans.values()].map((plan) => ({
    name: plan.name,
    size: plan.size,
    sha256: plan.hash,
  }))
  community.signal?.throwIfAborted()
  return {
    snapshot: {
      format: STRUCTURED_SNAPSHOT_FORMAT,
      version:
        portableData.generatedImageAlbum ||
        portableData.frontendWorkshopProjects ||
        portableData.imageGeneration
          ? STRUCTURED_SNAPSHOT_APPLICATION_VERSION
          : portableData.communitySources
            ? STRUCTURED_SNAPSHOT_COMMUNITY_VERSION
            : STRUCTURED_SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      categories,
      resources: current,
      versions: historic,
      portableData,
      objectContract: {
        algorithm: 'SHA-256',
        immutable: true,
        naming: 'srl-chunk--sha256-{hash}',
      },
    },
    chunks,
    nativeSources,
    objectPlans: [...objectPlans.values()],
    totalSize:
      [...current, ...historic].reduce((total, resource) => total + resource.fileSize, 0) +
      (portableData.communitySources?.attachments.reduce(
        (sum, entry) => sum + entry.object.totalSize,
        0,
      ) ?? 0) +
      (portableData.generatedImageAlbum?.reduce((sum, entry) => sum + entry.object!.totalSize, 0) ??
        0),
    partCount: parts.length,
    localReadBytes,
    descriptorUpdates,
  }
}

export function isStructuredSnapshot(value: unknown): value is StructuredSnapshot {
  const snapshot = value as Partial<StructuredSnapshot>
  return (
    Boolean(snapshot) &&
    snapshot.format === STRUCTURED_SNAPSHOT_FORMAT &&
    [
      LEGACY_STRUCTURED_SNAPSHOT_VERSION,
      LEGACY_STRUCTURED_SNAPSHOT_VERSION_2,
      STRUCTURED_SNAPSHOT_VERSION,
      STRUCTURED_SNAPSHOT_COMMUNITY_VERSION,
      STRUCTURED_SNAPSHOT_APPLICATION_VERSION,
    ].includes(snapshot.version ?? 0) &&
    Array.isArray(snapshot.resources) &&
    Array.isArray(snapshot.versions) &&
    Array.isArray(snapshot.categories) &&
    Boolean(snapshot.portableData) &&
    snapshot.portableData?.version === 1
  )
}

export function parseStructuredSnapshot(value: unknown): StructuredSnapshot {
  if (!isStructuredSnapshot(value)) throw new Error('对象级云备份清单格式无效')
  const snapshot = value as StructuredSnapshot
  if (Number.isNaN(Date.parse(snapshot.createdAt))) throw new Error('对象级云备份时间无效')
  const ids = new Set<string>()
  for (const resource of [...snapshot.resources, ...snapshot.versions]) {
    if (!resource || typeof resource.id !== 'string' || ids.has(resource.id)) {
      throw new Error('对象级云备份包含无效或重复资源 ID')
    }
    ids.add(resource.id)
    resource.object = parseGitHubBundleManifest(resource.object)
    if (
      resource.object.totalSize !== resource.fileSize ||
      resource.object.totalSha256.toLowerCase() !== resource.contentHash.toLowerCase()
    ) {
      throw new Error(`对象级云备份资源校验信息不一致：${resource.fileName}`)
    }
  }
  if (snapshot.portableData.communitySources !== undefined) {
    if (snapshot.version < STRUCTURED_SNAPSHOT_COMMUNITY_VERSION)
      throw new Error('Discord 云备份需要清单修订 4，不能将附件引用写入旧清单修订')
    const community = snapshot.portableData.communitySources
    if (!isRecord(community) || !Array.isArray(community.attachments))
      throw new Error('Discord 云备份附件清单无效')
    community.data = parseCommunitySourceBackupData(community.data)
    const referenced = collectCommunitySourceLocalAssetIds(community.data)
    const seen = new Set<string>()
    for (const entry of community.attachments) {
      if (
        !isRecord(entry) ||
        typeof entry.assetId !== 'string' ||
        typeof entry.mimeType !== 'string' ||
        !referenced.has(entry.assetId) ||
        seen.has(entry.assetId)
      )
        throw new Error('Discord 云备份附件引用无效')
      entry.object = parseGitHubBundleManifest(entry.object)
      if (entry.assetId !== `asset-${entry.object.totalSha256.toLowerCase()}`)
        throw new Error('Discord 云备份附件哈希不一致')
      seen.add(entry.assetId)
    }
    if (seen.size !== referenced.size) throw new Error('Discord 云备份缺少已保存附件')
  }
  if (
    snapshot.portableData.generatedImageAlbum ||
    snapshot.portableData.frontendWorkshopProjects ||
    snapshot.portableData.imageGeneration
  ) {
    if (snapshot.version < STRUCTURED_SNAPSHOT_APPLICATION_VERSION)
      throw new Error('创作资料备份需要清单修订 5')
    if (snapshot.portableData.generatedImageAlbum)
      snapshot.portableData.generatedImageAlbum = parseAlbumBackup(
        snapshot.portableData.generatedImageAlbum,
      )
    if (snapshot.portableData.frontendWorkshopProjects)
      parseFrontendWorkshopBackup(snapshot.portableData.frontendWorkshopProjects)
  }
  return snapshot
}

/** Every consumer (upload, retention, native restore) must see the same binary objects. */
export function structuredSnapshotObjects(snapshot: StructuredSnapshot): GitHubBundleManifest[] {
  return [
    ...snapshot.resources.map((resource) => resource.object),
    ...snapshot.versions.map((resource) => resource.object),
    ...(snapshot.portableData.communitySources?.attachments.map((entry) => entry.object) ?? []),
    ...(snapshot.portableData.generatedImageAlbum?.map((entry) => entry.object!) ?? []),
  ]
}

export function structuredSnapshotParts(snapshot: StructuredSnapshot): GitHubBundlePart[] {
  const unique = new Map<string, GitHubBundlePart>()
  for (const object of structuredSnapshotObjects(snapshot)) {
    for (const part of object.parts) {
      unique.set(part.name, {
        ...part,
        size: part.storedSize ?? part.size,
      })
    }
  }
  return [...unique.values()]
}

export async function materializeStructuredResources(
  records: StructuredResource[],
  readObject: (object: GitHubBundleManifest) => Promise<Blob>,
): Promise<Resource[]> {
  const resources: Resource[] = []
  for (const record of records) {
    resources.push(await materializeStructuredResource(record, readObject))
  }
  return resources
}

export async function materializeStructuredResource(
  record: StructuredResource,
  readObject: (object: GitHubBundleManifest) => Promise<Blob>,
): Promise<Resource> {
  const { object, ...resource } = record
  const originalBlob = await readObject(object)
  const metadata = await restoreStructuredMetadata(resource, originalBlob)
  return { ...resource, metadata, originalBlob }
}
