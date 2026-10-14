// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    inspect: vi.fn(async () => ({ ...page })),
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
    await f.owner.pause()
    resolve(page)
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
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
