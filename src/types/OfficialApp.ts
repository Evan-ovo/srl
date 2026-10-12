export const OFFICIAL_APP_IDS = [
  'chatReader',
  'draw',
  'stitch',
  'frontendWorkshop',
  'imageGeneration',
  'imageAlbum',
  'userPersona',
  'tavernBridge',
  'assistant',
] as const
export type OfficialAppId = (typeof OFFICIAL_APP_IDS)[number]
export function isOfficialAppId(value: string): value is OfficialAppId {
  return (OFFICIAL_APP_IDS as readonly string[]).includes(value)
}
export interface OfficialAppFile {
  path: string
  size: number
  sha256: string
  bundled?: boolean
}
export interface OfficialAppPackage {
  schemaVersion: 1
  id: OfficialAppId
  shellVersion: string
  /** Packages own their bytes, but components must share the shell's Vue runtime. */
  assetMode?: 'host' | 'self-contained'
  /** Singleton runtime chunks that must also belong to the currently running shell. */
  hostFiles?: OfficialAppFile[]
  /** Content-addressed Vue entry used by both the APP and the shell renderer. */
  runtimeEntry?: string
  /** Bump only when installed APPs must be rebuilt for an incompatible host API change. */
  hostApiVersion?: number
  /** Integrity fingerprint of APP-owned files; this does not determine update notifications. */
  appContentHash?: string
  /** Explicit update revision; bump only when this APP's behavior or owned resources change. */
  appContentRevision?: number
  entry: string
  styles: string[]
  files: OfficialAppFile[]
}
export interface InstalledOfficialApp extends OfficialAppPackage {
  installedAt: number
  /** Files left for retry when post-install cleanup could not remove old package assets. */
  pendingCleanupFiles?: OfficialAppFile[]
}
export interface OfficialAppDownload {
  runtimeEntry?: string
  shellVersion: string
  hostApiVersion: number
  assetMode?: 'host' | 'self-contained'
  appContentHash: string
  appContentRevision: number
  hostFiles: OfficialAppFile[]
  url: string
  sha256: string
  downloadBytes: number
  installedBytes: number
  entry: string
}
export interface OfficialAppCatalog {
  schemaVersion: 1
  hostApiVersion: number
  apps: Record<OfficialAppId, OfficialAppDownload[]>
}
/** Build-specific catalog embedded in packaged APKs; each APP has one package, not a list. */
export interface OfficialAppBuildCatalog {
  schemaVersion: 1
  shellVersion: string
  hostApiVersion: number
  apps: Partial<Record<OfficialAppId, OfficialAppDownload>>
}
export interface OfficialAppUpdateInfo {
  currentVersion: string
  latestVersion: string
  latestShellVersion: string
  requiresHostUpdate: boolean
  requiresAssetRepair?: boolean
}
export interface OfficialAppInstallProgress {
  id: OfficialAppId
  stage: 'queued' | 'downloading' | 'checking' | 'waiting' | 'installing' | 'done' | 'failed'
  downloadedBytes?: number
  totalBytes?: number
  completedFiles?: number
  totalFiles?: number
  message?: string
}
export interface OfficialAppInstallResult {
  id: OfficialAppId
  error?: Error
}
export const OFFICIAL_APP_ASSET_CACHE = 'srl-official-app-assets-v1'

export const OFFICIAL_APP_DATA_DESCRIPTION: Record<OfficialAppId, string> = {
  chatReader: '阅读进度、备注、收藏、回复选择和阅读外观；资源库中的聊天、角色卡和正则原件保留',
  draw: '抽取记录和显示偏好',
  stitch: '缝合草稿、恢复点、模板、收藏段落和最近使用记录',
  frontendWorkshop:
    '全部本地前端工程、源码、历史、恢复点、组件、旧草稿和最近颜色；共用 API 与图床设置保留',
  imageGeneration: '生图草稿、模板、接口设置及本机保存的生图密钥；已保存的相册图片保留',
  imageAlbum: '全部本地相册记录及原图；云端图片和资源库中的副本保留',
  userPersona: '人设模板；资源库中的人设文件保留',
  tavernBridge: '当前互传会话随页面关闭结束；已归档的资源和酒馆原件保留',
  assistant:
    '本机助手对话、记忆、偏好、独立 APP 项目与任务模板；共用 API 配置和助手 CSS 单独选择是否清理',
}
