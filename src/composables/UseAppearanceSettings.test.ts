/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewPolicy } from '../services/BrowserStorageService'
import type { CustomUiViews } from '../types/UiCustomization'
import type { CustomCssPreset } from '../types/BrowserPreferences'
import { createUiView, normalizeUiViews } from '../core/UiCustomization'
import { appearanceTransaction } from '../core/AppearanceSafety'

let policy: PreviewPolicy = { allowRemoteResources: false, allowScripts: false }
let views: CustomUiViews = {}
let activePresetId = 'previous'

const storage = {
  getLayoutMode: vi.fn(() => 'grid' as const),
  getMobileCardOrientation: vi.fn(() => 'mixed' as const),
  setMobileCardOrientation: vi.fn((value: 'mixed' | 'portrait' | 'landscape') => value),
  getMobileCardFitMode: vi.fn(() => 'contain' as const),
  setMobileCardFitMode: vi.fn((value: 'contain' | 'cover') => value),
  getResourceCardHeightMode: vi.fn(() => 'natural' as const),
  setResourceCardHeightMode: vi.fn((value: 'natural' | 'uniform') => value),
  getNoImageResourceCoverMode: vi.fn(() => 'cover' as const),
  setNoImageResourceCoverMode: vi.fn((value: 'cover' | 'character-only') => value),
  getUiFontScale: vi.fn(() => 'standard' as const),
  getPreviewPolicy: vi.fn(() => policy),
  setPreviewPolicy: vi.fn((next: PreviewPolicy) => {
    policy = next
    return next
  }),
  getCustomUiCss: vi.fn(() => ''),
  getCustomUiViews: vi.fn(() => normalizeUiViews(views)),
  setCustomUiViews: vi.fn((value: CustomUiViews) => {
    views = normalizeUiViews(value)
  }),
  getCustomUiPresets: vi.fn((): CustomCssPreset[] => []),
  getActiveCustomUiPresetId: vi.fn(() => activePresetId),
  setActiveCustomUiPresetId: vi.fn((value: string) => {
    activePresetId = value
  }),
  setCustomUiCss: vi.fn(),
  getExtractCharacterAssets: vi.fn(() => false),
  setExtractCharacterAssets: vi.fn(),
  getShowManuallyBoundResources: vi.fn(() => true),
  getHideCharacterAssets: vi.fn(() => false),
  getHideChatDisplayRegex: vi.fn(() => true),
  getBlurThumbnails: vi.fn(() => true),
  setBlurThumbnails: vi.fn(),
  getAutoDownloadDiscordShareLinks: vi.fn(() => false),
  setAutoDownloadDiscordShareLinks: vi.fn(),
  getPersistResourceVersionMatchCache: vi.fn(() => false),
  setPersistResourceVersionMatchCache: vi.fn(),
  getSkipVersionComparisonOnImport: vi.fn(() => false),
  getSameNameVersionCandidates: vi.fn(() => false),
  setSameNameVersionCandidates: vi.fn(),
  setSkipVersionComparisonOnImport: vi.fn(),
  setLayoutMode: vi.fn(),
  setUiFontScale: vi.fn((value: 'small' | 'standard' | 'large') => value),
}

vi.mock('../core/AppContainer', () => ({ browserStorageService: storage }))

const confirmMock = vi.fn(async () => true)
vi.mock('./UseConfirmDialog', () => ({ confirmAction: confirmMock }))
const configureDownloads = vi.fn(async () => true)
vi.mock('../services/NativePreviewAsset', () => ({
  configureNativePreviewDownloadConcurrency: configureDownloads,
}))

const { useAppearanceSettings } = await import('./UseAppearanceSettings')

describe('useAppearanceSettings', () => {
  let notices: string[]

  it('存储不足以记录恢复信息时不开始试用，也不覆盖当前界面', () => {
    const appearance = create()
    const previous = appearance.customUiCss.value
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('本机存储已满', 'QuotaExceededError')
    })
    try {
      appearance.saveCustomUiCss('.example{color:red}')
      expect(appearance.customUiCss.value).toBe(previous)
      expect(storage.setCustomUiCss).not.toHaveBeenCalled()
      expect(notices.some((notice) => notice.includes('外观试用未开始'))).toBe(true)
    } finally {
      set.mockRestore()
    }
  })

  beforeEach(() => {
    document
      .getElementById('srl-appearance-safe-layer')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-rollback]')
      ?.click()
    vi.clearAllMocks()
    policy = { allowRemoteResources: false, allowScripts: false }
    views = {}
    activePresetId = 'previous'
    storage.getCustomUiPresets.mockReturnValue([])
    notices = []
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-scale')
    localStorage.clear()
  })

  const create = () => useAppearanceSettings((message) => notices.push(message))
  it.each(['vue', 'default'] as const)(
    '快捷恢复%s取消未确认试用且不会迟到重新启用，预设/源码保持',
    (mode) => {
      vi.useFakeTimers()
      try {
        const view = { ...createUiView(), enabled: true }
        const preset = {
          id: 'saved',
          name: '预设',
          globalCss: '.saved{}',
          scopedCss: {},
          views: { shell: view },
          createdAt: '',
          updatedAt: '',
        }
        storage.getCustomUiPresets.mockReturnValue([preset])
        views = { shell: view }
        const appearance = create()
        appearance.saveCustomUiCss('.trial{}', {
          views: {
            shell: {
              ...view,
              files: [{ path: 'View.vue', contents: '<template>试用源码</template>' }],
            },
          },
          presetId: 'saved',
        })
        storage.getCustomUiCss.mockReturnValueOnce('.trial{}')
        appearance.saveCustomUiCss('.trial{}', { recovery: mode })
        expect(appearance.customUiCss.value).toBe(mode === 'default' ? '' : '.trial{}')
        expect(views.shell?.enabled).toBe(false)
        expect(views.shell?.files[0]?.contents).toContain('试用源码')
        expect(activePresetId).toBe(mode === 'default' ? '' : 'saved')
        vi.advanceTimersByTime(16000)
        expect(views.shell?.enabled).toBe(false)
        expect(storage.getCustomUiPresets()).toEqual([preset])
      } finally {
        vi.useRealTimers()
      }
    },
  )
  it('applies a saved preset immediately, and restores both CSS and selection on rollback', () => {
    const preset = {
      id: 'plaza',
      name: '粉樱',
      globalCss: ':root { --color-accent: pink; }',
      scopedCss: {},
      createdAt: '',
      updatedAt: '',
    }
    storage.getCustomUiPresets.mockReturnValue([preset])
    const appearance = create()
    appearance.saveCustomUiCss(preset.globalCss, { presetId: preset.id })
    expect(activePresetId).toBe(preset.id)
    expect(appearance.customUiCss.value).toBe(preset.globalCss)
    expect(document.getElementById('srl-custom-ui-style')!.textContent).toContain('pink')
    expect(storage.setCustomUiViews).not.toHaveBeenCalled()
    appearanceTransaction.rollback()
    expect(activePresetId).toBe('previous')
    expect(appearance.customUiCss.value).toBe('')
    expect(storage.getCustomUiPresets()).toEqual([preset])
  })
  it('keeps an explicitly chosen preset after confirmation and refuses a missing preset', () => {
    const preset = {
      id: 'plaza',
      name: '粉樱',
      globalCss: 'body { color: pink; }',
      scopedCss: {},
      createdAt: '',
      updatedAt: '',
    }
    storage.getCustomUiPresets.mockReturnValue([preset])
    const appearance = create()
    appearance.saveCustomUiCss(preset.globalCss, { presetId: preset.id })
    appearanceTransaction.keep()
    expect(activePresetId).toBe(preset.id)
    appearance.saveCustomUiCss('body{}', { presetId: 'missing' })
    expect(appearance.customUiCss.value).toBe(preset.globalCss)
    expect(activePresetId).toBe(preset.id)
    expect(notices).toContain('外观预设已不存在，请重新选择')
  })
  it('AI的Vue变化采用原15秒试用；CSS不变也能试用，未保留会恢复其它APP', () => {
    vi.useFakeTimers()
    const before = { ...createUiView(), enabled: true }
    views = { cabinet: before }
    const appearance = create()
    const next = { ...createUiView(), enabled: true }
    appearance.saveCustomUiCss('', { assistant: true, views: { cabinet: before, library: next } })
    expect(views.library?.enabled).toBe(true)
    expect(appearanceTransaction.hasPendingViewTrial()).toBe(true)
    const calls = storage.setCustomUiCss.mock.calls.length
    appearance.saveCustomUiCss('.new{color:red}', { assistant: true })
    expect(storage.setCustomUiCss).toHaveBeenCalledTimes(calls)
    expect(notices.at(-1)).toContain('保留或恢复')
    vi.advanceTimersByTime(15_001)
    expect(views.library).toBeUndefined()
    expect(views.cabinet).toEqual(before)
    expect(appearanceTransaction.hasPendingViewTrial()).toBe(false)
    vi.useRealTimers()
  })

  it('增加多线路必须先确认，取消不保存也不调整原生队列', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const appearance = create()
    await appearance.applyIncreasedPreviewDownloads(true)
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '增加多线路下载',
        confirmLabel: '确定',
        cancelLabel: '取消',
      }),
    )
    expect(storage.setPreviewPolicy).not.toHaveBeenCalled()
    expect(configureDownloads).not.toHaveBeenCalled()
    expect(appearance.previewPolicy.value.increaseDownloadConcurrency).not.toBe(true)
  })

  it('确认后保存并调整队列，关闭不再询问；其它预览开关保留该档位', async () => {
    const appearance = create()
    await appearance.applyIncreasedPreviewDownloads(true)
    expect(appearance.previewPolicy.value.increaseDownloadConcurrency).toBe(true)
    expect(configureDownloads).toHaveBeenLastCalledWith(true)
    appearance.applyRemotePreviewPolicy(true)
    expect(appearance.previewPolicy.value.increaseDownloadConcurrency).toBe(true)
    await appearance.applyScriptPreviewPolicy(false)
    expect(appearance.previewPolicy.value.increaseDownloadConcurrency).toBe(true)
    confirmMock.mockClear()
    await appearance.applyIncreasedPreviewDownloads(false)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(configureDownloads).toHaveBeenLastCalledWith(false)
    expect(appearance.previewPolicy.value.increaseDownloadConcurrency).toBe(false)
  })

  it('确认尚未完成时不会提前保存，多次点击不重复排队确认', async () => {
    let finish!: (value: boolean) => void
    confirmMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const appearance = create()
    const pending = appearance.applyIncreasedPreviewDownloads(true)
    await appearance.applyIncreasedPreviewDownloads(true)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(storage.setPreviewPolicy).not.toHaveBeenCalled()
    finish(true)
    await pending
    expect(storage.setPreviewPolicy).toHaveBeenCalledTimes(1)
  })

  it('应用主题会同时写入文档属性与本地存储', () => {
    const appearance = create()
    appearance.applyTheme('dark')
    expect(appearance.theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('srl-theme')).toBe('dark')
  })

  it('字体大小只接受受控档位并同步到文档属性', () => {
    const appearance = create()
    appearance.applyUiFontScale('large')

    expect(appearance.uiFontScale.value).toBe('large')
    expect(document.documentElement.dataset.fontScale).toBe('large')
    expect(storage.setUiFontScale).toHaveBeenCalledWith('large')
  })

  it('自定义 CSS 保存后注入同一个 style 节点，不重复创建', () => {
    const appearance = create()
    appearance.saveCustomUiCss('.a { color: red }')
    appearance.saveCustomUiCss('.b { color: blue }')
    expect(document.querySelectorAll('#srl-custom-ui-style')).toHaveLength(1)
    expect(document.getElementById('srl-custom-ui-style')?.textContent).toContain('.b')
    expect(notices).toEqual([
      '自定义 CSS 已临时应用，请在 15 秒内选择“保留更改”',
      '未确认更改，已自动恢复上一版 CSS',
      '自定义 CSS 已临时应用，请在 15 秒内选择“保留更改”',
    ])
  })

  it('清空自定义 CSS 给出不同提示', () => {
    const appearance = create()
    appearance.saveCustomUiCss('')
    expect(notices).toEqual(['自定义 CSS 已清除'])
  })

  it('超过20万字符的外观CSS完整应用并在确认后保存末尾规则', () => {
    const appearance = create()
    const css = `/*${'a'.repeat(250_000)}*/\n.tail { color: #123456; }`
    appearance.saveCustomUiCss(css)
    expect(appearance.customUiCss.value).toBe(css)
    expect(document.getElementById('srl-custom-ui-style')?.textContent).toBe(css)
    document
      .getElementById('srl-appearance-safe-layer')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-keep]')
      ?.click()
    expect(storage.setCustomUiCss).toHaveBeenCalledWith(css)
  })

  it('关闭远程资源开关会连同脚本一起关闭', () => {
    const appearance = create()
    appearance.applyRemotePreviewPolicy(false)
    expect(storage.setPreviewPolicy).toHaveBeenCalledWith({
      allowRemoteResources: false,
      allowScripts: false,
    })
  })

  it('用户在二次确认中取消时不得开启脚本预览', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const appearance = create()
    const keyBefore = appearance.settingsPanelKey.value

    await appearance.applyScriptPreviewPolicy(true)

    expect(confirmMock).toHaveBeenCalledOnce()
    expect(storage.setPreviewPolicy).not.toHaveBeenCalled()
    expect(appearance.previewPolicy.value.allowScripts).toBe(false)
    // 面板需要重建，让被点开的开关回到实际状态
    expect(appearance.settingsPanelKey.value).toBe(keyBefore + 1)
  })

  it('确认后开启脚本预览并连带放行远程资源', async () => {
    confirmMock.mockResolvedValueOnce(true)
    const appearance = create()
    await appearance.applyScriptPreviewPolicy(true)
    expect(storage.setPreviewPolicy).toHaveBeenCalledWith({
      allowRemoteResources: true,
      allowScripts: true,
    })
  })

  it('关闭脚本预览不需要二次确认', async () => {
    const appearance = create()
    await appearance.applyScriptPreviewPolicy(false)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(storage.setPreviewPolicy).toHaveBeenCalledWith({
      allowRemoteResources: false,
      allowScripts: false,
    })
  })

  it('恢复便携配置后重新读取全部外观设置', () => {
    const appearance = create()
    storage.getLayoutMode.mockReturnValue('list' as never)
    storage.getUiFontScale.mockReturnValue('small' as never)
    localStorage.setItem('srl-theme', 'dark')

    appearance.reloadAppearanceSettings()
    expect(configureDownloads).toHaveBeenLastCalledWith(false)

    expect(appearance.theme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(appearance.layoutMode.value).toBe('list')
    expect(appearance.uiFontScale.value).toBe('small')
    expect(document.documentElement.dataset.fontScale).toBe('small')
  })
})
