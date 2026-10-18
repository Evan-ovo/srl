/** @vitest-environment jsdom */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExternalAppManager from './ExternalAppManager.vue'
import { RUNTIME_BRIDGE } from '../services/ExternalAppRuntime'

const { service, downloadBlob, confirmAction } = vi.hoisted(() => ({
  service: {
    inspect: vi.fn(),
    install: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getHealth: vi.fn(),
    listRetainedData: vi.fn(),
    configurePreview: vi.fn(),
    exportPackage: vi.fn(),
    exportPreviewPackage: vi.fn(),
    setEnabled: vi.fn(),
    clearData: vi.fn(),
    uninstall: vi.fn(),
    updateSourceFile: vi.fn(),
    setAllowedPermissions: vi.fn(),
    revokePersistentPermission: vi.fn(),
    updatePresentation: vi.fn(),
    setRuntimeMode: vi.fn(),
    clearRetainedData: vi.fn(),
    exportData: vi.fn(),
  },
  downloadBlob: vi.fn(),
  confirmAction: vi.fn(),
}))
vi.mock('../core/AppContainer', () => ({ externalAppService: service }))
vi.mock('../utils/LibraryFormatting', () => ({ downloadBlob }))
vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction,
  useConfirmDialogState: () => ({ activeDialog: { value: undefined }, respond: vi.fn() }),
}))

const manifest = {
  schemaVersion: 2,
  apiVersion: 'srl-app-api@1',
  id: 'com.example.counter',
  name: '离线计数器',
  version: '1.0.0',
  entry: 'index.html',
  permissions: ['app.storage'],
}
const files = {
  'index.html': new TextEncoder().encode('<p>计数器</p>'),
  'app.js': new TextEncoder().encode('const count = 1'),
  'app.css': new TextEncoder().encode('p { color: blue }'),
}
const installed = () => ({
  id: manifest.id,
  enabled: true,
  manifest: structuredClone(manifest),
  runtimeHtml: '<p>计数器</p>',
  packageFiles: files,
  allowedPermissions: ['app.storage'],
})
const inspected = () => ({
  manifest: structuredClone(manifest),
  runtimeHtml: '<!doctype html><p>计数器</p>',
  compatibleRuntimeHtml: '<!doctype html><p>计数器</p>',
  sourceKind: 'srlapp',
  packageFingerprint: 'app-test',
  requestedPermissions: ['app.storage'],
  permissionLevel: 'isolated',
  requiresReauthorization: false,
  compatibility: [],
  packageBytes: 100,
  packageFiles: files,
})
const wrappers: VueWrapper[] = []
function render() {
  const wrapper = mount(ExternalAppManager, {
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}
function button(wrapper: VueWrapper, label: string) {
  const result = wrapper.findAll('button').find(
    (item) =>
      item
        .text()
        .replace(/\s*[›+−]$/, '')
        .trim() === label || item.attributes('aria-label') === label,
  )
  if (!result) throw new Error(`未找到按钮：${label}`)
  return result
}
async function inspect(wrapper: VueWrapper) {
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['package'], 'counter.srlapp')],
  })
  await input.trigger('change')
  await flushPromises()
}
async function manage(wrapper: VueWrapper) {
  await flushPromises()
  await wrapper.get('.external-app-card').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks()
  service.list.mockResolvedValue([])
  service.listRetainedData.mockResolvedValue([])
  service.inspect.mockResolvedValue(inspected())
  service.install.mockImplementation(async () => {
    service.list.mockResolvedValue([installed()])
    return installed()
  })
  service.get.mockResolvedValue(installed())
  service.getHealth.mockResolvedValue({
    packageBytes: 100,
    dataBytes: 0,
    dataLimitBytes: 1024 * 1024,
    dataEntries: 0,
    consecutiveFailures: 0,
  })
  confirmAction.mockResolvedValue(true)
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('ExternalAppManager', () => {
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-externalappmanager-test-ts-1
  it('keeps embedded installation preview inside its modal', async () => {
    // SRL-PUBLIC-SYNC: END REPLACE id=public-externalappmanager-test-ts-1
    const sharedFiles = [new File(['package'], 'counter.srlapp')]
    const wrapper = mount(ExternalAppManager, {
      attachTo: document.body,
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-externalappmanager-test-ts-2
      props: { embedded: true, sharedFiles },
      // SRL-PUBLIC-SYNC: END REPLACE id=public-externalappmanager-test-ts-2
    })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[aria-label="安装确认"]').exists()).toBe(true)
    expect(wrapper.get('[aria-label="安装确认"]').element.closest('.external-app-manager')).toBe(
      wrapper.element,
    )
    expect(wrapper.text()).not.toContain('返回功能桌面')
    expect(service.install).not.toHaveBeenCalled()
    await button(wrapper, '安装 APP').trigger('click')
    await flushPromises()
    expect(service.install).toHaveBeenCalledWith(
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-externalappmanager-test-ts-3
      expect.objectContaining({ packageFingerprint: 'app-test' }),
      // SRL-PUBLIC-SYNC: END REPLACE id=public-externalappmanager-test-ts-3
      'isolated',
    )
  })
  it('inspects without running or installing, then keeps a success result and an explicit open action', async () => {
    const wrapper = render()
    await inspect(wrapper)
    expect(service.install).not.toHaveBeenCalled()
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(wrapper.get('[aria-label="安装确认"]').text()).toContain('离线计数器')
    await button(wrapper, '安装 APP').trigger('click')
    await flushPromises()
    expect(service.install).toHaveBeenCalledWith(
      expect.objectContaining({ packageFingerprint: 'app-test' }),
      'isolated',
    )
    expect(wrapper.emitted('installed')).toEqual([[manifest.id]])
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(wrapper.text()).toContain('已安装')
    await button(wrapper, '打开 APP').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[manifest.id]])
  })
  it('explains ability limits and both runtime modes directly in Chinese', async () => {
    service.inspect.mockResolvedValue({
      ...inspected(),
      requestedPermissions: ['resources.library.read', 'resources.write'],
      compatibility: [
        { code: 'isolated-persistence', message: '网页数据不会持久保存。', level: 'warning' },
      ],
    })
    const wrapper = render()
    await inspect(wrapper)
    expect(wrapper.get('.external-app-manager__permissions').text()).toContain('勾选的是能力上限')
    expect(wrapper.text()).toContain('查看资源库的资源摘要')
    expect(wrapper.get('.external-app-manager__runtime-mode').text()).toContain('允许 HTTPS')
    expect(wrapper.text()).toContain('网页数据不会持久保存')
    expect(wrapper.text()).not.toContain('high 风险')
  })
  it('labels updates with real version and content changes without claiming new permissions', async () => {
    service.inspect.mockResolvedValue({
      ...inspected(),
      previousInstallation: {
        id: manifest.id,
        name: manifest.name,
        version: '0.9.0',
        enabled: true,
        runtimeMode: 'isolated',
      },
      contentChanged: true,
      addedPermissions: [],
    })
    const wrapper = render()
    await inspect(wrapper)
    expect(wrapper.get('[aria-label="版本变化"]').text()).toContain('v0.9.0 → v1.0.0')
    expect(wrapper.text()).toContain('包内容已变化')
    expect(wrapper.text()).not.toContain('此版本新增了权限')
    expect(button(wrapper, '更新 APP').exists()).toBe(true)
  })
  it('opens separate management pages and returns through the same navigation path', async () => {
    service.list.mockResolvedValue([installed()])
    const wrapper = render()
    await manage(wrapper)
    const controls = wrapper.get('[aria-label="APP 操作"]')
    expect(controls.findAll('button')).toHaveLength(2)
    await controls.findAll('button')[0]!.trigger('click')
    expect(wrapper.find('#external-app-more-options').exists()).toBe(true)
    expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(false)
    await button(wrapper, '名称与图标').trigger('click')
    await button(wrapper, '返回更多操作').trigger('click')
    await flushPromises()
    expect(wrapper.find('#external-app-more-options').exists()).toBe(true)
    await button(wrapper, '返回 APP 管理').trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="APP 操作"]').findAll('button')[1]!.trigger('click')
    expect(wrapper.find('#external-app-more-options').exists()).toBe(false)
    expect(wrapper.find('#external-app-data-options').exists()).toBe(true)
    await button(wrapper, '返回 APP 管理').trigger('click')
    await flushPromises()
    expect(wrapper.find('#external-app-data-options').exists()).toBe(false)
    expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(true)
  })
  it('serializes management loading until the selected app and its health are ready', async () => {
    const app = installed()
    const other = { ...installed(), id: 'com.example.other' }
    service.list.mockResolvedValue([app, other])
    let finishRead!: (value: typeof app) => void
    let finishHealth!: (value: { dataBytes: number; dataEntries: number }) => void
    service.get.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve
      }),
    )
    service.getHealth.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHealth = resolve
      }),
    )
    const wrapper = render()
    await flushPromises()
    const cards = wrapper.findAll('.external-app-card')
    await cards[0]!.trigger('click')
    ;(cards[1]!.element as HTMLButtonElement).click()
    expect(service.get).toHaveBeenCalledTimes(1)
    expect(button(wrapper, '添加第三方 APP').attributes('disabled')).toBeDefined()
    finishRead(app)
    await flushPromises()
    const close = button(wrapper, '关闭 APP 管理')
    expect(close.attributes('disabled')).toBeDefined()
    ;(close.element as HTMLButtonElement).click()
    expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(true)
    finishHealth({ dataBytes: 42, dataEntries: 1 })
    await flushPromises()
    expect(button(wrapper, '打开 APP').attributes('disabled')).toBeUndefined()
    expect(button(wrapper, '关闭 APP 管理').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="APP 操作"]').text()).toContain('42 B')
  })
  it('does not open management while installation files are being inspected', async () => {
    service.list.mockResolvedValue([installed()])
    let finish!: (value: ReturnType<typeof inspected>) => void
    service.inspect.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const wrapper = render()
    await inspect(wrapper)
    ;(wrapper.get('.external-app-card').element as HTMLButtonElement).click()
    await flushPromises()
    expect(service.get).not.toHaveBeenCalled()
    finish(inspected())
    await flushPromises()
    expect(wrapper.find('[aria-label="安装确认"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(false)
  })
  it('does not inspect new files while a management app is being read', async () => {
    const app = installed()
    service.list.mockResolvedValue([app])
    let finish!: (value: typeof app) => void
    service.get.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const wrapper = render()
    await manage(wrapper)
    await inspect(wrapper)
    expect(service.inspect).not.toHaveBeenCalled()
    finish(app)
    await flushPromises()
    expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="安装确认"]').exists()).toBe(false)
  })
  it.each(['missing', 'failed'])(
    'recovers from a %s management read and permits retry',
    async (state) => {
      service.list.mockResolvedValue([installed()])
      if (state === 'missing') service.get.mockResolvedValueOnce(undefined)
      else service.get.mockRejectedValueOnce(new Error('读取 APP 失败'))
      const wrapper = render()
      await manage(wrapper)
      expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(false)
      expect(wrapper.text()).toContain(state === 'missing' ? '已被卸载' : '读取 APP 失败')
      expect(wrapper.get('.external-app-card').attributes('disabled')).toBeUndefined()
      await manage(wrapper)
      expect(wrapper.find('[aria-label="APP 操作"]').exists()).toBe(true)
    },
  )
  it('refreshes enabled state inside the open management panel after toggling', async () => {
    service.list.mockResolvedValue([installed()])
    service.setEnabled.mockImplementation(async (_id: string, enabled: boolean) => {
      service.list.mockResolvedValue([{ ...installed(), enabled }])
    })
    const wrapper = render()
    await manage(wrapper)
    await button(wrapper, '禁用 APP').trigger('click')
    await flushPromises()
    expect(button(wrapper, '打开 APP').attributes('disabled')).toBeDefined()
    await button(wrapper, '启用 APP').trigger('click')
    await flushPromises()
    expect(service.setEnabled.mock.calls).toEqual([
      [manifest.id, false],
      [manifest.id, true],
    ])
    expect(button(wrapper, '打开 APP').attributes('disabled')).toBeUndefined()
  })
  it('exposes actual HTML/JS/CSS files and keeps source drafts when discard is declined', async () => {
    service.list.mockResolvedValue([installed()])
    const wrapper = render()
    await manage(wrapper)
    await wrapper.get('[aria-label="APP 操作"] button').trigger('click')
    await button(wrapper, '源码编辑').trigger('click')
    expect(
      wrapper
        .get('select')
        .findAll('option')
        .map((item) => item.text()),
    ).toEqual(['index.html', 'app.js', 'app.css'])
    await wrapper.get('textarea').setValue('未保存的源码')
    confirmAction.mockResolvedValue(false)
    await button(wrapper, '返回更多操作').trigger('click')
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('未保存的源码')
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({ title: '放弃未保存的更改' }),
    )
  })
  it('exports the package through the existing download channel', async () => {
    service.list.mockResolvedValue([installed()])
    const file = new File(['package'], 'counter.srlapp')
    service.exportPackage.mockResolvedValue(file)
    const wrapper = render()
    await manage(wrapper)
    await wrapper.get('[aria-label="APP 操作"] button').trigger('click')
    await button(wrapper, '导出为 .srlapp').trigger('click')
    await flushPromises()
    expect(downloadBlob).toHaveBeenCalledWith(file, file.name)
  })
  it('completes the same handshake required by the runtime and tags replies, rejecting stale sessions', async () => {
    const channels: Array<{
      port1: {
        onmessage?: (event: MessageEvent) => void
        postMessage: ReturnType<typeof vi.fn>
        start: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      }
      port2: object
    }> = []
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() }
        port2 = {}
        constructor() {
          channels.push(this)
        }
      },
    )
    const wrapper = render()
    await inspect(wrapper)
    await button(wrapper, '试运行').trigger('click')
    const frame = wrapper.get('iframe')
    const postMessage = vi
      .spyOn(frame.element.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    await frame.trigger('load')
    const connect = postMessage.mock.calls.at(-1)![0] as { nonce: string; protocolVersion: number }
    expect(connect).toMatchObject({
      type: 'srl:connect',
      protocolVersion: 2,
      nonce: expect.any(String),
    })
    const host = channels.at(-1)!.port1
    host.onmessage!({
      data: {
        type: 'srl:request',
        nonce: 'stale',
        id: '1',
        sequence: 1,
        method: 'sdk.capabilities',
      },
    } as MessageEvent)
    expect(host.postMessage).not.toHaveBeenCalled()
    host.onmessage!({
      data: {
        type: 'srl:request',
        nonce: connect.nonce,
        id: '2',
        sequence: 2,
        method: 'sdk.capabilities',
      },
    } as MessageEvent)
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: connect.nonce,
        ok: true,
        value: expect.objectContaining({ preview: true }),
      }),
    )
    // Execute the actual generated bridge, so the test catches handshake contract changes.
    const handlers = new Map<string, (event: unknown) => void>()
    const parent = {}
    const dispatchEvent = vi.fn()
    const runtimeWindow = {
      parent,
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      dispatchEvent,
      setTimeout,
      clearTimeout,
    }
    const runtimePort = { start: vi.fn(), postMessage: vi.fn() }
    new Function(
      'window',
      'document',
      'navigator',
      'console',
      RUNTIME_BRIDGE.replace(/^<script>|<\/script>$/g, ''),
    )(runtimeWindow, { addEventListener: vi.fn() }, {}, { warn: vi.fn(), error: vi.fn() })
    handlers.get('message')!({ source: parent, data: connect, ports: [runtimePort] })
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'srlappready' }))
    await button(wrapper, '结束试运行').trigger('click')
    expect(host.close).toHaveBeenCalled()
    expect(service.install).not.toHaveBeenCalled()
  })
  it('shows construction failures as trial errors while keeping installation choices available', async () => {
    const preview = inspected()
    Object.defineProperty(preview, 'runtimeHtml', {
      get() {
        throw new Error('找不到脚本文件 app.js')
      },
    })
    service.inspect.mockResolvedValue(preview)
    const wrapper = render()
    await inspect(wrapper)
    await button(wrapper, '试运行').trigger('click')
    expect(wrapper.text()).toContain('找不到脚本文件 app.js')
    expect(wrapper.find('iframe').exists()).toBe(false)
    expect(button(wrapper, '取消').attributes('disabled')).toBeUndefined()
  })
  it('lists retained data without mixing it into installed apps and requires a scoped deletion confirmation', async () => {
    service.listRetainedData.mockResolvedValue([
      { appId: 'com.example.removed', dataBytes: 30, dataEntries: 2 },
    ])
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('已卸载 APP 的保留数据')
    expect(wrapper.find('.external-app-card').exists()).toBe(false)
    await button(wrapper, '清除数据').trigger('click')
    await flushPromises()
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('2 项数据'), danger: true }),
    )
    expect(service.clearRetainedData).toHaveBeenCalledWith('com.example.removed')
  })
  it('keeps a single add menu with file and folder import', async () => {
    const wrapper = render()
    await button(wrapper, '添加第三方 APP').trigger('click')
    expect(wrapper.text()).toContain('导入文件')
    expect(wrapper.text()).toContain('导入文件夹')
  })
  it('saves an explicitly cleared icon instead of preserving the previous image', async () => {
    const app = { ...installed(), iconDataUrl: 'data:image/png;base64,aWNvbg==' }
    service.list.mockResolvedValue([app])
    service.get.mockResolvedValue(app)
    const wrapper = render()
    await manage(wrapper)
    await wrapper.get('[aria-label="APP 操作"] button').trigger('click')
    await button(wrapper, '名称与图标').trigger('click')
    await wrapper.get('input[inputmode="url"]').setValue('')
    await button(wrapper, '保存名称与图标').trigger('click')
    await flushPromises()
    expect(service.updatePresentation).toHaveBeenCalledWith(manifest.id, manifest.name, '')
  })
  it('does not navigate to another management page while an export is pending', async () => {
    service.list.mockResolvedValue([installed()])
    let finish!: (file: File) => void
    service.exportPackage.mockReturnValue(
      new Promise<File>((resolve) => {
        finish = resolve
      }),
    )
    const wrapper = render()
    await manage(wrapper)
    await wrapper.get('[aria-label="APP 操作"] button').trigger('click')
    await button(wrapper, '导出为 .srlapp').trigger('click')
    await button(wrapper, '名称与图标').trigger('click')
    expect(wrapper.find('#external-app-more-options').exists()).toBe(true)
    finish(new File(['package'], 'app.srlapp'))
    await flushPromises()
  })
  it('clears a packaged icon in the installation draft', async () => {
    service.inspect.mockResolvedValue({
      ...inspected(),
      iconDataUrl: 'data:image/png;base64,aWNvbg==',
    })
    const wrapper = render()
    await inspect(wrapper)
    await wrapper.get('input[inputmode="url"]').setValue('')
    await button(wrapper, '安装 APP').trigger('click')
    await flushPromises()
    expect(service.install.mock.calls[0]![0].iconDataUrl).toBe('')
  })
  it.each(['installed', 'preview'])(
    'shows an image read failure in the %s editor',
    async (mode) => {
      vi.stubGlobal(
        'FileReader',
        class {
          onerror?: () => void
          readAsDataURL() {
            this.onerror?.()
          }
        },
      )
      service.list.mockResolvedValue([installed()])
      const wrapper = render()
      if (mode === 'installed') {
        await manage(wrapper)
        await wrapper.get('[aria-label="APP 操作"] button').trigger('click')
        await button(wrapper, '名称与图标').trigger('click')
      } else await inspect(wrapper)
      const input = wrapper.findAll('input[type="file"]')[mode === 'installed' ? 3 : 2]!
      Object.defineProperty(input.element, 'files', {
        configurable: true,
        value: [new File(['image'], 'icon.png', { type: 'image/png' })],
      })
      await input.trigger('change')
      await flushPromises()
      expect(wrapper.text()).toContain('无法读取图标图片')
    },
  )
  it('keeps the preview and existing data when an APP update is cancelled', async () => {
    service.list.mockResolvedValue([installed()])
    confirmAction.mockResolvedValue(false)
    const wrapper = render()
    await inspect(wrapper)
    await button(wrapper, '安装 APP').trigger('click')
    await flushPromises()
    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ title: '更新第三方 APP' }))
    expect(service.install).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="安装确认"]').exists()).toBe(true)
    expect(wrapper.emitted('installed')).toBeUndefined()
    expect(wrapper.emitted('busy')?.at(-1)).toEqual([false])
    confirmAction.mockResolvedValue(true)
    await button(wrapper, '安装 APP').trigger('click')
    await flushPromises()
    expect(service.install).toHaveBeenCalledTimes(1)
  })
  it('notifies the embedding import dialog when the preview is cancelled', async () => {
    const wrapper = render()
    await inspect(wrapper)
    await button(wrapper, '取消').trigger('click')
    expect(wrapper.emitted('preview-cancelled')).toEqual([[]])
    expect(service.install).not.toHaveBeenCalled()
  })
})
