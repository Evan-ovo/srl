vi.mock('../services/WebBackgroundKeepAlive', async (original) => ({
  ...(await original<typeof import('../services/WebBackgroundKeepAlive')>()),
  requestWebBackgroundAudio: async () => () => undefined,
}))
/** @vitest-environment jsdom */
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useDiscordResourceInbox } from './UseDiscordResourceInbox'
import { taskCenter } from '../core/TaskCenter'
import { DiscordInboxTaskExpiredError } from '../services/DiscordHandoffService'
import type { SharedFileBatch } from '../utils/ShareTargetIntake'
import type { VaultStatus } from '../types/Vault'
import type { ImportResult } from '../types/Import'

const setup = vi.hoisted(() => ({
  target: { workerUrl: 'https://worker.example', libraryId: 'library-1' },
  list: vi.fn(),
  ack: vi.fn(),
  download: vi.fn(),
  read: vi.fn(),
  stage: vi.fn(),
  nativeRead: vi.fn(),
  cleanupNative: vi.fn(),
  notice: vi.fn(),
  notify: vi.fn(),
  native: false,
  inboxMode: false,
  release: vi.fn(),
  automation: vi.fn(),
  summary: vi.fn(),
  bindCards: vi.fn(),
  refresh: vi.fn(),
  webRunning: false,
  webPaused: false,
}))
vi.mock('../services/WebDiscordInboxSession', () => ({
  isWebDiscordInboxRunning: () => setup.webRunning,
  isWebDiscordInboxPaused: () => setup.webPaused,
  webDiscordInboxSignal: () => undefined,
  pauseWebDiscordInbox: vi.fn(),
  registerWebInboxParticipant: () => () => undefined,
}))
vi.mock('../services/NativeDiscordInboxService', () => ({
  isNativeDiscordInboxRunning: () => setup.inboxMode,
  notifyNativeDiscordInboxResult: setup.notify,
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => setup.native, getPlatform: () => 'android' },
  registerPlugin: vi.fn(() => ({})),
}))
vi.mock('../core/AppContainer', () => ({ initializeVaultOnce: async () => undefined }))
vi.mock('../core/LibraryContainer', () => ({
  initializeVaultOnce: async () => undefined,
  communitySourceService: {},
  discordInboxAutomationSettingsService: { load: setup.automation },
  resourceService: { getResourceListSummary: setup.summary },
}))
vi.mock('../services/DiscordInboxAutoBinding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/DiscordInboxAutoBinding')>()),
  autoBindIncomingCardBatch: setup.bindCards,
}))
vi.mock('../core/NativeSecurity', () => ({ requestNativeNotifications: async () => true }))
vi.mock('../core/NoticeCenter', () => ({ noticeCenter: { push: setup.notice, dismiss: vi.fn() } }))
vi.mock('../services/NativeImportKeepAlive', () => ({
  notifyNativeImportAwaitingChoice: setup.notify,
}))
vi.mock('../services/DiscordHandoffService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/DiscordHandoffService')>()),
  inboxConnection: () => ({ ...setup.target }),
}))
vi.mock('../services/DiscordResourceInboxService', () => ({
  listDiscordResourceJobs: setup.list,
  acknowledgeDiscordResource: setup.ack,
  downloadWebDiscordResource: setup.download,
  readDiscordResourceJob: setup.read,
}))
vi.mock('../utils/ShareTargetIntake', () => ({
  allowDiscordAttachmentRetry: setup.release,
  cleanupCompletedCloudDiscordResource: setup.cleanupNative,
  stageCloudDiscordResource: setup.stage,
  readCloudDiscordResource: setup.nativeRead,
  cloudWebResourceBatch: (file: File, id: string) => ({
    files: [file],
    recoveryId: id,
    acknowledge: async () => undefined,
  }),
}))
const job = {
  id: '11111111-1111-4111-a111-111111111111',
  name: 'card.json',
  libraryId: 'library-1',
  size: 12,
  state: 'queued',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 9999999999999,
}
const target = { workerUrl: 'https://worker.example', libraryId: 'library-1' }
const mounted: ReturnType<typeof mount>[] = []
function start(locked = false) {
  const vault = ref({ locked } as VaultStatus)
  const receive = vi.fn<(batch: SharedFileBatch) => void>()
  let intake!: ReturnType<typeof useDiscordResourceInbox>
  const wrapper = mount(
    defineComponent({
      setup() {
        intake = useDiscordResourceInbox(vault, receive, setup.refresh)
        return () => null
      },
    }),
  )
  mounted.push(wrapper)
  return { wrapper, vault, receive, request: () => intake.request() }
}
beforeEach(() => {
  vi.clearAllMocks()
  setup.notify.mockResolvedValue(undefined)
  setup.native = false
  setup.webRunning = false
  setup.webPaused = false
  setup.inboxMode = false
  setup.target = { ...target }
  setup.automation.mockResolvedValue({ bindForeground: false })
  setup.bindCards.mockResolvedValue([])
  const states = new Map<string, string>()
  setup.list.mockImplementation(async () => ({
    jobs: ['imported', 'failed', 'cancelled'].includes(states.get(job.id) ?? '') ? [] : [job],
    recent: [],
    hasMore: false,
  }))
  setup.ack.mockImplementation(async (id: string, state: string) => {
    states.set(id, state)
  })
  setup.download.mockResolvedValue(new File(['{}'], 'card.json'))
  setup.read.mockResolvedValue({
    ...job,
    url: 'https://cdn.discordapp.com/attachments/11111/22222/card.json',
  })
  setup.stage.mockResolvedValue(undefined)
  setup.nativeRead.mockResolvedValue({ transferredBytes: 3, totalBytes: 12 })
  setup.cleanupNative.mockResolvedValue(undefined)
  setup.refresh.mockResolvedValue(undefined)
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  for (const task of taskCenter.list()) {
    taskCenter.cancelled(task.operationId)
    taskCenter.dismiss(task.operationId)
  }
})
describe('cloud resource coordination', () => {
  it.each(['imported', 'cancelled'])(
    'orders the final %s ACK after a delayed waiting-version ACK',
    async (outcome) => {
      setup.webRunning = true
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const ack = setup.ack.getMockImplementation()!
      setup.ack.mockImplementation((id, state, ...args) =>
        state === 'waiting_version' ? pending : ack(id, state, ...args),
      )
      const intake = start()
      await flushPromises()
      const first = intake.receive.mock.calls[0]![0]
      await first.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
      first.onProcessingSettled?.()
      await flushPromises()
      await first.onVersionResolved?.(outcome === 'imported' ? 'a'.repeat(64) : undefined, 'A')
      const completing = first.acknowledge()
      try {
        await flushPromises()
        expect(setup.ack.mock.calls.some(([, state]) => state === outcome)).toBe(false)
      } finally {
        finish()
        await completing
        await flushPromises()
      }
      expect(
        setup.ack.mock.calls.filter(([id]) => id === job.id).map(([, state]) => state),
      ).toEqual(['downloading', 'importing', 'waiting_version', outcome])
    },
  )

  it.each(['notification', 'cloud ACK'])(
    'releases a history decision from transport while its %s is pending',
    async (phase) => {
      setup.webRunning = true
      const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'next.png' }
      setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const ack = setup.ack.getMockImplementation()!
      if (phase === 'notification') setup.notify.mockImplementationOnce(() => pending)
      else
        setup.ack.mockImplementation((id, state, ...args) =>
          id === job.id && state === 'waiting_version' ? pending : ack(id, state, ...args),
        )
      const intake = start()
      await flushPromises()
      const first = intake.receive.mock.calls[0]![0]
      const reporting = Promise.resolve(
        first.onItemComplete?.({ status: 'versionCandidate' } as ImportResult),
      ).then(() => first.onProcessingSettled?.())
      try {
        await flushPromises()
        expect(setup.download).toHaveBeenCalledTimes(2)
      } finally {
        finish()
        await reporting
        await flushPromises()
      }
    },
  )

  it('preserves a waiting history choice across pause, continues only explicitly, and settles after skip', async () => {
    setup.webRunning = true
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'next.png' }
    setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    setup.summary.mockResolvedValue({
      id: 'B',
      type: 'characterCard',
      name: 'B',
      fileName: 'B.png',
    })
    const intake = start()
    await flushPromises()
    const first = intake.receive.mock.calls[0]![0]
    await first.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
    setup.webPaused = true
    setup.webRunning = false
    window.dispatchEvent(new Event('srl:web-inbox-state'))
    first.onProcessingSettled?.()
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    setup.webPaused = false
    setup.webRunning = true
    await intake.request()
    expect(setup.download).toHaveBeenCalledTimes(2)
    await first.onVersionResolved?.()
    await first.acknowledge()
    const second = intake.receive.mock.calls[1]![0]
    await second.onItemComplete?.({
      status: 'imported',
      resource: { id: 'B', type: 'characterCard' },
    } as ImportResult)
    await second.acknowledge()
    await flushPromises()
    expect(setup.bindCards).toHaveBeenCalledOnce()
    expect(setup.bindCards.mock.calls[0]![1].map((item: { id: string }) => item.id)).toEqual(['B'])
  })

  it('continues same and later Web cohorts while a history choice waits, then binds complete cohorts in order', async () => {
    setup.webRunning = true
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'B.png' }
    const later = { ...job, id: '33333333-3333-4333-a333-333333333333', name: 'C.png' }
    setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    setup.summary.mockImplementation(async (id) => ({
      id,
      type: 'characterCard',
      name: id,
      fileName: `${id}.png`,
    }))
    const intake = start()
    await flushPromises()
    const first = intake.receive.mock.calls[0]![0]
    await first.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
    // Parsing must finish before this file ceases to own the import slot.
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    first.onProcessingSettled?.()
    await flushPromises()
    expect(setup.download).toHaveBeenCalledTimes(2)
    const second = intake.receive.mock.calls[1]![0]
    await second.onItemComplete?.({
      status: 'imported',
      resource: { id: 'B', type: 'characterCard' },
    } as ImportResult)
    await second.acknowledge()
    await flushPromises()
    expect(setup.bindCards).not.toHaveBeenCalled()
    setup.list.mockResolvedValueOnce({ jobs: [later], recent: [], hasMore: false })
    await intake.request()
    const third = intake.receive.mock.calls[2]![0]
    expect(setup.download).toHaveBeenCalledTimes(3)
    await third.onItemComplete?.({
      status: 'imported',
      resource: { id: 'C', type: 'characterCard' },
    } as ImportResult)
    await third.acknowledge()
    await flushPromises()
    expect(setup.bindCards).not.toHaveBeenCalled()
    await first.onVersionResolved?.('a'.repeat(64), 'A')
    await first.acknowledge()
    await flushPromises()
    expect(setup.bindCards).toHaveBeenCalledTimes(2)
    expect(setup.bindCards.mock.calls[0]![1].map((item: { id: string }) => item.id)).toEqual([
      'B',
      'A',
    ])
    expect(setup.bindCards.mock.calls[1]![1].map((item: { id: string }) => item.id)).toEqual(['C'])
    expect(setup.download).toHaveBeenCalledTimes(3)
  })

  it.each(
    ['notification', 'cloud acknowledgement'].flatMap((pendingPhase) =>
      ['download', 'parser callback', 'import result'].map((phase) => ({ pendingPhase, phase })),
    ),
  )(
    'continues after an unsupported file at $phase while its failed $pendingPhase is pending',
    async ({ pendingPhase, phase }) => {
      const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'next.png' }
      setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const ack = setup.ack.getMockImplementation()!
      if (pendingPhase === 'notification') setup.notify.mockImplementationOnce(() => pending)
      else
        setup.ack.mockImplementation((id, state, ...args) =>
          id === job.id && state === 'failed' ? pending : ack(id, state, ...args),
        )
      if (phase === 'download') setup.download.mockRejectedValueOnce(new Error('下载失败'))
      const intake = start()
      await flushPromises()
      const first = intake.receive.mock.calls[0]?.[0]
      let failing: void | Promise<void>
      if (phase === 'parser callback') failing = first!.onFailure!('不支持的酒馆资源文件')
      if (phase === 'import result') {
        await first!.onItemComplete?.({
          status: 'failed',
          message: '不支持的酒馆资源文件',
        } as ImportResult)
        failing = first!.acknowledge()
      }
      try {
        await flushPromises()
        expect(setup.download).toHaveBeenCalledTimes(2)
        expect(intake.receive).toHaveBeenCalledTimes(phase === 'download' ? 1 : 2)
        await intake.request()
        expect(setup.download).toHaveBeenCalledTimes(2)
      } finally {
        finish()
        await failing!
        await flushPromises()
      }
    },
  )

  it('retains a failed cloud receipt without re-downloading it and allows explicit retry', async () => {
    setup.ack.mockImplementation(async (_id, state) => {
      if (state === 'failed') throw new Error('ACK offline')
    })
    const intake = start()
    await flushPromises()
    await intake.receive.mock.calls[0]![0].onFailure!('不支持的资源')
    await flushPromises()
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    expect(
      taskCenter.list().find((task) => task.operationId === `discord-resource-${job.id}`),
    ).toMatchObject({
      status: 'failed',
      retryable: true,
    })
    await taskCenter.retry(`discord-resource-${job.id}`)
    expect(setup.download).toHaveBeenCalledTimes(2)
  })

  it('does not revive receiving after a late failure ACK when the user has paused', async () => {
    setup.webRunning = true
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const ack = setup.ack.getMockImplementation()!
    setup.ack.mockImplementation((id, state, ...args) =>
      state === 'failed' ? pending : ack(id, state, ...args),
    )
    const intake = start()
    await flushPromises()
    await intake.receive.mock.calls[0]![0].onFailure!('不支持的资源')
    await flushPromises()
    setup.webRunning = false
    setup.webPaused = true
    window.dispatchEvent(new Event('srl:web-inbox-state'))
    finish()
    await flushPromises()
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    setup.webRunning = true
    setup.webPaused = false
    await intake.request()
    expect(setup.download).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed Web cloud ACK retryable without blocking the next file or re-importing the committed one', async () => {
    setup.webRunning = true
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'next.json' }
    setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    const acknowledge = setup.ack.getMockImplementation()!
    let fail = true
    setup.ack.mockImplementation(async (id, state, ...args) => {
      if (id === job.id && state === 'imported' && fail) {
        fail = false
        throw new Error('ACK offline')
      }
      return acknowledge(id, state, ...args)
    })
    const intake = start()
    await flushPromises()
    const first = intake.receive.mock.calls[0]![0]
    await first.onItemComplete?.({
      status: 'imported',
      resource: { id: 'first', type: 'characterCard' },
    } as ImportResult)
    await expect(first.acknowledge()).rejects.toThrow('ACK offline')
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledTimes(2)
    expect(setup.download).toHaveBeenCalledTimes(2)
    expect(
      taskCenter.list().find((task) => task.operationId === `discord-resource-${job.id}`)?.status,
    ).toBe('failed')
    await taskCenter.retry(`discord-resource-${job.id}`)
    expect(setup.download).toHaveBeenCalledTimes(2)
    expect(intake.receive).toHaveBeenCalledTimes(2)
  })
  it('runs the Web download/import/binding cohort while hidden only with an explicit media session', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      setup.summary.mockResolvedValue({
        id: 'web-card',
        type: 'characterCard',
        name: '角色',
        fileName: 'card.json',
      })
      const intake = start()
      await flushPromises()
      expect(setup.download).not.toHaveBeenCalled()
      setup.webRunning = true
      await intake.request()
      await flushPromises()
      expect(setup.download).toHaveBeenCalledOnce()
      const batch = intake.receive.mock.calls[0]![0]
      expect(batch.canProcess?.()).toBe(true)
      document.dispatchEvent(new Event('visibilitychange'))
      expect(vi.mocked(setup.download).mock.calls[0]![2].aborted).toBe(false)
      await batch.onItemComplete?.({
        status: 'imported',
        resource: { id: 'web-card', type: 'characterCard' },
      } as ImportResult)
      await batch.acknowledge()
      await flushPromises()
      expect(setup.bindCards).toHaveBeenCalledOnce()
      // bindForeground is false: explicit background mode still follows the configured binding rules.
      expect(setup.summary).toHaveBeenCalledWith('web-card')
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()
      expect(intake.receive).toHaveBeenCalledOnce()
      expect(setup.download).toHaveBeenCalledOnce()
    } finally {
      visibility.mockRestore()
    }
  })
  it('retains an interrupted import and its file, and requires explicit resume before redelivery', async () => {
    setup.webRunning = true
    const intake = start()
    await flushPromises()
    const batch = intake.receive.mock.calls[0]![0]
    setup.webRunning = false
    setup.webPaused = true
    window.dispatchEvent(new Event('srl:web-inbox-state'))
    expect(batch.canProcess?.()).toBe(false)
    await batch.onFailure?.('用户已停止导入')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(setup.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }))
    setup.webRunning = true
    setup.webPaused = false
    await intake.request()
    expect(intake.receive).toHaveBeenCalledTimes(2)
    expect(setup.download).toHaveBeenCalledOnce()
    expect(intake.receive.mock.calls[1]![0].files[0]).toBe(batch.files[0])
  })
  it('keeps the same native attempt when returning to a half-downloaded attachment', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({ active: true, transferredBytes: 6, totalBytes: 12 })
    const intake = start()
    await flushPromises()
    window.dispatchEvent(new Event('srl:native-active'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.read).not.toHaveBeenCalled()
    expect(setup.ack).not.toHaveBeenCalled()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(taskCenter.list()[0]?.status).toBe('running')
  })
  it('does not replay a posted background result or cloud ACK while binding-owned staging is retained', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: {
        state: 'imported',
        resourceId: 'saved-resource',
        notificationPosted: true,
        cloudAckPending: false,
        automaticBindingPending: true,
      },
    })
    const intake = start()
    await flushPromises()
    const completion = () =>
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-completed', {
          detail: { cloud: true, token: `discord-url-${job.id}` },
        }),
      )
    completion()
    completion()
    await flushPromises()
    expect(setup.notify).not.toHaveBeenCalled()
    expect(setup.ack).not.toHaveBeenCalled()
    expect(setup.refresh).toHaveBeenCalledOnce()
    expect(taskCenter.list()).toEqual([])
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.cleanupNative).not.toHaveBeenCalled()
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: {
        state: 'imported',
        resourceId: 'saved-resource',
        notificationPosted: true,
        cloudAckPending: false,
        automaticBindingPending: false,
      },
    })
    completion()
    await flushPromises()
    expect(setup.cleanupNative).toHaveBeenCalledOnce()
    expect(setup.notify).not.toHaveBeenCalled()
    expect(setup.refresh).toHaveBeenCalledOnce()
  })

  it('shares an in-flight native read between a progress check and duplicate completion events', async () => {
    setup.native = true
    setup.list.mockResolvedValue({ jobs: [], recent: [], hasMore: false })
    const intake = start()
    await flushPromises()
    let resolve!: (value: unknown) => void
    setup.nativeRead.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    for (let index = 0; index < 3; index++)
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-completed', {
          detail: { cloud: true, token: `discord-url-${job.id}` },
        }),
      )
    await flushPromises()
    expect(setup.nativeRead).toHaveBeenCalledOnce()
    resolve({
      transferredBytes: 12,
      nativeImportOutcome: {
        state: 'duplicate_card',
        resourceId: 'saved-resource',
        notificationPosted: true,
        cloudAckPending: false,
      },
    })
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.cleanupNative).toHaveBeenCalledOnce()
    expect(taskCenter.list()).toEqual([])
  })

  it('settles an expired cloud receipt after a verified native duplicate without importing or notifying again', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: { state: 'duplicate_file', resourceId: 'existing-resource' },
    })
    setup.ack.mockRejectedValue(new DiscordInboxTaskExpiredError('resource'))
    const intake = start()
    await flushPromises()
    expect(setup.cleanupNative).toHaveBeenCalledWith(job.id)
    expect(taskCenter.list()).toEqual([])
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.notify).not.toHaveBeenCalled()
    expect(setup.notice).not.toHaveBeenCalled()
  })

  it.each([
    new Error('HTTP 503'),
    new Error('配对已失效'),
    new DiscordInboxTaskExpiredError('delivery'),
  ])(
    'retains failed native confirmation for explicit retry without polling or replaying the import: %s',
    async (error) => {
      vi.useFakeTimers()
      try {
        setup.native = true
        setup.nativeRead.mockResolvedValue({
          transferredBytes: 12,
          nativeImportOutcome: { state: 'imported', resourceId: 'saved-resource' },
        })
        setup.ack.mockRejectedValue(error)
        start()
        await flushPromises()
        const reads = setup.nativeRead.mock.calls.length
        await vi.advanceTimersByTimeAsync(5000)
        expect(setup.ack).toHaveBeenCalledOnce()
        expect(setup.nativeRead).toHaveBeenCalledTimes(reads)
        expect(setup.cleanupNative).not.toHaveBeenCalled()
        expect(setup.notice).toHaveBeenCalledOnce()
        expect(taskCenter.list()[0]?.status).toBe('failed')
        setup.ack.mockResolvedValue(undefined)
        expect(await taskCenter.retry(`discord-resource-${job.id}`)).toBe(true)
        expect(setup.cleanupNative).toHaveBeenCalledOnce()
        expect(taskCenter.list()).toEqual([])
        expect(setup.stage).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('retains binding-owned staging even when the committed cloud task has expired', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: {
        state: 'imported',
        resourceId: 'saved-resource',
        automaticBindingPending: true,
      },
    })
    setup.ack.mockRejectedValue(new DiscordInboxTaskExpiredError('resource'))
    start()
    await flushPromises()
    expect(setup.cleanupNative).not.toHaveBeenCalled()
    expect(taskCenter.list()).toEqual([])
    expect(setup.notice).not.toHaveBeenCalled()
  })
  it('removes completed receive tasks on native resume while retaining pending and failed tasks', async () => {
    setup.native = true
    setup.list.mockResolvedValue({ jobs: [], recent: [], hasMore: false })
    start()
    await flushPromises()
    taskCenter.start({
      operationId: 'discord-resource-completed',
      name: 'complete',
      phase: '已导入资源库',
    })
    taskCenter.complete('discord-resource-completed')
    taskCenter.start({
      operationId: 'discord-resource-pending',
      name: 'pending',
      phase: '已下载，等待解析导入',
    })
    taskCenter.start({ operationId: 'discord-resource-failed', name: 'failed', phase: '未完成' })
    taskCenter.fail('discord-resource-failed', 'import failed')
    taskCenter.start({ operationId: 'other-completed', name: 'other', phase: 'done' })
    taskCenter.complete('other-completed')
    window.dispatchEvent(new Event('srl:native-active'))
    await flushPromises()
    expect(
      taskCenter
        .list()
        .map((task) => task.operationId)
        .sort(),
    ).toEqual(['discord-resource-failed', 'discord-resource-pending', 'other-completed'])
  })
  it.each([
    'characterCard',
    'worldBook',
    'preset',
    'regex',
    'script',
    'beautification',
    'quickReply',
    'userPersona',
    'chat',
    'greeting',
    'plugin',
    'other',
  ])(
    'acknowledges a native background %s without re-delivering the file to the JS importer',
    async (resourceType) => {
      setup.native = true
      setup.nativeRead.mockResolvedValue({
        transferredBytes: 12,
        nativeImportOutcome: {
          state: 'imported',
          resourceId: 'native-resource-1',
          name: 'Mira',
          resourceType,
        },
      })
      const intake = start()
      await flushPromises()
      expect(intake.receive).not.toHaveBeenCalled()
      expect(setup.ack).toHaveBeenCalledWith(job.id, 'imported', target, undefined)
      expect(setup.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'imported' }))
      expect(setup.cleanupNative).toHaveBeenCalledWith(job.id)
      expect(taskCenter.list()).toEqual([])
      expect(setup.stage).not.toHaveBeenCalled()
      expect(setup.refresh).toHaveBeenCalledOnce()
      expect(setup.refresh).toHaveBeenCalledWith(['native-resource-1'])
    },
  )

  it('retains the full refresh fallback for an old native receipt without a resource ID', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: { state: 'imported' },
    })
    start()
    await flushPromises()
    expect(setup.refresh).toHaveBeenCalledExactlyOnceWith()
    expect(setup.cleanupNative).toHaveBeenCalledOnce()
  })

  it.each(['lock', 'target', 'unmount'] as const)(
    'ignores a native success read arriving after %s',
    async (change) => {
      setup.native = true
      let finish!: (value: unknown) => void
      setup.nativeRead.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const intake = start()
      await flushPromises()
      if (change === 'lock') intake.vault.value = { locked: true } as VaultStatus
      else if (change === 'target') setup.target = { ...target, libraryId: 'other' }
      else intake.wrapper.unmount()
      finish({
        transferredBytes: 12,
        nativeImportOutcome: { state: 'imported', resourceId: 'saved' },
      })
      await flushPromises()
      expect(setup.refresh).not.toHaveBeenCalled()
      expect(setup.ack).not.toHaveBeenCalled()
      expect(setup.cleanupNative).not.toHaveBeenCalled()
      expect(intake.receive).not.toHaveBeenCalled()
    },
  )

  it.each(['lock', 'target', 'unmount'] as const)(
    'retains a receipt when its refresh finishes after %s',
    async (change) => {
      setup.native = true
      const outcome = {
        transferredBytes: 12,
        nativeImportOutcome: { state: 'imported', resourceId: 'saved' },
      }
      setup.nativeRead.mockResolvedValue(outcome)
      let finish!: () => void
      setup.refresh.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      const intake = start()
      await flushPromises()
      expect(setup.refresh).toHaveBeenCalledExactlyOnceWith(['saved'])
      if (change === 'lock') intake.vault.value = { locked: true } as VaultStatus
      else if (change === 'target') setup.target = { ...target, libraryId: 'other' }
      else intake.wrapper.unmount()
      finish()
      await flushPromises()
      expect(setup.ack).not.toHaveBeenCalled()
      expect(setup.cleanupNative).not.toHaveBeenCalled()
      if (change === 'lock') {
        intake.vault.value = { locked: false } as VaultStatus
        await flushPromises()
        expect(setup.ack).toHaveBeenCalledWith(job.id, 'imported', target, undefined)
        expect(setup.cleanupNative).toHaveBeenCalledOnce()
      }
    },
  )

  it('refreshes committed native rows before an offline cloud acknowledgement, including repaired duplicates', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: { state: 'duplicate_card', resourceId: 'existing-card' },
    })
    setup.ack.mockImplementation(async (_id, state) => {
      if (state === 'imported') {
        expect(setup.refresh).toHaveBeenCalledOnce()
        return new Promise(() => undefined)
      }
    })
    const intake = start()
    await flushPromises()
    expect(setup.refresh).toHaveBeenCalledOnce()
    expect(setup.refresh).toHaveBeenCalledWith(['existing-card'])
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.cleanupNative).not.toHaveBeenCalled()
  })

  it('notifies a native duplicate as already present while acknowledging the cloud job as consumed', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      nativeImportOutcome: { state: 'duplicate_card', resourceId: 'existing-card', name: 'Mira' },
    })
    const intake = start()
    await flushPromises()
    expect(setup.ack).toHaveBeenCalledWith(job.id, 'imported', target, undefined)
    expect(setup.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'resource', state: 'duplicate' }),
    )
    expect(taskCenter.list()).toEqual([])
    expect(intake.receive).not.toHaveBeenCalled()
  })

  it('retries only cloud confirmation after a committed native import, without parsing or downloading again', async () => {
    setup.native = true
    const cleanup = vi.fn()
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      batch: { files: [new File(['{}'], 'card.json')], acknowledge: cleanup },
    })
    const intake = start()
    await flushPromises()
    setup.ack.mockRejectedValueOnce(new Error('HTTP 503'))
    await intake.receive.mock.calls[0]![0].acknowledge()
    await flushPromises()
    expect(taskCenter.list()[0]?.error).toContain('资源已导入')
    expect(cleanup).not.toHaveBeenCalled()
    expect(setup.notify.mock.calls.map(([result]) => result.state)).toEqual(['imported'])
    await taskCenter.retry(`discord-resource-${job.id}`)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.ack.mock.calls.map((call) => call[1])).toEqual(['imported', 'imported'])
    expect(taskCenter.list()).toEqual([])
  })

  it('exposes a native version decision even when the cloud progress acknowledgement never returns', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      batch: { files: [new File(['{}'], 'card.json')], acknowledge: vi.fn() },
    })
    const intake = start()
    await flushPromises()
    setup.ack.mockImplementation(() => new Promise(() => undefined))
    const batch = intake.receive.mock.calls[0]![0]
    let resolved = false
    void batch.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)?.then(() => {
      resolved = true
    })
    await flushPromises()
    expect(resolved).toBe(true)
    expect(setup.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'waiting_version' }))
    await batch.acknowledge()
    expect(setup.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'imported' }))
  })

  it('releases the importer after a local native commit while keeping staging until cloud confirmation succeeds', async () => {
    setup.native = true
    const cleanup = vi.fn()
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      batch: { files: [new File(['{}'], 'card.json')], acknowledge: cleanup },
    })
    setup.ack.mockImplementation(() => new Promise(() => undefined))
    const intake = start()
    await flushPromises()
    const batch = intake.receive.mock.calls[0]![0]
    let released = false
    void batch.acknowledge().then(() => {
      released = true
    })
    await flushPromises()
    expect(released).toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
    expect(setup.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'imported' }))
    setup.ack.mockResolvedValue(undefined)
    // A failed/in-flight confirmation must not requeue or download the local file.
    await intake.request()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(setup.stage).not.toHaveBeenCalled()
  })

  it('keeps independent native completions distinct while the cloud queue is unavailable', async () => {
    setup.native = true
    setup.inboxMode = true
    setup.list.mockImplementation(() => new Promise(() => undefined))
    setup.nativeRead.mockImplementation(async ({ id }) => ({
      transferredBytes: 12,
      batch: { files: [new File(['{}'], `${id}.json`)], acknowledge: vi.fn() },
    }))
    const intake = start()
    await flushPromises()
    const ids = [job.id, '22222222-2222-4222-a222-222222222222']
    for (const id of [...ids, ...ids])
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-completed', {
          detail: { cloud: true, token: `discord-url-${id}` },
        }),
      )
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledTimes(2)
    expect(taskCenter.list()).toHaveLength(2)
    expect(setup.stage).not.toHaveBeenCalled()
  })

  it.each(['target', 'vault'] as const)(
    'retains a claimed native file if %s changes while its metadata is read',
    async (change) => {
      setup.native = true
      setup.inboxMode = true
      setup.list.mockImplementation(() => new Promise(() => undefined))
      const intake = start()
      await flushPromises()
      const cleanup = vi.fn()
      setup.nativeRead.mockImplementation(async () => {
        if (change === 'target') setup.target = { ...target, libraryId: 'other-library' }
        else intake.vault.value = { locked: true } as VaultStatus
        return {
          transferredBytes: 12,
          batch: {
            files: [new File(['{}'], 'card.json')],
            nativeShareTokens: ['staged-token'],
            acknowledge: cleanup,
          },
        }
      })
      window.dispatchEvent(
        new CustomEvent('srl:native-share-download-completed', {
          detail: { cloud: true, token: `discord-url-${job.id}` },
        }),
      )
      await flushPromises()
      expect(intake.receive).not.toHaveBeenCalled()
      expect(cleanup).not.toHaveBeenCalled()
      expect(setup.release).toHaveBeenCalledWith('staged-token')
      expect(setup.ack).not.toHaveBeenCalled()
    },
  )

  it('does not adopt ordinary share completions as cloud resources', async () => {
    setup.native = true
    setup.list.mockImplementation(() => new Promise(() => undefined))
    const intake = start()
    await flushPromises()
    window.dispatchEvent(
      new CustomEvent('srl:native-share-download-completed', {
        detail: { cloud: false, token: `discord-url-${job.id}` },
      }),
    )
    await flushPromises()
    expect(setup.nativeRead).not.toHaveBeenCalled()
    expect(intake.receive).not.toHaveBeenCalled()
  })

  it('adopts a native cloud completion while its queue listing is still pending, once and into the checked target', async () => {
    setup.native = true
    setup.inboxMode = true
    setup.list.mockImplementation(() => new Promise(() => undefined))
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      totalBytes: 12,
      batch: { files: [new File(['{}'], 'card.json')], acknowledge: vi.fn() },
    })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const intake = start()
      await flushPromises()
      const event = new CustomEvent('srl:native-share-download-completed', {
        detail: { cloud: true, token: `discord-url-${job.id}` },
      })
      window.dispatchEvent(event)
      await flushPromises()
      expect(intake.receive).toHaveBeenCalledOnce()
      expect(setup.nativeRead).toHaveBeenCalledWith({ id: job.id, ...target })
      window.dispatchEvent(event)
      await flushPromises()
      expect(intake.receive).toHaveBeenCalledOnce()
      expect(setup.stage).not.toHaveBeenCalled()
      expect(setup.download).not.toHaveBeenCalled()
    } finally {
      visibility.mockRestore()
    }
  })

  it('delivers an already downloaded native file without waiting for a cloud progress acknowledgement', async () => {
    setup.native = true
    setup.ack.mockImplementation(() => new Promise(() => undefined))
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      totalBytes: 12,
      batch: { files: [new File(['{}'], 'card.json')], acknowledge: vi.fn() },
    })
    const intake = start()
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.read).not.toHaveBeenCalled()
  })

  it('preserves interrupted cloud imports and exposes an explicit cancel action', async () => {
    setup.native = true
    const cleanup = vi.fn()
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      totalBytes: 12,
      batch: {
        files: [new File(['{}'], 'card.json')],
        interrupted: true,
        acknowledge: cleanup,
      },
    })
    const intake = start()
    await flushPromises()

    const batch = intake.receive.mock.calls[0]![0]
    expect(batch.interrupted).toBe(true)
    expect(batch.onCancel).toBeDefined()
    await batch.onCancel?.()

    expect(setup.ack).toHaveBeenCalledWith(
      job.id,
      'cancelled',
      target,
      '用户取消了中断的资源解析。',
    )
    expect(setup.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'cancelled' }))
    expect(taskCenter.list()[0]?.status).toBe('cancelled')
    expect(cleanup).toHaveBeenCalledOnce()
    await batch.acknowledge()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('continues past an active first-page job instead of blocking later downloads', async () => {
    setup.native = true
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222', createdAt: 2 }
    setup.list
      .mockResolvedValueOnce({ jobs: [job], recent: [], hasMore: true })
      .mockResolvedValueOnce({ jobs: [next], recent: [], hasMore: false })
    start()
    await flushPromises()
    expect(setup.list).toHaveBeenNthCalledWith(2, target, `${job.createdAt}:${job.id}`)
    expect(setup.stage).toHaveBeenCalledTimes(2)
  })
  it('continues native staging after another resource fails to start downloading', async () => {
    setup.native = true
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222' }
    setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    setup.stage.mockRejectedValueOnce(new Error('first transfer failed'))
    start()
    await flushPromises()
    expect(setup.stage).toHaveBeenCalledTimes(2)
    expect(setup.stage.mock.calls[1]?.[0]).toMatchObject({ id: next.id })
    expect(setup.ack).toHaveBeenCalledWith(job.id, 'failed', target, 'first transfer failed')
  })
  it.each(['下载失败', '解析失败', '导入失败'])(
    'continues the next resource and its binding after %s',
    async (phase) => {
      const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'next.png' }
      setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
      setup.automation.mockResolvedValue({ bindForeground: true, bindSameAuthor: true })
      setup.summary.mockResolvedValue({
        id: 'later-card',
        type: 'characterCard',
        name: '后续角色卡',
        fileName: 'next.png',
      })
      if (phase === '下载失败') setup.download.mockRejectedValueOnce(new Error(phase))
      const intake = start()
      await flushPromises()
      if (phase !== '下载失败') {
        const first = intake.receive.mock.calls[0]![0]
        await first.onItemComplete?.({ status: 'failed', message: phase } as ImportResult)
        await first.acknowledge()
        await flushPromises()
      }
      const second = intake.receive.mock.calls.at(-1)![0]
      await second.onItemComplete?.({
        status: 'imported',
        resource: { id: 'later-card', type: 'characterCard' },
      } as ImportResult)
      await second.acknowledge()
      await flushPromises()
      expect(setup.download).toHaveBeenCalledTimes(2)
      expect(setup.ack.mock.calls).toContainEqual(expect.arrayContaining([job.id, 'failed']))
      expect(setup.ack.mock.calls).toContainEqual(expect.arrayContaining([next.id, 'imported']))
      expect(setup.summary).toHaveBeenCalledWith('later-card')
      expect(setup.bindCards).toHaveBeenCalledOnce()
    },
  )
  it('checks new cloud jobs while hidden only when the Android receive session is enabled', async () => {
    setup.native = true
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const intake = start()
      await flushPromises()
      expect(setup.list).not.toHaveBeenCalled()
      setup.inboxMode = true
      window.dispatchEvent(new Event('srl:receive-discord-inbox'))
      await flushPromises()
      expect(setup.stage).toHaveBeenCalledOnce()
      expect(intake.receive).not.toHaveBeenCalled()
      expect(setup.ack).not.toHaveBeenCalledWith(job.id, 'imported', expect.anything())
    } finally {
      visibility.mockRestore()
    }
  })
  it('receives resources after the existing shared pairing refresh event', async () => {
    setup.list.mockResolvedValueOnce({ jobs: [], recent: [], hasMore: false })
    const intake = start()
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('srl:receive-discord-inbox'))
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
  })
  it('delivers each Web attachment before downloading the next one', async () => {
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222', name: 'second.png' }
    setup.list.mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    setup.download
      .mockResolvedValueOnce(new File(['one'], job.name))
      .mockResolvedValueOnce(new File(['two'], 'second.png'))
    const intake = start()
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    const firstBatch = intake.receive.mock.calls[0]![0]
    expect(firstBatch.files.map((file) => file.name)).toEqual([job.name])
    expect(firstBatch.automaticCloud).toBe(true)
    expect(setup.download).toHaveBeenCalledOnce()
    await firstBatch.onItemComplete?.({
      status: 'imported',
      resource: { id: 'card-1', type: 'characterCard' },
    } as ImportResult)
    await firstBatch.acknowledge()
    await flushPromises()
    expect(firstBatch.files).toEqual([])
    expect(intake.receive).toHaveBeenCalledTimes(2)
    expect(intake.receive.mock.calls[1]![0].files.map((file) => file.name)).toEqual(['second.png'])
  })
  it('does not auto-bind files received by an explicit manual receive action', async () => {
    setup.list
      .mockResolvedValueOnce({ jobs: [], recent: [], hasMore: false })
      .mockResolvedValueOnce({ jobs: [job], recent: [], hasMore: false })
    const intake = start()
    await flushPromises()
    window.dispatchEvent(new Event('srl:receive-discord-resources'))
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(intake.receive.mock.calls[0]![0].automaticCloud).toBe(false)
  })
  it('settles five containers and a resolved history choice as two final logical cards', async () => {
    const names = ['A.png', 'A.json', 'A-old.json', 'B.png', 'B.json']
    const jobs = names.map((name, index) => ({
      ...job,
      name,
      id: `${String(index + 1).repeat(8)}-1111-4111-a111-111111111111`,
    }))
    setup.list.mockResolvedValueOnce({ jobs, recent: [], hasMore: false })
    setup.download.mockImplementation(async (item) => new File(['{}'], item.name))
    setup.automation.mockResolvedValue({ bindForeground: true, bindSameAuthor: true })
    const finalCards = ['A', 'B'].map((id) => ({
      id,
      type: 'characterCard',
      name: `${id} final`,
      fileName: `${id}.png`,
    }))
    setup.summary.mockImplementation(async (id) => finalCards.find((card) => card.id === id))
    const intake = start()
    await flushPromises()
    for (let index = 0; index < jobs.length; index += 1) {
      const batch = intake.receive.mock.calls[index]![0]
      expect(setup.download).toHaveBeenCalledTimes(index + 1)
      expect(batch.deferAutomaticBinding).toBe(true)
      if (index === 2) {
        await batch.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
        await batch.acknowledge()
        expect(setup.download).toHaveBeenCalledTimes(3)
        expect(setup.bindCards).not.toHaveBeenCalled()
        await batch.onVersionResolved?.('a'.repeat(64), 'A')
      } else {
        await batch.onItemComplete?.({
          status: 'imported',
          resource: { id: index < 3 ? 'A' : 'B', type: 'characterCard' },
        } as ImportResult)
      }
      expect(setup.bindCards).not.toHaveBeenCalled()
      await batch.acknowledge()
      await flushPromises()
      expect(batch.files).toEqual([])
    }
    expect(setup.summary.mock.calls.map(([id]) => id)).toEqual(['A', 'B'])
    expect(setup.bindCards).toHaveBeenCalledOnce()
    expect(setup.bindCards.mock.calls[0]![1]).toEqual(finalCards)
  })
  it('leaves all files unclaimed when a later metadata page fails and can resume on the next check', async () => {
    const next = { ...job, id: '22222222-2222-4222-a222-222222222222' }
    setup.list
      .mockResolvedValueOnce({ jobs: [job], recent: [], hasMore: true })
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce({ jobs: [job, next], recent: [], hasMore: false })
    const intake = start()
    await flushPromises()
    expect(setup.download).not.toHaveBeenCalled()
    expect(intake.receive).not.toHaveBeenCalled()
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    expect(intake.receive).toHaveBeenCalledOnce()
  })
  it('does not acknowledge an import when download completes or when a version still needs a decision', async () => {
    const intake = start()
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    const batch = intake.receive.mock.calls[0]![0]
    expect(setup.ack.mock.calls.map((call) => call[1])).toEqual(['downloading', 'importing'])
    expect(batch.route).toBe('resource')
    await batch.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
    await batch.acknowledge()
    expect(setup.ack.mock.calls.map((call) => call[1])).not.toContain('imported')
    expect(setup.notify).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'card.json', state: 'waiting_version' }),
    )
    await intake.request()
    expect(setup.download).toHaveBeenCalledOnce()
    await batch.onVersionResolved?.('a'.repeat(64))
    await batch.acknowledge()
    expect(setup.ack.mock.lastCall).toEqual([job.id, 'imported', target, undefined])
    expect(taskCenter.list()[0]?.status).toBe('completed')
    expect(setup.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'card.json', state: 'imported' }),
    )
  })
  it('a skipped version never becomes imported', async () => {
    const intake = start()
    await flushPromises()
    const batch = intake.receive.mock.calls[0]![0]
    await batch.onItemComplete?.({ status: 'versionCandidate' } as ImportResult)
    await batch.onVersionResolved?.()
    await batch.acknowledge()
    expect(setup.ack.mock.lastCall?.[1]).toBe('cancelled')
    expect(taskCenter.list()[0]?.status).toBe('cancelled')
    expect(setup.notify).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'cancelled' }))
  })
  it('retains a download failure, exposes retry and reports no successful import', async () => {
    setup.download.mockRejectedValue(new Error('网络失败'))
    const intake = start()
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.ack.mock.lastCall?.[1]).toBe('failed')
    expect(taskCenter.list()[0]).toMatchObject({ status: 'failed', retryable: true })
    expect(setup.notice).toHaveBeenCalledOnce()
    expect(setup.notify).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'card.json', state: 'failed' }),
    )
  })
  it('defers locked libraries and resumes without downloading into a changed pairing', async () => {
    const intake = start(true)
    await flushPromises()
    expect(setup.list).not.toHaveBeenCalled()
    setup.download.mockImplementation(async () => {
      setup.target = { ...target, libraryId: 'other-library' }
      return new File(['{}'], 'card.json')
    })
    intake.vault.value = { locked: false } as VaultStatus
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.ack.mock.calls.map((call) => call[1])).not.toContain('imported')
  })
  it('ends stale download progress when Android has no active work and retries through the original queue', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({ active: false, transferredBytes: 3, totalBytes: 12 })
    const intake = start()
    await flushPromises()
    const id = `discord-resource-${job.id}`
    const task = taskCenter.list().find((item) => item.operationId === id)!
    expect(task.status).toBe('failed')
    expect(setup.notice).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('下载任务已中断'),
      }),
    )
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.ack.mock.lastCall?.[1]).toBe('failed')
    expect(setup.stage).toHaveBeenCalledOnce()
    setup.nativeRead.mockResolvedValue({ active: true, transferredBytes: 3, totalBytes: 12 })
    await taskCenter.retry(id)
    await flushPromises()
    expect(setup.stage).toHaveBeenCalledOnce()
    expect(setup.ack.mock.calls.map((call) => call[1])).toContain('queued')
    expect(taskCenter.list().find((item) => item.operationId === id)?.status).toBe('running')
  })

  it('keeps work waiting for the network active without restarting or reporting failure', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({ active: true, transferredBytes: 3, totalBytes: 12 })
    const intake = start()
    await flushPromises()
    await intake.request()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.ack.mock.calls.map((call) => call[1])).not.toContain('failed')
    expect(setup.notice).not.toHaveBeenCalled()
  })

  it('hands native staging into the same importer once and releases it only after commit', async () => {
    setup.native = true
    setup.read.mockRejectedValue(new Error('直链已过期'))
    const cleanup = vi.fn()
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      totalBytes: 12,
      batch: {
        files: [new File([], 'card.json')],
        recoveryId: 'native-token',
        acknowledge: cleanup,
      },
    })
    const intake = start()
    await flushPromises()
    expect(setup.stage).not.toHaveBeenCalled()
    expect(setup.read).not.toHaveBeenCalled()
    expect(setup.download).not.toHaveBeenCalled()
    const batch = intake.receive.mock.calls[0]![0]
    expect(cleanup).not.toHaveBeenCalled()
    await batch.onItemComplete?.({ status: 'duplicate' } as ImportResult)
    await batch.acknowledge()
    await flushPromises()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(setup.ack.mock.lastCall?.[1]).toBe('imported')
    expect(setup.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'duplicate' }))
  })

  it('imports a claimed native completion when its WebView is alive in the background', async () => {
    setup.native = true
    const intake = start()
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    setup.nativeRead.mockResolvedValue({
      transferredBytes: 12,
      totalBytes: 12,
      batch: {
        files: [new File([], 'card.json')],
        recoveryId: 'background-native-token',
        acknowledge: vi.fn(),
      },
    })
    const listCalls = setup.list.mock.calls.length
    window.dispatchEvent(
      new CustomEvent('srl:native-share-download-completed', {
        detail: { token: 'download-token' },
      }),
    )
    await flushPromises()
    expect(intake.receive).toHaveBeenCalledOnce()
    expect(setup.list).toHaveBeenCalledTimes(listCalls)
    expect(setup.notify).not.toHaveBeenCalled()
    const batch = intake.receive.mock.calls[0]![0]
    await batch.onItemComplete?.({ status: 'imported' } as ImportResult)
    await batch.acknowledge()
    expect(setup.notify).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'card.json', state: 'imported' }),
    )
    visibility.mockRestore()
  })

  it('does not turn an already imported file into a parsing failure when cloud confirmation fails', async () => {
    const intake = start()
    await flushPromises()
    const batch = intake.receive.mock.calls[0]![0]
    await batch.onItemComplete?.({
      status: 'imported',
      resource: { id: 'card-1', type: 'characterCard' },
    } as ImportResult)
    setup.ack.mockRejectedValueOnce(new Error('HTTP 503'))
    await expect(batch.acknowledge()).rejects.toThrow('HTTP 503')
    await batch.onFailure?.('HTTP 503')
    expect(setup.notify.mock.calls.map(([result]) => result.state)).toEqual(['imported'])
    expect(setup.ack.mock.calls.map((call) => call[1])).not.toContain('failed')
    expect(taskCenter.list()[0]?.error).toContain('资源已导入')
  })

  it('keeps the native cancel action distinct from download failure', async () => {
    setup.native = true
    setup.nativeRead.mockResolvedValue({
      cancelled: true,
      error: '下载已取消',
      transferredBytes: 3,
      totalBytes: 12,
    })
    const intake = start()
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.ack.mock.lastCall?.[1]).toBe('cancelled')
    expect(taskCenter.list()[0]?.status).toBe('cancelled')
    expect(setup.notice).not.toHaveBeenCalled()
  })

  it('pauses a Web download when the page is hidden and retains the remote task for reopening', async () => {
    setup.download.mockImplementation(
      (_job, _target, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')))
        }),
    )
    const intake = start()
    await flushPromises()
    expect(setup.download).toHaveBeenCalledOnce()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(intake.receive).not.toHaveBeenCalled()
    expect(setup.ack.mock.lastCall?.[1]).toBe('queued')
    visibility.mockRestore()
  })
})
