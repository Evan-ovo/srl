import { isResourceAttachment } from '../types/ResourceAttachment'
import {
  requestWebBackgroundAudio,
  withWebBackgroundAudio,
} from '../services/WebBackgroundKeepAlive'
import {
  offerExportRecovery as offerExportRecoveryOperation,
  offerRestoreRecovery as offerRestoreRecoveryOperation,
  resumeRestoreTask as resumeRestoreTaskOperation,
  type UseLibraryArchiveRecoveryContext,
} from './UseLibraryArchiveRecovery'
import { createResourceArchiveSource } from '../services/ExportService'
import { selectPreparedRestore } from '../services/RestoreService'
import { canRestoreOnlyPortableData } from '../services/BackupRestoreSelection'
import { isResourceGalleryImage } from '../types/ResourceGallery'
import { includePersonalResource, plaintextSecretCopies } from '../services/PersonalResourceBackup'
import { requestSecretPassword } from './UseSecretPasswordPrompt'
import { onMounted, onScopeDispose, ref, type Ref } from 'vue'
import type { RestoreRecoveryTask, ExportRecoveryTask } from '../services/ArchiveRecoveryService'
import { openCheckpointArchiveWriter, discardCheckpointArchive } from '../core/NativeArchiveExport'
import type { ArchiveTransferOptions } from '../services/ArchiveZipWriter'
import { hashBlob } from '../services/HashService'
import { hashNativeFile, nativeFileSize } from '../core/NativeFileSource'
import { noticeCenter } from '../core/NoticeCenter'
import { confirmAction } from '../composables/UseConfirmDialog'
import {
  archiveRecoveryService,
  vaultService,
  browserStorageService,
  characterDrawService,
  communitySourceService,
  exportService,
  resourceGalleryService,
  resourceService,
  restoreService,
} from '../core/LibraryContainer'

const loadArchiveServices = () => import('../core/AppContainer')
import { mutationGuard } from '../core/MutationGuard'
import { requestNativeNotifications } from '../core/NativeSecurity'
import { triggerNativeHaptic } from '../core/NativeHaptics'
import {
  isNativeImportKeepAliveAvailable,
  notifyNativeImportAwaitingChoice,
  startNativeImportKeepAlive,
  suspendNativeImportKeepAlive,
  updateNativeImportKeepAlive,
} from '../services/NativeImportKeepAlive'
import {
  getNativeSafBackupStatus,
  openNativeSafBackupWriter,
  saveBlobToNativeSafBackup,
} from '../core/NativeSafBackup'
import { taskCenter } from '../core/TaskCenter'
import type { StorageHealth } from '../services/BrowserStorageService'
import type {
  ArchivePortableData,
  ArchiveOptions,
  ArchivePortableSelection,
  PreparedRestore,
  RestoreMode,
  RestoreReport,
} from '../types/Backup'
import { type Category, type ResourceSummary } from '../types/Resource'
import { downloadBlob, formatBytes } from '../utils/LibraryFormatting'

function restoreInspectionCancelledError(): Error {
  const error = new Error('已停止备份识别')
  error.name = 'AbortError'
  return error
}

export interface LibraryArchiveContext {
  isExporting: Ref<boolean, boolean>
  categories: Ref<Category[]>
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
  lastFullBackupAt: Ref<number | undefined, number | undefined>
  backupRecommended: Ref<boolean, boolean>
  isExportPanelOpen: Ref<boolean, boolean>
  refreshStorageHealth: () => Promise<void>
  reloadAppearanceSettings: () => void
  searchHistory: Ref<string[], string[]>
  cabinetResourceIds: Ref<string[], string[]>
  syncCustomUiCss: () => void
  preparedRestore: Ref<PreparedRestore | undefined>
  restoreSourceFile: Ref<File | undefined>
  restoreReport: Ref<RestoreReport | undefined>
  restoreEntry: Ref<'import' | 'export'>
  completedRestoreMode: Ref<RestoreMode>
  isRestorePanelOpen: Ref<boolean, boolean>
  storageHealth: Ref<StorageHealth>
  LARGE_ARCHIVE_BYTES: number
  isRestoring: Ref<boolean, boolean>
  onRestoreImportCancelled?: () => Promise<void>
  resources: Ref<ResourceSummary[]>
  loadLibrary: () => Promise<void>
  onRestoreImportComplete: () => Promise<void>
}

export function useLibraryArchive(getContext: () => LibraryArchiveContext) {
  let restoreRecovery: RestoreRecoveryTask | undefined
  const isRestorePreflighting = ref(false)
  let activeRestoreInspection:
    { operationId: string; controller: AbortController; settled: Promise<void> } | undefined
  const recovering = new Set<string>()

  function offerExportRecovery(task: ExportRecoveryTask): void {
    return offerExportRecoveryOperation(getUseLibraryArchiveRecoveryContext(), task)
  }

  function offerRestoreRecovery(task: RestoreRecoveryTask): void {
    return offerRestoreRecoveryOperation(getUseLibraryArchiveRecoveryContext(), task)
  }

  async function resumeRestoreTask(id: string): Promise<void> {
    return resumeRestoreTaskOperation(getUseLibraryArchiveRecoveryContext(), id)
  }

  onMounted(() => {
    void archiveRecoveryService.store
      .list()
      .then(async (tasks) => {
        for (const summary of tasks) {
          if (summary.kind === 'export') {
            const task = (await archiveRecoveryService.store.read(summary.id)) as
              ExportRecoveryTask | undefined
            if (task) offerExportRecovery(task)
            continue
          }
          if (summary.kind !== 'restore') continue
          const task = (await archiveRecoveryService.store.read(summary.id)) as
            RestoreRecoveryTask | undefined
          if (task) offerRestoreRecovery(task)
        }
      })
      .catch((error) =>
        getContext().showNotice(error instanceof Error ? error.message : '无法读取未完成任务'),
      )
  })
  let waitingForRestoreChoiceInBackground = false
  let requestingRestoreChoiceReminder = false
  let activeArchiveProtection: { operationId: string; title: string } | undefined
  let archiveProtectionRunning = false
  let archiveProtectionStarting: Promise<void> | undefined

  async function syncArchiveBackgroundProtection(): Promise<void> {
    const active = activeArchiveProtection
    if (!active || !isNativeImportKeepAliveAvailable()) return
    if (document.visibilityState === 'hidden') {
      if (archiveProtectionRunning) return
      if (archiveProtectionStarting) return archiveProtectionStarting
      const task = taskCenter.list().find((item) => item.operationId === active.operationId)
      if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return
      const starting = (async () => {
        const started = await startNativeImportKeepAlive(active.title, task.phase, 'resume')
        if (!started) return
        if (
          activeArchiveProtection?.operationId !== active.operationId ||
          document.visibilityState !== 'hidden'
        ) {
          await suspendNativeImportKeepAlive()
          return
        }
        archiveProtectionRunning = true
        updateNativeImportKeepAlive(active.title, task.phase, task.progress)
      })()
      archiveProtectionStarting = starting
      try {
        await starting
      } finally {
        if (archiveProtectionStarting === starting) archiveProtectionStarting = undefined
      }
      return
    }
    if (!archiveProtectionRunning) return
    archiveProtectionRunning = false
    await suspendNativeImportKeepAlive()
  }

  async function beginArchiveProtection(operationId: string, title: string): Promise<void> {
    activeArchiveProtection = { operationId, title }
    if (document.visibilityState !== 'hidden' && isNativeImportKeepAliveAvailable())
      void requestNativeNotifications().catch(() => false)
    await syncArchiveBackgroundProtection()
  }

  async function endArchiveProtection(operationId: string): Promise<void> {
    if (activeArchiveProtection?.operationId !== operationId) return
    activeArchiveProtection = undefined
    if (!archiveProtectionRunning) return
    archiveProtectionRunning = false
    await suspendNativeImportKeepAlive()
  }

  async function remindForRestoreChoice(): Promise<void> {
    const context = getContext()
    if (
      document.visibilityState !== 'hidden' ||
      !context.isRestorePanelOpen.value ||
      !context.preparedRestore.value ||
      context.isRestoring.value ||
      waitingForRestoreChoiceInBackground ||
      requestingRestoreChoiceReminder ||
      !isNativeImportKeepAliveAvailable()
    )
      return
    requestingRestoreChoiceReminder = true
    try {
      waitingForRestoreChoiceInBackground = true
      await notifyNativeImportAwaitingChoice(
        '备份预检已完成',
        '请返回 SRL，选择安全导入或覆盖当前资源库。',
      )
    } finally {
      requestingRestoreChoiceReminder = false
    }
  }

  const handleRestoreVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') void remindForRestoreChoice()
    void syncArchiveBackgroundProtection()
  }
  document.addEventListener('visibilitychange', handleRestoreVisibilityChange)
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', handleRestoreVisibilityChange)
    activeArchiveProtection = undefined
    if (archiveProtectionRunning) {
      archiveProtectionRunning = false
      void suspendNativeImportKeepAlive()
    }
  })

  async function handleExport(details: {
    mode: 'full' | 'partial'
    resourceIds?: string[]
    includeAllCategories?: boolean
    splitSizeBytes?: number
    resourceContent: 'original' | 'modified'
    portableSelection: ArchivePortableSelection
  }): Promise<void> {
    return mutationGuard.run(
      'archive:export',
      withWebBackgroundAudio('导出备份', () => performExport(details)),
    )
  }

  async function performExport(
    details: {
      mode: 'full' | 'partial'
      resourceIds?: string[]
      includeAllCategories?: boolean
      splitSizeBytes?: number
      resourceContent: 'original' | 'modified'
      portableSelection: ArchivePortableSelection
    },
    resumed?: ExportRecoveryTask,
  ): Promise<void> {
    const context = getContext()

    context.isExporting.value = true
    const controller = new AbortController()
    const checkCancelled = (): void => {
      if (controller.signal.aborted) throw controller.signal.reason
    }
    const operationId = taskCenter.start({
      name: '导出备份',
      keepAlive: true,
      phase: '收集可移植设置',
      cancelable: true,
      cancel: () => controller.abort(new DOMException('导出已取消', 'AbortError')),
    })
    let archiveName = ''
    const transfer: ArchiveTransferOptions = {
      signal: controller.signal,
      onProgress: ({ writtenBytes, fileName }: { writtenBytes: number; fileName?: string }) => {
        if (fileName !== archiveName) {
          archiveName = fileName ?? ''
          taskCenter.update(operationId, { phase: `生成 ZIP：${archiveName}` })
        }
        taskCenter.updateTransfer(operationId, { transferredBytes: writtenBytes })
        if (archiveProtectionRunning)
          updateNativeImportKeepAlive('导出备份', `已写入 ${formatBytes(writtenBytes)}`)
      },
    }
    let exportRecovery = resumed
    try {
      const portableData: ArchivePortableData = resumed?.payload.options.portableData ?? {
        version: 1,
      }
      if (!resumed) {
        Object.assign(
          portableData,
          await (
            await loadArchiveServices()
          ).exportPortableApplicationData(details.portableSelection),
        )
        if (details.portableSelection.appearance) {
          portableData.appearance = browserStorageService.exportAppearanceSettings()
        }
        if (details.portableSelection.cloudBackup) {
          portableData.cloudBackup = (
            await loadArchiveServices()
          ).cloudBackupService.exportPortableSettings()
        }
        if (details.portableSelection.characterDraw) {
          portableData.characterDraw = {
            state: await characterDrawService.load(),
            showNames: browserStorageService.getDrawShowNames(),
          }
        }
        if (details.portableSelection.generalPreferences) {
          portableData.generalPreferences = browserStorageService.exportGeneralPreferences()
        }
        if (details.portableSelection.mainApiProfiles) {
          const services = await loadArchiveServices()
          portableData.mainApiProfiles = services.mainApiService.getProfilesState()
          portableData.credentials = await services.exportPortableCredentialBundle()
        }
        if (details.portableSelection.resourceGallery)
          portableData.resourceGalleryCategories = await resourceGalleryService.exportCategories()
        if (details.portableSelection.aiTaggingState) {
          const { aiTaggingDraftService } = await loadArchiveServices()
          portableData.aiTaggingState = aiTaggingDraftService.exportPortableState()
        }
        if (details.portableSelection.externalApps) {
          portableData.externalApps = await (
            await loadArchiveServices()
          ).externalAppService.exportPortableState()
        }
        if (details.portableSelection.chatReader)
          portableData.chatReader = await (
            await loadArchiveServices()
          ).externalAppService.exportReaderData()
        if (details.portableSelection.assistantData)
          portableData.assistantData = await (
            await loadArchiveServices()
          ).exportPortableAssistantData()
        if (details.portableSelection.stitchWork) {
          portableData.stitchWork = browserStorageService.exportStitchWork()
        }
        if (details.portableSelection.frontendWorkshopComponents) {
          const { frontendWorkshopSourceComponentService } =
            await import('../core/FrontendWorkshopContainer')
          portableData.frontendWorkshopComponents =
            await frontendWorkshopSourceComponentService.exportPortableState()
        }
      }
      checkCancelled()
      taskCenter.update(operationId, { phase: '读取资源与版本摘要' })
      const source = await createResourceArchiveSource(resourceService)
      if (resumed) {
        source.resources = resumed.payload.resources
        source.versions = resumed.payload.versions
      }
      checkCancelled()
      const allResources = source.resources
      const secretCopies = details.portableSelection.plaintextSecretCopy
        ? allResources.filter(
            (resource) =>
              resource.type === 'secret' &&
              resource.metadata.secretProtection !== 'none' &&
              resource.metadata.privateFieldCount !== 0 &&
              includePersonalResource(resource, details.portableSelection.personalResources) &&
              (details.mode === 'full' || details.resourceIds?.includes(resource.id)),
          )
        : []
      if (!resumed && secretCopies.length) {
        const confirmed = await confirmAction({
          title: '明文密钥副本',
          message:
            '导出的备份清单将包含所选密钥卡的私密字段，拿到文件的人可以直接读取。加密原件同时保留。',
          confirmLabel: '继续导出明文副本',
        })
        if (!confirmed) {
          taskCenter.cancelled(operationId)
          return
        }
        checkCancelled()
        portableData.plaintextSecretCopies = []
        for (const summary of secretCopies) {
          checkCancelled()
          portableData.plaintextSecretCopies.push(
            ...(await plaintextSecretCopies([await source.read(summary, false)], undefined, () =>
              requestSecretPassword(
                '输入这批密钥卡的原查看密码，同一来源在本次页面内只需输入一次。',
              ),
            )),
          )
        }
      }
      let archiveOptions: ArchiveOptions = resumed?.payload.options ?? {
        ...details,
        personalResources: details.portableSelection.personalResources,
        portableData,
      }
      const nativeSafStatus = await getNativeSafBackupStatus().catch(() => null)
      if (resumed) {
        archiveOptions = { ...archiveOptions, communitySourceAttachments: [] }
        for (const entry of resumed.payload.attachments) {
          const blob = await communitySourceService.getAttachmentBlob(entry.assetId)
          if (!blob || blob.size !== entry.size || (await hashBlob(blob)) !== entry.hash)
            throw new Error('导出附件已变化，请重新导出')
          archiveOptions.communitySourceAttachments!.push({ assetId: entry.assetId, blob })
        }
      } else if (nativeSafStatus?.available) {
        archiveOptions = await exportService.prepareOptions(archiveOptions, transfer.signal, true)
        exportRecovery = await archiveRecoveryService.createExport(
          source,
          context.categories.value,
          archiveOptions,
          vaultService.isEnabled(),
        )
      }
      transfer.createdAt = exportRecovery?.payload.createdAt
      checkCancelled()
      taskCenter.update(operationId, { phase: '流式压缩并写入目标' })
      await beginArchiveProtection(operationId, '导出备份')
      const streamedArchives =
        exportRecovery || nativeSafStatus?.available
          ? await exportService.createArchivesFromSource(
              source,
              exportRecovery?.payload.categories ?? context.categories.value,
              archiveOptions,
              async (fileName) => {
                if (exportRecovery) return openCheckpointArchiveWriter(exportRecovery.id, fileName)
                const writer = await openNativeSafBackupWriter(fileName)
                if (!writer) throw new Error('系统备份文件夹授权已失效')
                return writer
              },
              transfer,
            )
          : undefined
      const archives = streamedArchives
        ? []
        : await exportService.createArchivesFromSource(
            source,
            context.categories.value,
            archiveOptions,
            undefined,
            transfer,
          )
      checkCancelled()
      let savedToSafCount = 0
      if (streamedArchives) savedToSafCount = streamedArchives.length
      for (const archive of archives) {
        checkCancelled()
        taskCenter.update(operationId, {
          phase: `保存或分享：${archive.fileName}`,
          cancelable: false,
        })
        let savedToSaf = false
        try {
          savedToSaf = await saveBlobToNativeSafBackup(archive.blob, archive.fileName)
        } catch (error) {
          context.showNotice(
            error instanceof Error
              ? `系统备份文件夹写入失败：${error.message}；已改为常规分享保存`
              : '系统备份文件夹写入失败；已改为常规分享保存',
            7000,
          )
        }
        if (savedToSaf) savedToSafCount += 1
        else await downloadBlob(archive.blob, archive.fileName)
        await new Promise<void>((continueDownload) => window.setTimeout(continueDownload, 120))
      }
      if (details.mode === 'full') {
        browserStorageService.recordFullBackup()
        context.lastFullBackupAt.value = browserStorageService.getLastFullBackupAt()
        context.backupRecommended.value = false
      }
      if (exportRecovery) {
        exportRecovery.phase = '完成'
        await archiveRecoveryService.store.save(exportRecovery)
        await discardCheckpointArchive(exportRecovery.id)
        await archiveRecoveryService.store.remove(exportRecovery.id)
        noticeCenter.dismiss(`archive:${exportRecovery.id}`)
      }
      context.isExportPanelOpen.value = false
      taskCenter.complete(operationId)
      context.showNotice(
        (streamedArchives ?? archives).length > 1
          ? `已导出 ${(streamedArchives ?? archives).length} 个分卷，共 ${(streamedArchives ?? archives).reduce((sum, item) => sum + item.resourceCount, 0)} 项资源${savedToSafCount ? `；其中 ${savedToSafCount} 个已保存到系统备份文件夹` : ''}`
          : `已导出 ${(streamedArchives ?? archives)[0]?.resourceCount ?? 0} 项资源${savedToSafCount ? '，已保存到系统备份文件夹' : ''}`,
      )
      triggerNativeHaptic('success')
      await context.refreshStorageHealth()
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        taskCenter.cancelled(operationId)
      else taskCenter.fail(operationId, error)
      if (exportRecovery) offerExportRecovery(exportRecovery)
      context.showNotice(error instanceof Error ? error.message : '导出失败')
    } finally {
      context.isExporting.value = false
      await endArchiveProtection(operationId)
    }
  }

  async function restorePortableData(
    data?: ArchivePortableData,
    recovery?: RestoreRecoveryTask,
  ): Promise<void> {
    const context = getContext()

    if (!data) return
    const apply = async (key: string, action: () => void | Promise<void>): Promise<void> => {
      if (recovery) await archiveRecoveryService.step(recovery, `设置：${key}`, action)
      else await action()
    }
    const credentialLabels = [
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
    const importCredentials =
      recovery?.payload.credentials ??
      (!credentialLabels.length ||
        (await confirmAction({
          title: '导入本机凭据',
          message: `这个备份包含：${credentialLabels.join('、')}。导入后会写入当前设备的受保护存储，确认继续吗？`,
          confirmLabel: '导入凭据',
        })))
    if (recovery && recovery.payload.credentials === undefined) {
      recovery.payload.credentials = importCredentials
      await archiveRecoveryService.store.save(recovery)
    }
    if (data.frontendWorkshopProjects || data.imageGeneration)
      await apply('创作资料', async () =>
        (await loadArchiveServices()).importPortableApplicationData(data),
      )
    if (data.appearance)
      await apply('外观', () => browserStorageService.importAppearanceSettings(data.appearance!))
    if (data.cloudBackup)
      await apply('云备份', async () =>
        (await loadArchiveServices()).cloudBackupService.importPortableSettings(data.cloudBackup!),
      )
    if (data.characterDraw) {
      await apply('抽了么', async () => {
        await characterDrawService.importState(data.characterDraw!.state)
        browserStorageService.setDrawShowNames(data.characterDraw!.showNames)
      })
    }
    if (data.generalPreferences) {
      await apply('常用偏好', async () => {
        browserStorageService.importGeneralPreferences(data.generalPreferences!)
      })
    }
    if (data.mainApiProfiles && importCredentials) {
      await apply('主 API', async () => {
        const services = await loadArchiveServices()
        services.mainApiService.importProfilesState(data.mainApiProfiles!)
        await services.mainApiService.awaitCredentialWrites()
      })
    }
    if (data.credentials && importCredentials) {
      await apply('凭据', async () =>
        (await loadArchiveServices()).importPortableCredentialBundle(data.credentials!),
      )
    }
    if (data.resourceGalleryCategories)
      await apply('图库分类', () =>
        resourceGalleryService.importCategories(data.resourceGalleryCategories!),
      )
    if (data.aiTaggingState)
      await apply('AI 标签工作区', async () => {
        const { aiTaggingDraftService } = await loadArchiveServices()
        aiTaggingDraftService.importPortableState(data.aiTaggingState!)
      })
    if (data.externalApps)
      await apply('应用数据', async () =>
        (await loadArchiveServices()).externalAppService.importPortableState(data.externalApps!),
      )
    if (data.chatReader)
      await apply('阅读数据', async () =>
        (await loadArchiveServices()).externalAppService.importReaderData(data.chatReader!),
      )
    if (data.assistantData)
      await apply('蒜惹菈本地资料', async () =>
        (await loadArchiveServices()).importPortableAssistantData(data.assistantData!),
      )
    if (data.stitchWork)
      await apply('缝了么', () => browserStorageService.importStitchWork(data.stitchWork!))
    if (data.frontendWorkshopComponents) {
      await apply('前端组件库', async () => {
        const { frontendWorkshopSourceComponentService } =
          await import('../core/FrontendWorkshopContainer')
        await frontendWorkshopSourceComponentService.importPortableState(
          data.frontendWorkshopComponents!,
        )
      })
    }
    if (data.plaintextSecretCopies?.length) {
      const { restorePlainSecretCopies } = await import('../core/PersonalResourceContainer')
      await apply('密钥副本', () => restorePlainSecretCopies(data.plaintextSecretCopies!))
    }
    context.reloadAppearanceSettings()
    context.searchHistory.value = browserStorageService.getSearchHistory()
    context.cabinetResourceIds.value = browserStorageService.getCabinetResourceIds()
    context.syncCustomUiCss()
  }

  function openRestorePanel(entry: 'import' | 'export' = 'export', resume = false): void {
    const context = getContext()
    if (resume) {
      context.isExportPanelOpen.value = false
      context.isRestorePanelOpen.value = true
      waitingForRestoreChoiceInBackground = false
      return
    }
    if (context.isRestoring.value) return
    if (restoreRecovery) offerRestoreRecovery(restoreRecovery)
    restoreRecovery = undefined
    context.isExportPanelOpen.value = false
    context.preparedRestore.value = undefined
    context.restoreSourceFile.value = undefined
    context.restoreReport.value = undefined
    waitingForRestoreChoiceInBackground = false
    context.restoreEntry.value = entry
    context.completedRestoreMode.value = 'merge'
    context.isRestorePanelOpen.value = true
  }

  async function handleRestoreInspect(file: File, recovery?: RestoreRecoveryTask): Promise<void> {
    const context = getContext()
    if (context.isRestoring.value) {
      context.showNotice('当前恢复任务仍在进行，请完成后再选择备份')
      return
    }
    if (!recovery) {
      let fileHash: string | undefined
      for (const summary of await archiveRecoveryService.store.list()) {
        if (summary.kind !== 'restore') continue
        const pending = (await archiveRecoveryService.store.read(summary.id)) as
          RestoreRecoveryTask | undefined
        const sourceSize = nativeFileSize(file)
        if (pending?.payload.source?.size === sourceSize)
          fileHash ??= (await hashNativeFile(file)) ?? (await hashBlob(file))
        if (pending && pending.payload.source?.hash === fileHash && fileHash) {
          offerRestoreRecovery(pending)
          await archiveRecoveryService.reselectSource(pending, file)
          await resumeRestoreTask(pending.id)
          return
        }
      }
    }

    const remainingBytes = Math.max(
      0,
      context.storageHealth.value.quota - context.storageHealth.value.usage,
    )
    const restoreSourceSize = nativeFileSize(file)
    const mayExceedRemainingSpace = remainingBytes > 0 && restoreSourceSize * 2 > remainingBytes
    if (
      (restoreSourceSize >= context.LARGE_ARCHIVE_BYTES || mayExceedRemainingSpace) &&
      !(await confirmAction({
        title: '大备份包预检',
        message: `该备份包为 ${formatBytes(restoreSourceSize)}，解压校验可能临时占用约 2 倍空间。${
          remainingBytes ? `当前剩余配额约 ${formatBytes(remainingBytes)}。` : ''
        }将使用分块读取，是否继续？`,
        confirmLabel: '继续预检',
      }))
    ) {
      return
    }
    if (restoreRecovery) offerRestoreRecovery(restoreRecovery)
    else await context.preparedRestore.value?.dispose?.()
    context.preparedRestore.value = undefined
    waitingForRestoreChoiceInBackground = false
    context.isRestoring.value = true
    const controller = new AbortController()
    let finishInspection!: () => void
    const settled = new Promise<void>((resolve) => {
      finishInspection = resolve
    })
    const operationId = taskCenter.start({
      name: '备份预检',
      keepAlive: true,
      phase: '读取 ZIP 并校验',
      cancelable: true,
      cancel: () => controller.abort(),
    })
    activeRestoreInspection = { operationId, controller, settled }
    isRestorePreflighting.value = true
    context.restoreSourceFile.value = file
    context.preparedRestore.value = undefined
    context.restoreReport.value = undefined
    let releaseAudio = () => undefined as void
    try {
      releaseAudio = await requestWebBackgroundAudio('备份预检', controller.signal)
      await beginArchiveProtection(operationId, '备份预检')
      if (controller.signal.aborted) throw restoreInspectionCancelledError()
      restoreRecovery =
        recovery ??
        (await archiveRecoveryService.createRestore(
          file,
          vaultService.isEnabled(),
          controller.signal,
        ))
      if (restoreRecovery)
        await archiveRecoveryService.ensureSource(restoreRecovery, file, controller.signal)
      if (controller.signal.aborted) throw restoreInspectionCancelledError()
      context.preparedRestore.value = await restoreService.prepare(
        file,
        context.resources.value,
        context.categories.value,
        true,
        (progress) => {
          const stagingStarted = progress.phase !== 'reading' || progress.stagedBytes > 0
          const phase =
            progress.phase === 'complete'
              ? '备份预检完成'
              : stagingStarted
                ? '解压、校验并写入暂存'
                : '读取 ZIP 并校验'
          taskCenter.update(operationId, {
            phase,
            progress: undefined,
            itemProgress: stagingStarted
              ? { completed: progress.completedEntries, total: progress.selectedEntries }
              : undefined,
          })
          const transferred =
            stagingStarted && progress.totalStagedBytes > 0
              ? {
                  transferredBytes: progress.stagedBytes,
                  totalBytes: progress.totalStagedBytes,
                }
              : { transferredBytes: progress.readBytes, totalBytes: progress.totalBytes }
          taskCenter.updateTransfer(operationId, transferred)
          if (archiveProtectionRunning)
            updateNativeImportKeepAlive(
              '备份预检',
              phase,
              transferred.totalBytes
                ? transferred.transferredBytes / transferred.totalBytes
                : undefined,
            )
        },
        controller.signal,
      )
      if (controller.signal.aborted) throw restoreInspectionCancelledError()
      if (restoreRecovery) {
        restoreRecovery.phase = '等待选择恢复方式'
        await archiveRecoveryService.savePrepared(restoreRecovery, context.preparedRestore.value)
      }
      taskCenter.complete(operationId)
      if (document.visibilityState === 'hidden') {
        waitingForRestoreChoiceInBackground = true
        await notifyNativeImportAwaitingChoice(
          '备份预检已完成',
          '请返回 SRL，选择安全导入或覆盖当前资源库。',
        )
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        taskCenter.cancelled(operationId)
        await context.preparedRestore.value?.dispose?.()
        context.preparedRestore.value = undefined
        context.restoreSourceFile.value = undefined
        if (restoreRecovery) {
          const cancelledRecovery = restoreRecovery
          await restoreService.clearRestoreCheckpoint(cancelledRecovery.id)
          await archiveRecoveryService.store.remove(cancelledRecovery.id)
          noticeCenter.dismiss(`archive:${cancelledRecovery.id}`)
          restoreRecovery = undefined
        }
        context.isRestorePanelOpen.value = false
        waitingForRestoreChoiceInBackground = false
        await context.onRestoreImportCancelled?.()
        context.showNotice('已停止识别，并清理分享暂存文件与恢复检查点。', 7000)
      } else {
        taskCenter.fail(operationId, error)
        if (restoreRecovery) offerRestoreRecovery(restoreRecovery)
        context.showNotice(error instanceof Error ? error.message : '备份预检失败')
      }
    } finally {
      releaseAudio()
      context.isRestoring.value = false
      isRestorePreflighting.value = false
      await endArchiveProtection(operationId)
      if (activeRestoreInspection?.operationId === operationId) activeRestoreInspection = undefined
      finishInspection()
    }
  }

  async function stopRestoreInspection(): Promise<boolean> {
    const active = activeRestoreInspection
    if (!active) return false
    if (!active.controller.signal.aborted) taskCenter.cancel(active.operationId)
    await active.settled
    return true
  }

  async function handleRestoreConfirm(
    mode: RestoreMode,
    resourceIds: string[],
    includeGallery = true,
    includeAttachments = true,
  ): Promise<void> {
    const context = getContext()
    if (context.isRestoring.value || recovering.size) return
    if (restoreRecovery?.payload.mode) return resumeRestoreTask(restoreRecovery.id)

    const prepared = context.preparedRestore.value
    if (!prepared) return
    const selectedIds = new Set(resourceIds)
    if (!selectedIds.size && mode === 'merge' && !canRestoreOnlyPortableData(prepared)) {
      context.showNotice('请至少选择一项资源后继续')
      return
    }
    if (
      mode === 'replace' &&
      ((!includeGallery && prepared.resources.some(isResourceGalleryImage)) ||
        (!includeAttachments && prepared.resources.some(isResourceAttachment)) ||
        !prepared.resources.every((resource) => selectedIds.has(resource.id)))
    ) {
      context.showNotice('整库覆盖必须选择全部资源；部分选择请使用安全新增')
      return
    }
    if (mode === 'replace' && prepared.preview.mode !== 'full') {
      context.showNotice('只有完整备份可以覆盖整个资源库')
      return
    }
    context.isRestoring.value = true
    let releaseAudio = () => undefined as void
    try {
      releaseAudio = await requestWebBackgroundAudio('导入备份')
      if (mode === 'replace') {
        const estimatedCurrentBytes = context.resources.value.reduce(
          (total, resource) => total + Math.max(0, resource.fileSize || 0),
          0,
        )
        const confirmed = await confirmAction({
          title: '整库覆盖',
          message: `确定用“${prepared.preview.fileName}”完整覆盖当前资源库吗？当前资源原件至少约 ${formatBytes(estimatedCurrentBytes)}，另有历史版本；覆盖成功后无法自动撤销，建议先导出当前资源库。资源写入失败会由数据库事务回滚。`,
          confirmLabel: '覆盖资源库',
          danger: true,
        })
        if (!confirmed) return
      }

      const selected =
        mode === 'replace'
          ? prepared
          : selectPreparedRestore(
              prepared,
              selectedIds,
              includeGallery,
              undefined,
              includeAttachments,
            )
      await mutationGuard.run(`archive:restore:${mode}`, () =>
        performRestoreConfirm(selected, mode),
      )
    } finally {
      releaseAudio()
      context.isRestoring.value = false
    }
  }

  async function performRestoreConfirm(
    prepared: PreparedRestore,
    mode: RestoreMode,
    resumed?: RestoreRecoveryTask,
  ): Promise<void> {
    const context = getContext()

    const operationId = taskCenter.start({
      name: '恢复备份',
      keepAlive: true,
      phase: '准备恢复数据',
    })
    waitingForRestoreChoiceInBackground = false
    try {
      await beginArchiveProtection(operationId, '恢复备份')
      const recovery = resumed ?? restoreRecovery
      if (!resumed && mode === 'replace') prepared = (await prepared.forReplacement?.()) ?? prepared
      if (recovery) {
        if (!resumed) {
          recovery.payload.mode = mode
          recovery.payload.baseline = await archiveRecoveryService.baseline(
            context.resources.value,
            context.categories.value,
          )
          prepared = { ...prepared, checkpointId: recovery.id, forReplacement: undefined }
          await archiveRecoveryService.savePrepared(recovery, prepared)
        }
      }
      taskCenter.update(operationId, {
        phase: mode === 'replace' ? '覆盖写入资源库' : '合并写入资源库',
        progress: undefined,
        itemProgress: { completed: 0, total: prepared.resources.length + prepared.versions.length },
      })
      const reportWriteProgress = (progress: {
        phase: 'prepare' | 'commit'
        completed: number
        total: number
        fileName?: string
        transferredBytes?: number
        totalBytes?: number
      }): void => {
        const phaseRatio = progress.total ? progress.completed / progress.total : 1
        const ratio = progress.phase === 'prepare' ? phaseRatio * 0.45 : 0.45 + phaseRatio * 0.5
        const phase = `${progress.phase === 'prepare' ? '准备并校验' : '写入资源库'}：${progress.fileName ?? ''}`
        if (progress.totalBytes !== undefined && progress.transferredBytes !== undefined) {
          taskCenter.updateTransfer(operationId, {
            transferredBytes: progress.transferredBytes,
            totalBytes: progress.totalBytes,
          })
        }
        taskCenter.update(operationId, {
          phase,
          progress: ratio,
          itemProgress: { completed: progress.completed, total: progress.total },
        })
        if (archiveProtectionRunning) updateNativeImportKeepAlive('恢复备份', phase, ratio)
      }
      let report: RestoreReport
      if (mode === 'replace') {
        report = await restoreService.replace(prepared, reportWriteProgress)
        await restorePortableData(prepared.portableData, recovery)
      } else {
        report = await restoreService.restore(prepared, undefined, reportWriteProgress)
        await restorePortableData(prepared.portableData, recovery)
      }
      context.completedRestoreMode.value = mode
      taskCenter.update(operationId, { phase: '刷新资源与索引', progress: 0.97 })
      await context.loadLibrary()
      await context.onRestoreImportComplete()
      if (recovery) {
        recovery.phase = '完成'
        await archiveRecoveryService.store.save(recovery)
        await prepared.dispose?.()
        await restoreService.clearRestoreCheckpoint(recovery.id)
        await archiveRecoveryService.store.remove(recovery.id)
        noticeCenter.dismiss(`archive:${recovery.id}`)
        restoreRecovery = undefined
      } else await prepared.dispose?.()
      context.preparedRestore.value = undefined
      context.restoreReport.value = report
      taskCenter.complete(operationId)
    } catch (error) {
      taskCenter.fail(operationId, error)
      if (restoreRecovery) offerRestoreRecovery(restoreRecovery)
      const reason = error instanceof Error ? `：${error.message}` : ''
      context.showNotice(`恢复未全部完成，请核对资源列表与设置后重试${reason}`)
    } finally {
      await endArchiveProtection(operationId)
    }
  }

  async function closeRestorePanel(): Promise<void> {
    const context = getContext()
    if (context.isRestoring.value || recovering.size) return
    context.isRestoring.value = true
    try {
      if (restoreRecovery && !restoreRecovery.payload.mode) {
        if (restoreRecovery.payload.prepared)
          await restoreService.revivePrepared(restoreRecovery.payload.prepared).dispose?.()
        else await context.preparedRestore.value?.dispose?.()
        await restoreService.clearRestoreCheckpoint(restoreRecovery.id)
        await archiveRecoveryService.store.remove(restoreRecovery.id)
        noticeCenter.dismiss(`archive:${restoreRecovery.id}`)
        restoreRecovery = undefined
      } else if (restoreRecovery) offerRestoreRecovery(restoreRecovery)
      else await context.preparedRestore.value?.dispose?.()
      context.preparedRestore.value = undefined
      context.restoreSourceFile.value = undefined
      context.isRestorePanelOpen.value = false
      waitingForRestoreChoiceInBackground = false
    } finally {
      context.isRestoring.value = false
    }
  }
  return {
    handleExport,
    performExport,
    restorePortableData,
    openRestorePanel,
    handleRestoreInspect,
    isRestorePreflighting,
    stopRestoreInspection,
    handleRestoreConfirm,
    closeRestorePanel,
  }

  function getUseLibraryArchiveRecoveryContext(): UseLibraryArchiveRecoveryContext {
    return {
      recovering,
      getContext,
      performExport: withWebBackgroundAudio('继续导出备份', performExport),
      resumeRestoreTask,
      get restoreRecovery() {
        return restoreRecovery
      },
      set restoreRecovery(value) {
        restoreRecovery = value
      },
      handleRestoreInspect,
      performRestoreConfirm,
    }
  }
}
