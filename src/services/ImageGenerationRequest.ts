import type {
  FrontendWorkshopImageProvider,
  FrontendWorkshopImageModelOption,
  FrontendWorkshopImageGenerationConfig,
} from '../types/ImageGeneration'

export const DEFAULT_ENDPOINTS: Record<FrontendWorkshopImageProvider, string> = {
  openai: 'https://api.openai.com/v1/images/generations',
  novelai: 'https://image.novelai.net/ai/generate-image',
}

export const DEFAULT_MODELS: Record<FrontendWorkshopImageProvider, string> = {
  openai: 'gpt-image-2',
  novelai: 'nai-diffusion-4-5-full',
}

export const NOVELAI_MODELS: FrontendWorkshopImageModelOption[] = [
  { id: 'nai-diffusion-5-full', name: 'NAI Diffusion V5 Full' },
  { id: 'nai-diffusion-5-curated', name: 'NAI Diffusion V5 Curated' },
  { id: 'nai-diffusion-4-5-full', name: 'NAI Diffusion V4.5 Full' },
  { id: 'nai-diffusion-4-5-curated', name: 'NAI Diffusion V4.5 Curated' },
  { id: 'nai-diffusion-4-full', name: 'NAI Diffusion V4 Full' },
  { id: 'nai-diffusion-4-curated-preview', name: 'NAI Diffusion V4 Curated' },
  { id: 'nai-diffusion-3', name: 'NAI Diffusion Anime V3' },
  { id: 'nai-diffusion-furry-3', name: 'NAI Diffusion Furry V3' },
]

export function requiredHttpsUrl(value: string, fallback: string): string {
  let url: URL
  try {
    url = new URL(value.trim() || fallback)
  } catch {
    throw new Error('生图 API 地址无效，请在连接设置中填写完整的 HTTPS 地址')
  }
  if (url.protocol !== 'https:') throw new Error('生图 API 地址必须使用 HTTPS')
  if (url.username || url.password) throw new Error('生图 API 地址不能包含用户名或密码')
  return url.toString()
}

export function validateImageGenerationConfig(config: FrontendWorkshopImageGenerationConfig): void {
  requiredHttpsUrl(config.endpoint, DEFAULT_ENDPOINTS[config.provider])
  if (!config.model.trim()) throw new Error('请在连接设置中填写模型 ID 或选择模型')
  if (!config.apiKey.trim()) throw new Error('请在连接设置中填写当前供应商的 API 密钥')
}

export function diagnosticEndpoint(value: string): string {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Number(value)))
}

export function redactImageRequest<T>(value: T, apiKey = ''): T {
  const secrets = apiKey ? [apiKey, encodeURIComponent(apiKey)] : []
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (/(authorization|api.?key|token|secret|headers?|password)/i.test(key)) return '[已脱敏]'
      if (typeof item !== 'string') return item
      let text = item
        .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据]')
        .replace(/Bearer\s+\S+/gi, '[已脱敏]')
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已脱敏]')
      for (const secret of secrets) text = text.split(secret).join('[已脱敏]')
      return text
    }),
  ) as T
}
