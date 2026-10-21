/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UserPersonaTemplatePanel from './UserPersonaTemplatePanel.vue'

describe('persona template naming', () => {
  it('preserves composition and saves only on the subsequent Enter', async () => {
    const wrapper = mount(UserPersonaTemplatePanel, {
      props: {
        builtinTemplates: [],
        customTemplates: [],
        canDelete: false,
        targetLabel: '人物',
        selectedTemplateId: '',
        creating: true,
        templateName: '人物模板',
      },
    })
    const input = wrapper.get('input')
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input.element.dispatchEvent(composing)
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(composing.defaultPrevented).toBe(false)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('save')).toHaveLength(1)
    wrapper.unmount()
  })
})
