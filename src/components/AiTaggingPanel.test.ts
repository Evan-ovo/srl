/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RESOURCE_TYPE, type Category, type ResourceSummary } from '../types/Resource'
import AiTaggingPanel from './AiTaggingPanel.vue'
import { getAiTaggingSystemPrompt } from '../services/AiTaggingService'
import type { AiTaggingRunOptions, AiTaggingRunResult } from '../services/AiTaggingService'

const mocks = vi.hoisted(() => ({
  recognize: vi.fn(),
  addTagsPerResource: vi.fn(),
  undoAddedTags: vi.fn(),
  loadDraft: vi.fn(),
  saveDraft: vi.fn(() => true),
  clearDraft: vi.fn(),
  loadUndo: vi.fn(),
  saveUndo: vi.fn(() => true),
  clearUndo: vi.fn(),
  confirmAction: vi.fn(async () => true),
  loadRuleTemplates: vi.fn(() => []),
  saveRuleTemplate: vi.fn(() => []),
}))

vi.mock('../core/AppContainer', () => ({
  aiTaggingService: { recognize: mocks.recognize },
  aiTaggingDraftService: {
    loadRuleTemplates: mocks.loadRuleTemplates,
    saveRuleTemplate: mocks.saveRuleTemplate,
    loadDraft: mocks.loadDraft,
    saveDraft: mocks.saveDraft,
    clearDraft: mocks.clearDraft,
    loadUndo: mocks.loadUndo,
    saveUndo: mocks.saveUndo,
    clearUndo: mocks.clearUndo,
  },
  resourceService: {
    addTagsPerResource: mocks.addTagsPerResource,
    undoAddedTags: mocks.undoAddedTags,
  },
  mainApiService: {
    getProfilesState: () => ({
      activeProfileId: 'main',
      profiles: [
        {
          id: 'main',
          name: '主配置',
          protocol: 'openai-compatible',
          url: 'https://example.com/v1',
          apiKey: 'secret',
          model: 'model-a',
          stream: false,
          reasoningEffort: 'auto',
          temperature: 0.7,
          topP: 1,
          maxTokens: 0,
          frequencyPenalty: 0,
          presencePenalty: 0,
        },
      ],
    }),
    getConfig: () => ({
      protocol: 'openai-compatible',
      url: 'https://example.com/v1',
      apiKey: 'secret',
      model: 'model-a',
      stream: false,
      reasoningEffort: 'auto',
      temperature: 0.7,
      topP: 1,
      maxTokens: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
    }),
  },
}))

vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: mocks.confirmAction }))

const resources = [
  {
    id: 'r1',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: '林间少女',
    description: '古风角色',
    fileName: 'r1.png',
    mimeType: 'image/png',
    fileSize: 10,
    contentHash: 'h1',
    favorite: false,
    categoryId: 'f1',
    categoryIds: ['f1'],
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'r2',
    type: RESOURCE_TYPE.WORLD_BOOK,
    name: '都市设定',
    description: '现代城市',
    fileName: 'r2.json',
    mimeType: 'application/json',
    fileSize: 10,
    contentHash: 'h2',
    favorite: false,
    categoryId: null,
    categoryIds: [],
    tags: ['现代'],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  },
] as ResourceSummary[]

const categories = [{ id: 'f1', name: '古风卡', color: '#888' }] as Category[]

afterEach(() => {
  mocks.recognize.mockReset()
  mocks.addTagsPerResource.mockReset()
  mocks.undoAddedTags.mockReset()
  mocks.loadDraft.mockReset()
  mocks.loadDraft.mockReturnValue(undefined)
  mocks.loadUndo.mockReset()
  mocks.loadUndo.mockReturnValue(undefined)
  mocks.saveDraft.mockClear()
  mocks.clearDraft.mockClear()
  mocks.saveUndo.mockClear()
  mocks.clearUndo.mockClear()
  mocks.confirmAction.mockClear()
  mocks.confirmAction.mockResolvedValue(true)
  mocks.loadRuleTemplates.mockReset().mockReturnValue([])
  mocks.saveRuleTemplate.mockReset().mockReturnValue([])
  document.body.style.overflow = ''
})

describe('AiTaggingPanel', () => {
  it('停止立即进入审核、保留逐批草稿；迟到任务不能覆盖新一轮识别', async () => {
    const runs: { options: AiTaggingRunOptions; resolve: (result: AiTaggingRunResult) => void }[] =
      []
    mocks.recognize.mockImplementation(
      (options: AiTaggingRunOptions) =>
        new Promise<AiTaggingRunResult>((resolve) => runs.push({ options, resolve })),
    )
    const wrapper = mount(AiTaggingPanel, {
      props: { resources, categories, initialSelectedIds: ['r1'] },
    })
    await flushPromises()
    await wrapper.get('.ai-tagging__footer .is-primary').trigger('click')
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: 'provider' as const,
    }
    const suggestions = [
      { resourceId: 'r1', tags: [{ name: '古风', evidence: '文本', level: 'explicit' as const }] },
    ]
    runs[0]!.options.onBatchResult!({ suggestions, failures: [], usage })
    await flushPromises()
    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'review',
        reviewItems: expect.arrayContaining([expect.objectContaining({ resourceId: 'r1' })]),
      }),
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '停止识别')!
      .trigger('click')
    expect(runs[0]!.options.signal!.aborted).toBe(true)
    expect(wrapper.find('.ai-tagging__running').exists()).toBe(false)
    expect(wrapper.get('.ai-tagging__review').text()).toContain('古风')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '返回调整')!
      .trigger('click')
    await wrapper.get('.ai-tagging__footer .is-primary').trigger('click')
    runs[0]!.options.onBatchResult!({
      suggestions: [
        { ...suggestions[0]!, tags: [{ ...suggestions[0]!.tags[0]!, name: '迟到结果' }] },
      ],
      failures: [],
      usage,
    })
    runs[0]!.resolve({ suggestions, failures: [], errors: [], stopped: false, usage })
    await flushPromises()
    expect(wrapper.find('.ai-tagging__running').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('迟到结果')
    wrapper.unmount()
    expect(runs[1]!.options.signal!.aborted).toBe(true)
  })

  it('大量建议按页展示，跨页审核不缩减应用范围', async () => {
    const many = Array.from({ length: 105 }, (_, index) => ({
      ...resources[0]!,
      id: `review-${index}`,
      name: `资源${index}`,
    }))
    mocks.recognize.mockResolvedValue({
      suggestions: many.map((resource) => ({
        resourceId: resource.id,
        tags: [{ name: '校园', evidence: '文本', level: 'explicit' }],
      })),
      failures: [],
      stopped: false,
      usage: { totalTokens: 120, source: 'provider' },
    })
    const wrapper = mount(AiTaggingPanel, {
      props: {
        resources: many,
        categories,
        initialSelectedIds: many.map((resource) => resource.id),
      },
    })
    await flushPromises()
    await wrapper.get('.ai-tagging__footer .is-primary').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.ai-tagging__review-card')).toHaveLength(20)
    await wrapper.get('.ai-tagging__review-card input[type="checkbox"]').setValue(false)
    await wrapper.get('nav[aria-label="标签建议分页"]').findAll('button')[1]!.trigger('click')
    await wrapper.get('.ai-tagging__review-card input[type="checkbox"]').setValue(false)
    expect(wrapper.get('.ai-tagging__footer').text()).toContain('注入 103 项')
    wrapper.unmount()
  })
  it('大库只渲染一页，跨页选择和筛选全选仍保留完整范围', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      ...resources[0]!,
      id: `item-${i}`,
      name: `资源 ${i}`,
    }))
    const wrapper = mount(AiTaggingPanel, { props: { resources: many, categories } })
    expect(wrapper.findAll('.ai-tagging__candidate')).toHaveLength(40)
    await wrapper.get('.ai-tagging__candidate input').setValue(true)
    const pagination = () => wrapper.get('nav[aria-label="待识别资源分页"]')
    await pagination().findAll('button')[1]!.trigger('click')
    expect(pagination().text()).toContain('2 / 25 页')
    expect(wrapper.get('.ai-tagging__candidate strong').text()).toBe('资源 40')
    await wrapper.get('.ai-tagging__candidate input').setValue(true)
    await pagination().findAll('button')[0]!.trigger('click')
    expect((wrapper.get('.ai-tagging__candidate input').element as HTMLInputElement).checked).toBe(
      true,
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '选择当前筛选 1000')!
      .trigger('click')
    expect(wrapper.text()).toContain('已选 1000 项')
    await pagination().findAll('button')[1]!.trigger('click')
    expect(
      wrapper
        .findAll('.ai-tagging__candidate input')
        .every((input) => (input.element as HTMLInputElement).checked),
    ).toBe(true)
    await wrapper.get('input[type="search"]').setValue('资源 999')
    expect(wrapper.findAll('.ai-tagging__candidate')).toHaveLength(1)
    expect(wrapper.get('.ai-tagging__candidate strong').text()).toBe('资源 999')
    expect(wrapper.find('nav[aria-label="待识别资源分页"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已选 1000 项')
    await wrapper.get('input[type="search"]').setValue('')
    expect(pagination().text()).toContain('1 / 25 页')
    wrapper.unmount()
  })

  it('打开详情并返回保留审核编辑和焦点，详情期间 Esc 不关闭审核', async () => {
    mocks.recognize.mockResolvedValue({
      suggestions: [
        { resourceId: 'r1', tags: [{ name: '古风', evidence: '服饰明确', level: 'explicit' }] },
      ],
      failures: [],
      errors: [],
      stopped: false,
      usage: { totalTokens: 0, source: 'estimated' },
    })
    const wrapper = mount(AiTaggingPanel, {
      attachTo: document.body,
      props: { resources, categories, initialSelectedIds: ['r1'] },
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('开始识别'))!
      .trigger('click')
    await flushPromises()
    await wrapper.get('button[aria-label="删除建议标签 古风"]').trigger('click')
    await wrapper.get('input[placeholder="手动补充标签"]').setValue('保留的手写标签')
    await wrapper.get('input[type="checkbox"]').setValue(false)
    const detail = wrapper.get('.ai-tagging__detail-link')
    await detail.trigger('click')
    expect(wrapper.emitted('openResource')?.[0]).toEqual([resources[0]])
    await wrapper.setProps({ suspended: true })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(mocks.confirmAction).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    await wrapper.setProps({ suspended: false })
    await flushPromises()
    expect(document.activeElement).toBe(detail.element)
    const handledEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    handledEscape.preventDefault()
    window.dispatchEvent(handledEscape)
    await flushPromises()
    expect(mocks.confirmAction).not.toHaveBeenCalled()
    expect(wrapper.find('.ai-tagging__tag-evidence').exists()).toBe(false)
    expect((wrapper.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(
      (wrapper.get('input[placeholder="手动补充标签"]').element as HTMLInputElement).value,
    ).toBe('保留的手写标签')
    wrapper.unmount()
  })

  it('大批次和超过 200 项选择完整传入识别，非法数量禁用开始', async () => {
    mocks.recognize.mockResolvedValue({
      suggestions: [],
      failures: [],
      errors: [],
      stopped: false,
      usage: { totalTokens: 0, source: 'estimated' },
    })
    const many = Array.from({ length: 205 }, (_, i) => ({ ...resources[0]!, id: `r${i}` }))
    const wrapper = mount(AiTaggingPanel, {
      props: { resources: many, categories, initialSelectedIds: many.map((item) => item.id) },
    })
    const batch = wrapper.get('input[aria-label="每批资源数"]')
    expect(batch.attributes('max')).toBeUndefined()
    const start = wrapper.findAll('button').find((button) => button.text().includes('开始识别'))!
    for (const value of ['', '0', '-1', '1.5']) {
      await batch.setValue(value)
      expect(start.attributes('disabled')).toBeDefined()
    }
    await batch.setValue('1000')
    await start.trigger('click')
    await flushPromises()
    expect(mocks.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 1000, resourceIds: many.map((item) => item.id) }),
    )
    wrapper.unmount()
  })
  it('高级提示词可编辑、保存到草稿和模板，并传入识别请求', async () => {
    mocks.recognize.mockResolvedValue({
      suggestions: [],
      failures: [],
      errors: [],
      stopped: false,
      usage: { totalTokens: 0, source: 'estimated' },
    })
    const wrapper = mount(AiTaggingPanel, {
      props: { resources, categories, initialSelectedIds: ['r1'] },
    })
    const prompt = '自定义完整系统消息，保留 resources JSON 格式。'
    expect(
      (wrapper.get('textarea[aria-label="系统提示词"]').element as HTMLTextAreaElement).value,
    ).toBe(getAiTaggingSystemPrompt())
    await wrapper.get('textarea[aria-label="系统提示词"]').setValue(prompt)
    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: prompt }),
    )
    await wrapper.get('input[placeholder="如：古风剧情卡"]').setValue('测试规范')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '保存当前规范')!
      .trigger('click')
    expect(mocks.saveRuleTemplate).toHaveBeenCalledWith(
      '测试规范',
      expect.any(String),
      'free',
      false,
      prompt,
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('开始识别'))!
      .trigger('click')
    await flushPromises()
    expect(mocks.recognize).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: prompt }))
    wrapper.unmount()
  })

  it('自定义系统提示词不被规范切换覆盖，清空会阻止开始，恢复默认解除', async () => {
    const wrapper = mount(AiTaggingPanel, {
      props: { resources, categories, initialSelectedIds: ['r1'] },
    })
    const editor = wrapper.get('textarea[aria-label="系统提示词"]')
    const taxonomy = wrapper
      .findAll('select')
      .find((select) => select.element.querySelector('option[value="story-resource"]'))!
    await editor.setValue('我的系统提示词')
    await taxonomy.setValue('story-resource')
    expect((editor.element as HTMLTextAreaElement).value).toBe('我的系统提示词')
    await editor.setValue('')
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text().includes('开始识别'))!
        .attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('系统提示词不能为空')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '恢复默认')!
      .trigger('click')
    expect((editor.element as HTMLTextAreaElement).value).toBe(
      getAiTaggingSystemPrompt('story-resource'),
    )
    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ systemPrompt: expect.any(String) }),
    )
    wrapper.unmount()
  })

  it('可按标签状态筛选候选资源', async () => {
    const wrapper = mount(AiTaggingPanel, { props: { resources, categories } })
    await wrapper.get('select[aria-label="标签状态"]').setValue('untagged')

    const queue = wrapper.find('.ai-tagging__candidate-list').text()
    expect(queue).toContain('林间少女')
    expect(queue).not.toContain('都市设定')
    wrapper.unmount()
  })

  it('识别结果必须经过审核页，点击注入后才调用资源 Service', async () => {
    mocks.recognize.mockImplementation(async (options) => {
      options.onProgress?.({ completed: 1, total: 1, batch: 1, batchCount: 1 })
      return {
        suggestions: [
          {
            resourceId: 'r1',
            tags: [
              { name: '单人', evidence: '描述只有一位角色', level: 'explicit' },
              { name: '古风', evidence: '场景使用古代服饰', level: 'inferred' },
            ],
          },
        ],
        failures: [],
        errors: [],
        stopped: false,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'provider' },
      }
    })
    mocks.addTagsPerResource.mockResolvedValue({
      resourceCount: 1,
      tagCount: 2,
      entries: [{ resourceId: 'r1', resourceName: '林间少女', tags: ['单人', '古风'] }],
    })
    const wrapper = mount(AiTaggingPanel, {
      props: { resources, categories, initialSelectedIds: ['r1'] },
    })

    const start = wrapper.findAll('button').find((button) => button.text().includes('开始识别'))
    await start?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('审核 AI 建议')
    expect(wrapper.text()).toContain('单人')
    expect(wrapper.text()).toContain('明确证据')
    expect(wrapper.text()).toContain('合理推断')
    expect(mocks.addTagsPerResource).not.toHaveBeenCalled()

    const apply = wrapper.findAll('button').find((button) => button.text().includes('注入 1 项'))
    await apply?.trigger('click')
    await flushPromises()

    expect(mocks.addTagsPerResource).toHaveBeenCalledWith([
      { resourceId: 'r1', tags: ['单人', '古风'] },
    ])
    expect(wrapper.emitted('applied')).toEqual([
      [{ resourceCount: 1, tagCount: 2, resourceIds: ['r1'], action: 'apply' }],
    ])
    expect(mocks.saveUndo).toHaveBeenCalledOnce()
    expect(mocks.clearDraft).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it.each(['openai-compatible', 'anthropic-compatible'])(
    '临时 API 不继承新地址的 Key，也不偷偷补输出上限（%s）',
    async (protocol) => {
      mocks.recognize.mockResolvedValue({
        suggestions: [],
        failures: [],
        errors: [],
        stopped: false,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 'estimated' },
      })
      const wrapper = mount(AiTaggingPanel, {
        props: { resources, categories, initialSelectedIds: ['r1'] },
      })
      const apiSource = wrapper
        .findAll('select')
        .find((select) => select.element.querySelector('option[value="temporary"]'))
      await apiSource?.setValue('temporary')
      await wrapper.find('.ai-tagging__details-toggle').trigger('click')
      await wrapper
        .findAll('select')
        .find((select) => select.element.querySelector('option[value="anthropic-compatible"]'))!
        .setValue(protocol)
      await wrapper.find('input[type="url"]').setValue('https://another.example/v1')
      const start = wrapper.findAll('button').find((button) => button.text().includes('开始识别'))
      await start?.trigger('click')
      await flushPromises()

      expect(mocks.recognize).toHaveBeenCalledWith(
        expect.objectContaining({
          apiOverride: expect.objectContaining({
            url: 'https://another.example/v1',
            apiKey: '',
            maxTokens: 0,
          }),
        }),
      )
      wrapper.unmount()
    },
  )

  it('显示失败资源并仅重试失败项，成功审核结果继续保留', async () => {
    mocks.recognize
      .mockResolvedValueOnce({
        suggestions: [
          {
            resourceId: 'r1',
            tags: [{ name: '古风', evidence: '服饰明确', level: 'explicit' }],
          },
        ],
        failures: [
          { batch: 2, resourceIds: ['r2'], message: '第 2 批失败：限流', retryable: true },
        ],
        errors: ['第 2 批失败：限流'],
        stopped: false,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'provider' },
      })
      .mockResolvedValueOnce({
        suggestions: [
          {
            resourceId: 'r2',
            tags: [{ name: '都市', evidence: '现代城市设定', level: 'explicit' }],
          },
        ],
        failures: [],
        errors: [],
        stopped: false,
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, source: 'provider' },
      })
    const wrapper = mount(AiTaggingPanel, {
      props: { resources, categories, initialSelectedIds: ['r1', 'r2'] },
    })

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('开始识别'))
      ?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('第 2 批失败：限流')
    expect(wrapper.text()).toContain('都市设定')
    expect(wrapper.text()).toContain('古风')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '返回调整')!
      .trigger('click')
    await wrapper.get('input[aria-label="每批资源数"]').setValue('1')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('仅重试失败项 1'))
      ?.trigger('click')
    await flushPromises()

    expect(mocks.recognize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resourceIds: ['r2'], batchSize: 1 }),
    )
    expect(wrapper.text()).toContain('古风')
    expect(wrapper.text()).toContain('都市')
    expect(wrapper.text()).not.toContain('第 2 批失败：限流')
    wrapper.unmount()
  })

  it('可从本机恢复审核草稿，退出前确认且不恢复临时 Key', async () => {
    mocks.loadDraft.mockReturnValue({
      version: 1,
      savedAt: 100,
      stage: 'review',
      searchQuery: '',
      typeFilter: 'all',
      categoryFilter: 'all',
      tagState: 'all',
      tagQuery: '',
      selectedIds: ['r1'],
      batchSize: 4,
      customPrompt: '草稿提示词',
      systemPrompt: '恢复的完整系统提示词',
      taxonomyTemplateId: 'story-resource',
      mergeAliases: true,
      api: {
        source: 'temporary',
        temporaryProtocol: 'openai-compatible',
        temporaryUrl: 'https://draft.example/v1',
        temporaryModel: 'draft-model',
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
      usageText: '120 Token · 供应商统计',
    })
    const wrapper = mount(AiTaggingPanel, { props: { resources, categories } })
    await flushPromises()

    expect(wrapper.text()).toContain('已恢复本机草稿')
    expect(wrapper.text()).toContain('古风')
    await wrapper.find('.ai-tagging__close').trigger('click')
    await flushPromises()

    expect(mocks.confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: '保存并退出' }),
    )
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: '恢复的完整系统提示词' }),
    )
    expect(mocks.saveDraft.mock.calls.flat().join(' ')).not.toContain('secret')
    wrapper.unmount()
  })

  it('撤销入口只提交上次真实新增标签记录', async () => {
    const additions = [{ resourceId: 'r1', resourceName: '林间少女', tags: ['甜宠'] }]
    mocks.loadUndo.mockReturnValue({ version: 1, appliedAt: 100, additions })
    mocks.undoAddedTags.mockResolvedValue({ resourceCount: 1, tagCount: 1, entries: additions })
    const wrapper = mount(AiTaggingPanel, { props: { resources, categories } })
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('撤销上次 AI 注入'))
      ?.trigger('click')
    await flushPromises()

    expect(mocks.undoAddedTags).toHaveBeenCalledWith(additions)
    expect(mocks.clearUndo).toHaveBeenCalledOnce()
    expect(wrapper.emitted('applied')).toEqual([
      [{ resourceCount: 1, tagCount: 1, resourceIds: ['r1'], action: 'undo' }],
    ])
    wrapper.unmount()
  })
})
