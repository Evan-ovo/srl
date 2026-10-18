import { createCloudObjectReader, type CloudReadPart } from './CloudBackupObjectReader'
import { waitForCloudRetry } from './CloudBackupHttp'
import { LEGACY_RELEASE_TAG } from './CloudBackupPolicy'
import type { CloudBackupItem, GitHubBackupConfig } from '../types/CloudBackup'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import { hashCloudBlob } from './CloudArchiveCodec'
import { parseGitHubBundleManifest, type GitHubBundleManifest } from './GitHubBackupBundle'
import {
  decodeStructuredSnapshot,
  encodeStructuredSnapshot,
  isStructuredSnapshotObjectKey,
  structuredSnapshotArchiveName,
  structuredSnapshotName,
  structuredSnapshotParts,
  structuredSnapshotObjects,
  type CloudObjectPlan,
  type CreatedStructuredSnapshot,
  type StructuredSnapshot,
} from './CloudStructuredSnapshot'
import {
  canUseNativeStructuredSnapshotHandoff,
  isNativeCloudTransferAvailable,
  uploadNativeStructuredSnapshot,
} from './NativeCloudTransfer'
import {
  encodeBase64,
  structuredPartObjectKey,
  structuredPartContainer,
  structuredPartIdentity,
} from './CloudBackupPolicy'
import {
  type GitHubErrorDetail,
  isCloudRequestTimeout,
  mapWithConcurrency,
  githubError,
} from './CloudBackupHttp'
import {
  type CloudBackupTransportContext,
  type GitHubAsset,
  type GitHubRelease,
  type CloudBackupProgressCallback,
  SNAPSHOT_RELEASE_TAG,
  OBJECT_RELEASE_PREFIX,
  GITHUB_OBJECT_CONTAINER_LIMIT,
  GITHUB_ASSET_CONFIRM_ATTEMPTS,
  GITHUB_ASSET_CONFIRM_DELAY_MS,
} from './CloudBackupTransportContext'

function githubInventory(context: CloudBackupTransportContext, config: GitHubBackupConfig) {
  if (!context.activeMetrics) return undefined
  const key = `${config.owner}/${config.repository}`
  if (context.activeGitHubInventory?.key !== key) {
    context.activeGitHubInventory = { key, assets: new Map(), releases: new Map() }
  }
  return context.activeGitHubInventory
}

export async function listGitHubObjectContainers(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = []
  const inventory = githubInventory(context, config)
  for (let page = 1; page <= 1_000; page += 1) {
    const response = await context.githubFetch(config, secret, `/releases?per_page=10&page=${page}`)
    const batch = (await response.json()) as GitHubRelease[]
    for (const value of batch) {
      const release = { ...value, assets: [] }
      if (release.tag_name) inventory?.releases.set(release.tag_name, release)
      if (/^srl-cloud-objects-\d{4,}$/u.test(release.tag_name ?? '')) releases.push(release)
    }
    if (batch.length < 10)
      return releases.sort(
        (a, b) =>
          Number(a.tag_name!.slice(OBJECT_RELEASE_PREFIX.length)) -
          Number(b.tag_name!.slice(OBJECT_RELEASE_PREFIX.length)),
      )
  }
  throw new Error('GitHub Release 列表超过扫描范围，未提交新快照')
}

export async function githubFetch(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const deletingAsset =
    (init.method ?? 'GET').toUpperCase() === 'DELETE' && /^\/releases\/assets\/\d+$/u.test(path)
  const stopped = (error: unknown): boolean =>
    Boolean(
      context.signal?.aborted ||
      init.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError'),
    )
  let response: Response
  try {
    response = await requestGitHub(context, config, secret, path, init)
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (
      !deletingAsset ||
      stopped(error) ||
      (error as { code?: string } | null)?.code === 'SITE_UNAUTHENTICATED' ||
      (status !== undefined && status !== 404 && status < 500)
    )
      throw error

    // A lost DELETE receipt does not prove deletion failed. Read this asset's
    // metadata once; release read access must still work because private repos
    // also return 404 when Contents access is lost. Repository metadata alone
    // cannot prove this permission. Never repeat the DELETE here.
    let present = false
    try {
      try {
        const asset = await requestGitHub(context, config, secret, path, { signal: init.signal })
        await asset.body?.cancel()
        present = true
      } catch (verificationError) {
        if ((verificationError as { status?: number } | null)?.status !== 404)
          throw verificationError
        const releases = await requestGitHub(
          context,
          config,
          secret,
          '/releases?per_page=10&page=1',
          { signal: init.signal },
        )
        await releases.body?.cancel()
      }
    } catch (verificationError) {
      if (stopped(verificationError)) throw verificationError
      throw new Error(
        'GitHub 删除结果尚未确认：删除回执异常，且远端复核未完成；文件可能已删除，请查看云端列表后再清理。',
        { cause: verificationError },
      )
    }
    if (present)
      throw new Error('GitHub 删除未完成：远端文件仍然存在，请稍后重新执行清理。', { cause: error })
    response = new Response(null, { status: 204 })
  }
  if (response.ok && deletingAsset) {
    const assetId = Number(path.split('/').at(-1))
    if (Number.isSafeInteger(assetId)) {
      for (const assets of githubInventory(context, config)?.assets.values() ?? [])
        assets.delete(assetId)
    }
  }
  return response
}

async function requestGitHub(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await context.cloudFetch(
    `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}${path}`,
    {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${secret}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    },
    'github',
  )
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as GitHubErrorDetail
    if (
      response.headers.get('x-srl-cloud-proxy') === '1' &&
      response.status === 401 &&
      (detail as GitHubErrorDetail & { code?: string }).code === 'UNAUTHENTICATED'
    ) {
      throw Object.assign(
        new Error('上传 GitHub 备份需要登录当前资源库网站；请先登录本站，再继续备份。'),
        { code: 'SITE_UNAUTHENTICATED' },
      )
    }
    throw githubError(response.status, detail, path, init.method ?? 'GET', response.headers)
  }
  return response
}

export async function ensureGitHubInitialCommit(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
): Promise<boolean> {
  const commits = await context.cloudFetch(
    `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/commits?per_page=1`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${secret}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    'github',
  )
  if (commits.ok) return false
  if (commits.status !== 409) {
    const detail = (await commits.json().catch(() => ({}))) as GitHubErrorDetail
    throw githubError(commits.status, detail, '/commits?per_page=1', 'GET', commits.headers)
  }
  await context.githubFetch(config, secret, '/contents/.srl-backup-container', {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Initialize SRL cloud backup container',
      content: encodeBase64(
        'This private repository is initialized for SillyTavern Resource Library backups.\n',
      ),
    }),
  })
  return true
}

export async function getGitHubRelease(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  create: boolean,
  tag = LEGACY_RELEASE_TAG,
  signal?: AbortSignal,
): Promise<GitHubRelease | undefined> {
  const inventory = githubInventory(context, config)
  const cached = inventory?.releases.get(tag)
  if (cached || (!create && inventory?.releases.has(tag))) return cached
  const readRelease = async (response: Response): Promise<GitHubRelease> => {
    const value = (await response.json()) as GitHubRelease
    const release = { ...value, assets: [] }
    inventory?.releases.set(tag, release)
    return release
  }
  const releaseUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/releases/tags/${encodeURIComponent(tag)}`
  const requestRelease = (): Promise<Response> =>
    context.cloudFetch(
      releaseUrl,
      {
        ...(signal ? { signal } : {}),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${secret}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      'github',
    )
  let response = await requestRelease()
  let initialized = false
  if (response.ok) return readRelease(response)
  // GitHub 对部分完全空白的私有仓库会先把 Release 查询返回为 403。
  // 初始化首个提交后，该查询会正常变成 404（尚无 Release），此时应继续创建而不是把 404 抛出。
  if (response.status === 403 && create) {
    const original = response.clone()
    initialized = await context.ensureGitHubInitialCommit(config, secret)
    if (initialized) {
      response = await requestRelease()
      if (response.ok) return readRelease(response)
    } else {
      const detail = (await original.json().catch(() => ({}))) as GitHubErrorDetail
      throw githubError(original.status, detail, `/releases/tags/${tag}`, 'GET', original.headers)
    }
  }
  if (response.status !== 404 || !create) {
    if (response.status === 404 && !create) {
      inventory?.releases.set(tag, undefined)
      return undefined
    }
    const detail = (await response.json().catch(() => ({}))) as GitHubErrorDetail
    throw githubError(response.status, detail, `/releases/tags/${tag}`, 'GET', response.headers)
  }
  if (!initialized) await context.ensureGitHubInitialCommit(config, secret)
  const created = await context.githubFetch(config, secret, '/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: tag === SNAPSHOT_RELEASE_TAG ? 'SRL 云备份快照清单' : `SRL 云备份对象 ${tag}`,
      body: '由 SillyTavern Resource Library 自动维护，请勿手动修改附件。',
      prerelease: true,
    }),
  })
  return readRelease(created)
}

export async function uploadGitHubStructuredBackup(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  snapshot: CreatedStructuredSnapshot,
  onProgress?: CloudBackupProgressCallback,
  respectAutomaticConstraints = false,
): Promise<CloudBackupItem> {
  const snapshotRelease = await context.getGitHubRelease(config, secret, true, SNAPSHOT_RELEASE_TAG)
  if (!snapshotRelease) throw new Error('无法创建 GitHub 快照清单容器')
  const containers: Array<{
    tag: string
    release: GitHubRelease
    assets: Map<string, GitHubAsset>
    assigned: number
  }> = []
  const releases = await context.listGitHubObjectContainers(config, secret)
  const loadedContainers = new Map<number, Map<string, GitHubAsset>>()
  await mapWithConcurrency(releases, 3, async (release) => {
    loadedContainers.set(
      release.id,
      new Map(
        (await context.listGitHubAssets(config, secret, release.id)).map((asset) => [
          asset.name,
          asset,
        ]),
      ),
    )
  })
  for (const release of releases)
    containers.push({
      tag: release.tag_name!,
      release,
      assets: loadedContainers.get(release.id)!,
      assigned: 0,
    })
  const createContainer = async () => {
    const tag = `${OBJECT_RELEASE_PREFIX}${String(Number(containers.at(-1)?.tag.slice(OBJECT_RELEASE_PREFIX.length) ?? 0) + 1).padStart(4, '0')}`
    const release = await context.getGitHubRelease(config, secret, true, tag)
    if (!release) throw new Error(`无法创建 GitHub 对象容器 ${tag}`)
    const container = { tag, release, assets: new Map<string, GitHubAsset>(), assigned: 0 }
    containers.push(container)
    return container
  }
  if (!containers.length) await createContainer()

  const placements = new Map<
    string,
    { tag: string; releaseId: number; asset?: GitHubAsset; plan: CloudObjectPlan }
  >()
  const byObjectName = new Map<
    string,
    { container: (typeof containers)[number]; asset: GitHubAsset }
  >()
  for (const container of containers) {
    for (const asset of container.assets.values()) {
      if (!byObjectName.has(asset.name)) byObjectName.set(asset.name, { container, asset })
    }
  }
  for (const plan of snapshot.objectPlans) {
    const name = plan.name
    let matched:
      { tag: string; releaseId: number; asset?: GitHubAsset; plan: CloudObjectPlan } | undefined
    const existing = byObjectName.get(name)
    if (existing) {
      const { container, asset } = existing
      if (await githubAssetMatchesPlan(context, config, secret, asset, plan)) {
        matched = { tag: container.tag, releaseId: container.release.id, asset, plan }
      } else {
        const expectedHash = /^srl-chunk--sha256-([a-f0-9]{64})$/iu.exec(name)?.[1]?.toLowerCase()
        const localBlob = await context.materializeCloudObject(plan)
        if (
          !expectedHash ||
          localBlob.size !== plan.size ||
          plan.hash.toLowerCase() !== expectedHash ||
          (await hashCloudBlob(localBlob)) !== expectedHash
        )
          throw new Error(
            `GitHub 内容寻址对象 ${name} 的远端摘要不符；本地对象未通过名称摘要核验，拒绝覆盖`,
          )
        context.signal?.throwIfAborted()
        await deleteGitHubAssetIfPresent(context, config, secret, asset.id)
        container.assets.delete(name)
        byObjectName.delete(name)
        // Existing snapshots locate this hash by container/name, not asset ID.
        container.assigned += 1
        matched = { tag: container.tag, releaseId: container.release.id, plan }
      }
    }
    if (!matched) {
      let container = containers.at(-1)!
      if (container.assets.size + container.assigned >= GITHUB_OBJECT_CONTAINER_LIMIT) {
        container = await createContainer()
      }
      container.assigned += 1
      matched = { tag: container.tag, releaseId: container.release.id, plan }
    }
    placements.set(name, matched)
  }
  for (const object of structuredSnapshotObjects(snapshot.snapshot)) {
    for (const part of object.parts) {
      const placement = placements.get(part.name)
      if (!placement) throw new Error(`V3 清单缺少对象定位：${part.name}`)
      part.storage = {
        kind: 'github-release',
        container: placement.tag,
        objectKey: part.name,
      }
    }
  }
  const jobs = [...placements].filter(([, placement]) => !placement.asset)
  onProgress?.(
    `对象级快照复用 ${snapshot.objectPlans.length - jobs.length} 个块；上传 ${jobs.length} 个变更块…`,
  )
  if (isNativeCloudTransferAvailable()) {
    const manifestBlob = await encodeStructuredSnapshot(snapshot.snapshot)
    const name = structuredSnapshotName()
    const nativeObjects = jobs.map(([objectName, placement]) => ({
      name: objectName,
      blob: placement.plan.blob,
      size: placement.plan.size,
      contentType: 'application/octet-stream',
      releaseId: placement.releaseId,
      nativeSource: snapshot.nativeSources.get(objectName),
    }))
    const nativeManifest = {
      name,
      blob: manifestBlob,
      size: manifestBlob.size,
      contentType: 'application/gzip',
      releaseId: snapshotRelease.id,
    }
    if (
      await canUseNativeStructuredSnapshotHandoff({
        objects: nativeObjects,
        manifest: nativeManifest,
      })
    ) {
      onProgress?.('大型对象可直接从 Android 原生对象库读取，正在交给后台任务…')
      const result = await uploadNativeStructuredSnapshot({
        config,
        secret,
        objects: nativeObjects,
        manifest: nativeManifest,
        onProgress,
        respectConstraints: respectAutomaticConstraints,
      })
      context.activeMetrics?.merge(result.metrics)
      // Native uploads change only these asset lists. Release IDs and untouched
      // inventories are still valid for this job's retention/reference checks.
      const inventory = githubInventory(context, config)
      for (const releaseId of new Set([
        snapshotRelease.id,
        ...nativeObjects.map((object) => object.releaseId),
      ]))
        inventory?.assets.delete(releaseId)
      return {
        id: result.id,
        objectKey: result.name,
        size: snapshot.totalSize,
        createdAt: Date.now(),
        kind: 'githubSnapshot',
        partCount: snapshot.partCount,
        archiveName: structuredSnapshotArchiveName(result.name),
      }
    }
    throw new Error('Android 原生对象来源不完整；已阻止 GitHub 云对象退回 JS Blob 网络')
  }
  const planHash = await hashCloudBlob(
    new Blob([
      JSON.stringify(
        [...placements]
          .map(([objectName, placement]) => [objectName, placement.tag, placement.plan.size])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ),
    ]),
  )
  const webJob = await context.jobStore.begin(
    'github',
    planHash,
    placements.keys(),
    [...placements].filter(([, placement]) => placement.asset).map(([name]) => name),
  )
  let completedJobs = 0
  try {
    await mapWithConcurrency(jobs, 3, async ([name, placement]) => {
      context.signal?.throwIfAborted()
      const blob = await context.materializeCloudObject(placement.plan)
      let completed = false
      let pendingDeleteAssetId: number | undefined
      let lastFailure: Error | undefined
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        context.signal?.throwIfAborted()
        if (attempt > 1) context.activeMetrics?.add('retryCount', 1)
        let uploadedAssetId: number | undefined
        let deleteAfterFailedSizeCheck = false
        try {
          if (pendingDeleteAssetId !== undefined) {
            await deleteGitHubAssetIfPresent(context, config, secret, pendingDeleteAssetId)
            pendingDeleteAssetId = undefined
          }
          const uploaded = await context.uploadGitHubAsset(
            config,
            secret,
            placement.releaseId,
            name,
            blob,
            'application/octet-stream',
            undefined,
            1,
          )
          uploadedAssetId = uploaded.id
          if (
            Number.isSafeInteger(uploaded.id) &&
            uploaded.id > 0 &&
            uploaded.name === name &&
            uploaded.size === blob.size &&
            uploaded.state === 'uploaded' &&
            (await githubAssetMatchesPlan(context, config, secret, uploaded, placement.plan))
          ) {
            completed = true
            break
          }
          if (
            await context.confirmGitHubAssetSize(
              config,
              secret,
              uploaded,
              blob.size,
              placement.plan.hash,
            )
          ) {
            completed = true
            break
          }
          deleteAfterFailedSizeCheck = true
          throw new Error(
            `GitHub 对象远端完整性校验失败：本地 SHA-256 ${placement.plan.hash}，上传响应大小 ${uploaded.size}/${blob.size} 字节（asset ${uploaded.id}）`,
          )
        } catch (error) {
          context.signal?.throwIfAborted()
          lastFailure = error instanceof Error ? error : new Error('GitHub 上传或校验失败')
          if (uploadedAssetId !== undefined && deleteAfterFailedSizeCheck) {
            pendingDeleteAssetId = uploadedAssetId
            try {
              await deleteGitHubAssetIfPresent(context, config, secret, uploadedAssetId)
              pendingDeleteAssetId = undefined
            } catch (deleteError) {
              lastFailure = new Error(
                `${lastFailure.message}；清理不完整对象 ${uploadedAssetId} 失败：${deleteError instanceof Error ? deleteError.message : '未知错误'}`,
                { cause: deleteError },
              )
            }
          }
          // Only retry this content-addressed object; verified objects stay complete.
        }
      }
      if (!completed) {
        await context.jobStore.markObject(webJob, name, 'failed')
        throw new Error(
          `GitHub 对象块 ${name.slice(-12)} 连续 3 次上传不完整；未提交快照清单${lastFailure ? `。最后失败原因：${lastFailure.message}` : ''}`,
          lastFailure ? { cause: lastFailure } : undefined,
        )
      }
      await context.jobStore.markObject(webJob, name, 'verified')
      completedJobs += 1
      onProgress?.(`GitHub 变更块已完成 ${completedJobs} / ${jobs.length}…`)
    })
  } catch (error) {
    await context.jobStore.fail(webJob, error)
    throw error
  }
  try {
    onProgress?.('对象块已完成，正在压缩快照清单…')
    const manifestBlob = await encodeStructuredSnapshot(snapshot.snapshot)
    const name = structuredSnapshotName()
    onProgress?.(`快照清单已压缩为 ${(manifestBlob.size / 1024).toFixed(1)} KiB，正在最后提交…`)
    context.signal?.throwIfAborted()
    context.beginCommit?.()
    const manifest = await context.uploadGitHubAsset(
      config,
      secret,
      snapshotRelease.id,
      name,
      manifestBlob,
      'application/gzip',
      `SRL_SNAPSHOT:${snapshot.totalSize}:${snapshot.partCount}`,
      3,
    )
    const confirmedManifest = await context.confirmGitHubAssetSize(
      config,
      secret,
      manifest,
      manifestBlob.size,
      await hashCloudBlob(manifestBlob),
    )
    if (!confirmedManifest) {
      await context.githubFetch(config, secret, `/releases/assets/${manifest.id}`, {
        method: 'DELETE',
      })
      throw new Error('GitHub 对象快照清单上传不完整；旧备份没有受到影响')
    }
    await context.jobStore.complete(webJob, name)
    return {
      id: String(confirmedManifest.id),
      objectKey: confirmedManifest.name,
      size: snapshot.totalSize,
      createdAt: Date.parse(confirmedManifest.created_at) || Date.now(),
      kind: 'githubSnapshot',
      partCount: snapshot.partCount,
      archiveName: structuredSnapshotArchiveName(name),
    }
  } catch (error) {
    await context.jobStore.fail(webJob, error)
    throw error
  }
}

export async function uploadGitHubAsset(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  releaseId: number,
  name: string,
  blob: Blob,
  contentType: string,
  label?: string,
  attempts = 1,
): Promise<GitHubAsset> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    context.signal?.throwIfAborted()
    if (attempt > 1) context.activeMetrics?.add('retryCount', 1)
    try {
      const query = new URLSearchParams({ name })
      if (label) query.set('label', label)
      const response = await context.cloudFetch(
        `https://uploads.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/releases/${releaseId}/assets?${query}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${secret}`,
            'Content-Type': contentType,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: blob,
        },
        'github',
      )
      if (response.ok) {
        const asset = (await response.json()) as GitHubAsset
        githubInventory(context, config)?.assets.get(releaseId)?.set(asset.id, asset)
        return asset
      }
      const detail = (await response.json().catch(() => ({}))) as GitHubErrorDetail
      if (response.status === 422) {
        githubInventory(context, config)?.assets.delete(releaseId)
        let existing = (await context.listGitHubAssets(config, secret, releaseId)).find(
          (asset) => asset.name === name,
        )
        // GitHub can reject a duplicate asset name before its release-asset
        // listing reflects the asset that caused the conflict. Reconcile only
        // explicit name conflicts, with bounded read-only checks, before
        // treating the upload as failed.
        const isNameConflict = detail.errors?.some(
          (item) => item.field === 'name' && item.code === 'already_exists',
        )
        if (!existing && isNameConflict) {
          for (const delay of [250, 500, 1_000]) {
            await waitForCloudRetry(delay, context.signal)
            githubInventory(context, config)?.assets.delete(releaseId)
            existing = (await context.listGitHubAssets(config, secret, releaseId)).find(
              (asset) => asset.name === name,
            )
            if (existing) break
          }
        }
        if (existing?.size === blob.size) {
          const expectedHash = await hashCloudBlob(blob)
          if (
            await githubAssetMatchesHash(context, config, secret, existing, blob.size, expectedHash)
          )
            return existing
          const namedHash = /^srl-chunk--sha256-([a-f0-9]{64})$/iu.exec(name)?.[1]?.toLowerCase()
          if (namedHash && namedHash === expectedHash) {
            await deleteGitHubAssetIfPresent(context, config, secret, existing.id)
            throw new Error(
              `GitHub 同名对象 ${name} 的远端 SHA-256 不符；已删除校验失败的附件，正在重试上传`,
            )
          }
          throw new Error(`GitHub 同名附件 ${name} 的远端 SHA-256 与本地内容不符；未覆盖附件`)
        }
        if (existing) {
          const contentHash = /^srl-chunk--sha256-([a-f0-9]{64})$/u.exec(name)?.[1]
          if (contentHash && (await hashCloudBlob(blob)) === contentHash) {
            await deleteGitHubAssetIfPresent(context, config, secret, existing.id)
            throw new Error(
              `GitHub 同名对象 ${name} 留有不完整远端附件（${existing.size}/${blob.size} 字节）；已删除残缺附件，正在重试上传`,
            )
          }
          throw new Error(
            `GitHub 同名对象大小冲突：${name} 的远端大小为 ${existing.size} 字节，本地预期 ${blob.size} 字节（asset ${existing.id}）；未覆盖远端对象`,
          )
        }
      }
      lastError = githubError(response.status, detail, 'GitHub 上传失败')
      if (response.status < 500 || attempt === attempts) throw lastError
    } catch (error) {
      context.signal?.throwIfAborted()
      lastError = error instanceof Error ? error : new Error('GitHub 上传失败')
      if (attempt === attempts) throw lastError
    }
    await waitForCloudRetry(attempt * 800, context.signal)
  }
  throw lastError ?? new Error('GitHub 上传失败')
}

async function deleteGitHubAssetIfPresent(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  assetId: number,
): Promise<void> {
  try {
    await context.githubFetch(config, secret, `/releases/assets/${assetId}`, {
      method: 'DELETE',
    })
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : undefined
    if (status !== 404) throw error
  }
}

async function githubAssetMatchesPlan(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  asset: GitHubAsset,
  plan: CloudObjectPlan,
): Promise<boolean> {
  return (
    asset.size === plan.size &&
    (await githubAssetMatchesHash(context, config, secret, asset, plan.size, plan.hash))
  )
}

async function githubAssetMatchesHash(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  asset: GitHubAsset,
  expectedSize: number,
  expectedHash: string,
): Promise<boolean> {
  if (asset.state && asset.state !== 'uploaded') return false
  if (asset.size !== expectedSize) return false
  const digest = /^sha256:([a-f0-9]{64})$/iu.exec(asset.digest ?? '')?.[1]
  if (digest) return digest.toLowerCase() === expectedHash.toLowerCase()

  // Older GitHub responses may omit `digest`; verify the actual bytes in that case.
  const response = await context.githubFetch(config, secret, `/releases/assets/${asset.id}`, {
    headers: { Accept: 'application/octet-stream' },
  })
  const blob = await context.readResponseBlob(response, expectedSize)
  return blob.size === expectedSize && (await hashCloudBlob(blob)) === expectedHash.toLowerCase()
}

export async function confirmGitHubAssetSize(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  uploaded: GitHubAsset,
  expectedSize: number,
  expectedHash?: string,
): Promise<GitHubAsset | undefined> {
  if (uploaded.state && uploaded.state !== 'uploaded') return undefined
  if (
    expectedHash &&
    (await githubAssetMatchesHash(context, config, secret, uploaded, expectedSize, expectedHash))
  )
    return uploaded
  const verifyStarted = typeof performance === 'undefined' ? Date.now() : performance.now()
  try {
    for (let attempt = 1; attempt <= GITHUB_ASSET_CONFIRM_ATTEMPTS; attempt += 1) {
      const response = await context.githubFetch(config, secret, `/releases/assets/${uploaded.id}`)
      const asset = (await response.json()) as GitHubAsset
      if (asset.state && asset.state !== 'uploaded') return undefined
      if (asset.id === uploaded.id && asset.size === expectedSize) {
        if (!expectedHash) return asset
        const digest = /^sha256:([a-f0-9]{64})$/iu.exec(asset.digest ?? '')?.[1]
        if (digest && digest.toLowerCase() !== expectedHash.toLowerCase()) return undefined
        if (
          await githubAssetMatchesHash(context, config, secret, asset, expectedSize, expectedHash)
        )
          return asset
      }
      if (attempt < GITHUB_ASSET_CONFIRM_ATTEMPTS) {
        await waitForCloudRetry(attempt * GITHUB_ASSET_CONFIRM_DELAY_MS, context.signal)
      }
    }
    return undefined
  } finally {
    const verifyFinished = typeof performance === 'undefined' ? Date.now() : performance.now()
    context.activeMetrics?.add('verifyMs', verifyFinished - verifyStarted)
  }
}

export async function listGitHubAssets(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  releaseId: number,
  signal?: AbortSignal,
): Promise<GitHubAsset[]> {
  const inventory = githubInventory(context, config)
  const cached = inventory?.assets.get(releaseId)
  if (cached) return [...cached.values()]
  const assets: GitHubAsset[] = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await context.githubFetch(
      config,
      secret,
      `/releases/${releaseId}/assets?per_page=100&page=${page}`,
      signal ? { signal } : undefined,
    )
    const batch = (await response.json()) as GitHubAsset[]
    assets.push(...batch)
    if (batch.length < 100) break
  }
  inventory?.assets.set(releaseId, new Map(assets.map((asset) => [asset.id, asset])))
  return assets
}

export async function readGitHubPartInventory(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  parts: GitHubBundleManifest['parts'],
): Promise<Map<string, GitHubAsset>> {
  const result = new Map<string, GitHubAsset>()
  const containers = [...new Set(parts.map(structuredPartContainer))]
  await mapWithConcurrency(containers, 3, async (container) => {
    const release = await context.getGitHubRelease(config, secret, false, container)
    if (!release) return
    for (const asset of await context.listGitHubAssets(config, secret, release.id)) {
      result.set(`${container}\u0000${asset.name}`, asset)
    }
  })
  return result
}

export async function listGitHub(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  onProgress?: CloudBackupProgressCallback,
): Promise<CloudBackupItem[]> {
  const legacyRelease = await context.getGitHubRelease(config, secret, false, LEGACY_RELEASE_TAG)
  const snapshotRelease = await context.getGitHubRelease(
    config,
    secret,
    false,
    SNAPSHOT_RELEASE_TAG,
  )
  if (!legacyRelease && !snapshotRelease) return []
  onProgress?.('正在读取 GitHub 远端对象索引…')
  const legacyAssets = legacyRelease
    ? await context.listGitHubAssets(config, secret, legacyRelease.id)
    : []
  const snapshotAssets = snapshotRelease
    ? await context.listGitHubAssets(config, secret, snapshotRelease.id)
    : []
  const backups = legacyAssets
    .filter((asset) => /\.zip$/i.test(asset.name) || asset.name.endsWith('.srlbundle.json'))
    .map((asset): CloudBackupItem => ({
      id: String(asset.id),
      objectKey: asset.name,
      size: /\.srlbundle\.json$/i.test(asset.name)
        ? Number(/^SRL_BUNDLE:(\d+):(\d+)$/.exec(asset.label ?? '')?.[1] ?? asset.size)
        : asset.size,
      createdAt: Date.parse(asset.created_at) || 0,
      kind: asset.name.endsWith('.srlbundle.json') ? 'githubBundle' : 'single',
      partCount: /\.srlbundle\.json$/i.test(asset.name)
        ? Number(/^SRL_BUNDLE:(\d+):(\d+)$/.exec(asset.label ?? '')?.[2] ?? 0)
        : undefined,
      archiveName: asset.name.endsWith('.srlbundle.json')
        ? asset.name.replace(/\.srlbundle\.json$/i, '')
        : asset.name,
    }))
  const manifests = [...snapshotAssets, ...legacyAssets].filter((entry) =>
    isStructuredSnapshotObjectKey(entry.name),
  )
  let checkedSnapshots = 0
  const containerInventories = new Map<string, Promise<Map<string, GitHubAsset>>>()
  if (manifests.length) {
    onProgress?.(`正在校验 ${manifests.length} 份快照及其对象定位…`)
  }
  await mapWithConcurrency(manifests, isCapacitorApp() ? 3 : 2, async (asset) => {
    try {
      assertGitHubDownloadableAsset(asset, asset.size, asset.name)
      const snapshot = await context.readGitHubStructuredSnapshot(config, secret, {
        id: String(asset.id),
        objectKey: asset.name,
        size: asset.size,
        createdAt: Date.parse(asset.created_at) || 0,
        kind: 'githubSnapshot',
      })
      const parts = structuredSnapshotParts(snapshot)
      const inventory = new Map<string, GitHubAsset>()
      await mapWithConcurrency(
        [...new Set(parts.map(structuredPartContainer))],
        3,
        async (container) => {
          let pending = containerInventories.get(container)
          if (!pending) {
            pending = context.readGitHubPartInventory(
              config,
              secret,
              parts.filter((part) => structuredPartContainer(part) === container),
            )
            containerInventories.set(container, pending)
          }
          for (const [key, asset] of await pending) inventory.set(key, asset)
        },
      )
      for (const part of parts)
        assertGitHubDownloadableAsset(
          inventory.get(structuredPartIdentity(part)),
          part.size,
          `${structuredPartContainer(part)}/${structuredPartObjectKey(part)}`,
        )
      backups.push({
        id: String(asset.id),
        objectKey: asset.name,
        size: structuredSnapshotObjects(snapshot).reduce(
          (total, object) => total + object.totalSize,
          0,
        ),
        createdAt: Date.parse(asset.created_at) || Date.parse(snapshot.createdAt) || 0,
        kind: 'githubSnapshot',
        partCount: parts.length,
        archiveName: structuredSnapshotArchiveName(asset.name),
      })
    } catch (error) {
      if (
        isCloudRequestTimeout(error) ||
        error instanceof TypeError ||
        (error && typeof error === 'object' && 'status' in error)
      )
        throw error
      // 清单损坏或对象块不完整时不暴露为可恢复备份。
    } finally {
      checkedSnapshots += 1
      onProgress?.(`正在校验云端快照 ${checkedSnapshots} / ${manifests.length}…`)
    }
  })
  return backups.sort((left, right) => right.createdAt - left.createdAt)
}

export async function readGitHubBundleManifest(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  item: CloudBackupItem,
): Promise<GitHubBundleManifest> {
  const response = await context.githubFetch(config, secret, `/releases/assets/${item.id}`, {
    headers: { Accept: 'application/octet-stream' },
  })
  return parseGitHubBundleManifest(await response.json())
}

export async function readGitHubStructuredSnapshot(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  item: CloudBackupItem,
): Promise<StructuredSnapshot> {
  return context
    .githubFetch(config, secret, `/releases/assets/${item.id}`, {
      headers: { Accept: 'application/octet-stream' },
    })
    .then(async (response) => decodeStructuredSnapshot(await context.readResponseBlob(response)))
    .catch((error: unknown) => {
      throw describeGitHubAssetFailure(error, `快照清单 ${item.objectKey}`, item.id)
    })
}

function describeGitHubAssetFailure(error: unknown, object: string, id: string | number): Error {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  const upstream =
    error && typeof error === 'object' && 'upstream' in error ? error.upstream : undefined
  return Object.assign(
    new Error(
      `读取 GitHub ${object}失败（附件 ${id}）。${status === 404 && upstream !== 'github-asset' ? '附件可能已被删除或替换，或当前令牌无权访问该仓库；请核对目标和权限并刷新备份列表。' : ''}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ),
    { status, upstream },
  )
}

const GITHUB_READ_CONCURRENCY = 3
const GITHUB_READ_BYTE_BUDGET = 32 * 1024 * 1024

/** Metadata can rule out incomplete uploads; it never replaces byte/SHA verification. */
export function assertGitHubDownloadableAsset(
  asset: GitHubAsset | undefined,
  expectedSize: number,
  description: string,
): asserts asset is GitHubAsset {
  if (!asset || asset.size !== expectedSize) throw new Error(`GitHub 对象缺少分块：${description}`)
  // Older valid inventories may omit state. Explicit unfinished states fail closed.
  if (asset.state && asset.state !== 'uploaded')
    throw new Error(
      `GitHub ${description} 上传未完成（状态 ${asset.state}，附件 ${asset.id}）。请在保留该资源原件的设备上重新备份以补齐分块；仅刷新或重试下载无法修复残件。`,
    )
}

export async function createGitHubObjectReader(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  options: { concurrency?: number; byteBudget?: number } = {},
): Promise<(object: GitHubBundleManifest) => Promise<Blob>> {
  const concurrency = Math.max(
    1,
    Math.min(GITHUB_READ_CONCURRENCY, Math.floor(options.concurrency || GITHUB_READ_CONCURRENCY)),
  )
  const byteBudget = Math.max(
    1,
    Math.min(GITHUB_READ_BYTE_BUDGET, options.byteBudget || GITHUB_READ_BYTE_BUDGET),
  )
  const inventories = new Map<string, Promise<Map<string, GitHubAsset>>>()
  const releaseIds = new Map<string, number>()
  const refreshedContainers = new Map<string, Promise<Map<string, GitHubAsset>>>()
  const inventory = (container: string, signal: AbortSignal) => {
    let pending = inventories.get(container)
    if (!pending) {
      pending = context
        .getGitHubRelease(config, secret, false, container, signal)
        .then(async (release) => {
          if (!release) throw new Error(`GitHub 对象容器不存在：${container}`)
          releaseIds.set(container, release.id)
          return new Map(
            (await context.listGitHubAssets(config, secret, release.id, signal)).map((asset) => [
              asset.name,
              asset,
            ]),
          )
        })
      inventories.set(container, pending)
    }
    return pending
  }
  return createCloudObjectReader(
    context,
    'GitHub',
    async (object) => {
      const resolved: CloudReadPart[] = []
      for (const part of object.parts) {
        const container = structuredPartContainer(part)
        const objectKey = structuredPartObjectKey(part)
        const storedSize = part.storedSize ?? part.size
        let asset = (
          await inventory(container, context.signal ?? new AbortController().signal)
        ).get(objectKey)
        assertGitHubDownloadableAsset(
          asset,
          storedSize,
          `资源 ${object.fileName} 的分块 ${container}/${objectKey}`,
        )
        resolved.push({
          key: `${container}\u0000${objectKey}\u0000${part.sha256}\u0000${storedSize}`,
          size: storedSize,
          sha256: part.sha256,
          describeFailure: (error) =>
            describeGitHubAssetFailure(
              error,
              `资源 ${object.fileName} 的分块 ${container}/${objectKey}`,
              asset!.id,
            ),
          download: async (signal) => {
            const download = (target: GitHubAsset) =>
              context.githubFetch(config, secret, `/releases/assets/${target.id}`, {
                headers: { Accept: 'application/octet-stream' },
                signal,
              })
            try {
              return await download(asset!).catch(async (error: unknown) => {
                signal.throwIfAborted()
                if (!(
                  error &&
                  typeof error === 'object' &&
                  'status' in error &&
                  error.status === 404
                ))
                  throw error
                if ('upstream' in error && error.upstream === 'github-asset') throw error
                if (
                  !/^srl-chunk--sha256-[a-f0-9]{64}$/u.test(objectKey) ||
                  !objectKey.endsWith(part.sha256)
                )
                  throw error
                let refresh = refreshedContainers.get(container)
                if (!refresh) {
                  const releaseId = releaseIds.get(container)!
                  context.activeGitHubInventory?.assets.delete(releaseId)
                  refresh = context
                    .listGitHubAssets(config, secret, releaseId, signal)
                    .then((assets) => new Map(assets.map((value) => [value.name, value])))
                  refreshedContainers.set(container, refresh)
                  inventories.set(container, refresh)
                }
                const refreshed = (await refresh).get(objectKey)
                signal.throwIfAborted()
                if (!refreshed || refreshed.id === asset!.id || refreshed.size !== storedSize)
                  throw error
                asset = refreshed
                return download(refreshed)
              })
            } catch (error) {
              if (signal.aborted) throw signal.reason
              throw error
            }
          },
        })
      }
      return resolved
    },
    concurrency,
    byteBudget,
  )
}

export async function downloadGitHubBundle(
  context: CloudBackupTransportContext,
  config: GitHubBackupConfig,
  secret: string,
  item: CloudBackupItem,
): Promise<Blob> {
  const manifest = await context.readGitHubBundleManifest(config, secret, item)
  const release = await context.getGitHubRelease(config, secret, false)
  if (!release) throw new Error('GitHub 分包所在的备份容器不存在')
  const assets = await context.listGitHubAssets(config, secret, release.id)
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const blobs: Blob[] = []
  for (const [index, part] of manifest.parts.entries()) {
    const asset = byName.get(part.name)
    if (!asset || asset.size !== part.size) throw new Error(`GitHub 备份缺少第 ${index + 1} 卷`)
    const response = await context.githubFetch(config, secret, `/releases/assets/${asset.id}`, {
      headers: { Accept: 'application/octet-stream' },
    })
    const blob = await context.readResponseBlob(response, part.size)
    if (blob.size !== part.size || (await hashCloudBlob(blob)) !== part.sha256) {
      throw new Error(`GitHub 第 ${index + 1} 卷校验失败`)
    }
    blobs.push(blob)
  }
  const restored = new Blob(blobs, { type: 'application/octet-stream' })
  if (
    restored.size !== manifest.totalSize ||
    (await hashCloudBlob(restored)) !== manifest.totalSha256
  ) {
    throw new Error('GitHub 分包合并后的完整性校验失败')
  }
  return restored
}
