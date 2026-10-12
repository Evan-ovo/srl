import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { BRIDGE_EXTENSION_VERSION } from '../utils/BridgeInstall'
import { TavernBridgeService, TavernHttpRelayPort } from './TavernBridgeService'
import { LOCAL_TAVERN_RELAY_BASE } from './TavernHttpRelayPort'
import { tavernEnvelope } from './TavernBridgeProtocol'
import { createChatArchive, readChatArchive } from './TavernChatArchiveCodec.mjs'
import { hashBlob } from './HashService'
import { checkRelayWorker, saveRelayWorkerBaseUrl } from './RelayWorkerSettingsService'

interface BridgeServiceTestAccess {
  handlePortMessage(message: unknown): Promise<void>
  handleWindowMessage(event: MessageEvent): void
  relayOrigin: string
  relayWindow: Window
  incoming: Map<string, { received: number }>
}

describe('TavernBridgeService', () => {
  it('uses the verified direct download hash once and still rejects changed metadata', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener() {},
      removeEventListener() {},
      location: { href: 'https://srl.test/', origin: 'https://srl.test' },
    })
    const sha256 = await hashBlob(new Blob(['data']))
    const digest = vi.spyOn(crypto.subtle, 'digest')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : new Response('data', { headers: { 'x-srl-direct-sha256': sha256 } }),
      ),
    )
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['pull-cancel-v1', 'pull-progress-v1'],
      }),
    )
    const pending = service.pullResources([
      { id: 'theme:one', kind: 'theme', name: 'test', fileName: 'test.json', detail: '' },
    ])
    const requestId = port.postMessage.mock.calls.at(-1)![0].requestId
    const meta = {
      requestId,
      transferId: 'direct-file',
      direction: 'to-srl',
      name: 'test.json',
      size: 4,
      sha256,
      localDirectSession: {
        sessionId: 'session_123456',
        token: 'a'.repeat(32),
        origin: 'http://127.0.0.1:8000',
        maxFileSize: 1024,
      },
    }
    try {
      await access.handlePortMessage(tavernEnvelope('file-start', meta))
      await access.handlePortMessage(tavernEnvelope('file-end', meta))
      await access.handlePortMessage(tavernEnvelope('pull-complete', { requestId, completed: 1 }))
      expect(await (await pending)[0]!.text()).toBe('data')
      expect(digest).not.toHaveBeenCalled()
      await expect(
        access.handlePortMessage(tavernEnvelope('file-start', { ...meta, sha256: 'f'.repeat(64) })),
      ).rejects.toThrow('完整性')
    } finally {
      service.destroy()
      digest.mockRestore()
    }
  })
  it('requests chats only from a capable peer and receives their archive over the existing checked chunks', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      removeEventListener: vi.fn(),
      addEventListener: vi.fn(),
      location: { href: 'https://srl.test/', origin: 'https://srl.test' },
    })
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(tavernEnvelope('st-ready', { bridgeVersion: '0.3.35' }))
    await expect(service.listResources('chat')).rejects.toThrow('不支持聊天')
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['chat-archive-v1', 'catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      }),
    )
    const list = service.listResources('chat')
    const query = port.postMessage.mock.calls.at(-1)![0]
    expect(query.kind).toBe('chat')
    const item = {
      id: 'chat:fixture',
      kind: 'chat' as const,
      name: '夜雨',
      fileName: '夜雨.srlchat',
      detail: '随附角色卡',
    }
    await access.handlePortMessage(
      tavernEnvelope('list-response', { requestId: query.requestId, items: [item] }),
    )
    expect(await list).toEqual([item])
    const pending = service.pullResources([item])
    const requestId = port.postMessage.mock.calls.at(-1)![0].requestId
    const file = createChatArchive(
      new File(['png'], 'a.png'),
      new File(['原文'], '夜雨.jsonl'),
      'a.png',
    )
    const transferId = 'chat-transfer'
    await access.handlePortMessage(
      tavernEnvelope('file-start', {
        requestId,
        transferId,
        direction: 'to-srl',
        name: file.name,
        mimeType: file.type,
        kind: 'chat',
        size: file.size,
        sha256: await hashBlob(file),
      }),
    )
    await access.handlePortMessage(
      tavernEnvelope('file-chunk', {
        requestId,
        transferId,
        index: 0,
        data: await file.arrayBuffer(),
      }),
    )
    await access.handlePortMessage(tavernEnvelope('file-end', { requestId, transferId }))
    await access.handlePortMessage(tavernEnvelope('pull-complete', { requestId, completed: 1 }))
    expect(await (await readChatArchive((await pending)[0]!)).chat.text()).toBe('原文')
    service.destroy()
  })
  it('requests only characters from peers that support filtered catalogs and falls back for older peers', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      removeEventListener: vi.fn(),
      addEventListener: vi.fn(),
      location: { href: 'https://srl.test/', origin: 'https://srl.test' },
    })
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['catalog-pages-v1', 'catalog-kind-filter-v1'],
      }),
    )
    const filtered = service.listResources('character')
    const filteredRequest = port.postMessage.mock.calls.at(-1)![0]
    expect(filteredRequest.kind).toBe('character')
    await access.handlePortMessage(
      tavernEnvelope('list-response', { requestId: filteredRequest.requestId, items: [] }),
    )
    await expect(filtered).resolves.toEqual([])

    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['catalog-pages-v1'],
      }),
    )
    const fallback = service.listResources('character')
    const fallbackRequest = port.postMessage.mock.calls.at(-1)![0]
    expect(fallbackRequest.kind).toBeUndefined()
    await access.handlePortMessage(
      tavernEnvelope('list-response', { requestId: fallbackRequest.requestId, items: [] }),
    )
    await expect(fallback).resolves.toEqual([])
    service.destroy()
  })
  it('acknowledges identical repeated chunks without counting them twice and rejects invalid indices', async () => {
    const service = new TavernBridgeService()
    const access = service as unknown as BridgeServiceTestAccess & {
      port: { postMessage: () => void }
      incoming: Map<string, { received: number }>
    }
    access.port = { postMessage: () => {} }
    await access.handlePortMessage(
      tavernEnvelope('file-start', {
        requestId: 'pull',
        transferId: 'same',
        direction: 'to-srl',
        size: 3,
      }),
    )
    const chunk = tavernEnvelope('file-chunk', {
      requestId: 'pull',
      transferId: 'same',
      index: 0,
      data: new Uint8Array([1, 2, 3]).buffer,
    })
    await access.handlePortMessage(chunk)
    await access.handlePortMessage(chunk)
    expect(access.incoming.get('same')?.received).toBe(3)
    await expect(access.handlePortMessage({ ...chunk, index: -1 })).rejects.toThrow('序号')
    await expect(
      access.handlePortMessage({ ...chunk, data: new Uint8Array([9, 2, 3]).buffer }),
    ).rejects.toThrow('不一致')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports an actionable error when only the server plugin was updated', async () => {
    const service = new TavernBridgeService()

    await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
      tavernEnvelope('st-ready'),
    )

    expect(service.getState().status).toBe('error')
    expect(service.getState().detail).toContain('页面扩展版本过旧')
  })

  it('records the connected front-end extension version', async () => {
    const service = new TavernBridgeService()

    await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
      tavernEnvelope('st-ready', { bridgeVersion: BRIDGE_EXTENSION_VERSION }),
    )

    expect(service.getState()).toMatchObject({
      status: 'connected',
      bridgeVersion: BRIDGE_EXTENSION_VERSION,
    })
  })

  it('assembles large catalog pages in catalog order and refreshes the idle deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: 'https://srl.test/', origin: 'https://srl.test' },
    })
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      }),
    )

    const result = service.listResources()
    const request = port.postMessage.mock.calls.at(-1)![0]
    await vi.advanceTimersByTimeAsync(179_000)
    await access.handlePortMessage(
      tavernEnvelope('list-progress', { requestId: request.requestId }),
    )
    await vi.advanceTimersByTimeAsync(179_000)
    const first = {
      id: 'theme:first',
      kind: 'theme' as const,
      name: '第一项',
      fileName: '1.json',
      detail: '',
    }
    const second = {
      id: 'theme:second',
      kind: 'theme' as const,
      name: '第二项',
      fileName: '2.json',
      detail: '',
    }
    await access.handlePortMessage(
      tavernEnvelope('list-response', {
        requestId: request.requestId,
        pageIndex: 1,
        pageCount: 2,
        items: [second],
      }),
    )
    await access.handlePortMessage(
      tavernEnvelope('list-response', {
        requestId: request.requestId,
        pageIndex: 0,
        pageCount: 2,
        items: [first],
      }),
    )

    await expect(result).resolves.toEqual([first, second])
    service.destroy()
  })

  it('cancels timed-out pulls and deletes partial incoming data before rejecting', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: 'https://srl.test/', origin: 'https://srl.test' },
    })
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      }),
    )
    const pending = service.pullResources([
      {
        id: 'theme:slow',
        kind: 'theme',
        name: '慢主题',
        fileName: 'slow.json',
        detail: '',
      },
    ])
    const request = port.postMessage.mock.calls.at(-1)![0]
    await access.handlePortMessage(
      tavernEnvelope('file-start', {
        requestId: request.requestId,
        transferId: 'slow-transfer',
        direction: 'to-srl',
        name: 'slow.json',
        size: 3,
        sha256: 'unused',
      }),
    )
    await access.handlePortMessage(
      tavernEnvelope('file-chunk', {
        requestId: request.requestId,
        transferId: 'slow-transfer',
        index: 0,
        data: new Uint8Array([1, 2, 3]).buffer,
      }),
    )
    const rejected = expect(pending).rejects.toThrow('连续 120 秒没有进度')
    await vi.advanceTimersByTimeAsync(120_000)
    await rejected
    expect(access.incoming.size).toBe(0)
    expect(port.postMessage.mock.calls.map(([message]) => message.type)).toContain('pull-cancel')
    await access.handlePortMessage(
      tavernEnvelope('operation-error', {
        requestId: request.requestId,
        error: 'late cancel response',
      }),
    )
    expect(service.getState().status).toBe('connected')
    service.destroy()
  })

  it('cancels an outgoing transfer, rejects its chunk waiter, and tells the Tavern to clear staging', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: 'https://srl.example.test/', origin: 'https://srl.example.test' },
    })
    const service = new TavernBridgeService()
    const port = { postMessage: vi.fn(), close: vi.fn() }
    const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
    access.port = port
    await access.handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
      }),
    )
    const controller = new AbortController()
    const pending = service.sendFiles(
      [
        {
          file: new File(['pending payload'], 'pending.json', { type: 'application/json' }),
          kind: 'character',
          displayName: 'pending',
        },
      ],
      'copy',
      undefined,
      { signal: controller.signal },
    )
    await vi.waitFor(() => {
      expect(port.postMessage.mock.calls.some(([message]) => message.type === 'file-chunk')).toBe(
        true,
      )
    })
    controller.abort(new DOMException('已取消', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const messages = port.postMessage.mock.calls.map(([message]) => message.type)
    expect(messages).toContain('file-cancel')
    expect(messages).not.toContain('file-end')
    service.destroy()
  })

  it('round-trips an avatar existence check only with a capable connected Bridge', async () => {
    const service = new TavernBridgeService()
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      removeEventListener: vi.fn(),
      location: { href: 'https://srl.example.test/', origin: 'https://srl.example.test' },
    })
    const messages: Array<{ type: string; requestId?: string }> = []
    ;(
      service as unknown as { port: { postMessage: (message: unknown) => void; close: () => void } }
    ).port = {
      postMessage: (message) => messages.push(message as { type: string; requestId?: string }),
      close: () => undefined,
    }
    await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
      tavernEnvelope('st-ready', {
        bridgeVersion: BRIDGE_EXTENSION_VERSION,
        capabilities: ['persona-avatar-check-v1'],
      }),
    )
    const pending = service.checkUserAvatarIds(['one.png', 'two.png'])
    const request = messages.find((message) => message.type === 'persona-avatar-check-request')
    expect(request?.requestId).toBeTruthy()
    await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
      tavernEnvelope('persona-avatar-check-response', {
        requestId: request!.requestId,
        existingIds: ['one.png'],
      }),
    )
    expect(await pending).toEqual(new Set(['one.png']))
    service.destroy()
  })

  it('断开或中继故障会立即结束正在接收的请求，而不等待两分钟超时', async () => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: 'https://srl.example.test/', origin: 'https://srl.example.test' },
    })
    for (const failure of ['manual', 'relay'] as const) {
      const service = new TavernBridgeService()
      const port = { postMessage: vi.fn(), close: vi.fn() }
      ;(service as unknown as { port: typeof port }).port = port
      await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
        tavernEnvelope('st-ready', {
          bridgeVersion: BRIDGE_EXTENSION_VERSION,
          capabilities: ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1'],
        }),
      )
      const pending = service.pullResources([
        {
          id: 'userPersona:one.png',
          kind: 'userPersona',
          name: '人设',
          fileName: 'one.json',
          detail: '',
        },
      ])
      await Promise.resolve()
      if (failure === 'manual') service.disconnect('已手动断开酒馆连接')
      else
        (
          service as unknown as { failConnection(error: Error, detail: string): void }
        ).failConnection(new Error('设备码中继已关闭'), '设备码中继已断开')
      await expect(pending).rejects.toThrow(
        failure === 'manual' ? '已手动断开酒馆连接' : '设备码中继已关闭',
      )
      expect(port.close).toHaveBeenCalled()
      expect(service.getState().status).toBe(failure === 'manual' ? 'idle' : 'error')
      service.destroy()
    }
  })

  it('reports update instructions when the handshake extension version is behind', async () => {
    const service = new TavernBridgeService()

    await (service as unknown as BridgeServiceTestAccess).handlePortMessage(
      tavernEnvelope('st-ready', { bridgeVersion: '0.3.18' }),
    )

    expect(service.getState().status).toBe('error')
    expect(service.getState().detail).toContain(`资源库要求 ${BRIDGE_EXTENSION_VERSION}`)
    expect(service.getState().detail).toContain('请在酒馆扩展管理中点击更新')
    expect(service.getState().detail).toContain('重新下载最新离线包')
  })

  it('joins the HTTPS relay in the current resource-library page', async () => {
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=tavern-local-worker-fixture
    const values = new Map<string, string>([
      ['srl.publicWorker.baseUrl.v1', 'https://worker.example'],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    })
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=tavern-local-worker-fixture
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval,
      setTimeout,
      clearInterval,
      location: {
        origin: 'https://srl.example.test',
        href: 'https://srl.example.test/',
      },
    })
    const savedSettings = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => savedSettings.get(key) ?? null,
      setItem: (key: string, value: string) => savedSettings.set(key, value),
      removeItem: (key: string) => savedSettings.delete(key),
    })
    saveRelayWorkerBaseUrl('https://worker.example')
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            pairCode: '123456',
            participantToken: 'participant-token',
            relayBase: '/api/bridge/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const service = new TavernBridgeService()

    await service.joinSecureRelay('AB23CD45')

    expect(fetchMock).toHaveBeenCalledWith(
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=tavern-relay-test-worker-url
      'https://worker.example/api/bridge/join',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'AB23CD45' }),
      }),
    )
    // SRL-PUBLIC-SYNC: END REPLACE id=tavern-relay-test-worker-url
    expect(service.getState()).toMatchObject({
      status: 'pairing',
      pairCode: '123456',
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=tavern-relay-test-worker-origin
      tavernOrigin: 'https://worker.example',
      // SRL-PUBLIC-SYNC: END REPLACE id=tavern-relay-test-worker-origin
    })
    service.destroy()
  })

  it('requests an approved local Tavern connection without asking for a device code', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval,
      setTimeout,
      clearInterval,
      location: { href: 'https://srl.example.test/', origin: 'https://srl.example.test' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'csrf-test-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'AB23CD45',
            participantToken: 'a'.repeat(32),
            relayBase: '/api/plugins/srl-bridge/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const service = new TavernBridgeService()

    await service.connectLocalTavern()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8000/csrf-token',
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8000/api/plugins/srl-bridge/local-pair/requests',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test-token' },
      }),
    )
    expect(service.getState()).toMatchObject({
      status: 'discovering',
      pairCode: '',
      tavernOrigin: 'http://127.0.0.1:8000',
    })
    service.destroy()
  })

  it('explains when the local Tavern server plugin has not been updated', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval,
      setTimeout,
      clearInterval,
      location: { href: 'https://srl.example.test/', origin: 'https://srl.example.test' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ token: 'csrf-test-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 404 })),
    )
    const service = new TavernBridgeService()

    await expect(service.connectLocalTavern()).rejects.toThrow('服务端插件未安装或版本过旧')

    service.destroy()
  })

  it('keeps an active relay popup as transport instead of fetching local HTTP from HTTPS SRL', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval,
      setTimeout,
      clearInterval,
      location: { href: 'https://srl.example.test/' },
    })
    const service = new TavernBridgeService()
    const postMessage = vi.fn()
    const relayWindow = {
      closed: false,
      close: vi.fn(),
      postMessage,
    } as unknown as Window
    const access = service as unknown as BridgeServiceTestAccess
    access.relayWindow = relayWindow
    access.relayOrigin = 'http://127.0.0.1:8000'

    access.handleWindowMessage({
      data: tavernEnvelope('relay-invitation', {
        channel: 'relay-AB23CD45',
        pairCode: '123456',
        relayBase: 'http://127.0.0.1:8000/api/plugins/srl-bridge/',
        participantToken: 'temporary-token',
      }),
      origin: 'http://127.0.0.1:8000',
      source: relayWindow,
    } as MessageEvent)

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'srl-hello', channel: 'relay-AB23CD45' }),
      'http://127.0.0.1:8000',
    )
    expect(service.getState().status).toBe('discovering')
    service.destroy()
  })
})

describe('TavernHttpRelayPort', () => {
  it('validates the whole poll batch before sending ACKs with bounded concurrency', async () => {
    const port = new TavernHttpRelayPort('https://relay.example.test/', {
      code: 'AB23CD45',
      token: 'token',
    })
    const handled: number[] = []
    let polls = 0,
      active = 0,
      maximum = 0
    const access = port as unknown as {
      request: (
        path: string,
        body: { message?: { type: string; index: number }; acknowledgements?: string[] },
      ) => Promise<unknown>
      poll: () => Promise<void>
    }
    access.request = async (path, body) => {
      if (path === 'poll')
        return polls++
          ? { closed: true }
          : {
              messages: Array.from({ length: 12 }, (_, index) => ({ type: 'file-chunk', index })),
              deliveryIds: Array.from({ length: 12 }, (_, index) => `delivery-${index}`),
            }
      expect(body.message?.type).toBe('file-chunk-ack')
      expect(handled).toHaveLength(12)
      expect(body.acknowledgements).toEqual(
        Array.from({ length: 12 }, (_, index) => `delivery-${index}`),
      )
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    }
    port.onmessage = async ({ data }) => {
      const message = data as { index: number }
      handled.push(message.index)
      await port.postMessage({ type: 'file-chunk-ack', index: message.index })
    }
    await access.poll()
    expect(maximum).toBe(6)
    expect(handled).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

  it('sends the local Tavern CSRF token on native relay requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const port = new TavernHttpRelayPort(LOCAL_TAVERN_RELAY_BASE, {
      code: 'AB23CD45',
      token: 'temporary-token',
      csrfToken: 'local-csrf-token',
    })

    await port.postMessage(tavernEnvelope('file-start'))

    expect(fetchMock).toHaveBeenCalledWith(
      `${LOCAL_TAVERN_RELAY_BASE}messages`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-CSRF-Token': 'local-csrf-token' }),
      }),
    )
  })

  it('keeps control messages ordered but allows file chunks to fill the ACK window', async () => {
    let resolveControl: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveControl = resolve
          }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const port = new TavernHttpRelayPort('https://relay.example.test/', {
      code: 'AB23CD45',
      token: 'temporary-token',
    })

    const firstControl = port.postMessage(tavernEnvelope('file-start'))
    const secondControl = port.postMessage(tavernEnvelope('file-end'))
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const firstChunk = port.postFileChunk(tavernEnvelope('file-chunk', { index: 0 }))
    const secondChunk = port.postFileChunk(tavernEnvelope('file-chunk', { index: 1 }))
    expect(fetchMock).toHaveBeenCalledTimes(3)

    resolveControl?.(new Response(null, { status: 204 }))
    await Promise.all([firstControl, secondControl, firstChunk, secondChunk])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

it('gates optional chat scripts by peer capability and forwards selected sources on the existing request', async () => {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    removeEventListener: vi.fn(),
    addEventListener: vi.fn(),
    location: { href: 'https://srl.test/', origin: 'https://srl.test' },
  })
  const service = new TavernBridgeService()
  const port = {
    postMessage: vi.fn((message) => {
      structuredClone(message)
    }),
    close: vi.fn(),
  }
  const access = service as unknown as BridgeServiceTestAccess & { port: typeof port }
  access.port = port
  const capabilities = ['catalog-pages-v1', 'pull-cancel-v1', 'pull-progress-v1']
  await access.handlePortMessage(
    tavernEnvelope('st-ready', { bridgeVersion: BRIDGE_EXTENSION_VERSION, capabilities }),
  )
  const item = {
    id: 'chat:one',
    kind: 'chat' as const,
    name: '聊天',
    fileName: 'chat.srlchat',
    detail: '',
    readingScriptIds: reactive(['scriptGlobal:phone']),
  }
  await expect(service.pullResources([item])).rejects.toThrow('新版')
  await access.handlePortMessage(
    tavernEnvelope('st-ready', {
      bridgeVersion: BRIDGE_EXTENSION_VERSION,
      capabilities: [...capabilities, 'chat-reading-scripts-v1'],
    }),
  )
  await expect(
    service.pullResources([{ ...item, readingScriptIds: ['character:secret'] }]),
  ).rejects.toThrow('最多 8')
  const pending = service.pullResources([item])
  const request = port.postMessage.mock.calls.at(-1)![0]
  expect(request.items).toEqual([{ id: item.id, readingScriptIds: item.readingScriptIds }])
  await access.handlePortMessage(
    tavernEnvelope('pull-complete', { requestId: request.requestId, completed: 0 }),
  )
  expect(await pending).toEqual([])
  service.destroy()
})
