import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

import { transferNativeStream } from '../core/NativeStreamTransfer'
import { taskCenter } from '../core/TaskCenter'
import type {
  CloudBackupConfig,
  CloudBackupMetrics,
  CloudBackupProvider,
} from '../types/CloudBackup'
import type { CloudObjectSource } from './CloudStructuredSnapshot'

interface NativeCloudJobStatus {
  requestId?: string
  resourceResults?: Array<{ hash: string; error?: string }>
  id: string
  kind?: 'upload' | 'restore'
  provider: CloudBackupProvider
  automatic?: boolean
  status: 'staging' | 'queued' | 'running' | 'committing' | 'completed' | 'failed' | 'cancelled'
  completed: number
  total: number
  updatedAt: number
  error?: string
  resultId?: string
  resultName?: string
  uploadedBytes?: number
  totalBytes?: number
  httpRequestCount?: number
  retryCount?: number
  networkMs?: number
  verifyMs?: number
}

interface NativeCloudTransferPlugin {
  addListener(
    eventName: 'jobProgress',
    listener: (state: NativeCloudJobStatus) => void,
  ): Promise<PluginListenerHandle>
  webDavRequest(options: {
    url: string
    method: 'MKCOL' | 'PROPFIND'
    headers: Record<string, string>
  }): Promise<{ status: number; headers?: Record<string, string>; body?: string }>
  saveCredential(options: { provider: CloudBackupProvider; secret: string }): Promise<void>
  clearCredential(options: { provider: CloudBackupProvider }): Promise<void>
  invalidateCredential(options: { provider: CloudBackupProvider }): Promise<void>
  readCredential(options: {
    provider: CloudBackupProvider
  }): Promise<{ present: boolean; valid: boolean; secret?: string }>
  saveAppCredential(options: { identifier: string; secret: string }): Promise<void>
  readAppCredential(options: { identifier: string }): Promise<{ secret?: string }>
  clearAppCredential(options: { identifier: string }): Promise<void>
  beginJob(options: {
    config: Record<string, unknown>
    secret: string
    wifiOnly: boolean
    chargingOnly: boolean
    automatic: boolean
    expectedTotal: number
  }): Promise<{ jobId: string; pipeline?: boolean }>
  beginObject(options: {
    jobId: string
    name: string
    contentType: string
    size: number
    manifest: boolean
    existingId?: string
    releaseId?: number
  }): Promise<{ token: string }>
  stageObjectFromLibrary(options: {
    jobId: string
    name: string
    contentType: string
    existingId?: string
    releaseId?: number
    sourceHash: string
    offset: number
    size: number
  }): Promise<{ staged: boolean }>
  stageObjectFromSources(options: {
    jobId: string
    name: string
    contentType: string
    existingId?: string
    releaseId?: number
    segments: Array<{ contentHash: string; offset: number; size: number }>
  }): Promise<{ staged: boolean }>
  stageObjectFromFile(options: {
    jobId: string
    name: string
    contentType: string
    existingId?: string
    releaseId?: number
    uri: string
    offset: number
    size: number
  }): Promise<{ staged: boolean }>
  probeLibraryObject(options: {
    sourceHash: string
    minimumSize: number
  }): Promise<{ available: boolean; size: number }>
  probeLibraryObjects?(options: {
    sources: Array<{ sourceHash: string; minimumSize: number }>
  }): Promise<{ available: boolean }>
  appendObject(options: { token: string; data: string }): Promise<void>
  commitObject(options: { token: string }): Promise<void>
  abortObject(options: { token: string }): Promise<void>
  startJob(options: { jobId: string }): Promise<NativeCloudJobStatus>
  finishJobStaging(options: { jobId: string }): Promise<NativeCloudJobStatus>
  getJob(options: { jobId: string }): Promise<NativeCloudJobStatus>
  getLatestJob(options: {
    provider?: CloudBackupProvider
    kind?: 'upload' | 'restore'
  }): Promise<(NativeCloudJobStatus & { present: true }) | { present: false }>
  cancelJob(options: { jobId: string }): Promise<{ cancelled: boolean; status: string }>
  cancelRestore(options: { requestId: string }): Promise<void>
  restoreStructuredFiles(options: {
    config: Record<string, unknown>
    secret: string
    objects: NativeRestoreObject[]
    resources: NativeRestoreResource[]
    requestId?: string
    progressive?: boolean
  }): Promise<NativeRestoreResult>
  readRestoredCardMetadata(options: {
    hash: string
    size: number
    fileName: string
  }): Promise<NativeRestoreMetadata>
}

const nativeTransfer = registerPlugin<NativeCloudTransferPlugin>('NativeCloudTransfer')
let activeJobId = ''

/** 原生桥接按 512 KiB 分段写入；单对象上限与 Android 原生暂存边界一致。 */
export const NATIVE_CLOUD_MAX_STAGED_OBJECT_BYTES = 256 * 1024 * 1024

export interface NativeUploadObject {
  name: string
  blob?: Blob
  size?: number
  contentType: string
  existingId?: string
  releaseId?: number
  nativeSource?: CloudObjectSource
}

export interface NativeUploadResult {
  id: string
  name: string
  metrics: Partial<CloudBackupMetrics>
}

export interface NativeRestoreObject {
  url: string
  hash: string
  size: number
}

export interface NativeRestoreResource {
  hash: string
  size: number
  type: string
  fileName: string
  segments: Array<{ hash: string; offset: number; size: number }>
}

export interface NativeRestoreMetadata {
  hash: string
  card: Record<string, unknown>
  thumbnailBase64?: string
  thumbnailMimeType?: string
}

export interface NativeRestoreResult {
  downloaded: number
  reused: number
  assembled: number
  failures?: Array<{ hash: string; error: string }>
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function nativeJobMetrics(state: NativeCloudJobStatus): Partial<CloudBackupMetrics> {
  return {
    uploadedBytes: state.uploadedBytes ?? 0,
    httpRequestCount: state.httpRequestCount ?? 0,
    retryCount: state.retryCount ?? 0,
    networkMs: state.networkMs ?? 0,
    verifyMs: state.verifyMs ?? 0,
  }
}

export function isNativeCloudTransferAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

function hasValidNativeSource(object: NativeUploadObject): boolean {
  const source = object.nativeSource
  if (!source || source.kind === 'inline') return false
  if (source.kind === 'file')
    return (
      Boolean(source.uri) &&
      Number.isSafeInteger(source.offset) &&
      source.offset >= 0 &&
      Number.isSafeInteger(source.size) &&
      source.size >= 0 &&
      Number.isSafeInteger(source.offset + source.size) &&
      source.size === (object.size ?? object.blob?.size)
    )
  const segments = source.kind === 'range' ? [source] : source.segments
  if (!segments.length) return false
  let total = 0
  for (const segment of segments) {
    if (!/^[a-f0-9]{64}$/iu.test(segment.contentHash)) return false
    if (!Number.isSafeInteger(segment.offset) || segment.offset < 0) return false
    if (!Number.isSafeInteger(segment.size) || segment.size < 0) return false
    const end = segment.offset + segment.size
    if (!Number.isSafeInteger(end) || end < segment.size) return false
    total += segment.size
    if (!Number.isSafeInteger(total)) return false
  }
  return total === (object.size ?? object.blob?.size)
}

/**
 * Native Cloud job 创建前的 capability probe。
 * 最终清单允许有界 inline；资源对象只有在 NativeLibrary 原件真实存在时才能进入 Native job。
 */
export async function canUseNativeStructuredSnapshotHandoff(options: {
  objects: NativeUploadObject[]
  manifest: NativeUploadObject
}): Promise<boolean> {
  if (!isNativeCloudTransferAvailable()) return false
  if (!options.manifest.blob || options.manifest.blob.size > NATIVE_CLOUD_MAX_STAGED_OBJECT_BYTES)
    return false

  const minimumSizeByHash = new Map<string, number>()
  for (const object of options.objects) {
    if (!hasValidNativeSource(object)) return false
    const source = object.nativeSource
    if (!source || source.kind === 'inline') return false
    if (source.kind === 'file') continue // The native stage method validates and snapshots its controlled path.
    const segments = source.kind === 'range' ? [source] : source.segments
    for (const segment of segments) {
      const minimumSize = segment.offset + segment.size
      minimumSizeByHash.set(
        segment.contentHash,
        Math.max(minimumSizeByHash.get(segment.contentHash) ?? 0, minimumSize),
      )
    }
  }

  const sources = [...minimumSizeByHash].map(([sourceHash, minimumSize]) => ({
    sourceHash,
    minimumSize,
  }))
  if (nativeTransfer.probeLibraryObjects) {
    try {
      return (await nativeTransfer.probeLibraryObjects({ sources })).available
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'UNIMPLEMENTED'
      ) {
        // Native source 不完整时 fail closed；APK 不再回退到 JS Blob 网络。
        return false
      }
    }
  }

  // Old APK compatibility: only APKs without the bounded batch method use one
  // bridge request per unique object. Current APKs check the whole source set once.
  try {
    for (const { sourceHash, minimumSize } of sources) {
      const result = await nativeTransfer.probeLibraryObject({ sourceHash, minimumSize })
      if (!result.available || result.size < minimumSize) return false
    }
  } catch {
    return false
  }

  return true
}

export async function nativeWebDavFetch(url: string, init: RequestInit): Promise<Response> {
  if (!isNativeCloudTransferAvailable()) throw new Error('当前不是 Android 原生 WebDAV 环境')
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'MKCOL' && method !== 'PROPFIND') {
    throw new Error('原生 WebDAV 专用通道只接受 MKCOL 或 PROPFIND')
  }
  if (init.body != null) throw new Error('原生 WebDAV 专用请求不接受请求体')
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value
  })
  const result = await nativeTransfer.webDavRequest({ url, method, headers })
  const responseHeaders = new Headers(result.headers)
  const body = [204, 205, 304].includes(result.status) ? null : (result.body ?? null)
  return new Response(body, { status: result.status, headers: responseHeaders })
}

async function stageObject(
  jobId: string,
  object: NativeUploadObject,
  manifest: boolean,
): Promise<Partial<CloudBackupMetrics>> {
  if (!manifest && object.nativeSource && object.nativeSource.kind !== 'inline') {
    const started = monotonicNow()
    const result =
      object.nativeSource.kind === 'file'
        ? await nativeTransfer
            .stageObjectFromFile({
              jobId,
              name: object.name,
              contentType: object.contentType,
              existingId: object.existingId,
              releaseId: object.releaseId,
              uri: object.nativeSource.uri,
              offset: object.nativeSource.offset,
              size: object.nativeSource.size,
            })
            .catch((error: unknown) => {
              if (
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'UNIMPLEMENTED'
              )
                throw new Error('当前 APK 缺少 Discord 附件原生备份接口，请更新 APK 后重试。', {
                  cause: error,
                })
              throw error
            })
        : object.nativeSource.kind === 'range'
          ? await nativeTransfer.stageObjectFromLibrary({
              jobId,
              name: object.name,
              contentType: object.contentType,
              existingId: object.existingId,
              releaseId: object.releaseId,
              sourceHash: object.nativeSource.contentHash,
              offset: object.nativeSource.offset,
              size: object.nativeSource.size,
            })
          : await nativeTransfer.stageObjectFromSources({
              jobId,
              name: object.name,
              contentType: object.contentType,
              existingId: object.existingId,
              releaseId: object.releaseId,
              segments: object.nativeSource.segments,
            })
    if (result.staged) {
      return {
        nativeDiskMs: monotonicNow() - started,
        localReadBytes: object.size ?? object.blob?.size ?? 0,
      }
    }
    throw new Error('Android 原生资源镜像暂不可用；已阻止云对象退回 JS Blob/Base64。')
  }
  if (!manifest || !object.blob || object.blob.size > NATIVE_CLOUD_MAX_STAGED_OBJECT_BYTES) {
    throw new Error(
      manifest
        ? '快照清单超过原生单对象 256 MiB 上限。'
        : '云对象缺少可用的 NativeLibrary 来源；已阻止 JS Blob/Base64 回退。',
    )
  }
  const started = await nativeTransfer.beginObject({
    jobId,
    name: object.name,
    contentType: object.contentType,
    size: object.size ?? object.blob.size,
    manifest,
    existingId: object.existingId,
    releaseId: object.releaseId,
  })
  try {
    let bridgeEncodeMs = 0
    let bridgeTransferMs = 0
    let bridgeBytes = 0
    await transferNativeStream(object.blob, {
      append: (data) => nativeTransfer.appendObject({ token: started.token, data }),
      onChunkMetrics: (metrics) => {
        bridgeEncodeMs += metrics.encodeMs
        bridgeTransferMs += metrics.transferMs
        bridgeBytes += metrics.bytes
      },
    })
    await nativeTransfer.commitObject({ token: started.token })
    return {
      bridgeEncodeMs,
      bridgeTransferMs,
      bridgeBytes,
      localReadBytes: object.size ?? object.blob.size,
    }
  } catch (error) {
    await Promise.resolve(nativeTransfer.abortObject({ token: started.token })).catch(
      () => undefined,
    )
    throw error
  }
}

export async function uploadNativeStructuredSnapshot(options: {
  config: CloudBackupConfig
  secret: string
  releaseId?: number
  objects: NativeUploadObject[]
  manifest: NativeUploadObject
  onProgress?: (message: string) => void
  respectConstraints?: boolean
}): Promise<NativeUploadResult> {
  if (!isNativeCloudTransferAvailable()) throw new Error('当前不是 Android 原生传输环境')
  if (
    !options.manifest.blob ||
    options.manifest.blob.size > NATIVE_CLOUD_MAX_STAGED_OBJECT_BYTES ||
    options.objects.some((object) => !hasValidNativeSource(object))
  ) {
    throw new Error('原生云任务包含不能安全 handoff 的大型对象；禁止使用 Base64 Bridge。')
  }
  const protection = options.config.protection ?? {
    wifiOnly: false,
    chargingOnly: false,
  }
  const config = {
    ...options.config,
    ...(options.releaseId === undefined ? {} : { releaseId: options.releaseId }),
  } as unknown as Record<string, unknown>
  const total = options.objects.length + 1
  const started = await nativeTransfer.beginJob({
    config,
    secret: options.secret,
    wifiOnly: options.respectConstraints ? protection.wifiOnly : false,
    chargingOnly: options.respectConstraints ? protection.chargingOnly : false,
    automatic: options.respectConstraints === true,
    expectedTotal: total,
  })
  const { jobId } = started
  const pipeline = started.pipeline === true
  activeJobId = jobId
  const operationId = `native-cloud-backup:${jobId}`
  taskCenter.start({
    operationId,
    name: options.config.provider === 'github' ? 'GitHub 云备份' : 'Koofr 云备份',
    phase: '正在准备 Android 上传任务',
    background: options.respectConstraints === true,
  })
  const publishTaskProgress = (state: NativeCloudJobStatus, phase?: string): void => {
    taskCenter.update(operationId, {
      phase:
        phase ??
        (state.status === 'staging'
          ? '正在暂存备份对象'
          : state.status === 'committing'
            ? '正在提交最终清单'
            : options.respectConstraints
              ? '自动备份正在后台上传'
              : '正在上传本次备份'),
      progress: state.total > 0 ? state.completed / state.total : undefined,
      itemProgress: { completed: state.completed, total: state.total },
    })
    if ((state.totalBytes ?? 0) > 0 || (state.uploadedBytes ?? 0) > 0) {
      taskCenter.updateTransfer(operationId, {
        transferredBytes: state.uploadedBytes ?? 0,
        totalBytes: state.totalBytes,
      })
    }
  }
  let listener: PluginListenerHandle | undefined
  let completed: Promise<NativeCloudJobStatus> | undefined

  const attachCompletionListener = async (): Promise<void> => {
    if (typeof nativeTransfer.addListener !== 'function') return
    let resolveCompleted!: (state: NativeCloudJobStatus) => void
    let rejectCompleted!: (error: Error) => void
    completed = new Promise<NativeCloudJobStatus>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })
    void completed.catch(() => undefined)
    listener = await nativeTransfer.addListener('jobProgress', (state) => {
      if (state.id !== jobId) return
      publishTaskProgress(state)
      const percent = state.total
        ? Math.min(100, Math.round((state.completed / state.total) * 100))
        : 0
      const speed =
        state.uploadedBytes && state.networkMs
          ? ` · ${(state.uploadedBytes / 1024 / 1024 / (state.networkMs / 1000)).toFixed(1)} MiB/s`
          : ''
      const transferred =
        state.totalBytes && state.totalBytes > 0
          ? ` · ${(state.uploadedBytes ?? 0) / 1024 / 1024 < 10 ? ((state.uploadedBytes ?? 0) / 1024 / 1024).toFixed(1) : Math.round((state.uploadedBytes ?? 0) / 1024 / 1024)} MiB / ${state.totalBytes / 1024 / 1024 < 10 ? (state.totalBytes / 1024 / 1024).toFixed(1) : Math.round(state.totalBytes / 1024 / 1024)} MiB`
          : ''
      options.onProgress?.(
        `正在上传 ${state.completed}/${state.total}（${percent}%）${transferred}${speed}；${options.respectConstraints ? '自动备份会在后台继续' : '手动备份切到其他应用后仍会继续'}…`,
      )
      if (state.status === 'completed') resolveCompleted(state)
      else if (state.status === 'failed' || state.status === 'cancelled') {
        rejectCompleted(
          new Error(
            state.error || (state.status === 'cancelled' ? '原生云备份已取消' : '原生云备份失败'),
          ),
        )
      }
    })
  }

  const awaitCompletion = async (
    stagingMetrics: Partial<CloudBackupMetrics>,
  ): Promise<NativeUploadResult> => {
    if (!completed) {
      while (true) {
        const state = await nativeTransfer.getJob({ jobId })
        if (state.status === 'completed') {
          return {
            id: state.resultId || state.resultName || jobId,
            name: state.resultName || options.manifest.name,
            metrics: { ...stagingMetrics, ...nativeJobMetrics(state) },
          }
        }
        if (state.status === 'failed' || state.status === 'cancelled') {
          throw new Error(
            state.error || (state.status === 'cancelled' ? '原生云备份已取消' : '原生云备份失败'),
          )
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000))
      }
    }

    const current = await nativeTransfer.getJob({ jobId })
    const state =
      current.status === 'completed'
        ? current
        : current.status === 'failed' || current.status === 'cancelled'
          ? (() => {
              throw new Error(
                current.error ||
                  (current.status === 'cancelled' ? '原生云备份已取消' : '原生云备份失败'),
              )
            })()
          : await completed
    return {
      id: state.resultId || state.resultName || jobId,
      name: state.resultName || options.manifest.name,
      metrics: { ...stagingMetrics, ...nativeJobMetrics(state) },
    }
  }

  try {
    await attachCompletionListener()
    if (pipeline) {
      await nativeTransfer.startJob({ jobId })
      options.onProgress?.(
        options.respectConstraints
          ? 'Android 自动备份任务已启动，正在后台流水暂存并上传变更对象…'
          : 'Android 上传任务已启动，正在流水暂存并上传本次备份；切到其他应用后仍会继续…',
      )
    }

    let staged = 0
    const stagingMetrics: Partial<CloudBackupMetrics> = {}
    const mergeStagingMetrics = (value: Partial<CloudBackupMetrics>): void => {
      for (const key of [
        'bridgeEncodeMs',
        'bridgeTransferMs',
        'nativeDiskMs',
        'localReadBytes',
        'bridgeBytes',
      ] as const) {
        stagingMetrics[key] = Number(stagingMetrics[key] ?? 0) + Number(value[key] ?? 0)
      }
    }
    for (const object of options.objects) {
      mergeStagingMetrics(await stageObject(jobId, object, false))
      if (activeJobId !== jobId) throw new Error('原生云备份已取消')
      staged += 1
      publishTaskProgress(
        {
          id: jobId,
          provider: options.config.provider,
          status: 'staging',
          completed: staged,
          total,
          updatedAt: Date.now(),
        },
        `正在暂存备份对象 ${staged}/${total}`,
      )
      options.onProgress?.(
        pipeline
          ? `正在扫描并暂存 ${staged}/${total}；${options.respectConstraints ? 'Android 自动备份在后台同步上传' : 'Android 正在同步上传本次备份，切到其他应用后仍会继续'}…`
          : `正在扫描并暂存 ${staged}/${total}…`,
      )
    }
    mergeStagingMetrics(await stageObject(jobId, options.manifest, true))
    if (activeJobId !== jobId) throw new Error('原生云备份已取消')

    if (pipeline) {
      await nativeTransfer.finishJobStaging({ jobId })
      options.onProgress?.('正在提交快照……全部对象已持久化，等待内容对象上传完成后提交最终清单。')
    } else {
      // 兼容尚未实现流水协议的旧 APK：保持原来的“全部暂存后再启动”行为。
      await nativeTransfer.startJob({ jobId })
      options.onProgress?.('正在提交快照……变更对象已持久化，等待上传完成后提交最终清单。')
    }

    const result = await awaitCompletion(stagingMetrics)
    taskCenter.complete(operationId)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '')
    if (/^(原生云备份|云备份)已取消$/u.test(message)) taskCenter.cancelled(operationId)
    else taskCenter.fail(operationId, error)
    if (activeJobId === jobId) {
      await Promise.resolve(nativeTransfer.cancelJob({ jobId })).catch(() => undefined)
    }
    throw error
  } finally {
    await listener?.remove()
    if (activeJobId === jobId) activeJobId = ''
  }
}

export async function restoreNativeStructuredObjects(options: {
  config: CloudBackupConfig
  secret: string
  objects: NativeRestoreObject[]
  resources: NativeRestoreResource[]
  signal?: AbortSignal
  onResource?: (hash: string, error?: string) => void
}): Promise<NativeRestoreResult> {
  if (!isNativeCloudTransferAvailable()) throw new Error('当前不是 Android 原生恢复环境')
  if (!options.secret) throw new Error('Android 原生恢复缺少云端凭据')
  options.signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const delivered = new Set<string>()
  const dispatch = (hash: string, error?: string) => {
    if (options.signal?.aborted || delivered.has(hash)) return
    delivered.add(hash)
    options.onResource?.(hash, error)
  }
  let cancel: Promise<void> | undefined
  const abort = () => {
    cancel ??= nativeTransfer.cancelRestore({ requestId }).catch(() => undefined)
  }
  const listener = options.onResource
    ? await nativeTransfer.addListener('jobProgress', (state) => {
        if (state.requestId !== requestId) return
        for (const result of state.resourceResults ?? []) dispatch(result.hash, result.error)
      })
    : undefined
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const result = await nativeTransfer.restoreStructuredFiles({
      config: options.config as unknown as Record<string, unknown>,
      secret: options.secret,
      objects: options.objects,
      resources: options.resources,
      ...(options.onResource || options.signal ? { requestId, progressive: true } : {}),
    })
    options.signal?.throwIfAborted()
    const failures = new Map(result.failures?.map((failure) => [failure.hash, failure.error]))
    for (const resource of options.resources) dispatch(resource.hash, failures.get(resource.hash))
    return result
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (error instanceof Error && 'code' in error && error.code === 'UNIMPLEMENTED') {
      throw new Error('请更新 Android APK 后再从云端导入；当前版本不支持逐项恢复。', {
        cause: error,
      })
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await cancel
    await listener?.remove()
  }
}

export async function readNativeRestoredCardMetadata(options: {
  hash: string
  size: number
  fileName: string
}): Promise<NativeRestoreMetadata> {
  if (!isNativeCloudTransferAvailable()) throw new Error('当前不是 Android 原生恢复环境')
  return nativeTransfer.readRestoredCardMetadata(options)
}

export async function cancelActiveNativeCloudTransfer(): Promise<
  'cancelled' | 'committing' | undefined
> {
  let jobId = activeJobId
  if (!jobId && isNativeCloudTransferAvailable()) {
    const latest = await nativeTransfer.getLatestJob({})
    if (latest.present && ['staging', 'queued', 'running', 'committing'].includes(latest.status)) {
      jobId = latest.id
    }
  }
  if (!jobId) return undefined
  const result = await nativeTransfer.cancelJob({ jobId })
  if (!result?.cancelled) return result?.status === 'committing' ? 'committing' : undefined
  if (activeJobId === jobId) activeJobId = ''
  return 'cancelled'
}

export async function saveNativeCloudCredential(
  provider: CloudBackupProvider,
  secret: string,
): Promise<void> {
  if (!isNativeCloudTransferAvailable() || !secret) return
  await nativeTransfer.saveCredential({ provider, secret })
}

export async function clearNativeCloudCredential(provider: CloudBackupProvider): Promise<void> {
  if (!isNativeCloudTransferAvailable()) return
  await nativeTransfer.clearCredential({ provider })
}

export async function invalidateNativeCloudCredential(
  provider: CloudBackupProvider,
): Promise<void> {
  if (!isNativeCloudTransferAvailable()) return
  await nativeTransfer.invalidateCredential({ provider })
}

export async function readNativeCloudCredential(provider: CloudBackupProvider): Promise<{
  state: 'missing' | 'valid' | 'invalid'
  secret: string
}> {
  if (!isNativeCloudTransferAvailable()) return { state: 'missing', secret: '' }
  const result = await nativeTransfer.readCredential({ provider })
  if (!result.valid) return { state: 'invalid', secret: '' }
  const secret = result.present ? (result.secret ?? '') : ''
  return { state: secret ? 'valid' : 'missing', secret }
}

export async function saveNativeAppCredential(identifier: string, secret: string): Promise<void> {
  if (!isNativeCloudTransferAvailable()) return
  await nativeTransfer.saveAppCredential({ identifier, secret })
}

export async function readNativeAppCredential(identifier: string): Promise<string> {
  if (!isNativeCloudTransferAvailable()) return ''
  const result = await nativeTransfer.readAppCredential({ identifier })
  return result.secret ?? ''
}

export async function clearNativeAppCredential(identifier: string): Promise<void> {
  if (!isNativeCloudTransferAvailable()) return
  await nativeTransfer.clearAppCredential({ identifier })
}

export async function getLatestNativeCloudJob(
  provider?: CloudBackupProvider,
): Promise<NativeCloudJobStatus | null> {
  if (!isNativeCloudTransferAvailable()) return null
  const result = await nativeTransfer.getLatestJob({ provider })
  return result.present ? result : null
}

export async function getLatestNativeCloudRestoreJob(): Promise<NativeCloudJobStatus | null> {
  if (!isNativeCloudTransferAvailable()) return null
  const result = await nativeTransfer.getLatestJob({ kind: 'restore' })
  return result.present && result.kind === 'restore' ? result : null
}
