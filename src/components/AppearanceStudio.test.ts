/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=appearance-official-runtime-test-mock
vi.mock('../core/OfficialAppRuntime', () => ({
  ensurePreinstalledOfficialApps: async () => undefined,
  acquireOfficialAppUse: async () => () => {},
  officialAppService: { list: async () => [{ id: 'imageAlbum' }, { id: 'assistant' }] },
  loadOfficialApp: async (id: string) => {
    if (id === 'assistant') return (await import('./ProductAssistant.vue')).default
    throw new Error(`Unexpected test APP: ${id}`)
  },
}))
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=appearance-official-runtime-test-mock
// SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-assistant-component-test-mock
vi.mock('./ProductAssistant.vue', () => ({
  default: {
    props: ['getContext', 'execute', 'captureReference'],
    template: '<div data-testid="assistant">AI 助手</div>',
  },
}))
// SRL-PUBLIC-SYNC: END REPLACE id=appearance-assistant-component-test-mock

import { BrowserStorageService } from '../services/BrowserStorageService'
import AppearanceOriginalCssActions from './AppearanceOriginalCssActions.vue'
import AppearanceStudio from './AppearanceStudio.vue'
import ProductAssistant from './ProductAssistant.vue'
import type { AssistantRequest, AssistantReply } from '../services/ProductAssistantService'
import { appearanceTransaction } from '../core/AppearanceSafety'
vi.mock('../services/ProductAssistantScreenshot', () => ({
  captureAssistantPage: vi.fn(async () => ({
    id: 'shot',
    name: '效果.jpg',
    dataUrl: 'data:image/jpeg;base64,AA',
    result: true,
  })),
}))

describe('AppearanceStudio cabinet layout', () => {
  beforeEach(() => localStorage.clear())

  it('offers two, three and four columns and persists the selected density', async () => {
    const wrapper = mount(AppearanceStudio, {
      props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '' },
    })

    const options = wrapper.findAll('[data-cabinet-columns]')
    expect(options.map((option) => option.attributes('data-cabinet-columns'))).toEqual([
      '2',
      '3',
      '4',
    ])
    expect(wrapper.text()).toContain('收藏柜布局')

    await wrapper.get('[data-cabinet-columns="2"]').trigger('click')
    expect(new BrowserStorageService().getCabinetColumns()).toBe(2)
    expect(wrapper.get('[data-cabinet-columns="2"]').attributes('aria-checked')).toBe('true')
  })

  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-scope-availability-test
  it('offers every feature app and separates installed APPs from dormant scopes', async () => {
    const wrapper = mount(AppearanceStudio, {
      props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '' },
    })

    expect(wrapper.text()).toContain('收藏柜')
    expect(wrapper.text()).toContain('酒馆互传')
    expect(wrapper.text()).toContain('缝了么')
    expect(wrapper.text()).toContain('前端了么')
    expect(wrapper.text()).toContain('user才是老大')
    await flushPromises()
    expect(wrapper.get('[aria-label="选择要装修的界面"]').text()).toContain('生图相册')
    expect(wrapper.get('[aria-label="未安装 APP 的样式"]').text()).toContain('AI 生图')
    expect(wrapper.get('[aria-label="选择要装修的界面"]').text()).not.toContain('AI 生图')
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=appearance-scope-availability-test

  it('shares official CSS actions without passing user CSS', () => {
    const wrapper = mount(AppearanceStudio, {
      props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '.user {}' },
    })
    const actions = wrapper.findAllComponents(AppearanceOriginalCssActions)
    expect(actions).toHaveLength(2)
    expect(actions[0]!.props('scope')).toBeUndefined()
    expect(actions[1]!.props('scope')?.value).toBe('library')
    expect(wrapper.get('.appearance-panel--code > header h2').text()).toBe('自定义 CSS')
    expect(wrapper.find('.appearance-code-header-actions').exists()).toBe(false)
    expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe('.user {}')
    const placeholder = wrapper.findAll('textarea')[1]!.attributes('placeholder')
    expect(placeholder).toBe('在此填写本界面的自定义 CSS')
    expect(wrapper.emitted('save-css')).toBeUndefined()
  })

  it('offers three controlled font tiers instead of arbitrary root scaling', async () => {
    const wrapper = mount(AppearanceStudio, {
      props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '' },
    })

    const options = wrapper.findAll('[data-font-scale]')
    expect(options.map((option) => option.attributes('data-font-scale'))).toEqual([
      'small',
      'standard',
      'large',
    ])
    await wrapper.get('[data-font-scale="large"]').trigger('click')
    expect(wrapper.emitted('update:uiFontScale')?.[0]).toEqual(['large'])
  })
})
describe('AppearanceStudio AI CSS owner', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })
  it('keeps the assistant page available as a CSS target in assistant-only mode', async () => {
    const host = document.createElement('main')
    host.className = 'feature-hub'
    host.dataset.featurePage = 'assistant'
    document.body.append(host)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 390,
      height: 800,
      top: 0,
      bottom: 800,
    } as DOMRect)
    const wrapper = mount(AppearanceStudio, {
      attachTo: host,
      props: {
        theme: 'light',
        layoutMode: 'grid',
        uiFontScale: 'standard',
        customCss: '',
        assistantOnly: true,
      },
    })
    try {
      await vi.waitFor(() => expect(wrapper.findComponent(ProductAssistant).exists()).toBe(true))
      const child = wrapper.getComponent(ProductAssistant)
      const context = child.props('getContext')()
      expect(context.currentScope).toBe('app:assistant')
      expect(context.pageContext).toEqual({ title: '蒜惹菈', scope: 'app:assistant' })
      expect(context.canCaptureCurrent).toBe(true)
      expect(child.props('captureReference')).toBeTypeOf('function')
    } finally {
      wrapper.unmount()
      host.remove()
    }
  })
  async function setup() {
    const storage = new BrowserStorageService()
    const preset = {
      id: 'original',
      name: '原预设',
      globalCss: '.toolbar { color:red }',
      scopedCss: {
        library: '.resource-card { color:red }',
        details: '.resource-detail-sheet { color:blue }',
      },
      createdAt: '2026-10-02',
      updatedAt: '2026-10-02',
    }
    storage.setCustomUiPresets([preset])
    storage.setActiveCustomUiPresetId(preset.id)
    const wrapper = mount(AppearanceStudio, {
      props: {
        theme: 'light',
        layoutMode: 'grid',
        uiFontScale: 'standard',
        customCss: '',
        assistantOnly: true,
        'onSave-assistant-css': (css: string) => {
          appearanceTransaction.keep()
          appearanceTransaction.begin({
            previousCss: storage.getCustomUiCss(),
            nextCss: css,
            autoKeep: true,
            apply: () => {},
            persist: (value) => storage.setCustomUiCss(value),
          })
        },
      },
    })
    await vi.waitFor(() => expect(wrapper.findComponent(ProductAssistant).exists()).toBe(true))
    await flushPromises()
    const child = wrapper.getComponent(ProductAssistant)
    const request: AssistantRequest = { ...child.props('getContext')(), history: [] }
    const proposal: AssistantReply = {
      action: 'style',
      scope: 'library',
      answer: '浅紫',
      css: '.resource-card { background:purple }',
    }
    return {
      wrapper,
      storage,
      preset,
      child,
      proposal,
      request,
      signal: new AbortController().signal,
    }
  }
  it('reports actual appearance state without changing CSS, presets or safety state', async () => {
    const { wrapper, child, storage, request, signal, proposal } = await setup()
    const initial = {
      css: storage.getCustomUiCss(),
      presets: storage.getCustomUiPresets(),
      active: storage.getActiveCustomUiPresetId(),
    }
    const style = document.createElement('style')
    style.id = 'srl-custom-ui-style'
    style.textContent = '.diagnostic-synthetic { color:red }'
    document.head.append(style)
    const previousSafeMode = sessionStorage.getItem('srl.safeMode.session.v1')
    sessionStorage.setItem('srl.safeMode.session.v1', 'safe')
    try {
      const value = await child.props('execute')(
        { action: 'diagnose', feature: 'appearance', answer: '排查' },
        request,
        signal,
      )
      expect(value.status).toBeUndefined()
      expect(value.data).toMatchObject({
        readOnly: true,
        appInstallation: { state: 'checked' },
        appearance: {
          safeMode: true,
          selectedScope: 'library',
          hasScopedDraft: true,
          hasAppliedCss: false,
          draftMatchesApplied: false,
          draftSaved: true,
          styleElementPresent: true,
          styleHasCss: true,
          presetCount: 1,
        },
      })
      expect(JSON.stringify(value.data)).not.toMatch(
        /color:red|color:blue|原预设|globalCss|scopedCss/u,
      )
      expect({
        css: storage.getCustomUiCss(),
        presets: storage.getCustomUiPresets(),
        active: storage.getActiveCustomUiPresetId(),
      }).toEqual(initial)
      expect(wrapper.emitted('save-assistant-css')).toBeUndefined()
      expect(wrapper.emitted('save-css')).toBeUndefined()
      await child.props('execute')(proposal, request, signal)
      const current = await child.props('execute')(
        { action: 'diagnose', feature: 'appearance', answer: '再次排查' },
        request,
        signal,
      )
      expect(current.data).toMatchObject({
        appearance: { hasAppliedCss: true, draftMatchesApplied: true, hasUnsavedChanges: true },
      })
      expect(wrapper.emitted('save-assistant-css')).toHaveLength(1)
    } finally {
      style.remove()
      if (previousSafeMode === null) sessionStorage.removeItem('srl.safeMode.session.v1')
      else sessionStorage.setItem('srl.safeMode.session.v1', previousSafeMode)
      appearanceTransaction.keep()
      wrapper.unmount()
    }
  })
  it('reports app availability and refuses unknown diagnostic targets without writing', async () => {
    const { wrapper, child, request, signal, storage } = await setup()
    const value = await child.props('execute')(
      { action: 'diagnose', feature: 'apps', answer: '检查安装' },
      request,
      signal,
    )
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=appearance-assistant-app-availability-test
    expect(value.data).toMatchObject({
      appInstallation: {
        availableRegions: expect.arrayContaining([
          expect.objectContaining({ value: 'app:imageAlbum' }),
        ]),
        unavailableRegions: expect.arrayContaining([
          expect.objectContaining({ value: 'app:imageGeneration' }),
        ]),
      },
    })
    // SRL-PUBLIC-SYNC: END REPLACE id=appearance-assistant-app-availability-test
    await expect(
      child.props('execute')(
        { action: 'diagnose', feature: 'login', answer: '检查' },
        request,
        signal,
      ),
    ).rejects.toThrow('认证')
    expect(storage.getCustomUiCss()).toBe('')
    expect(wrapper.emitted('save-assistant-css')).toBeUndefined()
    wrapper.unmount()
  })
  it('routes actual trial CSS through the existing event and protects unrelated CSS and stale proposals', async () => {
    const { wrapper, child, proposal, storage, preset, request, signal } = await setup()
    const evidence = await child.props('execute')(proposal, request, signal)
    expect(evidence.status).toContain('已应用')
    expect(evidence.data!.verification).toMatchObject({
      available: false,
      visualReview: '未视觉核验',
    })
    const css = wrapper.emitted('save-assistant-css')![0]![0] as string
    expect(css).toContain('@scope (.library)')
    expect(css).toContain('background:purple')
    expect(css).toContain(preset.globalCss)
    expect(css).toContain(preset.scopedCss.details)
    expect(storage.getCustomUiPresets()).toHaveLength(1)
    expect(storage.getCustomUiPresets()[0]?.scopedCss.library).toContain('color:red')
    await expect(child.props('execute')(proposal, request, signal)).rejects.toThrow('修改')
    appearanceTransaction.keep()
    wrapper.unmount()
  })
  it('applies global CSS through the same comparison and undo transaction', async () => {
    const { wrapper, child, preset, request, signal, storage } = await setup()
    const currentRequest = { ...request, currentScope: 'library' }
    const proposal: AssistantReply = {
      action: 'global-style',
      answer: '全局换成蓝白色',
      css: '.toolbar { color:red } :root { --brand: #387da5 }',
    }
    const value = await child.props('execute')(proposal, currentRequest, signal)
    expect(value.status).toBe('已应用到全局样式')
    const applied = wrapper.emitted('save-assistant-css')![0]![0] as string
    expect(applied).toContain('--brand: #387da5')
    expect(applied).toContain(preset.scopedCss.library)
    expect(child.props('getContext')().globalCss).toContain('--brand: #387da5')
    await child.props('execute')(
      { action: 'undo', answer: '撤销全局修改' },
      { ...child.props('getContext')(), history: [] },
      signal,
    )
    expect(child.props('getContext')().globalCss).toBe(preset.globalCss)
    appearanceTransaction.keep()
    wrapper.unmount()
    expect(storage.getCustomUiPresets()).toHaveLength(1)
  })
  it('saves into the current preset with readback without creating another preset', async () => {
    const { wrapper, child, proposal, storage, preset, request, signal } = await setup()
    await child.props('execute')(proposal, request, signal)
    expect(
      (
        await child.props('execute')(
          { action: 'save', answer: '保存当前预设' },
          { ...child.props('getContext')(), history: [] },
          signal,
        )
      ).text,
    ).toContain('更新当前预设')
    const saved = storage.getCustomUiPresets()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.id).toBe(preset.id)
    expect(saved[0]?.name).toBe(preset.name)
    expect(saved[0]?.globalCss).toBe(preset.globalCss)
    expect(saved[0]?.scopedCss.details).toBe(preset.scopedCss.details)
    expect(saved[0]?.scopedCss.library).toContain('background:purple')
    expect(storage.getActiveCustomUiPresetId()).toBe(preset.id)
    appearanceTransaction.keep()
    wrapper.unmount()
  })
  it('creates a preset only through the explicit save-as-new action', async () => {
    const { wrapper, child, proposal, storage, preset, request, signal } = await setup()
    await child.props('execute')(proposal, request, signal)
    expect(
      (
        await child.props('execute')(
          { action: 'save-as-new', answer: '另存为', name: '浅紫' },
          { ...child.props('getContext')(), history: [] },
          signal,
        )
      ).text,
    ).toContain('另存为新预设')
    const saved = storage.getCustomUiPresets()
    expect(saved).toHaveLength(2)
    expect(saved[0]).toEqual(preset)
    expect(saved[1]?.name).toBe('浅紫')
    expect(saved[1]?.id).not.toBe(preset.id)
    expect(saved[1]?.scopedCss.library).toContain('background:purple')
    expect(storage.getActiveCustomUiPresetId()).toBe(saved[1]?.id)
    appearanceTransaction.keep()
    wrapper.unmount()
  })
  it('does not claim to save or apply when preset storage cannot persist', async () => {
    const { wrapper, child, storage, request, signal } = await setup()
    vi.spyOn(BrowserStorageService.prototype, 'setCustomUiPresets').mockImplementation(() => {})
    await expect(
      child.props('execute')({ action: 'save', answer: '保存当前预设' }, request, signal),
    ).rejects.toThrow('未保存成功')
    expect(wrapper.emitted('save-css')).toBeUndefined()
    expect(storage.getCustomUiPresets()).toHaveLength(1)
    wrapper.unmount()
  })
  it('restores the last edit after the temporary recovery control has closed', async () => {
    const { wrapper, child, proposal, storage, request, signal } = await setup()
    await child.props('execute')(proposal, request, signal)
    appearanceTransaction.keep()
    await child.props('execute')(proposal, { ...child.props('getContext')(), history: [] }, signal)
    expect(
      (
        await child.props('execute')(
          { action: 'undo', answer: '撤销' },
          { ...child.props('getContext')(), history: [] },
          signal,
        )
      ).text,
    ).toContain('已撤销')
    expect(storage.getCustomUiCss()).toBe('')
    expect(child.props('getContext')().css.library).toContain('color:red')
    wrapper.unmount()
  })
  it('does not overwrite an applied CSS change made while the model was working', async () => {
    const { wrapper, child, proposal, storage, request, signal } = await setup()
    storage.setCustomUiCss('.manual{color:blue}')
    await expect(child.props('execute')(proposal, request, signal)).rejects.toThrow('其它操作')
    expect(storage.getCustomUiCss()).toBe('.manual{color:blue}')
    wrapper.unmount()
  })
  it('does not update the draft or claim success when the CSS owner fails to apply', async () => {
    const { wrapper, child, proposal, request, signal } = await setup()
    await wrapper.setProps({ 'onSave-assistant-css': () => {} })
    await expect(child.props('execute')(proposal, request, signal)).rejects.toThrow('未能应用')
    expect(child.props('getContext')().css.library).toContain('color:red')
    wrapper.unmount()
  })
  it('does not show or mount the assistant chat inside the regular appearance page', async () => {
    const wrapper = mount(AppearanceStudio, {
      props: {
        theme: 'light',
        layoutMode: 'grid',
        uiFontScale: 'standard',
        customCss: '',
      },
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('让 AI 修改')
    expect(wrapper.findComponent(ProductAssistant).exists()).toBe(false)
    wrapper.unmount()
  })
  it('lists preset metadata only and applies one scope through the existing undo owner', async () => {
    const { wrapper, child, proposal, storage, preset, request, signal } = await setup()
    const list = await child.props('execute')(
      { action: 'presets', answer: '查看' },
      request,
      signal,
    )
    expect(list.data!.presets).toEqual([
      { id: preset.id, name: preset.name, scopes: ['library', 'details'] },
    ])
    expect(JSON.stringify(list)).not.toContain('color:red')
    await child.props('execute')(proposal, request, signal)
    const current = { ...child.props('getContext')(), history: [] }
    await child.props('execute')(
      { action: 'apply-preset', id: preset.id, scope: 'library', answer: '套用' },
      current,
      signal,
    )
    expect(storage.getCustomUiCss()).toContain(preset.scopedCss.library)
    expect(storage.getCustomUiCss()).toContain(preset.scopedCss.details)
    expect(storage.getCustomUiCss()).toContain(preset.globalCss)
    await child.props('execute')(
      { action: 'undo', answer: '撤销' },
      { ...child.props('getContext')(), history: [] },
      signal,
    )
    expect(child.props('getContext')().css.library).toContain('purple')
    wrapper.unmount()
  })
  it('inspects classes and colors without sending text, form values, IDs or login nodes', async () => {
    const { wrapper, child, request, signal } = await setup()
    const root = document.createElement('div')
    root.className = 'library'
    root.innerHTML =
      '<div class="resource-card" id="private-id">PRIVATE_RESOURCE_TEXT<input value="PRIVATE_KEY"></div><div class="auth-portal"><p class="login-details">PRIVATE_LOGIN</p></div>'
    document.body.append(root)
    const value = await child.props('execute')(
      { action: 'inspect', scope: 'library', answer: '检查' },
      request,
      signal,
    )
    expect(JSON.stringify(value)).toContain('resource-card')
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|private-id|auth-portal|login-details/u)
    expect(value.data!.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'input', control: 'text' })]),
    )
    root.remove()
    wrapper.unmount()
  })
  it('clears only the requested scope and refuses changed global drafts or cancelled tools', async () => {
    const { wrapper, child, proposal, preset, request, signal } = await setup()
    await child.props('execute')({ ...proposal, css: '' }, request, signal)
    expect(child.props('getContext')().css.library).toBe('')
    expect(child.props('getContext')().css.details).toBe(preset.scopedCss.details)
    const current = { ...child.props('getContext')(), history: [] }
    await expect(
      child.props('execute')(proposal, { ...current, globalCss: 'changed' }, signal),
    ).rejects.toThrow('全局 CSS')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(child.props('execute')(proposal, current, cancelled.signal)).rejects.toThrow(
      '停止',
    )
    await expect(
      child.props('execute')({ action: 'undo', answer: '撤销' }, request, signal),
    ).rejects.toThrow('草稿已变化')
    wrapper.unmount()
  })
  it('reports screenshot failure as a tool error instead of success', async () => {
    const { captureAssistantPage } = await import('../services/ProductAssistantScreenshot')
    vi.mocked(captureAssistantPage).mockRejectedValueOnce(new Error('未挂载'))
    const { wrapper, child, request, signal } = await setup()
    const value = await child.props('execute')(
      { action: 'capture', scope: 'library', answer: '截图' },
      request,
      signal,
    )
    expect(value.ok).toBe(false)
    expect(value.image).toBeUndefined()
    expect(value.text).toContain('未挂载')
    wrapper.unmount()
  })
  it('imports CSS above 200000 characters with the final rule intact in storage and application', async () => {
    const { wrapper, storage, preset } = await setup()
    const css = `/*${'x'.repeat(250_000)}*/\n:root { --large-css-tail: preserved; }`
    const input = wrapper.get('[data-appearance-preset-import]')
    Object.defineProperty(input.element, 'files', {
      value: [{ name: 'complete.css', size: css.length, text: async () => css }],
    })
    await input.trigger('change')
    await flushPromises()
    expect(storage.getCustomUiPresets()[0]).toEqual(preset)
    const imported = storage.getCustomUiPresets()[1]!
    expect(imported.globalCss).toBe(css)
    expect(storage.getActiveCustomUiPresetId()).toBe(imported.id)
    expect(wrapper.emitted('save-css')?.at(-1)?.[0]).toBe(css)
    wrapper.unmount()
  })
})
