/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
vi.mock('../core/AppContainer', () => ({
  resourceService: {},
  resourceGalleryService: {
    list: vi.fn(async () => ({
      items: [],
      total: 0,
      galleryCount: 0,
      page: 1,
      pageCount: 1,
      categories: [],
      availableCategories: [],
    })),
  },
}))
import ResourceGalleryPanel from './ResourceGalleryPanel.vue'

describe('gallery keyboard propagation', () => {
  it('allows IME confirmation and only prevents normal input Enter from submitting the parent form', async () => {
    const wrapper = mount(ResourceGalleryPanel, {
      props: { resource: { id: 'one', type: 'other' } as Resource },
    })
    await flushPromises()
    const input = wrapper.get('input[type=search]')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input.element.dispatchEvent(composing)
    expect(composing.defaultPrevented).toBe(false)
    const normal = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input.element.dispatchEvent(normal)
    expect(normal.defaultPrevented).toBe(true)
    wrapper.unmount()
  })
})
