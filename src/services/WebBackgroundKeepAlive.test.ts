/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Capacitor } from '@capacitor/core'
import { useConfirmDialogState } from '../composables/UseConfirmDialog'
import { TaskCenter } from '../core/TaskCenter'
import {
  WebBackgroundKeepAlive,
  acquireWebBackgroundAudio,
  withWebBackgroundAudio,
  requestWebBackgroundAudio,
  startWebBackgroundAudio,
  stopWebBackgroundAudio,
  webBackgroundAudioState,
} from './WebBackgroundKeepAlive'

let keepAlive: WebBackgroundKeepAlive
const interrupted = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null)))
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }),
  )
  keepAlive = new WebBackgroundKeepAlive(interrupted)
})

describe('confirmed operation retention', () => {
  const dialog = useConfirmDialogState()
  const pending = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it('cancels a queued question without playing or retaining a stopped task', async () => {
    const controller = new AbortController()
    const asked = requestWebBackgroundAudio('导入', controller.signal)
    controller.abort()
    const release = await asked
    release()
    expect(dialog.activeDialog.value).toBeUndefined()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  })

  it('keeps audio until async cancellation acknowledges its safe boundary', async () => {
    const center = new TaskCenter(),
      stopped = pending()
    let id = ''
    const start = withWebBackgroundAudio('下载', async () => {
      id = center.start({
        name: '下载',
        keepAlive: true,
        cancelable: true,
        cancel: () => stopped.promise,
      })
    })()
    dialog.respond('confirm')
    await start
    expect(center.cancel(id)).toBe(true)
    expect(webBackgroundAudioState().status).toBe('running')
    stopped.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(webBackgroundAudioState().status).toBe('off')
    center.complete(id)
    expect(webBackgroundAudioState().status).toBe('off')
  })

  it('replaces the same task ID without restarting audio or leaking its old request', async () => {
    const center = new TaskCenter()
    const start = withWebBackgroundAudio('下载', async () => {
      center.start({ operationId: 'same', name: 'first', keepAlive: true })
    })()
    dialog.respond('confirm')
    await start
    center.start({ operationId: 'same', name: 'second', keepAlive: true })
    expect(webBackgroundAudioState().tasks).toBe(1)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    center.complete('same')
    expect(webBackgroundAudioState().status).toBe('off')
  })

  it('cannot revive temporary audio when work finishes before play resolves', async () => {
    const playing = pending()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playing.promise)
    const work = withWebBackgroundAudio('备份', async () => undefined)()
    dialog.respond('confirm')
    await work
    expect(webBackgroundAudioState().status).toBe('off')
    playing.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(webBackgroundAudioState()).toMatchObject({ status: 'off', tasks: 0 })
  })

  it('asks before work, starts play in the confirm click, and releases on completion', async () => {
    const work = pending()
    const run = vi.fn(() => work.promise)
    const done = withWebBackgroundAudio('云备份', run)()
    expect(run).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(dialog.activeDialog.value?.cancelLabel).toBe('直接继续')
    dialog.respond('confirm')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledOnce()
    expect(webBackgroundAudioState()).toMatchObject({ status: 'running', manual: false, tasks: 1 })
    work.resolve()
    await done
    expect(webBackgroundAudioState()).toMatchObject({ status: 'off', tasks: 0 })
  })

  it('continues without audio when declined, and unconfirmed tasks never start playback', async () => {
    const run = vi.fn(async () => 42)
    const done = withWebBackgroundAudio('导入', run)()
    dialog.respond('cancel')
    await expect(done).resolves.toBe(42)
    const release = acquireWebBackgroundAudio()
    release()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(webBackgroundAudioState().status).toBe('off')
  })

  it('borrows manual audio without a prompt and never stops it on completion or failure', async () => {
    await startWebBackgroundAudio()
    await withWebBackgroundAudio('备份', async () => undefined)()
    await expect(
      withWebBackgroundAudio('导入', async () => {
        throw Error('failed')
      })(),
    ).rejects.toThrow('failed')
    expect(dialog.activeDialog.value).toBeUndefined()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(webBackgroundAudioState()).toMatchObject({ status: 'running', manual: true, tasks: 0 })
  })

  it('shares overlapping operations, and a manual request made mid-task survives both endings', async () => {
    const a = pending(),
      b = pending()
    const first = withWebBackgroundAudio('备份', () => a.promise)()
    dialog.respond('confirm')
    await Promise.resolve()
    const second = withWebBackgroundAudio('导入', () => b.promise)()
    expect(dialog.activeDialog.value).toBeUndefined()
    a.resolve()
    await first
    expect(webBackgroundAudioState()).toMatchObject({ status: 'running', manual: false, tasks: 1 })
    await startWebBackgroundAudio()
    b.resolve()
    await second
    expect(webBackgroundAudioState()).toMatchObject({ status: 'running', manual: true, tasks: 0 })
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
  })

  it.each(['complete', 'fail', 'cancelled'] as const)(
    'holds a handed-off task until %s, without autoplaying later terminal cards',
    async (settle) => {
      const center = new TaskCenter()
      let id = ''
      const done = withWebBackgroundAudio('后台收件', async () => {
        id = center.start({ name: '收件', keepAlive: true })
      })()
      dialog.respond('confirm')
      await done
      expect(webBackgroundAudioState()).toMatchObject({ status: 'running', tasks: 1 })
      if (settle === 'fail') center.fail(id, 'offline')
      else center[settle](id)
      expect(webBackgroundAudioState()).toMatchObject({ status: 'off', tasks: 0 })
      const terminal = center.start({ name: '旧的失败卡片' })
      center.cancelled(terminal)
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    },
  )

  it('continues business once if playback is rejected, with no retry or recurring prompt', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('gesture', 'NotAllowedError'),
    )
    const run = vi.fn(async () => 'saved')
    const done = withWebBackgroundAudio('备份', run)()
    dialog.respond('confirm')
    await expect(done).resolves.toBe('saved')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledOnce()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(dialog.activeDialog.value).toBeUndefined()
    expect(webBackgroundAudioState()).toMatchObject({ status: 'off', manual: false, tasks: 0 })
  })

  it('does not let a late play or old release revive audio or stop a new request after page exit', async () => {
    const playing = pending(),
      work = pending()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(playing.promise)
    const done = withWebBackgroundAudio('备份', () => work.promise)()
    dialog.respond('confirm')
    await Promise.resolve()
    window.dispatchEvent(new Event('pagehide'))
    playing.resolve()
    await Promise.resolve()
    await startWebBackgroundAudio()
    work.resolve()
    await done
    expect(webBackgroundAudioState()).toMatchObject({ status: 'running', manual: true, tasks: 0 })
  })

  it('does not prompt or use web audio on native APK', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    await expect(withWebBackgroundAudio('备份', async () => 1)()).resolves.toBe(1)
    expect(dialog.activeDialog.value).toBeUndefined()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  })
})
afterEach(() => {
  keepAlive.stop()
  stopWebBackgroundAudio()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('web media retention', () => {
  it('provides a shared global audio session without any inbox pairing or vault initialization', async () => {
    const first = startWebBackgroundAudio()
    const second = startWebBackgroundAudio()
    expect(second).toBe(first)
    expect(webBackgroundAudioState().status).toBe('starting')
    await first
    expect(webBackgroundAudioState().status).toBe('running')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    await startWebBackgroundAudio()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('pagehide'))
    expect(webBackgroundAudioState().status).toBe('off')
  })
  it('starts audio in the initiating call without network traffic and releases its object URL on stop', async () => {
    const pending = keepAlive.start()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    await pending
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).not.toHaveBeenCalled()
    keepAlive.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
  it('reports audio interruptions but intentional cleanup does not request recovery', async () => {
    const created = vi.spyOn(window, 'Audio')
    await keepAlive.start()
    const audio = created.mock.results[0]!.value as HTMLAudioElement
    expect(audio.loop).toBe(true)
    expect(audio.muted).toBe(false)
    audio.dispatchEvent(new Event('pause'))
    expect(interrupted).toHaveBeenCalledOnce()
    keepAlive.stop()
    audio.dispatchEvent(new Event('pause'))
    expect(interrupted).toHaveBeenCalledOnce()
  })
  it('cleans up a rejected play without marking retention active', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('gesture', 'NotAllowedError'),
    )
    await expect(keepAlive.start()).rejects.toThrow('gesture')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it('cannot restart after stop while the initial play promise is pending', async () => {
    let played!: () => void
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        played = resolve
      }),
    )
    const pending = keepAlive.start()
    keepAlive.stop()
    played()
    await expect(pending).rejects.toThrow('已停止保活')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).not.toHaveBeenCalled()
  })
})
