import { createApp } from 'vue'

import { placeStartupAppearanceAfterApplicationStyles } from './core/StartupAppearance'
import { installAndroidAppUpdateChecks } from './core/AndroidAppUpdate'
import { appDatabase } from './core/AppDatabaseInstance'
import { installGlobalErrorHandlers } from './core/FatalErrorNotice'
import { installNativeRuntime } from './core/NativeRuntime'
import { installPerformanceMonitor } from './core/PerformanceMonitor'
import { installSystemInsetsService } from './core/SystemInsetsService'
import { FEATURE_APP_INACTIVE_EVENT } from './core/ViewportEvents'
import { disableServiceWorkerForNativeApp, installServiceWorker } from './core/ServiceWorkerUpdate'
import {
  canUseAndroidNativeDexieCore,
  isAndroidNativeAppDatabaseActive,
} from './storage/AndroidNativeDexieCore'
import {
  initializeAndroidNativeAppDatabase,
  rollbackAndroidNativeAppDatabase,
} from './storage/AndroidNativeAppDatabaseRuntime'
import RootApp from './RootApp.vue'
import { isCapacitorApp } from './utils/CapacitorDetection'
import {
  getMobileActiveElement,
  isMobileEditableElement,
  revealMobileInputIfOccluded,
  restorePersonalInputScroll,
  type MobileEditableElement,
} from './utils/MobileInputFocus'
import './styles/Foundation.css'
import './styles/DesignSystemRefinement.css'
import './styles/ProjectNoticeDialog.css'
import './styles/IOSStandaloneSafeAreaSurface.css'

// Bootstrap inserts saved CSS before dynamically importing Main. Move that same
// style node after Main's CSS dependencies so user theme tokens take precedence.
placeStartupAppearanceAfterApplicationStyles()

let viewportFrame: number | undefined
let androidNativeDatabaseMigrationWarning: string | undefined
let lastViewportHeight = -1
let lastLayoutHeight = -1
let expandedVisualViewportHeight = -1
let expandedVisualViewportScale = 1
let lastViewportOffsetTop = -1
let lastDisplayMode = ''
let lastIOSDevice: boolean | undefined
let layoutViewportWidth = -1
let viewportSettleFrame: number | undefined
let lastViewportSignature = ''
let stableViewportFrames = 0
let focusRevealPending = false
let focusRevealTarget: MobileEditableElement | undefined
let focusRevealAttempted = false
let keyboardFocusActive = false
let standaloneSafeTop = 0

async function prepareAndroidNativeDatabaseBeforeMount(): Promise<boolean> {
  if (!isCapacitorApp() || !canUseAndroidNativeDexieCore()) return true
  const root = document.querySelector<HTMLElement>('#app')
  let progress: HTMLParagraphElement | undefined
  function showPreparation(): void {
    if (!root || progress) return
    const shell = document.createElement('main')
    shell.setAttribute('aria-live', 'polite')
    shell.id = 'srl-native-preparation'
    const title = document.createElement('h1')
    title.textContent = '正在准备本机数据'
    progress = document.createElement('p')
    progress.textContent = '正在保存并核验旧数据，原件会保留。'
    shell.append(title, progress)
    root.replaceChildren(shell)
  }
  try {
    await initializeAndroidNativeAppDatabase(appDatabase, (state) => {
      showPreparation()
      if (progress)
        progress.textContent =
          state.status === 'verified'
            ? `${state.store}：已核验`
            : `${state.store}：${state.copied}/${state.total}`
    })
    root?.replaceChildren()
    return true
  } catch (error) {
    androidNativeDatabaseMigrationWarning = error instanceof Error ? error.message : String(error)
    console.error('Android 原生数据库迁移未完成，继续使用原 IndexedDB。', error)
    window.dispatchEvent(
      new CustomEvent('srl:android-native-database-migration-failed', {
        detail: { message: error instanceof Error ? error.message : String(error) },
      }),
    )
    if (isAndroidNativeAppDatabaseActive() && root) {
      showPreparation()
      const shell = root.firstElementChild
      const title = shell?.querySelector('h1')
      const status = shell?.querySelector('p')
      if (title) title.textContent = '本机数据库暂不可用'
      if (status)
        status.textContent = `为保护数据，应用暂未打开。原生数据仍保留。${error instanceof Error ? `原因：${error.message}` : ''}`
      const recover = document.createElement('button')
      recover.type = 'button'
      recover.textContent = '核验并恢复 IndexedDB 副本'
      recover.addEventListener('click', async () => {
        recover.disabled = true
        recover.textContent = '正在逐项恢复并核验…'
        try {
          await rollbackAndroidNativeAppDatabase(appDatabase, (progress) => {
            if (status)
              status.textContent = `${progress.store}：${progress.copied}/${progress.total}`
          })
          location.reload()
        } catch (rollbackError) {
          recover.disabled = false
          recover.textContent = '重试恢复 IndexedDB 副本'
          if (status)
            status.textContent = `恢复未完成，原生数据仍保留。${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        }
      })
      shell?.append(recover)
      return false
    }
    root?.replaceChildren()
    return true
  }
}

function isIOSDevice(): boolean {
  const browser = navigator as Navigator & { maxTouchPoints?: number }
  return (
    /\b(?:iPhone|iPad|iPod)\b/iu.test(browser.userAgent || '') ||
    (browser.platform === 'MacIntel' && (browser.maxTouchPoints ?? 0) > 1)
  )
}

function getViewportBounds() {
  return {
    height: window.visualViewport?.height ?? window.innerHeight,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
  }
}

function measureStandaloneSafeTop(): number {
  // Cache a resolved inset per width; startup WebKit may temporarily resolve it to zero.
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;width:0;height:0;padding-top:var(--safe-top,0px)'
  document.documentElement.append(probe)
  const top = Number.parseFloat(window.getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  return Math.max(0, top)
}

function isVisualViewportReduced(height: number): boolean {
  // VisualViewport uses fractional CSS pixels. A subpixel difference after
  // dismissal must not retain keyboard-only layout once the viewport is back.
  return Math.floor(expandedVisualViewportHeight - height) > 0
}

function getViewportSignature(): string {
  const viewport = window.visualViewport
  return [
    window.innerWidth,
    viewport?.height ?? window.innerHeight,
    viewport?.offsetTop ?? 0,
    viewport?.offsetLeft ?? 0,
    viewport?.scale ?? 1,
  ].join(':')
}

function markFocusedMobileInputForReveal(): void {
  const input = getMobileActiveElement()
  if (!isMobileEditableElement(input)) {
    focusRevealPending = false
    focusRevealTarget = undefined
    return
  }
  focusRevealAttempted = false
  focusRevealTarget = input
  stableViewportFrames = 0
  const viewport = getViewportBounds()
  keyboardFocusActive = true
  focusRevealPending = isVisualViewportReduced(viewport.height)
  scheduleViewportState()
}

function recheckViewportAfterMobileBlur(event: FocusEvent): void {
  if (!isMobileEditableElement(event.target as MobileEditableElement)) return
  if (isMobileEditableElement(event.relatedTarget as MobileEditableElement | null)) return
  if (!keyboardFocusActive) return

  // iOS standalone can finish dismissing the keyboard without a final
  // visualViewport resize. Re-read the same viewport owner after blur settles.
  scheduleViewportRechecks()
}

function scheduleViewportRechecks(): void {
  scheduleViewportState()
  for (const delay of [50, 250, 600]) {
    window.setTimeout(() => {
      if (!isMobileEditableElement(getMobileActiveElement())) scheduleViewportState()
    }, delay)
  }
}

function recheckViewportAfterFeatureExit(): void {
  keyboardFocusActive = false
  focusRevealPending = false
  focusRevealTarget = undefined
  focusRevealAttempted = false
  document.documentElement.dataset.iosKeyboardOpen = 'false'
  scheduleViewportRechecks()
}

function scheduleViewportSettleCheck(): void {
  if (viewportSettleFrame !== undefined) return
  viewportSettleFrame = window.requestAnimationFrame(checkViewportStability)
}

function checkViewportStability(): void {
  viewportSettleFrame = undefined
  const signature = getViewportSignature()
  if (signature !== lastViewportSignature) {
    stableViewportFrames = 0
    scheduleViewportState()
    return
  }
  stableViewportFrames += 1
  if (stableViewportFrames < 2) {
    scheduleViewportSettleCheck()
    return
  }
  const input = getMobileActiveElement()
  if (
    focusRevealPending &&
    !focusRevealAttempted &&
    focusRevealTarget === input &&
    isMobileEditableElement(input) &&
    lastIOSDevice &&
    window.innerWidth <= 860 &&
    document.documentElement.dataset.visualViewportReduced === 'true'
  ) {
    // Consume this focus/keyboard session before scrolling. A resulting
    // VisualViewport event must not queue a second correction for the same field.
    focusRevealAttempted = true
    focusRevealPending = false
    focusRevealTarget = undefined
    revealMobileInputIfOccluded(input, getViewportBounds())
  }
}

function applyViewportState(): void {
  viewportFrame = undefined
  const { height: rawViewportHeight, offsetTop: viewportOffsetTop } = getViewportBounds()
  let viewportHeight = rawViewportHeight
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  const windowHeight = window.innerHeight
  // Focus zoom changes innerWidth on iOS; it must not reset the expanded
  // layout/background baseline as though the device had rotated.
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportScale = window.visualViewport?.scale ?? 1
  // Keep the backdrop/layout sizing baseline separate from the visual viewport
  // baseline used for keyboard state: Safari/PWA may report different heights
  // for innerHeight and visualViewport even when the keyboard is closed.
  if (viewportWidth !== layoutViewportWidth || lastLayoutHeight < 0) {
    layoutViewportWidth = viewportWidth
    lastLayoutHeight = Math.max(windowHeight, viewportHeight)
    expandedVisualViewportHeight = viewportHeight
    expandedVisualViewportScale = viewportScale
    standaloneSafeTop = 0
  } else if (viewportHeight >= lastLayoutHeight || windowHeight >= lastLayoutHeight) {
    lastLayoutHeight = Math.max(windowHeight, viewportHeight)
  } else {
    lastLayoutHeight = Math.max(lastLayoutHeight, windowHeight)
  }
  // A startup zero is not a measured status-bar extent. Reuse the existing
  // viewport updates until WebKit supplies it, then stop probing for this width.
  if (iosStandalone && standaloneSafeTop === 0) standaloneSafeTop = measureStandaloneSafeTop()
  // Standalone WebKit can dismiss the keyboard into a status-bar-contained
  // viewport (e.g. 852 -> 448 -> 793). Keep the observed full shell extent,
  // but only for a loss bounded by the measured top inset. Keyboard-sized
  // reductions, panning, zoom and ordinary browsers retain their raw geometry.
  const lostExtent = lastLayoutHeight - rawViewportHeight
  if (
    iosStandalone &&
    viewportScale === 1 &&
    viewportOffsetTop === 0 &&
    standaloneSafeTop > 0 &&
    lostExtent > 0 &&
    lostExtent <= standaloneSafeTop + 1
  ) {
    viewportHeight = lastLayoutHeight
  }
  const focusedEditable = isMobileEditableElement(getMobileActiveElement())
  if (!focusedEditable && !keyboardFocusActive) {
    expandedVisualViewportHeight = viewportHeight
    expandedVisualViewportScale = viewportScale
  } else if (viewportHeight >= expandedVisualViewportHeight) {
    expandedVisualViewportHeight = viewportHeight
    expandedVisualViewportScale = viewportScale
  }
  document.documentElement.style.setProperty('--layout-viewport-height', `${lastLayoutHeight}px`)
  // Compare extents in the same zoom scale: zoom alone must not retain compact
  // input layout after the obstructed space is restored. Insets keep their
  // stricter keyboard signal below; internal focus reveal waits for stable geometry.
  const visualViewportReduced =
    Math.floor(
      expandedVisualViewportHeight * expandedVisualViewportScale - viewportHeight * viewportScale,
    ) > 0
  if (document.documentElement.dataset.visualViewportReduced !== String(visualViewportReduced)) {
    document.documentElement.dataset.visualViewportReduced = String(visualViewportReduced)
  }
  const viewportSignature = getViewportSignature()
  const viewportGeometryChanged = viewportSignature !== lastViewportSignature
  if (viewportGeometryChanged) {
    lastViewportSignature = viewportSignature
    stableViewportFrames = 0
    const input = getMobileActiveElement()
    if (
      isMobileEditableElement(input) &&
      !focusRevealAttempted &&
      isVisualViewportReduced(viewportHeight)
    ) {
      focusRevealPending = true
      focusRevealTarget = input
      keyboardFocusActive = true
    }
  }
  if (viewportHeight !== lastViewportHeight) {
    lastViewportHeight = viewportHeight
    document.documentElement.style.setProperty('--visual-viewport-height', `${viewportHeight}px`)
    document.documentElement.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
  }
  if (viewportOffsetTop !== lastViewportOffsetTop) {
    lastViewportOffsetTop = viewportOffsetTop
    document.documentElement.style.setProperty(
      '--visual-viewport-offset-top',
      `${viewportOffsetTop}px`,
    )
  }
  const iosDevice = iosStandalone || isIOSDevice()
  const displayMode =
    window.matchMedia('(display-mode: standalone)').matches || iosStandalone
      ? 'standalone'
      : 'browser'

  if (displayMode !== lastDisplayMode) {
    lastDisplayMode = displayMode
    document.documentElement.dataset.displayMode = displayMode
  }
  if (iosDevice !== lastIOSDevice) {
    lastIOSDevice = iosDevice
  }
  if (document.documentElement.dataset.iosStandalone !== String(iosStandalone)) {
    document.documentElement.dataset.iosStandalone = iosStandalone ? 'true' : 'false'
  }
  // On iOS Safari and standalone PWA, the visual viewport is the keyboard
  // signal. Do not compare it to innerHeight: WebKit may shrink both values
  // during the same keyboard animation, making that delta report a false negative.
  const iosKeyboardOpen =
    iosDevice &&
    window.innerWidth <= 860 &&
    (window.visualViewport?.scale ?? 1) === 1 &&
    keyboardFocusActive &&
    isVisualViewportReduced(viewportHeight)
  if (document.documentElement.dataset.iosKeyboardOpen !== String(iosKeyboardOpen)) {
    document.documentElement.dataset.iosKeyboardOpen = String(iosKeyboardOpen)
  }
  if (!visualViewportReduced) {
    restorePersonalInputScroll()
    keyboardFocusActive = false
    focusRevealPending = false
    focusRevealTarget = undefined
    focusRevealAttempted = false
  }
  if (viewportGeometryChanged || focusRevealPending) scheduleViewportSettleCheck()
}

function scheduleViewportState(): void {
  if (viewportFrame !== undefined) return
  viewportFrame = window.requestAnimationFrame(applyViewportState)
}

if (!(await prepareAndroidNativeDatabaseBeforeMount()))
  throw new Error('Android 原生数据库启动已停止')
applyViewportState()
installNativeRuntime()
installAndroidAppUpdateChecks()
void disableServiceWorkerForNativeApp()
window.addEventListener('resize', scheduleViewportState, { passive: true })
window.addEventListener('orientationchange', scheduleViewportState, { passive: true })
window.visualViewport?.addEventListener('resize', scheduleViewportState, { passive: true })
window.visualViewport?.addEventListener('scroll', scheduleViewportState, { passive: true })
window.addEventListener('pageshow', scheduleViewportState, { passive: true })
window.addEventListener(FEATURE_APP_INACTIVE_EVENT, recheckViewportAfterFeatureExit)
window.addEventListener('focusin', markFocusedMobileInputForReveal, {
  capture: true,
  passive: true,
})
window.addEventListener('focusout', recheckViewportAfterMobileBlur, {
  capture: true,
  passive: true,
})

const app = createApp(RootApp)
installGlobalErrorHandlers(app)
installPerformanceMonitor()
installSystemInsetsService()
app.mount('#app')

if (androidNativeDatabaseMigrationWarning) {
  const notice = document.createElement('aside')
  notice.setAttribute('role', 'alert')
  notice.className = 'srl-native-migration-notice'
  const title = document.createElement('strong')
  title.textContent = '本机资源库迁移未完成'
  const description = document.createElement('p')
  description.textContent = `当前仍使用原本机数据库；附件暂时无法自动导入。失败原因：${androidNativeDatabaseMigrationWarning}`
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '知道了'
  dismiss.addEventListener('click', () => notice.remove())
  notice.append(title, description, dismiss)
  document.body.append(notice)
}

// 先让当前页面的入口与异步主界面完成加载，再检查网站更新。
// 避免刚发布新版本时，首屏动态分包下载和 Service Worker 预缓存同时争用网络，
// 在手机慢网下表现成一段时间完全白屏。
function scheduleServiceWorkerInstallation(): void {
  if (isCapacitorApp()) return
  const install = () => {
    const idleCallback = (
      window as Window & {
        requestIdleCallback?: (
          callback: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number
      }
    ).requestIdleCallback
    if (idleCallback) {
      idleCallback(() => installServiceWorker(), { timeout: 2500 })
    } else {
      globalThis.setTimeout(() => installServiceWorker(), 800)
    }
  }
  if (document.readyState === 'complete') install()
  else window.addEventListener('load', install, { once: true })
}

scheduleServiceWorkerInstallation()
