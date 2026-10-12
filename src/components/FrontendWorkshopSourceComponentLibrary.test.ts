/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFrontendWorkshopSourceComponent } from '../types/FrontendWorkshopSourceComponent'
import { createFrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import FrontendWorkshopSourceComponentLibrary from './FrontendWorkshopSourceComponentLibrary.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  insertIntoProject: vi.fn(),
  duplicate: vi.fn(),
  removeFromProject: vi.fn(),
  createPortablePackage: vi.fn(),
  createPortablePackageAtRevision: vi.fn(),
  importPortablePackage: vi.fn(),
  updateAtRevision: vi.fn(),
  createFromAiProposal: vi.fn(),
  applyAiProposalAtRevision: vi.fn(),
  requestAiProposal: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
  downloadBlob: vi.fn(),
}))

vi.mock('../core/FrontendWorkshopContainer', () => ({
  frontendWorkshopSourceComponentService: {
    list: mocks.list,
    insertIntoProject: mocks.insertIntoProject,
    duplicate: mocks.duplicate,
    removeFromProject: mocks.removeFromProject,
    createPortablePackage: mocks.createPortablePackage,
    createPortablePackageAtRevision: mocks.createPortablePackageAtRevision,
    importPortablePackage: mocks.importPortablePackage,
    updateAtRevision: mocks.updateAtRevision,
    createFromAiProposal: mocks.createFromAiProposal,
    applyAiProposalAtRevision: mocks.applyAiProposalAtRevision,
    delete: mocks.delete,
  },
  frontendWorkshopSourceAiHostReferenceService: {
    request: mocks.requestAiProposal,
  },
}))

vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: mocks.confirm }))
vi.mock('../utils/LibraryFormatting', () => ({ downloadBlob: mocks.downloadBlob }))

function sourceDocument(revision = 1) {
  const source = createFrontendWorkshopSourceDocument(
    'project-1',
    '<body><article id="card">卡片</article></body>',
    10,
  )
  source.revision = revision
  return source
}

function component(projectIds: string[] = []) {
  return createFrontendWorkshopSourceComponent(
    {
      name: '人物卡',
      description: '角色信息折叠栏',
      source: { html: '<article>卡片</article>', css: '', javascript: '' },
      root: { tagName: 'article' },
      provenance: { origin: 'project-selection' },
      projectIds,
    },
    'component-1',
    10,
  )
}

function completedAiRequest(source: { projectId: string; revision: number; authorSource: string }) {
  const htmlStart = source.authorSource.indexOf('<article>')
  return {
    status: 'completed' as const,
    attempts: [
      {
        bundle: {
          projectId: source.projectId,
          sourceRevision: source.revision,
          sourceCreatedAt: 10,
        },
        result: {
          proposal: {
            kind: 'source-ai-proposal' as const,
            projectId: source.projectId,
            sourceRevision: source.revision,
            summary: '完成组件修改',
            edits: [
              {
                start: Math.max(0, htmlStart),
                end: Math.max(0, htmlStart),
                expectedText: '',
                replacement: '<span>AI</span>',
                reason: '测试修改',
              },
            ],
            hostReferenceRequests: [],
            warnings: [],
          },
        },
      },
    ],
    resolvedReferences: [],
  }
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset())
  mocks.list.mockResolvedValue([])
  mocks.confirm.mockResolvedValue(true)
})

describe('FrontendWorkshopSourceComponentLibrary', () => {
  it('默认展示当前组件，并把真实 AI 生成与导入收进右上角添加菜单', async () => {
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()

    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('input[type="file"]').attributes('hidden')).toBeDefined()
    expect(wrapper.get('[aria-label="组件范围"] button.is-active').text()).toContain('当前组件')
    expect(wrapper.get('[aria-label="当前组件"]').text()).toContain('当前项目还没有组件')
    expect(wrapper.find('[aria-label="添加组件方式"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('项目组件')

    await wrapper.get('[aria-label="添加组件"]').trigger('click')
    expect(wrapper.get('[aria-label="添加组件方式"]').text()).toContain('AI 生成')
    expect(wrapper.get('[aria-label="添加组件方式"]').text()).toContain('导入')
    await wrapper.get('[aria-label="添加组件方式"] > button').trigger('click')
    expect(wrapper.text()).toContain('AI 生成组件')
    expect(wrapper.find('[aria-label="AI 生成组件"] textarea').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('待接入')
  })

  it('通过现有 Source AI proposal owner 生成组件并保存到我的组件', async () => {
    const generated = component()
    generated.id = 'component-generated'
    generated.name = 'AI 折叠栏'
    generated.provenance = { origin: 'ai' }
    mocks.requestAiProposal.mockImplementation(({ source }) =>
      Promise.resolve(completedAiRequest(source)),
    )
    mocks.createFromAiProposal.mockResolvedValue(generated)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper.get('[aria-label="添加组件"]').trigger('click')
    await wrapper.get('[aria-label="添加组件方式"] > button').trigger('click')

    const form = wrapper.get('[aria-label="AI 生成组件"]')
    await form.get('input').setValue('AI 折叠栏')
    await form.get('textarea').setValue('生成一个可展开角色资料的折叠栏')
    await form.trigger('submit')
    await flushPromises()

    expect(mocks.requestAiProposal).toHaveBeenCalledOnce()
    expect(mocks.createFromAiProposal).toHaveBeenCalledOnce()
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('AI 折叠栏')
    expect(wrapper.emitted('status')).toEqual([['已生成组件“AI 折叠栏”，并保存到我的组件。']])
  })

  it('组件 AI 缺少 Host Reference 时 fail closed，不创建组件', async () => {
    mocks.requestAiProposal.mockResolvedValue({
      status: 'needs-host-reference',
      attempts: [],
      resolvedReferences: [],
      unresolvedRequests: ['TavernHelper.someUnknownApi'],
      retryExhausted: false,
      blockedReason: 'unresolved',
    })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper.get('[aria-label="添加组件"]').trigger('click')
    await wrapper.get('[aria-label="添加组件方式"] > button').trigger('click')
    const form = wrapper.get('[aria-label="AI 生成组件"]')
    await form.get('input').setValue('Host 组件')
    await form.get('textarea').setValue('调用一个未知酒馆接口')
    await form.trigger('submit')
    await flushPromises()

    expect(mocks.createFromAiProposal).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toContain('缺少可验证的 Host Reference')
  })

  it('当前组件只提供快速使用、查看和移出当前项目', async () => {
    const saved = component(['project-1'])
    mocks.list.mockResolvedValue([saved])
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()

    const card = wrapper.get('.frontend-workshop-source-components__list article')
    expect(card.text()).toContain('快速使用')
    expect(card.text()).toContain('查看')
    expect(card.text()).toContain('移出当前项目')
    expect(card.text()).not.toContain('插入')
    expect(card.text()).not.toMatch(/(^|\s)删除($|\s)/u)

    await card
      .findAll('button')
      .find((button) => button.text() === '快速使用')!
      .trigger('click')
    expect(wrapper.emitted('quickUse')).toEqual([[saved.id]])
  })

  it('列表和详情复用正式 Source Runtime 显示当前组件 revision', async () => {
    const saved = component(['project-1'])
    saved.revision = 3
    saved.preview = { viewportWidth: 375, colorScheme: 'dark' }
    mocks.list.mockResolvedValue([saved])
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument(), networkMode: 'host' },
    })
    await flushPromises()

    const cardPreview = wrapper.get('[aria-label="人物卡组件预览"]')
    expect(cardPreview.find('.frontend-workshop-source-preview').exists()).toBe(true)
    expect(cardPreview.text()).not.toContain('暂无预览')

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')
    const detailPreview = wrapper.get('[aria-label="人物卡运行预览"]')
    expect(detailPreview.attributes('style')).toContain('max-width: 375px')
    expect(detailPreview.find('.frontend-workshop-source-preview').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('组件预览待接入')
  })

  it('移出当前项目只解除项目收录，不调用个人组件删除', async () => {
    const saved = component(['project-1'])
    mocks.list.mockResolvedValueOnce([saved]).mockResolvedValueOnce([])
    mocks.removeFromProject.mockResolvedValue({ ...saved, projectIds: [] })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()

    await wrapper.get('button.is-danger').trigger('click')
    await flushPromises()

    expect(mocks.removeFromProject).toHaveBeenCalledWith(saved.id, 'project-1')
    expect(mocks.delete).not.toHaveBeenCalled()
    expect(wrapper.emitted('projectComponentsChanged')).toHaveLength(1)
    expect(wrapper.get('[aria-label="当前组件"]').text()).toContain('当前项目还没有组件')
  })

  it('我的组件插入成功后接收 Source revision 并刷新当前组件', async () => {
    const saved = component()
    const next = sourceDocument(2)
    next.authorSource = '<body><article>卡片</article></body>'
    mocks.list.mockResolvedValue([saved])
    mocks.insertIntoProject.mockResolvedValue({
      document: next,
      projectAssociationUpdated: true,
    })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper.get('[data-component-scope="mine"]').trigger('click')

    const card = wrapper.get('.frontend-workshop-source-components__list article')
    expect(card.text()).toContain('插入')
    expect(card.text()).toContain('查看')
    expect(card.text()).toContain('删除')
    expect(card.text()).not.toContain('快速使用')
    await card
      .findAll('button')
      .find((button) => button.text() === '插入')!
      .trigger('click')
    await flushPromises()

    expect(mocks.insertIntoProject).toHaveBeenCalledWith(saved.id, 'project-1', 1)
    expect(wrapper.emitted('revisionAccepted')).toEqual([
      [next, '已插入组件“人物卡”，并加入当前组件；可从历史记录撤销'],
    ])
    expect(wrapper.emitted('projectComponentsChanged')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('查看进入真实组件详情，不在列表堆技术元数据', async () => {
    mocks.list.mockResolvedValue([component(['project-1'])])
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    const detail = wrapper.get('[aria-label="组件详情"]')
    expect(detail.text()).toContain('人物卡')
    expect(detail.text()).toContain('来源')
    expect(detail.text()).toContain('素材')
    expect(detail.text()).toContain('复制到我的组件')
    expect(detail.text()).toContain('导出组件')
  })

  it('详情 AI 修改在 proposal 验证后通过当前 component revision CAS', async () => {
    const saved = component(['project-1'])
    saved.dependencies = [
      { kind: 'external-resource', specifier: 'https://cdn.example/avatar.png' },
    ]
    const updated = {
      ...saved,
      revision: 2,
      source: { ...saved.source, html: '<article>AI 已修改</article>' },
    }
    mocks.list.mockResolvedValue([saved])
    mocks.requestAiProposal.mockImplementation(({ source }) =>
      Promise.resolve(completedAiRequest(source)),
    )
    mocks.applyAiProposalAtRevision.mockResolvedValue(updated)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    const form = wrapper.get('[aria-label="AI 修改组件"]')
    await form.get('textarea').setValue('把卡片标题改短')
    await form.trigger('submit')
    await flushPromises()

    expect(mocks.applyAiProposalAtRevision).toHaveBeenCalledWith(
      saved.id,
      saved.revision,
      expect.any(Object),
      expect.objectContaining({ summary: '完成组件修改' }),
    )
    expect(mocks.requestAiProposal.mock.calls[0]?.[0]?.instruction).toContain(
      '可用素材直链：https://cdn.example/avatar.png',
    )
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('v2')
    expect(wrapper.emitted('status')).toEqual([['已用 AI 更新组件“人物卡”到 v2。']])
  })

  it('从详情经唯一 ComponentService 校验并下载 portable package', async () => {
    const saved = component(['project-1'])
    const blob = new Blob(['zip'], { type: 'application/zip' })
    mocks.list.mockResolvedValue([saved])
    mocks.createPortablePackage.mockResolvedValue({
      blob,
      fileName: '人物卡.srlcomponent.zip',
      manifest: {},
    })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')
    await wrapper
      .findAll('[aria-label="组件详情"] button')
      .find((button) => button.text() === '导出组件')!
      .trigger('click')
    await flushPromises()

    expect(mocks.createPortablePackage).toHaveBeenCalledWith(saved.id)
    expect(mocks.downloadBlob).toHaveBeenCalledWith(blob, '人物卡.srlcomponent.zip')
    expect(wrapper.emitted('status')).toEqual([['已导出组件“人物卡”。']])
  })

  it('在一个 component revision 中保存依赖与运行需求 metadata', async () => {
    const saved = component(['project-1'])
    saved.dependencies = [
      { kind: 'host-api', specifier: 'TavernHelper.getChatMessages', optional: false },
    ]
    saved.runtimeRequirements = {
      hostProfile: 'tavern-helper-message',
      requiresJavaScript: false,
      requiresNetwork: false,
      hostApis: ['getChatMessages'],
    }
    const updated = { ...saved, revision: 2 }
    mocks.list.mockResolvedValue([saved])
    mocks.updateAtRevision.mockResolvedValue(updated)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    const runtime = wrapper.get('[aria-label="依赖与运行需求"]')
    await runtime
      .findAll('button')
      .find((button) => button.text() === '添加依赖')!
      .trigger('click')
    await runtime.get('[aria-label="依赖 2 类型"]').setValue('component')
    await runtime.get('[aria-label="依赖 2 标识"]').setValue('  shared-card  ')
    await runtime.findAll('input[type="checkbox"]')[1]!.setValue(true)
    await runtime.findAll('input[type="checkbox"]')[2]!.setValue(true)
    await runtime.findAll('input[type="checkbox"]')[3]!.setValue(true)
    await runtime.get('textarea').setValue('getChatMessages\n getVariables, getVariables')
    await runtime.trigger('submit')
    await flushPromises()

    expect(mocks.updateAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencies: [
          { kind: 'host-api', specifier: 'TavernHelper.getChatMessages' },
          { kind: 'component', specifier: 'shared-card', optional: true },
        ],
        runtimeRequirements: {
          hostProfile: 'tavern-helper-message',
          requiresJavaScript: true,
          requiresNetwork: true,
          hostApis: ['getChatMessages', 'getVariables'],
        },
      }),
      saved.revision,
    )
    expect(wrapper.emitted('status')).toEqual([['已更新组件“人物卡”的运行需求。']])
  })

  it('保存组件新版本后清除该组件的旧预览错误', async () => {
    const saved = component(['project-1'])
    mocks.list.mockResolvedValue([saved])
    mocks.updateAtRevision.mockResolvedValue({ ...saved, revision: 2 })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
      global: { stubs: { FrontendWorkshopSourcePreview: true } },
    })
    await flushPromises()
    wrapper.findComponent({ name: 'FrontendWorkshopSourcePreview' }).vm.$emit('runtime-error', {
      message: '旧版本预览失败',
    })
    await flushPromises()
    expect(wrapper.get('[aria-label="当前组件"]').text()).toContain('预览不可用')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')
    await wrapper.get('[aria-label="依赖与运行需求"]').trigger('submit')
    await flushPromises()
    expect(mocks.updateAtRevision).toHaveBeenCalledOnce()
    expect(wrapper.get('[aria-label="组件详情"]').text()).not.toContain('旧版本预览失败')
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('v2')
    wrapper.unmount()
  })

  it('依赖标识为空时不允许提交组件 metadata', async () => {
    const saved = component(['project-1'])
    mocks.list.mockResolvedValue([saved])
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    const runtime = wrapper.get('[aria-label="依赖与运行需求"]')
    await runtime
      .findAll('button')
      .find((button) => button.text() === '添加依赖')!
      .trigger('click')
    const save = runtime.findAll('button').find((button) => button.text() === '保存运行需求')!

    expect(save.attributes('disabled')).toBeDefined()
    await runtime.trigger('submit')
    await flushPromises()
    expect(mocks.updateAtRevision).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toContain('依赖标识不能为空')
  })

  it('从右上角导入真实组件包并进入新组件详情', async () => {
    const imported = component()
    imported.id = 'component-imported'
    imported.name = '导入人物卡'
    imported.provenance = { origin: 'imported' }
    mocks.importPortablePackage.mockResolvedValue(imported)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper.get('[aria-label="添加组件"]').trigger('click')

    const fileInput = wrapper.get('[aria-label="选择 Source Component 组件包"]')
    const inputClick = vi.spyOn(fileInput.element as HTMLInputElement, 'click')
    await wrapper
      .findAll('[aria-label="添加组件方式"] > button')
      .find((button) => button.text().includes('导入'))!
      .trigger('click')
    expect(inputClick).toHaveBeenCalledOnce()

    const file = new File(['PK'], 'component.srlcomponent.zip', { type: 'application/zip' })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await flushPromises()

    expect(mocks.importPortablePackage).toHaveBeenCalledWith(file)
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('导入人物卡')
    expect(wrapper.emitted('status')).toEqual([['已导入组件“导入人物卡”。']])
    expect(imported.projectIds).toEqual([])
  })

  it('在详情通过组件 revision CAS 保存真实授权与分享 metadata', async () => {
    const saved = component(['project-1'])
    const updated = {
      ...saved,
      revision: 2,
      sharePolicy: {
        license: 'mit' as const,
        allowShare: true,
        allowDerivatives: true,
        notice: '保留作者说明',
      },
    }
    mocks.list.mockResolvedValue([saved])
    mocks.updateAtRevision.mockResolvedValue(updated)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    const policy = wrapper.get('[aria-label="授权与分享"]')
    await policy.get('select').setValue('mit')
    await policy.findAll('input[type="checkbox"]')[0]!.setValue(true)
    await policy.get('textarea').setValue('保留作者说明')
    await policy.trigger('submit')
    await flushPromises()

    expect(mocks.updateAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        id: saved.id,
        revision: saved.revision,
        sharePolicy: {
          license: 'mit',
          allowShare: true,
          allowDerivatives: true,
          notice: '保留作者说明',
        },
      }),
      saved.revision,
    )
    expect(() => structuredClone(mocks.updateAtRevision.mock.calls[0]?.[0])).not.toThrow()
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('v2')
    expect(wrapper.emitted('status')).toEqual([['已更新组件“人物卡”的授权设置。']])
  })

  it('在详情中通过 ComponentService revision CAS 保存 HTTPS 素材直链', async () => {
    const saved = component(['project-1'])
    const updated = {
      ...saved,
      revision: 2,
      dependencies: [
        { kind: 'external-resource' as const, specifier: 'https://cdn.example/avatar.png' },
      ],
      runtimeRequirements: { ...saved.runtimeRequirements, requiresNetwork: true },
    }
    mocks.list.mockResolvedValue([saved])
    mocks.updateAtRevision.mockResolvedValue(updated)
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    await wrapper
      .get('[aria-label="组件素材 HTTPS 直链"]')
      .setValue('https://cdn.example/avatar.png')
    await wrapper.get('.frontend-workshop-source-components__asset-editor').trigger('submit')
    await flushPromises()

    expect(mocks.updateAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencies: [
          {
            kind: 'external-resource',
            specifier: 'https://cdn.example/avatar.png',
            optional: false,
          },
        ],
        runtimeRequirements: expect.objectContaining({ requiresNetwork: true }),
      }),
      saved.revision,
    )
    expect(wrapper.get('[aria-label="组件素材直链"]').text()).toContain(
      'https://cdn.example/avatar.png',
    )
    expect(wrapper.get('[aria-label="组件详情"]').text()).toContain('v2')
    expect(wrapper.emitted('projectComponentsChanged')).toHaveLength(1)
  })

  it('移除素材直链只更新组件元数据，不改写组件 Source', async () => {
    const saved = component(['project-1'])
    saved.revision = 3
    saved.dependencies = [
      { kind: 'external-resource', specifier: 'https://cdn.example/avatar.png' },
    ]
    mocks.list.mockResolvedValue([saved])
    mocks.updateAtRevision.mockResolvedValue({
      ...saved,
      revision: 4,
      dependencies: [],
    })
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')
    await wrapper
      .findAll('[aria-label="组件素材直链"] button')
      .find((button) => button.text() === '移除')!
      .trigger('click')
    await flushPromises()

    expect(mocks.updateAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({ dependencies: [], source: saved.source }),
      saved.revision,
    )
    expect(wrapper.get('[aria-label="组件素材直链"]').text()).toContain('还没有素材直链')
    expect(wrapper.emitted('projectComponentsChanged')).toHaveLength(1)
  })

  it('非 HTTPS 素材直链 fail closed，不写组件元数据', async () => {
    const saved = component(['project-1'])
    mocks.list.mockResolvedValue([saved])
    const wrapper = mount(FrontendWorkshopSourceComponentLibrary, {
      props: { sourceDocument: sourceDocument() },
    })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看')!
      .trigger('click')

    await wrapper
      .get('[aria-label="组件素材 HTTPS 直链"]')
      .setValue('http://cdn.example/avatar.png')
    await wrapper.get('.frontend-workshop-source-components__asset-editor').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="status"]').text()).toContain('必须使用 HTTPS')
    expect(mocks.updateAtRevision).not.toHaveBeenCalled()
    expect(wrapper.emitted('projectComponentsChanged')).toBeUndefined()
  })

  it('复用公共弹窗与玻璃变量，保留组件网格，不建立组件库私有主题', () => {
    const css = readFileSync('src/styles/FrontendWorkshopSourceComponentLibrary.css', 'utf8')
    expect(css).toContain('var(--glass-panel')
    expect(css).toContain('var(--glass-border)')
    expect(css).toContain('var(--color-accent)')
    expect(css).toContain('background: var(--dialog-background, var(--color-canvas))')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(css).not.toContain('overflow-x: auto')
    expect(css).not.toContain('--component-library-')
  })
})
