/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiscordManualDeployDrawer from './DiscordManualDeployDrawer.vue'
import DiscordSetupGuideDrawer from './DiscordSetupGuideDrawer.vue'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'

const props = {
  open: true,
  applicationId: 'application-id',
  publicKey: 'public-key',
  botToken: 'bot-token',
  installationUrl: 'https://discord.com/oauth2/authorize',
  developerAppUrl: 'https://discord.com/developers/applications',
  developerBotUrl: 'https://discord.com/developers/applications/bot',
}

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      },
    },
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

describe('Discord tutorial screenshot previews', () => {
  it.each([
    ['one-click', DiscordSetupGuideDrawer],
    ['GitHub', DiscordSetupGuideDrawer],
    ['manual', DiscordManualDeployDrawer],
  ] as const)('presents the %s tutorial as a page, not a dialog or drawer', (_name, component) => {
    const wrapper = mount(component, {
      props: {
        ...props,
        ...(component === DiscordSetupGuideDrawer ? { deploymentMode: 'github' } : {}),
      },
      global: { stubs: { teleport: true } },
    })
    expect(wrapper.find('main.srl-independent-page').exists()).toBe(true)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.discord-guide-backdrop, .discord-manual-backdrop').exists()).toBe(false)
    wrapper.unmount()
  })

  it.each(['one-click', 'github', 'manual'] as const)(
    'opens privacy help at the end of the save instruction and returns focus in %s',
    async (mode) => {
      const wrapper = mount(
        mode === 'manual' ? DiscordManualDeployDrawer : DiscordSetupGuideDrawer,
        {
          props: { ...props, ...(mode === 'manual' ? {} : { deploymentMode: mode }) },
          attachTo: document.body,
          global: { stubs: { teleport: true } },
        },
      )
      try {
        const help = wrapper.get<HTMLButtonElement>('[aria-label="隐私说明与 Discord 配置"]')
        expect(help.element.parentElement?.textContent).toContain('确认保存成功。')
        expect(wrapper.find('dialog').exists()).toBe(false)
        await help.trigger('click')
        await flushPromises()
        expect(wrapper.get('dialog').attributes('open')).toBeDefined()
        expect(wrapper.get('dialog').text()).toContain('本地副本和历史版本不会随 Discord')
        expect(wrapper.get('dialog a').attributes('href')).toContain('/blob/main/PRIVACY.md')
        await wrapper.get('[aria-label="关闭隐私说明"]').trigger('click')
        await flushPromises()
        expect(wrapper.find('dialog').exists()).toBe(false)
        expect(document.activeElement).toBe(help.element)
        await help.trigger('click')
        const detail = { handled: false }
        window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
        await flushPromises()
        expect(detail.handled).toBe(true)
        expect(wrapper.find('dialog').exists()).toBe(false)
        expect(wrapper.emitted('close')).toBeUndefined()
      } finally {
        wrapper.unmount()
      }
    },
  )
  it('shows the D1 UUID column reference in the GitHub deploy guide', () => {
    const wrapper = mount(DiscordSetupGuideDrawer, {
      props: { ...props, deploymentMode: 'github' },
      global: { stubs: { teleport: true } },
    })
    const screenshot = wrapper
      .findAll('figure.discord-guide-screenshot')
      .find((figure) =>
        figure.get('img').attributes('src')?.includes('d1-database-uuid-column.jpg'),
      )

    expect(screenshot).toBeDefined()
    expect(screenshot?.get('img').attributes('alt')).toContain('UUID 列')
    expect(screenshot?.text()).toContain('复制完整 Database ID')
    wrapper.unmount()
  })

  it.each([
    ['GitHub setup guide', DiscordSetupGuideDrawer],
    ['manual deploy guide', DiscordManualDeployDrawer],
  ])('opens an image viewer immediately from the %s screenshot', async (_name, component) => {
    const wrapper = mount(component, {
      props,
      global: { stubs: { teleport: true } },
    })
    const screenshot = wrapper.get('figure[role="button"]')
    await screenshot.trigger('click')

    const viewer = wrapper.get('.resource-image-viewer--minimal')
    expect(viewer.get('img').attributes('alt')).toContain('Discord')
    expect(viewer.get('img').attributes('src')).toContain('/tutorials/discord-')
    expect(viewer.get('[aria-label="关闭图片"]').text()).toBe('×')

    await viewer.get('[aria-label="关闭图片"]').trigger('click')
    expect(wrapper.find('.resource-image-viewer').exists()).toBe(false)
    wrapper.unmount()
  })
})
