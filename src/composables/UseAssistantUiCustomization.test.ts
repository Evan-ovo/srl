/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeUiViews } from '../core/UiCustomization'
import { createEditableUiView } from '../core/UiViewStarter'
import { useAssistantUiCustomization, snapshotUiViews } from './UseAssistantUiCustomization'
import type { AssistantRequest } from '../services/ProductAssistantService'
import type { CustomCssPreset } from '../types/BrowserPreferences'
import { compileCustomUiView } from '../services/UiCustomizationService'

vi.mock('../services/UiCustomizationService', async (load) => ({
  ...(await load<typeof import('../services/UiCustomizationService')>()),
  compileCustomUiView: vi.fn(async () => 'compiled-vue'),
}))
vi.mock('./UseConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }))
const wrappers: Array<ReturnType<typeof mount>> = []
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.clearAllMocks()
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function setup(views: CustomCssPreset['views'] = {}) {
  const draft = ref<CustomCssPreset>({
    id: 'test',
    name: '主题',
    globalCss: '.global{color:pink}',
    scopedCss: { details: '.other{color:blue}' },
    views: normalizeUiViews(views),
    createdAt: '',
    updatedAt: '',
  })
  const remote = ref(false)
  const active = ref(true)
  const apply = vi.fn(async (_scope, revision, _request, signal: AbortSignal) => ({
    text: '已试用',
    data: { revision },
    ...(signal.aborted ? { ok: false, cancelled: true } : {}),
  }))
  let tools!: ReturnType<typeof useAssistantUiCustomization>
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          tools = useAssistantUiCustomization({
            draft: () => ({
              ...draft.value,
              scopedCss: { ...draft.value.scopedCss },
              views: snapshotUiViews(draft.value.views),
            }),
            scopes: () => [{ value: 'library', title: '资源库', selector: '.library', hint: '' }],
            write: (before, next) => {
              if (JSON.stringify(before) !== JSON.stringify(draft.value))
                throw new Error('草稿并发变化')
              draft.value = next
            },
            apply,
            css: () => '',
            previewCss: () => ':root{--color-accent:pink}',
            remote: () => remote.value,
            active: () => active.value,
            theme: () => 'light',
          })
          return () => null
        },
      }),
    ),
  )
  const request = (): AssistantRequest => ({
    presetId: 'test',
    appliedCss: '',
    scopes: [],
    css: {},
    currentScope: 'library',
    history: [],
    uiViews: snapshotUiViews(draft.value.views),
  })
  const read = () =>
    tools.execute(
      { action: 'vue', operation: 'read', scope: 'library' },
      request(),
      new AbortController().signal,
    )
  return { tools, draft, remote, active, apply, request, read }
}
async function readyPreview(
  ctx: ReturnType<typeof setup>,
  revision: string,
  signal = new AbortController().signal,
) {
  const result = ctx.tools.execute(
    { action: 'vue', operation: 'preview', scope: 'library', revision },
    ctx.request(),
    signal,
  )
  await vi.waitFor(() => expect(ctx.tools.preview.value).toBeDefined())
  const id = ctx.tools.preview.value!.id
  ctx.tools.status(id)
  await result
  return id
}
describe('Vue工具适配现有源码Owner', () => {
  it('只读模板不创建草稿；不读其它APP源码或二进制素材', async () => {
    const other = createEditableUiView('其它')
    other.files[0]!.contents = 'PRIVATE_OTHER_SOURCE'
    const ctx = setup({ cabinet: other })
    const value = await ctx.read()
    expect(value.data).toMatchObject({ exists: false, enabled: false, entry: 'View.vue' })
    expect(value.data!.code).toContain('usePage')
    expect(JSON.stringify(value)).not.toContain('PRIVATE_OTHER_SOURCE')
    expect(ctx.draft.value.views?.library).toBeUndefined()
    const current = createEditableUiView('资源库')
    current.files.push({ path: 'a.png', contents: 'YQ==', encoding: 'base64' })
    ctx.draft.value.views = { library: current }
    await expect(
      ctx.tools.execute(
        { action: 'vue', operation: 'read', scope: 'library', path: 'a.png' },
        ctx.request(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('二进制')
  })
  it('写入仅改目标源码、保留素材/其它APP/CSS；编译成功不自动启用', async () => {
    const original = createEditableUiView('资源库')
    original.files.push({ path: 'image.png', contents: 'YQ==', encoding: 'base64' })
    const ctx = setup({ library: original, cabinet: createEditableUiView('收藏柜') })
    const before = JSON.stringify(ctx.draft.value.views?.cabinet)
    const read = await ctx.read()
    const value = await ctx.tools.execute(
      {
        action: 'vue',
        operation: 'write',
        scope: 'library',
        path: 'View.vue',
        code: '<template><button>星形</button></template>',
        revision: read.data!.revision as string,
      },
      ctx.request(),
      new AbortController().signal,
    )
    expect(value.data).toMatchObject({ compiled: true, applied: false })
    expect(ctx.draft.value.views?.library?.enabled).toBe(false)
    expect(
      ctx.draft.value.views?.library?.files.find((file) => file.path === 'image.png')?.contents,
    ).toBe('YQ==')
    expect(JSON.stringify(ctx.draft.value.views?.cabinet)).toBe(before)
    expect(ctx.draft.value.globalCss).toContain('pink')
    expect(ctx.draft.value.scopedCss.details).toContain('blue')
    expect(ctx.apply).not.toHaveBeenCalled()
  })
  it('编译失败、版本不符、晚到结果都不能覆盖草稿', async () => {
    const ctx = setup()
    const read = await ctx.read()
    const command = {
      action: 'vue' as const,
      operation: 'write' as const,
      scope: 'library',
      path: 'View.vue',
      code: '<template/>',
      revision: read.data!.revision as string,
    }
    vi.mocked(compileCustomUiView).mockRejectedValueOnce(new Error('编译失败'))
    await expect(
      ctx.tools.execute(command, ctx.request(), new AbortController().signal),
    ).rejects.toThrow('编译失败')
    expect(ctx.draft.value.views?.library).toBeUndefined()
    let resolve!: (value: string) => void
    vi.mocked(compileCustomUiView).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const pending = ctx.tools.execute(command, ctx.request(), new AbortController().signal)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    ctx.draft.value.scopedCss.details = '.manual{color:red}'
    resolve('compiled')
    await expect(pending).rejects.toThrow('并发变化')
    expect(ctx.draft.value.views?.library).toBeUndefined()
    expect(ctx.draft.value.scopedCss.details).toContain('manual')
    await expect(
      ctx.tools.execute(
        { ...command, revision: 'old' },
        ctx.request(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Vue草稿已变化')
  })
  it('关闭预览取消等待，迟到ready被丢弃；重新打开才继续', async () => {
    const ctx = setup({ library: createEditableUiView('资源库') })
    const read = await ctx.read()
    const command = {
      action: 'vue' as const,
      operation: 'preview' as const,
      scope: 'library',
      revision: read.data!.revision as string,
    }
    const pending = ctx.tools.execute(command, ctx.request(), new AbortController().signal)
    await vi.waitFor(() => expect(ctx.tools.preview.value).toBeDefined())
    const id = ctx.tools.preview.value!.id
    ctx.tools.close()
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    ctx.tools.status(id)
    expect(ctx.tools.preview.value).toBeUndefined()
    await readyPreview(ctx, command.revision)
    expect(ctx.tools.preview.value?.state).toBe('ready')
  })
  it('错误/源码改变后不能应用；当前版本启动后才能委托原应用事务', async () => {
    const ctx = setup({ library: createEditableUiView('资源库') })
    const read = await ctx.read()
    const command = {
      action: 'vue' as const,
      operation: 'apply' as const,
      scope: 'library',
      revision: read.data!.revision as string,
    }
    await expect(
      ctx.tools.execute(command, ctx.request(), new AbortController().signal),
    ).rejects.toThrow('先预览')
    await readyPreview(ctx, command.revision)
    ctx.tools.status(ctx.tools.preview.value!.id, '运行失败')
    await expect(
      ctx.tools.execute(command, ctx.request(), new AbortController().signal),
    ).rejects.toThrow('先预览')
    await readyPreview(ctx, command.revision)
    await ctx.tools.execute(command, ctx.request(), new AbortController().signal)
    expect(ctx.apply).toHaveBeenCalledOnce()
    expect(ctx.tools.preview.value).toBeUndefined()
    ctx.draft.value.views!.library!.files[0]!.contents += '\n<!--手动-->'
    await expect(
      ctx.tools.execute(command, ctx.request(), new AbortController().signal),
    ).rejects.toThrow('草稿已变化')
  })
  it('开启网络或目标隐藏关闭预览，原真实快照不被新网络策略重用', async () => {
    const ctx = setup({ library: createEditableUiView('资源库') })
    const read = await ctx.read()
    await readyPreview(ctx, read.data!.revision as string)
    ctx.remote.value = true
    expect(ctx.tools.preview.value).toBeUndefined()
    ctx.remote.value = false
    await readyPreview(ctx, read.data!.revision as string)
    ctx.active.value = false
    expect(ctx.tools.preview.value).toBeUndefined()
  })
  it('关闭预览使正在等待的应用许可失效，不能晚到后继续写入', async () => {
    const ctx = setup({ library: createEditableUiView('资源库') })
    const read = await ctx.read()
    await readyPreview(ctx, read.data!.revision as string)
    let stopped = false
    ctx.apply.mockImplementationOnce(async (_scope, revision, _request, signal) => {
      await new Promise<void>((done) =>
        signal.addEventListener(
          'abort',
          () => {
            stopped = true
            done()
          },
          { once: true },
        ),
      )
      return { text: '取消', data: { revision }, ok: false, cancelled: true }
    })
    const pending = ctx.tools.execute(
      {
        action: 'vue',
        operation: 'apply',
        scope: 'library',
        revision: read.data!.revision as string,
      },
      ctx.request(),
      new AbortController().signal,
    )
    await vi.waitFor(() => expect(ctx.apply).toHaveBeenCalledOnce())
    ctx.tools.close()
    expect(await pending).toMatchObject({ ok: false, cancelled: true })
    expect(stopped).toBe(true)
  })
})
