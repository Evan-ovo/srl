import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  clear: vi.fn(),
  info: vi.fn(),
  health: vi.fn(),
  confirm: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  migrate: vi.fn(),
  repair: vi.fn(),
  repairOldPngThumbnails: vi.fn(),
  getOldPngThumbnailStatus: vi.fn(),
  lock: vi.fn(),
  unlock: vi.fn(),
  legacy: vi.fn(),
  clearLegacy: vi.fn(),
  retained: vi.fn(),
  clearRetained: vi.fn(),
  preserveCopy: vi.fn(),
}))
vi.mock('../storage/AndroidNativeDexieCore', () => ({
  isAndroidNativeAppDatabaseActive: () => true,
}))
vi.mock('../storage/AndroidNativeAppDatabaseRuntime', () => ({
  canRetryAndroidNativeAppDatabaseMigration: () => false,
  requestAndroidNativeAppDatabaseMigrationRetry: vi.fn(),
  getRetainedIndexedDbCopy: native.retained,
  clearRetainedIndexedDbCopy: native.clearRetained,
}))
vi.mock('../core/LibraryContainer', () => ({
  database: { name: 'test-database' },
  recycleBinService: { preserveLegacyDatabaseCopy: native.preserveCopy },
  browserStorageService: {
    getHealth: native.health,
    legacyLibraryHistoryCleanup: native.legacy,
    clearLegacyLibraryHistory: native.clearLegacy,
  },
  communitySourceStorage: { migrateVaultMode: native.migrate },
  resourceService: {
    repairThumbnailAssets: native.repair,
    getMissingPngThumbnailRepairStatus: native.getOldPngThumbnailStatus,
    repairMissingPngCharacterCardThumbnails: native.repairOldPngThumbnails,
  },
  vaultService: {
    enable: native.enable,
    disable: native.disable,
    lock: native.lock,
    unlock: native.unlock,
    getStatus: () => ({ enabled: false, locked: false }),
  },
}))
vi.mock('../storage/NativeResourceFileMirror', () => ({
  clearNativeTemporaryCaches: native.clear,
  getNativeResourceStorageInfo: native.info,
}))
vi.mock('./UseConfirmDialog', () => ({ confirmAction: native.confirm }))

import { useLibraryProtection } from './UseLibraryProtection'
import { domainEvents } from '../core/DomainEvents'
import { taskCenter } from '../core/TaskCenter'

it('stops thumbnail preparation at its safe boundary and ignores a late successful result until explicit resume', async () => {
  let finish!: (count: number) => void
  let signal!: AbortSignal
  native.repairOldPngThumbnails.mockImplementationOnce((options: { signal: AbortSignal }) => {
    signal = options.signal
    return new Promise<number>((resolve) => {
      finish = resolve
    })
  })
  const { protection, context } = createProtection()
  const running = protection.repairOldPngThumbnails()
  const task = taskCenter.active().find((task) => task.name === '准备列表缩略图')!
  expect(task).toBeDefined()
  taskCenter.cancel(task.operationId)
  expect(signal.aborted).toBe(true)
  expect(protection.isRepairingOldPngThumbnails.value).toBe(true)
  finish(1)
  await running
  expect(protection.isRepairingOldPngThumbnails.value).toBe(false)
  expect(context.loadResources).not.toHaveBeenCalled()
  expect(taskCenter.list().find((item) => item.operationId === task.operationId)?.status).toBe(
    'cancelled',
  )
  createProtection()
  expect(native.repairOldPngThumbnails).toHaveBeenCalledTimes(1)
  await protection.repairOldPngThumbnails()
  expect(native.repairOldPngThumbnails).toHaveBeenCalledTimes(2)
  expect(native.repairOldPngThumbnails.mock.calls[1]![0].signal.aborted).toBe(false)
})

function createProtection() {
  const context = {
    isNativeApk: true,
    isClearingNativeCache: ref(false),
    storageHealth: ref({}),
    nativeStorageInfo: ref(null),
    showNotice: vi.fn(),
    isDataProtectionOpen: ref(true),
    isVaultPanelOpen: ref(false),
    vaultStatus: ref({ enabled: false, locked: false }),
    isVaultBusy: ref(false),
    loadResources: vi.fn(),
    loadRecycleBin: vi.fn(),
    clearSearchHistory: vi.fn(),
    resetSearchState: vi.fn(),
    resources: ref([]),
    categories: ref([]),
    recycleBinEntries: ref([]),
    recycleUndoEntry: ref(),
  }
  const protection = useLibraryProtection(
    () => context as unknown as ReturnType<Parameters<typeof useLibraryProtection>[0]>,
  )
  return { context, protection }
}

beforeEach(() => {
  vi.resetAllMocks()
  native.retained.mockResolvedValue({ records: 3, counts: { resources: 3 } })
  native.legacy.mockResolvedValue({ records: [{ id: 'old', size: 100, createdAt: 1 }], bytes: 100 })
  native.getOldPngThumbnailStatus.mockResolvedValue({ status: 'not-started', repaired: 0 })
  native.repairOldPngThumbnails.mockResolvedValue(0)
})

describe('useLibraryProtection', () => {
  it('confirms old-copy cleanup before invoking the runtime and releases busy state on cancel', async () => {
    const { protection } = createProtection()
    native.confirm.mockResolvedValue(false)
    await protection.clearRetainedNativeCopy()
    expect(native.clearRetained).not.toHaveBeenCalled()
    expect(protection.isClearingRetainedNativeCopy.value).toBe(false)
    native.confirm.mockResolvedValue(true)
    await protection.clearRetainedNativeCopy()
    expect(native.clearRetained).toHaveBeenCalledWith(
      'test-database',
      { records: 3, counts: { resources: 3 } },
      expect.any(Function),
      undefined,
      expect.any(Function),
    )
    expect(protection.isClearingRetainedNativeCopy.value).toBe(false)
  })

  it('saves any old table to the existing recycle bin before reporting cleanup', async () => {
    const { protection, context } = createProtection()
    native.confirm.mockResolvedValue(true)
    const source = { stores: [{ name: 'settings', count: 3 }] }

    native.clearRetained.mockImplementation(async (_name, _plan, _progress, _native, preserve) => {
      await preserve(source)
    })
    await protection.clearRetainedNativeCopy()
    expect(native.preserveCopy).toHaveBeenCalledWith(source)
    expect(context.loadRecycleBin).toHaveBeenCalledOnce()
    expect(context.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('3 条旧记录和附件已保存到回收站'),
    )
  })

  it('runs the old PNG thumbnail scan only after an explicit request', async () => {
    const { context, protection } = createProtection()
    expect(native.repairOldPngThumbnails).not.toHaveBeenCalled()
    native.repairOldPngThumbnails.mockResolvedValue(3)

    await protection.repairOldPngThumbnails()

    expect(native.repairOldPngThumbnails).toHaveBeenCalledOnce()
    expect(native.repairOldPngThumbnails).toHaveBeenCalledWith({
      restart: true,
      signal: expect.any(AbortSignal),
    })
    expect(context.loadResources).toHaveBeenCalledOnce()
    expect(context.showNotice).toHaveBeenCalledWith('已准备 3 张列表缩略图')
    expect(protection.isRepairingOldPngThumbnails.value).toBe(false)
  })

  it('explicitly restarts a completed old PNG thumbnail scan', async () => {
    native.getOldPngThumbnailStatus.mockResolvedValue({ status: 'complete', repaired: 2 })
    const { context, protection } = createProtection()
    await protection.refreshOldPngThumbnailRepairStatus()
    await protection.repairOldPngThumbnails()

    expect(native.repairOldPngThumbnails).toHaveBeenCalledWith({
      restart: true,
      signal: expect.any(AbortSignal),
    })
    expect(context.loadResources).not.toHaveBeenCalled()
  })

  it('reserves legacy cleanup before confirmation, rejects repeated clicks and vault conversion, and cancels without deleting', async () => {
    let resolve!: (confirmed: boolean) => void
    native.confirm.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done
      }),
    )
    const { context, protection } = createProtection()
    const first = protection.clearLegacyLibraryHistory()
    await vi.waitFor(() => expect(native.confirm).toHaveBeenCalledOnce())
    await protection.clearLegacyLibraryHistory()
    await protection.handleVaultEnable('test-password')
    await protection.handleVaultDisable()
    protection.handleVaultLock()
    expect(protection.isClearingLegacyLibraryHistory.value).toBe(true)
    expect(native.confirm).toHaveBeenCalledOnce()
    expect(native.enable).not.toHaveBeenCalled()
    expect(native.lock).not.toHaveBeenCalled()
    resolve(false)
    await first
    expect(native.clearLegacy).not.toHaveBeenCalled()
    expect(protection.isClearingLegacyLibraryHistory.value).toBe(false)
    expect(context.isVaultBusy.value).toBe(false)
  })

  it('does not clean during conversion and releases cleanup after a failed deletion', async () => {
    native.confirm.mockResolvedValue(true)
    native.clearLegacy.mockRejectedValue(new Error('范围已变化'))
    const { context, protection } = createProtection()
    context.isVaultBusy.value = true
    await protection.clearLegacyLibraryHistory()
    expect(native.confirm).not.toHaveBeenCalled()
    context.isVaultBusy.value = false
    await protection.clearLegacyLibraryHistory()
    expect(context.showNotice).toHaveBeenCalledWith('范围已变化')
    expect(protection.isClearingLegacyLibraryHistory.value).toBe(false)
    expect(protection.legacyLibraryHistory.value.records).toHaveLength(1)
    native.clearLegacy.mockResolvedValue(100)
    native.info.mockResolvedValue(null)
    native.health.mockResolvedValue({})
    await protection.clearLegacyLibraryHistory()
    expect(native.clearLegacy).toHaveBeenCalledTimes(2)
    expect(protection.legacyLibraryHistory.value.records).toHaveLength(0)
  })
  it('reserves conversion while confirmation is pending and releases it on cancellation', async () => {
    let resolve!: (confirmed: boolean) => void
    const confirmation = new Promise<boolean>((done) => {
      resolve = done
    })
    native.confirm.mockReturnValue(confirmation)
    const { context, protection } = createProtection()
    const first = protection.handleVaultEnable('test-password')
    const others = [
      protection.handleVaultDisable(),
      protection.handleVaultUnlock('test-password'),
      protection.handleVaultEnable('another-password'),
    ]
    const confirmCount = native.confirm.mock.calls.length
    const busy = context.isVaultBusy.value
    resolve(false)
    await Promise.all([first, ...others])
    expect(confirmCount).toBe(1)
    expect(busy).toBe(true)
    expect(native.unlock).not.toHaveBeenCalled()
    expect(native.enable).not.toHaveBeenCalled()
    expect(native.disable).not.toHaveBeenCalled()
    expect(context.isVaultBusy.value).toBe(false)
  })

  it('prevents disabling or locking until conversion and refresh finish', async () => {
    native.confirm.mockResolvedValue(true)
    let finish!: () => void
    native.enable.mockImplementation(
      () =>
        new Promise<void>((done) => {
          finish = done
        }),
    )
    const { context, protection } = createProtection()
    const first = protection.handleVaultEnable('test-password')
    await vi.waitFor(() => expect(native.enable).toHaveBeenCalledOnce())
    await protection.handleVaultDisable()
    protection.handleVaultLock()
    const busy = context.isVaultBusy.value
    finish()
    await first
    expect(native.disable).not.toHaveBeenCalled()
    expect(native.lock).not.toHaveBeenCalled()
    expect(busy).toBe(true)
    expect(native.migrate).toHaveBeenCalledExactlyOnceWith('encrypted')
    expect(context.isVaultBusy.value).toBe(false)
  })

  it('does not queue a second cache clear during confirmation', async () => {
    let resolve!: (confirmed: boolean) => void
    const confirmation = new Promise<boolean>((done) => {
      resolve = done
    })
    native.confirm.mockReturnValue(confirmation)
    const { context, protection } = createProtection()
    const first = protection.clearNativeTemporaryStorage()
    const second = protection.clearNativeTemporaryStorage()
    const count = native.confirm.mock.calls.length
    const busy = context.isClearingNativeCache.value
    resolve(false)
    await Promise.all([first, second])
    expect(count).toBe(1)
    expect(busy).toBe(true)
    expect(native.clear).not.toHaveBeenCalled()
    expect(context.isClearingNativeCache.value).toBe(false)
  })

  it('releases conversion state after failure and permits a later confirmed attempt', async () => {
    native.confirm.mockResolvedValue(true)
    native.enable.mockRejectedValueOnce(new Error('encrypt failed')).mockResolvedValue(undefined)
    const { context, protection } = createProtection()
    await protection.handleVaultEnable('test-password')
    expect(context.isVaultBusy.value).toBe(false)
    expect(context.showNotice).toHaveBeenCalledWith('encrypt failed')
    expect(native.migrate).not.toHaveBeenCalled()
    await protection.handleVaultEnable('test-password')
    expect(native.enable).toHaveBeenCalledTimes(2)
    expect(native.migrate).toHaveBeenCalledExactlyOnceWith('encrypted')
    expect(context.isVaultBusy.value).toBe(false)
  })
  it('publishes the new storage measurement after one confirmed cache clear', async () => {
    native.confirm.mockResolvedValue(true)
    native.clear.mockResolvedValue(42 * 1024)
    native.info.mockResolvedValue({ totalBytes: 530 })
    native.health.mockResolvedValue({})
    const listener = vi.fn()
    const unsubscribe = domainEvents.on('NativeTemporaryCachesCleared', listener)
    try {
      const { context, protection } = createProtection()
      await protection.clearNativeTemporaryStorage()
      expect(native.clear).toHaveBeenCalledOnce()
      expect(native.info).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledWith({
        storage: { totalBytes: 530 },
        measuredAt: expect.any(Number),
      })
      expect(context.nativeStorageInfo.value).toEqual({ totalBytes: 530 })
      expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('42.0 KB'))
      expect(context.isClearingNativeCache.value).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('does not clear or announce a measurement when confirmation is cancelled', async () => {
    native.confirm.mockResolvedValue(false)
    const { protection } = createProtection()
    await protection.clearNativeTemporaryStorage()
    expect(native.clear).not.toHaveBeenCalled()
    expect(native.info).not.toHaveBeenCalled()
  })

  it('opens the vault without reading an archive or changing encryption', () => {
    const { context, protection } = createProtection()
    protection.openVaultPanel()
    expect(context.isDataProtectionOpen.value).toBe(false)
    expect(context.isVaultPanelOpen.value).toBe(true)
    expect(native.enable).not.toHaveBeenCalled()
    expect(native.disable).not.toHaveBeenCalled()
  })

  it('enables encryption after confirmation and refreshes resources without an archive service', async () => {
    native.confirm.mockResolvedValue(true)
    const { context, protection } = createProtection()
    await protection.handleVaultEnable('test-password')
    expect(native.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '开启本地保险库', confirmLabel: '开启加密' }),
    )
    expect(native.enable).toHaveBeenCalledWith('test-password')
    expect(native.migrate).toHaveBeenCalledWith('encrypted')
    expect(context.loadResources).toHaveBeenCalledOnce()
    expect(context.loadRecycleBin).toHaveBeenCalledOnce()
    expect(context.showNotice).toHaveBeenCalledWith('本地数据已完成 AES-256-GCM 加密')
    expect(context.isVaultBusy.value).toBe(false)
  })

  it('keeps encryption unchanged when either conversion is cancelled', async () => {
    native.confirm.mockResolvedValue(false)
    const { protection } = createProtection()
    await protection.handleVaultEnable('test-password')
    await protection.handleVaultDisable()
    expect(native.enable).not.toHaveBeenCalled()
    expect(native.disable).not.toHaveBeenCalled()
    expect(native.migrate).not.toHaveBeenCalled()
  })

  it('disables encryption after confirmation and refreshes the decrypted library', async () => {
    native.confirm.mockResolvedValue(true)
    const { context, protection } = createProtection()
    await protection.handleVaultDisable()
    expect(native.disable).toHaveBeenCalledOnce()
    expect(native.migrate).toHaveBeenCalledWith('plain')
    expect(native.migrate.mock.invocationCallOrder[0]).toBeLessThan(
      native.disable.mock.invocationCallOrder[0]!,
    )
    expect(context.loadResources).toHaveBeenCalledOnce()
    expect(context.loadRecycleBin).toHaveBeenCalledOnce()
    expect(context.showNotice).toHaveBeenCalledWith('本地加密已关闭')
  })
})
