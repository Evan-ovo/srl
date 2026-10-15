/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({
  play: vi.fn(),
  stop: vi.fn(),
  initialize: vi.fn(),
  locked: false,
  connection: {
    workerUrl: 'https://worker.example',
    libraryId: 'library-1',
    secret: 'test-pairing',
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('./WebBackgroundKeepAlive', () => ({
  WebBackgroundKeepAlive: class {
    start = runtime.play
    stop = runtime.stop
  },
}))
vi.mock('./DiscordHandoffService', () => ({ inboxConnection: () => ({ ...runtime.connection }) }))
vi.mock('../core/LibraryContainer', () => ({
  initializeVaultOnce: runtime.initialize,
  vaultService: { getStatus: () => ({ locked: runtime.locked }) },
}))
import {
  checkWebDiscordInbox,
  isWebDiscordInboxPaused,
  isWebDiscordInboxRunning,
  pauseWebDiscordInbox,
  registerWebInboxParticipant,
  startWebDiscordInbox,
  webDiscordInboxState,
} from './WebDiscordInboxSession'
const unregister: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
  pauseWebDiscordInbox('', false)
  localStorage.clear()
  vi.clearAllMocks()
  runtime.locked = false
  runtime.connection.libraryId = 'library-1'
  runtime.play.mockResolvedValue(undefined)
  runtime.initialize.mockResolvedValue(undefined)
})
afterEach(() => {
  pauseWebDiscordInbox()
  for (const stop of unregister.splice(0)) stop()
  vi.useRealTimers()
})
describe('explicit browser inbox session', () => {
  it('checks for new jobs after backgrounding, then stops all polling until explicit resume', async () => {
    const receive = vi.fn().mockResolvedValue(undefined)
    unregister.push(registerWebInboxParticipant('test', receive))
    await startWebDiscordInbox()
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledOnce()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(receive).toHaveBeenCalledTimes(2)
    pauseWebDiscordInbox()
    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(isWebDiscordInboxPaused()).toBe(true)
    await startWebDiscordInbox()
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledTimes(3)
  })
  it('aborts a pending cycle; its late resolution cannot schedule more work', async () => {
    let complete!: () => void
    let signal!: AbortSignal
    unregister.push(
      registerWebInboxParticipant('test', async (cycle) => {
        signal = cycle.signal
        await new Promise<void>((resolve) => {
          complete = resolve
        })
      }),
    )
    await startWebDiscordInbox()
    expect(signal.aborted).toBe(false)
    pauseWebDiscordInbox()
    expect(signal.aborted).toBe(true)
    complete()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isWebDiscordInboxRunning()).toBe(false)
    expect(webDiscordInboxState().status).toBe('paused')
  })
  it('does not claim running when vault initialization fails', async () => {
    runtime.initialize.mockRejectedValueOnce(new Error('vault unavailable'))
    await expect(startWebDiscordInbox()).rejects.toThrow('vault unavailable')
    expect(isWebDiscordInboxRunning()).toBe(false)
    expect(isWebDiscordInboxPaused()).toBe(true)
  })
  it('starts and stops receiving without starting or stopping global audio', async () => {
    await startWebDiscordInbox()
    expect(isWebDiscordInboxRunning()).toBe(true)
    await pauseWebDiscordInbox()
    expect(runtime.play).not.toHaveBeenCalled()
    expect(runtime.stop).not.toHaveBeenCalled()
  })
  it('stops a changed target and does not silently restart on vault unlock', async () => {
    await startWebDiscordInbox()
    await vi.advanceTimersByTimeAsync(0)
    runtime.connection.libraryId = 'other'
    await checkWebDiscordInbox()
    expect(isWebDiscordInboxRunning()).toBe(false)
    window.dispatchEvent(new Event('srl:vault-unlocked'))
    expect(isWebDiscordInboxRunning()).toBe(false)
  })
  it('stops after the same five-hour session budget as native inbox mode', async () => {
    await startWebDiscordInbox()
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)
    expect(isWebDiscordInboxRunning()).toBe(false)
    expect(webDiscordInboxState().message).toContain('5 小时')
  })
})
