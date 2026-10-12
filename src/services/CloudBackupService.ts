import {
  listRetentionBackups,
  referencedPartIdentities,
  prune,
  createStructuredFingerprint,
  readStructuredBackupIndex,
  type StructuredBackupIndex,
  reuseUnchangedStructuredBackup,
  buildStructuredBackup,
  buildNativeRestorePlan,
  materializeStructuredArchive,
  type CloudBackupSnapshotOperationsContext,
} from './CloudBackupSnapshotOperations'

import { cloudPlainSecretCopies, type PersonalResourceSelection } from './PersonalResourceBackup'

import type { ArchivePortableData } from '../types/Backup'

import type {
  CloudBackupConfig,
  CloudBackupContentSelection,
  CloudBackupItem,
  CloudBackupProvider,
  CloudBackupSnapshot,
  CloudBackupStatus,
  GitHubBackupConfig,
} from '../types/CloudBackup'

import type { CategoryService } from './CategoryService'

import { hashCloudBlob, readTransportHash } from './CloudArchiveCodec'

import { CloudBackupConfiguration, STATUS_KEY } from './CloudBackupConfiguration'

import { cloudHttpError, friendlyNetworkError, readJson } from './CloudBackupHttp'

import { CloudBackupMetricsTracker } from './CloudBackupMetrics'

import {
  RETRY_MS,
  allowsAutomaticBackup,
  basicAuthorization,
  isScheduleDue,
  joinUrl,
  normalizeContentSelection,
  normalizeFolder,
  normalizeProtection,
  normalizeRetention,
  normalizeSchedule,
} from './CloudBackupPolicy'

import { CloudBackupTransport } from './CloudBackupTransport'

import { type CloudBackupProgressCallback } from './CloudBackupTransportContext'

import {
  structuredSnapshotArchiveName,
  type CreatedStructuredSnapshot,
  type StructuredSnapshot,
} from './CloudStructuredSnapshot'

import type { ExportService } from './ExportService'

import {
  cancelActiveNativeCloudTransfer,
  getLatestNativeCloudJob,
  getLatestNativeCloudRestoreJob,
  isNativeCloudTransferAvailable,
  restoreNativeStructuredObjects,
  type NativeRestoreObject,
  type NativeRestoreResource,
} from './NativeCloudTransfer'

import type { ResourceService } from './ResourceService'

import {
  readBackupRestoreContents,
  portableRestoreScopeIds,
  selectRestorePortableData,
  selectPreparedRestore,
  selectStructuredSnapshot,
} from './BackupRestoreSelection'

import type { RestoreService } from './RestoreService'

import type { ResourceSummary } from '../types/Resource'

import type { CloudBackupJobRecord } from './CloudBackupJobStore'
import type { BackupScopeId } from './BackupScopeRegistry'

export type { CloudBackupProgressCallback } from './CloudBackupTransportContext'

export { readCloudResponseText } from './CloudBackupHttp'

export interface GitHubRepositoryInspection {
  fullName: string
  isPrivate: boolean
  canWrite: boolean
}

export class CloudBackupService extends CloudBackupTransport {
  private readonly configuration: CloudBackupConfiguration
  private readonly verifiedPrivateGitHubTargets = new Set<string>()
  private readonly resourceService: ResourceService
  private readonly categoryService: CategoryService
  private readonly exportService: ExportService
  private readonly restoreService: RestoreService
  private readonly portableDataFactory?: (
    selection: CloudBackupContentSelection,
  ) => Promise<ArchivePortableData>
  private readonly portableDataImporter?: (data: ArchivePortableData) => Promise<void>
  private readonly prepareNativeBackup?: () => Promise<void>
  private nativeRestoreInFlight = false

  constructor(
    resourceService: ResourceService,
    categoryService: CategoryService,
    exportService: ExportService,
    restoreService: RestoreService,
    portableDataFactory?: (selection: CloudBackupContentSelection) => Promise<ArchivePortableData>,
    portableDataImporter?: (data: ArchivePortableData) => Promise<void>,
    prepareNativeBackup?: () => Promise<void>,
  ) {
    super()
    this.resourceService = resourceService
    this.categoryService = categoryService
    this.exportService = exportService
    this.restoreService = restoreService
    this.portableDataFactory = portableDataFactory
    this.portableDataImporter = portableDataImporter
    this.prepareNativeBackup = prepareNativeBackup
    this.configuration = new CloudBackupConfiguration((config, secret) =>
      this.testConnection(config, secret),
    )
  }
  async initializeCredentials(): Promise<void> {
    return this.configuration.initializeCredentials()
  }

  async reconcileNativeJob(): Promise<void> {
    const latest = await getLatestNativeCloudJob().catch(() => null)
    if (!latest || !['completed', 'failed', 'cancelled'].includes(latest.status)) return
    const current = this.getSnapshot().status
    if ((current.lastAttemptAt ?? 0) >= (latest.updatedAt ?? 0)) return
    if (latest.status === 'completed') {
      this.writeStatus({
        provider: latest.provider,
        lastAttemptAt: latest.updatedAt,
        lastSuccessAt: latest.updatedAt,
        lastObjectKey: latest.resultName,
        lastError: undefined,
        lastWarning: undefined,
      })
    } else {
      this.writeStatus({
        provider: latest.provider,
        lastAttemptAt: latest.updatedAt,
        lastError:
          latest.error || (latest.status === 'cancelled' ? '原生云备份已取消' : '原生云备份失败'),
        lastWarning: undefined,
      })
    }
  }

  async cancelActiveNativeBackup(): Promise<'cancelled' | 'committing' | undefined> {
    return cancelActiveNativeCloudTransfer()
  }

  async hasActiveNativeBackup(): Promise<boolean> {
    const latest = await getLatestNativeCloudJob().catch(() => null)
    return Boolean(latest && ['staging', 'queued', 'running', 'committing'].includes(latest.status))
  }

  async getNativeRestoreProgress() {
    return getLatestNativeCloudRestoreJob().catch(() => null)
  }

  async pendingNativeRestores(): Promise<CloudBackupJobRecord[]> {
    return isNativeCloudTransferAvailable() ? this.transportState.jobStore.pendingRestores() : []
  }

  async resumeNativeRestore(
    record: CloudBackupJobRecord,
    filterPortableData?: (data: ArchivePortableData) => Promise<ArchivePortableData>,
  ): Promise<number> {
    if (!record.restore) throw new Error('云恢复记录不完整')
    await this.initializeCredentials()
    if (
      JSON.stringify(record.restore.target) !==
      JSON.stringify(this.restoreTarget(this.getActiveConfig()))
    )
      throw new Error('请先切回此恢复任务原来的云端目标，再继续导入')
    return this.restoreBackup(
      record.restore.item,
      filterPortableData,
      record.restore.resourceKeys,
      record.restore.includeGallery,
      record.restore.portableScopeIds,
    )
  }

  private restoreTarget(config: CloudBackupConfig): CloudBackupConfig {
    return config.provider === 'github'
      ? {
          provider: 'github',
          owner: config.owner.toLowerCase(),
          repository: config.repository.toLowerCase(),
          retention: 1,
          autoBackup: false,
        }
      : {
          provider: 'webdav',
          baseUrl: config.baseUrl.trim().replace(/\/+$/u, ''),
          folder: normalizeFolder(config.folder),
          username: config.username,
          retention: 1,
          autoBackup: false,
        }
  }

  async getActiveNativeBackupProgress(): Promise<{
    status: 'staging' | 'queued' | 'running' | 'committing'
    completed: number
    total: number
    uploadedBytes: number
    totalBytes: number
    networkMs: number
  } | null> {
    const latest = await getLatestNativeCloudJob().catch(() => null)
    if (!latest || !['staging', 'queued', 'running', 'committing'].includes(latest.status))
      return null
    return {
      status: latest.status as 'staging' | 'queued' | 'running' | 'committing',
      completed: latest.completed,
      total: latest.total,
      uploadedBytes: latest.uploadedBytes ?? 0,
      totalBytes: latest.totalBytes ?? 0,
      networkMs: latest.networkMs ?? 0,
    }
  }
  getSnapshot(): CloudBackupSnapshot {
    return this.configuration.getSnapshot()
  }
  exportPortableSettings(): NonNullable<ArchivePortableData['cloudBackup']> {
    return this.configuration.exportPortableSettings()
  }
  importPortableSettings(value: NonNullable<ArchivePortableData['cloudBackup']>): void {
    return this.configuration.importPortableSettings(value)
  }
  async exportPortableCredentials(): Promise<Partial<Record<CloudBackupProvider, string>>> {
    return this.configuration.exportPortableCredentials()
  }
  async importPortableCredentials(
    value: Partial<Record<CloudBackupProvider, string>>,
  ): Promise<void> {
    return this.configuration.importPortableCredentials(value)
  }
  async saveConfig(
    config: CloudBackupConfig,
    secret: string,
    activate = true,
  ): Promise<CloudBackupSnapshot> {
    return this.configuration.saveConfig(config, secret, activate)
  }
  async clearCredential(provider: CloudBackupProvider): Promise<void> {
    return this.configuration.clearCredential(provider)
  }
  hasCredential(provider: CloudBackupProvider): boolean {
    return this.configuration.hasCredential(provider)
  }

  private githubTargetKey(config: GitHubBackupConfig): string {
    return `${config.owner.trim().toLowerCase()}/${config.repository.trim().toLowerCase()}`
  }

  invalidateGitHubPrivacyVerification(target?: string): void {
    if (target) this.verifiedPrivateGitHubTargets.delete(target.toLowerCase())
    else this.verifiedPrivateGitHubTargets.clear()
  }

  async inspectGitHubRepository(
    config: GitHubBackupConfig,
    secret?: string,
  ): Promise<GitHubRepositoryInspection> {
    await this.initializeCredentials()
    const credential = secret || this.requireSecret(config.provider)
    const response = await this.githubFetch(config, credential, '')
    const repository = (await response.json()) as {
      full_name?: string
      private?: boolean
      permissions?: { push?: boolean }
    }
    if (repository.permissions?.push === false) {
      throw new Error('令牌可以读取仓库，但没有写入权限；请把 Contents 改为 Read and write')
    }
    const inspection = {
      fullName: repository.full_name ?? `${config.owner}/${config.repository}`,
      isPrivate: repository.private === true,
      canWrite: true,
    }
    const target = this.githubTargetKey(config)
    if (inspection.isPrivate) this.verifiedPrivateGitHubTargets.add(target)
    else this.verifiedPrivateGitHubTargets.delete(target)
    return inspection
  }

  async testConnection(config: CloudBackupConfig, secret?: string): Promise<string> {
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        await this.initializeCredentials()
        const credential = secret || this.requireSecret(config.provider)
        try {
          if (config.provider === 'github') {
            const repository = await this.inspectGitHubRepository(config, credential)
            return `已连接 ${repository.fullName}${repository.isPrivate ? '（私有仓库）' : '（公开仓库，建议改为私有）'}`
          }
          await this.ensureWebDavFolder(config, credential)
          const probeUrl = joinUrl(
            config.baseUrl,
            normalizeFolder(config.folder),
            '.srl-connection-test',
          )
          const response = await this.cloudFetch(
            probeUrl,
            {
              method: 'PUT',
              headers: {
                Authorization: basicAuthorization(config.username, credential),
                'Content-Type': 'text/plain',
              },
              body: 'SRL connection test',
            },
            'webdav',
          )
          if (!response.ok)
            throw cloudHttpError(`WebDAV 写入测试返回 ${response.status}`, response.status)
          await this.cloudFetch(
            probeUrl,
            {
              method: 'DELETE',
              headers: { Authorization: basicAuthorization(config.username, credential) },
            },
            'webdav',
          )
          return 'Koofr 连接成功'
        } catch (error) {
          if (!secret) await this.invalidateCredentialOnConfirmed401(config.provider, error)
          throw friendlyNetworkError(error, config.provider)
        }
      },
    )
  }

  async createBackup(
    config?: CloudBackupConfig,
    secret?: string,
    onProgress?: CloudBackupProgressCallback,
    respectAutomaticConstraints = false,
  ): Promise<CloudBackupItem> {
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        await this.initializeCredentials()
        const resolved = config ?? this.getActiveConfig()
        const credential = secret || this.requireSecret(resolved.provider)
        if (isNativeCloudTransferAvailable()) {
          const latest = await getLatestNativeCloudJob(resolved.provider).catch(() => null)
          if (latest && ['staging', 'queued', 'running', 'committing'].includes(latest.status)) {
            throw new Error('已有 Android 原生云备份正在继续；不会重新开始整个备份')
          }
        }
        if (this.transportState.activeMetrics)
          throw new Error('已有云备份正在执行，请等待它结束或先取消')
        const metrics = new CloudBackupMetricsTracker()
        this.transportState.activeMetrics = metrics
        this.writeStatus({
          provider: resolved.provider,
          lastAttemptAt: Date.now(),
          lastError: undefined,
          lastWarning: undefined,
        })
        try {
          if (isNativeCloudTransferAvailable() && this.prepareNativeBackup) {
            onProgress?.('正在核对 Android 本机原件镜像…')
            await metrics.measure('prepareMs', this.prepareNativeBackup)
          }
          onProgress?.('正在读取资源与历史版本…')
          const contentSelection = normalizeContentSelection(resolved.contentSelection)
          if (contentSelection.communitySources && resolved.provider === 'github') {
            const target = this.githubTargetKey(resolved)
            if (!this.verifiedPrivateGitHubTargets.has(target)) {
              const repository = await this.inspectGitHubRepository(resolved, credential)
              if (!repository.isPrivate)
                throw new Error(
                  `GitHub 仓库 ${repository.fullName} 是公开仓库，已阻止上传 Discord 社区内容。请先把仓库改为 Private，再重新测试连接。`,
                )
            }
          }
          const portableData: ArchivePortableData = await metrics.measure('prepareMs', async () =>
            Promise.resolve(this.portableDataFactory?.(contentSelection)).then(
              (value) => value ?? { version: 1 },
            ),
          )
          if (contentSelection.cloudBackup) portableData.cloudBackup = this.exportPortableSettings()
          if (contentSelection.personalResources?.secret && contentSelection.plaintextSecretCopy) {
            portableData.plaintextSecretCopies = await cloudPlainSecretCopies(
              resolved,
              this.resourceService,
            )
          }
          if (
            typeof this.resourceService.listSummaries === 'function' &&
            typeof this.resourceService.listVersions === 'function'
          ) {
            onProgress?.('正在读取轻量索引，检查本机内容是否变化…')
            const index = await metrics.measure('prepareMs', () =>
              readStructuredBackupIndex(this.snapshotContext(), contentSelection.personalResources),
            )
            const currentResourceCount = index.resourceCount
            const previousHealth = this.getSnapshot().status
            const suspiciousDrop =
              previousHealth.lastHealthyResourceCount !== undefined &&
              previousHealth.lastHealthyResourceCount > 0 &&
              currentResourceCount <
                Math.max(1, Math.floor(previousHealth.lastHealthyResourceCount * 0.5))
            if (suspiciousDrop && respectAutomaticConstraints) {
              throw new Error(
                `本机资源从上次健康备份的 ${previousHealth.lastHealthyResourceCount} 项骤降到 ${currentResourceCount} 项，已暂停自动备份与旧备份清理，请先检查资源库。`,
              )
            }
            const contentFingerprint = await metrics.measure('hashMs', () =>
              this.createStructuredFingerprint(resolved, portableData, index),
            )
            const previousStatus = this.getSnapshot().status
            if (
              previousStatus.provider === resolved.provider &&
              previousStatus.lastContentFingerprint === contentFingerprint &&
              previousStatus.lastObjectKey
            ) {
              onProgress?.('本机内容与上次成功备份一致，正在核对远端清单…')
              const reused = await this.reuseUnchangedStructuredBackup(
                resolved,
                credential,
                previousStatus.lastObjectKey,
              )
              if (reused) {
                const lastMetrics = metrics.snapshot(true)
                this.writeStatus({
                  provider: resolved.provider,
                  lastAttemptAt: Date.now(),
                  lastSuccessAt: Date.now(),
                  lastObjectKey: reused.objectKey,
                  lastSize: reused.size,
                  lastContentFingerprint: contentFingerprint,
                  lastResourceCount: currentResourceCount,
                  lastHealthyObjectKey: suspiciousDrop
                    ? previousHealth.lastHealthyObjectKey
                    : reused.objectKey,
                  lastHealthyResourceCount: suspiciousDrop
                    ? previousHealth.lastHealthyResourceCount
                    : currentResourceCount,
                  lastMetrics,
                  lastError: undefined,
                  lastWarning: undefined,
                })
                return { ...reused, unchanged: true, metrics: lastMetrics }
              }
              onProgress?.('远端上次清单缺失或不完整，正在重新构建对象快照…')
            }
            const structured = await metrics.measure('objectBuildMs', () =>
              this.buildStructuredBackup(
                portableData,
                onProgress,
                contentSelection.personalResources,
                index,
              ),
            )
            if (structured.descriptorUpdates?.length) {
              onProgress?.('正在保存可复用的分块描述，下次差量备份将跳过未变大文件扫描…')
              for (const update of structured.descriptorUpdates) {
                await this.resourceService.updateBackupDescriptor(
                  update.id,
                  update.descriptor,
                  update.historical,
                )
              }
            }
            metrics.add('localReadBytes', structured.localReadBytes ?? structured.totalSize)
            const item =
              resolved.provider === 'github'
                ? await this.uploadGitHubStructuredBackup(
                    resolved,
                    credential,
                    structured,
                    onProgress,
                    respectAutomaticConstraints,
                  )
                : await this.uploadWebDavStructuredBackup(
                    resolved,
                    credential,
                    structured,
                    onProgress,
                    respectAutomaticConstraints,
                  )
            let maintenanceWarning: string | undefined
            try {
              if (suspiciousDrop) {
                maintenanceWarning =
                  '检测到资源数量异常下降：新快照已作为事故现场保留，未执行任何云端清理。'
              } else {
                onProgress?.('备份已提交成功，正在按保留份数检查旧快照…')
                const removed = await metrics.measure('maintenanceMs', () =>
                  this.prune(
                    resolved,
                    credential,
                    item.objectKey,
                    false,
                    structured.snapshot,
                    onProgress,
                  ),
                )
                if (removed > 0)
                  maintenanceWarning = `已按保留份数自动清理 ${removed} 份旧云端快照。`
              }
            } catch (error) {
              maintenanceWarning = `新对象快照已上传成功，但旧备份清理失败：${friendlyNetworkError(error, resolved.provider).message}`
            }
            const lastMetrics = metrics.snapshot(true)
            this.writeStatus({
              provider: resolved.provider,
              lastAttemptAt: Date.now(),
              lastSuccessAt: Date.now(),
              lastObjectKey: item.objectKey,
              lastSize: item.size,
              lastContentFingerprint: contentFingerprint,
              lastResourceCount: currentResourceCount,
              lastHealthyObjectKey: suspiciousDrop
                ? previousHealth.lastHealthyObjectKey
                : item.objectKey,
              lastHealthyResourceCount: suspiciousDrop
                ? previousHealth.lastHealthyResourceCount
                : currentResourceCount,
              lastMetrics,
              lastError: undefined,
              lastWarning: maintenanceWarning,
            })
            return maintenanceWarning
              ? { ...item, maintenanceWarning, metrics: lastMetrics }
              : { ...item, metrics: lastMetrics }
          }
          throw new Error('当前资源存储不支持 Cloud Backup V3 所需的摘要与版本读取接口')
        } catch (error) {
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          const friendly = friendlyNetworkError(error, resolved.provider)
          const lastMetrics = metrics.snapshot(true)
          this.writeStatus({
            provider: resolved.provider,
            lastAttemptAt: Date.now(),
            lastMetrics,
            lastError: friendly.message,
            lastWarning: undefined,
          })
          throw friendly
        } finally {
          if (this.transportState.activeMetrics === metrics) {
            this.transportState.activeMetrics = undefined
            this.transportState.activeGitHubInventory = undefined
            this.transportState.activeWebDavInventory = undefined
          }
        }
      },
    )
  }

  async listBackups(
    config?: CloudBackupConfig,
    secret?: string,
    onProgress?: CloudBackupProgressCallback,
    onWarning?: CloudBackupProgressCallback,
  ): Promise<CloudBackupItem[]> {
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        await this.initializeCredentials()
        const resolved = config ?? this.getActiveConfig()
        const credential = secret || this.requireSecret(resolved.provider)
        try {
          return resolved.provider === 'github'
            ? await this.listGitHub(resolved, credential, onProgress)
            : await this.listWebDav(resolved, credential, onProgress, onWarning)
        } catch (error) {
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          throw friendlyNetworkError(error, resolved.provider)
        }
      },
    )
  }

  async enforceRetention(
    config?: CloudBackupConfig,
    secret?: string,
  ): Promise<{ removed: number; remaining: number }> {
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        await this.initializeCredentials()
        const resolved = config ?? this.getActiveConfig()
        const credential = secret || this.requireSecret(resolved.provider)
        try {
          const removed = await this.prune(resolved, credential, undefined, true)
          return { removed, remaining: normalizeRetention(resolved.retention) }
        } catch (error) {
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          throw friendlyNetworkError(error, resolved.provider)
        }
      },
    )
  }

  async downloadBackup(
    item: CloudBackupItem,
    config?: CloudBackupConfig,
    secret?: string,
  ): Promise<Blob> {
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        await this.initializeCredentials()
        const resolved = config ?? this.getActiveConfig()
        const credential = secret || this.requireSecret(resolved.provider)
        try {
          if (item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot') {
            return (await this.materializeStructuredArchive(item, resolved, credential)).blob
          }
          if (resolved.provider === 'github') {
            if (item.kind === 'githubBundle' || item.objectKey.endsWith('.srlbundle.json')) {
              return this.downloadGitHubBundle(resolved, credential, item)
            }
            const response = await this.githubFetch(
              resolved,
              credential,
              `/releases/assets/${item.id}`,
              {
                headers: { Accept: 'application/octet-stream' },
              },
            )
            return this.verifyDownloadedBlob(item, await response.blob())
          }
          if (item.kind === 'webdavBundle' || item.objectKey.endsWith('.srlbundle.json')) {
            return this.downloadWebDavBundle(resolved, credential, item)
          }
          const response = await this.cloudFetch(
            joinUrl(resolved.baseUrl, normalizeFolder(resolved.folder), item.objectKey),
            {
              headers: { Authorization: basicAuthorization(resolved.username, credential) },
            },
            'webdav',
          )
          if (!response.ok)
            throw cloudHttpError(`WebDAV 下载失败（${response.status}）`, response.status)
          return this.verifyDownloadedBlob(item, await response.blob())
        } catch (error) {
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          throw friendlyNetworkError(error, resolved.provider)
        }
      },
    )
  }

  async listBackupResources(item: CloudBackupItem): Promise<ResourceSummary[]> {
    return (await this.listBackupRestoreContents(item)).resources
  }

  async listBackupRestoreContents(
    item: CloudBackupItem,
  ): Promise<{ resources: ResourceSummary[]; portableScopeIds: BackupScopeId[] }> {
    return this.withRelayWorkerTarget(this.getActiveConfig().provider, async () => {
      await this.initializeCredentials()
      const resolved = this.getActiveConfig()
      const credential = this.requireSecret(resolved.provider)
      try {
        const contents = await readBackupRestoreContents(
          item,
          async () =>
            resolved.provider === 'github'
              ? await this.readGitHubStructuredSnapshot(resolved, credential, item)
              : await this.readWebDavStructuredSnapshot(resolved, credential, item.objectKey),
          () => this.downloadBackup(item),
          this.resourceService,
          this.categoryService,
          this.restoreService,
        )
        return {
          resources: contents.resources,
          portableScopeIds: portableRestoreScopeIds(contents.portableData),
        }
      } catch (error) {
        await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
        throw friendlyNetworkError(error, resolved.provider)
      }
    })
  }

  async restoreBackup(
    item: CloudBackupItem,
    filterPortableData?: (data: ArchivePortableData) => Promise<ArchivePortableData>,
    resourceKeys?: readonly string[],
    includeGallery = true,
    portableScopeIds?: readonly BackupScopeId[],
  ): Promise<number> {
    return this.withRelayWorkerTarget(this.getSnapshot().activeProvider, async () => {
      if (item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot') {
        const resolved = this.getActiveConfig()
        const credential = this.requireSecret(resolved.provider)
        try {
          return await this.restoreStructuredBackup(
            item,
            resolved,
            credential,
            filterPortableData,
            resourceKeys,
            includeGallery,
            portableScopeIds,
          )
        } catch (error) {
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          throw friendlyNetworkError(error, resolved.provider)
        }
      }
      const blob = await this.downloadBackup(item)
      const fileName = item.archiveName ?? item.objectKey.replace(/\.srlbundle\.json$/i, '')
      const [resources, categories] = await Promise.all([
        this.resourceService.listResourceListSummaries(),
        this.categoryService.list(),
      ])
      const prepared = await this.restoreService.prepare(
        new File([blob], fileName, { type: 'application/zip' }),
        resources,
        categories,
        true,
      )
      const selected = selectPreparedRestore(
        prepared,
        new Set(
          resourceKeys ??
            [...prepared.resources, ...(prepared.galleryOwners ?? [])].map((r) => r.id),
        ),
        includeGallery,
      )
      const report = await this.restoreService.restore(selected)
      await this.importPreparedPortableData(
        selectRestorePortableData(selected.portableData, portableScopeIds),
        filterPortableData,
      )
      return report.restoredResources
    })
  }

  private async restoreStructuredBackup(
    item: CloudBackupItem,
    config: CloudBackupConfig,
    secret: string,
    filterPortableData?: (data: ArchivePortableData) => Promise<ArchivePortableData>,
    resourceKeys?: readonly string[],
    includeGallery = true,
    portableScopeIds?: readonly BackupScopeId[],
  ): Promise<number> {
    const loadedSnapshot =
      config.provider === 'github'
        ? await this.readGitHubStructuredSnapshot(config, secret, item)
        : await this.readWebDavStructuredSnapshot(config, secret, item.objectKey)
    const snapshot = selectStructuredSnapshot(
      loadedSnapshot,
      new Set(resourceKeys ?? loadedSnapshot.resources.map((r) => r.id)),
      includeGallery,
    )
    const nativeRestore = isNativeCloudTransferAvailable() && snapshot.version === 3
    if (nativeRestore) {
      if (!this.restoreService.canRestoreStructuredNative()) {
        throw new Error('本地保险箱开启时不能从云端导入，请先通过保险箱设置切回普通存储。')
      }
      const plan = await this.buildNativeRestorePlan(snapshot, config, secret)
      if (this.nativeRestoreInFlight) throw new Error('已有云恢复正在导入，请等待当前任务完成')
      this.nativeRestoreInFlight = true
      let recovery: CloudBackupJobRecord | undefined
      try {
        const selection = {
          item,
          target: this.restoreTarget(config),
          resourceKeys: snapshot.resources.map((resource) => resource.id),
          includeGallery,
          ...(portableScopeIds === undefined ? {} : { portableScopeIds: [...portableScopeIds] }),
        }
        const planHash = await hashCloudBlob(new Blob([JSON.stringify(selection)]))
        recovery = await this.transportState.jobStore.beginRestore(planHash, selection)
        await restoreNativeStructuredObjects({ config, secret, ...plan })
        const [existingResources, existingCategories] = await Promise.all([
          this.resourceService.listResourceListSummaries(),
          this.categoryService.list(),
        ])
        const prepared = await this.restoreService.prepareStructuredNative(
          snapshot.resources,
          snapshot.versions,
          snapshot.categories,
          snapshot.portableData,
          existingResources,
          existingCategories,
          structuredSnapshotArchiveName(item.objectKey.split('/').at(-1) ?? item.objectKey),
        )
        const report = await this.restoreService.restoreNative(prepared)
        await this.importPreparedPortableData(
          selectRestorePortableData(prepared.portableData, portableScopeIds),
          filterPortableData,
        )
        await this.transportState.jobStore.complete(recovery, item.objectKey)
        return report.restoredResources
      } catch (error) {
        if (recovery) await this.transportState.jobStore.fail(recovery, error)
        throw error
      } finally {
        this.nativeRestoreInFlight = false
      }
    }
    const [existingResources, existingCategories] = await Promise.all([
      this.resourceService.listResourceListSummaries(),
      this.categoryService.list(),
    ])
    const providerReader =
      config.provider === 'github'
        ? await this.createGitHubObjectReader(config, secret)
        : this.createWebDavObjectReader(config, secret)
    const report = await this.restoreService.restoreStructured(
      snapshot,
      providerReader,
      existingResources,
      existingCategories,
      structuredSnapshotArchiveName(item.objectKey.split('/').at(-1) ?? item.objectKey),
    )
    await this.importPreparedPortableData(
      selectRestorePortableData(report.portableData ?? snapshot.portableData, portableScopeIds),
      filterPortableData,
    )
    return report.restoredResources
  }

  private async importPreparedPortableData(
    data: ArchivePortableData | undefined,
    filter?: (data: ArchivePortableData) => Promise<ArchivePortableData>,
  ): Promise<void> {
    if (!data || !this.portableDataImporter) return
    await this.portableDataImporter(filter ? await filter(data) : data)
  }

  private async buildNativeRestorePlan(
    snapshot: StructuredSnapshot,
    config: CloudBackupConfig,
    secret: string,
  ): Promise<{ objects: NativeRestoreObject[]; resources: NativeRestoreResource[] }> {
    return buildNativeRestorePlan(this.snapshotContext(), snapshot, config, secret)
  }

  private async materializeStructuredArchive(
    item: CloudBackupItem,
    config: CloudBackupConfig,
    secret: string,
  ) {
    return materializeStructuredArchive(this.snapshotContext(), item, config, secret)
  }

  async runDueBackup(): Promise<'disabled' | 'credential' | 'waiting' | 'success'> {
    await this.initializeCredentials()
    const snapshot = this.getSnapshot()
    const provider = snapshot.activeProvider
    if (!provider) return 'disabled'
    const config = provider ? snapshot[provider] : undefined
    if (!config?.autoBackup) return 'disabled'
    if (!this.getSecret(provider)) return 'credential'
    // A native job is already the durable owner while Android is uploading in the
    // background. Returning to the foreground must reconcile/bind to it, never
    // schedule a second backup for the same due window.
    if (await this.hasActiveNativeBackup()) return 'waiting'
    if (!(await allowsAutomaticBackup(normalizeProtection(config.protection)))) return 'waiting'
    const status = snapshot.status
    const now = Date.now()
    if (!isScheduleDue(normalizeSchedule(config.schedule), status.lastSuccessAt, now))
      return 'waiting'
    if (status.lastAttemptAt && now - status.lastAttemptAt < RETRY_MS) return 'waiting'
    await this.createBackup(config, undefined, undefined, true)
    return 'success'
  }
  private getActiveConfig(): CloudBackupConfig {
    return this.configuration.getActiveConfig()
  }
  private getSecret(provider: CloudBackupProvider): string {
    return this.configuration.getSecret(provider)
  }
  private async invalidateCredentialOnConfirmed401(
    provider: CloudBackupProvider,
    error: unknown,
  ): Promise<void> {
    return this.configuration.invalidateCredentialOnConfirmed401(provider, error)
  }
  private requireSecret(provider: CloudBackupProvider): string {
    return this.configuration.requireSecret(provider)
  }

  private async verifyDownloadedBlob(item: CloudBackupItem, blob: Blob): Promise<Blob> {
    if (item.size > 0 && blob.size !== item.size) {
      throw new Error(`云端备份大小校验失败：预期 ${item.size} 字节，实际 ${blob.size} 字节`)
    }
    const expected = readTransportHash(item.objectKey)
    if (expected && !(await hashCloudBlob(blob)).startsWith(expected)) {
      throw new Error('云端备份 SHA-256 校验失败，文件可能未完整上传或已经损坏')
    }
    return blob
  }

  private writeStatus(update: CloudBackupStatus): void {
    const current = readJson<CloudBackupStatus>(localStorage, STATUS_KEY, {})
    localStorage.setItem(
      STATUS_KEY,
      JSON.stringify({ ...current, ...update, lastError: update.lastError }),
    )
  }

  private async createStructuredFingerprint(
    config: CloudBackupConfig,
    portableData: ArchivePortableData,
    index?: StructuredBackupIndex,
  ): Promise<string> {
    return createStructuredFingerprint(this.snapshotContext(), config, portableData, index)
  }

  private async reuseUnchangedStructuredBackup(
    config: CloudBackupConfig,
    secret: string,
    objectKey: string,
  ): Promise<CloudBackupItem | undefined> {
    return reuseUnchangedStructuredBackup(this.snapshotContext(), config, secret, objectKey)
  }

  private async buildStructuredBackup(
    portableData: ArchivePortableData,
    onProgress?: CloudBackupProgressCallback,
    personalResources?: PersonalResourceSelection,
    index?: StructuredBackupIndex,
  ): Promise<CreatedStructuredSnapshot> {
    return buildStructuredBackup(
      this.snapshotContext(),
      portableData,
      onProgress,
      personalResources,
      index,
    )
  }

  private listRetentionBackups(
    config: CloudBackupConfig,
    secret: string,
  ): Promise<CloudBackupItem[]> {
    return listRetentionBackups(this.snapshotContext(), config, secret)
  }
  private referencedPartIdentities(
    config: CloudBackupConfig,
    secret: string,
    backups: CloudBackupItem[],
  ): Promise<Set<string>> {
    return referencedPartIdentities(this.snapshotContext(), config, secret, backups)
  }
  private async prune(
    config: CloudBackupConfig,
    secret: string,
    protectedObjectKey?: string,
    deep = false,
    committedSnapshot?: StructuredSnapshot,
    onProgress?: CloudBackupProgressCallback,
  ): Promise<number> {
    return prune(
      this.snapshotContext(),
      config,
      secret,
      protectedObjectKey,
      deep,
      committedSnapshot,
      onProgress,
    )
  }

  private snapshotContext(): CloudBackupSnapshotOperationsContext {
    const readTransportState = () => this.transportState
    return {
      listRetentionBackups: this.listRetentionBackups.bind(this),
      referencedPartIdentities: this.referencedPartIdentities.bind(this),
      getGitHubRelease: this.getGitHubRelease.bind(this),
      listGitHubAssets: this.listGitHubAssets.bind(this),
      readGitHubStructuredSnapshot: this.readGitHubStructuredSnapshot.bind(this),
      readWebDavStructuredSnapshot: this.readWebDavStructuredSnapshot.bind(this),
      createGitHubObjectReader: this.createGitHubObjectReader.bind(this),
      createWebDavObjectReader: this.createWebDavObjectReader.bind(this),
      exportService: this.exportService,
      resourceService: this.resourceService,
      categoryService: this.categoryService,
      get transportState() {
        return readTransportState()
      },
      readGitHubPartInventory: this.readGitHubPartInventory.bind(this),
      listWebDavObjects: this.listWebDavObjects.bind(this),
      listWebDavRetentionObjects: this.listWebDavRetentionObjects.bind(this),
      readGitHubBundleManifest: this.readGitHubBundleManifest.bind(this),
      readWebDavBundleManifest: this.readWebDavBundleManifest.bind(this),
      githubFetch: this.githubFetch.bind(this),
      deleteWebDavObject: this.deleteWebDavObject.bind(this),
    }
  }
}
