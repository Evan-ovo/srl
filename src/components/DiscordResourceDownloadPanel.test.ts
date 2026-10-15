/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { taskCenter } from '../core/TaskCenter'
const api = vi.hoisted(() => ({
  available: true,
  list: vi.fn(),
  ack: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(async () => true),
}))
vi.mock('../services/DiscordSourceSettingsService', () => ({
  loadDiscordSourceConnectionSettings: () =>
    api.available ? { inboxLibraryId: 'library-1', inboxSecret: 'private' } : {},
}))
vi.mock('../services/DiscordHandoffService', () => ({
  inboxConnection: () => ({ workerUrl: 'https://worker.example', libraryId: 'library-1' }),
}))
vi.mock('../services/DiscordResourceInboxService', () => ({
  listDiscordResourceJobs: api.list,
  acknowledgeDiscordResource: api.ack,
  cancelDiscordResourceJob: api.cancel,
  deleteDiscordResourceJob: api.remove,
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: api.confirm }))
import DiscordResourceDownloadPanel from './DiscordResourceDownloadPanel.vue'
const job = {
  id: '11111111-1111-4111-a111-111111111111',
  libraryId: 'library-1',
  name: '角色卡.json',
  state: 'failed',
  error: '网络未连接',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 9999999999999,
  size: 10,
}
beforeEach(() => {
  vi.clearAllMocks()
  api.available = true
  api.list.mockResolvedValue({ jobs: [], recent: [], hasMore: false })
  api.ack.mockResolvedValue(undefined)
  api.cancel.mockResolvedValue(undefined)
  api.remove.mockResolvedValue(undefined)
})
describe('resource download panel', () => {
  it('reuses the local failed task retry instead of racing its pending cloud receipt', async () => {
    api.list.mockResolvedValue({ jobs: [], recent: [job], hasMore: false })
    const retry = vi.fn(async () => undefined)
    const operationId = `discord-resource-${job.id}`
    taskCenter.start({ operationId, name: job.name, retry })
    taskCenter.fail(operationId, '失败状态确认未完成')
    const wrapper = mount(DiscordResourceDownloadPanel)
    try {
      await flushPromises()
      await wrapper.get('button[aria-label="重试 角色卡.json"]').trigger('click')
      await flushPromises()
      expect(retry).toHaveBeenCalledOnce()
      expect(api.ack).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      taskCenter.dismiss(operationId)
    }
  })
  it('shows the committed local processing phase instead of a stale cloud queued label', async () => {
    api.list.mockResolvedValue({ jobs: [{ ...job, state: 'queued' }], recent: [], hasMore: false })
    const operationId = `discord-resource-${job.id}`
    taskCenter.start({
      operationId,
      name: job.name,
      phase: '已下载，等待解析导入',
      cancelable: false,
    })
    const wrapper = mount(DiscordResourceDownloadPanel)
    try {
      await flushPromises()
      expect(wrapper.get('small[data-state="queued"]').text()).toBe('已下载，等待解析导入')
      expect(wrapper.find(`button[aria-label="取消 ${job.name}"]`).exists()).toBe(false)
      taskCenter.update(operationId, { phase: '已导入，正在确认云端' })
      await flushPromises()
      expect(wrapper.text()).toContain('已导入，正在确认云端')
    } finally {
      wrapper.unmount()
      taskCenter.complete(operationId)
      taskCenter.dismiss(operationId)
    }
  })
  it('folds imported receipts while keeping failed download actions visible', async () => {
    api.list.mockResolvedValue({
      jobs: [],
      recent: [
        job,
        {
          ...job,
          id: '22222222-2222-4222-a222-222222222222',
          name: 'saved.json',
          state: 'imported',
          error: null,
        },
      ],
      hasMore: false,
    })
    const wrapper = mount(DiscordResourceDownloadPanel)
    try {
      await flushPromises()
      const history = wrapper.get('details.discord-downloads__history')
      expect(history.attributes('open')).toBeUndefined()
      expect(history.text()).toContain('saved.json')
      expect(history.text()).toContain('7 天')
      expect(
        wrapper.get('button[aria-label="重试 角色卡.json"]').element.closest('details'),
      ).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })
  it('reuses pairing without exposing another code or secret', async () => {
    api.available = false
    const wrapper = mount(DiscordResourceDownloadPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('先在帖子收件中配对')
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(api.list).not.toHaveBeenCalled()
    expect(wrapper.find('input').exists()).toBe(false)
    wrapper.unmount()
  })
  it('updates resource availability when the shared pairing is created or disconnected', async () => {
    api.available = false
    const wrapper = mount(DiscordResourceDownloadPanel)
    await flushPromises()
    api.available = true
    window.dispatchEvent(new Event('srl:receive-discord-inbox'))
    await flushPromises()
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    expect(api.list).toHaveBeenCalledOnce()
    api.available = false
    window.dispatchEvent(new Event('srl:receive-discord-inbox'))
    await flushPromises()
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('先在帖子收件中配对')
    wrapper.unmount()
  })
  it('distinguishes waiting versions from imported resources and retries a failed task in place', async () => {
    api.list.mockResolvedValue({
      jobs: [
        {
          ...job,
          id: '22222222-2222-4222-a222-222222222222',
          state: 'waiting_version',
          error: null,
        },
      ],
      recent: [job],
      hasMore: false,
    })
    const wrapper = mount(DiscordResourceDownloadPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('待选历史版本')
    expect(wrapper.text()).toContain('网络未连接')
    expect(wrapper.text()).not.toContain('已导入')
    await wrapper.get('button[aria-label="重试 角色卡.json"]').trigger('click')
    await flushPromises()
    expect(api.ack).toHaveBeenCalledWith(job.id, 'queued', {
      workerUrl: 'https://worker.example',
      libraryId: 'library-1',
    })
    expect(wrapper.find('details').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })
  it('shows an old Worker error instead of inventing download success', async () => {
    api.list.mockRejectedValue(new Error('Worker 尚未更新'))
    const wrapper = mount(DiscordResourceDownloadPanel)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Worker 尚未更新')
    expect(wrapper.find('li').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lets an unfinished transfer be cancelled and a terminal task be cleaned or retried', async () => {
    api.list.mockResolvedValue({
      jobs: [
        { ...job, id: 'active', state: 'downloading' },
        { ...job, id: 'cancelled', state: 'cancelled' },
      ],
      recent: [],
      hasMore: false,
    })
    const wrapper = mount(DiscordResourceDownloadPanel)
    try {
      await flushPromises()
      await wrapper.get('button[aria-label="取消 角色卡.json"]').trigger('click')
      await flushPromises()
      expect(api.cancel).toHaveBeenCalledWith('active', {
        workerUrl: 'https://worker.example',
        libraryId: 'library-1',
      })
      expect(api.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: '取消下载 角色卡.json？' }),
      )
      await wrapper.get('button[aria-label="清理 角色卡.json"]').trigger('click')
      await flushPromises()
      expect(api.remove).toHaveBeenCalledWith('cancelled', {
        workerUrl: 'https://worker.example',
        libraryId: 'library-1',
      })
    } finally {
      wrapper.unmount()
    }
  })
})
