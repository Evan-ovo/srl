import {
  PREVIEW_REMOTE_RESOURCES_KEY,
  PREVIEW_SCRIPTS_KEY,
  readStoredCustomUiCss,
  writeStoredCustomUiCss,
  readPaletteDraft,
  writePaletteDraft,
} from './BrowserAppearancePreferences'
export { type BridgeTransferDraft, PROJECT_NOTICE_VERSION } from './BrowserDevicePreferences'
import { normalizeUiViews } from '../core/UiCustomization'
import {
  CUSTOM_UI_VIEWS_KEY,
  CUSTOM_UI_VIEWS_CHANGED,
  type CustomUiViews,
} from '../types/UiCustomization'
import {
  exportStitchWork,
  importStitchWork,
  getUserPersonaTemplates,
  setUserPersonaTemplates,
  getBridgeTransferLog,
  appendBridgeTransferLog,
  getBridgeTransferDraft,
  setBridgeTransferDraft,
  getTavernChatCarryScripts,
  setTavernChatCarryScripts,
  getTavernSendContent,
  setTavernSendContent,
  getModifiedResourceSyncTags,
  setModifiedResourceSyncTags,
  getPresetStitchDraft,
  setPresetStitchDraft,
  clearPresetStitchDraft,
  getPresetStitchCheckpoint,
  setPresetStitchCheckpoint,
  clearPresetStitchCheckpoint,
  getStitchRecentIds,
  pushStitchRecentId,
  getStitchFavorites,
  setStitchFavorites,
  getStitchTemplates,
  setStitchTemplates,
  getStitchMainSide,
  setStitchMainSide,
  getFrontendWorkshopDrawerSize,
  setFrontendWorkshopDrawerSize,
  getFrontendWorkshopRecentColors,
  setFrontendWorkshopRecentColors,
  pushFrontendWorkshopRecentColor,
  hasAcknowledgedProjectNotice,
  hasAcknowledgedProjectNoticePersisted,
  acknowledgeProjectNotice,
  type BridgeTransferDraft,
} from './BrowserDevicePreferences'

import type {
  IndexedDbResourceHealthStorage,
  LegacyLibraryHistoryCleanup,
} from '../storage/IndexedDbResourceHealthStorage'

import type { UserPersonaTemplate } from '../types/UserPersona'

import type { PresetFavoriteSnapshot } from '../utils/PresetStitcher'

import {
  type PresetStitchTemplate,
  type StorageHealth,
  type LayoutMode,
  type UiFontScale,
  type CabinetColumns,
  type MobileCardOrientation,
  type MobileCardFitMode,
  type ResourceCardHeightMode,
  type NoImageResourceCoverMode,
  type PreviewPolicy,
  type CustomCssPreset,
  type PortableAppearanceSettings,
  type PortableGeneralPreferences,
  type TavernSendContent,
  type CabinetLayoutEntry,
  type PresetStitchDraft,
} from '../types/BrowserPreferences'

import {
  LAYOUT_MODES,
  UI_FONT_SCALES,
  CABINET_COLUMN_OPTIONS,
  MOBILE_CARD_ORIENTATIONS,
  MOBILE_CARD_FIT_MODES,
  RESOURCE_CARD_HEIGHT_MODES,
  NO_IMAGE_RESOURCE_COVER_MODES,
} from '../types/BrowserPreferences'

import * as operationsBrowserPreferenceNormalization from './BrowserPreferenceNormalization'

export {
  type PresetStitchTemplate,
  type StorageHealth,
  type LayoutMode,
  type UiFontScale,
  type CabinetColumns,
  type MobileCardOrientation,
  type MobileCardFitMode,
  type ResourceCardHeightMode,
  type NoImageResourceCoverMode,
  type PreviewPolicy,
  type CustomCssScope,
  type CustomCssPreset,
  type PortableAppearanceSettings,
  type PortableGeneralPreferences,
  type CabinetLayoutEntry,
  type PresetStitchDraftEntry,
  type PresetStitchDraft,
} from '../types/BrowserPreferences'

export {
  LAYOUT_MODES,
  UI_FONT_SCALES,
  CABINET_COLUMN_OPTIONS,
  MOBILE_CARD_ORIENTATIONS,
  MOBILE_CARD_FIT_MODES,
  RESOURCE_CARD_HEIGHT_MODES,
  NO_IMAGE_RESOURCE_COVER_MODES,
} from '../types/BrowserPreferences'

const LAST_FULL_BACKUP_KEY = 'srl-last-full-backup'

const SEARCH_HISTORY_KEY = 'srl-search-history'

const LAYOUT_MODE_KEY = 'srl.ui.layoutMode'

const UI_FONT_SCALE_KEY = 'srl.ui.fontScale'

const EXTRACT_CHARACTER_ASSETS_KEY = 'srl.import.extractCharacterAssets'

const SHOW_MANUALLY_BOUND_RESOURCES_KEY = 'srl.library.showManuallyBoundResources'
const HIDE_CHAT_DISPLAY_REGEX_KEY = 'srl.library.hideChatDisplayRegex'
const HIDE_CHARACTER_ASSETS_KEY = 'srl.library.hideCharacterAssets'

const BLUR_THUMBNAILS_KEY = 'srl.library.blurThumbnails'
const AUTO_DOWNLOAD_DISCORD_SHARE_LINKS_KEY = 'srl.library.autoDownloadDiscordShareLinks'
const PERSIST_RESOURCE_VERSION_MATCH_CACHE_KEY = 'srl.library.persistResourceVersionMatchCache'
const SKIP_VERSION_COMPARISON_ON_IMPORT_KEY = 'srl.import.skipVersionComparison'
const SAME_NAME_VERSION_CANDIDATES_KEY = 'srl.library.sameNameVersionCandidates'
const MOBILE_CARD_ORIENTATION_KEY = 'srl.library.mobileCardOrientation'
const MOBILE_CARD_FIT_MODE_KEY = 'srl.library.mobileCardFitMode'
const RESOURCE_CARD_HEIGHT_MODE_KEY = 'srl.library.uniformResourceCardHeight'
const NO_IMAGE_RESOURCE_COVER_MODE_KEY = 'srl.library.noImageResourceCoverMode'
const LEGACY_MOBILE_LANDSCAPE_FIT_MODE_KEY = 'srl.library.mobileLandscapeFitMode'

const DRAW_SHOW_NAMES_KEY = 'srl.draw.showNames'

const PREVIEW_GREETING_PRELOAD_KEY = 'srl.preview.preloadGreetingResources'

const PREVIEW_BEAUTIFICATION_PRELOAD_KEY = 'srl.preview.preloadBeautificationResources'
const PREVIEW_DOWNLOAD_CONCURRENCY_KEY = 'srl.preview.increaseDownloadConcurrency'

const CUSTOM_UI_PRESETS_KEY = 'srl.ui.customCssPresets'

const ACTIVE_CUSTOM_UI_PRESET_KEY = 'srl.ui.activeCustomCssPreset'

const CABINET_RESOURCE_IDS_KEY = 'srl.cabinet.resourceIds'

const CABINET_LAYOUT_KEY = 'srl.cabinet.layout'

const CABINET_COLUMNS_KEY = 'srl.cabinet.columns'

const PREVIEW_POLICY_EVENT = 'srl-preview-policy-change'

const SEARCH_HISTORY_LIMIT = 10

export class BrowserStorageService {
  private readonly maintenance?: Pick<
    IndexedDbResourceHealthStorage,
    | 'legacyLibraryHistoryCleanup'
    | 'clearLegacyLibraryHistory'
    | 'optimizeDerivedSummaries'
    | 'getSummaryCompactionStatus'
  >

  constructor(
    maintenance?: Pick<
      IndexedDbResourceHealthStorage,
      | 'legacyLibraryHistoryCleanup'
      | 'clearLegacyLibraryHistory'
      | 'optimizeDerivedSummaries'
      | 'getSummaryCompactionStatus'
    >,
  ) {
    this.maintenance = maintenance
  }

  async legacyLibraryHistoryCleanup(): Promise<LegacyLibraryHistoryCleanup> {
    return this.maintenance?.legacyLibraryHistoryCleanup() ?? { records: [], bytes: 0 }
  }

  async clearLegacyLibraryHistory(plan: LegacyLibraryHistoryCleanup): Promise<number> {
    if (!this.maintenance) throw new Error('本机存储维护未初始化')
    return this.maintenance.clearLegacyLibraryHistory(plan)
  }

  async optimizeDerivedSummaries() {
    if (!this.maintenance) throw new Error('本机存储维护未初始化')
    return this.maintenance.optimizeDerivedSummaries()
  }

  async getSummaryCompactionStatus(): Promise<boolean | undefined> {
    return this.maintenance?.getSummaryCompactionStatus()
  }

  exportStitchWork(): {
    draft?: PresetStitchDraft
    checkpoint?: PresetStitchDraft
    recentPresets?: string[]
  } {
    return exportStitchWork()
  }

  importStitchWork(value: {
    draft?: PresetStitchDraft
    checkpoint?: PresetStitchDraft
    recentPresets?: string[]
  }): void {
    return importStitchWork(value)
  }
  exportAppearanceSettings(): PortableAppearanceSettings {
    let theme: 'light' | 'dark' = 'light'
    try {
      theme = localStorage.getItem('srl-theme') === 'dark' ? 'dark' : 'light'
    } catch {
      // 继续使用浅色默认值。
    }
    return {
      theme,
      layoutMode: this.getLayoutMode(),
      fontScale: this.getUiFontScale(),
      customCss: this.getCustomUiCss(),
      presets: this.getCustomUiPresets(),
      activePresetId: this.getActiveCustomUiPresetId(),
      views: this.getCustomUiViews(),
    }
  }

  importAppearanceSettings(value: PortableAppearanceSettings): void {
    // Restoring a theme must not silently execute scripts or restore network permission.
    const views = normalizeUiViews(value?.views, true)
    const presets = (Array.isArray(value?.presets) ? value.presets : []).map((preset) => ({
      ...preset,
      ...(preset.views ? { views: normalizeUiViews(preset.views, true) } : {}),
    }))
    try {
      localStorage.setItem('srl-theme', value?.theme === 'dark' ? 'dark' : 'light')
    } catch {
      // 其余外观项目仍可继续恢复。
    }
    this.setLayoutMode(LAYOUT_MODES.includes(value?.layoutMode) ? value.layoutMode : 'grid')
    this.setUiFontScale(
      UI_FONT_SCALES.includes(value?.fontScale as UiFontScale)
        ? (value.fontScale as UiFontScale)
        : 'standard',
    )
    this.setCustomUiCss(typeof value?.customCss === 'string' ? value.customCss : '')
    this.setCustomUiPresets(presets)
    this.setActiveCustomUiPresetId(
      typeof value?.activePresetId === 'string' ? value.activePresetId : '',
    )
    this.setCustomUiViews(views)
  }

  exportGeneralPreferences(): PortableGeneralPreferences {
    return {
      tavernChatCarryScripts: this.getTavernChatCarryScripts(),
      tavernSendContent: this.getTavernSendContent(),
      modifiedResourceSyncTags: this.getModifiedResourceSyncTags(),
      previewPolicy: this.getPreviewPolicy(),
      extractCharacterAssets: this.getExtractCharacterAssets(),
      hideCharacterAssets: this.getHideCharacterAssets(),
      hideChatDisplayRegex: this.getHideChatDisplayRegex(),
      showManuallyBoundResources: this.getShowManuallyBoundResources(),
      searchHistory: this.getSearchHistory(),
      blurThumbnails: this.getBlurThumbnails(),
      autoDownloadDiscordShareLinks: this.getAutoDownloadDiscordShareLinks(),
      persistResourceVersionMatchCache: this.getPersistResourceVersionMatchCache(),
      skipVersionComparisonOnImport: this.getSkipVersionComparisonOnImport(),
      sameNameVersionCandidates: this.getSameNameVersionCandidates(),
      mobileCardOrientation: this.getMobileCardOrientation(),
      mobileCardFitMode: this.getMobileCardFitMode(),
      resourceCardHeightMode: this.getResourceCardHeightMode(),
      noImageResourceCoverMode: this.getNoImageResourceCoverMode(),
      uniformResourceCardHeight: this.getResourceCardHeightMode() === 'uniform',
      cabinetResourceIds: this.getCabinetResourceIds(),
      cabinetLayout: this.getCabinetLayout(),
      cabinetColumns: this.getCabinetColumns(),
      userPersonaTemplates: this.getUserPersonaTemplates(),
      stitchFavorites: this.getStitchFavorites(),
      stitchTemplates: this.getStitchTemplates(),
      stitchMainSide: this.getStitchMainSide(),
      frontendWorkshopRecentColors: this.getFrontendWorkshopRecentColors(),
    }
  }

  importGeneralPreferences(value: PortableGeneralPreferences): void {
    if (value?.tavernChatCarryScripts !== undefined)
      this.setTavernChatCarryScripts(value.tavernChatCarryScripts)
    if (value?.tavernSendContent !== undefined) this.setTavernSendContent(value.tavernSendContent)
    if (value?.modifiedResourceSyncTags !== undefined)
      this.setModifiedResourceSyncTags(value.modifiedResourceSyncTags)
    // Device load preferences require confirmation on this device rather than backup opt-in.
    this.setPreviewPolicy({
      allowRemoteResources: value?.previewPolicy?.allowRemoteResources === true,
      allowScripts: value?.previewPolicy?.allowScripts === true,
    })
    this.setExtractCharacterAssets(value?.extractCharacterAssets === true)
    this.setHideCharacterAssets(value?.hideCharacterAssets !== false)
    this.setHideChatDisplayRegex(value?.hideChatDisplayRegex !== false)
    this.setShowManuallyBoundResources(value?.showManuallyBoundResources !== false)
    this.setBlurThumbnails(value?.blurThumbnails !== false)
    this.setAutoDownloadDiscordShareLinks(value?.autoDownloadDiscordShareLinks === true)
    this.setPersistResourceVersionMatchCache(value?.persistResourceVersionMatchCache !== false)
    this.setSkipVersionComparisonOnImport(value?.skipVersionComparisonOnImport === true)
    this.setSameNameVersionCandidates(value?.sameNameVersionCandidates === true)
    this.setMobileCardOrientation(value?.mobileCardOrientation)
    this.setMobileCardFitMode(value?.mobileCardFitMode ?? value?.mobileLandscapeFitMode)
    this.setResourceCardHeightMode(
      value?.resourceCardHeightMode ??
        (value?.uniformResourceCardHeight === true ? 'uniform' : 'natural'),
    )
    this.setNoImageResourceCoverMode(value?.noImageResourceCoverMode)
    this.setCabinetResourceIds(value?.cabinetResourceIds ?? [])
    this.setCabinetLayout(value?.cabinetLayout ?? [])
    this.setCabinetColumns(value?.cabinetColumns ?? 4)
    this.setUserPersonaTemplates(value?.userPersonaTemplates ?? [])
    this.setStitchFavorites(value?.stitchFavorites ?? [])
    this.setStitchTemplates(value?.stitchTemplates ?? [])
    this.setStitchMainSide(value?.stitchMainSide === 'left' ? 'left' : 'right')
    this.setFrontendWorkshopRecentColors(value?.frontendWorkshopRecentColors ?? [])
    this.writeSearchHistory(
      (Array.isArray(value?.searchHistory) ? value.searchHistory : [])
        .filter((item): item is string => typeof item === 'string')
        .slice(0, SEARCH_HISTORY_LIMIT),
    )
  }

  getCabinetResourceIds(): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(CABINET_RESOURCE_IDS_KEY) ?? '[]')
      if (!Array.isArray(parsed)) return []
      return Array.from(
        new Set(parsed.filter((item): item is string => typeof item === 'string' && Boolean(item))),
      ).slice(0, 5000)
    } catch {
      return []
    }
  }

  setCabinetResourceIds(resourceIds: string[]): void {
    const normalized = Array.from(
      new Set(
        resourceIds.filter((item): item is string => typeof item === 'string' && Boolean(item)),
      ),
    ).slice(0, 5000)
    try {
      localStorage.setItem(CABINET_RESOURCE_IDS_KEY, JSON.stringify(normalized))
    } catch {
      // 收藏柜桌面布局写入失败时，不阻断文件夹与资源本身的使用。
    }
  }

  getCabinetLayout(): CabinetLayoutEntry[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(CABINET_LAYOUT_KEY) ?? '[]')
      return this.normalizeCabinetLayout(parsed)
    } catch {
      return []
    }
  }

  setCabinetLayout(layout: CabinetLayoutEntry[]): void {
    try {
      localStorage.setItem(CABINET_LAYOUT_KEY, JSON.stringify(this.normalizeCabinetLayout(layout)))
    } catch {
      // 收藏柜槽位属于可恢复偏好，写入失败时不影响资源和文件夹本体。
    }
  }

  getCabinetColumns(): CabinetColumns {
    try {
      const value = Number(localStorage.getItem(CABINET_COLUMNS_KEY))
      return CABINET_COLUMN_OPTIONS.includes(value as CabinetColumns)
        ? (value as CabinetColumns)
        : 4
    } catch {
      return 4
    }
  }

  setCabinetColumns(value: number): CabinetColumns {
    const normalized = CABINET_COLUMN_OPTIONS.includes(value as CabinetColumns)
      ? (value as CabinetColumns)
      : 4
    try {
      localStorage.setItem(CABINET_COLUMNS_KEY, String(normalized))
    } catch {
      // 收藏柜密度属于本机视觉偏好，写入失败时继续使用四列默认值。
    }
    return normalized
  }

  getUserPersonaTemplates(): UserPersonaTemplate[] {
    return getUserPersonaTemplates()
  }

  setUserPersonaTemplates(value: UserPersonaTemplate[]): UserPersonaTemplate[] {
    return setUserPersonaTemplates(value)
  }

  getPreviewPolicy(): PreviewPolicy {
    try {
      const allowScripts = localStorage.getItem(PREVIEW_SCRIPTS_KEY) === 'true'
      return {
        allowScripts,
        allowRemoteResources:
          allowScripts || localStorage.getItem(PREVIEW_REMOTE_RESOURCES_KEY) === 'true',
        preloadGreetingResources: localStorage.getItem(PREVIEW_GREETING_PRELOAD_KEY) === 'true',
        preloadBeautificationResources:
          localStorage.getItem(PREVIEW_BEAUTIFICATION_PRELOAD_KEY) === 'true',
        increaseDownloadConcurrency:
          localStorage.getItem(PREVIEW_DOWNLOAD_CONCURRENCY_KEY) === 'true',
      }
    } catch {
      return {
        allowRemoteResources: false,
        allowScripts: false,
        preloadGreetingResources: false,
        preloadBeautificationResources: false,
        increaseDownloadConcurrency: false,
      }
    }
  }

  setPreviewPolicy(value: PreviewPolicy): PreviewPolicy {
    const normalized = {
      allowScripts: value.allowScripts,
      allowRemoteResources: value.allowScripts || value.allowRemoteResources,
      preloadGreetingResources: value.preloadGreetingResources === true,
      preloadBeautificationResources: value.preloadBeautificationResources === true,
      increaseDownloadConcurrency: value.increaseDownloadConcurrency === true,
    }
    try {
      localStorage.setItem(PREVIEW_REMOTE_RESOURCES_KEY, String(normalized.allowRemoteResources))
      localStorage.setItem(PREVIEW_SCRIPTS_KEY, String(normalized.allowScripts))
      localStorage.setItem(
        PREVIEW_GREETING_PRELOAD_KEY,
        String(normalized.preloadGreetingResources),
      )
      localStorage.setItem(
        PREVIEW_BEAUTIFICATION_PRELOAD_KEY,
        String(normalized.preloadBeautificationResources),
      )
      localStorage.setItem(
        PREVIEW_DOWNLOAD_CONCURRENCY_KEY,
        String(normalized.increaseDownloadConcurrency),
      )
      window.dispatchEvent(new CustomEvent(PREVIEW_POLICY_EVENT, { detail: normalized }))
    } catch {
      // 隐私模式拒绝写入时，当前组件仍可使用传入的新状态。
    }
    return normalized
  }

  onPreviewPolicyChange(listener: (value: PreviewPolicy) => void): () => void {
    const handler = (event: Event) =>
      listener((event as CustomEvent<PreviewPolicy>).detail ?? this.getPreviewPolicy())
    window.addEventListener(PREVIEW_POLICY_EVENT, handler)
    return () => window.removeEventListener(PREVIEW_POLICY_EVENT, handler)
  }

  getCustomUiCss(): string {
    return readStoredCustomUiCss()
  }
  setCustomUiCss(value: string): void {
    writeStoredCustomUiCss(value)
  }

  getCustomUiPresets(): CustomCssPreset[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(CUSTOM_UI_PRESETS_KEY) ?? '[]') as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is CustomCssPreset =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as CustomCssPreset).id === 'string' &&
          typeof (item as CustomCssPreset).name === 'string' &&
          typeof (item as CustomCssPreset).globalCss === 'string',
      )
    } catch {
      return []
    }
  }

  getAppearancePaletteDraft(): Record<string, unknown> | undefined {
    return readPaletteDraft()
  }

  setAppearancePaletteDraft(value: Record<string, unknown>): void {
    writePaletteDraft(value)
  }

  getCustomUiViews(): CustomUiViews {
    try {
      return normalizeUiViews(JSON.parse(localStorage.getItem(CUSTOM_UI_VIEWS_KEY) ?? '{}'))
    } catch {
      return {}
    }
  }

  setCustomUiViews(value: CustomUiViews): void {
    const clean = normalizeUiViews(value)
    const serialized = JSON.stringify(clean)
    localStorage.setItem(CUSTOM_UI_VIEWS_KEY, serialized)
    if (localStorage.getItem(CUSTOM_UI_VIEWS_KEY) !== serialized)
      throw new Error('界面源码未保存成功；请检查本机空间，草稿仍保留')
    window.dispatchEvent(new Event(CUSTOM_UI_VIEWS_CHANGED))
  }

  setCustomUiPresets(value: CustomCssPreset[]): void {
    try {
      localStorage.setItem(CUSTOM_UI_PRESETS_KEY, JSON.stringify(value.slice(0, 30)))
    } catch {
      // CSS 预设属于可导出的偏好，写入失败时仍允许当前会话继续编辑。
    }
  }

  getActiveCustomUiPresetId(): string {
    try {
      return localStorage.getItem(ACTIVE_CUSTOM_UI_PRESET_KEY) ?? ''
    } catch {
      return ''
    }
  }

  setActiveCustomUiPresetId(value: string): void {
    try {
      localStorage.setItem(ACTIVE_CUSTOM_UI_PRESET_KEY, value)
    } catch {
      // 当前预设指针写入失败不影响 CSS 本身的应用。
    }
  }

  getDrawShowNames(): boolean {
    try {
      const value = localStorage.getItem(DRAW_SHOW_NAMES_KEY)
      return value == null ? true : value === 'true'
    } catch {
      return true
    }
  }

  setDrawShowNames(enabled: boolean): void {
    try {
      localStorage.setItem(DRAW_SHOW_NAMES_KEY, String(enabled))
    } catch {
      // 抽卡显示偏好写入失败时，当前会话仍可正常使用。
    }
  }

  getShowManuallyBoundResources(): boolean {
    try {
      return localStorage.getItem(SHOW_MANUALLY_BOUND_RESOURCES_KEY) !== 'false'
    } catch {
      return true
    }
  }

  setShowManuallyBoundResources(enabled: boolean): void {
    try {
      localStorage.setItem(SHOW_MANUALLY_BOUND_RESOURCES_KEY, String(enabled))
    } catch {
      /* 当前会话仍应用此显示偏好。 */
    }
  }

  getHideChatDisplayRegex(): boolean {
    try {
      return localStorage.getItem(HIDE_CHAT_DISPLAY_REGEX_KEY) !== 'false'
    } catch {
      return true
    }
  }

  setHideChatDisplayRegex(enabled: boolean): void {
    try {
      localStorage.setItem(HIDE_CHAT_DISPLAY_REGEX_KEY, String(enabled))
    } catch {
      /* The current session still applies the display preference. */
    }
  }

  getHideCharacterAssets(): boolean {
    try {
      const value = localStorage.getItem(HIDE_CHARACTER_ASSETS_KEY)
      return value == null ? true : value === 'true'
    } catch {
      return true
    }
  }

  setHideCharacterAssets(enabled: boolean): void {
    try {
      localStorage.setItem(HIDE_CHARACTER_ASSETS_KEY, String(enabled))
    } catch {
      // 显示偏好写入失败时，不影响当前会话继续筛选。
    }
  }

  getBlurThumbnails(): boolean {
    try {
      const value = localStorage.getItem(BLUR_THUMBNAILS_KEY)
      return value == null ? true : value === 'true'
    } catch {
      return true
    }
  }

  setBlurThumbnails(enabled: boolean): void {
    try {
      localStorage.setItem(BLUR_THUMBNAILS_KEY, String(enabled))
    } catch {
      // 缩略图模糊偏好写入失败时，不影响当前会话继续使用。
    }
  }

  getAutoDownloadDiscordShareLinks(): boolean {
    try {
      return localStorage.getItem(AUTO_DOWNLOAD_DISCORD_SHARE_LINKS_KEY) === 'true'
    } catch {
      return false
    }
  }

  setAutoDownloadDiscordShareLinks(enabled: boolean): void {
    try {
      localStorage.setItem(AUTO_DOWNLOAD_DISCORD_SHARE_LINKS_KEY, String(enabled))
    } catch {
      // 分享下载偏好写入失败时仍在当前会话生效。
    }
  }

  getPersistResourceVersionMatchCache(): boolean {
    try {
      return localStorage.getItem(PERSIST_RESOURCE_VERSION_MATCH_CACHE_KEY) !== 'false'
    } catch {
      return true
    }
  }

  setPersistResourceVersionMatchCache(enabled: boolean): void {
    try {
      localStorage.setItem(PERSIST_RESOURCE_VERSION_MATCH_CACHE_KEY, String(enabled))
    } catch {
      // 持久化偏好写入失败时仍在当前会话使用默认缓存策略。
    }
  }

  getSameNameVersionCandidates(): boolean {
    try {
      return localStorage.getItem(SAME_NAME_VERSION_CANDIDATES_KEY) === 'true'
    } catch {
      return false
    }
  }

  setSameNameVersionCandidates(enabled: boolean): void {
    try {
      localStorage.setItem(SAME_NAME_VERSION_CANDIDATES_KEY, String(enabled))
    } catch {
      /* 当前会话仍使用受控偏好。 */
    }
  }

  getSkipVersionComparisonOnImport(): boolean {
    try {
      return localStorage.getItem(SKIP_VERSION_COMPARISON_ON_IMPORT_KEY) === 'true'
    } catch {
      return false
    }
  }

  setSkipVersionComparisonOnImport(enabled: boolean): void {
    try {
      localStorage.setItem(SKIP_VERSION_COMPARISON_ON_IMPORT_KEY, String(enabled))
    } catch {
      // 导入性能偏好写入失败时仍按当前会话设置执行。
    }
  }

  getMobileCardOrientation(): MobileCardOrientation {
    try {
      const value = localStorage.getItem(MOBILE_CARD_ORIENTATION_KEY)
      return MOBILE_CARD_ORIENTATIONS.find((option) => option === value) ?? 'mixed'
    } catch {
      return 'mixed'
    }
  }

  setMobileCardOrientation(value: unknown): MobileCardOrientation {
    const orientation = MOBILE_CARD_ORIENTATIONS.find((option) => option === value) ?? 'mixed'
    try {
      localStorage.setItem(MOBILE_CARD_ORIENTATION_KEY, orientation)
    } catch {
      // 比例偏好写入失败时仍在当前会话生效。
    }
    return orientation
  }

  getMobileCardFitMode(): MobileCardFitMode {
    try {
      const value =
        localStorage.getItem(MOBILE_CARD_FIT_MODE_KEY) ??
        localStorage.getItem(LEGACY_MOBILE_LANDSCAPE_FIT_MODE_KEY)
      return MOBILE_CARD_FIT_MODES.find((option) => option === value) ?? 'contain'
    } catch {
      return 'contain'
    }
  }

  setMobileCardFitMode(value: unknown): MobileCardFitMode {
    const mode = MOBILE_CARD_FIT_MODES.find((option) => option === value) ?? 'contain'
    try {
      localStorage.setItem(MOBILE_CARD_FIT_MODE_KEY, mode)
    } catch {
      // 卡片图片显示偏好写入失败时仍在当前会话生效。
    }
    return mode
  }

  getResourceCardHeightMode(): ResourceCardHeightMode {
    try {
      const stored = localStorage.getItem(RESOURCE_CARD_HEIGHT_MODE_KEY)
      if (stored === 'true') return 'uniform'
      if (stored === 'false' || stored === null) return 'natural'
      return RESOURCE_CARD_HEIGHT_MODES.find((option) => option === stored) ?? 'natural'
    } catch {
      return 'natural'
    }
  }

  setResourceCardHeightMode(value: unknown): ResourceCardHeightMode {
    const mode = RESOURCE_CARD_HEIGHT_MODES.find((option) => option === value) ?? 'natural'
    try {
      localStorage.setItem(RESOURCE_CARD_HEIGHT_MODE_KEY, mode)
    } catch {
      // 卡片高度偏好写入失败时仍在当前会话生效。
    }
    return mode
  }

  getNoImageResourceCoverMode(): NoImageResourceCoverMode {
    try {
      const stored = localStorage.getItem(NO_IMAGE_RESOURCE_COVER_MODE_KEY)
      return NO_IMAGE_RESOURCE_COVER_MODES.find((option) => option === stored) ?? 'cover'
    } catch {
      return 'cover'
    }
  }

  setNoImageResourceCoverMode(value: unknown): NoImageResourceCoverMode {
    const mode = NO_IMAGE_RESOURCE_COVER_MODES.find((option) => option === value) ?? 'cover'
    try {
      localStorage.setItem(NO_IMAGE_RESOURCE_COVER_MODE_KEY, mode)
    } catch {
      // 无图资源封面偏好写入失败时仍在当前会话生效。
    }
    return mode
  }

  getExtractCharacterAssets(): boolean {
    try {
      return localStorage.getItem(EXTRACT_CHARACTER_ASSETS_KEY) === 'true'
    } catch {
      return false
    }
  }

  setExtractCharacterAssets(enabled: boolean): void {
    try {
      localStorage.setItem(EXTRACT_CHARACTER_ASSETS_KEY, String(enabled))
    } catch {
      // 导入偏好写入失败时，不影响当前会话继续导入。
    }
  }

  getLayoutMode(): LayoutMode {
    try {
      const value = localStorage.getItem(LAYOUT_MODE_KEY)
      return LAYOUT_MODES.includes(value as LayoutMode) ? (value as LayoutMode) : 'grid'
    } catch {
      return 'grid'
    }
  }

  setLayoutMode(value: LayoutMode): void {
    try {
      localStorage.setItem(LAYOUT_MODE_KEY, value)
    } catch {
      // 排版偏好写入失败时，当前会话仍可正常切换。
    }
  }

  getUiFontScale(): UiFontScale {
    try {
      const value = localStorage.getItem(UI_FONT_SCALE_KEY)
      return UI_FONT_SCALES.includes(value as UiFontScale) ? (value as UiFontScale) : 'standard'
    } catch {
      return 'standard'
    }
  }

  setUiFontScale(value: UiFontScale): UiFontScale {
    const normalized = UI_FONT_SCALES.includes(value) ? value : 'standard'
    try {
      localStorage.setItem(UI_FONT_SCALE_KEY, normalized)
    } catch {
      // 写入失败时仍返回当前会话可应用的安全档位。
    }
    return normalized
  }

  async getHealth(): Promise<StorageHealth> {
    if (!navigator.storage) {
      return { supported: false, persisted: false, usage: 0, quota: 0 }
    }

    const [persisted, estimate] = await Promise.all([
      navigator.storage.persisted?.().catch(() => false) ?? false,
      navigator.storage.estimate?.().catch((): StorageEstimate => ({})) ??
        Promise.resolve<StorageEstimate>({}),
    ])
    return {
      supported: true,
      persisted,
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
    }
  }

  async requestPersistence(): Promise<StorageHealth> {
    if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false)
    return this.getHealth()
  }

  getLastFullBackupAt(): number | undefined {
    try {
      const value = Number(localStorage.getItem(LAST_FULL_BACKUP_KEY))
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  recordFullBackup(at = Date.now()): void {
    try {
      localStorage.setItem(LAST_FULL_BACKUP_KEY, String(at))
    } catch {
      // 浏览器禁用 localStorage 时，导出本身仍然有效。
    }
  }

  /** 互传报告：最近 20 条跨会话保留，供下次打开互传中心时回看。 */
  getBridgeTransferLog(): string[] {
    return getBridgeTransferLog()
  }

  getTavernChatCarryScripts(): boolean {
    return getTavernChatCarryScripts()
  }
  setTavernChatCarryScripts(enabled: boolean): void {
    setTavernChatCarryScripts(enabled)
  }

  getTavernSendContent(): TavernSendContent {
    return getTavernSendContent()
  }

  getModifiedResourceSyncTags(): boolean {
    return getModifiedResourceSyncTags()
  }

  setModifiedResourceSyncTags(enabled: boolean): void {
    setModifiedResourceSyncTags(enabled)
  }

  setTavernSendContent(content: TavernSendContent): void {
    setTavernSendContent(content)
  }

  appendBridgeTransferLog(entries: string[]): string[] {
    return appendBridgeTransferLog(entries)
  }

  getBridgeTransferDraft(): BridgeTransferDraft | undefined {
    return getBridgeTransferDraft()
  }

  setBridgeTransferDraft(value: BridgeTransferDraft): void {
    return setBridgeTransferDraft(value)
  }

  /** 缝了么：装配区非空时的本地草稿，防误退丢工作。 */
  getPresetStitchDraft(): PresetStitchDraft | undefined {
    return getPresetStitchDraft()
  }

  setPresetStitchDraft(draft: PresetStitchDraft): void {
    return setPresetStitchDraft(draft)
  }

  clearPresetStitchDraft(): void {
    return clearPresetStitchDraft()
  }

  /** 缝了么：用户手动保存的单个工作台检查点。 */
  getPresetStitchCheckpoint(): PresetStitchDraft | undefined {
    return getPresetStitchCheckpoint()
  }

  setPresetStitchCheckpoint(checkpoint: PresetStitchDraft): void {
    return setPresetStitchCheckpoint(checkpoint)
  }

  clearPresetStitchCheckpoint(): void {
    return clearPresetStitchCheckpoint()
  }

  /** 缝了么：最近用过的预设置顶（底板或来源），最多保留 6 个。 */
  getStitchRecentIds(): string[] {
    return getStitchRecentIds()
  }

  pushStitchRecentId(id: string): void {
    return pushStitchRecentId(id)
  }

  /** 缝了么：收藏条目保存完整 prompt 快照，来源资源删除后仍可复用。 */
  getStitchFavorites(): PresetFavoriteSnapshot[] {
    return getStitchFavorites()
  }

  setStitchFavorites(value: PresetFavoriteSnapshot[]): PresetFavoriteSnapshot[] {
    return setStitchFavorites(value)
  }

  getStitchTemplates(): PresetStitchTemplate[] {
    return getStitchTemplates()
  }

  setStitchTemplates(value: PresetStitchTemplate[]): PresetStitchTemplate[] {
    return setStitchTemplates(value)
  }

  getStitchMainSide(): 'left' | 'right' {
    return getStitchMainSide()
  }

  setStitchMainSide(value: 'left' | 'right'): 'left' | 'right' {
    return setStitchMainSide(value)
  }

  getFrontendWorkshopDrawerSize(): { bottom: number; side: number } {
    return getFrontendWorkshopDrawerSize()
  }

  setFrontendWorkshopDrawerSize(value: { bottom: number; side: number }): void {
    return setFrontendWorkshopDrawerSize(value)
  }

  getFrontendWorkshopRecentColors(): string[] {
    return getFrontendWorkshopRecentColors()
  }

  setFrontendWorkshopRecentColors(value: unknown): string[] {
    return setFrontendWorkshopRecentColors(value)
  }

  pushFrontendWorkshopRecentColor(value: string): string[] {
    return pushFrontendWorkshopRecentColor(value)
  }

  hasAcknowledgedProjectNotice(): boolean {
    return hasAcknowledgedProjectNotice()
  }

  async hasAcknowledgedProjectNoticePersisted(): Promise<boolean> {
    return hasAcknowledgedProjectNoticePersisted()
  }

  acknowledgeProjectNotice(): void {
    return acknowledgeProjectNotice()
  }

  getSearchHistory(): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]')
      return Array.isArray(parsed)
        ? parsed
            .filter((item): item is string => typeof item === 'string')
            .slice(0, SEARCH_HISTORY_LIMIT)
        : []
    } catch {
      return []
    }
  }

  saveSearch(query: string): string[] {
    const normalized = query.trim()
    if (!normalized) return this.getSearchHistory()
    const history = [
      normalized,
      ...this.getSearchHistory().filter(
        (item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase(),
      ),
    ].slice(0, SEARCH_HISTORY_LIMIT)
    this.writeSearchHistory(history)
    return history
  }

  clearSearchHistory(): void {
    this.writeSearchHistory([])
  }

  private writeSearchHistory(history: string[]): void {
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history))
    } catch {
      // 历史记录属于非关键偏好，写入失败不影响搜索。
    }
  }

  private normalizeCabinetLayout(value: unknown): CabinetLayoutEntry[] {
    return operationsBrowserPreferenceNormalization.normalizeCabinetLayout(value)
  }
}
