// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
import ResourceAttachmentPanel from './ResourceAttachmentPanel.vue'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  replace: vi.fn(),
  recycle: vi.fn(),
  history: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  resourceAttachmentService: mocks,
  recycleBinService: { moveToRecycleBin: mocks.recycle },
}))
vi.mock('./AttachmentDocumentPreview.vue', () => ({ default: { template: '<div>文档预览</div>' } }))
vi.mock('../utils/LibraryFormatting', () => ({
  formatBytes: (n: number) => `${n} B`,
  downloadBlob: vi.fn(),
}))
afterEach(() => vi.clearAllMocks())
const resource = { id: 'owner', name: '角色', metadata: {} } as Resource
function fixture() {
  const rows: Resource[] = []
  const pending: Array<() => void> = []
  mocks.list.mockImplementation(async () => rows)
  mocks.add.mockImplementation(
    (_owner, file: File) =>
      new Promise((resolve) => {
        pending.push(() => {
          const row = {
            id: file.name,
            fileName: file.name,
            fileSize: file.size,
            createdAt: rows.length,
            metadata: {},
          } as Resource
          rows.push(row)
          resolve(row)
        })
      }),
  )
  const view = mount(ResourceAttachmentPanel, {
    props: { resource, initialItems: [] },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  const click = (label: string) =>
    view
      .findAll('button')
      .find((button) => button.text() === label)!
      .trigger('click')
  const importFiles = async () => {
    const input = view.get('input[multiple]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
    })
    await input.trigger('change')
    await flushPromises()
  }
  return { view, rows, pending, click, importFiles }
}
it('pauses at the current atomic file boundary and only resumes on explicit continue', async () => {
  const f = fixture()
  try {
    await f.importFiles()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    await f.click('暂停')
    f.pending.shift()!()
    await flushPromises()
    expect(f.rows).toHaveLength(1)
    expect(mocks.add).toHaveBeenCalledTimes(1)
    await f.click('继续')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(2)
    f.pending.shift()!()
    await flushPromises()
    expect(f.view.emitted('changed')?.at(-1)?.[1]).toEqual(['a.txt', 'b.txt'])
  } finally {
    f.view.unmount()
  }
})
it('stops a paused import, retains a late atomic commit and never starts the next file on reopen', async () => {
  const f = fixture()
  try {
    await f.importFiles()
    await f.click('暂停')
    await f.click('停止')
    f.pending.shift()!()
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(f.view.text()).toContain('保留 1 个附件')
    expect(f.view.emitted('changed')?.at(-1)?.[1]).toEqual(['a.txt'])
  } finally {
    f.view.unmount()
  }
  const reopened = fixture()
  try {
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
  } finally {
    reopened.view.unmount()
  }
})

it('opens the replacement chooser in the menu click before reading attachment contents', async () => {
  const attachment = {
    ...resource,
    id: 'attachment',
    fileName: '说明.txt',
    contentHash: 'previous-hash',
    originalBlob: new Blob(['previous']),
  } as Resource
  let finishRead: ((value: Resource) => void) | undefined
  mocks.get.mockImplementation(() => new Promise<Resource>((resolve) => (finishRead = resolve)))
  const view = mount(ResourceAttachmentPanel, {
    props: { resource, initialItems: [attachment] },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  try {
    await view.get('[aria-label="说明.txt 的操作"]').trigger('click')
    await flushPromises()
    view
      .findAll('button')
      .find((button) => button.text() === '替换文件')!
      .element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(click).toHaveBeenCalledOnce()
    expect(mocks.get).not.toHaveBeenCalled()
  } finally {
    view.unmount()
    finishRead?.(attachment)
    await flushPromises()
    click.mockRestore()
  }
})

it('cancels replacement without changes and validates the captured target after file selection', async () => {
  const attachment = {
    ...resource,
    id: 'attachment',
    fileName: '说明.txt',
    contentHash: 'previous-hash',
  } as Resource
  const file = new File(['new contents'], '新版.txt', { type: 'text/plain' })
  const updated = {
    ...attachment,
    fileName: file.name,
    contentHash: 'updated-hash',
    originalBlob: file,
  } as Resource
  mocks.get.mockRejectedValue(new Error('Do not read contents to open a picker'))
  mocks.replace.mockResolvedValue(updated)
  mocks.list.mockResolvedValue([updated])
  const view = mount(ResourceAttachmentPanel, {
    props: { resource, initialItems: [attachment] },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  const input = view.get<HTMLInputElement>('input[aria-label="替换附件文件"]')
  const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  const replace = async () => {
    await view.get('[aria-label="说明.txt 的操作"]').trigger('click')
    await flushPromises()
    await view
      .findAll('button')
      .find((button) => button.text() === '替换文件')!
      .trigger('click')
  }
  try {
    await replace()
    await input.trigger('cancel')
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(view.text()).toContain('说明.txt')
    await replace()
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] })
    await input.trigger('change')
    await flushPromises()
    expect(click).toHaveBeenCalledTimes(2)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      'owner',
      'attachment',
      file,
      'previous-hash',
    )
    expect(view.text()).toContain('附件已替换')
    expect(view.emitted('changed')?.at(-1)?.[1]).toEqual(['attachment'])
  } finally {
    view.unmount()
    click.mockRestore()
  }
})

it('keeps Markdown read-only in the preview header and attachment menu', async () => {
  const attachment = {
    ...resource,
    id: 'markdown',
    fileName: '说明.md',
    contentHash: 'md-hash',
    originalBlob: new Blob(['# 正文']),
  } as Resource
  mocks.get.mockResolvedValue(attachment)
  const view = mount(ResourceAttachmentPanel, {
    props: { resource, initialItems: [attachment] },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  try {
    await view.get('.resource-attachments__file').trigger('click')
    await flushPromises()
    expect(view.findAll('button').some((button) => button.text() === '编辑文本')).toBe(false)
    await view.get('[aria-label="附件操作"]').trigger('click')
    await flushPromises()
    const labels = view.findAll('button').map((button) => button.text())
    expect(labels).not.toContain('编辑文本')
    expect(labels).toContain('导出')
    expect(labels).toContain('重命名')
    expect(view.find('textarea').exists()).toBe(false)
  } finally {
    view.unmount()
  }
})

it('opens history from the attachment menu and routes the system back through the child panel', async () => {
  const attachment = { ...resource, id: 'attachment', fileName: 'C.txt' } as Resource
  mocks.history.mockResolvedValue([])
  const view = mount(ResourceAttachmentPanel, {
    props: { resource, initialItems: [attachment] },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  try {
    await view.get('[aria-label="C.txt 的操作"]').trigger('click')
    await flushPromises()
    await view
      .findAll('button')
      .find((button) => button.text() === '历史版本')!
      .trigger('click')
    await flushPromises()
    expect(view.get('[aria-label="附件历史版本"]').isVisible()).toBe(true)
    expect(view.get('[aria-label="资源附件"]').isVisible()).toBe(false)
    expect(mocks.history).toHaveBeenCalledWith('owner', 'attachment')
    await (view.vm as unknown as { requestBack: () => Promise<void> }).requestBack()
    await flushPromises()
    expect(view.find('[aria-label="附件历史版本"]').exists()).toBe(false)
    expect(view.get('[aria-label="资源附件"]').isVisible()).toBe(true)
    expect(view.emitted('close')).toBeUndefined()
  } finally {
    view.unmount()
  }
})
