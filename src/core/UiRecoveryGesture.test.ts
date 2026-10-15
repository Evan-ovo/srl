/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUiRecoveryGesture } from './UiRecoveryGesture'

let stop: (() => void) | undefined
function pointer(type: string, x = 20, id = 1, primary = true, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 20, button })
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } })
  document.querySelector('button')!.dispatchEvent(event)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.body.innerHTML = '<button>原操作</button>'
})
afterEach(() => {
  stop?.()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})
describe('隐藏恢复入口的2秒长按', () => {
  it('短按不影响点击；满2秒只显示入口，并吞掉这次松手产生的原控件点击', () => {
    const reveal = vi.fn(),
      click = vi.fn()
    stop = installUiRecoveryGesture(document, reveal)
    const button = document.querySelector('button')!
    button.addEventListener('click', click)
    pointer('pointerdown')
    vi.advanceTimersByTime(100)
    pointer('pointerup')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(click).toHaveBeenCalledTimes(1)
    pointer('pointerdown')
    vi.advanceTimersByTime(1999)
    expect(reveal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reveal).toHaveBeenCalledOnce()
    pointer('pointerup')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(click).toHaveBeenCalledTimes(1)
    pointer('pointerdown')
    pointer('pointerup')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(click).toHaveBeenCalledTimes(2)
  })
  it.each([
    'pointerup',
    'pointercancel',
    'move',
    'scroll',
    'blur',
    'pagehide',
    'hidden',
    'multi',
    'dispose',
  ])('%s取消计时，不出现迟到入口', (reason) => {
    const reveal = vi.fn()
    stop = installUiRecoveryGesture(document, reveal)
    pointer('pointerdown')
    vi.advanceTimersByTime(1900)
    if (reason === 'move') pointer('pointermove', 40)
    else if (reason === 'scroll') document.dispatchEvent(new Event('scroll'))
    else if (reason === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    } else if (reason === 'multi') pointer('pointerdown', 20, 2, false)
    else if (reason === 'dispose') stop()
    else if (reason === 'blur' || reason === 'pagehide') window.dispatchEvent(new Event(reason))
    else pointer(reason)
    vi.advanceTimersByTime(3000)
    expect(reveal).not.toHaveBeenCalled()
  })
  it('右键或未启用的界面不启动恢复手势', () => {
    const reveal = vi.fn(),
      active = vi.fn(() => true)
    stop = installUiRecoveryGesture(document, reveal, active)
    pointer('pointerdown', 20, 1, true, 2)
    vi.advanceTimersByTime(2000)
    active.mockReturnValue(false)
    pointer('pointerdown')
    vi.advanceTimersByTime(2000)
    expect(reveal).not.toHaveBeenCalled()
  })
  it('离开页面取消旧计时，返回后仍可重新长按', () => {
    const reveal = vi.fn()
    stop = installUiRecoveryGesture(document, reveal)
    pointer('pointerdown')
    vi.advanceTimersByTime(1900)
    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(1000)
    expect(reveal).not.toHaveBeenCalled()
    pointer('pointerdown')
    vi.advanceTimersByTime(2000)
    expect(reveal).toHaveBeenCalledOnce()
  })
})
