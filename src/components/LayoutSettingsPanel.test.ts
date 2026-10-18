/** @vitest-environment jsdom */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  android: false,
  checkUpdate: vi.fn(async () => 'APK 更新渠道尚未发布'),
  postMedia: false,
  save: vi.fn(),
  permission: 'default' as 'unsupported' | NotificationPermission,
  nativeGranted: false,
  requestNative: vi.fn(async () => {
    runtime.nativeGranted = true
    return true
  }),
  requestWeb: vi.fn(async () => {
    runtime.permission = 'granted'
    return 'granted' as const
  }),
  audioManual: false,
  audioTasks: 0,
  inboxStatus: 'off' as 'off' | 'starting' | 'running' | 'pausing' | 'paused',
  inboxListeners: new Set<() => void>(),
  startAudio: vi.fn(async () => {
    runtime.audioManual = true
    runtime.inboxStatus = 'running'
    runtime.inboxListeners.forEach((fn) => fn())
  }),
  stopAudio: vi.fn(async () => {
    runtime.audioManual = false
    runtime.inboxStatus = 'off'
    runtime.inboxListeners.forEach((fn) => fn())
  }),
}))
vi.mock('../services/WebBackgroundKeepAlive', () => ({
  webBackgroundAudioState: () => ({
    status: runtime.inboxStatus,
    message: '',
    manual: runtime.audioManual,
    tasks: runtime.audioTasks,
  }),
  subscribeWebBackgroundAudio: (listener: () => void) => {
    runtime.inboxListeners.add(listener)
    return () => runtime.inboxListeners.delete(listener)
  },
  startWebBackgroundAudio: runtime.startAudio,
  stopWebBackgroundAudio: runtime.stopAudio,
}))
vi.mock('../services/WebDiscordInboxNotifications', () => ({
  webInboxNotificationStatus: () => runtime.permission,
  enableWebInboxNotifications: runtime.requestWeb,
}))
vi.mock('../core/LibraryContainer', async () => ({
  browserStorageService: new (
    await import('../services/BrowserStorageService')
  ).BrowserStorageService(),
  discordInboxAutomationSettingsService: {
    load: async () => ({
      bindSameName: false,
      bindSameAuthor: false,
      bindNextPng: false,
      bindForeground: false,
      preferPngContainer: false,
      downloadPostMedia: runtime.postMedia,
    }),
    save: async (settings: { downloadPostMedia?: boolean }) => {
      runtime.save(settings)
      runtime.postMedia = settings.downloadPostMedia === true
    },
  },
}))
vi.mock('../core/PlatformService', () => ({
  platform: {
    update: { isAndroidApk: () => runtime.android, check: runtime.checkUpdate },
    security: {
      getState: async () =>
        runtime.android
          ? {
              notificationsGranted: runtime.nativeGranted,
              secureScreen: false,
              biometricAvailable: false,
            }
          : null,
      requestNotifications: runtime.requestNative,
    },
    backup: { getStatus: async () => null },
    systemUi: { getState: async () => null },
  },
}))
vi.mock('../storage/NativeResourceFileMirror', () => ({
  getNativeResourceStorageInfo: async () => null,
}))
vi.mock('../core/OfflineResources', () => ({
  getOfflineResourceStatus: async () => null,
  downloadFullOfflineResources: vi.fn(),
  removeFullOfflineResources: vi.fn(),
}))
vi.mock('../core/NativeHaptics', () => ({
  isNativeHapticsEnabled: () => false,
  setNativeHapticsEnabled: vi.fn(),
}))
vi.mock('../core/ServiceWorkerUpdate', () => ({
  forceRefresh: vi.fn(),
  manualCheckForUpdate: vi.fn(),
}))
vi.mock('./SecretProtectionSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./MainApiSettings.vue', () => ({ default: { template: '<div />' } }))
vi.mock('./ResourceHealthCenter.vue', () => ({ default: { template: '<div />' } }))

import LayoutSettingsPanel from './LayoutSettingsPanel.vue'

const wrappers: Array<ReturnType<typeof shallowMount>> = []
it('uses the APK update owner from the visible settings button', async () => {
  runtime.android = true
  const wrapper = mountSettings()
  await flushPromises()
  const button = wrapper
    .findAll('button')
    .find((item) => item.text().includes('检查 APK 版本更新'))!
  expect(button).toBeDefined()
  await button.trigger('click')
  await flushPromises()
  expect(runtime.checkUpdate).toHaveBeenCalledWith(true)
  expect(wrapper.text()).toContain('APK 更新渠道尚未发布')
})
it('places factory reset last in the scrollable settings sections before the footer', () => {
  const view = mountSettings()
  expect(view.get('.settings-sections > :last-child').element.tagName.toLowerCase()).toBe(
    'local-data-reset-controls-stub',
  )
  expect(view.find('.layout-settings__footer').exists()).toBe(true)
})
it('defaults post media downloads off and persists the choice when settings reopen', async () => {
  const first = mountSettings()
  await flushPromises()
  const checkbox = first
    .findAll('label')
    .find((node) => node.text().includes('保存帖子时下载素材图片'))!
    .get('input')
  expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  await checkbox.setValue(true)
  await flushPromises()
  expect(runtime.save).toHaveBeenCalledWith(expect.objectContaining({ downloadPostMedia: true }))
  const second = mountSettings()
  await flushPromises()
  expect(
    (
      second
        .findAll('label')
        .find((node) => node.text().includes('保存帖子时下载素材图片'))!
        .get('input').element as HTMLInputElement
    ).checked,
  ).toBe(true)
})
it('persists modified tag choice in system settings and restores it on reopen', async () => {
  const first = mountSettings()
  const checkbox = first
    .findAll('label')
    .find((node) => node.text().includes('修改版是否更改标签'))!
    .get('input')
  expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  await checkbox.setValue(true)
  const second = mountSettings()
  const reopened = second
    .findAll('label')
    .find((node) => node.text().includes('修改版是否更改标签'))!
    .get('input')
  expect((reopened.element as HTMLInputElement).checked).toBe(true)
  await reopened.setValue(false)
  expect(localStorage.getItem('srl.modifiedResource.syncTags')).toBe('false')
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  runtime.android = false
  runtime.postMedia = false
  runtime.save.mockClear()
  runtime.inboxStatus = 'off'
  runtime.audioManual = false
  runtime.audioTasks = 0
  runtime.permission = 'default'
  runtime.nativeGranted = false
  vi.clearAllMocks()
  localStorage.clear()
})

function mountSettings() {
  const wrapper = shallowMount(LayoutSettingsPanel, {
    props: {
      vaultEnabled: false,
      allowRemotePreviews: true,
      allowScriptPreviews: false,
      preloadGreetingPreviews: true,
      preloadBeautificationPreviews: true,
      extractCharacterAssets: false,
      hideCharacterAssets: false,
      hideChatDisplayRegex: true,
      showManuallyBoundResources: true,
      blurThumbnails: false,
      autoDownloadDiscordShareLinks: false,
      persistResourceVersionMatchCache: true,
      skipVersionComparisonOnImport: false,
      showPerformanceMonitor: false,
      hiddenCharacterAssetCount: 0,
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

describe('background audio and unified notification settings', () => {
  it('shows temporary task audio separately and lets the user promote it to manual retention', async () => {
    runtime.inboxStatus = 'running'
    runtime.audioTasks = 1
    const wrapper = mountSettings()
    const toggle = wrapper.get('input[aria-label="后台音频保活"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('本次任务保活中，结束后自动关闭')
    await toggle.setValue(true)
    expect(runtime.startAudio).toHaveBeenCalledOnce()
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
  })
  it('uses one audio toggle and retains its running state when settings reopen', async () => {
    const first = mountSettings()
    const toggle = first.get('input[aria-label="后台音频保活"]')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    await toggle.setValue(true)
    await flushPromises()
    expect(runtime.startAudio).toHaveBeenCalledExactlyOnceWith()
    first.unmount()
    const second = mountSettings()
    const reopened = second.get('input[aria-label="后台音频保活"]')
    expect((reopened.element as HTMLInputElement).checked).toBe(true)
    expect(runtime.stopAudio).not.toHaveBeenCalled()
    await reopened.setValue(false)
    expect(runtime.stopAudio).toHaveBeenCalledOnce()
    expect((reopened.element as HTMLInputElement).checked).toBe(false)
    expect(second.text()).not.toContain('画中画')
    expect(second.text()).not.toContain('心跳')
  })
  it('requests web permission only after clicking, then displays already authorized', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    const button = wrapper.get('button[aria-label="系统通知"]')
    expect(runtime.requestWeb).not.toHaveBeenCalled()
    await button.trigger('click')
    await flushPromises()
    expect(runtime.requestWeb).toHaveBeenCalledOnce()
    expect(button.text()).toContain('已授权')
    expect(button.attributes('disabled')).toBeDefined()
    const reopened = mountSettings().get('button[aria-label="系统通知"]')
    expect(reopened.text()).toContain('已授权')
    expect(runtime.requestWeb).toHaveBeenCalledOnce()
  })
  it('keeps an authorized web permission visible without requesting again', () => {
    runtime.permission = 'granted'
    const wrapper = mountSettings()
    expect(wrapper.get('button[aria-label="系统通知"]').text()).toContain('已授权')
    expect(runtime.requestWeb).not.toHaveBeenCalled()
  })
  it('uses the existing native permission owner and hides the web audio toggle in APK', async () => {
    runtime.android = true
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.find('input[aria-label="后台音频保活"]').exists()).toBe(false)
    const button = wrapper.get('button[aria-label="系统通知"]')
    await button.trigger('click')
    await flushPromises()
    expect(runtime.requestNative).toHaveBeenCalledOnce()
    expect(runtime.requestWeb).not.toHaveBeenCalled()
    expect(button.text()).toContain('已授权')
    expect(wrapper.text()).not.toContain('允许系统任务通知')
  })
  it('explains denied and unavailable permissions instead of claiming authorization', () => {
    runtime.permission = 'denied'
    const denied = mountSettings()
    expect(denied.get('button[aria-label="系统通知"]').text()).not.toContain('已授权')
    runtime.permission = 'unsupported'
    const unsupported = mountSettings()
    expect(unsupported.get('button[aria-label="系统通知"]').attributes('disabled')).toBeDefined()
    expect(unsupported.get('button[aria-label="系统通知"]').text()).toContain('不支持')
    expect(unsupported.text()).not.toContain('各功能需单独开启')
  })
})

describe('LayoutSettingsPanel platform-specific preview options', () => {
  it('多线路开关在网页也可见，确认前保持实际关闭状态', async () => {
    const wrapper = mountSettings()
    const label = wrapper.findAll('label').find((item) => item.text().includes('增加多线路下载'))!
    const input = label.find<HTMLInputElement>('input')
    expect(input.element.checked).toBe(false)
    await input.setValue(true)
    expect(wrapper.emitted('update:increasePreviewDownloads')).toEqual([[true]])
    expect(input.element.checked).toBe(false)
    await wrapper.setProps({ increasePreviewDownloads: true })
    expect(input.element.checked).toBe(true)
  })
  it('exposes the same-name candidate switch without enabling it by default', async () => {
    const wrapper = mountSettings()
    const label = wrapper
      .findAll('label')
      .find((node) => node.text().includes('同名资源默认识别为版本候选'))!
    const checkbox = label.get('input[type="checkbox"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
    await checkbox.setValue(true)
    expect(wrapper.emitted('update:sameNameVersionCandidates')?.[0]).toEqual([true])
  })
  it('exposes the global PNG wrapper preference', async () => {
    const wrapper = mountSettings()
    const label = wrapper
      .findAll('label')
      .find((node) => node.text().includes('同内容角色卡优先使用 PNG 封装'))!
    expect((label.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  })
  it('keeps remote-resource permission but hides Android-only cache switches on Web/PWA', () => {
    runtime.android = false
    const wrapper = mountSettings()
    expect(wrapper.text()).toContain('允许远程资源')
    expect(wrapper.text()).not.toContain('开场白：Android 后台缓存')
    expect(wrapper.text()).not.toContain('美化：Android 后台缓存')
  })

  it('shows both background-cache switches in Android APK', () => {
    runtime.android = true
    const wrapper = mountSettings()
    expect(wrapper.text()).toContain('开场白：Android 后台缓存')
    expect(wrapper.text()).toContain('美化：Android 后台缓存')
    expect(wrapper.text()).toContain('DC 分享直链默认下载')
  })

  it('hides the Discord direct-link option outside Android APK', () => {
    runtime.android = false
    const wrapper = mountSettings()
    expect(wrapper.text()).not.toContain('DC 分享直链默认下载')
  })
})
