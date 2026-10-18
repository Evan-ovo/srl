import type {
  FrontendWorkshopImageFormat,
  FrontendWorkshopImageProvider,
  FrontendWorkshopNovelAiSampler,
  FrontendWorkshopOpenAiBackground,
  FrontendWorkshopOpenAiQuality,
} from './FrontendWorkshopImageGenerationService'
import type { NovelAiQualityMode } from './ImageGenerationCapabilities'

export interface FrontendWorkshopImagePromptHints {
  人物: string
  场景: string
  构图: string
  风格: string
}

export interface FrontendWorkshopImageDraftCharacter {
  prompt: string
  negativePrompt: string
  positioned: boolean
  x: number
  y: number
}

export interface FrontendWorkshopImageDraft {
  version: 1
  provider: FrontendWorkshopImageProvider
  endpoint: string
  model: string
  prompt: string
  negativePrompt: string
  imageText?: string
  promptHints?: FrontendWorkshopImagePromptHints
  novelAiCharacters?: FrontendWorkshopImageDraftCharacter[]
  width: number
  height: number
  openAiQuality: FrontendWorkshopOpenAiQuality
  openAiBackground: FrontendWorkshopOpenAiBackground
  outputFormat: FrontendWorkshopImageFormat
  outputCompression: number
  novelAiSampler: FrontendWorkshopNovelAiSampler
  novelAiSteps: number
  novelAiScale: number
  novelAiSeed?: number
  /** Legacy compatibility for drafts written before exact quality modes were persisted. */
  novelAiQualityToggle: boolean
  novelAiQualityMode?: NovelAiQualityMode
  novelAiUcPreset?: string
  novelAiTransparentBackground?: boolean
  novelAiSmea: boolean
  novelAiSmeaDyn: boolean
  savedAt: number
}

export interface FrontendWorkshopImageTemplate {
  id: string
  name: string
  draft: FrontendWorkshopImageDraft
  createdAt: number
  updatedAt: number
}

export interface FrontendWorkshopImageDraftStore {
  version: 2
  activeProvider?: FrontendWorkshopImageProvider
  drafts: Partial<Record<FrontendWorkshopImageProvider, FrontendWorkshopImageDraft>>
}

export interface ImageGenerationWorkBackup {
  version: 1
  store: FrontendWorkshopImageDraftStore
  templates: FrontendWorkshopImageTemplate[]
}

const IMAGE_DRAFT_KEY = 'srl.frontendWorkshop.imageGeneration.draft.v1'
const IMAGE_TEMPLATES_KEY = 'srl.frontendWorkshop.imageGeneration.templates.v1'
const TEMPLATE_LIMIT = 30

const PROVIDERS = ['openai', 'novelai'] as const
const OPENAI_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
const OPENAI_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const
const NOVELAI_SAMPLERS = [
  'k_dpmpp_2m',
  'k_euler_ancestral',
  'k_euler',
  'k_dpm_2',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_sde',
  'k_dpm_fast',
  'ddim',
] as const
const NOVELAI_QUALITY_MODES = ['off', 'light', 'standard'] as const
const NOVELAI_UC_PRESETS = ['none', 'heavy', 'light'] as const
const EMPTY_PROMPT_HINTS: FrontendWorkshopImagePromptHints = {
  人物: '',
  场景: '',
  构图: '',
  风格: '',
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) return fallback
  return Math.min(max, Math.max(min, normalized))
}

function normalizePromptHints(value: unknown): FrontendWorkshopImagePromptHints {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PROMPT_HINTS }
  const raw = value as Partial<FrontendWorkshopImagePromptHints>
  return {
    人物: String(raw.人物 ?? '').slice(0, 1200),
    场景: String(raw.场景 ?? '').slice(0, 1200),
    构图: String(raw.构图 ?? '').slice(0, 1200),
    风格: String(raw.风格 ?? '').slice(0, 1200),
  }
}

function normalizeCharacters(value: unknown): FrontendWorkshopImageDraftCharacter[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 22).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Partial<FrontendWorkshopImageDraftCharacter>
    const x = numberInRange(raw.x, 0.5, 0, 1)
    const y = numberInRange(raw.y, 0.5, 0, 1)
    return [
      {
        prompt: String(raw.prompt ?? '').slice(0, 3000),
        negativePrompt: String(raw.negativePrompt ?? '').slice(0, 2000),
        positioned: raw.positioned === true,
        x,
        y,
      },
    ]
  })
}

function normalizeDraft(value: unknown): FrontendWorkshopImageDraft | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<FrontendWorkshopImageDraft>
  const rawProvider = String(raw.provider ?? '')
  const provider =
    rawProvider === 'custom'
      ? 'openai'
      : PROVIDERS.includes(rawProvider as FrontendWorkshopImageProvider)
        ? (rawProvider as FrontendWorkshopImageProvider)
        : undefined
  if (!provider) return undefined
  const fallbackWidth = provider === 'novelai' ? 832 : 1024
  const fallbackHeight = provider === 'novelai' ? 1216 : 1024
  const novelAiSampler = NOVELAI_SAMPLERS.includes(
    raw.novelAiSampler as FrontendWorkshopNovelAiSampler,
  )
    ? (raw.novelAiSampler as FrontendWorkshopNovelAiSampler)
    : 'k_dpmpp_2m'
  const openAiQuality = OPENAI_QUALITIES.includes(
    raw.openAiQuality as FrontendWorkshopOpenAiQuality,
  )
    ? (raw.openAiQuality as FrontendWorkshopOpenAiQuality)
    : 'auto'
  const openAiBackground = OPENAI_BACKGROUNDS.includes(
    raw.openAiBackground as FrontendWorkshopOpenAiBackground,
  )
    ? (raw.openAiBackground as FrontendWorkshopOpenAiBackground)
    : 'auto'
  const outputFormat = IMAGE_FORMATS.includes(raw.outputFormat as FrontendWorkshopImageFormat)
    ? (raw.outputFormat as FrontendWorkshopImageFormat)
    : 'png'
  const legacyQualityToggle = raw.novelAiQualityToggle !== false
  const novelAiQualityMode = NOVELAI_QUALITY_MODES.includes(
    raw.novelAiQualityMode as NovelAiQualityMode,
  )
    ? (raw.novelAiQualityMode as NovelAiQualityMode)
    : legacyQualityToggle
      ? 'standard'
      : 'off'
  const novelAiUcPreset = NOVELAI_UC_PRESETS.includes(
    raw.novelAiUcPreset as (typeof NOVELAI_UC_PRESETS)[number],
  )
    ? String(raw.novelAiUcPreset)
    : 'none'
  const seed = Number(raw.novelAiSeed)
  return {
    version: 1,
    provider,
    endpoint: String(raw.endpoint ?? '')
      .trim()
      .slice(0, 2048),
    model: String(raw.model ?? '')
      .trim()
      .slice(0, 256),
    prompt: String(raw.prompt ?? '').slice(0, 6000),
    negativePrompt: String(raw.negativePrompt ?? '').slice(0, 3000),
    imageText: String(raw.imageText ?? '').slice(0, 1200),
    promptHints:
      provider === 'openai' ? normalizePromptHints(raw.promptHints) : { ...EMPTY_PROMPT_HINTS },
    novelAiCharacters: provider === 'novelai' ? normalizeCharacters(raw.novelAiCharacters) : [],
    width: Math.round(numberInRange(raw.width, fallbackWidth, 64, 1536)),
    height: Math.round(numberInRange(raw.height, fallbackHeight, 64, 1536)),
    openAiQuality,
    openAiBackground,
    outputFormat,
    outputCompression: Math.round(numberInRange(raw.outputCompression, 90, 0, 100)),
    novelAiSampler,
    novelAiSteps: Math.round(numberInRange(raw.novelAiSteps, 28, 1, 50)),
    novelAiScale: numberInRange(raw.novelAiScale, 5, 0, 10),
    novelAiSeed: Number.isFinite(seed) && seed >= 0 && seed <= 4_294_967_295 ? seed : undefined,
    novelAiQualityToggle: novelAiQualityMode !== 'off',
    novelAiQualityMode,
    novelAiUcPreset,
    novelAiTransparentBackground: raw.novelAiTransparentBackground === true,
    novelAiSmea: raw.novelAiSmea === true,
    novelAiSmeaDyn: raw.novelAiSmea === true && raw.novelAiSmeaDyn === true,
    savedAt: numberInRange(raw.savedAt, Date.now(), 1, Number.MAX_SAFE_INTEGER),
  }
}

function normalizeDraftStore(value: unknown): FrontendWorkshopImageDraftStore {
  const legacyDraft = normalizeDraft(value)
  if (legacyDraft) {
    return {
      version: 2,
      activeProvider: legacyDraft.provider,
      drafts: { [legacyDraft.provider]: legacyDraft },
    }
  }
  if (!value || typeof value !== 'object') return { version: 2, drafts: {} }
  const raw = value as Partial<FrontendWorkshopImageDraftStore>
  if (raw.version !== 2 || !raw.drafts || typeof raw.drafts !== 'object') {
    return { version: 2, drafts: {} }
  }
  const drafts: FrontendWorkshopImageDraftStore['drafts'] = {}
  for (const provider of PROVIDERS) {
    const draft = normalizeDraft(raw.drafts[provider])
    if (draft?.provider === provider) drafts[provider] = draft
  }
  const legacyProviderDraft = normalizeDraft((raw.drafts as Record<string, unknown>).custom)
  if (legacyProviderDraft && !drafts.openai) drafts.openai = legacyProviderDraft
  const rawActiveProvider = String(raw.activeProvider ?? '')
  const activeProvider =
    rawActiveProvider === 'custom'
      ? 'openai'
      : PROVIDERS.includes(rawActiveProvider as FrontendWorkshopImageProvider)
        ? (rawActiveProvider as FrontendWorkshopImageProvider)
        : undefined
  return {
    version: 2,
    activeProvider: activeProvider && drafts[activeProvider] ? activeProvider : undefined,
    drafts,
  }
}

function templateId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `image-template-${Date.now()}-${Math.random()}`
}

export class FrontendWorkshopImageDraftService {
  exportPortableState(): ImageGenerationWorkBackup {
    return { version: 1, store: this.readDraftStore(), templates: this.listTemplates() }
  }

  async importPortableState(value: ImageGenerationWorkBackup): Promise<void> {
    if (
      value.version !== 1 ||
      !Array.isArray(value.templates) ||
      !value.store ||
      value.store.version !== 2
    )
      throw new Error('生图工作区备份格式无效')
    const store = normalizeDraftStore(value.store)
    const previous = this.readDraftStore()
    const templates = this.listTemplates()
    const { hashBytes } = await import('./HashService')
    for (const provider of PROVIDERS) {
      const local = previous.drafts[provider],
        incoming = store.drafts[provider]
      if (local && incoming && JSON.stringify(local) !== JSON.stringify(incoming)) {
        const displaced = local.savedAt > incoming.savedAt ? incoming : local
        const digest = await hashBytes(new TextEncoder().encode(JSON.stringify(displaced)))
        const id = 'restored-draft-' + digest.slice(0, 16)
        if (!templates.some((row) => row.id === id))
          templates.push({
            id,
            name: '恢复时保留的 ' + provider + ' 草稿',
            draft: displaced,
            createdAt: displaced.savedAt,
            updatedAt: displaced.savedAt,
          })
      }
      if (local && (!incoming || local.savedAt > incoming.savedAt)) store.drafts[provider] = local
    }
    for (const template of value.templates) {
      const draft = normalizeDraft(template.draft)
      if (!draft || !template.id || !template.name) throw new Error('生图模板备份无效')
      let id = template.id
      const local = templates.find((row) => row.id === id)
      if (local && JSON.stringify(local) !== JSON.stringify(template)) {
        const digest = await hashBytes(new TextEncoder().encode(JSON.stringify(template)))
        id += '-restored-' + digest.slice(0, 16)
      }
      if (!templates.some((row) => row.id === id)) templates.push({ ...template, id, draft })
    }
    if (templates.length > TEMPLATE_LIMIT)
      throw new Error(`合并后生图模板超过 ${TEMPLATE_LIMIT} 份；请先导出或整理本机模板后重试`)
    const beforeDraft = localStorage.getItem(IMAGE_DRAFT_KEY),
      beforeTemplates = localStorage.getItem(IMAGE_TEMPLATES_KEY)
    try {
      localStorage.setItem(IMAGE_DRAFT_KEY, JSON.stringify(store))
      localStorage.setItem(IMAGE_TEMPLATES_KEY, JSON.stringify(templates))
      if (
        localStorage.getItem(IMAGE_DRAFT_KEY) !== JSON.stringify(store) ||
        localStorage.getItem(IMAGE_TEMPLATES_KEY) !== JSON.stringify(templates)
      )
        throw new Error('生图工作区保存后读回失败')
    } catch (cause) {
      if (beforeDraft === null) localStorage.removeItem(IMAGE_DRAFT_KEY)
      else localStorage.setItem(IMAGE_DRAFT_KEY, beforeDraft)
      if (beforeTemplates === null) localStorage.removeItem(IMAGE_TEMPLATES_KEY)
      else localStorage.setItem(IMAGE_TEMPLATES_KEY, beforeTemplates)
      throw cause
    }
  }

  loadDraft(provider?: FrontendWorkshopImageProvider): FrontendWorkshopImageDraft | undefined {
    const store = this.readDraftStore()
    if (provider) return store.drafts[provider]
    if (store.activeProvider) return store.drafts[store.activeProvider]
    return Object.values(store.drafts).sort((left, right) => right.savedAt - left.savedAt)[0]
  }

  saveDraft(value: FrontendWorkshopImageDraft): FrontendWorkshopImageDraft {
    const normalized = normalizeDraft({ ...value, savedAt: Date.now() })
    if (!normalized) throw new Error('当前生图草稿无效')
    const store = this.readDraftStore()
    store.activeProvider = normalized.provider
    store.drafts[normalized.provider] = normalized
    this.writeDraftStore(store)
    return normalized
  }

  clearDraft(provider?: FrontendWorkshopImageProvider): void {
    if (provider) {
      const store = this.readDraftStore()
      delete store.drafts[provider]
      if (store.activeProvider === provider) {
        store.activeProvider = Object.values(store.drafts).sort(
          (left, right) => right.savedAt - left.savedAt,
        )[0]?.provider
      }
      if (Object.keys(store.drafts).length) this.writeDraftStore(store)
      else this.removeDraftStore()
      return
    }
    this.removeDraftStore()
  }

  private removeDraftStore(): void {
    try {
      localStorage.removeItem(IMAGE_DRAFT_KEY)
    } catch {
      // 清理失败不影响当前会话继续编辑。
    }
  }

  listTemplates(): FrontendWorkshopImageTemplate[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(IMAGE_TEMPLATES_KEY) ?? '[]')
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((item): FrontendWorkshopImageTemplate | undefined => {
          if (!item || typeof item !== 'object') return undefined
          const raw = item as Partial<FrontendWorkshopImageTemplate>
          const draft = normalizeDraft(raw.draft)
          const name = String(raw.name ?? '')
            .trim()
            .slice(0, 80)
          if (!draft || !name || typeof raw.id !== 'string') return undefined
          return {
            id: raw.id,
            name,
            draft,
            createdAt: numberInRange(raw.createdAt, Date.now(), 1, Number.MAX_SAFE_INTEGER),
            updatedAt: numberInRange(raw.updatedAt, Date.now(), 1, Number.MAX_SAFE_INTEGER),
          }
        })
        .filter((item): item is FrontendWorkshopImageTemplate => Boolean(item))
        .slice(0, TEMPLATE_LIMIT)
    } catch {
      return []
    }
  }

  saveTemplate(name: string, draft: FrontendWorkshopImageDraft): FrontendWorkshopImageTemplate {
    const normalizedName = name.trim().slice(0, 80)
    if (!normalizedName) throw new Error('请先填写模板名称')
    const normalizedDraft = normalizeDraft({ ...draft, savedAt: Date.now() })
    if (!normalizedDraft) throw new Error('当前生成配置无法保存为模板')
    const now = Date.now()
    const template: FrontendWorkshopImageTemplate = {
      id: templateId(),
      name: normalizedName,
      draft: normalizedDraft,
      createdAt: now,
      updatedAt: now,
    }
    this.writeTemplates([template, ...this.listTemplates()])
    return template
  }

  overwriteTemplate(
    id: string,
    draft: FrontendWorkshopImageDraft,
  ): FrontendWorkshopImageTemplate | undefined {
    const templates = this.listTemplates()
    const index = templates.findIndex((item) => item.id === id)
    if (index < 0) return undefined
    const normalizedDraft = normalizeDraft({ ...draft, savedAt: Date.now() })
    if (!normalizedDraft) throw new Error('当前生成配置无法覆盖模板')
    const present = templates[index]
    const updated: FrontendWorkshopImageTemplate = {
      ...present,
      draft: normalizedDraft,
      updatedAt: Date.now(),
    }
    templates.splice(index, 1, updated)
    this.writeTemplates(templates)
    return updated
  }

  deleteTemplate(id: string): void {
    this.writeTemplates(this.listTemplates().filter((item) => item.id !== id))
  }

  private writeTemplates(value: FrontendWorkshopImageTemplate[]): void {
    try {
      const text = JSON.stringify(value.slice(0, TEMPLATE_LIMIT))
      localStorage.setItem(IMAGE_TEMPLATES_KEY, text)
      if (localStorage.getItem(IMAGE_TEMPLATES_KEY) !== text) throw new Error('保存后读回不一致')
    } catch (cause) {
      throw new Error('模板未能保存到本机，请检查存储空间或浏览器存储权限；当前画面描述仍保留', {
        cause,
      })
    }
  }

  private readDraftStore(): FrontendWorkshopImageDraftStore {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(IMAGE_DRAFT_KEY) ?? 'null')
      const normalized = normalizeDraftStore(parsed)
      const raw = parsed as { provider?: unknown; drafts?: Record<string, unknown> } | null
      if (
        raw &&
        typeof raw === 'object' &&
        (raw.provider === 'custom' || raw.drafts?.custom !== undefined)
      )
        this.writeDraftStore(normalized)
      return normalized
    } catch {
      return { version: 2, drafts: {} }
    }
  }

  private writeDraftStore(value: FrontendWorkshopImageDraftStore): void {
    try {
      localStorage.setItem(IMAGE_DRAFT_KEY, JSON.stringify(value))
    } catch {
      // 本机存储不可用时不阻断当前生成会话。
    }
  }
}

export const frontendWorkshopImageDraftService = new FrontendWorkshopImageDraftService()
