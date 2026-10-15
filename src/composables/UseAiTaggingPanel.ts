import type { EmitFn } from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { confirmAction } from '../composables/UseConfirmDialog'
import {
  aiTaggingDraftService,
  aiTaggingService,
  mainApiService,
  resourceService,
} from '../core/AppContainer'
import type { AiTaggingDraft, AiTaggingUndoRecord } from '../services/AiTaggingDraftService'
import type { AiTaggingRuleTemplate } from '../services/AiTaggingDraftService'
import {
  AI_TAGGING_DEFAULT_BATCH_SIZE,
  AI_TAGGING_DEFAULT_CONCURRENCY,
  AI_TAGGING_MAX_CONCURRENCY,
  normalizeAiTaggingConcurrency,
  AI_TAGGING_RESOURCE_CHAR_BUDGET,
  AI_TAGGING_MAX_SYSTEM_PROMPT,
  AI_TAGGING_TAXONOMY_TEMPLATES,
  getAiTaggingSystemPrompt,
  type AiTaggingFailure,
  type AiTaggingSuggestedTag,
  type AiTaggingSuggestion,
} from '../services/AiTaggingService'
import type { MainApiConfig, MainApiProfile } from '../services/MainApiService'
import { mainApiCancellationNotice } from '../services/MainApiTextTransport'
import {
  getResourceCategoryIds,
  RESOURCE_TYPE_LABELS,
  type Category,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'

export type Stage = 'select' | 'running' | 'review'

export type TagState = 'all' | 'tagged' | 'untagged'

export interface ReviewItem extends AiTaggingSuggestion {
  resource: ResourceSummary
  accepted: boolean
  draftTag: string
}

export type AiTaggingPanelProps = {
  resources: ResourceSummary[]
  categories: Category[]
  initialSelectedIds?: string[]
  suspended?: boolean
}

export type AiTaggingPanelEvents = {
  close: []
  openResource: [resource: ResourceSummary]
  applied: [
    details: {
      resourceCount: number
      tagCount: number
      resourceIds: string[]
      action: 'apply' | 'undo'
    },
  ]
}

export function useAiTaggingPanel(
  props: Readonly<AiTaggingPanelProps>,
  emit: EmitFn<AiTaggingPanelEvents>,
) {
  const DEFAULT_CUSTOM_PROMPT =
    '优先判断人数、背景时代或场景、性向与情绪风格；证据不足的维度不要猜测。'

  const stage = ref<Stage>('select')

  const searchQuery = ref('')

  const typeFilter = ref<'all' | ResourceType>('all')

  const categoryFilter = ref('all')

  const tagState = ref<TagState>('all')

  const tagQuery = ref('')

  const batchSize = ref(AI_TAGGING_DEFAULT_BATCH_SIZE)
  const concurrency = ref(AI_TAGGING_DEFAULT_CONCURRENCY)
  const batchSizeError = computed(() =>
    Number.isSafeInteger(batchSize.value) && batchSize.value > 0
      ? ''
      : '每批资源数请填写有效的正整数。',
  )

  const customPrompt = ref(DEFAULT_CUSTOM_PROMPT)
  const systemPrompt = ref<string>()
  const systemPromptText = computed({
    get: () => systemPrompt.value ?? getAiTaggingSystemPrompt(taxonomyTemplateId.value),
    set: (value: string) => {
      systemPrompt.value = value
    },
  })
  const isSystemPromptCustom = computed(() => systemPrompt.value !== undefined)
  const systemPromptError = computed(() =>
    !systemPromptText.value.trim()
      ? '系统提示词不能为空，请填写内容或恢复默认。'
      : systemPromptText.value.length > AI_TAGGING_MAX_SYSTEM_PROMPT
        ? `系统提示词最多 ${AI_TAGGING_MAX_SYSTEM_PROMPT} 字符。`
        : '',
  )
  function resetSystemPrompt(): void {
    systemPrompt.value = undefined
  }

  const ruleTemplates = ref<AiTaggingRuleTemplate[]>(aiTaggingDraftService.loadRuleTemplates())

  const ruleTemplateName = ref('')

  const selectedRuleTemplateId = ref('')

  const taxonomyTemplateId = ref('free')

  const mergeAliases = ref(false)

  const selectedIds = shallowRef(
    new Set(
      (props.initialSelectedIds ?? []).filter((id) =>
        props.resources.some((resource) => resource.id === id),
      ),
    ),
  )

  const message = ref('')

  const failures = ref<AiTaggingFailure[]>([])

  const reviewItems = ref<ReviewItem[]>([])
  const reviewPage = ref(1)
  const reviewPageSize = 20
  const reviewPageCount = computed(() =>
    Math.max(1, Math.ceil(reviewItems.value.length / reviewPageSize)),
  )
  const pageReviewItems = computed(() =>
    reviewItems.value.slice(
      (reviewPage.value - 1) * reviewPageSize,
      reviewPage.value * reviewPageSize,
    ),
  )
  watch(
    () => reviewItems.value.length,
    () => {
      reviewPage.value = Math.min(reviewPage.value, reviewPageCount.value)
    },
  )

  const progressCompleted = ref(0)

  const progressTotal = ref(0)

  const progressBatch = ref(0)

  const progressBatchCount = ref(0)
  const progressResourceNames = ref<string[]>([])

  const usageText = ref('')

  const stopRequested = ref(false)

  const applying = ref(false)

  const undoing = ref(false)

  const restoredAt = ref(0)

  const undoRecord = ref<AiTaggingUndoRecord>()

  let restoringDraft = false

  let recognitionController: AbortController | undefined

  let profiles: MainApiProfile[] = []

  let activeProfileId = ''

  try {
    const state = mainApiService.getProfilesState()
    profiles = state.profiles
    activeProfileId = state.activeProfileId
  } catch {
    profiles = []
  }

  const apiSource = ref('active')

  const temporaryProtocol = ref<MainApiConfig['protocol']>('openai-compatible')

  const temporaryUrl = ref('')

  const temporaryApiKey = ref('')

  const temporaryModel = ref('')

  const apiDetailsOpen = ref(false)

  const triggerElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null

  const previousBodyOverflow = document.body.style.overflow

  const resourceTypes = computed(() =>
    Array.from(new Set(props.resources.map((resource) => resource.type))).map((type) => ({
      type,
      label: RESOURCE_TYPE_LABELS[type],
    })),
  )

  const filteredResources = computed(() => {
    const keyword = searchQuery.value.trim().toLocaleLowerCase()
    const existingTag = tagQuery.value.trim().toLocaleLowerCase()
    return props.resources.filter((resource) => {
      if (typeFilter.value !== 'all' && resource.type !== typeFilter.value) return false
      const categoryIds = getResourceCategoryIds(resource)
      if (categoryFilter.value === 'uncategorized' && categoryIds.length) return false
      if (
        categoryFilter.value !== 'all' &&
        categoryFilter.value !== 'uncategorized' &&
        !categoryIds.includes(categoryFilter.value)
      )
        return false
      if (tagState.value === 'tagged' && !resource.tags.length) return false
      if (tagState.value === 'untagged' && resource.tags.length) return false
      if (
        existingTag &&
        !resource.tags.some((tag) => tag.toLocaleLowerCase().includes(existingTag))
      )
        return false
      if (!keyword) return true
      return [resource.name, resource.fileName, resource.description, ...resource.tags]
        .join('\n')
        .toLocaleLowerCase()
        .includes(keyword)
    })
  })

  // 只限制当前页的 DOM 数量；选择范围和 AI 批次仍包含跨页资源。
  const candidatePage = ref(1)
  const candidatePageSize = 40
  const candidatePageCount = computed(() =>
    Math.max(1, Math.ceil(filteredResources.value.length / candidatePageSize)),
  )
  const pageCandidates = computed(() =>
    filteredResources.value.slice(
      (candidatePage.value - 1) * candidatePageSize,
      candidatePage.value * candidatePageSize,
    ),
  )
  watch(filteredResources, () => {
    candidatePage.value = 1
  })

  const allFilteredSelected = computed(
    () =>
      filteredResources.value.length > 0 &&
      filteredResources.value.every((resource) => selectedIds.value.has(resource.id)),
  )
  const activeFilterCount = computed(
    () =>
      [
        typeFilter.value !== 'all',
        categoryFilter.value !== 'all',
        tagState.value !== 'all',
        Boolean(tagQuery.value.trim()),
      ].filter(Boolean).length,
  )

  const acceptedItems = computed(() =>
    reviewItems.value.filter((item) => item.accepted && item.tags.length),
  )

  const acceptedTagCount = computed(() =>
    acceptedItems.value.reduce((total, item) => total + item.tags.length, 0),
  )

  const activeTaxonomyTemplate = computed(
    () =>
      AI_TAGGING_TAXONOMY_TEMPLATES.find((template) => template.id === taxonomyTemplateId.value) ??
      AI_TAGGING_TAXONOMY_TEMPLATES[0]!,
  )

  const retryableResourceIds = computed(() =>
    Array.from(
      new Set(
        failures.value
          .filter((failure) => failure.retryable)
          .flatMap((failure) => failure.resourceIds),
      ),
    ),
  )

  const undoTagCount = computed(
    () => undoRecord.value?.additions.reduce((total, entry) => total + entry.tags.length, 0) ?? 0,
  )

  const activeProfile = computed(() => profiles.find((profile) => profile.id === activeProfileId))
  const selectedApiSummary = computed(() => {
    const profile = apiSource.value.startsWith('profile:')
      ? profiles.find((item) => `profile:${item.id}` === apiSource.value)
      : activeProfile.value
    const url =
      apiSource.value === 'temporary' ? temporaryUrl.value.trim() || profile?.url : profile?.url
    let host = '未配置地址'
    try {
      host = new URL(url || '').host
    } catch {
      /* 未配置时只显示状态，不暴露地址中的凭据。 */
    }
    const model =
      apiSource.value === 'temporary'
        ? temporaryModel.value.trim() || profile?.model
        : profile?.model
    return `${model || '未配置模型'} · ${host}`
  })

  function applyRuleTemplate(id: string): void {
    const template = ruleTemplates.value.find((item) => item.id === id)
    if (!template) return
    selectedRuleTemplateId.value = id
    ruleTemplateName.value = template.name
    customPrompt.value = template.prompt
    systemPrompt.value = template.systemPrompt
    taxonomyTemplateId.value = AI_TAGGING_TAXONOMY_TEMPLATES.some(
      (item) => item.id === template.taxonomyTemplateId,
    )
      ? template.taxonomyTemplateId
      : 'free'
    mergeAliases.value = template.mergeAliases
  }

  function saveRuleTemplate(): void {
    try {
      ruleTemplates.value = aiTaggingDraftService.saveRuleTemplate(
        ruleTemplateName.value,
        customPrompt.value,
        taxonomyTemplateId.value,
        mergeAliases.value,
        systemPrompt.value,
      )
      const saved = ruleTemplates.value.find((item) => item.name === ruleTemplateName.value.trim())
      selectedRuleTemplateId.value = saved?.id ?? ''
      message.value = `识别规则模板「${ruleTemplateName.value.trim()}」已保存在本机。`
    } catch (error) {
      message.value = error instanceof Error ? error.message : '模板保存失败'
    }
  }

  async function deleteRuleTemplate(): Promise<void> {
    const template = ruleTemplates.value.find((item) => item.id === selectedRuleTemplateId.value)
    if (!template) return
    const confirmed = await confirmAction({
      title: '删除识别规则模板',
      message: `确定从本机删除「${template.name}」吗？当前输入的识别规则不会改变。`,
      confirmLabel: '删除模板',
      danger: true,
    })
    if (!confirmed) return
    try {
      ruleTemplates.value = aiTaggingDraftService.deleteRuleTemplate(template.id)
      selectedRuleTemplateId.value = ''
      ruleTemplateName.value = ''
      message.value = '识别规则模板已删除。'
    } catch (error) {
      message.value = error instanceof Error ? error.message : '模板删除失败'
    }
  }

  const progressPercent = computed(() =>
    progressTotal.value ? Math.round((progressCompleted.value / progressTotal.value) * 100) : 0,
  )

  function replaceSelection(next: Set<string>): void {
    selectedIds.value = next
  }

  function resourceName(resourceId: string): string {
    return resourceIndex.value.get(resourceId)?.name ?? '资源已不存在'
  }

  function draftTime(value: number): string {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  }

  function toggleResource(resourceId: string): void {
    const next = new Set(selectedIds.value)
    if (next.has(resourceId)) next.delete(resourceId)
    else next.add(resourceId)
    replaceSelection(next)
  }

  function toggleFilteredSelection(): void {
    const next = new Set(selectedIds.value)
    if (allFilteredSelected.value)
      filteredResources.value.forEach((resource) => next.delete(resource.id))
    else {
      for (const resource of filteredResources.value) {
        next.add(resource.id)
      }
    }
    replaceSelection(next)
  }

  function clearSelection(): void {
    replaceSelection(new Set())
  }

  function configOverride(): Partial<MainApiConfig> | undefined {
    if (apiSource.value === 'active') return undefined
    if (apiSource.value.startsWith('profile:')) {
      const profile = profiles.find((item) => `profile:${item.id}` === apiSource.value)
      if (!profile) throw new Error('选择的 API 配置已不存在')
      return { ...profile }
    }
    const base = mainApiService.getConfig()
    const customUrl = temporaryUrl.value.trim()
    const customKey = temporaryApiKey.value.trim()
    const customModel = temporaryModel.value.trim()
    return {
      ...base,
      protocol: temporaryProtocol.value,
      url: customUrl || base.url,
      apiKey: customUrl ? customKey : customKey || base.apiKey,
      model: customModel || base.model,
    }
  }

  const resourceIndex = computed(
    () => new Map(props.resources.map((resource) => [resource.id, resource])),
  )
  function reviewItemsFromSuggestions(suggestions: AiTaggingSuggestion[]): ReviewItem[] {
    const resourceById = resourceIndex.value
    return suggestions.flatMap((suggestion) => {
      const resource = resourceById.get(suggestion.resourceId)
      return resource
        ? [{ ...suggestion, resource, accepted: true, draftTag: '' } satisfies ReviewItem]
        : []
    })
  }

  function mergeReviewItems(suggestions: AiTaggingSuggestion[], replacingIds: Set<string>): void {
    const replacements = new Map(
      reviewItemsFromSuggestions(suggestions).map((item) => [item.resourceId, item]),
    )
    const retained = reviewItems.value.filter((item) => !replacingIds.has(item.resourceId))
    reviewItems.value = [...retained, ...replacements.values()]
  }

  async function runRecognition(resourceIds: string[], preserveSuccesses: boolean): Promise<void> {
    if (stage.value === 'running') return
    if (systemPromptError.value || batchSizeError.value) {
      message.value = systemPromptError.value || batchSizeError.value
      return
    }
    if (!resourceIds.length) {
      message.value = '请先选择要识别的资源。'
      return
    }
    message.value = '正在读取首批资源并准备上下文…'
    if (!preserveSuccesses) {
      reviewPage.value = 1
      failures.value = []
      reviewItems.value = []
      usageText.value = ''
    }
    progressCompleted.value = 0
    progressTotal.value = resourceIds.length
    progressBatch.value = 0
    progressBatchCount.value = Math.ceil(resourceIds.length / batchSize.value)
    progressResourceNames.value = []
    stopRequested.value = false
    const controller = new AbortController()
    recognitionController = controller
    const isCurrent = () => recognitionController === controller && !controller.signal.aborted
    const targetIds = new Set(resourceIds)
    if (preserveSuccesses)
      failures.value = failures.value.filter(
        (failure) => !failure.resourceIds.some((id) => targetIds.has(id)),
      )
    stage.value = 'running'
    try {
      const result = await aiTaggingService.recognize({
        resourceIds,
        batchSize: batchSize.value,
        concurrency: concurrency.value,
        customPrompt: customPrompt.value,
        systemPrompt: systemPrompt.value,
        taxonomyTemplateId: taxonomyTemplateId.value,
        mergeAliases: mergeAliases.value,
        apiOverride: configOverride(),
        shouldContinue: isCurrent,
        signal: controller.signal,
        onBatchResult: (batch) => {
          if (!isCurrent()) return
          mergeReviewItems(
            batch.suggestions,
            new Set(batch.suggestions.map((item) => item.resourceId)),
          )
          failures.value = [...failures.value, ...batch.failures].sort(
            (left, right) => left.batch - right.batch,
          )
          usageText.value = `${batch.usage.totalTokens.toLocaleString()} Token · ${batch.usage.source === 'provider' ? '供应商统计' : '估算'}`
          if (reviewItems.value.length || failures.value.length)
            aiTaggingDraftService.saveDraft({ ...buildDraft(), stage: 'review' })
        },
        onProgress: (progress) => {
          if (!isCurrent()) return
          progressCompleted.value = progress.completed
          progressTotal.value = progress.total
          progressBatch.value = progress.batch
          progressBatchCount.value = progress.batchCount
          if (progress.resourceNames) progressResourceNames.value = progress.resourceNames
          message.value =
            progress.phase === 'request'
              ? `正在识别第 ${progress.batch}/${progress.batchCount} 批，等待 API 返回。`
              : `已处理 ${progress.completed}/${progress.total} 项，继续识别其余资源。`
        },
      })
      if (!isCurrent()) return
      if (preserveSuccesses) {
        failures.value = [
          ...failures.value.filter(
            (failure) => !failure.resourceIds.some((resourceId) => targetIds.has(resourceId)),
          ),
          ...result.failures,
        ]
        mergeReviewItems(result.suggestions, targetIds)
      } else {
        failures.value = result.failures
        reviewItems.value = reviewItemsFromSuggestions(result.suggestions)
      }
      usageText.value = `${result.usage.totalTokens.toLocaleString()} Token · ${
        result.usage.source === 'provider' ? '供应商统计' : '估算'
      }`
      message.value = result.stopped
        ? `已停止后续批次，保留 ${reviewItems.value.length} 项已完成结果。`
        : failures.value.length
          ? `已保留成功结果，${retryableResourceIds.value.length} 项可单独重试。`
          : reviewItems.value.length
            ? `识别完成，请逐项审核后再注入。`
            : '没有生成可审核结果，请检查失败信息后调整批次或 API。'
      stage.value = 'review'
      persistDraft()
    } catch (error) {
      if (!isCurrent()) return
      message.value = error instanceof Error ? error.message : 'AI 标签识别失败'
      stage.value = reviewItems.value.length || failures.value.length ? 'review' : 'select'
    } finally {
      if (recognitionController === controller) recognitionController = undefined
    }
  }

  async function startRecognition(): Promise<void> {
    await runRecognition(Array.from(selectedIds.value), false)
  }

  async function retryFailures(): Promise<void> {
    await runRecognition(retryableResourceIds.value, true)
  }

  function requestStop(): void {
    stopRequested.value = true
    const controller = recognitionController
    recognitionController = undefined
    controller?.abort()
    stage.value = 'review'
    message.value = `已停止识别，保留 ${reviewItems.value.length} 项已完成结果。${mainApiCancellationNotice()}`
    persistDraft()
  }

  function setAllAccepted(accepted: boolean): void {
    reviewItems.value = reviewItems.value.map((item) => ({ ...item, accepted }))
  }

  function removeTag(item: ReviewItem, tag: AiTaggingSuggestedTag): void {
    item.tags = item.tags.filter((candidate) => candidate !== tag)
  }

  function addDraftTag(item: ReviewItem): void {
    const tag = item.draftTag.replace(/^#+/u, '').replace(/\s+/gu, ' ').trim().slice(0, 40)
    if (!tag) return
    const existing = new Set(
      [...item.resource.tags, ...item.tags.map((candidate) => candidate.name)].map((candidate) =>
        candidate.toLocaleLowerCase(),
      ),
    )
    if (!existing.has(tag.toLocaleLowerCase()))
      item.tags.push({
        name: tag,
        evidence: '用户在审核阶段手动补充',
        level: 'explicit',
      })
    item.draftTag = ''
  }

  async function applyReviewedTags(): Promise<void> {
    if (!acceptedItems.value.length || applying.value) return
    applying.value = true
    message.value = '正在把已审核标签写入本地资源库…'
    try {
      const result = await resourceService.addTagsPerResource(
        acceptedItems.value.map((item) => ({
          resourceId: item.resourceId,
          tags: item.tags.map((tag) => tag.name),
        })),
      )
      if (result.entries.length) {
        const record: AiTaggingUndoRecord = {
          version: 1,
          appliedAt: Date.now(),
          additions: result.entries,
        }
        aiTaggingDraftService.saveUndo(record)
        undoRecord.value = record
      }
      aiTaggingDraftService.clearDraft()
      emit('applied', {
        resourceCount: result.resourceCount,
        tagCount: result.tagCount,
        resourceIds: result.entries.map((entry) => entry.resourceId),
        action: 'apply',
      })
      emit('close')
    } catch (error) {
      message.value = error instanceof Error ? error.message : '标签写入失败'
    } finally {
      applying.value = false
    }
  }

  function backToSelection(): void {
    stage.value = 'select'
    message.value = '审核草稿尚未写入，可调整后重新识别。'
  }

  function buildDraft(): AiTaggingDraft {
    return {
      version: 1,
      savedAt: Date.now(),
      stage: stage.value === 'review' ? 'review' : 'select',
      searchQuery: searchQuery.value,
      typeFilter: typeFilter.value,
      categoryFilter: categoryFilter.value,
      tagState: tagState.value,
      tagQuery: tagQuery.value,
      selectedIds: Array.from(selectedIds.value),
      batchSize: batchSize.value,
      concurrency: concurrency.value,
      customPrompt: customPrompt.value,
      ...(systemPrompt.value !== undefined ? { systemPrompt: systemPrompt.value } : {}),
      taxonomyTemplateId: taxonomyTemplateId.value,
      mergeAliases: mergeAliases.value,
      api: {
        source: apiSource.value,
        temporaryProtocol: temporaryProtocol.value,
        temporaryUrl: temporaryUrl.value,
        temporaryModel: temporaryModel.value,
      },
      reviewItems: reviewItems.value.map((item) => ({
        resourceId: item.resourceId,
        tags: item.tags,
        accepted: item.accepted,
        draftTag: item.draftTag,
      })),
      failures: failures.value,
      usageText: usageText.value,
    }
  }

  function hasDraftWork(): boolean {
    return (
      selectedIds.value.size > 0 ||
      reviewItems.value.length > 0 ||
      failures.value.length > 0 ||
      searchQuery.value.length > 0 ||
      typeFilter.value !== 'all' ||
      categoryFilter.value !== 'all' ||
      tagState.value !== 'all' ||
      tagQuery.value.length > 0 ||
      batchSize.value !== AI_TAGGING_DEFAULT_BATCH_SIZE ||
      concurrency.value !== AI_TAGGING_DEFAULT_CONCURRENCY ||
      customPrompt.value !== DEFAULT_CUSTOM_PROMPT ||
      systemPrompt.value !== undefined ||
      taxonomyTemplateId.value !== 'free' ||
      mergeAliases.value ||
      apiSource.value !== 'active' ||
      temporaryUrl.value.length > 0 ||
      temporaryModel.value.length > 0
    )
  }

  function persistDraft(): void {
    if (restoringDraft || stage.value === 'running') return
    if (hasDraftWork()) aiTaggingDraftService.saveDraft(buildDraft())
    else aiTaggingDraftService.clearDraft()
  }

  function restoreDraft(draft: AiTaggingDraft): void {
    const resourceById = new Map(props.resources.map((resource) => [resource.id, resource]))
    restoringDraft = true
    searchQuery.value = draft.searchQuery
    typeFilter.value = resourceTypes.value.some((item) => item.type === draft.typeFilter)
      ? (draft.typeFilter as ResourceType)
      : 'all'
    categoryFilter.value =
      draft.categoryFilter === 'all' ||
      draft.categoryFilter === 'uncategorized' ||
      props.categories.some((category) => category.id === draft.categoryFilter)
        ? draft.categoryFilter
        : 'all'
    tagState.value = draft.tagState
    tagQuery.value = draft.tagQuery
    selectedIds.value = new Set(draft.selectedIds.filter((id) => resourceById.has(id)))
    batchSize.value = draft.batchSize
    concurrency.value = normalizeAiTaggingConcurrency(draft.concurrency)
    customPrompt.value = draft.customPrompt
    systemPrompt.value = draft.systemPrompt
    taxonomyTemplateId.value = AI_TAGGING_TAXONOMY_TEMPLATES.some(
      (template) => template.id === draft.taxonomyTemplateId,
    )
      ? draft.taxonomyTemplateId
      : 'free'
    mergeAliases.value = draft.mergeAliases
    apiSource.value =
      draft.api.source === 'temporary' ||
      draft.api.source === 'active' ||
      profiles.some((profile) => `profile:${profile.id}` === draft.api.source)
        ? draft.api.source
        : 'active'
    temporaryProtocol.value = draft.api.temporaryProtocol
    temporaryUrl.value = draft.api.temporaryUrl
    temporaryApiKey.value = ''
    temporaryModel.value = draft.api.temporaryModel
    reviewItems.value = draft.reviewItems.flatMap((item) => {
      const resource = resourceById.get(item.resourceId)
      return resource ? [{ ...item, resource } satisfies ReviewItem] : []
    })
    failures.value = draft.failures.flatMap((failure) => {
      const resourceIds = failure.resourceIds.filter((id) => resourceById.has(id))
      return resourceIds.length ? [{ ...failure, resourceIds }] : []
    })
    usageText.value = draft.usageText
    stage.value =
      draft.stage === 'review' && (reviewItems.value.length || failures.value.length)
        ? 'review'
        : 'select'
    restoredAt.value = draft.savedAt
    message.value = '已恢复上次本机草稿；临时 API Key 未保存，需要时请重新填写。'
    restoringDraft = false
  }

  async function discardDraft(): Promise<void> {
    const confirmed = await confirmAction({
      title: '放弃 AI 标签草稿？',
      message: '将清空当前选择、识别结果与审核修改。此操作不会改变已经写入资源的标签。',
      confirmLabel: '放弃草稿',
      cancelLabel: '继续保留',
      danger: true,
    })
    if (!confirmed) return
    restoringDraft = true
    searchQuery.value = ''
    typeFilter.value = 'all'
    categoryFilter.value = 'all'
    tagState.value = 'all'
    tagQuery.value = ''
    selectedIds.value = new Set(props.initialSelectedIds ?? [])
    batchSize.value = AI_TAGGING_DEFAULT_BATCH_SIZE
    concurrency.value = AI_TAGGING_DEFAULT_CONCURRENCY
    customPrompt.value = DEFAULT_CUSTOM_PROMPT
    systemPrompt.value = undefined
    taxonomyTemplateId.value = 'free'
    mergeAliases.value = false
    apiSource.value = 'active'
    temporaryProtocol.value = 'openai-compatible'
    temporaryUrl.value = ''
    temporaryApiKey.value = ''
    temporaryModel.value = ''
    reviewItems.value = []
    failures.value = []
    usageText.value = ''
    stage.value = 'select'
    aiTaggingDraftService.clearDraft()
    restoredAt.value = 0
    restoringDraft = false
    message.value = '草稿已清空，可以开始新的识别任务。'
  }

  async function undoLastApplication(): Promise<void> {
    const record = undoRecord.value
    if (!record || undoing.value) return
    const confirmed = await confirmAction({
      title: '撤销上次 AI 标签注入？',
      message: `将从 ${record.additions.length} 项资源中移除上次新增且目前仍存在的 ${undoTagCount.value} 个标签。原有标签和之后改名的标签不会删除。`,
      confirmLabel: '撤销注入',
      cancelLabel: '保留标签',
      danger: true,
    })
    if (!confirmed) return
    undoing.value = true
    try {
      const result = await resourceService.undoAddedTags(record.additions)
      aiTaggingDraftService.clearUndo()
      undoRecord.value = undefined
      message.value = `已撤销 ${result.resourceCount} 项资源中的 ${result.tagCount} 个 AI 新增标签。`
      emit('applied', {
        resourceCount: result.resourceCount,
        tagCount: result.tagCount,
        resourceIds: result.entries.map((entry) => entry.resourceId),
        action: 'undo',
      })
    } catch (error) {
      message.value = error instanceof Error ? error.message : '撤销 AI 标签失败'
    } finally {
      undoing.value = false
    }
  }

  async function requestClose(): Promise<void> {
    if (stage.value === 'running') {
      requestStop()
      return
    }
    persistDraft()
    if (hasDraftWork()) {
      const confirmed = await confirmAction({
        title: '保存草稿并退出？',
        message: '当前选择和审核结果已保存在本机，下次打开可以继续。临时 API Key 不会保存。',
        confirmLabel: '保存并退出',
        cancelLabel: '继续编辑',
      })
      if (!confirmed) return
    }
    emit('close')
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (props.suspended || event.key !== 'Escape') return
    // Another overlay may close and Vue may resume this panel between key listeners.
    // Keep that same Escape with its original overlay; the global back stack blocks
    // AI closing so Escape from inside this panel still needs its own draft guard.
    if (
      event.defaultPrevented &&
      !(event.target instanceof Element && event.target.closest('.ai-tagging'))
    )
      return
    event.preventDefault()
    void requestClose()
  }

  onMounted(() => {
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeydown)
    const draft = aiTaggingDraftService.loadDraft()
    if (draft) restoreDraft(draft)
    undoRecord.value = aiTaggingDraftService.loadUndo()
    void nextTick(() =>
      document.querySelector<HTMLElement>('.ai-tagging__close')?.focus({ preventScroll: true }),
    )
  })

  onBeforeUnmount(() => {
    const controller = recognitionController
    recognitionController = undefined
    controller?.abort()
    window.removeEventListener('keydown', handleKeydown)
    document.body.style.overflow = previousBodyOverflow
    void nextTick(() => triggerElement?.focus({ preventScroll: true }))
  })

  watch(
    [
      searchQuery,
      typeFilter,
      categoryFilter,
      tagState,
      tagQuery,
      selectedIds,
      batchSize,
      concurrency,
      customPrompt,
      systemPrompt,
      taxonomyTemplateId,
      mergeAliases,
      apiSource,
      temporaryProtocol,
      temporaryUrl,
      temporaryModel,
      reviewItems,
      failures,
      stage,
    ],
    persistDraft,
    { deep: true },
  )

  watch(taxonomyTemplateId, () => {
    if (!Object.keys(activeTaxonomyTemplate.value.aliases).length) mergeAliases.value = false
  })
  let detailTrigger: HTMLElement | undefined
  function openReviewResource(item: ReviewItem, event: Event): void {
    detailTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
    emit('openResource', item.resource)
  }
  watch(
    () => props.suspended,
    async (suspended, previous) => {
      if (!suspended && !previous) return
      await nextTick()
      if (suspended)
        document
          .querySelector<HTMLElement>('.resource-detail__header .editor-sheet__close')
          ?.focus({ preventScroll: true })
      else detailTrigger?.focus({ preventScroll: true })
    },
  )
  watch(
    () => props.resources,
    (resources) => {
      const byId = new Map(resources.map((resource) => [resource.id, resource]))
      for (const item of reviewItems.value)
        item.resource = byId.get(item.resourceId) ?? item.resource
    },
  )
  return {
    openReviewResource,
    batchSizeError,
    AI_TAGGING_RESOURCE_CHAR_BUDGET,
    systemPromptText,
    isSystemPromptCustom,
    systemPromptError,
    resetSystemPrompt,
    AI_TAGGING_MAX_SYSTEM_PROMPT,
    progressResourceNames,
    selectedApiSummary,
    activeFilterCount,
    requestClose,
    stage,
    restoredAt,
    undoRecord,
    draftTime,
    discardDraft,
    undoTagCount,
    undoing,
    undoLastApplication,
    filteredResources,
    candidatePage,
    candidatePageCount,
    pageCandidates,
    searchQuery,
    typeFilter,
    resourceTypes,
    categoryFilter,
    tagState,
    tagQuery,
    toggleFilteredSelection,
    allFilteredSelected,
    clearSelection,
    selectedIds,
    customPrompt,
    ruleTemplates,
    ruleTemplateName,
    selectedRuleTemplateId,
    applyRuleTemplate,
    saveRuleTemplate,
    deleteRuleTemplate,
    batchSize,
    concurrency,
    AI_TAGGING_MAX_CONCURRENCY,
    taxonomyTemplateId,
    AI_TAGGING_TAXONOMY_TEMPLATES,
    activeTaxonomyTemplate,
    mergeAliases,
    apiSource,
    activeProfile,
    get profiles() {
      return profiles
    },
    set profiles(value: typeof profiles) {
      profiles = value
    },
    apiDetailsOpen,
    temporaryProtocol,
    temporaryModel,
    temporaryUrl,
    temporaryApiKey,
    toggleResource,
    RESOURCE_TYPE_LABELS,
    progressPercent,
    progressBatch,
    progressBatchCount,
    message,
    progressCompleted,
    progressTotal,
    stopRequested,
    requestStop,
    setAllAccepted,
    reviewItems,
    reviewPage,
    reviewPageSize,
    reviewPageCount,
    pageReviewItems,
    removeTag,
    addDraftTag,
    failures,
    retryableResourceIds,
    retryFailures,
    resourceName,
    usageText,
    startRecognition,
    applying,
    backToSelection,
    acceptedItems,
    applyReviewedTags,
    acceptedTagCount,
  }
}
