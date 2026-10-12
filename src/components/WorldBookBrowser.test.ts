/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorldBookBrowser from './WorldBookBrowser.vue'
import CharacterCardDetails from './CharacterCardDetails.vue'
import StructuredResourceDetails from './StructuredResourceDetails.vue'
import { readWorldBookEntries } from '../utils/WorldBookEntries'
import type { Resource } from '../types/Resource'

const raw = [
  { uid: 0, comment: '城市规则', constant: true, position: 1, content: '规则正文' },
  {
    uid: 1,
    comment: '夜市',
    key: ['夜市'],
    keysecondary: ['月光'],
    selective: true,
    selectiveLogic: 0,
    position: 4,
    depth: 2,
    role: 0,
    probability: 1,
    content: '<script>unsafe()</script>',
  },
  { uid: 2, comment: '秘密', vectorized: true, disable: true, position: 0 },
]
const entries = readWorldBookEntries(raw)

describe('shared world book browser', () => {
  it('combines mode, status and position filters and searches secondary keys', async () => {
    const wrapper = mount(WorldBookBrowser, { props: { entries } })
    expect(wrapper.findAll('.lore-row')).toHaveLength(3)
    expect(wrapper.get('.lore-row.is-disabled').text()).toContain('向量秘密停用')
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('enabled')
    await selects[1]!.setValue('keyword')
    await selects[2]!.setValue('指定深度')
    expect(wrapper.findAll('.lore-row')).toHaveLength(1)
    expect(wrapper.get('.lore-row').text()).toContain('指定深度 2 · 系统消息')
    await wrapper.get('input').setValue('月光')
    expect(wrapper.findAll('.lore-row')).toHaveLength(1)
    await wrapper.get('input').setValue('找不到')
    expect(wrapper.find('.lore-empty').exists()).toBe(true)
    expect(wrapper.get('.lore-list-info').text()).toContain('0 / 3')
    wrapper.unmount()
  })
  it('keeps pagination and search when returning, renders content as text and restores keyboard focus', async () => {
    const many = readWorldBookEntries(
      Array.from({ length: 23 }, (_, index) => ({
        uid: index,
        comment: `条目${index}`,
        key: ['共同'],
        position: 0,
        content: '<script>unsafe()</script>',
      })),
    )
    const wrapper = mount(WorldBookBrowser, { props: { entries: many }, attachTo: document.body })
    Element.prototype.scrollIntoView = vi.fn()
    await wrapper.get('input').setValue('共同')
    await wrapper.findAll('.lore-pagination button')[1]!.trigger('click')
    expect(
      (wrapper.get('input[aria-label="跳转到世界书条目页"]').element as HTMLInputElement).value,
    ).toBe('2')
    expect(wrapper.get('.lore-pagination span').text()).toBe('/ 3')
    await wrapper.findAll('.lore-row')[2]!.trigger('click')
    expect(wrapper.get('.lore-detail h4').text()).toBe('条目12')
    expect(wrapper.get('pre').text()).toBe('<script>unsafe()</script>')
    expect(wrapper.find('script').exists()).toBe(false)
    await wrapper.get('button[aria-label="返回条目列表"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('input').element.value).toBe('共同')
    expect(
      (wrapper.get('input[aria-label="跳转到世界书条目页"]').element as HTMLInputElement).value,
    ).toBe('2')
    expect(wrapper.get('.lore-pagination span').text()).toBe('/ 3')
    expect(document.activeElement?.getAttribute('data-entry-key')).toBe('12:12')
    await wrapper.setProps({ entries })
    expect(wrapper.get('input').element.value).toBe('')
    expect(wrapper.findAll('.lore-row')).toHaveLength(3)
    wrapper.unmount()
  })
  it('renders only one page of a 10,000-entry selected book', async () => {
    const many = readWorldBookEntries(
      Array.from({ length: 10_000 }, (_, uid) => ({
        uid,
        comment: `条目${uid}`,
        key: ['共同'],
        position: 0,
      })),
    )
    const wrapper = mount(WorldBookBrowser, { props: { entries: many } })
    expect(wrapper.findAll('.lore-row')).toHaveLength(10)
    await wrapper.get('input').setValue('条目9999')
    expect(wrapper.findAll('.lore-row')).toHaveLength(1)
    expect(wrapper.get('.lore-row').text()).toContain('条目9999')
    wrapper.unmount()
  })
  it('jumps to the requested page using a compact input in the existing page position', async () => {
    const many = readWorldBookEntries(
      Array.from({ length: 23 }, (_, index) => ({
        uid: index,
        comment: `条目${index + 1}`,
        position: 0,
      })),
    )
    const wrapper = mount(WorldBookBrowser, { props: { entries: many } })
    const pageInput = wrapper.get('input[aria-label="跳转到世界书条目页"]')
    expect(pageInput.element.getAttribute('style')).toContain('width: 1ch')
    await pageInput.setValue('3')
    expect((pageInput.element as HTMLInputElement).value).toBe('3')
    expect(wrapper.get('.lore-pagination span').text()).toBe('/ 3')
    expect(wrapper.get('.lore-row strong').text()).toBe('条目21')
    wrapper.unmount()
  })
  it('uses the shared browser in both actual resource detail entries', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const card = mount(CharacterCardDetails, {
      props: {
        metadata: {
          card: {
            data: {
              name: '角色',
              character_book: {
                entries: [
                  {
                    id: 0,
                    comment: '内嵌',
                    enabled: true,
                    position: 'after_char',
                    extensions: { position: 4, depth: 1, role: 1 },
                  },
                ],
              },
            },
          },
        },
      },
    })
    await card
      .findAll('.character-content-index__item')
      .find((button) => button.text().includes('世界书'))!
      .trigger('click')
    await flushPromises()
    expect(card.get('.lore-row').text()).toContain('指定深度 1 · 用户消息')
    await card.get('.lore-row').trigger('click')
    await card.get('button[aria-label="返回角色档案"]').trigger('click')
    await flushPromises()
    expect(card.find('.lore-row').exists()).toBe(true)
    card.unmount()
    const standalone = mount(StructuredResourceDetails, {
      props: {
        resource: {
          id: 'world',
          type: 'worldBook',
          fileName: '世界书.json',
          originalBlob: { text: async () => JSON.stringify({ entries: raw }) },
        } as Resource,
      },
    })
    await flushPromises()
    expect(standalone.findAll('.lore-row')).toHaveLength(3)
    await standalone.findAll('.lore-row')[1]!.trigger('click')
    expect(standalone.get('.lore-facts').text()).toContain('1%')
    standalone.unmount()
  })
})
