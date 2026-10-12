import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'

import { transferNativeStream } from './NativeStreamTransfer'


interface NativeHostedUploadResult {
  status: number
  headers?: Record<string, string>
  body?: string
}

interface NativeHostedUploadPlugin {
  beginSelfHostedImageUpload(options: {
    url: string
    fileName: string
    mimeType: string
    size: number
    authorization?: string
  }): Promise<{ token: string }>
  appendImageUpload(options: { token: string; data: string }): Promise<void>
  commitImageUpload(options: { token: string }): Promise<NativeHostedUploadResult>
  abortImageUpload(options: { token: string }): Promise<void>
}


export interface SelfHostedImageUploadOptions {
  blob: Blob
  fileName: string
  authorization?: string
  signal?: AbortSignal
}

export interface SelfHostedImageDeleteOptions {
  authorization: string
  signal?: AbortSignal
}

const nativeHostedUpload = registerPlugin<NativeHostedUploadPlugin>('NativeHostedUpload')

function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

function isAndroidNativeApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

type IOSNavigator = Navigator & { standalone?: boolean }

/**
 * WebKit 26.x 在 iOS Safari 的已确认生产请求中会把 IndexedDB/磁盘来源 File 的
 * multipart body 发成 0 字节。常规 Safari UA 可用 Version/26+ 精确命中；安装到主屏幕
 * 的 iOS PWA 可能省略 Version/Safari，因此以 standalone 作为同一 WebKit 路径的补充。
 * iPad 桌面 UA 通过 MacIntel + touch points 识别。
 */
function needsIOSWebKitMultipartMaterialization(): boolean {
  if (typeof navigator === 'undefined') return false
  const browser = navigator as IOSNavigator
  const userAgent = browser.userAgent || ''
  const isAppleWebKit = /AppleWebKit\//iu.test(userAgent)
  const isIOSDevice =
    /\b(?:iPhone|iPad|iPod)\b/iu.test(userAgent) ||
    (browser.platform === 'MacIntel' && browser.maxTouchPoints > 1)
  if (!isAppleWebKit || !isIOSDevice) return false

  const safariVersion = userAgent.match(/\bVersion\/(\d+)(?:\.(\d+))?/iu)
  if (safariVersion) return Number(safariVersion[1]) >= 26
  return browser.standalone === true
}

/**
 * 只在受影响的 iOS WebKit 上传边界把可能由 IndexedDB/磁盘 backing 的 Blob/File
 * 物化成新的内存 Blob，避免 WebKit 把 multipart 请求体发送成 Content-Length: 0。
 * 不在普通浏览器或 Android 主链复制大图片。
 */
async function browserMultipartUploadBlob(blob: Blob): Promise<Blob> {
  if (!needsIOSWebKitMultipartMaterialization() || blob.size === 0) return blob
  const materialized = new Blob([await blob.arrayBuffer()], { type: blob.type })
  if (materialized.size !== blob.size) throw new Error('Safari 图床上传内存副本大小不一致')
  return materialized
}


function browserSafeNativeHeaders(headers: Record<string, string> | undefined): Headers {
  const safe = new Headers()
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = name.toLowerCase()
    if (normalizedName === 'set-cookie' || normalizedName === 'set-cookie2') continue
    safe.append(name, value)
  }
  return safe
}


function responseBody(data: unknown, status: number, headers: Headers): BodyInit | null {
  if ([204, 205, 304].includes(status) || data == null) return null
  if (typeof data === 'string') return data
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return JSON.stringify(data)
}

function nativeHostedUploadResponse(result: NativeHostedUploadResult): Response {
  const headers = browserSafeNativeHeaders(result.headers)
  return new Response([204, 205, 304].includes(result.status) ? null : (result.body ?? ''), {
    status: result.status,
    headers,
  })
}

async function streamNativeUpload(
  blob: Blob,
  signal: AbortSignal | undefined,
  begin: () => Promise<{ token: string }>,
): Promise<Response> {
  let token = ''
  try {
    const staged = await begin()
    token = staged.token
    const transferred = await transferNativeStream(blob, {
      signal,
      totalBytes: blob.size,
      append: (data) => nativeHostedUpload.appendImageUpload({ token, data }),
    })
    if (transferred !== blob.size) throw new Error('原生上传暂存大小不一致')
    const result = await nativeHostedUpload.commitImageUpload({ token })
    token = ''
    return nativeHostedUploadResponse(result)
  } catch (error) {
    if (token) await nativeHostedUpload.abortImageUpload({ token }).catch(() => undefined)
    throw error
  }
}



/**
 * 用户自建 ImgBed 的 Android 上传入口。
 *
 * 网页端仍走调用方原有 fetch；Android 只允许 HTTPS POST multipart(file)，把图片按
 * 有界分块写到应用 cache 后由 OkHttp 从文件流式发送。它不是通用原生代理，不提供
 * 任意 method、任意 response body 或后台转发能力。
 */
export async function selfHostedImageUpload(
  request: typeof fetch,
  url: URL,
  options: SelfHostedImageUploadOptions,
): Promise<Response> {
  if (!isAndroidNativeApp()) {
    const uploadBlob = await browserMultipartUploadBlob(options.blob)
    const formData = new FormData()
    formData.set('file', uploadBlob, options.fileName)
    return request(url, {
      method: 'POST',
      headers: options.authorization ? { Authorization: options.authorization } : undefined,
      body: formData,
      signal: options.signal,
    })
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Android 自建图床只允许无 URL 凭据的 HTTPS 上传地址')
  }

  return streamNativeUpload(options.blob, options.signal, () =>
    nativeHostedUpload.beginSelfHostedImageUpload({
      url: url.toString(),
      fileName: options.fileName,
      mimeType: options.blob.type || 'application/octet-stream',
      size: options.blob.size,
      ...(options.authorization ? { authorization: options.authorization } : {}),
    }),
  )
}

function validateSelfHostedDeleteUrl(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/api/manage/delete/')
  ) {
    throw new TypeError('自建图床删除只允许无 URL 凭据的 HTTPS 图片删除接口')
  }
}

/**
 * 自建 ImgBed 图片删除入口。只允许标准 `/api/manage/delete/<fileId>`，不会扩成任意
 * 管理 API。网页端直接访问用户图床；原生端使用 CapacitorHttp 绕开 WebView CORS。
 */
export async function selfHostedImageDelete(
  request: typeof fetch,
  url: URL,
  options: SelfHostedImageDeleteOptions,
): Promise<Response> {
  validateSelfHostedDeleteUrl(url)
  if (!isNativeApp()) {
    return request(url, {
      method: 'DELETE',
      headers: { Authorization: options.authorization },
      signal: options.signal,
    })
  }

  const result = await CapacitorHttp.request({
    url: url.toString(),
    method: 'DELETE',
    headers: { Authorization: options.authorization, Accept: 'application/json' },
    connectTimeout: 20_000,
    readTimeout: 45_000,
    responseType: 'text',
  })
  const responseHeaders = browserSafeNativeHeaders(result.headers)
  return new Response(responseBody(result.data, result.status, responseHeaders), {
    status: result.status,
    headers: responseHeaders,
  })
}
