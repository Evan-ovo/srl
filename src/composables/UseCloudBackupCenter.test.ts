/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCloudBackupCenter } from './UseCloudBackupCenter'
import { noticeCenter } from '../core/NoticeCenter'
import { taskCenter } from '../core/TaskCenter'
import type { CloudRestoreOptions } from '../services/CloudBackupService'
import type { ResourceSummary } from '../types/Resource'
import type { WebCloudBackupState } from '../types/CloudBackup'
import type { RestoreReport } from '../types/Backup'
import type { CloudDownloadOptions } from '../services/CloudBackupTransport'

const runtime = vi.hoisted(() => ({
  native: true,
  webState: undefined as WebCloudBackupState | undefined,
  webListeners: new Set<() => void>(),
  webPause: vi.fn(),
  webCancel: vi.fn(),
  create: vi.fn(),
  snapshot: {
    activeProvider: 'github',
    status: {},
    credentials: { github: 'valid', webdav: 'valid' },
  },
  save: vi.fn(),
  list: vi.fn(),
  pending: vi.fn(),
  resume: vi.fn(),
  confirm: vi.fn(),
  backupProgress: vi.fn(),
  restoreProgress: vi.fn(),
  reconcile: vi.fn(),
  restore: vi.fn(),
  contents: vi.fn(),
  download: vi.fn(),
  saveFile: vi.fn(),
  discard: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.native,
    getPlatform: () => (runtime.native ? 'android' : 'web'),
  },
  registerPlugin: () => ({}),
}))
vi.mock('../core/AppContainer', () => ({
  resourceService: {},
  cloudBackupService: {
    getWebBackupState: () => runtime.webState,
    subscribeWebBackup: (listener: () => void) => {
      runtime.webListeners.add(listener)
      return () => runtime.webListeners.delete(listener)
    },
    pauseActiveWebBackup: runtime.webPause,
    cancelActiveWebBackup: runtime.webCancel,
    createBackup: runtime.create,
    getSnapshot: () => runtime.snapshot,
    hasCredential: () => true,
    initializeCredentials: async () => undefined,
    saveConfig: runtime.save,
    listBackups: runtime.list,
    pendingNativeRestores: runtime.pending,
    resumeNativeRestore: runtime.resume,
    getActiveNativeBackupProgress: runtime.backupProgress,
    getNativeRestoreProgress: runtime.restoreProgress,
    reconcileNativeJob: runtime.reconcile,
    restoreBackup: runtime.restore,
    downloadBackup: runtime.download,
    listBackupRestoreContents: runtime.contents,
    clearRestorePreview: vi.fn(async () => undefined),
    discardRestoreFailures: runtime.discard,
  },
}))
vi.mock('./UseConfirmDialog', () => ({ confirmAction: runtime.confirm }))
vi.mock('../utils/LibraryFormatting', async (load) => ({
  ...(await load<typeof import('../utils/LibraryFormatting')>()),
  downloadBlob: runtime.saveFile,
}))
vi.mock('../services/PersonalResourceBackup', () => ({
  clearPlainSecretExportGrant: async () => undefined,
}))

const item = {
  id: 'backup-1',
  objectKey: 'snapshot.json',
  size: 512,
  createdAt: 1,
  kind: 'webdavSnapshot' as const,
}
const record = { id: 'pending-test', restore: { item, resourceKeys: ['one'] } }
const resource = (id: string, hash = id) =>
  ({
    id,
    name: id,
    contentHash: hash,
    type: 'worldBook',
    metadata: {},
    tags: [],
  }) as unknown as ResourceSummary

beforeEach(() => {
  vi.clearAllMocks()
  runtime.native = true
  runtime.webState = undefined
  runtime.webListeners.clear()
  runtime.save.mockResolvedValue(runtime.snapshot)
  runtime.list.mockResolvedValue([])
  runtime.pending.mockResolvedValue([])
  runtime.resume.mockResolvedValue(1)
  runtime.confirm.mockResolvedValue(false)
  runtime.backupProgress.mockResolvedValue(null)
  runtime.restoreProgress.mockResolvedValue(null)
  runtime.reconcile.mockResolvedValue(undefined)
  runtime.restore.mockResolvedValue(0)
  runtime.download.mockResolvedValue(new Blob(['zip']))
  runtime.saveFile.mockResolvedValue(undefined)
  runtime.contents.mockResolvedValue({
    resources: [],
    portableScopeIds: ['extra.chatReader', 'extra.assistantData', 'extra.credentials'],
  })
})
afterEach(() => noticeCenter.dismiss('cloud-restore:pending-test'))

function mountCenter(resources = ref<ResourceSummary[]>([])) {
  let center!: ReturnType<typeof useCloudBackupCenter>
  const emit = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        center = useCloudBackupCenter(emit, () => resources.value)
        return () => null
      },
    }),
  )
  center.github.value.owner = 'example-user'
  center.github.value.repository = 'private-backup'
  return { center, wrapper, emit, resources }
}

it('publishes actual cloud download item/byte/ZIP progress and only then hands it to saving', async () => {
  let resolve!: (blob: Blob) => void
  let options!: CloudDownloadOptions
  runtime.download.mockImplementationOnce(
    (_item, _config, _secret, value: CloudDownloadOptions) => {
      options = value
      return new Promise<Blob>((done) => {
        resolve = done
      })
    },
  )
  const { center, wrapper } = mountCenter()
  const pending = center.download(item)
  await flushPromises()
  const id = center.downloadOperation.value
  options.onProgress!({
    phase: 'archive',
    completed: 2,
    total: 8,
    receivedBytes: 1000,
    writtenBytes: 500,
  })
  expect(center.downloadProgress.value).toMatchObject({
    completed: 2,
    total: 8,
    receivedBytes: 1000,
    writtenBytes: 500,
  })
  expect(taskCenter.list().find((task) => task.operationId === id)).toMatchObject({
    progress: 0.25,
    itemProgress: { completed: 2, total: 8 },
    transfer: { transferredBytes: 1000 },
  })
  expect(runtime.saveFile).not.toHaveBeenCalled()
  const zip = new Blob(['complete'])
  resolve(zip)
  await pending
  expect(runtime.saveFile).toHaveBeenCalledExactlyOnceWith(zip, item.objectKey)
  expect(taskCenter.list().find((task) => task.operationId === id)?.status).toBe('completed')
  taskCenter.dismiss(id)
  wrapper.unmount()
})

it.each([true, false])(
  'waits for explicit download failure retry in the existing task, without saving early (native=%s)',
  async (native) => {
    runtime.native = native
    let retries = 0
    runtime.download.mockImplementationOnce(
      async (_item, _config, _secret, options: CloudDownloadOptions) => {
        await options.onReadFailures!([{ fileName: 'failed.json', error: 'fetch failed' }])
        retries++
        return new Blob(['complete zip'])
      },
    )
    const { center, wrapper } = mountCenter()
    const pending = center.download(item)
    await flushPromises()
    const id = center.downloadOperation.value
    expect(center.downloadFailures.value).toEqual([
      { fileName: 'failed.json', error: 'fetch failed' },
    ])
    expect(taskCenter.list().find((task) => task.operationId === id)).toMatchObject({
      status: 'running',
      actionLabel: '重试失败项',
      cancelable: true,
    })
    expect(runtime.saveFile).not.toHaveBeenCalled()
    expect(retries).toBe(0)
    expect(runtime.download).toHaveBeenCalledOnce()
    await taskCenter.open(id)
    await pending
    expect(retries).toBe(1)
    expect(runtime.download).toHaveBeenCalledOnce()
    expect(runtime.saveFile).toHaveBeenCalledOnce()
    expect(center.downloadFailures.value).toEqual([])
    expect(taskCenter.list().find((task) => task.operationId === id)).toMatchObject({
      status: 'completed',
      actionLabel: undefined,
    })
    taskCenter.dismiss(id)
    wrapper.unmount()
  },
)

it.each(['stop', 'unmount'])(
  'ends a download retry wait on %s and cannot revive it through a stale task action',
  async (action) => {
    let options!: CloudDownloadOptions
    let retries = 0
    runtime.download.mockImplementationOnce(
      async (_item, _config, _secret, value: CloudDownloadOptions) => {
        options = value
        await value.onReadFailures!([{ fileName: 'failed.json', error: 'fetch failed' }])
        retries++
        return new Blob(['complete zip'])
      },
    )
    const { center, wrapper } = mountCenter()
    const pending = center.download(item)
    await flushPromises()
    const id = center.downloadOperation.value
    if (action === 'stop') center.stopDownload()
    else wrapper.unmount()
    await pending
    expect(options.signal?.aborted).toBe(true)
    expect(center.downloadFailures.value).toEqual([])
    expect(await taskCenter.open(id)).toBe(false)
    center.retryDownloadFailures()
    expect(retries).toBe(0)
    expect(runtime.saveFile).not.toHaveBeenCalled()
    expect(taskCenter.list().find((task) => task.operationId === id)?.status).toBe('cancelled')
    await expect(
      options.onReadFailures!([{ fileName: 'late.json', error: 'late' }]),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(center.downloadFailures.value).toEqual([])
    taskCenter.dismiss(id)
    if (action === 'stop') wrapper.unmount()
  },
)

it('acknowledges a download stop only after it drains and ignores late progress/results', async () => {
  let resolve!: (blob: Blob) => void
  let options!: CloudDownloadOptions
  runtime.download.mockImplementationOnce(
    (_item, _config, _secret, value: CloudDownloadOptions) => {
      options = value
      return new Promise<Blob>((done) => {
        resolve = done
      })
    },
  )
  const { center, wrapper } = mountCenter()
  const pending = center.download(item)
  await flushPromises()
  const id = center.downloadOperation.value
  center.stopDownload()
  expect(options.signal?.aborted).toBe(true)
  expect(taskCenter.list().find((task) => task.operationId === id)?.status).toBe('running')
  options.onProgress!({
    phase: 'archive',
    completed: 9,
    total: 9,
    receivedBytes: 9999,
    writtenBytes: 9999,
  })
  expect(center.downloadProgress.value?.receivedBytes).toBe(0)
  resolve(new Blob(['late']))
  await pending
  expect(runtime.saveFile).not.toHaveBeenCalled()
  expect(taskCenter.list().find((task) => task.operationId === id)?.status).toBe('cancelled')
  taskCenter.dismiss(id)
  wrapper.unmount()
})

it('cancels download on leaving and reopening does not start it again', async () => {
  let options!: CloudDownloadOptions
  runtime.download.mockImplementationOnce(
    (_item, _config, _secret, value: CloudDownloadOptions) => {
      options = value
      return new Promise<Blob>((_resolve, reject) =>
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
          once: true,
        }),
      )
    },
  )
  const { center, wrapper } = mountCenter()
  const pending = center.download(item)
  await flushPromises()
  const id = center.downloadOperation.value
  wrapper.unmount()
  await pending
  expect(options.signal?.aborted).toBe(true)
  const reopened = mountCenter()
  await flushPromises()
  expect(runtime.download).toHaveBeenCalledOnce()
  expect(reopened.center.downloadOperation.value).toBe('')
  expect(runtime.saveFile).not.toHaveBeenCalled()
  reopened.wrapper.unmount()
  taskCenter.dismiss(id)
})

it('shows real preparation/write counters and current download bytes, and acknowledges a stop', async () => {
  runtime.native = false
  runtime.confirm.mockResolvedValue(true)
  let options!: CloudRestoreOptions
  runtime.restore.mockImplementationOnce(
    async (_item, _filter, _keys, _gallery, _scopes, _commit, controls) => {
      options = controls
      controls.onProgress({ phase: 'prepare', completed: 2, total: 9, fileName: 'third.png' })
      controls.onTransfer(1024 * 1024, 4 * 1024 * 1024, 'third.png')
      await new Promise<void>((_resolve, reject) =>
        controls.signal.addEventListener('abort', () => reject(controls.signal.reason), {
          once: true,
        }),
      )
    },
  )
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    const importing = center.restore(item)
    await flushPromises()
    expect(center.restoreProgress.value).toMatchObject({ completed: 2, total: 9, phase: 'prepare' })
    expect(center.message.value).toContain('1.0 MiB / 4.0 MiB')
    const id = center.restoreOperation.value
    expect(taskCenter.list().find((r) => r.operationId === id)?.itemProgress).toEqual({
      completed: 2,
      total: 9,
    })
    center.stopRestore()
    await importing
    expect(options.signal?.aborted).toBe(true)
    expect(center.message.value).toContain('已停止')
    expect(taskCenter.list().find((r) => r.operationId === id)?.status).toBe('cancelled')
    expect(center.restorePicker.value).toBeDefined()
    taskCenter.dismiss(id)
  } finally {
    wrapper.unmount()
  }
})

it('distinguishes group writing from extra-data import and waits for extra-data safe completion', async () => {
  runtime.native = false
  runtime.confirm.mockResolvedValue(true)
  let finish!: () => void
  runtime.restore.mockImplementationOnce(
    async (_item, _filter, _keys, _gallery, _scopes, _commit, controls) => {
      controls.onProgress({
        phase: 'commit',
        completed: 4,
        total: 9,
        transferredBytes: 4000,
        totalBytes: 9000,
      })
      controls.onPhase('extras')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return 9
    },
  )
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    const importing = center.restore(item)
    await flushPromises()
    expect(center.restorePhase.value).toBe('extras')
    expect(center.message.value).toContain('附加数据')
    const id = center.restoreOperation.value
    expect(taskCenter.list().find((r) => r.operationId === id)?.cancelable).toBe(false)
    finish()
    await importing
    taskCenter.dismiss(id)
  } finally {
    wrapper.unmount()
  }
})

it('rebinds a live web backup on page reentry and permits pause/stop while the backup action is busy', async () => {
  runtime.native = false
  runtime.webState = {
    operationId: 'live-web',
    status: 'running',
    phase: '上传 2 / 5',
    target: {
      provider: 'github',
      owner: 'example-user',
      repository: 'private-backup',
      retention: 7,
      autoBackup: false,
    },
  }
  runtime.webCancel.mockResolvedValue('cancelled')
  runtime.webPause.mockResolvedValue('cancelled')
  const { center, wrapper } = mountCenter()
  await flushPromises()
  expect(center.busyAction.value).toBe('backup')
  expect(center.message.value).toBe('上传 2 / 5')
  center.selectProvider('webdav')
  expect(center.activeProvider.value).toBe('github')
  await center.pauseWebBackup()
  expect(runtime.webPause).toHaveBeenCalledOnce()
  await center.cancelNativeBackup()
  expect(runtime.webCancel).toHaveBeenCalledOnce()
  wrapper.unmount()
  expect(runtime.webListeners.size).toBe(0)
  const reopened = mountCenter()
  await flushPromises()
  expect(reopened.center.webBackup.value?.operationId).toBe('live-web')
  expect(reopened.center.busyAction.value).toBe('backup')
  reopened.wrapper.unmount()
})

it('does not start an upload when stop is clicked while asynchronous configuration preflight is pending', async () => {
  runtime.native = false
  let saved!: (value: typeof runtime.snapshot) => void
  runtime.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        saved = resolve
      }),
  )
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    const pending = center.createBackup()
    await flushPromises()
    expect(center.busyAction.value).toBe('backup')
    await center.cancelNativeBackup()
    saved(runtime.snapshot)
    await pending
    expect(runtime.create).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('locks list preflight and prevents duplicate requests or provider changes before save finishes', async () => {
  let saved!: (value: typeof runtime.snapshot) => void
  runtime.save.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)))
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    const first = center.loadBackups()
    await flushPromises()
    expect(center.busyAction.value).toBe('list')
    await center.loadBackups()
    center.selectProvider('webdav')
    expect(center.activeProvider.value).toBe('github')
    saved(runtime.snapshot)
    await first
    expect(runtime.save).toHaveBeenCalledOnce()
    expect(runtime.list).toHaveBeenCalledOnce()
    expect(center.busyAction.value).toBe('')
  } finally {
    wrapper.unmount()
  }
})

it('preserves valid backups and validation warnings when a list refresh finishes', async () => {
  runtime.list.mockImplementationOnce(async (_config, _secret, _progress, warning) => {
    warning('Koofr 有 1 份备份未通过校验：清单 JSON 无效')
    return [item]
  })
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    await center.loadBackups()
    expect(center.backups.value).toEqual([item])
    expect(center.message.value).toContain('已读取 1 个云端备份')
    expect(center.message.value).toContain('1 份备份未通过校验')
    expect(center.busyAction.value).toBe('')
    runtime.list.mockRejectedValueOnce(new Error('Koofr 网络读取失败'))
    await center.loadBackups()
    expect(center.backups.value).toEqual([item])
    expect(center.message.value).toBe('Koofr 网络读取失败')
    expect(center.busyAction.value).toBe('')
  } finally {
    wrapper.unmount()
  }
})

it('locks a restore during confirmation and releases it after cancellation without writing', async () => {
  let decide!: (value: boolean) => void
  runtime.confirm.mockImplementationOnce(() => new Promise((resolve) => (decide = resolve)))
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    const first = center.restore(item)
    await center.restore(item)
    expect(runtime.confirm).toHaveBeenCalledOnce()
    expect(center.busyAction.value).toBe('restore:backup-1')
    decide(false)
    await first
    expect(runtime.save).not.toHaveBeenCalled()
    expect(center.busyAction.value).toBe('')
  } finally {
    wrapper.unmount()
  }
})

it('rejects a selected snapshot when its repository changes before import', async () => {
  runtime.native = false
  runtime.contents.mockResolvedValue({ resources: [resource('one')], portableScopeIds: [] })
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    await center.restore(item)
    center.github.value.repository = 'another-target'
    runtime.confirm.mockResolvedValue(true)
    await center.restore(item)
    expect(runtime.contents).toHaveBeenCalledOnce()
    expect(runtime.restore).not.toHaveBeenCalled()
    expect(center.message.value).toContain('目标已变化')
    expect(center.restorePicker.value).toBeUndefined()
  } finally {
    wrapper.unmount()
  }
})

it('forwards committed resource IDs for targeted refresh and skips refresh for a no-op restore', async () => {
  const { center, wrapper, emit } = mountCenter()
  try {
    await flushPromises()
    runtime.confirm.mockResolvedValue(true)
    let ids = ['committed-id']
    runtime.restore.mockImplementation(
      async (_item, _filter, _keys, _gallery, _scopes, onCommitted) => {
        onCommitted({ restoredResources: ids.length, resourceIds: ids, categoriesChanged: false })
        return ids.length
      },
    )
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    await center.restore(item)
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      'library-changed',
      expect.objectContaining({ resourceIds: ids, categoriesChanged: false }),
    )
    emit.mockClear()
    ids = []
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    await center.restore(item)
    expect(emit).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('publishes a fast committed group within the refresh window while a later download is still waiting', async () => {
  runtime.native = false
  runtime.confirm.mockResolvedValue(true)
  let finish!: () => void
  runtime.restore.mockImplementationOnce(
    async (_item, _filter, _keys, _gallery, _scopes, committed) => {
      committed({ restoredResources: 1, resourceIds: ['first'], categoriesChanged: false })
      committed({ restoredResources: 1, resourceIds: ['second'], categoriesChanged: false })
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      committed({
        restoredResources: 2,
        resourceIds: ['first', 'second'],
        categoriesChanged: false,
      })
      return 2
    },
  )
  const { center, wrapper, emit } = mountCenter()
  let importing: Promise<void> | undefined
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [resource('one')] }
    center.selectedRestoreKeys.value = new Set(['one'])
    importing = center.restore(item)
    await flushPromises()
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      'library-changed',
      expect.objectContaining({ resourceIds: ['first'] }),
    )
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2), { timeout: 1_500 })
    expect(emit).toHaveBeenLastCalledWith(
      'library-changed',
      expect.objectContaining({ resourceIds: ['second'] }),
    )
    expect(center.busyAction.value).toBe('restore:backup-1')
  } finally {
    finish?.()
    await importing
    expect(emit).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  }
})

it('offers failed items for explicit retry only and ending the round seals the offer across reopening', async () => {
  runtime.native = false
  runtime.confirm.mockResolvedValue(true)
  runtime.discard.mockResolvedValue(undefined)
  const failure = {
    kind: 'resource' as const,
    id: 'failed',
    fileName: 'failed.json',
    error: 'HTTP 404',
  }
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [resource('saved'), resource('failed')] }
    center.selectedRestoreKeys.value = new Set(['saved', 'failed'])
    runtime.restore.mockImplementation(
      async (_item, _filter, _keys, _gallery, _scopes, committed) => {
        committed({ restoredResources: 1, resourceIds: ['saved'], failures: [failure] })
        return 1
      },
    )
    await center.restore(item)
    expect(center.restoreFailures.value).toEqual([failure])
    expect(runtime.restore).toHaveBeenCalledOnce()
    await flushPromises()
    expect(runtime.restore).toHaveBeenCalledOnce()
    await center.retryRestoreFailures()
    expect(runtime.restore.mock.calls[1]![6]).toMatchObject({ retryFailures: [failure] })
    expect(
      runtime.confirm.mock.calls.filter(([options]) => options.title === '从云端导入'),
    ).toHaveLength(1)
    await center.dismissRestoreFailures()
    expect(runtime.discard).toHaveBeenCalledOnce()
    expect(center.restoreFailures.value).toEqual([])
    expect(center.restorePicker.value).toBeUndefined()
    expect(center.message.value).toContain('不会自动重试')
    await center.retryRestoreFailures()
    expect(runtime.restore).toHaveBeenCalledTimes(2)
  } finally {
    wrapper.unmount()
  }
  const reopened = mountCenter()
  try {
    await flushPromises()
    expect(reopened.center.restoreFailures.value).toEqual([])
    expect(runtime.restore).toHaveBeenCalledTimes(2)
  } finally {
    reopened.wrapper.unmount()
  }
})

it('previews only selected resources against the latest library using the shared identity rules', async () => {
  const { center, wrapper, resources } = mountCenter(ref([resource('same', 'old')]))
  try {
    center.restorePicker.value = {
      item,
      resources: [resource('duplicate', 'old'), resource('same', 'new'), resource('unchecked')],
    }
    center.selectedRestoreKeys.value = new Set(['duplicate', 'same'])
    expect(center.restorePreview.value).toEqual({ added: 1, skipped: 1, conflicts: 1 })
    resources.value = [resource('same', 'old'), resource('imported', 'new')]
    expect(center.restorePreview.value).toEqual({ added: 0, skipped: 2, conflicts: 0 })
    expect(center.backupScopeResources.value).toHaveLength(2)
  } finally {
    wrapper.unmount()
  }
})

it('allows restoring selected settings without resources and forwards the exact scope', async () => {
  const { center, wrapper, emit } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [] }
    center.restoreScopeModel.value = { resourceIds: [], scopeIds: ['extra.generalPreferences'] }
    runtime.confirm.mockResolvedValue(true)
    await center.restore(item)
    expect(runtime.restore).toHaveBeenCalledWith(
      item,
      expect.any(Function),
      [],
      false,
      ['extra.generalPreferences'],
      expect.any(Function),
      expect.objectContaining({
        onProgress: expect.any(Function),
        onTransfer: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(emit).not.toHaveBeenCalledWith('library-changed')
    expect(center.busyAction.value).toBe('')
  } finally {
    wrapper.unmount()
  }
})

it('restores community-only selections and reports saved posts even when no resource was added', async () => {
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    center.restorePicker.value = { item, resources: [] }
    center.restoreScopeModel.value = { resourceIds: [], scopeIds: ['extra.communitySources'] }
    expect(center.hasRestoreSelection.value).toBe(true)
    runtime.confirm.mockResolvedValue(true)
    runtime.restore.mockImplementationOnce(
      async (
        _item,
        _filter,
        _keys,
        _gallery,
        _scopes,
        onCommitted: (report: RestoreReport) => void,
      ) => {
        onCommitted({
          restoredResources: 0,
          skippedDuplicates: 0,
          preservedConflicts: 0,
          createdCategories: 0,
          reusedCategories: 0,
          resourceIds: [],
          categoriesChanged: false,
          restoredCommunitySources: 2,
          restoredCommunityMessages: 5,
        })
        return 0
      },
    )
    await center.restore(item)
    expect(center.message.value).toContain('Discord 帖子 2 个，消息 5 条')
    expect(runtime.restore.mock.calls[0]?.[4]).toEqual(['extra.communitySources'])
  } finally {
    wrapper.unmount()
  }
})

it('opens a settings-only picker with available extras and leaves sensitive content unchecked', async () => {
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    await center.restore(item)
    expect(runtime.contents).toHaveBeenCalledOnce()
    expect(center.restoreScopeIds.value).toEqual([
      'extra.chatReader',
      'extra.assistantData',
      'extra.credentials',
    ])
    expect(center.restoreScopeModel.value.scopeIds).toEqual(['extra.chatReader'])
    expect(center.hasRestoreSelection.value).toBe(true)
    center.restoreScopeModel.value = { resourceIds: [], scopeIds: [] }
    await center.restore(item)
    expect(runtime.restore).not.toHaveBeenCalled()
    expect(center.hasRestoreSelection.value).toBe(false)
    expect(center.message.value).toBe('请至少选择一项资源或附加数据')
  } finally {
    wrapper.unmount()
  }
})

it('resumes the current persisted record once and dismisses its notice only after completion', async () => {
  runtime.pending.mockResolvedValue([record])
  let finish!: (value: number) => void
  runtime.resume.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const { center, wrapper, emit } = mountCenter()
  try {
    await flushPromises()
    const first = center.resumePendingRestore(record.id)
    await flushPromises()
    await center.resumePendingRestore(record.id)
    expect(runtime.resume).toHaveBeenCalledOnce()
    expect(noticeCenter.list().some((notice) => notice.id === 'cloud-restore:' + record.id)).toBe(
      true,
    )
    finish(1)
    await first
    expect(emit).toHaveBeenCalledWith('library-changed')
    expect(center.pendingRestores.value).toEqual([])
    expect(noticeCenter.list().some((notice) => notice.id === 'cloud-restore:' + record.id)).toBe(
      false,
    )
  } finally {
    wrapper.unmount()
  }
})

it('a retained notice after page close routes to the current cloud page instead of mutating stale state', async () => {
  runtime.pending.mockResolvedValue([record])
  const { wrapper } = mountCenter()
  await flushPromises()
  const action = noticeCenter.list().find((notice) => notice.id === 'cloud-restore:' + record.id)!
    .actions[0]!
  wrapper.unmount()
  const route = vi.fn()
  window.addEventListener('srl:native-deep-link', route)
  try {
    await action.run()
    expect(runtime.resume).not.toHaveBeenCalled()
    expect((route.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ kind: 'backup' })
  } finally {
    window.removeEventListener('srl:native-deep-link', route)
  }
})

it('late native progress cannot overwrite the message of a newer cloud action', async () => {
  let progress!: (value: unknown) => void
  runtime.backupProgress.mockImplementationOnce(
    () => new Promise((resolve) => (progress = resolve)),
  )
  let saved!: (value: typeof runtime.snapshot) => void
  runtime.save.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)))
  const { center, wrapper } = mountCenter()
  try {
    await flushPromises()
    const action = center.loadBackups()
    await flushPromises()
    center.message.value = '当前读取任务'
    progress({ completed: 1, total: 3, totalBytes: 0, uploadedBytes: 0, status: 'running' })
    await flushPromises()
    expect(center.message.value).toBe('当前读取任务')
    expect(center.nativeBackupActive.value).toBe(false)
    saved(runtime.snapshot)
    await action
  } finally {
    wrapper.unmount()
  }
})
