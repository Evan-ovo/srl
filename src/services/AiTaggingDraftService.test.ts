/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AiTaggingDraftService, type AiTaggingDraft } from './AiTaggingDraftService'

describe('AiTaggingDraftService', () => {
  beforeEach(() => localStorage.clear())
  it('reports storage failures and over-limit template merges without dropping existing templates', () => {
    const service = new AiTaggingDraftService()
    service.saveRuleTemplate('local', 'original', 'free', false)
    const backup = service.exportPortableState()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      expect(() => service.importPortableState(backup)).toThrow('保存失败')
    } finally {
      write.mockRestore()
    }
    expect(service.loadRuleTemplates()).toEqual(backup.ruleTemplates)
    for (let i = 1; i < 30; i++)
      service.saveRuleTemplate('local ' + i, 'original ' + i, 'free', false)
    expect(() =>
      service.importPortableState({
        ruleTemplates: [
          {
            id: 'another',
            name: 'incoming',
            prompt: 'new',
            taxonomyTemplateId: 'free',
            mergeAliases: false,
          },
        ],
      }),
    ).toThrow('超过30')
    expect(service.loadRuleTemplates()).toHaveLength(30)
    expect(service.loadRuleTemplates()[0]?.prompt).toBe('original')
    const discard = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => undefined)
    try {
      expect(() =>
        service.importPortableState({
          undo: {
            version: 1,
            appliedAt: 100,
            additions: [{ resourceId: 'r1', resourceName: 'saved', tags: ['tag'] }],
          },
        }),
      ).toThrow('撤销记录保存失败')
    } finally {
      discard.mockRestore()
    }
  })
  it('round-trips saved rule templates including system prompts, keeps local conflicts and is idempotent', () => {
    const service = new AiTaggingDraftService()
    service.saveRuleTemplate('换机规则', 'saved rule', 'free', true, 'saved system prompt')
    const backup = JSON.parse(JSON.stringify(service.exportPortableState()))
    expect(backup.ruleTemplates[0].systemPrompt).toBe('saved system prompt')
    localStorage.clear()
    const target = new AiTaggingDraftService()
    target.importPortableState(backup)
    expect(target.exportPortableState()).toEqual(backup)
    target.importPortableState(backup)
    expect(target.loadRuleTemplates()).toHaveLength(1)
    const conflict = structuredClone(backup)
    conflict.ruleTemplates[0].prompt = 'different imported rule'
    target.importPortableState(conflict)
    target.importPortableState(conflict)
    expect(target.loadRuleTemplates()).toHaveLength(2)
    expect(new Set(target.loadRuleTemplates().map((row) => row.id)).size).toBe(2)
    expect(target.loadRuleTemplates().map((row) => row.prompt)).toEqual([
      'saved rule',
      'different imported rule',
    ])
    target.importPortableState({})
    expect(target.loadRuleTemplates()).toHaveLength(2)
  })

  it('保存并恢复审核草稿，但永远不持久化临时 API Key', () => {
    const service = new AiTaggingDraftService()
    const draft: AiTaggingDraft = {
      version: 1,
      savedAt: 100,
      stage: 'review',
      searchQuery: '古风',
      typeFilter: 'all',
      categoryFilter: 'all',
      tagState: 'untagged',
      tagQuery: '',
      selectedIds: ['r1'],
      batchSize: 4,
      customPrompt: '只依据正文',
      systemPrompt: '完整自定义系统提示词',
      taxonomyTemplateId: 'story-resource',
      mergeAliases: true,
      api: {
        source: 'temporary',
        temporaryProtocol: 'openai-compatible',
        temporaryUrl: 'https://example.com/v1',
        temporaryModel: 'model-a',
      },
      reviewItems: [
        {
          resourceId: 'r1',
          tags: [{ name: '古风', evidence: '场景明确', level: 'explicit' }],
          accepted: true,
          draftTag: '',
        },
      ],
      failures: [],
      usageText: '120 Token',
    }

    service.saveDraft({
      ...draft,
      api: { ...draft.api, apiKey: 'must-not-persist' } as typeof draft.api,
    })

    const serialized = localStorage.getItem(localStorage.key(0) ?? '') ?? ''
    expect(serialized).toContain('https://example.com/v1')
    expect(serialized).not.toContain('must-not-persist')
    expect(service.loadDraft()).toEqual(draft)
  })

  it('撤销记录只保存资源和本次新增标签', () => {
    const service = new AiTaggingDraftService()
    const record = {
      version: 1 as const,
      appliedAt: 200,
      additions: [{ resourceId: 'r1', resourceName: '角色一', tags: ['甜宠'] }],
    }

    expect(service.saveUndo(record)).toBe(true)
    expect(service.loadUndo()).toEqual(record)
    service.clearUndo()
    expect(service.loadUndo()).toBeUndefined()
  })

  it('大批次草稿、失败资源和撤销记录不会在旧 200 项阈值截断', () => {
    const service = new AiTaggingDraftService()
    const ids = Array.from({ length: 205 }, (_, i) => `r${i}`)
    localStorage.setItem(
      'srl.aiTagging.draft.v1',
      JSON.stringify({
        version: 1,
        stage: 'review',
        api: { source: 'active' },
        batchSize: 1000,
        selectedIds: ids,
        reviewItems: ids.map((resourceId) => ({
          resourceId,
          tags: [],
          accepted: true,
          draftTag: '',
        })),
        failures: Array.from({ length: 55 }, (_, batch) => ({
          batch,
          resourceIds: ids,
          message: '失败',
          retryable: true,
        })),
      }),
    )
    const draft = service.loadDraft()!
    expect(draft.batchSize).toBe(1000)
    expect(draft.selectedIds).toEqual(ids)
    expect(draft.reviewItems).toHaveLength(205)
    expect(draft.failures).toHaveLength(55)
    expect(draft.failures[54]!.resourceIds).toEqual(ids)
    expect(service.saveDraft(draft)).toBe(true)
    expect(service.loadDraft()).toEqual(draft)
    service.saveUndo({
      version: 1,
      appliedAt: 1,
      additions: ids.map((resourceId) => ({
        resourceId,
        resourceName: resourceId,
        tags: ['新增'],
      })),
    })
    expect(service.loadUndo()!.additions).toHaveLength(205)
  })

  it('本机模板保存和恢复系统提示词，同名恢复默认会移除旧覆盖', () => {
    const service = new AiTaggingDraftService()
    service.saveRuleTemplate('题材', '只标注题材', 'free', false, '自定义系统消息')
    expect(service.loadRuleTemplates()[0]).toMatchObject({
      name: '题材',
      systemPrompt: '自定义系统消息',
    })
    service.saveRuleTemplate('题材', '只标注题材', 'story-resource', true)
    expect(service.loadRuleTemplates()).toHaveLength(1)
    expect(service.loadRuleTemplates()[0]).not.toHaveProperty('systemPrompt')
  })

  it('旧版草稿和模板缺少系统提示词时继续使用内置默认', () => {
    const service = new AiTaggingDraftService()
    localStorage.setItem(
      'srl.aiTagging.ruleTemplates.v1',
      JSON.stringify([
        {
          id: 'old',
          name: '旧模板',
          prompt: '旧要求',
          taxonomyTemplateId: 'free',
          mergeAliases: false,
        },
      ]),
    )
    localStorage.setItem(
      'srl.aiTagging.draft.v1',
      JSON.stringify({ version: 1, api: { source: 'active' } }),
    )
    expect(service.loadRuleTemplates()[0]).not.toHaveProperty('systemPrompt')
    expect(service.loadDraft()).toBeDefined()
    expect(service.loadDraft()).not.toHaveProperty('systemPrompt')
  })
})
