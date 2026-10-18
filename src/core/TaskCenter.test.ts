import { afterEach, describe, expect, it, vi } from 'vitest'

import { TaskCenter } from './TaskCenter'

describe('TaskCenter', () => {
  afterEach(() => vi.useRealTimers())

  it('expires a successful task with an optional view action after five seconds', async () => {
    vi.useFakeTimers()
    const center = new TaskCenter()
    const open = vi.fn()
    const id = center.start({
      name: 'backup',
      action: { label: '查看云备份', run: open, required: false },
    })
    center.complete(id)
    await expect(center.open(id)).resolves.toBe(true)
    expect(open).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(4_999)
    expect(center.list()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(center.list()).toEqual([])
  })

  it('retains required actions, waiting imports, failures and active tasks', () => {
    vi.useFakeTimers()
    const center = new TaskCenter()
    const pending = center.start({ name: 'pending', action: { label: '继续', run: vi.fn() } })
    center.complete(pending)
    const download = center.start({ name: 'download', phase: '下载完成，可继续导入' })
    center.complete(download)
    const failed = center.start({
      name: 'failed',
      action: { label: '查看', run: vi.fn(), required: false },
    })
    center.fail(failed, new Error('offline'))
    center.start({ name: 'running', action: { label: '查看', run: vi.fn(), required: false } })
    center.dismissCompleted()
    vi.advanceTimersByTime(60_000)
    expect(center.list()).toHaveLength(4)
  })

  it('reschedules cleanup when a required action becomes optional and cancels it if required again', () => {
    vi.useFakeTimers()
    const center = new TaskCenter()
    const id = center.start({ name: 'backup', action: { label: '继续', run: vi.fn() } })
    center.complete(id)
    center.setAction(id, { label: '查看', run: vi.fn(), required: false })
    vi.advanceTimersByTime(4_000)
    center.setAction(id, { label: '继续处理', run: vi.fn() })
    vi.advanceTimersByTime(10_000)
    expect(center.list()).toHaveLength(1)
    center.setAction(id, { label: '查看', run: vi.fn(), required: false })
    vi.advanceTimersByTime(5_000)
    expect(center.list()).toEqual([])
  })

  it('does not expire a replacement task with the same operation ID', () => {
    vi.useFakeTimers()
    const center = new TaskCenter()
    const id = center.start({ operationId: 'same', name: 'old' })
    center.complete(id)
    center.start({ operationId: id, name: 'new' })
    vi.advanceTimersByTime(5_000)
    expect(center.list()[0]?.name).toBe('new')
    expect(center.list()[0]?.status).toBe('running')
  })

  it('opens completed work once while unrelated actions remain independent', async () => {
    const center = new TaskCenter()
    let finish!: () => void
    const open = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const first = center.start({ name: 'first', action: { label: '查看附件', run: open } })
    const otherOpen = vi.fn()
    const second = center.start({ name: 'second', action: { label: '查看附件', run: otherOpen } })
    center.complete(first)
    const pending = center.open(first)
    await expect(center.open(first)).resolves.toBe(false)
    await expect(center.open(second)).resolves.toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(otherOpen).toHaveBeenCalledOnce()
    finish()
    await expect(pending).resolves.toBe(true)
    expect(center.list().find((task) => task.operationId === first)?.status).toBe('completed')
    center.dismiss(first)
    await expect(center.open(first)).resolves.toBe(false)
  })

  it('navigation failure leaves the original task and releases the action lock', async () => {
    const center = new TaskCenter()
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('navigation failed'))
      .mockResolvedValueOnce(undefined)
    const id = center.start({ name: 'download', action: { label: '查看附件', run: open } })
    center.complete(id)
    await expect(center.open(id)).rejects.toThrow('navigation failed')
    expect(center.list()[0]?.status).toBe('completed')
    await expect(center.open(id)).resolves.toBe(true)
  })
  it('does not advertise retry when no retry action exists', async () => {
    const center = new TaskCenter()
    const id = center.start({ name: 'download' })
    center.fail(id, new Error('offline'))
    expect(center.list()[0]?.retryable).toBe(false)
    await expect(center.retry(id)).resolves.toBe(false)
  })

  it('advertises and invokes a provided retry action', async () => {
    const center = new TaskCenter()
    const retry = vi.fn(async () => undefined)
    const id = center.start({ name: 'download', retry })
    center.fail(id, new Error('offline'))
    expect(center.list()[0]?.retryable).toBe(true)
    await expect(center.retry(id)).resolves.toBe(true)
    expect(retry).toHaveBeenCalledOnce()
  })

  it('keeps cancellation terminal when a pending operation later rejects or completes', () => {
    const center = new TaskCenter()
    const cancel = vi.fn()
    const id = center.start({ name: 'download', cancelable: true, cancel })
    expect(center.cancel(id)).toBe(true)
    center.fail(id, new Error('late abort rejection'))
    center.complete(id)
    expect(center.list()[0]?.status).toBe('cancelled')
    expect(center.list()[0]?.error).toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
    expect(center.active()).toHaveLength(0)
  })

  it('does not overwrite a completed task with a late failure', () => {
    const center = new TaskCenter()
    const id = center.start({ name: 'export' })
    center.complete(id)
    center.fail(id, new Error('late failure'))
    expect(center.list()[0]?.status).toBe('completed')
    expect(center.list()[0]?.progress).toBe(1)
  })
  it('keeps an asynchronous stop running until its owner reaches a safe boundary', async () => {
    const center = new TaskCenter()
    let finish!: () => void
    const id = center.start({
      name: 'receipt cleanup',
      cancelable: true,
      cancel: () => {
        center.update(id, { phase: '正在停止' })
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
    })
    expect(center.cancel(id)).toBe(true)
    expect(center.list()[0]?.status).toBe('running')
    expect(center.list()[0]?.phase).toBe('正在停止')
    expect(center.cancel(id)).toBe(false)
    finish()
    await Promise.resolve()
    expect(center.list()[0]?.status).toBe('cancelled')
    center.complete(id)
    expect(center.list()[0]?.status).toBe('cancelled')
  })
  it('does not cancel a replacement task when an old asynchronous stop finishes', async () => {
    const center = new TaskCenter()
    let finish!: () => void
    const id = center.start({
      operationId: 'same',
      name: 'old',
      cancelable: true,
      cancel: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    center.cancel(id)
    center.start({ operationId: id, name: 'new' })
    finish()
    await Promise.resolve()
    expect(center.list()[0]?.name).toBe('new')
    expect(center.list()[0]?.status).toBe('running')
  })
})
