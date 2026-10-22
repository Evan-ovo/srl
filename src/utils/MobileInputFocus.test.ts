/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

import {
  type MobileInputFocusDiagnostic,
  isElementOccludedByViewport,
  revealMobileInputIfOccluded,
  restorePersonalInputScroll,
  setMobileInputFocusDiagnosticListener,
} from './MobileInputFocus'

describe('revealMobileInputIfOccluded', () => {
  const viewport = { height: 420, offsetTop: 0 }

  it.each(['automatic', 'manual scroll', 'different field', 'closed dialog'])(
    'restores only untouched personal editor avoidance: %s',
    (change) => {
      const dialog = document.createElement('section')
      dialog.className = 'personal-resource-editor'
      dialog.setAttribute('role', 'dialog')
      const content = document.createElement('div')
      content.style.overflowY = 'auto'
      const input = document.createElement('input')
      const other = document.createElement('input')
      content.append(input, other)
      dialog.append(content)
      document.body.append(dialog)
      Object.defineProperties(content, {
        clientHeight: { value: 250 },
        scrollHeight: { value: 1200 },
      })
      content.scrollTop = 20
      vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 390, 250))
      vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, 440 - content.scrollTop, 390, 44),
      )
      input.focus()
      expect(revealMobileInputIfOccluded(input, viewport)).toBe(true)
      expect(content.scrollTop).toBeGreaterThan(20)
      if (change === 'manual scroll') content.scrollTop += 30
      if (change === 'different field') other.focus()
      if (change === 'closed dialog') dialog.remove()
      const beforeClose = content.scrollTop
      restorePersonalInputScroll()
      expect(content.scrollTop).toBe(change === 'automatic' ? 20 : beforeClose)
      restorePersonalInputScroll()
      expect(content.scrollTop).toBe(change === 'automatic' ? 20 : beforeClose)
      dialog.remove()
    },
  )

  it('焦点已经处于软键盘上方时不重复滚动', () => {
    expect(isElementOccludedByViewport({ top: 120, bottom: 164 }, viewport)).toBe(false)
  })

  it.each([100, 150])('低矮内容区优先完整显示输入框，留白按剩余空间缩小：%s', (top) => {
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('input')
    content.append(input)
    document.body.append(content)
    Object.defineProperties(content, {
      clientHeight: { value: 53 },
      scrollHeight: { value: 1200 },
    })
    content.scrollTop = 100
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 103, 390, 53))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, top + 100 - content.scrollTop, 390, 44),
    )
    try {
      expect(revealMobileInputIfOccluded(input, { height: 260, offsetTop: 0 })).toBe(true)
      const bounds = input.getBoundingClientRect()
      expect(bounds.top).toBeGreaterThanOrEqual(103)
      expect(bounds.bottom).toBeLessThanOrEqual(156)
      const applied = content.scrollTop
      expect(revealMobileInputIfOccluded(input, { height: 260, offsetTop: 0 })).toBe(false)
      expect(content.scrollTop).toBe(applied)
    } finally {
      content.remove()
    }
  })

  it('没有应用内部滚动区时不会把焦点避让委托给 body 或 root', () => {
    const input = document.createElement('input')
    const scrollIntoView = vi.fn()
    input.scrollIntoView = scrollIntoView
    document.body.append(input)
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      top: 396,
      bottom: 440,
    } as DOMRect)

    expect(revealMobileInputIfOccluded(input, viewport)).toBe(false)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(document.documentElement.scrollTop).toBe(0)
    expect(isElementOccludedByViewport({ top: 0, bottom: 44 }, viewport)).toBe(true)
    input.remove()
  })

  it('键盘缩小弹窗后只滚动正文，并且已经可见时不重复补偿', () => {
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('textarea')
    content.append(input)
    dialog.append(content)
    document.body.append(dialog)
    Object.defineProperties(content, {
      clientHeight: { value: 264 },
      scrollHeight: { value: 1500 },
    })
    content.scrollTop = 201
    input.scrollIntoView = vi.fn()
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 69, 390, 264))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 642 - content.scrollTop, 390, 154),
    )
    const pannedViewport = { height: 448, offsetTop: 296 }
    try {
      expect(revealMobileInputIfOccluded(input, pannedViewport)).toBe(true)
      expect(input.getBoundingClientRect().bottom).toBe(321)
      const scrollTop = content.scrollTop
      expect(revealMobileInputIfOccluded(input, pannedViewport)).toBe(false)
      expect(content.scrollTop).toBe(scrollTop)
      expect(input.scrollIntoView).not.toHaveBeenCalled()
      expect(document.documentElement.scrollTop).toBe(0)
    } finally {
      dialog.remove()
    }
  })

  it('以 visualViewport 客户端坐标修正被推到负 top 的输入框', () => {
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('input')
    content.append(input)
    dialog.append(content)
    document.body.append(dialog)
    Object.defineProperties(content, {
      clientHeight: { value: 417 },
      scrollHeight: { value: 1600 },
    })
    content.scrollTop = 384
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 417))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 336 - content.scrollTop, 390, 45),
    )
    const pannedViewport = { height: 417, offsetTop: 376 }

    try {
      expect(input.getBoundingClientRect().top).toBe(-48)
      expect(isElementOccludedByViewport(input.getBoundingClientRect(), pannedViewport)).toBe(true)
      expect(revealMobileInputIfOccluded(input, pannedViewport)).toBe(true)
      expect(content.scrollTop).toBe(324)
      expect(input.getBoundingClientRect().top).toBe(12)
      expect(revealMobileInputIfOccluded(input, pannedViewport)).toBe(false)
      expect(document.documentElement.scrollTop).toBe(0)
    } finally {
      dialog.remove()
    }
  })

  it('容器已经被 root 推出视觉视口时记录 skipped，而不是误报 already-visible', () => {
    const reports: MobileInputFocusDiagnostic[] = []
    setMobileInputFocusDiagnosticListener((event) => reports.push(event))
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'dialog')
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('input')
    content.append(input)
    dialog.append(content)
    document.body.append(dialog)
    Object.defineProperties(content, {
      clientHeight: { value: 240 },
      scrollHeight: { value: 1200 },
    })
    content.scrollTop = 384
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -250, 390, 240))
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -93, 390, 44))

    try {
      expect(revealMobileInputIfOccluded(input, { height: 189, offsetTop: 222 })).toBe(false)
      expect(content.scrollTop).toBe(384)
      expect(reports.at(-1)).toMatchObject({ result: 'skipped', targetBefore: { top: -93 } })
      expect(document.documentElement.scrollTop).toBe(0)
    } finally {
      setMobileInputFocusDiagnosticListener(undefined)
      dialog.remove()
    }
  })

  it.each(['select', 'contenteditable'])('非弹窗编辑控件也只滚动最近容器：%s', (kind) => {
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const target =
      kind === 'select' ? document.createElement('select') : document.createElement('div')
    if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true')
    content.append(target)
    document.body.append(content)
    Object.defineProperties(content, {
      clientHeight: { value: 240 },
      scrollHeight: { value: 1200 },
    })
    content.scrollTop = 0
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 60, 390, 240))
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 280 - content.scrollTop, 390, 44),
    )

    expect(revealMobileInputIfOccluded(target, viewport)).toBe(true)
    expect(content.scrollTop).toBeGreaterThan(0)
    content.remove()
  })

  it('reports input avoidance before and after scroll without input values', () => {
    const reports: MobileInputFocusDiagnostic[] = []
    setMobileInputFocusDiagnosticListener((event) => reports.push(event))
    const dialog = document.createElement('section')
    dialog.setAttribute('role', 'alertdialog')
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    const input = document.createElement('input')
    input.value = 'private-value'
    content.append(input)
    dialog.append(content)
    document.body.append(dialog)
    Object.defineProperties(content, {
      clientHeight: { value: 250 },
      scrollHeight: { value: 1200 },
    })
    content.scrollTop = 20
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 390, 250))
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 440 - content.scrollTop, 390, 44),
    )

    try {
      expect(revealMobileInputIfOccluded(input, viewport)).toBe(true)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        action: 'avoidance-check',
        target: 'input',
        result: 'scrolled',
        containerScrollTopBefore: 20,
      })
      expect(reports[0].containerScrollTopAfter).toBeGreaterThan(20)
      expect(reports[0]).not.toHaveProperty('value')
    } finally {
      setMobileInputFocusDiagnosticListener(undefined)
      dialog.remove()
    }
  })
})
