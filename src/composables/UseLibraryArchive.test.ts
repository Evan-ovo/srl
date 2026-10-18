// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useLibraryArchive } from './UseLibraryArchive'

const state = vi.hoisted(() => ({
  mounted: [] as (() => void)[],
  notices: [] as { actions: { label: string; run: () => Promise<void> }[] }[],
  task: {} as Record<string, unknown>,
  prepared: { resources: [], versions: [], categories: [], preview: {}, forReplacement: vi.fn() },
  prepare: vi.fn(),
  resume: vi.fn(),
  disposePrepared: vi.fn(),
  clearCheckpoint: vi.fn(),
  removeTask: vi.fn(),
  createRestore: vi.fn(async () => undefined),
  load: vi.fn(async () => {}),
  audioConfirm: vi.fn(async () => false),
  confirm: vi.fn(async (_options?: { title?: string }) => false),
  replace: vi.fn(async () => ({ added: 0 })),
}))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onMounted: (callback: () => void) => state.mounted.push(callback),
  onScopeDispose: () => {},
}))
vi.mock('../core/NoticeCenter', () => ({
  noticeCenter: {
    push: (notice: (typeof state.notices)[number]) => state.notices.push(notice),
    dismiss: vi.fn(),
  },
}))
vi.mock('./UseConfirmDialog', () => ({
  confirmAction: (options: { title?: string }) =>
    options.title === '本次任务后台保活' ? state.audioConfirm() : state.confirm(options),
  chooseAction: vi.fn(),
}))
vi.mock('../services/NativeImportKeepAlive', () => ({
  isNativeImportKeepAliveAvailable: () => false,
}))
vi.mock('../core/LibraryContainer', () => ({
  initializeVaultOnce: async () => {},
  vaultService: { getStatus: () => ({ locked: false }), isEnabled: () => false },
  archiveRecoveryService: {
    store: {
      list: async () => [{ id: 'saved', kind: 'restore' }],
      read: async () => state.task,
      save: vi.fn(),
      remove: state.removeTask,
    },
    readSource: async () => new File(['zip'], 'backup.zip'),
    createRestore: state.createRestore,
    ensureSource: vi.fn(),
    savePrepared: vi.fn(),
    baseline: async () => 'unchanged',
  },
  restoreService: {
    prepare: state.prepare,
    resumePrepared: state.resume,
    revivePrepared: vi.fn(() => ({ dispose: state.disposePrepared })),
    clearRestoreCheckpoint: state.clearCheckpoint,
    isRestoreCommitted: async () => false,
    replace: state.replace,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.mounted.length = 0
  state.notices.length = 0
  state.task = {
    id: 'saved',
    kind: 'restore',
    phase: '等待选择恢复方式',
    payload: {
      vaultEnabled: false,
      prepared: state.prepared,
      completed: [],
      baseline: 'unchanged',
    },
  }
  state.prepare.mockResolvedValue(state.prepared)
  state.resume.mockResolvedValue(state.prepared)
  state.disposePrepared.mockReset().mockResolvedValue(undefined)
  state.clearCheckpoint.mockReset().mockResolvedValue(undefined)
  state.removeTask.mockReset().mockResolvedValue(undefined)
  state.createRestore.mockReset().mockResolvedValue(undefined)
  state.audioConfirm.mockReset().mockResolvedValue(false)
  state.confirm.mockResolvedValue(false)
  state.replace.mockReset().mockResolvedValue({ added: 0 })
})

async function fixture() {
  const context = {
    isRestoring: ref(false),
    isRestorePanelOpen: ref(false),
    isExportPanelOpen: ref(false),
    restoreReport: ref(),
    preparedRestore: ref(),
    restoreSourceFile: ref(),
    resources: ref([]),
    categories: ref([]),
    storageHealth: ref({ quota: 0, usage: 0 }),
    LARGE_ARCHIVE_BYTES: 1000,
    completedRestoreMode: ref(),
    onRestoreImportComplete: vi.fn(),
    loadLibrary: state.load,
    showNotice: vi.fn(),
  }
  const archive = useLibraryArchive(
    () => context as unknown as ReturnType<Parameters<typeof useLibraryArchive>[0]>,
  )
  state.mounted[0]!()
  await vi.waitFor(() => expect(state.notices).toHaveLength(1))
  await state.notices[0]!.actions[0]!.run()
  return { context, archive }
}

it('rebuilds an unconfirmed restored preview so replace is not based on a serialized merge plan', async () => {
  const { context } = await fixture()
  expect(state.load).toHaveBeenCalledOnce()
  expect(state.prepare).toHaveBeenCalledOnce()
  expect(state.resume).not.toHaveBeenCalled()
  expect(context.preparedRestore.value.forReplacement).toBe(state.prepared.forReplacement)
  expect(context.isRestoring.value).toBe(false)
  expect(context.showNotice).not.toHaveBeenCalled()
})

it('keeps the confirmed plan and asks to continue without running preflight again', async () => {
  ;(state.task.payload as Record<string, unknown>).mode = 'replace'
  const { context } = await fixture()
  expect(state.resume).toHaveBeenCalledWith(state.prepared)
  expect(state.prepare).not.toHaveBeenCalled()
  expect(state.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: '继续恢复备份', danger: true }),
  )
  expect(context.preparedRestore.value).toEqual(state.prepared)
  expect(context.showNotice).not.toHaveBeenCalled()
})

it('requires explicit confirmation before replacing the whole library', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  await archive.handleRestoreConfirm('replace', [])
  expect(state.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: '整库覆盖',
      confirmLabel: '覆盖资源库',
      danger: true,
    }),
  )
  expect(state.replace).not.toHaveBeenCalled()
  expect(context.preparedRestore.value).toBeDefined()
  expect(context.onRestoreImportComplete).not.toHaveBeenCalled()
  expect(context.isRestoring.value).toBe(false)
})

it('replaces and completes recovery without a history service after confirmation', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  state.confirm.mockResolvedValue(true)
  await archive.handleRestoreConfirm('replace', [])
  expect(state.replace).toHaveBeenCalledOnce()
  expect(state.clearCheckpoint).toHaveBeenCalledWith('saved')
  expect(state.removeTask).toHaveBeenCalledWith('saved')
  expect(context.onRestoreImportComplete).toHaveBeenCalledOnce()
  expect(context.restoreReport.value).toEqual({ added: 0 })
  expect(context.showNotice).not.toHaveBeenCalled()
})

it('holds the restore plan during confirmation and prevents a second submission or disposal', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  let resolve!: (confirmed: boolean) => void
  state.confirm.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done
    }),
  )
  const first = archive.handleRestoreConfirm('replace', [])
  const second = archive.handleRestoreConfirm('replace', [])
  await archive.closeRestorePanel()
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce())
  const count = state.confirm.mock.calls.length
  const disposed = state.disposePrepared.mock.calls.length
  const busy = context.isRestoring.value
  resolve(true)
  await Promise.all([first, second])
  expect(count).toBe(1)
  expect(disposed).toBe(0)
  expect(busy).toBe(true)
  expect(state.replace).toHaveBeenCalledOnce()
  expect(context.isRestoring.value).toBe(false)
})

it('continues an older confirmed task while ignoring its retired snapshot flag', async () => {
  const payload = state.task.payload as Record<string, unknown>
  payload.mode = 'replace'
  payload.snapshot = true
  state.confirm.mockResolvedValue(true)
  const { context } = await fixture()
  expect(state.replace).toHaveBeenCalledWith(state.prepared, expect.any(Function))
  expect(state.removeTask).toHaveBeenCalledWith('saved')
  expect(context.onRestoreImportComplete).toHaveBeenCalledOnce()
  expect(context.showNotice).not.toHaveBeenCalled()
})

it('protects a resumed confirmed task from another restore and checkpoint disposal', async () => {
  const { context, archive } = await fixture()
  ;(state.task.payload as Record<string, unknown>).mode = 'replace'
  let resolve!: (confirmed: boolean) => void
  state.confirm.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done
    }),
  )
  const first = state.notices[0]!.actions[0]!.run()
  await vi.waitFor(() => expect(state.confirm).toHaveBeenCalledOnce())
  await archive.handleRestoreConfirm('replace', [])
  await archive.closeRestorePanel()
  await state.notices[0]!.actions[1]!.run()
  expect(state.disposePrepared).not.toHaveBeenCalled()
  expect(state.removeTask).not.toHaveBeenCalled()
  expect(context.isRestoring.value).toBe(true)
  resolve(false)
  await first
  expect(state.confirm).toHaveBeenCalledOnce()
  expect(context.isRestoring.value).toBe(false)
  expect(state.replace).not.toHaveBeenCalled()
})

it('releases the restore state after write failure while preserving recovery checkpoints', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  state.confirm.mockResolvedValue(true)
  state.replace.mockRejectedValue(new Error('write failed'))
  await archive.handleRestoreConfirm('replace', [])
  expect(context.isRestoring.value).toBe(false)
  expect(context.preparedRestore.value).toBeDefined()
  expect(state.clearCheckpoint).not.toHaveBeenCalled()
  expect(state.removeTask).not.toHaveBeenCalled()
  expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('write failed'))
})

it('does not restore while checkpoint disposal is still in progress', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  state.confirm.mockResolvedValue(true)
  let finish!: () => void
  state.disposePrepared.mockReturnValue(
    new Promise<void>((done) => {
      finish = done
    }),
  )
  const closing = archive.closeRestorePanel()
  await archive.handleRestoreConfirm('replace', [])
  const writes = state.replace.mock.calls.length
  finish()
  await closing
  expect(writes).toBe(0)
  expect(state.confirm).not.toHaveBeenCalled()
  expect(context.isRestoring.value).toBe(false)
  expect(context.isRestorePanelOpen.value).toBe(false)
})

it('does not resume a task while its discard confirmation is pending', async () => {
  const { context } = await fixture()
  let resolve!: (confirmed: boolean) => void
  state.confirm.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done
    }),
  )
  const discarding = state.notices[0]!.actions[1]!.run()
  const continuing = state.notices[0]!.actions[0]!.run()
  await Promise.resolve()
  await Promise.resolve()
  resolve(false)
  await Promise.all([discarding, continuing])
  expect(state.prepare).toHaveBeenCalledOnce()
  expect(state.removeTask).not.toHaveBeenCalled()
  expect(context.isRestoring.value).toBe(false)
})

it('closing an unconfirmed restore removes its prepared checkpoint instead of leaving a recurring task', async () => {
  const { context, archive } = await fixture()

  await archive.closeRestorePanel()

  expect(state.disposePrepared).toHaveBeenCalledOnce()
  expect(state.clearCheckpoint).toHaveBeenCalledWith('saved')
  expect(state.removeTask).toHaveBeenCalledWith('saved')
  expect(context.isRestorePanelOpen.value).toBe(false)
})

it('returning from the restore notification retains the prepared file and recovery checkpoint', async () => {
  const { context, archive } = await fixture()
  const prepared = context.preparedRestore.value
  const source = context.restoreSourceFile.value
  archive.openRestorePanel('export', true)
  expect(context.isRestorePanelOpen.value).toBe(true)
  expect(context.preparedRestore.value).toBe(prepared)
  expect(context.restoreSourceFile.value).toBe(source)
  expect(state.prepare).toHaveBeenCalledOnce()
  await archive.closeRestorePanel()
  expect(state.removeTask).toHaveBeenCalledWith('saved')
})

it('stopping restore preflight aborts the active scan and clears its UI state', async () => {
  const { context, archive } = await fixture()
  let signal: AbortSignal | undefined
  state.prepare.mockImplementation(
    (_file, _resources, _categories, _strict, _progress, activeSignal) => {
      signal = activeSignal
      return new Promise((_resolve, reject) => {
        activeSignal.addEventListener('abort', () => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        })
      })
    },
  )

  const inspection = archive.handleRestoreInspect(new File(['zip'], 'backup.zip'))
  await vi.waitFor(() => expect(archive.isRestorePreflighting.value).toBe(true))
  expect(await archive.stopRestoreInspection()).toBe(true)
  await inspection

  expect(signal?.aborted).toBe(true)
  expect(archive.isRestorePreflighting.value).toBe(false)
  expect(context.preparedRestore.value).toBeUndefined()
  expect(context.showNotice).toHaveBeenCalledWith(
    '已停止识别，并清理分享暂存文件与恢复检查点。',
    7000,
  )
})

it('holds the existing restore guard while the optional audio question is pending', async () => {
  const { context, archive } = await fixture()
  context.preparedRestore.value.preview = { mode: 'full', fileName: 'backup.zip' }
  let answer!: (enabled: boolean) => void
  state.audioConfirm.mockClear().mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      answer = resolve
    }),
  )
  const first = archive.handleRestoreConfirm('replace', [])
  expect(context.isRestoring.value).toBe(true)
  await archive.handleRestoreConfirm('replace', [])
  await archive.closeRestorePanel()
  expect(state.audioConfirm).toHaveBeenCalledOnce()
  expect(state.disposePrepared).not.toHaveBeenCalled()
  answer(false)
  await first
  expect(context.isRestoring.value).toBe(false)
})
