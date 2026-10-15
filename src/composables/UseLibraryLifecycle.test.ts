/** @vitest-environment jsdom */
import { computed, defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useLibraryLifecycle } from './UseLibraryLifecycle'
import type { SharedFileBatch } from '../utils/ShareTargetIntake'

const intake = vi.hoisted(() => ({ take: vi.fn(), retry: vi.fn(), complete: vi.fn() }))
const startup = vi.hoisted(() => ({
  initializeVaultOnce: vi.fn(() => new Promise<never>(() => undefined)),
  syncNativeResourceFiles: vi.fn((): Promise<void> => Promise.resolve()),
  reconcileNativeJob: vi.fn(async () => undefined),
  runDueBackup: vi.fn(async () => undefined),
  listSummaries: vi.fn(async (): Promise<never[]> => []),
  upgrade: vi.fn(async () => 0),
  backfill: vi.fn(async () => 0),
}))
vi.mock('../utils/ShareTargetIntake', () => ({
  takeSharedFileBatches: intake.take,
  clearShareTargetQuery: vi.fn(),
  allowDiscordAttachmentRetry: intake.retry,
  forgetCompletedDiscordAttachment: intake.complete,
}))
vi.mock('../core/LibraryContainer', () => ({
  initializeVaultOnce: startup.initializeVaultOnce,
  greetingResourceService: { onSaved: () => () => undefined },
  resourceService: {
    listSummaries: startup.listSummaries,
    repairThumbnailAssets: vi.fn(async () => 0),
    upgradeLegacyJsonResources: startup.upgrade,
    backfillCardFingerprints: startup.backfill,
  },
  browserStorageService: {},
  cloudBackupService: {},
  syncNativeResourceFiles: startup.syncNativeResourceFiles,
}))
vi.mock('../core/AppContainer', () => ({
  cloudBackupService: {
    pendingNativeRestores: vi.fn(async () => []),
    reconcileNativeJob: startup.reconcileNativeJob,
    runDueBackup: startup.runDueBackup,
  },
}))
vi.mock('../core/SafeStartup', () => ({ markStartupReady: vi.fn() }))

function mountLifecycle(onRender?: (cssSyncCount: number) => void) {
  const receive = vi.fn(),
    notice = vi.fn()
  const syncCustomUiCss = vi.fn()
  const context: Parameters<typeof useLibraryLifecycle>[0] = {
    showNotice: notice,
    receiveSharedFileBatch: receive,
    loadResources: vi.fn(),
    refreshStorageHealth: vi.fn(),
    vaultStatus: ref({ locked: false } as Parameters<
      typeof useLibraryLifecycle
    >[0]['vaultStatus']['value']),
    searchQuery: ref(''),
    searchHistory: ref([]),
    isVaultPanelOpen: ref(false),
    loadLibrary: vi.fn(),
    loadRecycleBin: vi.fn(),
    handleNativeDeepLink: vi.fn(),
    isOverlayOpen: computed(() => false),
    searchScope: ref('name'),
    activeFilter: ref('all'),
    activeCategoryId: ref(undefined),
    activeTag: ref(''),
    sortValue: ref('newest'),
    pageSize: ref(30),
    currentPage: ref(1),
    refreshSearchContentIndex: vi.fn(),
    resources: ref([]),
    selectedSplitResourceId: ref(undefined),
    isFeatureHubOpen: ref(false),
    saveWorkspaceSnapshot: vi.fn(),
    totalPages: computed(() => 1),
    applyTheme: vi.fn(),
    theme: ref('light'),
    applyUiFontScale: vi.fn(),
    uiFontScale: ref('standard'),
    handleGlobalKeydown: vi.fn(),
    handleBackRequest: vi.fn(),
    handleBrowserPopState: vi.fn(),
    updateSplitViewport: vi.fn(),
    handleNativeShortcut: vi.fn(),
    handleMobileFocus: vi.fn(),
    syncCustomUiCss,
  }
  let lifecycle!: ReturnType<typeof useLibraryLifecycle>
  const wrapper = mount(
    defineComponent({
      setup() {
        lifecycle = useLibraryLifecycle(context)
        return () => {
          onRender?.(syncCustomUiCss.mock.calls.length)
          return null
        }
      },
    }),
  )
  return { wrapper, lifecycle, receive, notice, context }
}
function empty(): SharedFileBatch {
  return { files: [], acknowledge: async () => undefined }
}
function attachment(index: number): SharedFileBatch {
  return {
    ...empty(),
    discordAttachment: {
      name: `${index}.json`,
      type: 'application/json',
      cleanupToken: `discord-url-${index}`,
      discordUrl: `https://cdn.discordapp.com/attachments/1/${index}/card.json`,
    },
  }
}

describe('系统分享待处理队列', () => {
  it.each([0, 1])(
    'shares the maintenance snapshot only when no content upgrade committed (%i)',
    async (upgraded) => {
      const snapshot = [{ id: 'snapshot' }] as never[]
      startup.initializeVaultOnce.mockImplementation(async () => ({ locked: false }) as never)
      startup.listSummaries.mockReset().mockResolvedValue(snapshot)
      startup.upgrade.mockReset().mockResolvedValue(upgraded)
      startup.backfill.mockReset().mockResolvedValue(0)
      intake.take.mockResolvedValue([])
      const { wrapper } = mountLifecycle()
      try {
        await vi.waitFor(() => expect(startup.backfill).toHaveBeenCalledOnce())
        expect(startup.listSummaries).toHaveBeenCalledOnce()
        expect(startup.upgrade.mock.calls[0]).toEqual([expect.any(Function), snapshot])
        expect(startup.backfill.mock.calls[0]).toEqual([
          expect.any(Function),
          upgraded ? undefined : snapshot,
        ])
      } finally {
        wrapper.unmount()
        startup.initializeVaultOnce
          .mockReset()
          .mockImplementation(() => new Promise<never>(() => undefined))
        startup.upgrade.mockReset().mockResolvedValue(0)
        startup.backfill.mockReset().mockResolvedValue(0)
        startup.listSummaries.mockReset().mockResolvedValue([])
        startup.syncNativeResourceFiles.mockClear()
        startup.reconcileNativeJob.mockClear()
        startup.runDueBackup.mockClear()
        intake.take.mockReset()
      }
    },
  )

  it.each(['sync', 'receipt'])('回执与对账独立开始，自动备份等待 %s 完成', async (pending) => {
    let finishSync!: () => void
    startup.initializeVaultOnce.mockImplementation(async () => ({ locked: false }) as never)
    const deferred =
      pending === 'sync' ? startup.syncNativeResourceFiles : startup.reconcileNativeJob
    deferred.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSync = resolve
        }),
    )
    startup.reconcileNativeJob.mockClear()
    startup.runDueBackup.mockClear()
    intake.take.mockResolvedValue([])
    const { wrapper } = mountLifecycle()
    try {
      await vi.waitFor(() => expect(startup.syncNativeResourceFiles).toHaveBeenCalledTimes(1))
      expect(startup.reconcileNativeJob).toHaveBeenCalledTimes(1)
      expect(startup.runDueBackup).not.toHaveBeenCalled()
      finishSync()
      await vi.waitFor(() => expect(startup.runDueBackup).toHaveBeenCalledTimes(1))
    } finally {
      wrapper.unmount()
      startup.initializeVaultOnce
        .mockReset()
        .mockImplementation(() => new Promise<never>(() => undefined))
      startup.syncNativeResourceFiles.mockReset().mockResolvedValue(undefined)
      startup.reconcileNativeJob.mockReset().mockResolvedValue(undefined)
      startup.runDueBackup.mockReset().mockResolvedValue(undefined)
      intake.take.mockReset()
    }
  })

  it.each(['sync', 'receipt'])('启动 %s 失败时不启动自动备份', async (failed) => {
    startup.initializeVaultOnce.mockImplementation(async () => ({ locked: false }) as never)
    const operation =
      failed === 'sync' ? startup.syncNativeResourceFiles : startup.reconcileNativeJob
    operation.mockRejectedValueOnce(new Error('startup fixture failure'))
    intake.take.mockResolvedValue([])
    const { wrapper, notice } = mountLifecycle()
    try {
      await vi.waitFor(() =>
        expect(notice).toHaveBeenCalledWith(expect.stringContaining('startup fixture failure')),
      )
      expect(startup.runDueBackup).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      startup.initializeVaultOnce
        .mockReset()
        .mockImplementation(() => new Promise<never>(() => undefined))
      startup.syncNativeResourceFiles.mockReset().mockResolvedValue(undefined)
      startup.reconcileNativeJob.mockReset().mockResolvedValue(undefined)
      startup.runDueBackup.mockReset().mockResolvedValue(undefined)
      intake.take.mockReset()
    }
  })

  it('首次渲染前应用已保存的全局 CSS', () => {
    intake.take.mockReset()
    intake.retry.mockReset()
    intake.complete.mockReset()
    const { wrapper } = mountLifecycle((cssSyncCount) => {
      expect(cssSyncCount).toBe(1)
    })
    wrapper.unmount()
    intake.take.mockReset()
    intake.retry.mockReset()
    intake.complete.mockReset()
  })

  it('rejected stale receipts cannot reset share deduplication or trigger another intake', () => {
    const { wrapper, context } = mountLifecycle()
    context.handleNativeDownloadState = () => false
    intake.retry.mockClear()
    intake.complete.mockClear()
    try {
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-failed', {
          detail: { token: 'old', workId: 'old-work' },
        }),
      )
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-completed', {
          detail: { token: 'old', workId: 'old-work' },
        }),
      )
      expect(intake.retry).not.toHaveBeenCalled()
      expect(intake.complete).not.toHaveBeenCalled()
      expect(intake.take).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
  it('无关文件读取失败不会丢弃已交付的 DC 下载确认', async () => {
    const link = attachment(300)
    intake.take.mockResolvedValueOnce([link]).mockRejectedValueOnce(new Error('文件读取失败'))
    const { wrapper, lifecycle, receive, notice } = mountLifecycle()
    try {
      await lifecycle.consumeSharedFiles()
      expect(receive).toHaveBeenCalledExactlyOnceWith(link)
      expect(notice).toHaveBeenCalledWith('文件读取失败')
    } finally {
      wrapper.unmount()
      intake.take.mockReset()
    }
  })
  it('单次到达事件取完多条 DC 链接并继续交付普通文件，不等待下载完成', async () => {
    const links = Array.from({ length: 200 }, (_, index) => attachment(index))
    const file = { ...empty(), files: [new File(['{}'], 'pending.json')] }
    intake.take.mockResolvedValueOnce(links).mockResolvedValueOnce([file])
    const { wrapper, lifecycle, receive } = mountLifecycle()
    try {
      await lifecycle.consumeSharedFiles()
      expect(receive.mock.calls.map(([batch]) => batch)).toEqual([...links, file])
      expect(intake.take).toHaveBeenCalledTimes(2)
    } finally {
      wrapper.unmount()
      intake.take.mockReset()
    }
  })

  it('读取期间新的 ready 事件会继续扫描，而不会被忙碌标记丢弃', async () => {
    let finish!: (batches: SharedFileBatch[]) => void
    intake.take.mockReturnValueOnce(
      new Promise<SharedFileBatch[]>((resolve) => {
        finish = resolve
      }),
    )
    const next = attachment(1)
    intake.take.mockResolvedValueOnce([next]).mockResolvedValueOnce([])
    const { wrapper, lifecycle, receive } = mountLifecycle()
    try {
      const scan = lifecycle.consumeSharedFiles()
      await lifecycle.consumeSharedFiles()
      finish([])
      await scan
      expect(receive).toHaveBeenCalledExactlyOnceWith(next)
      expect(intake.take).toHaveBeenCalledTimes(3)
    } finally {
      wrapper.unmount()
      intake.take.mockReset()
    }
  })
})
