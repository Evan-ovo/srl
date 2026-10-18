/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noticeCenter } from '../core/NoticeCenter'
import {
  enableWebInboxNotifications,
  installWebInboxNotificationNavigation,
  notifyWebDiscordAutoBinding,
  notifyWebDiscordInboxResult,
  notifyWebCloudBackupResult,
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
afterEach(() => {
  for (const notice of noticeCenter.list()) noticeCenter.dismiss(notice.id)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('web inbox result notifications', () => {
  it('replaces an obsolete pending or failed notice when the same intake finishes, preserving other intakes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request })
    const base = {
      kind: 'resource' as const,
      id: 'state-transition',
      workerUrl: 'https://worker.example',
      libraryId: 'library',
      name: '角色卡',
    }
    await notifyWebDiscordInboxResult({ ...base, state: 'waiting_version' })
    await notifyWebDiscordInboxResult({
      ...base,
      libraryId: 'other-library',
      state: 'waiting_version',
    })
    await notifyWebDiscordInboxResult({ ...base, state: 'failed' })
    expect(noticeCenter.list()).toHaveLength(2)
    await notifyWebDiscordInboxResult({ ...base, state: 'imported' })
    expect(noticeCenter.list()).toHaveLength(2)
    expect(noticeCenter.list().filter((notice) => notice.completed)).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(noticeCenter.list()).toHaveLength(1)
    expect(noticeCenter.list()[0]?.id).toContain('other-library')
    await notifyWebDiscordInboxResult({ ...base, state: 'waiting_version' })
    expect(noticeCenter.list()).toHaveLength(1)
  })

  it('does not refresh or revive completed internal notices when system permission is denied', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request })
    const result = {
      kind: 'post' as const,
      id: 'independent-channels',
      workerUrl: 'https://worker.example',
      libraryId: 'library',
      name: '帖子',
      state: 'saved' as const,
    }
    await notifyWebDiscordInboxResult(result)
    vi.advanceTimersByTime(4_000)
    await notifyWebDiscordInboxResult(result)
    vi.advanceTimersByTime(1_000)
    expect(noticeCenter.list()).toEqual([])
    await notifyWebDiscordInboxResult(result)
    expect(noticeCenter.list()).toEqual([])
    expect(show).not.toHaveBeenCalled()
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: request })
    await notifyWebDiscordInboxResult(result)
    await notifyWebDiscordInboxResult(result)
    expect(show).toHaveBeenCalledOnce()
    expect(noticeCenter.list()).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps pending decisions visible without repeatedly replacing their record after OS delivery fails', async () => {
    show.mockRejectedValueOnce(new Error('OS delivery'))
    const result = {
      kind: 'post' as const,
      id: 'pending-channels',
      workerUrl: 'https://worker.example',
      libraryId: 'library',
      name: '待整理帖子',
      state: 'waiting_binding' as const,
    }
    await notifyWebDiscordInboxResult(result)
    const original = noticeCenter.list()[0]
    await notifyWebDiscordInboxResult(result)
    expect(noticeCenter.list()[0]).toBe(original)
    expect(original?.persistent).toBe(true)
    expect(original?.completed).toBe(false)
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('delivers a committed backup outcome once and routes warm and cold notification clicks to backup', async () => {
    await notifyWebCloudBackupResult('backup-committed', '已完成', true)
    await notifyWebCloudBackupResult('backup-committed', '已完成', true)
    expect(show).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledWith(
      '云备份完成',
      expect.objectContaining({ data: { srlBackup: true } }),
    )
    history.replaceState({}, '', '/?open-backup=1&keep=1')
    const open = vi.fn()
    window.addEventListener('srl:native-deep-link', open)
    const remove = installWebInboxNotificationNavigation()
    await Promise.resolve()
    expect(open.mock.calls[0]?.[0].detail).toEqual({ kind: 'backup' })
    expect(location.search).toBe('?keep=1')
    const listener = vi.mocked(navigator.serviceWorker.addEventListener).mock.calls[0]?.[1] as (
      event: MessageEvent,
    ) => void
    listener(new MessageEvent('message', { data: { type: 'srl:open-backup' } }))
    expect(open).toHaveBeenCalledTimes(2)
    remove()
    window.removeEventListener('srl:native-deep-link', open)
    expect(request).not.toHaveBeenCalled()
  })
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
