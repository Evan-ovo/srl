import type { FrontendWorkshopImageProvider } from './FrontendWorkshopImageGenerationService'

export type ImageGenerationCapabilityLevel = 'supported' | 'unsupported' | 'unknown'
export type NovelAiModelFamily = 'v3' | 'v4' | 'v4.5' | 'v5' | 'unknown'
export type NovelAiQualityMode = 'off' | 'light' | 'standard'
export const OPENAI_IMAGE_MODEL_PROFILES = [
  { id: 'gpt-image-2', name: 'GPT Image 2' },
  { id: 'gpt-image-1.5', name: 'GPT Image 1.5' },
  { id: 'gpt-image-1', name: 'GPT Image 1' },
  { id: 'gpt-image-1-mini', name: 'GPT Image 1 mini' },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
  { id: 'chatgpt-image-latest', name: 'ChatGPT Image' },
] as const
export type OpenAiImageModelProfile = (typeof OPENAI_IMAGE_MODEL_PROFILES)[number]['id']
export function isOpenAiImageModelProfile(value: unknown): value is OpenAiImageModelProfile {
  return OPENAI_IMAGE_MODEL_PROFILES.some((profile) => profile.id === value)
}
export const NOVELAI_POSITION_GRID = [0.1, 0.3, 0.5, 0.7, 0.9] as const

export function novelAiGridCoordinate(value: number): number {
  return NOVELAI_POSITION_GRID.reduce<number>(
    (best, point) => (Math.abs(point - value) < Math.abs(best - value) ? point : best),
    0.5,
  )
}

export function isOfficialOpenAiImageEndpoint(endpoint?: string): boolean {
  if (!endpoint?.trim()) return true // Empty configuration uses the existing official default.
  try {
    return new URL(endpoint).origin === 'https://api.openai.com'
  } catch {
    return false
  }
}

export function isGptImageModel(model: string): boolean {
  return /^(gpt-image-(1|1-mini|1\.5|2|2\.5-(sunburst|flare))(-\d{4}-\d{2}-\d{2})?|chatgpt-image-latest)$/.test(
    model.trim(),
  )
}
export const RELAY_CAPABILITY_KEYS = [
  'quality',
  'outputFormat',
  'outputCompression',
  'background',
  'imageEdit',
  'imageInput',
  'multiImage',
  'mask',
] as const
export type RelayCapabilityKey = (typeof RELAY_CAPABILITY_KEYS)[number]
export type RelayCapabilityDeclaration = Partial<Record<RelayCapabilityKey, boolean>>
export interface RelayCapabilityEvidence {
  endpoint: string
  model: string
  modelProfile?: OpenAiImageModelProfile
  declared?: RelayCapabilityDeclaration
  manual?: RelayCapabilityDeclaration
}

export interface ImageGenerationCapabilities {
  provider: FrontendWorkshopImageProvider
  model: string
  textToImage: ImageGenerationCapabilityLevel
  negativePrompt: ImageGenerationCapabilityLevel
  multiCharacter: ImageGenerationCapabilityLevel
  characterPrompts: ImageGenerationCapabilityLevel
  maxCharacters: number
  characterPositioning: ImageGenerationCapabilityLevel
  freeCharacterPositioning: boolean
  transparentBackground: ImageGenerationCapabilityLevel
  textRendering: ImageGenerationCapabilityLevel
  multilingualPrompt: ImageGenerationCapabilityLevel
  vibeTransfer: ImageGenerationCapabilityLevel
  preciseReference: ImageGenerationCapabilityLevel
  sampler: ImageGenerationCapabilityLevel
  steps: ImageGenerationCapabilityLevel
  guidance: ImageGenerationCapabilityLevel
  seed: ImageGenerationCapabilityLevel
  ucPreset: ImageGenerationCapabilityLevel
  qualityMode: ImageGenerationCapabilityLevel
  qualityModes: NovelAiQualityMode[]
  smea: ImageGenerationCapabilityLevel
  imageInput: ImageGenerationCapabilityLevel
  imageEdit: ImageGenerationCapabilityLevel
  multiImage: ImageGenerationCapabilityLevel
  mask: ImageGenerationCapabilityLevel
  maxInputImages: number
  quality: ImageGenerationCapabilityLevel
  background: ImageGenerationCapabilityLevel
  outputFormat: ImageGenerationCapabilityLevel
  outputCompression: ImageGenerationCapabilityLevel
  sizes: string[]
  compatibilityLevel: 'basic' | 'enhanced' | 'editing'
  sources: Partial<Record<RelayCapabilityKey, 'profile' | 'selection' | 'metadata' | 'manual'>>
  notes: string[]
}

// Confirmed in NovelAI's public production client, 2026-08-30 (build 6750aa2).
export function getNovelAiModelFamily(model: string): NovelAiModelFamily {
  const id = model.trim().toLowerCase()
  if (/^nai-diffusion-5-(full|curated)$/.test(id)) return 'v5'
  if (/^nai-diffusion-4-5-(full|curated)$/.test(id)) return 'v4.5'
  if (/^nai-diffusion-4-(full|curated-preview)$/.test(id)) return 'v4'
  if (/^nai-diffusion-(furry-)?3$/.test(id)) return 'v3'
  return 'unknown'
}

export function readRelayCapabilities(value: unknown): RelayCapabilityDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const fields: Record<RelayCapabilityKey, string> = {
    quality: 'quality',
    outputFormat: 'output_format',
    outputCompression: 'output_compression',
    background: 'background',
    imageEdit: 'edits',
    imageInput: 'image_input',
    multiImage: 'multi_image',
    mask: 'mask',
  }
  return Object.fromEntries(
    RELAY_CAPABILITY_KEYS.flatMap((key) => {
      const v = raw[fields[key]] ?? raw[key]
      return typeof v === 'boolean' ? [[key, v]] : []
    }),
  )
}

export function getImageGenerationCapabilities(
  provider: FrontendWorkshopImageProvider,
  model: string,
  evidence?: RelayCapabilityEvidence,
  endpoint?: string,
): ImageGenerationCapabilities {
  const caps: ImageGenerationCapabilities = {
    provider,
    model: model.trim(),
    textToImage: 'supported',
    negativePrompt: 'unsupported',
    multiCharacter: 'unsupported',
    characterPrompts: 'unsupported',
    maxCharacters: 0,
    characterPositioning: 'unsupported',
    freeCharacterPositioning: false,
    transparentBackground: 'unsupported',
    textRendering: 'unknown',
    multilingualPrompt: 'unknown',
    vibeTransfer: 'unsupported',
    preciseReference: 'unsupported',
    sampler: 'unsupported',
    steps: 'unsupported',
    guidance: 'unsupported',
    seed: 'unsupported',
    ucPreset: 'unsupported',
    qualityMode: 'unsupported',
    qualityModes: [],
    smea: 'unsupported',
    imageInput: 'unknown',
    imageEdit: 'unknown',
    multiImage: 'unknown',
    mask: 'unknown',
    maxInputImages: 16,
    quality: 'unknown',
    background: 'unknown',
    outputFormat: 'unknown',
    outputCompression: 'unknown',
    sizes: ['1024x1024', '1024x1536', '1536x1024'],
    compatibilityLevel: 'basic',
    sources: {},
    notes: [],
  }
  if (provider === 'novelai') {
    const family = getNovelAiModelFamily(model)
    const known = family !== 'unknown'
    const modern = known && family !== 'v3'
    for (const key of [
      'negativePrompt',
      'sampler',
      'steps',
      'guidance',
      'seed',
      'ucPreset',
      'qualityMode',
    ] as const)
      caps[key] = known ? 'supported' : 'unknown'
    caps.textToImage = known ? 'supported' : 'unsupported'
    caps.multiCharacter =
      caps.characterPrompts =
      caps.characterPositioning =
        modern ? 'supported' : 'unsupported'
    caps.maxCharacters = family === 'v5' ? 22 : modern ? 6 : 0
    caps.freeCharacterPositioning = family === 'v5'
    caps.transparentBackground = family === 'v5' ? 'supported' : 'unsupported'
    caps.textRendering = modern ? 'supported' : 'unsupported'
    caps.multilingualPrompt = family === 'v5' ? 'supported' : 'unsupported'
    caps.smea = family === 'v3' ? 'supported' : 'unsupported'
    caps.qualityModes =
      family === 'v5' ? ['off', 'light', 'standard'] : known ? ['off', 'standard'] : []
    // These describe model support, independently of this client's reference transport readiness.
    caps.vibeTransfer = modern ? 'supported' : known ? 'unknown' : 'unsupported'
    caps.preciseReference = family === 'v4.5' ? 'supported' : 'unsupported'
    caps.imageInput = caps.imageEdit = caps.multiImage = caps.mask = 'unsupported'
    caps.outputFormat = caps.outputCompression = caps.background = caps.quality = 'unsupported'
    caps.sizes = []
    caps.notes = [
      !known
        ? '此 NovelAI 模型的请求结构尚未接通，请选择列表中的已支持模型。'
        : family === 'v5'
          ? 'V5 支持多语言提示词、透明背景和最多 22 个角色。Vibe Transfer 官方支持，但项目当前尚未接通；Precise Reference 当前模型不支持。'
          : 'Vibe / Precise Reference 按模型能力声明支持；项目参考图请求链当前尚未接通。',
    ]
    return caps
  }
  const official = isOfficialOpenAiImageEndpoint(endpoint)
  const scoped = evidence?.endpoint === endpoint?.trim() && evidence?.model === model.trim()
  const selectedProfile =
    !official && scoped && isOpenAiImageModelProfile(evidence?.modelProfile)
      ? evidence.modelProfile
      : undefined
  const isGpt = isGptImageModel(selectedProfile ?? model)
  if (isGpt && (official || selectedProfile)) {
    for (const key of RELAY_CAPABILITY_KEYS) {
      caps[key] = 'supported'
      caps.sources[key] = official ? 'profile' : 'selection'
    }
    caps.transparentBackground = caps.textRendering = caps.multilingualPrompt = 'supported'
  } else if (provider === 'openai') {
    // A relay's model name does not establish its supported API fields.
    if (/^dall-e-[23]$/.test(model.trim())) {
      for (const key of RELAY_CAPABILITY_KEYS) {
        caps[key] = 'unsupported'
        caps.sources[key] = 'profile'
      }
    }
    if (isGpt) caps.textRendering = caps.multilingualPrompt = 'supported'
  }
  if (provider === 'openai') {
    if (scoped && evidence) {
      for (const key of RELAY_CAPABILITY_KEYS) {
        // Official/model constraints cannot be enabled by a manual relay checkbox.
        if (caps.sources[key] === 'profile' && caps[key] === 'unsupported') continue
        const declared = evidence.declared?.[key]
        const manual = evidence.manual?.[key]
        if (typeof declared === 'boolean') {
          caps[key] = declared ? 'supported' : 'unsupported'
          caps.sources[key] = 'metadata'
        } else if (typeof manual === 'boolean') {
          caps[key] = manual ? 'supported' : 'unsupported'
          caps.sources[key] = 'manual'
        }
      }
    }
    caps.transparentBackground =
      caps.background === 'unsupported' || caps.outputFormat === 'unsupported'
        ? 'unsupported'
        : caps.background === 'supported' && caps.outputFormat === 'supported'
          ? 'supported'
          : 'unknown'
    if (caps.imageInput !== 'supported' || caps.imageEdit !== 'supported') {
      const unavailable = caps.imageInput === 'unsupported' || caps.imageEdit === 'unsupported'
      for (const key of ['multiImage', 'mask'] as const)
        if (caps[key] !== 'unsupported') caps[key] = unavailable ? 'unsupported' : 'unknown'
    }
    caps.maxInputImages = caps.multiImage === 'supported' ? 16 : 1
    caps.notes = official
      ? []
      : [
          selectedProfile
            ? '功能按所选模型类型显示；接口明确声明不支持的能力仍会隐藏。模型类型仅对当前 API 地址与模型 ID 有效。'
            : '可选择实际模型类型；不确定时仅使用接口已声明或手动确认的能力。',
        ]
    if (official && /^dall-e-[23]$/.test(model.trim())) {
      caps.textToImage = 'unsupported'
      caps.notes = ['此 DALL·E 模型已在 OpenAI 官方接口退役，请更换为可用的 GPT Image 模型。']
    } else if (
      official &&
      /^(gpt-(?!image-)|o[134](?:[-.]|$)|text-|whisper-|tts-|chatgpt-(?!image-))/.test(model.trim())
    ) {
      caps.textToImage = 'unsupported'
      caps.notes = ['当前模型不支持 Images 生图接口，请更换 GPT Image 模型。']
    }
  }
  if (!selectedProfile && model.trim() === 'dall-e-2')
    caps.sizes = ['256x256', '512x512', '1024x1024']
  if (!selectedProfile && model.trim() === 'dall-e-3')
    caps.sizes = ['1024x1024', '1024x1792', '1792x1024']
  caps.compatibilityLevel = ['imageEdit', 'imageInput', 'multiImage', 'mask'].every(
    (key) => caps[key as RelayCapabilityKey] === 'supported',
  )
    ? 'editing'
    : ['quality', 'outputFormat', 'outputCompression', 'background'].every(
          (key) => caps[key as RelayCapabilityKey] === 'supported',
        )
      ? 'enhanced'
      : 'basic'
  return caps
}
