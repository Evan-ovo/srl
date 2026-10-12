/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import RelayWorkerSettings from './RelayWorkerSettings.vue'
import {
  acquireRelayWorkerTarget,
  loadRelayWorkerBaseUrl,
  getDeviceRelayStatus,
} from '../services/RelayWorkerSettingsService'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})
it('restores a saved choice on reopening and disables relay features when cleared', async () => {
  localStorage.clear()
  const first = mount(RelayWorkerSettings)
  expect(first.text()).toContain('当前使用：未配置')
  await first.get('input').setValue('https://worker.example')
  await first
    .findAll('button')
    .find((b) => b.text() === '保存')!
    .trigger('click')
  expect(first.text()).toContain('自建中继 · https://worker.example')
  first.unmount()
  const reopened = mount(RelayWorkerSettings)
  const lease = acquireRelayWorkerTarget()
  try {
    await reopened
      .findAll('button')
      .find((b) => b.text() === '清除地址')!
      .trigger('click')
    expect(reopened.text()).toContain('先断开互传')
    expect(loadRelayWorkerBaseUrl()).toBe('https://worker.example')
  } finally {
    lease.release()
  }
  await reopened
    .findAll('button')
    .find((b) => b.text() === '清除地址')!
    .trigger('click')
  expect(reopened.text()).toContain('当前使用：未配置')
  reopened.unmount()
})
it('keeps invalid stored settings visible for repair and does not claim an unsuccessful check passed', async () => {
  localStorage.setItem('srl.publicWorker.baseUrl.v1', 'https://worker.example/private')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
  const panel = mount(RelayWorkerSettings)
  expect(panel.text()).toContain('配置无效，已停止中继请求')
  await panel.get('input').setValue('https://worker.example')
  await panel
    .findAll('button')
    .find((b) => b.text() === '检查连接')!
    .trigger('click')
  await flushPromises()
  expect(panel.get('[role="status"]').text()).toContain('offline')
  expect(localStorage.getItem('srl.publicWorker.baseUrl.v1')).toBe(
    'https://worker.example/private',
  )
  panel.unmount()
})

it('checks a draft without enabling it until saved, and revokes access on failed recheck', async () => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify({
            ok: true,
            service: String(url).endsWith('/api/bridge/health')
              ? 'srl-bridge-cloudflare'
              : 'srl-koofr-worker',
          }),
        ),
    ),
  )
  const panel = mount(RelayWorkerSettings)
  await panel.get('input').setValue('https://worker.example')
  const button = (label: string) => panel.findAll('button').find((item) => item.text() === label)!
  await button('检查连接').trigger('click')
  await flushPromises()
  expect(panel.text()).toContain('请保存该地址以开启中继码')
  expect(getDeviceRelayStatus().enabled).toBe(false)
  await button('保存').trigger('click')
  expect(getDeviceRelayStatus().enabled).toBe(true)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  await button('检查连接').trigger('click')
  await flushPromises()
  expect(getDeviceRelayStatus().enabled).toBe(false)
  expect(panel.text()).toContain('offline')
  panel.unmount()
})
