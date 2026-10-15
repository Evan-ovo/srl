/** @vitest-environment jsdom */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  readReaderData: vi.fn(),
  writeReaderData: vi.fn(async () => {}),
  listResourceListSummaries: vi.fn(),
  get: vi.fn(async () => undefined),
}))
vi.mock('../core/AppContainer', () => ({ resourceService: mock, externalAppService: mock }))
vi.mock('../services/AppearanceScopeService', () => ({ readAppliedAppFrameCss: async () => '' }))
import Reader from './ChatReaderApp.vue'
const wrappers: VueWrapper[] = []
const item = (id: string, type: string) => ({
  id,
  type,
  name: id,
  description: '',
  tags: [],
  favorite: false,
  categoryIds: [],
  relatedResourceIds: type === 'chat' ? ['role'] : [],
  updatedAt: 1,
  metadata: { messageCount: 12 },
})
beforeEach(() => {
  vi.clearAllMocks()
  mock.listResourceListSummaries.mockImplementation(async (filter: { types: string[] }) =>
    filter.types[0] === 'chat'
      ? Array.from({ length: 30 }, (_, i) => item('chat-' + i, 'chat'))
      : [item('role', 'characterCard')],
  )
  mock.readReaderData.mockImplementation(async (keys: string[]) =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        key === 'chat:chat-1' ? { title: '旧标题', note: '旧备注', position: { floor: 9 } } : null,
      ]),
    ),
  )
  const Observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.stubGlobal('IntersectionObserver', Observer)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
  HTMLElement.prototype.scrollTo = () => {}
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
})
async function open() {
  const wrapper = mount(Reader, { attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
it('mounts a host page with no outer iframe and batches all 30 visible chat states', async () => {
  const wrapper = await open(),
    root = wrapper.get('.chat-reader-app__view').element.shadowRoot!
  expect(wrapper.find('iframe').exists()).toBe(false)
  expect(wrapper.attributes('style')).toBeUndefined()
  expect(root.querySelector('iframe')).toBeNull()
  expect(root.querySelector('[data-role="role"]')).not.toBeNull()
  ;(root.querySelector('[data-role="role"]') as HTMLElement).click()
  await flushPromises()
  expect(mock.readReaderData.mock.calls.map((c) => c[0])).toEqual([
    ['preferences-v1', 'reader-index-v1'],
    Array.from({ length: 30 }, (_, i) => 'chat:chat-' + i),
  ])
  expect(root.querySelectorAll('.chat-row')).toHaveLength(30)
  expect(root.textContent).toContain('旧标题')
  expect(root.textContent).toContain('旧备注')
  expect(root.textContent).toContain('读至 10 楼')
  expect(wrapper.attributes('data-reader-page')).toBe('chats')
})
it('handles native back without closing the app while inside a role, and unregisters on exit', async () => {
  const wrapper = await open(),
    root = wrapper.get('.chat-reader-app__view').element.shadowRoot!
  ;(root.querySelector('[data-role="role"]') as HTMLElement).click()
  await flushPromises()
  let detail = { handled: false }
  window.dispatchEvent(new CustomEvent('srl:back-request', { detail, cancelable: true }))
  await flushPromises()
  expect(detail.handled).toBe(true)
  expect(wrapper.attributes('data-reader-page')).toBe('roles')
  expect(wrapper.emitted('back')).toBeUndefined()
  window.dispatchEvent(
    new CustomEvent('srl:back-request', { detail: { handled: false }, cancelable: true }),
  )
  await flushPromises()
  expect(wrapper.emitted('back')).toHaveLength(1)
  wrapper.unmount()
  detail = { handled: false }
  window.dispatchEvent(new CustomEvent('srl:back-request', { detail, cancelable: true }))
  expect(detail.handled).toBe(false)
})
it('rejects a late directory after unmount instead of publishing stale UI', async () => {
  let release!: (value: unknown[]) => void
  mock.listResourceListSummaries.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const wrapper = await open()
  wrapper.unmount()
  release([item('late', 'chat')])
  await flushPromises()
  expect(wrapper.emitted('back')).toBeUndefined()
  expect(mock.readReaderData).toHaveBeenCalledTimes(1)
})

it('consumes Escape in a native dialog before the feature hub can close the app', async () => {
  const wrapper = await open(),
    root = wrapper.get('.chat-reader-app__view').element.shadowRoot!
  ;(root.querySelector('#aboutBtn') as HTMLElement).click()
  await flushPromises()
  const dialog = root.querySelector('#sheet') as HTMLDialogElement
  expect(dialog.open).toBe(true)
  const propagated = vi.fn()
  window.addEventListener('keydown', propagated)
  dialog.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  )
  await flushPromises()
  window.removeEventListener('keydown', propagated)
  expect(dialog.open).toBe(false)
  expect(propagated).not.toHaveBeenCalled()
  expect(wrapper.emitted('back')).toBeUndefined()
})

it('removes its font-face registration when the native reader is unmounted', async () => {
  const wrapper = await open()
  const ownedStyle = document.head.lastElementChild
  expect(ownedStyle?.tagName).toBe('STYLE')
  wrapper.unmount()
  await flushPromises()
  expect(ownedStyle?.parentNode).toBeNull()
})
