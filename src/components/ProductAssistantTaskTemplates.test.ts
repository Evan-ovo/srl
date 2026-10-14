/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProductAssistantTaskTemplates from './ProductAssistantTaskTemplates.vue'
import type { ProductAssistantWorkspaceService } from '../services/ProductAssistantWorkspaceService'
const { choose, confirm } = vi.hoisted(() => ({ choose: vi.fn(), confirm: vi.fn() }))
vi.mock('../composables/UseConfirmDialog', () => ({ chooseAction: choose, confirmAction: confirm }))
function setup() {
  const template = { id: 'task', name: '检查保存', steps: ['点击保存', '重载检查结果'] }
  const workspace = {
    templates: vi.fn().mockResolvedValue([template]),
    saveTemplate: vi.fn().mockResolvedValue(undefined),
    removeTemplate: vi.fn().mockResolvedValue(undefined),
  }
  const w = mount(ProductAssistantTaskTemplates, {
    props: { workspace: workspace as unknown as ProductAssistantWorkspaceService },
  })
  return { template, workspace, w }
}
describe('task templates', () => {
  it('edits a reusable skill with version and scoped capabilities', async () => {
    const { w, workspace } = setup()
    try {
      await flushPromises()
      await w.vm.newTemplate()
      await flushPromises()
      await w.get('[aria-label="模板名称"]').setValue('定位保存失败')
      await w.get('[aria-label="模板操作步骤"]').setValue('核对入口\n原操作复验')
      await w.get('input[type="checkbox"]').setValue(true)
      await w.get('[aria-label="技能适用场景"]').setValue('保存报错时定位原因')
      await w.get('[aria-label="技能工作模式"]').setValue('features')
      await w.get('input[value="history"]').setValue(true)
      await w.get('form').trigger('submit')
      await flushPromises()
      expect(workspace.saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '定位保存失败',
          description: '保存报错时定位原因',
          mode: 'features',
          capabilities: ['history'],
        }),
      )
    } finally {
      w.unmount()
    }
  })
  it('uses a saved template only through an event and edits it without changing the original', async () => {
    const { w, template, workspace } = setup()
    try {
      await flushPromises()
      await w.get('[aria-label="使用模板 检查保存"]').trigger('click')
      expect(w.emitted('use')).toEqual([[template]])
      expect(workspace.saveTemplate).not.toHaveBeenCalled()
      await w.get('[aria-label="编辑模板 检查保存"]').trigger('click')
      await w.get('[aria-label="模板名称"]').setValue('新的步骤')
      await w.get('[aria-label="模板操作步骤"]').setValue('先读文件\n\n只改颜色')
      await w.get('form').trigger('submit')
      await flushPromises()
      expect(workspace.saveTemplate).toHaveBeenCalledWith({
        id: template.id,
        name: '新的步骤',
        steps: ['先读文件', '只改颜色'],
      })
      expect(template.name).toBe('检查保存')
    } finally {
      w.unmount()
    }
  })
  it('guards unsaved exit, retains an editor after failed save, and supports discarding', async () => {
    const { w, workspace } = setup()
    try {
      await flushPromises()
      await w.vm.newTemplate()
      await flushPromises()
      await w.get('[aria-label="模板名称"]').setValue('待保存')
      await w.get('[aria-label="模板操作步骤"]').setValue('操作一步')
      choose.mockResolvedValueOnce('cancel')
      expect(await w.vm.requestLeave()).toBe(false)
      choose.mockResolvedValueOnce('confirm')
      workspace.saveTemplate.mockRejectedValueOnce(new Error('存储空间不足'))
      expect(await w.vm.requestLeave()).toBe(false)
      expect(w.get('[aria-label="模板名称"]').element).toHaveProperty('value', '待保存')
      expect(w.text()).toContain('存储空间不足')
      choose.mockResolvedValueOnce('alternative')
      expect(await w.vm.requestLeave()).toBe(true)
      await flushPromises()
      expect(w.find('form').exists()).toBe(false)
    } finally {
      w.unmount()
    }
  })
  it('deletes only the chosen template after confirmation', async () => {
    const { w, workspace } = setup()
    try {
      await flushPromises()
      confirm.mockResolvedValueOnce(false)
      await w.get('[aria-label="删除模板 检查保存"]').trigger('click')
      await flushPromises()
      expect(workspace.removeTemplate).not.toHaveBeenCalled()
      confirm.mockResolvedValueOnce(true)
      await w.get('[aria-label="删除模板 检查保存"]').trigger('click')
      await flushPromises()
      expect(workspace.removeTemplate).toHaveBeenCalledWith('task')
    } finally {
      w.unmount()
    }
  })
})
