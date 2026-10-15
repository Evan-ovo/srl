/** @vitest-environment jsdom */
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SRL_BACK_REQUEST_EVENT } from '../composables/UseBackStack'

const {
  getExternalApp,
  getExternalAppSummary,
  requireCustomTool,
  getData,
  hasPermission,
  hasPersistentPermission,
  readChat,
  previewAllowed,
} = vi.hoisted(() => ({
  getExternalApp: vi.fn(),
  getExternalAppSummary: vi.fn(async () => getExternalApp.mock.results.at(-1)?.value),
  requireCustomTool: vi.fn(),
  getData: vi.fn(),
  hasPermission: vi.fn(),
  hasPersistentPermission: vi.fn(),
  readChat: vi.fn(),
  previewAllowed: { value: true },
}))

vi.mock('../composables/UsePreviewBudget', async () => {
  const { ref } = await import('vue')
  return { usePreviewBudget: () => ({ previewEnabled: ref(previewAllowed.value) }) }
})

vi.mock('../core/AppContainer', () => ({
  externalAppService: {
    get: getExternalApp,
    getSummary: getExternalAppSummary,
    requireCustomTool,
    getData,
    hasPermission,
    hasPersistentPermission,
    isBuiltinReader: (app: { id: string; runtimeHtml: string }) =>
      app.id === 'com.srl.duleme' &&
      app.runtimeHtml === '<!doctype html><html><body>reader</body></html>',
    recordPermissionDecision: vi.fn(),
    recordLaunch: vi.fn(),
    recordHealthyLaunch: vi.fn(),
    recordRuntimeError: vi.fn(),
  },
  externalAppSdkService: { readChat, releaseListSession: vi.fn() },
}))

import ExternalAppHost from './ExternalAppHost.vue'
import { readChatReaderColors, rememberChatReaderColors } from '../utils/ChatReaderAppearance'

describe('ExternalAppHost', () => {
  it('does not restore fullscreen when a pending load returns after closing', async () => {
    let resolve!: (app: unknown) => void
    getExternalApp.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.example.late' } })
    await wrapper.get('[aria-label="返回扩展管理"]').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
    wrapper.unmount()
    resolve({
      id: 'com.example.late',
      enabled: true,
      runtimeHtml: '',
      manifest: { name: 'late', immersive: true },
    })
    await flushPromises()
    expect(document.body.classList.contains('external-app-fullscreen')).toBe(false)
    expect(document.body.querySelector('.external-app-host__workspace')).toBeNull()
  })

  it.each([false, true])(
    'keeps a direct exit before iframe connection and after startup failure: %s',
    async (failed) => {
      previewAllowed.value = false
      if (failed) vi.useFakeTimers()
      getExternalApp.mockResolvedValueOnce({
        id: 'com.example.starting',
        enabled: true,
        runtimeHtml: '<p>starting</p>',
        manifest: {
          id: 'com.example.starting',
          name: 'starting',
          version: '1.0.0',
          immersive: true,
        },
      })
      const wrapper = mount(ExternalAppHost, { props: { appId: 'com.example.starting' } })
      try {
        await flushPromises()
        if (failed) {
          await vi.advanceTimersByTimeAsync(12_000)
          expect(document.body.textContent).toContain('第三方 APP 启动超时')
        }
        const exit = document.body.querySelector(
          '[aria-label="退出第三方 APP"]',
        ) as HTMLButtonElement
        expect(exit).not.toBeNull()
        exit.click()
        await nextTick()
        expect(wrapper.emitted('back')).toHaveLength(1)
        expect(document.body.classList.contains('external-app-fullscreen')).toBe(false)
      } finally {
        wrapper.unmount()
        previewAllowed.value = true
        vi.useRealTimers()
      }
    },
  )
  beforeEach(() =>
    rememberChatReaderColors({
      paper: '#f6f3ec',
      ink: '#303a32',
      muted: '#85887c',
      line: '#dddfd3',
      accent: '#586c4e',
      soft: '#e8ebdf',
    }),
  )

  it('uses the shared startup theme without discarding the saved reader colors', async () => {
    rememberChatReaderColors({ ...readChatReaderColors(), paper: '#202622' })
    getExternalApp.mockImplementationOnce(() => new Promise(() => {}))
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.srl.duleme', official: true } })
    try {
      expect(wrapper.get('.chat-reader-startup').attributes('style')).toBeUndefined()
      expect(readChatReaderColors().paper).toBe('#202622')
      expect(wrapper.find('iframe').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
  it('keeps an explicit return available when the built-in installation cannot load', async () => {
    getExternalApp.mockResolvedValueOnce(undefined)
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.srl.duleme', official: true } })
    try {
      expect(wrapper.find('[data-srl-feature-header]').exists()).toBe(false)
      await flushPromises()
      expect(wrapper.get('[data-srl-feature-header]').text()).toContain('读了么')
      expect(wrapper.text()).toContain('读了么未能加载')
      await wrapper.get('[aria-label="返回功能桌面"]').trigger('click')
      expect(wrapper.emitted('back')).toHaveLength(1)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([true, false])(
    'waits for APP initialization only for the built-in reader: %s',
    async (official) => {
      getExternalApp.mockResolvedValue({
        id: 'com.srl.duleme',
        enabled: true,
        runtimeMode: 'trustedCompatible',
        runtimeHtml: '<!doctype html><html><body>reader</body></html>',
        manifest: { id: 'com.srl.duleme', name: '读了么', version: '0.1.17', immersive: true },
      })
      const port = {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        onmessage: undefined as ((event: MessageEvent) => void) | undefined,
      }
      vi.stubGlobal(
        'MessageChannel',
        class {
          port1 = port
          port2 = {}
        },
      )
      const container = document.createElement('div')
      document.body.append(container)
      const wrapper = mount(ExternalAppHost, {
        props: { appId: 'com.srl.duleme', official },
        attachTo: container,
      })
      try {
        await flushPromises()
        const frame = document.body.querySelector('iframe') as HTMLIFrameElement
        const send = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
        frame.dispatchEvent(new Event('load'))
        frame.dispatchEvent(new Event('load'))
        await flushPromises()
        const connected = send.mock.calls.find(([data]) => data.type === 'srl:connect')![0]
        const workspace = document.body.querySelector('.external-app-host__workspace')!
        expect(workspace.classList.contains('external-app-host__workspace--starting')).toBe(
          official,
        )
        if (official) expect(document.body.textContent).toContain('正在打开读了么')
        const request = async (sequence: number, method: string, payload: unknown) => {
          port.onmessage!(
            new MessageEvent('message', {
              data: {
                type: 'srl:request',
                nonce: connected.nonce,
                id: String(sequence),
                sequence,
                method,
                payload,
              },
            }),
          )
          await flushPromises()
        }
        if (official) {
          await request(1, 'ui.readerNavigation', {
            page: 'reader',
            colors: { paper: '#191e20', ink: '#eeeeee' },
          })
          expect(workspace.classList.contains('external-app-host__workspace--starting')).toBe(true)
          expect((workspace as HTMLElement).style.getPropertyValue('--reader-paper')).toBe(
            '#f6f3ec',
          )
        }
        await request(2, 'ui.loading', { label: '' })
        expect(workspace.classList.contains('external-app-host__workspace--starting')).toBe(false)
        if (official) {
          expect((workspace as HTMLElement).style.getPropertyValue('--reader-paper')).toBe(
            '#191e20',
          )
          expect(readChatReaderColors().paper).toBe('#191e20')
          expect(workspace.querySelector('.feature-app-header')).toBeNull()
        }
      } finally {
        wrapper.unmount()
        container.remove()
        vi.unstubAllGlobals()
      }
    },
  )

  it.each([
    { official: true, id: 'com.srl.duleme', remote: false, prompts: false, ordinaryRead: true },
    { official: false, id: 'com.srl.duleme', remote: false, prompts: true, ordinaryRead: true },
    {
      official: true,
      id: 'com.srl.duleme',
      remote: false,
      prompts: true,
      ordinaryRead: true,
      forged: true,
    },
    { official: true, id: 'com.srl.duleme', remote: true, prompts: false },
    { official: true, id: 'com.srl.duleme', remote: false, prompts: false },
    { official: false, id: 'com.srl.duleme', remote: true, prompts: true },
    { official: true, id: 'com.example.reader', remote: true, prompts: true },
    { official: true, id: 'com.srl.duleme', remote: true, prompts: false, undeclared: true },
  ])(
    'uses the remote setting only for the built-in reader: %j',
    async ({ official, id, remote, prompts, undeclared, ordinaryRead, forged }) => {
      hasPermission
        .mockReset()
        .mockImplementation(
          async (_id, permission) => !(undeclared && permission === 'network.https'),
        )
      hasPersistentPermission
        .mockReset()
        .mockImplementation(
          async (_id, permission) => !ordinaryRead && permission !== 'network.https',
        )
      readChat.mockReset().mockResolvedValue({ messages: [] })
      getExternalApp.mockResolvedValue({
        id,
        enabled: true,
        runtimeMode: 'trustedCompatible',
        runtimeHtml: forged
          ? '<html>same ID, different source</html>'
          : '<!doctype html><html><body>reader</body></html>',
        manifest: { id, name: '读了么', version: '0.1.17' },
      })
      const port = {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        onmessage: undefined as ((event: MessageEvent) => void) | undefined,
      }
      vi.stubGlobal(
        'MessageChannel',
        class {
          port1 = port
          port2 = {}
        },
      )
      const originalModal = Object.getOwnPropertyDescriptor(
        HTMLDialogElement.prototype,
        'showModal',
      )
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.open = true
        },
      })
      const container = document.createElement('div')
      document.body.append(container)
      const wrapper = mount(ExternalAppHost, {
        props: { appId: id, official },
        attachTo: container,
      })
      try {
        await flushPromises()
        const iframe = wrapper.get('iframe').element as HTMLIFrameElement
        const connect = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
        // First load seeds the isolated document; the second connects the actual APP.
        await wrapper.get('iframe').trigger('load')
        await wrapper.get('iframe').trigger('load')
        const message = connect.mock.calls.find(([value]) => value.type === 'srl:connect')![0]
        port.onmessage!(
          new MessageEvent('message', {
            data: {
              type: 'srl:request',
              nonce: message.nonce,
              sequence: 1,
              id: 'remote-read',
              method: 'chat.read',
              payload: { id: 'chat', remote },
            },
          }),
        )
        await flushPromises()
        const dialog = document.body.querySelector('.external-app-permission')
        expect(Boolean(dialog)).toBe(prompts)
        if (prompts) {
          expect(readChat).not.toHaveBeenCalled()
          expect(dialog!.textContent).toContain(ordinaryRead ? '定位资源库' : '远程')
          ;(dialog!.querySelector('button') as HTMLButtonElement).click()
          await flushPromises()
        } else if (undeclared) {
          expect(readChat).not.toHaveBeenCalled()
          expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'remote-read', ok: false }),
          )
        } else {
          expect(readChat).toHaveBeenCalledExactlyOnceWith(id, { id: 'chat', remote })
          expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'remote-read', ok: true }),
          )
        }
        expect(
          hasPermission.mock.calls.some(([, permission]) => permission === 'network.https'),
        ).toBe(remote)
      } finally {
        wrapper.unmount()
        container.remove()
        if (originalModal)
          Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalModal)
        else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
        vi.unstubAllGlobals()
      }
    },
  )
  it('invokes registered tools over the same isolated runtime, narrows SDK permissions and rechecks the installed fingerprint after completion', async () => {
    const descriptor = {
      id: 'com.example.tools/note',
      appId: 'com.example.tools',
      name: 'note',
      title: '工具',
      appName: '工具 APP',
      available: true,
      version: '1.0.0',
      apiVersion: 'srl-app-tools@1',
      fingerprint: 'current',
      description: '权限核对',
      permissions: [] as import('../types/ExternalApp').ExternalAppPermission[],
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
        additionalProperties: false as const,
      },
    }
    requireCustomTool.mockResolvedValue(descriptor)
    getData.mockResolvedValue('PRIVATE_APP_VALUE')
    getExternalApp.mockResolvedValue({
      id: descriptor.appId,
      enabled: true,
      runtimeHtml: '<html>工具</html>',
      packageFingerprint: 'current',
      manifest: { id: descriptor.appId, name: '工具 APP', version: '1.0.0', tools: [descriptor] },
    })
    const port = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = port
        port2 = {}
      },
    )
    const wrapper = mount(ExternalAppHost, {
      props: { appId: descriptor.appId, assistantTool: descriptor },
      attachTo: document.body,
    })
    try {
      await flushPromises()
      const iframe = wrapper.get('iframe').element as HTMLIFrameElement
      const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
      iframe.dispatchEvent(new Event('load'))
      await flushPromises()
      const nonce = (post.mock.calls[0]![0] as { nonce: string }).nonce
      const send = (data: Record<string, unknown>) =>
        port.onmessage!(new MessageEvent('message', { data: { ...data, nonce } }))
      const pending = wrapper.vm.invokeTool(descriptor, '{}', new AbortController().signal)
      await flushPromises()
      send({ type: 'srl:tools-ready', names: ['note'] })
      const call = port.postMessage.mock.calls.find(([data]) => data.type === 'srl:tool-call')![0]
      const fullReads = getExternalApp.mock.calls.length
      send({
        type: 'srl:request',
        id: 'sdk',
        sequence: 1,
        method: 'storage.get',
        payload: { key: 'private' },
      })
      await flushPromises()
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sdk', ok: false, error: expect.stringContaining('超出') }),
      )
      expect(getData).not.toHaveBeenCalled()
      expect(getExternalApp).toHaveBeenCalledTimes(fullReads)
      expect(getExternalAppSummary).toHaveBeenCalledWith(descriptor.appId)
      send({ type: 'srl:tool-result', id: call.id, ok: true, result: '{"blocked":true}' })
      await expect(pending).resolves.toEqual({ blocked: true })
      getExternalAppSummary.mockResolvedValueOnce({ id: descriptor.appId, enabled: false })
      send({
        type: 'srl:request',
        id: 'disabled',
        sequence: 2,
        method: 'storage.get',
        payload: { key: 'private' },
      })
      await flushPromises()
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'disabled', ok: false, error: 'APP 已被禁用' }),
      )
      expect(getData).not.toHaveBeenCalled()
      expect(getExternalApp).toHaveBeenCalledTimes(fullReads)
      expect(requireCustomTool).toHaveBeenLastCalledWith(descriptor.id, 'current')
      expect(wrapper.get('iframe').attributes('sandbox')).toBe('allow-scripts')
      expect(wrapper.get('[data-srl-feature-header]').classes()).toContain(
        'feature-app-header--panel',
      )
      expect(wrapper.find('[aria-label="全屏预览"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      wrapper.element.remove()
      vi.unstubAllGlobals()
    }
  })
  it('reveals the third-party exit after 1.5 seconds and cancels an interrupted hold', async () => {
    const hostPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = hostPort
        port2 = {}
      },
    )
    getExternalApp.mockResolvedValue({
      id: 'com.example.hold',
      enabled: true,
      runtimeHtml: '<html><body>hold</body></html>',
      manifest: { id: 'com.example.hold', name: '长按验证', version: '1.0.0', immersive: true },
    })
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.example.hold' } })
    try {
      await flushPromises()
      const iframe = document.body.querySelector('.external-app-host__frame') as HTMLIFrameElement
      const connectMessage = vi
        .spyOn(iframe.contentWindow!, 'postMessage')
        .mockImplementation(() => {})
      iframe.dispatchEvent(new Event('load'))
      await flushPromises()
      const nonce = (connectMessage.mock.calls[0]![0] as { nonce: string }).nonce
      const signal = (type: string) =>
        hostPort.onmessage!(new MessageEvent('message', { data: { type, nonce } }))
      vi.useFakeTimers()
      signal('srl:host-hold-start')
      await vi.advanceTimersByTimeAsync(1000)
      signal('srl:host-hold-end')
      await vi.advanceTimersByTimeAsync(1500)
      expect(document.body.querySelector('.external-app-host__exit-handle')).toBeNull()
      signal('srl:host-hold-start')
      await vi.advanceTimersByTimeAsync(1499)
      expect(document.body.querySelector('.external-app-host__exit-handle')).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(document.body.querySelector('.external-app-host__exit-handle')).not.toBeNull()
      signal('srl:host-hold-end')
      await vi.advanceTimersByTimeAsync(2999)
      expect(document.body.querySelector('.external-app-host__exit-handle')).not.toBeNull()
      ;(document.body.querySelector('.external-app-host__exit-handle') as HTMLButtonElement).click()
      await nextTick()
      expect(wrapper.emitted('back')).toHaveLength(1)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
  it('uses the shared header for built-in lists and keeps reading navigation inside the app', async () => {
    const hostPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = hostPort
        port2 = {}
      },
    )
    getExternalApp.mockResolvedValue({
      id: 'com.srl.duleme',
      enabled: true,
      runtimeHtml: '<!doctype html><html><body>reader</body></html>',
      manifest: { id: 'com.srl.duleme', name: '读了么', version: '0.1.14', immersive: true },
    })
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.srl.duleme', official: true } })
    try {
      await flushPromises()
      const workspace = document.body.querySelector(
        '.external-app-host__workspace--builtin-reader',
      )!
      expect(workspace.querySelector('[data-srl-feature-header]')?.textContent).toContain('读了么')
      expect(workspace.querySelector('.external-app-host__runtime')).toBeNull()
      expect(workspace.querySelector('.external-app-host__immersive-hint')).toBeNull()
      const iframe = workspace.querySelector('iframe')!
      const connectMessage = vi
        .spyOn(iframe.contentWindow!, 'postMessage')
        .mockImplementation(() => {})
      iframe.dispatchEvent(new Event('load'))
      await flushPromises()
      const nonce = (connectMessage.mock.calls[0]![0] as { nonce: string }).nonce
      const navigate = async (page: string, sequence: number) => {
        hostPort.onmessage!(
          new MessageEvent('message', {
            data: {
              type: 'srl:request',
              nonce,
              sequence,
              id: String(sequence),
              method: 'ui.readerNavigation',
              payload: {
                page,
                cover: true,
                colors: { paper: '#202622', ink: '#d0d3c6', line: 'url(https://example.com)' },
              },
            },
          }),
        )
        await flushPromises()
      }
      await navigate('chats', 1)
      hostPort.onmessage!(
        new MessageEvent('message', {
          data: {
            type: 'srl:request',
            nonce,
            sequence: 2,
            id: 'ready',
            method: 'ui.loading',
            payload: { label: '' },
          },
        }),
      )
      await flushPromises()
      expect((workspace as HTMLElement).style.getPropertyValue('--color-canvas')).toBe('#202622')
      expect((workspace as HTMLElement).style.getPropertyValue('--color-ink')).toBe('#d0d3c6')
      expect((workspace as HTMLElement).style.getPropertyValue('--color-line')).toBe('#dddfd3')
      expect(workspace.querySelector('[data-srl-feature-header]')?.textContent).toContain(
        '聊天记录',
      )
      ;(workspace.querySelector('[aria-label="返回角色列表"]') as HTMLElement).click()
      expect(hostPort.postMessage).toHaveBeenCalledWith({
        type: 'srl:reader-action',
        nonce,
        action: 'back',
      })
      expect(wrapper.emitted('back')).toBeUndefined()
      await navigate('reader', 3)
      expect(workspace.querySelector('[data-srl-feature-header]')).toBeNull()
      expect(workspace.getAttribute('data-reader-page')).toBe('reader')
      const detail = { handled: false }
      window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
      expect(detail.handled).toBe(true)
      expect(document.body.classList.contains('external-app-fullscreen')).toBe(true)
      await navigate('roles', 4)
      hostPort.onmessage!(
        new MessageEvent('message', {
          data: { type: 'srl:request', nonce, sequence: 5, id: '5', method: 'ui.exitFullscreen' },
        }),
      )
      await flushPromises()
      expect(wrapper.emitted('back')).toHaveLength(1)
      await wrapper.setProps({ official: false })
      await navigate('reader', 6)
      expect(hostPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: '6', ok: false }),
      )
    } finally {
      wrapper.unmount()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { splashColor: undefined, splash: 'var(--color-accent)' },
    { splashColor: '#123456', splash: '#123456' },
  ])('keeps host theme with splash $splash', async ({ splashColor }) => {
    const featureHubEscape = vi.fn()
    window.addEventListener('keydown', featureHubEscape)
    getExternalApp.mockResolvedValue({
      id: 'com.srl.example.counter',
      enabled: true,
      runtimeHtml: '<!doctype html><html><body>example</body></html>',
      installedAt: 1,
      updatedAt: 1,
      manifest: {
        schemaVersion: 1,
        id: 'com.srl.example.counter',
        name: '离线计数器',
        splashColor,
        version: '1.0.0',
        entry: 'index.html',
      },
    })
    const wrapper = mount(ExternalAppHost, { props: { appId: 'com.srl.example.counter' } })
    await flushPromises()

    expect(wrapper.find('.external-app-host__status').exists()).toBe(false)
    expect(wrapper.get('.external-app-host__runtime').text()).toContain('独立工作区')
    expect(wrapper.get('.external-app-host__runtime').text()).toContain('本机 .srlapp · v1.0.0')
    expect(wrapper.get('.external-app-host__frame').attributes('sandbox')).toBe('allow-scripts')
    expect(
      (wrapper.get('.external-app-host__workspace').element as HTMLElement).style.getPropertyValue(
        '--external-app-splash',
      ),
    ).toBe('')
    expect((await getExternalApp.mock.results.at(-1)!.value).manifest.splashColor).toBe(splashColor)

    await wrapper.get('.external-app-host__fullscreen-toggle').trigger('click')
    expect(wrapper.classes()).toContain('external-app-host--fullscreen')
    expect(wrapper.find('.feature-app-header').exists()).toBe(false)
    expect(document.body.querySelector('.external-app-host__workspace--immersive')).not.toBeNull()
    expect(wrapper.find('.external-app-host__fullscreen-exit').exists()).toBe(false)
    expect(wrapper.find('.external-app-host__immersive-hint').exists()).toBe(false)
    expect(wrapper.find('.external-app-host__exit-handle').exists()).toBe(false)
    expect(wrapper.find('.external-app-host__fullscreen-error').exists()).toBe(false)
    expect(document.body.classList.contains('external-app-fullscreen')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    await nextTick()
    expect(featureHubEscape).not.toHaveBeenCalled()
    expect(wrapper.classes()).not.toContain('external-app-host--fullscreen')
    expect(document.body.classList.contains('external-app-fullscreen')).toBe(false)

    await wrapper.get('.external-app-host__fullscreen-toggle').trigger('click')
    const detail = { handled: false }
    window.dispatchEvent(new CustomEvent(SRL_BACK_REQUEST_EVENT, { detail }))
    await nextTick()
    expect(detail.handled).toBe(true)
    expect(wrapper.classes()).not.toContain('external-app-host--fullscreen')

    wrapper.unmount()
    window.removeEventListener('keydown', featureHubEscape)
    expect(document.body.classList.contains('external-app-fullscreen')).toBe(false)
  })
})
