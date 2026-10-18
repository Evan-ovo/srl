import { isResourceOwnedFile } from '../types/ResourceAttachment'
import {
  isUserPersonaAvatarAttachment,
  RESOURCE_TYPE,
  type ResourceSummary,
} from '../types/Resource'
import { RestoreDuplicateIndex } from './RestoreIdentity'

export interface DuplicateGroup {
  contentHash: string
  /** 组内按更新时间倒序，第一项为建议保留的最新副本。 */
  resources: ResourceSummary[]
}

/**
 * 按内容指纹找出库内完全重复的资源。
 *
 * 普通资源比较 contentHash；人设头像还必须匹配头像身份及所属人设。
 * 名称、标签或文件夹不同不影响判定；每组按更新时间倒序排列。
 */
export function findDuplicateGroups(resources: ResourceSummary[]): DuplicateGroup[] {
  const byHash = new Map<string, ResourceSummary[]>()
  const identities = new RestoreDuplicateIndex([], resources)
  for (const resource of resources) {
    if (isResourceOwnedFile(resource)) continue
    if (!resource.contentHash) continue
    const existingId = identities.find(resource)
    const key = isUserPersonaAvatarAttachment(resource)
      ? `avatar:${existingId ?? resource.id}`
      : resource.contentHash.toLowerCase()
    identities.add(resource, existingId ?? resource.id)
    const bucket = byHash.get(key)
    if (bucket) bucket.push(resource)
    else byHash.set(key, [resource])
  }
  return Array.from(byHash.entries())
    .filter(([, group]) => group.length > 1)
    .map(([contentHash, group]) => ({
      contentHash,
      resources: [...group].sort((left, right) => right.updatedAt - left.updatedAt),
    }))
    .sort((left, right) => right.resources.length - left.resources.length)
}

export interface ContainerVariantGroup {
  cardContentHash: string
  /** 组内 PNG 优先（保留立绘），同封装按更新时间倒序；第一项为建议保留项。 */
  resources: ResourceSummary[]
}

function isPng(resource: ResourceSummary): boolean {
  return resource.mimeType === 'image/png' || /\.png$/i.test(resource.fileName)
}

/**
 * 找出「同卡不同封装」的角色卡：卡内容指纹一致、但文件指纹不同
 * （典型为同一张卡的 PNG 与 JSON 导出）。文件指纹完全相同的组
 * 属于精确重复，由 findDuplicateGroups 处理，这里排除。
 */
export function findContainerVariantGroups(resources: ResourceSummary[]): ContainerVariantGroup[] {
  const byCardHash = new Map<string, ResourceSummary[]>()
  for (const resource of resources) {
    if (resource.type !== RESOURCE_TYPE.CHARACTER_CARD) continue
    const cardHash = resource.metadata.cardContentHash
    if (typeof cardHash !== 'string' || !cardHash) continue
    const bucket = byCardHash.get(cardHash)
    if (bucket) bucket.push(resource)
    else byCardHash.set(cardHash, [resource])
  }
  return Array.from(byCardHash.entries())
    .filter(
      ([, group]) => group.length > 1 && new Set(group.map((item) => item.contentHash)).size > 1,
    )
    .map(([cardContentHash, group]) => ({
      cardContentHash,
      resources: [...group].sort(
        (left, right) =>
          Number(isPng(right)) - Number(isPng(left)) || right.updatedAt - left.updatedAt,
      ),
    }))
    .sort((left, right) => right.resources.length - left.resources.length)
}
