/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiView } from '../core/UiCustomization'

const { documentSource } = vi.hoisted(() => ({ documentSource: vi.fn(() => '') }))
vi.mock('../services/UiCustomizationService', () => ({
  compileCustomUiView: vi.fn(async () => ''),
}))
vi.mock('../services/UiViewRuntime', () => ({ createUiViewDocument: documentSource }))
import CustomUiFrame from './CustomUiFrame.vue'

enableAutoUnmount(afterEach)
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('只由全局设置授权联网，旧主题字段不能放行；开关变更重建运行容器', async () => {
  const view = { ...createUiView(), allowNetwork: true }
  mount(CustomUiFrame, { props: { view, snapshot: { html: '', controls: [], theme: 'light' } } })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', false)
  const storage = new BrowserStorageService()
  storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: true })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', true)
  storage.setPreviewPolicy({ allowScripts: false, allowRemoteResources: false })
  await flushPromises()
  expect(documentSource).toHaveBeenLastCalledWith('', false)
  expect(view.allowNetwork).toBe(true)
})
