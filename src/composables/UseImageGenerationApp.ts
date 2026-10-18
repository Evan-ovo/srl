import { computed, onUnmounted, ref, watch } from 'vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import { frontendWorkshopImageGenerationService } from '../core/ImageGenerationContainer'
import {
  frontendWorkshopImageHostingService,
  generatedImageAlbumService,
} from '../core/ImageAlbumContainer'
import { isNativeFileExportAvailable, saveBlobToNativeDestination } from '../core/NativeFileExport'
import {
  frontendWorkshopImageDraftService,
  type FrontendWorkshopImageDraft,
  type FrontendWorkshopImageTemplate,
} from '../services/FrontendWorkshopImageDraftService'
import type {
  FrontendWorkshopGeneratedImage,
  FrontendWorkshopImageGenerationRequest,
  FrontendWorkshopImageModelOption,
  FrontendWorkshopImageProvider,
} from '../services/FrontendWorkshopImageGenerationService'
import {
  NOVELAI_MODELS,
  previewOpenAiImageRequest,
} from '../services/FrontendWorkshopImageGenerationService'
import {
  getImageGenerationCapabilities,
  RELAY_CAPABILITY_KEYS,
  type NovelAiQualityMode,
  type RelayCapabilityKey,
  novelAiGridCoordinate,
  OPENAI_IMAGE_MODEL_PROFILES,
  isOfficialOpenAiImageEndpoint,
  isOpenAiImageModelProfile,
  type OpenAiImageModelProfile,
} from '../services/ImageGenerationCapabilities'
import {
  redactImageRequest,
  validateImageGenerationConfig,
} from '../services/ImageGenerationRequest'

export type ImageGenerationAppEvents = { back: []; 'open-album': [] }

export type AppSection = 'generate' | 'result' | 'cloud' | 'connection'

export type ProviderTab = 'openai' | 'novelai'

export type InternalTab = 'prompt' | 'characters' | 'reference' | 'settings'

export function useImageGenerationApp() {
  const section = ref<AppSection>('generate')

  const provider = ref<ProviderTab>('novelai')

  const config = ref({
    openai: frontendWorkshopImageGenerationService.getSavedConfig('openai'),
    novelai: frontendWorkshopImageGenerationService.getSavedConfig('novelai'),
  })

  const prompt = ref('')

  const imageText = ref('')

  const promptHints = ref({ 人物: '', 场景: '', 构图: '', 风格: '' })

  const negativePrompt = ref('')

  const width = ref(832)

  const height = ref(1216)

  const openAiQuality = ref<'auto' | 'low' | 'medium' | 'high'>('auto')

  const openAiBackground = ref<'auto' | 'opaque' | 'transparent'>('auto')

  const outputFormat = ref<'png' | 'jpeg' | 'webp'>('png')

  const outputCompression = ref(90)

  const novelAiSampler = ref<
    | 'k_dpmpp_2m'
    | 'k_euler_ancestral'
    | 'k_euler'
    | 'k_dpm_2'
    | 'k_dpmpp_2s_ancestral'
    | 'k_dpmpp_sde'
    | 'k_dpm_fast'
    | 'ddim'
  >('k_dpmpp_2m')

  const novelAiSteps = ref(28)

  const novelAiScale = ref(5)

  const novelAiSeed = ref<number | undefined>()

  const novelAiQualityMode = ref<NovelAiQualityMode>('standard')

  const novelAiUcPreset = ref('none')

  const novelAiTransparentBackground = ref(false)

  const novelAiSmea = ref(false)

  const novelAiSmeaDyn = ref(false)

  const busy = ref(false)
  const resultBusy = ref(false)
  let disposed = false

  const error = ref('')

  const notice = ref('')

  const candidates = ref<
    Array<{
      image: FrontendWorkshopGeneratedImage
      albumItemId: string
      hostedUrl: string
      name: string
      category: string
    }>
  >([])

  const candidateIndex = ref(0)

  const currentCandidate = computed(() => candidates.value[candidateIndex.value])

  const result = computed(() => currentCandidate.value?.image)

  const resultUrl = computed(() => result.value?.dataUrl ?? result.value?.temporaryUrl ?? '')

  const albumSaved = computed(() => Boolean(currentCandidate.value?.albumItemId))

  const assetName = computed({
    get: () => currentCandidate.value?.name ?? '',
    set: (value: string) => {
      if (currentCandidate.value) currentCandidate.value.name = value
    },
  })
  const category = computed({
    get: () => currentCandidate.value?.category ?? '',
    set: (value: string) => {
      if (currentCandidate.value) currentCandidate.value.category = value
    },
  })

  const hostedUrl = computed(() => currentCandidate.value?.hostedUrl ?? '')

  const hostingBusy = ref(false)

  const rememberedImageBed = frontendWorkshopImageHostingService.getSelfHostedConfiguration()

  const selfHostedOrigin = ref(rememberedImageBed?.origin ?? '')

  const selfHostedToken = ref(rememberedImageBed?.token ?? '')

  const rememberSelfHosted = ref(rememberedImageBed?.remember ?? false)

  const selfHostedReady = ref(Boolean(rememberedImageBed))

  let generationController: AbortController | undefined

  let draftSaveTimer: ReturnType<typeof setTimeout> | undefined

  const internalTab = ref<InternalTab>('prompt')

  const modelOptions = ref<FrontendWorkshopImageModelOption[]>([])

  const modelsBusy = ref(false)

  const modelOptionsEndpoint = ref('')

  const characters = ref<
    Array<{ prompt: string; negativePrompt: string; positioned: boolean; x: number; y: number }>
  >([])

  const inputImages = ref<
    Array<{
      blob: Blob
      url: string
      name: string
      role: 'identity' | 'outfit' | 'composition' | 'scene' | 'reference'
    }>
  >([])

  const editInstruction = ref('')

  const preserve = ref<NonNullable<FrontendWorkshopImageGenerationRequest['openAiPreserve']>>({})

  const mask = ref<File>()

  const parentImageId = ref('')

  const additionalJson = ref('')

  const currentConfig = computed(() => config.value[provider.value])
  const officialOpenAiConnection = computed(
    () =>
      provider.value === 'openai' && isOfficialOpenAiImageEndpoint(currentConfig.value.endpoint),
  )
  const relayModelProfile = computed<OpenAiImageModelProfile | ''>({
    get: () => {
      const current = currentConfig.value
      const evidence = current.relayCapabilities
      return !officialOpenAiConnection.value &&
        evidence?.endpoint === current.endpoint.trim() &&
        evidence.model === current.model.trim() &&
        isOpenAiImageModelProfile(evidence.modelProfile)
        ? evidence.modelProfile
        : ''
    },
    set: (value) => {
      if (provider.value !== 'openai' || officialOpenAiConnection.value) return
      const current = currentConfig.value
      applyModelMetadata()
      current.relayCapabilities = {
        ...current.relayCapabilities,
        endpoint: current.endpoint.trim(),
        model: current.model.trim(),
        modelProfile: isOpenAiImageModelProfile(value) ? value : undefined,
        manual: {},
      }
      clearFeedback()
    },
  })

  const visibleModels = computed(() => {
    const options =
      provider.value === 'novelai'
        ? NOVELAI_MODELS
        : modelOptions.value.length
          ? modelOptions.value
          : provider.value === 'openai'
            ? ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'].map((id) => ({ id, name: id }))
            : []
    return options.some((item) => item.id === currentConfig.value.model)
      ? options
      : [...options, { id: currentConfig.value.model, name: currentConfig.value.model }]
  })

  const previewMeta = computed(() => {
    const image = result.value
    if (image) {
      const model = image.manifest?.model ?? '未知模型'
      return `${model} · ${image.width} × ${image.height}`
    }
    return `${currentConfig.value.model} · ${width.value} × ${height.value}`
  })

  const capabilities = computed(() =>
    getImageGenerationCapabilities(
      provider.value,
      currentConfig.value.model,
      currentConfig.value.relayCapabilities,
      currentConfig.value.endpoint,
    ),
  )

  const imageEditReady = computed(
    () =>
      capabilities.value.imageInput === 'supported' && capabilities.value.imageEdit === 'supported',
  )
  const resultEditReady = computed(() => {
    const image = result.value
    if (!image || image.provider === 'novelai') return false
    const connection = config.value[image.provider]
    const caps = getImageGenerationCapabilities(
      image.provider,
      image.manifest?.model ?? connection.model,
      connection.relayCapabilities,
      connection.endpoint,
    )
    return caps.imageEdit === 'supported' && caps.imageInput === 'supported'
  })
  const maskReady = computed(
    () =>
      imageEditReady.value &&
      capabilities.value.mask === 'supported' &&
      inputImages.value[0]?.blob.type === 'image/png',
  )
  const modelIssue = computed(() =>
    capabilities.value.textToImage === 'unsupported' ? capabilities.value.notes[0] : '',
  )
  const internalTabs = computed<Array<{ id: InternalTab; label: string }>>(() =>
    modelIssue.value
      ? []
      : provider.value === 'novelai'
        ? [
            { id: 'prompt', label: '创作' },
            ...(capabilities.value.multiCharacter === 'supported'
              ? [
                  {
                    id: 'characters' as const,
                    label: `角色${characters.value.length ? ` · ${characters.value.length}` : ''}`,
                  },
                ]
              : []),
            { id: 'settings', label: '更多参数' },
          ]
        : [
            { id: 'prompt', label: '创作' },
            ...(imageEditReady.value ? [{ id: 'reference' as const, label: '参考 / 改图' }] : []),
            { id: 'settings', label: '更多参数' },
          ],
  )
  const sizeOptions = computed(() =>
    provider.value === 'novelai' ? ['832x1216', '1024x1024', '1216x832'] : capabilities.value.sizes,
  )

  const capabilityLabels: Record<RelayCapabilityKey, string> = {
    quality: 'quality',
    outputFormat: 'output_format',
    outputCompression: 'output_compression',
    background: 'background',
    imageEdit: 'edits',
    imageInput: 'image input',
    multiImage: 'multi-image',
    mask: 'mask',
  }

  const preserveLabels = {
    identity: '人物身份',
    face: '面部',
    hairstyle: '发型',
    composition: '构图',
    background: '背景',
    lighting: '光照',
  }

  const openAiSize = computed({
    get: () => `${width.value}x${height.value}`,
    set: (value) => {
      ;[width.value, height.value] = value.split('x').map(Number)
    },
  })

  const activeImageText = computed(() =>
    capabilities.value.textRendering === 'supported' ? imageText.value.trim() : '',
  )

  const generationRequest = computed<FrontendWorkshopImageGenerationRequest>(() => ({
    prompt: [
      prompt.value,
      ...(provider.value === 'openai'
        ? Object.entries(promptHints.value)
            .filter(([, value]) => value.trim())
            .map(([key, value]) => `${key}：${value.trim()}`)
        : []),
      ...(activeImageText.value ? [`Text in image: ${JSON.stringify(activeImageText.value)}`] : []),
    ]
      .filter(Boolean)
      .join('\n'),
    width: width.value,
    height: height.value,
    ...(provider.value === 'novelai'
      ? {
          negativePrompt: negativePrompt.value,
          seed: novelAiSeed.value,
          novelAiSampler: novelAiSampler.value,
          novelAiSteps: novelAiSteps.value,
          novelAiScale: novelAiScale.value,
          novelAiQualityMode: activeImageText.value ? 'off' : novelAiQualityMode.value,
          novelAiUcPreset: novelAiUcPreset.value,
          novelAiTransparentBackground:
            capabilities.value.transparentBackground === 'supported' &&
            novelAiTransparentBackground.value,
          novelAiCharacters:
            capabilities.value.multiCharacter === 'supported'
              ? characters.value.slice(0, capabilities.value.maxCharacters).map((c) => ({
                  prompt: c.prompt,
                  negativePrompt: c.negativePrompt,
                  ...(c.positioned
                    ? {
                        position: {
                          x: capabilities.value.freeCharacterPositioning
                            ? c.x
                            : novelAiGridCoordinate(c.x),
                          y: capabilities.value.freeCharacterPositioning
                            ? c.y
                            : novelAiGridCoordinate(c.y),
                        },
                      }
                    : {}),
                }))
              : [],
          novelAiSmea:
            capabilities.value.smea === 'supported' &&
            novelAiSampler.value !== 'ddim' &&
            novelAiSmea.value,
          novelAiSmeaDyn:
            capabilities.value.smea === 'supported' &&
            novelAiSampler.value !== 'ddim' &&
            novelAiSmea.value &&
            novelAiSmeaDyn.value,
        }
      : {
          openAiQuality: openAiQuality.value,
          openAiBackground:
            openAiBackground.value === 'transparent' &&
            capabilities.value.transparentBackground !== 'supported'
              ? 'auto'
              : openAiBackground.value,
          outputFormat: outputFormat.value,
          outputCompression: outputCompression.value,
          openAiInputImages: (imageEditReady.value
            ? inputImages.value.slice(0, capabilities.value.maxInputImages)
            : []
          ).map((image) => ({
            blob: image.blob,
            role: image.role,
          })),
          openAiEditInstruction: imageEditReady.value ? editInstruction.value : '',
          openAiPreserve: imageEditReady.value ? { ...preserve.value } : {},
          openAiMask: maskReady.value ? mask.value : undefined,
          parentImageId: imageEditReady.value ? parentImageId.value || undefined : undefined,
          additionalJson: additionalJson.value,
        }),
  }))

  const requestPreview = computed(() => {
    if (provider.value !== 'openai') return { text: '', error: '' }
    try {
      return {
        text: JSON.stringify(
          previewOpenAiImageRequest(currentConfig.value, generationRequest.value),
          null,
          2,
        ),
        error: '',
      }
    } catch (cause) {
      return { text: '', error: cause instanceof Error ? cause.message : '请求无效' }
    }
  })

  const canGenerate = computed(() => busy.value || (!hostingBusy.value && !resultBusy.value))
  const feedbackError = computed(
    () =>
      error.value ||
      (section.value === 'generate' || section.value === 'connection' ? modelIssue.value : '') ||
      (section.value === 'generate' &&
      internalTab.value === 'settings' &&
      additionalJson.value.trim()
        ? requestPreview.value.error
        : ''),
  )
  function clearFeedback(): void {
    error.value = ''
    notice.value = ''
  }
  function reportError(cause: unknown, action: string): void {
    notice.value = ''
    let message = cause instanceof Error ? cause.message : '未知错误，请重试或检查连接设置'
    for (const secret of [
      config.value.openai.apiKey,
      config.value.novelai.apiKey,
      selfHostedToken.value,
    ])
      message = redactImageRequest(message, secret)
    error.value = `${action}：${message}`
  }
  function openSection(next: AppSection): void {
    clearFeedback()
    section.value = next
  }
  function reportPreviewFailure(): void {
    reportError(
      new Error(
        '图片无法显示，临时链接可能已失效或被浏览器拦截；可尝试保存到生图相册，失败时检查供应商返回内容。',
      ),
      '预览失败',
    )
  }

  watch([capabilities, openAiBackground, outputFormat], () => {
    if (
      (internalTab.value === 'reference' && !imageEditReady.value) ||
      (internalTab.value === 'characters' && capabilities.value.multiCharacter !== 'supported')
    )
      internalTab.value = 'prompt'
    if (provider.value !== 'novelai') {
      if (!capabilities.value.sizes.includes(`${width.value}x${height.value}`)) {
        ;[width.value, height.value] = (capabilities.value.sizes[0] ?? '1024x1024')
          .split('x')
          .map(Number)
      }
      if (
        openAiBackground.value === 'transparent' &&
        capabilities.value.transparentBackground !== 'supported'
      )
        openAiBackground.value = 'auto'
      if (openAiBackground.value === 'transparent' && outputFormat.value === 'jpeg')
        outputFormat.value = 'png'
      return
    }
    if (!capabilities.value.qualityModes.includes(novelAiQualityMode.value)) {
      novelAiQualityMode.value = capabilities.value.qualityModes.includes('standard')
        ? 'standard'
        : 'off'
    }
    if (capabilities.value.ucPreset !== 'supported') novelAiUcPreset.value = 'none'
  })

  const templates = ref(frontendWorkshopImageDraftService.listTemplates())

  const templateName = ref('')

  const canSaveToPhone = isNativeFileExportAvailable()

  function currentDraft(): FrontendWorkshopImageDraft {
    return {
      version: 1,
      provider: provider.value,
      endpoint: config.value[provider.value].endpoint,
      model: config.value[provider.value].model,
      prompt: prompt.value,
      negativePrompt: negativePrompt.value,
      imageText: imageText.value,
      promptHints: { ...promptHints.value },
      novelAiCharacters: characters.value.map((character) => ({ ...character })),
      width: width.value,
      height: height.value,
      openAiQuality: openAiQuality.value,
      openAiBackground: openAiBackground.value,
      outputFormat: outputFormat.value,
      outputCompression: outputCompression.value,
      novelAiSampler: novelAiSampler.value,
      novelAiSteps: novelAiSteps.value,
      novelAiScale: novelAiScale.value,
      novelAiSeed: novelAiSeed.value,
      novelAiQualityToggle: novelAiQualityMode.value !== 'off',
      novelAiQualityMode: novelAiQualityMode.value,
      novelAiUcPreset: novelAiUcPreset.value,
      novelAiTransparentBackground: novelAiTransparentBackground.value,
      novelAiSmea: novelAiSmea.value,
      novelAiSmeaDyn: novelAiSmeaDyn.value,
      savedAt: Date.now(),
    }
  }

  function applyDraft(draft?: FrontendWorkshopImageDraft): void {
    if (draft) {
      config.value[provider.value].endpoint =
        draft.endpoint ||
        frontendWorkshopImageGenerationService.defaultConfig(provider.value).endpoint
      config.value[provider.value].model = draft.model
    }
    prompt.value = draft?.prompt ?? ''
    negativePrompt.value = draft?.negativePrompt ?? ''
    imageText.value = draft?.imageText ?? ''
    promptHints.value = { 人物: '', 场景: '', 构图: '', 风格: '', ...draft?.promptHints }
    characters.value = (draft?.novelAiCharacters ?? []).map((character) => ({ ...character }))
    width.value = draft?.width ?? (provider.value === 'novelai' ? 832 : 1024)
    height.value = draft?.height ?? (provider.value === 'novelai' ? 1216 : 1024)
    openAiQuality.value = draft?.openAiQuality ?? 'auto'
    openAiBackground.value = draft?.openAiBackground ?? 'auto'
    outputFormat.value = draft?.outputFormat ?? 'png'
    outputCompression.value = draft?.outputCompression ?? 90
    novelAiSampler.value = draft?.novelAiSampler ?? 'k_dpmpp_2m'
    novelAiSteps.value = draft?.novelAiSteps ?? 28
    novelAiScale.value = draft?.novelAiScale ?? 5
    novelAiSeed.value = draft?.novelAiSeed
    novelAiQualityMode.value =
      draft?.novelAiQualityMode ?? (draft?.novelAiQualityToggle === false ? 'off' : 'standard')
    novelAiUcPreset.value = draft?.novelAiUcPreset ?? 'none'
    novelAiTransparentBackground.value = draft?.novelAiTransparentBackground ?? false
    novelAiSmea.value = draft?.novelAiSmea ?? false
    novelAiSmeaDyn.value = draft?.novelAiSmeaDyn ?? false
  }

  const savedDraft = frontendWorkshopImageDraftService.loadDraft()

  if (savedDraft) {
    provider.value = savedDraft.provider
    applyDraft(savedDraft)
  }

  watch(
    currentDraft,
    (draft) => {
      if (draftSaveTimer !== undefined) clearTimeout(draftSaveTimer)
      const snapshot = { ...draft }
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = undefined
        frontendWorkshopImageDraftService.saveDraft(snapshot)
      }, 300)
    },
    { deep: true },
  )

  function flushDraft(): void {
    if (draftSaveTimer !== undefined) {
      clearTimeout(draftSaveTimer)
      draftSaveTimer = undefined
    }
    frontendWorkshopImageDraftService.saveDraft(currentDraft())
  }

  function saveTemplate(): void {
    clearFeedback()
    try {
      if (!templateName.value.trim()) throw new Error('请填写模板名称')
      frontendWorkshopImageDraftService.saveTemplate(templateName.value, currentDraft())
      templates.value = frontendWorkshopImageDraftService.listTemplates()
      templateName.value = ''
      notice.value = '模板已保存。'
    } catch (cause) {
      reportError(cause, '保存模板失败')
    }
  }

  function useTemplate(template: FrontendWorkshopImageTemplate): void {
    chooseProvider(template.draft.provider)
    applyDraft(template.draft)
  }

  function overwriteTemplate(template: FrontendWorkshopImageTemplate): void {
    clearFeedback()
    try {
      frontendWorkshopImageDraftService.overwriteTemplate(template.id, currentDraft())
      templates.value = frontendWorkshopImageDraftService.listTemplates()
      notice.value = '模板已更新。'
    } catch (cause) {
      reportError(cause, '更新模板失败')
    }
  }

  async function deleteTemplate(template: FrontendWorkshopImageTemplate): Promise<void> {
    if (
      !(await confirmAction({
        title: '删除生图模板',
        message: `删除“${template.name}”？`,
        confirmLabel: '删除模板',
        danger: true,
      }))
    )
      return
    clearFeedback()
    try {
      frontendWorkshopImageDraftService.deleteTemplate(template.id)
      templates.value = frontendWorkshopImageDraftService.listTemplates()
    } catch (cause) {
      reportError(cause, '删除模板失败')
    }
  }

  async function saveToPhone(): Promise<void> {
    if (!result.value || !canSaveToPhone || resultBusy.value || hostingBusy.value || busy.value)
      return
    resultBusy.value = true
    clearFeedback()
    try {
      const image = result.value
      await saveBlobToNativeDestination(
        await frontendWorkshopImageGenerationService.toBlob(image),
        `${assetName.value.trim() || image.id}.${image.extension}`,
        'pictures',
      )
      notice.value = '已保存到手机相册。'
    } catch (cause) {
      reportError(cause, '保存到手机相册失败')
    } finally {
      resultBusy.value = false
    }
  }

  async function loadModels(): Promise<void> {
    if (modelsBusy.value) return
    modelsBusy.value = true
    clearFeedback()
    const current = { ...currentConfig.value }
    try {
      const models = await frontendWorkshopImageGenerationService.listModels(current)
      if (current.provider !== provider.value || current.endpoint !== currentConfig.value.endpoint)
        return
      modelOptions.value = models.options
      modelOptionsEndpoint.value = current.endpoint.trim()
      applyModelMetadata()
      notice.value = models.message
    } catch (cause) {
      if (current.provider === provider.value && current.endpoint === currentConfig.value.endpoint)
        reportError(cause, '拉取模型失败')
    } finally {
      modelsBusy.value = false
    }
  }

  function applyModelMetadata(): void {
    if (provider.value !== 'openai') return
    const current = config.value.openai
    const previous = current.relayCapabilities
    current.relayCapabilities = {
      endpoint: current.endpoint.trim(),
      model: current.model.trim(),
      modelProfile:
        previous?.endpoint === current.endpoint.trim() && previous.model === current.model.trim()
          ? previous.modelProfile
          : undefined,
      declared:
        modelOptionsEndpoint.value === current.endpoint.trim()
          ? modelOptions.value.find((option) => option.id === current.model)?.capabilities
          : previous?.endpoint === current.endpoint.trim() &&
              previous.model === current.model.trim()
            ? previous.declared
            : undefined,
      manual:
        previous?.endpoint === current.endpoint.trim() && previous.model === current.model.trim()
          ? previous.manual
          : {},
    }
  }

  function resetEndpoint(): void {
    config.value[provider.value].endpoint = frontendWorkshopImageGenerationService.defaultConfig(
      provider.value,
    ).endpoint
    applyModelMetadata()
  }

  function confirmCapability(key: RelayCapabilityKey, event: Event): void {
    if (provider.value !== 'openai') return
    const current = config.value.openai
    const existing = current.relayCapabilities
    const scoped =
      existing?.endpoint === current.endpoint.trim() && existing?.model === current.model.trim()
    const evidence = scoped
      ? existing
      : { endpoint: current.endpoint.trim(), model: current.model.trim() }
    current.relayCapabilities = {
      ...evidence,
      manual: { ...evidence.manual, [key]: (event.target as HTMLInputElement).checked },
    }
  }

  function addCharacter(): void {
    if (characters.value.length < capabilities.value.maxCharacters)
      characters.value.push({ prompt: '', negativePrompt: '', positioned: false, x: 0.5, y: 0.5 })
  }

  function removeInputImage(index: number): void {
    const image = inputImages.value.splice(index, 1)[0]
    if (image) URL.revokeObjectURL(image.url)
    if (index === 0) {
      parentImageId.value = ''
      mask.value = undefined
    }
  }

  function uploadImages(event: Event): void {
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    clearFeedback()
    const max =
      capabilities.value.multiImage === 'supported' ? capabilities.value.maxInputImages : 1
    if (files.length + inputImages.value.length > max) {
      error.value = `当前最多可用 ${max} 张参考图`
      return
    }
    const total = [...files, ...inputImages.value.map((image) => image.blob)].reduce(
      (sum, blob) => sum + blob.size,
      0,
    )
    if (
      total > 100 * 1024 * 1024 ||
      files.some(
        (file) =>
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
          !file.size ||
          file.size >= 50 * 1024 * 1024,
      )
    ) {
      error.value = '请使用 PNG / JPEG / WebP，单张小于 50 MiB，合计不超过 100 MiB'
      return
    }
    for (const file of files)
      inputImages.value.push({
        blob: file,
        url: URL.createObjectURL(file),
        name: file.name,
        role: 'reference',
      })
  }

  function uploadMask(event: Event): void {
    const input = event.target as HTMLInputElement
    mask.value = input.files?.[0]
    input.value = ''
  }

  async function continueEditing(): Promise<void> {
    if (
      !result.value ||
      !resultEditReady.value ||
      busy.value ||
      hostingBusy.value ||
      resultBusy.value
    )
      return
    resultBusy.value = true
    clearFeedback()
    try {
      const image = result.value
      const blob = await frontendWorkshopImageGenerationService.toBlob(image)
      const item = await generatedImageAlbumService.saveGenerated(image)
      if (disposed) return
      currentCandidate.value!.albumItemId = item.id
      chooseProvider(image.provider)
      if (image.manifest?.model) config.value[image.provider].model = image.manifest.model
      while (inputImages.value.length) removeInputImage(0)
      inputImages.value.push({
        blob,
        url: URL.createObjectURL(blob),
        name: item.name,
        role: 'reference',
      })
      parentImageId.value = item.id
      section.value = 'generate'
      internalTab.value = 'reference'
      editInstruction.value = ''
      notice.value = '原图已保存到相册；请填写下一步修改指令。'
    } catch (cause) {
      reportError(cause, '准备编辑失败')
    } finally {
      resultBusy.value = false
    }
  }

  async function saveConnection(): Promise<void> {
    clearFeedback()
    try {
      validateImageGenerationConfig(currentConfig.value)
      config.value[provider.value] = await frontendWorkshopImageGenerationService.saveConfiguration(
        currentConfig.value,
      )
      notice.value = '连接已保存；实际可用性以生成结果为准。'
    } catch (cause) {
      reportError(cause, '连接保存失败')
    }
  }

  function reuseResult(): void {
    if (!result.value || busy.value || hostingBusy.value || resultBusy.value) return
    chooseProvider(result.value.provider)
    if (result.value.manifest) config.value[provider.value].model = result.value.manifest.model
    prompt.value = result.value.prompt
    negativePrompt.value = result.value.negativePrompt ?? ''
    imageText.value = ''
    promptHints.value = { 人物: '', 场景: '', 构图: '', 风格: '' }
    width.value = result.value.width
    height.value = result.value.height
    if (result.value.provider === 'novelai') novelAiSeed.value = result.value.seed
    section.value = 'generate'
  }

  async function generateAnother(): Promise<void> {
    if (!result.value || busy.value || hostingBusy.value || resultBusy.value) return
    reuseResult()
    novelAiSeed.value = undefined
    await generate()
  }

  function providerLabel(value: FrontendWorkshopImageProvider): string {
    if (value === 'novelai') return 'NovelAI'
    if (value === 'openai') return 'OpenAI'
    return 'OpenAI'
  }

  function selectTab(tab: InternalTab): void {
    clearFeedback()
    internalTab.value = tab
    section.value = 'generate'
  }

  function chooseProvider(next: ProviderTab): void {
    if (busy.value || hostingBusy.value || modelsBusy.value) return
    flushDraft()
    if (next !== provider.value) {
      while (inputImages.value.length) removeInputImage(0)
      mask.value = undefined
      parentImageId.value = ''
      editInstruction.value = ''
      preserve.value = {}
    }
    section.value = 'generate'
    provider.value = next
    applyDraft(frontendWorkshopImageDraftService.loadDraft(next))
    internalTab.value = 'prompt'
    modelOptions.value = []
    modelOptionsEndpoint.value = ''
    error.value = ''
    notice.value = ''
    if (
      next !== 'novelai' &&
      !capabilities.value.sizes.includes(`${width.value}x${height.value}`)
    ) {
      width.value = 1024
      height.value = 1024
    }
  }

  async function generate(): Promise<void> {
    if (busy.value) {
      generationController?.abort()
      return
    }
    if (!canGenerate.value) return
    clearFeedback()
    try {
      validateImageGenerationConfig(currentConfig.value)
    } catch (cause) {
      section.value = 'connection'
      reportError(cause, '无法开始生成')
      return
    }
    if (modelIssue.value) {
      error.value = modelIssue.value
      return
    }
    if (
      !generationRequest.value.prompt.trim() &&
      !generationRequest.value.openAiEditInstruction?.trim()
    ) {
      selectTab('prompt')
      error.value = '请先填写画面描述，或添加原图并填写修改要求。'
      return
    }
    if (requestPreview.value.error) {
      error.value = requestPreview.value.error
      return
    }
    busy.value = true
    error.value = ''
    notice.value = ''
    const controller = new AbortController()
    generationController = controller
    try {
      const current = { ...config.value[provider.value] }
      const image = await frontendWorkshopImageGenerationService.generate(
        current,
        generationRequest.value,
        { signal: controller.signal, requestId: crypto.randomUUID() },
      )
      if (disposed || controller.signal.aborted) return
      candidates.value.push({ image, albumItemId: '', hostedUrl: '', name: '', category: '' })
      candidateIndex.value = candidates.value.length - 1
      section.value = 'result'
      try {
        config.value[current.provider] =
          await frontendWorkshopImageGenerationService.saveConfiguration(current)
      } catch {
        notice.value = '图片已生成；当前连接配置未能持久保存。'
      }
    } catch (cause) {
      if (
        controller.signal.aborted ||
        (cause instanceof DOMException && cause.name === 'AbortError')
      )
        notice.value = '已停止等待本次生成；供应商可能仍在处理，请核对任务及计费状态。'
      else reportError(cause, '生成失败')
    } finally {
      if (controller.signal.aborted && !disposed)
        notice.value = '已停止等待本次生成；供应商可能仍在处理，请核对任务及计费状态。'
      busy.value = false
      generationController = undefined
    }
  }

  async function saveToAlbum(): Promise<void> {
    if (
      !currentCandidate.value ||
      albumSaved.value ||
      resultBusy.value ||
      hostingBusy.value ||
      busy.value
    )
      return
    const candidate = currentCandidate.value
    resultBusy.value = true
    clearFeedback()
    try {
      const item = await generatedImageAlbumService.saveGenerated(candidate.image, {
        name: assetName.value.trim() || candidate.image.prompt.slice(0, 42),
        category: category.value,
      })
      candidate.albumItemId = item.id
      notice.value = '已保存到生图相册。'
    } catch (cause) {
      reportError(cause, '保存到生图相册失败')
    } finally {
      resultBusy.value = false
    }
  }

  async function saveSelfHostedConnection(): Promise<void> {
    clearFeedback()
    try {
      const saved = await frontendWorkshopImageHostingService.saveSelfHostedConfiguration({
        origin: selfHostedOrigin.value,
        token: selfHostedToken.value,
        remember: rememberSelfHosted.value,
      })
      selfHostedOrigin.value = saved.origin
      selfHostedToken.value = saved.token
      selfHostedReady.value = true
      notice.value = saved.remember
        ? '自建图床连接已保存在本机。'
        : '自建图床仅在本次打开期间连接。'
    } catch (cause) {
      selfHostedReady.value = false
      reportError(cause, '自建图床连接保存失败')
    }
  }

  async function hostResult(): Promise<void> {
    if (!result.value || hostingBusy.value || busy.value || resultBusy.value) return
    hostingBusy.value = true
    clearFeedback()
    try {
      const candidate = currentCandidate.value!
      const image = candidate.image
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=generated-image-self-hosted-upload
      const item = await generatedImageAlbumService.saveGenerated(image, {
        name: assetName.value,
        category: category.value,
      })
      candidate.albumItemId = item.id
      const blob = await generatedImageAlbumService.getOriginalBlob(item.id)
      const name = assetName.value.trim() || image.prompt.slice(0, 60) || '生成图片'
      const hosted = await frontendWorkshopImageHostingService.uploadBlobSelfHosted(blob, name)
      await generatedImageAlbumService.setHostedUrl(item.id, hosted, 'self-hosted')
      // SRL-PUBLIC-SYNC: END REPLACE id=generated-image-self-hosted-upload
      candidate.hostedUrl = hosted.url
      notice.value = '已生成稳定 HTTPS 直链，并同步记录到生图相册。'
    } catch (cause) {
      reportError(cause, '获取图片直链失败')
    } finally {
      hostingBusy.value = false
    }
  }

  onUnmounted(() => {
    disposed = true
    generationController?.abort()
    flushDraft()
    for (const image of inputImages.value) URL.revokeObjectURL(image.url)
  })
  return {
    section,
    resultUrl,
    previewMeta,
    provider,
    busy,
    resultBusy,
    feedbackError,
    clearFeedback,
    openSection,
    sizeOptions,
    imageEditReady,
    officialOpenAiConnection,
    relayModelProfile,
    OPENAI_IMAGE_MODEL_PROFILES,
    resultEditReady,
    maskReady,
    reportPreviewFailure,
    generateAnother,
    chooseProvider,
    providerLabel,
    config,
    applyModelMetadata,
    visibleModels,
    loadModels,
    internalTabs,
    internalTab,
    selectTab,
    prompt,
    notice,
    capabilities,
    imageText,
    promptHints,
    characters,
    addCharacter,
    uploadImages,
    inputImages,
    removeInputImage,
    editInstruction,
    preserveLabels,
    preserve,
    uploadMask,
    mask,
    openAiSize,
    novelAiQualityMode,
    activeImageText,
    novelAiTransparentBackground,
    novelAiSeed,
    novelAiUcPreset,
    novelAiSampler,
    novelAiSteps,
    novelAiScale,
    width,
    height,
    negativePrompt,
    novelAiSmea,
    novelAiSmeaDyn,
    openAiQuality,
    openAiBackground,
    outputFormat,
    outputCompression,
    additionalJson,
    requestPreview,
    modelsBusy,
    saveConnection,
    resetEndpoint,
    RELAY_CAPABILITY_KEYS,
    capabilityLabels,
    confirmCapability,
    templates,
    saveTemplate,
    templateName,
    useTemplate,
    overwriteTemplate,
    deleteTemplate,
    error,
    canGenerate,
    generate,
    result,
    reuseResult,
    continueEditing,
    candidates,
    candidateIndex,
    hostingBusy,
    assetName,
    category,
    albumSaved,
    saveToAlbum,
    canSaveToPhone,
    saveToPhone,
    selfHostedOrigin,
    selfHostedToken,
    rememberSelfHosted,
    saveSelfHostedConnection,
    selfHostedReady,
    hostResult,
    hostedUrl,
  }
}
