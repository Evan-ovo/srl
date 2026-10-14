/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto'
import { defineComponent, h, onMounted } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import AppearanceStudio from './AppearanceStudio.vue'
import ProductAssistant from './ProductAssistant.vue'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { appearanceTransaction } from '../core/AppearanceSafety'
import { createEditableUiView } from '../core/UiViewStarter'
import type { AssistantReply, AssistantRequest } from '../services/ProductAssistantService'
import type { UiApplyOptions } from '../types/UiCustomization'

vi.mock('../core/OfficialAppRuntime', () => ({
  ensurePreinstalledOfficialApps: async () => {},
  acquireOfficialAppUse: async () => () => {},
  officialAppService: { list: async () => [{ id: 'assistant' }] },
  loadOfficialApp: async () => (await import('./ProductAssistant.vue')).default,
}))
vi.mock('./ProductAssistant.vue', () => ({
  default: { props: ['getContext', 'execute'], template: '<div>助手</div>' },
}))
vi.mock('../services/UiCustomizationService', async (load) => ({
  ...(await load<typeof import('../services/UiCustomizationService')>()),
  compileCustomUiView: vi.fn(async () => 'compiled'),
}))
vi.mock('../services/ProductAssistantScreenshot', () => ({
  captureAssistantPage: vi.fn(async () => ({
    id: 'image',
    name: '界面',
    dataUrl: 'LOCAL_ONLY',
    result: true,
  })),
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('./AssistantUiPreview.vue', () => ({
  default: defineComponent({
    props: { preview: { type: Object, required: true } },
    emits: ['ready'],
    setup(props, { emit }) {
      onMounted(() => emit('ready', props.preview.id))
      return () => h('div', '只读预览')
    },
  }),
}))

const wrappers: Array<ReturnType<typeof mount>> = []
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
  vi.clearAllMocks()
})
afterEach(() => {
  appearanceTransaction.rollback()
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function setup() {
  const storage = new BrowserStorageService()
  const other = createEditableUiView('其它APP')
  storage.setCustomUiViews({ cabinet: other })
  storage.setCustomUiCss('.existing{color:pink}')
  const original = {
    id: 'preset',
    name: '原主题',
    globalCss: '.global{}',
    scopedCss: { details: '.details{}' },
    views: { cabinet: other },
    createdAt: '',
    updatedAt: '',
  }
  storage.setCustomUiPresets([original])
  storage.setActiveCustomUiPresetId('preset')
  const wrapper = mount(AppearanceStudio, {
    props: {
      theme: 'light',
      layoutMode: 'grid',
      uiFontScale: 'standard',
      customCss: '.existing{color:pink}',
      assistantOnly: true,
      'onSave-assistant-css': (css: string, options?: UiApplyOptions) => {
        if (appearanceTransaction.hasPendingViewTrial()) return
        appearanceTransaction.keep()
        const before = storage.getCustomUiViews()
        appearanceTransaction.begin({
          previousCss: storage.getCustomUiCss(),
          nextCss: css,
          autoKeep: !options?.views,
          ...(options?.views ? { previousViews: JSON.stringify(before) } : {}),
          apply: () => {},
          persist: (value) => storage.setCustomUiCss(value),
          onRollback: () => {
            if (options?.views) storage.setCustomUiViews(before)
          },
        })
        if (options?.views) storage.setCustomUiViews(options.views)
      },
    },
  })
  wrappers.push(wrapper)
  await vi.waitFor(() => expect(wrapper.findComponent(ProductAssistant).exists()).toBe(true))
  const child = wrapper.getComponent(ProductAssistant)
  const context = (): AssistantRequest => ({ ...child.props('getContext')(), history: [] })
  const execute = (reply: AssistantReply, request = context()) =>
    child.props('execute')(reply, request, new AbortController().signal)
  const read = await execute({ action: 'vue', operation: 'read', scope: 'library' })
  const write = await execute({
    action: 'vue',
    operation: 'write',
    scope: 'library',
    path: 'View.vue',
    code: '<template><button>新入口</button></template>',
    revision: read.data!.revision as string,
  })
  return { storage, wrapper, context, execute, revision: write.data!.revision as string, original }
}
describe('源码草稿与原试用/撤销事务', () => {
  it('写入不启用，预览后才试用；其它APP/CSS保留，未保留时自动恢复', async () => {
    const ctx = await setup()
    expect(ctx.storage.getCustomUiViews().library).toBeUndefined()
    expect(ctx.context().uiViews!.library!.enabled).toBe(false)
    await ctx.execute({
      action: 'vue',
      operation: 'preview',
      scope: 'library',
      revision: ctx.revision,
    })
    await flushPromises()
    const value = await ctx.execute({
      action: 'vue',
      operation: 'apply',
      scope: 'library',
      revision: ctx.revision,
    })
    expect(value.data).toMatchObject({ trial: true, applied: true, visualReviewed: false })
    expect(ctx.storage.getCustomUiViews().library?.enabled).toBe(true)
    expect(ctx.storage.getCustomUiViews().cabinet).toEqual(ctx.context().uiViews!.cabinet)
    expect(ctx.storage.getCustomUiCss()).toBe('.existing{color:pink}')
    expect(appearanceTransaction.hasPendingViewTrial()).toBe(true)
    await expect(ctx.execute({ action: 'save', answer: '保存' })).rejects.toThrow('保留或恢复')
    appearanceTransaction.rollback()
    expect(ctx.storage.getCustomUiViews().library).toBeUndefined()
    expect(ctx.storage.getCustomUiViews().cabinet).toBeDefined()
    await ctx.execute({ action: 'undo', answer: '撤销' })
    expect(ctx.context().uiViews!.library).toBeUndefined()
  })
  it('明确保留后可原位保存，撤销恢复应用前源码，已保存预设仍保留', async () => {
    const ctx = await setup()
    await ctx.execute({
      action: 'vue',
      operation: 'preview',
      scope: 'library',
      revision: ctx.revision,
    })
    await ctx.execute({
      action: 'vue',
      operation: 'apply',
      scope: 'library',
      revision: ctx.revision,
    })
    appearanceTransaction.keep()
    await ctx.execute({ action: 'save', answer: '保存' })
    expect(ctx.storage.getCustomUiPresets()).toHaveLength(1)
    expect(ctx.storage.getCustomUiPresets()[0]!.id).toBe('preset')
    expect(ctx.storage.getCustomUiPresets()[0]!.views?.library?.files[0]?.contents).toContain(
      '新入口',
    )
    await ctx.execute({ action: 'undo', answer: '撤销' })
    expect(ctx.storage.getCustomUiViews().library).toBeUndefined()
    expect(ctx.context().uiViews!.library).toBeUndefined()
    expect(ctx.storage.getCustomUiPresets()[0]!.views?.library).toBeDefined()
  })
  it('草稿撤销不调用运行事务，手动代码修改后拒绝覆盖；没有预览不能激活', async () => {
    const ctx = await setup()
    const undo = vi.spyOn(appearanceTransaction, 'undo')
    await expect(
      ctx.execute({ action: 'vue', operation: 'apply', scope: 'library', revision: ctx.revision }),
    ).rejects.toThrow('先预览')
    await ctx.execute({ action: 'undo', answer: '撤销源码' })
    expect(undo).not.toHaveBeenCalled()
    expect(ctx.context().uiViews!.library).toBeUndefined()
    expect(ctx.storage.getCustomUiCss()).toContain('pink')
  })
})
