import { matchesConfirmationText } from '../utils/ConfirmationText'

export const LOCAL_DATA_RESET_PHRASE = '我已了解到该操作会清除srl的数据，并确保我的确想这么做。'
export const LOCAL_DATA_RESET_KEY = 'srl.local-data-reset.v1'
const RESET_HASH = '#srl-local-data-reset'
const resetUrl = (token: string) => `/?srl-local-reset=${encodeURIComponent(token)}${RESET_HASH}`
interface ResetState {
  token: string
  phase: 'pending' | 'complete' | 'stopped'
}

export function readLocalDataReset(): ResetState | undefined {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_RESET_KEY)
    if (!raw) return
    const value = JSON.parse(raw) as ResetState
    if (
      typeof value.token === 'string' &&
      value.token &&
      ['pending', 'complete', 'stopped'].includes(value.phase)
    )
      return value
  } catch {
    /* Unrelated malformed metadata does not authorize deletion. */
  }
}

/** No business imports: this boundary must run before Main can open stores or start tasks. */
export function installLocalDataResetBoundary(
  replace: (url: string) => void = (url) => window.location.replace(url),
): boolean {
  let initial: string | null
  try {
    initial = localStorage.getItem(LOCAL_DATA_RESET_KEY)
  } catch {
    return false
  }
  const changed = () => {
    try {
      if (localStorage.getItem(LOCAL_DATA_RESET_KEY) !== initial)
        replace(resetUrl(readLocalDataReset()?.token ?? crypto.randomUUID()))
    } catch {
      /* Storage denied cannot authorize a reset or block ordinary startup. */
    }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === LOCAL_DATA_RESET_KEY || event.key === null) changed()
  })
  window.addEventListener('pageshow', changed)
  return readLocalDataReset()?.phase === 'pending' || window.location.hash === RESET_HASH
}

export function beginLocalDataReset(
  confirmation: string,
  replace: (url: string) => void = (url) => window.location.replace(url),
): void {
  if (!matchesConfirmationText(confirmation, LOCAL_DATA_RESET_PHRASE))
    throw new Error('确认句子尚未完整输入')
  const state: ResetState = { token: crypto.randomUUID(), phase: 'pending' }
  // Store the launch permit first. Other tabs see the generation but cannot auto-delete.
  sessionStorage.setItem(LOCAL_DATA_RESET_KEY, state.token)
  localStorage.setItem(LOCAL_DATA_RESET_KEY, JSON.stringify(state))
  // A hash-only navigation keeps Main and its writers alive. A fresh query unloads the document.
  replace(resetUrl(state.token))
}

/** A permit is consumed once; reload, failure and reopening never restart deletion by themselves. */
export function consumeLocalDataResetPermit(): string | undefined {
  const token = sessionStorage.getItem(LOCAL_DATA_RESET_KEY)
  sessionStorage.removeItem(LOCAL_DATA_RESET_KEY)
  const state = readLocalDataReset()
  return token && token === state?.token && state.phase === 'pending' ? token : undefined
}

export function stopIncompleteLocalDataReset(token: string): void {
  const state = readLocalDataReset()
  if (state?.token === token && state.phase === 'pending')
    localStorage.setItem(LOCAL_DATA_RESET_KEY, JSON.stringify({ token, phase: 'stopped' }))
}

export async function clearBrowserLocalData(
  token: string,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const current = () => {
    signal?.throwIfAborted()
    const state = readLocalDataReset()
    if (state?.token !== token || state.phase !== 'pending')
      throw new Error('本次清理已停止或已被另一次清理接管，请重新确认')
  }
  current()
  if (typeof indexedDB === 'undefined')
    throw new Error('当前浏览器未提供本机数据库接口，未完成清理')
  // Known stores cover browsers without databases(); enumeration also covers newer SRL/Workbox stores.
  const names = new Set([
    'SillyTavernResourceLibrary',
    'srl-cloud-credentials-v3',
    'srl-cloud-jobs-v3',
    'workbox-expiration',
  ])
  if (indexedDB.databases)
    for (const item of await indexedDB.databases()) if (item.name) names.add(item.name)
  current()
  if (navigator.serviceWorker)
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      current()
      await registration.unregister()
    }
  for (const name of names) {
    current()
    progress('正在清除本机数据库…')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('本机数据库清理失败'))
      request.onblocked = () =>
        progress('请关闭其他打开资源库的标签页或窗口；关闭后，本次已确认的清理将继续。')
    })
  }
  current()
  progress('正在清除离线文件和偏好…')
  if (typeof caches !== 'undefined')
    for (const name of await caches.keys()) {
      current()
      // Already absent is equivalent to cleared; an actual storage error still propagates.
      await caches.delete(name)
    }
  current()
  for (const key of Object.keys(localStorage))
    if (key !== LOCAL_DATA_RESET_KEY) localStorage.removeItem(key)
  sessionStorage.clear()
  current()
  // Keep a generation fence so a suspended/BFCache page cannot write old data back after completion.
  localStorage.setItem(LOCAL_DATA_RESET_KEY, JSON.stringify({ token, phase: 'complete' }))
}
