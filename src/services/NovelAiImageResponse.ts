import JSZip from 'jszip'
import type { FrontendWorkshopImageFormat } from '../types/ImageGeneration'
import { getCapacitorPlatform } from '../utils/CapacitorDetection'
import type { NovelAiTransport } from './NovelAiBinaryTransport'
import { asImageDataUrl, bytesToBase64, imageFormatFromBytes } from './GeneratedImageData'
import { responseErrorDetail } from './ImageGenerationError'

function novelAiJsonImage(value: unknown): string | undefined {
  const payload = value as { image?: unknown; images?: Array<{ image?: string } | string> }
  if (typeof payload?.image === 'string') return payload.image
  const first = payload?.images?.[0]
  return typeof first === 'string' ? first : first?.image
}

function novelAiResponseFingerprint(
  response: Response,
  bytes: Uint8Array,
  transport?: NovelAiTransport,
): string {
  const platform = getCapacitorPlatform()
  const runtime = platform === 'web' ? 'web' : `capacitor-${platform}`
  const contentType = response.headers.get('content-type') || 'unknown'
  const disposition = response.headers.get('content-disposition') || 'none'
  const magic = Array.from(bytes.subarray(0, 16), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join(' ')
  return `runtime=${runtime}; transport=${transport ?? 'unknown'}; content-type=${contentType}; content-disposition=${disposition}; byteLength=${bytes.length}; magic=${magic || 'none'}`
}

const NOVEL_AI_ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024

const NOVEL_AI_ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024

const NOVEL_AI_ZIP_MAX_ENTRIES = 256

function readNovelAiZipEntry(entry: JSZip.JSZipObject, previousTotal: number): Promise<Uint8Array> {
  // JSZip 3.10.1 omits this documented public method from its ZipObject typings.
  // async('uint8array') uses the same stream, but accumulates without a size bound.
  const file = entry as JSZip.JSZipObject & {
    internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>
  }
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let settled = false
    const stream = file.internalStream('uint8array')
    const fail = (message: string) => {
      if (settled) return
      settled = true
      stream.pause()
      chunks.length = 0
      reject(new Error(message))
    }
    stream
      .on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (
          size > NOVEL_AI_ZIP_MAX_ENTRY_BYTES ||
          previousTotal + size > NOVEL_AI_ZIP_MAX_TOTAL_BYTES
        ) {
          fail('NovelAI ZIP 解压大小超出上限（单条目 32 MiB / 总计 64 MiB）')
          return
        }
        chunks.push(chunk)
      })
      .on('error', () => fail('NovelAI ZIP 解压失败'))
      .on('end', () => {
        if (settled) return
        try {
          const value = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            value.set(chunk, offset)
            offset += chunk.length
          }
          chunks.length = 0
          settled = true
          resolve(value)
        } catch {
          fail('NovelAI ZIP 解压失败')
        }
      })
      .resume()
  })
}

async function readNovelAiZipImage(bytes: Uint8Array): Promise<Uint8Array> {
  let archive: JSZip
  try {
    // Do not enable load-time CRC decompression: output must pass the bounded reader.
    archive = await JSZip.loadAsync(bytes)
  } catch {
    // Library messages/causes can contain filenames or input. Expose only our diagnostic.
    throw new Error('NovelAI ZIP 解压失败')
  }
  const entries = Object.values(archive.files)
  if (entries.length > NOVEL_AI_ZIP_MAX_ENTRIES) throw new Error('NovelAI ZIP 条目数量超出上限')
  let totalSize = 0
  let firstImage: Uint8Array | undefined
  // Sequential extraction bounds memory and preserves archive order. Paths are never written.
  for (const entry of entries) {
    if (entry.dir) continue
    const value = await readNovelAiZipEntry(entry, totalSize)
    totalSize += value.length
    if (!firstImage && imageFormatFromBytes(value)) firstImage = value
  }
  if (!firstImage) throw new Error(`NovelAI 压缩包中没有可识别图片; entries=${entries.length}`)
  return firstImage
}

export async function readNovelAiImage(
  response: Response,
  novelAiTransport?: NovelAiTransport,
): Promise<{ dataUrl: string; mimeType: string; extension: FrontendWorkshopImageFormat }> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const parseError = (
    message: string,
    stage: 'response-parse' | 'zip-extract' = 'response-parse',
  ) =>
    new Error(
      `${message}（${novelAiResponseFingerprint(response, bytes, novelAiTransport)}; stage=${stage}）`,
    )
  if (!bytes.length) throw parseError('NovelAI 返回了空图片')
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    let entry: Uint8Array
    try {
      entry = await readNovelAiZipImage(bytes)
    } catch (error) {
      throw parseError(
        error instanceof Error ? error.message : 'NovelAI ZIP 解压失败',
        'zip-extract',
      )
    }
    const format = imageFormatFromBytes(entry)!
    return { ...format, dataUrl: `data:${format.mimeType};base64,${bytesToBase64(entry)}` }
  }
  const rawFormat = imageFormatFromBytes(bytes)
  if (rawFormat)
    return { ...rawFormat, dataUrl: `data:${rawFormat.mimeType};base64,${bytesToBase64(bytes)}` }
  const text = new TextDecoder().decode(bytes)
  const payloads: unknown[] = []
  if (contentType.includes('event-stream')) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue
      try {
        payloads.push(JSON.parse(line.slice(5).trim()))
      } catch {
        /* heartbeat */
      }
    }
  } else {
    try {
      payloads.push(JSON.parse(text))
    } catch {
      throw parseError('NovelAI 返回了未识别的二进制或文本内容')
    }
  }
  const encoded = [...payloads].reverse().map(novelAiJsonImage).find(Boolean)
  if (!encoded) {
    const detail = [...payloads].reverse().map(responseErrorDetail).find(Boolean)
    throw parseError(
      detail ? `NovelAI 未返回图片，服务端说明：${detail}` : 'NovelAI 没有返回可用图片',
    )
  }
  const dataUrl = asImageDataUrl(encoded, 'image/png')!
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));/u)
  const mimeType = match?.[1] ?? 'image/png'
  const extension =
    mimeType === 'image/jpeg'
      ? 'jpeg'
      : (mimeType.replace('image/', '') as FrontendWorkshopImageFormat)
  return { dataUrl, mimeType, extension }
}
