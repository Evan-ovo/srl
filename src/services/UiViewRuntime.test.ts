import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { createUiViewDocument } from './UiViewRuntime'

describe('Vue界面启动握手', () => {
  it('does not sample decorative animations when there are no native regions', async () => {
    const encoded = createUiViewDocument(
      '<div id="badge" style="position:fixed">loading</div>',
      false,
    ).match(/\)\(("(?:\\.|[^"\\])*")\)<\/script><\/body><\/html>$/u)![1]!
    const frame = new JSDOM(JSON.parse(encoded), {
      runScripts: 'outside-only',
      url: 'http://127.0.0.1',
      pretendToBeVisual: true,
    })
    const window = frame.window
    const callbacks: FrameRequestCallback[] = []
    const observers: MutationObserver[] = []
    const Observer = window.MutationObserver
    window.MutationObserver = class extends Observer {
      constructor(callback: MutationCallback) {
        super(callback)
        observers.push(this)
      }
    }
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback)
      return callbacks.length
    }
    window.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    const animations = vi.fn(() => [
      {
        playState: 'running',
        effect: {
          target: window.document.querySelector('#badge'),
          getKeyframes: () => [{ transform: 'rotate(1turn)' }],
        },
      },
    ])
    Object.defineProperty(window.document, 'getAnimations', { value: animations })
    try {
      window.eval(window.document.querySelector('script')!.textContent!)
      const port = {
        start() {},
        postMessage: vi.fn(),
        onmessage: undefined as undefined | ((event: { data: unknown }) => void),
      }
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: window as unknown as Window,
          data: { type: 'srl:ui-connect', nonce: 'decoration' },
          ports: [port as unknown as MessagePort],
        }),
      )
      port.onmessage!({ data: { type: 'state', nonce: 'decoration', state: {} } })
      await new Promise<void>((resolve) => setImmediate(resolve))
      for (let i = 0; i < 20 && callbacks.length; i++)
        callbacks.splice(0).forEach((callback) => callback(i * 16))
      expect(callbacks).toHaveLength(0)
      expect(animations).not.toHaveBeenCalled()
    } finally {
      observers.forEach((observer) => observer.disconnect())
      frame.window.close()
    }
  })
  it('class平移、祖先裁切、遮挡和动画更新定位，静止后不继续轮询或发送重复布局', async () => {
    const encoded = createUiViewDocument('', false).match(
      /\)\(("(?:\\.|[^"\\])*")\)<\/script><\/body><\/html>$/u,
    )![1]!
    const frame = new JSDOM(JSON.parse(encoded), {
      runScripts: 'outside-only',
      url: 'http://127.0.0.1',
    })
    const window = frame.window
    const callbacks: FrameRequestCallback[] = []
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback)
      return callbacks.length
    }
    window.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    const app = window.document.querySelector('#app')!
    app.innerHTML =
      '<style>.clipped{overflow-y:hidden}</style><section id="holder"><div data-srl-native="canvas"></div></section><div id="cover" style="position:absolute;pointer-events:none;display:none"></div>'
    const holder = window.document.querySelector<HTMLElement>('#holder')!
    const native = holder.firstElementChild as HTMLElement
    const cover = window.document.querySelector<HTMLElement>('#cover')!
    const rect = (top = 0, left = 0, width = 100, height = 80) =>
      ({ top, left, width, height, right: left + width, bottom: top + height }) as DOMRect
    let animatedTop = 0
    const top = () => (holder.classList.contains('moved') ? 70 : animatedTop)
    vi.spyOn(holder, 'getBoundingClientRect').mockImplementation(() => rect(top()))
    vi.spyOn(native, 'getBoundingClientRect').mockImplementation(() => rect(top()))
    vi.spyOn(cover, 'getBoundingClientRect').mockImplementation(() => rect(top(), 40, 20))
    for (const [name, value] of Object.entries({
      clientWidth: 100,
      clientHeight: 30,
      offsetWidth: 100,
      offsetHeight: 80,
    }))
      Object.defineProperty(holder, name, { configurable: true, value })
    Object.defineProperty(window.document, 'elementsFromPoint', {
      value: (_x: number, y: number) => {
        const band = window.document.querySelector('#band')
        return band && y > 9000
          ? [band, window.document.querySelector('[data-srl-native="row-150"]')]
          : [cover, native]
      },
    })
    let running = false
    Object.defineProperty(window.document, 'getAnimations', {
      value: () =>
        running
          ? [
              {
                playState: 'running',
                pending: false,
                effect: { target: holder, getKeyframes: () => [{ transform: 'translateY(20px)' }] },
              },
            ]
          : [],
    })
    try {
      window.eval(window.document.querySelector('script')!.textContent!)
      const port = {
        onmessage: undefined as undefined | ((event: { data: unknown }) => void),
        start: vi.fn(),
        postMessage: vi.fn(),
      }
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: window as unknown as Window,
          data: { type: 'srl:ui-connect', nonce: 'geometry' },
          ports: [port as unknown as MessagePort],
        }),
      )
      port.onmessage!({
        data: { type: 'state', nonce: 'geometry', state: { theme: 'light', html: '' } },
      })
      const settle = async () => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        for (let n = 0; callbacks.length && n < 5; n++)
          callbacks.splice(0).forEach((callback) => callback(0))
        expect(callbacks).toHaveLength(0)
      }
      const latest = () =>
        port.postMessage.mock.calls.filter(([message]) => message.type === 'native').at(-1)![0]
          .regions[0]
      await settle()
      expect(latest()).toMatchObject({
        top: 0,
        visibleRects: [{ top: 0, left: 0, width: 100, height: 80 }],
      })
      holder.className = 'moved'
      await settle()
      expect(latest().top).toBe(70)
      holder.className = 'clipped'
      await settle()
      expect(latest().visibleRects).toEqual([{ top: 0, left: 0, width: 100, height: 30 }])
      holder.className = ''
      cover.style.display = 'block'
      const coverStyle = cover.getAttribute('style')
      await settle()
      expect(latest().visibleRects).toEqual([
        { top: 0, left: 0, width: 40, height: 80 },
        { top: 0, left: 60, width: 40, height: 80 },
      ])
      expect(cover.getAttribute('style')).toBe(coverStyle)
      expect(native.hasAttribute('style')).toBe(false)
      cover.style.display = 'none'
      await settle()
      running = true
      window.document.dispatchEvent(new window.Event('animationstart'))
      animatedTop = 10
      callbacks.splice(0).forEach((callback) => callback(0))
      expect(latest().top).toBe(10)
      animatedTop = 20
      callbacks.splice(0).forEach((callback) => callback(0))
      expect(latest().top).toBe(20)
      running = false
      await settle()
      const count = port.postMessage.mock.calls.length
      window.document.dispatchEvent(new window.Event('animationend'))
      await settle()
      expect(port.postMessage).toHaveBeenCalledTimes(count)
      animatedTop = 25
      window.document.body.dispatchEvent(new window.Event('input', { bubbles: true }))
      await settle()
      expect(latest().top).toBe(25)
      animatedTop = 30
      window.document.body.dispatchEvent(new window.Event('pointerover', { bubbles: true }))
      await settle()
      expect(latest().top).toBe(30)
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 20000 })
      for (let i = 0; i < 256; i++) {
        const row = window.document.createElement('div')
        row.dataset.srlNative = 'row-' + i
        vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(i * 60, 0, 100, 40))
        app.append(row)
      }
      const band = window.document.createElement('div')
      band.id = 'band'
      band.style.position = 'absolute'
      vi.spyOn(band, 'getBoundingClientRect').mockImplementation(() => rect(9010, 0, 100, 20))
      app.append(band)
      await settle()
      const rows = port.postMessage.mock.calls
        .filter(([message]) => message.type === 'native')
        .at(-1)![0].regions
      expect(rows).toHaveLength(257)
      expect(rows.find((row: { id: string }) => row.id === 'row-150').visibleRects).toEqual([
        { top: 0, left: 0, width: 100, height: 10 },
        { top: 30, left: 0, width: 100, height: 10 },
      ])
      for (const id of ['row-149', 'row-151'])
        expect(rows.find((row: { id: string }) => row.id === id).visibleRects).toEqual([
          { top: 0, left: 0, width: 100, height: 40 },
        ])
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve))
      frame.window.close()
    }
  })
  it('仅显式选择宿主滚动时报告自然高度，内容缩短和退出都交回原滚动路线', async () => {
    const documentText = createUiViewDocument('', false)
    const encoded = documentText.match(/\)\(("(?:\\.|[^"\\])*")\)<\/script><\/body><\/html>$/u)![1]!
    const frame = new JSDOM(JSON.parse(encoded), {
      runScripts: 'outside-only',
      url: 'http://127.0.0.1',
    })
    try {
      const window = frame.window
      const frames: FrameRequestCallback[] = []
      window.requestAnimationFrame = (callback) => {
        frames.push(callback)
        return frames.length
      }
      let resize!: () => void
      const observed = vi.fn()
      window.ResizeObserver = class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe = observed
        disconnect() {}
        unobserve() {}
      }
      const root = window.document.createElement('section')
      root.dataset.srlHostScroll = ''
      window.document.querySelector('#app')!.append(root)
      let height = 1800
      let top = 0
      vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ height, top }) as DOMRect)
      window.eval(window.document.querySelector('script')!.textContent!)
      const port = {
        onmessage: undefined as undefined | ((event: { data: unknown }) => void),
        start: vi.fn(),
        postMessage: vi.fn(),
      }
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: window as unknown as Window,
          data: { type: 'srl:ui-connect', nonce: 'scroll' },
          ports: [port as unknown as MessagePort],
        }),
      )
      port.onmessage!({
        data: { type: 'state', nonce: 'scroll', state: { theme: 'light', html: '' } },
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      frames.splice(0).forEach((callback) => callback(0))
      expect(observed.mock.calls.some(([node]) => node === root)).toBe(true)
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'native', hostScrollHeight: 1800 }),
      )
      height = 320
      resize()
      frames.splice(0).forEach((callback) => callback(0))
      expect(port.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostScrollHeight: 320 }),
      )
      top = 40
      resize()
      frames.splice(0).forEach((callback) => callback(0))
      expect(port.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostScrollHeight: 360 }),
      )
      root.removeAttribute('data-srl-host-scroll')
      root.append(window.document.createElement('span'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      frames.splice(0).forEach((callback) => callback(0))
      expect(port.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ hostScrollHeight: null }),
      )
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve))
      frame.window.close()
    }
  })
  it.each([false, true])(
    '隐藏iframe的就绪不依赖绘制，运行错误仍阻止就绪（failed=%s）',
    async (failed) => {
      const documentText = createUiViewDocument('', false)
      const encodedInner = documentText.match(
        /\)\(("(?:\\.|[^"\\])*")\)<\/script><\/body><\/html>$/u,
      )![1]!
      const frame = new JSDOM(JSON.parse(encodedInner), { runScripts: 'outside-only' })
      try {
        const window = frame.window
        window.requestAnimationFrame = vi.fn(() => 1)
        window.ResizeObserver = class {
          observe() {}
          disconnect() {}
          unobserve() {}
        }
        window.eval(window.document.querySelector('script')!.textContent!)
        const rendered = vi.fn()
        const port = {
          onmessage: undefined as undefined | ((event: { data: unknown }) => void),
          start: vi.fn(),
          postMessage: vi.fn((message: { type: string }) => {
            if (message.type === 'rendered')
              rendered(window.document.querySelector('#app')!.textContent)
          }),
        }
        const ui = (
          window as unknown as {
            srlUi: { subscribe(callback: (state: { html: string }) => void): void }
          }
        ).srlUi
        ui.subscribe((state) => {
          // Vue's scheduled DOM flush must finish before the host hides the original UI.
          void Promise.resolve().then(() => {
            window.document.querySelector('#app')!.textContent = state.html
          })
        })
        window.dispatchEvent(
          new window.MessageEvent('message', {
            source: window as unknown as Window,
            data: { type: 'srl:ui-connect', nonce: 'trial' },
            ports: [port as unknown as MessagePort],
          }),
        )
        if (failed) window.dispatchEvent(new window.ErrorEvent('error', { message: '运行失败' }))
        port.onmessage!({
          data: {
            type: 'state',
            nonce: 'trial',
            state: { theme: 'light', html: '真实界面内容' },
          },
        })
        await Promise.resolve()
        await Promise.resolve()
        if (failed) {
          expect(rendered).not.toHaveBeenCalled()
          expect(port.postMessage).toHaveBeenCalledWith({ type: 'error', nonce: 'trial' })
        } else expect(rendered).toHaveBeenCalledWith('真实界面内容')
        if (failed) expect(window.requestAnimationFrame).not.toHaveBeenCalled()
        else expect(window.requestAnimationFrame).toHaveBeenCalled()
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve))
        frame.window.close()
      }
    },
  )
})
