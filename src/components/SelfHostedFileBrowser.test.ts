/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelfHostedFilePage } from '../services/FrontendWorkshopImageHostingService'

const { list, remove, confirm } = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../core/ImageAlbumContainer', () => ({
  frontendWorkshopImageHostingService: { listSelfHosted: list, deleteSelfHosted: remove },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: confirm }))
import SelfHostedFileBrowser from './SelfHostedFileBrowser.vue'
enableAutoUnmount(afterEach)
const file = {
  fileId: 'other-device/archive.zip',
  name: '归档.zip',
  url: 'https://files.example/file/other-device/archive.zip',
  managementOrigin: 'https://files.example',
  mimeType: 'application/zip',
  sizeBytes: 2048,
  createdAt: null,
  type: 'other' as const,
}
const page: SelfHostedFilePage = { files: [file], directories: ['other-device'], total: 101 }
beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue(structuredClone(page))
  remove.mockResolvedValue(undefined)
  confirm.mockResolvedValue(true)
})

describe('remote file browser', () => {
  it('uses the existing inline page interaction: select, change or Enter, normalize and clamp', async () => {
    const wrapper = mount(SelfHostedFileBrowser)
    await flushPromises()
    const input = wrapper.get<HTMLInputElement>('[aria-label="跳转页码"]')
    expect(input.classes()).toContain('inline-page-jump')
    await input.setValue('0')
    await input.trigger('change')
    await flushPromises()
    expect(input.element.value).toBe('1')
    expect(list).toHaveBeenCalledTimes(1)
    await input.setValue('2')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ start: 50 }))
    await input.trigger('change')
    await flushPromises()
    expect(list).toHaveBeenCalledTimes(2)
    await input.setValue('4')
    await input.trigger('change')
    await flushPromises()
    expect(input.element.value).toBe('3')
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ start: 100 }))
  })
  it('shows remotely listed non-image files and requests explicit search, type, folder and pages', async () => {
    const wrapper = mount(SelfHostedFileBrowser)
    await flushPromises()
    expect(wrapper.text()).toContain('归档.zip')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.get('input[type=search]').setValue('zip')
    expect(list).toHaveBeenCalledTimes(1)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'zip', start: 0, recursive: true }),
    )
    await wrapper.get('select').setValue('other')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'other', start: 0 }))
    const next = wrapper.findAll('button').find((button) => button.text() === '下一页')!
    await next.trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ start: 50 }))
    await wrapper.get('.remote-files__folders button').trigger('click')
    await flushPromises()
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ directory: 'other-device', start: 0 }),
    )
  })
  it('requires confirmation, retains a failed delete, and removes a successful remote file only', async () => {
    const wrapper = mount(SelfHostedFileBrowser)
    await flushPromises()
    confirm.mockResolvedValueOnce(false)
    await wrapper.get('[aria-label="删除 归档.zip"]').trigger('click')
    await flushPromises()
    expect(remove).not.toHaveBeenCalled()
    remove.mockRejectedValueOnce(new Error('没有 delete 权限'))
    await wrapper.get('[aria-label="删除 归档.zip"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('delete 权限')
    expect(wrapper.find('.remote-files__file').exists()).toBe(true)
    await wrapper.get('[aria-label="删除 归档.zip"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        danger: true,
        message: expect.stringContaining('other-device/archive.zip'),
      }),
      expect.any(AbortSignal),
    )
    expect(remove).toHaveBeenLastCalledWith({
      url: file.url,
      managementOrigin: file.managementOrigin,
      upstreamFileId: file.fileId,
    })
    expect(wrapper.find('.remote-files__file').exists()).toBe(false)
    expect(wrapper.text()).toContain('本地文件保留')
  })
  it('does not turn read errors into an empty list', async () => {
    list.mockRejectedValue(new Error('请使用 list 权限'))
    const wrapper = mount(SelfHostedFileBrowser)
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('list 权限')
    expect(wrapper.find('.remote-files__empty').exists()).toBe(false)
  })
  it('aborts a replaced query and ignores its late result', async () => {
    let finish!: (page: SelfHostedFilePage) => void
    list.mockImplementationOnce(
      () =>
        new Promise<SelfHostedFilePage>((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = mount(SelfHostedFileBrowser)
    const firstSignal = list.mock.calls[0]![0].signal as AbortSignal
    await wrapper.get('select').setValue('audio')
    await flushPromises()
    expect(firstSignal.aborted).toBe(true)
    finish({ files: [], directories: [], total: 0 })
    await flushPromises()
    expect(wrapper.text()).toContain('归档.zip')
    const lastSignal = list.mock.calls.at(-1)![0].signal as AbortSignal
    wrapper.unmount()
    expect(lastSignal.aborted).toBe(true)
  })
  it('does not execute a pending deletion after changing the saved connection', async () => {
    let finish!: (value: boolean) => void
    confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = mount(SelfHostedFileBrowser)
    await flushPromises()
    await wrapper.get('[aria-label="删除 归档.zip"]').trigger('click')
    await wrapper.setProps({ revision: 1 })
    finish(true)
    await flushPromises()
    expect(remove).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(2)
  })
})
