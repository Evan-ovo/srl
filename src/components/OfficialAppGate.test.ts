/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OfficialAppGate from './OfficialAppGate.vue'

const runtime = vi.hoisted(() => ({
  ensurePreinstalledOfficialApps: vi.fn(),
  acquireOfficialAppUse: vi.fn(),
  loadOfficialApp: vi.fn(),
  release: vi.fn(),
  officialAppService: {
    list: vi.fn(),
    getInstalled: vi.fn(),
    ready: vi.fn(),
    install: vi.fn(),
    repairCompatibility: vi.fn(),
  },
}))
vi.mock('../core/OfficialAppRuntime', () => runtime)
let wrapper: ReturnType<typeof mount>
beforeEach(() => {
  vi.resetAllMocks()
  runtime.ensurePreinstalledOfficialApps.mockResolvedValue(undefined)
  runtime.acquireOfficialAppUse.mockResolvedValue(runtime.release)
  runtime.officialAppService.list.mockResolvedValue([{ id: 'draw' }])
  runtime.officialAppService.getInstalled.mockResolvedValue({ id: 'draw' })
  runtime.officialAppService.install.mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllEnvs()
})
function open() {
  wrapper = mount(OfficialAppGate, { props: { appId: 'draw', appName: '抽了么' } })
}

it('releases the use lease before same-content dependency repair and then opens without another install button', async () => {
  vi.stubEnv('DEV', false)
  runtime.loadOfficialApp.mockImplementationOnce(async (_id, onReady) => {
    onReady(false)
  })
  runtime.officialAppService.repairCompatibility.mockImplementationOnce(async (_id, signal) => {
    expect(runtime.release).toHaveBeenCalledOnce()
    expect(signal.aborted).toBe(false)
    return true
  })
  runtime.loadOfficialApp.mockImplementationOnce(async (_id, onReady) => {
    onReady(true)
    return { template: '<p>程序已就绪</p>' }
  })
  open()
  await flushPromises()
  expect(wrapper.text()).toContain('程序已就绪')
  expect(runtime.officialAppService.install).not.toHaveBeenCalled()
  expect(runtime.officialAppService.repairCompatibility).toHaveBeenCalledOnce()
})

it('loads through the single readiness owner while holding the APP use lease', async () => {
  runtime.loadOfficialApp.mockImplementation(async (_id, onReady) => {
    expect(runtime.acquireOfficialAppUse).toHaveBeenCalledExactlyOnceWith('draw')
    expect(runtime.release).not.toHaveBeenCalled()
    onReady(true)
    return { template: '<p>抽了么就绪</p>' }
  })
  open()
  await flushPromises()
  expect(runtime.loadOfficialApp).toHaveBeenCalledExactlyOnceWith('draw', expect.any(Function))
  expect(runtime.officialAppService.ready).not.toHaveBeenCalled()
  expect(runtime.officialAppService.list).not.toHaveBeenCalled()
  expect(runtime.officialAppService.getInstalled).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('抽了么就绪')
  wrapper.unmount()
  expect(runtime.release).toHaveBeenCalledTimes(1)
})

it('releases an unusable installation before downloading its compatible replacement', async () => {
  runtime.loadOfficialApp.mockImplementationOnce(async (_id, onReady) => {
    onReady(false)
  })
  open()
  await flushPromises()
  expect(runtime.release).toHaveBeenCalledTimes(1)
  runtime.officialAppService.install.mockImplementation(async () => {
    expect(runtime.release).toHaveBeenCalledTimes(1)
  })
  runtime.loadOfficialApp.mockImplementationOnce(async (_id, onReady) => {
    onReady(true)
    return { template: '<p>兼容版本已就绪</p>' }
  })
  await wrapper
    .findAll('button')
    .find((button) => button.text() === '下载兼容版本')!
    .trigger('click')
  await flushPromises()
  expect(runtime.officialAppService.install).toHaveBeenCalledExactlyOnceWith('draw')
  expect(wrapper.text()).toContain('兼容版本已就绪')
})

it('keeps module-load failures on the reopen path rather than requiring another download', async () => {
  runtime.loadOfficialApp.mockImplementation(async (_id, onReady) => {
    onReady(true)
    throw new Error('模块加载失败')
  })
  open()
  await flushPromises()
  expect(wrapper.text()).toContain('模块加载失败')
  expect(wrapper.text()).toContain('重新打开')
  expect(wrapper.text()).not.toContain('下载兼容版本')
  expect(runtime.release).toHaveBeenCalledTimes(1)
})

it('does not load an APP after leaving while its lease is pending', async () => {
  let acquired!: (release: () => void) => void
  runtime.acquireOfficialAppUse.mockImplementation(
    () =>
      new Promise((resolve) => {
        acquired = resolve
      }),
  )
  open()
  await flushPromises()
  wrapper.unmount()
  acquired(runtime.release)
  await flushPromises()
  expect(runtime.loadOfficialApp).not.toHaveBeenCalled()
  expect(runtime.release).toHaveBeenCalledTimes(1)
})
