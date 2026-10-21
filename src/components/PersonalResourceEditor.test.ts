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
  hasRememberedPassword: vi.fn(),
  lock: vi.fn(),
  protect: vi.fn(),
  reveal: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../core/PersonalResourceContainer', () => ({ personalResourceService: mocks }))
vi.mock('../services/SecretResourceService', () => ({ secretResourceService: mocks }))
vi.mock('../core/NativeSecurity', () => ({ isNativeSecurityAvailable: () => false }))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: mocks.confirm }))
import PersonalResourceEditor from './PersonalResourceEditor.vue'
import { File as NodeFile } from 'node:buffer'
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
it('imports TXT into an editable draft, fills an empty name, and saves only on explicit save', async () => {
  const w = mountEditor('extraStory', false)
  await flushPromises()
  expect(button(w, '导入 TXT/Word')).toBeTruthy()
  const input = w.get('input[type="file"][aria-label="导入 TXT/Word 文件"]')
  expect(input.attributes('accept')).toContain('.docx')
  expect(input.attributes('accept')).toContain('.doc,')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new NodeFile(['导入的正文\n{{user}}'], '示例.txt')],
  })
  await input.trigger('change')
  await flushPromises()
  expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('导入的正文\n{{user}}')
  expect((w.get('input[required]').element as HTMLInputElement).value).toBe('示例')
  expect(mocks.save).not.toHaveBeenCalled()
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'extraStory', text: '导入的正文\n{{user}}', name: '示例' }),
    expect.any(Map),
    undefined,
  )
})
it('preserves existing draft on rejected replacement or extraction failure', async () => {
  const w = mountEditor('extraStory', false)
  await flushPromises()
  await w.get('textarea').setValue('原草稿')
  mocks.confirm.mockResolvedValueOnce(false)
  const input = w.get('input[type="file"][aria-label="导入 TXT/Word 文件"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new NodeFile(['新正文'], 'new.txt')],
  })
  await input.trigger('change')
  await flushPromises()
  expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('原草稿')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new NodeFile(['broken'], 'bad.doc')],
  })
  await input.trigger('change')
  await flushPromises()
  expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('原草稿')
  expect(mocks.save).not.toHaveBeenCalled()
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
  expect(w.findAll('input:not([type="checkbox"])')).toHaveLength(1)
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
it('saves a new unencrypted card without configuring or requesting a password', async () => {
  mocks.hasPassword.mockRejectedValue(new Error('password store unavailable'))
  const w = mountEditor('secret', false)
  await flushPromises()
  await w.get('input[maxlength]').setValue('本机资料')
  await button(w, '＋添加字段').trigger('click')
  await w.get('textarea').setValue('synthetic-plain-value')
  expect(w.find('input[type="password"]').exists()).toBe(false)
  expect(w.text()).not.toContain('备份中以明文保存')
  await w.get('[aria-label="密钥加密说明"]').trigger('click')
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: '密钥加密说明',
      message: expect.stringContaining('备份中以明文保存'),
    }),
  )
  expect((w.get('[aria-label="使用统一密码加密"]').element as HTMLInputElement).checked).toBe(false)
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.protect).not.toHaveBeenCalled()
  expect(mocks.hasPassword).not.toHaveBeenCalled()
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      protection: 'none',
      fields: [expect.objectContaining({ private: true, value: 'synthetic-plain-value' })],
    }),
    expect.any(Map),
    undefined,
  )
})
it('opens general settings without discarding the draft and picks up its shared unlock when returning', async () => {
  mocks.hasPassword.mockResolvedValue(false)
  const w = mountEditor('secret', false)
  await flushPromises()
  await w.get('input[maxlength]').setValue('草稿')
  await button(w, '＋添加字段').trigger('click')
  await w.get('textarea').setValue('secret-draft')
  await w.get('[aria-label="使用统一密码加密"]').setValue(true)
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
it('reuses a source session for another encrypted card and clears it on explicit lock', async () => {
  const doc = document('secret')
  doc.fields = [{ id: 'key', label: 'Key', value: '', private: true }]
  doc.protected = { salt: 'source', iv: 'iv', data: 'encrypted', iterations: 310000 }
  mocks.read.mockResolvedValue(doc)
  mocks.hasRememberedPassword.mockReturnValue(true)
  mocks.reveal.mockResolvedValue([{ ...doc.fields[0], value: 'synthetic-imported-value' }])
  const w = mountEditor('secret')
  await flushPromises()
  expect(w.find('input[type="password"]').exists()).toBe(false)
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.reveal).toHaveBeenCalledWith(expect.anything(), undefined)
  expect(w.text()).toContain('synthetic-imported-value')
  await button(w, '锁定私密内容').trigger('click')
  expect(mocks.lock).toHaveBeenCalledOnce()
  expect(w.find('input[type="password"]').exists()).toBe(true)
  expect(w.text()).not.toContain('synthetic-imported-value')
})
it('does not unlock inline private fields while confirming Chinese composition', async () => {
  const doc = document('secret')
  doc.fields = [{ id: 'key', label: '密钥', value: '', private: true }]
  doc.protected = { salt: 's', iv: 'i', data: 'encrypted', iterations: 310000 }
  mocks.read.mockResolvedValue(doc)
  mocks.reveal.mockResolvedValue([{ ...doc.fields[0], value: 'synthetic' }])
  const w = mount(PersonalResourceEditor, { props: { kind: 'secret', resource, embedded: true } })
  await flushPromises()
  const input = w.get('input[type=password]')
  await input.setValue('测试密码')
  const composing = new KeyboardEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    bubbles: true,
    cancelable: true,
  })
  input.element.dispatchEvent(composing)
  await flushPromises()
  expect(mocks.reveal).not.toHaveBeenCalled()
  expect(composing.defaultPrevented).toBe(false)
  await input.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  expect(mocks.reveal).toHaveBeenCalledOnce()
})

it('keeps extra-story text in its original editor without adding a second notes input', async () => {
  const w = mountEditor('extraStory')
  await flushPromises()
  await button(w, '编辑').trigger('click')
  expect(w.find('textarea[placeholder="用途或使用说明"]').exists()).toBe(false)
  expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('已保存正文')
})

it.each(['pocketPhone', 'secret'] as const)(
  'keeps %s notes open and focused after clearing the last character',
  async (kind) => {
    mocks.read.mockResolvedValue(document(kind))
    const w = mount(PersonalResourceEditor, {
      attachTo: window.document.body,
      props: { kind, resource },
    })
    await flushPromises()
    const edit = [
      ...window.document.querySelectorAll<HTMLButtonElement>(
        '.personal-resource-editor-overlay button',
      ),
    ].find((button) => button.textContent?.trim() === '编辑')!
    edit.click()
    await flushPromises()
    const element = window.document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="用途或使用说明"]',
    )!
    element.focus()
    element.value = ''
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(window.document.querySelector('textarea[placeholder="用途或使用说明"]')).toBe(element)
    expect(element.closest('details')?.open).toBe(true)
    expect(window.document.activeElement).toBe(element)
    element.value = '新的中文备注'
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(element.value).toBe('新的中文备注')
    w.unmount()
  },
)

it('requires unlocking an old card before removing encryption, and keeps its source on save failure', async () => {
  const doc = document('secret')
  doc.fields = [{ id: 'key', label: 'Key', value: '', private: true }]
  doc.protected = { salt: 's', iv: 'i', data: 'encrypted', iterations: 310000 }
  mocks.read.mockResolvedValue(doc)
  mocks.reveal.mockResolvedValue([{ ...doc.fields[0], value: 'synthetic-old-value' }])
  const w = mountEditor('secret')
  await flushPromises()
  expect(w.find('[aria-label="使用统一密码加密"]').exists()).toBe(false)
  await w.get('input[type="password"]').setValue('password123')
  await w.get('form').trigger('submit')
  await flushPromises()
  await button(w, '编辑').trigger('click')
  expect((w.get('[aria-label="使用统一密码加密"]').element as HTMLInputElement).checked).toBe(true)
  await w.get('[aria-label="使用统一密码加密"]').setValue(false)
  mocks.save.mockRejectedValueOnce(new Error('storage failure'))
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('storage failure')
  expect(doc.protected.data).toBe('encrypted')
  expect(doc.fields[0]?.value).toBe('')
  expect(mocks.protect).not.toHaveBeenCalled()
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      protection: 'none',
      fields: [expect.objectContaining({ value: 'synthetic-old-value' })],
    }),
    expect.any(Map),
    resource,
  )
  expect(mocks.save.mock.lastCall?.[0].protected).toBeUndefined()
  expect(w.find('input[type="password"]').exists()).toBe(false)
})
