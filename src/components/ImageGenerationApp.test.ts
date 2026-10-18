// SRL-PUBLIC-SYNC: BEGIN REPLACE id=image-generation-test-contract
/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frontendWorkshopImageDraftService } from '../services/FrontendWorkshopImageDraftService'
import { NOVELAI_MODELS } from '../services/FrontendWorkshopImageGenerationService'
const { generate, album, hosting, confirmAction, saveConfiguration } = vi.hoisted(() => ({
  confirmAction: vi.fn(async () => true),
  saveConfiguration: vi.fn(async (value) => value),
  generate: vi.fn(),
  album: { saveGenerated: vi.fn(), getOriginalBlob: vi.fn(), setHostedUrl: vi.fn() },
  hosting: {
    getSelfHostedConfiguration: vi.fn((): { origin: string } | null => null),
    uploadBlobShared: vi.fn(),
    uploadBlobSelfHosted: vi.fn(),
  },
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
      apiKey: 'ui-test-key',
      endpoint:
        provider === 'novelai'
          ? 'https://image.novelai.net/ai/generate-image'
          : 'https://api.openai.com/v1/images/generations',
    }),
    generate,
    toBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    saveConfiguration,
    listModels: vi.fn(async () => ({ options: [], message: '0 models' })),
  },
}))
vi.mock('../core/ImageAlbumContainer', () => ({
  generatedImageAlbumService: album,
  frontendWorkshopImageHostingService: hosting,
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction }))
vi.mock('../core/NativeFileExport', () => ({
  isNativeFileExportAvailable: () => false,
  saveBlobToNativeDestination: vi.fn(),
}))
import ImageGenerationApp from './ImageGenerationApp.vue'
enableAutoUnmount(afterEach)
const result = {
  id: 'result-one',
  provider: 'novelai',
  dataUrl: 'data:image/png;base64,cG5n',
  prompt: 'portrait',
  seed: 7,
  width: 832,
  height: 1216,
  parameters: {},
  createdAt: 1,
}
function clickTab(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper
    .findAll('[aria-label="供应商功能"] button')
    .find((b) => b.text() === label)!
    .trigger('click')
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  generate.mockReset()
  saveConfiguration.mockReset().mockImplementation(async (value) => value)
  generate.mockResolvedValue(result)
  album.saveGenerated.mockResolvedValue({ id: result.id })
  album.getOriginalBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  album.setHostedUrl.mockResolvedValue({
    id: result.id,
    hostedUrl: 'https://img.example/result.png',
  })
  hosting.uploadBlobShared.mockResolvedValue({ url: 'https://img.example/result.png' })
})

describe('ImageGenerationApp', () => {
  const click = (wrapper: ReturnType<typeof mount>, label: string) => {
    const control = wrapper.findAll('button').find((button) => button.text() === label)
    if (!control) throw new Error(`Missing button: ${label}`)
    return control.trigger('click')
  }
  const connection = async (wrapper: ReturnType<typeof mount>) => {
    if (!wrapper.find('.image-generation-connection').exists()) await click(wrapper, '连接设置')
  }
  const provider = async (wrapper: ReturnType<typeof mount>, label = 'OpenAI') => {
    await connection(wrapper)
    await click(wrapper, label)
    await click(wrapper, '完成')
  }
  const produce = async (wrapper: ReturnType<typeof mount>) => {
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await click(wrapper, '生成图片')
    await flushPromises()
  }
  const expectSingleError = (wrapper: ReturnType<typeof mount>, text: string) => {
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1)
    expect(wrapper.get('[role="alert"]').text()).toContain(text)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  }

  it('keeps one scrolling workspace, compact size choices and folded optional helpers', () => {
    const wrapper = mount(ImageGenerationApp)
    expect(wrapper.get('.image-generation-app').attributes()).toMatchObject({
      role: 'dialog',
      'aria-modal': 'true',
    })
    expect(wrapper.get('.image-generation-controls').element.tagName).toBe('FIELDSET')
    expect(wrapper.get('[aria-label="画面尺寸"]').findAll('button')).toHaveLength(3)
    expect(wrapper.find('.mobile-preview').exists()).toBe(false)
    expect(wrapper.findAll('details').every((d) => !(d.element as HTMLDetailsElement).open)).toBe(
      true,
    )
    expect(wrapper.findAll('[aria-label="供应商功能"] button').map((b) => b.text())).toEqual([
      '创作',
      '角色',
      '更多参数',
    ])
    expect(wrapper.text()).not.toContain('检查 Prompt')
  })
  it('preserves provider drafts and session keys without serializing credentials', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('NAI draft')
    await connection(wrapper)
    await wrapper.get('input[type="password"]').setValue('nai-session-key')
    await click(wrapper, 'OpenAI')
    await click(wrapper, '完成')
    await wrapper.get('[aria-label="画面描述"]').setValue('GPT draft')
    await provider(wrapper, 'NovelAI')
    expect(wrapper.get('[aria-label="画面描述"]').element).toHaveProperty('value', 'NAI draft')
    await connection(wrapper)
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', 'nai-session-key')
    wrapper.unmount()
    const reopened = mount(ImageGenerationApp)
    expect(reopened.get('[aria-label="画面描述"]').element).toHaveProperty('value', 'NAI draft')
    expect(frontendWorkshopImageDraftService.loadDraft('openai')?.prompt).toBe('GPT draft')
    expect(JSON.stringify(Object.values(localStorage))).not.toContain('session-key')
  })
  it('keeps template apply, overwrite and confirmed deletion on the existing owner', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait template')
    await wrapper.get('[aria-label="模板名称"]').setValue('portrait')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('[aria-label="画面描述"]').setValue('temporary')
    await click(wrapper, '套用')
    expect(wrapper.get('[aria-label="画面描述"]').element).toHaveProperty(
      'value',
      'portrait template',
    )
    await wrapper.get('[aria-label="画面描述"]').setValue('overwritten')
    await click(wrapper, '覆盖')
    expect(frontendWorkshopImageDraftService.listTemplates()[0]?.draft.prompt).toBe('overwritten')
    expect(JSON.stringify(frontendWorkshopImageDraftService.listTemplates())).not.toContain(
      'ui-test-key',
    )
    confirmAction.mockResolvedValueOnce(false)
    await click(wrapper, '删除')
    await flushPromises()
    expect(frontendWorkshopImageDraftService.listTemplates()).toHaveLength(1)
    await click(wrapper, '删除')
    await flushPromises()
    expect(frontendWorkshopImageDraftService.listTemplates()).toHaveLength(0)
  })
  it('opens the image after generation and saves it directly, preserving per-candidate state', async () => {
    generate
      .mockResolvedValueOnce({ ...result, id: 'first' })
      .mockResolvedValueOnce({ ...result, id: 'second' })
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    expect(wrapper.find('.image-generation-result img').exists()).toBe(true)
    expect(wrapper.find('button').exists()).toBe(true)
    await click(wrapper, '保存到生图相册')
    await flushPromises()
    expect(album.saveGenerated).toHaveBeenCalledTimes(1)
    expect(
      wrapper
        .findAll('button')
        .find((b) => b.text() === '已保存到生图相册')
        ?.attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.findAll('button').some((b) => b.text() === '保存到手机相册')).toBe(false)
    await click(wrapper, '调整描述')
    await click(wrapper, '生成图片')
    await flushPromises()
    expect(wrapper.get('[aria-label="生成候选"]').text()).toContain('2 / 2')
    await wrapper.get('[aria-label="上一张生成结果"]').trigger('click')
    expect(wrapper.findAll('button').some((b) => b.text() === '已保存到生图相册')).toBe(true)
    await wrapper.get('[aria-label="下一张生成结果"]').trigger('click')
    expect(
      wrapper
        .findAll('button')
        .find((b) => b.text() === '保存到生图相册')
        ?.attributes('disabled'),
    ).toBeUndefined()
  })
  it('preserves explicit seeds but does not silently lock a random seed after generation', async () => {
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    expect(generate.mock.calls[0]?.[1].seed).toBeUndefined()
    await click(wrapper, '调整描述')
    await click(wrapper, '生成图片')
    await flushPromises()
    expect(generate.mock.calls[1]?.[1].seed).toBeUndefined()
    await click(wrapper, '复用描述与种子')
    await click(wrapper, '生成图片')
    await flushPromises()
    expect(generate.mock.calls[2]?.[1].seed).toBe(7)
    await click(wrapper, '再生成一张（随机种子）')
    await flushPromises()
    expect(generate.mock.calls[3]?.[1].seed).toBeUndefined()
  })
  it('keeps manual models, endpoints and the protected/session credential preference', async () => {
    const wrapper = mount(ImageGenerationApp)
    expect(wrapper.get('[aria-label="模型列表"]').findAll('option')).toHaveLength(
      NOVELAI_MODELS.length,
    )
    await connection(wrapper)
    await click(wrapper, 'OpenAI')
    await wrapper.get('input[type="url"]').setValue('https://relay.test/v1/images/generations')
    await wrapper.get('input[type="password"]').setValue('relay-key')
    await wrapper.get('.image-generation-connection input[type="text"]').setValue('future-model')
    await wrapper.get('[aria-label="密钥保存方式"]').setValue('session')
    await click(wrapper, '保存连接')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('实际可用性以生成结果为准')
    expect(saveConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'future-model',
        apiKey: 'relay-key',
        credentialPersistence: 'session',
      }),
    )
    await click(wrapper, '恢复默认地址')
    expect(wrapper.get('input[type="url"]').element).toHaveProperty(
      'value',
      'https://api.openai.com/v1/images/generations',
    )
  })
  it.each([
    ['input[type="url"]', 'invalid', '地址无效'],
    ['input[type="url"]', 'http://relay.test', 'HTTPS'],
    ['input[type="password"]', '', 'API 密钥'],
    ['.image-generation-connection input[type="text"]', '', '模型 ID'],
  ])(
    'reports one configuration failure and sends no request: %s %s',
    async (selector, value, message) => {
      const wrapper = mount(ImageGenerationApp)
      await connection(wrapper)
      await wrapper.get(selector).setValue(value)
      await click(wrapper, '保存连接')
      await flushPromises()
      expectSingleError(wrapper, message)
      expect(saveConfiguration).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
    },
  )
  it('shows a missing prompt error instead of a disabled button with no explanation', async () => {
    const wrapper = mount(ImageGenerationApp)
    await click(wrapper, '生成图片')
    expectSingleError(wrapper, '填写画面描述')
    expect(generate).not.toHaveBeenCalled()
  })
  it('sends NAI characters and keeps unavailable reference features folded outside the workflow', async () => {
    const wrapper = mount(ImageGenerationApp)
    await clickTab(wrapper, '角色')
    await click(wrapper, '添加角色')
    await wrapper.get('.image-generation-entry textarea').setValue('red hair')
    await clickTab(wrapper, '更多参数')
    expect(wrapper.findAll('details').every((d) => !(d.element as HTMLDetailsElement).open)).toBe(
      true,
    )
    expect(wrapper.text()).toContain('尚未接通')
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    await clickTab(wrapper, '创作')
    await produce(wrapper)
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      novelAiCharacters: [{ prompt: 'red hair' }],
    })
  })
  it('does not expose diffusion controls for GPT, and has one background control', async () => {
    const wrapper = mount(ImageGenerationApp)
    await provider(wrapper)
    await clickTab(wrapper, '更多参数')
    expect(wrapper.text()).not.toMatch(/Seed|Sampler|Steps|Guidance/)
    await wrapper
      .findAll('select')
      .find((s) => s.find('option[value="transparent"]').exists())!
      .setValue('transparent')
    expect(wrapper.find('option[value="jpeg"]').exists()).toBe(false)
    expect(wrapper.findAll('input.switch')).toHaveLength(0)
    await clickTab(wrapper, '参考 / 改图')
    expect(wrapper.text()).toContain('先添加上方原图')
    expect(wrapper.findAll('details').every((d) => !(d.element as HTMLDetailsElement).open)).toBe(
      true,
    )
  })
  it('reports one malformed JSON error in the shared feedback region, even on submit', async () => {
    const wrapper = mount(ImageGenerationApp)
    await provider(wrapper)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await clickTab(wrapper, '更多参数')
    await wrapper.get('textarea[placeholder*="私有参数"]').setValue('{invalid')
    expectSingleError(wrapper, '附加 JSON 解析失败')
    await click(wrapper, '生成图片')
    expectSingleError(wrapper, '附加 JSON 解析失败')
    expect(generate).not.toHaveBeenCalled()
    await wrapper.get('textarea[placeholder*="私有参数"]').setValue('{}')
    await click(wrapper, '生成图片')
    await flushPromises()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('rejects editing without an original in one error and does not send a request', async () => {
    const wrapper = mount(ImageGenerationApp)
    await provider(wrapper)
    await clickTab(wrapper, '参考 / 改图')
    await wrapper.get('[aria-label="修改指令"]').setValue('change outfit')
    await click(wrapper, '生成图片')
    expectSingleError(wrapper, '至少一张输入图片')
    expect(generate).not.toHaveBeenCalled()
  })
  it('drops late results after cancellation and keeps drafts intact', async () => {
    let resolve!: (value: typeof result) => void
    generate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await click(wrapper, '生成图片')
    expect(wrapper.get('[aria-label="模型列表"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    await click(wrapper, '取消等待')
    expect(generate.mock.calls[0]?.[2].signal.aborted).toBe(true)
    resolve(result)
    await flushPromises()
    expect(wrapper.find('.image-generation-result').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('已停止等待')
    expect(wrapper.get('[aria-label="画面描述"]').element).toHaveProperty('value', 'portrait')
    expect(saveConfiguration).not.toHaveBeenCalled()
  })
  it('discards success after unmount and never saves the connection from a late result', async () => {
    let resolve!: (value: typeof result) => void
    generate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('portrait')
    await click(wrapper, '生成图片')
    wrapper.unmount()
    resolve(result)
    await flushPromises()
    expect(saveConfiguration).not.toHaveBeenCalled()
  })
  it('reports generation failures once, redacts keys and does not retain old success', async () => {
    const wrapper = mount(ImageGenerationApp)
    await connection(wrapper)
    await click(wrapper, '保存连接')
    await flushPromises()
    await click(wrapper, '完成')
    generate.mockRejectedValueOnce(new Error('HTTP 401 ui-test-key'))
    await produce(wrapper)
    expectSingleError(wrapper, '生成失败')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('ui-test-key')
    expect(wrapper.get('[aria-label="画面描述"]').element).toHaveProperty('value', 'portrait')
  })
  it('reports save failures once and retries only saving, without regenerating', async () => {
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    album.saveGenerated.mockRejectedValueOnce(new Error('storage full'))
    await click(wrapper, '保存到生图相册')
    await flushPromises()
    expectSingleError(wrapper, '保存到生图相册失败：storage full')
    await click(wrapper, '保存到生图相册')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(generate).toHaveBeenCalledTimes(1)
  })
  it('prevents duplicate saves while a save is pending', async () => {
    let resolve!: (value: { id: string }) => void
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    album.saveGenerated.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await click(wrapper, '保存到生图相册')
    await click(wrapper, '处理中…')
    expect(album.saveGenerated).toHaveBeenCalledTimes(1)
    resolve({ id: 'stored' })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('已保存')
  })
  it('does not upload when local persistence fails and reports exactly one error', async () => {
    hosting.getSelfHostedConfiguration.mockReturnValue({ origin: 'https://img.example/upload' })
    hosting.uploadBlobSelfHosted.mockResolvedValue({ url: 'https://img.example/result.png' })
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    await click(wrapper, '上传图床获取直链')
    album.saveGenerated.mockRejectedValueOnce(new Error('storage full'))
    await click(wrapper, '生成直链')
    await flushPromises()
    expectSingleError(wrapper, '获取图片直链失败：storage full')
    expect(hosting.uploadBlobSelfHosted).not.toHaveBeenCalled()
  })
  it('stores the hosted URL only after original storage and remote upload succeed', async () => {
    hosting.getSelfHostedConfiguration.mockReturnValue({ origin: 'https://img.example/upload' })
    hosting.uploadBlobSelfHosted.mockResolvedValue({ url: 'https://img.example/result.png' })
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    await click(wrapper, '上传图床获取直链')
    await click(wrapper, '生成直链')
    await flushPromises()
    expect(album.setHostedUrl).toHaveBeenCalledWith(
      result.id,
      { url: 'https://img.example/result.png' },
      'self-hosted',
    )
    expect(wrapper.get('input[readonly]').attributes('value')).toBe(
      'https://img.example/result.png',
    )
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)
  })
  it('reports a failed result image load through the same single error region', async () => {
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    await wrapper.get('.image-generation-result img').trigger('error')
    expectSingleError(wrapper, '预览失败')
  })
  it('keeps each candidate name and category independent when switching and saving', async () => {
    const wrapper = mount(ImageGenerationApp)
    await produce(wrapper)
    await wrapper.get('input[placeholder="留空使用画面描述"]').setValue('first name')
    await wrapper.get('input[placeholder="例如：背景、立绘"]').setValue('first category')
    await click(wrapper, '调整描述')
    await click(wrapper, '生成图片')
    await flushPromises()
    await wrapper.get('input[placeholder="留空使用画面描述"]').setValue('second name')
    await wrapper.get('[aria-label="上一张生成结果"]').trigger('click')
    expect(wrapper.get('input[placeholder="留空使用画面描述"]').element).toHaveProperty(
      'value',
      'first name',
    )
    await click(wrapper, '保存到生图相册')
    await flushPromises()
    expect(album.saveGenerated).toHaveBeenLastCalledWith(expect.anything(), {
      name: 'first name',
      category: 'first category',
    })
    await wrapper.get('[aria-label="下一张生成结果"]').trigger('click')
    expect(wrapper.get('input[placeholder="留空使用画面描述"]').element).toHaveProperty(
      'value',
      'second name',
    )
  })
  it('does not claim a template was saved when storage rejects the write', async () => {
    const wrapper = mount(ImageGenerationApp)
    await wrapper.get('[aria-label="画面描述"]').setValue('keep this draft')
    await wrapper.get('[aria-label="模板名称"]').setValue('portrait')
    const write = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key.includes('templates')) throw new DOMException('full', 'QuotaExceededError')
      return write.call(this, key, value)
    })
    try {
      await wrapper.get('form').trigger('submit')
      expectSingleError(wrapper, '模板未能保存到本机')
      expect(wrapper.get('[aria-label="画面描述"]').element).toHaveProperty(
        'value',
        'keep this draft',
      )
    } finally {
      spy.mockRestore()
    }
  })
})
// SRL-PUBLIC-SYNC: END REPLACE id=image-generation-test-contract
