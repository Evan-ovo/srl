import { isRetryableProviderCategory } from '../core/ProviderError'
import type {
  FrontendWorkshopImageProvider,
  FrontendWorkshopImageGenerationDiagnostic,
  FrontendWorkshopImageGenerationErrorCategory,
} from '../types/ImageGeneration'

export class FrontendWorkshopImageGenerationError extends Error {
  readonly diagnostic: FrontendWorkshopImageGenerationDiagnostic

  constructor(message: string, diagnostic: FrontendWorkshopImageGenerationDiagnostic) {
    super(message)
    this.name = 'FrontendWorkshopImageGenerationError'
    this.diagnostic = diagnostic
  }
}

export function responseErrorDetail(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const parsed = value as { error?: { message?: unknown } | string; message?: unknown }
  const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
  if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 500)
  if (typeof parsed.message === 'string' && parsed.message.trim())
    return parsed.message.slice(0, 500)
}

export async function responseError(response: Response): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return `HTTP ${response.status}（错误响应正文读取失败）`
  }
  if (!body) return `HTTP ${response.status}`
  try {
    return responseErrorDetail(JSON.parse(body)) ?? `HTTP ${response.status}（接口未提供文字说明）`
  } catch {
    return body.slice(0, 500)
  }
}

export function imageGenerationErrorCategory(
  status: number,
): FrontendWorkshopImageGenerationErrorCategory {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || status === 429) return 'rate_limit'
  if (status === 400 || status === 422) return 'request'
  if (status >= 500) return 'server'
  return 'response_parse'
}

function providerErrorMessage(
  provider: FrontendWorkshopImageProvider,
  category: FrontendWorkshopImageGenerationErrorCategory,
  status?: number,
): string {
  const label =
    provider === 'novelai' ? 'NovelAI' : provider === 'openai' ? 'OpenAI' : '第三方兼容接口'
  if (category === 'network')
    return `${label} 连接中断，未能取得响应；请检查网络、API 地址和跨域设置，确认供应商任务状态后再手动重试。`
  if (category === 'auth')
    return `${label} 验证失败（HTTP ${status}），请检查 API 密钥及模型使用权限。`
  if (status === 402) return `${label} 额度不足（HTTP 402），请检查账户余额或套餐。`
  if (category === 'rate_limit') return `${label} 请求受限（HTTP 429），请检查额度或稍后手动重试。`
  if (status === 404) return `${label} 接口或模型不存在（HTTP 404），请检查 API 地址与模型 ID。`
  if (status === 413) return `${label} 拒绝了过大的图片或请求（HTTP 413），请减少参考图数量或大小。`
  if (category === 'request')
    return `${label} 拒绝了当前模型或请求参数${status ? `（HTTP ${status}）` : ''}。`
  if (category === 'server')
    return `${label} 返回 HTTP ${status ?? 500}；请求已到达服务端，但生成失败。`
  return `${label} 返回了无法解析的结果${status ? `（HTTP ${status}）` : ''}。`
}

function reportProviderDiagnostic(diagnostic: FrontendWorkshopImageGenerationDiagnostic): void {
  if (!import.meta.env.DEV) return
  console.warn('[FrontendWorkshopImageGeneration]', diagnostic)
}

export function createProviderError(
  provider: FrontendWorkshopImageProvider,
  endpoint: string,
  model: string,
  parameters: Record<string, string | number | boolean>,
  category: FrontendWorkshopImageGenerationErrorCategory,
  options: {
    httpStatus?: number
    statusText?: string
    responseContentType?: string
    responseBody?: string
    requestId?: string
  } = {},
): FrontendWorkshopImageGenerationError {
  const baseMessage = providerErrorMessage(provider, category, options.httpStatus)
  const detail = options.responseBody?.trim()
  const message = detail
    ? `${baseMessage} 服务端说明：${/<(?:!doctype|html|body)[\s>]/iu.test(detail) ? '返回了网页内容，请核对 API 地址。' : detail.replace(/\s+/gu, ' ').slice(0, 240)}`
    : baseMessage
  const diagnostic: FrontendWorkshopImageGenerationDiagnostic = {
    provider,
    endpoint,
    model,
    category,
    message,
    detail: options.responseBody,
    retryable: isRetryableProviderCategory(category),
    parameters,
    ...options,
  }
  reportProviderDiagnostic(diagnostic)
  return new FrontendWorkshopImageGenerationError(diagnostic.message, diagnostic)
}
