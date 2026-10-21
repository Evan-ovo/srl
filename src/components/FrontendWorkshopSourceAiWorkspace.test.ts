/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import type {
  FrontendWorkshopSourceAiGeneration,
  FrontendWorkshopSourceAiSessionSnapshot,
} from '../services/FrontendWorkshopSourceAiSessionService'
import type { FrontendWorkshopSourceRuntimeFixIntent } from '../services/FrontendWorkshopSourceCompatibilityDiagnosticsService'
import type { FrontendWorkshopResolvedSourceSelection } from '../utils/FrontendWorkshopSourceSelection'
import { buildFrontendWorkshopSourceAiContext } from '../utils/FrontendWorkshopSourceAiContext'

const source = createFrontendWorkshopSourceDocument('project', '<main>before</main>', 100)
const after = { ...source, authorSource: '<main>after</main>', revision: 2 }

function dispatchPointer(
  element: Element,
  type: string,
  options: { pointerId: number; clientX?: number; clientY?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
  })
  Object.defineProperty(event, 'pointerId', { value: options.pointerId })
  element.dispatchEvent(event)
}
const mocks = vi.hoisted(() => ({
  readPreferences: vi.fn(),
  getDocument: vi.fn(),
  request: vi.fn(),
  apply: vi.fn(),
  select: vi.fn(),
  cancel: vi.fn(),
  preview: vi.fn(),
  deleteTurn: vi.fn(),
  deleteGeneration: vi.fn(),
  listener: undefined as ((value: FrontendWorkshopSourceAiSessionSnapshot) => void) | undefined,
  policyListener: undefined as ((value: { allowRemoteResources: boolean }) => void) | undefined,
  stopPolicy: vi.fn(),
  getPreviewPolicy: vi.fn(() => ({ allowRemoteResources: false })),
  scrollPreview: vi.fn(),
}))

vi.mock('../core/AppContainer', () => ({
  browserStorageService: {
    getPreviewPolicy: mocks.getPreviewPolicy,
    onPreviewPolicyChange: (listener: typeof mocks.policyListener) => {
      mocks.policyListener = listener
      return mocks.stopPolicy
    },
  },
}))

function snapshot(): FrontendWorkshopSourceAiSessionSnapshot {
  return {
    projectId: 'project',
    turns: [
      {
        id: 'turn',
        content: '把文字改掉',
        referenceImages: [],
        baseCheckpointId: 'base',
        generationIds: ['g1', 'g2'],
        createdAt: 1,
      },
    ],
    generations: [1, 2].map((ordinal) => ({
      id: `g${ordinal}`,
      turnId: 'turn',
      ordinal,
      status: 'applied' as const,
      assistantContent: `第 ${ordinal} 个结果`,
      summary: `修改摘要 ${ordinal}`,
      bundle: null,
      proposal: {
        kind: 'source-ai-proposal' as const,
        projectId: 'project',
        sourceRevision: 1,
        summary: `修改摘要 ${ordinal}`,
        edits: [
          {
            start: 6,
            end: 12,
            expectedText: 'before',
            replacement: `after-${ordinal}`,
            reason: '修改文字',
          },
        ],
        hostReferenceRequests: [],
        warnings: [],
      },
      unresolvedHostReferenceRequests: [],
      resultCheckpointId: `result-${ordinal}`,
      resultRevision: ordinal + 1,
      diagnostics: {
        instruction: '把文字改掉',
        target: '修改文字',
        selection: '未使用元素选择',
        sourceContext: '完整 Source',
        writeScope: 'whole-source · 1 个范围',
        contextTruncated: false,
        hostReferenceRequired: false,
        hostReferenceMissing: false,
        plannedAreas: ['6–12：修改文字'],
      },
      createdAt: ordinal,
    })),
    activeGenerationId: 'g2',
    materializedGenerationId: 'g2',
    pending: false,
    applying: false,
    error: null,
  }
}

function snapshotWithHostReferenceBlock(
  blockedReason:
    | 'additional-provider-consent-required'
    | 'unresolved'
    | 'context-truncated' = 'additional-provider-consent-required',
): FrontendWorkshopSourceAiSessionSnapshot {
  const current = snapshot()
  const generations = current.generations.map((generation) =>
    generation.id === 'g2'
      ? ({
          ...generation,
          status: 'needs-host-reference',
          assistantContent: '还需要本地 Host Reference',
          summary: '当前结果未写入 Source',
          unresolvedHostReferenceRequests: ['host events'],
          blockedReason,
        } satisfies FrontendWorkshopSourceAiGeneration)
      : generation,
  )
  return { ...current, generations }
}

vi.mock('../core/FrontendWorkshopContainer', () => ({
  frontendWorkshopAiLocalStorage: {
    read: mocks.readPreferences,
    write: vi.fn(async () => 1),
  },
  frontendWorkshopSourceDocumentService: { get: mocks.getDocument },
  frontendWorkshopSourceAiRequestService: { request: mocks.request },
  frontendWorkshopSourceAiSessionService: {
    subscribe: vi.fn((_projectId, listener) => {
      mocks.listener = listener
      listener(snapshot())
      return () => undefined
    }),
    previewGeneration: mocks.preview,
    applyGeneration: mocks.apply,
    selectGeneration: mocks.select,
    cancelRequest: mocks.cancel,
    deleteTurn: mocks.deleteTurn,
    deleteGeneration: mocks.deleteGeneration,
  },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }))

import FrontendWorkshopSourceAiWorkspace from './FrontendWorkshopSourceAiWorkspace.vue'
enableAutoUnmount(afterEach)
afterEach(() => vi.useRealTimers())

describe('FrontendWorkshopSourceAiWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readPreferences.mockResolvedValue(undefined)
    mocks.getPreviewPolicy.mockReturnValue({ allowRemoteResources: false })
    mocks.getDocument.mockResolvedValue(source)
    mocks.preview.mockResolvedValue({ before: source, after })
    mocks.request.mockResolvedValue({ accepted: true, status: 'completed', generationId: 'g3' })
    mocks.apply.mockResolvedValue(null)
  })

  function mountWorkspace(
    initialSelections?: readonly FrontendWorkshopResolvedSourceSelection[],
    runtimeFixIntent?: FrontendWorkshopSourceRuntimeFixIntent,
    initialInstruction?: string,
  ) {
    return mount(FrontendWorkshopSourceAiWorkspace, {
      props: { projectId: 'project', initialSelections, runtimeFixIntent, initialInstruction },
      global: {
        stubs: {
          FeatureBackButton: {
            template: '<button aria-label="返回工作台" @click="$emit(\'click\')">返回</button>',
          },
          FrontendWorkshopSourcePreview: {
            name: 'FrontendWorkshopSourcePreview',
            props: ['sourceDocument', 'networkMode', 'sizingMode', 'greetingIndex'],
            methods: { scrollBy: mocks.scrollPreview },
            template: '<div class="preview-stub">{{ sourceDocument.authorSource }}</div>',
          },
        },
      },
    })
  }

  it('opens an explicit layer action in work mode while retaining the editable instruction', async () => {
    mocks.readPreferences.mockResolvedValue({ data: { mode: 'plan' } })
    const wrapper = mountWorkspace(undefined, undefined, '请整理人物资料图层')
    await flushPromises()
    expect((wrapper.get('[aria-label="工作模式"]').element as HTMLSelectElement).value).toBe('edit')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(
      '请整理人物资料图层',
    )
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('keeps one greeting list for comparison and can return from a template jump to main', async () => {
    const withGreeting = {
      ...after,
      authorSource:
        '<main>after</main><script type="application/json" data-tavern-character>{"name":"人物","alternate_greetings":["第二幕"]}</script>',
    }
    mocks.preview.mockResolvedValue({ before: source, after: withGreeting })
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="切换修改前后对比"]').trigger('click')
    const previews = () => wrapper.findAllComponents({ name: 'FrontendWorkshopSourcePreview' })
    expect(wrapper.findAll('nav[aria-label="开场白列表"]')).toHaveLength(1)
    const tabs = wrapper.get('nav[aria-label="开场白列表"]').findAll('button')
    await tabs[1]!.trigger('click')
    expect(previews().at(-1)!.props('greetingIndex')).toBe(1)
    // The older source has no alternate: keep its main greeting visible in comparison.
    expect(previews()[0]!.props('greetingIndex')).toBe(0)
    await tabs[0]!.trigger('click')
    expect(previews().at(-1)!.props('greetingIndex')).toBe(0)
    previews().at(-1)!.vm.$emit('greetingChange', 1)
    await flushPromises()
    expect(tabs[1]!.attributes('aria-pressed')).toBe('true')
    await tabs[0]!.trigger('click')
    expect(previews().at(-1)!.props('greetingIndex')).toBe(0)
    expect(
      wrapper.find('textarea[placeholder="填写正文，也可以粘贴 HTML 或酒馆前端代码"]').exists(),
    ).toBe(false)
  })

  it('inherits and updates network policy for both previews and removes the subscription', async () => {
    mocks.getPreviewPolicy.mockReturnValue({ allowRemoteResources: true })
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="切换修改前后对比"]').trigger('click')
    const previews = () => wrapper.findAllComponents({ name: 'FrontendWorkshopSourcePreview' })
    expect(previews()).toHaveLength(2)
    expect(previews().map((item) => item.props('networkMode'))).toEqual(['host', 'host'])
    mocks.policyListener?.({ allowRemoteResources: false })
    await flushPromises()
    expect(previews().map((item) => item.props('networkMode'))).toEqual(['offline', 'offline'])
    wrapper.unmount()
    expect(mocks.stopPolicy).toHaveBeenCalledOnce()
  })

  it('discusses a plan without applying and generates only after reviewing and approving the edited prompt', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="工作模式"]').setValue('plan')
    await wrapper.get('.source-ai-workspace__composer-row textarea').setValue('帮我规划角色开场白')
    await wrapper.get('[aria-label="发送"]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'plan', writeScope: { kind: 'read-only' } }),
    )
    expect(mocks.apply).not.toHaveBeenCalled()
    const current = snapshot()
    current.generations[1]!.proposal!.edits = []
    current.generations[1]!.proposal!.generationPrompt = '制作角色档案'
    current.generations[1]!.bundle = buildFrontendWorkshopSourceAiContext({
      source,
      mode: 'plan',
      instruction: '规划',
    })
    mocks.listener?.(current)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '审阅方案与生成提示词')!
      .trigger('click')
    await wrapper.get('#workshop-plan-prompt').setValue('制作可切换三个开场白的角色档案')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '批准并生成')!
      .trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'edit', instruction: '制作可切换三个开场白的角色档案' }),
    )
    expect(mocks.apply).toHaveBeenCalledOnce()
  })

  it('scrolls both full-page comparisons while retaining the content sizing option', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    expect(
      wrapper.findComponent({ name: 'FrontendWorkshopSourcePreview' }).props('sizingMode'),
    ).toBe('viewport')
    await wrapper.get('[aria-label="切换修改前后对比"]').trigger('click')
    await wrapper
      .get('.source-ai-workspace__preview-stage')
      .trigger('wheel', { deltaY: 200, deltaX: 0, deltaMode: 0 })
    expect(mocks.scrollPreview).toHaveBeenCalledTimes(2)
    expect(mocks.scrollPreview).toHaveBeenCalledWith(0, 200, 0, 0)
    await wrapper.get('[aria-label="AI 设置"]').trigger('click')
    await wrapper.get('select:has(option[value="content"])').setValue('content')
    expect(
      wrapper
        .findAllComponents({ name: 'FrontendWorkshopSourcePreview' })
        .map((item) => item.props('sizingMode')),
    ).toEqual(['content', 'content'])
  })

  it('expands the same preview and restores the unsent composer draft', async () => {
    const wrapper = mountWorkspace()
    document.body.append(wrapper.element)
    await flushPromises()
    await wrapper.get('textarea').setValue('未发送的修改')
    const instance = wrapper.findComponent({ name: 'FrontendWorkshopSourcePreview' }).vm
    await wrapper.get('[aria-label="放大预览"]').trigger('click')
    expect(wrapper.classes()).toContain('is-preview-expanded')
    expect(wrapper.findComponent({ name: 'FrontendWorkshopSourcePreview' }).vm).toBe(instance)
    expect(wrapper.get('.source-ai-workspace__composer').isVisible()).toBe(false)
    await wrapper.get('[aria-label="收起预览"]').trigger('click')
    expect(wrapper.get('.source-ai-workspace__composer').isVisible()).toBe(true)
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('未发送的修改')
  })

  it('失败回复显示单次修复入口并发送 repair 而非 regenerate', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const current = snapshot()
    current.generations = current.generations.map((generation) =>
      generation.id === 'g2'
        ? {
            ...generation,
            status: 'failed',
            proposal: null,
            bundle: buildFrontendWorkshopSourceAiContext({
              source,
              mode: 'edit',
              instruction: '把文字改掉',
            }),
            receipts: [{ id: 'raw', rawText: '{broken', status: 'invalid' }],
          }
        : generation,
    )
    mocks.listener?.(current)
    await flushPromises()
    const button = wrapper.findAll('button').find((item) => item.text().includes('修复这份回复'))!
    expect(button.text()).toContain('调用 1 次 AI')
    await button.trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ session: { kind: 'repair', generationId: 'g2' } }),
    )
  })

  it('呈现正式 Header、实时预览、自由 Divider、左右消息与固定 Composer', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    expect(wrapper.get('.source-ai-workspace__header').text()).toContain('肘肘更健康')
    expect(wrapper.find('.source-ai-workspace__divider').exists()).toBe(true)
    expect(wrapper.get('.source-ai-message.is-user').text()).toContain('把文字改掉')
    expect(wrapper.get('.source-ai-message.is-assistant').text()).toContain('第 2 个结果')
    expect(wrapper.find('.source-ai-workspace__composer textarea').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('应用修改')
  })

  it('只有开启联网后才把版本和额外调用预算交给共享请求服务', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="AI 设置"]').trigger('click')
    const toggle = wrapper
      .findAll('label')
      .find((label) => label.text().includes('按需联网查接口'))!
    expect((toggle.get('input').element as HTMLInputElement).checked).toBe(false)
    await toggle.get('input').setValue(true)
    await wrapper.get('[aria-label="酒馆助手资料版本"]').setValue('4.9.5')
    const budget = wrapper
      .findAll('label')
      .find((label) => label.text().includes('每次最多额外调用 AI'))!
    await budget.get('input').setValue('7')
    await wrapper.get('.source-ai-workspace__composer textarea').setValue('读取角色资料')
    await wrapper.get('.source-ai-workspace__send').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostResearch: {
          maxAdditionalRequests: 7,
          tavernHelperVersion: '4.9.5',
          sillyTavernVersion: '1.18.0',
        },
      }),
    )
  })

  it('Provider 提供 reasoning 时显示真实内容，否则保留结构化诊断', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const initial = snapshot()
    const generations = initial.generations.map((generation) =>
      generation.id === 'g2'
        ? {
            ...generation,
            diagnostics: {
              ...generation.diagnostics!,
              providerReasoning: '先核对 Source，再限制 Write Scope。',
            },
          }
        : generation,
    )
    mocks.listener?.({ ...initial, generations })
    await flushPromises()

    await wrapper.get('[aria-label="查看思考"]').trigger('click')
    const thought = wrapper.get('.source-ai-message__details.is-thought')
    expect(thought.text()).toContain('先核对 Source，再限制 Write Scope。')
    expect(thought.text()).not.toContain('Source Context')
  })

  it('用左右分屏 SVG 开启中线对比，长按后才拖动分隔线', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const toggle = wrapper.get('[aria-label="切换修改前后对比"]')
    expect(toggle.get('svg.source-ai-workspace__compare-icon rect').attributes()).toMatchObject({
      x: '3',
      width: '18',
    })
    expect(toggle.get('svg path').attributes('d')).toContain('M12 4v16')
    expect(wrapper.find('.source-ai-workspace__compare-divider').exists()).toBe(false)
    await toggle.trigger('click')
    const viewport = wrapper.get('.source-ai-workspace__preview-viewport')
    vi.spyOn(viewport.element, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    })
    const divider = wrapper.get('.source-ai-workspace__compare-divider')
    vi.useFakeTimers()
    dispatchPointer(divider.element, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 })
    dispatchPointer(divider.element, 'pointermove', { pointerId: 1, clientX: 112, clientY: 106 })
    await vi.advanceTimersByTimeAsync(330)
    dispatchPointer(divider.element, 'pointermove', { pointerId: 1, clientX: 150, clientY: 100 })
    await wrapper.vm.$nextTick()
    expect(divider.attributes('aria-valuenow')).toBe('75')
    expect(wrapper.get('.source-ai-workspace__preview-content').attributes('style')).toContain(
      'translate3d(0px, 0px, 0)',
    )
    dispatchPointer(divider.element, 'pointerup', { pointerId: 1 })
    vi.useRealTimers()
  })

  it('随内容展开时对比拖动仍平移共同预览范围', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="AI 设置"]').trigger('click')
    await wrapper.get('select:has(option[value="content"])').setValue('content')
    await wrapper.get('[aria-label="AI 设置"]').trigger('click')
    await wrapper.get('[aria-label="切换修改前后对比"]').trigger('click')
    const stage = wrapper.get('.source-ai-workspace__preview-stage')
    dispatchPointer(stage.element, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 100 })
    dispatchPointer(stage.element, 'pointermove', { pointerId: 2, clientX: 124, clientY: 132 })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.source-ai-workspace__preview-content').attributes('style')).toContain(
      'translate3d(24px, 32px, 0)',
    )
    expect(wrapper.get('.source-ai-workspace__compare-divider').attributes('aria-valuenow')).toBe(
      '50',
    )
  })

  it('切换 sibling generation 只选择 generation 并刷新对应 Preview', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('[aria-label="上一个生成"]').trigger('click')
    expect(mocks.select).toHaveBeenCalledWith('project', 'g1')
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('删除早期 sibling 后按当前顺序显示与切换 generation', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const initial = snapshot()
    const value: FrontendWorkshopSourceAiSessionSnapshot = {
      ...initial,
      turns: [{ ...initial.turns[0]!, generationIds: ['g2', 'g3'] }],
      generations: [2, 3].map((ordinal) => ({
        ...initial.generations[0]!,
        id: `g${ordinal}`,
        ordinal,
        assistantContent: `第 ${ordinal} 个结果`,
      })),
      activeGenerationId: 'g3',
      materializedGenerationId: 'g3',
    }
    mocks.listener?.(value)
    await flushPromises()

    expect(wrapper.get('.source-ai-message__generations').text()).toContain('2 / 2')
    expect(wrapper.get('[aria-label="上一个生成"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="下一个生成"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[aria-label="上一个生成"]').trigger('click')
    expect(mocks.select).toHaveBeenCalledWith('project', 'g2')
  })

  it('发送修改即在 proposal 完成后调用唯一 Session application，不显示旧 Apply 卡', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    await wrapper.get('textarea').setValue('圆角再大一点')
    await wrapper.get('[aria-label="发送"]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        instruction: '圆角再大一点',
        mode: 'edit',
      }),
    )
    expect(mocks.apply).toHaveBeenCalledWith('project', 'g3', { label: 'AI 修改' })
  })

  it('Runtime 修复入口自动以真实 error 与 Diagnostics 发起 runtime-fix generation', async () => {
    const wrapper = mountWorkspace(undefined, {
      projectId: 'project',
      sourceRevision: 1,
      sourceCreatedAt: 100,
      runtimeError: { kind: 'script-error', message: 'refresh is not defined' },
      diagnostics: [
        {
          id: 'runtime:error',
          category: 'runtime',
          severity: 'error',
          title: 'Runtime 错误',
          message: 'refresh is not defined',
        },
      ],
    })
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        mode: 'runtime-fix',
        instruction: '修复当前运行错误，并保持现有功能与视觉不变。',
        writeScope: { kind: 'whole-source' },
        runtimeError: { kind: 'script-error', message: 'refresh is not defined' },
        runtimeDiagnostics: [expect.objectContaining({ category: 'runtime', severity: 'error' })],
      }),
    )
    expect(mocks.apply).toHaveBeenCalledWith('project', 'g3', { label: 'AI 修复运行错误' })
    expect(wrapper.find('.source-ai-workspace').exists()).toBe(true)
  })

  it('Runtime 修复 intent 的 Source revision 过期时 fail closed', async () => {
    const wrapper = mountWorkspace(undefined, {
      projectId: 'project',
      sourceRevision: 9,
      sourceCreatedAt: 100,
      runtimeError: { kind: 'script-error', message: 'stale' },
      diagnostics: [
        {
          id: 'runtime:error',
          category: 'runtime',
          severity: 'error',
          title: 'Runtime 错误',
          message: 'stale',
        },
      ],
    })
    await flushPromises()

    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('运行错误对应的 Source revision 已变化')
  })

  it('重新生成 Runtime 修复时复用同一 bundle 的 error、Diagnostics 与 base generation', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const runtimeBundle = buildFrontendWorkshopSourceAiContext({
      source,
      mode: 'runtime-fix',
      instruction: '修复当前运行错误，并保持现有功能与视觉不变。',
      writeScope: { kind: 'whole-source' },
      runtimeError: { kind: 'script-error', message: 'refresh is not defined' },
      runtimeDiagnostics: [
        {
          category: 'runtime',
          severity: 'error',
          title: 'Runtime 错误',
          message: 'refresh is not defined',
        },
      ],
    })
    const current = snapshot()
    mocks.listener?.({
      ...current,
      generations: current.generations.map((generation) =>
        generation.id === 'g2' ? { ...generation, bundle: runtimeBundle } : generation,
      ),
    })
    await flushPromises()
    const regenerateButton = wrapper
      .findAll('button')
      .find((button) => button.text().trim() === '重新生成')
    if (!regenerateButton) throw new Error('missing regenerate button')
    await regenerateButton.trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'runtime-fix',
        runtimeError: { kind: 'script-error', message: 'refresh is not defined' },
        runtimeDiagnostics: [expect.objectContaining({ category: 'runtime' })],
        session: { kind: 'regenerate', generationId: 'g2' },
      }),
    )
  })

  it('普通 generation 保留普通重新生成，不显示额外 Provider consent action', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()

    expect(wrapper.find('[aria-label="补充资料并继续，额外使用 1 次 AI 请求"]').exists()).toBe(
      false,
    )
    expect(wrapper.findAll('button').some((button) => button.text().trim() === '重新生成')).toBe(
      true,
    )
  })

  it('只有准确的 Host Reference 阻塞状态显示 +1 action，未点击不发请求，点击最多一次', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    mocks.listener?.(snapshotWithHostReferenceBlock())
    await flushPromises()

    const consent = wrapper.get('[aria-label="补充资料并继续，额外使用 1 次 AI 请求"]')
    expect(consent.text()).toContain('补充资料并继续')
    expect(consent.text()).toContain('额外使用 1 次 AI 请求')
    expect(wrapper.findAll('button').some((button) => button.text().trim() === '重新生成')).toBe(
      false,
    )
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()

    await consent.trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { kind: 'regenerate', generationId: 'g2' },
      }),
    )
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })

  it('Host Reference continuation 失败后不自动 retry', async () => {
    mocks.request.mockRejectedValueOnce(new Error('fixture-provider-failure'))
    const wrapper = mountWorkspace()
    await flushPromises()
    mocks.listener?.(snapshotWithHostReferenceBlock())
    await flushPromises()

    await wrapper.get('[aria-label="补充资料并继续，额外使用 1 次 AI 请求"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('fixture-provider-failure')
  })

  it('不匹配 blockedReason 时不冒充额外 Provider consent action', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    mocks.listener?.(snapshotWithHostReferenceBlock('unresolved'))
    await flushPromises()

    expect(wrapper.find('[aria-label="补充资料并继续，额外使用 1 次 AI 请求"]').exists()).toBe(
      false,
    )
    expect(wrapper.findAll('button').some((button) => button.text().trim() === '重新生成')).toBe(
      true,
    )
  })

  it('从精确选中进入时用完整外层元素作为唯一 Write Scope 与聚焦预览', async () => {
    const selection: FrontendWorkshopResolvedSourceSelection = {
      projectId: 'project',
      sourceRevision: 1,
      instanceId: 'runtime',
      runtimeNonce: 'nonce',
      runtimeNodeId: 'node',
      tagName: 'main',
      elementId: 'content',
      treeScope: 'document',
      mappingConfidence: 'exact',
      provenanceKind: 'static-source',
      sourceRange: { start: 0, end: 6 },
    }
    const wrapper = mountWorkspace([selection])
    await flushPromises()

    expect(wrapper.get('.source-ai-workspace__preview-header').text()).toContain('main#content')
    expect(wrapper.get('.preview-stub').text()).toContain('data-srl-ai-preview-focus')
    await wrapper.get('textarea').setValue('只改这个组件')
    await wrapper.get('[aria-label="发送"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit-selection',
        selections: [selection],
        writeScope: { kind: 'ranges', ranges: [{ start: 0, end: source.authorSource.length }] },
      }),
    )
  })

  it('多选元素进入时建立多个互不相邻 Write Scope 并同时聚焦 Preview', async () => {
    const authorSource =
      '<main><section id="one">一</section><aside>间隔</aside><section id="two">二</section></main>'
    const multiSource = createFrontendWorkshopSourceDocument('project', authorSource, 100)
    mocks.getDocument.mockResolvedValue(multiSource)
    const firstStart = authorSource.indexOf('<section id="one"')
    const firstStartEnd = authorSource.indexOf('>', firstStart) + 1
    const firstEnd = authorSource.indexOf('</section>') + '</section>'.length
    const secondStart = authorSource.indexOf('<section id="two"')
    const secondStartEnd = authorSource.indexOf('>', secondStart) + 1
    const secondEnd = authorSource.lastIndexOf('</section>') + '</section>'.length
    const selections: FrontendWorkshopResolvedSourceSelection[] = [
      {
        projectId: 'project',
        sourceRevision: 1,
        instanceId: 'runtime',
        runtimeNonce: 'nonce',
        runtimeNodeId: 'one',
        tagName: 'section',
        elementId: 'one',
        treeScope: 'document',
        mappingConfidence: 'exact',
        provenanceKind: 'static-source',
        sourceRange: { start: firstStart, end: firstStartEnd },
      },
      {
        projectId: 'project',
        sourceRevision: 1,
        instanceId: 'runtime',
        runtimeNonce: 'nonce',
        runtimeNodeId: 'two',
        tagName: 'section',
        elementId: 'two',
        treeScope: 'document',
        mappingConfidence: 'exact',
        provenanceKind: 'static-source',
        sourceRange: { start: secondStart, end: secondStartEnd },
      },
    ]
    const wrapper = mountWorkspace(selections)
    await flushPromises()

    expect(wrapper.get('.source-ai-workspace__preview-header').text()).toContain('已选 2 个')
    expect(
      wrapper
        .get('.preview-stub')
        .text()
        .match(/data-srl-ai-preview-focus=/gu),
    ).toHaveLength(2)
    await wrapper.get('textarea').setValue('同时改这两个组件')
    await wrapper.get('[aria-label="发送"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit-selection',
        selections,
        writeScope: {
          kind: 'ranges',
          ranges: [
            { start: firstStart, end: firstEnd },
            { start: secondStart, end: secondEnd },
          ],
        },
      }),
    )
  })

  it('中文候选确认不提前发送指令或清空草稿', async () => {
    const wrapper = mountWorkspace()
    await flushPromises()
    const input = wrapper.get('textarea')
    await input.setValue('调整中文标题')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input.element.dispatchEvent(composing)
    await flushPromises()
    expect(mocks.request).not.toHaveBeenCalled()
    expect((input.element as HTMLTextAreaElement).value).toBe('调整中文标题')
    expect(composing.defaultPrevented).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: '调整中文标题' }),
    )
  })

  it('通过 SVG 加号选择参考图片并随当前请求发送', async () => {
    const wrapper = mountWorkspace()
    const input = wrapper.get('input[type="file"]')
    const file = new File(['x'], 'reference.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await vi.waitFor(() => {
      expect(wrapper.find('.source-ai-workspace__attachments img').exists()).toBe(true)
    })
    await wrapper.get('textarea').setValue('参考图片调整布局')
    await wrapper.get('[aria-label="发送"]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: '参考图片调整布局',
        referenceImages: [
          expect.objectContaining({ name: 'reference.png', mimeType: 'image/png', size: 1 }),
        ],
      }),
    )
  })
})
