import type { UserPersonaTemplate } from './UserPersona'
import type { PresetFavoriteSnapshot } from '../utils/PresetStitcher'
export const LAYOUT_MODES = ['grid', 'list', 'split'] as const

export const UI_FONT_SCALES = ['small', 'standard', 'large'] as const

export const CABINET_COLUMN_OPTIONS = [2, 3, 4] as const

export const MOBILE_CARD_ORIENTATIONS = ['mixed', 'portrait', 'landscape'] as const

export type MobileCardOrientation = (typeof MOBILE_CARD_ORIENTATIONS)[number]

export const MOBILE_CARD_FIT_MODES = ['contain', 'cover'] as const

export type MobileCardFitMode = (typeof MOBILE_CARD_FIT_MODES)[number]

export const RESOURCE_CARD_HEIGHT_MODES = ['natural', 'uniform', 'fixed'] as const

export type ResourceCardHeightMode = (typeof RESOURCE_CARD_HEIGHT_MODES)[number]

export const NO_IMAGE_RESOURCE_COVER_MODES = ['cover', 'character-only', 'compact'] as const

export type NoImageResourceCoverMode = (typeof NO_IMAGE_RESOURCE_COVER_MODES)[number]

export interface PresetStitchTemplate {
  id: string
  name: string
  entries: PresetFavoriteSnapshot[]
  createdAt: number
  updatedAt: number
}

export interface StorageHealth {
  supported: boolean
  persisted: boolean
  usage: number
  quota: number
}

export type LayoutMode = (typeof LAYOUT_MODES)[number]

export type UiFontScale = (typeof UI_FONT_SCALES)[number]

export type CabinetColumns = (typeof CABINET_COLUMN_OPTIONS)[number]

export interface PreviewPolicy {
  allowRemoteResources: boolean
  allowScripts: boolean
  preloadGreetingResources?: boolean
  preloadBeautificationResources?: boolean
  increaseDownloadConcurrency?: boolean
}

export type CustomCssScope =
  | `app:${string}`
  | 'library'
  | 'shell'
  | 'details'
  | 'features'
  | 'draw'
  | 'cabinet'
  | 'appearance'
  | 'cloud'
  | 'bridge'
  | 'stitch'
  | 'frontend'
  | 'persona'
  | 'settings'

export interface CustomCssPreset {
  id: string
  name: string
  globalCss: string
  scopedCss: Partial<Record<CustomCssScope, string>>
  views?: import('./UiCustomization').CustomUiViews
  createdAt: string
  updatedAt: string
}

export interface PortableAppearanceSettings {
  theme: 'light' | 'dark'
  layoutMode: LayoutMode
  fontScale?: UiFontScale
  customCss: string
  presets: CustomCssPreset[]
  activePresetId: string
  views?: import('./UiCustomization').CustomUiViews
}

export type TavernSendContent = 'original' | 'modified'

export interface PortableGeneralPreferences {
  tavernChatCarryScripts?: boolean
  tavernSendContent?: TavernSendContent
  modifiedResourceSyncTags?: boolean
  previewPolicy: PreviewPolicy
  extractCharacterAssets: boolean
  hideCharacterAssets: boolean
  hideChatDisplayRegex?: boolean
  showManuallyBoundResources?: boolean
  searchHistory: string[]
  blurThumbnails?: boolean
  autoDownloadDiscordShareLinks?: boolean
  persistResourceVersionMatchCache?: boolean
  skipVersionComparisonOnImport?: boolean
  sameNameVersionCandidates?: boolean
  mobileCardOrientation?: MobileCardOrientation
  mobileCardFitMode?: MobileCardFitMode
  resourceCardHeightMode?: ResourceCardHeightMode
  noImageResourceCoverMode?: NoImageResourceCoverMode
  /** @deprecated Legacy setting; use resourceCardHeightMode. */
  uniformResourceCardHeight?: boolean
  /** @deprecated Legacy backup field; retained for importing older exports. */
  mobileLandscapeFitMode?: MobileCardFitMode
  cabinetResourceIds?: string[]
  cabinetLayout?: CabinetLayoutEntry[]
  cabinetColumns?: CabinetColumns
  userPersonaTemplates?: UserPersonaTemplate[]
  stitchFavorites?: PresetFavoriteSnapshot[]
  stitchTemplates?: PresetStitchTemplate[]
  stitchMainSide?: 'left' | 'right'
  frontendWorkshopRecentColors?: string[]
}

export interface CabinetLayoutEntry {
  kind: 'folder' | 'resource'
  id: string
  slot: number
  columnSpan: 1 | 2 | 4
  rowSpan: 1 | 2
}

export interface PresetStitchDraftEntry {
  origin: 'base' | 'pick'
  identifier: string
  enabled: boolean
  sourceResourceId?: string
  sourceName?: string
  favoriteId?: string
  name?: string
  role?: string
  content?: string
  prompt?: Record<string, unknown>
}

export interface PresetStitchDraft {
  baseId: string
  name: string
  savedAt: number
  entries: PresetStitchDraftEntry[]
  regexPickIds: string[]
  mainSide?: 'left' | 'right'
  sourceEdits?: Array<{
    sourceResourceId: string
    identifier: string
    name: string
    role: string
    content: string
  }>
  saveAsVersion?: boolean
  versionNote?: string
  candidates?: PresetFavoriteSnapshot[]
}

export interface ProjectNoticeStoragePlugin {
  getAcknowledgedVersion(): Promise<{ version?: string }>
  setAcknowledgedVersion(options: { version: string }): Promise<unknown>
}
