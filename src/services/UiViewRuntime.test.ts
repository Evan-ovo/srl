import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { createUiViewDocument } from './UiViewRuntime'

describe('Vue界面启动握手', () => {
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
        expect(window.requestAnimationFrame).toHaveBeenCalled()
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve))
        frame.window.close()
      }
    },
  )
})
