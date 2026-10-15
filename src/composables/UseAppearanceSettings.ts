import { onMounted, onUnmounted, ref } from 'vue'
import {
  APPLIED_CSS_CHANGED_EVENT,
  SCOPED_CSS_REMOVED_EVENT,
  upgradeLegacyAppearanceCss,
} from '../core/AppearanceScopes'

import { browserStorageService } from '../core/AppContainer'
import { appearanceTransaction, recoverInterruptedAppearance } from '../core/AppearanceSafety'
import { isSafeModeActive } from '../core/SafeStartup'
import type {
  LayoutMode,
  MobileCardOrientation,
  MobileCardFitMode,
  ResourceCardHeightMode,
  NoImageResourceCoverMode,
  PreviewPolicy,
  UiFontScale,
} from '../services/BrowserStorageService'
import { sanitizeCssForPreview } from '../utils/PreviewSafety'
import { normalizeUiViews, resolveUiCssAssets } from '../core/UiCustomization'
import { CUSTOM_UI_VIEWS_CHANGED } from '../types/UiCustomization'
import type { UiApplyOptions } from '../types/UiCustomization'
import { confirmAction } from './UseConfirmDialog'
import { configureNativePreviewDownloadConcurrency } from '../services/NativePreviewAsset'
import { readStoredTheme, writeStoredTheme, type ThemeValue } from '../utils/LibraryFormatting'

import { CUSTOM_UI_STYLE_ID } from '../services/BrowserAppearancePreferences'
const SCRIPT_PREVIEW_CONFIRM =
  '开启后，导入资源中的完整 JavaScript（包括内联、远程脚本和动态代码）会在隔离 iframe 中运行，并可加载远程图片、音频、字体及发起联网请求。\n\n脚本仍不能读取资源库、IndexedDB、登录信息或主页面，但可能暴露 IP、诱导跳转、持续占用 CPU 或导致当前页面卡顿。只应预览你信任来源的文件。'

/**
 * 外观与预览安全策略。
 *
 * 承载主题、资源排版、自定义 CSS、预览安全开关与角色卡配套资源偏好，
 * 这些设置只依赖 BrowserStorageService 与文档对象，与资源库数据流无关。
 */
export function useAppearanceSettings(showNotice: (message: string) => void) {
  const recoveredCss = recoverInterruptedAppearance()
  if (recoveredCss !== undefined) browserStorageService.setCustomUiCss(recoveredCss)
  const safeMode = isSafeModeActive()
  const theme = ref<ThemeValue>(readStoredTheme())
  const layoutMode = ref<LayoutMode>(browserStorageService.getLayoutMode())
  const mobileCardOrientation = ref(browserStorageService.getMobileCardOrientation())
  document.documentElement.dataset.mobileCardOrientation = mobileCardOrientation.value
  const mobileCardFitMode = ref(browserStorageService.getMobileCardFitMode())
  document.documentElement.dataset.mobileCardFitMode = mobileCardFitMode.value
  const resourceCardHeightMode = ref(browserStorageService.getResourceCardHeightMode())
  document.documentElement.dataset.resourceCardHeight = resourceCardHeightMode.value
  const noImageResourceCoverMode = ref(browserStorageService.getNoImageResourceCoverMode())
  document.documentElement.dataset.noImageResourceCover = noImageResourceCoverMode.value
  const uiFontScale = ref<UiFontScale>(browserStorageService.getUiFontScale())
  const storedPreviewPolicy = browserStorageService.getPreviewPolicy()
  const previewPolicy = ref<PreviewPolicy>(
    safeMode
      ? {
          allowRemoteResources: false,
          allowScripts: false,
          preloadGreetingResources: false,
          preloadBeautificationResources: false,
          increaseDownloadConcurrency: false,
        }
      : storedPreviewPolicy,
  )
  const customUiCss = ref(safeMode ? '' : browserStorageService.getCustomUiCss())
  const handleScopedCssRemoval = (event: Event) => {
    const css = (event as CustomEvent<string>).detail
    if (typeof css !== 'string') return
    appearanceTransaction.clear(
      css,
      (value) => {
        customUiCss.value = isSafeModeActive() ? '' : value
        syncCustomUiCss()
      },
      (value) => browserStorageService.setCustomUiCss(value),
    )
  }
  onMounted(() => window.addEventListener(SCOPED_CSS_REMOVED_EVENT, handleScopedCssRemoval))
  onUnmounted(() => window.removeEventListener(SCOPED_CSS_REMOVED_EVENT, handleScopedCssRemoval))
  const extractCharacterAssets = ref(browserStorageService.getExtractCharacterAssets())
  const showManuallyBoundResources = ref(browserStorageService.getShowManuallyBoundResources())
  const hideChatDisplayRegex = ref(browserStorageService.getHideChatDisplayRegex())
  const hideCharacterAssets = ref(browserStorageService.getHideCharacterAssets())
  const blurThumbnails = ref(browserStorageService.getBlurThumbnails())
  const autoDownloadDiscordShareLinks = ref(
    browserStorageService.getAutoDownloadDiscordShareLinks(),
  )
  const persistResourceVersionMatchCache = ref(
    browserStorageService.getPersistResourceVersionMatchCache(),
  )
  const skipVersionComparisonOnImport = ref(
    browserStorageService.getSkipVersionComparisonOnImport(),
  )
  const sameNameVersionCandidates = ref(browserStorageService.getSameNameVersionCandidates())
  // 设置面板使用受控开关，取消确认后需要重建面板才能让开关回到实际状态。
  const settingsPanelKey = ref(0)

  function applyTheme(value: ThemeValue): void {
    theme.value = value
    document.documentElement.dataset.theme = value
    writeStoredTheme(value)
  }

  function applyLayoutMode(value: LayoutMode): void {
    layoutMode.value = value
    browserStorageService.setLayoutMode(value)
  }

  function applyMobileCardOrientation(value: MobileCardOrientation): void {
    mobileCardOrientation.value = browserStorageService.setMobileCardOrientation(value)
    document.documentElement.dataset.mobileCardOrientation = mobileCardOrientation.value
  }

  function applyAutoDownloadDiscordShareLinks(enabled: boolean): void {
    autoDownloadDiscordShareLinks.value = enabled
    browserStorageService.setAutoDownloadDiscordShareLinks(enabled)
  }

  function applyPersistResourceVersionMatchCache(enabled: boolean): void {
    persistResourceVersionMatchCache.value = enabled
    browserStorageService.setPersistResourceVersionMatchCache(enabled)
  }

  function applySkipVersionComparisonOnImport(enabled: boolean): void {
    skipVersionComparisonOnImport.value = enabled
    browserStorageService.setSkipVersionComparisonOnImport(enabled)
  }

  function applySameNameVersionCandidates(enabled: boolean): void {
    sameNameVersionCandidates.value = enabled
    browserStorageService.setSameNameVersionCandidates(enabled)
  }

  function applyMobileCardFitMode(value: MobileCardFitMode): void {
    mobileCardFitMode.value = browserStorageService.setMobileCardFitMode(value)
    document.documentElement.dataset.mobileCardFitMode = mobileCardFitMode.value
  }

  function applyResourceCardHeightMode(value: ResourceCardHeightMode): void {
    resourceCardHeightMode.value = browserStorageService.setResourceCardHeightMode(value)
    document.documentElement.dataset.resourceCardHeight = resourceCardHeightMode.value
  }

  function applyNoImageResourceCoverMode(value: NoImageResourceCoverMode): void {
    noImageResourceCoverMode.value = browserStorageService.setNoImageResourceCoverMode(value)
    document.documentElement.dataset.noImageResourceCover = noImageResourceCoverMode.value
  }

  function applyUiFontScale(value: UiFontScale): void {
    uiFontScale.value = browserStorageService.setUiFontScale(value)
    document.documentElement.dataset.fontScale = uiFontScale.value
  }

  function syncCustomUiCss(): void {
    let style = document.getElementById(CUSTOM_UI_STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = CUSTOM_UI_STYLE_ID
      document.head.append(style)
    }
    const source = sanitizeCssForPreview(
      isSafeModeActive()
        ? ''
        : upgradeLegacyAppearanceCss(customUiCss.value, browserStorageService.getCustomUiPresets()),
      {
        allowExternalResources: previewPolicy.value.allowRemoteResources,
        allowLocalResources: true,
        preserveLength: true,
      },
    )
    style.textContent = resolveUiCssAssets(source, browserStorageService.getCustomUiViews?.() ?? {})
    document.head.append(style)
    window.dispatchEvent(new Event(APPLIED_CSS_CHANGED_EVENT))
  }
  onMounted(() => window.addEventListener(CUSTOM_UI_VIEWS_CHANGED, syncCustomUiCss))
  onUnmounted(() => window.removeEventListener(CUSTOM_UI_VIEWS_CHANGED, syncCustomUiCss))

  function saveCustomUiCss(value: string, options?: UiApplyOptions): void {
    if (options?.recovery) {
      const css = options.recovery === 'default' ? '' : browserStorageService.getCustomUiCss()
      const presetId =
        options.recovery === 'default' ? '' : browserStorageService.getActiveCustomUiPresetId()
      const disabled = normalizeUiViews(browserStorageService.getCustomUiViews())
      for (const view of Object.values(disabled)) if (view) view.enabled = false
      try {
        appearanceTransaction.clear(
          css,
          (next) => {
            customUiCss.value = next
            syncCustomUiCss()
          },
          (next) => browserStorageService.setCustomUiCss(next),
        )
        browserStorageService.setCustomUiViews(disabled)
        browserStorageService.setActiveCustomUiPresetId(presetId)
        showNotice(
          options.recovery === 'default'
            ? '已恢复默认预设，预设库与源码保留'
            : 'Vue已关闭，当前CSS与预设库保留',
        )
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '外观恢复失败，请检查本机存储空间')
      }
      return
    }
    const nextCss = value
    if (
      isSafeModeActive() &&
      (nextCss || Object.values(options?.views ?? {}).some((view) => view?.enabled))
    ) {
      showNotice('当前处于安全模式；恢复正常启动后才能应用自定义 CSS')
      return
    }
    if (options?.assistant && appearanceTransaction.hasPendingViewTrial()) {
      showNotice('请先保留或恢复当前Vue试用，再继续修改外观')
      return
    }
    if (options?.assistant) appearanceTransaction.keep()
    if (options?.views !== undefined || options?.presetId) appearanceTransaction.rollback()
    if (
      options?.presetId &&
      !browserStorageService.getCustomUiPresets().some((preset) => preset.id === options.presetId)
    ) {
      showNotice('外观预设已不存在，请重新选择')
      return
    }
    const previousPresetId = options?.presetId
      ? browserStorageService.getActiveCustomUiPresetId()
      : undefined
    const previousCss = browserStorageService.getCustomUiCss()
    const previousViews =
      options?.views === undefined ? {} : browserStorageService.getCustomUiViews()
    const nextViews = options?.views === undefined ? undefined : normalizeUiViews(options.views)
    const viewsChanged =
      nextViews !== undefined && JSON.stringify(nextViews) !== JSON.stringify(previousViews)
    const apply = (css: string) => {
      customUiCss.value = css
      syncCustomUiCss()
    }
    const persist = (css: string) => browserStorageService.setCustomUiCss(css)
    if ((!nextCss || nextCss === previousCss) && !viewsChanged) {
      appearanceTransaction.clear(nextCss, apply, persist)
      if (options?.presetId) browserStorageService.setActiveCustomUiPresetId(options.presetId)
      showNotice(nextCss ? '自定义 CSS 未发生变化' : '自定义 CSS 已清除')
      return
    }
    try {
      appearanceTransaction.begin({
        previousCss,
        nextCss,
        apply,
        persist,
        autoKeep: options?.assistant === true && !viewsChanged,
        ...(viewsChanged
          ? { previousViews: JSON.stringify(previousViews), title: '自定义界面与样式已临时应用' }
          : {}),
        onKeep: () => showNotice(options?.assistant ? 'AI 美化已保留' : '自定义 CSS 已确认保留'),
        onRollback: () => {
          if (previousPresetId !== undefined)
            browserStorageService.setActiveCustomUiPresetId(previousPresetId)
          if (viewsChanged) browserStorageService.setCustomUiViews(previousViews)
          showNotice(
            viewsChanged
              ? '已恢复修改前的界面与样式'
              : options?.assistant
                ? '已恢复 AI 修改前的 CSS'
                : '未确认更改，已自动恢复上一版 CSS',
          )
        },
      })
      if (options?.presetId) browserStorageService.setActiveCustomUiPresetId(options.presetId)
    } catch (error) {
      showNotice(
        error instanceof Error
          ? `外观试用未开始：${error.message}`
          : '外观试用未开始，请检查本机空间',
      )
      return
    }
    if (viewsChanged) {
      try {
        browserStorageService.setCustomUiViews(nextViews!)
      } catch (error) {
        appearanceTransaction.rollback()
        showNotice(error instanceof Error ? error.message : '界面源码保存失败，已恢复原界面')
        return
      }
    }
    showNotice(
      options?.assistant && !viewsChanged
        ? 'AI 美化已应用，可通过对话撤销'
        : viewsChanged
          ? 'Vue已临时应用，请在15秒内选择“保留更改”'
          : '自定义 CSS 已临时应用，请在 15 秒内选择“保留更改”',
    )
  }

  function applyRemotePreviewPolicy(enabled: boolean): void {
    previewPolicy.value = browserStorageService.setPreviewPolicy({
      ...previewPolicy.value,
      allowRemoteResources: enabled,
      allowScripts: false,
      preloadGreetingResources: previewPolicy.value.preloadGreetingResources,
      preloadBeautificationResources: previewPolicy.value.preloadBeautificationResources,
    })
    syncCustomUiCss()
  }

  async function applyScriptPreviewPolicy(enabled: boolean): Promise<void> {
    if (enabled && isSafeModeActive()) {
      showNotice('安全模式下不能开启脚本预览')
      settingsPanelKey.value += 1
      return
    }
    if (
      enabled &&
      !(await confirmAction({
        title: '高风险预览确认',
        message: SCRIPT_PREVIEW_CONFIRM,
        confirmLabel: '开启脚本预览',
        danger: true,
      }))
    ) {
      settingsPanelKey.value += 1
      return
    }
    previewPolicy.value = browserStorageService.setPreviewPolicy({
      ...previewPolicy.value,
      allowRemoteResources: enabled || previewPolicy.value.allowRemoteResources,
      allowScripts: enabled,
      preloadGreetingResources: previewPolicy.value.preloadGreetingResources,
      preloadBeautificationResources: previewPolicy.value.preloadBeautificationResources,
    })
    syncCustomUiCss()
  }

  function applyGreetingPreviewPreload(enabled: boolean): void {
    previewPolicy.value = browserStorageService.setPreviewPolicy({
      ...previewPolicy.value,
      preloadGreetingResources: enabled,
    })
  }

  function applyBeautificationPreviewPreload(enabled: boolean): void {
    previewPolicy.value = browserStorageService.setPreviewPolicy({
      ...previewPolicy.value,
      preloadBeautificationResources: enabled,
    })
  }

  function applyExtractCharacterAssets(enabled: boolean): void {
    extractCharacterAssets.value = enabled
    browserStorageService.setExtractCharacterAssets(enabled)
  }

  let downloadConfirmationPending = false
  async function applyIncreasedPreviewDownloads(enabled: boolean): Promise<void> {
    if (
      downloadConfirmationPending ||
      enabled === (previewPolicy.value.increaseDownloadConcurrency === true)
    )
      return
    if (enabled && isSafeModeActive()) {
      showNotice('安全模式下不能增加预览下载并发')
      return
    }
    downloadConfirmationPending = true
    try {
      if (
        enabled &&
        !(await confirmAction({
          title: '增加多线路下载',
          message:
            '开启后，预览素材最多同时进行 6 个下载任务，可能加快多图开场白和酒馆美化预览。\n\n更多图片同时到达可能增加内存占用、耗电、发热或卡顿；实际提速取决于网络、图片大小和服务器。网页普通图片仍由浏览器调度，音视频不拆分下载。\n\n遇到设备负担可随时关闭，恢复默认并发。是否开启？',
          confirmLabel: '确定',
          cancelLabel: '取消',
          centered: true,
        }))
      ) {
        return
      }
      previewPolicy.value = browserStorageService.setPreviewPolicy({
        ...previewPolicy.value,
        increaseDownloadConcurrency: enabled,
      })
      const supported = await configureNativePreviewDownloadConcurrency(enabled)
      if (!supported) showNotice('当前 APK 不支持调整预览下载并发，更新 APK 后生效')
    } finally {
      downloadConfirmationPending = false
    }
  }

  /** 恢复便携配置后重新读取全部外观设置，并立即应用到文档。 */
  function reloadAppearanceSettings(): void {
    theme.value = readStoredTheme()
    document.documentElement.dataset.theme = theme.value
    layoutMode.value = browserStorageService.getLayoutMode()
    mobileCardOrientation.value = browserStorageService.getMobileCardOrientation()
    document.documentElement.dataset.mobileCardOrientation = mobileCardOrientation.value
    mobileCardFitMode.value = browserStorageService.getMobileCardFitMode()
    document.documentElement.dataset.mobileCardFitMode = mobileCardFitMode.value
    resourceCardHeightMode.value = browserStorageService.getResourceCardHeightMode()
    document.documentElement.dataset.resourceCardHeight = resourceCardHeightMode.value
    noImageResourceCoverMode.value = browserStorageService.getNoImageResourceCoverMode()
    document.documentElement.dataset.noImageResourceCover = noImageResourceCoverMode.value
    uiFontScale.value = browserStorageService.getUiFontScale()
    document.documentElement.dataset.fontScale = uiFontScale.value
    previewPolicy.value = isSafeModeActive()
      ? {
          allowRemoteResources: false,
          allowScripts: false,
          preloadGreetingResources: false,
          preloadBeautificationResources: false,
          increaseDownloadConcurrency: false,
        }
      : browserStorageService.getPreviewPolicy()
    void configureNativePreviewDownloadConcurrency(
      previewPolicy.value.increaseDownloadConcurrency === true,
    )
    customUiCss.value = isSafeModeActive() ? '' : browserStorageService.getCustomUiCss()
    extractCharacterAssets.value = browserStorageService.getExtractCharacterAssets()
    showManuallyBoundResources.value = browserStorageService.getShowManuallyBoundResources()
    hideChatDisplayRegex.value = browserStorageService.getHideChatDisplayRegex()
    hideCharacterAssets.value = browserStorageService.getHideCharacterAssets()
    blurThumbnails.value = browserStorageService.getBlurThumbnails()
    autoDownloadDiscordShareLinks.value = browserStorageService.getAutoDownloadDiscordShareLinks()
    persistResourceVersionMatchCache.value =
      browserStorageService.getPersistResourceVersionMatchCache()
    skipVersionComparisonOnImport.value = browserStorageService.getSkipVersionComparisonOnImport()
    sameNameVersionCandidates.value = browserStorageService.getSameNameVersionCandidates()
  }

  return {
    theme,
    layoutMode,
    mobileCardOrientation,
    mobileCardFitMode,
    resourceCardHeightMode,
    noImageResourceCoverMode,
    uiFontScale,
    previewPolicy,
    customUiCss,
    extractCharacterAssets,
    hideCharacterAssets,
    hideChatDisplayRegex,
    showManuallyBoundResources,
    blurThumbnails,
    autoDownloadDiscordShareLinks,
    persistResourceVersionMatchCache,
    skipVersionComparisonOnImport,
    sameNameVersionCandidates,
    settingsPanelKey,
    applyTheme,
    applyLayoutMode,
    applyMobileCardOrientation,
    applyAutoDownloadDiscordShareLinks,
    applyPersistResourceVersionMatchCache,
    applySkipVersionComparisonOnImport,
    applySameNameVersionCandidates,
    applyMobileCardFitMode,
    applyResourceCardHeightMode,
    applyNoImageResourceCoverMode,
    applyUiFontScale,
    syncCustomUiCss,
    saveCustomUiCss,
    applyRemotePreviewPolicy,
    applyScriptPreviewPolicy,
    applyGreetingPreviewPreload,
    applyBeautificationPreviewPreload,
    applyIncreasedPreviewDownloads,
    applyExtractCharacterAssets,
    reloadAppearanceSettings,
  }
}
