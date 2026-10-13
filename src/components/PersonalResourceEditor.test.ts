/** @vitest-environment jsdom */
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
import type { PersonalResourceDocument } from '../types/PersonalResource'
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  attachment: vi.fn(),
  hasPassword: vi.fn(),
  isUnlocked: vi.fn(),
  protect: vi.fn(),
  reveal: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../core/PersonalResourceContainer', () => ({ personalResourceService: mocks }))
vi.mock('../services/SecretResourceService', () => ({ secretResourceService: mocks }))
vi.mock('../core/NativeSecurity', () => ({ isNativeSecurityAvailable: () => false }))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: mocks.confirm }))
import PersonalResourceEditor from './PersonalResourceEditor.vue'
enableAutoUnmount(afterEach)
const resource = { id: 'saved-id', name: '旧资源' } as Resource
const document = (
  kind: PersonalResourceDocument['kind'] = 'extraStory',
): PersonalResourceDocument => ({
  format: 'srl-personal-resource',
  version: 1,
  kind,
  name: '旧资源',
  text: '已保存正文',
  url: '',
  fields: [],
  attachments: [],
})
function button(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text() === text)!
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.hasPassword.mockResolvedValue(true)
  mocks.read.mockResolvedValue(document())
  mocks.save.mockResolvedValue(resource)
  mocks.confirm.mockResolvedValue(true)
})
const mountEditor = (kind: PersonalResourceDocument['kind'], existing = true) =>
  mount(PersonalResourceEditor, {
    props: { kind, resource: existing ? resource : undefined },
    global: { stubs: { Teleport: true } },
  })
it('opens reactive pocket-phone metadata and cancels edits without changing its saved source', async () => {
  const saved = reactive(document('pocketPhone'))
  mocks.read.mockResolvedValue(saved)
  const w = mountEditor('pocketPhone')
  await flushPromises()
  expect(w.text()).not.toContain('could not be cloned')
  expect(w.text()).toContain('已保存正文')
  await button(w, '编辑').trigger('click')
  await w.get('textarea').setValue('未保存的说明')
  expect(saved.text).toBe('已保存正文')
  w.vm.requestBack()
  await flushPromises()
  expect(w.text()).toContain('已保存正文')
  expect(w.text()).not.toContain('未保存的说明')
  expect(mocks.save).not.toHaveBeenCalled()
})
it('starts with name only and lets each field own its label, value and privacy without folding away the focused control', async () => {
  const w = mountEditor('secret', false)
  await flushPromises()
  expect(w.findAll('input')).toHaveLength(1)
  expect(w.findAll('textarea')).toHaveLength(0)
  await button(w, '＋添加字段').trigger('click')
  const row = w.get('.personal-resource-editor__field')
  const name = row.get('input:not([type="checkbox"])')
  const element = name.element
  await name.setValue('A')
  await name.setValue('API')
  expect(row.get('input:not([type="checkbox"])').element).toBe(element)
  expect(row.find('details').exists()).toBe(false)
  expect((row.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  await row.get('input[type="checkbox"]').setValue(false)
  await row.get('textarea').setValue('user-chosen-value')
  await button(w, '＋添加字段').trigger('click')
  await w.get('[aria-label="删除字段 2"]').trigger('click')
  expect(w.findAll('.personal-resource-editor__field')).toHaveLength(1)
  expect((row.get('textarea').element as HTMLTextAreaElement).value).toBe('user-chosen-value')
})
it('opens general settings without discarding the draft and picks up its shared unlock when returning', async () => {
  mocks.hasPassword.mockResolvedValue(false)
  const w = mountEditor('secret', false)
  await flushPromises()
  await w.get('input[maxlength]').setValue('草稿')
  await button(w, '＋添加字段').trigger('click')
  await w.get('textarea').setValue('secret-draft')
  await button(w, '去总设置设置密码').trigger('click')
  expect(w.emitted('open-settings')).toHaveLength(1)
  await w.setProps({ settingsOpen: true })
  mocks.hasPassword.mockResolvedValue(true)
  mocks.isUnlocked.mockReturnValue(true)
  await w.setProps({ settingsOpen: false })
  await flushPromises()
  expect(w.find('input[type="password"]').exists()).toBe(false)
  expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('secret-draft')
})
it('creates then opens a readable resource; subsequent saves use the same resource and cancel restores the stored value', async () => {
  const w = mountEditor('extraStory', false)
  await flushPromises()
  expect(button(w, '复制番外指令')).toBeUndefined()
  await w.get('input[maxlength]').setValue('新资源')
  await w.get('textarea').setValue('第一版')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.emitted('close')).toBeUndefined()
  expect(w.find('textarea').exists()).toBe(false)
  expect(w.text()).toContain('第一版')
  await button(w, '编辑').trigger('click')
  await w.get('textarea').setValue('第二版')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.save.mock.calls[1]?.[2]).toEqual(resource)
  await button(w, '编辑').trigger('click')
  await w.get('textarea').setValue('未保存内容')
  mocks.confirm.mockResolvedValueOnce(false)
  w.vm.requestBack()
  await flushPromises()
  expect(w.get('textarea').element.value).toBe('未保存内容')
  w.vm.requestBack()
  await flushPromises()
  expect(w.text()).toContain('第二版')
  expect(w.text()).not.toContain('未保存内容')
  expect(w.emitted('close')).toBeUndefined()
  expect(button(w, '文件夹 / 标签 / 历史')).toBeUndefined()
})
it('embeds actions without a nested form and returns from editing to the same detail', async () => {
  const w = mount(PersonalResourceEditor, {
    props: { kind: 'extraStory', resource, embedded: true },
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  expect(w.find('form').exists()).toBe(false)
  expect(w.find('[role="dialog"]').exists()).toBe(false)
  await w.setProps({ resource: { ...resource, name: '整理后的名称' } })
  await button(w, '编辑').trigger('click')
  expect(w.find('form').exists()).toBe(true)
  await w.get('textarea').setValue('更新正文')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.save.mock.calls[0]?.[0].name).toBe('整理后的名称')
  expect(w.find('form').exists()).toBe(false)
  expect(w.emitted('close')).toBeUndefined()
})
it('puts an embedded personal-resource editor on its own layer while editing', async () => {
  const w = mount(PersonalResourceEditor, {
    props: { kind: 'secret', resource, embedded: true },
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  expect(w.find('.personal-resource-editor-overlay').exists()).toBe(false)
  await button(w, '编辑').trigger('click')
  expect(w.find('.personal-resource-editor-overlay').exists()).toBe(true)
})
it('does not expose empty editing or allow overwrite after a read failure', async () => {
  mocks.read.mockRejectedValue(new Error('读取失败'))
  const w = mountEditor('pocketPhone')
  await flushPromises()
  expect(w.text()).toContain('读取失败')
  expect(w.find('form').exists()).toBe(false)
  expect(button(w, '保存')).toBeUndefined()
})
it('edits URL and attachments together without a redundant collection choice', async () => {
  const doc = document('pocketPhone')
  doc.url = 'https://example.com'
  doc.attachments = [{ path: 'attachments/a', name: 'phone.apk', kind: 'apk', size: 3 }]
  mocks.read.mockResolvedValue(doc)
  const w = mountEditor('pocketPhone')
  await flushPromises()
  expect(w.get('a').attributes('href')).toBe(doc.url)
  expect(button(w, '下载')).toBeDefined()
  await button(w, '编辑').trigger('click')
  expect(w.find('input[type="radio"]').exists()).toBe(false)
  expect(w.find('input[type="url"]').exists()).toBe(true)
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
    url: doc.url,
    attachments: doc.attachments,
  })
})
it('keeps private values locked, unlocks for use, and cancels edits back to encrypted data', async () => {
  const doc = document('secret')
  doc.fields = [{ id: 'key', label: '密钥', value: '', private: true }]
  doc.protected = { salt: 's', iv: 'i', data: 'encrypted', iterations: 310000 }
  mocks.read.mockResolvedValue(doc)
  mocks.reveal.mockResolvedValue([{ ...doc.fields[0], value: 'secret-value' }])
  const w = mountEditor('secret')
  await flushPromises()
  expect(w.get('[aria-label="复制密钥"]').attributes('disabled')).toBeDefined()
  expect(button(w, '密码设置')).toBeDefined()
  expect(button(w, '密码设置 / 找回')).toBeUndefined()
  expect(w.text()).toContain('iOS 和网页端不支持密码找回')
  expect(button(w, '编辑')).toBeUndefined()
  await w.get('input[type="password"]').setValue('password123')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('secret-value')
  await button(w, '编辑').trigger('click')
  await w.get('textarea[aria-label="密钥"]').setValue('changed-private')
  await button(w, '取消编辑').trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('secret-value')
  expect(w.text()).not.toContain('changed-private')
  expect(w.get('[aria-label="复制密钥"]').attributes('disabled')).toBeDefined()
  expect(mocks.save).not.toHaveBeenCalled()
})
