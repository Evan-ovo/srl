import { reloadAfterLoadFailure } from './core/ServiceWorkerReload'
import { applyStartupAppearance } from './core/StartupAppearance'
import { installLocalDataResetBoundary } from './core/LocalDataReset'
import {
  beginStartupAttempt,
  isSafeModeActive,
  installSafeModeBanner,
  installStartupRescuePrompt,
} from './core/SafeStartup'

if (installLocalDataResetBoundary()) {
  void import('./core/LocalDataResetPage').then(({ showLocalDataResetPage }) =>
    showLocalDataResetPage(),
  )
} else {
  // Recovery is available even when Main or its dependency graph fails to load.
  const startupAttempt = beginStartupAttempt()
  if (isSafeModeActive()) installSafeModeBanner()
  else if (startupAttempt.rescueRequired) installStartupRescuePrompt()
  applyStartupAppearance()

  // 独立于 Vue 和业务依赖图：Main 的静态依赖失败也能在原启动页说明原因。
  // 启动内容由 Vue mount 自然替换，不叠加覆盖层、定时刷新或清理用户设置。
  document.getElementById('srl-boot-reload')?.addEventListener('click', (event) => {
    event.preventDefault()
    void reloadAfterLoadFailure()
  })

  void import('./Main').catch(() => {
    const title = document.getElementById('srl-boot-title')
    const hint = document.getElementById('srl-boot-hint')
    if (title) {
      title.setAttribute('role', 'alert')
      title.textContent = '页面未能加载'
    }
    if (hint)
      hint.textContent = navigator.onLine
        ? '可能是网络中断或旧版本文件已失效。可重新获取页面，本机资源和外观设置会保留。'
        : '当前没有网络，且页面所需文件未完整缓存。请联网后重新打开，本机资源会保留。'
  })
}
