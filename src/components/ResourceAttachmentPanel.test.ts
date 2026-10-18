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
