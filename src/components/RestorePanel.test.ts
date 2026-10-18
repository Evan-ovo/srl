/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import RestorePanel from './RestorePanel.vue'
import type { PreparedRestore } from '../types/Backup'
import { canRestoreOnlyPortableData } from '../services/BackupRestoreSelection'
import { taskCenter } from '../core/TaskCenter'
import BackupScopeTree from './BackupScopeTree.vue'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'

it('registers an empty gallery category catalog even without image resources and respects deselection', async () => {
  const prepared = {
    resources: [],
    versions: [],
    categories: [],
    preview: { mode: 'full', createdAt: new Date().toISOString(), portableSections: ['图库分类'] },
    portableData: { version: 1, resourceGalleryCategories: { other: ['预览图'] } },
  } as unknown as PreparedRestore
  const wrapper = mount(RestorePanel, {
    props: { prepared, busy: false },
    global: { stubs: { teleport: true } },
  })
  try {
    const tree = wrapper.getComponent(BackupScopeTree)
    expect(tree.props('availableScopeIds')).toContain('extra.resourceGallery')
    const confirm = wrapper.findAll('button').find((button) => button.text() === '确认新增')!
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirm.trigger('click')
    expect(wrapper.emitted('confirm')?.at(-1)).toEqual(['merge', [], true, false])
    await tree
      .findAll('button')
      .find((button) => button.text().includes('额外资源'))!
      .trigger('click')
    await tree.get('.backup-scope-tree__scope-row').trigger('click')
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === '确认新增')!
        .attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.get('input[value="replace"]').attributes('disabled')).toBeDefined()
  } finally {
    wrapper.unmount()
  }
})

it('shows live restore progress inside the open panel without another floating notice', async () => {
  const id = taskCenter.start({ name: '恢复备份', phase: '写入第 2 项' })
  taskCenter.update(id, { progress: 0.5 })
  const wrapper = mount(RestorePanel, {
    props: { busy: true },
    global: { stubs: { teleport: true } },
  })
  try {
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('写入第 2 项')
    expect(wrapper.get('progress').attributes('value')).toBe('0.5')
    expect(wrapper.find('.activity-center__trigger').exists()).toBe(false)
  } finally {
    wrapper.unmount()
    taskCenter.complete(id)
    taskCenter.dismiss(id)
  }
})

it('offers a manual stop and cleanup action during backup recognition', async () => {
  const wrapper = mount(RestorePanel, {
    props: { busy: true, preflightBusy: true },
    global: { stubs: { teleport: true } },
  })
  try {
    const stop = wrapper.findAll('button').find((button) => button.text() === '停止识别并清理')!
    expect(stop.exists()).toBe(true)
    await stop.trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
    expect(wrapper.text()).toContain('正在停止并清理…')
  } finally {
    wrapper.unmount()
  }
})

it('allows portable-data merge and full replacement when all originals already exist', async () => {
  const prepared = {
    resources: [],
    versions: [],
    categories: [],
    preview: {
      mode: 'full',
      createdAt: new Date().toISOString(),
      duplicatesToSkip: 2,
      portableSections: ['读了么阅读数据'],
    },
    portableData: {
      version: 1,
      chatReader: [{ appId: 'com.srl.duleme', key: 'chat:old', value: { note: '保留原备注' } }],
    },
  } as unknown as PreparedRestore
  expect(canRestoreOnlyPortableData(prepared)).toBe(true)
  expect(canRestoreOnlyPortableData({ ...prepared, portableData: undefined })).toBe(false)
  const wrapper = mount(RestorePanel, {
    props: { prepared, busy: false },
    global: { stubs: { teleport: true } },
  })
  try {
    const confirm = wrapper.findAll('button').find((button) => button.text() === '确认新增')!
    expect(confirm.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('input[value="replace"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('成功后无法自动撤销，建议先导出当前库')
    expect(wrapper.text()).not.toContain('创建完整快照')
    await confirm.trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([['merge', [], false, false]])
    await wrapper.get('input[value="replace"]').setValue(true)
    const replace = wrapper.findAll('button').find((button) => button.text() === '确认覆盖')!
    expect(replace.attributes('disabled')).toBeUndefined()
    await replace.trigger('click')
    expect(wrapper.emitted('confirm')?.at(-1)).toEqual(['replace', [], false, false])
  } finally {
    wrapper.unmount()
  }
})

it('uses the shared registry to deselect gallery images while retaining the cover dependency', async () => {
  const owner = {
    id: 'owner',
    type: RESOURCE_TYPE.OTHER,
    name: '资源',
    fileName: 'a.bin',
    fileSize: 2,
    metadata: { resourceCoverId: 'cover' },
    tags: [],
  } as unknown as Resource
  const image = (id: string) => ({
    ...owner,
    id,
    metadata: {
      assetKind: 'resource-gallery-image',
      galleryOwnerId: 'owner',
      galleryVisible: true,
    },
  })
  const prepared = {
    resources: [owner, image('cover'), image('chat')],
    versions: [],
    categories: [],
    preview: { mode: 'full', createdAt: new Date().toISOString() },
  } as unknown as PreparedRestore
  const wrapper = mount(RestorePanel, {
    props: { prepared, busy: false },
    global: { stubs: { teleport: true } },
  })
  try {
    const tree = wrapper.getComponent(BackupScopeTree)
    expect(tree.props('availableScopeIds')).toContain('extra.resourceGallery')
    await tree.vm.$emit('update:modelValue', { resourceIds: ['owner'], scopeIds: [] })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('input[value="replace"]').attributes('disabled')).toBeDefined()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '确认新增')!
      .trigger('click')
    expect(wrapper.emitted('confirm')?.at(-1)).toEqual(['merge', ['owner', 'cover'], false, false])
  } finally {
    wrapper.unmount()
  }
})
