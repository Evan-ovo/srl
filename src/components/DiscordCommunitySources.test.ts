// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE,
  COMMUNITY_SOURCE_MESSAGE_KIND,
  COMMUNITY_SOURCE_PLATFORM,
  toCommunitySourceSummary,
  type ResourceCommunitySourceSummary,
  type ResourceCommunitySourceView,
} from '../types/CommunitySource'
import DiscordCommunitySources from './DiscordCommunitySources.vue'

const runtime = vi.hoisted(() => ({
  getAttachmentBlob: vi.fn(),
  getForResource: vi.fn(),
  listSummariesForResource: vi.fn(),
}))

vi.mock('../core/CommunitySourceRuntime', () => ({
  communitySourceService: runtime,
}))

function sourceView(): ResourceCommunitySourceView {
  const sourceId = 'source-1'
  return {
    source: {
      id: sourceId,
      platform: COMMUNITY_SOURCE_PLATFORM.DISCORD,
      sourceKeyHash: 'a'.repeat(64),
      guildId: '11111',
      guildName: '社区 A',
      channelId: '22222',
      channelName: '角色发布',
      starterMessageId: '33333',
      canonicalUrl: 'https://discord.com/channels/11111/22222/33333',
      title: '帖子',
      forumTags: [],
      messageCount: 1,
      missingMessageCount: 0,
      latestMessagePreview: '正文',
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [
      {
        id: 'message-1',
        sourceId,
        messageKeyHash: 'b'.repeat(64),
        messageId: '33333',
        kind: COMMUNITY_SOURCE_MESSAGE_KIND.STARTER,
        authorId: '44444',
        authorName: 'Author',
        content: '正文',
        embeds: [],
        attachments: ['asset-first', 'asset-second'].map((localAssetId, index) => ({
          id: `attachment-${index}`,
          name: `attachment-${index}.txt`,
          size: 5,
          url: `https://cdn.discordapp.com/attachments/a/${index}`,
          contentType: 'text/plain',
          localAssetId,
          localState: COMMUNITY_SOURCE_ATTACHMENT_LOCAL_STATE.LOCAL,
        })),
        canonicalUrl: 'https://discord.com/channels/11111/22222/33333',
        timestamp: '2026-08-27T00:00:00.000Z',
        capturedAt: 1,
        updatedAt: 1,
      },
    ],
    binding: {
      id: 'resource-1:source:source-1',
      resourceId: 'resource-1',
      sourceId,
      createdAt: 1,
    },
  }
}

function sourceSummary(view: ResourceCommunitySourceView): ResourceCommunitySourceSummary {
  return {
    source: toCommunitySourceSummary(view.source),
    binding: view.binding,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('DiscordCommunitySources lazy local reads', () => {
  it.each([true, false])(
    'shows the pinned navigation and jumps to a saved marked message (has pin: %s)',
    async (hasPin) => {
      const view = sourceView()
      const scroll = vi.fn()
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: scroll,
      })
      if (hasPin)
        view.messages.push({
          ...view.messages[0]!,
          id: 'message-pinned',
          messageId: '55555',
          kind: COMMUNITY_SOURCE_MESSAGE_KIND.SELECTED_COMMENT,
          pinned: true,
          content: '帖主标注的重要评论',
          attachments: [],
        })
      runtime.listSummariesForResource.mockResolvedValue([sourceSummary(view)])
      runtime.getForResource.mockResolvedValue(view)
      runtime.getAttachmentBlob.mockResolvedValue(undefined)
      const wrapper = mount(DiscordCommunitySources, {
        props: { resourceId: 'resource-1' },
        attachTo: document.body,
      })
      await flushPromises()
      await wrapper.get('.discord-source-open').trigger('click')
      await flushPromises()
      document.querySelector<HTMLButtonElement>('button[aria-label="展开帖子导航"]')!.click()
      await flushPromises()
      const heading = [...document.querySelectorAll('h4')].find(
        (item) => item.textContent === '已标注信息',
      )!
      if (hasPin) {
        expect(heading).toBeTruthy()
        expect(heading.parentElement!.textContent).toContain('帖主标注的重要评论')
        const previous = scroll.mock.calls.length
        heading.parentElement!.querySelector<HTMLButtonElement>('button')!.click()
        await flushPromises()
        expect(scroll.mock.calls.length).toBeGreaterThan(previous)
        expect(
          document.querySelector('.discord-thread-message.is-selected')?.textContent,
        ).toContain('帖主标注的重要评论')
      } else {
        expect(heading).toBeUndefined()
        expect(document.body.textContent).not.toContain('尚无已保存的标注消息')
      }
      wrapper.unmount()
    },
  )

  it('loads only summaries for the directory and reads the selected source on demand', async () => {
    const view = sourceView()
    runtime.listSummariesForResource.mockResolvedValue([sourceSummary(view)])
    runtime.getForResource.mockResolvedValue(view)
    runtime.getAttachmentBlob.mockResolvedValue(undefined)
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(DiscordCommunitySources, {
      props: { resourceId: 'resource-1' },
      attachTo: document.body,
    })
    await flushPromises()

    expect(runtime.listSummariesForResource).toHaveBeenCalledWith('resource-1')
    expect(runtime.getForResource).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('社区 A · #角色发布')

    await wrapper.get('.discord-source-open').trigger('click')
    await flushPromises()

    expect(runtime.getForResource).toHaveBeenCalledWith('resource-1', 'source-1')
    expect(document.body.textContent).toContain('正文')
    expect(document.body.textContent).not.toContain('检查更新')
    expect(document.body.textContent).not.toContain('重试自动检查')
    const original = [...document.querySelectorAll('a')].find((link) =>
      link.textContent?.includes('打开 Discord 原帖'),
    )
    expect(original?.href).toBe(view.source.canonicalUrl)
    wrapper.unmount()
  })

  it('revokes partially hydrated object URLs when the detail closes', async () => {
    const view = sourceView()
    let resolveSecond!: (blob: Blob) => void
    runtime.listSummariesForResource.mockResolvedValue([sourceSummary(view)])
    runtime.getForResource.mockResolvedValue(view)
    runtime.getAttachmentBlob
      .mockResolvedValueOnce(new Blob(['first'], { type: 'text/plain' }))
      .mockImplementationOnce(
        () =>
          new Promise<Blob>((resolve) => {
            resolveSecond = resolve
          }),
      )
    const createObjectURL = vi.fn(() => 'blob:discord-first')
    const revokeObjectURL = vi.fn()
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    })
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(DiscordCommunitySources, {
      props: { resourceId: 'resource-1' },
      attachTo: document.body,
    })
    await flushPromises()
    expect(runtime.getForResource).not.toHaveBeenCalled()

    await wrapper.get('.discord-source-open').trigger('click')
    await vi.waitFor(() => expect(runtime.getAttachmentBlob).toHaveBeenCalledTimes(2))
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="关闭 Discord 来源详情"]',
    )
    expect(close).not.toBeNull()
    close!.click()
    resolveSecond(new Blob(['second'], { type: 'text/plain' }))
    await flushPromises()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:discord-first')
    wrapper.unmount()
  })

  it('refreshes only the open detail when background attachment localization finishes', async () => {
    const view = sourceView()
    runtime.listSummariesForResource.mockResolvedValue([sourceSummary(view)])
    runtime.getForResource.mockResolvedValue(view)
    runtime.getAttachmentBlob.mockResolvedValue(undefined)
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    const wrapper = mount(DiscordCommunitySources, {
      props: { resourceId: 'resource-1' },
      attachTo: document.body,
    })
    await flushPromises()
    await wrapper.get('.discord-source-open').trigger('click')
    await flushPromises()
    expect(runtime.getForResource).toHaveBeenCalledTimes(1)

    window.dispatchEvent(
      new CustomEvent('srl:community-source-attachments-updated', {
        detail: { sourceId: 'source-other' },
      }),
    )
    await flushPromises()
    expect(runtime.getForResource).toHaveBeenCalledTimes(1)

    window.dispatchEvent(
      new CustomEvent('srl:community-source-attachments-updated', {
        detail: { sourceId: 'source-1' },
      }),
    )
    await flushPromises()

    expect(runtime.getForResource).toHaveBeenCalledTimes(2)
    expect(runtime.listSummariesForResource).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
