import { ref, type Ref, type ShallowRef } from 'vue'
import type { LegacyLibraryHistoryCleanup } from '../storage/IndexedDbResourceHealthStorage'
import { confirmAction } from '../composables/UseConfirmDialog'
import {
  database,
  browserStorageService,
  communitySourceStorage,
  resourceService,
  recycleBinService,
  vaultService,
} from '../core/LibraryContainer'
import { mutationGuard } from '../core/MutationGuard'
import { domainEvents } from '../core/DomainEvents'
import { taskCenter } from '../core/TaskCenter'
import type { StorageHealth } from '../services/BrowserStorageService'
import type { NativeResourceStorageInfo } from '../storage/NativeResourceFileMirror'
import {
  canRetryAndroidNativeAppDatabaseMigration,
  getRetainedIndexedDbCopy,
  clearRetainedIndexedDbCopy,
  type RetainedIndexedDbCopy,
  requestAndroidNativeAppDatabaseMigrationRetry,
} from '../storage/AndroidNativeAppDatabaseRuntime'
import { isAndroidNativeAppDatabaseActive } from '../storage/AndroidNativeDexieCore'
import type { MissingPngThumbnailRepairStatus } from '../storage/ResourceThumbnailMaintenance'
import type { BackupRecord } from '../types/Resource'
import { type Category, type ResourceSummary } from '../types/Resource'
import type { VaultStatus } from '../types/Vault'
import { formatBytes } from '../utils/LibraryFormatting'

interface LibraryProtectionContext {
  storageHealth: Ref<StorageHealth>
  nativeStorageInfo: Ref<NativeResourceStorageInfo | null>
  isNativeApk: boolean
  isClearingNativeCache: Ref<boolean, boolean>
  showNotice: (message: string, duration?: number, preserveRecycleUndo?: boolean) => void
  isRequestingPersistence: Ref<boolean, boolean>
  categories: Ref<Category[]>
  isDataProtectionOpen: Ref<boolean, boolean>
  isVaultPanelOpen: Ref<boolean, boolean>
  vaultStatus: Ref<VaultStatus>
  isVaultBusy: Ref<boolean, boolean>
  loadLibrary: () => Promise<void>
  loadRecycleBin: () => Promise<void>
  scheduleLibraryMaintenance: () => void
  clearSearchHistory: () => void
  loadResources: () => Promise<void>
  resetSearchState: () => void
  resources: Ref<ResourceSummary[]>
  recycleBinEntries: ShallowRef<BackupRecord[], BackupRecord[]>
  recycleUndoEntry: ShallowRef<BackupRecord | undefined, BackupRecord | undefined>
}

export function useLibraryProtection(getContext: () => LibraryProtectionContext) {
  const legacyLibraryHistory = ref<LegacyLibraryHistoryCleanup>({ records: [], bytes: 0 })
  const isClearingLegacyLibraryHistory = ref(false)
  const oldPngThumbnailRepairStatus = ref<MissingPngThumbnailRepairStatus>({
    status: 'not-started',
    repaired: 0,
  })
  const isRepairingOldPngThumbnails = ref(false)
  const isRetryingNativeMigration = ref(false)

  const canClearRetainedNativeCopy = isAndroidNativeAppDatabaseActive()
  const retainedNativeCopy = ref<RetainedIndexedDbCopy | null>(null)
  const isClearingRetainedNativeCopy = ref(false)
  const retainedNativeCopyProgress = ref('')

  async function refreshRetainedNativeCopy(): Promise<void> {
    if (!getContext().isNativeApk || !canClearRetainedNativeCopy) return
    try {
      retainedNativeCopy.value = await getRetainedIndexedDbCopy(database.name)
    } catch (error) {
      getContext().showNotice(error instanceof Error ? error.message : '无法读取旧迁移副本')
    }
  }

  async function clearRetainedNativeCopy(): Promise<void> {
    const context = getContext()
    if (
      !context.isNativeApk ||
      !canClearRetainedNativeCopy ||
      isClearingRetainedNativeCopy.value ||
      context.isVaultBusy.value
    )
      return
    isClearingRetainedNativeCopy.value = true
    try {
      await refreshRetainedNativeCopy()
      const plan = retainedNativeCopy.value
      if (!plan?.records) return
      const confirmed = await confirmAction({
        title: '清理迁移前的旧副本',
        message: `清理迁移前的 ${plan.records} 条旧记录及附件。先校验当前原生主库；无法确认已迁移的旧记录和完整附件会保存到回收站的“迁移前旧副本恢复档”，读回验证后才清理。旧设置、APP、聊天等内容有差异也能保存后清理，不覆盖当前库或权限。恢复档可手动恢复为文件并导出。请保持应用打开；大附件保存可能需要时间。`,
        confirmLabel: '校验并清理旧副本',
        danger: true,
      })
      if (!confirmed) return
      let checkedGroups = 0
      let preservedRecords = 0
      await clearRetainedIndexedDbCopy(
        database.name,
        plan,
        () => {
          checkedGroups += 1
          retainedNativeCopyProgress.value = `正在校验原生数据与附件（第 ${checkedGroups}/${Object.keys(plan.counts).length} 组）…`
        },
        undefined,
        async (source) => {
          retainedNativeCopyProgress.value = '正在保存旧副本恢复档并校验…'
          await recycleBinService.preserveLegacyDatabaseCopy(source)
          preservedRecords = source.stores.reduce((sum, store) => sum + store.count, 0)
        },
      )
      if (preservedRecords) await context.loadRecycleBin()
      context.showNotice(
        preservedRecords
          ? `旧副本已清理；${preservedRecords} 条旧记录和附件已保存到回收站的“迁移前旧副本恢复档”，当前数据和权限保持不变`
          : '迁移前的旧副本已清理；系统回收磁盘空间可能稍有延迟',
      )
      await refreshRetainedNativeCopy()
      await refreshStorageHealth()
    } catch (error) {
      context.showNotice(
        error instanceof Error ? error.message : '旧副本清理失败，原生主库不受影响',
      )
    } finally {
      isClearingRetainedNativeCopy.value = false
      retainedNativeCopyProgress.value = ''
    }
  }

  async function retryNativeMigration(): Promise<void> {
    const context = getContext()
    if (!context.isNativeApk || isRetryingNativeMigration.value) return
    const confirmed = await confirmAction({
      title: '重试原生资源库迁移',
      message:
        '应用将重启，并从保留的 IndexedDB 副本重新复制资源与附件。重试会清除未启用的原生迁移副本；原 IndexedDB 数据不会删除。请保持应用打开，并确保设备有足够的额外空间。',
      confirmLabel: '重启并重试',
    })
    if (!confirmed) return
    isRetryingNativeMigration.value = true
    try {
      await requestAndroidNativeAppDatabaseMigrationRetry()
      window.location.reload()
    } catch (error) {
      isRetryingNativeMigration.value = false
      context.showNotice(error instanceof Error ? error.message : '无法安排迁移重试')
    }
  }

  async function refreshOldPngThumbnailRepairStatus(): Promise<void> {
    try {
      oldPngThumbnailRepairStatus.value = await resourceService.getMissingPngThumbnailRepairStatus()
    } catch {
      getContext().showNotice('无法读取旧资源缩略图补回状态')
    }
  }

  let thumbnailPreparation:
    { controller: AbortController; taskId: string; operation?: Promise<number> } | undefined
  async function repairOldPngThumbnails(): Promise<void> {
    const context = getContext()
    if (thumbnailPreparation) {
      thumbnailPreparation.controller.abort()
      taskCenter.update(thumbnailPreparation.taskId, { phase: '正在停止，等待当前图片保存' })
      return
    }
    if (
      isRepairingOldPngThumbnails.value ||
      context.isVaultBusy.value ||
      context.vaultStatus.value.locked
    )
      return

    isRepairingOldPngThumbnails.value = true
    const controller = new AbortController()
    const taskId = taskCenter.start({
      name: '准备列表缩略图',
      phase: '补回缺图并准备卡片尺寸',
      cancelable: true,
      cancel: async () => {
        controller.abort()
        taskCenter.update(taskId, { phase: '正在停止，等待当前图片保存' })
        await thumbnailPreparation?.operation?.catch(() => undefined)
      },
    })
    thumbnailPreparation = { controller, taskId }
    try {
      const operation = resourceService.repairMissingPngCharacterCardThumbnails({
        // This is an explicit scan request. Storage resumes a running checkpoint
        // and only resets a completed scan, even if the displayed status is stale.
        restart: true,
        signal: controller.signal,
      })
      thumbnailPreparation.operation = operation
      const repaired = await operation
      controller.signal.throwIfAborted()
      await refreshOldPngThumbnailRepairStatus()
      if (repaired > 0) await context.loadResources()
      context.showNotice(
        repaired > 0 ? `已准备 ${repaired} 张列表缩略图` : '扫描完成，没有新增缩略图；现有封面保留',
      )
      taskCenter.complete(taskId)
    } catch (error) {
      await refreshOldPngThumbnailRepairStatus()
      if (controller.signal.aborted) {
        taskCenter.cancelled(taskId)
        context.showNotice('已停止准备，已完成的缩略图保留，可手动继续')
      } else {
        taskCenter.fail(taskId, error)
        context.showNotice(
          error instanceof Error ? error.message : '列表缩略图准备失败，可继续重试',
        )
      }
    } finally {
      thumbnailPreparation = undefined
      isRepairingOldPngThumbnails.value = false
    }
  }

  async function refreshLegacyLibraryHistory(): Promise<void> {
    try {
      legacyLibraryHistory.value = await browserStorageService.legacyLibraryHistoryCleanup()
    } catch (error) {
      getContext().showNotice('无法读取旧整库快照占用')
      throw error
    }
  }

  async function clearLegacyLibraryHistory(): Promise<void> {
    const context = getContext()
    if (isClearingLegacyLibraryHistory.value || context.isVaultBusy.value) return
    isClearingLegacyLibraryHistory.value = true
    try {
      await refreshLegacyLibraryHistory()
      const plan = {
        records: legacyLibraryHistory.value.records.map((record) => ({ ...record })),
        bytes: legacyLibraryHistory.value.bytes,
      }
      if (!plan.records.length) return
      const confirmed = await confirmAction({
        title: '清理旧整库快照',
        message: `永久删除 ${plan.records.length} 份旧整库快照（${formatBytes(plan.bytes)}），无法撤销。当前资源、单资源版本、回收站和云备份不受影响。`,
        confirmLabel: '永久清理',
      })
      if (!confirmed) return
      const bytes = await browserStorageService.clearLegacyLibraryHistory(plan)
      legacyLibraryHistory.value = { records: [], bytes: 0 }
      context.showNotice(
        `已清理 ${plan.records.length} 份旧整库快照（${formatBytes(bytes)}）；系统回收磁盘空间可能稍有延迟`,
      )
      await refreshStorageHealth()
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '旧整库快照清理失败')
      await refreshLegacyLibraryHistory().catch(() => undefined)
    } finally {
      isClearingLegacyLibraryHistory.value = false
    }
  }

  async function refreshStorageHealth(): Promise<void> {
    const context = getContext()

    const [health, nativeInfo] = await Promise.all([
      browserStorageService.getHealth(),
      context.isNativeApk
        ? import('../storage/NativeResourceFileMirror')
            .then(({ getNativeResourceStorageInfo }) => getNativeResourceStorageInfo())
            .catch(() => null)
        : Promise.resolve(null),
    ])
    context.storageHealth.value = health
    context.nativeStorageInfo.value = nativeInfo
  }

  async function clearNativeTemporaryStorage(): Promise<void> {
    const context = getContext()

    if (!context.isNativeApk || context.isClearingNativeCache.value) return
    context.isClearingNativeCache.value = true
    try {
      const confirmed = await confirmAction({
        title: '清理 APK 临时缓存',
        message:
          '清空 APK 的临时缓存和代码缓存，不会删除资源、历史版本、云端备份、网页数据库或登录信息。请先完成上传、下载、导入和恢复任务。',
        confirmLabel: '清理缓存',
      })
      if (!confirmed) return
      const { clearNativeTemporaryCaches } = await import('../storage/NativeResourceFileMirror')
      const clearedBytes = await clearNativeTemporaryCaches()
      await refreshStorageHealth()
      domainEvents.emit('NativeTemporaryCachesCleared', {
        storage: context.nativeStorageInfo.value,
        measuredAt: Date.now(),
      })
      context.showNotice(
        clearedBytes > 0
          ? `已清理 ${formatBytes(clearedBytes)} 临时缓存；网页容器中的数据库等数据未清理`
          : '没有可清理的 APK 临时缓存；网页容器中的数据库等数据未清理',
      )
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : 'APK 临时缓存清理失败')
    } finally {
      context.isClearingNativeCache.value = false
    }
  }

  async function requestPersistentStorage(): Promise<void> {
    const context = getContext()

    context.isRequestingPersistence.value = true
    try {
      context.storageHealth.value = await browserStorageService.requestPersistence()
      context.showNotice(
        context.storageHealth.value.persisted
          ? '浏览器已授予持久化存储保护'
          : '浏览器暂未授予持久化保护，建议定期完整备份',
      )
    } finally {
      context.isRequestingPersistence.value = false
    }
  }

  async function openVaultPanel(): Promise<void> {
    const context = getContext()

    context.isDataProtectionOpen.value = false
    context.isVaultPanelOpen.value = true
  }

  async function handleVaultUnlock(password: string): Promise<void> {
    const context = getContext()

    if (
      context.isVaultBusy.value ||
      isClearingLegacyLibraryHistory.value ||
      isClearingRetainedNativeCopy.value
    )
      return
    context.isVaultBusy.value = true
    try {
      await vaultService.unlock(password)
      await communitySourceStorage.migrateVaultMode('encrypted')
      context.vaultStatus.value = vaultService.getStatus()
      window.dispatchEvent(new Event('srl:vault-unlocked'))
      await Promise.all([context.loadLibrary(), context.loadRecycleBin()])
      context.isVaultPanelOpen.value = false
      context.scheduleLibraryMaintenance()
      context.showNotice('本地保险库已解锁')
    } catch (error) {
      context.showNotice(error instanceof Error ? error.message : '解锁失败')
    } finally {
      context.isVaultBusy.value = false
    }
  }

  async function handleVaultEnable(password: string): Promise<void> {
    const context = getContext()
    if (
      context.isVaultBusy.value ||
      isClearingLegacyLibraryHistory.value ||
      isClearingRetainedNativeCopy.value
    )
      return
    context.isVaultBusy.value = true
    try {
      const confirmed = await confirmAction({
        title: '开启本地保险库',
        message:
          '加密会转换当前设备上的全部资源。密码不会保存，忘记密码无法恢复。建议先导出完整备份。',
        confirmLabel: '开启加密',
        danger: true,
      })
      if (!confirmed) return
      await mutationGuard.run('vault:enable', () => performVaultEnable(password))
    } finally {
      context.isVaultBusy.value = false
    }
  }

  async function performVaultEnable(password: string): Promise<void> {
    const context = getContext()

    const operationId = taskCenter.start({
      name: '开启本地保险库',
      phase: '准备加密',
    })
    try {
      taskCenter.update(operationId, { phase: '整理缩略图存储' })
      await resourceService.repairThumbnailAssets()
      taskCenter.update(operationId, { phase: '分批加密本地数据' })
      await vaultService.enable(password)
      await communitySourceStorage.migrateVaultMode('encrypted')
      context.vaultStatus.value = vaultService.getStatus()
      context.clearSearchHistory()
      await Promise.all([context.loadResources(), context.loadRecycleBin()])
      taskCenter.complete(operationId)
      context.showNotice('本地数据已完成 AES-256-GCM 加密')
    } catch (error) {
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '开启加密失败')
    }
  }

  async function handleVaultDisable(): Promise<void> {
    const context = getContext()
    if (
      context.isVaultBusy.value ||
      isClearingLegacyLibraryHistory.value ||
      isClearingRetainedNativeCopy.value
    )
      return
    context.isVaultBusy.value = true
    try {
      const confirmed = await confirmAction({
        title: '关闭本地加密',
        message: '关闭后，本机资源将恢复为明文存储。确定继续吗？',
        confirmLabel: '关闭并解密',
        danger: true,
      })
      if (!confirmed) return
      await mutationGuard.run('vault:disable', () => performVaultDisable())
    } finally {
      context.isVaultBusy.value = false
    }
  }

  async function performVaultDisable(): Promise<void> {
    const context = getContext()

    const operationId = taskCenter.start({
      name: '关闭本地保险库',
      phase: '准备关闭加密',
    })
    try {
      taskCenter.update(operationId, { phase: '整理缩略图存储' })
      await resourceService.repairThumbnailAssets()
      taskCenter.update(operationId, { phase: '分批恢复明文数据' })
      await communitySourceStorage.migrateVaultMode('plain')
      await vaultService.disable()
      context.vaultStatus.value = vaultService.getStatus()
      await Promise.all([context.loadResources(), context.loadRecycleBin()])
      taskCenter.complete(operationId)
      context.showNotice('本地加密已关闭')
    } catch (error) {
      taskCenter.fail(operationId, error)
      context.showNotice(error instanceof Error ? error.message : '关闭加密失败')
    }
  }

  function handleVaultLock(): void {
    const context = getContext()

    if (
      context.isVaultBusy.value ||
      isClearingLegacyLibraryHistory.value ||
      isClearingRetainedNativeCopy.value
    )
      return
    vaultService.lock()
    context.vaultStatus.value = vaultService.getStatus()
    context.resetSearchState()
    context.resources.value = []
    context.categories.value = []
    context.recycleBinEntries.value = []
    context.recycleUndoEntry.value = undefined
    context.isVaultPanelOpen.value = true
  }

  return {
    canClearRetainedNativeCopy,
    retainedNativeCopy,
    isClearingRetainedNativeCopy,
    retainedNativeCopyProgress,
    refreshRetainedNativeCopy,
    clearRetainedNativeCopy,
    legacyLibraryHistory,
    isClearingLegacyLibraryHistory,
    oldPngThumbnailRepairStatus,
    isRepairingOldPngThumbnails,
    isRetryingNativeMigration,
    canRetryNativeMigration: canRetryAndroidNativeAppDatabaseMigration(),
    retryNativeMigration,
    refreshOldPngThumbnailRepairStatus,
    repairOldPngThumbnails,
    refreshLegacyLibraryHistory,
    clearLegacyLibraryHistory,
    refreshStorageHealth,
    clearNativeTemporaryStorage,
    requestPersistentStorage,
    openVaultPanel,
    handleVaultUnlock,
    handleVaultEnable,
    handleVaultDisable,
    handleVaultLock,
  }
}
