/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import ProjectActivityCenter from './ProjectActivityCenter.vue'
import { taskCenter } from '../core/TaskCenter'
import { noticeCenter } from '../core/NoticeCenter'
import { notifyWebDiscordInboxResult } from '../services/WebDiscordInboxNotifications'

it('does not add a floating trigger for a finished task without an action, but retains its folded history', async () => {
  const id = taskCenter.start({ name: '普通导入已完成' })
  taskCenter.complete(id)
  const wrapper = mount(ProjectActivityCenter)
  let notice = ''
  try {
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.activity-center').exists()).toBe(false)
    notice = noticeCenter.push({ type: 'info', message: '需要查看的通知', persistent: true })
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    expect(wrapper.get('.activity-center__completed').text()).toContain('普通导入已完成')
    expect(wrapper.get('.activity-center__completed').attributes('open')).toBeUndefined()
  } finally {
    wrapper.unmount()
    taskCenter.dismiss(id)
    noticeCenter.dismiss(notice)
  }
})

it('folds completed history without hiding pending work or letting history consume its slots', async () => {
  const ids = Array.from({ length: 10 }, (_, index) =>
    taskCenter.start({ name: `完成任务${index}` }),
  )
  ids.forEach((id) => taskCenter.complete(id))
  const pending = taskCenter.start({
    name: '仍待导入',
    phase: '下载完成，可继续导入',
    action: { label: '继续导入', run: () => undefined },
  })
  taskCenter.complete(pending)
  const failed = taskCenter.start({ name: '未成功资源' })
  taskCenter.fail(failed, '文件不支持')
  const running = taskCenter.start({ name: '正在处理下一份' })
  const notice = noticeCenter.push({
    id: 'fold-completed-notice',
    type: 'success',
    message: '已保存',
    persistent: true,
  })
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    const history = wrapper.get('.activity-center__completed')
    expect(history.attributes('open')).toBeUndefined()
    expect(history.get('summary').text()).toBe('已完成（11）')
    expect(history.findAll('.activity-card')).toHaveLength(11)
    for (const label of ['仍待导入', '未成功资源', '正在处理下一份']) {
      const card = wrapper.findAll('.activity-card').find((card) => card.text().includes(label))!
      expect(card.element.closest('.activity-center__completed')).toBeNull()
    }
    taskCenter.complete(running)
    await wrapper.vm.$nextTick()
    expect(history.attributes('open')).toBeUndefined()
    expect(history.get('summary').text()).toBe('已完成（12）')
    await wrapper.get('button[aria-label="收起任务与通知"]').trigger('click')
    await wrapper.get('.activity-center__trigger').trigger('click')
    expect(wrapper.get('.activity-center__completed').attributes('open')).toBeUndefined()
  } finally {
    wrapper.unmount()
    for (const id of [...ids, pending, failed, running]) {
      taskCenter.complete(id)
      taskCenter.dismiss(id)
    }
    noticeCenter.dismiss(notice)
  }
})

it('clears completed web inbox results while preserving failed and pending results', async () => {
  const base = {
    kind: 'resource' as const,
    workerUrl: 'https://worker.example',
    libraryId: 'web-clear',
    name: '角色卡',
  }
  for (const state of ['imported', 'duplicate', 'waiting_version', 'failed'] as const)
    await notifyWebDiscordInboxResult({ ...base, state, id: `web-clear-${state}` })
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '清理完成项')!
      .trigger('click')
    const results = noticeCenter.list().filter((notice) => notice.id.includes('web-clear'))
    expect(results).toHaveLength(2)
    expect(results.some((notice) => notice.message.startsWith('等待确认历史版本'))).toBe(true)
    expect(results.some((notice) => notice.message.startsWith('下载或解析未完成'))).toBe(true)
  } finally {
    wrapper.unmount()
    for (const notice of noticeCenter.list())
      if (notice.id.includes('web-clear')) noticeCenter.dismiss(notice.id)
  }
})

it('closes the activity drawer when a notice opens the inbox', async () => {
  const action = vi.fn(() =>
    window.dispatchEvent(new CustomEvent('srl:native-deep-link', { detail: { kind: 'inbox' } })),
  )
  const id = noticeCenter.push({
    id: 'web-inbox-open',
    type: 'info',
    message: '已收件',
    persistent: true,
    actions: [
      {
        label: '查看收件箱',
        run: () => {
          action()
        },
      },
    ],
  })
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看收件箱')!
      .trigger('click')
    expect(action).toHaveBeenCalledOnce()
    expect(wrapper.find('#srl-activity-panel').exists()).toBe(false)
    expect(noticeCenter.list().some((notice) => notice.id === id)).toBe(true)
  } finally {
    wrapper.unmount()
    noticeCenter.dismiss(id)
  }
})

it('completed attachment remains accessible from its task action', async () => {
  const open = vi.fn()
  const id = taskCenter.start({ name: '指定附件', action: { label: '查看附件', run: open } })
  taskCenter.complete(id)
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    wrapper.get<HTMLDetailsElement>('.activity-center__completed').element.open = true
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '查看附件')!
      .trigger('click')
    expect(open).toHaveBeenCalledOnce()
    expect(wrapper.find('#srl-activity-panel').exists()).toBe(false)
    await wrapper.get('.activity-center__trigger').trigger('click')
    expect(wrapper.text()).toContain('指定附件')
  } finally {
    wrapper.unmount()
    taskCenter.dismiss(id)
  }
})

it('局部窗口承载的通知不重复显示，全局记录与其他通知保留', async () => {
  const local = 'activity-local-notice',
    other = 'activity-other-notice'
  noticeCenter.push({ id: local, type: 'success', message: '局部已保存', persistent: true })
  const wrapper = mount(ProjectActivityCenter, { props: { hiddenNoticeIds: [local] } })
  try {
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.activity-center').exists()).toBe(false)
    expect(noticeCenter.list().some((notice) => notice.id === local)).toBe(true)
    noticeCenter.push({ id: other, type: 'info', message: '其他通知', persistent: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('其他通知')
    expect(wrapper.text()).not.toContain('局部已保存')
    await wrapper.setProps({ hiddenNoticeIds: [] })
    await wrapper.get('.activity-center__trigger').trigger('click')
    expect(wrapper.text()).toContain('局部已保存')
  } finally {
    wrapper.unmount()
    noticeCenter.dismiss(local)
    noticeCenter.dismiss(other)
  }
})

it('一键清理成功通知，但保留需要处理的通知和仍在运行的任务', async () => {
  const runningTask = taskCenter.start({ name: '仍在下载', phase: '下载中' })
  const completedImport = taskCenter.start({ name: '云端资源：card.json', phase: '正在解析' })
  taskCenter.update(completedImport, { phase: '已导入资源库' })
  taskCenter.complete(completedImport)
  const readyToImport = taskCenter.start({
    name: 'attachment.png',
    phase: '下载完成，可继续导入',
    action: { label: '查看附件', run: () => undefined },
  })
  taskCenter.complete(readyToImport)
  const first = 'activity-clear-first',
    second = 'activity-clear-second'
  const actionNotice = 'activity-clear-actionable'
  noticeCenter.push({ id: first, type: 'success', message: '文件已导入', persistent: true })
  noticeCenter.push({ id: second, type: 'success', message: '另一文件已导入', persistent: true })
  noticeCenter.push({
    id: actionNotice,
    type: 'warning',
    message: '仍需确认版本',
    persistent: true,
    actions: [{ label: '确认', run: () => undefined }],
  })
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    await wrapper.get('.activity-center__trigger').trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '清理完成项')!
      .trigger('click')
    await wrapper.vm.$nextTick()
    expect(noticeCenter.list().some((notice) => [first, second].includes(notice.id))).toBe(false)
    expect(noticeCenter.list().some((notice) => notice.id === actionNotice)).toBe(true)
    expect(taskCenter.list().some((task) => task.operationId === runningTask)).toBe(true)
    expect(taskCenter.list().some((task) => task.operationId === completedImport)).toBe(false)
    expect(taskCenter.list().some((task) => task.operationId === readyToImport)).toBe(true)
  } finally {
    wrapper.unmount()
    taskCenter.complete(runningTask)
    taskCenter.dismiss(runningTask)
    taskCenter.dismiss(readyToImport)
    noticeCenter.dismiss(actionNotice)
  }
})

it('任务抽屉与浮动进度互斥，面板承载的恢复任务不再重复展示', async () => {
  const id = taskCenter.start({ name: '恢复备份', phase: '恢复资源' })
  const wrapper = mount(ProjectActivityCenter)
  try {
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('progress')).toHaveLength(1)
    await wrapper.get('.activity-center__trigger').trigger('click')
    expect(wrapper.findAll('progress')).toHaveLength(1)
    expect(wrapper.find('.activity-center__focused-progress').exists()).toBe(false)
    await wrapper.setProps({ hiddenTaskNames: ['恢复备份'] })
    expect(wrapper.findAll('progress')).toHaveLength(0)
  } finally {
    wrapper.unmount()
    taskCenter.complete(id)
    taskCenter.dismiss(id)
  }
})
