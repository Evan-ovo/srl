/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ native: false, registerSW: vi.fn(), relaunch: vi.fn() }))

vi.mock('virtual:pwa-register', () => ({
  registerSW: runtime.registerSW,
}))

vi.mock('../utils/CapacitorDetection', () => ({
  isCapacitorApp: () => runtime.native,
}))

vi.mock('./ServiceWorkerReload', () => ({ relaunchCurrentShell: runtime.relaunch }))

vi.mock('./HostedApiTransport', () => ({
  hostedApiFetch: vi.fn(),
  hostedApiFetchBinary: vi.fn(),
}))

import {
  disableServiceWorkerForNativeApp,
  forceRefresh,
  installServiceWorker,
  manualCheckForUpdate,
} from './ServiceWorkerUpdate'

describe('ServiceWorkerUpdate native boundary', () => {
  afterEach(() => {
    runtime.native = false
    runtime.registerSW.mockReset()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('does not register the website Service Worker inside the APK', async () => {
    runtime.native = true

    installServiceWorker()

    expect(runtime.registerSW).not.toHaveBeenCalled()
    await expect(manualCheckForUpdate()).resolves.toContain('检查 APK 版本更新')
  })

  it('unregisters legacy website workers while preserving downloaded asset caches inside the APK', async () => {
    runtime.native = true
    const unregister = vi.fn(async () => true)
    const getRegistrations = vi.fn(async () => [
      { unregister } as unknown as ServiceWorkerRegistration,
    ])
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations },
    })
    const deleteCache = vi.fn(async () => true)
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => [
        'workbox-precache',
        'legacy-runtime',
        'srl-assistant-pet-assets-v1',
        'srl-official-app-assets-v1',
      ]),
      delete: deleteCache,
    })
    const updateBanner = document.createElement('div')
    updateBanner.id = 'srl-update-notice'
    document.body.append(updateBanner)

    await disableServiceWorkerForNativeApp()

    expect(unregister).toHaveBeenCalledOnce()
    expect(deleteCache).toHaveBeenCalledTimes(2)
    expect(deleteCache).toHaveBeenNthCalledWith(1, 'workbox-precache')
    expect(deleteCache).toHaveBeenNthCalledWith(2, 'legacy-runtime')
    expect(document.getElementById('srl-update-notice')).toBeNull()
  })

  it('keeps downloaded pet and official app assets during a forced refresh', async () => {
    const reload = vi.fn()
    vi.stubGlobal('window', {
      caches: {},
      location: { reload },
    })
    const deleteCache = vi.fn(async () => true)
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => [
        'workbox-precache',
        'srl-assistant-pet-assets-v1',
        'srl-official-app-assets-v1',
      ]),
      delete: deleteCache,
    })

    await forceRefresh()

    expect(deleteCache).toHaveBeenCalledOnce()
    expect(deleteCache).toHaveBeenCalledWith('workbox-precache')
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('ServiceWorkerUpdate early PWA checks', () => {
  afterEach(() => {
    runtime.native = false
    runtime.registerSW.mockReset()
    runtime.relaunch.mockReset()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    document.body.replaceChildren()
  })

  async function updater(serviceWorker: unknown) {
    vi.resetModules()
    vi.stubGlobal('navigator', { serviceWorker })
    return import('./ServiceWorkerUpdate')
  }

  it('checks the browser registration before the delayed page registration callback has run', async () => {
    const update = vi.fn(async () => undefined)
    const registration = { update, installing: {} }
    const getRegistration = vi.fn(async () => registration)
    const api = await updater({ getRegistration })
    const clearCache = vi.fn()
    vi.stubGlobal('caches', { delete: clearCache })

    await expect(api.manualCheckForUpdate()).resolves.toContain('正在下载新版本')
    expect(getRegistration).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(clearCache).not.toHaveBeenCalled()
  })

  it('reports initialization without clearing caches and discovers a registration on a later check', async () => {
    const registration = { update: vi.fn(async () => undefined), installing: {} }
    const getRegistration = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(registration)
    const api = await updater({ getRegistration })

    const first = await api.manualCheckForUpdate()
    expect(first).toContain('正在初始化')
    expect(first).not.toContain('强制刷新')
    await expect(api.manualCheckForUpdate()).resolves.toContain('正在下载新版本')
    expect(getRegistration).toHaveBeenCalledTimes(2)
  })

  it('uses the selected waiting worker after user confirmation even before the page update helper is ready', async () => {
    const waiting = { postMessage: vi.fn() }
    const registration = { update: vi.fn(async () => undefined), waiting }
    const container = Object.assign(new EventTarget(), {
      getRegistration: vi.fn(async () => registration),
      controller: null as unknown,
    })
    const api = await updater(container)

    await expect(api.manualCheckForUpdate()).resolves.toContain('发现新版本')
    expect(waiting.postMessage).not.toHaveBeenCalled()
    document.querySelector<HTMLButtonElement>('#srl-update-notice button')!.click()
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' })
    expect(runtime.relaunch).not.toHaveBeenCalled()
    container.controller = waiting
    container.dispatchEvent(new Event('controllerchange'))
    container.dispatchEvent(new Event('controllerchange'))
    expect(runtime.relaunch).toHaveBeenCalledOnce()
  })

  it('distinguishes a registration failure from initialization instead of suggesting repeated force refreshes', async () => {
    vi.stubEnv('DEV', false)
    const api = await updater({ getRegistration: vi.fn(async () => undefined) })
    api.installServiceWorker()
    const callbacks = runtime.registerSW.mock.calls[0]![0]
    callbacks.onRegisterError(new Error('registration failed'))

    const message = await api.manualCheckForUpdate()
    expect(message).toContain('注册失败')
    expect(message).not.toContain('强制刷新')
  })

  it('reports a failed registration query without turning it into a cache reset instruction', async () => {
    const api = await updater({
      getRegistration: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
    })
    const message = await api.manualCheckForUpdate()
    expect(message).toContain('无法读取')
    expect(message).not.toContain('强制刷新')
  })

  it('allows a later check after update fails without clearing the existing cache', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined)
    const api = await updater({ getRegistration: vi.fn(async () => ({ update, installing: {} })) })
    const clearCache = vi.fn()
    vi.stubGlobal('caches', { delete: clearCache })
    const message = await api.manualCheckForUpdate()
    expect(message).toContain('检查失败')
    expect(message).not.toContain('强制刷新')
    await expect(api.manualCheckForUpdate()).resolves.toContain('正在下载新版本')
    expect(update).toHaveBeenCalledTimes(2)
    expect(clearCache).not.toHaveBeenCalled()
  })
})
