import {
  selfHostedFileList,
  selfHostedImageDelete,
  selfHostedImageUpload,
} from '../core/HostedApiTransport'
import { isCapacitorApp } from '../utils/CapacitorDetection'
import { generatedImageToBlob } from './GeneratedImageData'
import type { FrontendWorkshopGeneratedImage } from '../types/ImageGeneration'
import { localCredentialStore, type LocalCredentialRepository } from './LocalCredentialStore'

export interface FrontendWorkshopHostedImage {
  id: string
  name: string
  url: string
  mimeType: string
  sizeBytes: number
  createdAt: number
  /** 仅自建 ImgBed 使用；不包含凭据。 */
  managementOrigin?: string
  /** 仅自建 ImgBed 使用；对应 `/file/<fileId>` 的真实 fileId。 */
  upstreamFileId?: string
}

export type FrontendWorkshopSelfHostedAuthMode = 'auto' | 'bearer' | 'auth-code'

export type SelfHostedFileType = 'image' | 'video' | 'audio' | 'other'
export interface SelfHostedRemoteFile {
  fileId: string
  name: string
  url: string
  managementOrigin: string
  mimeType: string
  sizeBytes: number | null
  createdAt: number | null
  type: SelfHostedFileType
}
export interface SelfHostedFilePage {
  files: SelfHostedRemoteFile[]
  directories: string[]
  total: number
}

function safeRemotePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.split('/').every((part) => part && part !== '.' && part !== '..') &&
    !Array.from(value).some((character) => character === '\\' || character.charCodeAt(0) < 32)
  )
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export interface FrontendWorkshopSelfHostedImageBedConfig {
  /** 完整上传 API；旧版仅保存站点根地址时会自动迁移到 /upload。 */
  origin: string
  /** Bearer API Token 或经典 CloudFlare-ImgBed 的 AUTH_CODE，始终只进凭据存储。 */
  token: string
  remember: boolean
  authMode?: FrontendWorkshopSelfHostedAuthMode
}

const SELF_HOSTED_CONFIG_KEY = 'srl-frontend-workshop-self-hosted-imgbed'
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024
const MAX_SELF_HOSTED_CREDENTIAL_LENGTH = 4096
const IMGBED_API_TOKEN_PATTERN = /^imgbed_[0-9a-f]{64}$/iu

function imageFileName(mimeType: string): string {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'png'
  return `generated-image.${extension}`
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < MAX_ERROR_RESPONSE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = MAX_ERROR_RESPONSE_BYTES - total
      chunks.push(value.byteLength > remaining ? value.slice(0, remaining) : value)
      total += Math.min(value.byteLength, remaining)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function responseError(response: Response): Promise<string> {
  const body = await readLimitedText(response)
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string }
    return parsed.message || parsed.error || `HTTP ${response.status}`
  } catch {
    return body.slice(0, 300) || `HTTP ${response.status}`
  }
}

async function selfHostedResponseError(response: Response, uploadUrl?: URL): Promise<string> {
  const message = await responseError(response)
  if (response.status === 405) {
    const path = uploadUrl?.pathname || '/upload'
    return `自建 ImgBed 拒绝了 POST 上传（HTTP 405，路径 ${path}）。请确认该部署已启用 /upload API。`
  }
  if (/no telegram channel provided/iu.test(message)) {
    return '自建 ImgBed 当前落到了 Telegram 通道，但图床没有配置 Telegram 频道。请在图床后台启用可用通道，或在上传 API 地址后指定 uploadChannel。'
  }
  return message
}

async function jsonPayload<T>(response: Response, fallback: string): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(fallback)
  }
}

/**
 * 自建 ImgBed 保存完整上传入口而不是只保存 origin：
 * - https://img.example -> https://img.example/upload
 * - https://img.example/upload?uploadChannel=cfr2 -> 保留路径和非敏感 Query
 * - https://img.example/custom -> https://img.example/custom/upload
 *
 * authCode 会在保存配置时抽出到安全凭据存储，不留在 localStorage URL 中。
 */
function normalizedOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的自建图床 HTTPS 地址')
  }
  if (url.protocol !== 'https:') throw new Error('自建图床必须使用 HTTPS 地址')
  if (url.username || url.password) throw new Error('自建图床地址不能包含 URL 用户名或密码')
  url.hash = ''
  const pathname = url.pathname.replace(/\/+$/u, '')
  if (!pathname) url.pathname = '/upload'
  else if (!/\/upload$/iu.test(pathname)) url.pathname = `${pathname}/upload`
  else url.pathname = pathname
  return url.toString()
}

function normalizedAuthMode(value: unknown): FrontendWorkshopSelfHostedAuthMode {
  return value === 'bearer' || value === 'auth-code' ? value : 'auto'
}

export function isImgBedApiToken(value: string): boolean {
  return IMGBED_API_TOKEN_PATTERN.test(value.trim())
}

function extractSelfHostedCredential(
  origin: string,
  suppliedToken: string,
  requestedMode: unknown,
): { origin: string; token: string; authMode: FrontendWorkshopSelfHostedAuthMode } {
  const url = new URL(normalizedOrigin(origin))
  const queryAuthCode = url.searchParams.get('authCode')?.trim() ?? ''
  if (queryAuthCode) url.searchParams.delete('authCode')
  const token = queryAuthCode || suppliedToken.trim()
  if (!token) throw new Error('请输入自建图床上传凭据（API Token 或 AUTH_CODE）')
  if (token.length > MAX_SELF_HOSTED_CREDENTIAL_LENGTH) throw new Error('自建图床上传凭据长度异常')
  return {
    origin: url.toString(),
    token,
    // 当前 CloudFlare-ImgBed API Token 有稳定的 imgbed_ + 64 hex 格式。Web/iOS 识别到
    // 这种凭据后直接按 Bearer 使用，避免把全权限 Token 误当成 AUTH_CODE 探测。
    authMode: queryAuthCode
      ? 'auth-code'
      : isImgBedApiToken(token)
        ? 'bearer'
        : normalizedAuthMode(requestedMode),
  }
}

function selfHostedFileId(value: unknown, managementOrigin: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value, managementOrigin)
    if (url.origin !== managementOrigin || !url.pathname.startsWith('/file/')) return undefined
    const fileId = url.pathname
      .slice('/file/'.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .filter(Boolean)
      .join('/')
    return fileId || undefined
  } catch {
    return undefined
  }
}

function selfHostedDeleteUrl(managementOrigin: string, fileId: string): URL {
  return new URL(
    `/api/manage/delete/${fileId
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')}`,
    managementOrigin,
  )
}

function rootUploadUrl(source: URL): URL {
  const fallback = new URL(source)
  fallback.pathname = '/upload'
  return fallback
}

export class FrontendWorkshopImageHostingService {
  private readonly request: typeof fetch
  private readonly credentialStore: LocalCredentialRepository
  private selfHostedConfig: FrontendWorkshopSelfHostedImageBedConfig | null = null

  constructor(
    request: typeof fetch = globalThis.fetch.bind(globalThis),
    credentialStore: LocalCredentialRepository = localCredentialStore,
  ) {
    this.request = request
    this.credentialStore = credentialStore
    this.selfHostedConfig = this.readRememberedSelfHostedConfig()
  }

  private readRememberedSelfHostedConfig(): FrontendWorkshopSelfHostedImageBedConfig | null {
    try {
      const raw = localStorage.getItem(SELF_HOSTED_CONFIG_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<FrontendWorkshopSelfHostedImageBedConfig>
      if (typeof parsed.origin !== 'string') return null
      const origin = normalizedOrigin(parsed.origin)
      const url = new URL(origin)
      const legacyQueryAuthCode = url.searchParams.get('authCode')?.trim() ?? ''
      if (legacyQueryAuthCode) url.searchParams.delete('authCode')
      return {
        origin: url.toString(),
        token: legacyQueryAuthCode || (typeof parsed.token === 'string' ? parsed.token.trim() : ''),
        remember: parsed.remember !== false,
        authMode: legacyQueryAuthCode ? 'auth-code' : normalizedAuthMode(parsed.authMode),
      }
    } catch {
      return null
    }
  }

  private persistRememberedSelfHostedMetadata(): void {
    const config = this.selfHostedConfig
    if (!config?.remember) return
    localStorage.setItem(SELF_HOSTED_CONFIG_KEY, JSON.stringify({ ...config, token: '' }))
  }

  private rememberDetectedAuthMode(
    mode: Exclude<FrontendWorkshopSelfHostedAuthMode, 'auto'>,
  ): void {
    const config = this.selfHostedConfig
    if (!config || config.authMode === mode) return
    config.authMode = mode
    this.persistRememberedSelfHostedMetadata()
  }

  getSelfHostedConfiguration(): FrontendWorkshopSelfHostedImageBedConfig | null {
    return this.selfHostedConfig ? { ...this.selfHostedConfig } : null
  }

  async initializeCredentials(): Promise<void> {
    if (!this.selfHostedConfig) return
    if (!this.selfHostedConfig.remember) {
      await this.credentialStore.clear('image-hosting:self-hosted')
      return
    }
    if (this.selfHostedConfig.token) {
      await this.credentialStore.save('image-hosting:self-hosted', this.selfHostedConfig.token)
    } else {
      this.selfHostedConfig.token = await this.credentialStore.read('image-hosting:self-hosted')
    }
    // 修复旧 Web/iOS 本地元数据：曾经 auto 探测出的 auth-code 不能覆盖一个明确的现代
    // API Token。Token 本身仍只存在安全凭据仓库，不写回 localStorage。
    if (isImgBedApiToken(this.selfHostedConfig.token)) this.selfHostedConfig.authMode = 'bearer'
    this.persistRememberedSelfHostedMetadata()
  }

  async saveSelfHostedConfiguration(
    config: FrontendWorkshopSelfHostedImageBedConfig,
  ): Promise<FrontendWorkshopSelfHostedImageBedConfig> {
    const credential = extractSelfHostedCredential(config.origin, config.token, config.authMode)
    const normalized: FrontendWorkshopSelfHostedImageBedConfig = {
      origin: credential.origin,
      token: credential.token,
      remember: config.remember,
      authMode: credential.authMode,
    }
    try {
      if (normalized.remember) {
        await this.credentialStore.save('image-hosting:self-hosted', normalized.token)
        localStorage.setItem(SELF_HOSTED_CONFIG_KEY, JSON.stringify({ ...normalized, token: '' }))
      } else {
        await this.credentialStore.clear('image-hosting:self-hosted')
        localStorage.removeItem(SELF_HOSTED_CONFIG_KEY)
      }
    } catch {
      if (normalized.remember) throw new Error('当前设备无法安全保存图床连接，请改为仅本次使用')
    }
    this.selfHostedConfig = normalized
    return { ...normalized }
  }

  async forgetSelfHostedConfiguration(): Promise<void> {
    this.selfHostedConfig = null
    await this.credentialStore.clear('image-hosting:self-hosted')
    try {
      localStorage.removeItem(SELF_HOSTED_CONFIG_KEY)
    } catch {
      // 隐私模式下没有可清除的持久配置。
    }
  }

  exportSelfHostedConfiguration(): FrontendWorkshopSelfHostedImageBedConfig | undefined {
    return this.selfHostedConfig?.token ? { ...this.selfHostedConfig } : undefined
  }

  async uploadSelfHosted(
    generatedImage: FrontendWorkshopGeneratedImage,
    name: string,
  ): Promise<FrontendWorkshopHostedImage> {
    const blob = await generatedImageToBlob(this.request, generatedImage)
    return this.uploadBlobSelfHosted(blob, name)
  }

  private async requestSelfHostedUpload(
    url: URL,
    blob: Blob,
    token: string,
    mode: Exclude<FrontendWorkshopSelfHostedAuthMode, 'auto'>,
  ): Promise<Response> {
    const requestUrl = new URL(url)
    if (mode === 'auth-code') requestUrl.searchParams.set('authCode', token)
    else requestUrl.searchParams.delete('authCode')
    return selfHostedImageUpload(this.request, requestUrl, {
      blob,
      fileName: imageFileName(blob.type),
      ...(mode === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
    })
  }

  private async requestSelfHostedUploadWithMode(
    url: URL,
    blob: Blob,
    token: string,
    requestedMode: FrontendWorkshopSelfHostedAuthMode,
  ): Promise<{ response: Response; mode: Exclude<FrontendWorkshopSelfHostedAuthMode, 'auto'> }> {
    if (requestedMode === 'auth-code') {
      return {
        response: await this.requestSelfHostedUpload(url, blob, token, 'auth-code'),
        mode: 'auth-code',
      }
    }
    if (requestedMode === 'bearer' || isImgBedApiToken(token)) {
      return {
        response: await this.requestSelfHostedUpload(url, blob, token, 'bearer'),
        mode: 'bearer',
      }
    }
    if (!isCapacitorApp()) {
      // 未知旧凭据仍先尝试无需预检的经典 AUTH_CODE；明确 401 后才尝试 Bearer。
      let response = await this.requestSelfHostedUpload(url, blob, token, 'auth-code')
      if (response.status !== 401) return { response, mode: 'auth-code' }
      response = await this.requestSelfHostedUpload(url, blob, token, 'bearer')
      return { response, mode: 'bearer' }
    }
    let response = await this.requestSelfHostedUpload(url, blob, token, 'bearer')
    if (response.status !== 401) return { response, mode: 'bearer' }
    response = await this.requestSelfHostedUpload(url, blob, token, 'auth-code')
    return { response, mode: 'auth-code' }
  }

  async uploadBlobSelfHosted(blob: Blob, name: string): Promise<FrontendWorkshopHostedImage> {
    const config = this.selfHostedConfig
    if (!config) throw new Error('请先连接你自己的 ImgBed')
    if (!config.token) throw new Error('自建图床上传凭据已丢失，请重新连接')
    const fileName = name.trim().slice(0, 80) || '生成图片'
    let url = new URL(config.origin)
    url.searchParams.set('returnFormat', 'full')
    if (!url.searchParams.has('uploadNameType')) url.searchParams.set('uploadNameType', 'short')
    if (!url.searchParams.has('uploadFolder')) url.searchParams.set('uploadFolder', 'srl-workshop')
    // 不指定通道时让 ImgBed 自己从已配置渠道重试；用户显式指定通道时则保持固定通道。
    if (!url.searchParams.has('autoRetry')) {
      url.searchParams.set('autoRetry', url.searchParams.has('uploadChannel') ? 'false' : 'true')
    }

    const requestedMode = isImgBedApiToken(config.token)
      ? 'bearer'
      : normalizedAuthMode(config.authMode)
    let result: {
      response: Response
      mode: Exclude<FrontendWorkshopSelfHostedAuthMode, 'auto'>
    }
    try {
      result = await this.requestSelfHostedUploadWithMode(url, blob, config.token, requestedMode)
      // iOS 可能长期保留旧的自建 URL 元数据。只有服务器真实返回 POST 405、且当前不是根
      // /upload 时，才在同一 origin 回退一次标准入口；绝不跨域，也不把 Token 发给新站点。
      if (result.response.status === 405 && url.pathname !== '/upload') {
        url = rootUploadUrl(url)
        result = await this.requestSelfHostedUploadWithMode(url, blob, config.token, requestedMode)
        if (result.response.ok) {
          config.origin = url.toString()
          this.persistRememberedSelfHostedMetadata()
        }
      }
    } catch (error) {
      if (!isCapacitorApp()) {
        throw new Error(
          '浏览器没有拿到自建 ImgBed 的上传响应。请确认该图床的 /upload 已允许跨域 POST/OPTIONS 与 Authorization；这属于浏览器 CORS/网络失败，不是 HTTP 405。',
          { cause: error },
        )
      }
      throw error
    }

    const { response, mode } = result
    if (response.ok && normalizedAuthMode(config.authMode) === 'auto') {
      this.rememberDetectedAuthMode(mode)
    }
    if (!response.ok) throw new Error(await selfHostedResponseError(response, url))
    const payload = await jsonPayload<unknown>(response, '自建图床没有返回有效图片记录')
    const first = Array.isArray(payload) ? payload[0] : payload
    const value = first as { publicUrl?: unknown; src?: unknown } | null
    const candidate =
      typeof value?.publicUrl === 'string'
        ? value.publicUrl
        : typeof value?.src === 'string'
          ? value.src
          : ''
    if (!candidate.trim()) throw new Error('自建图床没有返回图片直链')
    const publicUrl = new URL(candidate, url.origin)
    if (publicUrl.protocol !== 'https:') throw new Error('自建图床没有返回 HTTPS 图片直链')
    const managementOrigin = url.origin
    const upstreamFileId =
      selfHostedFileId(value?.src, managementOrigin) ??
      selfHostedFileId(publicUrl.toString(), managementOrigin)
    return {
      id: crypto.randomUUID(),
      name: fileName,
      url: publicUrl.toString(),
      mimeType: blob.type,
      sizeBytes: blob.size,
      createdAt: Date.now(),
      managementOrigin,
      upstreamFileId,
    }
  }

  async listSelfHosted(
    options: {
      start?: number
      directory?: string
      search?: string
      type?: SelfHostedFileType | ''
      recursive?: boolean
      signal?: AbortSignal
    } = {},
  ): Promise<SelfHostedFilePage> {
    const config = this.selfHostedConfig
    if (!config?.token) throw new Error('请先保存自建图床连接，并使用包含 list 权限的 API Token。')
    if (normalizedAuthMode(config.authMode) === 'auth-code' && !isImgBedApiToken(config.token))
      throw new Error('AUTH_CODE 只能上传。查看远端文件需要包含 list 权限的 API Token。')
    const directory = options.directory ?? ''
    if (directory && !safeRemotePath(directory)) throw new Error('图床目录无效')
    if (options.type && !['image', 'video', 'audio', 'other'].includes(options.type))
      throw new Error('文件类型无效')
    const origin = new URL(config.origin).origin
    const url = new URL('/api/manage/list', origin)
    const recursive = options.recursive !== false
    url.search = new URLSearchParams({
      start: String(Math.max(0, Math.floor(options.start ?? 0))),
      count: '50',
      dir: directory,
      search: options.search?.trim() ?? '',
      fileType: options.type ?? '',
      recursive: String(recursive),
    }).toString()
    let response: Response
    try {
      response = await selfHostedFileList(this.request, url, {
        authorization: `Bearer ${config.token}`,
        signal: options.signal,
      })
    } catch (cause) {
      options.signal?.throwIfAborted()
      throw new Error(
        '无法读取自建图床文件列表，请检查网络及 /api/manage/list 的跨域 CORS 配置。',
        { cause },
      )
    }
    if (response.status === 401 || response.status === 403)
      throw new Error('当前图床凭据没有文件列表权限，请使用包含 list 权限的 API Token。')
    if (!response.ok) throw new Error(`读取自建图床列表失败（HTTP ${response.status}）`)
    const payload = await jsonPayload<{
      files?: { name?: unknown; metadata?: Record<string, unknown> }[]
      directories?: unknown[]
      totalCount?: unknown
      directFileCount?: unknown
      isIndexedResponse?: boolean
    }>(response, '图床没有返回有效的文件列表')
    if (
      !Array.isArray(payload.files) ||
      payload.files.length > 50 ||
      payload.isIndexedResponse === false
    )
      throw new Error('图床未返回分页索引，请在 ImgBed 后台检查或重建文件索引后重试。')
    const files = payload.files.map((file) => {
      if (!file || !safeRemotePath(file.name)) throw new Error('图床返回了无效的文件路径')
      const metadata = file.metadata ?? {}
      const mimeType = String(metadata.FileType ?? metadata['File-Mime'] ?? '')
      const type: SelfHostedFileType = mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('video/')
          ? 'video'
          : mimeType.startsWith('audio/')
            ? 'audio'
            : 'other'
      return {
        fileId: file.name,
        name:
          typeof metadata.FileName === 'string' && metadata.FileName
            ? metadata.FileName
            : file.name.split('/').at(-1)!,
        url: new URL(
          `/file/${file.name.split('/').map(encodeURIComponent).join('/')}`,
          origin,
        ).toString(),
        managementOrigin: origin,
        mimeType,
        type,
        sizeBytes: nonNegativeNumber(metadata.FileSizeBytes ?? metadata['File-Size']),
        createdAt: nonNegativeNumber(metadata.TimeStamp),
      }
    })
    return {
      files,
      directories: (payload.directories ?? []).filter(
        (path): path is string =>
          safeRemotePath(path) &&
          path !== directory &&
          (!directory || path.startsWith(directory + '/')),
      ),
      total:
        nonNegativeNumber(
          recursive ? payload.totalCount : (payload.directFileCount ?? payload.totalCount),
        ) ?? files.length,
    }
  }

  async deleteSelfHosted(image: {
    url: string
    managementOrigin?: string
    upstreamFileId?: string
  }): Promise<void> {
    const config = this.selfHostedConfig
    if (!config) throw new Error('请先连接这张图片所属的自建 ImgBed')
    if (!config.token) throw new Error('自建图床管理凭据已丢失，请重新连接')
    if (normalizedAuthMode(config.authMode) === 'auth-code' && !isImgBedApiToken(config.token)) {
      throw new Error(
        '当前连接使用 AUTH_CODE，它只能用于上传。请在你的 ImgBed 创建包含 delete 权限的 API Token 后重新连接。',
      )
    }

    const configuredOrigin = new URL(config.origin).origin
    const managementOrigin = image.managementOrigin?.trim() || configuredOrigin
    let targetOrigin: URL
    try {
      targetOrigin = new URL(managementOrigin)
    } catch {
      throw new Error('这张图片缺少有效的自建图床来源，无法安全删除远端文件')
    }
    if (targetOrigin.protocol !== 'https:' || targetOrigin.origin !== configuredOrigin) {
      throw new Error('这张图片来自另一套自建 ImgBed，请先重新连接该图床再删除远端文件')
    }

    const fileId = image.upstreamFileId?.trim() || selfHostedFileId(image.url, targetOrigin.origin)
    if (!fileId) {
      throw new Error('这张旧直链缺少可验证的 ImgBed fileId，无法安全执行远端删除')
    }

    let response: Response
    try {
      response = await selfHostedImageDelete(
        this.request,
        selfHostedDeleteUrl(targetOrigin.origin, fileId),
        { authorization: `Bearer ${config.token}` },
      )
    } catch (error) {
      if (!isCapacitorApp()) {
        throw new Error(
          '浏览器无法访问自建 ImgBed 的删除接口。请确认该图床支持 /api/manage/delete 与跨域 OPTIONS/CORS；也可以在 Android APP 中重试。',
          { cause: error },
        )
      }
      throw error
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        '当前自建图床凭据没有图片删除权限。请在该 ImgBed 创建包含 delete 权限的 API Token 后重新连接；AUTH_CODE 只能上传。',
      )
    }
    if (response.status === 405) {
      throw new Error('当前 ImgBed 部署不支持标准图片删除接口，请升级 ImgBed 后重试。')
    }
    if (!response.ok) {
      throw new Error(`自建图床删除失败：${await responseError(response)}`)
    }
  }
}
