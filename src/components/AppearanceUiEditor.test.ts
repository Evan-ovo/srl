/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AppearanceUiEditor from './AppearanceUiEditor.vue'
import { createUiView } from '../core/UiCustomization'

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

  it('编辑保留素材；全屏预览委托真实界面，不创建示例快照或改变启用状态', async () => {
    const view = createUiView()
    view.files.push({ path: 'cover.png', contents: 'AQ==', encoding: 'base64' })
    const wrapper = mount(AppearanceUiEditor, {
      props: { scope: 'library', title: '资源库', views: { library: view } },
    })
    await wrapper
      .get('.appearance-ui-editor__source textarea')
      .setValue('<template>新文字</template>')
    const saved = wrapper.emitted('update:views')![0]![0] as { library: typeof view }
    expect(saved.library.files[1]).toEqual(view.files[1])
    expect(saved.library.enabled).toBe(false)
    expect(view.files[0]!.contents).not.toBe(saved.library.files[0]!.contents)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '全屏预览')!
      .trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.emitted('update:views')).toHaveLength(1)
    expect(wrapper.text()).toContain('保存、删除等业务操作会影响真实数据')
    await wrapper.setProps({ scope: 'cloud', title: '云备份' })
    expect(wrapper.get('.appearance-ui-editor__vue').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })

  it('恢复默认前询问确认，取消时保留源码，确认后移除', async () => {
    const wrapper = mount(AppearanceUiEditor, {
      props: {
        scope: 'library',
        title: '资源库',
        views: { library: createUiView() },
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
