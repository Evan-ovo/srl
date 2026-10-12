/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CharacterCardDetails from './CharacterCardDetails.vue'
import GreetingPreviewDialog from './GreetingPreviewDialog.vue'
import * as opening from '../utils/OpeningPreviewContent'
import * as preview from '../utils/RichContentPreview'

enableAutoUnmount(afterEach)
const scrollDescriptors = ['scrollIntoView', 'scrollTo'].map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
}))
beforeEach(() => {
  for (const { name } of scrollDescriptors)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: vi.fn() })
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const { name, descriptor } of scrollDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

describe('character opening list computation', () => {
  it('列表惰性计算，切换/重命名复用，正文编辑只重算变化项', async () => {
    const excerpt = vi.spyOn(opening, 'stripOpeningPreviewHiddenBlocks')
    const rich = vi.spyOn(preview, 'hasRichPreviewContent')
    let data = { name: '角色', first_mes: '<p>主正文</p>', alternate_greetings: ['备用正文'] }
    const wrapper = mount(CharacterCardDetails, {
      props: { metadata: { card: { data } } },
      global: { stubs: { GreetingPreviewDialog: true, CharacterCardContentWorkbench: true } },
    })
    await flushPromises()
    expect(excerpt).not.toHaveBeenCalled()
    expect(rich).not.toHaveBeenCalled()
    const openList = async () => {
      await wrapper.get('.character-content-index__item').trigger('click')
      await flushPromises()
    }
    await openList()
    expect(excerpt).toHaveBeenCalledTimes(2)
    expect(rich).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.character-greeting-card__excerpt').map((item) => item.text())).toEqual(
      ['主正文', '备用正文'],
    )
    await wrapper.get('.character-greetings__fullscreen').trigger('click')
    wrapper.findComponent(GreetingPreviewDialog).vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(excerpt).toHaveBeenCalledTimes(2)
    expect(rich).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.character-greetings__track article.is-active strong').text()).toBe(
      '备用 01',
    )
    data = { ...data, name: '改名角色' }
    await wrapper.setProps({ metadata: { card: { data } } })
    await openList()
    expect(excerpt).toHaveBeenCalledTimes(2)
    expect(rich).toHaveBeenCalledTimes(2)
    data = { ...data, first_mes: '<p>更新正文</p>' }
    await wrapper.setProps({ metadata: { card: { data } } })
    await openList()
    expect(excerpt).toHaveBeenCalledTimes(3)
    expect(rich).toHaveBeenCalledTimes(3)
    expect(wrapper.findAll('.character-greeting-card__excerpt').map((item) => item.text())).toEqual(
      ['更新正文', '备用正文'],
    )
    data = { ...data, first_mes: '<!--desc:手写说明--><p>更新正文</p>' }
    await wrapper.setProps({ metadata: { card: { data } } })
    await openList()
    expect(excerpt).toHaveBeenCalledTimes(3)
    expect(rich).toHaveBeenCalledTimes(3)
    expect(wrapper.find('.character-greeting-card__excerpt').text()).toBe('手写说明')
  })

  it('通过原页码位置的紧凑输入框直接跳转到开场白', async () => {
    const wrapper = mount(CharacterCardDetails, {
      props: {
        metadata: {
          card: {
            data: {
              name: '角色',
              first_mes: '主正文',
              alternate_greetings: ['备用一', '备用二', '备用三'],
            },
          },
        },
      },
      global: { stubs: { GreetingPreviewDialog: true, CharacterCardContentWorkbench: true } },
    })
    await flushPromises()
    await wrapper.get('.character-content-index__item').trigger('click')

    const pageInput = wrapper.get('input[aria-label="跳转到开场白"]')
    expect(pageInput.element.getAttribute('style')).toContain('width: 2ch')
    await pageInput.setValue('3')

    expect((pageInput.element as HTMLInputElement).value).toBe('03')
    expect(wrapper.get('.character-greetings__track article.is-active small').text()).toBe(
      'OPENING 03',
    )
  })

  it('通过页码跳转到角色卡内嵌世界书条目', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      uid: index,
      comment: `世界书条目 ${String(index + 1).padStart(2, '0')}`,
      content: `正文 ${index + 1}`,
      keys: [`关键词 ${index + 1}`],
    }))
    const wrapper = mount(CharacterCardDetails, {
      props: {
        metadata: { card: { data: { name: '角色', character_book: { entries } } } },
      },
      global: { stubs: { GreetingPreviewDialog: true, CharacterCardContentWorkbench: true } },
    })
    await flushPromises()
    await wrapper.get('.character-content-index__item').trigger('click')

    const pageInput = wrapper.get('input[aria-label="跳转到内嵌世界书条目页"]')
    await pageInput.setValue('3')

    expect((pageInput.element as HTMLInputElement).value).toBe('3')
    expect(wrapper.findAll('.lore-row strong').map((item) => item.text())).toContain(
      '世界书条目 21',
    )
  })
})
