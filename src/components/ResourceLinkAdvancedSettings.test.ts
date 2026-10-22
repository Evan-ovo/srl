/** @vitest-environment jsdom */
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { discordSetupSession } from '../services/AssistantBrowserRuntime'
const { attachForm, detachForm } = vi.hoisted(() => ({
  attachForm: vi.fn(),
  detachForm: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  discordSetupService: {
    attachLocalForm: attachForm,
    localConnectionDraft: vi.fn(async () => undefined),
  },
}))
import ResourceLinkAdvancedSettings from './ResourceLinkAdvancedSettings.vue'
let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  Object.assign(discordSetupSession, { active: false, webStepActive: false, chatPresentation: '' })
  document.body.innerHTML = ''
})
it('parks the independent settings page during browser chat without discarding drafts or the form owner', async () => {
  attachForm.mockReturnValue(detachForm)
  Object.assign(discordSetupSession, { active: true, webStepActive: true, chatPresentation: '' })
  const outlet = document.createElement('div')
  outlet.id = 'srl-independent-page-outlet'
  document.body.append(outlet)
  wrapper = shallowMount(ResourceLinkAdvancedSettings, {
    attachTo: document.body,
    global: { stubs: { teleport: false } },
  })
  await flushPromises()
  const overlay = document.querySelector<HTMLElement>('.resource-source-advanced-page')!
  expect(overlay.getAttribute('role')).toBe('main')
  const input = overlay.querySelector<HTMLInputElement>('input')!
  input.value = '2234567890123456789'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const node = input
  for (const presentation of ['compact', 'fullscreen'] as const) {
    discordSetupSession.chatPresentation = presentation
    await flushPromises()
    expect(overlay.style.display).toBe('none')
    expect(input.isConnected).toBe(true)
    expect(detachForm).not.toHaveBeenCalled()
  }
  discordSetupSession.chatPresentation = ''
  await flushPromises()
  expect(overlay.style.display).not.toBe('none')
  expect(overlay.querySelector('input')).toBe(node)
  expect(input.value).toBe('2234567890123456789')
  expect(attachForm).toHaveBeenCalledOnce()
  expect(wrapper.emitted('close')).toBeUndefined()
  discordSetupSession.chatPresentation = 'compact'
  discordSetupSession.webStepActive = false
  await flushPromises()
  expect(overlay.style.display).not.toBe('none')
})
