/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import DiscordInboxCenter from './DiscordInboxCenter.vue'

const inboxActions = { openCloudCleanup: vi.fn(), openAutomationSettings: vi.fn() }

vi.mock('../services/DiscordSourceSettingsService', () => ({
  loadDiscordSourceConnectionSettings: () => ({
    applicationId: '',
    publicKey: '',
    botToken: '',
    workerBaseUrl: '',
  }),
  saveDiscordSourceConnectionSettings: vi.fn(),
  saveDiscordSourceConnectionStatus: vi.fn(),
}))

const stubs = {
  DiscordInboxPanel: {
    props: ['mode', 'view'],
    methods: inboxActions,
    template:
      "<section :data-testid=\"mode === 'pairing' ? 'pairing-settings' : view === 'review' ? 'binding-review' : 'post-inbox'\"><button data-testid=\"emit-organization-counts\" @click=\"$emit('organization-counts', { review: 3, reviewHasMore: true, pending: 12 })\"></button>收件面板</section>",
  },
  DiscordResourceDownloadPanel: {
    template: '<section data-testid="resource-inbox">资源下载</section>',
  },
  DiscordPendingSources: {
    template: '<section data-testid="pending-sources">待整理来源</section>',
  },
}

describe('standalone inbox', () => {
  it('places cleanup and inbox settings in the page header and opens the matching panels', async () => {
    const wrapper = mount(DiscordInboxCenter, { attachTo: document.body, global: { stubs } })
    try {
      const header = wrapper.find('.feature-app-header__trailing')
      expect(header.exists()).toBe(true)
      const cleanup = header.get('[aria-label="清理云端"]')
      const settings = header.get('[aria-label="收件箱设置"]')
      expect(cleanup.find('svg').exists()).toBe(true)
      expect(settings.find('svg').exists()).toBe(true)
      expect(cleanup.find('svg path').attributes('stroke')).toBe('currentColor')
      expect(settings.find('svg path').attributes('stroke')).toBe('currentColor')
      await cleanup.trigger('click')
      await settings.trigger('click')
      expect(inboxActions.openCloudCleanup).toHaveBeenCalledOnce()
      expect(inboxActions.openAutomationSettings).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
      vi.clearAllMocks()
    }
  })

  it('opens the existing connection settings without duplicating the inbox panels', async () => {
    const outlet = document.createElement('div')
    outlet.id = 'srl-independent-page-outlet'
    document.body.append(outlet)
    const wrapper = mount(DiscordInboxCenter, { attachTo: document.body, global: { stubs } })
    try {
      expect(wrapper.get('h1').text()).toBe('收件箱')
      expect(wrapper.find('[data-testid="post-inbox"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="resource-inbox"]').exists()).toBe(true)
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '连接设置')!
        .trigger('click')
      await vi.waitFor(() =>
        expect(document.querySelector('.resource-source-advanced-page')).not.toBeNull(),
      )
      const back = { handled: false }
      window.dispatchEvent(new CustomEvent('srl:back-request', { detail: back }))
      await flushPromises()
      expect(back.handled).toBe(true)
      expect(document.querySelector('.resource-source-advanced-page')).toBeNull()
      expect(wrapper.get('h1').text()).toBe('收件箱')
      expect(wrapper.find('.discord-inbox-center__secondary').text()).toContain('待整理来源')
      await wrapper
        .findAll('button')
        .find((button) => button.text() === '连接设置')!
        .trigger('click')
      await vi.waitFor(() =>
        expect(document.querySelector('.resource-source-advanced-page')).not.toBeNull(),
      )
      expect(document.querySelector('h2')?.textContent).toBe('Discord 连接设置')
      expect(document.querySelector('.resource-source-advanced-page')?.textContent).toContain(
        '返回收件箱',
      )
      expect(
        document.querySelector('.resource-source-advanced-page [data-testid="post-inbox"]'),
      ).toBeNull()
      expect(
        document.querySelector('.resource-source-advanced-page [data-testid="pairing-settings"]'),
      ).not.toBeNull()
      expect(
        document.querySelector('.resource-source-advanced-page [data-testid="resource-inbox"]'),
      ).toBeNull()
      expect(
        document.querySelector('.resource-source-advanced-page [data-testid="pending-sources"]'),
      ).toBeNull()
      ;(document.querySelector('.resource-source-advanced__back') as HTMLButtonElement).click()
      await flushPromises()
      expect(document.querySelector('.resource-source-advanced-page')).toBeNull()
      expect(wrapper.find('[data-testid="resource-inbox"]').exists()).toBe(true)
    } finally {
      wrapper.unmount()
      outlet.remove()
    }
  })

  it('groups pending-source review directly under auto-binding review before resource downloads', async () => {
    const wrapper = mount(DiscordInboxCenter, { global: { stubs } })
    try {
      const labels = wrapper
        .findAll('.discord-inbox-center__secondary button')
        .map((button) => button.text())
      expect(labels).toEqual(['自动绑定审核›', '待整理来源›'])
      const text = wrapper.text()
      expect(text.indexOf('自动绑定审核')).toBeLessThan(text.indexOf('待整理来源'))
      expect(text.indexOf('待整理来源')).toBeLessThan(text.indexOf('资源下载'))

      await wrapper
        .findAll('.discord-inbox-center__secondary button')
        .find((button) => button.text().includes('待整理来源'))!
        .trigger('click')
      expect(wrapper.get('h1').text()).toBe('待整理来源')
      expect(wrapper.find('[data-testid="pending-sources"]').exists()).toBe(true)
      expect(wrapper.find('[aria-label="清理云端"]').exists()).toBe(false)
      expect(wrapper.find('[aria-label="收件箱设置"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('shows counts for automatic-binding review and pending sources', async () => {
    const wrapper = mount(DiscordInboxCenter, { global: { stubs } })
    try {
      await wrapper.get('[data-testid="emit-organization-counts"]').trigger('click')
      const secondary = wrapper.get('.discord-inbox-center__secondary')
      expect(secondary.text()).toContain('3+')
      expect(secondary.text()).toContain('12')
    } finally {
      wrapper.unmount()
    }
  })
})
