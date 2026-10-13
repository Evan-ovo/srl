import type {
  ResourceMetadataPatch,
  ResourceStorageAdapter,
} from '../storage/ResourceStorageAdapter'
import { galleryOwnerId, isResourceGalleryImage } from '../types/ResourceGallery'
import { moveResourceGallery } from './ResourceGalleryService'
import { RestoreDuplicateIndex } from '../utils/RestoreIdentity'
import {
  getRelatedResourceIds,
  getResourceCategoryIds,
  isUserPersonaAvatarAttachment,
  normalizeResourceLinkUrl,
  normalizeResourceLinks,
  normalizeResource,
  toResourceListSummary,
  RESOURCE_TYPE,
  type Resource,
  type ResourceLink,
  type ResourceType,
  type ResourceListSummary,
} from '../types/Resource'
import {
  hasCharacterCardOverrides,
  normalizeCharacterCardOverrides,
  type CharacterCardOverrides,
} from '../utils/CharacterCardCustomization'
import { readResourceType } from './ResourceVersionIdentity'
import { normalizeTags } from './ResourceLinkImport'
import {
  type ExternalAppResourceUpdate,
  type AiTagMutationEntry,
  type AiTagMutationResult,
} from '../types/ResourceOperations'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import { readCharacterCardContentEdits } from '../utils/CharacterCardContentEdits'

export async function updateExternalAppResource(
  storage: ResourceStorageAdapter,
  update: ExternalAppResourceUpdate,
): Promise<Resource> {
  const resource = await storage.get(update.resourceId)
  if (!resource) throw new Error('要更新的资源已经不存在')

  const name = update.name === undefined ? resource.name : update.name.trim()
  if (!name) throw new Error('资源名称不能为空')
  if (name.length > 160) throw new Error('资源名称不能超过 160 个字符')

  const description =
    update.description === undefined ? resource.description : update.description.trim()
  if (description.length > 20_000) throw new Error('资源说明不能超过 20000 个字符')

  const categoryIds =
    update.categoryIds === undefined
      ? getResourceCategoryIds(resource)
      : Array.from(new Set(update.categoryIds.filter(Boolean)))
  await storage.update(resource.id, {
    name,
    description,
    tags: update.tags === undefined ? resource.tags : normalizeTags(update.tags),
    favorite: update.favorite ?? resource.favorite,
    categoryId: categoryIds[0] ?? null,
    categoryIds,
    updatedAt: Date.now(),
  })
  const updated = await storage.get(resource.id)
  if (!updated) throw new Error('资源更新失败')
  return updated
}

export async function updateDetails(
  storage: ResourceStorageAdapter,
  resource: Resource,
  details: {
    name: string
    authorNote?: string
    description: string
    type: ResourceType
    categoryIds: string[]
    relatedResourceIds: string[]
    tags: string[]
    sourceLinks?: ResourceLink[]
    characterOverrides?: CharacterCardOverrides
    characterContentEdits?: CharacterCardContentEdit[]
  },
): Promise<void> {
  const name = details.name.trim()
  if (!name) throw new Error('资源名称不能为空')
  if (name.length > 160) throw new Error('资源名称不能超过 160 个字符')

  const sourceLinkDrafts = details.sourceLinks ?? []
  const invalidSourceLink = sourceLinkDrafts.find(
    (link) => link.url.trim() && !normalizeResourceLinkUrl(link.url),
  )
  if (invalidSourceLink) throw new Error('资源链接仅支持 http/https 地址')

  const hadManualOverride = readResourceType(resource.metadata.manualTypeOverride)

  const previousRelatedIds = new Set(getRelatedResourceIds(resource))
  const requestedIds = new Set(details.relatedResourceIds.filter((id) => id !== resource.id))
  const affectedResources = []
  // Binding edits need metadata for the selected neighbours, never the whole library
  // or their original card files. Older adapters retain their targeted get() fallback.
  for (const id of new Set([...previousRelatedIds, ...requestedIds])) {
    if (id === resource.id) continue
    const item = await (storage.getSummary ? storage.getSummary(id) : storage.get(id))
    if (item) affectedResources.push(item)
  }
  const existingIds = new Set(affectedResources.map((item) => item.id))
  const relatedResourceIds = [...requestedIds].filter((id) => existingIds.has(id))
  const nextRelatedIds = new Set(relatedResourceIds)
  const categoryIds = Array.from(new Set(details.categoryIds.filter(Boolean)))
  const now = Date.now()
  const metadata: Record<string, unknown> =
    details.type !== resource.type || hadManualOverride
      ? { ...resource.metadata, manualTypeOverride: details.type }
      : { ...resource.metadata }
  if (details.authorNote !== undefined) {
    const authorNote = details.authorNote.trim()
    if (authorNote.length > 160) throw new Error('备注作者不能超过 160 个字符')
    if (authorNote) metadata.authorNote = authorNote
    else delete metadata.authorNote
  }
  metadata.manuallyBoundResourceIds = Array.from(
    new Set([
      ...(Array.isArray(resource.metadata.manuallyBoundResourceIds)
        ? resource.metadata.manuallyBoundResourceIds.filter(
            (id): id is string => typeof id === 'string' && nextRelatedIds.has(id),
          )
        : []),
      ...relatedResourceIds.filter((id) => !previousRelatedIds.has(id)),
    ]),
  )
  if (details.type === RESOURCE_TYPE.CHARACTER_CARD) {
    const characterOverrides = normalizeCharacterCardOverrides(
      details.characterOverrides ?? {},
      relatedResourceIds,
    )
    if (hasCharacterCardOverrides(characterOverrides)) {
      metadata.characterOverrides = characterOverrides
    } else {
      delete metadata.characterOverrides
    }
    const contentEdits = readCharacterCardContentEdits(details.characterContentEdits)
    if (contentEdits.length) metadata.characterContentEdits = contentEdits
    else delete metadata.characterContentEdits
  } else {
    delete metadata.characterOverrides
    delete metadata.characterContentEdits
  }
  // updateMetadata merges metadata patches; explicit undefined removes fields that
  // the complete replacement previously dropped (author note and card overrides).
  for (const key of Object.keys(resource.metadata)) {
    if (!(key in metadata)) metadata[key] = undefined
  }
  const patches: Array<{ id: string; changes: ResourceMetadataPatch }> = [
    {
      id: resource.id,
      changes: {
        name,
        description: details.description.trim(),
        type: details.type,
        categoryId: categoryIds[0] ?? null,
        categoryIds,
        relatedResourceIds,
        sourceLinks: normalizeResourceLinks(sourceLinkDrafts),
        tags: normalizeTags(details.tags),
        metadata,
        updatedAt: now,
      },
    },
  ]
  for (const item of affectedResources) {
    const itemRelatedIds = new Set(getRelatedResourceIds(item))
    if (nextRelatedIds.has(item.id)) itemRelatedIds.add(resource.id)
    else itemRelatedIds.delete(resource.id)
    const manualIds = item.metadata.manuallyBoundResourceIds
    const nextManualIds = Array.isArray(manualIds)
      ? manualIds.filter((id) => typeof id === 'string' && itemRelatedIds.has(id))
      : undefined
    const nextIds = Array.from(itemRelatedIds)
    const previousIds = getRelatedResourceIds(item)
    if (
      nextIds.length === previousIds.length &&
      nextIds.every((id, index) => id === previousIds[index]) &&
      (!nextManualIds || (Array.isArray(manualIds) && nextManualIds.length === manualIds.length))
    )
      continue
    patches.push({
      id: item.id,
      changes: {
        relatedResourceIds: nextIds,
        metadata: {
          ...item.metadata,
          ...(nextManualIds
            ? {
                manuallyBoundResourceIds: nextManualIds,
              }
            : {}),
        },
        updatedAt: now,
      },
    })
  }
  if (storage.updateMetadataMany) await storage.updateMetadataMany(patches)
  else for (const { id, changes } of patches) await storage.update(id, changes)
}

export async function restoreRelatedLinks(
  storage: ResourceStorageAdapter,
  resources: Resource[],
): Promise<void> {
  const restoredIds = new Set(resources.map((resource) => resource.id))
  const requiredLinks = new Map<string, Set<string>>()
  for (const resource of resources) {
    for (const relatedId of getRelatedResourceIds(resource)) {
      if (restoredIds.has(relatedId)) continue
      const sources = requiredLinks.get(relatedId) ?? new Set<string>()
      sources.add(resource.id)
      requiredLinks.set(relatedId, sources)
    }
  }
  const targets = (
    await Promise.all(Array.from(requiredLinks.keys(), (id) => storage.get(id)))
  ).flatMap((resource) => (resource ? [resource] : []))
  const now = Date.now()
  const changed = targets.flatMap((resource) => {
    const additions = requiredLinks.get(resource.id)
    if (!additions?.size) return []
    const relatedResourceIds = new Set(getRelatedResourceIds(resource))
    const before = relatedResourceIds.size
    for (const sourceId of additions) relatedResourceIds.add(sourceId)
    if (relatedResourceIds.size === before) return []
    return [
      normalizeResource({
        ...resource,
        relatedResourceIds: Array.from(relatedResourceIds),
        updatedAt: now,
      }),
    ]
  })
  if (changed.length) await storage.saveMany(changed)
}

export async function moveManyToCategory(
  storage: ResourceStorageAdapter,
  ids: string[],
  categoryId: string | null,
): Promise<void> {
  if (!ids.length) return
  const selectedIds = new Set(ids)
  const now = Date.now()
  const resources = (await storage.list())
    .filter((resource) => selectedIds.has(resource.id))
    .map((resource) => {
      const categoryIds = categoryId
        ? Array.from(new Set([...getResourceCategoryIds(resource), categoryId]))
        : []
      return normalizeResource({
        ...resource,
        categoryId: categoryIds[0] ?? null,
        categoryIds,
        updatedAt: now,
      })
    })
  await storage.saveMany(resources)
}

export async function updateTagsMany(
  storage: ResourceStorageAdapter,
  ids: string[],
  tag: string,
  action: 'add' | 'remove',
): Promise<void> {
  const normalizedTag = tag.trim()
  if (!ids.length || !normalizedTag) throw new Error('请输入标签名称')
  const selectedIds = new Set(ids)
  const now = Date.now()
  const resources = (await storage.list())
    .filter((resource) => selectedIds.has(resource.id))
    .map((resource) => ({
      ...resource,
      tags:
        action === 'add'
          ? normalizeTags([...resource.tags, normalizedTag])
          : resource.tags.filter(
              (item) => item.toLocaleLowerCase() !== normalizedTag.toLocaleLowerCase(),
            ),
      updatedAt: now,
    }))
  await storage.saveMany(resources)
}

export async function addTagsPerResource(
  storage: ResourceStorageAdapter,
  suggestions: Array<{ resourceId: string; tags: string[] }>,
  preserveTagLength = false,
): Promise<AiTagMutationResult> {
  const tagsById = new Map(
    suggestions.flatMap((suggestion) => {
      const resourceId = suggestion.resourceId.trim()
      const tags = normalizeTags(suggestion.tags).map((tag) =>
        preserveTagLength ? tag : tag.slice(0, 40),
      )
      return resourceId && tags.length ? [[resourceId, tags] as const] : []
    }),
  )
  if (!tagsById.size) return { resourceCount: 0, tagCount: 0, entries: [] }
  const loaded = storage.listResourceListSummaries
    ? await storage.listResourceListSummaries()
    : await storage.listSummaries()
  const now = Date.now()
  const mutations = loaded.flatMap((resource) => {
    if (!tagsById.has(resource.id)) return []
    const seen = new Set(resource.tags.map((tag) => tag.toLocaleLowerCase()))
    const nextTags = [...resource.tags]
    const addedTags: string[] = []
    for (const tag of tagsById.get(resource.id) ?? []) {
      const key = tag.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      nextTags.push(tag)
      addedTags.push(tag)
    }
    return !addedTags.length
      ? []
      : [
          {
            resource: { ...resource, tags: nextTags, updatedAt: now },
            entry: {
              resourceId: resource.id,
              resourceName: resource.name,
              tags: addedTags,
            },
          },
        ]
  })
  for (const { resource } of mutations)
    await storage.update(resource.id, { tags: resource.tags, updatedAt: now })
  const entries = mutations.map((mutation) => mutation.entry)
  return {
    resourceCount: entries.length,
    tagCount: entries.reduce((total, entry) => total + entry.tags.length, 0),
    entries,
  }
}

export async function undoAddedTags(
  storage: ResourceStorageAdapter,
  entries: AiTagMutationEntry[],
): Promise<AiTagMutationResult> {
  const byId = new Map(
    entries.flatMap((entry) => {
      const resourceId = entry.resourceId.trim()
      const tags = normalizeTags(entry.tags).map((tag) => tag.slice(0, 40))
      return resourceId && tags.length ? [[resourceId, tags] as const] : []
    }),
  )
  if (!byId.size) return { resourceCount: 0, tagCount: 0, entries: [] }
  const loaded = await Promise.all(Array.from(byId.keys(), (id) => storage.get(id)))
  const now = Date.now()
  const mutations = loaded.flatMap((resource) => {
    if (!resource) return []
    const targets = new Set(byId.get(resource.id) ?? [])
    const removedTags = resource.tags.filter((tag) => targets.has(tag))
    if (!removedTags.length) return []
    return [
      {
        resource: {
          ...resource,
          tags: resource.tags.filter((tag) => !targets.has(tag)),
          updatedAt: now,
        },
        entry: {
          resourceId: resource.id,
          resourceName: resource.name,
          tags: removedTags,
        },
      },
    ]
  })
  if (mutations.length) await storage.saveMany(mutations.map((mutation) => mutation.resource))
  const removedEntries = mutations.map((mutation) => mutation.entry)
  return {
    resourceCount: removedEntries.length,
    tagCount: removedEntries.reduce((total, entry) => total + entry.tags.length, 0),
    entries: removedEntries,
  }
}

export async function deleteResource(storage: ResourceStorageAdapter, id: string): Promise<void> {
  await deleteMany(storage, [id])
}

export async function deleteMany(
  storage: ResourceStorageAdapter,
  ids: string[],
  onProgress?: (progress: { completed: number; total: number }) => void,
): Promise<ResourceListSummary[] | undefined> {
  if (!ids.length) return
  // Surface the destructive phase before relation cleanup and the IndexedDB
  // transaction start; Web storage cannot report progress inside that transaction.
  onProgress?.({ completed: 0, total: ids.length })
  const deletedIds = new Set(ids)
  const summaries = storage.listResourceListSummaries
    ? await storage.listResourceListSummaries()
    : await storage.listSummaries()
  for (const image of summaries) {
    if (isResourceGalleryImage(image) && deletedIds.has(galleryOwnerId(image)))
      deletedIds.add(image.id)
  }
  const now = Date.now()
  for (const resource of summaries) {
    if (deletedIds.has(resource.id)) continue
    const currentRelatedIds = getRelatedResourceIds(resource)
    const relatedResourceIds = currentRelatedIds.filter((relatedId) => !deletedIds.has(relatedId))
    if (relatedResourceIds.length !== currentRelatedIds.length)
      await storage.update(resource.id, { relatedResourceIds, updatedAt: now })
  }
  await storage.deleteMany([...deletedIds], onProgress)
  // An image may finish saving after the initial summary read but before its owner is
  // deleted. After deletion no new import can validate this owner; sweep that narrow gap.
  const afterDelete = await (storage.listResourceListSummaries?.() ?? storage.listSummaries())
  const lateImages = afterDelete.filter(
    (image) => isResourceGalleryImage(image) && deletedIds.has(galleryOwnerId(image)),
  )
  if (lateImages.length) await storage.deleteMany(lateImages.map((image) => image.id))
  const lateIds = new Set(lateImages.map((image) => image.id))
  return afterDelete.filter((resource) => !lateIds.has(resource.id)).map(toResourceListSummary)
}

/** 同内容副本的组织信息归并；成功写入保留项后沿用 Service 删除入口清理反向关联。 */
export async function mergeDuplicates(
  storage: ResourceStorageAdapter,
  deleteResource: (id: string) => Promise<void>,
  keepId: string,
  removeIds: string[],
): Promise<number> {
  const keeper = await storage.get(keepId)
  if (!keeper) throw new Error('要保留的资源已经不存在')
  const targets = (
    await Promise.all(removeIds.filter((id) => id !== keepId).map((id) => storage.get(id)))
  ).flatMap((resource) => (resource ? [resource] : []))
  if (!targets.length) return 0
  const mismatched = targets.find((resource) => resource.contentHash !== keeper.contentHash)
  if (mismatched) throw new Error(`「${mismatched.name}」与保留项内容不同，不能作为重复项清理`)
  const summaries = await storage.listSummaries()
  if ([keeper, ...targets].some(isUserPersonaAvatarAttachment)) {
    const identities = new RestoreDuplicateIndex([], summaries)
    identities.add(keeper, keeper.id)
    if (targets.some((target) => identities.find(target) !== keeper.id))
      throw new Error('头像身份或所属人设不同，不能作为重复附件清理')
  }

  const mergedCategoryIds = Array.from(
    new Set([
      ...getResourceCategoryIds(keeper),
      ...targets.flatMap((resource) => getResourceCategoryIds(resource)),
    ]),
  )
  const mergedTags = normalizeTags([
    ...keeper.tags,
    ...targets.flatMap((resource) => resource.tags),
  ])
  const mergedRelatedIds = Array.from(
    new Set([
      ...getRelatedResourceIds(keeper),
      ...targets.flatMap((resource) => getRelatedResourceIds(resource)),
    ]),
  ).filter((id) => id !== keeper.id && !removeIds.includes(id))
  await storage.update(keeper.id, {
    categoryId: mergedCategoryIds[0] ?? null,
    categoryIds: mergedCategoryIds,
    tags: mergedTags,
    relatedResourceIds: mergedRelatedIds,
    favorite: keeper.favorite || targets.some((resource) => resource.favorite),
    updatedAt: Date.now(),
  })
  // Move incoming references before deleting copies; deleting alone would detach their owners.
  for (const target of targets) await moveResourceGallery(storage, target.id, keeper.id)
  const removedIds = new Set(targets.map((target) => target.id))
  for (const summary of summaries) {
    if (summary.id === keeper.id || removedIds.has(summary.id)) continue
    if (!getRelatedResourceIds(summary).some((id) => removedIds.has(id))) continue
    const resource = await storage.get(summary.id)
    if (!resource) continue
    const replaceIds = (ids: string[]) =>
      Array.from(new Set(ids.map((id) => (removedIds.has(id) ? keeper.id : id)))).filter(
        (id) => id !== resource.id,
      )
    const manualIds = resource.metadata.manuallyBoundResourceIds
    await storage.update(resource.id, {
      relatedResourceIds: replaceIds(getRelatedResourceIds(resource)),
      ...(Array.isArray(manualIds)
        ? {
            metadata: {
              ...resource.metadata,
              manuallyBoundResourceIds: replaceIds(
                manualIds.filter((id): id is string => typeof id === 'string'),
              ),
            },
          }
        : {}),
      updatedAt: Date.now(),
    })
  }
  for (const target of targets) {
    await deleteResource(target.id)
  }
  return targets.length
}

/** 把新资源与来源资源建立双向关联；来源已删除的 id 会被静默跳过。 */
export async function linkRelatedResources(
  storage: ResourceStorageAdapter,
  resourceId: string,
  relatedIds: string[],
): Promise<string[]> {
  const now = Date.now()
  const targets = (
    await Promise.all(
      Array.from(new Set(relatedIds))
        .filter((id) => id && id !== resourceId)
        .map((id) => storage.get(id)),
    )
  ).flatMap((resource) => (resource ? [resource] : []))
  if (targets.length) {
    await storage.saveMany(
      targets.map((target) =>
        normalizeResource({
          ...target,
          relatedResourceIds: Array.from(new Set([...getRelatedResourceIds(target), resourceId])),
          updatedAt: now,
        }),
      ),
    )
  }
  return targets.map((target) => target.id)
}

/** 把两个或更多已入库资源设为双向关联，供成套但仍保持原生格式的资源使用。 */
export async function linkResources(
  storage: ResourceStorageAdapter,
  resourceIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(resourceIds.filter(Boolean)))
  if (ids.length < 2) return

  const source = await storage.get(ids[0]!)
  if (!source) throw new Error('无法关联：主资源不存在或已被删除')

  const linkedIds = await linkRelatedResources(storage, source.id, ids.slice(1))
  await storage.update(source.id, {
    relatedResourceIds: Array.from(
      new Set([...getRelatedResourceIds(source), ...linkedIds]),
    ).filter((id) => id !== source.id),
    updatedAt: Date.now(),
  })
}
