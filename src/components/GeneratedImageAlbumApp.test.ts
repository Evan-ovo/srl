/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'
import type { GeneratedImageAlbumPage } from '../types/GeneratedImageAlbum'

const { albumService, hostingService } = vi.hoisted(() => ({
  albumService: {
    list: vi.fn(),
    getPreviewBlob: vi.fn<(id: string) => Promise<Blob>>(
      async () => new Blob(['thumb'], { type: 'image/webp' }),
    ),
    getOriginalBlob: vi.fn<(id: string) => Promise<Blob>>(
      async () => new Blob(['image'], { type: 'image/png' }),
    ),
    importFile: vi.fn(),
    updateDetails: vi.fn(),
    setHostedUrl: vi.fn(),
    delete: vi.fn(),
  },
  hostingService: {
    listSelfHosted: vi.fn(async () => ({ files: [], directories: [], total: 0 })),
    initializeCredentials: vi.fn(async () => {}),
    getSelfHostedConfiguration: vi.fn(() => null),
    saveSelfHostedConfiguration: vi.fn((value) => value),
    status: vi.fn(async () => ({
      configured: true,
      membership: { registered: true, disabled: false, termsAccepted: true },
      capacity: { uploadEnabled: true },
    })),
    uploadBlobShared: vi.fn(),
    uploadBlobSelfHosted: vi.fn(),
  },
}))

vi.mock('../core/ImageAlbumContainer', () => ({
  generatedImageAlbumService: albumService,
  frontendWorkshopImageHostingService: hostingService,
}))

vi.mock('../core/NativeFileExport', () => ({
  isNativeFileExportAvailable: vi.fn(() => false),
  saveBlobToNativeDestination: vi.fn(),
}))

vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction: vi.fn(async () => true),
}))

import GeneratedImageAlbumApp from './GeneratedImageAlbumApp.vue'

enableAutoUnmount(afterEach)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

async function albumPage(count = 18) {
  const original = (await albumService.list()) as GeneratedImageAlbumPage
  const result = {
    ...original,
    items: Array.from({ length: count }, (_, index) => ({
      ...original.items[0]!,
      id: 'image-' + index,
      name: 'image ' + index,
    })),
    total: count,
  }
  albumService.list.mockClear().mockResolvedValue(result)
  return result
}

function pendingPreviews(page: GeneratedImageAlbumPage) {
  const pending = new Map(page.items.map((item) => [item.id, deferred<Blob>()]))
  albumService.getPreviewBlob.mockImplementation((id) => pending.get(id)!.promise)
  const resolve = () =>
    pending.forEach((value, id) => value.resolve(new Blob([id], { type: 'image/webp' })))
  return { pending, resolve }
}

describe('GeneratedImageAlbumApp', () => {
  // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-album-own-hosting-entry-tests
  it('opens the self-hosted form directly from the empty album header and returns focus', async () => {
    const empty = await albumPage(0)
    albumService.list.mockResolvedValue(empty)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    const button = wrapper.get('[aria-label="自建图床设置"]')
    await button.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[aria-label="自建图床"]')).not.toBeNull()
    expect(document.body.querySelector('.image-hosting-connection')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"][aria-label="自建图床"]')).toBeNull()
    expect(document.body.querySelector('.generated-album__hosting-page')).not.toBeNull()
    document.body
      .querySelector<HTMLButtonElement>('[aria-label="关闭自建图床设置"], [aria-label="返回相册"]')!
      .click()
    await flushPromises()
    expect(document.activeElement).toBe(button.element)
    expect(albumService.getOriginalBlob).not.toHaveBeenCalled()
  })
  // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-album-own-hosting-entry-tests

  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    vi.clearAllMocks()
    albumService.getPreviewBlob
      .mockReset()
      .mockImplementation(async () => new Blob(['thumb'], { type: 'image/webp' }))
    albumService.getOriginalBlob
      .mockReset()
      .mockImplementation(async () => new Blob(['image'], { type: 'image/png' }))
    albumService.list.mockReset()
    let nextUrl = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => `blob:${++nextUrl}:${blob.size}`),
      revokeObjectURL: vi.fn(),
    })
    albumService.list.mockResolvedValue({
      items: [
        {
          id: 'one',
          name: '月下庭院',
          source: 'generated',
          category: '背景',
          mimeType: 'image/png',
          sizeBytes: 5,
          hostedUrl: 'https://img.example/one.png',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 18,
      pageCount: 1,
      categories: ['背景'],
      mimeTypes: ['image/png'],
    })
  })

  it('opens self-hosted connection from an empty album without loading an original or uploading', async () => {
    const empty = await albumPage(0)
    albumService.list.mockResolvedValue(empty)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[aria-label="相册设置"]').trigger('click')
    await flushPromises()
    const own = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.generated-album__settings button'),
    ).find((button) => button.textContent === '自建图床连接')!
    own.click()
    await flushPromises()
    const form = document.body.querySelector<HTMLFormElement>('.image-hosting-connection')!
    expect(form).not.toBeNull()
    expect(hostingService.initializeCredentials).toHaveBeenCalledTimes(1)
    const fields = form.querySelectorAll<HTMLInputElement>('input')
    fields[0]!.value = 'https://img.example'
    fields[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    fields[1]!.value = 'example-token'
    fields[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(hostingService.saveSelfHostedConfiguration).toHaveBeenCalledWith({
      origin: 'https://img.example',
      token: 'example-token',
      remember: false,
    })
    expect(document.body.querySelector('[aria-label="自建图床"]')!.textContent).not.toContain(
      '自建图床仅在本次打开期间连接。',
    )
    form.closest('details')!.open = true
    fields[0]!.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    fields[0]!.dispatchEvent(tab)
    if (document.body.querySelector('[role="dialog"][aria-label="自建图床"]'))
      expect(document.activeElement).toBe(fields[1])
    else expect(tab.defaultPrevented).toBe(false)
    expect(albumService.getOriginalBlob).not.toHaveBeenCalled()
    expect(hostingService.uploadBlobSelfHosted).not.toHaveBeenCalled()
    expect(albumService.list).toHaveBeenCalledTimes(1)
  })

  it('does not fill a closed connection dialog from a late credential read', async () => {
    const reading = deferred<void>()
    hostingService.initializeCredentials.mockReturnValueOnce(reading.promise)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('[aria-label="相册设置"]').trigger('click')
    await flushPromises()
    Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.generated-album__settings button'),
    )
      .find((button) => button.textContent === '自建图床连接')!
      .click()
    await flushPromises()
    document.body
      .querySelector<HTMLButtonElement>('[aria-label="关闭自建图床设置"], [aria-label="返回相册"]')!
      .click()
    reading.resolve()
    await flushPromises()
    expect(document.body.querySelector('.generated-album__settings')).toBeNull()
    expect(hostingService.saveSelfHostedConfiguration).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(wrapper.get('[aria-label="相册设置"]').element)
  })

  it('serializes a burst of filters and only prepares the latest requested page', async () => {
    const original = await albumPage(),
      listing = deferred<GeneratedImageAlbumPage>()
    const latest = {
      ...original,
      items: [{ ...original.items[0]!, id: 'latest', name: 'latest filter' }],
      total: 1,
    }
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    albumService.getPreviewBlob.mockClear()
    albumService.list.mockReturnValueOnce(listing.promise).mockResolvedValueOnce(latest)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await wrapper.get('[aria-label="自定义分类"]').setValue('背景')
    await wrapper.get('[aria-label="图片类型"]').setValue('image/png')
    await wrapper.get('[aria-label="保存时间排序"]').setValue('newest')
    expect(albumService.list.mock.calls.length).toBe(2)
    listing.resolve(original)
    await flushPromises()
    expect(albumService.list.mock.calls.length).toBe(3)
    expect(albumService.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: '背景', mimeType: 'image/png', sort: 'newest', page: 1 }),
    )
    expect(albumService.getPreviewBlob.mock.calls.map(([id]) => id)).toEqual(['latest'])
    expect(wrapper.get('.generated-album__grid').text()).toContain('latest filter')
  })

  it('keeps committed previews while cancelling obsolete preparation and swapping once ready', async () => {
    const original = await albumPage()
    const obsolete = {
      ...original,
      items: original.items.map((item) => ({ ...item, id: 'obsolete-' + item.id })),
    }
    const latest = {
      ...original,
      items: [{ ...original.items[0]!, id: 'latest', name: 'latest page' }],
      total: 1,
    }
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    const shown = wrapper.findAll('.generated-album__grid img').map((img) => img.attributes('src'))
    const pending = new Map(obsolete.items.map((item) => [item.id, deferred<Blob>()])),
      final = deferred<Blob>()
    albumService.getPreviewBlob
      .mockClear()
      .mockImplementation((id) => (id === 'latest' ? final.promise : pending.get(id)!.promise))
    albumService.list.mockResolvedValueOnce(obsolete).mockResolvedValueOnce(latest)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await flushPromises()
    for (const item of obsolete.items.slice(0, 3))
      pending.get(item.id)!.resolve(new Blob([item.id]))
    await flushPromises()
    expect(albumService.getPreviewBlob).toHaveBeenCalledTimes(7)
    const prepared = vi
      .mocked(URL.createObjectURL)
      .mock.results.slice(18)
      .map((result) => result.value)
    await wrapper.get('[aria-label="自定义分类"]').setValue('背景')
    const revokedOnRequest = vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url)
    for (const gate of pending.values()) gate.resolve(new Blob(['obsolete']))
    await flushPromises()
    const whilePending = wrapper
      .findAll('.generated-album__grid img')
      .map((img) => img.attributes('src'))
    final.resolve(new Blob(['latest']))
    await flushPromises()
    expect(revokedOnRequest).toEqual(prepared)
    expect(whilePending).toEqual(shown)
    expect(albumService.getPreviewBlob.mock.calls.length).toBe(8)
    expect(wrapper.findAll('.generated-album__grid > button')).toHaveLength(1)
    expect(wrapper.get('.generated-album__grid').text()).toContain('latest page')
    for (const url of shown) expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(
      wrapper.get('.generated-album__grid img').attributes('src'),
    )
  })

  it('ignores superseded query errors and releases the loader for explicit retries', async () => {
    const original = await albumPage(),
      listing = deferred<GeneratedImageAlbumPage>()
    const latest = {
      ...original,
      items: [{ ...original.items[0]!, name: 'recovered latest' }],
      total: 1,
    }
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    albumService.list.mockReturnValueOnce(listing.promise).mockResolvedValueOnce(latest)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await wrapper.get('[aria-label="自定义分类"]').setValue('背景')
    listing.reject(new Error('superseded query failed'))
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.generated-album__grid').text()).toContain('recovered latest')
    albumService.list.mockRejectedValueOnce(new Error('current query failed'))
    await wrapper.get('[aria-label="保存时间排序"]').setValue('newest')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('current query failed')
    albumService.list.mockResolvedValueOnce(latest)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('.generated-album__grid').text()).toContain('recovered latest')
  })

  it('discards queued filter requests when the album unmounts', async () => {
    const original = await albumPage(),
      listing = deferred<GeneratedImageAlbumPage>()
    albumService.list.mockReturnValueOnce(listing.promise)
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await wrapper.get('[aria-label="保存时间排序"]').setValue('newest')
    wrapper.unmount()
    listing.resolve(original)
    await flushPromises()
    expect(albumService.list).toHaveBeenCalledTimes(1)
    expect(albumService.getPreviewBlob).not.toHaveBeenCalled()
    expect(hostingService.status).not.toHaveBeenCalled()
  })

  it('refreshes a completed save at the pending filter page instead of the old page number', async () => {
    const original = await albumPage()
    const first = { ...original, total: 54, pageCount: 3 }
    const second = {
      ...first,
      page: 2,
      items: first.items.map((item, index) => ({ ...item, id: 'page-two-' + index })),
    }
    albumService.list.mockResolvedValue(first)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    albumService.list.mockResolvedValueOnce(second)
    await wrapper.findAll('.generated-album__pagination button')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.get('.generated-album__pagination span').text()).toBe('2 / 3')
    await wrapper.get('.generated-album__grid > button').trigger('click')
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.generated-album__detail input')!
    input.value = 'saved name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const saving = deferred<void>(),
      listing = deferred<GeneratedImageAlbumPage>()
    albumService.updateDetails.mockReturnValueOnce(saving.promise)
    document.body
      .querySelector<HTMLButtonElement>('.generated-album__detail-bar > button:last-child')!
      .click()
    await flushPromises()
    document.body.querySelector<HTMLButtonElement>('[aria-label="关闭图片详情"]')!.click()
    const stale = { ...first, page: 1, total: 1, pageCount: 1, items: [second.items[0]!] }
    const latest = { ...stale, items: [{ ...stale.items[0]!, name: 'saved name' }] }
    albumService.list.mockReturnValueOnce(listing.promise).mockResolvedValueOnce(latest)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    saving.resolve()
    await flushPromises()
    listing.resolve(stale)
    await flushPromises()
    expect(albumService.updateDetails).toHaveBeenCalledWith('page-two-0', 'saved name', '背景')
    expect(albumService.list.mock.calls.length).toBe(4)
    expect(albumService.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, sort: 'oldest' }),
    )
    expect(wrapper.get('.generated-album__grid').text()).toContain('saved name')
  })

  it('does not repeat a search already covered by a same-frame filter query', async () => {
    const original = await albumPage(),
      latest = { ...original, items: [{ ...original.items[0]!, name: '庭院 match' }], total: 1 }
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    albumService.list.mockResolvedValue(latest)
    const search = wrapper.get<HTMLInputElement>('input[type="search"]'),
      sort = wrapper.get<HTMLSelectElement>('[aria-label="保存时间排序"]')
    search.element.value = '庭院'
    search.element.dispatchEvent(new Event('input', { bubbles: true }))
    sort.element.value = 'oldest'
    sort.element.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    expect(albumService.list.mock.calls.length).toBe(2)
    expect(albumService.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: '庭院', sort: 'oldest' }),
    )
    await vi.advanceTimersByTimeAsync(220)
    await flushPromises()
    expect(albumService.list.mock.calls.length).toBe(2)
    wrapper.unmount()
  })

  it('preserves a newer debounced search not covered by the queued query', async () => {
    const original = await albumPage(),
      listing = deferred<GeneratedImageAlbumPage>()
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    albumService.list.mockReturnValueOnce(listing.promise).mockResolvedValue(original)
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await wrapper.get('[aria-label="保存时间排序"]').setValue('newest')
    await wrapper.get('input[type="search"]').setValue('new search')
    listing.resolve(original)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(220)
    await flushPromises()
    expect(albumService.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'new search', page: 1 }),
    )
    wrapper.unmount()
  })

  it('does not start previews or hosting status after an unmounted page query resolves', async () => {
    const page = await albumPage()
    const listing = deferred<GeneratedImageAlbumPage>()
    albumService.list.mockReturnValueOnce(listing.promise)
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    expect(albumService.list).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    listing.resolve(page)
    await flushPromises()
    expect(albumService.getPreviewBlob).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(hostingService.status).not.toHaveBeenCalled()
  })

  it('stops claiming remaining previews after the page closes', async () => {
    const page = await albumPage(),
      previews = pendingPreviews(page)
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    expect(albumService.getPreviewBlob).toHaveBeenCalledTimes(4)
    wrapper.unmount()
    previews.resolve()
    await flushPromises()
    expect(albumService.getPreviewBlob.mock.calls.length).toBe(4)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(hostingService.status).not.toHaveBeenCalled()
  })

  it('keeps four preview workers and other images usable when one preview fails', async () => {
    await albumPage()
    let pending = 0,
      peak = 0
    albumService.getPreviewBlob.mockImplementation(async (id) => {
      pending++
      peak = Math.max(peak, pending)
      await Promise.resolve()
      pending--
      if (id === 'image-2') throw new Error('damaged preview')
      return new Blob([id], { type: 'image/webp' })
    })
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    expect(peak).toBe(4)
    expect(albumService.getPreviewBlob).toHaveBeenCalledTimes(18)
    expect(wrapper.findAll('.generated-album__grid > button')).toHaveLength(18)
    expect(wrapper.findAll('.generated-album__grid img')).toHaveLength(17)
    expect(albumService.getOriginalBlob).not.toHaveBeenCalled()
  })

  it('releases already prepared previews while other reads are still pending', async () => {
    const page = await albumPage(),
      previews = pendingPreviews(page)
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()
    for (const item of page.items.slice(0, 3))
      previews.pending.get(item.id)!.resolve(new Blob([item.id]))
    await flushPromises()
    expect(albumService.getPreviewBlob).toHaveBeenCalledTimes(7)
    const created = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value)
    expect(created).toHaveLength(3)
    wrapper.unmount()
    const releasedAtClose = vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url)
    previews.resolve()
    await flushPromises()
    expect(releasedAtClose).toEqual(created)
    expect(albumService.getPreviewBlob.mock.calls.length).toBe(7)
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(3)
  })

  it.each(['close', 'unmount'])('discards an original arriving after detail %s', async (action) => {
    const original = deferred<Blob>()
    albumService.getOriginalBlob.mockReturnValueOnce(original.promise)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    vi.mocked(URL.createObjectURL).mockClear()
    await wrapper.get('.generated-album__grid > button').trigger('click')
    await flushPromises()
    if (action === 'unmount') wrapper.unmount()
    else document.body.querySelector<HTMLButtonElement>('[aria-label="关闭图片详情"]')!.click()
    original.resolve(new Blob(['late-original'], { type: 'image/png' }))
    await flushPromises()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(document.body.querySelector('.generated-album__detail')).toBeNull()
  })

  it.each(['resolve', 'reject'])(
    'keeps the current image when an older read later %s',
    async (action) => {
      await albumPage(2)
      const first = deferred<Blob>(),
        second = deferred<Blob>(),
        latest = new Blob(['current-image'], { type: 'image/png' })
      albumService.getOriginalBlob
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
      await flushPromises()
      vi.mocked(URL.createObjectURL).mockClear()
      await wrapper.get('.generated-album__grid > button').trigger('click')
      await flushPromises()
      document.body.querySelector<HTMLButtonElement>('[aria-label="下一张"]')!.click()
      await flushPromises()
      second.resolve(latest)
      await flushPromises()
      const currentUrl = document.body.querySelector<HTMLImageElement>(
        '.generated-album__detail img',
      )!.src
      if (action === 'resolve') first.resolve(new Blob(['old-image'], { type: 'image/png' }))
      else first.reject(new Error('old read failed'))
      await flushPromises()
      expect(
        document.body.querySelector<HTMLImageElement>('.generated-album__detail img')!.src,
      ).toBe(currentUrl)
      expect(
        document.body.querySelector<HTMLImageElement>('.generated-album__detail img')!.alt,
      ).toBe('image 1')
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob)).toEqual([latest])
    },
  )

  it('finishes a started save without reloading previews after unmount', async () => {
    const saved = deferred<void>()
    albumService.updateDetails.mockReturnValueOnce(saved.promise)
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    await wrapper.get('.generated-album__grid > button').trigger('click')
    await flushPromises()
    const save = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.generated-album__detail button'),
    ].find((button) => button.textContent === '保存')!
    save.click()
    await flushPromises()
    expect(albumService.updateDetails).toHaveBeenCalledWith('one', '月下庭院', '背景')
    wrapper.unmount()
    saved.resolve()
    await flushPromises()
    expect(albumService.updateDetails).toHaveBeenCalledTimes(1)
    expect(albumService.list).toHaveBeenCalledTimes(1)
  })

  it('loads only page previews and exposes URL, category, phone-save and delete actions', async () => {
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()

    expect(albumService.getPreviewBlob).toHaveBeenCalledWith('one')
    expect(albumService.getOriginalBlob).not.toHaveBeenCalled()
    await wrapper.get('.generated-album__grid > button').trigger('click')
    await flushPromises()

    expect(albumService.getOriginalBlob).toHaveBeenCalledWith('one')
    const detail = document.body.querySelector<HTMLElement>('.generated-album__detail')
    expect(detail?.querySelector('.generated-album__url')?.textContent).toContain(
      'https://img.example/one.png',
    )
    expect(detail?.querySelector('.generated-album__actions')?.textContent).toContain('存手机')
    expect(detail?.querySelector('.generated-album__actions')?.textContent).toContain('删除')
    detail?.querySelector<HTMLButtonElement>('.generated-album__actions .is-danger')?.click()
    await flushPromises()
    expect(albumService.delete).toHaveBeenCalledWith('one')
  })

  it('adds hosted/local badges to the original cards and combines status with existing filters', async () => {
    const originalPage = await albumService.list()
    albumService.list.mockResolvedValue({
      ...originalPage,
      items: [originalPage.items[0], { ...originalPage.items[0], id: 'two', hostedUrl: undefined }],
      total: 2,
    })
    const wrapper = mount(GeneratedImageAlbumApp)
    await flushPromises()

    expect(wrapper.findAll('.generated-album__thumb i').map((badge) => badge.text())).toEqual([
      '已有直链',
      '仅本地',
    ])
    expect(wrapper.findAll('.generated-album__grid > button')).toHaveLength(2)
    expect(wrapper.findAll('.generated-album__filters select')).toHaveLength(3)
    expect(wrapper.text()).not.toContain('生成直链并导入')
    expect(albumService.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostedStatus: 'all' }),
    )
    await wrapper.get('[aria-label="自定义分类"]').setValue('背景')
    await flushPromises()
    await wrapper.get('[aria-label="图片类型"]').setValue('image/png')
    await flushPromises()
    await wrapper.get('[aria-label="保存时间排序"]').setValue('oldest')
    await flushPromises()
    for (const hostedStatus of ['hosted', 'local', 'all']) {
      await wrapper.get('[aria-label="相册设置"]').trigger('click')
      await flushPromises()
      const label = { hosted: '已有直链', local: '仅本地', all: '全部' }[hostedStatus]
      const action = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(
          '.generated-album__status-options button',
        ),
      ).find((button) => button.querySelector('span')?.textContent === label)
      expect(action).toBeDefined()
      action!.click()
      await flushPromises()
      expect(wrapper.get('[aria-label="相册设置"]').attributes('aria-expanded')).toBe('false')
      expect(albumService.list).toHaveBeenLastCalledWith({
        search: '',
        mimeType: 'image/png',
        category: '背景',
        sort: 'oldest',
        hostedStatus,
        page: 1,
        pageSize: 18,
      })
    }
  })

  it('keeps settings focus inside the dialog and closes without leaving the album', async () => {
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()
    const trigger = wrapper.get<HTMLButtonElement>('[aria-label="相册设置"]')
    for (const method of ['escape', 'backdrop', 'back']) {
      await trigger.trigger('click')
      await flushPromises()
      const dialog = document.body.querySelector<HTMLElement>('.generated-album__settings')!
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button')
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(document.activeElement).toBe(buttons[0])
      buttons[0]!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
      expect(document.activeElement).toBe(buttons[buttons.length - 1])
      buttons[buttons.length - 1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(buttons[0])
      if (method === 'escape') {
        buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } else if (method === 'backdrop') {
        document.body.querySelector<HTMLElement>('.generated-album__settings-backdrop')!.click()
      } else {
        const detail = { handled: false }
        document.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
        if (!detail.handled)
          window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
        expect(detail.handled).toBe(true)
      }
      await flushPromises()
      expect(document.body.querySelector('.generated-album__settings')).toBeNull()
      expect(document.activeElement).toBe(trigger.element)
      expect(wrapper.emitted('back')).toBeUndefined()
    }
  })

  it('uses a modal inspector and restores focus after Escape', async () => {
    const wrapper = mount(GeneratedImageAlbumApp, { attachTo: document.body })
    await flushPromises()

    const card = wrapper.get<HTMLButtonElement>('.generated-album__grid > button')
    card.element.focus()
    await card.trigger('click')
    await flushPromises()

    expect(document.body.querySelector('.generated-album__detail[role="dialog"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭图片详情')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(document.body.querySelector('.generated-album__detail')).toBeNull()
    expect(document.activeElement).toBe(card.element)
  })
})
