/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OfficialAppManager from './OfficialAppManager.vue'
import { taskCenter } from '../core/TaskCenter'

const service = vi.hoisted(() => ({
  list: vi.fn(),
  installedSnapshot: [],
  loadInstalled: () => service.list(),
  checkInstalledStatus: vi.fn(),
  availableUpdates: vi.fn(),
  install: vi.fn(),
  installMany: vi.fn(),
  clearAppData: vi.fn(),
  uninstall: vi.fn(),
}))
vi.mock('../core/OfficialAppRuntime', () => ({ officialAppService: service }))
let wrapper: ReturnType<typeof mount>
beforeEach(() => {
  vi.resetAllMocks()
  service.list.mockResolvedValue([])
  service.availableUpdates.mockResolvedValue({})
  service.install.mockResolvedValue(undefined)
  service.installMany.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })))
  service.clearAppData.mockResolvedValue(undefined)
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  wrapper = mount(OfficialAppManager, { attachTo: document.body })
})
afterEach(() => {
  wrapper.unmount()
  document.body.innerHTML = ''
})
it('opens APP guidance in a centered modal from the question-mark control', async () => {
  await flushPromises()
  expect(wrapper.find('.official-app-manager > p').exists()).toBe(false)
  await wrapper.get('[aria-label="查看 APP 管理说明"]').trigger('click')
  const help = document.querySelector<HTMLDialogElement>('#official-app-manager-help-dialog')!
  expect(help.open).toBe(true)
  expect(help.classList.contains('official-app-manager__dialog')).toBe(true)
  expect(help.textContent).toContain('程序按需下载')
  expect(help.textContent).toContain('原有数据保留')
  await help.querySelector<HTMLButtonElement>('footer button')!.click()
  expect(help.open).toBe(false)
})
it('checks local integrity only from the explicit status action and reports the affected APP', async () => {
  await flushPromises()
  expect(service.checkInstalledStatus).not.toHaveBeenCalled()
  expect(wrapper.findAll('button').some((button) => button.text() === '检查 APP 状态')).toBe(false)
  service.checkInstalledStatus.mockResolvedValue([{ id: 'chatReader', ready: false }])
  await wrapper.get('[aria-label="查看 APP 管理说明"]').trigger('click')
  const help = document.querySelector<HTMLDialogElement>('#official-app-manager-help-dialog')!
  help.querySelector<HTMLButtonElement>('.button--quiet')!.click()
  await flushPromises()
  expect(service.checkInstalledStatus).toHaveBeenCalledOnce()
  expect(wrapper.text()).toContain('需要修复：读了么')
  expect(help.textContent).toContain('需要修复：读了么')
})
async function openCleanup() {
  await flushPromises()
  const row = wrapper.findAll('li').find((row) => row.text().includes('前端了么'))!
  await row
    .findAll('button')
    .find((button) => button.text() === '清理数据')!
    .trigger('click')
  await flushPromises()
  return document.querySelector<HTMLDialogElement>(
    '.official-app-manager__dialog[aria-labelledby="official-app-action-title"]',
  )!
}
function remountManager() {
  wrapper.unmount()
  wrapper = mount(OfficialAppManager, { attachTo: document.body })
}
it('downloads selected missing APPs without updating or reinstalling existing APPs', async () => {
  service.list.mockResolvedValue([{ id: 'draw', files: [] }])
  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '1',
      latestVersion: '2',
      latestShellVersion: 'test-shell',
      requiresHostUpdate: false,
    },
  })
  remountManager()
  await flushPromises()
  await wrapper.get('[aria-label="选择下载缝了么"]').setValue(true)
  await wrapper.get('[aria-label="选择下载读了么"]').setValue(true)
  expect(wrapper.find('[aria-label="选择下载抽了么"]').exists()).toBe(false)
  await wrapper.get('.official-app-manager__batch-download').trigger('click')
  await flushPromises()
  expect(service.installMany).toHaveBeenCalledWith(
    ['chatReader', 'stitch'],
    expect.any(Function),
    expect.any(AbortSignal),
  )
  expect(wrapper.text()).toContain('下载结束：完成 2 个')
  expect(wrapper.find('[aria-label="选择更新抽了么"]').exists()).toBe(true)
})
it('downloads all missing APPs by default and disables repeated batch submissions', async () => {
  service.list.mockResolvedValue([{ id: 'draw', files: [] }])
  remountManager()
  await flushPromises()
  const expected = wrapper
    .findAll('input[aria-label^="选择下载"]')
    .map((input) => (input.element as HTMLInputElement).value)
  let finish!: (value: unknown) => void
  service.installMany.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const button = wrapper.get('.official-app-manager__batch-download').element as HTMLButtonElement
  button.click()
  button.click()
  await flushPromises()
  expect(service.installMany).toHaveBeenCalledExactlyOnceWith(
    expected,
    expect.any(Function),
    expect.any(AbortSignal),
  )
  expect(expected).not.toContain('draw')
  expect(wrapper.get('.official-app-manager__batch-download').attributes('disabled')).toBeDefined()
  service.list.mockResolvedValue([...expected, 'draw'].map((id) => ({ id, files: [] })))
  finish(expected.map((id) => ({ id })))
  await flushPromises()
  expect(wrapper.find('.official-app-manager__batch-download').exists()).toBe(false)
})
it('retains failed download selections for retry and drops successful selections', async () => {
  await flushPromises()
  await wrapper.get('[aria-label="选择下载缝了么"]').setValue(true)
  await wrapper.get('[aria-label="选择下载读了么"]').setValue(true)
  service.installMany.mockResolvedValueOnce([
    { id: 'chatReader' },
    { id: 'stitch', error: new Error('用户已停止') },
  ])
  service.list.mockResolvedValue([{ id: 'chatReader', files: [] }])
  await wrapper.get('.official-app-manager__batch-download').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('下载结束：完成 1 个，失败 1 个')
  expect(wrapper.get('[aria-label="选择下载缝了么"]').element).toHaveProperty('checked', true)
  await wrapper.get('.official-app-manager__batch-download').trigger('click')
  await flushPromises()
  expect(service.installMany).toHaveBeenLastCalledWith(
    ['stitch'],
    expect.any(Function),
    expect.any(AbortSignal),
  )
})
it('selects several updates, shows per-APP progress, and refreshes the catalog once after the batch', async () => {
  service.list.mockResolvedValue([
    { id: 'draw', files: [] },
    { id: 'stitch', files: [] },
  ])
  const update = {
    currentVersion: '1',
    latestVersion: '2',
    latestShellVersion: 'test-shell',
    requiresHostUpdate: false,
  }
  service.availableUpdates.mockResolvedValue({
    draw: update,
    stitch: { ...update, requiresHostUpdate: true },
  })
  remountManager()
  await flushPromises()
  document.querySelector<HTMLButtonElement>('.official-app-manager__updates-footer button')!.click()
  await flushPromises()
  await wrapper.get('[aria-label="选择更新抽了么"]').setValue(true)
  await wrapper.get('[aria-label="选择更新缝了么"]').setValue(true)
  let finish!: (result: unknown) => void
  service.installMany.mockImplementation((ids, report) => {
    report({ id: ids[0], stage: 'downloading', downloadedBytes: 1024, totalBytes: 2048 })
    report({ id: ids[1], stage: 'checking' })
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  service.availableUpdates.mockClear()
  await wrapper.get('.official-app-manager__batch-update').trigger('click')
  expect(service.installMany).toHaveBeenCalledWith(
    ['draw', 'stitch'],
    expect.any(Function),
    expect.any(AbortSignal),
  )
  expect(wrapper.text()).toContain('正在下载')
  expect(wrapper.text()).toContain('正在校验')
  expect(wrapper.get('[aria-label="选择更新缝了么"]').attributes('disabled')).toBeDefined()
  expect(service.availableUpdates).not.toHaveBeenCalled()
  service.availableUpdates.mockResolvedValue({ stitch: update })
  finish([{ id: 'draw' }, { id: 'stitch', error: new Error('网络中断') }])
  await flushPromises()
  expect(service.availableUpdates).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).toContain('完成 1 个，失败 1 个')
  expect(wrapper.text()).toContain('网络中断')
  expect(wrapper.findAll('.official-app-manager__update-dot')).toHaveLength(1)
})
it('announces batch completion only after the updated list has finished refreshing', async () => {
  service.list.mockResolvedValue([{ id: 'draw', files: [] }])
  service.availableUpdates.mockResolvedValueOnce({
    draw: {
      currentVersion: '1',
      latestVersion: '2',
      latestShellVersion: 'test-shell',
      requiresHostUpdate: false,
    },
  })
  let finishCheck!: (updates: object) => void
  service.availableUpdates.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCheck = resolve
      }),
  )
  remountManager()
  await flushPromises()
  document.querySelector<HTMLButtonElement>('.official-app-manager__updates-footer button')!.click()
  await flushPromises()
  await wrapper.get('.official-app-manager__batch-update').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('更新成功')
  expect(wrapper.text()).not.toContain('更新结束')
  finishCheck({})
  await flushPromises()
  expect(wrapper.text()).toContain('更新结束：完成 1 个')
  expect(wrapper.findAll('.official-app-manager__update-dot')).toHaveLength(0)
})
it('announces installed APP updates in a centered modal and leaves a red dot after skipping', async () => {
  service.list.mockResolvedValue([
    {
      id: 'draw',
      shellVersion: 'srl-0.0.126-v286',
      installedAt: 1,
      files: [],
      entry: '/assets/draw.js',
      styles: [],
    },
  ])
  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '01234567',
      latestVersion: '89abcdef',
      latestShellVersion: 'srl-0.0.127-v287',
      requiresHostUpdate: false,
    },
  })
  remountManager()
  await flushPromises()
  const dialog = document.querySelector<HTMLDialogElement>('.official-app-manager__updates-dialog')!
  expect(dialog.open).toBe(true)
  expect(dialog.textContent).toContain('抽了么')
  expect(dialog.textContent).toContain('#01234567')
  expect(dialog.textContent).toContain('#89abcdef')
  expect(dialog.classList.contains('official-app-manager__dialog')).toBe(true)
  expect(wrapper.get('.official-app-manager__update-dot').attributes('aria-label')).toBe('有新版本')
  await dialog.querySelector<HTMLButtonElement>('button:not(.confirm-dialog__confirm)')!.click()
  await flushPromises()
  expect(dialog.open).toBe(false)
  expect(JSON.parse(localStorage.getItem('srl.officialApps.skippedUpdates.v1')!)).toEqual({
    draw: '89abcdef',
  })
  expect(wrapper.find('.official-app-manager__update-dot').exists()).toBe(true)
  remountManager()
  await flushPromises()
  expect(document.querySelector('.official-app-manager__updates-dialog')).toBeNull()
  expect(wrapper.find('.official-app-manager__update-dot').exists()).toBe(true)

  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '01234567',
      latestVersion: '89abcdef',
      latestShellVersion: 'srl-0.0.128-v288',
      requiresHostUpdate: false,
    },
  })
  remountManager()
  await flushPromises()
  expect(document.querySelector('.official-app-manager__updates-dialog')).toBeNull()

  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '01234567',
      latestVersion: 'abcdef12',
      latestShellVersion: 'srl-0.0.128-v288',
      requiresHostUpdate: false,
    },
  })
  remountManager()
  await flushPromises()
  expect(
    document.querySelector<HTMLDialogElement>('.official-app-manager__updates-dialog')!.open,
  ).toBe(true)
})
it('preserves legacy version skips across shell rebuilds without hiding necessary repairs', async () => {
  localStorage.setItem(
    'srl.officialApps.skippedUpdates.v1',
    JSON.stringify({ draw: '2@srl-0.0.127-v287' }),
  )
  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '1',
      latestVersion: '2',
      latestShellVersion: 'srl-0.0.128-v288',
      requiresHostUpdate: false,
    },
  })
  remountManager()
  await flushPromises()
  expect(document.querySelector('.official-app-manager__updates-dialog')).toBeNull()
  service.availableUpdates.mockResolvedValue({
    draw: {
      currentVersion: '2',
      latestVersion: '2',
      latestShellVersion: 'srl-0.0.128-v288',
      requiresHostUpdate: false,
      requiresAssetRepair: true,
    },
  })
  remountManager()
  await flushPromises()
  const dialog = document.querySelector<HTMLDialogElement>('.official-app-manager__updates-dialog')!
  expect(dialog.open).toBe(true)
  expect(dialog.textContent).toContain('缺少运行资源')
})
it('updates only the selected APP from the version reminder', async () => {
  service.list
    .mockResolvedValueOnce([
      {
        id: 'draw',
        shellVersion: 'srl-0.0.126-v286',
        installedAt: 1,
        files: [],
        entry: '/assets/draw.js',
        styles: [],
      },
    ])
    .mockResolvedValue([
      {
        id: 'draw',
        shellVersion: 'srl-0.0.127-v287',
        installedAt: 2,
        files: [],
        entry: '/assets/draw.js',
        styles: [],
      },
    ])
  service.availableUpdates
    .mockResolvedValueOnce({
      draw: {
        currentVersion: '01234567',
        latestVersion: '89abcdef',
        latestShellVersion: 'srl-0.0.127-v287',
        requiresHostUpdate: false,
      },
    })
    .mockResolvedValue({})
  remountManager()
  await flushPromises()
  await document
    .querySelector<HTMLButtonElement>(
      '.official-app-manager__updates-dialog button.confirm-dialog__confirm',
    )!
    .click()
  await flushPromises()
  expect(service.install).toHaveBeenCalledExactlyOnceWith('draw')
  expect(wrapper.get('[role="status"]').text()).toContain('更新成功')
  expect(wrapper.find('.official-app-manager__update-dot').exists()).toBe(false)
  expect(wrapper.text()).toContain('已是最新')
})
it('opens a modal confirmation outside the list and cancel does not clear data', async () => {
  const dialog = await openCleanup()
  expect(dialog.parentElement).toBe(document.body)
  expect(dialog.open).toBe(true)
  expect(dialog.textContent).toContain('前端了么')
  expect(service.clearAppData).not.toHaveBeenCalled()
  dialog.querySelector<HTMLButtonElement>('button[type="button"]')!.click()
  await flushPromises()
  expect(
    document.querySelector(
      '.official-app-manager__dialog[aria-labelledby="official-app-action-title"]',
    ),
  ).toBeNull()
  expect(service.clearAppData).not.toHaveBeenCalled()
})
it('accepts only one installation before the busy buttons render', async () => {
  let finish!: () => void
  service.install.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await flushPromises()
  const buttons = wrapper.findAll('li button').filter((button) => button.text() === '下载')
  const first = buttons[0]!.element as HTMLButtonElement
  const second = buttons[1]!.element as HTMLButtonElement
  first.click()
  first.click()
  second.click()
  await flushPromises()
  expect(service.install).toHaveBeenCalledTimes(1)
  expect(second.disabled).toBe(true)
  finish()
  await flushPromises()
  expect(second.disabled).toBe(false)
  expect(wrapper.get('[role="status"]').text()).toContain('安装成功')
})
it('keeps busy and successful outcomes visible in the same dialog', async () => {
  let finish!: () => void
  service.clearAppData.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const dialog = await openCleanup()
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  await flushPromises()
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('正在清理')
  expect(dialog.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true)
  finish()
  await flushPromises()
  expect(service.clearAppData).toHaveBeenCalledExactlyOnceWith('frontendWorkshop', false)
  expect(dialog.open).toBe(true)
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('已清理')
  expect(dialog.textContent).toContain('刷新页面')
})
it('shows the actual cleanup failure next to confirmation and allows retry', async () => {
  service.clearAppData.mockRejectedValueOnce(
    new Error('其他页面正在使用这个 APP，请关闭后再清理数据'),
  )
  const dialog = await openCleanup()
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  await flushPromises()
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('其他页面正在使用')
  expect(dialog.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false)
  expect(dialog.querySelector('[role="status"]')).toBeNull()
  dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
  await flushPromises()
  expect(service.clearAppData).toHaveBeenCalledTimes(2)
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('已清理')
})

it('stops through the task center, waits for the owner, and ignores late progress after reopening', async () => {
  await flushPromises()
  let finish!: () => void
  let report!: (progress: { id: string; stage: string }) => void
  let signal!: AbortSignal
  service.installMany.mockImplementation((_ids, onProgress, stopSignal) => {
    report = onProgress
    signal = stopSignal
    return new Promise((_resolve, reject) => {
      finish = () => reject(signal.reason)
    })
  })
  await wrapper.get('input[value="draw"]').setValue(true)
  await wrapper.get('input[value="stitch"]').setValue(true)
  await wrapper.get('.official-app-manager__batch-download').trigger('click')
  report({ id: 'draw', stage: 'done' })
  const task = taskCenter
    .list()
    .find((task) => task.name === '下载内置 APP' && task.status === 'running')!
  expect(taskCenter.cancel(task.operationId)).toBe(true)
  expect(signal.aborted).toBe(true)
  expect(taskCenter.list().find((item) => item.operationId === task.operationId)?.status).toBe(
    'running',
  )
  report({ id: 'stitch', stage: 'downloading' })
  await flushPromises()
  expect(wrapper.text()).toContain('正在停止')
  service.list.mockResolvedValue([{ id: 'draw', files: [] }])
  finish()
  await flushPromises()
  expect(wrapper.text()).toContain('已停止下载，已完成 1 个')
  expect(taskCenter.list().find((item) => item.operationId === task.operationId)?.status).toBe(
    'cancelled',
  )
  expect(wrapper.get('input[value="stitch"]').element).toHaveProperty('checked', true)
  remountManager()
  await flushPromises()
  expect(service.installMany).toHaveBeenCalledOnce()
})

it('stops the final update check without losing already installed APPs or hanging the task', async () => {
  await flushPromises()
  let checkSignal!: AbortSignal
  service.availableUpdates.mockImplementationOnce((signal: AbortSignal) => {
    checkSignal = signal
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
  })
  await wrapper.get('input[value="draw"]').setValue(true)
  await wrapper.get('.official-app-manager__batch-download').trigger('click')
  await flushPromises()
  expect(checkSignal).toBeInstanceOf(AbortSignal)
  expect(wrapper.text()).toContain('正在检查更新状态')
  service.list.mockResolvedValue([{ id: 'draw', files: [] }])
  await wrapper.get('button.button--quiet').trigger('click')
  await flushPromises()
  expect(checkSignal.aborted).toBe(true)
  expect(wrapper.text()).toContain('已停止下载，已完成 1 个')
  expect(wrapper.text()).not.toContain('暂时无法检查 APP 更新')
  expect(wrapper.find('input[value="draw"]').exists()).toBe(false)
  expect(wrapper.get('.official-app-manager').attributes('aria-busy')).toBe('false')
})
