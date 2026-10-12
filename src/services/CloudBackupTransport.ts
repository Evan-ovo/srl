import type {
  CloudBackupItem,
  CloudBackupProvider,
  GitHubBackupConfig,
  WebDavBackupConfig,
} from '../types/CloudBackup'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import {
  acquireRelayWorkerTarget,
  relayWorkerEndpoint,
  resolveRelayWorkerTarget,
} from './RelayWorkerSettingsService'
import { hashCloudBlob } from './CloudArchiveCodec'
import * as CloudBackupGitHubTransport from './CloudBackupGitHubTransport'
import {
  cloudProxyUnavailableError,
  fetchWithDeadline,
  isCloudRequestTimeout,
  proxyPayloadTooLargeError,
} from './CloudBackupHttp'
import { CloudBackupJobStore } from './CloudBackupJobStore'
import { LEGACY_RELEASE_TAG } from './CloudBackupPolicy'
import {
  type CloudBackupProgressCallback,
  type CloudBackupTransportContext,
  type GitHubAsset,
  type GitHubRelease,
  type WebDavCapabilities,
  type WebDavObject,
} from './CloudBackupTransportContext'
import * as CloudBackupWebDavTransport from './CloudBackupWebDavTransport'
import {
  type CloudObjectPlan,
  isStructuredSnapshotObjectKey,
  type CreatedStructuredSnapshot,
  type StructuredSnapshot,
} from './CloudStructuredSnapshot'
import { type GitHubBundleManifest } from './GitHubBackupBundle'
import { isNativeCloudTransferAvailable, nativeWebDavFetch } from './NativeCloudTransfer'

/** Shared transport state and provider dispatch for one backup service instance. */
export class CloudBackupTransport {
  private relayWorkerScope?: ReturnType<typeof acquireRelayWorkerTarget> & { users: number }

  protected async withRelayWorkerTarget<T>(
    provider: CloudBackupProvider | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (provider !== 'webdav' || isCapacitorApp()) return run()
    const scope = this.relayWorkerScope ?? { ...acquireRelayWorkerTarget(), users: 0 }
    this.relayWorkerScope = scope
    scope.users += 1
    try {
      return await run()
    } finally {
      scope.users -= 1
      if (!scope.users) {
        scope.release()
        this.relayWorkerScope = undefined
      }
    }
  }
  protected readonly transportState: Pick<
    CloudBackupTransportContext,
    | 'webDavCapabilities'
    | 'activeMetrics'
    | 'activeGitHubInventory'
    | 'activeWebDavInventory'
    | 'jobStore'
  > = {
    webDavCapabilities: new Map<string, WebDavCapabilities>(),
    activeMetrics: undefined,
    activeGitHubInventory: undefined,
    activeWebDavInventory: undefined,
    jobStore: new CloudBackupJobStore(),
  }

  protected transportContext?: CloudBackupTransportContext

  protected getTransportContext(): CloudBackupTransportContext {
    if (this.transportContext) return this.transportContext
    const state = this.transportState
    this.transportContext = {
      get activeGitHubInventory() {
        return state.activeGitHubInventory
      },
      set activeGitHubInventory(value) {
        state.activeGitHubInventory = value
      },
      get activeMetrics() {
        return state.activeMetrics
      },
      set activeMetrics(value) {
        state.activeMetrics = value
      },
      get jobStore() {
        return state.jobStore
      },
      get activeWebDavInventory() {
        return state.activeWebDavInventory
      },
      set activeWebDavInventory(value) {
        state.activeWebDavInventory = value
      },
      get webDavCapabilities() {
        return state.webDavCapabilities
      },
      cloudFetch: (...args) => this.cloudFetch(...args),
      readResponseBlob: (response) => response.blob(),
      githubFetch: (...args) => this.githubFetch(...args),
      ensureGitHubInitialCommit: (...args) => this.ensureGitHubInitialCommit(...args),
      getGitHubRelease: (...args) => this.getGitHubRelease(...args),
      listGitHubObjectContainers: (...args) => this.listGitHubObjectContainers(...args),
      listGitHubAssets: (...args) => this.listGitHubAssets(...args),
      materializeCloudObject: (...args) => this.materializeCloudObject(...args),
      uploadGitHubAsset: (...args) => this.uploadGitHubAsset(...args),
      confirmGitHubAssetSize: (...args) => this.confirmGitHubAssetSize(...args),
      readGitHubStructuredSnapshot: (...args) => this.readGitHubStructuredSnapshot(...args),
      readGitHubPartInventory: (...args) => this.readGitHubPartInventory(...args),
      readGitHubBundleManifest: (...args) => this.readGitHubBundleManifest(...args),
      ensureWebDavFolder: (...args) => this.ensureWebDavFolder(...args),
      listWebDavObjects: (...args) => this.listWebDavObjects(...args),
      uploadWebDavObject: (...args) => this.uploadWebDavObject(...args),
      readWebDavRemoteSize: (...args) => this.readWebDavRemoteSize(...args),
      verifyWebDavUploadSize: (...args) => this.verifyWebDavUploadSize(...args),
      readWebDavBundleManifest: (...args) => this.readWebDavBundleManifest(...args),
      readWebDavStructuredSnapshot: (...args) => this.readWebDavStructuredSnapshot(...args),
    }
    return this.transportContext!
  }

  protected async cloudFetch(
    url: string,
    init: RequestInit,
    provider: CloudBackupProvider,
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const measuredFetch = async (target: string, request: RequestInit): Promise<Response> => {
      const started = typeof performance === 'undefined' ? Date.now() : performance.now()
      const metrics = this.transportState.activeMetrics
      metrics?.add('httpRequestCount', 1)
      try {
        const bodyKind =
          method === 'GET' && isStructuredSnapshotObjectKey(new URL(url).pathname)
            ? 'metadata'
            : 'auto'
        const response = await fetchWithDeadline(target, request, bodyKind)
        // Accepted HTTP bodies, not pre-counted planned bytes or verified unique objects.
        if (response.ok && request.body instanceof Blob)
          metrics?.add('uploadedBytes', request.body.size)
        return response
      } finally {
        const finished = typeof performance === 'undefined' ? Date.now() : performance.now()
        metrics?.add('networkMs', finished - started)
      }
    }
    if (provider === 'github') {
      return measuredFetch(url, init)
    }
    if (
      provider === 'webdav' &&
      isNativeCloudTransferAvailable() &&
      (method === 'MKCOL' || method === 'PROPFIND')
    ) {
      const started = typeof performance === 'undefined' ? Date.now() : performance.now()
      this.transportState.activeMetrics?.add('httpRequestCount', 1)
      try {
        return await nativeWebDavFetch(url, init)
      } finally {
        const finished = typeof performance === 'undefined' ? Date.now() : performance.now()
        this.transportState.activeMetrics?.add('networkMs', finished - started)
      }
    }
    if (isCapacitorApp()) return measuredFetch(url, init)

    // SRL-PUBLIC-SYNC: BEGIN WORKER-URL id=koofr-proxy
    const relayTarget = this.relayWorkerScope?.target ?? resolveRelayWorkerTarget()
    const proxyFetch = async (): Promise<Response> => {
      const path = `/api/cloud/proxy/koofr?url=${encodeURIComponent(url)}`
      const proxyUrl = relayTarget.custom ? relayWorkerEndpoint(path, relayTarget).href : path
      const headers = new Headers(init.headers)
      if (init.body instanceof Blob) {
        headers.set('X-SRL-Content-Length', String(init.body.size))
      }
      const proxyInit = {
        ...init,
        headers,
        credentials: relayTarget.custom ? ('omit' as const) : ('same-origin' as const),
        redirect: 'error' as const,
        cache: 'no-store' as const,
      }
      return measuredFetch(proxyUrl, proxyInit)
    }
    // SRL-PUBLIC-SYNC: END WORKER-URL id=koofr-proxy
    try {
      const response = await proxyFetch()
      if (response.status === 413) throw proxyPayloadTooLargeError(init.body)
      if (response.headers.get('x-srl-cloud-proxy') !== '1') {
        throw new Error('当前站点没有可用的 Koofr 同源代理')
      }
      return response
    } catch (error) {
      if (isCloudRequestTimeout(error) || (error instanceof Error && /（413）/.test(error.message)))
        throw error
      if (relayTarget.custom)
        throw new Error(
          '自建中继未完成 Koofr 请求。请检查设置 → 自部署 Worker 中的地址、部署状态及 CORS 配置；不会自动切回官方中继。',
          { cause: error },
        )
      throw cloudProxyUnavailableError(error)
    }
  }

  protected async githubFetch(
    config: GitHubBackupConfig,
    secret: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return CloudBackupGitHubTransport.githubFetch(
      this.getTransportContext(),
      config,
      secret,
      path,
      init,
    )
  }

  protected async ensureGitHubInitialCommit(
    config: GitHubBackupConfig,
    secret: string,
  ): Promise<boolean> {
    return CloudBackupGitHubTransport.ensureGitHubInitialCommit(
      this.getTransportContext(),
      config,
      secret,
    )
  }

  protected async getGitHubRelease(
    config: GitHubBackupConfig,
    secret: string,
    create: boolean,
    tag = LEGACY_RELEASE_TAG,
  ): Promise<GitHubRelease | undefined> {
    return CloudBackupGitHubTransport.getGitHubRelease(
      this.getTransportContext(),
      config,
      secret,
      create,
      tag,
    )
  }

  protected async materializeCloudObject(plan: CloudObjectPlan): Promise<Blob> {
    const hydratedLazily = !plan.blob
    const blob = plan.blob ?? (await plan.loadBlob?.())
    if (!blob) throw new Error(`云备份对象缺少本机来源：${plan.name}`)
    if (blob.size !== plan.size) throw new Error(`云备份对象本机大小已变化：${plan.name}`)
    if (hydratedLazily && (await hashCloudBlob(blob)) !== plan.hash.toLowerCase()) {
      throw new Error(`云备份对象本机摘要校验失败：${plan.name}`)
    }
    return blob
  }

  protected async uploadGitHubStructuredBackup(
    config: GitHubBackupConfig,
    secret: string,
    snapshot: CreatedStructuredSnapshot,
    onProgress?: CloudBackupProgressCallback,
    respectAutomaticConstraints = false,
  ): Promise<CloudBackupItem> {
    return CloudBackupGitHubTransport.uploadGitHubStructuredBackup(
      this.getTransportContext(),
      config,
      secret,
      snapshot,
      onProgress,
      respectAutomaticConstraints,
    )
  }

  protected async uploadGitHubAsset(
    config: GitHubBackupConfig,
    secret: string,
    releaseId: number,
    name: string,
    blob: Blob,
    contentType: string,
    label?: string,
    attempts = 1,
  ): Promise<GitHubAsset> {
    return CloudBackupGitHubTransport.uploadGitHubAsset(
      this.getTransportContext(),
      config,
      secret,
      releaseId,
      name,
      blob,
      contentType,
      label,
      attempts,
    )
  }

  protected async confirmGitHubAssetSize(
    config: GitHubBackupConfig,
    secret: string,
    uploaded: GitHubAsset,
    expectedSize: number,
  ): Promise<GitHubAsset | undefined> {
    return CloudBackupGitHubTransport.confirmGitHubAssetSize(
      this.getTransportContext(),
      config,
      secret,
      uploaded,
      expectedSize,
    )
  }

  protected listGitHubObjectContainers(
    config: GitHubBackupConfig,
    secret: string,
  ): Promise<GitHubRelease[]> {
    return CloudBackupGitHubTransport.listGitHubObjectContainers(
      this.getTransportContext(),
      config,
      secret,
    )
  }

  protected async listGitHubAssets(
    config: GitHubBackupConfig,
    secret: string,
    releaseId: number,
  ): Promise<GitHubAsset[]> {
    return CloudBackupGitHubTransport.listGitHubAssets(
      this.getTransportContext(),
      config,
      secret,
      releaseId,
    )
  }

  protected async readGitHubPartInventory(
    config: GitHubBackupConfig,
    secret: string,
    parts: GitHubBundleManifest['parts'],
  ): Promise<Map<string, GitHubAsset>> {
    return CloudBackupGitHubTransport.readGitHubPartInventory(
      this.getTransportContext(),
      config,
      secret,
      parts,
    )
  }

  protected async listGitHub(
    config: GitHubBackupConfig,
    secret: string,
    onProgress?: CloudBackupProgressCallback,
  ): Promise<CloudBackupItem[]> {
    return CloudBackupGitHubTransport.listGitHub(
      this.getTransportContext(),
      config,
      secret,
      onProgress,
    )
  }

  protected async readGitHubBundleManifest(
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<GitHubBundleManifest> {
    return CloudBackupGitHubTransport.readGitHubBundleManifest(
      this.getTransportContext(),
      config,
      secret,
      item,
    )
  }

  protected async readGitHubStructuredSnapshot(
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<StructuredSnapshot> {
    return CloudBackupGitHubTransport.readGitHubStructuredSnapshot(
      this.getTransportContext(),
      config,
      secret,
      item,
    )
  }

  protected async createGitHubObjectReader(
    config: GitHubBackupConfig,
    secret: string,
  ): Promise<(object: GitHubBundleManifest) => Promise<Blob>> {
    return CloudBackupGitHubTransport.createGitHubObjectReader(
      this.getTransportContext(),
      config,
      secret,
    )
  }

  protected async downloadGitHubBundle(
    config: GitHubBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<Blob> {
    return CloudBackupGitHubTransport.downloadGitHubBundle(
      this.getTransportContext(),
      config,
      secret,
      item,
    )
  }

  protected async ensureWebDavFolder(config: WebDavBackupConfig, secret: string): Promise<void> {
    return CloudBackupWebDavTransport.ensureWebDavFolder(this.getTransportContext(), config, secret)
  }

  protected async uploadWebDavStructuredBackup(
    config: WebDavBackupConfig,
    secret: string,
    snapshot: CreatedStructuredSnapshot,
    onProgress?: CloudBackupProgressCallback,
    respectAutomaticConstraints = false,
  ): Promise<CloudBackupItem> {
    return CloudBackupWebDavTransport.uploadWebDavStructuredBackup(
      this.getTransportContext(),
      config,
      secret,
      snapshot,
      onProgress,
      respectAutomaticConstraints,
    )
  }

  protected async uploadWebDavObject(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
    blob: Blob,
    contentType = 'application/octet-stream',
    onUploaded?: () => void,
  ): Promise<void> {
    return CloudBackupWebDavTransport.uploadWebDavObject(
      this.getTransportContext(),
      config,
      secret,
      objectKey,
      blob,
      contentType,
      onUploaded,
    )
  }

  protected async readWebDavRemoteSize(
    config: WebDavBackupConfig,
    secret: string,
    objectUrl: string,
  ): Promise<number> {
    return CloudBackupWebDavTransport.readWebDavRemoteSize(
      this.getTransportContext(),
      config,
      secret,
      objectUrl,
    )
  }

  protected async verifyWebDavUploadSize(
    config: WebDavBackupConfig,
    secret: string,
    objectUrl: string,
    expectedSize: number,
    remoteSize: number,
  ): Promise<void> {
    return CloudBackupWebDavTransport.verifyWebDavUploadSize(
      this.getTransportContext(),
      config,
      secret,
      objectUrl,
      expectedSize,
      remoteSize,
    )
  }

  protected async listWebDavObjects(
    config: WebDavBackupConfig,
    secret: string,
  ): Promise<WebDavObject[]> {
    return CloudBackupWebDavTransport.listWebDavObjects(this.getTransportContext(), config, secret)
  }

  protected async listWebDavRetentionObjects(
    config: WebDavBackupConfig,
    secret: string,
  ): Promise<WebDavObject[]> {
    return CloudBackupWebDavTransport.listWebDavObjects(
      this.getTransportContext(),
      config,
      secret,
      ['', 'snapshots'],
    )
  }

  protected async listWebDav(
    config: WebDavBackupConfig,
    secret: string,
    onProgress?: CloudBackupProgressCallback,
    onWarning?: CloudBackupProgressCallback,
  ): Promise<CloudBackupItem[]> {
    return CloudBackupWebDavTransport.listWebDav(
      this.getTransportContext(),
      config,
      secret,
      onProgress,
      onWarning,
    )
  }

  protected async readWebDavBundleManifest(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ): Promise<GitHubBundleManifest> {
    return CloudBackupWebDavTransport.readWebDavBundleManifest(
      this.getTransportContext(),
      config,
      secret,
      objectKey,
    )
  }

  protected async readWebDavStructuredSnapshot(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
    onProgress?: CloudBackupProgressCallback,
  ): Promise<StructuredSnapshot> {
    return CloudBackupWebDavTransport.readWebDavStructuredSnapshot(
      this.getTransportContext(),
      config,
      secret,
      objectKey,
      onProgress,
    )
  }

  protected createWebDavObjectReader(
    config: WebDavBackupConfig,
    secret: string,
  ): (object: GitHubBundleManifest) => Promise<Blob> {
    return CloudBackupWebDavTransport.createWebDavObjectReader(
      this.getTransportContext(),
      config,
      secret,
    )
  }

  protected async downloadWebDavBundle(
    config: WebDavBackupConfig,
    secret: string,
    item: CloudBackupItem,
  ): Promise<Blob> {
    return CloudBackupWebDavTransport.downloadWebDavBundle(
      this.getTransportContext(),
      config,
      secret,
      item,
    )
  }

  protected async deleteWebDavObject(
    config: WebDavBackupConfig,
    secret: string,
    objectKey: string,
  ): Promise<void> {
    return CloudBackupWebDavTransport.deleteWebDavObject(
      this.getTransportContext(),
      config,
      secret,
      objectKey,
    )
  }
}
