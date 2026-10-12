/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AppearanceUiEditor from './AppearanceUiEditor.vue'
import CustomUiFrame from './CustomUiFrame.vue'
import { createUiView } from '../core/UiCustomization'
import { BrowserStorageService } from '../services/BrowserStorageService'

const { confirmAction } = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction }))

describe('界面源码编辑器', () => {
  it('Vue默认折叠，无快捷参数和文件管理，创建仅影响所选APP且不启用', async () => {
    const views = { library: createUiView() }
    const wrapper = mount(AppearanceUiEditor, {
      props: {
        scope: 'cloud',
        title: '云备份',
        views,
        css: '',
      },
    })
    expect(wrapper.get('.appearance-ui-editor__vue').attributes('open')).toBeUndefined()
    await wrapper.get('.appearance-ui-editor__create').trigger('click')
    const next = wrapper.emitted('update:views')![0]![0] as typeof views & {
      cloud: ReturnType<typeof createUiView>
    }
    expect(next.cloud.enabled).toBe(false)
    expect(next.cloud.allowNetwork).toBe(false)
    expect(next.cloud.files[0]!.contents).toContain('云备份')
    expect(next.cloud.files[0]!.contents).toContain('<Region body />')
    expect(next.cloud.files.map((file) => file.path)).toEqual(['View.vue', 'Page.js'])
    expect(next.library).toEqual(views.library)
    await wrapper.setProps({ views: next })
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1)
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(wrapper.find('.appearance-ui-editor__css').exists()).toBe(false)
    expect(wrapper.find('.appearance-ui-editor__files').exists()).toBe(false)
    wrapper.unmount()
  })

  it('只编辑入口源码，保留旧素材与辅助文件；联网开启前关闭原只读预览', async () => {
    const storage = new BrowserStorageService()
    storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: false })
    const view = createUiView()
    view.files.push({ path: 'cover.png', contents: 'AQ==', encoding: 'base64' })
    const wrapper = mount(AppearanceUiEditor, {
      props: { scope: 'library', title: '资源库', views: { library: view }, css: '' },
    })
    await wrapper
      .get('.appearance-ui-editor__source textarea')
      .setValue('<template>新文字</template>')
    const saved = wrapper.emitted('update:views')![0]![0] as { library: typeof view }
    expect(saved.library.files[1]).toEqual(view.files[1])
    expect(view.files[0]!.contents).not.toBe(saved.library.files[0]!.contents)
    expect(wrapper.emitted('update:css')).toBeUndefined()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '预览')!
      .trigger('click')
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(true)
    storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: true })
    await flushPromises()
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(false)
    wrapper.unmount()
    storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: false })
  })

  it('关闭高级区或切换APP释放预览，保留原项目', async () => {
    const views = { library: createUiView(), cloud: createUiView() }
    const wrapper = mount(AppearanceUiEditor, {
      props: {
        scope: 'library',
        title: '资源库',
        views,
        css: '',
      },
    })
    const advanced = wrapper.get('.appearance-ui-editor__vue')
    ;(advanced.element as HTMLDetailsElement).open = true
    await advanced.trigger('toggle')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '预览')!
      .trigger('click')
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(true)
    expect(() =>
      structuredClone(wrapper.findComponent(CustomUiFrame).props('snapshot')),
    ).not.toThrow()
    ;(advanced.element as HTMLDetailsElement).open = false
    await advanced.trigger('toggle')
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(false)
    await wrapper.setProps({ scope: 'cloud', title: '云备份' })
    expect(advanced.attributes('open')).toBeUndefined()
    expect(wrapper.emitted('update:views')).toBeUndefined()
    wrapper.unmount()
  })

  it('预览保持打开，编辑器操作不会把预览关闭', async () => {
    const wrapper = mount(AppearanceUiEditor, {
      props: {
        scope: 'library',
        title: '资源库',
        views: { library: createUiView() },
        css: '',
      },
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '预览')!
      .trigger('click')
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(true)
    await wrapper
      .get('.appearance-ui-editor__source textarea')
      .setValue('<template><h1>改过</h1></template>')
    expect(wrapper.find('.appearance-ui-editor__preview').exists()).toBe(true)
    wrapper.unmount()
  })

  it('恢复默认前询问确认，取消时保留源码，确认后移除', async () => {
    const wrapper = mount(AppearanceUiEditor, {
      props: {
        scope: 'library',
        title: '资源库',
        views: { library: createUiView() },
        css: '',
      },
    })
    confirmAction.mockResolvedValueOnce(false)
    await wrapper.get('.appearance-ui-editor__restore').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:views')).toBeUndefined()
    confirmAction.mockResolvedValueOnce(true)
    await wrapper.get('.appearance-ui-editor__restore').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('update:views')!.at(-1)![0]).toEqual({})
    wrapper.unmount()
  })
})
