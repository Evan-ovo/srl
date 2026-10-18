import { registerSW } from 'virtual:pwa-register'

import { isCapacitorApp } from '../utils/CapacitorDetection'
import { relaunchCurrentShell } from './ServiceWorkerReload'
import {
  requestServiceWorkerUpdate,
  startServiceWorkerUpdateChecks,
} from './ServiceWorkerUpdateChecks'
import { ASSISTANT_PET_ASSET_CACHE_NAME } from '../services/ProductAssistantPetAssets'

const BANNER_ID = 'srl-update-notice'
const PRESERVED_CACHE_NAMES = new Set([
  'srl-official-app-assets-v1',
  ASSISTANT_PET_ASSET_CACHE_NAME,
])

/**
 * 用简单闭包持有运行时的 SW 状态。
 * 避免模块级 let 变量在 vue-tsc 增量的 Linux 构建中被误报 noUnusedLocals。
 */
function createUpdateState() {
  let activeRegistration: ServiceWorkerRegistration | undefined
  let applyUpdateRef: ((reload?: boolean) => void) | undefined
  let stopAutomaticUpdateChecks: (() => void) | undefined
  let stopPendingRelaunch: (() => void) | undefined
  let relaunchRequested = false
  let registrationFailed = false
  let manualCheck: Promise<string> | undefined

  function relaunchOnce(): void {
    if (relaunchRequested) return
    relaunchRequested = true
    stopPendingRelaunch?.()
    relaunchCurrentShell()
  }

  function applyUpdateAndRelaunch(): void {
    stopPendingRelaunch?.()
    const waiting = activeRegistration?.waiting
    if (!waiting) {
      relaunchOnce()
      return
    }
    // Workbox's isUpdate describes whether the page was controlled at register
    // time. A first-visit page can install a second worker later without that
    // flag becoming true. Follow the worker the user actually chose instead.
    stopPendingRelaunch = relaunchAfterWaitingWorkerControls(
      navigator.serviceWorker,
      waiting,
      () => {
        if (applyUpdateRef) applyUpdateRef(true)
        else waiting.postMessage({ type: 'SKIP_WAITING' })
      },
      relaunchOnce,
    )
  }

  function showUpdateBanner(applyUpdate: () => void): void {
    if (isCapacitorApp()) return
    if (document.getElementById(BANNER_ID)) return

    const banner = document.createElement('div')
    banner.id = BANNER_ID
    banner.setAttribute('role', 'status')

    const title = document.createElement('strong')
    title.textContent = '资源库有新版本'

    const hint = document.createElement('span')
    hint.textContent = '刷新后使用新版本。本地资源保存在浏览器数据库中，不会因为更新而丢失。'

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.textContent = '立即刷新'
    confirm.addEventListener('click', () => {
      banner.remove()
      applyUpdate()
    })

    const later = document.createElement('button')
    later.type = 'button'
    later.textContent = '稍后'
    later.addEventListener('click', () => banner.remove())

    const actions = document.createElement('div')
    actions.className = 'srl-update-notice__actions'
    actions.append(confirm, later)

    banner.append(title, hint, actions)
    document.body.append(banner)
  }

  function showOfflineReadyBanner(): void {
    if (isCapacitorApp()) return
    const banner = document.createElement('div')
    banner.id = 'srl-offline-ready'
    banner.setAttribute('role', 'status')
    banner.textContent = '资源库已可离线使用'
    document.body.append(banner)
    window.setTimeout(() => banner.remove(), 4000)
  }

  /**
   * 手动触发更新检查，返回是否有新版本可用。
   * 可在设置中由用户主动调用，不依赖定时器或前台切换。
   */
  function manualCheckForUpdate(): Promise<string> {
    manualCheck ??= runManualCheck().finally(() => {
      manualCheck = undefined
    })
    return manualCheck
  }

  async function runManualCheck(): Promise<string> {
    if (isCapacitorApp()) return 'APK 中不使用网页更新，请使用“检查 APK 版本更新”'
    if (!activeRegistration) {
      if (!('serviceWorker' in navigator))
        return '当前环境不支持网页更新，请使用支持 PWA 的浏览器通过 HTTPS 打开应用'
      try {
        // The browser may already have a registration before this page's deferred
        // Workbox callback runs, especially immediately after a PWA update.
        const registration = await navigator.serviceWorker.getRegistration()
        activeRegistration ??= registration
        if (activeRegistration) registrationFailed = false
      } catch {
        return '暂时无法读取网页更新状态，请稍后重试'
      }
      if (!activeRegistration)
        return registrationFailed
          ? '网页更新注册失败，请确认网络连接后重新打开 PWA'
          : '网页更新正在初始化，请稍后再检查'
    }

    try {
      await requestServiceWorkerUpdate(activeRegistration)
      if (activeRegistration.waiting) {
        showUpdateBanner(applyUpdateAndRelaunch)
        return '发现新版本，点击上方"立即刷新"使用'
      }
      if (activeRegistration.installing) return '正在下载新版本，请稍候…'

      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=service-worker-version-fallback
      // SW 没检测到变化时，通过当前部署源的 /api/version 请求版本号。
      try {
        const response = await fetch('/api/version', { cache: 'no-store' })
        if (response.ok) {
          const data = (await response.json()) as { version?: string }
          const serverVersion = data?.version ?? ''
          const storedVersion = localStorage.getItem('srl.deploy.version') ?? ''
          if (serverVersion && serverVersion !== storedVersion) {
            localStorage.setItem('srl.deploy.version', serverVersion)
            if (applyUpdateRef) showUpdateBanner(applyUpdateAndRelaunch)
            return '服务器有新版本（' + serverVersion + '），点击上方"立即刷新"'
          }
          if (serverVersion) {
            return '已是最新版本（' + serverVersion + '）'
          }
        }
      } catch {
        /* 直连失败 */
      }
      // SRL-PUBLIC-SYNC: END REPLACE id=service-worker-version-fallback

      return '暂未发现可用更新'
    } catch {
      return '网页更新检查失败，请确认网络连接后重试'
    }
  }

  /**
   * 强制跳过 SW 缓存重新加载——注销 Service Worker、清空 Cache Storage、硬刷新。
   * 用于 SW 自身的缓存导致更新检测失败时的兜底恢复。
   */
  async function forceRefresh(): Promise<void> {
    if (activeRegistration) {
      await activeRegistration.unregister().catch(() => undefined)
    }
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => !PRESERVED_CACHE_NAMES.has(key)).map((key) => caches.delete(key)),
      )
    }
    window.location.reload()
  }

  function installServiceWorker(): void {
    if (import.meta.env.DEV) return
    if (isCapacitorApp()) {
      void disableServiceWorkerForNativeApp()
      return
    }

    const applyUpdate = registerSW({
      // Prompt 模式下，updateSW() 触发 waiting worker 接管后默认会调用 location.reload()。
      // 改走 Worker 直出的当前应用壳，避免刚更新完仍握着旧分包清单；不清 Cache Storage。
      onNeedReload: relaunchOnce,
      onNeedRefresh: () => showUpdateBanner(applyUpdateAndRelaunch),
      onOfflineReady: showOfflineReadyBanner,
      onRegisterError: () => {
        registrationFailed = true
      },
      onRegisteredSW: (_workerUrl, registration) => {
        stopAutomaticUpdateChecks?.()
        activeRegistration = registration ?? undefined
        registrationFailed = false
        applyUpdateRef = applyUpdate
        stopAutomaticUpdateChecks = registration
          ? startServiceWorkerUpdateChecks(registration)
          : undefined
      },
    })
  }

  return { installServiceWorker, manualCheckForUpdate, forceRefresh }
}

/** Follow the selected worker, independent of Workbox's registration-time flag. */
export function relaunchAfterWaitingWorkerControls(
  container: ServiceWorkerContainer,
  waiting: ServiceWorker,
  applyUpdate: () => void,
  relaunch: () => void,
): () => void {
  const stop = () => container.removeEventListener('controllerchange', onControllerChange)
  const onControllerChange = () => {
    if (container.controller !== waiting) return
    stop()
    relaunch()
  }
  container.addEventListener('controllerchange', onControllerChange)
  applyUpdate()
  return stop
}

/**
 * Remote APK 早期版本曾注册网页 Service Worker。原生环境启动时移除这些遗留，
 * 防止 APK 更新通道之外再次出现网页更新提示；独立下载的用户资产缓存会保留。
 */
export async function disableServiceWorkerForNativeApp(): Promise<void> {
  if (!isCapacitorApp()) return
  document.getElementById(BANNER_ID)?.remove()
  document.getElementById('srl-offline-ready')?.remove()
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => [])
    await Promise.all(registrations.map((registration) => registration.unregister()))
  }
  if ('caches' in window) {
    const keys = await caches.keys().catch(() => [])
    await Promise.all(
      keys.filter((key) => !PRESERVED_CACHE_NAMES.has(key)).map((key) => caches.delete(key)),
    )
  }
}

const state = createUpdateState()

/** 注册 Service Worker。开发模式下不注册，避免缓存干扰调试。 */
export const installServiceWorker = state.installServiceWorker

/** 手动检查更新。在设置页点击"检查网页更新"时调用。 */
export const manualCheckForUpdate = state.manualCheckForUpdate

/** 强制刷新：注销 SW、清空 Cache Storage、硬重载。 */
export const forceRefresh = state.forceRefresh
