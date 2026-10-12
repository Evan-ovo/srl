import type { PersonalResourceSelection, PlainSecretCopy } from '../services/PersonalResourceBackup'
import type { Category, Resource, ResourceSummary } from './Resource'
import type { AppSetting } from './Resource'
import type {
  CommunitySourceAttachmentArchiveEntry,
  CommunitySourceBackupData,
} from './CommunitySource'
import type { PreviewPolicy, PortableAppearanceSettings } from '../services/BrowserStorageService'
import type { CharacterDrawState } from '../services/CharacterDrawService'
import type { GitHubBackupConfig, WebDavBackupConfig } from './CloudBackup'
import type { MainApiConfig, MainApiProfilesState } from '../services/MainApiService'
import type { FrontendWorkshopImageGenerationConfig } from '../services/FrontendWorkshopImageGenerationService'
import type { FrontendWorkshopSelfHostedImageBedConfig } from '../services/FrontendWorkshopImageHostingService'
import type { DiscordSourceConnectionSettings } from '../services/DiscordSourceSettingsService'
import type { AiTaggingDraft, AiTaggingUndoRecord } from '../services/AiTaggingDraftService'
import type { ExternalAppDataRecord, InstalledExternalApp } from './ExternalApp'
import type { PresetStitchDraft } from '../services/BrowserStorageService'

export const ARCHIVE_FORMAT = 'srl-archive'
export const ARCHIVE_VERSION = 4
export const COMMUNITY_SOURCE_ARCHIVE_PATH = 'community-sources.json'
export const COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX = 'community-sources/assets/'

export type ArchiveMode = 'full' | 'partial'
export type RestoreMode = 'merge' | 'replace'

export interface ArchivePortableSelection {
  resourceGallery?: boolean
  personalResources?: PersonalResourceSelection
  plaintextSecretCopy?: boolean
  appearance?: boolean
  cloudBackup?: boolean
  characterDraw?: boolean
  generalPreferences?: boolean
  mainApiProfiles?: boolean
  aiTaggingState?: boolean
  externalApps?: boolean
  chatReader?: boolean
  assistantData?: boolean
  stitchWork?: boolean
  frontendWorkshopComponents?: boolean
  /** 完整社区帖子/评论快照与已经本地化的 Discord 附件；不包含 Discord / Worker 凭据。 */
  communitySources?: boolean
}

export interface ArchivePortableData {
  resourceGalleryCategories?: import('./ResourceGallery').GalleryCategoryCatalog
  chatReader?: ExternalAppDataRecord[]
  /** 蒜惹菈聊天、记忆、项目、模板与偏好；只有明确选择时才随备份迁移。 */
  assistantData?: AppSetting[]
  /** Explicit opt-in readable companion; encrypted originals remain in the resource archive. */
  plaintextSecretCopies?: PlainSecretCopy[]
  version: 1
  appearance?: PortableAppearanceSettings
  cloudBackup?: {
    activeProvider?: 'github' | 'webdav'
    github?: GitHubBackupConfig
    webdav?: WebDavBackupConfig
  }
  characterDraw?: {
    state: CharacterDrawState
    showNames: boolean
  }
  generalPreferences?: {
    previewPolicy: PreviewPolicy
    extractCharacterAssets: boolean
    hideCharacterAssets: boolean
    hideChatDisplayRegex?: boolean
    showManuallyBoundResources?: boolean
    searchHistory: string[]
  }
  /** 包含 API Key；只能在用户明确选择时迁移。 */
  mainApiProfiles?: MainApiProfilesState
  /** 其它本机凭据；与主 API 密钥共用同一个显式迁移选择。 */
  credentials?: {
    version: 1
    /** @deprecated 仅为旧备份恢复兼容；新备份不再写出生图 API Key。 */
    imageGeneration?: FrontendWorkshopImageGenerationConfig[]
    imageHosting?: FrontendWorkshopSelfHostedImageBedConfig
    legacyFrontendWorkshopApi?: MainApiConfig
    productAssistantApi?: MainApiConfig
    discordSource?: DiscordSourceConnectionSettings
    cloudBackup?: Partial<Record<'github' | 'webdav', string>>
  }
  aiTaggingState?: {
    draft?: AiTaggingDraft
    undo?: AiTaggingUndoRecord
  }
  /** 第三方代码及其授权状态；恢复后保持禁用，需用户重新启用。 */
  externalApps?: {
    apps: InstalledExternalApp[]
    data: ExternalAppDataRecord[]
  }
  stitchWork?: {
    draft?: PresetStitchDraft
    checkpoint?: PresetStitchDraft
    recentPresets?: string[]
  }
  frontendWorkshopComponents?: import('./FrontendWorkshopSourceComponent').FrontendWorkshopSourceComponent[]
}

export interface ArchivedResource extends Omit<Resource, 'originalBlob' | 'thumbnailBlob'> {
  archivePath: string
}

export interface ArchiveCommunitySourcesDescriptor {
  version: 1
  path: typeof COMMUNITY_SOURCE_ARCHIVE_PATH
  sourceCount: number
  messageCount: number
  bindingCount: number
  /** v4 的向后兼容扩展；旧备份没有这两个字段。 */
  attachmentCount?: number
  attachmentPathPrefix?: typeof COMMUNITY_SOURCE_ATTACHMENT_ARCHIVE_PREFIX
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT
  version: number
  mode: ArchiveMode
  resourceContent?: 'original' | 'modified'
  createdAt: string
  resourceCount: number
  categoryCount: number
  categories: Category[]
  resources: ArchivedResource[]
  versionCount?: number
  versions?: ArchivedResource[]
  portableData?: ArchivePortableData
  communitySources?: ArchiveCommunitySourcesDescriptor
}

export interface ArchiveOptions {
  personalResources?: PersonalResourceSelection
  mode: ArchiveMode
  resourceContent?: 'original' | 'modified'
  resourceIds?: string[]
  includeAllCategories?: boolean
  /** Local recovery archives retain links to resources that were not deleted. */
  preserveExternalRelatedResourceIds?: boolean
  splitSizeBytes?: number
  portableData?: ArchivePortableData
  /** UI 选择只用于决定是否向来源 Owner 请求快照，不写入 manifest。 */
  portableSelection?: ArchivePortableSelection
  /** 由来源 Owner 准备的完整本地来源快照；ExportService 只负责按导出资源范围裁剪。 */
  communitySourceData?: CommunitySourceBackupData
  /** 与 communitySourceData 同源的本地附件二进制；ExportService 会按最终来源范围裁剪。 */
  communitySourceAttachments?: CommunitySourceAttachmentArchiveEntry[]
}

export interface CreatedArchive {
  blob: Blob
  fileName: string
  manifest: ArchiveManifest
}

export interface RestorePreview {
  fileName: string
  mode: ArchiveMode
  createdAt: string
  archiveResourceCount: number
  resourcesToAdd: number
  duplicatesToSkip: number
  conflictsToPreserve: number
  categoriesToCreate: number
  categoriesToReuse: number
  portableSections?: string[]
  communitySourceCount?: number
  communityMessageCount?: number
  communityAttachmentCount?: number
}

export interface PreparedRestore {
  /** Durable plan references; file bodies remain in the existing staging owner. */
  staging?: { jobId: string; paths: [string, string][] }
  checkpointId?: string
  /** Replans the verified archive against an empty library before a full replacement. */
  forReplacement?: () => Promise<PreparedRestore>
  /** Opens staged, verified entries for the commit, then releases their bounded temporary data. */
  openFiles?: () => Promise<{
    hydrate: (resource: Resource) => Promise<Resource>
    dispose: () => Promise<void>
  }>
  /** Releases staged data if the user closes the preview without restoring. */
  dispose?: () => Promise<void>

  preview: RestorePreview
  /** Existing duplicate owners remain selectable for their newly restored gallery attachments. */
  galleryOwners?: ResourceSummary[]
  resources: Resource[]
  versions: Resource[]
  categories: Category[]
  portableData?: ArchivePortableData
  communitySourceData?: CommunitySourceBackupData
  communitySourceAttachments?: CommunitySourceAttachmentArchiveEntry[]
}

export interface RestoreReport {
  restoredResources: number
  restoredVersions?: number
  skippedDuplicates: number
  preservedConflicts: number
  createdCategories: number
  reusedCategories: number
  restoredCommunitySources?: number
  restoredCommunityMessages?: number
  restoredCommunityAttachments?: number
}
