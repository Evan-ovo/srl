import type { ComputedRef, Ref } from 'vue'
import { onMounted, onUnmounted, watch } from 'vue'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'
import {
  browserStorageService,
  initializeVaultOnce,
  resourceService,
  greetingResourceService,
  syncNativeResourceFiles,
} from '../core/LibraryContainer'
import { markStartupReady } from '../core/SafeStartup'
import { noticeCenter } from '../core/NoticeCenter'
import { reportHandledError, type HandledErrorCode } from '../core/FatalErrorNotice'
import type { FilterValue, SortValue } from '../types/AppView'
import type { UiFontScale } from '../types/BrowserPreferences'
import { type ResourceSummary } from '../types/Resource'
import type { VaultStatus } from '../types/Vault'
import type { ThemeValue } from '../utils/LibraryFormatting'
import {
  allowDiscordAttachmentRetry,
  clearShareTargetQuery,
  forgetCompletedDiscordAttachment,
  takeSharedFileBatches,
} from '../utils/ShareTargetIntake'
import type { SharedFileBatch } from '../utils/ShareTargetIntake'
import type { SearchScope } from './UseSearchIndex'
import { useDiscordResourceInbox } from './UseDiscordResourceInbox'
import { installWebInboxNotificationNavigation } from '../services/WebDiscordInboxNotifications'

interface LibraryLifecycleContext {
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
  receiveSharedFileBatch: (batch: SharedFileBatch) => void
  handleNativeDownloadState?: (event: Event) => boolean | void
  loadResources: (ids?: string[]) => Promise<void>
  refreshStorageHealth: () => Promise<void>
  vaultStatus: Ref<VaultStatus>
  searchQuery: Ref<string, string>
  searchHistory: Ref<string[], string[]>
  isVaultPanelOpen: Ref<boolean, boolean>
  loadLibrary: () => Promise<void>
  loadRecycleBin: () => Promise<void>
  handleNativeDeepLink: (event?: Event) => Promise<void>
  isOverlayOpen: ComputedRef<boolean>
  searchScope: Ref<SearchScope, SearchScope>
  activeFilter: Ref<FilterValue>
  activeCategoryId: Ref<string | null | undefined>
  activeTag: Ref<string, string>
  sortValue: Ref<SortValue>
  pageSize: Ref<number, number>
  currentPage: Ref<number, number>
  refreshSearchContentIndex: (items: ResourceSummary[]) => Promise<void>
  resources: Ref<ResourceSummary[]>
  selectedSplitResourceId: Ref<string | undefined>
  isFeatureHubOpen: Ref<boolean, boolean>
  saveWorkspaceSnapshot: () => void
  totalPages: ComputedRef<number>
  applyTheme: (value: ThemeValue) => void
  theme: Ref<ThemeValue, ThemeValue>
  applyUiFontScale: (value: UiFontScale) => void
  uiFontScale: Ref<'small' | 'standard' | 'large', 'small' | 'standard' | 'large'>
  handleGlobalKeydown: (event: KeyboardEvent) => void
  handleBackRequest: (event: Event) => void
  handleBrowserPopState: () => void
  updateSplitViewport: () => void
  handleNativeShortcut: (event?: Event) => void
  handleMobileFocus: (event: FocusEvent) => void
  syncCustomUiCss: () => void
}

export function useLibraryLifecycle(context: LibraryLifecycleContext) {
  useDiscordResourceInbox(
    context.vaultStatus,
    context.receiveSharedFileBatch,
    context.loadResources,
  )
  let searchIndexTimer: number | undefined
  let cloudBackupTimer: number | undefined
  let libraryMaintenanceTimer: number | undefined
  let consumingSharedFiles = false
  let sharedFilesRequested = false
  let disposed = false
  let resumeMaintenance: (() => void) | undefined
  let maintenanceRun: Promise<void> | undefined
  let stopGreetingUpdates: (() => void) | undefined
  let removeNotificationNavigation: (() => void) | undefined
  let startupFailureCode: HandledErrorCode = 'SRL-LIBRARY-VAULT-INIT'
  let maintenanceFailureCode: HandledErrorCode = 'SRL-LIBRARY-MAINTENANCE-THUMBNAILS'
  const maintenanceInterrupted = new DOMException('Maintenance paused or stopped', 'AbortError')

  function reportFailure(
    code: HandledErrorCode,
    error: unknown,
    notify = true,
  ): string | undefined {
    if (disposed) return
    const message = reportHandledError(code, error)
    if (notify && message) context.showNotice(message)
    return message
  }

  function handleDiscordDownloadFailure(event: Event): void {
    if (context.handleNativeDownloadState?.(event) === false) return
    const token = (event as CustomEvent<{ token?: string }>).detail?.token
    if (!token) return
    allowDiscordAttachmentRetry(token)
    void consumeSharedFiles()
  }

  function handleDiscordDownloadComplete(event: Event): void {
    if (context.handleNativeDownloadState?.(event) === false) return
    const token = (event as CustomEvent<{ token?: string }>).detail?.token
    if (token) forgetCompletedDiscordAttachment(token)
  }

  function handleDiscordDownloadStarted(event: Event): void {
    context.handleNativeDownloadState?.(event)
  }

  async function consumeSharedFiles(): Promise<void> {
    sharedFilesRequested = true
    if (consumingSharedFiles) return
    consumingSharedFiles = true
    const arrivedViaShare = new URLSearchParams(window.location.search).has('share-target')
    try {
      clearShareTargetQuery()
      let received = false
      do {
        sharedFilesRequested = false
        const batches = await takeSharedFileBatches((detail) =>
          context.handleNativeDownloadState?.(
            new CustomEvent('srl:native-share-download-started', { detail }),
          ),
        )
        for (const batch of batches) {
          received = true
          context.receiveSharedFileBatch(batch)
          // Deliver URL confirmations before reading unrelated file contents.
          // A failed file read must not discard already accepted URL batches.
          if (batch.discordAttachment) sharedFilesRequested = true
        }
      } while (sharedFilesRequested && !disposed)
      if (!received && arrivedViaShare)
        context.showNotice('分享跳转已到达，但没有收到文件；请重新分享或使用“导入资源”。')
    } catch (error) {
      context.showNotice(
        error instanceof Error ? error.message : '读取系统分享文件失败；文件已保留，可稍后重试',
      )
    } finally {
      consumingSharedFiles = false
    }
  }

  async function maintenanceCheckpoint(wait = false): Promise<void> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    while (
      !disposed &&
      !context.vaultStatus.value.locked &&
      (context.isOverlayOpen.value || context.isFeatureHubOpen.value)
    ) {
      // Do not retain a metadata snapshot across a foreground edit/import.
      // Restart the idempotent pass after the user finishes instead.
      if (!wait) throw maintenanceInterrupted
      await new Promise<void>((resolve) => {
        resumeMaintenance = resolve
      })
    }
    if (disposed || context.vaultStatus.value.locked) throw maintenanceInterrupted
  }

  watch(
    [context.isOverlayOpen, context.isFeatureHubOpen, () => context.vaultStatus.value.locked],
    () => {
      resumeMaintenance?.()
      resumeMaintenance = undefined
    },
  )

  async function maintainLibrary(): Promise<void> {
    await maintenanceCheckpoint(true)
    maintenanceFailureCode = 'SRL-LIBRARY-MAINTENANCE-THUMBNAILS'
    const thumbnailRepairCount = await resourceService.repairThumbnailAssets()
    await maintenanceCheckpoint()
    maintenanceFailureCode = 'SRL-LIBRARY-MAINTENANCE-SUMMARIES'
    const snapshot = await resourceService.listResourceListSummaries()
    maintenanceFailureCode = 'SRL-LIBRARY-MAINTENANCE-UPGRADE'
    const upgradedCount = await resourceService.upgradeLegacyJsonResources(
      maintenanceCheckpoint,
      snapshot,
    )
    // A real upgrade changed content/metadata: backfill must obtain the committed new snapshot.
    maintenanceFailureCode = 'SRL-LIBRARY-MAINTENANCE-FINGERPRINTS'
    const backfilledCount = await resourceService.backfillCardFingerprints(
      maintenanceCheckpoint,
      upgradedCount ? undefined : snapshot,
    )
    if (thumbnailRepairCount > 0 || upgradedCount > 0 || backfilledCount > 0) {
      maintenanceFailureCode = 'SRL-LIBRARY-MAINTENANCE-REFRESH'
      await context.loadResources()
    }
  }

  function runLibraryMaintenance(): Promise<void> {
    if (!maintenanceRun)
      maintenanceRun = (async () => {
        while (!disposed && !context.vaultStatus.value.locked) {
          try {
            await maintainLibrary()
            return
          } catch (error) {
            // Only our foreground pause restarts the pass. A cancelled storage
            // operation must not become an automatic retry loop.
            if (error !== maintenanceInterrupted) throw error
          }
        }
      })().finally(() => {
        maintenanceRun = undefined
      })
    return maintenanceRun
  }

  function scheduleLibraryMaintenance(): void {
    if (libraryMaintenanceTimer !== undefined) window.clearTimeout(libraryMaintenanceTimer)
    libraryMaintenanceTimer = window.setTimeout(() => {
      libraryMaintenanceTimer = undefined
      void runLibraryMaintenance().catch((error) => {
        reportFailure(maintenanceFailureCode, error, false)
      })
    }, 0)
  }

  async function initializeLibrary(): Promise<void> {
    const status = await initializeVaultOnce()
    if (disposed) return
    context.vaultStatus.value = status
    if (context.vaultStatus.value.locked) {
      browserStorageService.clearSearchHistory()
      context.searchQuery.value = ''
      context.searchHistory.value = []
      context.isVaultPanelOpen.value = true
      return
    }
    startupFailureCode = 'SRL-LIBRARY-LOAD'
    await context.loadLibrary()
    if (disposed) return
    markStartupReady()
    // The usable library must not wait for recycle-bin contents or quota probes.
    void (async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      if (disposed || context.vaultStatus.value.locked) return
      const results = await Promise.allSettled([
        context.refreshStorageHealth(),
        context.loadRecycleBin(),
      ])
      const codes: HandledErrorCode[] = ['SRL-LIBRARY-STORAGE-HEALTH', 'SRL-LIBRARY-RECYCLE-LOAD']
      const messages = results.flatMap((result, index) => {
        const message =
          result.status === 'rejected'
            ? reportFailure(codes[index]!, result.reason, false)
            : undefined
        return message ? [message] : []
      })
      if (messages.length) context.showNotice(messages.join('\n'))
    })()
    startupFailureCode = 'SRL-LIBRARY-DEEP-LINK'
    await context.handleNativeDeepLink()
    await consumeSharedFiles()
    if (disposed) return
    scheduleLibraryMaintenance()
    startupFailureCode = 'SRL-LIBRARY-BACKUP-LOAD'
    const { cloudBackupService } = await import('../core/AppContainer')
    void cloudBackupService
      .pendingNativeRestores()
      .then((records) => {
        if (disposed) return
        for (const record of records) {
          if (!record.restore) continue
          noticeCenter.push({
            id: 'cloud-restore:' + record.id,
            type: 'warning',
            persistent: true,
            message: '上次云恢复尚未完成本机导入',
            details: record.restore.item.objectKey,
            actions: [
              {
                label: '查看并继续',
                run: () => {
                  window.dispatchEvent(
                    new CustomEvent('srl:native-deep-link', { detail: { kind: 'backup' } }),
                  )
                },
              },
            ],
          })
        }
      })
      .catch((error) => reportFailure('SRL-BACKUP-CHECKPOINT-READ', error))
    // Settle completed receipts independently; starting a backup still requires both checks.
    const settleStartup = (operation: Promise<unknown>, code: HandledErrorCode) =>
      operation.then(
        () => true,
        (error) => {
          reportFailure(code, error)
          return false
        },
      )
    void Promise.all([
      settleStartup(cloudBackupService.reconcileNativeJob(), 'SRL-BACKUP-RECEIPT-RECONCILE'),
      settleStartup(syncNativeResourceFiles(), 'SRL-BACKUP-NATIVE-FILE-SYNC'),
    ])
      .then((results) => {
        if (!disposed && results.every(Boolean)) return cloudBackupService.runDueBackup()
      })
      .catch((error) => reportFailure('SRL-BACKUP-AUTO-START', error))
  }

  watch(
    context.isOverlayOpen,
    (open) => {
      document.body.classList.toggle('modal-open', open)
      document.documentElement.classList.toggle('modal-open', open)
    },
    { immediate: true },
  )

  watch(
    [
      context.searchQuery,
      context.searchScope,
      context.activeFilter,
      context.activeCategoryId,
      context.activeTag,
      context.sortValue,
      context.pageSize,
    ],
    () => {
      context.currentPage.value = 1
    },
  )

  watch([context.searchQuery, context.searchScope], ([query, scope]) => {
    if (searchIndexTimer !== undefined) window.clearTimeout(searchIndexTimer)
    if (scope !== 'content' || !query.trim()) return
    searchIndexTimer = window.setTimeout(() => {
      void context.refreshSearchContentIndex(context.resources.value)
    }, 220)
  })

  watch(
    [
      context.activeFilter,
      context.activeCategoryId,
      context.activeTag,
      context.sortValue,
      context.currentPage,
      context.selectedSplitResourceId,
      context.isFeatureHubOpen,
    ],
    context.saveWorkspaceSnapshot,
  )

  watch(context.totalPages, (value) => {
    if (context.currentPage.value > value) context.currentPage.value = value
  })

  context.applyTheme(context.theme.value)

  context.applyUiFontScale(context.uiFontScale.value)

  // Apply persisted global CSS before Vue paints the library; post-mount
  // injection makes the first layout differ from the settled layout.
  context.syncCustomUiCss()

  onMounted(() => {
    stopGreetingUpdates = greetingResourceService.onSaved((resourceId, changed) => {
      if (!changed) return
      void context
        .loadResources([resourceId])
        .catch((error) => reportFailure('SRL-LIBRARY-GREETING-REFRESH', error))
    })
    window.addEventListener('keydown', context.handleGlobalKeydown)
    window.addEventListener(SRL_BACK_REQUEST_EVENT, context.handleBackRequest)
    window.addEventListener('popstate', context.handleBrowserPopState)
    window.history.pushState({ ...(window.history.state ?? {}), srlBackGuard: true }, '')
    window.addEventListener('resize', context.updateSplitViewport)
    window.addEventListener('srl:native-share', consumeSharedFiles)
    window.addEventListener('srl:native-share-download-started', handleDiscordDownloadStarted)
    window.addEventListener('srl:native-share-download-failed', handleDiscordDownloadFailure)
    window.addEventListener('srl:native-share-download-completed', handleDiscordDownloadComplete)
    window.addEventListener('srl:native-shortcut', context.handleNativeShortcut)
    window.addEventListener('srl:native-deep-link', context.handleNativeDeepLink)
    // Install only after the navigation owner is listening, including a cold PWA notification open.
    removeNotificationNavigation = installWebInboxNotificationNavigation()
    window.addEventListener('pagehide', context.saveWorkspaceSnapshot)
    context.handleNativeShortcut()
    document.addEventListener('focusin', context.handleMobileFocus)
    context.updateSplitViewport()
    cloudBackupTimer = window.setInterval(
      () =>
        void import('../core/AppContainer')
          .then(({ cloudBackupService }) => cloudBackupService.runDueBackup())
          .catch((error) => reportFailure('SRL-BACKUP-AUTO-START', error, false)),
      60 * 1000,
    )
    void initializeLibrary()
      .then(markStartupReady)
      .catch((error) => reportFailure(startupFailureCode, error))
  })

  onUnmounted(() => {
    disposed = true
    resumeMaintenance?.()
    stopGreetingUpdates?.()
    if (searchIndexTimer !== undefined) window.clearTimeout(searchIndexTimer)
    if (libraryMaintenanceTimer !== undefined) window.clearTimeout(libraryMaintenanceTimer)
    if (cloudBackupTimer !== undefined) window.clearInterval(cloudBackupTimer)
    window.removeEventListener('keydown', context.handleGlobalKeydown)
    window.removeEventListener(SRL_BACK_REQUEST_EVENT, context.handleBackRequest)
    window.removeEventListener('popstate', context.handleBrowserPopState)
    window.removeEventListener('resize', context.updateSplitViewport)
    window.removeEventListener('srl:native-share', consumeSharedFiles)
    window.removeEventListener('srl:native-share-download-started', handleDiscordDownloadStarted)
    window.removeEventListener('srl:native-share-download-failed', handleDiscordDownloadFailure)
    window.removeEventListener('srl:native-share-download-completed', handleDiscordDownloadComplete)
    window.removeEventListener('srl:native-shortcut', context.handleNativeShortcut)
    window.removeEventListener('srl:native-deep-link', context.handleNativeDeepLink)
    removeNotificationNavigation?.()
    window.removeEventListener('pagehide', context.saveWorkspaceSnapshot)
    context.saveWorkspaceSnapshot()
    document.removeEventListener('focusin', context.handleMobileFocus)
    document.body.classList.remove('modal-open')
    document.documentElement.classList.remove('modal-open')
  })
  return {
    consumeSharedFiles,
    runLibraryMaintenance,
    scheduleLibraryMaintenance,
    initializeLibrary,
  }
}
