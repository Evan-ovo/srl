/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { download } = vi.hoisted(() => ({ download: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../utils/LibraryFormatting', () => ({ downloadBlob: download }))
vi.mock('../services/AppearanceReferenceService', () => ({
  createInstalledAppearanceReferenceReader: async (catalog: unknown) => ({
    read: async () => catalog,
    clear: () => {},
  }),
}))
vi.mock('virtual:srl-appearance-reference', () => ({
  default: {
    vue: [
      ['page.click(selector)', '调用原按钮。'],
      ['UiViewAction.event: click | input', '原事件。'],
    ],
    sources: [
      {
        path: 'src/styles/Foundation.css:1',
        rules: [
          { selector: ':root', conditions: '', declarations: { '--color-accent': '#123456' } },
        ],
      },
      {
        path: 'stitch.css:1',
        rules: [
          {
            selector: '.stitch-button',
            conditions: '',
            declarations: { color: 'var(--color-accent)', background: 'var(--button-background)' },
          },
        ],
      },
    ],
    scopes: {
      global: ['src/styles/Foundation.css:1'],
      stitch: ['src/styles/Foundation.css:1', 'stitch.css:1'],
    },
  },
}))
import AppearanceCodeReference from './AppearanceCodeReference.vue'
enableAutoUnmount(afterEach)
beforeEach(() => {
  download.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})
afterEach(() => vi.restoreAllMocks())
const mountHelp = () => mount(AppearanceCodeReference, { global: { stubs: { teleport: true } } })
async function openHelp(wrapper: ReturnType<typeof mountHelp>) {
  await wrapper.get('[aria-label="接口参考"]').trigger('click')
  await flushPromises()
}
async function clickText(wrapper: ReturnType<typeof mountHelp>, label: string) {
  await wrapper
    .findAll('button')
    .find((button) => button.text() === label)!
    .trigger('click')
  await flushPromises()
}
async function blobText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsText(blob)
  })
}
describe('接口教程', () => {
  it('从二选一入口进入 APP 列表，再显示全屏教程；Vue 默认折叠', async () => {
    const wrapper = mountHelp()
    expect(wrapper.get('dialog').attributes('open')).toBeUndefined()
    await openHelp(wrapper)
    expect(wrapper.find('svg circle').exists()).toBe(true)
    await clickText(wrapper, '单独 APP 接口')
    expect(wrapper.get('.reference-app-list').text()).toContain('缝了么')
    await wrapper
      .findAll('.reference-app-list button')
      .find((button) => button.text().includes('缝了么'))!
      .trigger('click')
    expect(wrapper.get('dialog').classes()).toContain('appearance-code-reference--full')
    expect(wrapper.get('.reference-vue').attributes('open')).toBeUndefined()
    await vi.waitFor(() => expect(wrapper.text()).toContain('--button-background'))
    expect(wrapper.text()).toContain('普通按钮背景')
    await wrapper.get('[aria-label="返回教程列表"]').trigger('click')
    expect(wrapper.find('.reference-app-list').exists()).toBe(true)
    await wrapper.get('[aria-label="关闭接口参考"]').trigger('click')
    expect(wrapper.get('dialog').attributes('open')).toBeUndefined()
  })
  it('全局提供 Discord 式侧边目录，选择 APP 后关闭目录并显示对应教程', async () => {
    const wrapper = mountHelp()
    await openHelp(wrapper)
    await clickText(wrapper, '全局接口')
    expect(wrapper.get('.reference-navigation').classes()).not.toContain(
      'reference-navigation--open',
    )
    await wrapper.get('[aria-label="展开教程导航"]').trigger('click')
    const nav = wrapper.get('.reference-navigation')
    expect(nav.find('[aria-label="关闭教程导航"]').exists()).toBe(false)
    expect(wrapper.find('.reference-nav-backdrop').exists()).toBe(false)
    expect(nav.text()).toContain('前端了么')
    await nav
      .findAll('button')
      .find((button) => button.text().includes('缝了么'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.get('.reference-navigation').classes()).not.toContain(
      'reference-navigation--open',
    )
    expect(wrapper.findAll('[data-reference-chapter]')).toHaveLength(1)
    expect(wrapper.find('[data-reference-chapter="stitch"]').exists()).toBe(true)
    expect(
      wrapper.get('[data-reference-chapter="stitch"] .reference-chapter-body').text(),
    ).toContain('--color-accent')
  })
  it.each(['css', 'vue', 'both'] as const)(
    '按选择导出 %s Markdown，单 APP 不混入其他 APP',
    async (kind) => {
      const wrapper = mountHelp()
      await openHelp(wrapper)
      await clickText(wrapper, '单独 APP 接口')
      await wrapper
        .findAll('.reference-app-list button')
        .find((button) => button.text().includes('缝了么'))!
        .trigger('click')
      await wrapper.get('[aria-label="导出教程"]').trigger('click')
      await clickText(
        wrapper,
        kind === 'css' ? '仅导出 CSS 接口' : kind === 'vue' ? '仅导出 Vue 教程' : '两者都导出',
      )
      const [blob, name] = download.mock.calls[0]!
      const markdown = await blobText(blob)
      expect(name).toBe(`SRL-缝了么接口-${kind}.md`)
      expect(blob.type).toContain('text/markdown')
      expect(markdown).toContain('缝了么')
      expect(markdown).not.toContain('前端了么')
      expect(markdown.includes('### CSS 接口')).toBe(kind !== 'vue')
      expect(markdown.includes('page.click(selector)')).toBe(kind !== 'css')
      expect(wrapper.get('[role="status"]').text()).toBe('Markdown 教程已导出')
    },
  )
  it('按变量用途查找；复制失败不会显示成功', async () => {
    const wrapper = mountHelp()
    await openHelp(wrapper)
    await clickText(wrapper, '全局接口')
    await wrapper
      .get('.reference-search:not(.reference-navigation-search) input')
      .setValue('普通按钮背景')
    expect(wrapper.get('.reference-content').text()).toContain('缝了么')
    expect(wrapper.get('.reference-content').text()).toContain('--button-background')
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('复制被拒绝'))
    await clickText(wrapper, '一键复制')
    expect(wrapper.get('[role="status"]').text()).toBe('复制被拒绝')
    expect(wrapper.find('.reference-content').exists()).toBe(true)
  })
  it('目录搜索与正文筛选独立，选择 APP 清除正文筛选并回到章节顶部', async () => {
    const wrapper = mountHelp()
    await openHelp(wrapper)
    await clickText(wrapper, '全局接口')
    await wrapper
      .get('.reference-search:not(.reference-navigation-search) input')
      .setValue('不存在的变量')
    expect(wrapper.get('.reference-content').text()).toContain('没有找到匹配的接口')
    await wrapper.get('[aria-label="展开教程导航"]').trigger('click')
    let nav = wrapper.get('.reference-navigation')
    expect(nav.text()).toContain('前端了么')
    await nav.get('input').setValue('缝了么')
    nav = wrapper.get('.reference-navigation')
    expect(nav.findAll('section button')).toHaveLength(1)
    await nav.get('section button').trigger('click')
    await flushPromises()
    expect(
      wrapper.get('.reference-search:not(.reference-navigation-search) input').element,
    ).toHaveProperty('value', '')
    expect(wrapper.get('[data-reference-chapter="stitch"]').text()).toContain('--color-accent')
    expect(wrapper.get('.reference-navigation [aria-current="location"]').text()).toContain(
      '缝了么',
    )
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 0 })
    await wrapper.get('[aria-label="展开教程导航"]').trigger('click')
    await wrapper.get('.reference-navigation input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('.reference-navigation').classes()).not.toContain(
      'reference-navigation--open',
    )
  })
  it('全局复制包含全部界面、APP 和 Vue 教程，基础用法只出现一次', async () => {
    const wrapper = mountHelp()
    await openHelp(wrapper)
    await clickText(wrapper, '全局接口')
    await clickText(wrapper, '一键复制')
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]
    expect(text).toContain('## 缝了么')
    expect(text).toContain('## 前端了么')
    expect(text).toContain('## 资源库')
    expect(text.match(/## Vue 用法与接口/g)).toHaveLength(1)
    expect(text.match(/## CSS 用法/g)).toHaveLength(1)
  })
})
