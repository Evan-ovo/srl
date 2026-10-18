// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMMUNITY_SOURCE_PLATFORM,
  type ResourceCommunitySourceSummary,
} from '../types/CommunitySource'
import ResourceSourceLinks from './ResourceSourceLinks.vue'
import { readDiscordSourceFromUrl } from '../services/DiscordSourceRefreshService'

const runtime = vi.hoisted(() => ({
  listSummariesForResource: vi.fn(),
}))

vi.mock('../core/CommunitySourceRuntime', () => ({
  communitySourceService: {
    listSummariesForResource: runtime.listSummariesForResource,
  },
}))

vi.mock('../services/DiscordSourceRefreshService', () => ({
  parseDiscordMessageUrl: vi.fn(),
  readDiscordSourceFromUrl: vi.fn(),
  readDiscordSourceRemote: vi.fn(),
}))

function savedSourceSummary(): ResourceCommunitySourceSummary {
  return {
    source: {
      id: 'source-1',
      platform: COMMUNITY_SOURCE_PLATFORM.DISCORD,
      sourceKeyHash: 'a'.repeat(64),
      channelId: 'channel-1',
      canonicalUrl: 'https://discord.com/channels/guild-1/channel-1/message-1',
      title: '已保存的 Discord 来源',
      revisionCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      id: 'binding-1',
      resourceId: 'resource-1',
      sourceId: 'source-1',
      createdAt: 1,
    },
  }
}

describe('ResourceSourceLinks Discord directory lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtime.listSummariesForResource.mockResolvedValue([savedSourceSummary()])
  })

  it('keeps the saved-source directory mounted when the Discord group opens', async () => {
    const wrapper = mount(ResourceSourceLinks, {
      props: { resourceId: 'resource-1', links: [] },
      global: {
        stubs: {
          ResourceLinkAdvancedSettings: true,
          ResourceLinkRow: true,
          Teleport: true,
        },
      },
    })
    await flushPromises()

    const discordRow = wrapper.get('.resource-source-platform__row')
    expect(discordRow.text()).toContain('Discord')
    await discordRow.trigger('click')
    await flushPromises()

    expect(wrapper.find('.resource-source-platform--open').exists()).toBe(true)
    expect(wrapper.text()).toContain('已保存的 Discord 来源')
    expect(wrapper.text()).not.toContain('正在读取已保存的 Discord 来源')
    wrapper.unmount()
  })

  it('loads linked posts even when the card already has a GitHub link and refreshes after a new binding', async () => {
    runtime.listSummariesForResource.mockResolvedValue([])
    const wrapper = mount(ResourceSourceLinks, {
      props: {
        resourceId: 'resource-1',
        links: [
          {
            id: 'github-1',
            type: 'github',
            label: 'GitHub',
            url: 'https://github.com/octocat/Hello-World',
            createdAt: 1,
          },
        ],
      },
      global: {
        stubs: { ResourceLinkAdvancedSettings: true, ResourceLinkRow: true, Teleport: true },
      },
    })
    await flushPromises()
    expect(runtime.listSummariesForResource).toHaveBeenCalledWith('resource-1')
    expect(
      wrapper
        .findAll('.resource-source-platform__row')
        .map((row) => row.text())
        .join(' '),
    ).not.toContain('Discord')
    runtime.listSummariesForResource.mockResolvedValue([savedSourceSummary()])
    window.dispatchEvent(new Event('srl:community-sources-changed'))
    await flushPromises()
    const discord = wrapper
      .findAll('.resource-source-platform__row')
      .find((row) => row.text().includes('Discord'))
    expect(discord).toBeDefined()
    await discord!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已保存的 Discord 来源')
    expect(
      wrapper
        .findAll('.resource-source-platform__row')
        .map((row) => row.text())
        .join(' '),
    ).toContain('GitHub')
    wrapper.unmount()
  })

  it('defaults to saving a link, explains inbox capture and retains GitHub metadata', async () => {
    const wrapper = mount(ResourceSourceLinks, {
      props: { resourceId: 'resource-1', links: [] },
      global: {
        stubs: {
          DiscordCommunitySources: true,
          ResourceLinkAdvancedSettings: true,
          ResourceLinkRow: true,
          Teleport: true,
        },
      },
    })
    await flushPromises()

    await wrapper.get('.resource-sources__add').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('仅保存来源链接，不会读取帖子正文')
    expect(wrapper.get('[role="dialog"]').text()).toContain('功能 → 收件箱')
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    expect(wrapper.get('.resource-source-add-actions__primary').text()).toBe('保存链接')
    await wrapper.get('input[type="url"]').setValue('https://github.com/octocat/Hello-World')
    await wrapper.get('.resource-source-add-actions__primary').trigger('click')

    const updates = wrapper.emitted('update:links') ?? []
    const links = updates.at(-1)?.[0] as Array<{
      type: string
      github?: { owner: string; repo: string }
    }>
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      type: 'github',
      github: { owner: 'octocat', repo: 'Hello-World' },
    })
    wrapper.unmount()
  })

  it('saves a Discord URL without requesting or saving a remote post', async () => {
    const wrapper = mount(ResourceSourceLinks, {
      props: { resourceId: 'resource-1', links: [] },
      global: {
        stubs: {
          DiscordCommunitySources: true,
          ResourceLinkAdvancedSettings: true,
          ResourceLinkRow: true,
          Teleport: true,
        },
      },
    })
    await wrapper.get('.resource-sources__add').trigger('click')
    const url = 'https://discord.com/channels/11111/22222/33333'
    await wrapper.get('input[type="url"]').setValue(url)
    await wrapper.get('.resource-source-add-actions__primary').trigger('click')
    expect(wrapper.emitted('update:links')?.at(-1)?.[0]).toEqual([
      expect.objectContaining({ url, type: 'discord', trustMode: 'linkOnly' }),
    ])
    expect(readDiscordSourceFromUrl).not.toHaveBeenCalled()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('来源链接已添加')
    await wrapper.get('.resource-sources__add').trigger('click')
    expect((wrapper.get('input[type="url"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
