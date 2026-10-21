import type {
  AiTaggingEvidenceLevel,
  AiTaggingFailure,
  AiTaggingSuggestedTag,
} from './AiTaggingService'
import type { MainApiConfig } from './MainApiService'
import { AI_TAGGING_MAX_SYSTEM_PROMPT, normalizeAiTaggingBatchSize } from './AiTaggingService'
import { normalizeAiTaggingConcurrency } from './AiTaggingService'

export interface AiTaggingDraftReviewItem {
  resourceId: string
  tags: AiTaggingSuggestedTag[]
  accepted: boolean
  draftTag: string
}

export interface AiTaggingDraft {
  version: 1
  savedAt: number
  stage: 'select' | 'review'
  searchQuery: string
  typeFilter: string
  categoryFilter: string
  tagState: 'all' | 'tagged' | 'untagged'
  tagQuery: string
  selectedIds: string[]
  batchSize: number
  concurrency?: number
  customPrompt: string
  systemPrompt?: string
  taxonomyTemplateId: string
  mergeAliases: boolean
  api: {
    source: string
    temporaryProtocol: MainApiConfig['protocol']
    temporaryUrl: string
    temporaryModel: string
  }
  reviewItems: AiTaggingDraftReviewItem[]
  failures: AiTaggingFailure[]
  usageText: string
}

export interface AiTaggingUndoAddition {
  resourceId: string
  resourceName: string
  tags: string[]
}

export interface AiTaggingUndoRecord {
  version: 1
  appliedAt: number
  additions: AiTaggingUndoAddition[]
}

const DRAFT_KEY = 'srl.aiTagging.draft.v1'
const UNDO_KEY = 'srl.aiTagging.lastInjection.v1'
const RULE_TEMPLATES_KEY = 'srl.aiTagging.ruleTemplates.v1'

export interface AiTaggingRuleTemplate {
  id: string
  name: string
  prompt: string
  systemPrompt?: string
  taxonomyTemplateId: string
  mergeAliases: boolean
}
export interface AiTaggingStateBackup {
  draft?: AiTaggingDraft
  undo?: AiTaggingUndoRecord
  ruleTemplates?: AiTaggingRuleTemplate[]
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function evidenceLevel(value: unknown): AiTaggingEvidenceLevel {
  return value === 'explicit' ? 'explicit' : 'inferred'
}

function suggestedTags(value: unknown): AiTaggingSuggestedTag[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const tag = item as Partial<AiTaggingSuggestedTag>
    const name = text(tag.name, 40).trim()
    if (!name) return []
    return [
      {
        name,
        evidence: text(tag.evidence, 160).trim(),
        level: evidenceLevel(tag.level),
      },
    ]
  })
}

function failures(value: unknown): AiTaggingFailure[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const failure = item as Partial<AiTaggingFailure>
    const resourceIds = Array.isArray(failure.resourceIds)
      ? failure.resourceIds.filter((id): id is string => typeof id === 'string')
      : []
    if (!resourceIds.length) return []
    return [
      {
        batch: Number.isFinite(failure.batch) ? Math.max(1, Number(failure.batch)) : 1,
        resourceIds,
        message: text(failure.message, 500) || '识别失败',
        retryable: failure.retryable !== false,
      },
    ]
  })
}

function parseDraft(value: unknown): AiTaggingDraft | undefined {
  if (!value || typeof value !== 'object') return undefined
  const draft = value as Partial<AiTaggingDraft>
  if (draft.version !== 1 || !draft.api || typeof draft.api !== 'object') return undefined
  const selectedIds = Array.isArray(draft.selectedIds)
    ? draft.selectedIds.filter((id): id is string => typeof id === 'string')
    : []
  const reviewItems = Array.isArray(draft.reviewItems)
    ? draft.reviewItems.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const review = item as Partial<AiTaggingDraftReviewItem>
        const resourceId = text(review.resourceId, 160).trim()
        if (!resourceId) return []
        return [
          {
            resourceId,
            tags: suggestedTags(review.tags),
            accepted: review.accepted !== false,
            draftTag: text(review.draftTag, 40),
          },
        ]
      })
    : []
  const parsedFailures = failures(draft.failures)
  return {
    version: 1,
    savedAt: Number.isFinite(draft.savedAt) ? Number(draft.savedAt) : Date.now(),
    stage:
      draft.stage === 'review' && (reviewItems.length || parsedFailures.length)
        ? 'review'
        : 'select',
    searchQuery: text(draft.searchQuery, 160),
    typeFilter: text(draft.typeFilter, 80) || 'all',
    categoryFilter: text(draft.categoryFilter, 160) || 'all',
    tagState: draft.tagState === 'tagged' || draft.tagState === 'untagged' ? draft.tagState : 'all',
    tagQuery: text(draft.tagQuery, 40),
    selectedIds,
    batchSize: normalizeAiTaggingBatchSize(draft.batchSize),
    ...(draft.concurrency !== undefined
      ? { concurrency: normalizeAiTaggingConcurrency(draft.concurrency) }
      : {}),
    customPrompt: text(draft.customPrompt, 4_000),
    ...(typeof draft.systemPrompt === 'string'
      ? { systemPrompt: text(draft.systemPrompt, AI_TAGGING_MAX_SYSTEM_PROMPT) }
      : {}),
    taxonomyTemplateId: text(draft.taxonomyTemplateId, 80) || 'free',
    mergeAliases: draft.mergeAliases === true,
    api: {
      source: text(draft.api.source, 160) || 'active',
      temporaryProtocol:
        draft.api.temporaryProtocol === 'anthropic-compatible'
          ? 'anthropic-compatible'
          : 'openai-compatible',
      temporaryUrl: text(draft.api.temporaryUrl, 2_000),
      temporaryModel: text(draft.api.temporaryModel, 200),
    },
    reviewItems,
    failures: parsedFailures,
    usageText: text(draft.usageText, 200),
  }
}

function parseUndo(value: unknown): AiTaggingUndoRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<AiTaggingUndoRecord>
  if (record.version !== 1 || !Array.isArray(record.additions)) return undefined
  const additions = record.additions.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const addition = item as Partial<AiTaggingUndoAddition>
    const resourceId = text(addition.resourceId, 160).trim()
    const tags = Array.isArray(addition.tags)
      ? addition.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
      : []
    if (!resourceId || !tags.length) return []
    return [{ resourceId, resourceName: text(addition.resourceName, 160), tags }]
  })
  if (!additions.length) return undefined
  return {
    version: 1,
    appliedAt: Number.isFinite(record.appliedAt) ? Number(record.appliedAt) : Date.now(),
    additions,
  }
}

function parseRuleTemplates(value: unknown): AiTaggingRuleTemplate[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const template = item as Partial<AiTaggingRuleTemplate>
    const id = text(template.id, 80).trim()
    const name = text(template.name, 80).trim()
    const prompt = text(template.prompt, 4_000).trim()
    return id && name && prompt
      ? [
          {
            id,
            name,
            prompt,
            ...(typeof template.systemPrompt === 'string'
              ? { systemPrompt: text(template.systemPrompt, AI_TAGGING_MAX_SYSTEM_PROMPT) }
              : {}),
            taxonomyTemplateId: text(template.taxonomyTemplateId, 80) || 'free',
            mergeAliases: template.mergeAliases === true,
          },
        ]
      : []
  })
}

export class AiTaggingDraftService {
  loadRuleTemplates(): AiTaggingRuleTemplate[] {
    try {
      return parseRuleTemplates(JSON.parse(storage()?.getItem(RULE_TEMPLATES_KEY) ?? '[]'))
    } catch {
      return []
    }
  }
  exportPortableState(): AiTaggingStateBackup {
    return {
      draft: this.loadDraft(),
      undo: this.loadUndo(),
      ruleTemplates: this.loadRuleTemplates(),
    }
  }
  importPortableState(value: AiTaggingStateBackup): void {
    if (value.ruleTemplates !== undefined) {
      if (!Array.isArray(value.ruleTemplates)) throw new Error('AI 标注规则模板格式无效')
      const incoming = parseRuleTemplates(value.ruleTemplates)
      if (incoming.length !== value.ruleTemplates.length)
        throw new Error('AI 标注规则模板格式无效或超过30项')
      const merged = this.loadRuleTemplates()
      for (const item of incoming) {
        if (
          merged.some(
            (row) =>
              row.name === item.name &&
              row.prompt === item.prompt &&
              row.systemPrompt === item.systemPrompt &&
              row.taxonomyTemplateId === item.taxonomyTemplateId &&
              row.mergeAliases === item.mergeAliases,
          )
        )
          continue
        merged.push(
          merged.some((row) => row.id === item.id) ? { ...item, id: crypto.randomUUID() } : item,
        )
      }
      if (merged.length > 30) throw new Error('合并后的 AI 标注规则模板超过30项，现有模板已保留')
      const target = storage(),
        encoded = JSON.stringify(merged)
      if (!target) throw new Error('本机存储不可用，AI 标注规则模板未恢复')
      try {
        target.setItem(RULE_TEMPLATES_KEY, encoded)
        if (target.getItem(RULE_TEMPLATES_KEY) !== encoded) throw new Error('readback failed')
      } catch {
        throw new Error('AI 标注规则模板保存失败，请检查本机存储后重试')
      }
    }
    if (value.draft) {
      const expected = parseDraft(value.draft)
      if (
        !expected ||
        !this.saveDraft(expected) ||
        JSON.stringify(this.loadDraft()) !== JSON.stringify(expected)
      )
        throw new Error('AI 标注草稿保存失败，请检查数据和本机存储后重试')
    }
    if (value.undo) {
      const expected = parseUndo(value.undo)
      if (
        !expected ||
        !this.saveUndo(expected) ||
        JSON.stringify(this.loadUndo()) !== JSON.stringify(expected)
      )
        throw new Error('AI 标注撤销记录保存失败，请检查数据和本机存储后重试')
    }
  }

  saveRuleTemplate(
    name: string,
    prompt: string,
    taxonomyTemplateId: string,
    mergeAliases: boolean,
    systemPrompt?: string,
  ): AiTaggingRuleTemplate[] {
    const normalizedName = name.trim().slice(0, 80)
    const normalizedPrompt = prompt.trim().slice(0, 4_000)
    const system =
      typeof systemPrompt === 'string'
        ? systemPrompt.slice(0, AI_TAGGING_MAX_SYSTEM_PROMPT)
        : undefined
    if (!normalizedName || !normalizedPrompt) throw new Error('请填写模板名称和识别规则')
    const templates = this.loadRuleTemplates()
    const existing = templates.find((item) => item.name === normalizedName)
    const next = existing
      ? templates.map((item) =>
          item.id === existing.id
            ? {
                ...item,
                prompt: normalizedPrompt,
                taxonomyTemplateId,
                mergeAliases,
                systemPrompt: system,
              }
            : item,
        )
      : [
          ...templates,
          {
            id: crypto.randomUUID(),
            name: normalizedName,
            prompt: normalizedPrompt,
            systemPrompt: system,
            taxonomyTemplateId,
            mergeAliases,
          },
        ].slice(-30)
    const target = storage()
    if (!target) throw new Error('本机存储不可用，模板没有保存')
    try {
      target.setItem(RULE_TEMPLATES_KEY, JSON.stringify(next))
      return next
    } catch {
      throw new Error('本机存储空间不足，模板没有保存')
    }
  }

  deleteRuleTemplate(id: string): AiTaggingRuleTemplate[] {
    const next = this.loadRuleTemplates().filter((item) => item.id !== id)
    const target = storage()
    if (!target) throw new Error('本机存储不可用，模板没有删除')
    try {
      target.setItem(RULE_TEMPLATES_KEY, JSON.stringify(next))
    } catch {
      throw new Error('模板删除失败')
    }
    return next
  }

  loadDraft(): AiTaggingDraft | undefined {
    try {
      return parseDraft(JSON.parse(storage()?.getItem(DRAFT_KEY) ?? 'null'))
    } catch {
      return undefined
    }
  }

  saveDraft(draft: AiTaggingDraft): boolean {
    try {
      const safeDraft = parseDraft(draft)
      if (!safeDraft) return false
      const target = storage()
      if (!target) return false
      target.setItem(DRAFT_KEY, JSON.stringify(safeDraft))
      return true
    } catch {
      return false
    }
  }

  clearDraft(): void {
    try {
      storage()?.removeItem(DRAFT_KEY)
    } catch {
      // 草稿清理失败不阻断当前审核。
    }
  }

  loadUndo(): AiTaggingUndoRecord | undefined {
    try {
      return parseUndo(JSON.parse(storage()?.getItem(UNDO_KEY) ?? 'null'))
    } catch {
      return undefined
    }
  }

  saveUndo(record: AiTaggingUndoRecord): boolean {
    try {
      const safeRecord = parseUndo(record)
      if (!safeRecord) return false
      const target = storage()
      if (!target) return false
      target.setItem(UNDO_KEY, JSON.stringify(safeRecord))
      return true
    } catch {
      return false
    }
  }

  clearUndo(): void {
    try {
      storage()?.removeItem(UNDO_KEY)
    } catch {
      // 撤销记录清理失败不影响资源数据。
    }
  }
}
