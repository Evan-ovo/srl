import { createApp } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import {
  beginLocalDataReset,
  clearBrowserLocalData,
  consumeLocalDataResetPermit,
  LOCAL_DATA_RESET_KEY,
  LOCAL_DATA_RESET_PHRASE,
  readLocalDataReset,
  stopIncompleteLocalDataReset,
} from './LocalDataReset'
import '../styles/Foundation.css'
import '../styles/LocalDataReset.css'

/** Isolated maintenance screen: never imports the library containers or starts their writers. */
export async function showLocalDataResetPage(): Promise<void> {
  document.title = 'SRL · 本机数据清理'
  const root = document.getElementById('app')!
  const main = document.createElement('main')
  main.className = 'local-data-reset'
  const title = document.createElement('h1')
  title.textContent = '清除本机全部内容'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const scope = document.createElement('p')
  scope.textContent =
    '范围为本浏览器当前站点的数据。云端备份和账号保留；资源、历史、回收站、APP 使用数据、设置与本机凭据会清除。'
  const retry = document.createElement('button')
  retry.textContent = '重新确认并清理'
  const open = document.createElement('a')
  open.textContent = '打开资源库'
  open.href = '/'
  const renderer = document.createElement('div')
  const stop = document.createElement('button')
  stop.textContent = '停止后续清理'
  stop.hidden = true
  const controller = new AbortController()
  stop.addEventListener('click', () => {
    controller.abort()
    stop.disabled = true
    status.textContent =
      '正在停止；已开始的数据库删除会完成，之后不再清理下一项。若提示其他页面占用，请先关闭那些页面。'
  })
  main.append(title, status, scope, stop, retry, open)
  root.replaceChildren(main, renderer)
  createApp(ConfirmDialog).mount(renderer)
  const refresh = () => {
    const state = readLocalDataReset()
    open.hidden = state?.phase === 'pending'
    if (state?.phase === 'complete') {
      status.textContent = '本机数据已清除，可以重新打开资源库。'
      retry.hidden = true
    }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === LOCAL_DATA_RESET_KEY) refresh()
  })
  retry.addEventListener('click', async () => {
    retry.disabled = true
    try {
      if (
        await confirmAction({
          title: '重新确认清除本机数据',
          message: '清理可能已经部分完成；这次会继续清除剩余本机内容。云端备份和账号保留。',
          requiredText: LOCAL_DATA_RESET_PHRASE,
          danger: true,
          centered: true,
          confirmLabel: '清除全部本机数据',
        })
      )
        beginLocalDataReset(LOCAL_DATA_RESET_PHRASE)
    } finally {
      retry.disabled = false
    }
  })
  refresh()
  const permit = consumeLocalDataResetPermit()
  // sessionStorage belongs to each tab. Passive reset pages must discard their own old secrets too.
  sessionStorage.clear()
  if (!permit) {
    if (readLocalDataReset()?.phase !== 'complete')
      status.textContent =
        '此页已停止资源库后台写入。若清理在另一个页面进行，请关闭此页；若上次清理中断，请重新确认后继续。'
    return
  }
  retry.hidden = true
  stop.hidden = false
  try {
    await clearBrowserLocalData(
      permit,
      (message) => {
        status.textContent = message
      },
      controller.signal,
    )
    refresh()
  } catch (error) {
    stopIncompleteLocalDataReset(permit)
    refresh()
    status.setAttribute('role', 'alert')
    status.textContent = controller.signal.aborted
      ? '清理已停止，已清除的部分无法撤销。可以重新确认清理剩余内容，或打开资源库查看剩余数据。'
      : `清理未完成：${error instanceof Error ? error.message : '本机存储操作失败'}。可能已有部分数据清除，不会自动重试；可重新确认继续，或打开资源库。`
    retry.hidden = false
  } finally {
    stop.hidden = true
  }
}
