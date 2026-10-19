import { isResourceOwnedFile } from '../types/ResourceAttachment'
import { withWebBackgroundAudio } from '../services/WebBackgroundKeepAlive'
import {
  formatMetricDuration,
  formatMetricBytes,
  metricSpeed,
  formatBytes,
  formatTime as formatBackupTime,
} from '../utils/CloudBackupFormatting'
import { cloudBackupSelectionModel } from './UseCloudBackupDrafts'
import {
  useCloudBackupDrafts,
  KOOFR_URL,
  DEFAULT_SCHEDULE,
  DEFAULT_PROTECTION,
  DEFAULT_CONTENT_SELECTION,
} from './UseCloudBackupDrafts'

import { requestSecretPassword } from './UseSecretPasswordPrompt'

import {
  readPlainSecretExportGrant,
  savePlainSecretExportGrant,
  clearPlainSecretExportGrant,
  plaintextSecretCopies,
} from '../services/PersonalResourceBackup'

import { resourceService } from '../core/AppContainer'

import { Capacitor } from '@capacitor/core'

import type { EmitFn } from 'vue'

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { withAbort } from '../utils/Abortable'
import type { ArchiveReadFailure } from '../services/ArchiveZipWriter'

import { confirmAction } from '../composables/UseConfirmDialog'

import { cloudBackupService } from '../core/AppContainer'

import { noticeCenter } from '../core/NoticeCenter'

import type { ArchivePortableData } from '../types/Backup'
import type { ArchiveRestoreProgress } from '../storage/ArchiveStorageAdapter'

import type {
  CloudBackupConfig,
  CloudBackupContentSelection,
  CloudBackupIntervalUnit,
  CloudBackupItem,
  CloudBackupProtection,
  CloudBackupProvider,
  CloudBackupSchedule,
  GitHubBackupConfig,
} from '../types/CloudBackup'

import type { GitHubRepositoryInspection } from '../services/CloudBackupService'

import { type Category, type ResourceSummary } from '../types/Resource'

import {
  BACKUP_SCOPE_REGISTRY,
  resourceRestoreScopeIds,
  toCloudContentSelection,
  type BackupScopeId,
  type BackupSelectionTreeState,
} from '../services/BackupScopeRegistry'

import { downloadBlob } from '../utils/LibraryFormatting'
import type { StructuredRestoreFailure } from '../types/Backup'
import type { CloudDownloadProgress } from '../services/CloudBackupTransport'

import { taskCenter } from '../core/TaskCenter'

import { summarizeRestoreSelection } from '../utils/RestoreIdentity'

import { requestNativeNotifications } from '../core/NativeSecurity'
import {
  enableWebInboxNotifications,
  webInboxNotificationStatus,
} from '../services/WebDiscordInboxNotifications'

export type CloudBackupCenterProps = {
  resourceCount: number
  resources: ResourceSummary[]
  categories?: Category[]
}

export type CloudBackupCenterEvents = {
  back: []
  'library-changed': [
    changes?: Pick<import('../types/Backup').RestoreReport, 'resourceIds' | 'categoriesChanged'>,
  ]
}

export function useCloudBackupCenter(
  emit: EmitFn<CloudBackupCenterEvents>,
  resources: readonly ResourceSummary[] | (() => readonly ResourceSummary[]) = [],
) {
  const currentResources = () => (typeof resources === 'function' ? resources() : resources)
  const nativeTransport = Capacitor.isNativePlatform()
  const androidNativeTransport =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

  const snapshot = ref(cloudBackupService.getSnapshot())

  const { activeProvider, github, webdav } = useCloudBackupDrafts(snapshot)
  const githubToken = ref('')

  const githubRepositoryInspection = ref<
    (GitHubRepositoryInspection & { target: string }) | undefined
  >()

  const communityBackupConfirmedTarget = ref<Record<CloudBackupProvider, string | undefined>>({
    github: undefined,
    webdav: undefined,
  })

  const webdavPassword = ref('')

  const editingCredential = ref<Record<CloudBackupProvider, boolean>>({
    github: snapshot.value.credentials.github !== 'valid',
    webdav: snapshot.value.credentials.webdav !== 'valid',
  })

  const credentialBackupConfirmedTarget = ref<Record<CloudBackupProvider, string | undefined>>({
    github:
      snapshot.value.github?.contentSelection?.credentials === true
        ? credentialBackupTarget(snapshot.value.github)
        : undefined,
    webdav:
      snapshot.value.webdav?.contentSelection?.credentials === true
        ? credentialBackupTarget(snapshot.value.webdav)
        : undefined,
  })

  const backups = ref<CloudBackupItem[]>([])

  const restorePicker = ref<{
    item: CloudBackupItem
    resources: ResourceSummary[]
    scopeIds?: BackupScopeId[]
    target?: string
  }>()
  const selectedRestoreKeys = ref(new Set<string>())
  const selectedRestoreScopes = ref<BackupScopeId[]>([])
  const restoreResourceCount = computed(
    () => restorePicker.value?.resources.filter((r) => !isResourceOwnedFile(r)).length ?? 0,
  )
  const restoreScopeIds = computed(() => restorePicker.value?.scopeIds ?? [])
  const hasRestoreSelection = computed(
    () =>
      selectedRestoreKeys.value.size > 0 ||
      selectedRestoreScopes.value.some((scope) => scope.startsWith('extra.')),
  )
  const restoreScopeModel = computed({
    get: () => ({
      resourceIds: [...selectedRestoreKeys.value],
      scopeIds: selectedRestoreScopes.value,
    }),
    set: (value: { resourceIds: string[]; scopeIds: BackupScopeId[] }) => {
      selectedRestoreKeys.value = new Set(value.resourceIds)
      selectedRestoreScopes.value = value.scopeIds
    },
  })
  const restorePreview = computed(() =>
    summarizeRestoreSelection(
      [...currentResources()],
      (restorePicker.value?.resources ?? []).filter((resource) =>
        selectedRestoreKeys.value.has(resource.id),
      ),
    ),
  )
  const pendingRestores = ref<Awaited<ReturnType<typeof cloudBackupService.pendingNativeRestores>>>(
    [],
  )

  const webBackup = ref(nativeTransport ? undefined : cloudBackupService.getWebBackupState())
  const localAction = ref('')
  const busyAction = computed({
    get: () => localAction.value || (webBackup.value?.status === 'running' ? 'backup' : ''),
    set: (value: string) => {
      localAction.value = value
    },
  })
  let removeWebBackupListener: (() => void) | undefined
  let backupStartGeneration = 0
  const webNotificationPermission = ref(webInboxNotificationStatus())
  async function enableBackupNotifications(): Promise<void> {
    try {
      webNotificationPermission.value = await enableWebInboxNotifications()
    } catch (error) {
      message.value = error instanceof Error ? error.message : '通知授权失败'
    }
  }
  async function pauseWebBackup(): Promise<void> {
    backupStartGeneration++
    const result = await cloudBackupService.pauseActiveWebBackup()
    if (result === 'committing') message.value = '最终清单已开始提交，完成后结束。'
  }
  async function resumeWebBackup(): Promise<void> {
    await runCloudAction('backup', async () => {
      try {
        await cloudBackupService.resumeWebBackup()
      } catch (error) {
        message.value = error instanceof Error ? error.message : '继续备份失败'
      } finally {
        refreshSnapshot()
      }
    })
  }
  let disposed = false
  let nativeStateGeneration = 0

  async function runCloudAction<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    if (busyAction.value) return
    if (nativeBackupActive.value && name.startsWith('restore:')) {
      message.value = '云备份仍在进行，请完成后再恢复。'
      return
    }
    if (name.startsWith('download:')) downloadProgress.value = undefined
    busyAction.value = name
    try {
      const title =
        name === 'backup'
          ? '云备份'
          : name.startsWith('restore:')
            ? '导入云备份'
            : name.startsWith('download:')
              ? '下载云备份'
              : undefined
      return await (title ? withWebBackgroundAudio(title, run)() : run())
    } finally {
      busyAction.value = ''
    }
  }

  async function resumePendingRestore(id: string): Promise<void> {
    if (disposed) {
      window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'backup' } }))
      return
    }
    await runCloudAction('restore:' + id, async () => {
      try {
        const records = await cloudBackupService.pendingNativeRestores()
        if (disposed) return
        const record = records.find((pending) => pending.id === id && pending.restore)
        pendingRestores.value = records.filter((pending) => pending.restore)
        if (!record) {
          noticeCenter.dismiss('cloud-restore:' + id)
          message.value = '此恢复任务已完成或已不存在。'
          return
        }
        const count = await cloudBackupService.resumeNativeRestore(
          record,
          confirmPortableCredentialImport,
        )
        if (!disposed) {
          emit('library-changed')
          message.value = '云恢复已继续完成，加入 ' + count + ' 项新资源'
          pendingRestores.value = pendingRestores.value.filter((pending) => pending.id !== id)
        }
        noticeCenter.dismiss('cloud-restore:' + id)
      } catch (error) {
        if (!disposed) message.value = error instanceof Error ? error.message : '继续云恢复失败'
      }
    })
  }

  const nativeBackupActive = ref(false)

  const message = ref('')
  const restoreProgress = ref<ArchiveRestoreProgress>()
  const restorePhase = ref<'manifest' | 'prepare' | 'commit' | 'extras'>('manifest')
  const restoreOperation = ref('')
  const restoreFailures = ref<StructuredRestoreFailure[]>([])
  const downloadProgress = ref<CloudDownloadProgress>()
  const downloadOperation = ref('')
  const downloadFailures = shallowRef<readonly ArchiveReadFailure[]>([])
  let continueDownload: (() => void) | undefined
  let downloadController: AbortController | undefined
  const stopDownload = () => downloadOperation.value && taskCenter.cancel(downloadOperation.value)
  const retryDownloadFailures = () => {
    if (disposed || !continueDownload || downloadController?.signal.aborted) return
    const resume = continueDownload
    continueDownload = undefined
    downloadFailures.value = []
    taskCenter.setAction(downloadOperation.value)
    taskCenter.update(downloadOperation.value, { phase: '正在补齐失败项并继续生成 ZIP' })
    message.value = '正在重试失败项，已生成的 ZIP 内容保持不变…'
    resume()
  }
  let restoreController: AbortController | undefined
  const stopRestore = () => restoreOperation.value && taskCenter.cancel(restoreOperation.value)

  const now = ref(Date.now())

  const tutorialPreview = ref<{ source: string; alt: string }>()

  let clock: number | undefined

  let nativeJobPoll: number | undefined

  const activeConfig = computed<CloudBackupConfig>(() =>
    activeProvider.value === 'github' ? github.value : webdav.value,
  )

  const githubTarget = computed(
    () =>
      `${github.value.owner.trim().toLowerCase()}/${github.value.repository.trim().toLowerCase()}`,
  )

  watch(githubToken, (value) => {
    if (!value) return
    githubRepositoryInspection.value = undefined
    cloudBackupService.invalidateGitHubPrivacyVerification(githubTarget.value)
  })

  const githubPrivateVerified = computed(
    () =>
      githubRepositoryInspection.value?.target === githubTarget.value &&
      githubRepositoryInspection.value?.isPrivate === true,
  )

  const communitySourcesEnabled = computed(
    () => activeProvider.value === 'webdav' || githubPrivateVerified.value,
  )

  const communitySourcesDisabledReason = computed(() => {
    if (activeProvider.value !== 'github') return undefined
    if (
      githubRepositoryInspection.value?.target === githubTarget.value &&
      !githubRepositoryInspection.value.isPrivate
    )
      return '目标是公开仓库，已阻止上传'
    return '先测试连接并确认目标为私有仓库'
  })

  const activeProtection = computed<CloudBackupProtection>(
    () => activeConfig.value.protection ?? DEFAULT_PROTECTION,
  )

  const activeContentSelection = computed<CloudBackupContentSelection>(
    () => activeConfig.value.contentSelection ?? DEFAULT_CONTENT_SELECTION,
  )

  function selectionModelForConfig(config: CloudBackupConfig): BackupSelectionTreeState {
    return cloudBackupSelectionModel(config, currentResources())
  }

  const cloudScopeModel = ref<{
    resourceIds: string[]
    scopeIds: BackupScopeId[]
  }>(
    (() => {
      const model = selectionModelForConfig(activeConfig.value)
      return { resourceIds: [...model.resourceIds], scopeIds: [...model.scopes] }
    })(),
  )

  function setCloudScopeModel(next: { resourceIds: string[]; scopeIds: BackupScopeId[] }): void {
    cloudScopeModel.value = next
    const selectedIds = new Set(next.resourceIds)
    const allResourcesSelected =
      currentResources().length > 0 &&
      currentResources().every((resource) => selectedIds.has(resource.id))
    activeConfig.value.contentSelection = {
      ...activeContentSelection.value,
      ...toCloudContentSelection({
        resourceIds: selectedIds,
        scopes: new Set(next.scopeIds),
      }),
      resourceIds: allResourcesSelected ? undefined : [...selectedIds],
    }
  }

  const personalBackupSelection = computed(() => {
    const selection = activeContentSelection.value
    selection.personalResources ??= { extraStory: true, pocketPhone: true, secret: false }
    return selection.personalResources
  })

  const backupContentSummary = computed(() => {
    const labels: string[] = []
    if (personalBackupSelection.value.extraStory) labels.push('番外')
    if (personalBackupSelection.value.pocketPhone) labels.push('小手机')
    if (personalBackupSelection.value.secret) labels.push('加密密钥')
    if (activeContentSelection.value.plaintextSecretCopy) labels.push('明文密钥副本')
    if (activeContentSelection.value.credentials) labels.push('API 配置与本机密钥')
    if (activeContentSelection.value.aiTaggingState) labels.push('AI 标签草稿')
    if (activeContentSelection.value.stitchWork) labels.push('预设缝合草稿')
    if (activeContentSelection.value.generatedImageAlbum) labels.push('生图相册')
    if (activeContentSelection.value.imageGeneration) labels.push('生图配置与草稿')
    if (activeContentSelection.value.frontendWorkshopProjects) labels.push('前端项目与创作记录')
    if (activeContentSelection.value.externalApps) labels.push('第三方 APP 数据')
    if (activeContentSelection.value.chatReader) labels.push('读了么阅读数据')
    if (activeContentSelection.value.assistantData) labels.push('蒜惹菈本地资料')
    if (activeContentSelection.value.resourceAttachments) labels.push('资源附件')
    if (activeContentSelection.value.resourceGallery) labels.push('资源图库')
    if (activeContentSelection.value.communitySources) labels.push('Discord 社区内容')
    if (activeContentSelection.value.appearance) labels.push('外观与 CSS')
    if (activeContentSelection.value.generalPreferences) labels.push('常用偏好')
    if (activeContentSelection.value.characterDraw) labels.push('抽了么记录')
    if (activeContentSelection.value.cloudBackup) labels.push('云备份配置')
    return labels.length ? `额外携带：${labels.join('、')}` : '额外携带：无'
  })

  const activeSecret = computed(() =>
    activeProvider.value === 'github' ? githubToken.value : webdavPassword.value,
  )

  const status = computed(() => snapshot.value.status)

  const lastMetrics = computed(() => status.value.lastMetrics)

  const excessBackupCount = computed(() =>
    Math.max(0, backups.value.length - Math.max(1, Number(activeConfig.value.retention) || 1)),
  )

  const excessBackupBytes = computed(() => {
    const keep = Math.max(1, Number(activeConfig.value.retention) || 1)
    return backups.value.slice(keep).reduce((total, item) => total + item.size, 0)
  })

  function formatTime(value?: number): string {
    return formatBackupTime(value, now.value)
  }
  function refreshSnapshot(): void {
    snapshot.value = cloudBackupService.getSnapshot()
  }

  function validateConfig(config: CloudBackupConfig): string {
    if (config.provider === 'github') {
      if (!config.owner.trim() || !config.repository.trim()) return '请填写 GitHub 用户名和仓库名'
    } else {
      if (!/^https:\/\//i.test(config.baseUrl.trim())) return 'WebDAV 地址必须使用 HTTPS'
      if (!config.username.trim()) return '请填写 Koofr 注册邮箱'
    }
    return ''
  }

  function credentialBackupTarget(config: CloudBackupConfig): string {
    if (config.provider === 'github') {
      return JSON.stringify([
        config.provider,
        config.owner.trim().toLowerCase(),
        config.repository.trim().toLowerCase(),
      ])
    }
    return JSON.stringify([
      config.provider,
      config.baseUrl.trim().replace(/\/+$/, ''),
      config.folder.trim().replace(/^\/+|\/+$/g, ''),
      config.username.trim().toLowerCase(),
    ])
  }

  function credentialBackupTargetLabel(config: CloudBackupConfig): string {
    return config.provider === 'github'
      ? `GitHub 仓库 ${config.owner.trim()}/${config.repository.trim()}`
      : `Koofr 账号 ${config.username.trim()} 的 /${config.folder.trim().replace(/^\/+/, '')} 目录`
  }

  async function ensureCommunitySourcesSafe(): Promise<boolean> {
    const target = credentialBackupTarget(activeConfig.value)
    const githubConfig = activeConfig.value as GitHubBackupConfig
    if (activeProvider.value === 'github') {
      try {
        const inspection =
          githubRepositoryInspection.value?.target === githubTarget.value
            ? githubRepositoryInspection.value
            : await cloudBackupService
                .inspectGitHubRepository(githubConfig, activeSecret.value || undefined)
                .then((value) => {
                  const next = { ...value, target: githubTarget.value }
                  githubRepositoryInspection.value = next
                  return next
                })
        if (!inspection.isPrivate) {
          message.value = `GitHub 仓库 ${inspection.fullName} 是公开仓库，已阻止上传 Discord 社区内容。请先把仓库改为 Private，再重新测试连接。`
          return false
        }
      } catch (error) {
        message.value = error instanceof Error ? error.message : '无法确认 GitHub 仓库是否私有'
        return false
      }
    }
    if (communityBackupConfirmedTarget.value[activeProvider.value] !== target) {
      const confirmed = await confirmAction({
        title: '确认备份 Discord 社区内容',
        message:
          activeProvider.value === 'github'
            ? `社区帖子、评论、作者信息和已保存附件可能包含其他人的个人信息。当前目标已确认是私有 GitHub 仓库 ${githubConfig.owner}/${githubConfig.repository}；请确认你有权保存并迁移这些内容。`
            : `社区帖子、评论、作者信息和已保存附件可能包含其他人的个人信息。Koofr 目录是否公开分享无法由应用完全判断，请确认当前目录未公开共享，并确认你有权保存并迁移这些内容。`,
        confirmLabel: '确认并允许备份',
        danger: true,
      })
      if (!confirmed) return false
      communityBackupConfirmedTarget.value[activeProvider.value] = target
    }
    return true
  }

  async function saveConfig(requireSecret = false): Promise<boolean> {
    const error = validateConfig(activeConfig.value)
    if (error) {
      message.value = error
      return false
    }
    const hasCredential = cloudBackupService.hasCredential(activeProvider.value)
    if (requireSecret && !activeSecret.value && !hasCredential) {
      message.value =
        activeProvider.value === 'github' ? '请填写 GitHub 令牌' : '请填写 Koofr 应用密码'
      return false
    }
    if (activeContentSelection.value.communitySources && !(await ensureCommunitySourcesSafe()))
      return false
    const credentialTarget = activeContentSelection.value.credentials
      ? credentialBackupTarget(activeConfig.value)
      : undefined
    if (
      credentialTarget &&
      credentialBackupConfirmedTarget.value[activeProvider.value] !== credentialTarget
    ) {
      const confirmed = await confirmAction({
        title: '将凭据写入云备份',
        message: `后续备份会把主 API、生图、图床、Discord 及云备份凭据写入 ${credentialBackupTargetLabel(activeConfig.value)}。备份本身未额外加密，拥有远端读取权限的人可使用这些密钥。确认保存这个选择吗？`,
        confirmLabel: '允许携带凭据',
        danger: true,
      })
      if (!confirmed) return false
    }
    try {
      if (
        activeContentSelection.value.plaintextSecretCopy &&
        personalBackupSelection.value.secret
      ) {
        if (!(await readPlainSecretExportGrant(activeConfig.value))) {
          if (
            !(await confirmAction({
              title: '允许明文密钥副本',
              message: `后续备份会将所选密钥卡的私密字段明文写入 ${credentialBackupTargetLabel(activeConfig.value)}。远端读取者可以看到这些值；本机将受保护保存此目标的解锁授权以便自动备份。`,
              confirmLabel: '允许此目标携带明文副本',
              danger: true,
            }))
          )
            return false
          const password = await requestSecretPassword(
            '输入查看密码。授权仅用于当前云备份目标；关闭明文副本会清除该目标的授权。',
          )
          if (!password) return false
          const secrets = []
          for (const summary of await resourceService.listSummaries()) {
            if (summary.type !== 'secret' || summary.metadata.cloudBackupExcluded === true) continue
            const resource = await resourceService.get(summary.id)
            if (resource) secrets.push(resource)
          }
          await plaintextSecretCopies(secrets, password)
          await savePlainSecretExportGrant(activeConfig.value, password)
        }
      } else await clearPlainSecretExportGrant(activeConfig.value)
      snapshot.value = await cloudBackupService.saveConfig(
        activeConfig.value,
        activeSecret.value,
        true,
      )
      credentialBackupConfirmedTarget.value[activeProvider.value] = credentialTarget
      if (activeSecret.value) {
        if (activeProvider.value === 'github') githubToken.value = ''
        else webdavPassword.value = ''
        editingCredential.value[activeProvider.value] = false
      }
      message.value = nativeTransport
        ? '配置已保存；凭据由 Android Keystore 保护并会自动使用'
        : '配置已保存；凭据已由本机浏览器设备密钥加密并会自动使用'
      return true
    } catch (error) {
      message.value = error instanceof Error ? error.message : '配置保存失败'
      refreshSnapshot()
      return false
    }
  }

  async function testConnection(): Promise<void> {
    busyAction.value = 'test'
    message.value = ''
    try {
      if (activeSecret.value) {
        if (!(await saveConfig(true))) return
        if (activeProvider.value === 'github') {
          const githubConfig = activeConfig.value as GitHubBackupConfig
          const inspection =
            githubRepositoryInspection.value?.target === githubTarget.value
              ? githubRepositoryInspection.value
              : await cloudBackupService.inspectGitHubRepository(githubConfig)
          githubRepositoryInspection.value = { ...inspection, target: githubTarget.value }
          message.value = `已连接 ${inspection.fullName}${inspection.isPrivate ? '（私有仓库）' : '（公开仓库，社区内容将被阻止）'}；新凭据已原子替换并正在使用`
        } else message.value = '连接成功；新凭据已原子替换并正在使用'
      } else {
        if (!(await saveConfig(true))) return
        if (activeProvider.value === 'github') {
          const inspection = await cloudBackupService.inspectGitHubRepository(
            activeConfig.value as GitHubBackupConfig,
          )
          githubRepositoryInspection.value = { ...inspection, target: githubTarget.value }
          message.value = `已连接 ${inspection.fullName}${inspection.isPrivate ? '（私有仓库）' : '（公开仓库，社区内容将被阻止）'}`
        } else message.value = await cloudBackupService.testConnection(activeConfig.value)
      }
    } catch (error) {
      message.value = error instanceof Error ? error.message : '连接测试失败'
    } finally {
      busyAction.value = ''
      refreshSnapshot()
    }
  }

  function refillCredential(provider: CloudBackupProvider): void {
    editingCredential.value[provider] = true
    if (provider === 'github') {
      githubToken.value = ''
      githubRepositoryInspection.value = undefined
      cloudBackupService.invalidateGitHubPrivacyVerification(githubTarget.value)
    } else webdavPassword.value = ''
  }

  function cancelCredentialRefill(provider: CloudBackupProvider): void {
    editingCredential.value[provider] = false
    if (provider === 'github') githubToken.value = ''
    else webdavPassword.value = ''
  }

  async function createBackup(): Promise<void> {
    const startGeneration = ++backupStartGeneration
    if (androidNativeTransport && (await cloudBackupService.hasActiveNativeBackup())) {
      nativeBackupActive.value = true
      message.value =
        'Android 已有同一云备份任务在继续传输；已恢复当前状态显示，不会重复创建上传任务。'
      return
    }
    if (!(await saveConfig(true))) return
    if (startGeneration !== backupStartGeneration) return
    let notificationWarning = ''
    if (androidNativeTransport) {
      const granted = await requestNativeNotifications().catch(() => false)
      if (!granted) {
        notificationWarning = '系统通知未开启，后台完成提醒可能不会出现在通知栏。'
      }
    }
    if (startGeneration !== backupStartGeneration) return
    busyAction.value = 'backup'
    message.value = '正在检查本机变化与远端对象，可离开此页面并在任务中心查看进度…'
    try {
      const item = await cloudBackupService.createBackup(
        activeConfig.value,
        activeSecret.value || undefined,
        (progress) => {
          message.value = progress
        },
      )
      const resultMessage = item.unchanged
        ? `本机内容与上次成功备份完全一致，已核对远端清单，无需重新上传：${item.objectKey}`
        : item.maintenanceWarning
          ? `备份成功：${item.objectKey}\n${item.maintenanceWarning}`
          : `备份成功：${item.objectKey}`
      message.value = [resultMessage, notificationWarning].filter(Boolean).join('\n')
      backups.value = [
        item,
        ...backups.value.filter((backup) => backup.objectKey !== item.objectKey),
      ]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, activeConfig.value.retention)
      refreshSnapshot()
    } catch (error) {
      message.value = [error instanceof Error ? error.message : '云端备份失败', notificationWarning]
        .filter(Boolean)
        .join('\n')
    } finally {
      busyAction.value = ''
      refreshSnapshot()
    }
  }

  async function cancelNativeBackup(): Promise<void> {
    backupStartGeneration++
    if (!androidNativeTransport) {
      message.value = '正在停止云备份，等待当前步骤结束…'
      const result = await cloudBackupService.cancelActiveWebBackup()
      message.value =
        result === 'committing'
          ? '最终清单已开始提交，当前步骤完成后结束；旧备份保留。'
          : result === 'cancelled'
            ? '已停止本次备份；已验证对象保留供再次手动备份使用。'
            : '当前没有可停止的备份任务。'
      return
    }
    const result = await cloudBackupService.cancelActiveNativeBackup()
    if (result === 'committing') {
      message.value =
        '最终清单已开始提交，任务将完成后再更新状态；为避免产生不完整快照，当前不能撤销此提交。'
      return
    }
    if (result !== 'cancelled') return
    nativeBackupActive.value = false
    message.value = 'Android 已取消本次备份；最终快照清单未提交，旧备份不会受影响'
  }

  async function refreshNativeBackupState(): Promise<void> {
    if (!nativeTransport || busyAction.value || disposed) return
    const generation = ++nativeStateGeneration
    const active = await cloudBackupService.getActiveNativeBackupProgress()
    if (generation !== nativeStateGeneration || busyAction.value || disposed) return
    nativeBackupActive.value = Boolean(active)
    if (active) {
      const operationId = `native-cloud-backup:${active.id}`
      if (!taskCenter.list().some((task) => task.operationId === operationId)) {
        taskCenter.start({
          operationId,
          name: active.provider === 'github' ? 'GitHub 云备份' : 'Koofr 云备份',
          phase: '已恢复 Android 上传任务',
          background: active.automatic,
        })
      }
      taskCenter.update(operationId, {
        phase:
          active.status === 'staging'
            ? 'Android 正在暂存备份对象'
            : active.status === 'committing'
              ? 'Android 正在提交最终清单'
              : active.automatic
                ? '自动备份正在后台上传'
                : '正在上传本次备份',
        progress: active.total > 0 ? active.completed / active.total : undefined,
        itemProgress: { completed: active.completed, total: active.total },
      })
      if (active.totalBytes > 0 || active.uploadedBytes > 0) {
        taskCenter.updateTransfer(operationId, {
          transferredBytes: active.uploadedBytes,
          totalBytes: active.totalBytes,
        })
      }
    }
    if (!active && !busyAction.value) {
      const restore = await cloudBackupService.getNativeRestoreProgress()
      if (generation !== nativeStateGeneration || busyAction.value || disposed) return
      if (restore && ['queued', 'running'].includes(restore.status)) {
        message.value = `Android 正在继续同一云恢复任务：${restore.completed}/${restore.total}；切回前台不会重新下载已完成的对象。`
      }
    }
    if (active) {
      const percent = active.total
        ? Math.min(100, Math.round((active.completed / active.total) * 100))
        : 0
      const bytes =
        active.totalBytes > 0
          ? ` · ${formatBytes(active.uploadedBytes)} / ${formatBytes(active.totalBytes)}`
          : ''
      const speed =
        active.uploadedBytes > 0 && active.networkMs > 0
          ? ` · ${formatBytes(active.uploadedBytes / (active.networkMs / 1000))}/s`
          : ''
      message.value =
        active.status === 'staging'
          ? `正在恢复 Android 备份状态：已暂存 ${active.completed}/${active.total}${bytes}`
          : active.status === 'committing'
            ? `正在提交最终清单；后台任务即将完成${bytes}`
            : `${active.automatic ? '自动备份在后台继续上传' : '本次备份继续上传中'}：${active.completed}/${active.total}（${percent}%）${bytes}${speed}`
      return
    }
    await cloudBackupService.reconcileNativeJob()
    if (generation !== nativeStateGeneration || busyAction.value || disposed) return
    refreshSnapshot()
  }

  async function loadBackups(): Promise<void> {
    if (!(await saveConfig(true))) return
    busyAction.value = 'list'
    try {
      await closeRestorePicker()
      const warnings: string[] = []
      backups.value = await cloudBackupService.listBackups(
        activeConfig.value,
        activeSecret.value || undefined,
        (progress) => {
          message.value = progress
        },
        (warning) => warnings.push(warning),
      )
      listedTarget = restoreTarget()
      message.value = backups.value.length
        ? `已读取 ${backups.value.length} 个云端备份${
            excessBackupCount.value
              ? `；比当前保留份数多 ${excessBackupCount.value} 个，可点击“清理到 ${activeConfig.value.retention} 份”`
              : ''
          }`
        : '云端暂无备份'
      if (warnings.length) message.value += `\n${warnings.join('\n')}`
    } catch (error) {
      message.value = error instanceof Error ? error.message : '云端列表读取失败'
    } finally {
      busyAction.value = ''
    }
  }

  async function cleanupRetention(): Promise<void> {
    if (!(await saveConfig(true))) return
    if (
      !(await confirmAction({
        title: '清理旧云备份',
        message: `预计最多释放 ${formatMetricBytes(excessBackupBytes.value)}（旧快照清单）。只会删除名称和 SHA-256 格式均可验证、且未被任何当前或历史快照引用的旧分块；用途无法证明的对象一律保留。确定继续吗？`,
        confirmLabel: `清理到 ${activeConfig.value.retention} 份`,
        danger: true,
      }))
    )
      return
    busyAction.value = 'prune'
    message.value = '正在核对快照引用并清理旧备份…'
    try {
      const result = await cloudBackupService.enforceRetention(
        activeConfig.value,
        activeSecret.value || undefined,
      )
      await loadBackups()
      message.value = result.removed
        ? `已删除 ${result.removed} 份旧备份，现在最多保留 ${result.remaining} 份`
        : `无需清理，当前未超过 ${result.remaining} 份`
    } catch (error) {
      message.value = error instanceof Error ? error.message : '旧备份清理失败'
    } finally {
      busyAction.value = ''
    }
  }

  let listedTarget: string | undefined
  function restoreTarget(): string {
    const config = activeConfig.value
    return JSON.stringify(
      config.provider === 'github'
        ? [
            config.provider,
            config.owner.trim().toLowerCase(),
            config.repository.trim().toLowerCase(),
          ]
        : [
            config.provider,
            config.baseUrl.trim().replace(/\/+$/u, ''),
            config.folder,
            config.username,
          ],
    )
  }

  async function restore(item: CloudBackupItem, retry = false): Promise<void> {
    const retryFailures = retry ? [...restoreFailures.value] : undefined
    const target = restoreTarget()
    if (
      (listedTarget && listedTarget !== target) ||
      (restorePicker.value?.target && restorePicker.value.target !== target)
    ) {
      await closeRestorePicker()
      backups.value = []
      message.value = '云端目标已变化，请先刷新当前目标的备份列表'
      return
    }
    if (!restorePicker.value || restorePicker.value.item.id !== item.id) {
      if (!(await saveConfig(true))) return
      busyAction.value = `restore:${item.id}`
      message.value = '正在读取云端资源清单…'
      try {
        const contents = await cloudBackupService.listBackupRestoreContents(item)
        const { resources, portableScopeIds } = contents
        const scopeIds = [...new Set([...resourceRestoreScopeIds(resources), ...portableScopeIds])]
        if (disposed || target !== restoreTarget()) {
          await closeRestorePicker()
          return
        }
        restorePicker.value = { item, resources, scopeIds, target }
        selectedRestoreKeys.value = new Set(
          resources.filter((r) => !isResourceOwnedFile(r)).map((resource) => resource.id),
        )
        selectedRestoreScopes.value = scopeIds.filter(
          (id) => !BACKUP_SCOPE_REGISTRY.find((scope) => scope.id === id)?.sensitive,
        )
        message.value = scopeIds.length
          ? '请选择要导入的资源和附加数据；历史版本会随所属资源一起导入。'
          : '这个备份没有可导入的内容'
      } catch (error) {
        message.value = error instanceof Error ? error.message : '读取云端资源清单失败'
      } finally {
        busyAction.value = ''
      }
      return
    }
    const selectedKeys = [...selectedRestoreKeys.value]
    if (!hasRestoreSelection.value) {
      message.value = '请至少选择一项资源或附加数据'
      return
    }
    if (
      !retry &&
      !(await confirmAction({
        title: '从云端导入',
        message: `将从“${item.objectKey}”导入选中的 ${selectedKeys.length} 项资源和勾选的附加数据吗？预计新增 ${restorePreview.value.added} 项，已有内容 ${restorePreview.value.skipped} 项；${restorePreview.value.conflicts} 项 ID 冲突将保留两份。历史另行合并，实际以导入结果为准；不会清空现有资源。${selectedRestoreScopes.value.includes('extra.credentials') ? '该备份可能包含你明确选择迁移的 API 凭据，恢复后会写入本机受保护存储。' : ''}`,
        confirmLabel: '导入',
      }))
    )
      return
    if (disposed || target !== restoreTarget()) return
    if (!(await saveConfig(true))) return
    busyAction.value = `restore:${item.id}`
    nativeStateGeneration++
    message.value = '正在下载、校验并逐组保存备份…'
    restoreFailures.value = []
    restoreProgress.value = undefined
    restorePhase.value = 'manifest'
    const controller = new AbortController()
    restoreController = controller
    let acknowledgeStop!: () => void
    const stopped = new Promise<void>((resolve) => {
      acknowledgeStop = resolve
    })
    const operationId =
      item.kind === 'githubSnapshot' || item.kind === 'webdavSnapshot'
        ? taskCenter.start({
            name: '从云端导入本机',
            keepAlive: true,
            phase: '正在准备所选资源',
            cancelable: true,
            cancel: () => {
              controller.abort(new DOMException('已停止本次云恢复', 'AbortError'))
              return stopped
            },
          })
        : ''
    restoreOperation.value = operationId
    let changes: import('../types/Backup').RestoreReport | undefined
    const refreshIds = new Set<string>()
    const reportedIds = new Set<string>()
    let refreshCategories = false
    let lastRefreshAt = 0
    let refreshTimer: number | undefined
    const refreshInterval = 1_000
    const flushRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshTimer = undefined
      if (!changes || disposed || (!refreshIds.size && !refreshCategories)) return
      emit('library-changed', {
        ...changes,
        resourceIds: [...refreshIds],
        categoriesChanged: refreshCategories,
      })
      refreshIds.clear()
      refreshCategories = false
      lastRefreshAt = Date.now()
    }
    try {
      const count = await cloudBackupService.restoreBackup(
        item,
        confirmPortableCredentialImport,
        selectedKeys,
        selectedRestoreScopes.value.includes('extra.resourceGallery'),
        [...selectedRestoreScopes.value],
        (report) => {
          changes = report
          for (const id of report.resourceIds ?? []) {
            if (reportedIds.has(id)) continue
            reportedIds.add(id)
            refreshIds.add(id)
          }
          refreshCategories ||= report.categoriesChanged === true
          if (!refreshIds.size && !refreshCategories) return
          const elapsed = Date.now() - lastRefreshAt
          if (elapsed >= refreshInterval) flushRefresh()
          else if (refreshTimer === undefined)
            refreshTimer = window.setTimeout(flushRefresh, refreshInterval - elapsed)
        },
        {
          retryFailures,
          signal: controller.signal,
          onPhase: (phase) => {
            if (disposed) return
            restorePhase.value = phase
            message.value =
              phase === 'manifest' ? '正在核对快照清单…' : '资源阶段已结束，正在导入所选附加数据…'
            if (operationId)
              taskCenter.update(operationId, {
                phase: message.value,
                cancelable: phase !== 'extras',
              })
          },
          onProgress: (progress) => {
            if (disposed) return
            restorePhase.value = progress.phase
            restoreProgress.value = progress
            const phase =
              progress.phase === 'prepare' ? '核对、下载与准备（含本机复用）' : '写入本机'
            message.value = progress.fileName ? `当前文件 · ${progress.fileName}` : phase
            if (progress.transferredBytes !== undefined)
              message.value += ` · ${formatMetricBytes(progress.transferredBytes)}${progress.totalBytes === undefined ? '' : ` / ${formatMetricBytes(progress.totalBytes)}`}`
            if (operationId) {
              taskCenter.update(operationId, {
                phase,
                progress: progress.total ? progress.completed / progress.total : undefined,
                itemProgress: { completed: progress.completed, total: progress.total },
                cancelable: true,
              })
              if (progress.transferredBytes !== undefined)
                taskCenter.updateTransfer(operationId, {
                  transferredBytes: progress.transferredBytes,
                  totalBytes: progress.totalBytes,
                })
            }
          },
          onTransfer: (received, total, fileName) => {
            if (disposed || controller.signal.aborted) return
            message.value = `正在下载 ${fileName ?? '云端分块'} · ${formatMetricBytes(received)}${total === undefined ? '' : ` / ${formatMetricBytes(total)}`}`
          },
        },
      )
      if (operationId) taskCenter.complete(operationId)
      restoreFailures.value = changes?.failures ?? []
      message.value = restoreFailures.value.length
        ? `本轮已保存 ${count} 项新资源`
        : count
          ? `所选内容已导入，加入 ${count} 项新资源`
          : '所选内容已导入，没有新增资源'
      if (changes?.restoredCommunitySources !== undefined)
        message.value += `；Discord 帖子 ${changes.restoredCommunitySources} 个，消息 ${changes.restoredCommunityMessages ?? 0} 条`
      restoreFailures.value = changes?.failures ?? []
      if (restoreFailures.value.length)
        message.value += `；${restoreFailures.value.length} 项未完成，可在下方手动重试`
      if (!changes?.resourceIds && selectedKeys.length) emit('library-changed')
      if (!restoreFailures.value.length) {
        restorePicker.value = undefined
        selectedRestoreKeys.value = new Set()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (operationId) taskCenter.cancelled(operationId)
        restoreFailures.value = []
        message.value = '已停止本次导入；已经保存的内容保留，不会自动重试。'
      } else {
        if (operationId) taskCenter.fail(operationId, error)
        message.value = error instanceof Error ? error.message : '云端导入失败'
      }
    } finally {
      flushRefresh()
      acknowledgeStop()
      restoreOperation.value = ''
      if (restoreController === controller) restoreController = undefined
      busyAction.value = ''
    }
  }

  async function dismissRestoreFailures(): Promise<void> {
    const id = await cloudBackupService.discardRestoreFailures()
    if (id) {
      noticeCenter.dismiss('cloud-restore:' + id)
      pendingRestores.value = pendingRestores.value.filter((record) => record.id !== id)
    }
    restoreFailures.value = []
    nativeStateGeneration++
    await closeRestorePicker()
    message.value = '本轮导入已结束；成功内容已保留，不会自动重试。'
  }
  async function retryRestoreFailures(): Promise<void> {
    const item = restorePicker.value?.item
    if (!item || !restoreFailures.value.length) return
    await runCloudAction('restore:' + item.id, () => restore(item, true))
  }

  async function closeRestorePicker(): Promise<void> {
    restorePicker.value = undefined
    selectedRestoreKeys.value = new Set()
    await cloudBackupService.clearRestorePreview()
  }

  async function confirmPortableCredentialImport(
    data: ArchivePortableData,
  ): Promise<ArchivePortableData> {
    const labels = [
      data.mainApiProfiles?.profiles.some((profile) => profile.apiKey) ? '主 API 密钥' : '',
      data.credentials?.imageGeneration?.length ? '生图 API 密钥' : '',
      data.credentials?.assistantGitHubReadToken ? '助手 GitHub 读取令牌' : '',
      data.credentials?.imageHosting ? '自建图床 Token' : '',
      data.credentials?.legacyFrontendWorkshopApi?.apiKey ? '旧状态项目专用 API 密钥' : '',
      data.credentials?.productAssistantApi ? 'AI 助手独立 API 配置与密钥' : '',
      data.credentials?.discordSource?.botToken ? 'Discord Bot Token' : '',
      data.credentials?.cloudBackup && Object.keys(data.credentials.cloudBackup).length
        ? '云备份凭据'
        : '',
    ].filter(Boolean)
    if (!labels.length) return data
    const confirmed = await confirmAction({
      title: '导入云备份中的凭据',
      message: `这个云备份实际包含：${labels.join('、')}。导入后会写入当前设备的受保护存储，确认继续吗？`,
      confirmLabel: '导入凭据',
    })
    return confirmed ? data : { ...data, mainApiProfiles: undefined, credentials: undefined }
  }

  async function download(item: CloudBackupItem): Promise<void> {
    if (!(await saveConfig(true))) return
    busyAction.value = `download:${item.id}`
    message.value = '正在读取、下载并生成备份归档…'
    const controller = new AbortController()
    downloadController = controller
    downloadFailures.value = []
    downloadProgress.value = {
      phase: 'manifest',
      completed: 0,
      total: 0,
      receivedBytes: 0,
      writtenBytes: 0,
    }
    let acknowledgeStop!: () => void
    const stopped = new Promise<void>((resolve) => {
      acknowledgeStop = resolve
    })
    const operationId = taskCenter.start({
      name: '下载云备份',
      phase: '读取、下载并生成归档',
      keepAlive: true,
      cancelable: true,
      cancel: () => {
        controller.abort(new DOMException('已停止云备份下载', 'AbortError'))
        taskCenter.update(operationId, { phase: '正在停止下载…' })
        return stopped
      },
    })
    downloadOperation.value = operationId
    try {
      const blob = await cloudBackupService.downloadBackup(item, undefined, undefined, {
        signal: controller.signal,
        onReadFailures: async (failures) => {
          controller.signal.throwIfAborted()
          if (disposed || downloadController !== controller)
            throw new DOMException('下载页面已关闭', 'AbortError')
          const retry = new Promise<void>((resolve) => {
            continueDownload = resolve
          })
          downloadFailures.value = failures
          message.value = `其余内容已生成，${failures.length} 项待补齐；重试只读取失败项。`
          taskCenter.update(operationId, { phase: `${failures.length} 项下载失败，等待手动重试` })
          taskCenter.setAction(operationId, { label: '重试失败项', run: retryDownloadFailures })
          await withAbort(retry, controller.signal)
        },
        onProgress: (progress) => {
          if (disposed || controller.signal.aborted || downloadController !== controller) return
          downloadProgress.value = progress
          taskCenter.update(operationId, {
            phase: progress.phase === 'manifest' ? '正在读取备份清单' : '正在下载、校验并生成 ZIP',
            itemProgress: progress.total
              ? { completed: progress.completed, total: progress.total }
              : undefined,
          })
          taskCenter.updateTransfer(operationId, { transferredBytes: progress.receivedBytes })
          taskCenter.update(operationId, {
            progress: progress.total ? progress.completed / progress.total : undefined,
          })
        },
      })
      controller.signal.throwIfAborted()
      taskCenter.update(operationId, { phase: '等待保存或系统分享', cancelable: false })
      downloadOperation.value = ''
      downloadController = undefined
      message.value = '归档已生成，正在交给系统保存或分享…'
      await downloadBlob(blob, item.archiveName ?? item.objectKey)
      taskCenter.complete(operationId)
      message.value = nativeTransport
        ? '已交给系统分享；请在目标应用中确认保存'
        : '已交给浏览器下载；保存结果请查看浏览器下载列表'
    } catch (error) {
      const cancelled =
        controller.signal.aborted ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          error.name === 'AbortError')
      if (cancelled) taskCenter.cancelled(operationId)
      else taskCenter.fail(operationId, error)
      message.value = cancelled
        ? '已取消下载或保存'
        : error instanceof Error
          ? error.message
          : '下载失败'
    } finally {
      taskCenter.setAction(operationId)
      continueDownload = undefined
      downloadFailures.value = []
      acknowledgeStop()
      busyAction.value = ''
      downloadOperation.value = ''
      if (downloadController === controller) downloadController = undefined
    }
  }

  function selectProvider(provider: CloudBackupProvider): void {
    if (busyAction.value) return
    activeProvider.value = provider
    if (provider === 'webdav') applyKoofrPreset(false)
    const model = selectionModelForConfig(provider === 'github' ? github.value : webdav.value)
    cloudScopeModel.value = { resourceIds: [...model.resourceIds], scopeIds: [...model.scopes] }
    backups.value = []
    restorePicker.value = undefined
    selectedRestoreKeys.value = new Set()
    void cloudBackupService.clearRestorePreview()
    message.value = ''
    refreshSnapshot()
  }

  function applyKoofrPreset(showMessage = true): void {
    webdav.value.baseUrl = KOOFR_URL
    if (!webdav.value.folder.trim()) webdav.value.folder = 'SRL-Backups'
    if (showMessage) message.value = 'Koofr 地址和备份文件夹已经配好；只需填写注册邮箱和应用密码'
  }

  function setScheduleMode(mode: CloudBackupSchedule['mode']): void {
    activeConfig.value.schedule =
      mode === 'daily' ? { mode: 'daily', time: '02:00' } : { ...DEFAULT_SCHEDULE }
  }

  function updateScheduleValue(event: Event): void {
    const schedule = activeConfig.value.schedule
    if (schedule?.mode !== 'interval') return
    activeConfig.value.schedule = {
      ...schedule,
      value: Number((event.target as HTMLInputElement).value),
    }
  }

  function updateScheduleUnit(event: Event): void {
    const schedule = activeConfig.value.schedule
    if (schedule?.mode !== 'interval') return
    activeConfig.value.schedule = {
      ...schedule,
      unit: (event.target as HTMLSelectElement).value as CloudBackupIntervalUnit,
    }
  }

  function updateScheduleTime(event: Event): void {
    activeConfig.value.schedule = {
      mode: 'daily',
      time: (event.target as HTMLInputElement).value,
    }
  }

  function openTutorialPreview(source: string, alt: string, event: MouseEvent): void {
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.focus({ preventScroll: true })
    tutorialPreview.value = { source, alt }
  }

  function closeTutorialPreview(): void {
    if (!tutorialPreview.value) return
    tutorialPreview.value = undefined
  }

  watch(
    () => github.value.contentSelection.credentials,
    (enabled, previous) => {
      if (enabled && !previous) credentialBackupConfirmedTarget.value.github = undefined
    },
  )

  watch(
    () => webdav.value.contentSelection.credentials,
    (enabled, previous) => {
      if (enabled && !previous) credentialBackupConfirmedTarget.value.webdav = undefined
    },
  )

  onMounted(() => {
    if (!nativeTransport) {
      const refreshWebBackup = () => {
        if (disposed) return
        webBackup.value = cloudBackupService.getWebBackupState()
        if (webBackup.value) message.value = webBackup.value.phase
        refreshSnapshot()
      }
      removeWebBackupListener = cloudBackupService.subscribeWebBackup(refreshWebBackup)
      refreshWebBackup()
    }
    clock = window.setInterval(() => (now.value = Date.now()), 60_000)
    if (nativeTransport) {
      void refreshNativeBackupState()
      nativeJobPoll = window.setInterval(() => void refreshNativeBackupState(), 5_000)
    }
    void cloudBackupService.initializeCredentials().then(() => {
      if (disposed) return
      refreshSnapshot()
      editingCredential.value.github = snapshot.value.credentials.github !== 'valid'
      editingCredential.value.webdav = snapshot.value.credentials.webdav !== 'valid'
      if (nativeTransport) {
        const restoreGeneration = nativeStateGeneration
        void cloudBackupService
          .pendingNativeRestores()
          .then((records) => {
            if (disposed || restoreGeneration !== nativeStateGeneration) return
            pendingRestores.value = records.filter((record) => record.restore)
            for (const record of records) {
              if (!record.restore) continue
              noticeCenter.push({
                id: `cloud-restore:${record.id}`,
                type: 'warning',
                persistent: true,
                message: '上次云恢复尚未完成本机导入',
                details: record.restore.item.objectKey,
                actions: [
                  {
                    label: '继续导入',
                    run: () => resumePendingRestore(record.id),
                  },
                ],
              })
            }
          })
          .catch(() => {
            if (!disposed && restoreGeneration === nativeStateGeneration)
              message.value = '暂时无法读取云恢复检查点，请保留原备份后重试'
          })
      }
    })
  })

  onUnmounted(() => {
    disposed = true
    downloadController?.abort(new DOMException('已离开云备份下载页面', 'AbortError'))
    if (restorePhase.value !== 'extras')
      restoreController?.abort(new DOMException('已离开云恢复页面', 'AbortError'))
    removeWebBackupListener?.()
    void cloudBackupService.clearRestorePreview()
    nativeStateGeneration += 1
    if (clock !== undefined) window.clearInterval(clock)
    if (nativeJobPoll !== undefined) window.clearInterval(nativeJobPoll)
  })
  return {
    status,
    formatTime,
    snapshot,
    activeProvider,
    selectProvider,
    busyAction,
    createBackup: () => runCloudAction('backup', createBackup),
    nativeTransport,
    nativeBackupActive,
    cancelNativeBackup,
    webBackup,
    pauseWebBackup,
    resumeWebBackup,
    webNotificationPermission,
    enableBackupNotifications,
    loadBackups: () => runCloudAction('list', loadBackups),
    message,
    restoreProgress,
    restoreFailures,
    retryRestoreFailures,
    dismissRestoreFailures,
    downloadProgress,
    downloadOperation,
    downloadFailures,
    retryDownloadFailures,
    stopDownload,
    restorePhase,
    restoreOperation,
    stopRestore,
    lastMetrics,
    metricSpeed,
    formatMetricDuration,
    formatMetricBytes,
    excessBackupCount,
    excessBackupBytes,
    cleanupRetention: () => runCloudAction('prune', cleanupRetention),
    activeConfig,
    backups,
    restorePicker,
    closeRestorePicker,
    selectedRestoreKeys,
    hasRestoreSelection,
    restoreScopeIds,
    restoreScopeModel,
    restorePreview,
    pendingRestores,
    restoreResourceCount,
    formatBytes,
    download: (item: CloudBackupItem) =>
      runCloudAction('download:' + item.id, () => download(item)),
    restore: (item: CloudBackupItem) => runCloudAction('restore:' + item.id, () => restore(item)),
    saveConfig: (quiet = false) => runCloudAction('save', () => saveConfig(quiet)),
    resumePendingRestore,
    github,
    openTutorialPreview,
    editingCredential,
    refillCredential,
    githubToken,
    cancelCredentialRefill,
    webdav,
    KOOFR_URL,
    webdavPassword,
    setScheduleMode,
    updateScheduleValue,
    updateScheduleUnit,
    updateScheduleTime,
    activeProtection,
    activeContentSelection,
    cloudScopeModel,
    setCloudScopeModel,
    communitySourcesEnabled,
    communitySourcesDisabledReason,
    backupScopeResources: computed(() => currentResources()),
    personalBackupSelection,
    backupContentSummary,
    testConnection: () => runCloudAction('test', testConnection),
    tutorialPreview,
    closeTutorialPreview,
  }
}
