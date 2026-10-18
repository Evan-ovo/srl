/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({
  backHandler: undefined as (() => void) | undefined,
  urlOpenHandler: undefined as ((event: { url: string }) => void) | undefined,
  shortcutHandler: undefined as ((event: { action?: string }) => void) | undefined,
  shareHandlers: {} as Record<string, (event: unknown) => void>,
  minimizeApp: vi.fn(),
  takePending: vi.fn().mockResolvedValue({}),
  resumeDeferredDiscordImports: vi.fn().mockResolvedValue({ resumed: 0 }),
  shortcutListenerReady: Promise.resolve(),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, handler: (value?: { url: string }) => void) => {
      if (event === 'backButton') nativeMocks.backHandler = handler
      if (event === 'appUrlOpen') nativeMocks.urlOpenHandler = handler
      return Promise.resolve({ remove: vi.fn() })
    }),
    minimizeApp: nativeMocks.minimizeApp,
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => ({
    addListener: vi.fn(async (event: string, handler: (value: { action?: string }) => void) => {
      await nativeMocks.shortcutListenerReady
      if (event === 'shortcut') nativeMocks.shortcutHandler = handler
      else nativeMocks.shareHandlers[event] = handler as (value: unknown) => void
      return { remove: vi.fn() }
    }),
    takePending: nativeMocks.takePending,
    resumeDeferredDiscordImports: nativeMocks.resumeDeferredDiscordImports,
  }),
}))

import { createNativeResourceDeepLink, installNativeRuntime } from './NativeRuntime'
import { noticeCenter } from './NoticeCenter'

describe('NativeRuntime back handling', () => {
  it('updates existing source views after background posts are saved, without emitting a binding success', async () => {
    const changed = vi.fn()
    window.addEventListener('srl:community-sources-changed', changed)
    installNativeRuntime()
    try {
      await vi.waitFor(() =>
        expect(nativeMocks.shareHandlers.cloudInboxReady).toBeTypeOf('function'),
      )
      nativeMocks.shareHandlers.cloudInboxReady?.({ running: true })
      expect(changed).not.toHaveBeenCalled()
      nativeMocks.shareHandlers.cloudInboxReady?.({ running: true, postsSaved: true })
      expect(changed).toHaveBeenCalledOnce()
      expect(
        noticeCenter.list().some((notice) => notice.id.startsWith('discord-auto-binding:')),
      ).toBe(false)
    } finally {
      window.removeEventListener('srl:community-sources-changed', changed)
    }
  })
  it('briefly shows committed native binding results and updates pending sources', async () => {
    const changed = vi.fn()
    window.addEventListener('srl:community-sources-changed', changed)
    installNativeRuntime()
    await vi.waitFor(() =>
      expect(nativeMocks.shareHandlers.autoBindingsCommitted).toBeTypeOf('function'),
    )
    vi.useFakeTimers()
    try {
      nativeMocks.shareHandlers.autoBindingsCommitted?.({
        bindings: [
          {
            sourceId: 'native-post',
            resourceId: 'native-card',
            sourceTitle: '帖子 A',
            resourceName: '卡 A',
          },
        ],
      })
      expect(noticeCenter.list()).toContainEqual(
        expect.objectContaining({
          id: 'discord-auto-binding:native-post:native-card',
          message: '帖子“帖子 A”已绑定角色卡“卡 A”',
          persistent: false,
        }),
      )
      expect(changed).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(4999)
      expect(
        noticeCenter
          .list()
          .some((notice) => notice.id === 'discord-auto-binding:native-post:native-card'),
      ).toBe(true)
      vi.advanceTimersByTime(1)
      expect(
        noticeCenter
          .list()
          .some((notice) => notice.id === 'discord-auto-binding:native-post:native-card'),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
      window.removeEventListener('srl:community-sources-changed', changed)
      noticeCenter.dismiss('discord-auto-binding:native-post:native-card')
    }
  })
  it('opens the inbox from the native receive notification without exposing credentials', async () => {
    const opened = vi.fn()
    window.addEventListener('srl:native-deep-link', opened)
    try {
      await installNativeRuntime()
      nativeMocks.urlOpenHandler?.({ url: 'srl://inbox' })
      expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ kind: 'inbox' })
    } finally {
      window.removeEventListener('srl:native-deep-link', opened)
    }
  })
  beforeEach(() => {
    nativeMocks.backHandler = undefined
    nativeMocks.urlOpenHandler = undefined
    nativeMocks.shortcutHandler = undefined
    nativeMocks.shareHandlers = {}
    nativeMocks.minimizeApp.mockClear()
    nativeMocks.takePending.mockClear()
    nativeMocks.resumeDeferredDiscordImports.mockClear()
    nativeMocks.shortcutListenerReady = Promise.resolve()
  })

  it('lets the active UI consume Android back before browser history or minimize', () => {
    const listener = (event: KeyboardEvent) => event.preventDefault()
    document.addEventListener('keydown', listener)
    installNativeRuntime()

    nativeMocks.backHandler?.()

    expect(nativeMocks.minimizeApp).not.toHaveBeenCalled()
    document.removeEventListener('keydown', listener)
  })

  it('等待原生快捷方式监听就绪后再读取启动期间的待办', async () => {
    let releaseListener!: () => void
    nativeMocks.shortcutListenerReady = new Promise<void>((resolve) => {
      releaseListener = resolve
    })

    installNativeRuntime()
    await Promise.resolve()
    expect(nativeMocks.takePending).not.toHaveBeenCalled()

    releaseListener()
    await vi.waitFor(() => expect(nativeMocks.takePending).toHaveBeenCalledTimes(1))
  })

  it('收到下载完成回调后重新检查仍待导入的原生资源', async () => {
    installNativeRuntime()
    await vi.waitFor(() =>
      expect(nativeMocks.shareHandlers.discordDownloadCompleted).toBeTypeOf('function'),
    )
    await vi.waitFor(() =>
      expect(nativeMocks.resumeDeferredDiscordImports).toHaveBeenCalledTimes(1),
    )
    await Promise.resolve()
    nativeMocks.resumeDeferredDiscordImports.mockClear()

    nativeMocks.shareHandlers.discordDownloadCompleted?.({
      token: 'discord-url-11111111-1111-1111-1111-111111111111',
    })

    expect(nativeMocks.resumeDeferredDiscordImports).toHaveBeenCalledTimes(1)
  })
})

describe('NativeRuntime deep links', () => {
  it('routes each download notification by its own share token and rejects malformed tokens', () => {
    const received = vi.fn()
    window.addEventListener('srl:native-deep-link', received)
    installNativeRuntime()
    const first = 'discord-url-11111111-1111-1111-1111-111111111111'
    const second = 'discord-url-22222222-2222-2222-2222-222222222222'
    nativeMocks.urlOpenHandler?.({ url: `srl://shared-import/${first}` })
    nativeMocks.urlOpenHandler?.({ url: `srl://shared-import/${second}` })
    nativeMocks.urlOpenHandler?.({ url: 'srl://shared-import/../../secret' })
    expect(received.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([
      { kind: 'sharedImport', token: first },
      { kind: 'sharedImport', token: second },
    ])
    window.removeEventListener('srl:native-deep-link', received)
    sessionStorage.removeItem('srl.native.deep-link')
  })
  it('只为安全的资源编号生成不含内容和凭据的本机链接', () => {
    expect(createNativeResourceDeepLink('resource-01')).toBe('srl://resource/resource-01')
    expect(createNativeResourceDeepLink('../secret')).toBeNull()
  })

  it('把云备份通知深链路由到云备份功能页，而不是 ZIP 恢复面板', () => {
    sessionStorage.removeItem('srl.native.shortcut')
    sessionStorage.removeItem('srl.native.deep-link')
    const shortcut = vi.fn()
    const deepLink = vi.fn()
    window.addEventListener('srl:native-shortcut', shortcut)
    window.addEventListener('srl:native-deep-link', deepLink)
    installNativeRuntime()

    nativeMocks.urlOpenHandler?.({ url: 'srl://backup' })

    expect(shortcut).toHaveBeenCalledTimes(1)
    expect((shortcut.mock.calls[0]?.[0] as CustomEvent).detail).toBe('cloud')
    expect(deepLink).toHaveBeenCalledTimes(1)
    expect((deepLink.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ kind: 'backup' })
    window.removeEventListener('srl:native-shortcut', shortcut)
    window.removeEventListener('srl:native-deep-link', deepLink)
    sessionStorage.removeItem('srl.native.shortcut')
    sessionStorage.removeItem('srl.native.deep-link')
  })

  it('为需要选择恢复方式的备份通知发布独立恢复深链', () => {
    const deepLink = vi.fn()
    window.addEventListener('srl:native-deep-link', deepLink)
    installNativeRuntime()

    nativeMocks.urlOpenHandler?.({ url: 'srl://restore' })

    expect(deepLink).toHaveBeenCalledTimes(1)
    expect((deepLink.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ kind: 'restore' })
    window.removeEventListener('srl:native-deep-link', deepLink)
    sessionStorage.removeItem('srl.native.deep-link')
  })
})
