import { toRaw } from 'vue'
import { isEncodedBlobValue } from './AndroidAppDatabaseMigration'
import {
  normalizeResource,
  normalizeResourceLinks,
  type Resource,
  type ResourceType,
} from '../types/Resource'
import {
  isEncryptedResource,
  isEncryptedResourceSummary,
  isNativeBackedResource,
  type StoredResource,
  type StoredResourceSummary,
} from '../types/Vault'

export function cloneJsonValue(value: unknown, depth = 0): unknown {
  const rawValue = toRaw(value)
  if (
    rawValue === null ||
    typeof rawValue === 'string' ||
    typeof rawValue === 'number' ||
    typeof rawValue === 'boolean'
  ) {
    return rawValue
  }
  if (typeof rawValue === 'bigint') return rawValue.toString()
  if (
    typeof rawValue === 'undefined' ||
    typeof rawValue === 'function' ||
    typeof rawValue === 'symbol'
  ) {
    return undefined
  }
  if (depth > 32) return undefined
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => cloneJsonValue(item, depth + 1))
      .filter((item) => typeof item !== 'undefined')
  }
  if (rawValue instanceof Date) return rawValue.toISOString()
  if (rawValue instanceof RegExp) return rawValue.source
  if (rawValue instanceof Error) return rawValue.message
  if (!rawValue || typeof rawValue !== 'object') return undefined

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(rawValue as Record<string, unknown>)) {
    const cloned = cloneJsonValue(item, depth + 1)
    if (typeof cloned !== 'undefined') output[key] = cloned
  }
  return output
}

export function cloneStringArray(value: unknown): string[] {
  const rawValue = toRaw(value)
  return Array.isArray(rawValue)
    ? Array.from(new Set(rawValue.filter((item): item is string => typeof item === 'string')))
    : []
}

export function cloneOptionalString(value: unknown): string | undefined {
  const rawValue = toRaw(value)
  return typeof rawValue === 'string' ? rawValue : undefined
}

export function cloneOptionalNumber(value: unknown): number | undefined {
  const rawValue = toRaw(value)
  return Number.isFinite(rawValue) ? Number(rawValue) : undefined
}

export async function cloneBlob(value: unknown): Promise<Blob | undefined> {
  const rawValue = toRaw(value)
  if (!(rawValue instanceof Blob)) return undefined
  // WebKit can reject a File object during IndexedDB structured cloning even
  // though the same bytes are accepted as a plain Blob. Materialize the bytes
  // before persistence without changing the public Resource shape. Wrapping a
  // File in a new Blob is not sufficient: WebKit can retain the source file
  // backing during structured cloning.
  if (typeof File !== 'undefined' && rawValue instanceof File) {
    if (rawValue.size > 1024 * 1024) {
      const parts: Blob[] = []
      // Detach file backing for WebKit without a whole-file ArrayBuffer/copy.
      for (let offset = 0; offset < rawValue.size; offset += 1024 * 1024) {
        const bytes = await rawValue.slice(offset, offset + 1024 * 1024).arrayBuffer()
        parts.push(new Blob([bytes]))
      }
      return new Blob(parts, { type: rawValue.type })
    }
    const bytes = await rawValue.arrayBuffer()
    return new Blob([bytes], { type: rawValue.type })
  }
  return rawValue
}

export async function cloneResourceForStorage(resource: Resource): Promise<Resource> {
  const rawResource = toRaw(resource)
  const originalBlob = await cloneBlob(rawResource.originalBlob)
  if (!originalBlob) throw new Error('资源原始文件无法保存，请刷新页面后重试。')

  return normalizeResource({
    id: rawResource.id,
    type: rawResource.type as ResourceType,
    name: rawResource.name,
    description: rawResource.description,
    fileName: rawResource.fileName,
    mimeType: rawResource.mimeType,
    fileSize: Number(rawResource.fileSize) || 0,
    contentHash: rawResource.contentHash,
    backupDescriptor: cloneJsonValue(rawResource.backupDescriptor) as
      Resource['backupDescriptor'] | undefined,
    favorite: rawResource.favorite === true,
    categoryId: cloneOptionalString(rawResource.categoryId) ?? null,
    categoryIds: cloneStringArray(rawResource.categoryIds),
    relatedResourceIds: cloneStringArray(rawResource.relatedResourceIds),
    sourceLinks: normalizeResourceLinks(rawResource.sourceLinks),
    tags: cloneStringArray(rawResource.tags),
    metadata: (cloneJsonValue(rawResource.metadata) ?? {}) as Record<string, unknown>,
    versionGroupId: cloneOptionalString(rawResource.versionGroupId),
    versionImportedAt: cloneOptionalNumber(rawResource.versionImportedAt),
    versionLabel: cloneOptionalString(rawResource.versionLabel),
    versionNote: cloneOptionalString(rawResource.versionNote),
    versionCount: cloneOptionalNumber(rawResource.versionCount),
    thumbnailAssetId: cloneOptionalString(rawResource.thumbnailAssetId),
    thumbnailBlob: await cloneBlob(rawResource.thumbnailBlob),
    originalBlob,
    createdAt: Number(rawResource.createdAt) || Date.now(),
    updatedAt: Number(rawResource.updatedAt) || Date.now(),
  })
}

export async function materializeResourceForIndexedDb(
  resource: StoredResource,
): Promise<StoredResource> {
  if (isEncryptedResource(resource) || isNativeBackedResource(resource)) return resource
  if (!(resource.originalBlob instanceof Blob)) return resource
  // Large ArrayBuffers exceed browser IPC/IDB record limits and duplicate the full file in JS.
  // The decoder already accepts both forms; keep existing small-record compatibility.
  if (resource.originalBlob.size > 1024 * 1024) return resource
  return {
    ...resource,
    originalBlob: await resource.originalBlob.arrayBuffer(),
  } as unknown as StoredResource
}

export function hydrateResourceFromIndexedDb(resource: StoredResource): Resource {
  if (isEncryptedResource(resource) || isNativeBackedResource(resource))
    return resource as unknown as Resource
  const originalBlob = resource.originalBlob as unknown
  if (originalBlob instanceof Blob) return resource
  if (!(originalBlob instanceof ArrayBuffer)) return resource
  return {
    ...resource,
    originalBlob: new Blob([originalBlob], { type: resource.mimeType }),
  }
}

export function storedResourceBinarySize(resource: StoredResource): number {
  if (isEncryptedResource(resource)) return resource.original.data.size
  if (isNativeBackedResource(resource)) return resource.nativeOriginal.size
  const originalBlob = resource.originalBlob as unknown
  if (originalBlob instanceof Blob) return originalBlob.size
  if (originalBlob instanceof ArrayBuffer) return originalBlob.byteLength
  if (isEncodedBlobValue(originalBlob)) return originalBlob.size
  return 0
}

export function stripStableResourceBinaryFields(resource: StoredResource): Partial<StoredResource> {
  if (isEncryptedResource(resource)) {
    const { original: _original, thumbnail: _thumbnail, ...patch } = resource
    return patch as Partial<StoredResource>
  }
  if (isNativeBackedResource(resource)) {
    const { thumbnailBlob: _thumbnailBlob, ...patch } = resource
    return patch
  }

  const { originalBlob: _originalBlob, thumbnailBlob: _thumbnailBlob, ...patch } = resource
  return patch as Partial<StoredResource>
}

export function stripStableSummaryBinaryFields(
  summary: StoredResourceSummary,
): Partial<StoredResourceSummary> {
  if (isEncryptedResourceSummary(summary)) {
    const { thumbnail: _thumbnail, ...patch } = summary
    return patch as Partial<StoredResourceSummary>
  }

  const { thumbnailBlob: _thumbnailBlob, ...patch } = summary
  return patch as Partial<StoredResourceSummary>
}
