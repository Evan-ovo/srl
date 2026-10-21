/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import {
  installGlobalErrorHandlers,
  reportFatalError,
  reportHandledError,
} from './FatalErrorNotice'
import { BUILD_INFO } from './BuildInfo'

function errorDialogText(): string {
  return document.getElementById('srl-fatal-error')?.textContent ?? ''
}

describe('reportFatalError', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    // 每个用例推进时间，越过同一错误的 5 秒去重窗口
    vi.setSystemTime(Date.now() + 60_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('渲染带来源与技术详情的错误弹窗，并保留原始错误信息', () => {
    reportFatalError('导入', new Error('something broke'))
    const overlay = document.getElementById('srl-fatal-error')
    const dialog = overlay?.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(errorDialogText()).toContain('发生位置：导入')
    expect(errorDialogText()).toContain('something broke')
  })

  it('把配额超限翻译成可执行的中文建议', () => {
    reportFatalError('保存', new Error('QuotaExceededError: quota reached'))
    expect(errorDialogText()).toContain('存储空间不足')
    expect(errorDialogText()).toContain('导出完整备份')
  })

  it('数据库损坏提示保全原文件，不引导清除数据或把重开当作修复', () => {
    reportFatalError('Android 数据库', new Error('SRL-DATABASE-CORRUPT: damaged database'))
    expect(errorDialogText()).toContain('SRL-FATAL-DATABASE-CORRUPT')
    expect(errorDialogText()).toContain('请勿清除应用数据或卸载')
    expect(errorDialogText()).toContain('先保全应用数据')
    expect(errorDialogText()).not.toContain('换回普通窗口')
  })

  it('Vue 渲染故障的详情保留组件、版本和原始堆栈，帮助区分更新与业务错误', () => {
    const app = createApp({ name: 'FailingFeature', render: () => null })
    // This case concerns the error detail only; do not install window listeners.
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
    installGlobalErrorHandlers(app)
    const root = document.createElement('div')
    const instance = app.mount(root)
    const error = new Error("null is not an object (evaluating 'W.ce')")
    error.stack = `${error.message}\nrender@https://example.com/assets/Feature-test.js:1:42`
    app.config.errorHandler!(error, instance, 'https://vuejs.org/error-reference/#runtime-1')
    const detail = document.querySelector('#srl-fatal-error pre')?.textContent
    expect(detail).toContain('（FailingFeature）')
    expect(detail).toContain(`资源库版本：${BUILD_INFO.buildId}`)
    expect(detail).toContain('Feature-test.js:1:42')
    app.unmount()
  })

  it('把分包加载失败提示为需要刷新', () => {
    reportFatalError('加载', new Error('Failed to fetch dynamically imported module'))
    expect(errorDialogText()).toContain('刷新页面即可继续')
  })

  it('把 IndexedDB 故障与网络故障分开解释', () => {
    reportFatalError('读取', new Error('IndexedDB is not available'))
    expect(errorDialogText()).toContain('本地数据库无法访问')

    vi.setSystemTime(Date.now() + 60_000)
    reportFatalError('上传', new Error('Failed to fetch'))
    expect(errorDialogText()).toContain('本地资源不受影响')
  })

  it('短时间内的相同错误只提示一次，避免循环报错刷屏', () => {
    reportFatalError('渲染', new Error('same failure'))
    const first = document.getElementById('srl-fatal-error')
    reportFatalError('渲染', new Error('same failure'))
    expect(document.getElementById('srl-fatal-error')).toBe(first)
  })

  it('超过去重窗口后重新提示', () => {
    reportFatalError('渲染', new Error('same failure'))
    const first = document.getElementById('srl-fatal-error')
    vi.setSystemTime(Date.now() + 6_000)
    reportFatalError('渲染', new Error('same failure'))
    expect(document.getElementById('srl-fatal-error')).not.toBe(first)
  })

  it('相同错误文字来自不同操作时分别显示，保留当前发生位置', () => {
    reportFatalError('读取资源', new Error('shared failure'))
    const first = document.getElementById('srl-fatal-error')
    reportFatalError('保存设置', new Error('shared failure'))
    expect(document.getElementById('srl-fatal-error')).not.toBe(first)
    expect(errorDialogText()).toContain('发生位置：保存设置')
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('同一位置的不同错误类型不被相同文字吞掉', () => {
    reportFatalError('保存', new Error('type-specific failure'))
    const first = document.getElementById('srl-fatal-error')
    reportFatalError('保存', new DOMException('type-specific failure', 'QuotaExceededError'))
    expect(document.getElementById('srl-fatal-error')).not.toBe(first)
    expect(errorDialogText()).toContain('SRL-FATAL-STORAGE-QUOTA')
  })

  it.each(['Maximum call stack size exceeded', 'too much recursion'])(
    '调用栈溢出不误报为存储配额耗尽：%s',
    (message) => {
      reportFatalError('渲染', new RangeError(message))
      expect(errorDialogText()).toContain('SRL-FATAL-STACK-OVERFLOW')
      expect(errorDialogText()).toContain('调用层级过深')
      expect(errorDialogText()).not.toContain('存储空间不足')
      expect(errorDialogText()).not.toContain('清理回收站')
    },
  )

  it('普通的限额或超限文字不推断成本地存储配额故障', () => {
    reportFatalError('请求', new Error('API rate quota exceeded'))
    expect(errorDialogText()).toContain('SRL-FATAL-UNHANDLED')
    expect(errorDialogText()).not.toContain('存储空间不足')
  })

  it.each([
    ['IndexedDB is not available', 'SRL-FATAL-DATABASE'],
    ['Failed to fetch dynamically imported module', 'SRL-FATAL-MODULE-LOAD'],
    ['Failed to fetch', 'SRL-FATAL-NETWORK'],
    ['unrecognized failure', 'SRL-FATAL-UNHANDLED'],
  ])('已知类别提供稳定错误码：%s', (message, code) => {
    reportFatalError('操作', new Error(message))
    expect(errorDialogText()).toContain(code)
  })

  it('控制台只记录允许的诊断字段，本机技术详情保留原文和关联编号', () => {
    const privateText = 'private-resource-content token=private-token'
    const error = new Error(privateText)
    error.stack = `${privateText}\nread@https://example.com/resource?token=private-token:1:2`
    reportFatalError('读取', error)
    const call = vi.mocked(console.error).mock.calls[0]!
    expect(call[0]).toBe('[SRL:FatalError]')
    expect(call[1]).toEqual({
      code: 'SRL-FATAL-UNHANDLED',
      occurrenceId: expect.any(String),
      buildId: BUILD_INFO.buildId,
    })
    expect(JSON.stringify(call)).not.toContain(privateText)
    expect(JSON.stringify(call)).not.toContain('private-token')
    expect(errorDialogText()).toContain(`本次编号：${call[1].occurrenceId}`)
    expect(errorDialogText()).toContain(privateText)
  })

  it('点击忽略后移除横幅', () => {
    reportFatalError('渲染', new Error('dismiss me'))
    const buttons = document.querySelectorAll<HTMLButtonElement>('#srl-fatal-error button')
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(['刷新页面', '关闭提示'])
    buttons[1].click()
    expect(document.getElementById('srl-fatal-error')).toBeNull()
  })
})

describe('reportHandledError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps operation code and wrapped cause classification without exposing private data', () => {
    const secret = 'resource-private token=secret https://private.example/?token=secret'
    const error = new Error(secret, { cause: new DOMException(secret, 'QuotaExceededError') })
    const message = reportHandledError('SRL-SEARCH-ORIGINAL-READ', error, { itemCount: 10000 })
    expect(message).toContain('正文搜索未完成')
    expect(message).toContain('SRL-SEARCH-ORIGINAL-READ')
    expect(message).not.toContain(secret)
    const record = vi.mocked(console.warn).mock.calls[0]![1]
    expect(record).toEqual({
      code: 'SRL-SEARCH-ORIGINAL-READ',
      occurrenceId: expect.any(String),
      buildId: BUILD_INFO.buildId,
      category: 'STORAGE-QUOTA',
      errorName: 'QuotaExceededError',
      itemCount: 10000,
    })
    expect(message).toContain(record.occurrenceId)
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret)
  })

  it('ignores cancellation and does not render the fatal dialog for a handled failure', () => {
    expect(
      reportHandledError('SRL-LIBRARY-LOAD', new DOMException('private', 'AbortError')),
    ).toBeUndefined()
    expect(console.warn).not.toHaveBeenCalled()
    document.getElementById('srl-fatal-error')?.remove()
    reportHandledError('SRL-LIBRARY-LOAD', new Error('failure'))
    expect(document.getElementById('srl-fatal-error')).toBeNull()
  })

  it('allows only known error names and finite nonnegative integer context', () => {
    const error = new Error('private')
    error.name = 'private-token'
    reportHandledError('SRL-LIBRARY-VAULT-INIT', error, { itemCount: Infinity })
    expect(vi.mocked(console.warn).mock.calls[0]![1]).toEqual({
      code: 'SRL-LIBRARY-VAULT-INIT',
      occurrenceId: expect.any(String),
      buildId: BUILD_INFO.buildId,
      category: 'UNHANDLED',
      errorName: 'UnknownError',
    })
  })
})
