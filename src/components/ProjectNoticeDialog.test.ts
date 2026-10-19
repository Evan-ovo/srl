/** @vitest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ native: false }))
vi.mock('../core/AndroidAppUpdate', () => ({ isAndroidApk: () => runtime.native }))
vi.mock('../core/NativeHaptics', () => ({ triggerNativeHaptic: vi.fn() }))

import ProjectNoticeDialog from './ProjectNoticeDialog.vue'

function makeScrollable(element: HTMLElement): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1200 })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 })
  element.scrollTop = 0
  element.dispatchEvent(new Event('scroll'))
}

describe('ProjectNoticeDialog', () => {
  afterEach(() => {
    runtime.native = false
    localStorage.clear()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('requires both five seconds and reaching the bottom before acknowledgement', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: true },
    })
    await flushPromises()

    const body = document.querySelector<HTMLElement>('.project-notice__body')!
    const button = document.querySelector<HTMLButtonElement>('.project-notice__footer button')!
    makeScrollable(body)
    await flushPromises()

    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('5 秒')

    vi.advanceTimersByTime(5_000)
    await flushPromises()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('滑至底部')

    body.scrollTop = 800
    body.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('我已阅读')

    button.click()
    expect(wrapper.emitted('acknowledged')).toHaveLength(1)
    wrapper.unmount()
  })

  it('does not unlock early when the reader reaches the bottom before five seconds', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: true },
    })
    await flushPromises()

    const body = document.querySelector<HTMLElement>('.project-notice__body')!
    const button = document.querySelector<HTMLButtonElement>('.project-notice__footer button')!
    makeScrollable(body)
    body.scrollTop = 800
    body.dispatchEvent(new Event('scroll'))
    await flushPromises()

    expect(button.disabled).toBe(true)

    vi.advanceTimersByTime(4_000)
    await flushPromises()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('1 秒')

    vi.advanceTimersByTime(1_000)
    await flushPromises()
    expect(button.disabled).toBe(false)
    wrapper.unmount()
  })

  it('does not allow Escape or the overlay to dismiss a required first-reading notice', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: true },
    })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    document.querySelector<HTMLElement>('.project-notice__overlay')?.click()
    expect(wrapper.emitted('acknowledged')).toBeUndefined()
    expect(document.querySelector('.project-notice')).not.toBeNull()
    wrapper.unmount()
  })

  it('关闭状态不吞掉工作台的 Escape 返回事件', async () => {
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: false },
    })
    await flushPromises()
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('review closes immediately without changing network permission or first-reading acknowledgement', async () => {
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: true, review: true },
    })
    await flushPromises()
    const button = document.querySelector<HTMLButtonElement>('.project-notice__footer button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('关闭说明')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(wrapper.emitted('acknowledged')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    wrapper.unmount()
  })
  it('first reading keeps automatic checks off unless the user checks the optional choice and finishes reading', async () => {
    runtime.native = true
    vi.useFakeTimers()
    const wrapper = mount(ProjectNoticeDialog, { attachTo: document.body, props: { open: true } })
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('.project-notice__option input')!
    expect(input.checked).toBe(false)
    input.click()
    expect(localStorage.getItem('srl.apk-update.automatic-enabled.v1')).toBeNull()
    const body = document.querySelector<HTMLElement>('.project-notice__body')!
    makeScrollable(body)
    body.scrollTop = 800
    body.dispatchEvent(new Event('scroll'))
    await vi.advanceTimersByTimeAsync(5000)
    document.querySelector<HTMLButtonElement>('.project-notice__footer button')!.click()
    expect(localStorage.getItem('srl.apk-update.automatic-enabled.v1')).toBe('true')
    expect(wrapper.emitted('acknowledged')).toHaveLength(1)
    wrapper.unmount()
  })

  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=project-notice-copy-test
  it('shows public data, domains, source and responsibility notices', () => {
    const wrapper = mount(ProjectNoticeDialog, {
      attachTo: document.body,
      props: { open: true },
    })

    expect(document.body.textContent).toContain('隐私与网络')
    expect(document.body.textContent).toContain('源码与费用')
    expect(document.body.textContent).toContain('使用责任')
    expect(document.body.textContent).toContain('本项目源码不收取购买费')
    expect(
      document.querySelector(
        'a[href="https://github.com/jixiangruyi117/SillyTavernResourceLibrary-Public"]',
      ),
    ).not.toBeNull()
    expect(document.body.textContent).toContain('release-assets.githubusercontent.com')
    expect(document.body.textContent).toContain('默认关闭')
    expect(document.body.textContent).not.toContain('功能现状')
    expect(document.body.textContent).not.toContain('完全免费，请勿付费购买')
    wrapper.unmount()
  })
  // SRL-PUBLIC-SYNC: END REPLACE id=project-notice-copy-test
})
