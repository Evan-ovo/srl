// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import DiscordMarkdownText from './DiscordMarkdownText.vue'

describe('DiscordMarkdownText', () => {
  it('keeps mixed Markdown tokens inside one list body alongside the marker', () => {
    const wrapper = mount(DiscordMarkdownText, {
      props: {
        content:
          '- 建议按顺序阅读||想快速阅读者可以先看摘要再继续正文||\n' +
          '- 感谢示例作者https://discord.com/channels/123/456\n' +
          '1. **编号项**和`代码`、[链接](https://example.com)，继续正文。',
      },
    })
    for (const line of wrapper.findAll('.discord-markdown__line--list-item')) {
      expect([...line.element.children].map((el) => el.className)).toEqual([
        'discord-markdown__marker',
        'discord-markdown__content',
      ])
    }
    const bodies = wrapper.findAll('.discord-markdown__content')
    expect(bodies[0]?.text()).toBe('建议按顺序阅读想快速阅读者可以先看摘要再继续正文')
    expect(bodies[1]?.text()).toBe('感谢示例作者https://discord.com/channels/123/456')
    expect(bodies[2]?.text()).toBe('编号项和代码、链接，继续正文。')
    expect(wrapper.get('.discord-markdown__content .is-spoiler').text()).toBe(
      '想快速阅读者可以先看摘要再继续正文',
    )
    expect(wrapper.get('.discord-markdown__content a').attributes('href')).toBe(
      'https://discord.com/channels/123/456',
    )
    expect(wrapper.get('.discord-markdown__content .is-bold').text()).toBe('编号项')
    expect(wrapper.get('.discord-markdown__content code').text()).toBe('代码')
  })
  it('renders Discord Markdown through Vue text nodes without executing embedded HTML', () => {
    const wrapper = mount(DiscordMarkdownText, {
      props: {
        content:
          '## 标题\n> **重点** 与 `代码`\n[入口](https://example.com)\n<img src=x onerror=alert(1)>',
      },
    })

    expect(wrapper.get('.discord-markdown__line--heading-2').text()).toBe('标题')
    expect(wrapper.get('.discord-markdown__line--quote .is-bold').text()).toBe('重点')
    expect(wrapper.get('.discord-markdown__inline-code').text()).toBe('代码')
    expect(wrapper.get('a').attributes('href')).toBe('https://example.com/')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
  })
})
