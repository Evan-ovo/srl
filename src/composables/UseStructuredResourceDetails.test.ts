/** @vitest-environment jsdom */
import { Blob } from 'node:buffer'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import { useStructuredResourceDetails } from './UseStructuredResourceDetails'

vi.mock('./UsePreviewPolicy', () => ({ usePreviewPolicy: () => ref({ allowScripts: false }) }))

async function openDetails(preset: Record<string, unknown>) {
  const resource = {
    id: 'preset',
    type: RESOURCE_TYPE.PRESET,
    contentHash: 'original',
    fileName: 'preset.json',
    originalBlob: new Blob([JSON.stringify(preset)]),
  } as unknown as Resource
  let details!: ReturnType<typeof useStructuredResourceDetails>
  const wrapper = mount(
    defineComponent({
      setup() {
        details = useStructuredResourceDetails({ resource })
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  return { details, wrapper, resource }
}

describe('预设详情顺序', () => {
  it('按100001组展示并读取组内启停，孤儿条目保留在末尾且不改原件', async () => {
    const preset = {
      prompts: [
        { identifier: 'a', name: 'A', content: '甲', enabled: true },
        { identifier: 'b', name: 'B', content: '乙', enabled: false },
        { identifier: 'c', name: 'C', content: '丙' },
        { identifier: 'orphan', name: '孤儿', content: '保留' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'c', enabled: true },
            { identifier: 'orphan', enabled: true },
          ],
        },
        {
          character_id: '100001',
          order: [
            { identifier: 'missing', enabled: true },
            { identifier: 'c', enabled: true },
            { identifier: 'a', enabled: false },
            { identifier: 'c', enabled: false },
            { identifier: 'b', enabled: true },
          ],
        },
      ],
    }
    const { details, wrapper, resource } = await openDetails(preset)
    try {
      expect(details.rawError.value).toBe('')
      expect(details.presetPrompts.value.map((p) => [p.id, p.enabled])).toEqual([
        ['c', true],
        ['a', false],
        ['b', true],
        ['orphan', false],
      ])
      details.presetPromptQuery.value = '甲'
      expect(details.filteredPresetPrompts.value.map((p) => p.id)).toEqual(['a'])
      details.selectPresetPrompt('a')
      expect(details.selectedPresetPrompt.value?.content).toBe('甲')
      expect(await resource.originalBlob.text()).toBe(JSON.stringify(preset))
    } finally {
      wrapper.unmount()
    }
  })

  it('没有排序表时保留旧格式的顺序、别名、无标识条目和启停', async () => {
    const { details, wrapper } = await openDetails({
      prompts: [
        { id: 'legacy', name: '旧格式', prompt: '正文', enabled: false },
        { name: '无标识一', content: '一' },
        { name: '无标识二', content: '二' },
      ],
    })
    try {
      expect(details.presetPrompts.value.map((p) => [p.id, p.content, p.enabled])).toEqual([
        ['legacy', '正文', false],
        ['1', '一', true],
        ['2', '二', true],
      ])
    } finally {
      wrapper.unmount()
    }
  })
})
