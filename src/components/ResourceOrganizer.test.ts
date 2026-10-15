/** @vitest-environment jsdom */
import { DOMWrapper, flushPromises, mount, shallowMount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
// Resolve this lazily mounted panel before the jsdom test environment tears down.
import './StructuredResourceDetails.vue'
import './CharacterCardDetails.vue'
import ResourceOrganizer from './ResourceOrganizer.vue'

it('prepares a tab before mounting its editor, preserves the draft, and offers explicit retry', async () => {
  const resource = {
    id: 'prepared',
    name: '角色',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    description: '',
    fileName: 'card.json',
    mimeType: 'application/json',
    fileSize: 2,
    contentHash: 'hash',
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: { card: { data: { name: '角色' } } },
    originalBlob: new Blob(['{}']),
    createdAt: 1,
    updatedAt: 1,
  } as Resource
  let ready!: () => void
  const prepareTab = vi.fn(async (tab: string) => {
    if (tab === 'content')
      await new Promise<void>((resolve) => {
        ready = resolve
      })
  })
  const mounted = vi.fn()
  const editor = defineComponent({
    setup() {
      mounted()
      const value = ref('')
      return () =>
        h('input', {
          value: value.value,
          'aria-label': 'prepared draft',
          onInput: (e: Event) => {
            value.value = (e.target as HTMLInputElement).value
          },
        })
    },
  })
  const wrapper = mount(ResourceOrganizer, {
    props: {
      resource,
      resources: [resource],
      boundResources: [],
      versions: [],
      categories: [],
      busy: false,
      prepareTab,
    },
    global: {
      stubs: {
        CharacterCardDetails: editor,
        ResourceCoverEditor: true,
        ResourceSourceLinks: true,
        ResourcePicker: true,
        ResourceVersionCarriers: true,
      },
    },
  })
  const dom = new DOMWrapper(document.body)
  try {
    await flushPromises()
    ;(dom.get('.resource-detail__layout').element as HTMLElement).scrollTo = vi.fn()
    await dom.get('#resource-tab-content').trigger('click')
    expect(mounted).not.toHaveBeenCalled()
    ready()
    await flushPromises()
    await dom.get('[aria-label="prepared draft"]').setValue('keep draft')
    await dom.get('#resource-tab-overview').trigger('click')
    await dom.get('#resource-tab-content').trigger('click')
    await flushPromises()
    expect(mounted).toHaveBeenCalledOnce()
    expect((dom.get('[aria-label="prepared draft"]').element as HTMLInputElement).value).toBe(
      'keep draft',
    )
    prepareTab.mockRejectedValueOnce(new Error('history fixture failure'))
    await dom.get('#resource-tab-versions').trigger('click')
    await flushPromises()
    expect(dom.get('[role="alert"]').text()).toContain('history fixture failure')
    expect(dom.find('#resource-panel-versions').exists()).toBe(false)
    await dom
      .findAll('button')
      .find((button) => button.text() === '重试读取')!
      .trigger('click')
    await flushPromises()
    expect(dom.find('#resource-panel-versions').exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it.each([undefined, 'content'] as const)(
  'defers hidden metadata and preserves a visited content draft (initial tab: %s)',
  async (initialTab) => {
    const serialize = vi.fn(() => ({ card: { data: { name: '角色' } } }))
    const contentMounted = vi.fn()
    const Content = defineComponent({
      name: 'CharacterCardDetails',
      setup() {
        contentMounted()
        const draft = ref('')
        return () =>
          h('input', {
            'aria-label': '内容草稿',
            value: draft.value,
            onInput: (event: Event) => {
              draft.value = (event.target as HTMLInputElement).value
            },
          })
      },
    })
    const resource: Resource = {
      id: 'lazy-detail',
      name: '角色',
      description: '',
      type: RESOURCE_TYPE.CHARACTER_CARD,
      fileName: 'card.json',
      mimeType: 'application/json',
      fileSize: 2,
      contentHash: 'hash',
      favorite: false,
      categoryId: null,
      categoryIds: [],
      tags: [],
      metadata: { card: { data: { name: '角色' } }, toJSON: serialize },
      originalBlob: new Blob(['{}']),
      createdAt: 1,
      updatedAt: 1,
    }
    const wrapper = mount(ResourceOrganizer, {
      props: {
        initialTab,
        resource,
        resources: [resource],
        boundResources: [],
        versions: [],
        categories: [],
        busy: false,
      },
      global: {
        stubs: {
          Teleport: false,
          CharacterCardDetails: Content,
          ResourceCoverEditor: true,
          ResourcePicker: true,
          ResourceSourceLinks: true,
          ResourceVersionCarriers: true,
        },
      },
    })
    const dom = new DOMWrapper(document.body)
    await flushPromises()
    ;(dom.get('.resource-detail__layout').element as HTMLElement).scrollTo = vi.fn()
    expect(contentMounted).toHaveBeenCalledTimes(initialTab === 'content' ? 1 : 0)
    expect(serialize).not.toHaveBeenCalled()
    expect(dom.find('#resource-panel-content').exists()).toBe(initialTab === 'content')
    expect(dom.find('#resource-panel-file').exists()).toBe(false)

    await dom.get('#resource-tab-content').trigger('click')
    await flushPromises()
    expect(contentMounted).toHaveBeenCalledTimes(1)
    await dom.get('input[aria-label="内容草稿"]').setValue('未保存的编辑')
    await dom.get('#resource-tab-overview').trigger('click')
    expect(dom.get('#resource-panel-content').isVisible()).toBe(false)
    await dom.get('#resource-tab-content').trigger('click')
    expect(contentMounted).toHaveBeenCalledTimes(1)
    expect((dom.get('input[aria-label="内容草稿"]').element as HTMLInputElement).value).toBe(
      '未保存的编辑',
    )

    await dom.get('#resource-tab-file').trigger('click')
    expect(dom.get('#resource-panel-file pre').text()).toContain('角色')
    expect(serialize).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  },
)

it.each([RESOURCE_TYPE.CHARACTER_CARD, RESOURCE_TYPE.WORLD_BOOK, RESOURCE_TYPE.REGEX])(
  'uses the full-page content editor for %s and restores detail controls without losing changes',
  async (type) => {
    const prepareSave = vi.fn().mockResolvedValue(false)
    const resource: Resource = {
      id: 'editing',
      name: '编辑资源',
      type,
      description: '',
      fileName: 'content.json',
      mimeType: 'application/json',
      fileSize: 2,
      contentHash: 'hash',
      favorite: false,
      categoryId: null,
      categoryIds: [],
      tags: [],
      metadata: {},
      originalBlob: new Blob(['{}']),
      createdAt: 1,
      updatedAt: 1,
    }
    const editor = { template: '<div><slot name="content-save" /></div>', methods: { prepareSave } }
    const wrapper = shallowMount(ResourceOrganizer, {
      props: {
        initialTab: 'content',
        resource,
        resources: [resource],
        boundResources: [],
        versions: [],
        categories: [],
        busy: false,
      },
      global: {
        stubs: { Teleport: true, CharacterCardDetails: editor, StructuredResourceDetails: editor },
      },
    })
    await flushPromises()
    expect(wrapper.get('.resource-detail__tabs').isVisible()).toBe(true)
    expect(wrapper.find('.resource-detail__actions').exists()).toBe(true)
    const content = () =>
      wrapper.findComponent({
        ref: type === RESOURCE_TYPE.CHARACTER_CARD ? 'characterContent' : 'structuredContent',
      })
    content().vm.$emit('workbench-open', true)
    await flushPromises()
    expect(wrapper.get('.resource-detail-overlay').classes()).toContain(
      'resource-detail-overlay--content-editor',
    )
    expect(wrapper.get('.resource-detail-sheet').classes()).toContain(
      'resource-detail-sheet--content-editor',
    )
    expect(wrapper.get('.resource-detail__tabs').isVisible()).toBe(false)
    expect(wrapper.find('.resource-detail__actions').exists()).toBe(false)
    const save = wrapper.get('.resource-detail__editor-save')
    expect(save.attributes('form')).toBe('resource-organize-section')
    expect(save.attributes('disabled')).toBeDefined()
    content().vm.$emit('draft-change', true)
    await flushPromises()
    expect(wrapper.get('.resource-detail__editor-save').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(prepareSave).toHaveBeenCalledOnce()
    expect(wrapper.emitted('save')).toBeUndefined()
    prepareSave.mockResolvedValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ name: '编辑资源' })
    content().vm.$emit('workbench-open', false)
    await flushPromises()
    expect(wrapper.get('.resource-detail__tabs').isVisible()).toBe(true)
    expect(wrapper.find('.resource-detail__editor-save').exists()).toBe(false)
    expect(wrapper.get('.resource-detail__actions').text()).toContain('有未保存修改')
    wrapper.unmount()
  },
)
it('pages thousands of relations and preserves chosen IDs through folder and search filters', async () => {
  const resources: ResourceSummary[] = Array.from({ length: 5000 }, (_, index) => ({
    id: `card-${index}`,
    name: `角色 ${String(index).padStart(4, '0')}`,
    description: '',
    type: [RESOURCE_TYPE.WORLD_BOOK, RESOURCE_TYPE.CHARACTER_CARD, RESOURCE_TYPE.REGEX][index % 3]!,
    fileName: `file-${index}.json`,
    mimeType: 'application/json',
    fileSize: 2,
    contentHash: `hash-${index}`,
    favorite: false,
    categoryId: index % 2 ? null : 'a',
    categoryIds: index === 4999 ? ['a', 'b'] : [],
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }))
  const current: Resource = {
    ...resources[0]!,
    id: 'current',
    name: '当前资源',
    originalBlob: new Blob(['{}']),
  }
  const wrapper = shallowMount(ResourceOrganizer, {
    props: {
      initialTab: 'relations',
      resource: current,
      resources: [current, ...resources],
      boundResources: [],
      versions: [],
      categories: [
        { id: 'a', name: '常用', color: '', createdAt: 1, updatedAt: 1 },
        { id: 'b', name: '收藏', color: '', createdAt: 1, updatedAt: 1 },
      ],
      busy: false,
    },
    global: {
      stubs: {
        Teleport: true,
        StructuredResourceDetails: {
          template: '<div />',
          methods: { prepareSave: async () => true },
        },
      },
    },
  })
  await flushPromises()
  expect(wrapper.findAll('.resource-relation')).toHaveLength(30)
  await wrapper.get('.resource-relations__pagination').findAll('button')[1]!.trigger('click')
  expect(wrapper.get('.resource-relations__pagination').text()).toContain('2 / 167')
  await wrapper.get('select[aria-label="关联资源类型"]').setValue(RESOURCE_TYPE.CHARACTER_CARD)
  expect(wrapper.get('.resource-relations__pagination').text()).toContain('1 / 56')
  expect(wrapper.findAll('.resource-relation')).toHaveLength(30)
  expect(wrapper.findAll('.resource-relations__groups > section')).toHaveLength(1)
  expect(wrapper.get('.resource-relations__groups > section > header').text()).toContain('角色卡')
  await wrapper.get('select[aria-label="关联资源文件夹"]').setValue('b')
  expect(wrapper.findAll('.resource-relation')).toHaveLength(1)
  expect(wrapper.get('.resource-relation').text()).toContain('file-4999.json')
  await wrapper.get('.resource-relation input[type="checkbox"]').setValue(true)
  await wrapper.get('select[aria-label="关联资源类型"]').setValue(RESOURCE_TYPE.WORLD_BOOK)
  expect(wrapper.find('.resource-relation--selected').exists()).toBe(false)
  await wrapper.get('select[aria-label="关联资源类型"]').setValue('all')
  expect(wrapper.get('.resource-relation--selected').text()).toContain('file-4999.json')
  await wrapper.get('select[aria-label="关联资源文件夹"]').setValue('uncategorized')
  expect(wrapper.find('.resource-relation--selected').exists()).toBe(false)
  await wrapper.get('select[aria-label="关联资源文件夹"]').setValue('all')
  expect(wrapper.get('.resource-relation--selected').text()).toContain('file-4999.json')
  await wrapper.get('.resource-relations__search input').setValue('无匹配')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ relatedResourceIds: ['card-4999'] })
  wrapper.unmount()
})

it('edits a note on one packaging file without affecting its sibling carrier', async () => {
  const current: Resource = {
    id: 'current',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: '同一角色',
    description: '',
    fileName: 'card-current.png',
    mimeType: 'image/png',
    fileSize: 3,
    contentHash: 'current-hash',
    favorite: false,
    categoryId: null,
    categoryIds: [],
    relatedResourceIds: [],
    tags: [],
    metadata: { card: { data: { name: '同一角色' } } },
    originalBlob: new Blob(['current png'], { type: 'image/png' }),
    createdAt: 1,
    updatedAt: 1,
  }
  const alternate: Resource = {
    ...current,
    id: 'alternate',
    fileName: 'card-alternate.png',
    contentHash: 'alternate-hash',
    originalBlob: new Blob(['alternate png'], { type: 'image/png' }),
    versionGroupId: current.id,
    versionNote: '作者原版立绘',
  }
  const wrapper = shallowMount(ResourceOrganizer, {
    props: {
      initialTab: 'versions',
      resource: current,
      resources: [current],
      boundResources: [],
      versions: [{ resource: current, active: true, carriers: [current, alternate] }],
      categories: [],
      busy: false,
    },
    global: { stubs: { Teleport: true, ResourceVersionCarriers: false } },
  })
  await flushPromises()

  const carriers = wrapper.findAll('.resource-version-carriers > article')
  expect(carriers).toHaveLength(2)
  expect(carriers.every((carrier) => !carrier.get('details').element.open)).toBe(true)
  await carriers[1]!.get('details > summary').trigger('click')
  expect(
    carriers.flatMap((carrier) => carrier.findAll('button').map((button) => button.text())),
  ).toContain('对比图片')
  expect(
    carriers[1]!
      .findAll('button')
      .find((button) => button.text() === '对比图片')!
      .attributes('aria-label'),
  ).toContain('card-alternate.png')
  await carriers[1]!
    .findAll('button')
    .find((button) => button.text() === '备注')!
    .trigger('click')
  const editedCarrier = wrapper.findAll('.resource-version-carriers > article')[1]!
  const editor = editedCarrier.get('.resource-version-carrier__note-editor')
  await editor.get('textarea').setValue('透明底备用立绘')
  await wrapper
    .findAll('.resource-version-carriers > article')[1]!
    .get('.resource-version-carrier__note-editor')
    .findAll('button')
    .find((button) => button.text() === '保存封装备注')!
    .trigger('click')

  expect(wrapper.emitted('updateVersionNote')).toEqual([['alternate', '透明底备用立绘']])
  expect(
    wrapper
      .findAll('.resource-version-carriers > article')[0]!
      .find('.resource-version-carrier__note-editor')
      .exists(),
  ).toBe(false)
  expect(await current.originalBlob.text()).toBe('current png')
  expect(await alternate.originalBlob.text()).toBe('alternate png')
  wrapper.unmount()
})
