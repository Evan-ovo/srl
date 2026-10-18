import type {
  FrontendWorkshopImageGenerationRequest,
  FrontendWorkshopImageGenerationConfig,
} from '../types/ImageGeneration'
import {
  getImageGenerationCapabilities,
  isOfficialOpenAiImageEndpoint,
} from './ImageGenerationCapabilities'
import {
  DEFAULT_MODELS,
  DEFAULT_ENDPOINTS,
  requiredHttpsUrl,
  diagnosticEndpoint,
  boundedNumber,
  redactImageRequest,
} from './ImageGenerationRequest'
import { decodeGeneratedImageDataUrl } from './GeneratedImageData'

function openAiSize(width: number, height: number): '1024x1024' | '1024x1536' | '1536x1024' {
  const ratio = width / height
  if (ratio < 0.85) return '1024x1536'
  if (ratio > 1.18) return '1536x1024'
  return '1024x1024'
}

export function compileOpenAiPrompt(request: FrontendWorkshopImageGenerationRequest): string {
  const roles = {
    identity: '人物身份',
    outfit: '服装',
    composition: '构图',
    scene: '场景',
    reference: '普通参考',
  }
  const preserve = {
    identity: '人物身份',
    face: '面部特征',
    hairstyle: '发型',
    composition: '构图与镜头位置',
    background: '背景',
    lighting: '光照',
  }
  const parts = [request.prompt.trim()]
  request.openAiInputImages?.forEach((image, index) =>
    parts.push(`图片 ${index + 1} 用途：${roles[image.role ?? 'reference']}。`),
  )
  if (request.openAiEditInstruction?.trim())
    parts.push(`修改指令：${request.openAiEditInstruction.trim()}。仅修改指令指定的部分。`)
  const unchanged = (Object.keys(preserve) as Array<keyof typeof preserve>)
    .filter((key) => request.openAiInputImages?.length && request.openAiPreserve?.[key])
    .map((key) => preserve[key])
  if (unchanged.length)
    parts.push(`保持不变：${unchanged.join('、')}。以输入图片为准，保持这些特征，不要重新设计。`)
  return parts.filter(Boolean).join('\n')
}

export function parseImageAdditionalJson(value?: string): Record<string, unknown> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('附加 JSON 解析失败，已阻止提交')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('附加 JSON 必须是对象')
  const protectedKeys = new Set([
    'model',
    'prompt',
    'size',
    'n',
    'quality',
    'background',
    'outputformat',
    'outputcompression',
    'image',
    'images',
    'mask',
    'stream',
    'responseformat',
    'inputfidelity',
  ])
  function validate(item: unknown, top = false): void {
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
      if (
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        /authorization|endpoint|headers?|apikey|accesstoken|password|secret/i.test(normalized) ||
        (top && protectedKeys.has(normalized))
      )
        throw new Error('附加 JSON 包含受保护字段，不能覆盖请求参数、Endpoint 或凭据')
      validate(child)
    }
  }
  validate(parsed, true)
  return parsed as Record<string, unknown>
}

export function buildOpenAiImageRequest(
  config: FrontendWorkshopImageGenerationConfig,
  request: FrontendWorkshopImageGenerationRequest,
) {
  const model = config.model.trim() || DEFAULT_MODELS[config.provider]
  const caps = getImageGenerationCapabilities(
    config.provider,
    model,
    config.relayCapabilities,
    config.endpoint,
  )
  const images = request.openAiInputImages ?? []
  if (caps.textToImage === 'unsupported') throw new Error(caps.notes[0])
  const edit =
    images.length > 0 ||
    Boolean(request.openAiEditInstruction?.trim()) ||
    Boolean(request.openAiMask)
  if (edit && (caps.imageEdit !== 'supported' || caps.imageInput !== 'supported'))
    throw new Error('图片编辑 / 图片输入能力未确认，已阻止提交')
  if (edit && !images.length) throw new Error('图片编辑需要至少一张输入图片')
  if (images.length > 1 && caps.multiImage !== 'supported')
    throw new Error('多图能力未确认，已阻止提交')
  if (images.length > caps.maxInputImages) throw new Error(`最多上传 ${caps.maxInputImages} 张图片`)
  if (request.openAiMask && caps.mask !== 'supported')
    throw new Error('Mask 能力未确认，已阻止提交')
  const prompt = compileOpenAiPrompt(request)
  if (!prompt) throw new Error('请先填写生图提示词或编辑指令')
  const dimensions = `${request.width ?? 1024}x${request.height ?? 1024}`
  const size = caps.sizes.includes(dimensions)
    ? dimensions
    : openAiSize(request.width ?? 1024, request.height ?? 1024)
  const outputFormat = caps.outputFormat === 'supported' ? (request.outputFormat ?? 'png') : 'png'
  const body: Record<string, unknown> = { model, prompt, size }
  if (isOfficialOpenAiImageEndpoint(config.endpoint)) body.n = 1
  if (caps.quality === 'supported') body.quality = request.openAiQuality ?? 'auto'
  if (caps.background === 'supported') body.background = request.openAiBackground ?? 'auto'
  if (body.background === 'transparent' && outputFormat === 'jpeg')
    throw new Error('透明背景不能使用 JPEG，请选择 PNG 或 WebP')
  if (body.background === 'transparent' && caps.transparentBackground !== 'supported')
    throw new Error('透明背景需要接口同时确认背景和 PNG / WebP 输出格式能力')
  if (caps.outputFormat === 'supported') body.output_format = outputFormat
  if (
    caps.outputCompression === 'supported' &&
    outputFormat !== 'png' &&
    caps.outputFormat === 'supported'
  )
    body.output_compression = Math.round(boundedNumber(request.outputCompression, 90, 0, 100))
  if (config.provider === 'openai')
    Object.assign(body, parseImageAdditionalJson(request.additionalJson))
  const url = new URL(requiredHttpsUrl(config.endpoint, DEFAULT_ENDPOINTS[config.provider]))
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = /\/images\/(generations|edits)$/.test(path)
    ? path.replace(/\/(generations|edits)$/, edit ? '/edits' : '/generations')
    : `${path}/images/${edit ? 'edits' : 'generations'}`
  return { endpoint: url.toString(), body, edit, images, outputFormat, size }
}

export function previewOpenAiImageRequest(
  config: FrontendWorkshopImageGenerationConfig,
  request: FrontendWorkshopImageGenerationRequest,
) {
  const prepared = buildOpenAiImageRequest(config, request)
  return redactImageRequest(
    {
      endpoint: diagnosticEndpoint(prepared.endpoint),
      encoding: prepared.edit ? 'multipart/form-data' : 'application/json',
      payload: {
        ...prepared.body,
        ...(prepared.edit
          ? {
              'image[]': prepared.images.map(
                (image, index) => `[图片 ${index + 1}, ${image.blob?.type ?? 'data URL'}]`,
              ),
            }
          : {}),
        ...(request.openAiMask ? { mask: '[PNG mask]' } : {}),
      },
    },
    config.apiKey,
  )
}

export function openAiInputBlob(input: { blob?: Blob; dataUrl?: string }): Blob {
  const blob =
    input.blob ?? (input.dataUrl ? decodeGeneratedImageDataUrl(input.dataUrl) : undefined)
  if (!blob || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
    throw new Error('输入图片必须为 PNG / JPEG / WebP')
  if (!blob.size || blob.size >= 50 * 1024 * 1024) throw new Error('输入图片必须非空且小于 50 MiB')
  return blob
}

export async function validateOpenAiMask(image: Blob, mask: Blob): Promise<void> {
  if (image.type !== 'image/png') throw new Error('使用 Mask 时，第一张输入图片请使用同尺寸 PNG')
  const [source, overlay] = await Promise.all([
    image.slice(0, 33).arrayBuffer(),
    mask.slice(0, 33).arrayBuffer(),
  ])
  const dimensions = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer)
    if (
      bytes.length < 33 ||
      bytes[0] !== 137 ||
      bytes[1] !== 80 ||
      bytes[2] !== 78 ||
      bytes[3] !== 71
    )
      throw new Error('PNG 文件头无效')
    const view = new DataView(buffer)
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      alpha: bytes[25] === 4 || bytes[25] === 6,
    }
  }
  const original = dimensions(source)
  const alpha = dimensions(overlay)
  if (!alpha.alpha || alpha.width !== original.width || alpha.height !== original.height)
    throw new Error('Mask 必须含透明通道，且与第一张 PNG 图片尺寸一致')
}
