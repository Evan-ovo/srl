import type { BackupScopeId } from './BackupScopeRegistry'
import { collectCommunitySourceLocalAssetIds } from './CommunitySourceAttachmentArchive'
import { includeResourceGalleryIds } from '../types/ResourceGallery'
import type { ArchivePortableData, PreparedRestore } from '../types/Backup'
import type { CloudBackupItem } from '../types/CloudBackup'
import {
  isUserPersonaAvatarAttachment,
  includeChatCompanionIds,
  RESOURCE_TYPE,
  toResourceListSummary,
  type Category,
  type Resource,
  type ResourceListSummary,
  type ResourceSummary,
} from '../types/Resource'
import type { CategoryService } from './CategoryService'
import type { StructuredSnapshot } from './CloudStructuredSnapshot'
import type { ResourceService } from './ResourceService'
import type { RestoreService } from './RestoreService'

/** Duplicate originals need no insertion, but their saved APP data still needs restoration. */
export function canRestoreOnlyPortableData(prepared: PreparedRestore | undefined): boolean {
  return Boolean(
    prepared &&
    prepared.resources.length === 0 &&
    prepared.portableData &&
    Object.entries(prepared.portableData).some(
      ([key, value]) => key !== 'version' && value != null,
    ),
  )
}

/**
 * Limit an already verified restore plan without reopening or reparsing the archive.
 * Selectors use prepared resource IDs, which remain unique after conflict remapping.
 */
export function selectPreparedRestore(
  prepared: PreparedRestore,
  selectors: ReadonlySet<string>,
  includeGallery = true,
  includeCommunitySources?: boolean,
  includeAttachments = true,
): PreparedRestore {
  const selectedIds = new Set<string>()
  const withCompanions = new Set(selectors)
  includeChatCompanionIds(prepared.resources, withCompanions)
  includeResourceGalleryIds(
    [...prepared.resources, ...(prepared.galleryOwners ?? [])],
    withCompanions,
    includeGallery,
    includeAttachments,
  )
  const selectedResources: Resource[] = []
  for (const resource of prepared.resources) {
    if (!withCompanions.has(resource.id)) continue
    selectedIds.add(resource.id)
    selectedResources.push(resource)
  }

  for (const resource of selectedResources) {
    if (resource.type !== RESOURCE_TYPE.USER_PERSONA) continue
    for (const relatedId of resource.relatedResourceIds ?? []) {
      const related = prepared.resources.find((candidate) => candidate.id === relatedId)
      if (related && isUserPersonaAvatarAttachment(related) && !selectedIds.has(related.id)) {
        selectedIds.add(related.id)
        selectedResources.push(related)
      }
    }
  }

  const versions = prepared.versions.filter(
    (version) => version.versionGroupId && selectedIds.has(version.versionGroupId),
  )
  const categoryIds = new Set(
    selectedResources.flatMap(
      (resource) => resource.categoryIds ?? (resource.categoryId ? [resource.categoryId] : []),
    ),
  )
  const categories = prepared.categories.filter((category) => categoryIds.has(category.id))
  // A complete restore also includes unbound sources and bindings mapped to existing
  // duplicate resources, which are intentionally absent from prepared.resources.
  const allResourcesSelected = prepared.resources.every((resource) => selectedIds.has(resource.id))
  const plannedIds = new Set(prepared.resources.map((resource) => resource.id))
  const communitySourceData =
    includeCommunitySources === false
      ? undefined
      : includeCommunitySources === true && prepared.communitySourceData
        ? {
            ...prepared.communitySourceData,
            bindings: prepared.communitySourceData.bindings.filter(
              (binding) =>
                selectedIds.has(binding.resourceId) || !plannedIds.has(binding.resourceId),
            ),
          }
        : prepared.communitySourceData && !allResourcesSelected
          ? (() => {
              const bindings = prepared.communitySourceData!.bindings.filter((binding) =>
                selectedIds.has(binding.resourceId),
              )
              const sourceIds = new Set(bindings.map((binding) => binding.sourceId))
              return {
                ...prepared.communitySourceData!,
                sources: prepared.communitySourceData!.sources.filter((source) =>
                  sourceIds.has(source.id),
                ),
                messages: prepared.communitySourceData!.messages.filter((message) =>
                  sourceIds.has(message.sourceId),
                ),
                bindings,
              }
            })()
          : prepared.communitySourceData

  const assetIds = communitySourceData
    ? collectCommunitySourceLocalAssetIds(communitySourceData)
    : new Set<string>()
  const communitySourceAttachments = prepared.communitySourceAttachments?.filter((entry) =>
    assetIds.has(entry.assetId),
  )

  return {
    ...prepared,
    portableData: prepared.portableData
      ? {
          ...prepared.portableData,
          resourceGalleryCategories: includeGallery
            ? prepared.portableData.resourceGalleryCategories
            : undefined,
        }
      : undefined,
    forReplacement: undefined,
    resources: selectedResources,
    versions,
    categories,
    communitySourceData,
    communitySourceAttachments,
    preview: {
      ...prepared.preview,
      archiveResourceCount: selectedResources.length,
      resourcesToAdd: selectedResources.length,
      categoriesToCreate: categories.length,
      communitySourceCount: communitySourceData?.sources.length,
      communityMessageCount: communitySourceData?.messages.length,
      communityAttachmentCount: communitySourceAttachments?.length,
    },
  }
}

export function selectStructuredSnapshot(
  snapshot: StructuredSnapshot,
  selectors: ReadonlySet<string>,
  includeGallery = true,
  includeAttachments = true,
): StructuredSnapshot {
  const selectedIds = new Set<string>()
  const withCompanions = new Set(selectors)
  includeChatCompanionIds(snapshot.resources, withCompanions)
  includeResourceGalleryIds(snapshot.resources, withCompanions, includeGallery, includeAttachments)
  const resources = snapshot.resources.filter((resource) => {
    if (!withCompanions.has(resource.id)) return false
    selectedIds.add(resource.id)
    return true
  })
  for (const resource of resources) {
    if (resource.type !== RESOURCE_TYPE.USER_PERSONA) continue
    for (const relatedId of resource.relatedResourceIds ?? []) {
      const related = snapshot.resources.find((candidate) => candidate.id === relatedId)
      if (related && isUserPersonaAvatarAttachment(related)) {
        selectedIds.add(related.id)
        if (!resources.some((candidate) => candidate.id === related.id)) resources.push(related)
      }
    }
  }
  const versions = snapshot.versions.filter(
    (version) => version.versionGroupId && selectedIds.has(version.versionGroupId),
  )
  const categoryIds = new Set(
    resources.flatMap(
      (resource) => resource.categoryIds ?? (resource.categoryId ? [resource.categoryId] : []),
    ),
  )
  return {
    ...snapshot,
    portableData: {
      ...snapshot.portableData,
      resourceGalleryCategories: includeGallery
        ? snapshot.portableData.resourceGalleryCategories
        : undefined,
    },
    resources,
    versions,
    categories: snapshot.categories.filter((category) => categoryIds.has(category.id)),
  }
}

export function listStructuredBackupResources(snapshot: StructuredSnapshot): ResourceSummary[] {
  const versionCounts = new Map<string, number>()
  for (const version of snapshot.versions) {
    if (version.versionGroupId) {
      versionCounts.set(
        version.versionGroupId,
        (versionCounts.get(version.versionGroupId) ?? 0) + 1,
      )
    }
  }
  return snapshot.resources.map(({ object: _object, ...resource }) => ({
    ...resource,
    versionCount: versionCounts.get(resource.id) ?? 0,
  }))
}

export async function readBackupRestoreContents(
  item: CloudBackupItem,
  readStructuredSnapshot: () => Promise<StructuredSnapshot>,
  downloadBackup: () => Promise<Blob>,
  resourceService: Pick<ResourceService, 'listResourceListSummaries'>,
  categoryService: Pick<CategoryService, 'list'>,
  restoreService: Pick<RestoreService, 'prepare'>,
  retainPrepared?: (prepared: PreparedRestore) => void,
): Promise<{
  resources: ResourceSummary[]
  portableData?: ArchivePortableData
  communitySources?: boolean
}> {
  if (item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot') {
    const snapshot = await readStructuredSnapshot()
    return {
      resources: listStructuredBackupResources(snapshot),
      portableData: snapshot.portableData,
    }
  }
  return readArchiveRestoreContents(
    item,
    downloadBackup,
    resourceService,
    categoryService,
    restoreService,
    retainPrepared,
  )
}

async function readArchiveRestoreContents(
  item: Pick<CloudBackupItem, 'archiveName' | 'objectKey'>,
  downloadBackup: () => Promise<Blob>,
  resourceService: Pick<ResourceService, 'listResourceListSummaries'>,
  categoryService: Pick<CategoryService, 'list'>,
  restoreService: Pick<RestoreService, 'prepare'>,
  retainPrepared?: (prepared: PreparedRestore) => void,
): Promise<{
  resources: ResourceListSummary[]
  portableData?: ArchivePortableData
  communitySources?: boolean
}> {
  const blob = await downloadBackup()
  const [resources, categories] = await Promise.all([
    resourceService.listResourceListSummaries(),
    categoryService.list(),
  ])
  const prepared = await restoreService.prepare(
    new File([blob], item.archiveName ?? item.objectKey, { type: 'application/zip' }),
    resources,
    categories as Category[],
    true,
  )
  let retained = false
  try {
    retainPrepared?.(prepared)
    retained = Boolean(retainPrepared)
    return {
      resources: [...prepared.resources, ...(prepared.galleryOwners ?? [])].map((resource) =>
        toResourceListSummary(resource),
      ),
      portableData: prepared.portableData,
      communitySources: Boolean(prepared.communitySourceData),
    }
  } finally {
    if (!retained) await prepared.dispose?.()
  }
}

const PORTABLE_SCOPE_FIELDS: Partial<
  Record<BackupScopeId, readonly (keyof Omit<ArchivePortableData, 'version'>)[]>
> = {
  'extra.communitySources': ['communitySources'],
  'extra.resourceGallery': ['resourceGalleryCategories'],
  'extra.externalApps': ['externalApps'],
  'extra.chatReader': ['chatReader'],
  'extra.assistantData': ['assistantData'],
  'extra.aiTaggingState': ['aiTaggingState'],
  'extra.stitchWork': ['stitchWork'],
  'extra.frontendWorkshopComponents': ['frontendWorkshopComponents'],
  'extra.frontendWorkshopProjects': ['frontendWorkshopProjects'],
  'extra.imageGeneration': ['imageGeneration'],
  'extra.generatedImageAlbum': ['generatedImageAlbum'],
  'extra.appearance': ['appearance'],
  'extra.generalPreferences': ['generalPreferences'],
  'extra.characterDraw': ['characterDraw'],
  'extra.cloudBackup': ['cloudBackup'],
  'extra.credentials': ['mainApiProfiles', 'credentials'],
  'extra.plaintextSecretCopy': ['plaintextSecretCopies'],
}

export function portableRestoreScopeIds(data?: ArchivePortableData): BackupScopeId[] {
  return data
    ? Object.entries(PORTABLE_SCOPE_FIELDS)
        .filter(([, fields]) => fields.some((field) => data[field] !== undefined))
        .map(([id]) => id as BackupScopeId)
    : []
}

export function selectRestorePortableData(
  data: ArchivePortableData | undefined,
  scopeIds?: readonly BackupScopeId[],
): ArchivePortableData | undefined {
  if (!data || scopeIds === undefined) return data
  return {
    version: 1,
    ...Object.fromEntries(
      scopeIds.flatMap((id) =>
        (PORTABLE_SCOPE_FIELDS[id] ?? [])
          .filter((field) => data[field] !== undefined)
          .map((field) => [field, data[field]]),
      ),
    ),
  }
}
