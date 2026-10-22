/** @vitest-environment jsdom */
import { computed, defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryLifecycle } from './UseLibraryLifecycle'
import type { SharedFileBatch } from '../utils/ShareTargetIntake'

const intake = vi.hoisted(() => ({ take: vi.fn(), retry: vi.fn(), complete: vi.fn() }))
const greetings = vi.hoisted(() => new Set<(resourceId: string, changed: boolean) => void>())
const startup = vi.hoisted(() => ({
  initializeVaultOnce: vi.fn(() => new Promise<never>(() => undefined)),
  syncNativeResourceFiles: vi.fn((): Promise<void> => Promise.resolve()),
  reconcileNativeJob: vi.fn(async () => undefined),
  runDueBackup: vi.fn(async () => undefined),
  listSummaries: vi.fn(async (): Promise<never[]> => []),
  listLightSummaries: vi.fn(async (): Promise<never[]> => []),
  upgrade: vi
    .fn<(checkpoint: () => Promise<void>, snapshot?: never[]) => Promise<number>>()
    .mockResolvedValue(0),
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
  greetingResourceService: {
    onSaved: (listener: (resourceId: string, changed: boolean) => void) => {
      greetings.add(listener)
      return () => greetings.delete(listener)
    },
  },
  resourceService: {
    listSummaries: startup.listSummaries,
    listResourceListSummaries: startup.listLightSummaries,
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
// Lifecycle tests do not start the independent inbox owner or its startup reads.
vi.mock('./UseDiscordResourceInbox', () => ({ useDiscordResourceInbox: vi.fn() }))

function mountLifecycle(onRender?: (cssSyncCount: number) => void) {
  const overlay = ref(false)
  const receive = vi.fn(),
    notice = vi.fn()
  const syncCustomUiCss = vi.fn()
  const context: Parameters<typeof useLibraryLifecycle>[0] = {
    showNotice: notice,
    receiveSharedFileBatch: receive,
    loadResources: vi.fn(async () => undefined),
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
    isOverlayOpen: computed(() => overlay.value),
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
  return { wrapper, lifecycle, receive, notice, context, overlay }
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

describe('弹层后台位置保护', () => {
  let style: HTMLStyleElement
  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = 'html.modal-open body.modal-open { overflow-y: clip }'
    document.head.append(style)
    intake.take.mockResolvedValue([])
  })
  afterEach(() => {
    style.remove()
    vi.restoreAllMocks()
  })

  it.each(['close', 'unmount'] as const)('restores the opening position on %s', async (end) => {
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1200)
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(0)
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { wrapper, overlay } = mountLifecycle()
    try {
      expect(scroll).not.toHaveBeenCalled()
      overlay.value = true
      await nextTick()
      expect(document.body.style.getPropertyValue('--modal-scroll-offset-top')).toBe('-1200px')
      // The underlying page may report a different offset during native focus.
      scrollY.mockReturnValue(882)
      expect(scroll).not.toHaveBeenCalled()
      if (end === 'close') {
        overlay.value = false
        await nextTick()
      } else wrapper.unmount()
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 1200, behavior: 'instant' })
      expect(document.body.classList.contains('modal-open')).toBe(false)
      expect(document.documentElement.classList.contains('modal-open')).toBe(false)
      expect(document.body.style.getPropertyValue('--modal-scroll-offset-top')).toBe('')
    } finally {
      if (wrapper.exists()) wrapper.unmount()
    }
  })

  it('does not restore stale offsets when clipping is inactive on desktop or unsupported CSS', async () => {
    style.textContent = ''
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1200)
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { wrapper, overlay } = mountLifecycle()
    try {
      overlay.value = true
      await nextTick()
      overlay.value = false
      await nextTick()
      expect(scroll).not.toHaveBeenCalled()
      expect(document.body.style.getPropertyValue('--modal-scroll-offset-top')).toBe('')
    } finally {
      wrapper.unmount()
    }
  })

  it('uses the current library position for each new modal session', async () => {
    const scrollY = vi.spyOn(window, 'scrollY', 'get')
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { wrapper, overlay } = mountLifecycle()
    try {
      for (const top of [1200, 1800, 900]) {
        scrollY.mockReturnValue(top)
        overlay.value = true
        await nextTick()
        scrollY.mockReturnValue(0)
        overlay.value = false
        await nextTick()
        expect(scroll).toHaveBeenLastCalledWith({ left: 0, top, behavior: 'instant' })
      }
      expect(scroll).toHaveBeenCalledTimes(3)
    } finally {
      wrapper.unmount()
    }
    expect(scroll).toHaveBeenCalledTimes(3)
  })
})

describe('系统分享待处理队列', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['vault', 'library', 'deep-link'] as const)(
    'reports the actual startup failure stage: %s',
    async (stage) => {
      const failure = new Error('private-resource token=secret')
      if (stage === 'vault') startup.initializeVaultOnce.mockRejectedValueOnce(failure)
      else startup.initializeVaultOnce.mockResolvedValueOnce({ locked: false } as never)
      intake.take.mockResolvedValue([])
      const { wrapper, context, notice } = mountLifecycle()
      if (stage === 'library') vi.mocked(context.loadLibrary).mockRejectedValueOnce(failure)
      if (stage === 'deep-link')
        vi.mocked(context.handleNativeDeepLink).mockRejectedValueOnce(failure)
      try {
        const code = {
          vault: 'SRL-LIBRARY-VAULT-INIT',
          library: 'SRL-LIBRARY-LOAD',
          'deep-link': 'SRL-LIBRARY-DEEP-LINK',
        }[stage]
        await vi.waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringContaining(code)))
        expect(JSON.stringify(notice.mock.calls)).not.toContain('private-resource')
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
        expect(notice).not.toHaveBeenCalledWith('无法读取本地数据库，请刷新后重试')
      } finally {
        wrapper.unmount()
        intake.take.mockReset()
      }
    },
  )

  it.each([false, true])(
    'does not report cancelled or disposed startup failures (disposed=%s)',
    async (disposed) => {
      let reject!: (error: Error) => void
      startup.initializeVaultOnce.mockImplementationOnce(
        () =>
          new Promise<never>((_, fail) => {
            reject = fail
          }),
      )
      const { wrapper, notice } = mountLifecycle()
      if (disposed) wrapper.unmount()
      reject(disposed ? new Error('late failure') : new DOMException('stopped', 'AbortError'))
      await Promise.resolve()
      await Promise.resolve()
      expect(notice).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      if (!disposed) wrapper.unmount()
    },
  )

  it('records maintenance failure stage without logging raw errors', async () => {
    startup.initializeVaultOnce.mockResolvedValueOnce({ locked: false } as never)
    startup.backfill.mockRejectedValueOnce(new Error('private-maintenance token=secret'))
    intake.take.mockResolvedValue([])
    const { wrapper } = mountLifecycle()
    try {
      await vi.waitFor(() =>
        expect(console.warn).toHaveBeenCalledWith(
          '[SRL:HandledError]',
          expect.objectContaining({ code: 'SRL-LIBRARY-MAINTENANCE-FINGERPRINTS' }),
        ),
      )
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
    } finally {
      wrapper.unmount()
      intake.take.mockReset()
    }
  })

  it('records optional startup reads independently and keeps the library usable', async () => {
    startup.initializeVaultOnce.mockResolvedValueOnce({ locked: false } as never)
    intake.take.mockResolvedValue([])
    const { wrapper, context, notice } = mountLifecycle()
    vi.mocked(context.refreshStorageHealth).mockRejectedValueOnce(new Error('storage private'))
    vi.mocked(context.loadRecycleBin).mockRejectedValueOnce(new Error('recycle private'))
    try {
      await vi.waitFor(() =>
        expect(notice).toHaveBeenCalledWith(expect.stringContaining('SRL-LIBRARY-RECYCLE-LOAD')),
      )
      expect(notice).toHaveBeenCalledWith(expect.stringContaining('SRL-LIBRARY-STORAGE-HEALTH'))
      expect(context.loadLibrary).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      intake.take.mockReset()
    }
  })

  it('does not restart a maintenance operation cancelled by its storage owner', async () => {
    startup.initializeVaultOnce.mockResolvedValueOnce({ locked: false } as never)
    startup.upgrade
      .mockClear()
      .mockRejectedValueOnce(new DOMException('cancelled read', 'AbortError'))
    startup.backfill.mockClear()
    intake.take.mockResolvedValue([])
    const { wrapper } = mountLifecycle()
    try {
      await vi.waitFor(() => expect(startup.upgrade).toHaveBeenCalledOnce())
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(startup.upgrade).toHaveBeenCalledOnce()
      expect(startup.backfill).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      startup.upgrade.mockReset().mockResolvedValue(0)
      intake.take.mockReset()
    }
  })

  it('refreshes only committed greeting IDs, skips no-op saves and releases the listener', async () => {
    const { wrapper, context, notice } = mountLifecycle()
    try {
      expect(greetings.size).toBe(1)
      greetings.forEach((listener) => listener('unchanged', false))
      expect(context.loadResources).not.toHaveBeenCalled()
      greetings.forEach((listener) => listener('greeting-new', true))
      greetings.forEach((listener) => listener('character-updated', true))
      expect(vi.mocked(context.loadResources).mock.calls).toEqual([
        [['greeting-new']],
        [['character-updated']],
      ])
      vi.mocked(context.loadResources).mockRejectedValueOnce(new Error('synthetic read failure'))
      greetings.forEach((listener) => listener('committed-but-unreadable', true))
      await vi.waitFor(() =>
        expect(notice).toHaveBeenCalledWith(
          expect.stringContaining('SRL-LIBRARY-GREETING-REFRESH'),
        ),
      )
    } finally {
      wrapper.unmount()
    }
    expect(greetings.size).toBe(0)
  })

  it('drops a maintenance snapshot when an overlay opens during reading and rereads after it closes', async () => {
    let finish!: (rows: never[]) => void
    let paused = false
    startup.initializeVaultOnce.mockImplementation(async () => ({ locked: false }) as never)
    startup.listLightSummaries
      .mockReset()
      .mockResolvedValue([])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    startup.upgrade.mockReset().mockImplementation(async (checkpoint: () => Promise<void>) => {
      try {
        await checkpoint()
      } catch (error) {
        paused = true
        throw error
      }
      return 0
    })
    startup.backfill.mockReset().mockResolvedValue(0)
    intake.take.mockResolvedValue([])
    const { wrapper, overlay } = mountLifecycle()
    try {
      await vi.waitFor(() => expect(startup.listLightSummaries).toHaveBeenCalledOnce())
      overlay.value = true
      finish([])
      await vi.waitFor(() => expect(paused).toBe(true))
      expect(startup.backfill).not.toHaveBeenCalled()
      expect(startup.listLightSummaries).toHaveBeenCalledOnce()
      overlay.value = false
      await vi.waitFor(() => expect(startup.backfill).toHaveBeenCalledOnce())
      expect(startup.listLightSummaries).toHaveBeenCalledTimes(2)
    } finally {
      wrapper.unmount()
      startup.initializeVaultOnce
        .mockReset()
        .mockImplementation(() => new Promise<never>(() => undefined))
      startup.listLightSummaries.mockReset().mockResolvedValue([])
      startup.upgrade.mockReset().mockResolvedValue(0)
      startup.backfill.mockReset().mockResolvedValue(0)
      intake.take.mockReset()
    }
  })

  it.each([0, 1])(
    'shares the maintenance snapshot only when no content upgrade committed (%i)',
    async (upgraded) => {
      const snapshot = [{ id: 'snapshot' }] as never[]
      startup.initializeVaultOnce.mockImplementation(async () => ({ locked: false }) as never)
      startup.listLightSummaries.mockReset().mockResolvedValue(snapshot)
      startup.listSummaries.mockClear()
      startup.upgrade.mockReset().mockResolvedValue(upgraded)
      startup.backfill.mockReset().mockResolvedValue(0)
      intake.take.mockResolvedValue([])
      const { wrapper } = mountLifecycle()
      try {
        await vi.waitFor(() => expect(startup.backfill).toHaveBeenCalledOnce())
        expect(startup.listLightSummaries).toHaveBeenCalledOnce()
        expect(startup.listSummaries).not.toHaveBeenCalled()
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
        startup.listLightSummaries.mockReset().mockResolvedValue([])
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
        expect(notice).toHaveBeenCalledWith(
          expect.stringContaining(
            failed === 'sync' ? 'SRL-BACKUP-NATIVE-FILE-SYNC' : 'SRL-BACKUP-RECEIPT-RECONCILE',
          ),
        ),
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
