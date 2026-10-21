/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import BackupScopeTree from './BackupScopeTree.vue'
import { createDefaultBackupSelection } from '../services/BackupScopeRegistry'
import { RESOURCE_TYPE, type Category, type ResourceSummary } from '../types/Resource'

const categories: Category[] = [
  {
    id: 'folder-a',
    name: '常用',
    color: '#4aa',
    createdAt: 1,
    updatedAt: 1,
  },
]

const resources = [
  {
    id: 'card-a',
    name: '常用角色卡',
    fileName: 'a.png',
    fileSize: 2_000,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    categoryId: 'folder-a',
    categoryIds: ['folder-a'],
    metadata: {},
  },
  {
    id: 'card-b',
    name: '未归档角色卡',
    fileName: 'b.png',
    fileSize: 3_000,
    type: RESOURCE_TYPE.CHARACTER_CARD,
    categoryId: null,
    metadata: {},
  },
  {
    id: 'secret',
    name: '密钥资料',
    fileName: 'secret.json',
    fileSize: 1_000,
    type: RESOURCE_TYPE.SECRET,
    categoryId: null,
    metadata: {},
  },
] as ResourceSummary[]

describe('BackupScopeTree', () => {
  it('does not build search strings for the unqueried catalogue', async () => {
    let tagReads = 0
    const cards = Array.from({ length: 1000 }, (_, index) => ({
      ...resources[0]!,
      id: `row-${index}`,
      name: `角色 ${index}`,
      get tags() {
        tagReads++
        return index === 999 ? ['唯一标签'] : []
      },
    }))
    const wrapper = mount(BackupScopeTree, {
      props: { resources: cards, mode: 'local', modelValue: { resourceIds: [], scopeIds: [] } },
    })
    try {
      await wrapper.get('button[aria-label="展开角色卡"]').trigger('click')
      tagReads = 0
      await wrapper.get('input[type="search"]').setValue(' ')
      expect(tagReads).toBe(0)
      await wrapper.get('input[type="search"]').setValue('唯一标签')
      expect(wrapper.findAll('.backup-scope-tree__resources label')).toHaveLength(1)
      expect(wrapper.get('.backup-scope-tree__resources label').text()).toContain('角色 999')
    } finally {
      wrapper.unmount()
    }
  })
  it('paginates 2501 resources and searching preserves selection outside the results', async () => {
    const cards = Array.from({ length: 2501 }, (_, index) => ({
      ...resources[0]!,
      id: `bulk-${index}`,
      name: `角色 ${index}`,
      fileName: `file-${index}.json`,
      tags: index === 2400 ? ['稀有'] : [],
    }))
    const wrapper = mount(BackupScopeTree, {
      props: {
        resources: cards,
        mode: 'local',
        modelValue: { resourceIds: ['bulk-0'], scopeIds: [] },
      },
    })
    await wrapper.get('button[aria-label="展开角色卡"]').trigger('click')
    expect(wrapper.findAll('.backup-scope-tree__resources label')).toHaveLength(30)
    await wrapper.findAll('nav[aria-label="角色卡分页"] button')[1]!.trigger('click')
    expect(wrapper.get('nav').text()).toContain('2 / 84')
    await wrapper.get('input[type="search"]').setValue('2400 稀有')
    expect(wrapper.findAll('.backup-scope-tree__resources label')).toHaveLength(1)
    await wrapper.get('.backup-scope-tree__resources input').setValue(true)
    const emitted = wrapper.emitted('update:modelValue')!.at(-1)![0] as { resourceIds: string[] }
    expect(emitted.resourceIds).toEqual(['bulk-0', 'bulk-2400'])
    await wrapper.setProps({ modelValue: { resourceIds: emitted.resourceIds, scopeIds: [] } })
    await wrapper.get('input[type="search"]').setValue('不存在')
    expect(wrapper.text()).toContain('2 项资源')
    await wrapper.get('input[type="search"]').setValue('')
    expect(wrapper.get('nav').text()).toContain('1 / 84')
    wrapper.unmount()
  })
  it('counts selected gallery bytes and keeps cover bytes when the gallery is unchecked', async () => {
    const owner = { ...resources[0]!, fileSize: 1024, metadata: { resourceCoverId: 'cover' } }
    const attachment = (id: string, fileSize: number) => ({
      ...owner,
      id,
      type: RESOURCE_TYPE.OTHER,
      fileSize,
      metadata: {
        assetKind: 'resource-gallery-image',
        galleryOwnerId: owner.id,
        galleryVisible: true,
      },
    })
    const wrapper = mount(BackupScopeTree, {
      props: {
        resources: [owner, attachment('cover', 2048), attachment('gallery', 4096)],
        mode: 'local',
        modelValue: { resourceIds: [owner.id], scopeIds: ['extra.resourceGallery'] },
      },
    })
    try {
      expect(wrapper.get('.backup-scope-tree__summary').text()).toContain('1 项资源')
      expect(wrapper.get('.backup-scope-tree__summary').text()).toContain('7.0 KB')
      await wrapper.setProps({ modelValue: { resourceIds: [owner.id], scopeIds: [] } })
      expect(wrapper.get('.backup-scope-tree__summary').text()).toContain('1 项资源')
      expect(wrapper.get('.backup-scope-tree__summary').text()).toContain('3.0 KB')
    } finally {
      wrapper.unmount()
    }
  })
  it('在酒馆资源分组内保留文件夹查看入口', async () => {
    const initial = createDefaultBackupSelection(resources, 'local')
    const wrapper = mount(BackupScopeTree, {
      props: {
        resources,
        categories,
        mode: 'local',
        modelValue: { resourceIds: [...initial.resourceIds], scopeIds: [...initial.scopes] },
      },
    })

    expect(wrapper.text()).toContain('按文件夹查看')
    await wrapper.get('button[aria-label="展开角色卡"]').trigger('click')
    const folderButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('常用 1'))
    await folderButton?.trigger('click')
    expect(wrapper.text()).toContain('常用角色卡')
    expect(wrapper.text()).not.toContain('未归档角色卡')
  })

  it('把敏感提示和查看操作放在独立操作行', () => {
    const wrapper = mount(BackupScopeTree, {
      props: {
        resources,
        categories: [],
        mode: 'local',
        modelValue: { resourceIds: [], scopeIds: [] },
      },
    })
    const keyScope = wrapper
      .findAll('.backup-scope-tree__scope')
      .find((scope) => scope.text().includes('密钥'))
    expect(keyScope?.find('.backup-scope-tree__scope-actions em').text()).toContain('需要确认')
    expect(keyScope?.find('.backup-scope-tree__scope-actions button').exists()).toBe(true)
  })

  it('显示云端范围被禁用的具体原因', async () => {
    const wrapper = mount(BackupScopeTree, {
      props: {
        resources,
        categories: [],
        mode: 'cloud',
        modelValue: { resourceIds: [], scopeIds: [] },
        disabledScopeIds: ['extra.communitySources'],
        disabledScopeReasons: { 'extra.communitySources': '先确认 GitHub 仓库为私有' },
      },
    })

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('额外资源'))
      ?.trigger('click')
    expect(wrapper.text()).toContain('先确认 GitHub 仓库为私有')
  })
})
