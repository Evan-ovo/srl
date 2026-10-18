import type { App } from 'vue'

import { BUILD_INFO } from './BuildInfo'
import { reloadAfterLoadFailure } from './ServiceWorkerReload'

const BANNER_ID = 'srl-fatal-error'
const REPEAT_WINDOW_MS = 5_000

let lastErrorKey = ''
let lastShownAt = 0
let occurrenceSequence = 0

const handledErrorMessages = {
  'SRL-LIBRARY-VAULT-INIT': '保险库状态初始化失败，请重新打开资源库后重试',
  'SRL-LIBRARY-LOAD': '本机资源列表读取失败，请重新打开资源库后重试',
  'SRL-LIBRARY-DEEP-LINK': '启动入口打开失败，可从资源库重新打开对应功能',
  'SRL-LIBRARY-BACKUP-LOAD': '云备份模块加载失败，可在云备份中重试',
  'SRL-LIBRARY-STORAGE-HEALTH': '资源库已打开，存储状态读取失败，可在存储面板重试',
  'SRL-LIBRARY-RECYCLE-LOAD': '资源库已打开，回收站读取失败，可在回收站重试',
  'SRL-LIBRARY-MAINTENANCE-THUMBNAILS': '资源缩略图维护未完成，可重新打开资源库后重试',
  'SRL-LIBRARY-MAINTENANCE-SUMMARIES': '资源维护摘要读取失败，可重新打开资源库后重试',
  'SRL-LIBRARY-MAINTENANCE-UPGRADE': '旧资源格式维护未完成，可重新打开资源库后重试',
  'SRL-LIBRARY-MAINTENANCE-FINGERPRINTS': '角色卡指纹维护未完成，可重新打开资源库后重试',
  'SRL-LIBRARY-MAINTENANCE-REFRESH': '资源维护后的列表刷新失败，可重新打开资源库后重试',
  'SRL-LIBRARY-GREETING-REFRESH': '开场白已保存，资源列表暂时刷新失败',
  'SRL-BACKUP-CHECKPOINT-READ': '暂时无法读取云恢复检查点，可在云备份中重试',
  'SRL-BACKUP-RECEIPT-RECONCILE': '云备份任务回执核对失败，可在云备份中重试',
  'SRL-BACKUP-NATIVE-FILE-SYNC': 'Android 本地文件同步失败，可在云备份中重试',
  'SRL-BACKUP-AUTO-START': '自动云备份未启动，可在云备份中查看并重试',
  'SRL-SEARCH-ORIGINAL-READ': '部分资源原件读取失败，正文搜索未完成，请重试',
  'SRL-SEARCH-CONTENT-SCAN': '资源正文扫描失败，正文搜索未完成，请重试',
  'SRL-SEARCH-WORKER': '正文搜索进程失败，正文搜索未完成，请重试',
} as const

export type HandledErrorCode = keyof typeof handledErrorMessages

function isErrorObject(error: unknown): error is Error | DOMException {
  return (
    error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)
  )
}

export function isErrorCancellation(error: unknown): boolean {
  return isErrorObject(error) && error.name === 'AbortError'
}

/** Handled failures share the existing error owner, without logging private error text. */
export function reportHandledError(
  code: HandledErrorCode,
  error: unknown,
  context: { itemCount?: number } = {},
): string | undefined {
  if (isErrorCancellation(error)) return undefined
  const occurrenceId = `${Date.now().toString(36)}-${++occurrenceSequence}`
  const allowedNames = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'QuotaExceededError',
    'UnknownError',
    'NotFoundError',
    'NotReadableError',
    'SecurityError',
    'InvalidStateError',
    'VersionError',
    'ConstraintError',
    'TransactionInactiveError',
    'TimeoutError',
    'DataError',
  ])
  let cause = error
  let category = 'UNHANDLED'
  let errorName = 'UnknownError'
  // Classify wrapped causes, but never log their strings, stacks, URLs or arbitrary properties.
  for (let depth = 0; depth < 4 && isErrorObject(cause); depth++) {
    if (allowedNames.has(cause.name)) errorName = cause.name
    const current = explain(cause.message, cause.name).code.replace('SRL-FATAL-', '')
    if (current !== 'UNHANDLED') category = current
    cause = 'cause' in cause ? cause.cause : undefined
  }
  const itemCount = context.itemCount
  console.warn('[SRL:HandledError]', {
    code,
    occurrenceId,
    buildId: BUILD_INFO.buildId,
    category,
    errorName,
    ...(typeof itemCount === 'number' && Number.isSafeInteger(itemCount) && itemCount >= 0
      ? { itemCount }
      : {}),
  })
  return `${handledErrorMessages[code]}（错误代码：${code}；本次编号：${occurrenceId}）`
}

/**
 * 存储层常见故障的可读解释。
 *
 * 资源库重度依赖 IndexedDB，配额耗尽、隐私模式禁库、Safari 清理站点数据都会抛出
 * 用户看不懂的原生错误。这里只做归类提示，不尝试自动修复。
 */
function explain(message: string, name: string): { code: string; advice: string } {
  const text = message.toLocaleLowerCase()
  if (
    name === 'QuotaExceededError' ||
    text.includes('quotaexceedederror') ||
    /(?:storage|disk) (?:space )?quota/.test(text) ||
    /^(?:the )?quota (?:has been )?exceeded[.!]?$/.test(text)
  ) {
    return {
      code: 'SRL-FATAL-STORAGE-QUOTA',
      advice: '浏览器存储空间不足。请先导出完整备份，再清理回收站或不需要的资源。',
    }
  }
  if (text.includes('maximum call stack') || text.includes('too much recursion')) {
    return {
      code: 'SRL-FATAL-STACK-OVERFLOW',
      advice: '操作的调用层级过深，已中止。请重新打开该功能后重试；若重复出现，请保留技术详情。',
    }
  }
  if (text.includes('indexeddb') || text.includes('database') || text.includes('dexie')) {
    return {
      code: 'SRL-FATAL-DATABASE',
      advice: '本地数据库无法访问。若使用隐私模式或浏览器刚清理过站点数据，请换回普通窗口重试。',
    }
  }
  // 分包失败必须先于通用网络错误判断；错误码表示已知故障类别，不断言根因。
  if (text.includes('dynamically imported module') || text.includes('importing a module')) {
    return {
      code: 'SRL-FATAL-MODULE-LOAD',
      advice: '页面模块加载失败，通常是资源库刚完成更新。刷新页面即可继续。',
    }
  }
  if (text.includes('failed to fetch') || text.includes('networkerror')) {
    return {
      code: 'SRL-FATAL-NETWORK',
      advice: '网络请求失败。本地资源不受影响，联网功能请稍后重试。',
    }
  }
  return {
    code: 'SRL-FATAL-UNHANDLED',
    advice: '发生了未处理的错误。本地资源仍保存在浏览器数据库中，刷新页面可以继续使用。',
  }
}

/**
 * 用原生 DOM 渲染错误横幅。
 *
 * 刻意不使用 Vue 组件：这里要处理的正是 Vue 渲染树已经崩溃的场景。
 */
function renderErrorDialog(source: string, detail: string, advice: string): void {
  const existing = document.getElementById(BANNER_ID)
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = BANNER_ID
  overlay.setAttribute('role', 'presentation')
  const dialog = document.createElement('section')
  dialog.className = 'srl-fatal-error__dialog'
  dialog.setAttribute('role', 'alertdialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'srl-fatal-error-title')
  dialog.setAttribute('aria-describedby', 'srl-fatal-error-advice')

  const eyebrow = document.createElement('small')
  eyebrow.textContent = '系统错误'
  const title = document.createElement('strong')
  title.id = 'srl-fatal-error-title'
  title.textContent = '该操作没有完成'
  const location = document.createElement('p')
  location.className = 'srl-fatal-error__location'
  location.textContent = `发生位置：${source}`
  const adviceNode = document.createElement('p')
  adviceNode.id = 'srl-fatal-error-advice'
  adviceNode.className = 'srl-fatal-error__advice'
  adviceNode.textContent = advice
  const technical = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '查看技术详情'
  const reason = document.createElement('pre')
  reason.textContent = detail
  technical.append(summary, reason)

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = '刷新页面'
  reload.addEventListener('click', () => void reloadAfterLoadFailure())

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '关闭提示'
  dismiss.addEventListener('click', () => overlay.remove())

  const actions = document.createElement('div')
  actions.className = 'srl-fatal-error__actions'
  actions.append(reload, dismiss)

  dialog.append(eyebrow, title, location, adviceNode, technical, actions)
  overlay.append(dialog)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  document.body.append(overlay)
  dismiss.focus()
}

/** 展示一次错误提示；短时间内的相同错误只提示一次，避免循环报错刷屏。 */
export function reportFatalError(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const { code, advice } = explain(message, name)
  const key = JSON.stringify([source, name, message])
  const now = Date.now()
  if (key === lastErrorKey && now - lastShownAt < REPEAT_WINDOW_MS) return
  lastErrorKey = key
  lastShownAt = now
  const occurrenceId = `${now.toString(36)}-${++occurrenceSequence}`

  // Raw errors may contain resource text, private URLs or credentials. Keep the
  // console record allowlisted; local technical details below retain the diagnosis.
  console.error('[SRL:FatalError]', { code, occurrenceId, buildId: BUILD_INFO.buildId })
  try {
    const detail = [
      `错误代码：${code}`,
      `本次编号：${occurrenceId}`,
      `${source}：${message}`,
      `资源库版本：${BUILD_INFO.buildId}`,
      error instanceof Error ? error.stack : undefined,
    ]
      .filter(Boolean)
      .join('\n\n')
    renderErrorDialog(source, detail.slice(0, 6000), advice)
  } catch {
    // 连横幅都渲染不出来时不再追加动作，控制台记录已经完成。
  }
}

/** 注册全局兜底：Vue 渲染错误、未捕获异常与未处理的 Promise 拒绝。 */
export function installGlobalErrorHandlers(app: App): void {
  app.config.errorHandler = (error, instance, info) => {
    const component = instance?.$options.name ?? instance?.$options.__name
    reportFatalError(`组件错误 ${info}${component ? `（${component}）` : ''}`, error)
  }
  window.addEventListener('error', (event) => {
    // 图片、样式等资源加载失败会冒泡到 window，但没有 error 对象，不作为致命错误处理。
    if (!event.error) return
    reportFatalError('运行时错误', event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportFatalError('未处理的异步错误', event.reason)
  })
}
