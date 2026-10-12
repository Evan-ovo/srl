/** @vitest-environment jsdom */
import { DOMWrapper, flushPromises, mount as vueMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TavernBridgeCenter from './TavernBridgeCenter.vue'
import { chooseAction, confirmAction } from '../composables/UseConfirmDialog'
import { browserStorageService, resourceService } from '../core/AppContainer'
import { assistantGuidance, startAssistantGuidance } from '../core/ProductAssistantGuidance'
import { tavernConnectionStore } from '../core/TavernConnectionStore'
import { hashBlob } from '../services/HashService'
import { PngResourceParser } from '../parser/PngResourceParser'
import type { TavernResourceItem } from '../services/TavernBridgeProtocol'
import { RESOURCE_TYPE, type ResourceSummary } from '../types/Resource'
import { checkRelayWorker, saveRelayWorkerBaseUrl } from '../services/RelayWorkerSettingsService'

beforeEach(() => {
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

const writeText = vi.fn(async (_value: string) => undefined)
const mountedWrappers: Array<{ unmount(): void }> = []
const bridgeMocks = vi.hoisted(() => ({
  getState: vi.fn(() => ({
    status: 'idle',
    detail: '等待酒馆扩展',
    pairCode: '',
    tavernOrigin: '',
    bridgeVersion: '',
  })),
  hasInvitation: vi.fn(() => false),
  canBindDirectory: vi.fn(() => false),
  bindDirectory: vi.fn(async () => undefined),
  joinSecureRelay: vi.fn(async () => undefined),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  listResources: vi.fn(
    async (_kind?: 'chat' | 'character' | 'userPersona'): Promise<TavernResourceItem[]> => [],
  ),
  isLocalTavernDirectAvailable: vi.fn(() => false),
  disconnect: vi.fn(),
  finishPullBatch: vi.fn(async () => undefined),
  sendFiles: vi.fn(async () => [{ status: 'created', name: '已接收' }]),
  checkUserAvatarIds: vi.fn(async () => new Set<string>()),
  pullResources: vi.fn(async (_items: Array<{ fileName: string }>) => [
    new File(['{}'], 'personas.json', { type: 'application/json' }),
  ]),
}))

vi.mock('../composables/UseConfirmDialog', () => ({
  confirmAction: vi.fn(),
  chooseAction: vi.fn(),
}))
vi.mock('../core/AppContainer', async () => ({
  exportService: new (await import('../services/ExportService')).ExportService(),
  browserStorageService: {
    getTavernChatCarryScripts: vi.fn(() => true),
    setTavernChatCarryScripts: vi.fn(),
    getTavernSendContent: vi.fn(() => 'modified' as const),
    setTavernSendContent: vi.fn(),
    getModifiedResourceSyncTags: vi.fn(() => false),
    setModifiedResourceSyncTags: vi.fn(),
    getBridgeTransferLog: vi.fn(() => []),
    appendBridgeTransferLog: vi.fn((items: string[]) => items),
    getBridgeTransferDraft: vi.fn(() => undefined),
    setBridgeTransferDraft: vi.fn(),
  },
  resourceService: { get: vi.fn() },
}))
vi.mock('../services/TavernBridgeService', () => ({
  tavernBridgeService: {
    ...bridgeMocks,
  },
}))

function mountBridge(options: { attachTo?: HTMLElement; props: Record<string, unknown> }) {
  return vueMount(TavernBridgeCenter, {
    attachTo: document.body,
    ...options,
    props: {
      ...options.props,
      onImportFiles:
        options.props.onImportFiles ??
        ((_files: File[], onComplete?: () => void) => onComplete?.()),
    } as never,
  })
}

function transferSettings() {
  return new DOMWrapper(
    document.body.querySelector<HTMLDialogElement>('.tavern-transfer-settings')!,
  )
}
function render() {
  const wrapper = mountBridge({
    attachTo: document.body,
    props: { resources: [] },
  })
  mountedWrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
  bridgeMocks.sendFiles.mockReset()
  bridgeMocks.sendFiles.mockImplementation(async () => [{ status: 'created', name: '已接收' }])
  bridgeMocks.joinSecureRelay.mockClear()
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('shows the exact centered prompt instead of joining without a self-hosted Worker', async () => {
  const wrapper = render()
  const button = wrapper.get('.tavern-device-join button')
  expect(button.attributes('data-relay-enabled')).toBe('false')
  expect(wrapper.get('.tavern-device-join input').attributes('disabled')).toBeDefined()
  await wrapper.get('.tavern-device-join').trigger('submit')
  expect(confirmAction).toHaveBeenCalledWith({
    title: '中继码',
    message: '中继码功能已停用，请自部署worker',
    confirmLabel: '知道了',
    centered: true,
  })
  expect(bridgeMocks.joinSecureRelay).not.toHaveBeenCalled()
})

it('enables the button only after checking the saved Worker and disables it on target change', async () => {
  saveRelayWorkerBaseUrl('https://worker.example')
  const wrapper = render()
  expect(wrapper.get('.tavern-device-join button').attributes('data-relay-enabled')).toBe('false')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify({
            ok: true,
            service: String(url).endsWith('/api/bridge/health')
              ? 'srl-bridge-cloudflare'
              : 'srl-koofr-worker',
          }),
        ),
    ),
  )
  await checkRelayWorker('https://worker.example')
  await flushPromises()
  expect(wrapper.get('.tavern-device-join button').attributes('data-relay-enabled')).toBe('true')
  await wrapper.get('.tavern-device-join input').setValue('AB23CD45')
  await wrapper.get('.tavern-device-join').trigger('submit')
  await flushPromises()
  expect(bridgeMocks.joinSecureRelay).toHaveBeenCalledWith('AB23CD45')
  saveRelayWorkerBaseUrl('https://other.example')
  await flushPromises()
  expect(wrapper.get('.tavern-device-join button').attributes('data-relay-enabled')).toBe('false')
})

function resource(overrides: Partial<ResourceSummary>): ResourceSummary {
  return {
    id: 'local-1',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    name: '本地角色',
    fileName: '本地角色.png',
    metadata: {
      card: {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: overrides.name ?? '本地角色', first_mes: '原开场白' },
      },
    },
    tags: [],
    ...overrides,
  } as ResourceSummary
}

describe('聊天回传确认与默认范围', () => {
  it('shows stop during an outgoing transfer and aborts its signal immediately', async () => {
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.39',
      capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    const local = resource({ id: 'cancel-card', fileName: 'cancel-card.json' })
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      originalBlob: new Blob(['{}'], { type: 'application/json' }),
      mimeType: 'application/json',
    } as Awaited<ReturnType<typeof resourceService.get>>)
    let receivedSignal: AbortSignal | undefined
    const sendMock = bridgeMocks.sendFiles as unknown as {
      mockImplementation: (handler: (...args: unknown[]) => Promise<never>) => void
    }
    sendMock.mockImplementation((_files, _policy, _progress, options) => {
      receivedSignal = (options as { signal: AbortSignal }).signal
      return new Promise<never>((_resolve, reject) => {
        receivedSignal!.addEventListener('abort', () => reject(receivedSignal!.reason), {
          once: true,
        })
      })
    })
    const wrapper = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id] },
    })
    mountedWrappers.push(wrapper)
    await wrapper
      .findAll('.tavern-bridge-tabs button')
      .find((button) => button.text().includes('发送到酒馆'))!
      .trigger('click')
    await wrapper.find('.tavern-bridge__sticky-action').trigger('click')
    await flushPromises()
    const cancel = wrapper.find('.tavern-bridge-cancel')
    expect(cancel.exists()).toBe(true)
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    expect(receivedSignal?.aborted).toBe(false)
    await cancel.trigger('click')
    await flushPromises()
    expect(receivedSignal?.aborted).toBe(true)
    expect(wrapper.text()).toContain('已取消：已发送 0 项')
    expect(wrapper.find('.tavern-bridge-cancel').exists()).toBe(false)
  })

  it('paginates large catalogs without rendering every resource card', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.39',
      capabilities: ['catalog-pages-v1'],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue(
      Array.from(
        { length: 2500 },
        (_, index) =>
          ({
            id: `theme:${index}`,
            kind: 'theme',
            name: `主题 ${index}`,
            fileName: `${index}.json`,
            detail: '',
            ...(index === 0 ? { size: 1024 } : {}),
          }) as TavernResourceItem,
      ),
    )
    const wrapper = mountBridge({ props: { resources: [] } })
    mountedWrappers.push(wrapper)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '刷新目录')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(10)
    expect(wrapper.findAll('.tavern-bridge-file-size')).toHaveLength(10)
    expect(wrapper.find('.tavern-bridge-file-size').text()).toBe('1.0 KB')
    expect(wrapper.text()).toContain('酒馆未提供大小')
    expect(wrapper.text()).toContain('第 1 / 250 页')
    expect(
      wrapper
        .find('.tavern-bridge-resource-grid')
        .element.compareDocumentPosition(wrapper.find('.tavern-bridge-pagination').element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await wrapper.find('.tavern-bridge-pagination button:last-child').trigger('click')
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(10)
    expect(wrapper.text()).toContain('第 2 / 250 页')
    wrapper.unmount()
  })

  it('paginates local resources and shows each exact file size', async () => {
    const resources = Array.from({ length: 65 }, (_, index) =>
      resource({
        id: `persona-${index}`,
        type: RESOURCE_TYPE.CHARACTER_CARD,
        name: `人设 ${index}`,
        fileName: `persona-${index}.json`,
        fileSize: 2048,
      }),
    )
    const wrapper = mountBridge({
      props: { resources, initialLocalIds: [resources[0]!.id] },
    })
    mountedWrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(10)
    expect(wrapper.findAll('.tavern-bridge-file-size')).toHaveLength(10)
    expect(wrapper.find('.tavern-bridge-file-size').text()).toBe('2.0 KB')
    expect(wrapper.text()).toContain('第 1 / 7 页')
    await wrapper.find('.tavern-bridge-pagination button:last-child').trigger('click')
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(10)
    expect(wrapper.text()).toContain('第 2 / 7 页')
  })

  it('loads chat records from their resource category only when selected', async () => {
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.40',
      capabilities: ['catalog-pages-v1', 'chat-archive-v1'],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockImplementation(async (kind) =>
      kind === 'chat'
        ? [
            {
              id: 'chat:card-one',
              kind: 'chat',
              name: '测试聊天',
              fileName: '测试聊天.srlchat',
              detail: '聊天记录 · 测试角色',
              sizeLabel: '2.50 MB',
            },
          ]
        : [
            {
              id: 'userPersona:one',
              kind: 'userPersona',
              name: '测试人设',
              fileName: 'persona-one.json',
              detail: '用户人设',
            },
          ],
    )
    const wrapper = mountBridge({ props: { resources: [] } })
    mountedWrappers.push(wrapper)
    await flushPromises()

    const chatFilter = () =>
      wrapper
        .findAll('.tavern-bridge-type-filter button')
        .find((button) => button.text().includes('聊天记录'))!
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.listResources.mock.calls[0]?.[0]).toBeUndefined()
    expect(chatFilter().exists()).toBe(true)
    await chatFilter().trigger('click')
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenCalledWith('chat')
    expect(wrapper.find('.tavern-bridge-resource-card').text()).toContain('2.50 MB')

    await wrapper
      .findAll('.tavern-bridge-type-filter button')
      .find((button) => button.text().includes('用户人设'))!
      .trigger('click')
    await chatFilter().trigger('click')
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(2)
  })

  it('waits for each bounded import batch before pulling more resources', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.39',
      capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue(
      Array.from(
        { length: 26 },
        (_, index) =>
          ({
            id: `theme:${index}`,
            kind: 'theme',
            name: `主题 ${index}`,
            fileName: `${index}.json`,
            detail: '',
          }) as TavernResourceItem,
      ),
    )
    bridgeMocks.pullResources.mockImplementation(async ([item]) => [
      new File(['{}'], item!.fileName),
    ])
    const batches: File[][] = []
    const completions: Array<() => void> = []
    const wrapper = mountBridge({
      props: {
        resources: [],
        onImportFiles: (files: File[], onComplete?: () => void) => {
          batches.push(files)
          if (onComplete) completions.push(onComplete)
        },
      },
    })
    mountedWrappers.push(wrapper)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '刷新目录')!
      .trigger('click')
    await flushPromises()
    await wrapper.find('.tavern-bridge-selectbar button').trigger('click')
    await wrapper
      .findAll('.tavern-bridge__sticky-action')
      .find((button) => button.text().includes('取回'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.pullResources).toHaveBeenCalledTimes(25)
    expect(batches[0]).toHaveLength(25)
    completions.shift()?.()
    await flushPromises()
    expect(bridgeMocks.pullResources).toHaveBeenCalledTimes(26)
    expect(batches[1]).toHaveLength(1)
    completions.shift()?.()
    await flushPromises()
  })

  it('sends nothing after cancel, then sends only the original chat to the confirmed avatar by default', async () => {
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://localhost:8000',
      bridgeVersion: '0.3.36-chat.4',
      capabilities: ['chat-import-v1'],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'character:card.png',
        kind: 'character',
        name: '目标角色',
        fileName: 'card.png',
        detail: '',
      },
    ])
    const card = {
      ...resource({ id: 'card', fileName: 'card.png' }),
      originalBlob: new Blob(['card']),
    }
    const chat = {
      ...resource({
        id: 'chat',
        type: RESOURCE_TYPE.CHAT,
        fileName: '雨夜.jsonl',
        relatedResourceIds: ['card'],
      }),
      originalBlob: new Blob([
        '{"user_name":"User"}\n{"name":"角色","is_user":false,"mes":"原文"}',
      ]),
    }
    vi.mocked(resourceService.get).mockImplementation(async (id) => (id === 'card' ? card : chat))
    const w = mountBridge({
      props: { resources: [chat, card], initialLocalIds: ['chat'] },
    })
    mountedWrappers.push(w)
    await flushPromises()
    const send = w
      .findAll('.tavern-bridge__sticky-action')
      .find((item) => item.text().includes('发送'))!
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    await send.trigger('click')
    await flushPromises()
    expect(bridgeMocks.sendFiles).not.toHaveBeenCalled()
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '确认导入聊天记录',
        message: expect.stringContaining('目标角色（card.png）'),
      }),
    )
    vi.mocked(confirmAction).mockResolvedValueOnce(true)
    await send.trigger('click')
    await flushPromises()
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1)
    expect(bridgeMocks.sendFiles).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'chat', targetName: 'card.png' })],
      'copy',
      expect.any(Function),
      { signal: expect.any(AbortSignal) },
    )
  })
})

describe('TavernBridgeCenter 的作者小工具入口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'idle',
      detail: '等待酒馆扩展',
      pairCode: '',
      tavernOrigin: '',
      bridgeVersion: '',
    })
    bridgeMocks.listResources.mockResolvedValue([])
    bridgeMocks.pullResources.mockResolvedValue([
      new File(['{}'], 'personas.json', { type: 'application/json' }),
    ])
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  afterEach(() => {
    assistantGuidance.value = undefined
    document.body.innerHTML = ''
  })

  it('assistant navigation directly opens the extension installation guide', async () => {
    startAssistantGuidance('tavern-transfer-install', 'tavernBridge')
    const wrapper = render()
    await flushPromises()
    expect(wrapper.get('.tavern-bridge-install').attributes('data-assistant-focus')).toBe(
      'tavern-transfer-install-content',
    )
    expect(wrapper.text()).toContain('Install Extension')
    expect(wrapper.text()).toContain('酒馆资源库互传')
  })

  it('在酒馆互传内容之后提供其他小工具入口，并展示三个已发布项目', async () => {
    const wrapper = render()
    const trigger = wrapper.get('.tavern-bridge-author-tools > button')

    expect(trigger.text()).toBe('查看其他小工具')
    await trigger.trigger('click')

    expect(document.body.textContent).toContain('聊天重载保护器')
    expect(document.body.textContent).toContain('场景切换器')
    expect(document.body.textContent).toContain('角色世界书')
    expect(document.body.textContent).toContain('每个项目独立维护与发布')
  })

  it('角色世界书详情指向可由酒馆直接安装的公开仓库', async () => {
    const wrapper = render()
    await wrapper.get('.tavern-bridge-author-tools > button').trigger('click')
    const characterLorebookButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.author-tools-dialog__list button'),
    ).find((button) => button.parentElement?.textContent?.includes('角色世界书'))
    expect(characterLorebookButton).toBeDefined()
    await characterLorebookButton!.click()
    await flushPromises()

    const repository = 'https://github.com/jixiangruyi117/SillyTavern-CharacterLorebooks'
    expect(document.body.querySelector(`a[href="${repository}"]`)).not.toBeNull()
    expect(document.body.textContent).toContain('不移动或改写世界书文件')
  })

  it('详情显示准确的 GitHub 地址，并支持一键复制', async () => {
    const wrapper = render()
    await wrapper.get('.tavern-bridge-author-tools > button').trigger('click')
    await document.body
      .querySelectorAll<HTMLButtonElement>('.author-tools-dialog__list button')[0]!
      .click()
    await flushPromises()

    const repository = 'https://github.com/jixiangruyi117/SillyTavern-ChatReloadGuard'
    expect(document.body.querySelector(`a[href="${repository}"]`)).not.toBeNull()
    expect(document.body.textContent).toContain('当前已审计支持 SillyTavern 1.18.0。')

    const copyButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('.author-tool-detail__actions button'),
    )[0]!
    await copyButton.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(repository)
    expect(copyButton.textContent).toBe('已复制地址')
  })

  it('关闭弹窗后把焦点还给入口按钮', async () => {
    const wrapper = render()
    const trigger = wrapper.get('.tavern-bridge-author-tools > button')
    await trigger.trigger('click')
    await document.body
      .querySelector<HTMLButtonElement>('.author-tools-dialog__header > button')!
      .click()
    await flushPromises()

    expect(document.activeElement).toBe(trigger.element)
  })

  it('重新进入互传页时恢复现有连接并提供手动断开入口', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接酒馆页面扩展',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.24',
    })
    bridgeMocks.listResources.mockResolvedValue([])

    const wrapper = render()
    await flushPromises()

    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(1)
    const disconnectButton = Array.from(wrapper.findAll('button')).find(
      (button) => button.text() === '断开连接',
    )
    expect(disconnectButton).toBeDefined()
    await wrapper.get('.tavern-bridge-connection-tools summary').trigger('click')
    await disconnectButton!.trigger('click')

    expect(bridgeMocks.disconnect).toHaveBeenCalledWith('已手动断开酒馆连接')
  })

  it('离开再进入保留上次目录，只有点击刷新目录才重新提取', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.31',
    })
    bridgeMocks.listResources.mockResolvedValue([
      { id: 'theme:one', kind: 'theme', name: '旧快照', fileName: 'one.json', detail: '' },
    ])
    const first = render()
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(1)
    first.unmount()
    const second = render()
    await flushPromises()
    expect(second.text()).toContain('旧快照')
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(1)
    expect(
      second.findAll('button').filter((button) => button.text().includes('刷新目录')),
    ).toHaveLength(1)
    await second
      .findAll('button')
      .find((button) => button.text().includes('刷新目录'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(2)
  })

  it('loads saved chats only on request and retains the other resource inventory', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.36-chat.1',
      capabilities: ['chat-archive-v1'],
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue([
      { id: 'theme:one', kind: 'theme', name: '保留主题', fileName: 'one.json', detail: '' },
    ])
    const wrapper = render()
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenCalledTimes(1)
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'chat:one',
        kind: 'chat',
        name: '雨夜',
        fileName: '雨夜.srlchat',
        detail: '陆沉 · 随附角色卡',
        sizeLabel: '2.50 MB',
      },
    ])
    await wrapper
      .findAll('.tavern-bridge-type-filter button')
      .find((button) => button.text().includes('聊天记录'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.listResources).toHaveBeenLastCalledWith('chat')
    expect(wrapper.text()).toContain('雨夜')
    expect(wrapper.text()).toContain('随附角色卡')
    expect(wrapper.text()).toContain('2.50 MB')
    expect(tavernConnectionStore.getSnapshot().inventory).toHaveLength(2)
  })

  it('shows explicit avatar choices only for selected personas and gates old Bridge versions', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接酒馆页面扩展',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.30',
    })
    const personaSummary = resource({ type: RESOURCE_TYPE.USER_PERSONA, fileName: 'personas.json' })
    const wrapper = mountBridge({
      attachTo: document.body,
      props: {
        resources: [personaSummary],
        initialKind: 'userPersona',
        initialLocalIds: [personaSummary.id],
      },
    })
    mountedWrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain('发送设置')
    expect(wrapper.text()).toContain('默认封面 · 可选')
    expect(
      wrapper
        .find('.tavern-bridge-send-options')
        .element.compareDocumentPosition(wrapper.find('.tavern-bridge-resource-grid').element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect((wrapper.find('input[value="none"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.find('input[value="missing"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('传送封面需要更新酒馆互传扩展')
    expect(bridgeMocks.sendFiles).not.toHaveBeenCalled()
  })

  it('双向资源使用紧凑卡片，并可只查看当前已选项', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接酒馆页面扩展',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.27',
    })
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'character:one',
        kind: 'character',
        name: '酒馆角色',
        fileName: '角色.png',
        detail: '',
      },
      { id: 'theme:one', kind: 'theme', name: '酒馆主题', fileName: '主题.json', detail: '' },
    ] as TavernResourceItem[])
    const wrapper = mountBridge({
      attachTo: document.body,
      props: {
        resources: [
          resource({}),
          resource({
            id: 'local-2',
            name: '本地主题',
            fileName: '主题.json',
            type: RESOURCE_TYPE.BEAUTIFICATION,
            metadata: { detectedVariant: 'theme' },
          }),
        ],
      },
    })
    mountedWrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(2)
    expect(wrapper.text()).toContain('角色卡')
    await wrapper.findAll('.tavern-bridge-resource-card')[0].trigger('click')
    expect(wrapper.findAll('.tavern-bridge-resource-card')[0].attributes('aria-pressed')).toBe(
      'true',
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('只看已选'))!
      .trigger('click')
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(1)

    await wrapper.findAll('.tavern-bridge-tabs button')[1].trigger('click')
    expect(wrapper.findAll('.tavern-bridge-resource-card')).toHaveLength(2)
    const selectAll = wrapper.findAll('.tavern-bridge-selectbar button')[0]
    expect(selectAll.text()).toBe('全选当前结果')
    await selectAll.trigger('click')
    expect(selectAll.text()).toBe('取消当前全选')
    expect(
      wrapper
        .findAll('.tavern-bridge-resource-card')
        .every((card) => card.attributes('aria-pressed') === 'true'),
    ).toBe(true)
    await selectAll.trigger('click')
    expect(selectAll.text()).toBe('全选当前结果')
  })
})

describe('用户人设共用互传通道', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.11',
      capabilities: ['catalog-kind-filter-v1'],
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'persona:all',
        kind: 'userPersona',
        name: '酒馆人设',
        fileName: 'personas.json',
        detail: '',
      },
    ])
    bridgeMocks.pullResources.mockResolvedValue([
      new File(['{}'], 'personas.json', { type: 'application/json' }),
    ])
  })
  it('sends a saved persona as userPersona JSON without uploading cover attachments', async () => {
    const local = resource({
      id: 'persona-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      name: '本地人设',
      fileName: 'personas.json',
      relatedResourceIds: ['private-cover'],
    })
    const json = JSON.stringify({
      personas: { 'one.png': '本地人设' },
      persona_descriptions: { 'one.png': { description: '测试' } },
    })
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      originalBlob: new Blob([json], { type: 'application/json' }),
      mimeType: 'application/json',
    } as Awaited<ReturnType<typeof resourceService.get>>)
    const w = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    expect(w.text()).toContain('本地人设')
    const send = w.findAll('.tavern-bridge__sticky-action').find((b) => b.text().includes('发送'))
    expect(send).toBeDefined()
    await send!.trigger('click')
    await flushPromises()
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1)
    const [files, policy] = bridgeMocks.sendFiles.mock.calls[0] as unknown as [
      Array<{ file: File; kind: string }>,
      string,
    ]
    expect(policy).toBe('skip')
    expect(files).toHaveLength(1)
    expect(files[0]!.kind).toBe('userPersona')
    expect(JSON.parse(await files[0]!.file.text())).toEqual(JSON.parse(json))
    expect(bridgeMocks.listResources).not.toHaveBeenCalledWith('character', expect.anything())
    w.unmount()
  })

  function personaWithVariants(
    variants: Record<string, unknown>,
    bindings: Record<string, unknown>,
  ) {
    const persona = resource({
      id: 'persona-variant-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      name: '分角色人设',
      fileName: 'persona.json',
    })
    const backup = {
      personas: { 'persona.png': '分角色人设' },
      persona_descriptions: {
        'persona.png': {
          description: '全局设定',
          connections: [],
          srl_persona_character_bindings: bindings,
          srl_persona_profile: {
            version: 1,
            sections: [{ id: 'base', name: '基础设定', text: '全局设定' }],
            variants,
          },
        },
      },
    }
    return {
      persona,
      backup,
      full: {
        ...persona,
        originalBlob: new Blob([JSON.stringify(backup)], { type: 'application/json' }),
        mimeType: 'application/json',
      },
    }
  }

  function roleCard(id: string, name: string, fileName: string, contentHash: string) {
    const summary = resource({
      id,
      type: RESOURCE_TYPE.CHARACTER_CARD,
      name,
      fileName,
      contentHash,
      mimeType: 'image/png',
    })
    return {
      summary,
      full: {
        ...summary,
        originalBlob: new Blob([`png:${name}`], { type: 'image/png' }),
        mimeType: 'image/png',
      },
    }
  }

  it('通过卡片哈希匹配酒馆已有 char 并自动映射角色专属人设', async () => {
    const remoteCardFile = new File(['same-card-bytes'], 'tavern-card.png', { type: 'image/png' })
    const hash = await hashBlob(remoteCardFile)
    const { persona, full } = personaWithVariants(
      { 'source-card.png': { defaultVersionId: 'v1', versions: { v1: { name: '雨夜' } } } },
      { 'source-card.png': { avatar: 'source-card.png', name: '雨夜侦探', hash } },
    )
    bridgeMocks.listResources.mockImplementation(async (kind) =>
      kind === 'character'
        ? [
            ...Array.from({ length: 1500 }, (_, index) => ({
              id: `character:noise-${index}.png`,
              kind: 'character' as const,
              name: `无关角色 ${index}`,
              fileName: `noise-${index}.png`,
              detail: '',
            })),
            {
              id: 'character:tavern-card.png',
              kind: 'character' as const,
              name: '雨夜侦探',
              fileName: 'tavern-card.png',
              detail: '',
            },
          ]
        : [],
    )
    bridgeMocks.pullResources.mockResolvedValueOnce([remoteCardFile])
    vi.mocked(resourceService.get).mockResolvedValue(
      full as Awaited<ReturnType<typeof resourceService.get>>,
    )
    const w = mountBridge({
      props: { resources: [persona], initialLocalIds: [persona.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((button) => button.text().includes('发送'))!
      .trigger('click')
    await flushPromises()

    await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalled())
    expect(chooseAction).not.toHaveBeenCalled()
    const [files] = bridgeMocks.sendFiles.mock.calls.at(-1) as unknown as [
      Array<{ kind: string; file: File }>,
    ]
    expect(files[0]!.kind).toBe('userPersona')
    const descriptor = JSON.parse(await files[0]!.file.text()).persona_descriptions['persona.png']
    expect(descriptor.description).toBe('全局设定')
    expect(descriptor.connections).toEqual([])
    expect(descriptor.srl_persona_profile.variants).toHaveProperty('tavern-card.png')
    expect(descriptor.srl_persona_profile.variants).not.toHaveProperty('source-card.png')
  })

  it('拒绝补传缺少的 char 时只传酒馆已有角色卡对应的专属人设', async () => {
    const existingHash = 'a'.repeat(64)
    const missingHash = 'b'.repeat(64)
    const { persona, full } = personaWithVariants(
      {
        'existing.png': { defaultVersionId: 'v1', versions: { v1: { name: '现有设定' } } },
        'missing.png': { defaultVersionId: 'v1', versions: { v1: { name: '缺卡设定' } } },
      },
      {
        'existing.png': { avatar: 'existing.png', name: '现有角色', hash: existingHash },
        'missing.png': { avatar: 'missing.png', name: '缺失角色', hash: missingHash },
      },
    )
    const missingCard = roleCard('role-card', '缺失角色', 'missing.png', missingHash)
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'character:existing.png',
        kind: 'character',
        name: '现有角色',
        fileName: 'existing.png',
        contentHash: existingHash,
        detail: '',
      },
    ])
    vi.mocked(chooseAction).mockResolvedValue('alternative')
    vi.mocked(resourceService.get).mockImplementation(async (id) =>
      id === persona.id
        ? (full as Awaited<ReturnType<typeof resourceService.get>>)
        : (missingCard.full as Awaited<ReturnType<typeof resourceService.get>>),
    )
    const w = mountBridge({
      props: {
        resources: [persona, missingCard.summary],
        initialLocalIds: [persona.id],
        initialKind: 'userPersona',
      },
    })
    mountedWrappers.push(w)
    await flushPromises()
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((button) => button.text().includes('发送'))!
      .trigger('click')
    await flushPromises()

    expect(chooseAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '酒馆缺少角色卡',
        message: expect.stringContaining('缺失角色'),
      }),
    )
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1)
    const [files] = bridgeMocks.sendFiles.mock.calls[0] as unknown as [
      Array<{ kind: string; file: File }>,
    ]
    expect(files[0]!.kind).toBe('userPersona')
    const descriptor = JSON.parse(await files[0]!.file.text()).persona_descriptions['persona.png']
    expect(descriptor.srl_persona_profile.variants).toHaveProperty('existing.png')
    expect(descriptor.srl_persona_profile.variants).not.toHaveProperty('missing.png')
    expect(descriptor.description).toBe('全局设定')
  })

  it('酒馆没有任何匹配 char 且拒绝补传时只传全局设定', async () => {
    const hash = 'c'.repeat(64)
    const { persona, full } = personaWithVariants(
      { 'missing.png': { defaultVersionId: 'v1', versions: { v1: { name: '缺卡设定' } } } },
      { 'missing.png': { avatar: 'missing.png', name: '缺失角色', hash } },
    )
    bridgeMocks.listResources.mockResolvedValue([])
    vi.mocked(chooseAction).mockResolvedValue('alternative')
    vi.mocked(resourceService.get).mockResolvedValue(
      full as Awaited<ReturnType<typeof resourceService.get>>,
    )
    const w = mountBridge({
      props: { resources: [persona], initialLocalIds: [persona.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((button) => button.text().includes('发送'))!
      .trigger('click')
    await flushPromises()

    const [files] = bridgeMocks.sendFiles.mock.calls[0] as unknown as [Array<{ file: File }>]
    const descriptor = JSON.parse(await files[0]!.file.text()).persona_descriptions['persona.png']
    expect(descriptor.description).toBe('全局设定')
    expect(descriptor.srl_persona_profile.sections[0].text).toBe('全局设定')
    expect(descriptor.srl_persona_profile.variants).toEqual({})
  })

  it('用户同意补传时先导入角色卡，再导入该卡专属人设', async () => {
    const hash = 'd'.repeat(64)
    const { persona, full } = personaWithVariants(
      { 'traveler.png': { defaultVersionId: 'v1', versions: { v1: { name: '同行' } } } },
      { 'traveler.png': { avatar: 'traveler.png', name: '旅行者', hash } },
    )
    const card = roleCard('role-card', '旅行者', 'traveler.png', hash)
    card.full.originalBlob = new Blob([JSON.stringify(card.full.metadata.card)], {
      type: 'application/json',
    })
    card.full.fileName = 'traveler.json'
    card.full.mimeType = 'application/json'
    card.full.metadata.characterContentEdits = [
      {
        id: 'saved',
        section: 'greeting',
        targetKey: 'primary',
        before: '原开场白',
        after: '补传的修改内容',
        operation: 'update',
        label: '开场白',
        migrateToVersions: false,
        updatedAt: 1,
      },
    ]
    bridgeMocks.listResources.mockResolvedValue([])
    vi.mocked(chooseAction).mockResolvedValue('confirm')
    vi.mocked(resourceService.get).mockImplementation(async (id) =>
      id === persona.id
        ? (full as Awaited<ReturnType<typeof resourceService.get>>)
        : (card.full as Awaited<ReturnType<typeof resourceService.get>>),
    )
    const w = mountBridge({
      props: {
        resources: [persona, card.summary],
        initialLocalIds: [persona.id],
        initialKind: 'userPersona',
      },
    })
    mountedWrappers.push(w)
    await flushPromises()
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((button) => button.text().includes('发送'))!
      .trigger('click')
    await flushPromises()

    await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(2))
    const calls = bridgeMocks.sendFiles.mock.calls as unknown as Array<
      [Array<{ kind: string; file: File }>, string]
    >
    expect(calls[0]![0][0]!.kind).toBe('character')
    expect(calls[0]![0][0]!.file.name).toBe('traveler.png')
    expect(
      (await new PngResourceParser().parse(calls[0]![0][0]!.file)).metadata.card,
    ).toMatchObject({ data: { first_mes: '补传的修改内容' } })
    expect(calls[0]![1]).toBe('skip')
    expect(calls[1]![0][0]!.kind).toBe('userPersona')
    const descriptor = JSON.parse(await calls[1]![0][0]!.file.text()).persona_descriptions[
      'persona.png'
    ]
    expect(descriptor.srl_persona_profile.variants).toHaveProperty('traveler.png')
  })

  it('checks the cached default cover and uploads it before the persona only when selected', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.30',
      capabilities: ['persona-avatar-check-v1'],
    } as ReturnType<typeof bridgeMocks.getState>)
    vi.mocked(confirmAction).mockResolvedValue(true)
    const local = resource({
      id: 'persona-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      fileName: 'personas.json',
      relatedResourceIds: ['cover'],
    })
    vi.mocked(resourceService.get).mockImplementation(async (id) =>
      id === 'cover'
        ? ({
            ...resource({ id: 'cover', type: RESOURCE_TYPE.USER_PERSONA }),
            metadata: { assetKind: 'userPersonaAvatar', avatarId: 'one.png' },
            originalBlob: new Blob(['png'], { type: 'image/png' }),
          } as Awaited<ReturnType<typeof resourceService.get>>)
        : ({
            ...local,
            originalBlob: new Blob(
              [
                JSON.stringify({
                  personas: { 'one.png': '本地人设' },
                  persona_descriptions: { 'one.png': { description: '测试' } },
                  default_persona: 'one.png',
                }),
              ],
              { type: 'application/json' },
            ),
            mimeType: 'application/json',
          } as Awaited<ReturnType<typeof resourceService.get>>),
    )
    const w = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    expect(w.find('input[value="missing"]').attributes('disabled')).toBeUndefined()
    expect((w.get('input[value="missing"]').element as HTMLInputElement).checked).toBe(true)
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((b) => b.text().includes('发送'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.checkUserAvatarIds).toHaveBeenCalledWith(['one.png'], {
      signal: expect.any(AbortSignal),
    })
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({ title: '核对人设封面传送' }),
    )
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(2)
    const sendCalls = bridgeMocks.sendFiles.mock.calls as unknown as Array<
      [Array<{ kind: string }>, string]
    >
    expect(sendCalls[0]?.[0]?.[0]?.kind).toBe('userAvatar')
    expect(sendCalls[0]?.[1]).toBe('skip')
    expect(sendCalls[1]?.[0]?.[0]?.kind).toBe('userPersona')
    w.unmount()
  })

  it('人设缺少已缓存封面时默认仍发送 JSON，明确显示仅传人设', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.31',
      capabilities: ['persona-avatar-check-v1', 'catalog-kind-filter-v1'],
    } as ReturnType<typeof bridgeMocks.getState>)
    const local = resource({
      id: 'persona-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      fileName: 'personas.json',
    })
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      originalBlob: new Blob(
        [
          JSON.stringify({
            personas: { 'one.png': '本地人设' },
            persona_descriptions: { 'one.png': {} },
          }),
        ],
        { type: 'application/json' },
      ),
      mimeType: 'application/json',
    } as Awaited<ReturnType<typeof resourceService.get>>)
    const w = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    expect((w.get('input[value="missing"]').element as HTMLInputElement).checked).toBe(true)
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((b) => b.text().includes('发送'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('没有已缓存封面；仅传人设')
  })

  it('发送前核对酒馆内容时锁定发送按钮，防止重复提交', async () => {
    let finishList: ((items: TavernResourceItem[]) => void) | undefined
    const local = resource({
      id: 'persona-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      fileName: 'personas.json',
    })
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      originalBlob: new Blob(
        [
          JSON.stringify({
            personas: { 'one.png': '本地人设' },
            persona_descriptions: { 'one.png': {} },
          }),
        ],
        { type: 'application/json' },
      ),
      mimeType: 'application/json',
    } as Awaited<ReturnType<typeof resourceService.get>>)
    const w = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    bridgeMocks.listResources.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve
        }),
    )
    const send = w.findAll('.tavern-bridge__sticky-action').find((b) => b.text().includes('发送'))!
    await send.trigger('click')
    expect(send.attributes('disabled')).toBeDefined()
    await send.trigger('click')
    await vi.waitFor(() => expect(finishList).toBeDefined())
    finishList?.([])
    await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1))
  })

  it('同头像键但内容变化时可另存为新的人设，并将缓存封面跟随新键发送', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
      bridgeVersion: '0.3.31',
      capabilities: ['persona-avatar-check-v1'],
    } as ReturnType<typeof bridgeMocks.getState>)
    bridgeMocks.listResources.mockResolvedValue([
      {
        id: 'userPersona:one.png',
        kind: 'userPersona',
        name: '旧名',
        fileName: 'personas.json',
        detail: '',
      },
    ])
    bridgeMocks.pullResources.mockResolvedValue([
      new File(
        [
          JSON.stringify({
            personas: { 'one.png': '旧名' },
            persona_descriptions: { 'one.png': { description: '旧内容' } },
          }),
        ],
        'personas.json',
        { type: 'application/json' },
      ),
    ])
    vi.mocked(chooseAction).mockResolvedValue('confirm')
    vi.mocked(confirmAction).mockResolvedValue(true)
    const local = resource({
      id: 'persona-local',
      type: RESOURCE_TYPE.USER_PERSONA,
      fileName: 'personas.json',
      relatedResourceIds: ['cover'],
    })
    vi.mocked(resourceService.get).mockImplementation(async (id) =>
      id === 'cover'
        ? ({
            ...resource({ id: 'cover', type: RESOURCE_TYPE.USER_PERSONA }),
            metadata: { assetKind: 'userPersonaAvatar', avatarId: 'one.png' },
            originalBlob: new Blob(['png'], { type: 'image/png' }),
          } as Awaited<ReturnType<typeof resourceService.get>>)
        : ({
            ...local,
            originalBlob: new Blob(
              [
                JSON.stringify({
                  personas: { 'one.png': '新名' },
                  persona_descriptions: { 'one.png': { description: '新内容' } },
                  default_persona: 'one.png',
                }),
              ],
              { type: 'application/json' },
            ),
            mimeType: 'application/json',
          } as Awaited<ReturnType<typeof resourceService.get>>),
    )
    const w = mountBridge({
      props: { resources: [local], initialLocalIds: [local.id], initialKind: 'userPersona' },
    })
    mountedWrappers.push(w)
    await flushPromises()
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((b) => b.text().includes('发送'))!
      .trigger('click')
    await vi.waitFor(() =>
      expect(chooseAction).toHaveBeenCalledWith(
        expect.objectContaining({ title: '酒馆人设已有不同内容' }),
      ),
    )
    expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(2)
    const sendCalls = bridgeMocks.sendFiles.mock.calls as unknown as Array<
      [Array<{ kind: string; targetName?: string; file: File }>, string]
    >
    const avatar = sendCalls[0]![0][0]!
    const persona = sendCalls[1]![0][0]!
    expect(avatar.kind).toBe('userAvatar')
    expect(avatar.targetName).toMatch(/^persona-[a-f0-9-]{36}\.png$/u)
    expect(persona.kind).toBe('userPersona')
    const copied = JSON.parse(await persona.file.text()) as {
      personas: Record<string, string>
      default_persona?: string
    }
    expect(copied.personas[avatar.targetName!]).toBe(local.name)
    expect(copied.default_persona).toBeUndefined()
  })

  it('接收进行中仍可点击断开连接', async () => {
    let finishPull: ((files: File[]) => void) | undefined
    bridgeMocks.pullResources.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPull = resolve
        }),
    )
    const w = mountBridge({ props: { resources: [], initialKind: 'userPersona' } })
    mountedWrappers.push(w)
    await flushPromises()
    await w.get('.tavern-bridge-resource-card').trigger('click')
    await w
      .findAll('.tavern-bridge__sticky-action')
      .find((b) => b.text().includes('取回'))!
      .trigger('click')
    await flushPromises()
    const disconnect = w.findAll('button').find((button) => button.text() === '断开连接')!
    expect(disconnect.attributes('disabled')).toBeUndefined()
    await disconnect.trigger('click')
    expect(bridgeMocks.disconnect).toHaveBeenCalledWith('已手动断开酒馆连接')
    finishPull?.([])
    await flushPromises()
  })
  it('filters received personas and hands the real file to the existing importer', async () => {
    const w = mountBridge({ props: { resources: [], initialKind: 'userPersona' } })
    mountedWrappers.push(w)
    await flushPromises()
    expect(w.findAll('.tavern-bridge-resource-card')).toHaveLength(1)
    await w.get('.tavern-bridge-resource-card').trigger('click')
    const pull = w.findAll('.tavern-bridge__sticky-action').find((b) => b.text().includes('取回'))
    expect(pull).toBeDefined()
    await pull!.trigger('click')
    await flushPromises()
    expect(bridgeMocks.pullResources).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'userPersona' })],
      { signal: expect.any(AbortSignal) },
    )
    expect(w.emitted('import-files')?.[0]?.[0]).toEqual([
      expect.objectContaining({ name: 'personas.json' }),
    ])
    w.unmount()
  })
})

describe('bridge send content preference', () => {
  it('keeps version settings without automatic script-source selection', async () => {
    bridgeMocks.getState.mockReturnValue({
      status: 'idle',
      detail: '未连接',
      pairCode: '',
      tavernOrigin: '',
      bridgeVersion: '',
    })
    tavernConnectionStore.clearInventory()
    vi.clearAllMocks()
    const wrapper = render()
    const button = wrapper.get('button[aria-label="酒馆互传设置"]')
    await button.trigger('click')
    const dialog = transferSettings()
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.find('input[role="switch"]').exists()).toBe(true)
    await dialog.get('input[role="switch"]').setValue(false)
    expect(browserStorageService.setTavernChatCarryScripts).toHaveBeenLastCalledWith(false)
    expect(dialog.text()).toContain('仅携带角色脚本')
    expect(bridgeMocks.listResources).not.toHaveBeenCalled()
    await dialog
      .findAll('button')
      .find((b) => b.text() === '原版')!
      .trigger('click')
    expect(browserStorageService.setTavernSendContent).toHaveBeenLastCalledWith('original')
    expect(button.attributes('title')).toBe('发送原版')
    await dialog
      .findAll('button')
      .find((b) => b.text() === '修改版')!
      .trigger('click')
    expect(browserStorageService.setTavernSendContent).toHaveBeenLastCalledWith('modified')
    await dialog.get('[aria-label="关闭互传设置"]').trigger('click')
    expect((dialog.element as HTMLDialogElement).open).toBe(false)
    await button.trigger('click')
    expect(dialog.find('.tavern-bridge-chat-scripts').exists()).toBe(false)
  })
  it.each([
    ['modified', 'relay'],
    ['original', 'relay'],
    ['modified', 'directory'],
    ['original', 'directory'],
  ] as const)('sends %s bytes through %s using the existing bridge', async (content, transport) => {
    vi.clearAllMocks()
    vi.mocked(confirmAction).mockResolvedValue(true)
    tavernConnectionStore.clearInventory()
    bridgeMocks.listResources.mockResolvedValue([])
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.39',
      capabilities: [],
      transport,
    } as ReturnType<typeof bridgeMocks.getState>)
    const local = resource({ fileName: 'card.json' })
    const raw = JSON.stringify(local.metadata.card)
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      mimeType: 'application/json',
      originalBlob: new Blob([raw]),
    } as Awaited<ReturnType<typeof resourceService.get>>)
    const wrapper = mountBridge({ props: { resources: [local], initialLocalIds: [local.id] } })
    mountedWrappers.push(wrapper)
    if (content === 'original') {
      await flushPromises()
      await wrapper.find('button[aria-label="酒馆互传设置"]').trigger('click')
      await transferSettings()
        .findAll('button')
        .find((b) => b.text() === '原版')!
        .trigger('click')
      await transferSettings().get('[aria-label="关闭互传设置"]').trigger('click')
      await flushPromises()
    }
    await wrapper
      .findAll('.tavern-bridge-tabs button')
      .find((button) => button.text().includes('发送到酒馆'))!
      .trigger('click')
    await wrapper.find('.tavern-bridge__sticky-action').trigger('click')
    await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(1))
    const [files] = bridgeMocks.sendFiles.mock.calls[0] as unknown as [Array<{ file: File }>]
    expect(files[0]!.file.name).toBe(content === 'original' ? 'card.json' : 'card.png')
    if (content === 'original') expect(await files[0]!.file.text()).toBe(raw)
    else expect(files[0]!.file.type).toBe('image/png')
    await flushPromises()
  })
})
it.each(['version', 'tags'])(
  'changes operation identity when a failed send is retried with another %s choice',
  async (choice) => {
    vi.mocked(browserStorageService.getModifiedResourceSyncTags).mockReturnValue(false)
    vi.clearAllMocks()
    tavernConnectionStore.clearInventory()
    bridgeMocks.listResources.mockResolvedValue([])
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://tavern.test',
      bridgeVersion: '0.3.39',
      capabilities: [],
      transport: 'relay',
    } as ReturnType<typeof bridgeMocks.getState>)
    const local = resource({ fileName: 'card.json' })
    vi.mocked(resourceService.get).mockResolvedValue({
      ...local,
      mimeType: 'application/json',
      originalBlob: new Blob([JSON.stringify(local.metadata.card)]),
    } as Awaited<ReturnType<typeof resourceService.get>>)
    bridgeMocks.sendFiles.mockRejectedValueOnce(new Error('fixture failure'))
    const wrapper = mountBridge({ props: { resources: [local], initialLocalIds: [local.id] } })
    mountedWrappers.push(wrapper)
    await wrapper
      .findAll('.tavern-bridge-tabs button')
      .find((button) => button.text().includes('发送到酒馆'))!
      .trigger('click')
    await wrapper.find('.tavern-bridge__sticky-action').trigger('click')
    await vi.waitFor(() =>
      expect(wrapper.findAll('button').some((b) => b.text().includes('重试 1'))).toBe(true),
    )
    const first = (
      bridgeMocks.sendFiles.mock.calls[0] as unknown as [Array<{ file: File; operationId: string }>]
    )[0][0]!
    expect(first.file.name).toBe('card.png')
    if (choice === 'version') {
      await wrapper.find('button[aria-label="酒馆互传设置"]').trigger('click')
      await transferSettings()
        .findAll('button')
        .find((b) => b.text() === '原版')!
        .trigger('click')
      await transferSettings().get('[aria-label="关闭互传设置"]').trigger('click')
    } else vi.mocked(browserStorageService.getModifiedResourceSyncTags).mockReturnValue(true)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('重试 1'))!
      .trigger('click')
    await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalledTimes(2))
    const second = (
      bridgeMocks.sendFiles.mock.calls[1] as unknown as [Array<{ file: File; operationId: string }>]
    )[0][0]!
    expect(second.file.name).toBe(choice === 'version' ? 'card.json' : 'card.png')
    expect(second.operationId).not.toBe(first.operationId)
    await flushPromises()
    vi.mocked(browserStorageService.getModifiedResourceSyncTags).mockReturnValue(false)
  },
)
it('keeps an original legacy draft operation identity when retrying original content', async () => {
  vi.clearAllMocks()
  tavernConnectionStore.clearInventory()
  bridgeMocks.listResources.mockResolvedValue([])
  bridgeMocks.getState.mockReturnValue({
    status: 'connected',
    detail: '已连接',
    pairCode: '',
    tavernOrigin: 'https://tavern.test',
    bridgeVersion: '0.3.39',
    capabilities: [],
    transport: 'relay',
  } as ReturnType<typeof bridgeMocks.getState>)
  const local = resource({ fileName: 'card.json' })
  const operationId = crypto.randomUUID()
  vi.mocked(browserStorageService.getTavernSendContent).mockReturnValueOnce('original')
  vi.mocked(browserStorageService.getBridgeTransferDraft).mockReturnValueOnce({
    direction: 'send',
    origin: 'https://tavern.test',
    policy: 'copy',
    at: Date.now(),
    items: [
      {
        key: local.id,
        name: local.name,
        label: '发送',
        status: 'failed',
        detail: 'legacy',
        operationId,
      },
    ],
  })
  vi.mocked(resourceService.get).mockResolvedValue({
    ...local,
    mimeType: 'application/json',
    originalBlob: new Blob([JSON.stringify(local.metadata.card)]),
  } as Awaited<ReturnType<typeof resourceService.get>>)
  const wrapper = mountBridge({ props: { resources: [local] } })
  mountedWrappers.push(wrapper)
  await flushPromises()
  await wrapper
    .findAll('button')
    .find((b) => b.text().includes('重试 1'))!
    .trigger('click')
  await vi.waitFor(() => expect(bridgeMocks.sendFiles).toHaveBeenCalledOnce())
  const sent = (
    bridgeMocks.sendFiles.mock.calls[0] as unknown as [Array<{ file: File; operationId: string }>]
  )[0][0]!
  expect(sent.file.name).toBe('card.json')
  expect(sent.operationId).toBe(operationId)
  await flushPromises()
})

it.each([true, false])(
  'restores the carry setting %s and requests only role scripts without extra selections',
  async (carryReadingScripts) => {
    vi.clearAllMocks()
    vi.mocked(browserStorageService.getTavernChatCarryScripts).mockReturnValueOnce(
      carryReadingScripts,
    )
    tavernConnectionStore.clearInventory()
    bridgeMocks.getState.mockReturnValue({
      status: 'connected',
      detail: '已连接',
      pairCode: '',
      tavernOrigin: 'https://chat-scripts.test',
      bridgeVersion: '0.3.57',
      capabilities: [
        'chat-archive-v1',
        'chat-reading-scripts-v1',
        'pull-cancel-v1',
        'pull-progress-v1',
      ],
    } as ReturnType<typeof bridgeMocks.getState>)
    const chat: TavernResourceItem = {
      id: 'chat:one',
      kind: 'chat',
      name: '雨夜',
      fileName: '雨夜.srlchat',
      detail: '',
    }
    bridgeMocks.listResources.mockImplementation(async (kind) => (kind === 'chat' ? [chat] : []))
    bridgeMocks.pullResources.mockResolvedValue([new File(['chat'], '雨夜.srlchat')])
    const wrapper = render()
    await flushPromises()
    await wrapper
      .findAll('.tavern-bridge-type-filter button')
      .find((b) => b.text().includes('聊天记录'))!
      .trigger('click')
    await flushPromises()
    await wrapper.get('[aria-label="酒馆互传设置"]').trigger('click')
    expect(transferSettings().find('.tavern-bridge-chat-scripts').exists()).toBe(false)
    expect(
      (transferSettings().get('[aria-label="聊天记录互传携带脚本"]').element as HTMLInputElement)
        .checked,
    ).toBe(carryReadingScripts)
    await wrapper.get('.tavern-bridge-resource-card').trigger('click')
    await wrapper
      .findAll('.tavern-bridge__sticky-action')
      .find((b) => b.text().includes('取回'))!
      .trigger('click')
    await flushPromises()
    expect(bridgeMocks.pullResources).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: chat.id,
          carryReadingScripts,
          readingScriptIds: [],
        }),
      ],
      { signal: expect.any(AbortSignal) },
    )
  },
)
