/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archivedScriptHostContext } from './RenderCompatibilityScriptHost'
import {
  buildRenderCompatibilityHostRuntime,
  buildRenderCompatibilityChildAdapter,
  createRenderCompatibilityContext,
} from './RenderCompatibilityRuntime'

interface TestHost {
  registerScript: (meta: Record<string, unknown>) => void
  invoke: (name: string, args?: unknown[], meta?: Record<string, unknown>) => unknown
  subscribe: (type: string, callback: () => void, owner: Window) => void
  teardown: () => void
}
let host: TestHost
const card = {
  name: '实际角色',
  character_book: {
    name: '实际世界书',
    entries: [{ id: 12, comment: '原条目', content: '原始内容', enabled: true }],
  },
}
const meta = {
  scriptId: 'phone',
  scriptName: '手机',
  scriptButtons: [
    { name: '开关', visible: true },
    { name: '隐藏', visible: false },
  ],
}
function boot() {
  const context = createRenderCompatibilityContext({
    greetings: [],
    formattedGreetings: [],
    greetingIndex: 0,
    charName: '实际角色',
    userName: '实际用户',
    characterData: card,
    characterContextAvailable: true,
    scriptHost: archivedScriptHostContext(card, {
      global: [],
      preset: [],
      character: [
        {
          id: 'r',
          scriptName: '原正则',
          findRegex: 'a',
          replaceString: 'b',
          placement: [2],
          markdownOnly: true,
        },
      ],
    }),
  })
  window.eval(
    buildRenderCompatibilityHostRuntime(context, 0, {
      message_id: 29,
      last_message_id: 29,
      name: '实际角色',
      role: 'assistant',
      is_hidden: false,
      message: '当前楼',
      data: {},
      extra: {},
      swipe_id: 0,
    })
      .replace(/^<script>/, '')
      .replace(/<\/script>$/, ''),
  )
  host = (window as unknown as { __SRL_RENDER_COMPAT_HOST__: TestHost }).__SRL_RENDER_COMPAT_HOST__
  host.registerScript(meta)
}
afterEach(() => host?.teardown())
describe('companion script APIs in the existing reading host', () => {
  it('schedules hidden-script animations in its isolated parent and cancels them on pagehide', () => {
    boot()
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.set(++next, callback)
      return next
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id)
    })
    let cleanup = () => {}
    const child = {
      parent: window,
      requestAnimationFrame: vi.fn(() => 123),
      cancelAnimationFrame: vi.fn(),
      name: 'TH-script--animation--animation',
      addEventListener: (name: string, handler: () => void) => {
        if (name === 'pagehide') cleanup = handler
      },
    }
    const original = child.requestAnimationFrame
    try {
      const source = buildRenderCompatibilityChildAdapter({ id: 'animation', name: '动画' })
        .replace(/^<script>/, '')
        .replace(/<\/script>$/, '')
      new Function('window', source)(child)
      const callback = vi.fn()
      const id = (child.requestAnimationFrame as typeof window.requestAnimationFrame)(callback)
      expect(original).not.toHaveBeenCalled()
      callbacks.get(id)!(17)
      expect(callback).toHaveBeenCalledWith(17)
      expect(callback.mock.contexts[0]).toBe(child)
      const pending = (child.requestAnimationFrame as typeof window.requestAnimationFrame)(vi.fn())
      cleanup()
      expect(cancel).toHaveBeenCalledWith(pending)
      expect(callbacks.has(pending)).toBe(false)
      expect(child.requestAnimationFrame).toBe(original)
    } finally {
      frame.mockRestore()
      cancel.mockRestore()
    }
  })
  it('retains a known external binding name without fabricating its missing entries', () => {
    const value = archivedScriptHostContext(
      { name: '角色', extensions: { world: '外部世界书' } },
      { global: [], preset: [], character: [] },
    )
    expect(value.characterWorldbooks.primary).toBe('外部世界书')
    expect(value.worldbooks).toEqual({})
  })
  it('reads the selected card worldbook and changes only its detached session copy', async () => {
    boot()
    expect(host.invoke('getCharWorldbookNames', ['current'])).toEqual({
      primary: '实际世界书',
      additional: [],
    })
    expect(() => host.invoke('getCharWorldbookNames', ['其它角色'])).toThrow('selected character')
    const original = JSON.stringify(card)
    const added = (await host.invoke('createWorldbookEntries', [
      '实际世界书',
      [{ name: '手机-基本设置', content: '配置' }],
    ])) as { new_entries: { uid: number }[] }
    expect(added.new_entries[0]?.uid).toBe(13)
    await host.invoke('setLorebookEntries', ['实际世界书', [{ uid: 12, content: '临时内容' }]])
    const entries = (await host.invoke('getWorldbook', ['实际世界书'])) as { content: string }[]
    expect(entries.map((entry) => entry.content)).toEqual(['临时内容', '配置'])
    expect(JSON.stringify(card)).toBe(original)
    await expect(host.invoke('getWorldbook', ['不存在'])).rejects.toThrow('unavailable')
    expect(() => host.invoke('setChatMessages', [[{ message_id: 29, message: '覆写' }]])).toThrow(
      'read-only',
    )
    host.teardown()
    boot()
    expect(await host.invoke('getWorldbook', ['实际世界书'])).toHaveLength(1)
  })
  it('isolates static and dynamically added controls and rejects foreign sources or hidden buttons', async () => {
    boot()
    host.registerScript({ scriptId: 'other', scriptName: '另一个', scriptButtons: ['开关'] })
    const click = vi.fn()
    const hidden = vi.fn()
    const event = host.invoke('getButtonEvent', ['开关'], meta) as string
    expect(host.invoke('getButtonEvent', ['开关'], { scriptId: 'other' })).not.toBe(event)
    host.subscribe(event, click, window)
    host.subscribe(host.invoke('getButtonEvent', ['隐藏'], meta) as string, hidden, window)
    const message = {
      protocol: 'srl-render-compat-v1',
      type: 'SRL_SCRIPT_BUTTON_CLICK',
      scriptId: 'phone',
      name: '开关',
    }
    window.dispatchEvent(new MessageEvent('message', { data: message, source: null }))
    expect(click).not.toHaveBeenCalled()
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window.parent }))
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce())
    window.dispatchEvent(
      new MessageEvent('message', { data: { ...message, name: '隐藏' }, source: window.parent }),
    )
    expect(hidden).not.toHaveBeenCalled()
    host.invoke(
      'appendInexistentScriptButtons',
      [
        [
          { name: '开关', visible: true },
          { name: '新按钮', visible: true },
        ],
      ],
      meta,
    )
    expect(host.invoke('getScriptButtons', [], meta)).toHaveLength(3)
    host.teardown()
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window.parent }))
    expect(click).toHaveBeenCalledOnce()
  })
  it('supports known read macros and scoped regex edits without claiming send or generation support', async () => {
    boot()
    await expect(
      host.invoke('triggerSlash', ['/pass {{char}}/{{user}}/{{lastMessageId}}']),
    ).resolves.toBe('实际角色/实际用户/29')
    await expect(host.invoke('triggerSlash', ['/send 发消息'])).rejects.toThrow('Only /pass')
    const regex = host.invoke('getTavernRegexes', [{ scope: 'character' }]) as {
      script_name: string
      enabled: boolean
    }[]
    expect(regex[0]?.script_name).toBe('原正则')
    expect(regex[0]?.enabled).toBe(true)
    await host.invoke('replaceTavernRegexes', [
      [{ ...regex[0], enabled: false }],
      { type: 'character' },
    ])
    expect(
      host.invoke('getTavernRegexes', [{ scope: 'character', enable_state: 'enabled' }]),
    ).toEqual([])
  })
})
