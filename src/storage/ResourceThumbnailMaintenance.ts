import type { AppDatabase } from '../database/AppDatabase'

import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import type { VaultService } from '../services/VaultService'

import { normalizeResource } from '../types/Resource'

import {
  isEncryptedResource,
  isEncryptedResourceSummary,
  type StoredResource,
  type StoredResourceSummary,
} from '../types/Vault'

import { IndexedDbAssetStore } from './IndexedDbAssetStore'

import { hydrateResourceFromIndexedDb } from './ResourceStorageClone'
import { createImageThumbnail } from '../utils/createImageThumbnail'

export interface ResourceThumbnailMaintenanceContext {
  thumbnailMigrationPromise: Promise<number> | undefined
  database: AppDatabase
  assets: IndexedDbAssetStore
  vault: VaultService | undefined
  loadResource: (id: string) => Promise<Resource | undefined>
  toStoredSummary: (resource: StoredResource) => StoredResourceSummary
  createStoredListSummariesFromSummaries: (
    summaries: StoredResourceSummary[],
  ) => Promise<StoredResourceSummary[]>
  repairResourceListSummaryIndex: (force?: boolean) => Promise<void>
}
export const THUMBNAIL_ASSET_MIGRATION_SETTING_ID = 'migration.resourceThumbnails.asset.v23'

export const THUMBNAIL_ASSET_REPAIR_SETTING_ID = 'repair.resourceThumbnails.asset.v24'

export const THUMBNAIL_EMBEDDED_REPAIR_SETTING_ID = 'repair.resourceThumbnails.asset.v25'

export const MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID = 'repair.resourceThumbnails.missingPng.v28'
const LEGACY_MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID = 'repair.resourceThumbnails.missingPng.v27'

export const THUMBNAIL_MIGRATION_BATCH_SIZE = 25

export interface ThumbnailAssetMigrationState {
  version: 23
  status: 'running' | 'complete'
  stage: 'resources' | 'resourceVersions' | 'complete'
  checkpoint?: string
  migrated: number
}

export interface ThumbnailAssetRepairState {
  version: 24
  status: 'running' | 'complete'
  stage: 'resources' | 'resourceVersions' | 'complete'
  checkpoint?: string
  repaired: number
}

export interface ThumbnailEmbeddedRepairState {
  version: 25
  status: 'running' | 'complete'
  stage: 'resources' | 'resourceVersions' | 'complete'
  checkpoint?: string
  repaired: number
}

export interface MissingPngThumbnailRepairState {
  version: 28
  status: 'running' | 'complete'
  checkpoint?: string
  repaired: number
}

export interface MissingPngThumbnailRepairStatus {
  status: 'not-started' | 'running' | 'complete'
  repaired: number
}

export function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}
export function repairThumbnailAssets(
  context: ResourceThumbnailMaintenanceContext,
): Promise<number> {
  if (context.thumbnailMigrationPromise) return context.thumbnailMigrationPromise
  const operation = (async () => {
    const [legacyState, unlinkedState, embeddedState] = await Promise.all([
      context.database.settings.get(THUMBNAIL_ASSET_MIGRATION_SETTING_ID),
      context.database.settings.get(THUMBNAIL_ASSET_REPAIR_SETTING_ID),
      context.database.settings.get(THUMBNAIL_EMBEDDED_REPAIR_SETTING_ID),
    ])
    const needsRefresh =
      (legacyState?.value as Partial<ThumbnailAssetMigrationState> | undefined)?.status !==
        'complete' ||
      (unlinkedState?.value as Partial<ThumbnailAssetRepairState> | undefined)?.status !==
        'complete' ||
      (embeddedState?.value as Partial<ThumbnailEmbeddedRepairState> | undefined)?.status !==
        'complete'
    await migrateLegacyThumbnails(context)
    await repairUnlinkedThumbnailAssets(context)
    await repairEmbeddedThumbnailAssets(context)
    return needsRefresh ? 1 : 0
  })()
  context.thumbnailMigrationPromise = operation
  void operation
    .finally(() => {
      if (context.thumbnailMigrationPromise === operation)
        context.thumbnailMigrationPromise = undefined
    })
    .catch(() => undefined)
  return operation
}

/** Backfill previews for older PNG cards that were imported before background preview support. */
export async function getMissingPngThumbnailRepairStatus(
  context: ResourceThumbnailMaintenanceContext,
): Promise<MissingPngThumbnailRepairStatus> {
  const saved = await context.database.settings.get(MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID)
  const value = saved?.value as Partial<MissingPngThumbnailRepairState> | undefined
  if (value?.version === 28 && (value.status === 'running' || value.status === 'complete'))
    return { status: value.status, repaired: value.repaired ?? 0 }

  const legacy = await context.database.settings.get(LEGACY_MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID)
  const legacyValue = legacy?.value as
    { version?: number; status?: string; repaired?: number } | undefined
  if (legacyValue?.version === 27 && legacyValue.status === 'running')
    return { status: 'running', repaired: legacyValue.repaired ?? 0 }
  return { status: 'not-started', repaired: 0 }
}

export async function repairMissingPngCharacterCardThumbnails(
  context: ResourceThumbnailMaintenanceContext,
  options: { restart?: boolean; signal?: AbortSignal } = {},
): Promise<number> {
  options.signal?.throwIfAborted()
  if (context.vault?.getStatus().locked) return 0

  const saved = await context.database.settings.get(MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID)
  let previous = saved?.value as Partial<MissingPngThumbnailRepairState> | undefined
  if (previous?.version !== 28) {
    const legacy = await context.database.settings.get(
      LEGACY_MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID,
    )
    const legacyValue = legacy?.value as
      { version?: number; status?: string; checkpoint?: string; repaired?: number } | undefined
    previous =
      legacyValue?.version === 27 && legacyValue.status === 'running'
        ? { checkpoint: legacyValue.checkpoint, repaired: legacyValue.repaired }
        : undefined
  }
  if (previous?.version === 28 && previous.status === 'complete') {
    if (!options.restart) return 0
    previous = undefined
  }

  let checkpoint = previous?.checkpoint
  let repaired = previous?.repaired ?? 0
  await context.database.settings.put({
    id: MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID,
    value: { version: 28, status: 'running', checkpoint, repaired },
    updatedAt: Date.now(),
  })

  const table = context.database.resourceSummaries
  // Enumerate IDs once: a native primary-key cursor can otherwise rescan the entire
  // table for every page. Only the current batch's summary values cross the bridge.
  const ids = await (
    checkpoint ? table.where('id').above(checkpoint) : table.orderBy('id')
  ).primaryKeys()
  for (let offset = 0; offset < ids.length; offset += THUMBNAIL_MIGRATION_BATCH_SIZE) {
    options.signal?.throwIfAborted()
    const batchIds = ids.slice(offset, offset + THUMBNAIL_MIGRATION_BATCH_SIZE)
    const batch = (await table.bulkGet(batchIds)).filter(
      (summary): summary is StoredResourceSummary => summary !== undefined,
    )

    let batchRepaired = 0
    let completedId = checkpoint
    const prepareSummary = async (summary: StoredResourceSummary) => {
      options.signal?.throwIfAborted()
      if (
        !isEncryptedResourceSummary(summary) &&
        summary.type === RESOURCE_TYPE.CHARACTER_CARD &&
        summary.thumbnailAssetId
      ) {
        const asset = await context.assets.get(summary.thumbnailAssetId)
        options.signal?.throwIfAborted()
        if (
          !asset?.thumbnailRefs.card &&
          (await context.assets.thumbnails.prepareCard(summary.thumbnailAssetId))
        )
          batchRepaired++
        return
      }
      if (
        isEncryptedResourceSummary(summary) ||
        summary.type !== RESOURCE_TYPE.CHARACTER_CARD ||
        summary.thumbnailAssetId ||
        summary.thumbnailBlob instanceof Blob ||
        !(summary.mimeType === 'image/png' || /\.png$/iu.test(summary.fileName))
      )
        return

      const resource = await context.loadResource(summary.id)
      if (
        !resource ||
        !(resource.mimeType === 'image/png' || /\.png$/iu.test(resource.fileName)) ||
        !(resource.originalBlob instanceof Blob)
      )
        return

      options.signal?.throwIfAborted()
      const thumbnail = await createImageThumbnail(resource.originalBlob, {
        maxEdge: 640,
        allowImageElement: true,
      })
      if (!thumbnail) return
      const asset = await context.assets.put(thumbnail, { source: 'thumbnail' })
      if (!options.signal?.aborted) await context.assets.thumbnails.prepareCard(asset.assetId)
      const updated = { ...resource, thumbnailAssetId: asset.assetId, thumbnailBlob: undefined }
      const storedSummary = context.toStoredSummary(updated as StoredResource)
      const [listSummary] = await context.createStoredListSummariesFromSummaries([storedSummary])
      if (!listSummary) return

      await context.database.transaction(
        'rw',
        context.database.resources,
        context.database.resourceSummaries,
        context.database.resourceListSummaries,
        async () => {
          const current = await context.database.resources.get(resource.id)
          if (!current || isEncryptedResource(current)) return
          if (current.thumbnailAssetId || current.thumbnailBlob instanceof Blob) return
          await context.database.resources.update(resource.id, (record) => {
            if (isEncryptedResource(record)) return
            record.thumbnailAssetId = asset.assetId
            record.thumbnailBlob = undefined
          })
          await context.database.resourceSummaries.put(listSummary)
          await context.database.resourceListSummaries.put(listSummary)
          batchRepaired++
        },
      )
    }
    let interrupted: unknown
    try {
      for (const summary of batch) {
        await prepareSummary(summary)
        completedId = summary.id
      }
    } catch (error) {
      interrupted = error
    }

    // Publish completed items before acknowledging a stop; resume never skips the interrupted item.
    checkpoint = interrupted ? completedId : batchIds.at(-1)!
    repaired += batchRepaired
    await context.database.settings.put({
      id: MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID,
      value: {
        version: 28,
        status: 'running',
        checkpoint,
        repaired,
      } satisfies MissingPngThumbnailRepairState,
      updatedAt: Date.now(),
    })
    if (interrupted) throw interrupted
    options.signal?.throwIfAborted()
    if (offset + THUMBNAIL_MIGRATION_BATCH_SIZE < ids.length) await yieldMainThread()
  }

  options.signal?.throwIfAborted()
  await context.database.settings.put({
    id: MISSING_PNG_THUMBNAIL_REPAIR_SETTING_ID,
    value: {
      version: 28,
      status: 'complete',
      checkpoint,
      repaired,
    } satisfies MissingPngThumbnailRepairState,
    updatedAt: Date.now(),
  })
  return repaired
}

export async function migrateLegacyThumbnails(
  context: ResourceThumbnailMaintenanceContext,
): Promise<void> {
  const saved = await context.database.settings.get(THUMBNAIL_ASSET_MIGRATION_SETTING_ID)
  const previous = saved?.value as Partial<ThumbnailAssetMigrationState> | undefined
  if (previous?.version === 23 && previous.status === 'complete') return

  let stage: ThumbnailAssetMigrationState['stage'] =
    previous?.version === 23 ? (previous.stage ?? 'resources') : 'resources'
  let checkpoint = previous?.version === 23 ? previous.checkpoint : undefined
  let migrated = previous?.version === 23 ? (previous.migrated ?? 0) : 0

  while (stage !== 'complete') {
    const sourceTable =
      stage === 'resources' ? context.database.resources : context.database.resourceVersions
    const summaryTable =
      stage === 'resources'
        ? context.database.resourceSummaries
        : context.database.resourceVersionSummaries
    const query = checkpoint ? sourceTable.where('id').above(checkpoint) : sourceTable.orderBy('id')
    const batch = await query.limit(THUMBNAIL_MIGRATION_BATCH_SIZE).toArray()
    if (!batch.length) {
      stage = stage === 'resources' ? 'resourceVersions' : 'complete'
      checkpoint = undefined
      continue
    }

    const patches: Array<{
      id: string
      thumbnailAssetId?: string
      encrypted: boolean
    }> = []
    for (const stored of batch) {
      if (isEncryptedResource(stored)) {
        patches.push({ id: stored.id, encrypted: true })
        continue
      }
      if (!(stored.thumbnailBlob instanceof Blob)) continue
      const asset = await context.assets.put(stored.thumbnailBlob, { source: 'thumbnail' })
      patches.push({ id: stored.id, thumbnailAssetId: asset.assetId, encrypted: false })
    }

    const nextCheckpoint = batch.at(-1)!.id
    migrated += patches.length
    await context.database.transaction(
      'rw',
      sourceTable,
      summaryTable,
      context.database.resourceListSummaries,
      context.database.settings,
      async () => {
        for (const patch of patches) {
          if (!patch.encrypted) {
            const updateResource = (record: StoredResource): void => {
              if (isEncryptedResource(record)) return
              record.thumbnailAssetId = patch.thumbnailAssetId
              record.thumbnailBlob = undefined
            }
            const updateSummary = (record: StoredResourceSummary): void => {
              if (isEncryptedResourceSummary(record)) return
              record.thumbnailAssetId = patch.thumbnailAssetId
              record.thumbnailBlob = undefined
            }
            if (stage === 'resources') {
              await context.database.resources.update(patch.id, updateResource)
              await context.database.resourceSummaries.update(patch.id, updateSummary)
            } else {
              await context.database.resourceVersions.update(patch.id, updateResource)
              await context.database.resourceVersionSummaries.update(patch.id, updateSummary)
            }
            if (stage === 'resources') {
              await context.database.resourceListSummaries.update(patch.id, (record) => {
                if (isEncryptedResourceSummary(record)) return
                record.thumbnailAssetId = patch.thumbnailAssetId
                record.thumbnailBlob = undefined
              })
            }
          } else {
            const removeEncryptedThumbnail = (record: StoredResourceSummary): void => {
              if (isEncryptedResourceSummary(record)) record.thumbnail = undefined
            }
            if (stage === 'resources') {
              await context.database.resourceSummaries.update(patch.id, removeEncryptedThumbnail)
            } else {
              await context.database.resourceVersionSummaries.update(
                patch.id,
                removeEncryptedThumbnail,
              )
            }
            if (stage === 'resources') {
              await context.database.resourceListSummaries.update(patch.id, (record) => {
                if (isEncryptedResourceSummary(record)) record.thumbnail = undefined
              })
            }
          }
        }
        await context.database.settings.put({
          id: THUMBNAIL_ASSET_MIGRATION_SETTING_ID,
          value: {
            version: 23,
            status: 'running',
            stage,
            checkpoint: nextCheckpoint,
            migrated,
          } satisfies ThumbnailAssetMigrationState,
          updatedAt: Date.now(),
        })
      },
    )
    checkpoint = nextCheckpoint
    if (batch.length === THUMBNAIL_MIGRATION_BATCH_SIZE) await yieldMainThread()
  }

  await context.database.settings.put({
    id: THUMBNAIL_ASSET_MIGRATION_SETTING_ID,
    value: {
      version: 23,
      status: 'complete',
      stage: 'complete',
      migrated,
    } satisfies ThumbnailAssetMigrationState,
    updatedAt: Date.now(),
  })
}

export async function repairUnlinkedThumbnailAssets(
  context: ResourceThumbnailMaintenanceContext,
): Promise<void> {
  const saved = await context.database.settings.get(THUMBNAIL_ASSET_REPAIR_SETTING_ID)
  const previous = saved?.value as Partial<ThumbnailAssetRepairState> | undefined
  if (previous?.version === 24 && previous.status === 'complete') return

  let stage: ThumbnailAssetRepairState['stage'] =
    previous?.version === 24 ? (previous.stage ?? 'resources') : 'resources'
  let checkpoint = previous?.version === 24 ? previous.checkpoint : undefined
  let repaired = previous?.version === 24 ? (previous.repaired ?? 0) : 0

  while (stage !== 'complete') {
    const sourceTable =
      stage === 'resources' ? context.database.resources : context.database.resourceVersions
    const summaryTable =
      stage === 'resources'
        ? context.database.resourceSummaries
        : context.database.resourceVersionSummaries
    const query = checkpoint ? sourceTable.where('id').above(checkpoint) : sourceTable.orderBy('id')
    const batch = await query.limit(THUMBNAIL_MIGRATION_BATCH_SIZE).toArray()
    if (!batch.length) {
      stage = stage === 'resources' ? 'resourceVersions' : 'complete'
      checkpoint = undefined
      continue
    }

    const patches: Array<{ id: string; thumbnailAssetId: string }> = []
    for (const stored of batch) {
      if (
        isEncryptedResource(stored) ||
        stored.thumbnailAssetId ||
        !(stored.thumbnailBlob instanceof Blob)
      ) {
        continue
      }
      const asset = await context.assets.put(stored.thumbnailBlob, { source: 'thumbnail' })
      patches.push({ id: stored.id, thumbnailAssetId: asset.assetId })
    }

    const nextCheckpoint = batch.at(-1)!.id
    let applied = 0
    await context.database.transaction(
      'rw',
      sourceTable,
      summaryTable,
      context.database.resourceListSummaries,
      context.database.settings,
      async () => {
        for (const patch of patches) {
          const current =
            stage === 'resources'
              ? await context.database.resources.get(patch.id)
              : await context.database.resourceVersions.get(patch.id)
          if (
            !current ||
            isEncryptedResource(current) ||
            current.thumbnailAssetId ||
            !(current.thumbnailBlob instanceof Blob)
          ) {
            continue
          }

          const updateResource = (record: StoredResource): void => {
            if (isEncryptedResource(record) || record.thumbnailAssetId) return
            record.thumbnailAssetId = patch.thumbnailAssetId
            record.thumbnailBlob = undefined
          }
          const updateSummary = (record: StoredResourceSummary): void => {
            if (isEncryptedResourceSummary(record) || record.thumbnailAssetId) return
            record.thumbnailAssetId = patch.thumbnailAssetId
            record.thumbnailBlob = undefined
          }

          if (stage === 'resources') {
            await context.database.resources.update(patch.id, updateResource)
            await context.database.resourceSummaries.update(patch.id, updateSummary)
            await context.database.resourceListSummaries.update(patch.id, updateSummary)
          } else {
            await context.database.resourceVersions.update(patch.id, updateResource)
            await context.database.resourceVersionSummaries.update(patch.id, updateSummary)
          }
          applied += 1
        }

        await context.database.settings.put({
          id: THUMBNAIL_ASSET_REPAIR_SETTING_ID,
          value: {
            version: 24,
            status: 'running',
            stage,
            checkpoint: nextCheckpoint,
            repaired: repaired + applied,
          } satisfies ThumbnailAssetRepairState,
          updatedAt: Date.now(),
        })
      },
    )
    repaired += applied
    checkpoint = nextCheckpoint
    if (batch.length === THUMBNAIL_MIGRATION_BATCH_SIZE) await yieldMainThread()
  }

  await context.database.settings.put({
    id: THUMBNAIL_ASSET_REPAIR_SETTING_ID,
    value: {
      version: 24,
      status: 'complete',
      stage: 'complete',
      repaired,
    } satisfies ThumbnailAssetRepairState,
    updatedAt: Date.now(),
  })
}

export async function repairEmbeddedThumbnailAssets(
  context: ResourceThumbnailMaintenanceContext,
): Promise<void> {
  const saved = await context.database.settings.get(THUMBNAIL_EMBEDDED_REPAIR_SETTING_ID)
  const previous = saved?.value as Partial<ThumbnailEmbeddedRepairState> | undefined
  if (previous?.version === 25 && previous.status === 'complete') return

  let stage: ThumbnailEmbeddedRepairState['stage'] =
    previous?.version === 25 ? (previous.stage ?? 'resources') : 'resources'
  let checkpoint = previous?.version === 25 ? previous.checkpoint : undefined
  let repaired = previous?.version === 25 ? (previous.repaired ?? 0) : 0

  while (stage !== 'complete') {
    const sourceTable =
      stage === 'resources' ? context.database.resources : context.database.resourceVersions
    const summaryTable =
      stage === 'resources'
        ? context.database.resourceSummaries
        : context.database.resourceVersionSummaries
    const query = checkpoint ? sourceTable.where('id').above(checkpoint) : sourceTable.orderBy('id')
    const batch = await query.limit(THUMBNAIL_MIGRATION_BATCH_SIZE).toArray()
    if (!batch.length) {
      stage = stage === 'resources' ? 'resourceVersions' : 'complete'
      checkpoint = undefined
      continue
    }

    const replacements: Array<{
      id: string
      stored: StoredResource
      summary: StoredResourceSummary
      listSummary?: StoredResourceSummary
    }> = []
    for (const stored of batch) {
      const decoded = hydrateResourceFromIndexedDb(
        (context.vault ? await context.vault.decodeResource(stored) : stored) as StoredResource,
      )
      if (!(decoded.thumbnailBlob instanceof Blob)) continue
      const externalized = await context.assets.externalizeResourceThumbnail(
        normalizeResource(decoded),
      )
      const replacement = context.vault
        ? await context.vault.encodeResource(externalized)
        : externalized
      const summary = (
        await context.createStoredListSummariesFromSummaries([context.toStoredSummary(replacement)])
      )[0]!
      const listSummary = stage === 'resources' ? summary : undefined
      replacements.push({
        id: stored.id,
        stored: replacement,
        summary,
        listSummary,
      })
    }

    const nextCheckpoint = batch.at(-1)!.id
    await context.database.transaction(
      'rw',
      sourceTable,
      summaryTable,
      context.database.resourceListSummaries,
      context.database.settings,
      async () => {
        for (const replacement of replacements) {
          await sourceTable.put(replacement.stored)
          await summaryTable.put(replacement.summary)
          if (replacement.listSummary) {
            await context.database.resourceListSummaries.put(replacement.listSummary)
          }
        }
        await context.database.settings.put({
          id: THUMBNAIL_EMBEDDED_REPAIR_SETTING_ID,
          value: {
            version: 25,
            status: 'running',
            stage,
            checkpoint: nextCheckpoint,
            repaired: repaired + replacements.length,
          } satisfies ThumbnailEmbeddedRepairState,
          updatedAt: Date.now(),
        })
      },
    )
    repaired += replacements.length
    checkpoint = nextCheckpoint
    if (batch.length === THUMBNAIL_MIGRATION_BATCH_SIZE) await yieldMainThread()
  }

  // Old ArchiveStorage writes could leave the one-shot v20 list index marked complete while
  // missing restored rows. Rebuild this derived index once as part of the v25 repair.
  await context.repairResourceListSummaryIndex(true)
  await context.database.settings.put({
    id: THUMBNAIL_EMBEDDED_REPAIR_SETTING_ID,
    value: {
      version: 25,
      status: 'complete',
      stage: 'complete',
      repaired,
    } satisfies ThumbnailEmbeddedRepairState,
    updatedAt: Date.now(),
  })
}
