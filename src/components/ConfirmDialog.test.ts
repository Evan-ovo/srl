/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { chooseAction, confirmAction, useConfirmDialogState } from '../composables/UseConfirmDialog'
import ConfirmDialog from './ConfirmDialog.vue'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})
// Teleport 会把对话框挪到 body 下，组件包装器查不到，统一走 document 查询。
function dialogButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.confirm-dialog button'))
}

function confirmButton(): HTMLButtonElement | undefined {
  return dialogButtons().find((button) => button.classList.contains('confirm-dialog__confirm'))
}

function cancelButton(): HTMLButtonElement | undefined {
  return dialogButtons().find((button) => !button.classList.contains('confirm-dialog__confirm'))
}

async function drain(): Promise<void> {
  // 清掉可能残留的对话框，避免用例间互相影响
  const { activeDialog, respond } = useConfirmDialogState()
  for (let i = 0; i < 10 && activeDialog.value; i += 1) {
    respond('cancel')
    await flushPromises()
  }
}

describe('ConfirmDialog + confirmAction', () => {
  it('keeps task continuation disabled until the original unlock form reports readiness, resetting for the next prompt', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      global: {
        stubs: {
          SecretProtectionSettings: {
            template: '<button class="unlock-test" @click="$emit(\'ready\')">本机解锁</button>',
            emits: ['ready'],
          },
        },
      },
    })
    try {
      for (let index = 0; index < 2; index++) {
        const pending = confirmAction({
          title: '解锁部署密钥',
          message: '本机密码',
          centered: true,
          secretUnlock: true,
        })
        await flushPromises()
        expect(confirmButton()?.disabled).toBe(true)
        document.querySelector<HTMLButtonElement>('.unlock-test')!.click()
        await flushPromises()
        expect(confirmButton()?.disabled).toBe(false)
        confirmButton()!.click()
        expect(await pending).toBe(true)
        await flushPromises()
      }
    } finally {
      wrapper.unmount()
      await drain()
    }
  })
  it('renders the extra choice through the existing dialog and returns its distinct response', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = chooseAction({
      title: '下载资源',
      message: '选择格式',
      confirmLabel: '修改版单文件',
      alternativeLabel: '下载原版',
      additionalLabel: '完整修改包',
    })
    await flushPromises()
    expect(dialogButtons()).toHaveLength(4)
    expect(document.querySelector('.confirm-dialog__choices')).not.toBeNull()
    dialogButtons()
      .find((button) => button.textContent?.trim() === '完整修改包')!
      .click()
    await expect(pending).resolves.toBe('additional')
    await flushPromises()
    expect(document.querySelector('.confirm-dialog')).toBeNull()
    wrapper.unmount()
  })
  it('keeps keyboard focus inside confirmation and restores the opener after cancelling', async () => {
    await drain()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = confirmAction({ message: '清除数据', danger: true })
    await flushPromises()
    expect(document.activeElement).toBe(cancelButton())
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(confirmButton())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(cancelButton())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await expect(pending).resolves.toBe(false)
    await flushPromises()
    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
    opener.remove()
  })
  it('确认按钮 resolve(true)，附带标题与正文，危险操作有红色样式', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = confirmAction({ title: '删除资源', message: '确定删除吗？', danger: true })
    await flushPromises()

    expect(document.body.textContent).toContain('删除资源')
    expect(document.body.textContent).toContain('确定删除吗？')
    const confirm = confirmButton()
    expect(confirm?.classList.contains('confirm-dialog__confirm--danger')).toBe(true)
    confirm?.click()
    expect(await pending).toBe(true)
    await flushPromises()
    expect(document.querySelector('.confirm-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('取消按钮与 Esc 都 resolve(false)', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })

    const first = confirmAction({ message: '第一问' })
    await flushPromises()
    cancelButton()?.click()
    expect(await first).toBe(false)

    const second = confirmAction({ message: '第二问' })
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await second).toBe(false)
    wrapper.unmount()
  })

  it('并发请求排队，一次只显示一个', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const first = confirmAction({ message: '排队一' })
    const second = confirmAction({ message: '排队二' })
    await flushPromises()

    expect(document.body.textContent).toContain('排队一')
    expect(document.body.textContent).not.toContain('排队二')

    confirmButton()?.click()
    expect(await first).toBe(true)
    await flushPromises()
    expect(document.body.textContent).toContain('排队二')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await second).toBe(false)
    wrapper.unmount()
  })

  it('opens a native modal above existing dialogs and consumes back as cancel', async () => {
    await drain()
    const parent = document.createElement('dialog')
    parent.setAttribute('open', '')
    document.body.appendChild(parent)
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = confirmAction({ message: '确认正文', danger: true })
    await flushPromises()
    expect(document.querySelector('dialog.confirm-dialog__overlay')?.hasAttribute('open')).toBe(
      true,
    )
    expect(
      document
        .querySelector('dialog.confirm-dialog__overlay')
        ?.classList.contains('confirm-dialog__overlay--safety-layer'),
    ).toBe(true)
    expect(document.activeElement).toBe(cancelButton())
    const detail = { handled: false }
    window.dispatchEvent(new CustomEvent('srl:back-request', { detail }))
    expect(detail.handled).toBe(true)
    expect(await pending).toBe(false)
    expect(parent.hasAttribute('open')).toBe(true)
    parent.remove()
    wrapper.unmount()
  })
  it('presents a request made before the renderer mounts', async () => {
    await drain()
    const pending = confirmAction({ message: '挂载前已请求确认' })
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    await flushPromises()
    expect(document.querySelector('dialog.confirm-dialog__overlay')?.hasAttribute('open')).toBe(
      true,
    )
    cancelButton()?.click()
    expect(await pending).toBe(false)
    wrapper.unmount()
  })
  it('keeps confirmations visible when an embedded WebView cannot open a modal dialog', async () => {
    await drain()
    const showModal = HTMLDialogElement.prototype.showModal
    HTMLDialogElement.prototype.showModal = vi.fn(() => {
      throw new Error('top layer unavailable')
    })
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    try {
      const pending = confirmAction({ title: '归档并开始新对话', message: '确认归档' })
      await flushPromises()
      const dialog = document.querySelector<HTMLDialogElement>('.confirm-dialog__overlay')
      expect(dialog?.hasAttribute('open')).toBe(true)
      expect(dialog?.classList.contains('confirm-dialog__overlay--fallback')).toBe(true)
      expect(document.body.textContent).toContain('确认归档')
      cancelButton()?.click()
      await expect(pending).resolves.toBe(false)
    } finally {
      HTMLDialogElement.prototype.showModal = showModal
      wrapper.unmount()
    }
  })
  it('falls back when an embedded WebView silently declines to open a modal dialog', async () => {
    await drain()
    const showModal = HTMLDialogElement.prototype.showModal
    HTMLDialogElement.prototype.showModal = vi.fn()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    try {
      const pending = confirmAction({ title: '归档并开始新对话', message: '确认归档' })
      await flushPromises()
      const dialog = document.querySelector<HTMLDialogElement>('.confirm-dialog__overlay')
      expect(dialog?.hasAttribute('open')).toBe(true)
      expect(dialog?.classList.contains('confirm-dialog__overlay--safety-layer')).toBe(true)
      expect(dialog?.classList.contains('confirm-dialog__overlay--fallback')).toBe(true)
      expect(document.body.textContent).toContain('确认归档')
      confirmButton()?.click()
      await expect(pending).resolves.toBe(true)
    } finally {
      HTMLDialogElement.prototype.showModal = showModal
      wrapper.unmount()
    }
  })
  it('默认文案为「请确认 / 确认 / 取消」', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = confirmAction({ message: '仅正文' })
    await flushPromises()
    expect(document.body.textContent).toContain('请确认')
    const labels = dialogButtons().map((button) => button.textContent?.trim())
    expect(labels).toContain('确认')
    expect(labels).toContain('取消')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await pending
    wrapper.unmount()
  })

  it('centered 选项在移动端仍保持屏幕中央弹窗', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = confirmAction({ message: '中央确认', centered: true })
    await flushPromises()

    expect(
      document.querySelector('.confirm-dialog__overlay')?.classList.contains('is-centered'),
    ).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(pending).resolves.toBe(false)
    wrapper.unmount()
  })

  it('第三个明确选项会返回 alternative，不会与取消混淆', async () => {
    await drain()
    const wrapper = mount(ConfirmDialog, { attachTo: document.body })
    const pending = chooseAction({
      message: '发现新版本',
      confirmLabel: '更新',
      cancelLabel: '稍后提醒',
      alternativeLabel: '不更新当前版本',
    })
    await flushPromises()

    const alternative = dialogButtons().find(
      (button) => button.textContent?.trim() === '不更新当前版本',
    )
    alternative?.click()
    await expect(pending).resolves.toBe('alternative')
    wrapper.unmount()
  })
})
