export const SERVICE_WORKER_UPDATE_INTERVAL_MS = 10 * 60 * 1000

/**
 * 为已注册的 Service Worker 补充主动更新检查。
 *
 * 服务器整包覆盖后，旧标签页只有真正向服务器发起过请求才会发现新版本。
 * 因此这里在注册完成时立即查一次，并在回到前台、窗口获得焦点、网络恢复时补查；
 * 隐藏页面不做定时网络请求，重新可见时立即补上。
 */
export function startServiceWorkerUpdateChecks(
  registration: ServiceWorkerRegistration,
): () => void {
  let pending: Promise<unknown> | undefined
  const checkForUpdate = (): void => {
    if (pending) return
    pending = registration
      .update()
      .catch(() => undefined)
      .finally(() => {
        pending = undefined
      })
  }
  const checkWhenVisible = (): void => {
    if (document.visibilityState === 'visible') checkForUpdate()
  }

  // 注册完成时立即检查：页面刚加载不会触发 visibilitychange，
  // 否则用户最快也要等到下一次切前台或定时器到点才能看到更新提示。
  checkForUpdate()

  document.addEventListener('visibilitychange', checkWhenVisible)
  window.addEventListener('focus', checkWhenVisible)
  window.addEventListener('online', checkWhenVisible)
  const intervalId = window.setInterval(checkWhenVisible, SERVICE_WORKER_UPDATE_INTERVAL_MS)

  return () => {
    document.removeEventListener('visibilitychange', checkWhenVisible)
    window.removeEventListener('focus', checkWhenVisible)
    window.removeEventListener('online', checkWhenVisible)
    window.clearInterval(intervalId)
  }
}
