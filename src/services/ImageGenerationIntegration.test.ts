import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FrontendWorkshopImageGenerationService,
  buildOpenAiImageRequest,
  previewOpenAiImageRequest,
  buildNovelAiPayload,
  parseImageAdditionalJson,
} from './FrontendWorkshopImageGenerationService'
import {
  getImageGenerationCapabilities,
  getNovelAiModelFamily,
} from './ImageGenerationCapabilities'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
function setup() {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png }] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  const service = new FrontendWorkshopImageGenerationService(fetcher)
  const config = { ...service.defaultConfig('openai'), apiKey: 'test-image-secret' }
  return { service, config, fetcher }
}
const naiSettings = {
  prompt: 'portrait',
  negativePrompt: 'blur',
  width: 832,
  height: 1216,
  seed: 7,
  sampler: 'k_euler_ancestral' as const,
  steps: 23,
  scale: 5,
  qualityToggle: true,
  smea: true,
  smeaDyn: true,
}

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() }))

describe('image generation integration contracts', () => {
  it.each(['openai', 'novelai'] as const)(
    'preserves the explicit %s error inside an HTTP 200 response without exposing the key',
    async (provider) => {
      const { service, fetcher } = setup()
      const config = { ...service.defaultConfig(provider), apiKey: 'never-echo-secret' }
      fetcher.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: `Unsupported model parameter; token ${config.apiKey}` },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      await expect(service.generate(config, { prompt: 'portrait' })).rejects.toSatisfy(
        (error: Error) => {
          expect(error.message).toContain('Unsupported model parameter')
          expect(JSON.stringify(error)).not.toContain(config.apiKey)
          return true
        },
      )
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
  it.each(['nai-diffusion-5-full', 'nai-diffusion-5-curated'])(
    'routes %s to modern prompts, including negative character captions and coordinates',
    (model) => {
      expect(getNovelAiModelFamily(model)).toBe('v5')
      const payload = buildNovelAiPayload(model, {
        ...naiSettings,
        novelAiQualityMode: 'off',
        novelAiTransparentBackground: true,
        novelAiCharacters: [
          { prompt: 'red hair', negativePrompt: 'hat', position: { x: 0.25, y: 0.6 } },
        ],
      })
      expect(payload.input).toBe('portrait, transparent background')
      expect(payload.parameters).toMatchObject({
        params_version: 4,
        noise_schedule: 'karras',
        use_coords: true,
        v4_prompt: {
          caption: {
            base_caption: payload.input,
            char_captions: [{ char_caption: 'red hair', centers: [{ x: 0.25, y: 0.6 }] }],
          },
        },
        v4_negative_prompt: { caption: { char_captions: [{ char_caption: 'hat' }] } },
      })
      for (const key of ['prompt', 'sm', 'sm_dyn'])
        expect(payload.parameters).not.toHaveProperty(key)
    },
  )
  it('keeps model families distinct and rejects unknown models instead of silently using V3', () => {
    expect(getNovelAiModelFamily('nai-diffusion-3')).toBe('v3')
    expect(getNovelAiModelFamily('nai-diffusion-4-full')).toBe('v4')
    expect(getNovelAiModelFamily('nai-diffusion-4-5-full')).toBe('v4.5')
    expect(() => buildNovelAiPayload('nai-diffusion-6-full', naiSettings)).toThrow('不能回退')
  })
  it.each(['nai-diffusion-5-full', 'nai-diffusion-5-curated'])(
    'sends the production transparent tag and hint for %s only when enabled',
    async (model) => {
      const { service, fetcher } = setup()
      fetcher.mockImplementation(
        async () =>
          new Response(JSON.stringify({ images: [{ image: png }] }), {
            headers: { 'Content-Type': 'application/json' },
          }),
      )
      const config = { ...service.defaultConfig('novelai'), model, apiKey: 'test-key' }
      for (const enabled of [true, false, undefined]) {
        await service.generate(config, {
          prompt: 'portrait',
          negativePrompt: 'blur',
          novelAiQualityMode: 'off',
          novelAiTransparentBackground: enabled,
          novelAiCharacters: [{ prompt: 'red hair', negativePrompt: 'hat' }],
        })
        const [endpoint, init] = fetcher.mock.calls.at(-1)!
        expect(endpoint).toBe('https://image.novelai.net/ai/generate-image')
        const payload = JSON.parse(String(init?.body))
        expect(payload.input).toBe(enabled ? 'portrait, transparent background' : 'portrait')
        expect(payload.parameters.v4_prompt.caption).toMatchObject({
          base_caption: payload.input,
          char_captions: [{ char_caption: 'red hair' }],
        })
        expect(payload.parameters.v4_negative_prompt.caption).toMatchObject({
          base_caption: 'blur',
          char_captions: [{ char_caption: 'hat' }],
        })
        if (enabled) expect(payload.parameters.tag_hint_transparent_background).toBe(true)
        else expect(payload.parameters).not.toHaveProperty('tag_hint_transparent_background')
        expect(payload.parameters).not.toHaveProperty('transparent_background')
      }
    },
  )
  it.each(['nai-diffusion-3', 'nai-diffusion-4-full', 'nai-diffusion-4-5-full'])(
    'rejects transparency for %s before sending a request',
    async (model) => {
      const { service, fetcher } = setup()
      await expect(
        service.generate(
          { ...service.defaultConfig('novelai'), model, apiKey: 'test-key' },
          { prompt: 'portrait', novelAiTransparentBackground: true },
        ),
      ).rejects.toThrow('当前模型不支持透明背景')
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
  it('gates references, character limits, V4 coordinates and quality modes before any paid request', () => {
    const v5 = getImageGenerationCapabilities('novelai', 'nai-diffusion-5-full')
    expect(v5).toMatchObject({
      vibeTransfer: 'supported',
      preciseReference: 'unsupported',
      maxCharacters: 22,
      multilingualPrompt: 'supported',
      smea: 'unsupported',
    })
    expect(() =>
      buildNovelAiPayload('nai-diffusion-5-full', {
        ...naiSettings,
        novelAiVibes: [{ image: 'data', strength: 1, informationExtracted: 1 }],
      }),
    ).toThrow('官方支持，但项目当前尚未接通')
    expect(
      getImageGenerationCapabilities('novelai', 'nai-diffusion-4-5-full').preciseReference,
    ).toBe('supported')
    expect(() =>
      buildNovelAiPayload('nai-diffusion-5-full', {
        ...naiSettings,
        novelAiCharacters: Array.from({ length: 23 }, () => ({ prompt: 'person' })),
      }),
    ).toThrow('22 个角色')
    expect(() =>
      buildNovelAiPayload('nai-diffusion-4-full', {
        ...naiSettings,
        novelAiCharacters: Array.from({ length: 7 }, () => ({ prompt: 'person' })),
      }),
    ).toThrow('6 个角色')
    expect(() =>
      buildNovelAiPayload('nai-diffusion-4-full', {
        ...naiSettings,
        novelAiCharacters: [{ prompt: 'person', position: { x: 0.25, y: 0.5 } }],
      }),
    ).toThrow('网格')
    expect(() =>
      buildNovelAiPayload('nai-diffusion-4-full', { ...naiSettings, novelAiQualityMode: 'light' }),
    ).toThrow('Quality Mode')
  })
  it('compiles V5 Light quality and UC into the modern captions without invented API fields', () => {
    const payload = buildNovelAiPayload('nai-diffusion-5-full', {
      ...naiSettings,
      novelAiQualityMode: 'light',
      novelAiUcPreset: 'light',
    })
    expect(payload.input).toContain('very aesthetic, amazing quality, no text')
    expect(payload.parameters).not.toHaveProperty('quality_mode')
    expect(payload.parameters).toMatchObject({
      v4_negative_prompt: { caption: { base_caption: expect.stringContaining('bad hands') } },
    })
  })
  it('sends multipart image[] and a compiled edit prompt, with no made-up role/preserve fields', async () => {
    const { service, config, fetcher } = setup()
    const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const result = await service.generate(config, {
      prompt: '新服装',
      openAiInputImages: [
        { blob: image, role: 'identity' },
        { dataUrl: `data:image/png;base64,${png}`, role: 'outfit' },
      ],
      openAiEditInstruction: '换蓝色外套',
      openAiPreserve: { identity: true, composition: true },
      parentImageId: 'album-parent',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/images/edits')
    expect(init?.headers).not.toHaveProperty('Content-Type')
    const form = init?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.getAll('image[]')).toHaveLength(2)
    expect(form.get('prompt')).toContain('图片 1 用途：人物身份')
    expect(form.get('prompt')).toContain('保持不变：人物身份、构图与镜头位置')
    expect(form.has('role')).toBe(false)
    expect(form.has('preserve')).toBe(false)
    expect(result.manifest).toMatchObject({
      model: 'gpt-image-2',
      parentImageId: 'album-parent',
      parameters: { inputRoles: ['identity', 'outfit'], edit: true },
    })
    expect(JSON.stringify(result.manifest)).not.toContain(png)
    expect(JSON.stringify(result.manifest)).not.toContain(config.apiKey)
  })
  it('does not turn instructions without input images into a paid generation', async () => {
    const { service, config, fetcher } = setup()
    await expect(
      service.generate(config, { prompt: '', openAiEditInstruction: 'change coat' }),
    ).rejects.toThrow('至少一张')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('blocks transparent JPEG and supports transparent PNG multipart with a validated mask', async () => {
    const { service, config, fetcher } = setup()
    await expect(
      service.generate(config, {
        prompt: 'icon',
        openAiBackground: 'transparent',
        outputFormat: 'jpeg',
      }),
    ).rejects.toThrow('JPEG')
    const image = new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
      type: 'image/png',
    })
    await service.generate(config, {
      prompt: 'edit',
      openAiInputImages: [{ blob: image }],
      openAiMask: image,
      openAiBackground: 'transparent',
    })
    expect((fetcher.mock.calls[0]?.[1]?.body as FormData).get('mask')).toBeInstanceOf(Blob)
  })
  it('defaults unknown OpenAI-compatible models to model/prompt/size only', () => {
    const { config } = setup()
    const relay = {
      ...config,
      provider: 'openai' as const,
      model: 'relay-image',
      endpoint: 'https://relay.example/v1/images/generations',
    }
    expect(
      buildOpenAiImageRequest(relay, {
        prompt: 'test',
        openAiQuality: 'high',
        openAiBackground: 'transparent',
        outputFormat: 'webp',
        outputCompression: 20,
      }).body,
    ).toEqual({ model: 'relay-image', prompt: 'test', size: '1024x1024' })
    expect(() =>
      buildOpenAiImageRequest(relay, { prompt: 'edit', openAiInputImages: [{ dataUrl: 'x' }] }),
    ).toThrow('未确认')
  })
  it('uses declared capability before manual confirmation and invalidates stale endpoint/model evidence', () => {
    const { config } = setup()
    const evidence = {
      endpoint: config.endpoint,
      model: 'relay-image',
      declared: { quality: false },
      manual: { quality: true, outputFormat: true },
    }
    const caps = getImageGenerationCapabilities('openai', 'relay-image', evidence, config.endpoint)
    expect(caps.quality).toBe('unsupported')
    expect(caps.outputFormat).toBe('supported')
    expect(
      getImageGenerationCapabilities('openai', 'other', evidence, config.endpoint).outputFormat,
    ).toBe('unknown')
    expect(
      getImageGenerationCapabilities('openai', 'relay-image', evidence, 'https://other.example')
        .outputFormat,
    ).toBe('unknown')
  })
  it('learns only explicit booleans from GET /models, with no generation probes', async () => {
    const { service, config, fetcher } = setup()
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'vendor-image',
              capabilities: { quality: true, edits: false, mask: 'yes', output_format: true },
            },
          ],
        }),
      ),
    )
    const models = await service.listModels({
      ...config,
      provider: 'openai',
      endpoint: 'https://relay.example/v1',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(models.options[0]?.capabilities).toEqual({
      quality: true,
      imageEdit: false,
      outputFormat: true,
    })
  })
  it.each([
    '{bad',
    '[]',
    '{"model":"x"}',
    '{"endpoint":"x"}',
    '{"extra":{"Authorization":"key"}}',
    '{"headers":{"X-Test":"x"}}',
    '{"quality":"high"}',
    '{"__proto__":{}}',
  ])('blocks unsafe additional JSON %s', (json) => {
    expect(() => parseImageAdditionalJson(json)).toThrow()
  })
  it('previews the actual body with URL credentials stripped and secret echoes redacted', async () => {
    const { service, config, fetcher } = setup()
    const openai = {
      ...config,
      provider: 'openai' as const,
      endpoint: `https://relay.example/v1/images/generations?key=${config.apiKey}`,
    }
    const request = { prompt: `test ${config.apiKey}`, additionalJson: '{"vendor_option":true}' }
    const preview = previewOpenAiImageRequest(openai, request)
    expect(JSON.stringify(preview)).not.toContain(config.apiKey)
    expect(preview.endpoint).toBe('https://relay.example/v1/images/generations')
    expect(preview.payload).toHaveProperty('vendor_option', true)
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: `Authorization: Bearer ${config.apiKey}` } }),
        { status: 400 },
      ),
    )
    await expect(service.generate(openai, request)).rejects.toSatisfy(
      (error: Error) => !JSON.stringify(error).includes(config.apiKey),
    )
  })
})
