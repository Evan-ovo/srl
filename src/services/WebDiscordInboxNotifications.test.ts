/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enableWebInboxNotifications,
  installWebInboxNotificationNavigation,
  notifyWebDiscordAutoBinding,
  notifyWebDiscordInboxResult,
} from './WebDiscordInboxNotifications'
const show = vi.fn()
const request = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: request })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue({ active: {}, showNotification: show }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
  show.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())
describe('web inbox result notifications', () => {
  it('posts only committed outcomes, deduplicates repeats and retains separate binding identities', async () => {
    const result = {
      kind: 'resource' as const,
      id: 'task-notification',
      workerUrl: 'https://worker.example',
      libraryId: 'library',
      name: '角色卡',
      state: 'imported' as const,
    }
    await notifyWebDiscordInboxResult(result)
    await notifyWebDiscordInboxResult(result)
    expect(show).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledWith(
      '解析成功并已导入',
      expect.objectContaining({ data: { srlInbox: true } }),
    )
    await notifyWebDiscordAutoBinding('帖子 A', '角色 A', {
      sourceId: 'post-a',
      resourceId: 'card-a',
    })
    await notifyWebDiscordAutoBinding('帖子 B', '角色 B', {
      sourceId: 'post-b',
      resourceId: 'card-b',
    })
    expect(show).toHaveBeenCalledTimes(3)
    expect(show.mock.calls[1]![1].tag).not.toBe(show.mock.calls[2]![1].tag)
    expect(request).not.toHaveBeenCalled()
  })
  it('does not open a permission prompt from completion and preserves success if OS delivery fails', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request })
    await expect(
      notifyWebDiscordInboxResult({
        kind: 'post',
        id: 'denied',
        workerUrl: 'https://worker.example',
        libraryId: 'library',
        name: '帖子',
        state: 'saved',
      }),
    ).resolves.toBeUndefined()
    expect(show).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: request })
    show.mockRejectedValueOnce(new Error('OS delivery'))
    await expect(
      notifyWebDiscordAutoBinding('帖子', '角色', {
        sourceId: 'failed-notification',
        resourceId: 'card',
      }),
    ).resolves.toBeUndefined()
  })
  it('requests permission only when invoked by the explicit control', async () => {
    request.mockResolvedValue('granted')
    expect(await enableWebInboxNotifications()).toBe('granted')
    expect(request).toHaveBeenCalledOnce()
  })
  it('handles a cold notification open without retaining or interpreting an external destination', async () => {
    history.replaceState({}, '', '/?open-inbox=1&keep=1')
    const open = vi.fn()
    window.addEventListener('srl:native-deep-link', open)
    const remove = installWebInboxNotificationNavigation()
    await Promise.resolve()
    expect(open).toHaveBeenCalledOnce()
    expect(location.search).toBe('?keep=1')
    remove()
    window.removeEventListener('srl:native-deep-link', open)
  })
})
