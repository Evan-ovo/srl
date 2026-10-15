// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { AssistantBrowserTaskService } from './AssistantBrowserTaskService'
import {
  assistantBrowserSession,
  type AssistantBrowserRuntime,
  type AssistantBrowserEvent,
} from './AssistantBrowserRuntime'
import { TaskCenter } from '../core/TaskCenter'
const page = {
  tabId: 2,
  documentId: 7,
  url: 'https://example.org/form',
  paused: false,
  searchMatched: true,
}
function fixture() {
  let event: (value: AssistantBrowserEvent) => void = () => {}
  const browser = {
    open: vi.fn(async (_options: Parameters<AssistantBrowserRuntime['open']>[0]) => {}),
    inspect: vi.fn(async (_options?: Parameters<AssistantBrowserRuntime['inspect']>[0]) => ({
      ...page,
    })),
    waitReady: vi.fn(async () => ({ ...page })),
    addListener: vi.fn(async (_name, callback) => {
      event = callback
      return { remove: vi.fn(async () => {}) }
    }),
    act: vi.fn(async () => ({ ok: true, dispatched: true })),
    close: vi.fn(async () => {}),
    cancelWait: vi.fn(async () => {}),
    pauseAgent: vi.fn(async () => {}),
    readPage: vi.fn(async () => ({ ...page, text: 'actual content' })),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    back: vi.fn(async () => ({ ...page, moved: true })),
    switchTab: vi.fn(async () => ({ ...page })),
    wait: vi.fn(async () => ({ ...page })),
    capture: vi.fn(async () => ({
      dataUrl: 'data:image/jpeg;base64,AAA',
      tabId: 2,
      documentId: 7,
    })),
    chatPresentation: vi.fn(async () => {}),
    download: vi.fn(async () => ({ ok: true, downloaded: true, importQueued: true })),
    waitStatus: vi.fn(async () => ({ ...page })),
    confirmSuccess: vi.fn(async () => ({ confirmed: true })),
    suspend: vi.fn(async () => ({ suspended: true })),
    restore: vi.fn(async () => {}),
    pet: vi.fn(async () => {}),
    message: vi.fn(async () => {}),
  } satisfies AssistantBrowserRuntime
  const tasks = new TaskCenter(),
    confirm = vi.fn(async () => true)
  const owner = new AssistantBrowserTaskService(browser as AssistantBrowserRuntime, tasks, confirm)
  const controller = new AbortController()
  const execute = (operation: string, args: Record<string, string> = {}) =>
    owner.execute({ operation, ...args }, 'chat-a', controller.signal)
  return {
    browser,
    tasks,
    confirm,
    owner,
    controller,
    execute,
    event: (value: AssistantBrowserEvent) => event(value),
  }
}
beforeEach(() =>
  Object.assign(assistantBrowserSession, {
    purpose: 'general',
    active: false,
    agentRunning: false,
    assistantConversationId: '',
    browserVisible: false,
  }),
)
describe('shared browser task lifecycle', () => {
  it('does not open a webpage when generation is cancelled during listener registration', async () => {
    const f = fixture()
    const remove = vi.fn(async () => {})
    let resolve!: (value: { remove: typeof remove }) => void
    f.browser.addListener.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const opening = f.execute('open', { url: page.url })
    await vi.waitFor(() => expect(f.browser.addListener).toHaveBeenCalledTimes(1))
    f.controller.abort()
    resolve({ remove })
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.browser.open).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
  })
  it('removes a late listener registration when the task closes during opening', async () => {
    const f = fixture()
    const remove = vi.fn(async () => {})
    let resolve!: (value: { remove: typeof remove }) => void
    f.browser.addListener.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const opening = f.execute('open', { url: page.url })
    await vi.waitFor(() => expect(f.browser.addListener).toHaveBeenCalledTimes(1))
    const closing = f.owner.close()
    resolve({ remove })
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await closing
    expect(remove).toHaveBeenCalledTimes(1)
    expect(f.browser.open).not.toHaveBeenCalled()
  })
  it('does not mark a late resume as running after the task closes', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await f.owner.pause()
    let resolve!: () => void
    f.browser.open.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const resuming = f.owner.resume('chat-a')
    await f.owner.close()
    resolve()
    await expect(resuming).rejects.toMatchObject({ name: 'AbortError' })
    expect(assistantBrowserSession.agentRunning).toBe(false)
    expect(assistantBrowserSession.active).toBe(false)
  })
  it.each(['pause', 'close', 'model'] as const)(
    'releases a pending resume on %s without waiting for a native open receipt',
    async (stop) => {
      const f = fixture()
      await f.execute('open', { url: page.url })
      await f.owner.pause()
      let finish!: () => void
      f.browser.open.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      )
      let settled = false
      const resuming = stop === 'model' ? f.execute('resume') : f.owner.resume('chat-a')
      const outcome = resuming.then(
        () => {
          settled = true
          return 'unexpected success'
        },
        (error: unknown) => {
          settled = true
          return error
        },
      )
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      if (stop === 'model') f.controller.abort()
      else await f.owner[stop]()
      try {
        await vi.waitFor(() => expect(settled).toBe(true))
      } finally {
        finish()
        expect(await outcome).toMatchObject({ name: 'AbortError' })
        await f.owner.close()
      }
      expect(assistantBrowserSession.agentRunning).toBe(false)
      expect(f.browser.inspect).not.toHaveBeenCalled()
    },
  )
  it('can inspect and list tabs while paused without restarting or allowing mutations', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await f.owner.pause()
    await expect(f.execute('inspect')).resolves.toMatchObject({ documentId: page.documentId })
    await expect(f.execute('list-tabs')).resolves.toMatchObject({ tabs: [] })
    expect(f.browser.inspect.mock.lastCall?.[0]).not.toHaveProperty('ownerAgentRunId')
    await expect(
      f.execute('click', { document_id: '7', tab_id: '2', target: 'button' }),
    ).rejects.toThrow('暂停')
    expect(f.browser.act).not.toHaveBeenCalled()
    expect(f.browser.open).toHaveBeenCalledOnce()
    expect(assistantBrowserSession.agentRunning).toBe(false)
    await f.owner.close()
  })
  it('cancels the resumed observation and never returns its late page as success', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await f.owner.pause()
    let finish!: (value: typeof page) => void
    f.browser.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const resuming = f.execute('resume')
    const rejected = expect(resuming).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.controller.abort()
    await rejected
    finish(page)
    await Promise.resolve()
    expect(assistantBrowserSession.agentRunning).toBe(false)
    await f.owner.close()
  })
  it('does not reopen a running task or permit actions after a failed explicit resume', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    const run = f.browser.open.mock.lastCall![0]!.agentRunId
    await f.owner.resume('chat-a')
    expect(f.browser.open).toHaveBeenCalledOnce()
    expect(f.browser.open.mock.lastCall![0]!.agentRunId).toBe(run)
    await f.owner.pause()
    f.browser.open.mockRejectedValueOnce(new Error('open unavailable'))
    await expect(f.owner.resume('chat-a')).rejects.toThrow('open unavailable')
    expect(assistantBrowserSession.agentRunning).toBe(false)
    await expect(
      f.execute('click', { document_id: '7', tab_id: '2', target: 'button' }),
    ).rejects.toThrow('暂停')
    expect(f.browser.act).not.toHaveBeenCalled()
    await f.owner.close()
  })
  it('does not adopt a native task from a cancelled recovery lookup', async () => {
    const f = fixture()
    type CurrentTask = Awaited<ReturnType<NonNullable<AssistantBrowserRuntime['currentTask']>>>
    let finish!: (value: CurrentTask) => void
    Object.assign(f.browser, {
      currentTask: vi.fn(
        () =>
          new Promise<CurrentTask>((resolve) => {
            finish = resolve
          }),
      ),
    })
    let settled = false
    const outcome = f.execute('resume').then(
      () => {
        settled = true
        return 'unexpected success'
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.controller.abort()
    try {
      await vi.waitFor(() => expect(settled).toBe(true))
    } finally {
      finish({
        ...page,
        active: true,
        purpose: 'general',
        runId: 'retained-run',
        conversationId: 'chat-a',
        finished: false,
      })
      expect(await outcome).toMatchObject({ name: 'AbortError' })
      expect(f.owner.owns('chat-a')).toBe(false)
      expect(f.browser.addListener).not.toHaveBeenCalled()
    }
  })
  it('closes before a pending listener returns and removes the late registration', async () => {
    const f = fixture()
    const remove = vi.fn(async () => {})
    let resolve!: (handle: { remove: typeof remove }) => void
    f.browser.addListener.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const opening = f.execute('open', { url: page.url })
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.browser.addListener).toHaveBeenCalledOnce())
    await f.owner.close()
    expect(f.browser.close).toHaveBeenCalledOnce()
    expect(f.tasks.list()[0]?.status).toBe('cancelled')
    resolve({ remove })
    await rejected
    expect(remove).toHaveBeenCalledOnce()
    expect(f.browser.open).not.toHaveBeenCalled()
  })
  it.each(['pause', 'close'] as const)(
    'still releases the native window during %s when cancelling a wait fails',
    async (operation) => {
      const f = fixture()
      const remove = vi.fn(async () => {})
      f.browser.addListener.mockResolvedValueOnce({ remove })
      await f.execute('open', { url: page.url })
      f.browser.cancelWait.mockRejectedValueOnce(new Error('cancel bridge failed'))
      await (operation === 'pause' ? f.owner.pause() : f.owner.close())
      expect(assistantBrowserSession.agentRunning).toBe(false)
      if (operation === 'pause') {
        expect(f.browser.pauseAgent).toHaveBeenCalledOnce()
        expect(f.tasks.list()[0]?.phase).toContain('已暂停')
        await f.owner.close()
      } else {
        expect(f.browser.close).toHaveBeenCalledOnce()
        expect(remove).toHaveBeenCalledOnce()
        expect(f.tasks.list()[0]?.status).toBe('cancelled')
      }
    },
  )
  it('does not wait for a stalled cancellation or listener removal when closing', async () => {
    const f = fixture()
    let finishRemove!: () => void
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemove = resolve
        }),
    )
    f.browser.addListener.mockResolvedValueOnce({ remove })
    await f.execute('open', { url: page.url })
    f.browser.cancelWait.mockImplementationOnce(() => new Promise(() => {}))
    await f.owner.close()
    expect(f.browser.close).toHaveBeenCalledOnce()
    expect(f.tasks.list()[0]?.status).toBe('cancelled')
    expect(remove).toHaveBeenCalledOnce()
    finishRemove()
    await Promise.resolve()
  })
  it('does not claim native pause is confirmed when its primary acknowledgement fails', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    f.browser.pauseAgent.mockRejectedValueOnce(new Error('pause unavailable'))
    await expect(f.owner.pause()).rejects.toThrow('pause unavailable')
    expect(f.tasks.list()[0]?.phase).toContain('回执未确认')
    await f.owner.pause()
    expect(f.browser.pauseAgent).toHaveBeenCalledTimes(2)
    expect(f.tasks.list()[0]?.phase).toContain('已暂停')
    expect(assistantBrowserSession.agentRunning).toBe(false)
    await f.owner.close()
  })
  it('does not overwrite a resumed task phase with a late pause acknowledgement', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    let finish!: () => void
    f.browser.pauseAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const stopping = f.owner.pause()
    await f.owner.resume('chat-a')
    finish()
    await stopping
    expect(assistantBrowserSession.agentRunning).toBe(true)
    expect(f.tasks.list()[0]?.phase).toContain('已继续')
    await f.owner.close()
  })
  it('shares one pause receipt across the model cancellation and visible stop action', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    let finish!: () => void
    f.browser.pauseAgent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const first = f.owner.pause()
    const second = f.owner.pause()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(f.browser.pauseAgent).toHaveBeenCalledOnce()
    finish()
    await Promise.all([first, second])
    await f.owner.pause()
    expect(f.browser.pauseAgent).toHaveBeenCalledOnce()
    await f.owner.close()
  })
  it('does not display an old event failure over the current resumed task', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    let fail!: (error: Error) => void
    f.browser.pauseAgent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        }),
    )
    f.event({
      action: 'agent-pause',
      runId: f.browser.open.mock.lastCall![0]!.ownerTaskId!,
      conversationId: 'chat-a',
    })
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
    await f.owner.resume('chat-a')
    fail(new Error('old pause failed'))
    await flushPromises()
    expect(f.tasks.list()[0]?.phase).toContain('已继续')
    expect(assistantBrowserSession.agentRunning).toBe(true)
    await f.owner.close()
  })
  it('renews the execution generation on explicit resume while retaining task and conversation identity', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    const first = f.browser.open.mock.calls[0]![0]!
    await f.owner.pause()
    await f.owner.resume('chat-a')
    const resumed = f.browser.open.mock.lastCall![0]!
    expect(resumed.ownerTaskId).toBe(first.ownerTaskId)
    expect(resumed.conversationId).toBe(first.conversationId)
    expect(resumed.agentRunId).not.toBe(first.agentRunId)
    await f.execute('click', { tab_id: '2', document_id: '7', target: '99' })
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRunId: first.ownerTaskId,
        ownerAgentRunId: resumed.agentRunId,
      }),
    )
    await f.owner.close()
  })
  it('recovers only the same conversation and preserves pause without reopening or operating a page', async () => {
    const f = fixture()
    Object.assign(f.browser, {
      currentTask: vi.fn(async () => ({
        active: true,
        purpose: 'general',
        runId: 'retained-run',
        conversationId: 'chat-a',
        url: page.url,
        paused: true,
        finished: false,
      })),
    })
    expect(await f.owner.recover('chat-b')).toBe(false)
    expect(await f.owner.recover('chat-a')).toBe(true)
    expect(assistantBrowserSession.agentRunning).toBe(false)
    expect(f.browser.open).not.toHaveBeenCalled()
    await expect(
      f.execute('click', { tab_id: '2', document_id: '7', target: '1' }),
    ).rejects.toThrow('明确继续')
    await f.owner.close()
  })
  it('does not disturb Discord after the shared window is handed to that workflow', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    Object.assign(assistantBrowserSession, {
      purpose: 'discord-setup',
      active: true,
      assistantConversationId: 'discord-chat',
      browserVisible: true,
    })
    await expect(f.execute('inspect')).rejects.toThrow('另一任务')
    expect(f.browser.close).not.toHaveBeenCalled()
    expect(assistantBrowserSession.assistantConversationId).toBe('discord-chat')
    expect(assistantBrowserSession.browserVisible).toBe(true)
  })
  it('keeps the user chat, uses current target refs without a hidden reinspection, and reads paginated regions', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await f.execute('inspect')
    await f.execute('click', { tab_id: '2', document_id: '7', target: 'original-ref' })
    expect(f.browser.inspect).toHaveBeenCalledTimes(1)
    expect(f.browser.act).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 2, documentId: 7, target: 'original-ref' }),
    )
    await f.execute('read-page', {
      tab_id: '2',
      document_id: '7',
      region: 'region-ref',
      offset: '2400',
    })
    expect(f.browser.readPage).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'region-ref', offset: 2400 }),
    )
    expect(assistantBrowserSession.assistantConversationId).toBe('chat-a')
    await f.owner.close()
  })
  it('does not infer identity for an action and never borrows another chat task', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await expect(f.execute('click', { target: '1' })).rejects.toThrow('document_id')
    await expect(
      f.owner.execute(
        { operation: 'click', document_id: '7', tab_id: '2' },
        'chat-b',
        f.controller.signal,
      ),
    ).rejects.toThrow('当前聊天')
    expect(f.browser.act).not.toHaveBeenCalled()
    await f.owner.close()
  })
  it('discards an in-flight read after pause and does not revive on page-ready', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    const id = f.tasks.list()[0]!.operationId
    let resolve!: (value: typeof page) => void
    f.browser.inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const reading = f.execute('inspect')
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await f.owner.pause()
    await rejected
    resolve(page)
    f.event({ action: 'page-ready', runId: id, conversationId: 'chat-a' })
    expect(assistantBrowserSession.agentRunning).toBe(false)
    await expect(
      f.execute('fill', { tab_id: '2', document_id: '7', target: '1', value: 'a' }),
    ).rejects.toThrow('明确继续')
    await f.owner.close()
  })
  it('closes as cancellation and rejects late navigation completion', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    let resolve!: (value: { ok: boolean; dispatched: boolean }) => void
    f.browser.act.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const clicking = f.execute('click', { tab_id: '2', document_id: '7', target: '1' })
    await f.owner.close()
    resolve({ ok: true, dispatched: true })
    await expect(clicking).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.tasks.list()[0]?.status).toBe('cancelled')
  })
  it('ignores events from another run and switches to the preserved WebView without reloading', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    f.event({ action: 'return', runId: 'old-run', conversationId: 'chat-a' })
    expect(f.owner.owns('chat-a')).toBe(true)
    await f.owner.returnToBrowser()
    expect(f.browser.chatPresentation).toHaveBeenCalledWith({
      mode: 'browser',
      conversationId: 'chat-a',
    })
    expect(f.browser.open).toHaveBeenCalledTimes(1)
    await f.owner.close()
  })
  it('uses webpage evidence for finish, then rejects further actions', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    await expect(f.execute('finish')).rejects.toThrow('实际完成结果')
    f.browser.inspect.mockResolvedValueOnce({ ...page, searchMatched: false })
    await expect(f.execute('finish', { query: 'success' })).rejects.toThrow('未核验')
    expect(f.tasks.list()[0]?.status).toBe('running')
    await f.execute('finish', { query: 'success' })
    expect(f.tasks.list()[0]?.status).toBe('completed')
    await expect(f.execute('fill', { tab_id: '2', document_id: '7', target: '1' })).rejects.toThrow(
      '任务已结束',
    )
    await f.owner.close()
    expect(f.tasks.list()[0]?.status).toBe('completed')
  })
  it('takes screenshots from the target runtime and routes downloads to its file owner', async () => {
    const f = fixture()
    await f.execute('open', { url: page.url })
    expect(await f.execute('screenshot', { tab_id: '2', document_id: '7' })).toMatchObject({
      imageDataUrl: 'data:image/jpeg;base64,AAA',
    })
    expect(
      await f.execute('download', {
        tab_id: '2',
        document_id: '7',
        target: '55',
        destination: 'import',
      }),
    ).toMatchObject({ importQueued: true })
    expect(f.browser.download).toHaveBeenCalledWith({
      documentId: 7,
      tabId: 2,
      target: '55',
      destination: 'import',
      ownerRunId: f.tasks.list()[0]!.operationId,
      ownerAgentRunId: expect.any(String),
    })
    await f.owner.close()
  })
})
