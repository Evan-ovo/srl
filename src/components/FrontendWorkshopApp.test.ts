/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { confirmActionMock, mainApiApi } = vi.hoisted(() => ({
  confirmActionMock: vi.fn(async () => true),
  mainApiApi: {
    getActiveProfile: vi.fn(() => ({ id: 'main', name: '默认接口' })),
    getConfig: vi.fn(() => ({
      protocol: 'openai-compatible',
      url: 'https://example.com/v1/chat/completions',
      apiKey: '',
      model: 'test-model',
      temperature: 0.7,
      topP: 1,
      maxTokens: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      reasoningEffort: 'auto',
    })),
    getProfiles: vi.fn(() => [{ id: 'main', name: '默认接口' }]),
    complete: vi.fn(),
    completeWithUsage: vi.fn(),
  },
}))

vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction: confirmActionMock,
}))

vi.mock('../core/AppContainer', () => ({
  mainApiService: mainApiApi,
  resourceService: {},
}))

import FrontendWorkshopApp from './FrontendWorkshopApp.vue'

function seedPreviewVersion(): void {
  localStorage.setItem(
    'srl.frontendWorkshop.versions.v1',
    JSON.stringify([
      {
        id: 'preview-width-test',
        createdAt: Date.now(),
        source: '姓名：测试角色',
        style: '清晰卡片',
        refinement: '',
        artifact: {
          title: '宽度校样',
          fields: [
            {
              label: '姓名',
              example: '测试角色',
              group: '基础信息',
              kind: 'text',
              path: '姓名',
            },
          ],
          prompt: '按格式输出',
          sampleOutput: '<StatusPlaceHolder>\n姓名: 测试角色\n</StatusPlaceHolder>',
          regex: {
            id: 'preview-width-test',
            scriptName: '宽度校样',
            findRegex: '/<StatusPlaceHolder>[\\s\\S]*?<\\/StatusPlaceHolder>/s',
            replaceString: '<section>$1</section>',
            trimStrings: [],
            placement: [2],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
          },
          styleNote: '',
          dataMode: 'reply',
          interactions: [],
          blocks: [],
          imageUrls: [],
          htmlTemplate: '<section>{{field_1}}</section>',
          compatibility: {
            levelLabel: '纯酒馆',
            dataLabel: '完整状态块',
            persistenceLabel: '每轮输出',
            dependencies: ['SillyTavern 内置正则'],
            verificationNote: '校样',
          },
        },
      },
    ]),
  )
}

function seedConversationRecovery(): void {
  seedPreviewVersion()
  const version = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')[0]
  version.refinement = '把标题改成红色'
  const secondVersion = {
    ...version,
    id: 'preview-width-test-2',
    parentVersionId: version.id,
    refinement: '让卡片间距更紧凑',
    artifact: { ...version.artifact, title: '紧凑校样' },
  }
  localStorage.setItem(
    'srl.frontendWorkshop.recovery.v1',
    JSON.stringify({
      id: 'conversation-recovery',
      name: '对话删除测试',
      updatedAt: Date.now(),
      activeStep: 'proof',
      source: '姓名：测试角色',
      style: '清晰卡片',
      dataMode: 'reply',
      interactions: [],
      refinement: '',
      referenceGuidance: '',
      versions: [version, secondVersion],
      currentIndex: 1,
      conversation: [
        {
          id: 'chat-user',
          versionId: version.id,
          role: 'user',
          content: '把标题改成红色',
          createdAt: Date.now(),
        },
        {
          id: 'chat-assistant',
          versionId: version.id,
          role: 'assistant',
          content: '已经修改',
          createdAt: Date.now(),
        },
        {
          id: 'chat-user-2',
          versionId: secondVersion.id,
          role: 'user',
          content: '让卡片间距更紧凑',
          createdAt: Date.now(),
        },
        {
          id: 'chat-assistant-2',
          versionId: secondVersion.id,
          role: 'assistant',
          content: '已经调整间距',
          createdAt: Date.now(),
        },
      ],
    }),
  )
}

describe('FrontendWorkshopApp', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mainApiApi.completeWithUsage.mockReset()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })

  it('把移动端设计阶段拆成内容、外观、生成三个短面板', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const tabs = wrapper.findAll('.frontend-workshop__design-tabs button')
    expect(tabs.map((button) => button.text())).toEqual(['01内容', '02外观', '03生成'])
    expect(wrapper.get('[data-design-panel="content"]').classes()).toContain('is-active')
    expect(wrapper.get('[data-design-panel="appearance"]').classes()).not.toContain('is-active')

    await tabs[1]!.trigger('click')
    expect(wrapper.get('[data-design-panel="content"]').classes()).not.toContain('is-active')
    expect(wrapper.get('[data-design-panel="appearance"]').classes()).toContain('is-active')

    await tabs[2]!.trigger('click')
    expect(wrapper.get('[data-design-panel="generate"]').classes()).toContain('is-active')
    wrapper.unmount()
  })
  it('自定义 API 输出上限默认留空，填写和清空沿原偏好保存', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: { stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true } },
    })
    const panel = wrapper.get('[data-design-panel="generate"]')
    const apiMode = panel.get<HTMLSelectElement>('.frontend-workshop__api-body > label select')
    const previousMode = apiMode.element.value
    try {
      await panel.get('.frontend-workshop__api-body > label select').setValue('custom')
      const field = panel.get<HTMLInputElement>('input[placeholder="留空不限制"]')
      expect(field.element.value).toBe('')
      expect(field.attributes('max')).toBeUndefined()
      const save = () => panel.findAll('button').find((button) => button.text() === '保存选择')!
      await field.setValue('1000000')
      await save().trigger('click')
      await vi.waitFor(() =>
        expect(
          JSON.parse(localStorage.getItem('srl.frontendWorkshop.api.v1')!).custom.maxTokens,
        ).toBe(1000000),
      )
      await field.setValue('')
      await save().trigger('click')
      await vi.waitFor(() =>
        expect(
          JSON.parse(localStorage.getItem('srl.frontendWorkshop.api.v1')!).custom.maxTokens,
        ).toBe(0),
      )
      expect(field.element.value).toBe('')
    } finally {
      await apiMode.setValue(previousMode)
      await panel
        .findAll('button')
        .find((button) => button.text() === '保存选择')!
        .trigger('click')
      await vi.waitFor(() =>
        expect(JSON.parse(localStorage.getItem('srl.frontendWorkshop.api.v1')!).mode).toBe(
          previousMode,
        ),
      )
      wrapper.unmount()
    }
  })

  it('字段输入可在文本与可视表格间切换并写回同一份契约', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const modeButtons = wrapper.get('[role="group"][aria-label="字段输入方式"]').findAll('button')
    await modeButtons[1]!.trigger('click')
    expect(
      wrapper.get('.frontend-workshop__field-editor').attributes('data-field-input-mode'),
    ).toBe('visual')
    expect(wrapper.findAll('.frontend-workshop__field-table > article')).toHaveLength(4)

    const firstName = wrapper.get('.frontend-workshop__field-table > article input')
    await firstName.setValue('人物')
    await firstName.trigger('change')
    await wrapper.get('.frontend-workshop__field-add').trigger('click')
    expect(wrapper.findAll('.frontend-workshop__field-table > article')).toHaveLength(5)

    await modeButtons[0]!.trigger('click')
    const sourceInput = wrapper.get<HTMLTextAreaElement>(
      '.frontend-workshop__field-editor textarea',
    )
    expect(sourceInput.element.value).toContain('人物')
    expect(sourceInput.element.value).toContain('新字段5[文本]：待填写')
    wrapper.unmount()
  })

  it('自动保留未完成内容并在再次进入时恢复', async () => {
    const first = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await first.findAll('textarea')[0]!.setValue('姓名：未完成角色\n状态：填写到一半')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('srl.frontendWorkshop.recovery.v1')).toContain('填写到一半')
    first.unmount()

    const restored = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    await restored.vm.$nextTick()
    expect((restored.findAll('textarea')[0]!.element as HTMLTextAreaElement).value).toContain(
      '填写到一半',
    )
    await restored.get('.frontend-workshop__drafts summary').trigger('click')
    expect(restored.get('.frontend-workshop__draft-protection').text()).toContain(
      '已恢复上次未完成的内容',
    )
    restored.unmount()
  })

  it('退出前保存命名草稿，保存成功后才离开', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    await wrapper.findAll('textarea')[0]!.setValue('姓名：退出保护测试')
    await wrapper.get('.feature-app-header__back').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('back')).toHaveLength(1))

    expect(confirmActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '退出前保存草稿？',
        confirmLabel: '保存并退出',
      }),
    )
    expect(localStorage.getItem('srl.frontendWorkshop.drafts.v1')).toContain('退出保护测试')
    expect(localStorage.getItem('srl.frontendWorkshop.recovery.v1')).toBeNull()
    wrapper.unmount()
  })

  it('命名草稿写入失败时留在页面并保留自动恢复内容', async () => {
    const originalSetItem = Storage.prototype.setItem
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === 'srl.frontendWorkshop.drafts.v1') {
        throw new DOMException('quota', 'QuotaExceededError')
      }
      return originalSetItem.call(this, key, value)
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    try {
      await wrapper.findAll('textarea')[0]!.setValue('姓名：不能丢失')
      await wrapper.get('.feature-app-header__back').trigger('click')
      await vi.waitFor(() => expect(wrapper.text()).toContain('草稿空间已满'))

      expect(wrapper.emitted('back')).toBeUndefined()
      expect(localStorage.getItem('srl.frontendWorkshop.recovery.v1')).toContain('不能丢失')
    } finally {
      storageSpy.mockRestore()
      wrapper.unmount()
    }
  })

  it('不保存退出会二次确认并清除自动恢复内容', async () => {
    confirmActionMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    await wrapper.findAll('textarea')[0]!.setValue('姓名：明确放弃')
    await wrapper.get('.feature-app-header__back').trigger('click')
    await vi.waitFor(() => expect(wrapper.emitted('back')).toHaveLength(1))

    expect(confirmActionMock).toHaveBeenCalledTimes(2)
    expect(confirmActionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '不保存命名草稿？',
        confirmLabel: '不保存并退出',
      }),
    )
    expect(localStorage.getItem('srl.frontendWorkshop.recovery.v1')).toBeNull()
    wrapper.unmount()
  })

  it('提供字体角色、用户字体直链和自定义文字样式', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const tabs = wrapper.findAll('.frontend-workshop__design-tabs button')
    await tabs[1]!.trigger('click')
    const typographySelects = wrapper.findAll('.frontend-workshop__type-pickers select')
    expect(typographySelects).toHaveLength(2)
    expect(typographySelects[0]!.text()).toContain('宋体档案')
    expect(typographySelects[1]!.text()).toContain('现代黑体')
    await typographySelects[0]!.setValue('custom')
    expect(wrapper.get('.frontend-workshop__type-pickers input').attributes('inputmode')).toBe(
      'url',
    )

    await wrapper.get('.frontend-workshop__text-styles summary').trigger('click')
    await wrapper.get('.frontend-workshop__text-style-add input').setValue('小字')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    wrapper.get('.frontend-workshop__text-style-add input').element.dispatchEvent(composing)
    expect(wrapper.find('.frontend-workshop__text-styles article').exists()).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    await wrapper.get('.frontend-workshop__text-style-add button').trigger('click')
    expect(wrapper.get('.frontend-workshop__text-styles article').text()).toContain('小字')

    const fontScope = wrapper
      .findAll('.frontend-workshop__scope-chips button')
      .find((button) => button.text() === '字体')
    expect(fontScope).toBeDefined()
    await fontScope!.trigger('click')
    expect(fontScope!.classes()).toContain('is-active')
    wrapper.unmount()
  })

  it('提供可不选的经典配色和色卡导入入口', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    expect(wrapper.get('.frontend-workshop__palettes').text()).toContain('不限定配色')
    expect(wrapper.get('.frontend-workshop__palettes').text()).toContain('墨玉纸页')
    expect(wrapper.get('.frontend-workshop__palettes input').attributes('accept')).toContain('.gpl')
    expect(wrapper.findAll('.frontend-workshop__palette-strip > article')).toHaveLength(6)
    wrapper.unmount()
  })

  it('材质与精细度使用站内按钮并在更新后恢复移动页面位置', async () => {
    const scrollTo = vi.mocked(window.scrollTo)
    const animationFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0)
        return 1
      })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    await wrapper.get('.frontend-workshop__design-tokens summary').trigger('click')
    const materialButtons = wrapper.findAll(
      '.frontend-workshop__design-tokens fieldset:first-child > button',
    )
    expect(materialButtons.length).toBeGreaterThan(2)
    expect(wrapper.find('.frontend-workshop__design-tokens input[type="radio"]').exists()).toBe(
      false,
    )

    await materialButtons[2]!.trigger('click')
    await wrapper.vm.$nextTick()
    expect(materialButtons[2]!.attributes('aria-pressed')).toBe('true')
    expect(scrollTo).toHaveBeenCalledWith(window.scrollX, window.scrollY)

    animationFrame.mockRestore()
    wrapper.unmount()
  })

  it('可编辑三组功能提示，生成前查看完整消息并随版本回看', async () => {
    mainApiApi.completeWithUsage.mockResolvedValueOnce({
      text: '<SRL_META>{"title":"提示词校样"}</SRL_META><SRL_TEMPLATE><style>.card{display:grid;background:#f5efe2 repeating-linear-gradient(45deg,transparent 0 2px,rgba(0,0,0,.03) 2px 3px)}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>',
      usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, source: 'provider' },
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    const editors = wrapper.findAll('.frontend-workshop__module-prompt textarea')
    expect(editors).toHaveLength(3)
    await editors[0]!.setValue('材质要有纸张压纹')
    await editors[1]!.setValue('条件激活只改标题')
    await editors[2]!.setValue('积木使用非对称排版')
    await wrapper.findAll('.frontend-workshop__design-tabs button')[2]!.trigger('click')

    const fullPrompt = wrapper.get('.frontend-workshop__full-prompt')
    expect(fullPrompt.text()).toContain('材质要有纸张压纹')
    expect(fullPrompt.text()).toContain('条件激活只改标题')
    expect(fullPrompt.text()).toContain('积木使用非对称排版')

    await wrapper.get('.frontend-workshop__generate').trigger('click')
    await vi.waitFor(() => expect(mainApiApi.completeWithUsage).toHaveBeenCalledTimes(1))
    expect(mainApiApi.completeWithUsage.mock.calls[0]?.[0]?.[0]?.content).toContain(
      '材质要有纸张压纹',
    )
    await vi.waitFor(() =>
      expect(wrapper.find('.frontend-workshop__prompt-history').exists()).toBe(true),
    )
    expect(wrapper.get('.frontend-workshop__prompt-history').text()).toContain('材质要有纸张压纹')
    wrapper.unmount()
  })

  it('三组功能提示词可关闭，关闭后不进入完整提示词和实际请求', async () => {
    mainApiApi.completeWithUsage.mockResolvedValueOnce({
      text: '<SRL_META>{"title":"自由提示"}</SRL_META><SRL_TEMPLATE><style>.card{display:grid}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'provider' },
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    await wrapper.get<HTMLButtonElement>('[data-block-id="relationship-card"]').trigger('click')
    const modules = wrapper.findAll('.frontend-workshop__module-prompt')
    const editors = wrapper.findAll('.frontend-workshop__module-prompt textarea')
    await editors[0]!.setValue('材质关闭时不应进入请求')
    await editors[1]!.setValue('条件关闭时不应进入请求')
    await editors[2]!.setValue('积木关闭时不应进入请求')
    for (const modulePrompt of modules) {
      await modulePrompt.get('input[type="checkbox"]').setValue(false)
    }
    await wrapper.findAll('.frontend-workshop__design-tabs button')[2]!.trigger('click')

    const fullPrompt = wrapper.get('.frontend-workshop__full-prompt')
    expect(fullPrompt.text()).toContain('材质与精细度提示词已关闭')
    expect(fullPrompt.text()).toContain('条件样式提示词已关闭')
    expect(fullPrompt.text()).toContain('组件积木提示词已关闭')
    expect(fullPrompt.text()).not.toContain('材质关闭时不应进入请求')
    expect(fullPrompt.text()).not.toContain('data-srl-block="relationship-card"')

    await wrapper.get('.frontend-workshop__generate').trigger('click')
    await vi.waitFor(() => expect(mainApiApi.completeWithUsage).toHaveBeenCalledTimes(1))
    const systemPrompt = mainApiApi.completeWithUsage.mock.calls[0]?.[0]?.[0]?.content
    expect(systemPrompt).toContain('组件积木提示词已关闭')
    expect(systemPrompt).not.toContain('积木关闭时不应进入请求')
    expect(systemPrompt).not.toContain('data-srl-block="relationship-card"')
    wrapper.unmount()
  })

  it('参考图补充说明使用独立的窄屏收缩输入框', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    const guidance = wrapper.get('.frontend-workshop__reference-guidance')
    expect(guidance.attributes('placeholder')).toContain('字体只参考笔画气质')
    expect(guidance.element.tagName).toBe('INPUT')
    wrapper.unmount()
  })

  it('用八张静态微型样板解释组件积木并保留稳定内部 ID', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    expect(wrapper.get('.frontend-workshop__blocks').text()).toContain('组件积木')
    const cards = wrapper.findAll<HTMLButtonElement>('[data-block-id]')
    expect(cards).toHaveLength(8)
    expect(cards.map((card) => card.attributes('data-block-id'))).toEqual([
      'character-header',
      'attribute-grid',
      'relationship-card',
      'inventory',
      'quest-timeline',
      'character-tabs',
      'long-collapse',
      'image-banner',
    ])
    expect(
      cards.map((card) => card.get('.frontend-workshop__block-heading strong').text()),
    ).toEqual([
      '人物名片',
      '并排数值区',
      '关系与好感',
      '分类背包',
      '剧情进度',
      '队伍成员切换',
      '收起次要内容',
      '顶部视觉图',
    ])
    expect(wrapper.findAll('[data-block-preview]')).toHaveLength(8)
    expect(
      wrapper
        .findAll('[data-block-preview]')
        .map((preview) => preview.attributes('data-block-preview')),
    ).toEqual(cards.map((card) => card.attributes('data-block-id')))

    const characterTabs = wrapper.get<HTMLButtonElement>('[data-block-id="character-tabs"]')
    expect(characterTabs.attributes('aria-pressed')).toBe('false')
    await characterTabs.trigger('click')
    expect(characterTabs.attributes('aria-pressed')).toBe('true')
    expect(characterTabs.get('.frontend-workshop__block-selected').text()).toBe('已加入')
    expect(characterTabs.text()).toContain('点击移除')

    const tabsInteraction = wrapper
      .findAll('.frontend-workshop__interaction-grid button')
      .find((button) => button.text().includes('分组分页'))
    expect(tabsInteraction?.attributes('aria-pressed')).toBe('true')

    await wrapper.get<HTMLButtonElement>('[data-block-id="long-collapse"]').trigger('click')
    const collapseInteraction = wrapper
      .findAll('.frontend-workshop__interaction-grid button')
      .find((button) => button.text().includes('折叠分组'))
    expect(collapseInteraction?.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.frontend-workshop__image-urls').text()).toContain('成品图片直链')
    expect(wrapper.get('.frontend-workshop__image-urls input').attributes('inputmode')).toBe('url')
    const imageInput = wrapper.get('.frontend-workshop__image-urls input')
    await imageInput.setValue('https://example.com/图片.png')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    imageInput.element.dispatchEvent(composing)
    expect(wrapper.find('.frontend-workshop__image-urls li').exists()).toBe(false)
    expect(composing.defaultPrevented).toBe(false)
    await imageInput.trigger('keydown', { key: 'Enter' })
    expect(wrapper.get('.frontend-workshop__image-urls li').text()).toContain(
      new URL('https://example.com/图片.png').href,
    )
    wrapper.unmount()
  })

  it('场景模板会建立状态栏骨架并即时给出移动端复杂度', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    const scenes = wrapper.findAll<HTMLButtonElement>('[data-scene-id]')
    expect(scenes.map((scene) => scene.text())).toEqual(
      expect.arrayContaining([
        expect.stringContaining('人物档案'),
        expect.stringContaining('剧情进度'),
        expect.stringContaining('队伍状态'),
        expect.stringContaining('物品与关系'),
      ]),
    )
    await wrapper.get<HTMLButtonElement>('[data-scene-id="story"]').trigger('click')
    expect(
      wrapper.get<HTMLButtonElement>('[data-block-id="quest-timeline"]').attributes('aria-pressed'),
    ).toBe('true')
    expect(
      wrapper.get<HTMLButtonElement>('[data-block-id="long-collapse"]').attributes('aria-pressed'),
    ).toBe('true')
    expect(wrapper.get('.frontend-workshop__block-blueprint').text()).toContain('状态栏骨架')
    expect(wrapper.get('.frontend-workshop__block-blueprint').text()).toContain('剧情进度')
    expect(wrapper.get('.frontend-workshop__block-blueprint').text()).toContain('移动端复杂度')
    wrapper.unmount()
  })

  it('长按进入多选后可一次删除多轮对话，并让后续 AI 不再继承这些要求', async () => {
    seedConversationRecovery()
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    await wrapper.vm.$nextTick()
    const messages = wrapper.findAll('.frontend-workshop__conversation > div p')
    expect(messages).toHaveLength(4)
    expect(messages[0]!.attributes('aria-label')).toContain('长按')

    vi.useFakeTimers()
    messages[0]!.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 8 }),
    )
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    vi.useRealTimers()

    expect(confirmActionMock).not.toHaveBeenCalled()
    expect(wrapper.get('.frontend-workshop__conversation-toolbar').text()).toContain('已选 1 轮')
    await wrapper.findAll('.frontend-workshop__conversation > div p')[2]!.trigger('click')
    expect(wrapper.get('.frontend-workshop__conversation-toolbar').text()).toContain('已选 2 轮')
    const deleteButton = wrapper.get<HTMLButtonElement>('.frontend-workshop__conversation-delete')
    expect(deleteButton.attributes('disabled')).toBeUndefined()
    deleteButton.element.click()
    await wrapper.vm.$nextTick()
    await vi.waitFor(() =>
      expect(confirmActionMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: '删除选中的 2 轮对话？' }),
      ),
    )
    expect(wrapper.findAll('.frontend-workshop__conversation > div p')).toHaveLength(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem('srl.frontendWorkshop.recovery.v1')).toContain(
      'excludedConversationVersionIds',
    )
    wrapper.unmount()
  })

  it('让 AI 审视当前校样，选择并编辑建议后写入下一轮要求', async () => {
    seedPreviewVersion()
    mainApiApi.completeWithUsage.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          category: 'layout',
          title: '收紧首屏层级',
          detail: '减少标题与数值之间的空白，让手机首屏看到核心状态。',
        },
        {
          category: 'motion',
          title: '收敛动效',
          detail: '只在数值更新时使用一次性短动效。',
        },
      ]),
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, source: 'provider' },
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.get('.frontend-workshop__review-start').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.findAll('.frontend-workshop__review-suggestion')).toHaveLength(2),
    )
    const suggestions = wrapper.findAll('.frontend-workshop__review-suggestion')
    await suggestions[0]!.get('input[type="checkbox"]').setValue(true)
    await suggestions[0]!.get('textarea').setValue('手机首屏优先保留名称和核心数值。')
    expect(suggestions[0]!.classes()).toContain('is-selected')
    expect(suggestions[0]!.get('.frontend-workshop__review-selection').text()).toBe('已选')
    expect(wrapper.get('.frontend-workshop__review-apply').text()).toContain('已选 1 条')
    await wrapper.get('.frontend-workshop__review-apply').trigger('click')

    expect(
      (wrapper.get('.frontend-workshop__refine textarea').element as HTMLTextAreaElement).value,
    ).toContain('手机首屏优先保留名称和核心数值。')
    expect(wrapper.get('.frontend-workshop__review-apply').text()).toContain('已写入 1 条')
    const appliedValue = (
      wrapper.get('.frontend-workshop__refine textarea').element as HTMLTextAreaElement
    ).value
    await wrapper.get('.frontend-workshop__review-apply').trigger('click')
    expect(
      (wrapper.get('.frontend-workshop__refine textarea').element as HTMLTextAreaElement).value,
    ).toBe(appliedValue)
    expect(wrapper.get('.frontend-workshop__review-prompt').text()).toContain('当前状态栏模板')
    wrapper.unmount()
  })

  it('常驻 AI 对话入口会打开可发送下一版的对话抽屉', async () => {
    seedPreviewVersion()
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.get('.frontend-workshop__conversation-launcher').trigger('click')

    expect(wrapper.get('.frontend-workshop__conversation-dialog').text()).toContain(
      '和 AI 继续调整',
    )
    expect(wrapper.get('.frontend-workshop__conversation-dialog-refine button').text()).toContain(
      '发送并生成下一版',
    )
    await wrapper
      .get('.frontend-workshop__conversation-dialog button[aria-label="关闭 AI 对话"]')
      .trigger('click')
    expect(wrapper.find('.frontend-workshop__conversation-dialog').exists()).toBe(false)
    wrapper.unmount()
  })

  it('只清理历史版本中重复的已选审美建议', async () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    const repeatedRequirement = '【已选审美建议】\n1. 收紧标题留白\n【已选审美建议结束】'
    versions[0].refinement = repeatedRequirement
    versions.push({
      ...versions[0],
      id: 'review-duplicate',
      parentVersionId: versions[0].id,
      refinement: repeatedRequirement,
      promptSnapshot: {
        createdAt: Date.now(),
        messages: [
          {
            role: 'user',
            label: '本轮用户提示词',
            content: `${repeatedRequirement}\n${repeatedRequirement}`,
          },
        ],
      },
    })
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))
    const storedDraft = {
      id: 'stored-review-draft',
      name: '旧草稿',
      updatedAt: Date.now(),
      source: '姓名：测试角色',
      style: '清爽卡片',
      dataMode: 'reply',
      interactions: [],
      refinement: repeatedRequirement,
      referenceGuidance: '',
      versions: versions.map((version: Record<string, unknown>) => ({ ...version })),
      currentIndex: 1,
      conversation: [],
    }
    localStorage.setItem('srl.frontendWorkshop.drafts.v1', JSON.stringify([storedDraft]))
    localStorage.setItem('srl.frontendWorkshop.recovery.v1', JSON.stringify(storedDraft))
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.get('.frontend-workshop__review-cleanup').trigger('click')

    const saved = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    expect(saved.map((version: { refinement: string }) => version.refinement)).toEqual([
      repeatedRequirement,
      '',
    ])
    expect(saved[1].promptSnapshot.messages[0]).toMatchObject({
      label: '本轮用户提示词（已去重展示）',
      content: repeatedRequirement,
      originalContent: `${repeatedRequirement}\n${repeatedRequirement}`,
    })
    const savedDraft = JSON.parse(localStorage.getItem('srl.frontendWorkshop.drafts.v1') ?? '[]')[0]
    const recoveryDraft = JSON.parse(
      localStorage.getItem('srl.frontendWorkshop.recovery.v1') ?? '{}',
    )
    expect(savedDraft.refinement).toBe(repeatedRequirement)
    expect(savedDraft.versions[1].refinement).toBe('')
    expect(recoveryDraft.versions[1].refinement).toBe('')
    wrapper.unmount()
  })

  it('清理已经展开为普通文本的重复审美建议区块', async () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    const intro = '请在保持未提及区域不变的前提下，执行以下已选审美建议：'
    const advice = '1. [排版] 为标题增加留白\n2. [动效] 只保留短动效'
    const repeated = `${advice}\n\n${intro}\n${advice}\n\n${intro}\n${advice}\n\n${intro}\n${advice}`
    versions[0].refinement = repeated
    versions[0].promptSnapshot = {
      createdAt: Date.now(),
      messages: [{ role: 'user', label: '本轮用户提示词', content: repeated }],
    }
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper.get('.frontend-workshop__review-cleanup').trigger('click')

    const saved = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')[0]
    const expected = `${intro}\n${advice}`
    expect(saved.refinement).toBe(expected)
    expect(saved.promptSnapshot.messages[0].content).toBe(expected)
    wrapper.unmount()
  })

  it('生成下一版时会在实际请求中合并历史与本轮重复建议', async () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    const intro = '请在保持未提及区域不变的前提下，执行以下已选审美建议：'
    const advice = '1. [排版] 为标题增加留白\n2. [动效] 只保留短动效'
    const repeated = `${advice}\n\n${intro}\n${advice}\n\n${intro}\n${advice}`
    versions[0].refinement = repeated
    versions.push({
      ...versions[0],
      id: 'runtime-review-duplicate',
      parentVersionId: versions[0].id,
      refinement: repeated,
    })
    versions.push({
      ...versions[1],
      id: 'runtime-review-current',
      parentVersionId: versions[1].id,
      refinement: '',
    })
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))
    mainApiApi.completeWithUsage.mockResolvedValueOnce({
      text: '<SRL_META>{"title":"去重校样"}</SRL_META><SRL_TEMPLATE><style>.card{display:grid}</style><section class="card">{{field_1}}</section></SRL_TEMPLATE>',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'provider' },
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })

    await wrapper
      .findAll('.frontend-workshop__steps button')
      .find((button) => button.text() === '预览')!
      .trigger('click')
    await wrapper.get('.frontend-workshop__refine textarea').setValue(repeated)
    await wrapper.get('.frontend-workshop__refine button').trigger('click')

    await vi.waitFor(() => expect(mainApiApi.completeWithUsage).toHaveBeenCalledTimes(1))
    const userPrompt = String(mainApiApi.completeWithUsage.mock.calls[0]?.[0]?.[1]?.content ?? '')
    expect(userPrompt.split(intro)).toHaveLength(2)
    expect(userPrompt.split(advice)).toHaveLength(2)
    await vi.waitFor(() =>
      expect(localStorage.getItem('srl.frontendWorkshop.conversation.v1')).toContain(
        '1. [排版] 为标题增加留白',
      ),
    )
    wrapper.unmount()
    localStorage.removeItem('srl.frontendWorkshop.recovery.v1')

    const reopened = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })
    await reopened.get('.frontend-workshop__conversation-launcher').trigger('click')
    expect(reopened.get('.frontend-workshop__conversation-dialog').text()).toContain(
      '1. [排版] 为标题增加留白',
    )
    reopened.unmount()
  })

  it('下一版发送失败时在预览步骤就地显示请求阶段、原始原因和处理建议', async () => {
    seedPreviewVersion()
    mainApiApi.completeWithUsage.mockRejectedValueOnce(
      new Error('API 返回 429：rate limit exceeded'),
    )
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: true },
      },
    })
    await wrapper
      .findAll('.frontend-workshop__steps button')
      .find((button) => button.text() === '预览')!
      .trigger('click')
    await wrapper.get('.frontend-workshop__refine textarea').setValue('增加纸张颗粒纹理')
    await wrapper.get('.frontend-workshop__refine button').trigger('click')

    await vi.waitFor(() =>
      expect(wrapper.find('.frontend-workshop__generation-failure').exists()).toBe(true),
    )
    const failure = wrapper.get('.frontend-workshop__generation-failure')
    expect(failure.text()).toContain('下一版没有生成')
    expect(failure.text()).toContain('API 返回 429')
    expect(failure.text()).toContain('请求频率或额度')
    expect(failure.text()).toContain('默认接口')
    expect(wrapper.get('.frontend-workshop__version-controls').text()).toContain('V1 / 1')
    wrapper.unmount()
  })

  it('从外观面板进入全屏自由排版并保存构图参考', async () => {
    const wrapper = mount(FrontendWorkshopApp, {
      attachTo: document.body,
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[1]!.trigger('click')
    await wrapper.get('.frontend-workshop__layout-reference button').trigger('click')
    expect(wrapper.get('.layout-studio').attributes('aria-modal')).toBe('true')
    expect(wrapper.findAll('.layout-studio__canvas > article')).toHaveLength(4)
    await wrapper.get('.layout-studio > header button.is-primary').trigger('click')
    expect(wrapper.find('.layout-studio').exists()).toBe(false)
    expect(wrapper.get('.frontend-workshop__layout-reference').text()).toContain('已保存 4 个对象')

    await wrapper
      .findAll('.frontend-workshop__layout-reference-actions button')
      .find((button) => button.text() === '取消参考')!
      .trigger('click')
    expect(confirmActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '取消自由排版参考？' }),
    )
    expect(wrapper.get('.frontend-workshop__layout-reference').text()).not.toContain(
      '已保存 4 个对象',
    )
    expect(wrapper.findAll('.frontend-workshop__layout-reference-actions button')).toHaveLength(1)
    wrapper.unmount()
  })

  it('第一次 AI 输出漏字段时自动带错误修复一次', async () => {
    mainApiApi.completeWithUsage
      .mockResolvedValueOnce({
        text: '<SRL_META>{"title":"漏项版"}</SRL_META><SRL_TEMPLATE><section>{{field_1}}</section></SRL_TEMPLATE>',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          source: 'provider',
        },
      })
      .mockResolvedValueOnce({
        text: '<SRL_META>{"title":"修复版"}</SRL_META><SRL_TEMPLATE><style>.card{display:grid}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>',
        usage: {
          inputTokens: 120,
          outputTokens: 60,
          totalTokens: 180,
          source: 'provider',
        },
      })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[2]!.trigger('click')
    await wrapper.get('.frontend-workshop__generate').trigger('click')
    await vi.waitFor(() => expect(mainApiApi.completeWithUsage).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(wrapper.get('.frontend-workshop__generation-notice').text()).toContain('已自动修复'),
    )
    expect(wrapper.get('.frontend-workshop__version-controls').text()).toContain('V1 / 1')
    const initialMessages = mainApiApi.completeWithUsage.mock.calls[0]?.[0]
    expect(initialMessages?.[0]?.content).toContain('不能只完成其中容易的一半')
    expect(initialMessages?.[1]?.content).toContain('【本轮最高优先级风格要求｜用户原话】')
    expect(initialMessages?.[1]?.content).toContain('不允许只完成一半')
    const repairMessage = mainApiApi.completeWithUsage.mock.calls[1]?.[0]?.at(-1)?.content
    const repairSystemPrompt = mainApiApi.completeWithUsage.mock.calls[1]?.[0]?.[0]?.content
    expect(repairMessage).toContain('请一次性修复下面列出的全部问题')
    expect(repairMessage).toContain('漏掉了第 2 个字段')
    expect(repairMessage).toContain('漏掉了第 3 个字段')
    expect(repairMessage).toContain('AI 返回的模板缺少内联 <style>')
    expect(repairMessage).toContain('【当前完整模板或原始输出】')
    expect(repairMessage).toContain('修复优先级')
    expect(repairSystemPrompt).toContain('静态状态栏的格式修复器')
    expect(repairSystemPrompt).toContain('<SRL_META>{"title":"修复后的状态栏"')
    expect(repairSystemPrompt).toContain('禁止 http:、data:、blob:、file:、ftp: 和 base64')
    expect(repairSystemPrompt).toContain('每条 CSS 选择器必须在最终 DOM 有真实目标')
    expect(mainApiApi.completeWithUsage.mock.calls[1]?.[0]).toHaveLength(2)
    expect(mainApiApi.completeWithUsage.mock.calls[0]?.[2]).toEqual({ timeoutMs: null })
    expect(mainApiApi.completeWithUsage.mock.calls[1]?.[2]).toEqual({ timeoutMs: null })
    expect(mainApiApi.completeWithUsage.mock.calls[1]?.[1]).toMatchObject({
      temperature: 0.2,
      topP: 1,
    })
    expect(wrapper.get('.frontend-workshop__prompt-history').text()).toContain('自动修复紧凑协议')
    wrapper.unmount()
  })

  it('两次 AI 输出未通过校验时允许手动修复并按同一规则重新验收', async () => {
    const incomplete =
      '<SRL_META>{"title":"待修复版"}</SRL_META><SRL_TEMPLATE><style>.bad{display:block}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>'
    const fixed =
      '<SRL_META>{"title":"手动修复版"}</SRL_META><SRL_TEMPLATE><style>.card{display:block}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>'
    mainApiApi.completeWithUsage
      .mockResolvedValueOnce({
        text: incomplete,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'provider' },
      })
      .mockResolvedValueOnce({
        text: incomplete,
        usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, source: 'provider' },
      })
    const wrapper = mount(FrontendWorkshopApp, {
      attachTo: document.body,
      global: { stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: false } },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[2]!.trigger('click')
    await wrapper.get('.frontend-workshop__generate').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.get('.frontend-workshop__manual-repair-open').text()).toContain('手动修复'),
    )
    await wrapper.get('.frontend-workshop__manual-repair-open').trigger('click')
    const dialog = document.querySelector<HTMLElement>('.frontend-workshop__manual-repair-dialog')!
    expect(dialog.textContent).toContain('待修复位置')
    expect(dialog.querySelector('.frontend-workshop__manual-repair-issues')).not.toBeNull()
    expect(
      dialog.querySelector('.frontend-workshop__manual-repair-code .is-error')?.textContent,
    ).toContain('.bad')
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '查看常见错误修复')!
      .click()
    await wrapper.vm.$nextTick()
    const guide = document.querySelector<HTMLElement>('.frontend-workshop__manual-repair-guide')!
    expect(guide.textContent).toContain('主题开关：checkbox 与对应 label 必须紧邻')
    expect(guide.textContent).toContain('data:image/svg+xml,...')
    ;[...guide.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '我知道了，继续修改代码')!
      .click()
    await wrapper.vm.$nextTick()
    expect(document.querySelector('.frontend-workshop__manual-repair-guide')).toBeNull()
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = fixed
    textarea.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    ;[...dialog.querySelectorAll<HTMLButtonElement>('footer button')]
      .find((button) => button.textContent?.trim() === '重新验证并保存')!
      .click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('.frontend-workshop__manual-repair-dialog')).toBeNull()
    expect(wrapper.get('.frontend-workshop__version-controls').text()).toContain('V1 / 1')
    expect(wrapper.get('.frontend-workshop__generation-notice').text()).toContain('手动修复')
    wrapper.unmount()
  })

  it('首轮输出缺少双分区时仍会把原始输出交给自动修复', async () => {
    const malformed = '{"title":"错误输出"}\n{"note":"多余 JSON 对象"}'
    const fixed =
      '<SRL_META>{"title":"协议修复版"}</SRL_META><SRL_TEMPLATE><style>.card{display:block}</style><section class="card"><b>{{field_1}}</b><i>{{field_2}}</i><span>{{field_3}}</span><em>{{field_4}}</em></section></SRL_TEMPLATE>'
    mainApiApi.completeWithUsage
      .mockResolvedValueOnce({
        text: malformed,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, source: 'provider' },
      })
      .mockResolvedValueOnce({
        text: fixed,
        usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, source: 'provider' },
      })
    const wrapper = mount(FrontendWorkshopApp, {
      global: { stubs: { InlineModelPicker: true, RichContentPreview: true, Teleport: false } },
    })

    await wrapper.findAll('.frontend-workshop__design-tabs button')[2]!.trigger('click')
    await wrapper.get('.frontend-workshop__generate').trigger('click')
    await vi.waitFor(() => expect(mainApiApi.completeWithUsage).toHaveBeenCalledTimes(2))

    expect(wrapper.get('.frontend-workshop__version-controls').text()).toContain('V1 / 1')
    wrapper.unmount()
  })

  it('可以多选删除本机状态栏校样版本', async () => {
    const makeVersion = (id: string, title: string) => ({
      id,
      createdAt: Date.now(),
      source: '姓名：林言',
      style: '档案风',
      refinement: '',
      artifact: {
        title,
        fields: [
          {
            label: '姓名',
            example: '林言',
            group: '基础信息',
            kind: 'text',
            path: '姓名',
          },
        ],
        prompt: '提示',
        sampleOutput: '<StatusPlaceHolder>\\n姓名: 林言\\n</StatusPlaceHolder>',
        regex: {
          id,
          scriptName: title,
          findRegex: '/<StatusPlaceHolder>[\\\\s\\\\S]*?<\\\\/StatusPlaceHolder>/s',
          replaceString: '<section>$1</section>',
          trimStrings: [],
          placement: [2],
          disabled: false,
          markdownOnly: true,
          promptOnly: false,
          runOnEdit: true,
          substituteRegex: 0,
          minDepth: null,
          maxDepth: null,
        },
        styleNote: '',
        dataMode: 'reply',
        interactions: [],
        blocks: [],
        imageUrls: [],
        htmlTemplate: '<section>{{field_1}}</section>',
        compatibility: {
          levelLabel: '纯酒馆',
          dataLabel: '完整状态块',
          persistenceLabel: '每轮输出',
          dependencies: ['SillyTavern 内置正则'],
          verificationNote: '校样',
        },
      },
    })
    localStorage.setItem(
      'srl.frontendWorkshop.versions.v1',
      JSON.stringify([makeVersion('v1', '第一版'), makeVersion('v2', '第二版')]),
    )
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const manage = wrapper
      .findAll('.frontend-workshop__version-controls > button')
      .find((button) => button.text() === '整理版本')!
    await manage.trigger('click')
    const versionButtons = wrapper.findAll('.frontend-workshop__version-manager > div button')
    expect(versionButtons).toHaveLength(2)
    await versionButtons[0]!.trigger('click')
    await wrapper.get('.frontend-workshop__version-manager > button').trigger('click')
    expect(confirmActionMock).toHaveBeenCalled()
    expect(wrapper.get('.frontend-workshop__version-controls').text()).toContain('V1 / 1')
    wrapper.unmount()
  })

  it('320、390、桌面和适应按钮会切换真实预览宽度', async () => {
    seedPreviewVersion()
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const widthButtons = wrapper.get('[role="group"][aria-label="预览宽度"]').findAll('button')
    const stage = () => wrapper.get('.frontend-workshop__stage')

    await widthButtons[0]!.trigger('click')
    expect(stage().attributes('data-preview-width')).toBe('phone320')
    expect((stage().element as HTMLElement).style.width).toBe('320px')

    await widthButtons[1]!.trigger('click')
    expect(stage().attributes('data-preview-width')).toBe('phone390')
    expect((stage().element as HTMLElement).style.width).toBe('390px')

    await widthButtons[2]!.trigger('click')
    expect(stage().attributes('data-preview-width')).toBe('desktop')
    expect((stage().element as HTMLElement).style.width).toBe('720px')

    await widthButtons[3]!.trigger('click')
    expect(stage().attributes('data-preview-width')).toBe('fit')
    expect((stage().element as HTMLElement).style.width).toBe('100%')
    expect(wrapper.find('.frontend-workshop__stage-viewport').exists()).toBe(true)
    const preview = () =>
      wrapper.get('.frontend-workshop__stage-viewport rich-content-preview-stub')
    expect(preview().attributes('immersive')).toBe('true')
    expect(preview().attributes('rendershell')).toBe('message')
    expect(preview().attributes('messageavatarmode')).toBe('visible')
    expect(wrapper.find('.frontend-workshop__tavern-message').exists()).toBe(false)

    const avatarButtons = wrapper.get('[role="group"][aria-label="酒馆头像设置"]').findAll('button')
    await avatarButtons[1]!.trigger('click')
    expect(preview().attributes('messageavatarmode')).toBe('hidden')
    expect(wrapper.get('.frontend-workshop__preview-note').text()).toContain('隐藏头像')
    wrapper.unmount()
  })

  it('全屏校样把所选宽度与头像模式交给同 iframe 酒馆消息壳', async () => {
    seedPreviewVersion()
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })
    const widthButtons = wrapper.get('[role="group"][aria-label="预览宽度"]').findAll('button')
    await widthButtons[0]!.trigger('click')
    const avatarButtons = wrapper.get('[role="group"][aria-label="酒馆头像设置"]').findAll('button')
    await avatarButtons[1]!.trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '全屏看当前模式')!
      .trigger('click')

    const fullscreenStage = wrapper.get(
      '.frontend-workshop__fullscreen-stage-viewport .frontend-workshop__stage',
    )
    expect(fullscreenStage.classes()).toContain('is-message')
    expect(fullscreenStage.attributes('data-preview-width')).toBe('phone320')
    expect((fullscreenStage.element as HTMLElement).style.width).toBe('320px')
    expect(wrapper.find('.frontend-workshop__fullscreen .mesAvatarWrapper').exists()).toBe(false)
    expect(wrapper.get('.frontend-workshop__fullscreen').text()).toContain('酒馆消息位')
    expect(wrapper.get('.frontend-workshop__fullscreen').text()).toContain('隐藏头像')
    expect(wrapper.get('.frontend-workshop__fullscreen').text()).toContain('V1')
    expect(wrapper.get('.frontend-workshop__fullscreen').text()).toContain('preview-')
    const fullscreenPreview = wrapper.get(
      '.frontend-workshop__fullscreen-stage-viewport rich-content-preview-stub',
    )
    expect(fullscreenPreview.attributes('immersive')).toBe('true')
    expect(fullscreenPreview.attributes('rendershell')).toBe('message')
    expect(fullscreenPreview.attributes('messageavatarmode')).toBe('hidden')
    wrapper.unmount()
  })

  it('交付区为世界书与正则分别提供独立 JSON 下载', async () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    versions[0].artifact.htmlTemplate =
      '<style>.card{display:block}</style><section class="card">{{field_1}}</section>'
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))
    const createObjectUrl = vi.fn(() => 'blob:frontend-workshop-download')
    const revokeObjectUrl = vi.fn()
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const originalCreateObjectUrl = window.URL.createObjectURL
    const originalRevokeObjectUrl = window.URL.revokeObjectURL
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    })
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    const downloadButtons = wrapper
      .findAll('.frontend-workshop__copybar button')
      .filter((button) => button.text() === '下载 JSON')
    expect(downloadButtons).toHaveLength(2)
    expect(wrapper.get('.frontend-workshop__delivery-hint').text()).toContain('分别下载')
    await downloadButtons[0]!.trigger('click')
    await downloadButtons[1]!.trigger('click')
    expect(createObjectUrl).toHaveBeenCalledTimes(2)
    expect(
      anchorClick.mock.instances.map((anchor) => (anchor as HTMLAnchorElement).download),
    ).toEqual(['宽度校样.world.json', '宽度校样.regex.json'])
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    })
    anchorClick.mockRestore()
    wrapper.unmount()
  })

  it('旧版本模板校验失败时阻止复制和保存交付物', () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    versions[0].artifact.htmlTemplate =
      '<style>.card{display:block}</style><section class="card">< img src="https://example.com/a.png">{{field_1}}</section>'
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))
    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    expect(wrapper.get('.frontend-workshop__delivery [role="alert"]').text()).toContain(
      '畸形 HTML 标签',
    )
    expect(
      wrapper
        .get('.frontend-workshop__delivery-actions')
        .findAll('button')
        .find((button) => button.text().includes('保存为配套资源'))
        ?.attributes('disabled'),
    ).toBeDefined()
    expect(
      wrapper
        .findAll('.frontend-workshop__copybar button')
        .every((button) => button.attributes('disabled') !== undefined),
    ).toBe(true)
    wrapper.unmount()
  })

  it('旧 MVU 版本也会补全提示词模板依赖和处理消息内容开关说明', () => {
    seedPreviewVersion()
    const versions = JSON.parse(localStorage.getItem('srl.frontendWorkshop.versions.v1') ?? '[]')
    versions[0].artifact.dataMode = 'mvu'
    versions[0].artifact.sampleOutput = JSON.stringify({ stat_data: { 姓名: '测试角色' } })
    versions[0].artifact.htmlTemplate =
      '<style>.card{display:block}</style><section class="card">{{field_1}}</section>'
    versions[0].artifact.compatibility = {
      levelLabel: '酒馆助手 + MVU',
      dataLabel: '已有 MVU 变量',
      persistenceLabel: '由 MVU 保存',
      dependencies: ['酒馆助手', 'MVU'],
      verificationNote: '旧版说明',
    }
    localStorage.setItem('srl.frontendWorkshop.versions.v1', JSON.stringify(versions))

    const wrapper = mount(FrontendWorkshopApp, {
      global: {
        stubs: {
          InlineModelPicker: true,
          RichContentPreview: true,
          Teleport: true,
        },
      },
    })

    expect(wrapper.get('.frontend-workshop__delivery').text()).toContain('ST-Prompt-Template')
    expect(wrapper.get('.frontend-workshop__delivery').text()).toContain('处理消息内容')
    expect(wrapper.get('.frontend-workshop__delivery').text()).toContain(
      '酒馆内置正则本身不会执行 EJS',
    )
    wrapper.unmount()
  })
})
