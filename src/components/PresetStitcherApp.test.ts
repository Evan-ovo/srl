/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PresetStitchDraft } from '../services/BrowserStorageService'
import type { ResourceSummary } from '../types/Resource'
import type { PresetFavoriteSnapshot } from '../utils/PresetStitcher'

const basePreset = {
  temperature: 0.7,
  custom_unknown: { keep: true },
  prompts: [
    {
      identifier: 'main',
      name: '主提示',
      role: 'system',
      content: '底板主提示',
      system_prompt: true,
    },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
  ],
}

const sourcePrompts = [
  { identifier: 'style-1', name: '文风段', role: 'system', content: '轻小说文风提示' },
  { identifier: 'cot-1', name: '思维链', role: 'assistant', content: '先思考再回答' },
  ...Array.from({ length: 10 }, (_, index) => ({
    identifier: `extra-${index}`,
    name: `补充段 ${index + 1}`,
    role: 'system',
    content: `补充内容 ${index + 1}`,
  })),
]
const sourcePreset = {
  prompts: sourcePrompts,
  prompt_order: [
    {
      character_id: 100001,
      order: sourcePrompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })),
    },
  ],
  extensions: {
    regex_scripts: [{ id: 'rx-1', scriptName: '状态栏', findRegex: '/a/', replaceString: 'b' }],
  },
}

function summary(id: string, name: string, promptCount: number): ResourceSummary {
  return {
    id,
    type: 'preset',
    name,
    description: '',
    fileName: `${name}.json`,
    mimeType: 'application/json',
    fileSize: 10,
    contentHash: `hash-${id}`,
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    tags: [],
    metadata: { promptCount },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  } as ResourceSummary
}

const presetTexts: Record<string, string> = {
  'base-1': JSON.stringify(basePreset),
  'source-1': JSON.stringify(sourcePreset),
}

const resourceApi = {
  get: vi.fn(async (id: string) =>
    presetTexts[id] ? { id, originalBlob: { text: async () => presetTexts[id] } } : undefined,
  ),
  importStitchedPreset: vi.fn(async () => ({ id: 'new-1' })),
}
let favoriteStore: PresetFavoriteSnapshot[] = []
let checkpointStore: PresetStitchDraft | undefined
let templateStore: Array<{
  id: string
  name: string
  entries: PresetFavoriteSnapshot[]
  createdAt: number
  updatedAt: number
}> = []
const storageApi = {
  getPresetStitchDraft: vi.fn(() => undefined as never),
  setPresetStitchDraft: vi.fn(),
  clearPresetStitchDraft: vi.fn(),
  getPresetStitchCheckpoint: vi.fn(() => checkpointStore),
  setPresetStitchCheckpoint: vi.fn((value: PresetStitchDraft) => {
    checkpointStore = value
  }),
  clearPresetStitchCheckpoint: vi.fn(() => {
    checkpointStore = undefined
  }),
  getStitchRecentIds: vi.fn(() => [] as string[]),
  pushStitchRecentId: vi.fn(),
  getStitchFavorites: vi.fn(() => favoriteStore),
  setStitchFavorites: vi.fn((value: PresetFavoriteSnapshot[]) => {
    favoriteStore = value
    return value
  }),
  getStitchTemplates: vi.fn(() => templateStore),
  setStitchTemplates: vi.fn((value: typeof templateStore) => {
    templateStore = value
    return value
  }),
  getStitchMainSide: vi.fn(() => 'right' as const),
  setStitchMainSide: vi.fn((value: 'left' | 'right') => value),
}

vi.mock('../core/AppContainer', () => ({
  get resourceService() {
    return resourceApi
  },
  get browserStorageService() {
    return storageApi
  },
}))

import PresetStitcherApp from './PresetStitcherApp.vue'

function render() {
  return mount(PresetStitcherApp, {
    props: {
      resources: [summary('base-1', '破限底板', 2), summary('source-1', '文风来源', 12)],
      categories: [],
    },
    global: { stubs: { Teleport: true } },
  })
}

function renderWithRealTeleport() {
  return mount(PresetStitcherApp, {
    attachTo: document.body,
    props: {
      resources: [summary('base-1', '破限底板', 2), summary('source-1', '文风来源', 12)],
      categories: [],
    },
  })
}

async function pickBaseAndSource(wrapper: ReturnType<typeof render>) {
  await wrapper
    .findAll('.stitch__preset-list button')
    .find((button) => button.text().includes('破限底板'))!
    .trigger('click')
  await flushPromises()
  const sheet = wrapper.find('.stitch-sheet')
  await sheet
    .findAll('.stitch__preset-list button')
    .find((button) => button.text().includes('文风来源'))!
    .trigger('click')
  await flushPromises()
}

async function pickBaseAndSourceWithRealTeleport(
  wrapper: ReturnType<typeof renderWithRealTeleport>,
) {
  await wrapper
    .findAll('.stitch__preset-list button')
    .find((button) => button.text().includes('破限底板'))!
    .trigger('click')
  await flushPromises()
  const sourceButton = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.stitch-sheet .stitch__preset-list button'),
  ).find((button) => button.textContent?.includes('文风来源'))
  expect(sourceButton).toBeTruthy()
  sourceButton!.click()
  await flushPromises()
}

function sourceRow(wrapper: ReturnType<typeof render>, name: string) {
  return wrapper
    .findAll('.stitch-pane--source .stitch-entry')
    .find((row) => row.text().includes(name))!
}

function targetRow(wrapper: ReturnType<typeof render>, name: string) {
  return wrapper
    .findAll('.stitch-pane--target .stitch-entry')
    .find((row) => row.text().includes(name))!
}

function dispatchPointer(
  element: EventTarget,
  type: string,
  values: { pointerId: number; clientX: number; clientY: number; pointerType?: string },
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: values.pointerType ?? 'touch' },
    button: { value: 0 },
    isPrimary: { value: true },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  })
  element.dispatchEvent(event)
}

describe('PresetStitcherApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    favoriteStore = []
    checkpointStore = undefined
    templateStore = []
    presetTexts['base-1'] = JSON.stringify(basePreset)
    storageApi.getPresetStitchDraft.mockReturnValue(undefined as never)
    storageApi.getStitchMainSide.mockReturnValue('right')
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] })
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('可以输入页码快速跳转到大量主预设条目的指定页', async () => {
    const prompts = Array.from({ length: 25 }, (_, index) => ({
      identifier: `entry-${index + 1}`,
      name: `测试条目 ${index + 1}`,
      role: 'system',
      content: `内容 ${index + 1}`,
    }))
    presetTexts['base-1'] = JSON.stringify({
      prompts,
      prompt_order: [
        {
          character_id: 100001,
          order: prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })),
        },
      ],
    })
    const wrapper = render()
    await pickBaseAndSource(wrapper)

    const input = wrapper
      .find('nav[aria-label="主预设条目分页"]')
      .find('input[aria-label="跳转到主预设条目页"]')
    expect(wrapper.find('nav[aria-label="主预设条目分页"]').findAll('button')).toHaveLength(2)
    await input.setValue('3')
    await input.trigger('change')

    expect((input.element as HTMLInputElement).value).toBe('3')
    expect(wrapper.find('.stitch-pane--target').text()).toContain('测试条目 21')
    expect(wrapper.find('.stitch-pane--target').text()).toContain('测试条目 25')
    expect(wrapper.find('.stitch-pane--target').text()).not.toContain('测试条目 20')
    wrapper.unmount()
  })

  it('可以输入页码快速跳转到填充预设条目的指定页', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)

    const input = wrapper
      .find('nav[aria-label="填充条目分页"]')
      .find('input[aria-label="跳转到填充预设条目页"]')
    await input.setValue('2')
    await input.trigger('change')

    expect((input.element as HTMLInputElement).value).toBe('2')
    expect(wrapper.find('.stitch-pane--source').text()).toContain('补充段 9')
    expect(wrapper.find('.stitch-pane--source').text()).toContain('补充段 10')
    expect(wrapper.find('.stitch-pane--source').text()).not.toContain('思维链')
    wrapper.unmount()
  })

  it('可以新建主预设条目，并将其加入当前装配', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    const editor = wrapper.find('.stitch-editor')
    await editor.find('input').setValue('自定义规则')
    await editor.find('textarea').setValue('只按当前主预设执行')
    await editor.find('.button--primary').trigger('click')
    expect(wrapper.find('.stitch-pane--target').text()).toContain('自定义规则')
    await targetRow(wrapper, '自定义规则').find('.stitch-entry__copy').trigger('click')
    expect(wrapper.find('.stitch-pane--target').text()).toContain('只按当前主预设执行')
  })

  it('新建与修改共用宏工具，新条目按光标替换选区并可写入聊天变量', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const main = targetRow(wrapper, '主提示')
    await main.find('.stitch-entry__copy').trigger('click')
    await main.find('.stitch-entry__actions button').trigger('click')
    const editTools = wrapper.findAll('.stitch-editor__macros button').map((item) => item.text())
    await wrapper.findAll('.stitch-editor__actions button')[1].trigger('click')
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    expect(wrapper.findAll('.stitch-editor__macros button').map((item) => item.text())).toEqual(
      editTools,
    )
    const panel = wrapper.find('.stitch-editor')
    await panel.find('input').setValue('变量规则')
    const textarea = panel.find('textarea')
    await textarea.setValue('前文待替换后文')
    textarea.element.setSelectionRange(2, 5)
    await textarea.trigger('select')
    await panel
      .findAll('.stitch-editor__macros button')
      .find((item) => item.text() === '用户名')!
      .trigger('click')
    expect(textarea.element.value).toBe('前文{{user}}后文')
    await panel
      .findAll('.stitch-editor__macros button')
      .find((item) => item.text() === '写入聊天变量')!
      .trigger('click')
    const writer = wrapper.find('.stitch-variable-writer')
    await writer.find('input').setValue('mood')
    await writer.find('textarea').setValue('warm')
    await writer.find('.button--primary').trigger('click')
    await panel.find('.button--primary').trigger('click')
    const newRow = targetRow(wrapper, '变量规则')
    await newRow.find('.stitch-entry__copy').trigger('click')
    expect(newRow.find('pre').text()).toBe('前文{{user}}{{setvar::mood::warm}}后文')
    wrapper.unmount()
  })

  it('新建条目可读取已写变量、选择变量名占位，取消后不加入装配', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const main = targetRow(wrapper, '主提示')
    await main.find('.stitch-entry__copy').trigger('click')
    await main.find('.stitch-entry__actions button').trigger('click')
    await main.find('textarea').setValue('{{setvar::mood::warm}}')
    await main.find('.stitch-editor__actions .button--primary').trigger('click')
    const names = wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    const panel = wrapper.find('.stitch-editor')
    await panel.find('.stitch-editor__macros select').setValue('chat:mood')
    expect(panel.find('textarea').element.value).toBe('{{getvar::mood}}')
    await panel
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text() === '读取聊天变量')!
      .trigger('click')
    await flushPromises()
    const textarea = panel.find('textarea').element
    expect(textarea.value).toBe('{{getvar::mood}}{{getvar::变量名}}')
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('变量名')
    await panel.findAll('.stitch-editor__actions button')[1].trigger('click')
    expect(wrapper.find('.stitch-editor').exists()).toBe(false)
    expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual(names)
    wrapper.unmount()
  })

  it('可以在新条目中用名称插入酒馆填写占位，不要求手写宏', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    await wrapper
      .findAll('.stitch-editor__macros button')
      .find((item) => item.text() === '插入填写占位')!
      .trigger('click')
    const slotDialog = wrapper.find('.stitch-slot-writer')
    await slotDialog.find('input').setValue('文风')
    await slotDialog.find('button.button--primary').trigger('click')

    const editor = wrapper.find('.stitch-editor')
    expect((editor.find('input').element as HTMLInputElement).value).toBe('文风')
    expect((editor.find('textarea').element as HTMLTextAreaElement).value).toMatch(
      /^\{\{srl_slot::[a-f\d-]{36}::文风\}\}$/u,
    )
    await editor.find('.button--primary').trigger('click')
    expect(wrapper.find('.stitch-pane--target').text()).toContain('文风')
  })

  it('选中已有占位可修改显示名并保留稳定 ID', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    await wrapper
      .findAll('.stitch-editor__macros button')
      .find((item) => item.text() === '插入填写占位')!
      .trigger('click')
    const slotDialog = wrapper.find('.stitch-slot-writer')
    await slotDialog.find('input').setValue('文风')
    await slotDialog.find('button.button--primary').trigger('click')
    let editor = wrapper.find('.stitch-editor')
    const initialMacro = (editor.find('textarea').element as HTMLTextAreaElement).value
    const initialId = initialMacro.match(/srl_slot::([^:]+)::/u)?.[1]
    expect(initialId).toBeTruthy()
    await editor.find('.button--primary').trigger('click')

    const row = targetRow(wrapper, '文风')
    expect(row.exists()).toBe(true)
    await row.find('.stitch-entry__copy').trigger('click')
    await row.find('.stitch-entry__actions button').trigger('click')
    editor = wrapper.find('.stitch-editor')
    const textarea = editor.find('textarea')
    const textareaElement = textarea.element as HTMLTextAreaElement
    textareaElement.setSelectionRange(0, textareaElement.value.length)
    await textarea.trigger('select')
    await editor
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text().trim() === '插入填写占位')!
      .trigger('click')
    const renameDialog = wrapper.find('.stitch-slot-writer')
    expect(renameDialog.find('strong').text()).toBe('修改填写占位')
    expect((renameDialog.find('input').element as HTMLInputElement).value).toBe('文风')
    await renameDialog.find('input').setValue('叙事风格')
    await renameDialog.find('button.button--primary').trigger('click')
    const renamedMacro = (editor.find('textarea').element as HTMLTextAreaElement).value
    expect(renamedMacro).toBe(`{{srl_slot::${initialId}::叙事风格}}`)
    await editor.find('.button--primary').trigger('click')
    expect(targetRow(wrapper, '叙事风格').text()).toContain('叙事风格')
  })

  it('更多菜单不显示提示词预览或 token 入口', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.find('.stitch-tools__toggle').trigger('click')
    const menu = wrapper.find('.stitch-tools__menu')
    expect(menu.text()).not.toMatch(/预览|token/i)
    expect(wrapper.find('.stitch-prompt-card').exists()).toBe(false)
  })

  it('顶部按左右、全屏、SVG 更多排序，更多可用 Esc 和点击外部关闭', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const tools = wrapper.find('.feature-app-header .stitch-tools')
    expect(
      tools.findAll('.stitch__header-action').map((button) => button.attributes('aria-label')),
    ).toEqual(['将主预设调到左侧', '进入全屏工作区', '工作台更多操作'])
    const toggle = tools.find('.stitch-tools__toggle')
    expect(toggle.find('svg').exists()).toBe(true)
    expect(toggle.text()).toBe('')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(tools.findAll('.stitch-tools__action')).toHaveLength(5)
    expect(tools.findAll('.stitch-tools__action')[1].attributes('disabled')).toBeDefined()
    await tools.findAll('.stitch-tools__action')[2].trigger('keydown', { key: 'Escape' })
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(tools.find('.stitch-tools__menu').exists()).toBe(false)
    await toggle.trigger('click')
    dispatchPointer(document.body, 'pointerdown', {
      pointerId: 70,
      clientX: 0,
      clientY: 200,
      pointerType: 'mouse',
    })
    await wrapper.vm.$nextTick()
    expect(tools.find('.stitch-tools__menu').exists()).toBe(false)
    expect(wrapper.find('.stitch-workbench').exists()).toBe(true)
    wrapper.unmount()
  })

  it('选择主预设后拉出填充表单，默认填充在左、主预设在右，并可记忆调换', async () => {
    const wrapper = render()
    await wrapper
      .findAll('.stitch__preset-list button')
      .find((button) => button.text().includes('破限底板'))!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('.stitch-sheet').exists()).toBe(true)
    const sourceNames = wrapper
      .find('.stitch-sheet')
      .findAll('.stitch__preset-list button')
      .map((b) => b.text())
    expect(sourceNames.some((text) => text.includes('文风来源'))).toBe(true)
    expect(sourceNames.some((text) => text.includes('破限底板'))).toBe(false)
    expect(wrapper.findAll('.stitch-workbench > section')[0].attributes('aria-label')).toBe(
      '填充预设',
    )
    expect(wrapper.find('.stitch-workbench').classes()).not.toContain('is-main-left')

    await wrapper
      .find('.stitch-sheet')
      .findAll('.stitch__preset-list button')
      .find((button) => button.text().includes('文风来源'))!
      .trigger('click')
    await flushPromises()
    await wrapper.find('[aria-label="将主预设调到左侧"]').trigger('click')
    expect(wrapper.find('.stitch-workbench').classes()).toContain('is-main-left')
    expect(storageApi.setStitchMainSide).toHaveBeenCalledWith('left')
  })

  it('填充和主预设每页最多十条，箭头只切换一页', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    expect(wrapper.findAll('.stitch-pane--source .stitch-entry')).toHaveLength(10)
    const sourcePagination = wrapper.find('.stitch-pane--source .stitch-pagination')
    expect(sourcePagination.attributes('aria-label')).toBe('填充条目分页')
    expect(sourcePagination.findAll('button')).toHaveLength(2)
    expect(
      sourcePagination.find('input[aria-label="跳转到填充预设条目页"]').attributes('type'),
    ).toBe('text')
    expect(
      (
        sourcePagination.find('input[aria-label="跳转到填充预设条目页"]')
          .element as HTMLInputElement
      ).value,
    ).toBe('1')
    expect(sourceRow(wrapper, '文风段').find('strong').attributes('title')).toBe('文风段')
    await wrapper.find('.stitch-pane--source .stitch-pagination button:last-child').trigger('click')
    expect(wrapper.findAll('.stitch-pane--source .stitch-entry')).toHaveLength(2)
    expect(
      (
        wrapper
          .find('.stitch-pane--source .stitch-pagination')
          .find('input[aria-label="跳转到填充预设条目页"]').element as HTMLInputElement
      ).value,
    ).toBe('2')
  })

  it('点选插入位置后加入条目，主预设工作副本同步且底板结构项不可移除', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.findAll('.stitch-insertion button')[1].trigger('click')
    await sourceRow(wrapper, '文风段').find('.stitch-entry__add').trigger('click')

    const targetNames = wrapper
      .findAll('.stitch-pane--target .stitch-entry__copy strong')
      .map((node) => node.text())
    expect(targetNames).toEqual(['主提示', '文风段', 'Chat History'])
    expect(targetRow(wrapper, '文风段').classes()).toContain('is-inserted')
    expect(targetRow(wrapper, '文风段').find('.stitch-entry__change-badge').text()).toBe('新增')
    await targetRow(wrapper, 'Chat History').find('.stitch-entry__copy').trigger('click')
    expect(targetRow(wrapper, 'Chat History').find('.is-danger').exists()).toBe(false)
  })

  it('小屏条目编辑器与遮罩脱离触控滚动条目，避免 iOS fixed 编辑层被裁切', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(max-width: 52rem)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    const wrapper = renderWithRealTeleport()
    try {
      await pickBaseAndSourceWithRealTeleport(wrapper)

      const target = targetRow(wrapper, '主提示')
      await target.find('.stitch-entry__copy').trigger('click')
      await target.find('.stitch-entry__actions button').trigger('click')
      await flushPromises()

      const portal = wrapper.find('#stitch-entry-editor-portal')
      expect(portal.find('.stitch-editor-backdrop').exists()).toBe(true)
      expect(portal.find('.stitch-editor').exists()).toBe(true)
      expect(portal.find('.stitch-editor').element.closest('.stitch-entry')).toBeNull()
      expect(target.find('.stitch-editor').exists()).toBe(false)

      await portal.findAll('.stitch-editor__actions button')[1].trigger('click')
      const source = sourceRow(wrapper, '文风段')
      await source.find('.stitch-entry__copy').trigger('click')
      await source.find('.stitch-entry__detail button').trigger('click')
      await flushPromises()

      expect(portal.find('.stitch-editor').exists()).toBe(true)
      expect(portal.find('.stitch-editor').element.closest('.stitch-entry')).toBeNull()
      expect(source.find('.stitch-editor').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      })
    }
  })

  it('来源和主预设条目均可编辑保存或取消，并可快速插入官方变量语法', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const row = sourceRow(wrapper, '文风段')
    await row.find('.stitch-entry__copy').trigger('click')
    await row.find('.stitch-entry__detail button').trigger('click')
    expect(wrapper.find('.stitch-editor-backdrop').exists()).toBe(true)
    await row.find('textarea').setValue('不应保存')
    await row.findAll('.stitch-editor__actions button')[1].trigger('click')
    expect(wrapper.find('.stitch-editor-backdrop').exists()).toBe(false)
    expect(row.find('pre').text()).toContain('轻小说文风提示')

    await row.find('.stitch-entry__detail button').trigger('click')
    await row.find('input[type="text"]').setValue('改写文风')
    const sourceTextarea = row.find('textarea')
    sourceTextarea.element.setSelectionRange(3, 3)
    await sourceTextarea.trigger('select')
    await row
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text() === '用户名')!
      .trigger('click')
    expect(sourceTextarea.element.value).toBe('轻小说{{user}}文风提示')
    await row.findAll('.stitch-editor__actions button')[0].trigger('click')
    await sourceRow(wrapper, '改写文风').find('.stitch-entry__add').trigger('click')
    expect(targetRow(wrapper, '改写文风').text()).toContain('改写文风')

    await targetRow(wrapper, '主提示').find('.stitch-entry__copy').trigger('click')
    await targetRow(wrapper, '主提示').find('input[type="checkbox"]').setValue(false)
    await targetRow(wrapper, '主提示').find('.stitch-entry__actions button').trigger('click')
    expect(targetRow(wrapper, '主提示').classes()).toContain('is-editing')
    await targetRow(wrapper, '主提示').find('textarea').setValue('主提示已修改 {{char}}')
    await targetRow(wrapper, '主提示').findAll('.stitch-editor__actions button')[0].trigger('click')
    expect(targetRow(wrapper, '主提示').find('pre').text()).toContain('主提示已修改 {{char}}')
    expect(targetRow(wrapper, '主提示').classes()).toContain('is-modified')
    expect(targetRow(wrapper, '主提示').find('.stitch-entry__change-badge').text()).toBe('修改')
  })

  it('读取聊天变量会选中变量名，写入聊天变量通过两个输入框生成宏', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const row = sourceRow(wrapper, '文风段')
    await row.find('.stitch-entry__copy').trigger('click')
    await row.find('.stitch-entry__detail button').trigger('click')
    const textarea = row.find('textarea')

    await row
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text() === '读取聊天变量')!
      .trigger('click')
    await flushPromises()
    expect(textarea.element.value).toContain('{{getvar::变量名}}')
    expect(
      textarea.element.value.slice(textarea.element.selectionStart, textarea.element.selectionEnd),
    ).toBe('变量名')

    await row
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text() === '写入聊天变量')!
      .trigger('click')
    const writer = wrapper.find('.stitch-variable-writer')
    await writer.find('input').setValue('mood')
    await writer.find('textarea').setValue('warm')
    await writer.find('.button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('textarea').map((item) => item.element.value)).toEqual(
      expect.arrayContaining([expect.stringContaining('{{setvar::mood::warm}}')]),
    )
  })

  it('写入聊天变量时可在变量值中快捷插入填写占位', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await wrapper.find('.stitch-pane__add-entry').trigger('click')
    const editor = wrapper.find('.stitch-editor')
    await editor
      .findAll('.stitch-editor__macros button')
      .find((button) => button.text() === '写入聊天变量')!
      .trigger('click')

    const writer = wrapper.find('.stitch-variable-writer')
    await writer.find('input').setValue('tone')
    const value = writer.find('textarea')
    await value.setValue('前后')
    ;(value.element as HTMLTextAreaElement).setSelectionRange(1, 1)
    await writer.find('.stitch-variable-writer__slot-button').trigger('click')

    const slotWriter = wrapper.find('.stitch-slot-writer')
    await slotWriter.find('input').setValue('文风')
    await slotWriter.find('.button--primary').trigger('click')
    const variableText = (
      wrapper.find('.stitch-variable-writer textarea').element as HTMLTextAreaElement
    ).value
    const slotMacro = variableText.match(/\{\{srl_slot::[a-f\d-]{36}::文风\}\}/u)?.[0]
    expect(variableText).toContain('{{srl_slot::')
    expect(slotMacro).toBeTruthy()
    expect(variableText).toBe(`前${slotMacro}后`)
    expect(writer.exists()).toBe(true)

    await wrapper.find('.stitch-variable-writer .button--primary').trigger('click')
    expect((editor.find('textarea').element as HTMLTextAreaElement).value).toBe(
      `{{setvar::tone::前${slotMacro}后}}`,
    )
    wrapper.unmount()
  })

  it('高亮条目宏，可复制正文、按变量读写筛选，并读取未使用的已写变量', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const main = targetRow(wrapper, '主提示')
    await main.find('.stitch-entry__copy').trigger('click')
    await main.find('.stitch-entry__actions button').trigger('click')
    await main
      .find('textarea')
      .setValue('<daily_limits>{{setvar::dailylimits::保持生活细节}}</daily_limits>')
    await main.find('.stitch-editor__actions .button--primary').trigger('click')

    expect(main.find('.stitch-macro--write').text()).toBe('{{setvar::dailylimits::保持生活细节}}')
    await main
      .findAll('.stitch-entry__actions button')
      .find((button) => button.text() === '复制')!
      .trigger('click')
    expect(writeText).toHaveBeenCalledWith(
      '<daily_limits>{{setvar::dailylimits::保持生活细节}}</daily_limits>',
    )

    const source = sourceRow(wrapper, '文风段')
    await source.find('.stitch-entry__copy').trigger('click')
    await source.find('.stitch-entry__detail button').trigger('click')
    const unreadSelector = source.find('.stitch-editor__macros select')
    expect(unreadSelector.exists()).toBe(true)
    await unreadSelector.setValue('chat:dailylimits')
    expect(source.find('textarea').element.value).toContain('{{getvar::dailylimits}}')

    const filterToggle = wrapper.find('.stitch-pane__filter-toggle')
    expect(filterToggle.attributes('aria-expanded')).toBe('false')
    await filterToggle.trigger('click')
    expect(filterToggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.stitch-pane__filters').isVisible()).toBe(true)

    const filters = wrapper.find('.stitch-pane__filters').findAll('input')
    await filters[3].setValue(true)
    expect(targetRow(wrapper, '主提示').exists()).toBe(true)
    await filters[3].setValue(false)
    await filters[2].setValue(true)
    expect(targetRow(wrapper, '主提示')).toBeUndefined()
  })

  it('横屏自动收起主预设筛选，并把填充筛选收进搜索框', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    expect(wrapper.find('.stitch').classes()).toContain('is-reading')
    expect(wrapper.find('.stitch-pane__filter-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).not.toContain('点虚线设定')
    const sourceFilter = wrapper.find('.stitch__search-filter')
    expect(sourceFilter.exists()).toBe(true)
    await sourceFilter.trigger('click')
    expect(wrapper.find('#stitch-source-role-filters').exists()).toBe(true)
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
  })

  it('最终确认只保留正文前后对比与宏变化，不显示逐行和重复变量明细', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await sourceRow(wrapper, '文风段').find('.stitch-entry__add').trigger('click')
    const main = targetRow(wrapper, '主提示')
    await main.find('.stitch-entry__copy').trigger('click')
    await main.find('.stitch-entry__actions button').trigger('click')
    await main.find('textarea').setValue('新版主提示\n{{setvar::mood::warm}}\n{{getvar::mood}}')
    await main.find('.stitch-editor__actions .button--primary').trigger('click')

    expect(wrapper.find('.stitch-audit').exists()).toBe(false)
    await wrapper.find('.stitch__footer .button--primary').trigger('click')
    expect(wrapper.text()).toContain('新增 1 条目')
    expect(wrapper.text()).toContain('删除 0 条目')
    expect(wrapper.text()).toContain('修改 1 条目')
    expect(wrapper.find('.stitch-review__hero').exists()).toBe(false)
    expect(wrapper.find('.stitch-review__content-transition').text()).toContain('修改前')
    expect(wrapper.find('.stitch-review__content-transition').text()).toContain('修改后')
    expect(wrapper.text()).not.toContain('具体增加的行')
    expect(wrapper.text()).toContain('新版主提示')
    expect(wrapper.text()).not.toContain('具体删除的行')
    expect(wrapper.text()).toContain('底板主提示')
    expect(wrapper.text()).toContain('宏变化')
    expect(wrapper.text()).not.toContain('新增变量读取')
    expect(wrapper.text()).not.toContain('新增变量写入')
    expect(wrapper.find('.stitch-review__technical').text()).toContain('{{setvar::mood::warm}}')
    expect(wrapper.find('.stitch-review__technical').text()).toContain('{{getvar::mood}}')
    expect(wrapper.find('.stitch-review__technical').attributes('open')).toBeUndefined()
  })

  it('差异较多时按组收起长列表，没有宏变化时不显示额外明细', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    for (let index = 1; index <= 5; index += 1) {
      await wrapper.find('.stitch-pane__add-entry').trigger('click')
      const editor = wrapper.find('.stitch-editor')
      await editor.find('input').setValue(`自定义段 ${index}`)
      await editor.find('textarea').setValue(`规则正文 ${index}`)
      await editor.find('.stitch-editor__actions .button--primary').trigger('click')
    }
    await wrapper.find('.stitch__footer .button--primary').trigger('click')
    const addedGroup = wrapper.find('.stitch-review__group--added')
    expect(addedGroup.find('summary').text()).toContain('5')
    expect(addedGroup.attributes('open')).toBeUndefined()
    expect(wrapper.find('.stitch-review__overview').text()).toContain('新增 5')
    expect(wrapper.find('.stitch-review__overview').text()).toContain('删除 0')
    const technical = wrapper.find('.stitch-review__technical')
    expect(technical.exists()).toBe(false)
  })

  it('生成前检查只显示阻断错误，不显示变量提醒', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const main = targetRow(wrapper, '主提示')
    await main.find('.stitch-entry__copy').trigger('click')
    await main.find('.stitch-entry__actions button').trigger('click')
    await main.find('textarea').setValue('{{getvar::fromElsewhere}}')
    await main.find('.stitch-editor__actions .button--primary').trigger('click')
    expect(wrapper.find('.stitch-audit').exists()).toBe(false)

    const refreshedMain = targetRow(wrapper, '主提示')
    if (!refreshedMain.find('.stitch-entry__actions button').exists()) {
      await refreshedMain.find('.stitch-entry__copy').trigger('click')
      await flushPromises()
    }
    await refreshedMain.find('.stitch-entry__actions button').trigger('click')
    await refreshedMain.find('textarea').setValue('{{getvar::fromElsewhere}} {{')
    await refreshedMain.find('.stitch-editor__actions .button--primary').trigger('click')
    expect(wrapper.find('.stitch-audit').text()).toContain('1 个错误')
    expect(wrapper.find('.stitch-audit').text()).not.toContain('提醒')
  })

  it('支持撤销重做、工作台检查点以及启用和修改筛选', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await sourceRow(wrapper, '文风段').find('.stitch-entry__add').trigger('click')
    await flushPromises()
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)

    const actions = wrapper
    await wrapper.find('.stitch-tools__toggle').trigger('click')
    await actions
      .findAll('button')
      .find((button) => button.text() === '撤销')!
      .trigger('click')
    await flushPromises()
    expect(targetRow(wrapper, '文风段')).toBeUndefined()
    await wrapper.find('.stitch-tools__toggle').trigger('click')
    await actions
      .findAll('button')
      .find((button) => button.text() === '重做')!
      .trigger('click')
    await flushPromises()
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)

    await wrapper.find('.stitch-tools__toggle').trigger('click')
    await actions
      .findAll('button')
      .find((button) => button.text() === '保存工作台检查点')!
      .trigger('click')
    expect(storageApi.setPresetStitchCheckpoint).toHaveBeenCalled()
    await targetRow(wrapper, '文风段').find('.stitch-entry__copy').trigger('click')
    await targetRow(wrapper, '文风段').find('.is-danger').trigger('click')
    await wrapper.find('.stitch-tools__toggle').trigger('click')
    await actions
      .findAll('button')
      .find((button) => button.text() === '恢复检查点')!
      .trigger('click')
    await flushPromises()
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)

    const filters = wrapper.find('.stitch-pane__filters')
    await wrapper.find('.stitch-pane__filter-toggle').trigger('click')
    await targetRow(wrapper, '主提示').find('input[type="checkbox"]').setValue(false)
    await filters.findAll('input')[0].setValue(true)
    expect(targetRow(wrapper, '主提示')).toBeUndefined()
    await filters.findAll('input')[0].setValue(false)
    await filters.findAll('input')[1].setValue(true)
    expect(targetRow(wrapper, 'Chat History')).toBeUndefined()
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)
  })

  it('条目收藏为本机快照，并能从填充表单的已收藏条目再次加入', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const source = sourceRow(wrapper, '文风段')
    await source.find('.stitch-entry__copy').trigger('click')
    await source.findAll('.stitch-entry__detail button')[2].trigger('click')
    expect(storageApi.setStitchFavorites).toHaveBeenCalled()
    expect(favoriteStore[0].content).toBe('轻小说文风提示')

    await wrapper.find('.stitch-pane__header button').trigger('click')
    await wrapper.find('.stitch-sheet__favorites button').trigger('click')
    const favoriteRow = sourceRow(wrapper, '文风段')
    expect(favoriteRow.text()).toContain('文风来源')
    await favoriteRow.find('.stitch-entry__add').trigger('click')
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)
  })

  it('候选篮子会提示重复变量和正文相似项，并可按顺序加入或存为模板', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const source = sourceRow(wrapper, '文风段')
    await source.find('.stitch-entry__copy').trigger('click')
    await source.findAll('.stitch-entry__detail button')[3].trigger('click')
    await wrapper.find('.stitch-pane--target .stitch-pane__candidates').trigger('click')

    expect(wrapper.find('.stitch-candidates__summary').text()).toContain('1 条候选')
    expect(wrapper.find('.stitch-candidates__templates').element.tagName).toBe('DETAILS')
    expect(wrapper.find('.stitch-candidates__templates').attributes('open')).toBeUndefined()
    await wrapper.find('.stitch-candidates__actions button').trigger('click')
    expect(wrapper.find('.stitch-candidates__compare').exists()).toBe(true)
    await wrapper.find('.stitch-candidates__actions button').trigger('click')
    expect(wrapper.find('.stitch-candidates__compare').exists()).toBe(false)
    await wrapper.find('.stitch-candidates__template-save input').setValue('常用文风')
    await wrapper.find('.stitch-candidates__template-save button').trigger('click')
    expect(storageApi.setStitchTemplates).toHaveBeenCalled()
    await wrapper.find('.stitch-candidates__all').trigger('click')
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)
  })

  it('手机端固定显示左右两列，长按加入按钮有 420ms 与明确落点保护', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    expect(wrapper.find('.stitch-pane--source').exists()).toBe(true)
    expect(wrapper.find('.stitch-pane--target').exists()).toBe(true)
    const handle = sourceRow(wrapper, '文风段').find('.stitch-entry__add')

    dispatchPointer(handle.element, 'pointerdown', { pointerId: 1, clientX: 20, clientY: 20 })
    dispatchPointer(window, 'pointermove', { pointerId: 1, clientX: 35, clientY: 20 })
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(wrapper.find('.stitch-drag-ghost').exists()).toBe(false)
    expect(targetRow(wrapper, '文风段')).toBeUndefined()
    await handle.trigger('click')
    expect(targetRow(wrapper, '文风段')).toBeUndefined()

    dispatchPointer(handle.element, 'pointerdown', { pointerId: 2, clientX: 20, clientY: 20 })
    const noticeBeforePickup = wrapper.find('.stitch__notice').exists()
      ? wrapper.find('.stitch__notice').text()
      : ''
    vi.advanceTimersByTime(421)
    await flushPromises()
    expect(wrapper.find('.stitch-drag-ghost').exists()).toBe(true)
    expect(
      wrapper.find('.stitch__notice').exists() ? wrapper.find('.stitch__notice').text() : '',
    ).toBe(noticeBeforePickup)
    expect(wrapper.find('.stitch-workbench').classes()).toContain('is-dragging')
    dispatchPointer(window, 'pointerup', { pointerId: 2, clientX: 20, clientY: 20 })
    await wrapper.vm.$nextTick()
    expect(targetRow(wrapper, '文风段')).toBeUndefined()
    expect(wrapper.find('.stitch-workbench').classes()).not.toContain('is-dragging')

    const targetSlot = wrapper.findAll('.stitch-pane--target .stitch-insertion')[1]
    vi.spyOn(wrapper.find('.stitch-target-list').element, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 300,
    } as DOMRect)
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [targetSlot.element],
    })
    dispatchPointer(handle.element, 'pointerdown', { pointerId: 3, clientX: 20, clientY: 20 })
    vi.advanceTimersByTime(421)
    await flushPromises()
    dispatchPointer(window, 'pointermove', { pointerId: 3, clientX: 120, clientY: 80 })
    await wrapper.vm.$nextTick()
    expect(targetSlot.classes()).toContain('is-drag-over')
    dispatchPointer(window, 'pointerup', { pointerId: 3, clientX: 120, clientY: 80 })
    await wrapper.vm.$nextTick()
    expect(targetRow(wrapper, '文风段').exists()).toBe(true)
    vi.useRealTimers()
  })

  it('鼠标无需等待长按即可拖入条目，落点高亮且拖后点击不展开条目', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    try {
      await pickBaseAndSource(wrapper)
      const handle = sourceRow(wrapper, '文风段').find('.stitch-entry__copy')
      const slot = wrapper.find('[data-insertion-index="1"]')
      vi.spyOn(
        wrapper.find('.stitch-target-list').element,
        'getBoundingClientRect',
      ).mockReturnValue({
        top: 0,
        bottom: 300,
      } as DOMRect)
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: () => [slot.element],
      })
      dispatchPointer(handle.element, 'pointerdown', {
        pointerId: 40,
        pointerType: 'mouse',
        clientX: 20,
        clientY: 20,
      })
      dispatchPointer(window, 'pointermove', {
        pointerId: 40,
        pointerType: 'mouse',
        clientX: 120,
        clientY: 80,
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.stitch-drag-ghost').exists()).toBe(true)
      expect(slot.classes()).toContain('is-drag-over')
      dispatchPointer(window, 'pointerup', {
        pointerId: 40,
        pointerType: 'mouse',
        clientX: 120,
        clientY: 80,
      })
      await flushPromises()
      await handle.trigger('click')
      expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual([
        '主提示',
        '文风段',
        'Chat History',
      ])
      expect(handle.attributes('aria-expanded')).toBe('false')
      vi.advanceTimersByTime(500)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.stitch-drag-ghost').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('单列侧栏长按后让出主预设，按条目中线落点插入且撤销可恢复', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    try {
      await pickBaseAndSource(wrapper)
      await wrapper.find('.stitch-tools__toggle').trigger('click')
      expect(wrapper.findAll('.stitch-tools__action')).toHaveLength(5)
      await wrapper
        .findAll('.stitch-tools__action')
        .find((button) => button.text() === '单列显示')!
        .trigger('click')
      expect(wrapper.find('.stitch-workbench').classes()).toContain('is-single-column')
      expect(wrapper.find('.stitch-pane--source').attributes('style')).toContain('display: none')
      await wrapper.find('.stitch-source-toggle').trigger('click')
      const handle = sourceRow(wrapper, '文风段').find('.stitch-entry__copy')
      const target = targetRow(wrapper, '主提示')
      vi.spyOn(
        wrapper.find('.stitch-target-list').element,
        'getBoundingClientRect',
      ).mockReturnValue({ top: 0, bottom: 300 } as DOMRect)
      vi.spyOn(target.element, 'getBoundingClientRect').mockReturnValue({
        top: 20,
        height: 60,
      } as DOMRect)
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: () => [target.element],
      })
      dispatchPointer(handle.element, 'pointerdown', { pointerId: 20, clientX: 20, clientY: 20 })
      vi.advanceTimersByTime(421)
      await flushPromises()
      expect(wrapper.find('.stitch-pane--source').attributes('style')).toContain('display: none')
      dispatchPointer(window, 'pointermove', { pointerId: 20, clientX: 120, clientY: 65 })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-insertion-index="1"]').classes()).toContain('is-drag-over')
      dispatchPointer(window, 'pointerup', { pointerId: 20, clientX: 120, clientY: 65 })
      await flushPromises()
      expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual([
        '主提示',
        '文风段',
        'Chat History',
      ])
      await wrapper.find('.stitch-tools__toggle').trigger('click')
      await wrapper
        .findAll('.stitch-tools__action')
        .find((button) => button.text() === '撤销')!
        .trigger('click')
      await flushPromises()
      expect(targetRow(wrapper, '文风段')).toBeUndefined()
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('主预设向后拖动使用移除后的正确索引，取消拖动不改顺序', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    try {
      await pickBaseAndSource(wrapper)
      await sourceRow(wrapper, '文风段').find('.stitch-entry__add').trigger('click')
      const list = wrapper.find('.stitch-target-list')
      vi.spyOn(list.element, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        bottom: 300,
      } as DOMRect)
      const slot = wrapper.findAll('.stitch-insertion').at(-1)!
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: () => [slot.element],
      })
      const handle = targetRow(wrapper, '主提示').find('.stitch-entry__reorder')
      dispatchPointer(handle.element, 'pointerdown', { pointerId: 30, clientX: 10, clientY: 20 })
      vi.advanceTimersByTime(421)
      dispatchPointer(window, 'pointermove', { pointerId: 30, clientX: 20, clientY: 200 })
      dispatchPointer(window, 'pointercancel', { pointerId: 30, clientX: 20, clientY: 200 })
      await flushPromises()
      expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual([
        '主提示',
        'Chat History',
        '文风段',
      ])
      dispatchPointer(handle.element, 'pointerdown', { pointerId: 31, clientX: 10, clientY: 20 })
      vi.advanceTimersByTime(421)
      dispatchPointer(window, 'pointerup', { pointerId: 31, clientX: 20, clientY: 200 })
      await flushPromises()
      expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual([
        'Chat History',
        '文风段',
        '主提示',
      ])
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('调整两栏宽度保持装配内容，左右互换后键盘方向跟随分隔线', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    const names = wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())
    const separator = wrapper.find('.stitch-column-separator')
    expect(separator.attributes('aria-valuenow')).toBe('40')
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(separator.attributes('aria-valuenow')).toBe('42')
    await wrapper.find('[aria-label="将主预设调到左侧"]').trigger('click')
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(separator.attributes('aria-valuenow')).toBe('40')
    await separator.trigger('keydown', { key: 'Home' })
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(separator.attributes('aria-valuenow')).toBe('30')
    await separator.trigger('keydown', { key: 'End' })
    await separator.trigger('keydown', { key: 'ArrowLeft' })
    expect(separator.attributes('aria-valuenow')).toBe('60')
    expect(wrapper.findAll('.stitch-entry--target strong').map((row) => row.text())).toEqual(names)
    wrapper.unmount()
  })

  it('全屏工作区保留分页、编辑与拖放操作，退出后回到普通工作台', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)

    await wrapper.find('[aria-label="进入全屏工作区"]').trigger('click')
    expect(wrapper.find('.stitch').classes()).toContain('is-reading')
    expect(wrapper.find('.stitch__focus-exit').exists()).toBe(true)
    expect(wrapper.find('.stitch__footer').exists()).toBe(false)
    await wrapper.find('.stitch-tools__toggle').trigger('click')
    expect(wrapper.findAll('.stitch-tools__action')).toHaveLength(5)
    expect(wrapper.find('.stitch-tools__menu').text()).not.toContain('导出')
    expect(wrapper.find('.stitch-tools__toggle').exists()).toBe(true)
    expect(wrapper.find('.stitch__focus-swap').exists()).toBe(true)
    expect(wrapper.findAll('.stitch-workbench > section')).toHaveLength(2)
    expect(wrapper.find('.stitch-pane--source .stitch-pagination').exists()).toBe(true)
    expect(wrapper.find('.stitch-pane--target .stitch-insertion').exists()).toBe(true)
    expect(sourceRow(wrapper, '文风段').find('.stitch-entry__add').exists()).toBe(true)
    await sourceRow(wrapper, '文风段').find('.stitch-entry__copy').trigger('click')
    expect(sourceRow(wrapper, '文风段').find('.stitch-entry__detail button').exists()).toBe(true)

    await wrapper.find('.stitch__focus-exit').trigger('click')
    expect(wrapper.find('.stitch').classes()).not.toContain('is-reading')
  })

  it('手机横屏会自动进入全屏工作区，转回竖屏后恢复普通界面', async () => {
    const landscapeListener = vi.fn()
    const landscapeQuery = {
      matches: true,
      addEventListener: landscapeListener,
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList
    const mobileQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) =>
        query === '(orientation: landscape) and (max-height: 34rem)' ? landscapeQuery : mobileQuery,
      ),
    )
    try {
      const wrapper = render()
      expect(wrapper.find('.stitch').classes()).not.toContain('is-reading')
      await pickBaseAndSource(wrapper)
      expect(wrapper.find('.stitch').classes()).toContain('is-reading')
      expect(wrapper.find('.stitch__focus-toolbar').exists()).toBe(true)
      expect(wrapper.find('.stitch__focus-exit').exists()).toBe(false)
      expect(wrapper.find('.stitch__focus-swap').exists()).toBe(true)
      expect(wrapper.find('.stitch-pane--source .stitch-pagination').exists()).toBe(true)
      expect(sourceRow(wrapper, '文风段').find('.stitch-entry__add').exists()).toBe(true)

      await wrapper.find('.stitch__search-filter').trigger('click')
      expect(wrapper.find('.stitch__chips').exists()).toBe(true)
      const compactHandler = landscapeListener.mock.calls[0]?.[1] as (() => void) | undefined
      compactHandler?.()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.stitch__chips').exists()).toBe(false)

      Object.assign(landscapeQuery, { matches: false })
      const changeHandler = landscapeListener.mock.calls[0]?.[1] as (() => void) | undefined
      changeHandler?.()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.stitch').classes()).not.toContain('is-reading')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('导出前显示新增和修改差异，确认后才入库并保留标准预设关联', async () => {
    const wrapper = render()
    await pickBaseAndSource(wrapper)
    await sourceRow(wrapper, '文风段').find('.stitch-entry__add').trigger('click')
    await targetRow(wrapper, '主提示').find('.stitch-entry__copy').trigger('click')
    await targetRow(wrapper, '主提示').find('.stitch-entry__actions button').trigger('click')
    await targetRow(wrapper, '主提示').find('textarea').setValue('修改后的主提示')
    await targetRow(wrapper, '主提示').findAll('.stitch-editor__actions button')[0].trigger('click')

    await wrapper.find('.stitch__footer .button--primary').trigger('click')
    expect(resourceApi.importStitchedPreset).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('新增「文风段」')
    expect(wrapper.text()).toContain('修改「主提示」')
    await wrapper.find('.stitch__generate .button--primary').trigger('click')
    await flushPromises()

    expect(resourceApi.importStitchedPreset).toHaveBeenCalledTimes(1)
    const [file, options] = resourceApi.importStitchedPreset.mock.calls[0] as unknown as [
      File,
      {
        stitchedFrom: { resourceId: string }[]
        baseResourceId: string
        relatedResourceIds: string[]
      },
    ]
    expect(file.name.endsWith('.json')).toBe(true)
    expect(options.baseResourceId).toBe('base-1')
    expect(options.relatedResourceIds).toEqual(expect.arrayContaining(['base-1', 'source-1']))
    expect(options.stitchedFrom[0].resourceId).toBe('source-1')
    expect(storageApi.clearPresetStitchDraft).toHaveBeenCalled()
    expect(wrapper.emitted('library-changed')).toBeTruthy()
    storageApi.setPresetStitchDraft.mockClear()
    wrapper.unmount()
    expect(storageApi.setPresetStitchDraft).not.toHaveBeenCalled()
  })

  it('退出草稿保存正文编辑并可恢复，缺失来源会跳过而不是阻断', async () => {
    storageApi.getPresetStitchDraft.mockReturnValueOnce({
      baseId: 'base-1',
      name: '草稿名',
      savedAt: 1,
      entries: [
        {
          origin: 'base',
          identifier: 'main',
          enabled: true,
          name: '主提示',
          role: 'system',
          content: '草稿修改正文',
        },
        { origin: 'base', identifier: 'chatHistory', enabled: true },
        { origin: 'pick', identifier: 'gone', enabled: true, sourceResourceId: 'deleted-source' },
      ],
      regexPickIds: [],
      mainSide: 'left',
    } as never)
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('发现自动草稿')
    await wrapper.find('.stitch__draft .button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('1 个已删除来源已跳过')
    expect(wrapper.find('.stitch-workbench').classes()).toContain('is-main-left')
    await targetRow(wrapper, '主提示').find('.stitch-entry__copy').trigger('click')
    expect(targetRow(wrapper, '主提示').find('pre').text()).toContain('草稿修改正文')
  })
})
