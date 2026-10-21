/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import CharacterCardContentWorkbench from './CharacterCardContentWorkbench.vue'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import { applyCharacterCardContentEdits } from '../utils/CharacterCardContentEdits'
import type { CharacterCardContentEdit } from '../types/CharacterCardContentEdit'

vi.mock('../composables/UseConfirmDialog', () => ({
  chooseAction: vi.fn(),
  confirmAction: vi.fn(),
}))

describe('CharacterCardContentWorkbench', () => {
  it('leaves IME confirmation untouched before accepting the normal save shortcut', async () => {
    const wrapper = mount(CharacterCardContentWorkbench, {
      props: { card: { data: { first_mes: '原开场' } }, edits: [] },
    })
    try {
      await wrapper.findAll('.card-content-workbench__header button')[2]!.trigger('click')
      const field = wrapper.get('textarea')
      await field.setValue('中文候选确认后的草稿')
      const composing = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
      field.element.dispatchEvent(composing)
      await flushPromises()
      expect(composing.defaultPrevented).toBe(false)
      expect(wrapper.emitted('update:edits')).toBeUndefined()
      expect(wrapper.get('textarea').element.value).toBe('中文候选确认后的草稿')
      await field.trigger('keydown', { key: 'Enter', ctrlKey: true })
      await flushPromises()
      expect(wrapper.emitted('update:edits')).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  })
  it('keeps exit, import, new and the parent save in that order while editing an entry', async () => {
    const wrapper = mount(CharacterCardContentWorkbench, {
      props: { card: { data: { first_mes: '原开场' } }, edits: [] },
      slots: { save: '<button type="submit" form="resource-organize-section">保存</button>' },
    })
    const actions = () =>
      wrapper.findAll('.card-content-workbench__header button').map((button) => button.text())
    try {
      expect(actions()).toEqual(['退出编辑', '导入', '新建', '保存'])
      await wrapper.findAll('.card-content-workbench__header button')[2]!.trigger('click')
      expect(actions()).toEqual(['退出编辑', '导入', '新建', '保存'])
      await wrapper.get('textarea').setValue('保留草稿')
      await wrapper.get('[aria-label="返回列表"]').trigger('click')
      expect(wrapper.text()).toContain('还有未应用的输入')
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '继续编辑')!
        .trigger('click')
      expect(wrapper.get('textarea').element.value).toBe('保留草稿')
    } finally {
      wrapper.unmount()
    }
  })
  it('keeps alternate greeting identity after deleting an earlier greeting', async () => {
    vi.mocked(chooseAction).mockResolvedValue('confirm')
    vi.mocked(confirmAction).mockResolvedValue(true)
    const card = { data: { first_mes: '主开场', alternate_greetings: ['A', 'B', 'C'] } }
    const wrapper = mount(CharacterCardContentWorkbench, { props: { card, edits: [] } })
    const acceptEdits = async () => {
      const edits = wrapper.emitted('update:edits')!.at(-1)![0] as CharacterCardContentEdit[]
      await wrapper.setProps({ edits })
      return edits
    }
    try {
      await wrapper
        .findAll('.card-content-workbench__list li')[1]!
        .findAll('button')[1]!
        .trigger('click')
      await flushPromises()
      await acceptEdits()
      await wrapper
        .findAll('.card-content-workbench__list li')[1]!
        .findAll('button')[0]!
        .trigger('click')
      await wrapper.get('textarea').setValue('B 已编辑')
      await wrapper.get('.card-content-workbench__editor footer .is-primary').trigger('click')
      await flushPromises()
      const edits = await acceptEdits()
      expect(applyCharacterCardContentEdits(card, edits).card).toMatchObject({
        data: { alternate_greetings: ['B 已编辑', 'C'] },
      })
    } finally {
      wrapper.unmount()
    }
  })

  it('imports a primary greeting into a card with an empty primary', async () => {
    vi.mocked(chooseAction).mockResolvedValue('confirm')
    vi.mocked(confirmAction).mockResolvedValue(true)
    const card = { data: { first_mes: '', alternate_greetings: [] } }
    const wrapper = mount(CharacterCardContentWorkbench, { props: { card, edits: [] } })
    try {
      const input = wrapper.get('input[type="file"]')
      Object.defineProperty(input.element, 'files', {
        value: [{ name: '开场.txt', text: async () => '新的主开场' }],
      })
      await input.trigger('change')
      await flushPromises()
      await wrapper.get('select').setValue('replace-primary')
      await wrapper
        .get('.card-content-workbench__import-preview footer .is-primary')
        .trigger('click')
      await flushPromises()
      const edits = wrapper.emitted('update:edits')!.at(-1)![0] as CharacterCardContentEdit[]
      expect(applyCharacterCardContentEdits(card, edits).card).toMatchObject({
        data: { first_mes: '新的主开场' },
      })
    } finally {
      wrapper.unmount()
    }
  })

  it('edits one item in a focused form view instead of leaving the list behind it', async () => {
    const wrapper = mount(CharacterCardContentWorkbench, {
      props: {
        card: { data: { first_mes: '初始开场白' } },
        edits: [],
      },
    })

    expect(wrapper.find('.card-content-workbench__list').exists()).toBe(true)
    expect(wrapper.find('.card-content-workbench__tabs').exists()).toBe(true)
    await wrapper.get('.card-content-workbench__list button').trigger('click')

    expect(wrapper.find('.card-content-workbench__editor').exists()).toBe(true)
    expect(wrapper.find('.card-content-workbench__list').exists()).toBe(false)
    expect(wrapper.find('.card-content-workbench__tabs').exists()).toBe(false)
    expect(wrapper.text()).toContain('返回列表')
    expect(wrapper.findAll('button').filter((button) => button.text() === '返回列表')).toHaveLength(
      1,
    )
    expect(wrapper.get('textarea').element.value).toBe('初始开场白')
    await wrapper.get('textarea').setValue('暂存的开场白')
    await wrapper.get('button[aria-label="返回列表"]').trigger('click')
    expect(wrapper.find('.card-content-workbench__editor').exists()).toBe(false)
    expect(wrapper.text()).toContain('还有未应用的输入，已暂存')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '继续编辑')!
      .trigger('click')
    expect(wrapper.get('textarea').element.value).toBe('暂存的开场白')
    wrapper.unmount()
  })
})
