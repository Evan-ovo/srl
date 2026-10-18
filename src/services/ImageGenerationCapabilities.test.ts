import { describe, expect, it } from 'vitest'
import {
  getImageGenerationCapabilities,
  RELAY_CAPABILITY_KEYS,
  novelAiGridCoordinate,
  isOfficialOpenAiImageEndpoint,
  OPENAI_IMAGE_MODEL_PROFILES,
} from './ImageGenerationCapabilities'
import { buildOpenAiImageRequest } from './OpenAiImageRequest'

const endpoint = 'https://relay.example/v1/images/generations'
describe('image model and endpoint capability boundaries', () => {
  it.each(OPENAI_IMAGE_MODEL_PROFILES)(
    'uses an explicitly selected $name profile for a relay alias without changing the request model ID',
    (profile) => {
      const config = {
        provider: 'openai' as const,
        endpoint,
        model: 'vendor-alias',
        apiKey: 'test-key',
        relayCapabilities: { endpoint, model: 'vendor-alias', modelProfile: profile.id },
      }
      const caps = getImageGenerationCapabilities(
        'openai',
        config.model,
        config.relayCapabilities,
        endpoint,
      )
      for (const key of RELAY_CAPABILITY_KEYS) {
        expect(caps[key]).toBe('supported')
        expect(caps.sources[key]).toBe('selection')
      }
      expect(
        buildOpenAiImageRequest(config, { prompt: 'portrait', outputFormat: 'webp' }).body,
      ).toMatchObject({ model: 'vendor-alias', output_format: 'webp' })
    },
  )
  it('keeps explicit endpoint limitations and individual overrides above a selected profile', () => {
    const caps = getImageGenerationCapabilities(
      'openai',
      'vendor-alias',
      {
        endpoint,
        model: 'vendor-alias',
        modelProfile: 'gpt-image-2',
        declared: { imageEdit: false },
        manual: { imageEdit: true, quality: false },
      },
      endpoint,
    )
    expect(caps.imageEdit).toBe('unsupported')
    expect(caps.mask).toBe('unsupported')
    expect(caps.quality).toBe('unsupported')
    expect(caps.outputFormat).toBe('supported')
  })
  it('invalidates selected profiles on endpoint or model changes and ignores invalid stored values', () => {
    const evidence = { endpoint, model: 'vendor-alias', modelProfile: 'gpt-image-2' as const }
    expect(
      getImageGenerationCapabilities('openai', 'vendor-alias', evidence, endpoint + '/other')
        .quality,
    ).toBe('unknown')
    expect(getImageGenerationCapabilities('openai', 'new-alias', evidence, endpoint).quality).toBe(
      'unknown',
    )
    const invalid = { ...evidence, modelProfile: 'invented-profile' } as unknown as typeof evidence
    expect(
      getImageGenerationCapabilities('openai', 'vendor-alias', invalid, endpoint).quality,
    ).toBe('unknown')
  })
  it('does not let a saved relay profile unlock an unknown official model', () => {
    const official = 'https://api.openai.com/v1/images/generations'
    expect(
      getImageGenerationCapabilities(
        'openai',
        'vendor-alias',
        { endpoint: official, model: 'vendor-alias', modelProfile: 'gpt-image-2' },
        official,
      ).quality,
    ).toBe('unknown')
  })
  it.each([
    'gpt-image-1',
    'gpt-image-1-mini',
    'gpt-image-1.5',
    'gpt-image-2',
    'gpt-image-2-2026-04-21',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-flare',
    'chatgpt-image-latest',
  ])('%s uses the official profile only on the official API', (model) => {
    const official = getImageGenerationCapabilities(
      'openai',
      model,
      undefined,
      'https://api.openai.com/v1/images/generations',
    )
    for (const key of RELAY_CAPABILITY_KEYS) expect(official[key]).toBe('supported')
    const relay = getImageGenerationCapabilities('openai', model, undefined, endpoint)
    for (const key of RELAY_CAPABILITY_KEYS) expect(relay[key]).toBe('unknown')
    expect(relay.transparentBackground).toBe('unknown')
    expect(relay.maxInputImages).toBe(1)
  })
  it.each([
    'https://api.openai.com.evil.example/v1',
    'https://api.openai.com@relay.example/v1',
    'http://api.openai.com/v1',
    'invalid',
  ])('does not infer official capability from %s', (value) =>
    expect(isOfficialOpenAiImageEndpoint(value)).toBe(false),
  )
  it('uses declared endpoint/model metadata before manual confirmation and model defaults', () => {
    const declared = Object.fromEntries(RELAY_CAPABILITY_KEYS.map((key) => [key, true]))
    const caps = getImageGenerationCapabilities(
      'openai',
      'gpt-image-2',
      {
        endpoint,
        model: 'gpt-image-2',
        declared: { ...declared, imageEdit: false },
        manual: { imageEdit: true },
      },
      endpoint,
    )
    expect(caps.imageEdit).toBe('unsupported')
    expect(caps.mask).toBe('unsupported')
    expect(caps.multiImage).toBe('unsupported')
    expect(caps.transparentBackground).toBe('supported')
    expect(
      getImageGenerationCapabilities(
        'openai',
        'gpt-image-2',
        { endpoint, model: 'gpt-image-2', declared },
        endpoint + '/other',
      ).quality,
    ).toBe('unknown')
    expect(
      getImageGenerationCapabilities(
        'openai',
        'gpt-image-1',
        { endpoint, model: 'gpt-image-2', declared },
        endpoint,
      ).quality,
    ).toBe('unknown')
  })
  it('requires both editing and image input before enabling mask or multi-image controls', () => {
    const caps = getImageGenerationCapabilities(
      'openai',
      'gpt-image-2',
      {
        endpoint,
        model: 'gpt-image-2',
        declared: { mask: true, multiImage: true, imageEdit: true },
      },
      endpoint,
    )
    expect(caps.mask).toBe('unknown')
    expect(caps.multiImage).toBe('unknown')
    const blocked = getImageGenerationCapabilities(
      'openai',
      'gpt-image-2',
      { endpoint, model: 'gpt-image-2', declared: { mask: false, imageEdit: true } },
      endpoint,
    )
    expect(blocked.mask).toBe('unsupported')
  })
  it.each([
    'dall-e-2',
    'dall-e-3',
    'gpt-4o',
    'gpt-5',
    'o3',
    'text-embedding-3-small',
    'whisper-1',
    'tts-1',
  ])('blocks %s on the official Images API before any network request', (model) => {
    const caps = getImageGenerationCapabilities(
      'openai',
      model,
      undefined,
      'https://api.openai.com/v1',
    )
    expect(caps.textToImage).toBe('unsupported')
    expect(() =>
      buildOpenAiImageRequest(
        { provider: 'openai', model, endpoint: 'https://api.openai.com/v1', apiKey: 'test-key' },
        { prompt: 'portrait' },
      ),
    ).toThrow(caps.notes[0])
  })
  it('does not send unconfirmed optional fields to a relay carrying a GPT Image model name', () => {
    const prepared = buildOpenAiImageRequest(
      { provider: 'openai', model: 'gpt-image-2', endpoint, apiKey: 'test-key' },
      {
        prompt: 'portrait',
        openAiQuality: 'high',
        openAiBackground: 'transparent',
        outputFormat: 'jpeg',
        outputCompression: 10,
      },
    )
    expect(prepared.body).toEqual({ model: 'gpt-image-2', prompt: 'portrait', size: '1024x1024' })
  })
  it('does not claim transparent output when the endpoint only confirms the background field', () => {
    const relayCapabilities = {
      endpoint,
      model: 'gpt-image-2',
      declared: { background: true, outputFormat: false },
    }
    expect(
      getImageGenerationCapabilities('openai', 'gpt-image-2', relayCapabilities, endpoint)
        .transparentBackground,
    ).toBe('unsupported')
    expect(() =>
      buildOpenAiImageRequest(
        {
          provider: 'openai',
          model: 'gpt-image-2',
          endpoint,
          apiKey: 'test-key',
          relayCapabilities,
        },
        { prompt: 'portrait', openAiBackground: 'transparent' },
      ),
    ).toThrow('同时确认')
  })
  it.each([
    ['nai-diffusion-3', 0, false, false, true],
    ['nai-diffusion-furry-3', 0, false, false, true],
    ['nai-diffusion-4-full', 6, false, true, false],
    ['nai-diffusion-4-curated-preview', 6, false, true, false],
    ['nai-diffusion-4-5-full', 6, false, true, false],
    ['nai-diffusion-4-5-curated', 6, false, true, false],
    ['nai-diffusion-5-full', 22, true, true, false],
    ['nai-diffusion-5-curated', 22, true, true, false],
  ] as const)('keeps %s capabilities distinct', (model, count, transparent, text, smea) => {
    const caps = getImageGenerationCapabilities('novelai', model)
    expect(caps.maxCharacters).toBe(count)
    expect(caps.transparentBackground === 'supported').toBe(transparent)
    expect(caps.textRendering === 'supported').toBe(text)
    expect(caps.smea === 'supported').toBe(smea)
    expect(caps.imageEdit).toBe('unsupported')
  })
  it('does not expose an unknown NAI request schema as a usable model', () => {
    expect(getImageGenerationCapabilities('novelai', 'nai-diffusion-6-full').textToImage).toBe(
      'unsupported',
    )
  })
  it('projects V5 coordinates onto a legal V4 grid without mutating the stored coordinate', () => {
    expect(novelAiGridCoordinate(0.35)).toBe(0.3)
    expect(novelAiGridCoordinate(0.65)).toBe(0.7)
  })
})
