import type {
  CloudBackupItem,
  CloudBackupProvider,
  GitHubBackupConfig,
  WebDavBackupConfig,
} from '../types/CloudBackup'
import { type GitHubBundleManifest } from './GitHubBackupBundle'
import { type CloudObjectPlan, type StructuredSnapshot } from './CloudStructuredSnapshot'
import { CloudBackupMetricsTracker } from './CloudBackupMetrics'
import { CloudBackupJobStore } from './CloudBackupJobStore'

export const SNAPSHOT_RELEASE_TAG = 'srl-cloud-snapshots'

export const OBJECT_RELEASE_PREFIX = 'srl-cloud-objects-'

export const GITHUB_OBJECT_CONTAINER_LIMIT = 900

export const GITHUB_ASSET_CONFIRM_ATTEMPTS = 4

export const GITHUB_ASSET_CONFIRM_DELAY_MS = 600

export interface GitHubAsset {
  id: number
  name: string
  size: number
  digest?: string | null
  state?: string
  created_at: string
  url: string
  label?: string | null
}

export interface GitHubRelease {
  id: number
  assets: GitHubAsset[]
  tag_name?: string
}

export interface WebDavObject {
  objectKey: string
  size: number
  createdAt: number
}

export type WebDavVerifyMethod = 'range' | 'head' | 'propfind'

export interface WebDavCapabilities {
  verifyMethod: WebDavVerifyMethod
  probedAt: number
}

export type CloudBackupProgressCallback = (message: string) => void

export interface CloudBackupTransportContext {
  signal?: AbortSignal
  beginCommit?: () => void
  activeGitHubInventory:
    | {
        key: string
        assets: Map<number, Map<number, GitHubAsset>>
        releases: Map<string, GitHubRelease | undefined>
      }
    | undefined
  activeMetrics: CloudBackupMetricsTracker | undefined
  jobStore: CloudBackupJobStore
  activeWebDavInventory: { key: string; objects: Map<string, WebDavObject> } | undefined
  webDavCapabilities: Map<string, WebDavCapabilities>
  cloudFetch(url: string, init: RequestInit, provider: CloudBackupProvider): Promise<Response>
  readResponseBlob(response: Response, totalBytes?: number, fileName?: string): Promise<Blob>
  githubFetch(
    config: GitHubBackupConfig,
    secret: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response>
  ensureGitHubInitialCommit(config: GitHubBackupConfig, secret: string): Promise<boolean>
  getGitHubRelease(
    config: GitHubBackupConfig,
    secret: string,
    create: boolean,
    tag?: string,
    signal?: AbortSignal,
  ): Promise<GitHubRelease | undefined>
  listGitHubObjectContainers(config: GitHubBackupConfig, secret: string): Promise<GitHubRelease[]>
  listGitHubAssets(
    config: GitHubBackupConfig,
    secret: string,
    releaseId: number,
    signal?: AbortSignal,
  ): Promise<GitHubAsset[]>
  materializeCloudObject(plan: CloudObjectPlan): Promise<Blob>
  uploadGitHubAsset(
    config: GitHubBackupConfig,
    secret: string,
    releaseId: number,
    name: string,
    blob: Blob,
    contentType: string,
    label?: string,
    attempts?: number,
  ): Promise<GitHubAsset>
  confirmGitHubAssetSize(
    config: GitHubBackupConfig,
    secret: string,
    uploaded: GitHubAsset,
    expectedSize: number,
    expectedHash?: string,
  ): Promise<GitHubAsset | undefined>
  readGitHubStructuredSnapshot(
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<StructuredSnapshot>
  readGitHubPartInventory(
    config: GitHubBackupConfig,
    secret: string,
    parts: GitHubBundleManifest['parts'],
  ): Promise<Map<string, GitHubAsset>>
  readGitHubBundleManifest(
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<GitHubBundleManifest>
  ensureWebDavFolder(config: WebDavBackupConfig, secret: string): Promise<void>
  listWebDavObjects(config: WebDavBackupConfig, secret: string): Promise<WebDavObject[]>
  uploadWebDavObject(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
    blob: Blob,
    contentType?: string,
    onUploaded?: () => void,
  ): Promise<void>
  readWebDavRemoteSize(
    config: WebDavBackupConfig,
    secret: string,
    objectUrl: string,
  ): Promise<number>
  verifyWebDavUploadSize(
    config: WebDavBackupConfig,
    secret: string,
    objectUrl: string,
    expectedSize: number,
    remoteSize: number,
  ): Promise<void>
  readWebDavBundleManifest(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ): Promise<GitHubBundleManifest>
  readWebDavStructuredSnapshot(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
    onProgress?: CloudBackupProgressCallback,
  ): Promise<StructuredSnapshot>
}
