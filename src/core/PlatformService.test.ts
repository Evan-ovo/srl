/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  getInfo: vi.fn(),
  getState: vi.fn(),
  setShowStatusBar: vi.fn(),
  clearLocalData: vi.fn(),
}))
const capacitor = vi.hoisted(() => ({ available: true }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.available,
    getPlatform: () => 'android',
    isPluginAvailable: () => capacitor.available,
  },
  registerPlugin: () => native,
}))

import { getPlatformInfo, platform, requirePlatformCapability } from './PlatformService'
import { setNativeStatusBarVisible } from './NativeSystemUi'
import { refreshSystemInsets } from './SystemInsetsService'

describe('PlatformService', () => {
  it('clears native app data only with the actual capability and never falls back to browser clearing', async () => {
    const phrase = '我已了解到该操作会清除srl的数据，并确保我的确想这么做。'
    await expect(platform.maintenance.clearLocalData(phrase)).rejects.toThrow('系统设置')
    expect(native.clearLocalData).not.toHaveBeenCalled()
    native.getInfo.mockResolvedValueOnce({ capabilities: ['clear-app-user-data-v1'] })
    await platform.maintenance.clearLocalData(phrase)
    expect(native.clearLocalData).toHaveBeenCalledWith({ confirmation: phrase })
    capacitor.available = false
    await expect(platform.maintenance.clearLocalData(phrase)).rejects.toThrow('仅用于 Android')
    expect(native.clearLocalData).toHaveBeenCalledOnce()
  })
  const browserSafeArea = (edge: 'top' | 'right' | 'bottom' | 'left') =>
    `env(safe-area-inset-${edge}, 0px)`

  beforeEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    capacitor.available = true
    native.getState.mockResolvedValue({ showStatusBar: true })
    native.setShowStatusBar.mockImplementation(async ({ show }: { show: boolean }) => ({
      showStatusBar: show,
    }))
    native.getInfo.mockResolvedValue({
      apiVersion: 1,
      capabilities: ['system-insets-v1'],
      insets: { top: 31, bottom: 18 },
      network: { offline: false, wifi: true, cellular: false, metered: false, validated: true },
    })
    document.documentElement.removeAttribute('style')
    delete document.documentElement.dataset.statusBarVisible
    vi.clearAllMocks()
  })

  it('exposes native API version/capabilities and centralizes safe-area variables', async () => {
    const info = await refreshSystemInsets()
    expect(info.kind).toBe('android')
    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('31px')
    expect(document.documentElement.style.getPropertyValue('--safe-right')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('18px')
    expect(document.documentElement.style.getPropertyValue('--safe-left')).toBe('0px')
    expect(document.documentElement.dataset.statusBarVisible).toBe('true')
    expect(document.documentElement.dataset.nativeApiVersion).toBe('1')
  })

  it('reports an old shell instead of silently using an unavailable native API', async () => {
    const info = await getPlatformInfo()
    expect(() => requirePlatformCapability(info, 'native-stream-transfer-v2')).toThrow(
      'APK 外壳过旧',
    )
  })

  it('converts Android physical insets to CSS pixels before exposing safe-area variables', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.5 })
    native.getInfo.mockResolvedValueOnce({
      apiVersion: 1,
      capabilities: ['system-insets-v1'],
      insets: { top: 100, bottom: 80 },
      network: { offline: false, wifi: true, cellular: false, metered: false, validated: true },
    })

    await refreshSystemInsets()

    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('40px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('32px')
  })

  it('clears only the Android top inset when the status bar is hidden', async () => {
    native.getState.mockResolvedValueOnce({ showStatusBar: false })

    await refreshSystemInsets()

    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe('0px')
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe('18px')
    expect(document.documentElement.dataset.statusBarVisible).toBe('false')
  })

  it('uses browser safe-area env values for web and iOS PWA layouts', async () => {
    capacitor.available = false

    await refreshSystemInsets()

    expect(document.documentElement.style.getPropertyValue('--safe-top')).toBe(
      browserSafeArea('top'),
    )
    expect(document.documentElement.style.getPropertyValue('--safe-right')).toBe(
      browserSafeArea('right'),
    )
    expect(document.documentElement.style.getPropertyValue('--safe-bottom')).toBe(
      browserSafeArea('bottom'),
    )
    expect(document.documentElement.style.getPropertyValue('--safe-left')).toBe(
      browserSafeArea('left'),
    )
    expect(document.documentElement.dataset.statusBarVisible).toBeUndefined()
  })

  it('notifies the inset service immediately after changing Android status bar visibility', async () => {
    const listener = vi.fn()
    window.addEventListener('srl:system-ui-changed', listener, { once: true })

    await expect(setNativeStatusBarVisible(false)).resolves.toEqual({ showStatusBar: false })

    expect(native.setShowStatusBar).toHaveBeenCalledWith({ show: false })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('provides one stable facade for every platform capability domain', async () => {
    expect(Object.keys(platform)).toEqual([
      'maintenance',
      'capabilities',
      'files',
      'backup',
      'security',
      'network',
      'systemUi',
      'share',
      'update',
    ])
    await expect(platform.capabilities.supports('system-insets-v1')).resolves.toBe(true)
    await expect(platform.network.getState()).resolves.toMatchObject({ wifi: true })
  })
})
