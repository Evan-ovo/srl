import { withWebBackgroundAudio } from './WebBackgroundKeepAlive'
import { taskCenter } from '../core/TaskCenter'
import { noticeCenter } from '../core/NoticeCenter'
import { notifyWebCloudBackupResult } from './WebDiscordInboxNotifications'
import type { WebCloudBackupState } from '../types/CloudBackup'
import {
  readNativeResourceObject,
  retainNativeResourceFiles,
} from '../storage/NativeResourceFileMirror'
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

import type { ArchivePortableData, PreparedRestore, RestoreReport } from '../types/Backup'

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
import { CloudBackupMaintenanceError } from './CloudBackupRetentionOperations'

import {
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

import { CloudBackupTransport, type RestoreTransferOptions } from './CloudBackupTransport'

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

import type { RestoreService, StructuredRestoreOptions } from './RestoreService'

export interface CloudRestoreOptions extends Omit<StructuredRestoreOptions, 'onFailure'> {
  onTransfer?: RestoreTransferOptions['onTransfer']
  onPhase?: (phase: 'manifest' | 'extras') => void
}

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
  // One selection session: immutable descriptors and verified ZIP staging, never a library of bodies.
  private restorePreview?: {
    key: string
    secret: string
    pending: Promise<{ resources: ResourceSummary[]; portableScopeIds: BackupScopeId[] }>
    snapshot?: StructuredSnapshot
    prepared?: PreparedRestore
    importing?: boolean
    discarded?: boolean
    selection?: string
    committed?: { report: RestoreReport; portableData?: ArchivePortableData }
    completed?: boolean
  }

  async clearRestorePreview(): Promise<void> {
    const preview = this.restorePreview
    if (!preview) return
    if (preview.importing) return
    this.restorePreview = undefined
    preview.discarded = true
    await preview.pending.catch(() => undefined)
    await preview.prepared?.dispose?.()
  }

  private restorePreviewKey(item: CloudBackupItem, config: CloudBackupConfig): string {
    return JSON.stringify([
      this.restoreTarget(config),
      item.id,
      item.objectKey,
      item.kind,
      item.size,
      item.createdAt,
    ])
  }

  private activeWebBackup?: {
    controller: AbortController
    committing: boolean
    stopRequested: boolean
    done: Promise<void>
    operationId: string
    stopStatus?: 'paused' | 'stopped'
  }
  private webBackupState?: WebCloudBackupState
  private readonly webBackupListeners = new Set<() => void>()

  getWebBackupState(): WebCloudBackupState | undefined {
    if (!this.webBackupState) {
      const saved = this.getSnapshot().status.webBackup
      if (saved) {
        this.webBackupState = structuredClone(saved)
        if (saved.status === 'running') {
          this.webBackupState.status = 'paused'
          this.webBackupState.phase = '上次备份已中断，点击继续备份以核对并续传'
          this.writeStatus({ webBackup: this.webBackupState })
        }
      }
    }
    return this.webBackupState ? structuredClone(this.webBackupState) : undefined
  }

  subscribeWebBackup(listener: () => void): () => void {
    this.webBackupListeners.add(listener)
    return () => this.webBackupListeners.delete(listener)
  }

  private publishWebBackup(state: WebCloudBackupState, persist = true): void {
    this.webBackupState = state
    if (persist) this.writeStatus({ webBackup: state })
    for (const listener of this.webBackupListeners) listener()
  }

  private openWebBackup(): void {
    window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'backup' } }))
  }

  private finishWebBackup(status: WebCloudBackupState['status'], phase: string): void {
    const state = this.webBackupState
    if (!state) return
    this.publishWebBackup({ ...state, status, phase })
    const resume = withWebBackgroundAudio('继续云备份', async () => {
      // Finish releasing the old operation before an explicit immediate continuation.
      await this.activeWebBackup?.done
      try {
        await this.resumeWebBackup()
      } catch (error) {
        noticeCenter.push({
          type: 'error',
          persistent: true,
          message: error instanceof Error ? error.message : '继续备份失败',
        })
      }
    })
    const actions = [{ label: '查看云备份', run: () => this.openWebBackup() }]
    if (status !== 'completed') actions.push({ label: '继续备份', run: resume })
    noticeCenter.push({
      id: 'web-cloud-backup',
      type: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'info',
      persistent: status !== 'completed',
      completed: status === 'completed',
      message: phase,
      actions,
    })
    taskCenter.setAction(
      state.operationId,
      status === 'completed'
        ? { label: '查看云备份', run: () => this.openWebBackup(), required: false }
        : { label: '继续备份', run: resume },
    )
  }

  async resumeWebBackup(): Promise<CloudBackupItem> {
    const state = this.getWebBackupState()
    if (!state || state.status === 'completed') throw new Error('没有待继续的网页云备份')
    if (this.activeWebBackup) throw new Error('已有云备份正在执行')
    if (
      JSON.stringify(this.restoreTarget(state.target)) !==
      JSON.stringify(this.restoreTarget(this.getActiveConfig()))
    )
      throw new Error('请先切回这次备份原来的云端目标，再继续备份')
    if (
      JSON.stringify(normalizeContentSelection(state.target.contentSelection)) !==
      JSON.stringify(normalizeContentSelection(this.getActiveConfig().contentSelection))
    )
      throw new Error('备份范围已变化，请使用“立即备份”按当前范围继续；已验证的云端对象仍可复用')
    // Reuse committed remote objects, but recheck current content and all remote sizes.
    return this.createBackup(state.target)
  }

  async pauseActiveWebBackup(): Promise<'cancelled' | 'committing' | undefined> {
    return this.cancelActiveWebBackup('paused')
  }

  async cancelActiveWebBackup(
    stopStatus: 'paused' | 'stopped' = 'stopped',
  ): Promise<'cancelled' | 'committing' | undefined> {
    const active = this.activeWebBackup
    if (!active) {
      const state = this.getWebBackupState()
      if (state && state.status !== 'completed')
        this.publishWebBackup({
          ...state,
          status: stopStatus,
          phase: '已停止；只有手动继续才会再次上传',
        })
      return undefined
    }
    if (active.committing) {
      active.stopRequested = true
      return 'committing'
    }
    active.stopStatus = stopStatus
    active.controller.abort(
      new DOMException('已取消本次云备份，已验证对象保留供重试', 'AbortError'),
    )
    taskCenter.update(active.operationId, {
      phase:
        stopStatus === 'paused' ? '正在暂停并等待当前步骤结束…' : '正在停止并等待当前步骤结束…',
      cancelable: false,
    })
    if (this.webBackupState)
      this.publishWebBackup(
        {
          ...this.webBackupState,
          phase:
            stopStatus === 'paused' ? '正在暂停，等待当前步骤结束…' : '正在停止，等待当前步骤结束…',
        },
        false,
      )
    await active.done
    return 'cancelled'
  }

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
  private readonly readCommunityAttachment?: (assetId: string) => Promise<Blob | undefined>
  private readonly readAlbumFile?: (id: string) => Promise<Blob>
  private nativeRestoreInFlight = false

  constructor(
    resourceService: ResourceService,
    categoryService: CategoryService,
    exportService: ExportService,
    restoreService: RestoreService,
    portableDataFactory?: (selection: CloudBackupContentSelection) => Promise<ArchivePortableData>,
    portableDataImporter?: (data: ArchivePortableData) => Promise<void>,
    prepareNativeBackup?: () => Promise<void>,
    readCommunityAttachment?: (assetId: string) => Promise<Blob | undefined>,
    readAlbumFile?: (id: string) => Promise<Blob>,
  ) {
    super()
    this.resourceService = resourceService
    this.categoryService = categoryService
    this.exportService = exportService
    this.restoreService = restoreService
    this.portableDataFactory = portableDataFactory
    this.portableDataImporter = portableDataImporter
    this.prepareNativeBackup = prepareNativeBackup
    this.readCommunityAttachment = readCommunityAttachment
    this.readAlbumFile = readAlbumFile
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
    id: string
    provider: CloudBackupProvider
    automatic: boolean
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
      id: latest.id,
      provider: latest.provider,
      automatic: latest.automatic === true,
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
    if (this.activeWebBackup) throw new Error('已有云备份正在执行，请先停止或等待完成')
    // Snapshot the selected target before the first await; editing another page cannot retarget it.
    config = JSON.parse(JSON.stringify(config ?? this.getActiveConfig())) as CloudBackupConfig
    let finish!: () => void
    const controller = new AbortController()
    const active = !isNativeCloudTransferAvailable()
      ? {
          controller,
          committing: false,
          stopRequested: false,
          done: new Promise<void>((resolve) => {
            finish = resolve
          }),
          operationId: '',
          stopStatus: undefined as 'paused' | 'stopped' | undefined,
        }
      : undefined
    if (active) {
      this.activeWebBackup = active
      active.operationId = taskCenter.start({
        name: '云备份',
        keepAlive: true,
        phase: '正在检查本机内容',
        cancelable: true,
        background: respectAutomaticConstraints,
        action: {
          label: '暂停备份',
          run: async () => {
            await this.pauseActiveWebBackup()
          },
        },
        cancel: async () => {
          await this.cancelActiveWebBackup()
        },
      })
    }
    const startWebBackup = () => {
      if (!active) return
      const target: CloudBackupConfig = {
        ...this.restoreTarget(config),
        retention: normalizeRetention(config.retention),
        contentSelection: normalizeContentSelection(config.contentSelection),
      }
      this.publishWebBackup({
        operationId: active.operationId,
        status: 'running',
        target,
        phase: '正在检查本机内容',
      })
      noticeCenter.push({
        id: 'web-cloud-backup',
        type: 'info',
        persistent: true,
        message: respectAutomaticConstraints
          ? '自动云备份正在后台执行，可离开此页面。'
          : '云备份正在执行，可在任务中心查看进度。',
        actions: [
          { label: '查看进度', run: () => this.openWebBackup() },
          {
            label: '暂停',
            run: async () => {
              await this.pauseActiveWebBackup()
            },
          },
          {
            label: '停止',
            run: async () => {
              await this.cancelActiveWebBackup()
            },
          },
        ],
      })
    }
    const signal = active?.controller.signal
    const releaseNativeSources = !active ? retainNativeResourceFiles() : undefined
    const progress = onProgress
    onProgress = (message) => {
      signal?.throwIfAborted()
      if (active) taskCenter.update(active.operationId, { phase: message })
      if (active && this.webBackupState)
        this.publishWebBackup({ ...this.webBackupState, phase: message }, false)
      progress?.(message)
    }
    const beginCommit = () => {
      signal?.throwIfAborted()
      if (active) {
        active.committing = true
        taskCenter.update(active.operationId, {
          phase: '正在提交最终清单，完成后停止',
          cancelable: false,
        })
      }
    }
    return this.withRelayWorkerTarget(
      config?.provider ?? this.getActiveConfig().provider,
      async () => {
        startWebBackup()
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
          for (const key of [
            'generatedImageAlbum',
            'frontendWorkshopProjects',
            'imageGeneration',
          ] as const)
            if (contentSelection[key] && portableData[key] === undefined)
              throw new Error(`所选创作资料 ${key} 没有接入备份，未提交云备份`)
          if (contentSelection.communitySources && !portableData.communitySources)
            throw new Error('Discord 社区内容没有接入备份数据，未提交云备份')
          if (contentSelection.personalResources?.secret && contentSelection.plaintextSecretCopy) {
            portableData.plaintextSecretCopies = await cloudPlainSecretCopies(
              resolved,
              this.resourceService,
              contentSelection.personalResources,
            )
          }
          if (
            typeof this.resourceService.listSummaries === 'function' &&
            typeof this.resourceService.listVersions === 'function'
          ) {
            onProgress?.('正在读取轻量索引，检查本机内容是否变化…')
            const index = await metrics.measure('prepareMs', () =>
              readStructuredBackupIndex(
                this.snapshotContext(signal),
                contentSelection.personalResources,
              ),
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
                signal,
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
                signal,
              ),
            )
            if (structured.descriptorUpdates?.length) {
              onProgress?.('正在保存可复用的分块描述，下次差量备份将跳过未变大文件扫描…')
              for (const update of structured.descriptorUpdates) {
                signal?.throwIfAborted()
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
                    signal,
                    beginCommit,
                  )
                : await this.uploadWebDavStructuredBackup(
                    resolved,
                    credential,
                    structured,
                    onProgress,
                    respectAutomaticConstraints,
                    signal,
                    beginCommit,
                  )
            let maintenanceWarning: string | undefined
            try {
              if (active?.stopRequested) {
                maintenanceWarning = '快照已提交；按停止选择跳过旧备份清理。'
              } else if (suspiciousDrop) {
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
              maintenanceWarning =
                error instanceof CloudBackupMaintenanceError
                  ? `新对象快照已上传成功；${error.message}`
                  : `新对象快照已上传成功，但旧备份维护未完成：${friendlyNetworkError(error, resolved.provider).message}`
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
          if (signal?.aborted) throw signal.reason
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
      .then(
        (item) => {
          if (active) {
            taskCenter.complete(active.operationId)
            this.finishWebBackup(
              'completed',
              item.unchanged
                ? '云端备份已核对，内容没有变化'
                : `备份完成${item.maintenanceWarning ? '；' + item.maintenanceWarning : ''}`,
            )
            void notifyWebCloudBackupResult(
              active.operationId,
              item.unchanged ? '内容未变化，已核对远端备份' : '所选内容已完成云端备份',
              true,
            )
          }
          return item
        },
        (error) => {
          if (active) {
            if (signal?.aborted) taskCenter.cancelled(active.operationId)
            else taskCenter.fail(active.operationId, error)
            const status = active.stopStatus ?? 'failed'
            const phase =
              status === 'paused'
                ? '备份已暂停；已完成对象保留'
                : status === 'stopped'
                  ? '备份已停止；已完成对象保留'
                  : error instanceof Error
                    ? error.message
                    : '云备份未完成'
            this.finishWebBackup(status, phase)
            if (status === 'failed')
              void notifyWebCloudBackupResult(active.operationId, phase, false)
          }
          throw error
        },
      )
      .finally(async () => {
        if (active && this.activeWebBackup === active) this.activeWebBackup = undefined
        if (active) finish()
        await releaseNativeSources?.()
      })
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
      const key = this.restorePreviewKey(item, resolved)
      while (this.restorePreview) {
        if (this.restorePreview.importing) throw new Error('已有云恢复正在导入')
        if (this.restorePreview.key === key && this.restorePreview.secret === credential)
          return this.restorePreview.pending
        await this.clearRestorePreview()
      }
      const preview: NonNullable<CloudBackupService['restorePreview']> = {
        key,
        secret: credential,
        pending: Promise.resolve({ resources: [], portableScopeIds: [] }),
      }
      this.restorePreview = preview
      preview.pending = (async () => {
        try {
          const contents = await readBackupRestoreContents(
            item,
            async () => {
              const snapshot =
                resolved.provider === 'github'
                  ? await this.readGitHubStructuredSnapshot(resolved, credential, item)
                  : await this.readWebDavStructuredSnapshot(resolved, credential, item.objectKey)
              preview.snapshot = snapshot
              return snapshot
            },
            () => this.downloadBackup(item),
            this.resourceService,
            this.categoryService,
            this.restoreService,
            (prepared) => {
              preview.prepared = prepared
            },
          )
          if (preview.discarded) throw new DOMException('已关闭云恢复选择', 'AbortError')
          return {
            resources: contents.resources,
            portableScopeIds: [
              ...portableRestoreScopeIds(contents.portableData),
              ...(contents.communitySources ? ['extra.communitySources' as const] : []),
            ],
          }
        } catch (error) {
          if (this.restorePreview === preview) this.restorePreview = undefined
          await preview.prepared?.dispose?.()
          preview.prepared = undefined
          await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
          throw friendlyNetworkError(error, resolved.provider)
        }
      })()
      return preview.pending
    })
  }

  async restoreBackup(
    item: CloudBackupItem,
    filterPortableData?: (data: ArchivePortableData) => Promise<ArchivePortableData>,
    resourceKeys?: readonly string[],
    includeGallery = true,
    portableScopeIds?: readonly BackupScopeId[],
    onCommitted?: (report: RestoreReport) => void,
    options: CloudRestoreOptions = {},
  ): Promise<number> {
    return this.withRelayWorkerTarget(this.getSnapshot().activeProvider, async () => {
      const preview = this.restorePreview
      if (preview) {
        const config = this.getActiveConfig()
        if (
          preview.key !== this.restorePreviewKey(item, config) ||
          preview.secret !== this.requireSecret(config.provider)
        ) {
          await this.clearRestorePreview()
          throw new Error('云端目标、凭据或备份已变化，请重新打开导入选择区')
        }
        await preview.pending
        if (preview.discarded) throw new Error('云恢复选择已关闭，请重新选择')
        if (preview.importing) throw new Error('已有云恢复正在导入')
        const selection = JSON.stringify([resourceKeys, includeGallery, portableScopeIds])
        if (preview.committed && preview.selection !== selection)
          throw new Error('资源已导入，请保持原选择继续处理附加数据，或关闭后重新选择')
        preview.selection = selection
        preview.importing = true
      }
      try {
        if (preview?.committed) {
          options.onPhase?.('extras')
          await this.finishRestore(
            preview.committed.report,
            preview.committed.portableData,
            filterPortableData,
            onCommitted,
          )
          return preview.committed.report.restoredResources
        }
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
              onCommitted,
              options,
            )
          } catch (error) {
            await this.invalidateCredentialOnConfirmed401(resolved.provider, error)
            throw friendlyNetworkError(error, resolved.provider)
          }
        }
        const fileName = item.archiveName ?? item.objectKey.replace(/\.srlbundle\.json$/i, '')
        const [resources, categories] = await Promise.all([
          this.resourceService.listResourceListSummaries(),
          this.categoryService.list(),
        ])
        const previous = preview?.prepared
        const prepared =
          (previous?.replan ? await previous.replan(resources, categories) : previous) ??
          (await this.restoreService.prepare(
            new File([await this.downloadBackup(item)], fileName, { type: 'application/zip' }),
            resources,
            categories,
            true,
          ))
        const sourceIds = new Map(
          previous?.sourceResourceIds?.map(([source, target]) => [target, source]),
        )
        const targetIds = new Map(prepared.sourceResourceIds)
        const selected = selectPreparedRestore(
          prepared,
          new Set(
            resourceKeys?.map((id) => targetIds.get(sourceIds.get(id) ?? id) ?? id) ??
              [...prepared.resources, ...(prepared.galleryOwners ?? [])].map((r) => r.id),
          ),
          includeGallery,
          portableScopeIds === undefined
            ? undefined
            : portableScopeIds.includes('extra.communitySources'),
          portableScopeIds === undefined || portableScopeIds.includes('extra.resourceAttachments'),
        )
        const report = await this.restoreService.restore(selected, undefined, options.onProgress)
        if (preview) preview.prepared = undefined
        options.onPhase?.('extras')
        await this.finishRestore(
          report,
          selectRestorePortableData(selected.portableData, portableScopeIds),
          filterPortableData,
          onCommitted,
        )
        return report.restoredResources
      } finally {
        if (preview) {
          preview.importing = false
          if (preview.completed) await this.clearRestorePreview()
        }
      }
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
    onCommitted?: (report: RestoreReport) => void,
    options: CloudRestoreOptions = {},
  ): Promise<number> {
    options.onPhase?.('manifest')
    const loadedSnapshot =
      this.restorePreview?.snapshot ??
      (config.provider === 'github'
        ? await this.readGitHubStructuredSnapshot(config, secret, item)
        : await this.readWebDavStructuredSnapshot(config, secret, item.objectKey))
    const snapshot = selectStructuredSnapshot(
      {
        ...loadedSnapshot,
        portableData: selectRestorePortableData(loadedSnapshot.portableData, portableScopeIds) ?? {
          version: 1,
        },
      },
      new Set(resourceKeys ?? loadedSnapshot.resources.map((r) => r.id)),
      includeGallery,
      portableScopeIds === undefined || portableScopeIds.includes('extra.resourceAttachments'),
    )
    const nativeRestore = isNativeCloudTransferAvailable() && snapshot.version >= 3
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
        if (prepared.portableData?.generatedImageAlbum?.length)
          await this.restoreService.restoreStructuredAlbum(
            prepared.portableData,
            (object) =>
              readNativeResourceObject(
                object.totalSha256,
                object.totalSize,
                'application/octet-stream',
              ),
            options.signal,
          )
        if (prepared.portableData?.communitySources?.attachments.length)
          await this.restoreService.restoreStructuredCommunityAttachments(
            prepared.portableData,
            (object) =>
              readNativeResourceObject(
                object.totalSha256,
                object.totalSize,
                'application/octet-stream',
              ),
            options.signal,
          )
        const report = await this.restoreService.restoreNative(prepared)
        options.onPhase?.('extras')
        await this.finishRestore(
          report,
          selectRestorePortableData(prepared.portableData, portableScopeIds),
          filterPortableData,
          onCommitted,
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
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
    const transfer = { signal, onTransfer: options.onTransfer }
    const providerReader =
      config.provider === 'github'
        ? await this.createGitHubObjectReader(config, secret, transfer)
        : this.createWebDavObjectReader(config, secret, transfer)
    let report: RestoreReport & { portableData?: ArchivePortableData }
    try {
      report = await this.restoreService.restoreStructured(
        snapshot,
        providerReader,
        existingResources,
        existingCategories,
        structuredSnapshotArchiveName(item.objectKey.split('/').at(-1) ?? item.objectKey),
        { ...options, signal, onFailure: (error) => controller.abort(error) },
      )
    } finally {
      controller.abort(new DOMException('云恢复准备已结束', 'AbortError'))
    }
    options.onPhase?.('extras')
    await this.finishRestore(
      report,
      selectRestorePortableData(report.portableData ?? snapshot.portableData, portableScopeIds),
      filterPortableData,
      onCommitted,
    )
    return report.restoredResources
  }

  private async finishRestore(
    report: RestoreReport,
    portableData: ArchivePortableData | undefined,
    filter: ((data: ArchivePortableData) => Promise<ArchivePortableData>) | undefined,
    onCommitted?: (report: RestoreReport) => void,
  ): Promise<void> {
    const preview = this.restorePreview
    if (preview) preview.committed = { report, portableData }
    await this.importPreparedPortableData(portableData, filter)
    if (preview) preview.completed = true
    onCommitted?.(report)
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
    if (this.activeWebBackup) return 'waiting'
    const web = !isNativeCloudTransferAvailable() ? this.getWebBackupState() : undefined
    if (web && web.status !== 'completed') {
      // Failure is reported when it happens; stopping is an explicit choice.
      // Keep both checkpoints for manual continuation on the backup page,
      // without resurrecting dismissed tasks/notices on startup or timer ticks.
      if (web.status === 'stopped' || web.status === 'failed') return 'waiting'
      if (!taskCenter.list().some((task) => task.operationId === web.operationId)) {
        taskCenter.start({
          operationId: web.operationId,
          name: '云备份',
          phase: web.phase,
          background: true,
        })
        taskCenter.cancelled(web.operationId)
        this.finishWebBackup(web.status, web.phase)
      }
      return 'waiting'
    }
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
    // A failed scheduled run is surfaced with an explicit continue action.
    // Do not let startup/visibility events silently restart it forever.
    if (status.lastError) return 'waiting'
    const now = Date.now()
    if (!isScheduleDue(normalizeSchedule(config.schedule), status.lastSuccessAt, now))
      return 'waiting'
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
    localStorage.setItem(STATUS_KEY, JSON.stringify({ ...current, ...update }))
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
    signal?: AbortSignal,
  ): Promise<CloudBackupItem | undefined> {
    return reuseUnchangedStructuredBackup(this.snapshotContext(signal), config, secret, objectKey)
  }

  private async buildStructuredBackup(
    portableData: ArchivePortableData,
    onProgress?: CloudBackupProgressCallback,
    personalResources?: PersonalResourceSelection,
    index?: StructuredBackupIndex,
    signal?: AbortSignal,
  ): Promise<CreatedStructuredSnapshot> {
    return buildStructuredBackup(
      this.snapshotContext(signal),
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

  private snapshotContext(signal?: AbortSignal): CloudBackupSnapshotOperationsContext {
    const readTransportState = () => this.transportState
    const transport = signal ? this.getTransportContext(signal) : undefined
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
      readCommunityAttachment: this.readCommunityAttachment,
      readAlbumFile: this.readAlbumFile,
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
      signal,
      ...(signal
        ? {
            getGitHubRelease: transport!.getGitHubRelease,
            listGitHubAssets: transport!.listGitHubAssets,
            readGitHubStructuredSnapshot: transport!.readGitHubStructuredSnapshot,
            readWebDavStructuredSnapshot: transport!.readWebDavStructuredSnapshot,
            readGitHubPartInventory: transport!.readGitHubPartInventory,
            listWebDavObjects: transport!.listWebDavObjects,
            readGitHubBundleManifest: transport!.readGitHubBundleManifest,
            readWebDavBundleManifest: transport!.readWebDavBundleManifest,
            githubFetch: transport!.githubFetch,
          }
        : {}),
    }
  }
}
