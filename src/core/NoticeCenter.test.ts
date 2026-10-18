import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NoticeCenter } from './NoticeCenter'

describe('NoticeCenter lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('expires completed results even when an old caller requests persistence and a view action', () => {
    const center = new NoticeCenter()
    for (const type of ['success', 'info'] as const)
      center.push({
        type,
        message: '备份完成',
        completed: true,
        persistent: true,
        actions: [{ label: '查看结果', run: vi.fn() }],
      })
    expect(center.list().every((notice) => !notice.persistent)).toBe(true)
    vi.advanceTimersByTime(4_999)
    expect(center.list()).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(center.list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves pending decisions, failures and data risks when clearing completed work', () => {
    const center = new NoticeCenter()
    center.push({ type: 'info', message: '等待确认', persistent: true })
    center.push({ type: 'error', message: '失败', completed: true })
    center.push({ type: 'data-risk', message: '风险', completed: true })
    center.push({ type: 'success', message: '完成', persistent: true })
    center.dismissCompleted()
    vi.advanceTimersByTime(60_000)
    expect(
      center
        .list()
        .map((notice) => notice.message)
        .sort(),
    ).toEqual(['失败', '等待确认', '风险'].sort())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces same-millisecond expiry with the current notice lifetime', () => {
    const center = new NoticeCenter()
    center.push({ id: 'same', type: 'info', message: '旧提示', durationMs: 1 })
    center.push({ id: 'same', type: 'info', message: '等待操作', persistent: true })
    vi.advanceTimersByTime(1)
    expect(center.list()[0]?.message).toBe('等待操作')
    center.push({ id: 'same', type: 'success', message: '完成' })
    vi.advanceTimersByTime(4_000)
    center.push({ id: 'same', type: 'success', message: '新结果' })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(4_999)
    expect(center.list()[0]?.message).toBe('新结果')
    vi.advanceTimersByTime(1)
    expect(center.list()).toEqual([])
  })

  it('cancels timers on dismissal and honours explicit transient durations', () => {
    const center = new NoticeCenter()
    const id = center.push({ type: 'info', message: '普通提示' })
    center.push({ type: 'success', message: '短提示', durationMs: 20 })
    vi.advanceTimersByTime(20)
    expect(center.list()).toHaveLength(1)
    center.dismiss(id)
    expect(vi.getTimerCount()).toBe(0)
    center.push({ type: 'info', message: '普通提示' })
    vi.advanceTimersByTime(4_000)
    expect(center.list()).toEqual([])
  })

  it('retains a replacement pushed synchronously by a subscriber', () => {
    const center = new NoticeCenter()
    const unsubscribe = center.subscribe(() => {
      if (center.list()[0]?.message === '旧提示')
        center.push({ id: 'same', type: 'info', message: '等待操作', persistent: true })
    })
    center.push({ id: 'same', type: 'info', message: '旧提示' })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(center.list()[0]?.message).toBe('等待操作')
    unsubscribe()
  })
})
