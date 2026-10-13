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
  getInitializedGlobal: (name: string, meta?: Record<string, unknown>) => unknown
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
function boot(reader?: Record<string, unknown>) {
  if (reader) {
    const input = document.createElement('script')
    input.type = 'application/json'
    input.id = 'srl-archived-reader-window'
    input.textContent = JSON.stringify(reader)
    document.head.append(input)
    const root = document.querySelector<HTMLElement>('#chat')!
    root.scrollTo = vi.fn((_x?: number | ScrollToOptions, y?: number) => {
      root.scrollTop = typeof _x === 'object' ? (_x.top ?? 0) : (y ?? 0)
    })
  }
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
afterEach(() => {
  host?.teardown()
  document.getElementById('srl-archived-reader-window')?.remove()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
describe('companion script APIs in the existing reading host', () => {
  it('still publishes a real reply change when an older host has only the window snapshots', async () => {
    document.body.innerHTML =
      '<div id="chat" data-srl-reader-window><section data-floor="29"></section></div>'
    const saved = {
      message_id: 29,
      last_message_id: 29,
      message: '旧回复',
      role: 'assistant',
      data: {},
      extra: {},
      swipe_id: 0,
    }
    boot({ snapshots: [saved], position: { floor: 29, offset: 0 } })
    const rendered = vi.fn()
    host.subscribe('character_message_rendered', rendered, window)
    document.dispatchEvent(new Event('DOMContentLoaded'))
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          protocol: 'srl-render-compat-v1',
          type: 'SRL_ARCHIVED_READER_WINDOW',
          snapshots: [{ ...saved, message: '新回复', swipe_id: 1 }],
          html: '<div id="chat" data-srl-reader-window><section data-floor="29"></section></div>',
        },
      }),
    )
    await Promise.resolve()
    expect(rendered).toHaveBeenCalledWith(29)
  })
  it('exposes requested real history ranges without emitting render events on scrolling', async () => {
    document.body.innerHTML =
      '<div id="chat" data-srl-reader-window><section data-floor="1"></section></div>'
    const history = Array.from({ length: 3 }, (_, id) => ({
      message_id: id,
      last_message_id: 2,
      message: '记录' + id,
      name: '角色',
      role: id === 1 ? 'user' : 'assistant',
      is_hidden: false,
      data: { floor: id },
      extra: {},
      swipe_id: 0,
    }))
    boot({
      snapshots: [history[1]],
      history,
      position: { floor: 1, offset: 0 },
      mode: 'continuous',
    })
    const rendered = vi.fn(),
      more = vi.fn()
    host.subscribe('character_message_rendered', rendered, window)
    host.subscribe('more_messages_loaded', more, window)
    document.dispatchEvent(new Event('DOMContentLoaded'))
    expect(host.invoke('getChatMessages', ['0-{{lastMessageId}}'], meta)).toHaveLength(3)
    expect(() => host.invoke('getCurrentMessageId', [], meta)).toThrow('message iframe')
    expect(host.invoke('getChatMessages', [-1], meta)).toMatchObject([
      { message_id: 2, message: '记录2' },
    ])
    expect(host.invoke('getChatMessages', ['0-2', { role: 'assistant' }], meta)).toHaveLength(2)
    expect(host.invoke('getVariables', [{ type: 'message', message_id: 0 }], meta)).toEqual({
      floor: 0,
    })
    const send = (snapshot = history[2]) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window.parent,
          data: {
            protocol: 'srl-render-compat-v1',
            type: 'SRL_ARCHIVED_READER_WINDOW',
            snapshots: [history[1], snapshot],
            html: '<div id="chat" data-srl-reader-window><section data-floor="1"></section><section data-floor="2"></section></div>',
          },
        }),
      )
    send()
    await Promise.resolve()
    expect(more).toHaveBeenCalledTimes(1)
    expect(rendered).not.toHaveBeenCalled()
    send()
    document.querySelector('#chat')!.dispatchEvent(new Event('scroll'))
    await Promise.resolve()
    expect(more).toHaveBeenCalledTimes(1)
    expect(rendered).not.toHaveBeenCalled()
    send({ ...history[2], message: '真实切换回复', swipe_id: 1 })
    await Promise.resolve()
    expect(rendered).toHaveBeenCalledWith(2)
    expect(host.invoke('getChatMessages', [-1], meta)).toMatchObject([
      { message: '真实切换回复', swipe_id: 1 },
    ])
  })
  it('reads only the chat scroller and detaches that owner on teardown', () => {
    document.body.innerHTML =
      '<div id="chat" data-srl-reader-window><section data-floor="29"></section></div><aside style="position:absolute;top:20px">作者UI</aside>'
    const root = document.querySelector<HTMLElement>('#chat')!
    vi.spyOn(document.querySelector('section')!, 'getBoundingClientRect').mockImplementation(
      () => ({ top: -root.scrollTop, bottom: 1000 - root.scrollTop, height: 1000 }) as DOMRect,
    )
    const windowScroll = vi.spyOn(window, 'scrollTo')
    const post = vi.spyOn(window.parent, 'postMessage')
    boot({
      snapshots: [
        {
          message_id: 29,
          last_message_id: 29,
          message: '保存正文',
          data: {},
          extra: {},
          swipe_id: 0,
        },
      ],
      position: { floor: 29, offset: 0 },
      mode: 'continuous',
    })
    document.dispatchEvent(new Event('DOMContentLoaded'))
    post.mockClear()
    root.scrollTop = 200
    window.dispatchEvent(new Event('scroll'))
    expect(post).not.toHaveBeenCalled()
    root.dispatchEvent(new Event('scroll'))
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SRL_ARCHIVED_READER_LAYOUT',
        top: 200,
        position: { floor: 29, offset: 200 },
      }),
      '*',
    )
    expect(windowScroll).not.toHaveBeenCalled()
    post.mockClear()
    host.teardown()
    root.scrollTop = 250
    root.dispatchEvent(new Event('scroll'))
    expect(post).not.toHaveBeenCalled()
  })
  it('keeps a trailing virtual gap when the next real floor becomes available', () => {
    document.body.innerHTML =
      '<div id="chat" data-srl-reader-window><section data-floor="29"></section></div>'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const start = this.dataset.floor === '30' ? 300 : 0
      return {
        top: start - document.querySelector<HTMLElement>('#chat')!.scrollTop,
        bottom: start - document.querySelector<HTMLElement>('#chat')!.scrollTop + 300,
        height: 300,
      } as DOMRect
    })
    const root = document.querySelector<HTMLElement>('#chat')!
    root.scrollTo = vi.fn((_x?: number | ScrollToOptions, y?: number) => {
      root.scrollTop = typeof _x === 'object' ? (_x.top ?? 0) : (y ?? 0)
    })
    const scroll = vi.spyOn(root, 'scrollTo')
    const saved = (id: number) => ({
      message_id: id,
      last_message_id: 30,
      message: '保存正文',
      data: {},
      extra: {},
      swipe_id: 0,
    })
    boot({ snapshots: [saved(29)], position: { floor: 29, offset: 0 }, mode: 'continuous' })
    document.dispatchEvent(new Event('DOMContentLoaded'))
    document.querySelector<HTMLElement>('#chat')!.scrollTop = 500
    document.querySelector('#chat')!.dispatchEvent(new Event('scroll'))
    scroll.mockClear()
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        data: {
          protocol: 'srl-render-compat-v1',
          type: 'SRL_ARCHIVED_READER_WINDOW',
          snapshots: [saved(29), saved(30)],
          html: '<div id="chat" data-srl-reader-window><section data-floor="29"></section><section data-floor="30"></section></div>',
          position: { floor: 29, offset: 0 },
        },
      }),
    )
    expect(document.querySelector<HTMLElement>('#chat')!.scrollTop).toBe(500)
    expect(host.invoke('getCurrentMessageId')).toBe(30)
  })
  it('retains mounted floor documents while binding each frontend to its own saved snapshot', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const saved = (id: number) => ({
      message_id: id,
      last_message_id: 31,
      name: '实际角色',
      role: 'assistant',
      is_hidden: false,
      message: `楼${id}`,
      data: { stat_data: { floor: id }, schema: {} },
      extra: {},
      swipe_id: 0,
    })
    const section = (id: number) =>
      `<section data-floor="${id}"><div class="TH-render"><iframe name="TH-message--${id}--0"></iframe></div></section>`
    const root = (ids: number[]) =>
      `<div id="chat" data-srl-reader-window>${ids.map(section).join('')}</div>`
    document.body.innerHTML = root([29, 30])
    boot({
      snapshots: [saved(29), saved(30)],
      position: { floor: 29, offset: 0 },
      mode: 'continuous',
    })
    document.dispatchEvent(new Event('DOMContentLoaded'))
    const frame = document.querySelector('[data-floor="30"] iframe')!
    const frontend = { frameName: 'TH-message--30--0' }
    const scopedMvu = host.getInitializedGlobal('Mvu', frontend) as {
      getCurrentMvuData: () => unknown
      getMvuData: (options: Record<string, unknown>) => unknown
    }
    expect(host.invoke('getCurrentMessageId', [], frontend)).toBe(30)
    expect(host.invoke('getChatMessages', ['30'], frontend)).toMatchObject([{ message: '楼30' }])
    expect(scopedMvu.getCurrentMvuData()).toEqual(saved(30).data)
    expect(scopedMvu.getMvuData({ message_id: -2 })).toEqual(saved(30).data)
    expect(() => scopedMvu.getMvuData({ message_id: -1 })).toThrow('snapshot')
    expect(host.invoke('getChatMessages', ['29'], frontend)).toEqual([])
    expect(() => host.invoke('replaceVariables', [{}, { type: 'message' }], frontend)).toThrow(
      'read-only',
    )
    // The parent payload can lag a touch move; bounded-window extension must
    // preserve the document's current pixels rather than that older position.
    vi.spyOn(document.querySelector('[data-floor="29"]')!, 'getBoundingClientRect').mockReturnValue(
      {
        top: -50,
        bottom: 250,
        height: 300,
      } as DOMRect,
    )
    const update = (ids: number[]) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window.parent,
          data: {
            protocol: 'srl-render-compat-v1',
            type: 'SRL_ARCHIVED_READER_WINDOW',
            html: root(ids),
            snapshots: ids.map(saved),
            position: { floor: ids[0], offset: 0 },
            mode: 'continuous',
          },
        }),
      )
    const rootScroll = document.querySelector<HTMLElement>('#chat')!.scrollTo as ReturnType<
      typeof vi.fn
    >
    rootScroll.mockClear()
    update([29, 30, 31])
    expect(rootScroll.mock.calls.every(([x, y]) => x === 0 && y === 0)).toBe(true)
    expect(document.querySelector('[data-floor="30"] iframe')).toBe(frame)
    update([29, 30])
    update([29, 30, 31])
    expect(document.querySelector('#chat')!.lastElementChild!.id).toBe('srl-reader-virtual-bottom')
    expect(document.querySelector('[data-floor="31"]')!.nextElementSibling!.id).toBe(
      'srl-reader-virtual-bottom',
    )
    expect(host.invoke('getScriptButtons', [], meta)).toEqual(meta.scriptButtons)
    expect(scopedMvu.getCurrentMvuData()).toEqual(saved(30).data)
    update([31])
    expect(frame.isConnected).toBe(false)
    expect(() => host.invoke('getCurrentMessageId', [], frontend)).toThrow('released')
    expect(() => scopedMvu.getCurrentMvuData()).toThrow('released')
  })
  it('keeps script controls and subscriptions while switching the saved floor and rejecting foreign updates', async () => {
    boot()
    document.body.innerHTML = '<div id="chat">旧楼</div><aside id="phone-ui">已打开联系人</aside>'
    const rendered = vi.fn()
    const oldPanel = document.createElement('div')
    oldPanel.className = 'TH-render'
    const oldFrontend = document.createElement('iframe')
    oldPanel.append(oldFrontend)
    document.querySelector('#chat')!.append(oldPanel)
    const staleRender = vi.fn()
    host.subscribe('character_message_rendered', staleRender, oldFrontend.contentWindow!)
    host.subscribe('character_message_rendered', rendered, window)
    const snapshot = {
      message_id: 7,
      last_message_id: 29,
      name: '角色',
      role: 'assistant',
      is_hidden: false,
      message: '新楼原文',
      data: { stat_data: { place: '家' }, schema: {} },
      extra: {},
      swipe_id: 1,
    }
    const original = JSON.stringify(snapshot)
    const data = {
      protocol: 'srl-render-compat-v1',
      type: 'SRL_ARCHIVED_FLOOR',
      snapshot,
      html: '<div id="chat"><p>新楼展示</p></div>',
    }
    window.dispatchEvent(new MessageEvent('message', { data, source: null }))
    expect(host.invoke('getCurrentMessageId')).toBe(29)
    window.dispatchEvent(new MessageEvent('message', { data, source: window.parent }))
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledWith(7))
    expect(staleRender).not.toHaveBeenCalled()
    expect(document.querySelector('#phone-ui')?.textContent).toBe('已打开联系人')
    expect(document.querySelector('#chat')?.textContent).toBe('新楼展示')
    expect(host.invoke('getCurrentMessageId')).toBe(7)
    expect(host.invoke('getChatMessages', ['7'])).toMatchObject([
      { message_id: 7, swipe_id: 1, message: '新楼原文' },
    ])
    expect(host.invoke('getVariables', [{ type: 'message' }])).toEqual(snapshot.data)
    expect(host.invoke('getScriptButtons', [], meta)).toEqual(meta.scriptButtons)
    expect(() => host.invoke('replaceVariables', [{}, { type: 'message' }])).toThrow('read-only')
    expect(JSON.stringify(snapshot)).toBe(original)
    const mvu = host.getInitializedGlobal('Mvu') as { getCurrentMvuData: () => unknown }
    expect(mvu.getCurrentMvuData()).toEqual(snapshot.data)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          ...data,
          snapshot: { ...snapshot, message_id: 8, data: { stat_data: [], schema: {} } },
        },
        source: window.parent,
      }),
    )
    expect(host.getInitializedGlobal('Mvu')).toBeUndefined()
    expect(() => mvu.getCurrentMvuData()).toThrow('unavailable')
    window.dispatchEvent(new MessageEvent('message', { data, source: window.parent }))
    expect((host.getInitializedGlobal('Mvu') as typeof mvu).getCurrentMvuData()).toEqual(
      snapshot.data,
    )
    host.teardown()
    expect(
      (window as unknown as Record<string, unknown>).__SRL_ARCHIVED_READER_FLOOR__,
    ).toBeUndefined()
  })
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
