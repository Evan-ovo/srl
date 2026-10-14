import { chatCharacterSummary } from './ChatReaderCharacter'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import type { ExternalAppResourceSnapshot } from './ExternalAppSdkService'
const MAX_RESOURCE_DATA_BYTES = 512 * 1024
const textEncoder = new TextEncoder()
function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(metadata)
  if (json === undefined || textEncoder.encode(json).byteLength > MAX_RESOURCE_DATA_BYTES)
    throw new Error('该资源可供 APP 读取的数据过大')
  return JSON.parse(json) as Record<string, unknown>
}

export function toSnapshot(
  resource: ResourceSummary | Resource,
  includeData = false,
): ExternalAppResourceSnapshot {
  return {
    apiVersion: 'srl-resource@1',
    id: resource.id,
    type: resource.type,
    name: resource.name,
    description: resource.description,
    tags: [...resource.tags],
    favorite: resource.favorite,
    categoryIds: Array.isArray(resource.categoryIds)
      ? [...resource.categoryIds]
      : resource.categoryId
        ? [resource.categoryId]
        : [],
    relatedResourceIds: Array.isArray(resource.relatedResourceIds)
      ? [...resource.relatedResourceIds]
      : [],
    revision: resource.updatedAt,
    format: typeof resource.metadata.format === 'string' ? resource.metadata.format : 'unknown',
    formatVersion:
      typeof resource.metadata.parserVersion === 'number' ? resource.metadata.parserVersion : 1,
    ...(resource.type === RESOURCE_TYPE.CHAT
      ? {
          messageCount: Number(resource.metadata.messageCount) || 0,
          chatCharacter: chatCharacterSummary(resource.metadata),
        }
      : {}),
    ...(includeData ? { data: cloneMetadata(resource.metadata) } : {}),
  }
}
