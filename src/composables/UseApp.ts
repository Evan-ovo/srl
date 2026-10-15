import { computed, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useAppearanceSettings } from '../composables/UseAppearanceSettings'
import { useBatchOperations } from '../composables/UseBatchOperations'
import { useCategoryManagement } from '../composables/UseCategoryManagement'
import { useNativeResourceExport } from '../composables/UseNativeResourceExport'
import { useRecycleBin } from '../composables/UseRecycleBin'
import { useResourceVersions } from '../composables/UseResourceVersions'
import { useSearchIndex } from '../composables/UseSearchIndex'
import { isAndroidApk } from '../core/AndroidAppUpdate'
import { browserStorageService, resourceService } from '../core/LibraryContainer'
import { noticeCenter, type NoticeType } from '../core/NoticeCenter'
import { taskCenter } from '../core/TaskCenter'
import { getPerformanceMonitorVisible } from '../core/PerformanceMonitor'
import type { StorageHealth } from '../services/BrowserStorageService'
import type { ResourceVersionView } from '../services/ResourceService'
import { type NativeResourceStorageInfo } from '../storage/NativeResourceFileMirror'
import type { FilterValue, SortValue } from '../types/AppView'
import type { PreparedRestore, RestoreMode, RestoreReport } from '../types/Backup'
import type { ImportVersionCandidate, ImportVersionComparison } from '../types/Import'
import {
  isExtractedCharacterAsset,
  type Category,
  type Resource,
  type ResourceSummary,
} from '../types/Resource'
import type { VaultStatus } from '../types/Vault'
import { listExtractedCleanupCandidates } from '../utils/ExtractedAssetCleanup'
import { formatBackupDate, formatBytes } from '../utils/LibraryFormatting'
import { useLibraryArchive } from './UseLibraryArchive'
import { useLibraryDisplayPreferences } from './UseLibraryDisplayPreferences'
import { useLibraryFolderOperations } from './UseLibraryFolderOperations'
import { useLibraryHealthRegistration } from './UseLibraryHealthRegistration'
import { useLibraryImport } from './UseLibraryImport'
import { useLibraryLifecycle } from './UseLibraryLifecycle'
import { useLibraryNavigation } from './UseLibraryNavigation'
import { useLibraryOverlayNavigation } from './UseLibraryOverlayNavigation'
import { useLibraryProtection } from './UseLibraryProtection'
import { useLibraryProtectionView } from './UseLibraryProtectionView'
import { useLibraryQueryView } from './UseLibraryQueryView'
import { useLibraryRefresh } from './UseLibraryRefresh'
import { useLibraryResourceActions } from './UseLibraryResourceActions'
import { useLibraryWorkspaceRecovery } from './UseLibraryWorkspaceRecovery'
import {
  downloadSharedDiscordAttachment,
  shouldAutoResumeSharedImport,
  type SharedFileBatch,
} from '../utils/ShareTargetIntake'
export type { FilterValue, SortValue } from '../types/AppView'

export function useApp() {
  const {
    updatePerformanceMonitorVisibility,
    applyHideCharacterAssets,
    applyHideChatDisplayRegex,
    applyShowManuallyBoundResources,
    applyBlurThumbnails,
    handleManualUpdateCheck,
    updateSplitViewport,
    openAiTagging,
    openVersionRecognition,
    openVaultSettings,
  } = useLibraryDisplayPreferences(() => ({
    showPerformanceMonitor,
    resources,
    hideCharacterAssets,
    hideChatDisplayRegex,
    showManuallyBoundResources,
    selectedSplitResource,
    selectedSplitResourceId,
    blurThumbnails,
    showNotice,
    isSplitWide,
    isAiTaggingOpen,
    isSettingsOpen,
    isVersionRecognitionOpen,
    openVaultPanel,
  }))

  const {
    loadResources,
    loadLibrary,
    handleLibraryChanged,
    refreshLibraryAndOpenVersions,
    handleAiTagsApplied,
    prepareResourceRefresh,
  } = useLibraryRefresh(() => ({
    resources,
    categories,
    managedResources,
    loadRecycleBin,
    organizingResource,
    closeResourceDetail,
    organizingVersions,
    showNotice,
  }))

  const { restoreWorkspaceSnapshot, saveWorkspaceSnapshot } = useLibraryWorkspaceRecovery(() => ({
    isNativeApk,
    WORKSPACE_RECOVERY_KEY,
    activeFilter,
    activeCategoryId,
    activeTag,
    sortValue,
    currentPage,
    selectedSplitResourceId,
    isFeatureHubOpen,
  }))

  const {
    selectFilter,
    selectCategory,
    selectTag,
    clearBrowsingState,
    selectMobileDestination,
    openFeatureHub,
    openAssistantDestination,
    handleNativeShortcut,
    handleNativeDeepLink,
    handleBrowseBack,
    handleGlobalKeydown,
    handleBackRequest,
    handleBrowserPopState,
    handleMobileFocus,
  } = useLibraryNavigation(() => ({
    openSharedImport,
    activeResourceIds,
    isNativeApk,
    WORKSPACE_RECOVERY_KEY,
    activeFilter,
    activeCategoryId,
    activeTag,
    sortValue,
    currentPage,
    selectedSplitResourceId,
    isFeatureHubOpen,
    isOverlayOpen,
    isMobileFiltersOpen,
    searchQuery,
    isSearchHistoryOpen,
    isSearchFocused,
    isSettingsOpen,
    isLinkImportOpen,
    isImportChooserOpen,
    isAiTaggingOpen,
    isCategoryManagerOpen,
    isExportPanelOpen,
    isRestorePanelOpen,
    isDataProtectionOpen,
    isRecycleBinOpen,
    isDuplicateCleanerOpen,
    isSimilarNameGroupsOpen,
    isExtractedCleanerOpen,
    isParsedTagCleanerOpen,
    isVersionRecognitionOpen,
    isVaultPanelOpen,
    openImportChooser,
    openLinkImportPanel,
    isBusy,
    resources,
    openResourceDetail,
    openRestorePanel,
    cancelSearchInput,
    saveCustomUiCss,
    backStack,
  }))

  const {
    openResourceDetail,
    copyResourceDeepLink,
    prepareResourceDetail,
    closeResourceDetail,
    openResourceFromLayout,
    handleFavorite,
    handleDelete,
    handleDetailSave,
    handleRelatedDownload,
  } = useLibraryResourceActions(() => ({
    showNotice,
    organizingResource,
    organizingInitialTab,
    organizingBoundResources,
    organizingVersions,
    layoutMode,
    isSplitWide,
    isBatchMode,
    selectedSplitResourceId,
    resources,
    moveResourcesToRecycleBin,
    isOrganizing,
    loadResources,
    categories,
  }))

  const {
    openFolderSettings,
    handleFolderAdd,
    handleFolderCover,
    handleCabinetPin,
    handleCabinetUnpin,
    handleFolderRename,
    handleFolderReorder,
    openFolderManagerFromFeatureHub,
  } = useLibraryFolderOperations(() => ({
    isSettingsOpen,
    isCategoryManagerOpen,
    isFolderViewBusy,
    loadResources,
    cabinetResourceIds,
    categories,
    showNotice,
    loadLibrary,
    resources,
  }))

  const {
    linkImportUrls,
    linkImportPreview,
    handleImport,
    handleTavernBackupImport,
    handleLibraryBackupImport,
    handleResourceArchiveImport,
    handleSystemFileDragOver,
    handleSystemFileDragLeave,
    handleSystemFileDrop,
    handleLinkImport,
    closeImportChooser: closeImportChooserBase,
    openLinkImportPanel,
    openImportChooser,
    openFileImportPicker,
    openResourceArchivePicker,
    openLibraryBackupPicker,
    openTavernBackupPicker,
    importResourceFiles,
    handleVersionImportDecision: handleVersionImportDecisionBase,
    handleSharedImportChoice,
  } = useLibraryImport(() => ({
    pendingBackupImport,
    showNotice,
    activeVersionImport,
    isNativeApk,
    isBusy,
    isSystemFileDropActive,
    linkImportUrls,
    loadResources,
    linkImportText,
    isLinkImportOpen,
    isImportChooserOpen,
    isRestorePanelOpen,
    isFeatureHubOpen,
    fileImportInput,
    tavernBackupInput,
    resourceArchiveInput,
    libraryBackupInput,
    openRestorePanel,
    handleRestoreInspect,
    extractCharacterAssets,
    pendingVersionImports,
    LARGE_IMPORT_BYTES,
    backupRecommended,
    hideCharacterAssets,
    persistResourceVersionMatchCache,
    skipVersionComparisonOnImport,
    sameNameVersionCandidates,
    showManuallyBoundResources,
    refreshStorageHealth,
    isVersionImportBusy,
    sharedAppImportFiles,
  }))

  const {
    refreshStorageHealth,
    clearNativeTemporaryStorage,
    legacyLibraryHistory,
    isClearingLegacyLibraryHistory,
    oldPngThumbnailRepairStatus,
    isRepairingOldPngThumbnails,
    canClearRetainedNativeCopy,
    retainedNativeCopy,
    isClearingRetainedNativeCopy,
    retainedNativeCopyProgress,
    refreshRetainedNativeCopy,
    clearRetainedNativeCopy,
    isRetryingNativeMigration,
    canRetryNativeMigration,
    retryNativeMigration,
    refreshOldPngThumbnailRepairStatus,
    repairOldPngThumbnails,
    refreshLegacyLibraryHistory,
    clearLegacyLibraryHistory,
    requestPersistentStorage,
    openVaultPanel,
    handleVaultUnlock,
    handleVaultEnable,
    handleVaultDisable,
    handleVaultLock,
  } = useLibraryProtection(() => ({
    storageHealth,
    nativeStorageInfo,
    isNativeApk,
    isClearingNativeCache,
    showNotice,
    isRequestingPersistence,
    categories,
    isDataProtectionOpen,
    isVaultPanelOpen,
    vaultStatus,
    isVaultBusy,
    loadLibrary,
    loadRecycleBin,
    scheduleLibraryMaintenance,
    clearSearchHistory,
    loadResources,
    resetSearchState,
    resources,
    recycleBinEntries,
    recycleUndoEntry,
  }))

  const pendingSharedFileBatch = shallowRef<SharedFileBatch>()
  let pendingSharedBackupBatch: SharedFileBatch | undefined
  const deferredSharedImportBatches = new Map<string, SharedFileBatch>()

  async function acknowledgeSharedBackupAfterRestore(): Promise<void> {
    const batch = pendingSharedBackupBatch
    if (!batch) return
    try {
      await batch.acknowledge()
      if (pendingSharedFileBatch.value === batch) pendingSharedFileBatch.value = undefined
      pendingSharedBackupBatch = undefined
    } catch {
      showNotice('备份已恢复，但系统分享暂存文件未清理。')
    }
  }

  async function cancelPendingSharedBatch(batch: SharedFileBatch): Promise<void> {
    try {
      if (batch.onCancel) await batch.onCancel()
      else {
        await batch.setRoute?.(undefined)
        await batch.acknowledge()
      }
    } catch {
      showNotice('取消未完成，系统暂存文件未能清理；请重试取消。', 9000)
      isImportChooserOpen.value = true
      return
    }
    if (pendingSharedFileBatch.value === batch) pendingSharedFileBatch.value = undefined
    if (pendingSharedBackupBatch === batch) pendingSharedBackupBatch = undefined
  }

  async function closeImportChooser(): Promise<void> {
    closeImportChooserBase()
    const batch = pendingSharedFileBatch.value
    if (!batch || batch.discordAttachment) return
    await cancelPendingSharedBatch(batch)
  }

  async function closeRestorePanel(): Promise<void> {
    const batch = pendingSharedBackupBatch
    await closeRestorePanelBase()
    if (!batch || isRestorePanelOpen.value) return
    await cancelPendingSharedBatch(batch)
  }

  const {
    handleExport,
    openRestorePanel,
    handleRestoreInspect,
    handleRestoreConfirm,
    closeRestorePanel: closeRestorePanelBase,
    isRestorePreflighting,
    stopRestoreInspection,
  } = useLibraryArchive(() => ({
    isExporting,
    categories,
    showNotice,
    lastFullBackupAt,
    backupRecommended,
    isExportPanelOpen,
    refreshStorageHealth,
    reloadAppearanceSettings,
    searchHistory,
    cabinetResourceIds,
    syncCustomUiCss,
    preparedRestore,
    restoreSourceFile,
    restoreReport,
    restoreEntry,
    completedRestoreMode,
    isRestorePanelOpen,
    storageHealth,
    LARGE_ARCHIVE_BYTES,
    isRestoring,
    isRestorePreflighting,
    stopRestoreInspection,
    resources,
    loadLibrary,
    onRestoreImportCancelled: async () => {
      const batch = pendingSharedBackupBatch ?? pendingSharedFileBatch.value
      if (batch) await cancelPendingSharedBatch(batch)
    },
    onRestoreImportComplete: acknowledgeSharedBackupAfterRestore,
  }))

  const resourceNameCollator = new Intl.Collator('zh-CN')

  const DEFAULT_PAGE_SIZE = 24

  const LARGE_IMPORT_BYTES = 100 * 1024 * 1024

  const LARGE_ARCHIVE_BYTES = 256 * 1024 * 1024

  const BACKUP_REMINDER_INTERVAL = 14 * 24 * 60 * 60 * 1000

  const RESOURCE_LIST_COLUMNS = [
    '资源名称',
    '类型',
    '文件夹',
    '标签 / 关联',
    '大小',
    '更新时间',
    '操作',
  ]

  const WORKSPACE_RECOVERY_KEY = 'srl.android.workspace-recovery.v1'

  const resources = shallowRef<ResourceSummary[]>([])

  const categories = ref<Category[]>([])

  const activeFilter = ref<FilterValue>('all')

  const activeCategoryId = ref<string | null | undefined>(undefined)

  const activeTag = ref('')
  const activeResourceIds = shallowRef<Set<string>>()
  watch(activeResourceIds, () => {
    currentPage.value = 1
  })

  const sortValue = ref<SortValue>('newest')

  const currentPage = ref(1)

  const pageSize = ref(DEFAULT_PAGE_SIZE)

  const isBusy = ref(false)

  const batchBarHeight = ref(0)

  const linkImportText = ref('')

  const isLinkImportOpen = ref(false)

  const isImportChooserOpen = ref(false)

  const isSystemFileDropActive = ref(false)

  const fileImportInput = useTemplateRef<HTMLInputElement>('fileImportInput')

  const tavernBackupInput = useTemplateRef<HTMLInputElement>('tavernBackupInput')

  const resourceArchiveInput = useTemplateRef<HTMLInputElement>('resourceArchiveInput')

  const libraryBackupInput = useTemplateRef<HTMLInputElement>('libraryBackupInput')

  const pendingVersionImports = ref<ImportVersionCandidate[]>([])

  const pendingBackupImport = shallowRef<File>()

  const sharedAppImportFiles = shallowRef<File[]>([])
  const autoAttemptedDiscordTokens = new Set<string>()
  const queuedSharedFileBatches: SharedFileBatch[] = []
  const nativeDownloadAttempts = new Map<string, { workId?: string; taskId: string }>()
  const nativeImportResults = new Map<string, Set<string>>()

  // Retain only lightweight recent navigation identities; never evict active transfers.
  function trimNativeShareHistory(): void {
    const tasks = new Map(taskCenter.list().map((task) => [task.operationId, task.status]))
    for (const [token, attempt] of nativeDownloadAttempts) {
      if (nativeDownloadAttempts.size <= 100) break
      if (tasks.get(attempt.taskId) !== 'running') {
        nativeDownloadAttempts.delete(token)
        taskCenter.dismiss(attempt.taskId)
      }
    }
    while (nativeImportResults.size > 100)
      nativeImportResults.delete(nativeImportResults.keys().next().value!)
  }

  function matchesSharedToken(batch: SharedFileBatch, token: string): boolean {
    return batch.recoveryId === token || Boolean(batch.nativeShareTokens?.includes(token))
  }

  async function openSharedImport(token: string): Promise<void> {
    if (!/^discord-url-[a-f0-9-]{36}$/u.test(token)) return
    if (
      isBusy.value ||
      vaultStatus.value.locked ||
      pendingVersionImports.value.length ||
      pendingBackupImport.value ||
      pendingSharedBackupBatch ||
      sharedAppImportFiles.value.length
    ) {
      showNotice('请先完成当前导入或解锁资源库，再查看此附件。')
      return
    }
    function showImported(): boolean {
      const imported = nativeImportResults.get(token)
      if (!imported?.size || pendingSharedFileBatch.value) return false
      selectMobileDestination('all')
      currentPage.value = 1
      activeResourceIds.value = new Set(imported)
      isImportChooserOpen.value = false
      return true
    }
    if (showImported()) return
    await consumeSharedFiles()
    if (showImported()) return
    const pending = pendingSharedFileBatch.value
    if (isBusy.value || (pending && !matchesSharedToken(pending, token))) {
      showNotice('当前还有其他导入，请完成后再查看此附件。')
      return
    }
    const index = queuedSharedFileBatches.findIndex((batch) => matchesSharedToken(batch, token))
    if (!pending && index >= 0)
      activateSharedFileBatch(queuedSharedFileBatches.splice(index, 1)[0]!)
    if (pendingSharedFileBatch.value && matchesSharedToken(pendingSharedFileBatch.value, token)) {
      isFeatureHubOpen.value = false
      isImportChooserOpen.value = true
      return
    }
    const task = taskCenter
      .list()
      .find((item) => item.operationId === nativeDownloadAttempts.get(token)?.taskId)
    showNotice(
      task?.status === 'running'
        ? '此附件仍在下载，完成后可继续导入。'
        : '此分享已处理或暂存已过期，未打开其他附件。',
    )
  }

  function handleNativeDownloadState(event: Event): boolean {
    const detail = (
      event as CustomEvent<{ token?: string; workId?: string; name?: string; cloud?: boolean }>
    ).detail
    // Cloud downloads are owned by the resource inbox, including their import task.
    if (detail?.cloud === true) return false
    const token = detail?.token
    if (!token || !/^discord-url-[a-f0-9-]{36}$/u.test(token)) return false
    const started = event.type === 'srl:native-share-download-started'
    let attempt = nativeDownloadAttempts.get(token)
    if (!started && attempt?.workId && detail.workId && attempt.workId !== detail.workId)
      return false
    if (started && attempt && attempt.workId === detail.workId) return true
    if (!attempt || started) {
      attempt = { workId: detail.workId, taskId: 'native-download:' + token }
      nativeDownloadAttempts.set(token, attempt)
      taskCenter.start({
        operationId: attempt.taskId,
        name: detail.name || 'Discord 附件下载',
        phase: '等待网络并下载',
        background: true,
        action: { label: '查看附件', run: () => openSharedImport(token) },
      })
    }
    if (started) {
      for (let index = queuedSharedFileBatches.length - 1; index >= 0; index -= 1)
        if (queuedSharedFileBatches[index]?.discordAttachment?.cleanupToken === token)
          queuedSharedFileBatches.splice(index, 1)
      if (pendingSharedFileBatch.value?.discordAttachment?.cleanupToken === token) {
        pendingSharedFileBatch.value = undefined
        isImportChooserOpen.value = false
      }
    } else if (event.type === 'srl:native-share-download-completed') {
      taskCenter.update(attempt.taskId, { phase: '下载完成，可继续导入' })
      taskCenter.complete(attempt.taskId)
    } else {
      taskCenter.fail(attempt.taskId, '附件下载未完成，打开附件可查看原因并重试。')
    }
    trimNativeShareHistory()
    return true
  }

  function activateSharedFileBatch(batch: SharedFileBatch): void {
    if (batch.canProcess?.() === false) {
      queuedSharedFileBatches.push(batch)
      return
    }
    pendingSharedFileBatch.value = batch
    isLinkImportOpen.value = false
    const attachment = batch.discordAttachment
    if (
      attachment &&
      autoDownloadDiscordShareLinks.value &&
      !attachment.error &&
      !autoAttemptedDiscordTokens.has(attachment.cleanupToken)
    ) {
      autoAttemptedDiscordTokens.add(attachment.cleanupToken)
      isImportChooserOpen.value = false
      void downloadDiscordAttachment(true)
      return
    }
    if (shouldAutoResumeSharedImport(batch)) {
      void chooseSharedImportRoute(batch.route)
      return
    }
    isFeatureHubOpen.value = false
    isImportChooserOpen.value = true
  }

  function receiveSharedFileBatch(batch: SharedFileBatch): void {
    if (batch.nativeShareTokens?.length && batch.files.length) {
      const originalComplete = batch.onItemComplete
      batch.onItemComplete = async (result) => {
        await originalComplete?.(result)
        if (result.status !== 'imported' && result.status !== 'duplicate') return
        for (const token of batch.nativeShareTokens ?? []) {
          const ids = nativeImportResults.get(token) ?? new Set<string>()
          ids.add(result.resource.id)
          nativeImportResults.set(token, ids)
        }
        trimNativeShareHistory()
      }
    }
    if (pendingSharedFileBatch.value || isBusy.value) {
      queuedSharedFileBatches.push(batch)
      return
    }
    activateSharedFileBatch(batch)
  }

  watch([isBusy, pendingSharedFileBatch], ([busy, pending]) => {
    if (busy || pending || !queuedSharedFileBatches.length) return
    continueSharedInboxBatches()
  })
  function continueSharedInboxBatches(): void {
    if (isBusy.value || pendingSharedFileBatch.value || !queuedSharedFileBatches.length) return
    const index = queuedSharedFileBatches.findIndex((batch) => batch.canProcess?.() !== false)
    if (index < 0) return
    activateSharedFileBatch(queuedSharedFileBatches.splice(index, 1)[0]!)
  }
  onMounted(() => window.addEventListener('srl:web-inbox-state', continueSharedInboxBatches))
  onUnmounted(() => window.removeEventListener('srl:web-inbox-state', continueSharedInboxBatches))

  async function downloadSharedDiscordAttachmentNow(): Promise<void> {
    await downloadDiscordAttachment(false)
  }

  async function downloadDiscordAttachment(automatic: boolean): Promise<void> {
    const batch = pendingSharedFileBatch.value
    if (!batch?.discordAttachment) return
    try {
      await downloadSharedDiscordAttachment(batch.discordAttachment)
      if (pendingSharedFileBatch.value === batch) {
        pendingSharedFileBatch.value = undefined
        isImportChooserOpen.value = false
      }
      if (!automatic) {
        showNotice('已加入 Discord 附件下载队列；完成后将自动进入资源导入。', 5000)
      }
    } catch (error) {
      if (automatic) isImportChooserOpen.value = true
      showNotice(error instanceof Error ? error.message : '无法开始下载 Discord 附件', 9000)
    }
  }

  async function cancelSharedDiscordAttachment(): Promise<void> {
    const batch = pendingSharedFileBatch.value
    if (!batch?.discordAttachment) return
    autoAttemptedDiscordTokens.delete(batch.discordAttachment.cleanupToken)
    try {
      await batch.acknowledge()
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '清理分享链接失败', 9000)
      return
    }
    if (pendingSharedFileBatch.value === batch) {
      pendingSharedFileBatch.value = undefined
      isImportChooserOpen.value = false
    }
    window.dispatchEvent(new Event('srl:native-share'))
  }

  async function chooseSharedImportRoute(
    route: 'libraryBackup' | 'tavernBackup' | 'resource' | 'thirdPartyApp',
  ) {
    const batch = pendingSharedFileBatch.value
    if (!batch) return
    // The selected route may open a restore/editor panel or a long-running task.
    // Close the route sheet first so progress and confirmation UI cannot stack on it.
    isImportChooserOpen.value = false
    let savedRoute = false
    let importCommitted = false
    batch.onProcessingStarted?.()
    try {
      if (!batch.route && batch.setRoute) {
        await batch.setRoute(route)
        savedRoute = true
      }
      await batch.markImportStarted?.()
      const outcome = await handleSharedImportChoice(batch.files, route, batch)
      if (!outcome) {
        await batch.onFailure?.('资源未导入；可能已取消、文件结构不支持或需要另选导入用途。')
        if (batch.onFailure) {
          pendingSharedFileBatch.value = undefined
          return
        }
        if ((savedRoute || batch.routeWasPersisted) && batch.setRoute)
          await batch.setRoute(undefined)
        isImportChooserOpen.value = true
        return
      }
      if (outcome === 'thirdPartyApp') return
      if (outcome === 'restore') {
        if (pendingSharedFileBatch.value !== batch) return
        // Keep the original shared ZIP until the restore is committed. If Android
        // recreates the WebView while the user is choosing a restore mode, the
        // staged share can be recognized and preflighted again. The inspected
        // archive type owns acknowledgement timing, even when Android's route hint
        // came from a different import shortcut.
        pendingSharedBackupBatch = batch
        return
      }
      const waitingForVersionDecision = Boolean(
        batch.recoveryId &&
        pendingVersionImports.value.some(
          (candidate) => candidate.shareRecoveryId === batch.recoveryId,
        ),
      )
      if (waitingForVersionDecision && batch.recoveryId) {
        deferredSharedImportBatches.set(batch.recoveryId, batch)
        pendingSharedFileBatch.value = undefined
        return
      }
      importCommitted = true
      await batch.acknowledge()
    } catch (error) {
      if (importCommitted) {
        const reason = error instanceof Error ? `：${error.message}` : ''
        showNotice(`资源已导入，但系统分享暂存清理未完成${reason}；不会重复导入。`, 9000)
        pendingSharedFileBatch.value = undefined
        isImportChooserOpen.value = false
        return
      }
      if (batch.onFailure) {
        await batch.onFailure(error instanceof Error ? error.message : '云端资源导入或确认失败')
        pendingSharedFileBatch.value = undefined
        return
      }
      if ((savedRoute || batch.routeWasPersisted) && batch.setRoute) {
        try {
          await batch.setRoute(undefined)
        } catch {
          // Keep the original processing error visible; stale route hints expire with the share.
        }
      }
      const reason = error instanceof Error ? `：${error.message}` : ''
      showNotice(`分享文件处理失败${reason}；原分享文件仍保留，可重新选择用途。`, 9000)
      isImportChooserOpen.value = true
      return
    } finally {
      batch.onProcessingSettled?.()
    }
    pendingSharedFileBatch.value = undefined
  }

  async function handleSharedAppFilesConsumed(): Promise<void> {
    sharedAppImportFiles.value = []
    const batch = pendingSharedFileBatch.value
    if (batch) {
      try {
        await batch.acknowledge()
      } catch {
        showNotice('APP 预览已打开，但系统分享暂存未清理。')
      }
      pendingSharedFileBatch.value = undefined
    }
    isImportChooserOpen.value = false
  }

  const isVersionImportBusy = ref(false)
  const versionImportComparison = shallowRef<ImportVersionComparison>()
  const versionImportComparingId = ref('')

  const activeVersionImport = computed<ImportVersionCandidate | undefined>(
    () => pendingVersionImports.value[0],
  )

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
    const pending = activeVersionImport.value
    await handleVersionImportDecisionBase(decision)
    if (!pending?.shareRecoveryId) return
    if (pendingVersionImports.value.includes(pending)) return
    const recoveryId = pending.shareRecoveryId
    if (pendingVersionImports.value.some((candidate) => candidate.shareRecoveryId === recoveryId))
      return
    const batch = deferredSharedImportBatches.get(recoveryId)
    if (!batch) return
    try {
      await batch.acknowledge()
    } catch {
      deferredSharedImportBatches.delete(recoveryId)
      if (pendingSharedFileBatch.value === batch) pendingSharedFileBatch.value = undefined
      isImportChooserOpen.value = false
      showNotice('导入已完成，但系统分享暂存未清理；不会重复导入。', 9000)
      return
    }
    deferredSharedImportBatches.delete(recoveryId)
    if (pendingSharedFileBatch.value === batch) pendingSharedFileBatch.value = undefined
  }

  function cancelCloudVersionImport(event: Event): void {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id
    if (!id || !/^[a-f\d-]{36}$/u.test(id)) return
    const pending = activeVersionImport.value
    if (pending?.shareRecoveryId !== `discord-resource-${id}`) return
    void handleVersionImportDecision({ action: 'skip' })
  }

  onMounted(() =>
    window.addEventListener('srl:cancel-discord-version-import', cancelCloudVersionImport),
  )
  onUnmounted(() =>
    window.removeEventListener('srl:cancel-discord-version-import', cancelCloudVersionImport),
  )

  watch(activeVersionImport, () => {
    versionImportComparison.value = undefined
  })

  async function handleVersionImportCompare(matchedResourceId: string): Promise<void> {
    const pending = activeVersionImport.value
    if (!pending || isVersionImportBusy.value || versionImportComparingId.value) return
    const candidate = pending.candidates.find(
      (item) => item.matchedResource.id === matchedResourceId,
    )
    if (!candidate) return

    versionImportComparingId.value = matchedResourceId
    try {
      const [incoming, existing] = await Promise.all([
        resourceService.previewImportFile(pending.file),
        candidate.matchedHistorical
          ? resourceService.getVersion(candidate.matchedResource.id)
          : resourceService.get(candidate.matchedResource.id),
      ])
      if (activeVersionImport.value?.file !== pending.file) return
      if (!existing) throw new Error('被比较的已有资源已不存在')
      versionImportComparison.value = {
        incoming,
        existing,
        score: candidate.score,
        reasons: candidate.reasons,
        matchedHistorical: candidate.matchedHistorical,
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '无法生成资源对比')
    } finally {
      versionImportComparingId.value = ''
    }
  }

  function closeVersionImportCompare(): void {
    versionImportComparison.value = undefined
  }

  const isOrganizing = ref(false)

  const notice = ref('')
  useLibraryHealthRegistration({
    resources,
  })

  const isSettingsOpen = ref(false)

  const showPerformanceMonitor = ref(getPerformanceMonitorVisible())

  const isAiTaggingOpen = ref(false)

  const isFeatureHubOpen = ref(new URLSearchParams(window.location.search).has('srlBridge'))

  const isFeatureAppActive = ref(false)

  watch(isFeatureHubOpen, (open) => {
    if (!open) isFeatureAppActive.value = false
  })

  const selectedSplitResourceId = ref<string>()

  const isSplitWide = ref(false)

  const organizingResource = ref<Resource>()

  const organizingInitialTab = ref<'overview' | 'versions'>('overview')

  const organizingBoundResources = ref<Resource[]>([])

  const organizingVersions = ref<ResourceVersionView[]>([])

  const {
    pendingNativeExport,
    isNativeExportBusy,
    handleResourceDownload,
    handleNativeExportSelection,
    sharePendingNativeExport,
  } = useNativeResourceExport({ showNotice })

  const isCategoryManagerOpen = ref(false)

  const isFolderViewBusy = ref(false)

  const cabinetResourceIds = ref(browserStorageService.getCabinetResourceIds())

  const isExportPanelOpen = ref(false)

  const isRestorePanelOpen = ref(false)

  const isExporting = ref(false)

  const isRestoring = ref(false)

  const preparedRestore = shallowRef<PreparedRestore>()

  const restoreSourceFile = shallowRef<File>()

  const restoreReport = ref<RestoreReport>()

  const restoreEntry = ref<'import' | 'export'>('export')

  const completedRestoreMode = ref<RestoreMode>('merge')

  const storageHealth = ref<StorageHealth>({
    supported: false,
    persisted: false,
    usage: 0,
    quota: 0,
  })

  const nativeStorageInfo = ref<NativeResourceStorageInfo | null>(null)

  const isClearingNativeCache = ref(false)

  const isNativeApk = isAndroidApk()

  const isRequestingPersistence = ref(false)

  const isDataProtectionOpen = ref(false)

  const isDuplicateCleanerOpen = ref(false)

  const isSimilarNameGroupsOpen = ref(false)

  const isExtractedCleanerOpen = ref(false)

  const isParsedTagCleanerOpen = ref(false)

  const isVersionRecognitionOpen = ref(false)

  const isMobileFiltersOpen = ref(false)

  const isVaultPanelOpen = ref(false)

  const isVaultBusy = ref(false)

  const {
    isRecycleBinOpen,
    isRecycleBinBusy,
    recycleBinEntries,
    recycleUndoEntry,
    recycleBinSize,
    loadRecycleBin,
    moveResourcesToRecycleBin,
    openRecycleBin,
    handleRestoreRecycleBinEntry,
    handlePurgeRecycleBinEntry,
    handleEmptyRecycleBin,
  } = useRecycleBin({
    isDataProtectionOpen,
    prepareResourceRefresh,
    loadLibrary,
    refreshStorageHealth,
    showNotice,
  })

  const vaultStatus = ref<VaultStatus>({ enabled: false, locked: false })

  restoreWorkspaceSnapshot()

  const lastFullBackupAt = ref(browserStorageService.getLastFullBackupAt())

  const backupRecommended = ref(false)

  const extractedCleanupCount = computed(
    () => listExtractedCleanupCandidates(resources.value).length,
  )

  const {
    theme,
    layoutMode,
    mobileCardOrientation,
    mobileCardFitMode,
    resourceCardHeightMode,
    noImageResourceCoverMode,
    autoDownloadDiscordShareLinks,
    persistResourceVersionMatchCache,
    skipVersionComparisonOnImport,
    sameNameVersionCandidates,
    uiFontScale,
    previewPolicy,
    customUiCss,
    extractCharacterAssets,
    hideCharacterAssets,
    hideChatDisplayRegex,
    showManuallyBoundResources,
    blurThumbnails,
    settingsPanelKey,
    applyTheme,
    applyLayoutMode,
    applyMobileCardOrientation,
    applyResourceCardHeightMode,
    applyNoImageResourceCoverMode,
    applyAutoDownloadDiscordShareLinks,
    applyPersistResourceVersionMatchCache: setPersistResourceVersionMatchCache,
    applySkipVersionComparisonOnImport,
    applySameNameVersionCandidates,
    applyMobileCardFitMode,
    applyUiFontScale,
    syncCustomUiCss,
    saveCustomUiCss,
    applyRemotePreviewPolicy,
    applyScriptPreviewPolicy,
    applyGreetingPreviewPreload,
    applyBeautificationPreviewPreload,
    applyIncreasedPreviewDownloads,
    applyExtractCharacterAssets,
    reloadAppearanceSettings,
  } = useAppearanceSettings(showNotice)

  function applyPersistResourceVersionMatchCache(enabled: boolean): void {
    setPersistResourceVersionMatchCache(enabled)
    if (!enabled) {
      void resourceService.clearVersionMatchFingerprintCache().catch((error) => {
        showNotice(
          error instanceof Error
            ? `版本比对缓存未能清理：${error.message}`
            : '版本比对缓存未能清理',
        )
      })
    }
  }

  const {
    searchQuery,
    searchScope,
    searchHistory,
    isSearchHistoryOpen,
    isSearchFocused,
    isSearchIndexing,
    nameSearchIndexById,
    searchIndexById,
    contentSearchMatchIds,
    contentSearchQuery,
    refreshSearchContentIndex,
    commitSearch,
    useSearchHistory,
    clearSearchHistory,
    handleSearchFocus,
    handleSearchBlur,
    cancelSearchInput,
    resetSearchState,
  } = useSearchIndex(resources, () => vaultStatus.value.enabled)
  const { isOverlayOpen, backStack, personalNavigation } = useLibraryOverlayNavigation({
    closeRestorePanel,
    organizingResource,
    isOrganizing,
    isImportChooserOpen,
    closeImportChooser,
    isSettingsOpen,
    isDuplicateCleanerOpen,
    isSimilarNameGroupsOpen,
    isExtractedCleanerOpen,
    isParsedTagCleanerOpen,
    isVersionRecognitionOpen,
    isVaultPanelOpen,
    vaultStatus,
    isVaultBusy,
    isRestorePanelOpen,
    isRestoring,
    isExportPanelOpen,
    isExporting,
    isCategoryManagerOpen,
    isRecycleBinOpen,
    isRecycleBinBusy,
    isAiTaggingOpen,
    pendingNativeExport,
    isNativeExportBusy,
    activeVersionImport,
    versionImportComparison,
    closeVersionImportCompare,
    isVersionImportBusy,
    pendingVersionImports,
    get isBatchMode() {
      return isBatchMode
    },
    get isBatchBusy() {
      return isBatchBusy
    },
    get toggleBatchMode() {
      return toggleBatchMode
    },
    isMobileFiltersOpen,
    isDataProtectionOpen,
    isLinkImportOpen,
    get hasBrowsingState() {
      return hasBrowsingState
    },
    handleBrowseBack,
    isFeatureHubOpen,
  })

  const hiddenCharacterAssetCount = computed(
    () => resources.value.filter(isExtractedCharacterAsset).length,
  )

  function openSimilarNameGroups(): void {
    isSimilarNameGroupsOpen.value = true
  }

  function showSimilarResources(ids: string[]): void {
    clearBrowsingState()
    activeResourceIds.value = new Set(ids)
    currentPage.value = 1
    isSimilarNameGroupsOpen.value = false
  }

  const {
    countFilter,
    countCategory,
    statistics,
    visibleCategories,
    managedResources,
    duplicateGroupCounts,
    visibleLibraryResources,
    filters,
    matchesCategory,
    categoriesForResource,
    filteredResources,
    filteredResourceCount,
    paginatedResources,
    totalPages,
    tagFilters,
    selectedSplitResource,
    selectedSplitCategories,
    selectedSplitRelations,
    activeFilterLabel,
    activeCategoryLabel,
    activeSecondaryFilterCount,
    activeScopeLabel,
  } = useLibraryQueryView({
    activeResourceIds,
    categories,
    resources,
    hideCharacterAssets,
    hideChatDisplayRegex,
    showManuallyBoundResources,
    activeCategoryId,
    searchQuery,
    activeFilter,
    activeTag,
    sortValue,
    resourceNameCollator,
    searchScope,
    nameSearchIndexById,
    searchIndexById,
    contentSearchQuery,
    contentSearchMatchIds,
    currentPage,
    pageSize,
    selectedSplitResourceId,
  })

  const {
    isBatchMode,
    isBatchBusy,
    selectedResourceIds,
    allVisibleSelected,
    batchSelectionScope,
    allBatchScopeSelected,
    batchSelectionScopeLabel,
    selectedCharacterCount,
    toggleBatchMode,
    toggleResourceSelection,
    toggleVisibleSelection,
    toggleBatchScopeSelection,
    handleBatchTag,
    handleBatchFavorite,
    handleBatchMove,
    handleBatchExtractCharacterAssets,
    handleBatchDelete,
  } = useBatchOperations({
    resources,
    paginatedResources,
    filteredResources,
    visibleLibraryResources,
    activeCategoryId,
    activeCategoryLabel,
    matchesCategory,
    showNotice,
    loadResources,
    moveToRecycleBin: moveResourcesToRecycleBin,
  })

  const {
    handleActivateVersion,
    handleDeleteResourceVersion,
    handleDetachResourceVersion,
    handleUpdateVersionNote,
    handleMergeExistingVersion,
    handleReplaceCharacterCardArtwork,
  } = useResourceVersions({
    organizingResource,
    organizingVersions,
    isOrganizing,
    resources,
    showNotice,
    loadResources,
    refreshStorageHealth,
  })

  const {
    categoryManagerKey,
    handleCategoryCreate,
    handleCategoryUpdate,
    handleCategoryVisibility,
    handleCategoryDelete,
  } = useCategoryManagement({
    activeCategoryId,
    isOrganizing,
    showNotice,
    loadLibrary,
  })
  const {
    backupOverdue,
    displayedStorageUsage,
    displayedStorageAvailable,
    storageUsagePercent,
    storageProtectionStatus,
  } = useLibraryProtectionView({
    resources,
    lastFullBackupAt,
    BACKUP_REMINDER_INTERVAL,
    nativeStorageInfo,
    storageHealth,
    backupRecommended,
  })

  const hasBrowsingState = computed(
    () =>
      Boolean(activeResourceIds.value) ||
      Boolean(searchQuery.value) ||
      Boolean(activeTag.value) ||
      activeCategoryId.value !== undefined ||
      activeFilter.value !== 'all',
  )

  function showNotice(
    message: string,
    duration = 4000,
    preserveRecycleUndo = false,
    explicitType?: NoticeType,
  ): void {
    if (!preserveRecycleUndo) recycleUndoEntry.value = undefined
    if (!preserveRecycleUndo) {
      notice.value = ''
      const type: NoticeType =
        explicitType ?? (/失败|错误|损坏|无法|回滚/u.test(message) ? 'error' : 'info')
      noticeCenter.push({ id: 'app-main', type, message, durationMs: duration })
      return
    }
    notice.value = message
    window.setTimeout(() => {
      if (notice.value === message) notice.value = ''
    }, duration)
  }
  const { scheduleLibraryMaintenance, consumeSharedFiles } = useLibraryLifecycle({
    showNotice,
    receiveSharedFileBatch,
    handleNativeDownloadState,
    loadResources,
    refreshStorageHealth,
    vaultStatus,
    searchQuery,
    searchHistory,
    isVaultPanelOpen,
    loadLibrary,
    loadRecycleBin,
    handleNativeDeepLink,
    isOverlayOpen,
    searchScope,
    activeFilter,
    activeCategoryId,
    activeTag,
    sortValue,
    pageSize,
    currentPage,
    refreshSearchContentIndex,
    resources,
    selectedSplitResourceId,
    isFeatureHubOpen,
    saveWorkspaceSnapshot,
    totalPages,
    applyTheme,
    theme,
    applyUiFontScale,
    uiFontScale,
    handleGlobalKeydown,
    handleBackRequest,
    handleBrowserPopState,
    updateSplitViewport,
    handleNativeShortcut,
    handleMobileFocus,
    syncCustomUiCss,
  })
  return {
    layoutMode,
    autoDownloadDiscordShareLinks,
    persistResourceVersionMatchCache,
    skipVersionComparisonOnImport,
    sameNameVersionCandidates,
    mobileCardOrientation,
    mobileCardFitMode,
    resourceCardHeightMode,
    noImageResourceCoverMode,
    applyResourceCardHeightMode,
    applyNoImageResourceCoverMode,
    isBatchMode,
    vaultStatus,
    isSystemFileDropActive,
    batchBarHeight,
    isFeatureAppActive,
    handleSystemFileDragOver,
    handleSystemFileDragLeave,
    handleSystemFileDrop,
    isFeatureHubOpen,
    isOverlayOpen,
    isMobileFiltersOpen,
    theme,
    applyTheme,
    activeSecondaryFilterCount,
    filters,
    activeFilter,
    selectFilter,
    countFilter,
    isCategoryManagerOpen,
    activeCategoryId,
    selectCategory,
    countCategory,
    visibleCategories,
    activeTag,
    tagFilters,
    selectTag,
    openFeatureHub,
    isSettingsOpen,
    isExporting,
    isExportPanelOpen,
    isBusy,
    openImportChooser,
    handleImport,
    handleTavernBackupImport,
    handleLibraryBackupImport,
    handleResourceArchiveImport,
    pendingSharedFileBatch,
    chooseSharedImportRoute,
    downloadSharedDiscordAttachmentNow,
    cancelSharedDiscordAttachment,
    sharedAppImportFiles,
    handleSharedAppFilesConsumed,
    isImportChooserOpen,
    personalNavigation,
    closeImportChooser,
    openLinkImportPanel,
    openFileImportPicker,
    openResourceArchivePicker,
    openLibraryBackupPicker,
    openTavernBackupPicker,
    isLinkImportOpen,
    handleLinkImport,
    linkImportText,
    linkImportUrls,
    linkImportPreview,
    statistics,
    backupOverdue,
    backupRecommended,
    isDataProtectionOpen,
    storageProtectionStatus,
    openVaultPanel,
    recycleBinEntries,
    formatBytes,
    recycleBinSize,
    openRecycleBin,
    isNativeApk,
    storageHealth,
    isRequestingPersistence,
    requestPersistentStorage,
    displayedStorageUsage,
    displayedStorageAvailable,
    storageUsagePercent,
    isClearingNativeCache,
    clearNativeTemporaryStorage,
    legacyLibraryHistory,
    isClearingLegacyLibraryHistory,
    oldPngThumbnailRepairStatus,
    isRepairingOldPngThumbnails,
    canClearRetainedNativeCopy,
    retainedNativeCopy,
    isClearingRetainedNativeCopy,
    retainedNativeCopyProgress,
    refreshRetainedNativeCopy,
    clearRetainedNativeCopy,
    isRetryingNativeMigration,
    canRetryNativeMigration,
    retryNativeMigration,
    refreshOldPngThumbnailRepairStatus,
    repairOldPngThumbnails,
    refreshLegacyLibraryHistory,
    clearLegacyLibraryHistory,
    formatBackupDate,
    lastFullBackupAt,
    duplicateGroupCounts,
    isDuplicateCleanerOpen,
    isSimilarNameGroupsOpen,
    openSimilarNameGroups,
    activeResourceIds,
    showSimilarResources,
    extractedCleanupCount,
    isExtractedCleanerOpen,
    isParsedTagCleanerOpen,
    hasBrowsingState,
    handleBrowseBack,
    activeFilterLabel,
    activeCategoryLabel,
    searchQuery,
    cancelSearchInput,
    clearBrowsingState,
    commitSearch,
    searchScope,
    isSearchIndexing,
    handleSearchFocus,
    handleSearchBlur,
    isSearchFocused,
    isSearchHistoryOpen,
    searchHistory,
    clearSearchHistory,
    useSearchHistory,
    sortValue,
    filteredResources,
    filteredResourceCount,
    activeScopeLabel,
    toggleBatchMode,
    paginatedResources,
    categoriesForResource,
    selectedResourceIds,
    blurThumbnails,
    handleFavorite,
    openResourceFromLayout,
    toggleResourceSelection,
    handleDelete,
    RESOURCE_LIST_COLUMNS,
    selectedSplitResourceId,
    selectedSplitResource,
    selectedSplitCategories,
    selectedSplitRelations,
    openResourceDetail,
    handleResourceDownload,
    copyResourceDeepLink,
    pageSize,
    currentPage,
    totalPages,
    managedResources,
    duplicateResources: resources,
    visibleLibraryResources,
    organizingVersions,
    categories,
    uiFontScale,
    customUiCss,
    isFolderViewBusy,
    cabinetResourceIds,
    openFolderManagerFromFeatureHub,
    handleFolderAdd,
    handleFolderCover,
    handleFolderRename,
    handleFolderReorder,
    handleCabinetPin,
    handleCabinetUnpin,
    applyLayoutMode,
    applyMobileCardOrientation,
    applyMobileCardFitMode,
    applyUiFontScale,
    saveCustomUiCss,
    handleLibraryChanged,
    importResourceFiles,
    selectMobileDestination,
    openAssistantDestination,
    notice,
    recycleUndoEntry,
    handleRestoreRecycleBinEntry,
    allVisibleSelected,
    batchSelectionScope,
    batchSelectionScopeLabel,
    allBatchScopeSelected,
    selectedCharacterCount,
    isBatchBusy,
    toggleVisibleSelection,
    toggleBatchScopeSelection,
    handleBatchExtractCharacterAssets,
    handleBatchFavorite,
    handleBatchMove,
    handleBatchTag,
    openAiTagging,
    handleBatchDelete,
    isAiTaggingOpen,
    handleAiTagsApplied,
    isRecycleBinOpen,
    isRecycleBinBusy,
    handlePurgeRecycleBinEntry,
    handleEmptyRecycleBin,
    organizingResource,
    organizingInitialTab,
    organizingBoundResources,
    prepareResourceDetail,
    isOrganizing,
    closeResourceDetail,
    handleRelatedDownload,
    handleActivateVersion,
    handleDeleteResourceVersion,
    handleDetachResourceVersion,
    handleUpdateVersionNote,
    handleMergeExistingVersion,
    handleReplaceCharacterCardArtwork,
    handleDetailSave,
    pendingNativeExport,
    isNativeExportBusy,
    handleNativeExportSelection,
    sharePendingNativeExport,
    activeVersionImport,
    pendingVersionImports,
    isVersionImportBusy,
    versionImportComparison,
    versionImportComparingId,
    handleVersionImportCompare,
    closeVersionImportCompare,
    handleVersionImportDecision,
    settingsPanelKey,
    previewPolicy,
    extractCharacterAssets,
    hideCharacterAssets,
    hideChatDisplayRegex,
    showManuallyBoundResources,
    showPerformanceMonitor,
    hiddenCharacterAssetCount,
    applyRemotePreviewPolicy,
    applyScriptPreviewPolicy,
    applyGreetingPreviewPreload,
    applyBeautificationPreviewPreload,
    applyIncreasedPreviewDownloads,
    applyExtractCharacterAssets,
    applyHideCharacterAssets,
    applyHideChatDisplayRegex,
    applyShowManuallyBoundResources,
    applyBlurThumbnails,
    applyAutoDownloadDiscordShareLinks,
    applyPersistResourceVersionMatchCache,
    applySkipVersionComparisonOnImport,
    applySameNameVersionCandidates,
    updatePerformanceMonitorVisibility,
    openFolderSettings,
    openVaultSettings,
    openVersionRecognition,
    handleManualUpdateCheck,
    categoryManagerKey,
    handleCategoryCreate,
    handleCategoryUpdate,
    handleCategoryVisibility,
    handleCategoryDelete,
    openRestorePanel,
    handleExport,
    isRestorePanelOpen,
    preparedRestore,
    restoreReport,
    isRestoring,
    isRestorePreflighting,
    stopRestoreInspection,
    restoreEntry,
    completedRestoreMode,
    handleRestoreInspect,
    handleRestoreConfirm,
    closeRestorePanel,
    isVaultPanelOpen,
    isVaultBusy,
    handleVaultUnlock,
    handleVaultEnable,
    handleVaultDisable,
    handleVaultLock,
    isVersionRecognitionOpen,
    refreshLibraryAndOpenVersions,
  }
}
