/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: confirm }))
import { runAssistantPageScript } from './ProductAssistantScript'

describe('assistant page script opt-in runtime', () => {
  beforeEach(() => confirm.mockReset().mockResolvedValue(true))
  it('does not execute after rejection or a late approval following stop', async () => {
    const signal = new AbortController()
    const run = vi.fn()
    Object.assign(globalThis, { __scriptAuditRun: run })
    try {
      confirm.mockResolvedValueOnce(false)
      await expect(
        runAssistantPageScript('globalThis.__scriptAuditRun()', signal.signal),
      ).rejects.toThrow('取消')
      let accept!: (value: boolean) => void
      confirm.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve
          }),
      )
      const pending = runAssistantPageScript('globalThis.__scriptAuditRun()', signal.signal)
      signal.abort()
      accept(true)
      await expect(pending).rejects.toThrow()
      expect(run).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(globalThis, '__scriptAuditRun')
    }
  })
  it('executes asynchronous JavaScript in the current page and returns a JSON-safe value', async () => {
    const value = await runAssistantPageScript(
      'await Promise.resolve(); return { title: document.title, answer: 6 * 7 }',
      new AbortController().signal,
    )
    expect(value).toMatchObject({ title: document.title, answer: 42 })
  })
  it('rejects empty or oversized scripts and honors an already-aborted run', async () => {
    const signal = AbortSignal.abort()
    await expect(runAssistantPageScript('', new AbortController().signal)).rejects.toThrow(
      '不能为空',
    )
    await expect(runAssistantPageScript('return 1', signal)).rejects.toThrow()
    await expect(
      runAssistantPageScript('x'.repeat(30_001), new AbortController().signal),
    ).rejects.toThrow('超过30000字')
  })
  it('refuses oversized and non-serializable results instead of injecting them into model history', async () => {
    await expect(
      runAssistantPageScript('return "x".repeat(16001)', new AbortController().signal),
    ).rejects.toThrow('超过16000字')
    await expect(runAssistantPageScript('return 1n', new AbortController().signal)).rejects.toThrow(
      '无法序列化',
    )
  })
})

it('rechecks the live script grant after confirmation before evaluating source', async () => {
  let accept!: (value: boolean) => void
  let allowed = true
  confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      }),
  )
  const pending = runAssistantPageScript(
    'throw new Error("source must not execute")',
    new AbortController().signal,
    () => allowed,
  )
  allowed = false
  accept(true)
  await expect(pending).rejects.toThrow('权限已关闭')
})
