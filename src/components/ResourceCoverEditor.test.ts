/** @vitest-environment jsdom */
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RESOURCE_TYPE, type Resource } from '../types/Resource'
import ResourceCoverEditor from './ResourceCoverEditor.vue'

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  original: vi.fn(),
  restore: vi.fn(),
  native: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({
  resourceGalleryService: {
    getImagePreview: api.preview,
    getImage: api.original,
    restoreDefaultCover: api.restore,
  },
}))
vi.mock('../core/NativeFileSource', () => ({ nativeFileSource: api.native }))
const wrappers: ReturnType<typeof mount>[] = []
const thumbnail = new Blob(['small'], { type: 'image/webp' })
const original = new Blob(['complete original'], { type: 'image/png' })
function resource(values: Partial<Resource> = {}): Resource {
  return {
    id: 'owner',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: 'card',
    description: '',
    fileName: 'card.png',
    mimeType: 'image/png',
    fileSize: original.size,
    contentHash: 'hash',
    originalBlob: original,
    thumbnailBlob: thumbnail,
    tags: [],
    favorite: false,
    categoryId: null,
    metadata: { resourceCoverId: 'cover' },
    createdAt: 1,
    updatedAt: 1,
    ...values,
  }
}
function setup(value = resource()) {
  const wrapper = mount(ResourceCoverEditor, {
    props: { resource: value },
    global: { stubs: { ResourceImageViewer: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}
function viewer(wrapper: ReturnType<typeof setup>) {
  return wrapper.findComponent({ name: 'ResourceImageViewer' })
}
function back(wrapper: ReturnType<typeof setup>) {
  ;(wrapper.vm as unknown as { requestBack: () => void }).requestBack()
}
beforeEach(() => {
  api.preview.mockReset().mockResolvedValue({ blob: thumbnail, url: '' })
  api.original
    .mockReset()
    .mockResolvedValue({ ...resource(), id: 'cover', originalBlob: original, metadata: {} })
  api.restore.mockReset().mockResolvedValue(resource({ metadata: {} }))
  api.native.mockReset().mockReturnValue(undefined)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => (blob === original ? 'blob:original' : 'blob:small')),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
})

it('prepares one original for the mounted cover and reuses it across repeated opens', async () => {
  const wrapper = setup()
  await flushPromises()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.original).toHaveBeenCalledExactlyOnceWith('owner', 'cover')
  expect(wrapper.get('button img').attributes('src')).toBe('blob:original')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.original).toHaveBeenCalledExactlyOnceWith('owner', 'cover')
  expect(viewer(wrapper).props('src')).toBe('blob:original')
  back(wrapper)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.original).toHaveBeenCalledOnce()
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
  expect(viewer(wrapper).props('src')).toBe('blob:original')
})

it('keeps the web full-image path immediate and avoids rereading it for metadata edits or viewing', async () => {
  const wrapper = setup()
  await flushPromises()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.original).toHaveBeenCalledExactlyOnceWith('owner', 'cover')
  expect(wrapper.get('button img').attributes('src')).toBe('blob:original')
  await wrapper.setProps({ resource: resource({ name: 'renamed', updatedAt: 2 }) })
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.original).toHaveBeenCalledOnce()
  expect(viewer(wrapper).props('src')).toBe('blob:original')
  expect(viewer(wrapper).props('loading')).toBe(false)
})

it('keeps metadata-only replacements and unrelated thumbnail fields from reloading a custom cover', async () => {
  const wrapper = setup()
  await flushPromises()
  await wrapper.setProps({
    resource: resource({ name: 'renamed', updatedAt: 2, thumbnailBlob: new Blob(['unrelated']) }),
  })
  await flushPromises()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.original).toHaveBeenCalledOnce()
})

it('uses the already-loaded default original for both button and viewer without a second decode URL', async () => {
  const wrapper = setup(resource({ metadata: {} }))
  await flushPromises()
  expect(wrapper.get('button img').attributes('src')).toBe('blob:original')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(viewer(wrapper).props('src')).toBe('blob:original')
  expect(api.original).not.toHaveBeenCalled()
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
})

it.each(['switch', 'unmount'] as const)(
  'ignores an initial cover read completing after %s',
  async (change) => {
    let finish!: (value: Resource) => void
    api.original.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const wrapper = setup()
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    if (change === 'switch')
      await wrapper.setProps({ resource: resource({ id: 'other', contentHash: 'other' }) })
    else wrapper.unmount()
    await flushPromises()
    const created = vi.mocked(URL.createObjectURL).mock.calls.length
    finish({ ...resource(), originalBlob: original })
    await flushPromises()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(created)
    if (change !== 'unmount') expect(viewer(wrapper).exists()).toBe(false)
  },
)

it('retains the mounted cover URL on close and releases it when the component unmounts', async () => {
  const wrapper = setup()
  await flushPromises()
  await wrapper.get('button').trigger('click')
  back(wrapper)
  await flushPromises()
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:original')
  wrapper.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:original')
})

it('disables an actually broken original without repeating its read or using a lower quality image', async () => {
  const wrapper = setup()
  await flushPromises()
  await wrapper.get('button img').trigger('error')
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  expect(api.original).toHaveBeenCalledOnce()
  expect(api.preview).not.toHaveBeenCalled()
})

it('recovers an initial read failure when the selected cover changes', async () => {
  api.original.mockRejectedValueOnce(new Error('original failed'))
  const wrapper = setup()
  await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toBe('original failed')
  await wrapper.setProps({ resource: resource({ metadata: { resourceCoverId: 'new-cover' } }) })
  await flushPromises()
  expect(wrapper.find('[role=alert]').exists()).toBe(false)
  expect(api.original).toHaveBeenLastCalledWith('owner', 'new-cover')
  await wrapper.get('button').trigger('click')
  expect(viewer(wrapper).props('src')).toBe('blob:original')
})
it('keeps URL covers on their original remote URL without reading again or retrying the same broken URL', async () => {
  api.preview.mockResolvedValue({ url: 'https://example.com/cover.png' })
  api.original.mockResolvedValueOnce({
    ...resource(),
    metadata: {
      assetKind: 'resource-gallery-image',
      galleryStorage: 'url',
      galleryUrl: 'https://example.com/cover.png',
    },
  })
  const wrapper = setup()
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(viewer(wrapper).props('src')).toBe('https://example.com/cover.png')
  expect(api.original).toHaveBeenCalledOnce()
  back(wrapper)
  await wrapper.get('button img').trigger('error')
  await flushPromises()
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  expect(api.original).toHaveBeenCalledOnce()
})

it('forwards a native full-image source to the existing tile viewer', async () => {
  api.native.mockReturnValue('native:image')
  const wrapper = setup()
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(viewer(wrapper).props('nativeSource')).toBe('native:image')
})

it('drops a late original when the selected cover changes', async () => {
  let finish!: (value: Resource) => void
  api.original.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const wrapper = setup()
  await wrapper.setProps({ resource: resource({ metadata: { resourceCoverId: 'new-cover' } }) })
  await flushPromises()
  const before = vi.mocked(URL.createObjectURL).mock.calls.length
  finish(resource())
  await flushPromises()
  expect(vi.mocked(URL.createObjectURL).mock.calls).toHaveLength(before)
  expect(api.original).toHaveBeenLastCalledWith('owner', 'new-cover')
})

it('keeps a default full image usable when no thumbnail exists', async () => {
  const wrapper = setup(resource({ metadata: {}, thumbnailBlob: undefined }))
  await flushPromises()
  expect(wrapper.get('button img').attributes('src')).toBe('blob:original')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(viewer(wrapper).props('src')).toBe('blob:original')
  expect(api.original).not.toHaveBeenCalled()
  expect(URL.createObjectURL).toHaveBeenCalledOnce()
})
