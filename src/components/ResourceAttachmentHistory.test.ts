// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
import ResourceAttachmentHistory from './ResourceAttachmentHistory.vue'
import { taskCenter } from '../core/TaskCenter'
const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  getHistory: vi.fn(),
  move: vi.fn(),
  confirm: vi.fn(),
  download: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  resourceAttachmentService: mocks,
  recycleBinService: { moveAttachmentVersionToRecycleBin: mocks.move },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: mocks.confirm }))
vi.mock('../utils/LibraryFormatting', () => ({
  downloadBlob: mocks.download,
  formatBytes: (n: number) => `${n} B`,
  formatBackupDate: (n: number) => `time ${n}`,
}))
vi.mock('./AttachmentDocumentPreview.vue', () => ({
  default: { props: ['resource'], template: '<article>{{resource.fileName}}</article>' },
}))
afterEach(() => {
  vi.resetAllMocks()
  document.body.innerHTML = ''
})
const attachment = { id: 'attachment', fileName: 'C.txt' } as Resource
const old = {
  id: 'old',
  fileName: 'B.md',
  fileSize: 1,
  versionImportedAt: 2,
  contentHash: 'b',
  originalBlob: new Blob(['B']),
} as Resource
async function setup(rows = [old]) {
  mocks.history.mockResolvedValue(rows)
  mocks.getHistory.mockResolvedValue(old)
  const view = mount(ResourceAttachmentHistory, {
    props: { ownerId: 'owner', attachment },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}
it('reads summaries first, previews read-only, reuses the selected bytes to export and returns through both levels', async () => {
  const view = await setup()
  try {
    expect(mocks.getHistory).not.toHaveBeenCalled()
    await view.get('[aria-label="预览历史版本 B.md"]').trigger('click')
    await flushPromises()
    expect(mocks.getHistory).toHaveBeenCalledExactlyOnceWith('owner', 'attachment', 'old')
    expect(view.text()).toContain('历史版本 · 只读')
    expect(view.find('textarea,input').exists()).toBe(false)
    const click = async (label: string) => {
      await view
        .findAll('button')
        .find((b) => b.text() === label)!
        .trigger('click')
      await flushPromises()
    }
    await click('导出')
    expect(mocks.download).toHaveBeenCalledWith(old.originalBlob, 'B.md')
    expect(mocks.getHistory).toHaveBeenCalledTimes(1)
    await view.get('[aria-label="返回上一级"]').trigger('click')
    await flushPromises()
    expect(view.text()).toContain('历史版本（1）')
    expect(view.emitted('close')).toBeUndefined()
    await view.get('[aria-label="返回上一级"]').trigger('click')
    expect(view.emitted('close')).toHaveLength(1)
  } finally {
    view.unmount()
  }
})
it('cancels deletion without mutation, retains a failed deletion and refreshes after successful recycling', async () => {
  const view = await setup()
  try {
    const remove = async () => {
      await view.get('[aria-label="删除历史版本 B.md"]').trigger('click')
      await flushPromises()
    }
    mocks.confirm.mockResolvedValueOnce(false)
    await remove()
    expect(mocks.move).not.toHaveBeenCalled()
    mocks.confirm.mockResolvedValue(true)
    mocks.move.mockRejectedValueOnce(new Error('disk full'))
    await remove()
    expect(view.get('[role="alert"]').text()).toBe('disk full')
    expect(view.emitted('changed')).toBeUndefined()
    mocks.move.mockResolvedValue(undefined)
    mocks.history.mockResolvedValue([])
    await remove()
    expect(mocks.move).toHaveBeenLastCalledWith(
      'owner',
      'attachment',
      'old',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    )
    expect(view.emitted('changed')).toHaveLength(1)
    expect(view.text()).toContain('暂无历史版本')
  } finally {
    view.unmount()
  }
})
it('paginates historical summaries without loading file bodies', async () => {
  const view = await setup(Array.from({ length: 31 }, (_, i) => ({ ...old, id: `old-${i}` })))
  try {
    expect(view.findAll('.resource-attachments__list li')).toHaveLength(30)
    await view
      .findAll('button')
      .find((b) => b.text() === '下一页')!
      .trigger('click')
    expect(view.findAll('.resource-attachments__list li')).toHaveLength(1)
    expect(mocks.history).toHaveBeenCalledTimes(1)
    expect(mocks.getHistory).not.toHaveBeenCalled()
  } finally {
    view.unmount()
  }
})
it('discards a late preview read after the history panel closes', async () => {
  const view = await setup()
  let finish: ((r: Resource) => void) | undefined
  mocks.getHistory.mockImplementation(
    () =>
      new Promise<Resource>((resolve) => {
        finish = resolve
      }),
  )
  await view.get('[aria-label="预览历史版本 B.md"]').trigger('click')
  view.unmount()
  finish!(old)
  await flushPromises()
  expect(mocks.download).not.toHaveBeenCalled()
})

it.each(['panel', 'task'])(
  'stops history archiving from %s without deleting or automatically restarting on reopen',
  async (entry) => {
    const view = await setup()
    mocks.confirm.mockResolvedValue(true)
    mocks.move.mockImplementation(
      (_owner, _id, _version, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('stopped', 'AbortError')),
            { once: true },
          ),
        ),
    )
    try {
      await view.get('[aria-label="删除历史版本 B.md"]').trigger('click')
      await flushPromises()
      if (entry === 'panel')
        await view
          .findAll('button')
          .find((b) => b.text() === '停止打包')!
          .trigger('click')
      else {
        const task = taskCenter
          .list()
          .find((t) => t.name === '附件历史移入回收站' && t.status === 'running')!
        expect(taskCenter.cancel(task.operationId)).toBe(true)
      }
      await flushPromises()
      expect(view.text()).toContain('已停止，历史版本保留')
      expect(view.emitted('changed')).toBeUndefined()
      expect(view.find('.resource-attachments__list li').exists()).toBe(true)
    } finally {
      view.unmount()
    }
    const reopened = await setup()
    expect(mocks.move).toHaveBeenCalledTimes(1)
    reopened.unmount()
  },
)
