/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  load: vi.fn(),
  prompt: vi.fn(async () => 'cancel'),
  install: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  registerPlugin: () => ({
    getCurrentVersion: async () => ({ versionCode: 1, versionName: '1' }),
    downloadAndInstall: state.install,
  }),
}))
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=apk-privacy-test-provider
vi.mock('./GitHubAndroidApkRelease', () => ({ loadAndroidApkRelease: state.load }))
// SRL-PUBLIC-SYNC: END REPLACE id=apk-privacy-test-provider
vi.mock('../composables/UseConfirmDialog', () => ({ chooseAction: state.prompt }))
import { checkForAndroidAppUpdate, installAndroidAppUpdateChecks } from './AndroidAppUpdate'
import {
  acknowledgeProjectNotice,
  getAutomaticApkUpdateChecks,
  setAutomaticApkUpdateChecks,
  PROJECT_NOTICE_ACKNOWLEDGED_COOKIE,
} from '../services/BrowserDevicePreferences'
const release = {
  versionCode: 2,
  versionName: '2',
  apkUrl: 'https://example.test/update.apk',
  sha256: 'a'.repeat(64),
}
let stop: (() => void) | undefined
beforeEach(() => {
  localStorage.clear()
  document.cookie = `${PROJECT_NOTICE_ACKNOWLEDGED_COOKIE}=; Max-Age=0; Path=/`
  state.load.mockReset().mockResolvedValue({ status: 200, release })
  state.prompt.mockClear()
  state.install.mockClear()
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})
describe('APK update privacy choice', () => {
  it('defaults off and sends no startup/online/resume request before or after acknowledgement', async () => {
    vi.useFakeTimers()
    expect(getAutomaticApkUpdateChecks()).toBe(false)
    stop = installAndroidAppUpdateChecks()
    acknowledgeProjectNotice()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('srl:native-active'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.load).not.toHaveBeenCalled()
  })
  it('requires the current notice even if automatic checking was enabled earlier', async () => {
    setAutomaticApkUpdateChecks(true)
    await expect(checkForAndroidAppUpdate()).resolves.toContain('说明')
    expect(state.load).not.toHaveBeenCalled()
    acknowledgeProjectNotice()
    await checkForAndroidAppUpdate()
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(getAutomaticApkUpdateChecks()).toBe(true)
  })
  it('starts only after both choices, then disabling prevents future lifecycle requests', async () => {
    stop = installAndroidAppUpdateChecks()
    setAutomaticApkUpdateChecks(true)
    await Promise.resolve()
    expect(state.load).not.toHaveBeenCalled()
    acknowledgeProjectNotice()
    await vi.waitFor(() => expect(state.load).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(state.prompt).toHaveBeenCalledTimes(1))
    setAutomaticApkUpdateChecks(false)
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('srl:native-active'))
    await expect(checkForAndroidAppUpdate()).resolves.toContain('关闭')
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(getAutomaticApkUpdateChecks()).toBe(false)
  })
  it('aborts an automatic manifest request and discards even a transport that completes late', async () => {
    stop = installAndroidAppUpdateChecks()
    acknowledgeProjectNotice()
    let finish!: (value: unknown) => void
    let signal!: AbortSignal
    state.load.mockImplementationOnce((value: AbortSignal) => {
      signal = value
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    setAutomaticApkUpdateChecks(true)
    await vi.waitFor(() => expect(signal).toBeDefined())
    setAutomaticApkUpdateChecks(false)
    expect(signal.aborted).toBe(true)
    finish({ status: 200, release })
    await vi.waitFor(() => expect(localStorage.getItem('srl.apk-update.last-check-at')).toBeNull())
    expect(state.prompt).not.toHaveBeenCalled()
    await expect(checkForAndroidAppUpdate()).resolves.toContain('关闭')
    expect(state.install).not.toHaveBeenCalled()
  })
  it('re-enabling after cancellation starts one fresh check and cannot revive the old response', async () => {
    stop = installAndroidAppUpdateChecks()
    acknowledgeProjectNotice()
    let finish!: (value: unknown) => void
    state.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    setAutomaticApkUpdateChecks(true)
    await vi.waitFor(() => expect(state.load).toHaveBeenCalledTimes(1))
    setAutomaticApkUpdateChecks(false)
    setAutomaticApkUpdateChecks(true)
    finish({ status: 200, release })
    await vi.waitFor(() => expect(state.load).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(state.prompt).toHaveBeenCalledTimes(1))
  })
  it('turning off background checks does not cancel an explicit manual check sharing that request', async () => {
    stop = installAndroidAppUpdateChecks()
    acknowledgeProjectNotice()
    let finish!: (value: unknown) => void
    let signal!: AbortSignal
    state.load.mockImplementationOnce((value: AbortSignal) => {
      signal = value
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    setAutomaticApkUpdateChecks(true)
    await vi.waitFor(() => expect(signal).toBeDefined())
    const manual = checkForAndroidAppUpdate(true)
    setAutomaticApkUpdateChecks(false)
    expect(signal.aborted).toBe(false)
    finish({ status: 200, release })
    await manual
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(state.prompt).toHaveBeenCalledTimes(1)
  })
  it('does not restore the device opt-in from a general-preferences backup', async () => {
    const { BrowserStorageService } = await import('../services/BrowserStorageService')
    const service = new BrowserStorageService()
    setAutomaticApkUpdateChecks(true)
    const backup = service.exportGeneralPreferences()
    localStorage.clear()
    service.importGeneralPreferences(backup)
    expect(getAutomaticApkUpdateChecks()).toBe(false)
    expect(state.load).not.toHaveBeenCalled()
  })
  it('keeps explicit manual checks available while automatic checks are disabled', async () => {
    await checkForAndroidAppUpdate(true)
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(state.prompt).toHaveBeenCalledTimes(1)
    expect(getAutomaticApkUpdateChecks()).toBe(false)
  })
})
