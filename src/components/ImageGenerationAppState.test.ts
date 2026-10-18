/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { generate, toBlob, saveGenerated } = vi.hoisted(() => ({
  generate: vi.fn(),
  toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  saveGenerated: vi.fn(async () => ({ id: 'saved-image', name: 'saved image' })),
}))

vi.mock('../core/ImageGenerationContainer', () => ({
  frontendWorkshopImageGenerationService: {
    defaultConfig: (provider: string) => ({
      provider,
      endpoint:
        provider === 'novelai'
          ? 'https://image.novelai.net/ai/generate-image'
          : 'https://api.openai.com/v1/images/generations',
    }),
    getSavedConfig: (provider: string) => ({
      provider,
      model: provider === 'novelai' ? 'nai-diffusion-5-full' : 'gpt-image-2',
      apiKey: 'state-test-key',
      endpoint:
        provider === 'novelai'
          ? 'https://image.novelai.net/ai/generate-image'
          : 'https://api.openai.com/v1/images/generations',
    }),
    generate,
    toBlob,
    saveConfiguration: vi.fn(async (value) => value),
    listModels: vi.fn(async () => ({ options: [], message: '0 models' })),
  },
}))
vi.mock('../core/ImageAlbumContainer', () => ({
  generatedImageAlbumService: {
    saveGenerated,
    getOriginalBlob: vi.fn(),
    setHostedUrl: vi.fn(),
  },
  frontendWorkshopImageHostingService: {
    getSelfHostedConfiguration: vi.fn(() => null),
    uploadBlobShared: vi.fn(),
    uploadBlobSelfHosted: vi.fn(),
  },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('../core/NativeFileExport', () => ({
  isNativeFileExportAvailable: () => false,
  saveBlobToNativeDestination: vi.fn(),
}))

import ImageGenerationApp from './ImageGenerationApp.vue'
import { frontendWorkshopImageGenerationService } from '../core/ImageGenerationContainer'
import { frontendWorkshopImageDraftService } from '../services/FrontendWorkshopImageDraftService'
import type { FrontendWorkshopGeneratedImage } from '../services/FrontendWorkshopImageGenerationService'

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper
    .findAll('button')
    .find((item) => item.text() === label || (label === '角色' && item.text().startsWith('角色 ·')))
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

async function selectProvider(wrapper: ReturnType<typeof mount>, provider: string) {
  if (!wrapper.find('.image-generation-connection').exists()) {
    if (!wrapper.find('.providerbar').exists()) await button(wrapper, '创作').trigger('click')
    await button(wrapper, '连接设置').trigger('click')
  }
  await button(wrapper, provider).trigger('click')
  await button(wrapper, '完成').trigger('click')
}

function naiSettingSelect(wrapper: ReturnType<typeof mount>, label: string) {
  const owner = wrapper.findAll('label').find((item) => item.text().includes(label))
  if (!owner) throw new Error(`Missing setting: ${label}`)
  return owner.get('select')
}

describe('ImageGenerationApp editing state', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    generate.mockResolvedValue({
      id: 'v5-result',
      provider: 'novelai',
      dataUrl: 'data:image/png;base64,cG5n',
      mimeType: 'image/png',
      extension: 'png',
      prompt: 'portrait',
      seed: 7,
      width: 832,
      height: 1216,
      parameters: {},
      manifest: {
        version: 1,
        provider: 'novelai',
        model: 'nai-diffusion-5-full',
        prompt: 'portrait',
        width: 832,
        height: 1216,
        outputFormat: 'png',
        createdAt: 1,
        parameters: {},
      },
      createdAt: 1,
    })
  })

  it('restores exact NAI quality mode, UC preset and transparent-background state', async () => {
    const wrapper = mount(ImageGenerationApp)
    await button(wrapper, '更多参数').trigger('click')
    await naiSettingSelect(wrapper, '质量预设').setValue('light')
    await naiSettingSelect(wrapper, '排除内容预设').setValue('heavy')
    await wrapper.get('input.switch').setValue(true)

    await selectProvider(wrapper, 'OpenAI')
    await selectProvider(wrapper, 'NovelAI')
    await button(wrapper, '更多参数').trigger('click')

    expect(naiSettingSelect(wrapper, '质量预设').element).toHaveProperty('value', 'light')
    expect(naiSettingSelect(wrapper, '排除内容预设').element).toHaveProperty('value', 'heavy')
    expect((wrapper.get('input.switch').element as HTMLInputElement).checked).toBe(true)

    wrapper.unmount()
    const reopened = mount(ImageGenerationApp)
    await button(reopened, '更多参数').trigger('click')
    expect(naiSettingSelect(reopened, '质量预设').element).toHaveProperty('value', 'light')
    expect(naiSettingSelect(reopened, '排除内容预设').element).toHaveProperty('value', 'heavy')
    expect((reopened.get('input.switch').element as HTMLInputElement).checked).toBe(true)
  })

  it('keeps preview metadata tied to the displayed result instead of later editor changes', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()

    expect(wrapper.get('.image-generation-result-meta').text()).toBe(
      'nai-diffusion-5-full · 832 × 1216',
    )
    await button(wrapper, '调整描述').trigger('click')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-4-5-full')
    expect(wrapper.get('.meta > span:first-child').text()).toBe('nai-diffusion-5-full · 832 × 1216')
    await button(wrapper, '更多参数').trigger('click')
    await naiSettingSelect(wrapper, '尺寸').setValue('1024x1024')
    await selectProvider(wrapper, 'OpenAI')
    expect(wrapper.get('.meta > span:first-child').text()).toBe('nai-diffusion-5-full · 832 × 1216')
    await button(wrapper, '看图').trigger('click')
    expect(button(wrapper, '复用描述与种子').exists()).toBe(true)
    await button(wrapper, '复用描述与种子').trigger('click')
    await button(wrapper, '更多参数').trigger('click')
    expect(naiSettingSelect(wrapper, '尺寸').element).toHaveProperty('value', '832x1216')
    const seed = wrapper.findAll('label').find((label) => label.text().startsWith('种子'))!
    expect(seed.get('input').element).toHaveProperty('value', '7')
  })

  it('does not invent a model for a legacy result without a manifest', async () => {
    generate.mockResolvedValueOnce({
      id: 'legacy',
      provider: 'novelai',
      dataUrl: 'data:image/png;base64,cG5n',
      prompt: 'portrait',
      width: 832,
      height: 1216,
      parameters: {},
      createdAt: 1,
    })
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    const original = wrapper.get('.image-generation-result-meta').text()
    await button(wrapper, '调整描述').trigger('click')
    expect.soft(original).not.toContain('nai-diffusion-5-full')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-4-5-full')
    expect(wrapper.get('.meta > span:first-child').text()).toBe(original)
  })

  it('uses OpenAI for compatible endpoints and preserves additional request fields', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '创作').trigger('click')
    await wrapper.get('[aria-label="画面描述"]').setValue('openai-compatible only')
    await button(wrapper, '更多参数').trigger('click')
    await wrapper.get('textarea[placeholder*="私有参数"]').setValue('{"vendor_option":true}')
    expect(wrapper.get('pre').text()).toContain('vendor_option')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate.mock.calls.at(-1)?.[1].prompt).toBe('openai-compatible only')
    expect(generate.mock.calls.at(-1)?.[1].additionalJson).toBe('{"vendor_option":true}')
  })

  it('does not leak OpenAI edit instructions, masks or references into NovelAI', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:reference')
        static revokeObjectURL = vi.fn()
      },
    )
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '参考 / 改图').trigger('click')
    const file = new File(['png'], 'reference.png', { type: 'image/png' })
    const upload = wrapper.get('input[type="file"]')
    Object.defineProperty(upload.element, 'files', { value: [file], configurable: true })
    await upload.trigger('change')
    await wrapper.get('[aria-label="修改指令"]').setValue('private edit')
    await wrapper.get('input.switch').setValue(true)
    const maskInput = wrapper.get('input[type="file"][accept="image/png"]')
    Object.defineProperty(maskInput.element, 'files', { value: [file], configurable: true })
    await maskInput.trigger('change')
    await selectProvider(wrapper, 'NovelAI')
    await button(wrapper, '创作').trigger('click')
    await wrapper.get('[aria-label="画面描述"]').setValue('novelai only')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]?.[1].prompt).toBe('novelai only')
    expect(generate.mock.calls[0]?.[1]).not.toHaveProperty('openAiInputImages')
    expect(generate.mock.calls[0]?.[1]).not.toHaveProperty('openAiEditInstruction')
    expect(generate.mock.calls[0]?.[1]).not.toHaveProperty('openAiMask')
  })

  it('gates hidden NAI text helpers after changing to a model without text support', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await wrapper.get('[aria-label="图片中的文字"]').setValue('HIDDEN TEXT')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-3')
    expect(wrapper.find('[aria-label="图片中的文字"]').exists()).toBe(false)
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect.soft(generate.mock.calls[0]?.[1].prompt).toBe('portrait')
    expect(generate.mock.calls[0]?.[1].novelAiQualityMode).toBe('standard')
  })

  it('excludes retained edit state when switching to an unconfirmed relay', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:reference')
        static revokeObjectURL = vi.fn()
      },
    )
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '参考 / 改图').trigger('click')
    const upload = wrapper.get('input[type="file"]')
    Object.defineProperty(upload.element, 'files', {
      value: [new File(['png'], 'original.png', { type: 'image/png' })],
      configurable: true,
    })
    await upload.trigger('change')
    await wrapper.get('[aria-label="修改指令"]').setValue('hidden edit')
    await wrapper.get('input.switch').setValue(true)
    const mask = wrapper.get('input[type="file"][accept="image/png"]')
    Object.defineProperty(mask.element, 'files', {
      value: [new File(['png'], 'mask.png', { type: 'image/png' })],
      configurable: true,
    })
    await mask.trigger('change')
    await button(wrapper, '连接设置').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://relay.example/v1/images/generations')
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.text()).not.toContain('参考 / 改图')
    expect(wrapper.find('[aria-label="修改指令"]').exists()).toBe(false)
    await wrapper.get('[aria-label="画面描述"]').setValue('text only')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({
      prompt: 'text only',
      openAiInputImages: [],
      openAiEditInstruction: '',
      openAiPreserve: {},
      openAiMask: undefined,
      parentImageId: undefined,
    })
  })

  it('skips model type selection for official endpoints and lets a relay alias choose its actual type', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '连接设置').trigger('click')
    expect(wrapper.find('[aria-label="实际模型类型"]').exists()).toBe(false)
    expect(wrapper.find('.image-generation-connection__capabilities').exists()).toBe(false)
    await wrapper.get('input[type="url"]').setValue('https://relay.example/v1/images/generations')
    await wrapper.get('[aria-label="模型 ID"]').setValue('vendor-alias')
    await wrapper.get('[aria-label="实际模型类型"]').setValue('gpt-image-2')
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.text()).toContain('参考 / 改图')
    await button(wrapper, '连接设置').trigger('click')
    expect(
      wrapper.get('.image-generation-connection__capabilities').attributes('open'),
    ).toBeUndefined()
    await button(wrapper, '保存连接').trigger('click')
    await flushPromises()
    expect(frontendWorkshopImageGenerationService.saveConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'vendor-alias',
        relayCapabilities: expect.objectContaining({ modelProfile: 'gpt-image-2' }),
      }),
    )
    await wrapper.get('input[type="url"]').setValue('https://another.example/v1/images/generations')
    expect(wrapper.get('[aria-label="实际模型类型"]').element).toHaveProperty('value', '')
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.text()).not.toContain('参考 / 改图')
  })

  it('keeps the chosen model type after fetching models and respects explicit unavailable edits', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '连接设置').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://relay.example/v1/images/generations')
    await wrapper.get('[aria-label="模型 ID"]').setValue('vendor-alias')
    await wrapper.get('[aria-label="实际模型类型"]').setValue('gpt-image-2')
    vi.mocked(frontendWorkshopImageGenerationService.listModels).mockResolvedValueOnce({
      source: 'remote',
      message: 'loaded',
      options: [
        { id: 'vendor-alias', name: 'alias', capabilities: { imageEdit: false, imageInput: true } },
      ],
    })
    await button(wrapper, '拉取模型').trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="实际模型类型"]').element).toHaveProperty(
      'value',
      'gpt-image-2',
    )
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.text()).not.toContain('参考 / 改图')
  })

  it('projects only six grid characters for V4 while retaining the V5 draft', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('group portrait')
    await button(wrapper, '角色').trigger('click')
    for (let i = 0; i < 7; i++) await button(wrapper, '添加角色').trigger('click')
    await wrapper.get('[aria-label="角色 1 Prompt"]').setValue('red hair')
    await wrapper.get('.image-generation-entry input[type="checkbox"]').setValue(true)
    const coordinates = wrapper.findAll('.image-generation-entry input[type="number"]')
    await coordinates[0]!.setValue('0.38')
    await coordinates[1]!.setValue('0.68')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-4-5-full')
    expect(wrapper.findAll('.image-generation-entry')).toHaveLength(6)
    expect(wrapper.findAll('.image-generation-entry input[type="number"]')).toHaveLength(0)
    expect(
      wrapper
        .findAll('.image-generation-entry select')
        .map((s) => (s.element as HTMLSelectElement).value),
    ).toEqual(['0.3', '0.7'])
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate.mock.calls.at(-1)?.[1].novelAiCharacters).toHaveLength(6)
    expect(generate.mock.calls.at(-1)?.[1].novelAiCharacters[0]).toMatchObject({
      position: { x: 0.3, y: 0.7 },
    })
    await button(wrapper, '调整描述').trigger('click')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-5-full')
    await button(wrapper, '角色').trigger('click')
    expect(wrapper.findAll('.image-generation-entry')).toHaveLength(7)
    expect(
      wrapper
        .findAll('.image-generation-entry input[type="number"]')
        .map((s) => (s.element as HTMLInputElement).value),
    ).toEqual(['0.38', '0.68'])
  })

  it('hides SMEA for DDIM and excludes retained SMEA switches from its request', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await wrapper.get('[aria-label="模型列表"]').setValue('nai-diffusion-3')
    await button(wrapper, '更多参数').trigger('click')
    expect(wrapper.text()).toContain('SMEA')
    const switches = wrapper.findAll('label.check input[type="checkbox"]')
    await switches[0]!.setValue(true)
    await switches[1]!.setValue(true)
    await naiSettingSelect(wrapper, 'Sampler').setValue('ddim')
    expect(wrapper.text()).not.toContain('SMEA')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({
      novelAiSampler: 'ddim',
      novelAiSmea: false,
      novelAiSmeaDyn: false,
    })
  })

  it('shows one actionable error and no generation control for an official text model', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '连接设置').trigger('click')
    await wrapper.get('[aria-label="模型 ID"]').setValue('gpt-5')
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('不支持 Images')
    expect(wrapper.findAll('button').some((b) => b.text() === '生成图片')).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('does not offer result editing when only edits, without image input, is confirmed', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '连接设置').trigger('click')
    await wrapper.get('input[type="url"]').setValue('https://relay.example/v1/images/generations')
    await wrapper
      .findAll('.cap')
      .find((c) => c.find('span').text() === 'edits')!
      .get('input')
      .setValue(true)
    await button(wrapper, '完成').trigger('click')
    expect(wrapper.text()).not.toContain('参考 / 改图')
    generate.mockResolvedValueOnce({
      id: 'relay-result',
      provider: 'openai',
      dataUrl: 'data:image/png;base64,cG5n',
      mimeType: 'image/png',
      extension: 'png',
      prompt: 'portrait',
      width: 1024,
      height: 1024,
      parameters: {},
      createdAt: 1,
    })
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('修改这张图')
  })

  it('offers a mask only when the first reference is PNG', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:reference')
        static revokeObjectURL = vi.fn()
      },
    )
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '参考 / 改图').trigger('click')
    expect(wrapper.find('input[accept="image/png"]').exists()).toBe(false)
    const upload = wrapper.get('input[type="file"]')
    Object.defineProperty(upload.element, 'files', {
      value: [new File(['jpeg'], 'reference.jpg', { type: 'image/jpeg' })],
      configurable: true,
    })
    await upload.trigger('change')
    expect(wrapper.find('input[accept="image/png"]').exists()).toBe(false)
    await button(wrapper, '移除图片').trigger('click')
    Object.defineProperty(upload.element, 'files', {
      value: [new File(['png'], 'reference.png', { type: 'image/png' })],
      configurable: true,
    })
    await upload.trigger('change')
    expect(wrapper.find('input[accept="image/png"]').exists()).toBe(true)
  })

  it('hides compression for PNG and replaces JPEG when transparent output is selected', async () => {
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await button(wrapper, '更多参数').trigger('click')
    const compression = () => wrapper.findAll('label').find((l) => l.text().startsWith('压缩'))
    expect(compression()).toBeUndefined()
    await naiSettingSelect(wrapper, '格式').setValue('jpeg')
    expect(compression()?.find('input').exists()).toBe(true)
    await naiSettingSelect(wrapper, '背景').setValue('transparent')
    expect(naiSettingSelect(wrapper, '格式').element).toHaveProperty('value', 'png')
    expect(wrapper.find('option[value="jpeg"]').exists()).toBe(false)
    expect(compression()).toBeUndefined()
  })

  it('restores NAI characters and OpenAI structured helpers via template and remount', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await wrapper.get('[aria-label="图片中的文字"]').setValue('NAI text')
    await button(wrapper, '角色').trigger('click')
    await button(wrapper, '添加角色').trigger('click')
    await wrapper.get('[aria-label="角色 1 Prompt"]').setValue('red hair')
    await wrapper.get('[aria-label="角色 1 Negative"]').setValue('hat')
    await wrapper.get('.image-generation-entry input[type="checkbox"]').setValue(true)
    const coords = wrapper.findAll('.image-generation-entry input[type="number"]')
    await coords[0]!.setValue('0.35')
    await coords[1]!.setValue('0.65')
    await button(wrapper, '创作').trigger('click')
    await wrapper.get('[aria-label="模板名称"]').setValue('NAI complete')
    await wrapper.get('form').trigger('submit')
    await selectProvider(wrapper, 'OpenAI')
    await wrapper.get('[aria-label="图片中的文字"]').setValue('GPT text')
    for (const label of ['人物', '场景', '构图', '风格'])
      await wrapper.get(`[aria-label="${label}"]`).setValue(label + ' value')
    wrapper.unmount()
    const reopened = mount(ImageGenerationApp)
    expect(reopened.get('[aria-label="图片中的文字"]').element).toHaveProperty('value', 'GPT text')
    for (const label of ['人物', '场景', '构图', '风格'])
      expect(reopened.get(`[aria-label="${label}"]`).element).toHaveProperty(
        'value',
        label + ' value',
      )
    await button(reopened, '套用').trigger('click')
    expect(reopened.get('[aria-label="图片中的文字"]').element).toHaveProperty('value', 'NAI text')
    await button(reopened, '角色').trigger('click')
    expect(reopened.get('[aria-label="角色 1 Prompt"]').element).toHaveProperty('value', 'red hair')
    expect(reopened.get('[aria-label="角色 1 Negative"]').element).toHaveProperty('value', 'hat')
    expect(reopened.get('.image-generation-entry input[type="checkbox"]').element).toHaveProperty(
      'checked',
      true,
    )
    expect(
      reopened
        .findAll('.image-generation-entry input[type="number"]')
        .map((input) => (input.element as HTMLInputElement).value),
    ).toEqual(['0.35', '0.65'])
  })

  it('debounces for 300ms but flushes the latest input on provider switch and unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const save = vi.spyOn(frontendWorkshopImageDraftService, 'saveDraft')
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('first')
    await vi.advanceTimersByTimeAsync(299)
    expect(save).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="画面描述"]').setValue('last NAI')
    await selectProvider(wrapper, 'OpenAI')
    expect(frontendWorkshopImageDraftService.loadDraft('novelai')?.prompt).toBe('last NAI')
    await wrapper.get('[aria-label="画面描述"]').setValue('last GPT')
    wrapper.unmount()
    expect(frontendWorkshopImageDraftService.loadDraft('openai')?.prompt).toBe('last GPT')
    const count = save.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(count)
    const reopened = mount(ImageGenerationApp)
    expect(reopened.get('[aria-label="画面描述"]').element).toHaveProperty('value', 'last GPT')
    await reopened.get('[aria-label="画面描述"]').setValue('debounced')
    await vi.advanceTimersByTimeAsync(299)
    expect(save).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(count + 1)
    expect(frontendWorkshopImageDraftService.loadDraft('openai')?.prompt).toBe('debounced')
  })

  it('saves and overwrites templates from current state before debounce fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('latest template')
    await wrapper.get('[aria-label="模板名称"]').setValue('instant')
    await wrapper.get('form').trigger('submit')
    expect(frontendWorkshopImageDraftService.listTemplates()[0]?.draft.prompt).toBe(
      'latest template',
    )
    await wrapper.get('[aria-label="画面描述"]').setValue('latest overwrite')
    await button(wrapper, '覆盖').trigger('click')
    expect(frontendWorkshopImageDraftService.listTemplates()[0]?.draft.prompt).toBe(
      'latest overwrite',
    )
  })

  it('keeps a saved square NovelAI size when returning from another provider', async () => {
    const wrapper = mount(ImageGenerationApp)
    await button(wrapper, '更多参数').trigger('click')
    await naiSettingSelect(wrapper, '尺寸').setValue('1024x1024')
    await selectProvider(wrapper, 'OpenAI')
    expect(frontendWorkshopImageDraftService.loadDraft('novelai')).toMatchObject({
      width: 1024,
      height: 1024,
    })
    await selectProvider(wrapper, 'NovelAI')
    await button(wrapper, '更多参数').trigger('click')
    expect(naiSettingSelect(wrapper, '尺寸').element).toHaveProperty('value', '1024x1024')
  })

  it('continues editing an OpenAI result after switching the editor to NovelAI', async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:result')
        static revokeObjectURL = vi.fn()
      },
    )
    const image: FrontendWorkshopGeneratedImage = {
      id: 'openai-result',
      provider: 'openai',
      dataUrl: 'data:image/png;base64,cG5n',
      mimeType: 'image/png',
      extension: 'png',
      prompt: 'GPT portrait',
      width: 1024,
      height: 1024,
      parameters: {},
      createdAt: 1,
    }
    generate.mockResolvedValueOnce(image)
    const wrapper = mount(ImageGenerationApp)
    await selectProvider(wrapper, 'OpenAI')
    await wrapper.get('[aria-label="画面描述"]').setValue('GPT portrait')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    await selectProvider(wrapper, 'NovelAI')
    await button(wrapper, '看图').trigger('click')
    expect(button(wrapper, '复用描述').exists()).toBe(true)
    await button(wrapper, '修改这张图').trigger('click')
    await flushPromises()
    expect(toBlob).toHaveBeenCalledWith(image)
    expect(saveGenerated).toHaveBeenCalledWith(image)
    await wrapper.get('[aria-label="修改指令"]').setValue('white coat')
    await button(wrapper, '生成图片').trigger('click')
    await flushPromises()
    expect(generate.mock.calls.at(-1)?.[0].provider).toBe('openai')
    expect(generate.mock.calls.at(-1)?.[1]).toMatchObject({
      parentImageId: 'saved-image',
      openAiInputImages: [{ role: 'reference' }],
      openAiEditInstruction: 'white coat',
    })
  })
})
