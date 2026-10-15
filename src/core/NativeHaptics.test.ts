/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeSystemUi = vi.hoisted(() => ({ performHaptic: vi.fn() }))
const capacitor = vi.hoisted(() => ({ available: true, platform: 'android', native: true }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => capacitor.platform,
    isPluginAvailable: () => capacitor.available,
  },
  registerPlugin: () => nativeSystemUi,
}))

import { setNativeHapticsEnabled, triggerNativeHaptic } from './NativeHaptics'

describe('NativeHaptics', () => {
  beforeEach(() => {
    localStorage.clear()
    nativeSystemUi.performHaptic.mockReset().mockResolvedValue({ performed: true })
    capacitor.available = true
    capacitor.platform = 'android'
    capacitor.native = true
    vi.stubGlobal('navigator', { ...navigator, vibrate: vi.fn() })
  })

  it('uses the Android semantic haptic while the existing preference is enabled', async () => {
    setNativeHapticsEnabled(true)

    await triggerNativeHaptic('confirm')

    expect(nativeSystemUi.performHaptic).toHaveBeenCalledWith({ kind: 'confirm' })
    expect(navigator.vibrate).not.toHaveBeenCalled()
  })

  it('does nothing when the existing preference is disabled', async () => {
    setNativeHapticsEnabled(false)

    await triggerNativeHaptic('success')

    expect(nativeSystemUi.performHaptic).not.toHaveBeenCalled()
    expect(navigator.vibrate).not.toHaveBeenCalled()
  })

  it('uses browser vibration only when the native plugin is unavailable', async () => {
    capacitor.available = false
    setNativeHapticsEnabled(true)

    await triggerNativeHaptic('warning')

    expect(nativeSystemUi.performHaptic).not.toHaveBeenCalled()
    expect(navigator.vibrate).toHaveBeenCalledWith([18, 40, 22])
  })

  it('does not override Android when the system declines to perform feedback', async () => {
    nativeSystemUi.performHaptic.mockResolvedValue({ performed: false })
    setNativeHapticsEnabled(true)

    await triggerNativeHaptic('success')

    expect(navigator.vibrate).not.toHaveBeenCalled()
  })

  it('falls back only for older native bridges that report UNIMPLEMENTED', async () => {
    nativeSystemUi.performHaptic.mockRejectedValue({ code: 'UNIMPLEMENTED' })
    setNativeHapticsEnabled(true)

    await triggerNativeHaptic('confirm')

    expect(navigator.vibrate).toHaveBeenCalledWith(12)
  })
  it('does not deliver a late fallback vibration after the user switches feedback off', async () => {
    let reject!: (error: { code: string }) => void
    nativeSystemUi.performHaptic.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    setNativeHapticsEnabled(true)
    const pending = triggerNativeHaptic('confirm')
    setNativeHapticsEnabled(false)
    reject({ code: 'UNIMPLEMENTED' })
    await pending
    expect(navigator.vibrate).not.toHaveBeenCalled()
  })
})
