import { friendlyNetworkError, mapWithConcurrency } from './CloudBackupHttp'
import type { CloudBackupSnapshotOperationsContext } from './CloudBackupSnapshotOperations'
import type { CloudBackupConfig, CloudBackupItem, CloudBackupProvider } from '../types/CloudBackup'

import {
  LEGACY_RELEASE_TAG,
  normalizeFolder,
  normalizeRetention,
  structuredPartIdentity,
  structuredPartObjectKey,
} from './CloudBackupPolicy'

import {
  OBJECT_RELEASE_PREFIX,
  SNAPSHOT_RELEASE_TAG,
  type GitHubAsset,
  type GitHubRelease,
} from './CloudBackupTransportContext'

import { isStructuredSnapshotObjectKey, structuredSnapshotParts } from './CloudStructuredSnapshot'

export const ORPHAN_CHUNK_GRACE_MS = 24 * 60 * 60 * 1000

export class CloudBackupMaintenanceError extends Error {
  readonly status?: number
  readonly code?: string
  readonly stage: 'snapshots' | 'objects'
  readonly deletedSnapshots: number
  constructor(
    stage: 'snapshots' | 'objects',
    deletedSnapshots: number,
    total: number,
    provider: CloudBackupProvider,
    cause: unknown,
  ) {
    const result =
      stage === 'snapshots'
        ? `已确认清理 ${deletedSnapshots}/${total} 份旧快照，其余清理未完成`
        : `${deletedSnapshots ? `已清理 ${deletedSnapshots} 份旧快照` : '快照保留检查已完成'}，但无引用内容对象回收未完成`
    super(`${result}：${friendlyNetworkError(cause, provider).message}`, { cause })
    this.name = 'CloudBackupMaintenanceError'
    this.stage = stage
    this.deletedSnapshots = deletedSnapshots
    const detail = cause as { status?: number; code?: string } | null
    this.status = detail?.status
    this.code = detail?.code
  }
}

export function isVerifiedChunkObjectName(name: string): boolean {
  return /^srl-chunk--sha256-[a-f0-9]{64}$/iu.test(name)
}

export function isVerifiedChunkIdentity(provider: CloudBackupProvider, identity: string): boolean {
  const name =
    provider === 'github'
      ? (identity.split('\u0000').at(-1) ?? '')
      : (identity.split('/').at(-1) ?? '')
  return isVerifiedChunkObjectName(name)
}

export async function listRetentionBackups(
  context: CloudBackupSnapshotOperationsContext,
  config: CloudBackupConfig,
  secret: string,
): Promise<CloudBackupItem[]> {
  if (config.provider === 'github') {
    const [legacy, snapshots] = await Promise.all([
      context.getGitHubRelease(config, secret, false, LEGACY_RELEASE_TAG),
      context.getGitHubRelease(config, secret, false, SNAPSHOT_RELEASE_TAG),
    ])
    const inventories = await Promise.all([
      legacy ? context.listGitHubAssets(config, secret, legacy.id) : [],
      snapshots ? context.listGitHubAssets(config, secret, snapshots.id) : [],
    ])
    const assets = inventories.flat()
    return assets
      .flatMap((asset): CloudBackupItem[] => {
        const createdAt = Date.parse(asset.created_at) || 0
        if (isStructuredSnapshotObjectKey(asset.name))
          return [
            {
              id: String(asset.id),
              objectKey: asset.name,
              size: asset.size,
              createdAt,
              kind: 'githubSnapshot',
            },
          ]
        if (asset.name.endsWith('.srlbundle.json'))
          return [
            {
              id: String(asset.id),
              objectKey: asset.name,
              size: asset.size,
              createdAt,
              kind: 'githubBundle',
            },
          ]
        return /\.zip$/iu.test(asset.name)
          ? [
              {
                id: String(asset.id),
                objectKey: asset.name,
                size: asset.size,
                createdAt,
                kind: 'single',
              },
            ]
          : []
      })
      .sort((left, right) => right.createdAt - left.createdAt)
  }
  return (await context.listWebDavRetentionObjects(config, secret))
    .flatMap((object): CloudBackupItem[] => {
      if (isStructuredSnapshotObjectKey(object.objectKey))
        return [
          {
            id: object.objectKey,
            objectKey: object.objectKey,
            size: object.size,
            createdAt: object.createdAt,
            kind: 'webdavSnapshot',
          },
        ]
      if (object.objectKey.endsWith('.srlbundle.json'))
        return [
          {
            id: object.objectKey,
            objectKey: object.objectKey,
            size: object.size,
            createdAt: object.createdAt,
            kind: 'webdavBundle',
          },
        ]
      return /\.zip$/iu.test(object.objectKey)
        ? [{ ...object, id: object.objectKey, kind: 'single', archiveName: object.objectKey }]
        : []
    })
    .sort((left, right) => right.createdAt - left.createdAt)
}

export async function referencedPartIdentities(
  context: CloudBackupSnapshotOperationsContext,
  config: CloudBackupConfig,
  secret: string,
  backups: CloudBackupItem[],
  cached?: { objectKey: string; snapshot: import('./CloudStructuredSnapshot').StructuredSnapshot },
  onChecked?: () => void,
): Promise<Set<string>> {
  const referenced = new Set<string>()
  await mapWithConcurrency(backups, 3, async (item) => {
    if (item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot') {
      const snapshot =
        cached?.objectKey === item.objectKey
          ? cached.snapshot
          : config.provider === 'github'
            ? await context.readGitHubStructuredSnapshot(config, secret, item)
            : await context.readWebDavStructuredSnapshot(config, secret, item.objectKey)
      for (const part of structuredSnapshotParts(snapshot))
        referenced.add(
          config.provider === 'github'
            ? structuredPartIdentity(part)
            : structuredPartObjectKey(part),
        )
    } else if (item.kind === 'githubBundle' || item.kind === 'webdavBundle') {
      const manifest =
        config.provider === 'github'
          ? await context.readGitHubBundleManifest(config, secret, item)
          : await context.readWebDavBundleManifest(config, secret, item.objectKey)
      for (const part of manifest.parts)
        referenced.add(
          config.provider === 'github' ? `${LEGACY_RELEASE_TAG}\u0000${part.name}` : part.name,
        )
    }
    onChecked?.()
  })
  return referenced
}

export async function prune(
  context: CloudBackupSnapshotOperationsContext,
  config: CloudBackupConfig,
  secret: string,
  protectedObjectKey?: string,
  deep = false,
  committedSnapshot?: import('./CloudStructuredSnapshot').StructuredSnapshot,
  onProgress?: (message: string) => void,
): Promise<number> {
  const report = (message: string): void =>
    onProgress?.(`${protectedObjectKey ? '备份已提交成功；' : ''}${message}`)
  report('正在读取旧快照列表…')
  const backups = await context.listRetentionBackups(config, secret)
  const normalKept = backups.slice(0, normalizeRetention(config.retention))
  const protectedItem = protectedObjectKey
    ? backups.find((item) => item.objectKey === protectedObjectKey)
    : undefined
  const kept =
    protectedItem && !normalKept.some((item) => item.id === protectedItem.id)
      ? [...normalKept, protectedItem]
      : normalKept
  const keptIds = new Set(kept.map((item) => item.id))
  const removed = backups.filter((item) => !keptIds.has(item.id))

  const orphanScope =
    config.provider === 'github'
      ? `github:${config.owner}/${config.repository}`
      : `webdav:${config.baseUrl.replace(/\/+$/u, '')}/${normalizeFolder(config.folder)}`
  const pending = await context.transportState.jobStore.pendingOrphans(orphanScope)
  if (!deep && !removed.length && !pending.length) {
    report('保留份数检查完成，无需清理。')
    return 0
  }
  const cached =
    protectedObjectKey && committedSnapshot
      ? { objectKey: protectedObjectKey, snapshot: committedSnapshot }
      : undefined

  // Only retained and about-to-expire manifests are read during normal automatic maintenance.
  // A malformed one aborts before its snapshot can be deleted.
  let checked = 0
  const checkTotal = kept.length + removed.length
  report(`正在核对快照引用（0/${checkTotal}）…`)
  const onChecked = (): void => report(`正在核对快照引用（${++checked}/${checkTotal}）…`)
  const [keptParts, retiredParts] = await Promise.all([
    referencedPartIdentities(context, config, secret, kept, cached, onChecked),
    referencedPartIdentities(context, config, secret, removed, cached, onChecked),
  ])

  // 先让超出 retention 的清单退出可见快照集合；只要任一清单删除失败，
  // 本轮就不会继续回收内容对象，避免留下“仍可见但缺对象”的旧快照。
  let deleted = 0
  report(`正在清理过期快照（0/${removed.length}）…`)
  try {
    await mapWithConcurrency(removed, 3, async (item) => {
      if (config.provider === 'github') {
        await context.githubFetch(config, secret, `/releases/assets/${item.id}`, {
          method: 'DELETE',
        })
      } else {
        await context.deleteWebDavObject(config, secret, item.objectKey)
      }
      report(`正在清理过期快照（${++deleted}/${removed.length}）…`)
    })
  } catch (error) {
    throw new CloudBackupMaintenanceError(
      'snapshots',
      deleted,
      removed.length,
      config.provider,
      error,
    )
  }

  try {
    const now = Date.now()
    const candidates = new Set(
      [...pending, ...retiredParts].filter(
        (part) => !keptParts.has(part) && isVerifiedChunkIdentity(config.provider, part),
      ),
    )

    if (deep && config.provider === 'github') {
      const containers: Array<{ tag: string; release: GitHubRelease }> = []
      const legacy = await context.getGitHubRelease(config, secret, false, LEGACY_RELEASE_TAG)
      if (legacy) containers.push({ tag: LEGACY_RELEASE_TAG, release: legacy })
      for (let index = 1; index <= 10_000; index += 1) {
        const tag = `${OBJECT_RELEASE_PREFIX}${String(index).padStart(4, '0')}`
        const release = await context.getGitHubRelease(config, secret, false, tag)
        if (!release) break
        containers.push({ tag, release })
      }
      const orphanAssets = new Map<string, GitHubAsset>()
      for (const container of containers) {
        for (const asset of await context.listGitHubAssets(config, secret, container.release.id)) {
          const identity = `${container.tag}\u0000${asset.name}`
          orphanAssets.set(identity, asset)
          if (isVerifiedChunkObjectName(asset.name) && !keptParts.has(identity))
            candidates.add(identity)
        }
      }
      const eligible = await context.transportState.jobStore.eligibleOrphans(
        orphanScope,
        candidates,
        now,
        ORPHAN_CHUNK_GRACE_MS,
      )
      for (const identity of eligible) {
        const asset = orphanAssets.get(identity)
        if (!asset) continue
        await context.githubFetch(config, secret, `/releases/assets/${asset.id}`, {
          method: 'DELETE',
        })
        await context.transportState.jobStore.clearOrphan(orphanScope, identity)
      }
      return removed.length
    }

    if (config.provider === 'github') {
      report('正在检查可回收内容对象…')
      const eligible = await context.transportState.jobStore.eligibleOrphans(
        orphanScope,
        candidates,
        now,
        ORPHAN_CHUNK_GRACE_MS,
      )
      const assetsByIdentity = new Map<string, GitHubAsset>()
      const containers = [...new Set(eligible.map((identity) => identity.split('\u0000', 1)[0]!))]
      await mapWithConcurrency(containers, 3, async (container) => {
        const release = await context.getGitHubRelease(config, secret, false, container)
        if (!release) return
        for (const asset of await context.listGitHubAssets(config, secret, release.id))
          assetsByIdentity.set(`${container}\u0000${asset.name}`, asset)
      })
      let reclaimed = 0
      report(`正在处理无引用内容对象（0/${eligible.length}）…`)
      await mapWithConcurrency(eligible, 3, async (identity) => {
        const asset = assetsByIdentity.get(identity)
        if (asset)
          await context.githubFetch(config, secret, `/releases/assets/${asset.id}`, {
            method: 'DELETE',
          })
        await context.transportState.jobStore.clearOrphan(orphanScope, identity)
        report(`正在处理无引用内容对象（${++reclaimed}/${eligible.length}）…`)
      })
      report('旧快照维护完成。')
      return removed.length
    }

    if (deep) {
      for (const object of await context.listWebDavObjects(config, secret)) {
        const leaf = object.objectKey.split('/').at(-1) ?? ''
        if (isVerifiedChunkObjectName(leaf) && !keptParts.has(object.objectKey))
          candidates.add(object.objectKey)
      }
    }
    const eligible = await context.transportState.jobStore.eligibleOrphans(
      orphanScope,
      candidates,
      now,
      ORPHAN_CHUNK_GRACE_MS,
    )
    let reclaimed = 0
    report(`正在处理无引用内容对象（0/${eligible.length}）…`)
    await mapWithConcurrency(eligible, 3, async (objectKey) => {
      await context.deleteWebDavObject(config, secret, objectKey)
      await context.transportState.jobStore.clearOrphan(orphanScope, objectKey)
      report(`正在处理无引用内容对象（${++reclaimed}/${eligible.length}）…`)
    })
    report('旧快照维护完成。')
    return removed.length
  } catch (error) {
    throw new CloudBackupMaintenanceError(
      'objects',
      deleted,
      removed.length,
      config.provider,
      error,
    )
  }
}
