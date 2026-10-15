/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WebBackgroundKeepAlive,
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
