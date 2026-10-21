/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { RESOURCE_TYPE, type ResourceSummary, type ResourceType } from '../types/Resource'
import ResourcePicker from './ResourcePicker.vue'

function summary(
  id: string,
  name: string,
  type: ResourceType = RESOURCE_TYPE.PRESET,
): ResourceSummary {
  return {
    id,
    name,
    type,
    description: '',
    fileName: `${name}.json`,
    mimeType: 'application/json',
    fileSize: 12,
    contentHash: id,
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

it('does not build hidden-row search strings until there is a text query', async () => {
  let hiddenTagReads = 0
  const rows = Array.from({ length: 1000 }, (_, index) => {
    const row = summary(`row-${index}`, `资源 ${index}`)
    Object.defineProperty(row, 'tags', {
      get: () => {
        if (index >= 30) hiddenTagReads++
        return index === 999 ? ['唯一标签'] : []
      },
    })
    return row
  })
  const wrapper = mount(ResourcePicker, { props: { resources: rows, modelValue: [] } })
  try {
    expect(wrapper.findAll('[role="option"]')).toHaveLength(30)
    hiddenTagReads = 0
    await wrapper.get('input[type="search"]').setValue(' ')
    expect(hiddenTagReads).toBe(0)
    await wrapper.get('input[type="search"]').setValue('唯一标签')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.get('[role="option"]').text()).toContain('资源 999')
    expect(hiddenTagReads).toBeGreaterThan(0)
  } finally {
    wrapper.unmount()
  }
})

describe('ResourcePicker', () => {
  it('combines words across name, tag and author instead of requiring one contiguous phrase', async () => {
    const wrapper = mount(ResourcePicker, {
      props: {
        resources: [
          {
            ...summary('a', '北境角色'),
            tags: ['剧情'],
            metadata: { creator: '甲作者', authorNote: '收藏作者' },
          },
          summary('b', '北境路人'),
        ],
        modelValue: [],
      },
    })
    await wrapper.get('input[type="search"]').setValue('剧情 北境 甲作者')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.get('[role="option"]').text()).toContain('收藏作者')
  })
  it('paginates thousands of cards and combines folder and text filters without losing selection', async () => {
    const resources = Array.from({ length: 2501 }, (_, index) => ({
      ...summary(`card-${index}`, `角色 ${index}`, RESOURCE_TYPE.CHARACTER_CARD),
      categoryIds: index % 2 === 0 ? ['folder-a', 'folder-b'] : [],
    }))
    resources[2400]!.fileName = 'special-file.json'
    resources[2400]!.tags = ['特殊标签']
    const wrapper = mount(ResourcePicker, {
      props: {
        resources,
        modelValue: ['card-2400'],
        multiple: false,
        showActions: false,
        categories: [{ id: 'folder-b', name: '收藏分类', color: '', createdAt: 1, updatedAt: 1 }],
      },
    })
    expect(wrapper.findAll('[role="option"]')).toHaveLength(30)
    const next = wrapper.findAll('nav button')[1]!
    await next.trigger('click')
    expect(wrapper.get('nav').text()).toContain('2 / 84')
    await wrapper.get('select[aria-label="文件夹分类"]').setValue('folder-b')
    expect(wrapper.get('nav').text()).toContain('1 / 42')
    await wrapper.get('input[type="search"]').setValue('special-file')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.get('[role="option"]').attributes('aria-selected')).toBe('true')
    await wrapper.get('input[type="search"]').setValue('特殊标签')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    await wrapper.get('[role="option"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['card-2400'])
    await wrapper.get('select[aria-label="文件夹分类"]').setValue('uncategorized')
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('已选：角色 2400')
    expect(wrapper.find('footer').exists()).toBe(false)
  })

  it('blocks selection while the parent is saving', async () => {
    const wrapper = mount(ResourcePicker, {
      props: { resources: [summary('a', '预设')], modelValue: [], disabled: true },
    })
    await wrapper.get('[role="option"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
  it('searches resources and emits a multi-selection change', async () => {
    const wrapper = mount(ResourcePicker, {
      props: {
        resources: [summary('a', '清爽预设'), summary('b', '夜间预设')],
        modelValue: ['a'],
      },
    })
    await wrapper.get('input[type="search"]').setValue('夜间')
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(1)
    await options[0]?.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toEqual(['a', 'b'])
  })

  it('enforces allowed resource types', () => {
    const wrapper = mount(ResourcePicker, {
      props: {
        resources: [summary('a', '预设'), summary('b', '世界书', RESOURCE_TYPE.WORLD_BOOK)],
        modelValue: [],
        allowedTypes: [RESOURCE_TYPE.WORLD_BOOK],
      },
    })
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('世界书')
  })
})
