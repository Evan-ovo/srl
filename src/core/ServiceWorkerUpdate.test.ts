/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }))
import { relaunchAfterWaitingWorkerControls } from './ServiceWorkerUpdate'

import {
  SERVICE_WORKER_UPDATE_INTERVAL_MS,
  startServiceWorkerUpdateChecks,
} from './ServiceWorkerUpdateChecks'

function registrationWith(update: () => Promise<unknown>): ServiceWorkerRegistration {
  return { update } as unknown as ServiceWorkerRegistration
}

describe('startServiceWorkerUpdateChecks', () => {
  let visibilityState: DocumentVisibilityState = 'visible'

  afterEach(() => {
    visibilityState = 'visible'
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function watchVisibility(): void {
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
  }

  it('shares an unfinished registration check across visible, focus and online events', () => {
    watchVisibility()
    let finish!: () => void
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      expect(update).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      finish()
    }
  })

  it('releases a failed check for the next event without scheduling an automatic retry', async () => {
    watchVisibility()
    const update = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    try {
      window.dispatchEvent(new Event('focus'))
      expect(update).toHaveBeenCalledOnce()
      await flushPromises()
      expect(update).toHaveBeenCalledOnce()
      window.dispatchEvent(new Event('online'))
      expect(update).toHaveBeenCalledTimes(2)
      await flushPromises()
    } finally {
      stop()
    }
  })

  it('注册完成时立即检查一次更新', () => {
    watchVisibility()
    const update = vi.fn(async () => undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))

    expect(update).toHaveBeenCalledTimes(1)

    stop()
  })

  it('页面从后台回到前台时立即检查更新', async () => {
    watchVisibility()
    const update = vi.fn(async () => undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    await flushPromises()
    update.mockClear()

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(update).not.toHaveBeenCalled()

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(update).toHaveBeenCalledTimes(1)

    stop()
  })

  it('窗口获得焦点或网络恢复时补查更新', async () => {
    watchVisibility()
    const update = vi.fn(async () => undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    await flushPromises()
    update.mockClear()

    window.dispatchEvent(new Event('focus'))
    expect(update).toHaveBeenCalledTimes(1)

    await flushPromises()
    window.dispatchEvent(new Event('online'))
    expect(update).toHaveBeenCalledTimes(2)

    stop()
  })

  it('应用常驻前台时按固定间隔检查', async () => {
    vi.useFakeTimers()
    watchVisibility()
    const update = vi.fn(async () => undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    update.mockClear()

    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_UPDATE_INTERVAL_MS - 1)
    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_UPDATE_INTERVAL_MS)
    expect(update).toHaveBeenCalledTimes(2)

    stop()
  })

  it('隐藏页面不做定时检查，停止后移除所有触发器', async () => {
    vi.useFakeTimers()
    watchVisibility()
    const update = vi.fn(async () => undefined)
    const stop = startServiceWorkerUpdateChecks(registrationWith(update))
    update.mockClear()

    visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_UPDATE_INTERVAL_MS)
    expect(update).not.toHaveBeenCalled()

    stop()
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_UPDATE_INTERVAL_MS)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('用户选择的更新完成后重新打开', () => {
  it('首次注册时没有controller，仍在目标worker接管后刷新一次', () => {
    const target = new EventTarget()
    const waiting = {} as ServiceWorker
    const container = Object.assign(target, { controller: null as ServiceWorker | null })
    const apply = vi.fn()
    const relaunch = vi.fn()
    relaunchAfterWaitingWorkerControls(
      container as ServiceWorkerContainer,
      waiting,
      apply,
      relaunch,
    )
    expect(apply).toHaveBeenCalledTimes(1)
    expect(relaunch).not.toHaveBeenCalled()
    container.controller = {} as ServiceWorker
    container.dispatchEvent(new Event('controllerchange'))
    expect(relaunch).not.toHaveBeenCalled()
    container.controller = waiting
    container.dispatchEvent(new Event('controllerchange'))
    container.dispatchEvent(new Event('controllerchange'))
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('替换或取消待处理更新会移除旧监听，不留下额外刷新', () => {
    const waiting = {} as ServiceWorker
    const container = Object.assign(new EventTarget(), { controller: waiting })
    const relaunch = vi.fn()
    const stop = relaunchAfterWaitingWorkerControls(
      container as ServiceWorkerContainer,
      waiting,
      vi.fn(),
      relaunch,
    )
    stop()
    container.dispatchEvent(new Event('controllerchange'))
    expect(relaunch).not.toHaveBeenCalled()
  })
})
