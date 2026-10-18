import { requestWebBackgroundAudio } from '../services/WebBackgroundKeepAlive'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { computed, nextTick, onMounted, onScopeDispose } from 'vue'
import {
  communitySourceService,
  discordInboxAutomationSettingsService,
  resourceArchiveService,
  resourceService,
} from '../core/LibraryContainer'
import { DEFAULT_DISCORD_INBOX_AUTOMATION_SETTINGS } from '../services/DiscordInboxAutomationSettings'
import { autoBindIncomingCardBatch } from '../services/DiscordInboxAutoBinding'
import { noticeCenter } from '../core/NoticeCenter'
import { triggerNativeHaptic } from '../core/NativeHaptics'
import { confirmChatImports } from './UseChatImportConfirmation'
import { confirmAction } from './UseConfirmDialog'
import {
  migrateCharacterCardContentWithReview,
  selectCharacterCardMigrationEdits,
} from '../services/CharacterCardMigrationReview'
import type { ImportVersionCandidate } from '../types/Import'
import {
  analyzeResourceLink,
  getResourceLinkRiskBadges,
  RESOURCE_TYPE,
  RESOURCE_INSTALL_TARGET,
  RESOURCE_INSTALL_TARGET_LABELS,
  RESOURCE_LINK_PURPOSE,
  RESOURCE_LINK_PURPOSE_LABELS,
  RESOURCE_LINK_TYPE,
  type ResourceLink,
  type ResourceListSummary,
} from '../types/Resource'
import { summarizeFileNames, summarizeResourceTypes } from '../utils/LibraryFormatting'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'
import { PngResourceParser } from '../parser/PngResourceParser'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { isRecord } from '../utils/UnknownValue'
import { readCharacterCardContentEdits } from '../utils/CharacterCardContentEdits'
import { taskCenter } from '../core/TaskCenter'
import type { ArchiveStageProgress } from '../services/ArchiveExtraction'
import {
  isNativeImportKeepAliveAvailable,
  startNativeImportKeepAlive,
  stopNativeImportKeepAlive,
  suspendNativeImportKeepAlive,
  updateNativeImportKeepAlive,
} from '../services/NativeImportKeepAlive'
import { requestNativeNotifications } from '../core/NativeSecurity'
import type { NoticeType } from '../core/NoticeCenter'
import { materializeNativeFile, nativeFileSize, nativeFileSource } from '../core/NativeFileSource'
import { markSharedImportItemCompleted, type SharedFileBatch } from '../utils/ShareTargetIntake'
import { hashBlob } from '../services/HashService'
import { compareVersionCandidates } from '../services/ResourceVersionMatcher'
import {
  beginLinkImportRecovery,
  clearLinkImportRecovery,
  markLinkImportItemCompleted,
  pendingLinkImportUrls,
  readLinkImportRecovery,
  type LinkImportRecovery,
} from '../utils/LinkImportRecovery'

export interface LibraryImportContext {
  pendingBackupImport: Ref<File | undefined>
  showNotice: (
    message: string,
    duration?: number,
    preserveRecycleUndo?: boolean,
    type?: NoticeType,
  ) => void
  activeVersionImport: ComputedRef<ImportVersionCandidate | undefined>
  isNativeApk: boolean
  isBusy: Ref<boolean, boolean>
  isSystemFileDropActive: Ref<boolean, boolean>
  linkImportUrls: ComputedRef<string[]>
  loadResources: () => Promise<void>
  linkImportText: Ref<string, string>
  isLinkImportOpen: Ref<boolean, boolean>
  isImportChooserOpen: Ref<boolean, boolean>
  isRestorePanelOpen: Ref<boolean, boolean>
  isFeatureHubOpen: Ref<boolean, boolean>
  fileImportInput: Readonly<ShallowRef<HTMLInputElement | null>>
  tavernBackupInput: Readonly<ShallowRef<HTMLInputElement | null>>
  resourceArchiveInput: Readonly<ShallowRef<HTMLInputElement | null>>
  libraryBackupInput: Readonly<ShallowRef<HTMLInputElement | null>>
  openRestorePanel: (entry?: 'import' | 'export') => void
  handleRestoreInspect: (file: File) => Promise<void>
  extractCharacterAssets: Ref<boolean, boolean>
  pendingVersionImports: Ref<ImportVersionCandidate[]>
  LARGE_IMPORT_BYTES: number
  backupRecommended: Ref<boolean, boolean>
  hideCharacterAssets: Ref<boolean, boolean>
  persistResourceVersionMatchCache: Ref<boolean, boolean>
  skipVersionComparisonOnImport: Ref<boolean, boolean>
  sameNameVersionCandidates?: Ref<boolean, boolean>
  refreshStorageHealth: () => Promise<void>
  isVersionImportBusy: Ref<boolean, boolean>
  sharedAppImportFiles: Ref<File[], File[]>
}

export interface ImportTotals {
  imported: number
  importedBytes?: number
  duplicate: number
  failed: number
  firstFailure: string
}

export type SharedImportOutcome = 'restore' | 'consumed' | 'thirdPartyApp'

export function useLibraryImport(getContext: () => LibraryImportContext) {
  const linkImportUrls = computed(() => splitLinkImportText(getContext().linkImportText.value))
  let handlingSharedImport = false
  let activeImportTaskId = ''
  let activeImportAbortController: AbortController | undefined
  let backgroundKeepAliveTaskId = ''
  let backgroundKeepAliveStarting: Promise<void> | undefined
  let notificationPermissionChecked = false
  let linkImportRecoveryToResume: LinkImportRecovery | undefined

  onMounted(() => {
    let recovery: LinkImportRecovery | undefined
    try {
      recovery = readLinkImportRecovery(localStorage)
    } catch {
      return
    }
    if (!recovery || !pendingLinkImportUrls(recovery).length) return
    noticeCenter.push({
      id: 'srl-link-import-recovery',
      type: 'warning',
      persistent: true,
      message: '检测到上次链接导入未完成',
      details: `还有 ${pendingLinkImportUrls(recovery).length} 条链接未完成。已完成的项目会跳过。`,
      actions: [
        {
          label: '继续导入',
          run: async () => {
            linkImportRecoveryToResume = recovery
            getContext().linkImportText.value = pendingLinkImportUrls(recovery!).join('\n')
            getContext().isImportChooserOpen.value = true
            getContext().isLinkImportOpen.value = true
            noticeCenter.dismiss('srl-link-import-recovery')
            await handleLinkImport()
          },
        },
        {
          label: '放弃任务',
          run: () => {
            try {
              clearLinkImportRecovery(localStorage, recovery!.id)
            } catch {
              getContext().showNotice('无法清理上次链接导入记录。', 9000)
              return
            }
            noticeCenter.dismiss('srl-link-import-recovery')
          },
        },
      ],
    })
  })

  function createImportTask(
    options: { name: string; phase: string },
    operationId: string = crypto.randomUUID(),
  ): string {
    const controller = new AbortController()
    activeImportTaskId = operationId
    activeImportAbortController = controller
    return taskCenter.start({
      ...options,
      keepAlive: true,
      operationId,
      cancelable: true,
      cancel: () => controller.abort(new DOMException('用户已停止导入', 'AbortError')),
    })
  }

  function throwIfImportStopped(): void {
    activeImportAbortController?.signal.throwIfAborted()
  }

  async function enterBackgroundProtection(): Promise<void> {
    if (backgroundKeepAliveStarting) return backgroundKeepAliveStarting
    const taskId = activeImportTaskId
    if (!taskId || backgroundKeepAliveTaskId === taskId || !isNativeImportKeepAliveAvailable())
      return
    const task = taskCenter.list().find((item) => item.operationId === taskId)
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return
    const starting = (async () => {
      const started = await startNativeImportKeepAlive(task.name, task.phase)
      if (!started) return
      if (activeImportTaskId !== taskId || document.visibilityState !== 'hidden') {
        await suspendNativeImportKeepAlive()
        return
      }
      backgroundKeepAliveTaskId = taskId
      updateNativeImportKeepAlive(task.name, task.phase, task.progress)
    })()
    backgroundKeepAliveStarting = starting
    try {
      await starting
    } finally {
      if (backgroundKeepAliveStarting === starting) backgroundKeepAliveStarting = undefined
    }
  }

  async function leaveBackgroundProtection(): Promise<void> {
    if (!backgroundKeepAliveTaskId) return
    backgroundKeepAliveTaskId = ''
    await suspendNativeImportKeepAlive()
  }

  function handleImportVisibilityChange(): void {
    if (document.visibilityState === 'hidden') void enterBackgroundProtection()
    else void leaveBackgroundProtection()
  }

  document.addEventListener('visibilitychange', handleImportVisibilityChange)
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', handleImportVisibilityChange)
    activeImportTaskId = ''
    if (backgroundKeepAliveTaskId) void leaveBackgroundProtection()
  })

  async function startImportTask(taskId: string): Promise<void> {
    if (activeImportTaskId !== taskId) {
      activeImportTaskId = taskId
      activeImportAbortController = new AbortController()
    }
    // Ask while the Activity is visible; never try to open a permission prompt
    // after Android has already backgrounded the app.
    if (
      document.visibilityState !== 'hidden' &&
      isNativeImportKeepAliveAvailable() &&
      !notificationPermissionChecked
    ) {
      notificationPermissionChecked = true
      const granted = await requestNativeNotifications().catch(() => false)
      if (!granted)
        getContext().showNotice('系统通知未开启；切到后台时仍会尝试保活，但通知栏可能不显示进度。')
    }
    // Foreground imports use the normal TaskCenter/UI path. Native keep-alive is
    // only a protection layer entered after the app actually becomes hidden.
    if (document.visibilityState === 'hidden') await enterBackgroundProtection()
  }

  function updateImportTask(
    taskId: string,
    changes: Parameters<typeof taskCenter.update>[1],
  ): void {
    taskCenter.update(taskId, changes)
    if (backgroundKeepAliveTaskId !== taskId) return
    const task = taskCenter.list().find((item) => item.operationId === taskId)
    if (task) updateNativeImportKeepAlive(task.name, task.phase, task.progress)
  }

  async function stopImportTask(taskId: string): Promise<void> {
    if (activeImportTaskId === taskId) {
      activeImportTaskId = ''
      activeImportAbortController = undefined
    }
    if (backgroundKeepAliveTaskId !== taskId) return
    const task = taskCenter.list().find((item) => item.operationId === taskId)
    backgroundKeepAliveTaskId = ''
    await stopNativeImportKeepAlive({
      title: task?.status === 'completed' ? '导入已完成' : '导入未完成',
      message: task?.error || task?.name || '导入任务已结束',
      successful: task?.status === 'completed',
      notify: document.visibilityState === 'hidden' && !getContext().isRestorePanelOpen.value,
    })
  }

  const linkImportPreview = computed(() => {
    const url = linkImportUrls.value[0]
    if (!url) return undefined
    const analysis = analyzeResourceLink(url)
    if (!analysis.url || !analysis.type) return { valid: false as const, url }
    const link: ResourceLink = {
      id: 'preview',
      label: '',
      url: analysis.url,
      type: analysis.type,
      purpose: analysis.purpose ?? RESOURCE_LINK_PURPOSE.SOURCE_POST,
      installTarget: analysis.installTarget ?? RESOURCE_INSTALL_TARGET.NONE,
      trustMode: analysis.trustMode,
      versionRef: analysis.versionRef,
      github: analysis.github,
      createdAt: 0,
    }
    return {
      valid: true as const,
      url: analysis.url,
      purposeLabel: RESOURCE_LINK_PURPOSE_LABELS[link.purpose ?? RESOURCE_LINK_PURPOSE.SOURCE_POST],
      installTargetLabel:
        link.type === RESOURCE_LINK_TYPE.GITHUB &&
        link.purpose === RESOURCE_LINK_PURPOSE.REPOSITORY &&
        link.installTarget === RESOURCE_INSTALL_TARGET.NONE
          ? '用途待读取'
          : RESOURCE_INSTALL_TARGET_LABELS[link.installTarget ?? RESOURCE_INSTALL_TARGET.NONE],
      badges: getResourceLinkRiskBadges(link),
      github: link.github,
      versionRef: link.versionRef,
    }
  })

  const LARGE_IMPORT_FILE_COUNT = 20

  function splitLinkImportText(value: string): string[] {
    return Array.from(
      new Set(
        value
          .split(/[\s,，]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    )
  }

  async function handleImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const selectedFiles = Array.from(input.files ?? [])
    input.value = ''

    await processImportedFiles(selectedFiles)
  }

  async function handleTavernBackupImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const context = getContext()
    if (context.isBusy.value) return
    if (!/\.zip$/i.test(file.name)) {
      context.showNotice('酒馆备份必须是 ZIP 文件。普通资源请使用“导入本地资源 / 备份”。')
      return
    }
    await importTavernBackupFile(file)
  }

  async function handleLibraryBackupImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!/\.zip$/i.test(file.name)) {
      getContext().showNotice('资源库备份必须是 SRL 导出的 ZIP 文件。')
      return
    }
    const context = getContext()
    if (context.isBusy.value) return
    context.pendingBackupImport.value = file
    await openPendingBackupImport()
  }

  async function handleResourceArchiveImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const context = getContext()
    if (context.isBusy.value) return
    if (!/\.zip$/i.test(file.name)) {
      context.showNotice('资源合集必须是 ZIP 压缩包。')
      return
    }

    context.isBusy.value = true
    const operationId = createImportTask({
      name: `导入资源合集：${file.name}`,
      phase: '扫描压缩包并提取资源',
    })
    await startImportTask(operationId)
    try {
      const archive = await resourceArchiveService.readResourceArchive(file, (progress) =>
        reportArchiveProgress(operationId, progress),
      )
      throwIfImportStopped()
      if (archive.kind === 'library') {
        throw new Error('这是资源库备份，请返回并选择“资源库备份”入口。')
      }
      if (archive.kind === 'tavern') {
        throw new Error('这是酒馆备份，请返回并选择“酒馆备份”入口。')
      }
      const files = archive.kind === 'personal' ? [file] : archive.files
      if (!files.length) throw new Error('压缩包里没有发现可导入的资源文件。')

      const totals: ImportTotals = { imported: 0, duplicate: 0, failed: 0, firstFailure: '' }
      await importResourceFiles(files, totals, operationId)
      if (activeImportAbortController?.signal.aborted) return
      if (totals.failed) {
        const detail = totals.firstFailure ? `：${totals.firstFailure}` : ''
        throw new Error(`资源合集有 ${totals.failed} 项导入失败${detail}`)
      }
      taskCenter.complete(operationId)
      context.showNotice(
        `资源合集处理完成：成功 ${totals.imported}，重复 ${totals.duplicate}。`,
        9000,
      )
    } catch (error) {
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '资源合集导入失败', 9000)
    } finally {
      context.isBusy.value = false
      await stopImportTask(operationId)
    }
  }

  async function importTavernBackupFile(
    file: File,
    shareBatch?: SharedFileBatch,
    ownsBusyLock = false,
  ): Promise<boolean> {
    const context = getContext()
    if (context.isBusy.value && !ownsBusyLock) return false
    context.isBusy.value = true
    const operationId = createImportTask({ name: '导入酒馆备份', phase: '读取并校验 ZIP' })
    let success = false
    await startImportTask(operationId)
    try {
      context.showNotice(`正在处理 SillyTavern 备份：${file.name}…`)
      const includeChats = await confirmAction({
        title: '导入酒馆聊天记录',
        message:
          '是否同时导入备份中的 SillyTavern JSONL 聊天？聊天会复用资源库现有聊天解析器并保留原件；不会仅凭文件夹名称猜测角色绑定。大型酒馆备份包含大量聊天时会明显增加导入时间和存储占用。',
        confirmLabel: '同时导入聊天',
        cancelLabel: '只导入资源',
      })
      let batch: File[] = []
      let count = 0
      const totals: ImportTotals = { imported: 0, duplicate: 0, failed: 0, firstFailure: '' }
      updateImportTask(operationId, { phase: '验证备份结构并解压资源' })
      for await (const resourceFile of resourceArchiveService.tavernFiles(
        file,
        (progress) => reportArchiveProgress(operationId, progress),
        { includeChats },
      )) {
        throwIfImportStopped()
        batch.push(resourceFile)
        count++
        if (batch.length === 10) {
          updateImportTask(operationId, { phase: `正在导入已提取资源（已提取 ${count} 项）` })
          await importResourceFiles(batch, totals, operationId, shareBatch)
          throwIfImportStopped()
          batch = []
        }
      }
      if (batch.length) {
        updateImportTask(operationId, { phase: `正在导入最后 ${batch.length} 项资源` })
        await importResourceFiles(batch, totals, operationId, shareBatch)
        throwIfImportStopped()
      }
      context.showNotice(
        count
          ? `酒馆备份已提取 ${count} 个受支持资源文件：成功 ${totals.imported}，重复 ${totals.duplicate}，失败 ${totals.failed}${totals.firstFailure ? `（${totals.firstFailure}）` : ''}。${context.pendingVersionImports.value.length ? '有文件待确认历史版本。' : ''}${includeChats ? '聊天记录已按现有聊天解析规则处理；' : '聊天记录未导入；'}缓存、账号密钥、系统提示词及不支持的配置未导入。`
          : '已确认是 SillyTavern 备份，但没有发现当前支持导入的资源。',
        9000,
        false,
        totals.failed ? 'error' : 'success',
      )
      taskCenter.complete(operationId)
      success = totals.failed === 0
    } catch (error) {
      if (activeImportAbortController?.signal.aborted) return false
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '酒馆备份导入失败', 9000)
    } finally {
      context.isBusy.value = false
      await stopImportTask(operationId)
    }
    return success
  }

  async function handleSharedImportChoice(
    files: File[],
    route: 'libraryBackup' | 'tavernBackup' | 'resource' | 'thirdPartyApp',
    shareBatch?: SharedFileBatch,
  ): Promise<SharedImportOutcome | false> {
    const context = getContext()
    if (!files.length || context.isBusy.value || handlingSharedImport) return false
    // Acquire synchronously before any native materialization, archive inspection,
    // or notification permission prompt can yield to another import entrance.
    handlingSharedImport = true
    context.isBusy.value = true
    // ZIP routes can be inspected and selectively staged by NativeArchive. Only
    // routes whose downstream owner requires a regular File materialize the source.
    if (route === 'thirdPartyApp') {
      try {
        files = await Promise.all(files.map((file) => materializeNativeFile(file)))
        context.sharedAppImportFiles.value = files
        context.isFeatureHubOpen.value = true
        return 'thirdPartyApp'
      } finally {
        handlingSharedImport = false
        context.isBusy.value = false
      }
    }
    if (route === 'tavernBackup') {
      if (files.length !== 1 || !/\.zip$/i.test(files[0]!.name)) {
        context.showNotice('酒馆备份导入一次请选择一个 ZIP；资源库备份请选择“导入资源库备份”。')
        handlingSharedImport = false
        context.isBusy.value = false
        return false
      }
      try {
        const file = files[0]!
        const kind = await resourceArchiveService.inspect(file)
        if (kind !== 'tavern') {
          context.showNotice(
            kind === 'library'
              ? '选择的是“酒馆备份”，但文件实际是资源库备份。请从系统分享菜单选择“SRL · 资源库备份”。'
              : '选择的是“酒馆备份”，但文件结构不匹配。请重新选择正确的分享类型。',
          )
          return false
        }
        return (await importTavernBackupFile(file, shareBatch, true)) ? 'consumed' : false
      } finally {
        handlingSharedImport = false
        context.isBusy.value = false
      }
    }
    const operationId = createImportTask(
      {
        name:
          route === 'libraryBackup' ? '识别分享的资源库备份' : `识别分享的 ${files.length} 个资源`,
        phase: '检查文件结构',
      },
      shareBatch?.taskOperationId,
    )
    try {
      await startImportTask(operationId)
      throwIfImportStopped()
      if (route === 'libraryBackup') {
        if (files.length !== 1 || !/\.zip$/i.test(files[0]!.name)) {
          context.showNotice('资源库备份导入一次请选择一个 ZIP；酒馆备份请选择“导入酒馆备份”。')
          return false
        }
        const file = files[0]!
        // Android route records the entry point, not the archive's authoritative type.
        // Inspect once before dispatch so a stale/misrouted shortcut cannot force a
        // Tavern ZIP into the SRL restore path. SRL manifests still take precedence
        // inside ResourceArchiveService, so library archives containing Tavern-like
        // directory names remain library backups.
        // Android direct-share files stay native-backed so multi-GB archives are
        // never materialized in WebView memory. The restore preflight below parses
        // and validates the SRL manifest authoritatively. Browser/local Files can
        // still use the cheap classifier before handoff.
        if (!nativeFileSource(file)) {
          updateImportTask(operationId, { phase: '核对备份包实际结构' })
          const kind = await resourceArchiveService.inspect(file, (progress) =>
            reportArchiveProgress(operationId, progress),
          )
          if (kind === 'tavern') {
            const error = new Error(
              '选择的是“资源库备份”，但文件实际是酒馆备份。请从系统分享菜单选择“SRL · 酒馆备份”。',
            )
            taskCenter.fail(operationId, error)
            context.showNotice(error.message, 9000)
            return false
          }
          if (kind !== 'library') {
            const error = new Error(
              '选择的是“资源库备份”，但文件结构不匹配。请重新选择正确的分享类型。',
            )
            taskCenter.fail(operationId, error)
            context.showNotice(error.message, 9000)
            return false
          }
        }
        updateImportTask(operationId, { phase: '交由资源库恢复器预检' })
        context.pendingBackupImport.value = file
        taskCenter.complete(operationId)
        await openPendingBackupImport()
        return 'restore'
      }

      const ordinaryFiles: File[] = []
      const totals: ImportTotals = { imported: 0, duplicate: 0, failed: 0, firstFailure: '' }
      const routeErrors: string[] = []
      for (const file of files) {
        throwIfImportStopped()
        if (!/\.zip$/i.test(file.name)) {
          ordinaryFiles.push(file)
          continue
        }
        const archive = await resourceArchiveService.readResourceArchive(file, (progress) =>
          reportArchiveProgress(operationId, progress),
        )
        throwIfImportStopped()
        if (archive.kind === 'library') {
          context.showNotice(`“${file.name}”是资源库备份，请改选“导入资源库备份”。`)
          return false
        }
        if (archive.kind === 'personal') ordinaryFiles.push(file)
        else if (archive.kind === 'resources') ordinaryFiles.push(...archive.files)
        else routeErrors.push(`“${file.name}”是 SillyTavern 酒馆备份，请通过“导入酒馆备份”入口处理`)
      }
      if (ordinaryFiles.length)
        await importResourceFiles(ordinaryFiles, totals, operationId, shareBatch)
      if (activeImportAbortController?.signal.aborted) return false
      const failedCount = totals.failed + routeErrors.length
      if (failedCount) {
        const error = new Error(
          `分享资源导入失败 ${failedCount} 项：${[totals.firstFailure, ...routeErrors].filter(Boolean).join('；') || '请查看任务详情'}`,
        )
        taskCenter.fail(operationId, error)
        context.showNotice(error.message, 9000)
        return false
      }
      const waitingForVersion =
        shareBatch?.taskOperationId &&
        context.pendingVersionImports.value.some(
          (candidate) => candidate.shareRecoveryId === shareBatch.recoveryId,
        )
      if (waitingForVersion)
        taskCenter.update(operationId, { phase: '等待确认历史版本', cancelable: false })
      else {
        taskCenter.complete(operationId)
      }
      if (!shareBatch?.automaticCloud)
        context.showNotice(
          `分享资源处理完成：成功 ${totals.imported}，重复 ${totals.duplicate}。`,
          9000,
        )
      return 'consumed'
    } catch (error) {
      if (activeImportAbortController?.signal.aborted) return false
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '分享文件识别失败', 9000)
      return false
    } finally {
      handlingSharedImport = false
      context.isBusy.value = false
      await stopImportTask(operationId)
      if (
        context.isNativeApk &&
        shareBatch?.automaticCloud &&
        document.visibilityState !== 'hidden' &&
        taskCenter
          .list()
          .some((task) => task.operationId === operationId && task.status === 'completed')
      )
        taskCenter.dismiss(operationId)
    }
  }

  async function processImportedFiles(selectedFiles: File[]): Promise<void> {
    const context = getContext()

    if (!selectedFiles.length || context.isBusy.value) return
    context.isBusy.value = true
    const operationId = createImportTask({
      name: selectedFiles.length > 1 ? `导入 ${selectedFiles.length} 个文件` : '导入资源',
      phase: '读取所选文件',
    })
    await startImportTask(operationId)
    try {
      const ordinaryFiles = selectedFiles.filter((file) => !/\.zip$/i.test(file.name))
      const totals: ImportTotals = { imported: 0, duplicate: 0, failed: 0, firstFailure: '' }
      if (ordinaryFiles.length) await importResourceFiles(ordinaryFiles, totals, operationId)
      throwIfImportStopped()
      const zipFiles = selectedFiles.filter((item) => /\.zip$/i.test(item.name))
      const zipErrors: string[] = []
      let handedToRestore = false
      for (const [index, file] of zipFiles.entries()) {
        throwIfImportStopped()
        try {
          updateImportTask(operationId, {
            phase: `正在识别压缩包 ${index + 1}/${zipFiles.length}：${file.name}`,
          })
          const archive = await resourceArchiveService.readResourceArchive(file, (progress) =>
            reportArchiveProgress(operationId, progress),
          )
          throwIfImportStopped()
          if (archive.kind === 'library') {
            context.pendingBackupImport.value = file
            if (!context.activeVersionImport.value) await openPendingBackupImport()
            handedToRestore = true
            break
          }
          if (archive.kind === 'personal') {
            await importResourceFiles([file], totals, operationId)
            continue
          }
          if (archive.kind === 'resources') {
            await importResourceFiles(archive.files, totals, operationId)
            continue
          }
          zipErrors.push(`“${file.name}”是 SillyTavern 酒馆备份，请通过“导入酒馆备份”入口处理`)
        } catch (error) {
          if (activeImportAbortController?.signal.aborted) throw error
          zipErrors.push(
            `${file.name}：${error instanceof Error ? error.message : '压缩包导入失败'}`,
          )
        }
      }
      const failedCount = totals.failed + zipErrors.length
      if (!handedToRestore)
        context.showNotice(
          `导入处理完成：成功 ${totals.imported}，重复 ${totals.duplicate}，失败 ${failedCount}${totals.firstFailure ? `（${totals.firstFailure}）` : ''}${zipErrors.length ? `；${zipErrors.slice(0, 3).join('；')}${zipErrors.length > 3 ? '；…' : ''}` : ''}`,
          9000,
          false,
          failedCount ? 'error' : 'success',
        )
      if (failedCount)
        taskCenter.fail(
          operationId,
          new Error(
            `${failedCount} 项未能导入：${[totals.firstFailure, ...zipErrors].filter(Boolean).slice(0, 5).join('；')}${failedCount > 5 ? '；…' : ''}`,
          ),
        )
      else taskCenter.complete(operationId)
    } catch (error) {
      if (activeImportAbortController?.signal.aborted) return
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '导入失败', 9000)
    } finally {
      context.isBusy.value = false
      await stopImportTask(operationId)
    }
  }

  function reportArchiveProgress(operationId: string, progress: ArchiveStageProgress): void {
    taskCenter.updateTransfer(operationId, {
      transferredBytes: progress.readBytes,
      totalBytes: progress.totalBytes,
    })
    if (backgroundKeepAliveTaskId === operationId) {
      const task = taskCenter.list().find((item) => item.operationId === operationId)
      if (task) updateNativeImportKeepAlive(task.name, task.phase, task.progress)
    }
  }

  function handleSystemFileDragOver(event: DragEvent): void {
    const context = getContext()

    if (
      !context.isNativeApk ||
      context.isBusy.value ||
      !Array.from(event.dataTransfer?.types ?? []).includes('Files')
    )
      return
    event.preventDefault()
    context.isSystemFileDropActive.value = true
  }

  function handleSystemFileDragLeave(event: DragEvent): void {
    const context = getContext()

    if (!event.currentTarget || event.target === event.currentTarget)
      context.isSystemFileDropActive.value = false
  }

  async function handleSystemFileDrop(event: DragEvent): Promise<void> {
    const context = getContext()

    context.isSystemFileDropActive.value = false
    if (!context.isNativeApk || context.isBusy.value) return
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (!files.length) return
    event.preventDefault()
    context.showNotice(`收到 ${files.length} 个系统拖放文件，开始导入…`)
    await processImportedFiles(files)
  }

  async function handleLinkImport(): Promise<void> {
    const context = getContext()

    const urls = context.linkImportUrls.value
    if (!urls.length || context.isBusy.value) return
    let recovery = linkImportRecoveryToResume
    linkImportRecoveryToResume = undefined
    if (!recovery) {
      try {
        recovery = beginLinkImportRecovery(localStorage, urls)
      } catch {
        // Storage restrictions must not prevent a foreground import.
      }
    }
    const recoveryIndexes = recovery
      ? recovery.urls
          .map((url, index) => ({ url, index }))
          .filter(({ index }) => !recovery!.completed.includes(index))
          .map(({ index }) => index)
      : []
    context.isBusy.value = true
    const operationId = createImportTask({
      name: `导入 ${urls.length} 条资源链接`,
      phase: '检查资源链接',
    })
    let releaseAudio = () => undefined as void
    try {
      releaseAudio = await requestWebBackgroundAudio(
        '链接下载与导入',
        activeImportAbortController?.signal,
      )
      await startImportTask(operationId)
      let completedPosition = 0
      const results = await resourceService.importLinks(urls, {
        signal: activeImportAbortController?.signal,
        onItemComplete: (result) => {
          const index = recoveryIndexes[completedPosition++]
          if (!recovery || index === undefined || result.status === 'failed') return
          try {
            markLinkImportItemCompleted(localStorage, recovery.id, index)
            recovery.completed.push(index)
          } catch {
            // The import remains usable if the browser refuses local storage writes.
          }
        },
      })
      const importedCount = results.filter((result) => result.status === 'imported').length
      const duplicateCount = results.filter((result) => result.status === 'duplicate').length
      const failed = results.filter((result) => result.status === 'failed')
      await context.loadResources()
      if (failed.length && recovery) {
        linkImportRecoveryToResume = recovery
        context.linkImportText.value = pendingLinkImportUrls(recovery).join('\n')
      }
      if (!failed.length && importedCount + duplicateCount > 0) {
        if (recovery) {
          try {
            clearLinkImportRecovery(localStorage, recovery.id)
          } catch {
            context.showNotice('导入已完成，但无法清理恢复记录。', 9000)
          }
        }
        context.linkImportText.value = ''
        closeImportChooser()
      }
      context.showNotice(
        [
          importedCount ? `链接资源 ${importedCount} 项` : '',
          duplicateCount ? `重复 ${duplicateCount} 项` : '',
          failed.length ? `失败 ${failed.length} 项：${failed[0]?.message}` : '',
        ]
          .filter(Boolean)
          .join('；') || '没有可导入的链接',
      )
      if (activeImportAbortController?.signal.aborted) taskCenter.cancelled(operationId)
      else taskCenter.complete(operationId)
    } catch (error) {
      if (recovery) {
        linkImportRecoveryToResume = recovery
        context.linkImportText.value = pendingLinkImportUrls(recovery).join('\n')
      }
      if (activeImportAbortController?.signal.aborted) taskCenter.cancelled(operationId)
      else {
        taskCenter.fail(operationId, error)
        context.showNotice(error instanceof Error ? error.message : '链接导入失败', 9000)
      }
    } finally {
      releaseAudio()
      context.isBusy.value = false
      await stopImportTask(operationId)
    }
  }

  function closeImportChooser(): void {
    const context = getContext()

    context.isLinkImportOpen.value = false
    context.isImportChooserOpen.value = false
  }

  function openLinkImportPanel(): void {
    const context = getContext()

    context.isImportChooserOpen.value = true
    context.isLinkImportOpen.value = true
    void nextTick(() => {
      document.getElementById('link-import-text')?.focus({ preventScroll: true })
    })
  }

  function openImportChooser(): void {
    const context = getContext()

    if (context.isBusy.value) return
    context.isFeatureHubOpen.value = false
    context.isLinkImportOpen.value = false
    context.isImportChooserOpen.value = true
  }

  function openFileImportPicker(): void {
    const context = getContext()

    closeImportChooser()
    void nextTick(() => context.fileImportInput.value?.click())
  }

  function openResourceArchivePicker(): void {
    const context = getContext()
    if (context.isBusy.value) return
    closeImportChooser()
    void nextTick(() => context.resourceArchiveInput.value?.click())
  }

  function openLibraryBackupPicker(): void {
    const context = getContext()
    if (context.isBusy.value) return
    closeImportChooser()
    void nextTick(() => context.libraryBackupInput.value?.click())
  }

  function openTavernBackupPicker(): void {
    const context = getContext()
    if (context.isBusy.value) return
    closeImportChooser()
    void nextTick(() => context.tavernBackupInput.value?.click())
  }

  async function openPendingBackupImport(): Promise<void> {
    const context = getContext()

    const file = context.pendingBackupImport.value
    if (!file) return
    context.pendingBackupImport.value = undefined
    context.openRestorePanel('import')
    await context.handleRestoreInspect(file)
  }

  async function importResourceFiles(
    files: File[],
    totals?: ImportTotals,
    operationId?: string,
    shareBatch?: SharedFileBatch,
  ): Promise<boolean> {
    const context = getContext()

    if (!files.length) return true

    const wasBusy = context.isBusy.value
    context.isBusy.value = true
    const taskId =
      operationId ??
      createImportTask({
        name:
          files.length > 1 ? `导入 ${files.length} 项资源` : `导入资源：${files[0]?.name ?? ''}`,
        phase: '准备导入',
      })
    const ownsTask = !operationId
    let resultsReceived = false
    try {
      if (ownsTask) await startImportTask(taskId)
      updateImportTask(taskId, { phase: `等待确认导入内容（${files.length} 项）` })
      const chatOptions = await confirmChatImports(
        files,
        resourceService,
        activeImportAbortController?.signal,
      )
      if (!chatOptions) {
        if (ownsTask) taskCenter.cancelled(taskId)
        return false
      }
      const { protectPersonalImport } = await import('../services/PersonalResourceImport')
      const { requestSecretPassword } = await import('./UseSecretPasswordPrompt')
      const protectedFiles = []
      const originalContentHashes = new Map<File, string>()
      for (const file of files) {
        throwIfImportStopped()
        // Small personal JSON may be encrypted with a fresh IV on each attempt.
        // Retain only the source digest so a resumed share can find its committed ciphertext.
        const smallPersonalSource =
          shareBatch && /\.json$/iu.test(file.name) && nativeFileSize(file) <= 2 * 1024 * 1024
        const source = smallPersonalSource
          ? await materializeNativeFile(file, { signal: activeImportAbortController?.signal })
          : file
        let sourceHash =
          smallPersonalSource && Object.keys(shareBatch?.completedImportAliases ?? {}).length
            ? await hashBlob(new File([source], source.name, { type: source.type }))
            : undefined
        const committedHash = sourceHash && shareBatch?.completedImportAliases?.[sourceHash]
        const alreadyCommitted =
          committedHash && (await resourceService.findByContentHash(committedHash))
        const protectedFile = alreadyCommitted
          ? source
          : await protectPersonalImport(
              source,
              () =>
                requestSecretPassword(
                  '此文件含明文私密字段。输入总设置中的统一密码，加密后再存入资源库。',
                ),
              activeImportAbortController?.signal,
            )
        if (shareBatch && protectedFile !== source)
          sourceHash ??= await hashBlob(new File([source], source.name, { type: source.type }))
        throwIfImportStopped()
        protectedFiles.push(protectedFile)
        if (sourceHash) originalContentHashes.set(protectedFile, sourceHash)
      }
      const automationSettings = await discordInboxAutomationSettingsService
        .load()
        .catch(() => ({ ...DEFAULT_DISCORD_INBOX_AUTOMATION_SETTINGS }))
      const autoBindingResources: ResourceListSummary[] = []
      const results = await resourceService.importFiles(protectedFiles, {
        ...chatOptions,
        extractCharacterAssets: context.extractCharacterAssets.value,
        skipVersionComparison: context.skipVersionComparisonOnImport.value,
        sameNameVersionCandidates: context.sameNameVersionCandidates?.value === true,
        preferPngContainer: automationSettings.preferPngContainer,
        persistVersionMatchCache: context.persistResourceVersionMatchCache.value,
        signal: activeImportAbortController?.signal,
        completedContentHashes: shareBatch?.completedContentHashes,
        originalContentHashes,
        completedImportAliases: shareBatch?.completedImportAliases,
        discardCompletedResults: Boolean(shareBatch),
        onItemComplete: async (result) => {
          if (shareBatch && totals) {
            if (result.status === 'imported') {
              totals.imported += 1
              totals.importedBytes =
                (totals.importedBytes ?? 0) +
                result.resource.fileSize +
                (result.extractedResources ?? []).reduce(
                  (sum, resource) => sum + resource.fileSize,
                  0,
                )
            } else if (result.status === 'duplicate') totals.duplicate += 1
            else if (result.status === 'failed') {
              totals.failed += 1
              totals.firstFailure ||= `${result.fileName}：${result.message}`
            }
          }
          if (shareBatch && result.status === 'versionCandidate')
            context.pendingVersionImports.value.push({
              ...result,
              shareRecoveryId: shareBatch.recoveryId,
              onResolved: shareBatch.onVersionResolved,
            })
          if (
            (result.status === 'imported' || result.status === 'duplicate') &&
            result.resource.contentHash
          ) {
            if (result.sourceContentHash)
              await shareBatch?.markImportItemCompleted?.(
                result.resource.contentHash,
                result.sourceContentHash,
              )
            else await shareBatch?.markImportItemCompleted?.(result.resource.contentHash)
          }
          await shareBatch?.onItemComplete?.(result)
          if (
            shareBatch?.automaticCloud &&
            !shareBatch.deferAutomaticBinding &&
            automationSettings.bindForeground &&
            result.status === 'imported' &&
            result.resource.type === RESOURCE_TYPE.CHARACTER_CARD
          )
            autoBindingResources.push(result.resource)
        },
        onProgress: ({ completed, total, fileName, phase }) => {
          updateImportTask(taskId, {
            phase: `${completed}/${total} 项 · ${phase}：${fileName}`,
            progress: completed / Math.max(1, total),
            itemProgress: { completed, total },
          })
        },
      })
      if (
        shareBatch?.automaticCloud &&
        !shareBatch.deferAutomaticBinding &&
        automationSettings.bindForeground
      ) {
        try {
          const bindings = await autoBindIncomingCardBatch(
            communitySourceService,
            autoBindingResources,
            automationSettings,
          )
          for (const binding of bindings)
            window.dispatchEvent(
              new CustomEvent('srl:community-sources-changed', {
                detail: { origin: 'discord-auto-binding', sourceId: binding.sourceId },
              }),
            )
        } catch {
          // Binding is best effort; it must not turn a committed resource import into a failure.
        }
      }
      resultsReceived = true
      if (totals && !shareBatch) {
        totals.imported += results.filter((result) => result.status === 'imported').length
        totals.duplicate += results.filter((result) => result.status === 'duplicate').length
        totals.failed += results.filter((result) => result.status === 'failed').length
        const failed = results.find((result) => result.status === 'failed')
        if (failed?.status === 'failed')
          totals.firstFailure ||= `${failed.fileName}：${failed.message}`
      }
      if (!shareBatch)
        context.pendingVersionImports.value.push(
          ...results.filter(
            (result): result is ImportVersionCandidate => result.status === 'versionCandidate',
          ),
        )
      await context.loadResources()
      const importedCount =
        totals?.imported ?? results.filter((result) => result.status === 'imported').length
      const extractedResources = results.flatMap((result) =>
        result.status === 'imported' || result.status === 'duplicate'
          ? (result.extractedResources ?? [])
          : [],
      )
      const importedBytes =
        totals?.importedBytes ??
        results.reduce(
          (total, result) =>
            result.status === 'imported'
              ? total +
                result.resource.fileSize +
                (result.extractedResources ?? []).reduce(
                  (subtotal, resource) => subtotal + resource.fileSize,
                  0,
                )
              : total,
          0,
        )
      const duplicateCount = results.filter((result) => result.status === 'duplicate').length
      const duplicateFileNames = results.flatMap((result) =>
        result.status === 'duplicate' ? [result.fileName] : [],
      )
      const firstDuplicate = results.find((result) => result.status === 'duplicate')
      const reclassifiedCount = results.filter(
        (result) => result.status === 'duplicate' && result.reclassified,
      ).length
      const failedCount = results.filter((result) => result.status === 'failed').length
      const firstFailure = results.find((result) => result.status === 'failed')
      const recognizedResources = results.flatMap((result) =>
        result.status === 'imported' || result.status === 'duplicate'
          ? [result.resource, ...(result.extractedResources ?? [])]
          : [],
      )
      const typeSummary = summarizeResourceTypes(recognizedResources)
      const isLargeImport =
        importedCount >= LARGE_IMPORT_FILE_COUNT || importedBytes >= context.LARGE_IMPORT_BYTES
      if (isLargeImport) context.backupRecommended.value = true
      const details = [
        `成功 ${importedCount} 项`,
        extractedResources.length
          ? `自动拆分配套 ${extractedResources.length} 项${context.hideCharacterAssets.value ? '（已从普通列表隐藏）' : ''}`
          : '',
        duplicateCount
          ? `已存在：${summarizeFileNames(duplicateFileNames)}${firstDuplicate?.status === 'duplicate' ? `（${firstDuplicate.message}）` : ''}${reclassifiedCount ? `（重新识别 ${reclassifiedCount} 项）` : ''}`
          : '',
        firstFailure?.status === 'failed'
          ? `失败 ${failedCount} 项：${firstFailure.fileName}（${firstFailure.message}）`
          : '',
        typeSummary ? `类型：${typeSummary}` : '',
        context.pendingVersionImports.value.length
          ? `有 ${context.pendingVersionImports.value.length} 个文件需要确认是否为历史版本`
          : '',
        isLargeImport ? '本次导入量较大，建议立即创建完整备份' : '',
      ].filter(Boolean)
      if (!totals) context.showNotice(details.join('，'), 7000)
      if (ownsTask) taskCenter.complete(taskId)
      if (importedCount > 0) triggerNativeHaptic('success')
      await context.refreshStorageHealth()
      return true
    } catch (error) {
      if (activeImportAbortController?.signal.aborted) return false
      if (totals && !resultsReceived) {
        totals.failed += files.length
        totals.firstFailure ||= error instanceof Error ? error.message : '导入失败'
      }
      if (!totals)
        context.showNotice(
          error instanceof Error ? error.message : '本地数据库写入失败，请检查浏览器存储权限',
        )
      if (ownsTask) taskCenter.fail(taskId, error)
      return false
    } finally {
      context.isBusy.value = wasBusy
      if (ownsTask) await stopImportTask(taskId)
    }
  }

  async function handleVersionImportDecision(decision: {
    action:
      | 'activate'
      | 'archive'
      | 'replace'
      | 'replaceCurrent'
      | 'replaceHistory'
      | 'independent'
      | 'existing'
      | 'skip'
    targetId?: string
    note?: string
  }): Promise<void> {
    const context = getContext()

    const pending = context.activeVersionImport.value
    if (!pending || context.isVersionImportBusy.value) return

    const selectedCandidate = pending.candidates.find(
      (candidate) => candidate.resource.id === decision.targetId,
    )
    const isContainerVariant = selectedCandidate?.matchKind === 'containerVariant'
    const isReplaceAction = ['replace', 'replaceCurrent', 'replaceHistory'].includes(
      decision.action,
    )
    if (isReplaceAction) {
      if (!decision.targetId) throw new Error('请选择要覆盖的已有资源')
      const replacingHistory = decision.action === 'replaceHistory'
      const confirmed = await confirmAction({
        title: replacingHistory
          ? isContainerVariant
            ? '覆盖命中的历史封装'
            : '覆盖命中的历史版本'
          : isContainerVariant
            ? '覆盖当前封装'
            : '覆盖当前版本',
        message: `将用“${pending.fileName}”替换「${replacingHistory ? selectedCandidate?.matchedResource.versionLabel || selectedCandidate?.matchedResource.fileName : (selectedCandidate?.resource.name ?? '已有资源')}」。被替换文件会清理，但旧哈希仍可定位；已标记为可迁移的修改会迁移到新文件。确定继续吗？`,
        confirmLabel: '覆盖并保留旧哈希',
        danger: true,
        centered: true,
      })
      if (!confirmed) return
    }

    context.isVersionImportBusy.value = true
    try {
      let committedHash: string | undefined
      let resolvedResourceId: string | undefined
      let importedCardEdits: CharacterCardContentEdit[] | undefined
      if (
        (decision.action === 'activate' || isReplaceAction) &&
        selectedCandidate?.resource.type === RESOURCE_TYPE.CHARACTER_CARD
      ) {
        const current =
          decision.action === 'replaceHistory' && selectedCandidate.matchedHistorical
            ? await resourceService.getVersion(selectedCandidate.matchedResource.id)
            : await resourceService.get(selectedCandidate.resource.id)
        if (!current) throw new Error('要迁移修改的角色卡已经不存在')
        const currentEdits = readCharacterCardContentEdits(current.metadata.characterContentEdits)
        if (isContainerVariant) {
          // A container variant has the same complete card fingerprint, so existing
          // card edits still apply and do not need to pass through version migration review.
          importedCardEdits = currentEdits
        } else {
          const tracked = currentEdits.filter((edit) => edit.migrateToVersions)
          const selectedEdits = await selectCharacterCardMigrationEdits(tracked, pending.fileName)
          if (!selectedEdits) {
            context.showNotice('已取消版本绑定；文件尚未导入。请完成或关闭当前修改迁移窗口后重试。')
            return
          }
          if (selectedEdits.length) {
            const parsed = /\.png$/iu.test(pending.file.name)
              ? await new PngResourceParser().parse(pending.file)
              : await new JsonResourceParser().parse(pending.file)
            const newCard = isRecord(parsed.metadata.card) ? parsed.metadata.card : undefined
            if (parsed.type !== RESOURCE_TYPE.CHARACTER_CARD || !newCard)
              throw new Error('所选新版本无法解析为角色卡，未迁移卡内修改')
            const migration = await migrateCharacterCardContentWithReview(
              newCard,
              [],
              selectedEdits,
            )
            if (!migration) {
              context.showNotice('已取消修改迁移；文件尚未导入。')
              return
            }
            if (migration.conflicts.length) {
              const scope = migration.conflicts.map((edit) => `• ${edit.label}`).join('\n')
              const proceed = await confirmAction({
                title: '有修改与新版本冲突',
                message: `以下项目不会迁移：\n${scope}\n\n是否继续导入？冲突项将保留在旧版记录中，新版本原内容保持不变。`,
                confirmLabel: '继续并跳过冲突',
                cancelLabel: '取消导入',
              })
              if (!proceed) {
                context.showNotice('已取消版本绑定；文件尚未导入。')
                return
              }
            }
            importedCardEdits = migration.edits
          }
        }
      }
      if (decision.action === 'independent') {
        const [result] = await resourceService.importFiles([pending.file], {
          extractCharacterAssets: context.extractCharacterAssets.value,
          detectVersions: false,
          persistVersionMatchCache: context.persistResourceVersionMatchCache.value,
        })
        if (!result || result.status === 'failed') {
          throw new Error(result?.status === 'failed' ? result.message : '独立资源导入失败')
        }
        if (result.status === 'imported' || result.status === 'duplicate') {
          committedHash = result.resource.contentHash
          resolvedResourceId = result.resource.id
        }
        context.showNotice(`“${pending.fileName}”已作为独立资源导入`)
      } else if (decision.action === 'existing') {
        if (!selectedCandidate) throw new Error('请选择要保留的已有资源')
        const recognizedHash = await resourceService.rememberRecognizedFileHash(
          pending.file,
          selectedCandidate.matchedResource,
          selectedCandidate.matchedHistorical,
        )
        committedHash = selectedCandidate.resource.contentHash
        resolvedResourceId = selectedCandidate.resource.id
        context.showNotice(
          `已保留“${selectedCandidate.resource.name}”的库内原件；新文件未导入，已记住其哈希（${recognizedHash.slice(0, 12)}…），以后会自动跳过`,
        )
      } else if (
        decision.action === 'activate' ||
        decision.action === 'archive' ||
        decision.action === 'replace' ||
        decision.action === 'replaceCurrent' ||
        decision.action === 'replaceHistory'
      ) {
        if (!decision.targetId) throw new Error('请选择要归入的已有资源')
        const importedVersion =
          decision.action === 'replaceHistory' && selectedCandidate?.matchedHistorical
            ? await resourceService.replaceHistoricalVersion(
                pending.file,
                selectedCandidate.resource.id,
                selectedCandidate.matchedResource.id,
                importedCardEdits,
              )
            : await resourceService.importAsVersion(
                pending.file,
                decision.targetId,
                decision.action === 'activate' ||
                  decision.action === 'replace' ||
                  decision.action === 'replaceCurrent',
                decision.note,
                isContainerVariant ? 'container' : undefined,
                {},
                false,
                decision.action !== 'replace' && decision.action !== 'replaceCurrent',
                importedCardEdits,
              )
        committedHash = importedVersion?.contentHash
        resolvedResourceId = decision.targetId
        if (
          (decision.action === 'activate' || isReplaceAction) &&
          decision.action !== 'replaceHistory' &&
          context.extractCharacterAssets.value
        ) {
          await resourceService.extractCharacterAssetsMany([decision.targetId])
        }
        const migratedCount = importedCardEdits?.length ?? 0
        context.showNotice(
          isReplaceAction
            ? isContainerVariant
              ? `“${pending.fileName}”已覆盖${decision.action === 'replaceHistory' ? '命中的历史封装' : '当前封装'}，旧文件已清理并保留哈希${migratedCount ? `，迁移 ${migratedCount} 项修改` : ''}`
              : `“${pending.fileName}”已覆盖${decision.action === 'replaceHistory' ? '命中的历史版本' : '当前版本'}，旧文件已清理并保留哈希${migratedCount ? `，迁移 ${migratedCount} 项修改` : ''}`
            : isContainerVariant
              ? decision.action === 'activate'
                ? `“${pending.fileName}”已绑定到同一版本并设为当前封装，原文件仍完整保留`
                : `“${pending.fileName}”已绑定为同一版本的另一份封装，当前展示未改变`
              : decision.action === 'activate'
                ? `“${pending.fileName}”已设为当前版本，旧版已收入历史${migratedCount ? `，迁移 ${migratedCount} 项修改` : ''}`
                : `“${pending.fileName}”已加入历史，当前展示版本未改变`,
        )
      }
      if (pending.shareRecoveryId && committedHash)
        markSharedImportItemCompleted(
          pending.shareRecoveryId,
          committedHash,
          pending.sourceContentHash,
        )
      await pending.onResolved?.(committedHash, resolvedResourceId)
      const nextPending = context.pendingVersionImports.value[1]
      if (nextPending && resolvedResourceId) {
        const candidates = nextPending.candidates.filter(
          (candidate) => candidate.resource.id !== resolvedResourceId,
        )
        try {
          const refreshed = await resourceService.findVersionCandidateForGroup(
            nextPending.file,
            resolvedResourceId,
            { sameNameVersionCandidates: context.sameNameVersionCandidates?.value === true },
          )
          if (refreshed) candidates.push(refreshed)
          candidates.sort(compareVersionCandidates)
          nextPending.candidates = candidates.slice(0, 3)
        } catch {
          nextPending.candidates = candidates
          context.showNotice('下一项版本候选刷新失败；为避免误绑定，已移除刚处理资源的旧候选。')
        }
      }
      context.pendingVersionImports.value.shift()
      await context.loadResources()
      await context.refreshStorageHealth()
      if (!context.activeVersionImport.value && context.pendingBackupImport.value)
        await openPendingBackupImport()
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '历史版本保存失败')
    } finally {
      context.isVersionImportBusy.value = false
    }
  }
  return {
    linkImportUrls,
    linkImportPreview,
    splitLinkImportText,
    handleImport,
    handleTavernBackupImport,
    handleLibraryBackupImport,
    handleResourceArchiveImport,
    processImportedFiles,
    handleSystemFileDragOver,
    handleSystemFileDragLeave,
    handleSystemFileDrop,
    handleLinkImport,
    closeImportChooser,
    openLinkImportPanel,
    openImportChooser,
    openFileImportPicker,
    openResourceArchivePicker,
    openLibraryBackupPicker,
    openTavernBackupPicker,
    openPendingBackupImport,
    importResourceFiles,
    handleVersionImportDecision,
    handleSharedImportChoice,
  }
}
