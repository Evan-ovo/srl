/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureAssistantPage } from './ProductAssistantScreenshot'
import { getAssistantVisibleScope } from '../core/ProductAssistantViewContext'

const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('html-to-image', () => ({ toJpeg: render }))
const scope = { value: 'library' as const, title: '资源库', selector: '.library', hint: '' }
beforeEach(() => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.style.height ? parseFloat(this.style.height) : 800
    const top = this.classList.contains('library') ? -100 : 0
    return {
      width: 390,
      height,
      top,
      left: 0,
      right: 390,
      bottom: top + height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(800)
  render.mockReset().mockResolvedValue('data:image/jpeg;base64,SHOT')
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
describe('current-view screenshot', () => {
  it('does not substitute an open APP or chat for the requested feature desktop', async () => {
    document.body.innerHTML =
      '<main class="feature-hub" data-feature-page="assistant"><p>聊天页</p></main>'
    await expect(
      captureAssistantPage(
        { value: 'features', title: '功能桌面', selector: '.feature-hub', hint: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('当前没有打开')
    expect(render).not.toHaveBeenCalled()
  })
  it('selects the visible instance of the requested page instead of a retained hidden one', async () => {
    document.body.innerHTML =
      '<div style="display:none"><main class="library">OLD</main></div><main class="library">ACTUAL</main>'
    render.mockImplementation(async (node: HTMLElement) => {
      expect(node.textContent).toBe('ACTUAL')
      return 'data:image/jpeg;base64,SHOT'
    })
    await captureAssistantPage(scope, new AbortController().signal)
    expect(render).toHaveBeenCalledOnce()
  })
  it('captures the current frame without waiting for unrelated pending document fonts', async () => {
    document.body.innerHTML = '<main class="library">当前页面</main>'
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => {}) },
    })
    await expect(captureAssistantPage(scope, new AbortController().signal)).resolves.toMatchObject({
      dataUrl: 'data:image/jpeg;base64,SHOT',
    })
    expect(render).toHaveBeenCalledOnce()
  })
  it('cancels a stalled renderer, removes its clone and consumes a late completion', async () => {
    document.body.innerHTML = '<main class="library">当前页面</main>'
    let resolve!: (value: string) => void
    render.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    )
    const controller = new AbortController()
    const capture = captureAssistantPage(scope, controller.signal, true)
    const rejected = expect(capture).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    const [node, options] = render.mock.calls[0]!
    expect(node.isConnected).toBe(true)
    expect(options.fetchRequestInit).toMatchObject({
      signal: controller.signal,
      credentials: 'omit',
    })
    controller.abort()
    await rejected
    expect(node.isConnected).toBe(false)
    expect(() => options.imagePlaceholder).toThrow()
    resolve('data:image/jpeg;base64,LATE')
    await Promise.resolve()
    expect(document.querySelectorAll('.library')).toHaveLength(1)
    expect(document.querySelector('.library')!.textContent).toBe('当前页面')
  })
  it('identifies the full assistant instead of falling back to the hidden home', () => {
    document.body.innerHTML =
      '<main class="library" style="display:none"></main><main class="feature-hub" data-feature-page="assistant"><span data-official-app-ready="assistant"></span><div class="product-assistant"></div></main>'
    expect(getAssistantVisibleScope()?.value).toBe('app:assistant')
  })
  it('does not reject the desktop because an inactive assistant is retained inside it', async () => {
    document.body.innerHTML =
      '<main class="feature-hub" data-feature-page="home"><p>功能列表</p><div style="display:none"><div class="product-assistant">旧聊天</div></div></main>'
    expect(getAssistantVisibleScope()?.value).toBe('features')
    await captureAssistantPage(
      { value: 'features', title: '功能桌面', selector: '.feature-hub', hint: '' },
      new AbortController().signal,
      true,
    )
    expect(render).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])(
    'captures the assistant layout with private conversation content masked (current=%s)',
    async (currentView) => {
      document.body.innerHTML =
        '<main class="feature-hub" data-feature-page="assistant"><div class="product-assistant"><header>蒜惹菈</header><article class="chat-message"><div class="chat-bubble"><p>HIDDEN_CHAT</p><button class="chat-image"><img src="data:image/png;base64,PRIVATE"></button></div></article><dialog class="chat-reasoning-viewer" open><pre>PRIVATE_REASONING</pre></dialog><textarea>PRIVATE_INPUT</textarea></div></main>'
      const chatScope = {
        // Skill selection and selected source content are local chat data as well.
        value: 'app:assistant' as const,
        title: '蒜惹菈',
        selector: '.feature-hub[data-feature-page="assistant"]',
        appId: 'assistant',
        hint: '',
      }
      render.mockImplementation(async (node: HTMLElement) => {
        for (const selector of ['.assistant-resource-citations', '.assistant-task-context'])
          expect(node.querySelector<HTMLElement>(selector)?.style.visibility).toBe('hidden')
        expect(node.querySelector('.assistant-reference-dialog')).toBeNull()
        expect(node.querySelector('.product-assistant')).not.toBeNull()
        expect(node.querySelector('.chat-reasoning-viewer')).toBeNull()
        expect(node.querySelector<HTMLElement>('.chat-bubble > p')!.style.visibility).toBe('hidden')
        expect(node.querySelector<HTMLElement>('.chat-image')!.style.visibility).toBe('hidden')
        expect(node.querySelector('textarea')!.value).toBe('')
        return 'data:image/jpeg;base64,SHOT'
      })
      document
        .querySelector('.product-assistant')!
        .insertAdjacentHTML(
          'beforeend',
          '<div class="assistant-resource-citations">PRIVATE_SOURCE</div><div class="assistant-task-context">PRIVATE_SKILL</div><dialog class="assistant-reference-dialog" data-sensitive open>RAW_RESOURCE</dialog>',
        )
      await captureAssistantPage(chatScope, new AbortController().signal, currentView)
      expect(
        document.querySelector<HTMLElement>('.assistant-resource-citations')?.style.visibility,
      ).toBe('')
      expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('PRIVATE_INPUT')
      expect(document.querySelector<HTMLElement>('.chat-bubble > p')!.style.visibility).toBe('')
      expect(document.querySelectorAll('.feature-hub')).toHaveLength(1)
    },
  )
  it.each([false, true])(
    'removes the open assistant and message overlays before rendering (current view=%s)',
    async (currentView) => {
      document.body.innerHTML =
        '<main class="library"><p>PAGE_CONTENT</p><div class="product-assistant">CHAT_SECRET</div><div class="assistant-pet-bubble">SPEECH_SECRET</div><dialog class="chat-message-menu" open>MENU_SECRET</dialog><div class="scroll"><div>SCROLLED_CONTENT</div></div></main>'
      const live = document.querySelector<HTMLElement>('.library')!
      live.querySelector<HTMLElement>('.scroll')!.scrollTop = 120
      render.mockImplementation(async (node: HTMLElement) => {
        expect(node.textContent).toContain('PAGE_CONTENT')
        expect(node.textContent).not.toMatch(/CHAT_SECRET|SPEECH_SECRET|MENU_SECRET/u)
        expect(
          node.querySelector('.product-assistant,.assistant-pet-bubble,.chat-message-menu'),
        ).toBeNull()
        if (currentView)
          expect(node.querySelector('.scroll > div')?.getAttribute('style')).toContain('-120px')
        return 'data:image/jpeg;base64,SHOT'
      })
      await captureAssistantPage(scope, new AbortController().signal, currentView)
      expect(live.textContent).toContain('CHAT_SECRET')
      expect(live.querySelector('dialog')?.open).toBe(true)
      expect(document.querySelectorAll('.library')).toHaveLength(1)
    },
  )
  it('paints virtualized cards only after mounting and does not restart their entrance animation', async () => {
    document.body.innerHTML = '<main class="library"><div class="resource-card">卡片</div></main>'
    const originalStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) => {
      const style = originalStyle(node, pseudo)
      if (node.classList.contains('resource-card') && node.isConnected)
        Object.defineProperty(style, 'contentVisibility', { value: 'auto', configurable: true })
      return style
    })
    render.mockImplementation(async (node: HTMLElement) => {
      const card = node.querySelector<HTMLElement>('.resource-card')!
      expect(card.style.contentVisibility).toBe('visible')
      expect(card.style.animation).toBe('none')
      expect(card.style.transition).toBe('none')
      return 'data:image/jpeg;base64,SHOT'
    })
    await captureAssistantPage(scope, new AbortController().signal)
    expect(document.querySelector<HTMLElement>('.resource-card')!.style.animation).toBe('')
    expect(document.querySelectorAll('.library')).toHaveLength(1)
  })
  it('keeps the existing local screenshot path for the retained background library', async () => {
    document.body.innerHTML = '<main class="library" style="display:none"><p>本机内容</p></main>'
    const source = document.querySelector<HTMLElement>('.library')!
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 0 } as DOMRect)
    const result = await captureAssistantPage(scope, new AbortController().signal)
    expect(result.name).toContain('页面上部')
    expect(render).toHaveBeenCalledTimes(1)
    expect(source.style.display).toBe('none')
    expect(document.body.children).toHaveLength(1)
    await expect(captureAssistantPage(scope, new AbortController().signal, true)).rejects.toThrow(
      '当前没有打开',
    )
  })
  it('redacts before rendering, preserves user input, clips the current viewport and cleans clones', async () => {
    document.body.innerHTML =
      '<main class="library"><input value="SECRET"><textarea>PRIVATE</textarea><select><option>HIDDEN</option></select><div class="main-api-settings">TOKEN</div><div data-sensitive>PERSONAL</div><div class="scroll"><div>VISIBLE</div></div></main><div class="assistant-pet-dialog"><main class="library">CHAT</main></div>'
    const original = document.querySelector('.library')!
    ;(original.querySelector('.scroll') as HTMLElement).scrollTop = 120
    render.mockImplementation(async (node: HTMLElement, options) => {
      expect(node.textContent).not.toMatch(/PRIVATE|HIDDEN|TOKEN|PERSONAL|CHAT/u)
      expect(node.querySelector('input')?.value).toBe('')
      expect(node.querySelector('.scroll > div')?.getAttribute('style')).toContain('-120px')
      expect(options.height).toBe(700)
      expect(node.querySelector('.library')?.getAttribute('style')).toContain('top: -100px')
      return 'data:image/jpeg;base64,SHOT'
    })
    const result = await captureAssistantPage(scope, new AbortController().signal, true)
    expect(result.name).toContain('当前界面')
    expect(original.querySelector('input')?.value).toBe('SECRET')
    expect(document.querySelectorAll('.library')).toHaveLength(2)
    expect(document.body.children).toHaveLength(2)
  })
  it('blocks authentication, aborts and removes the temporary clone after a renderer failure', async () => {
    document.body.innerHTML = '<main class="library">界面</main><div class="auth-portal">登录</div>'
    const auth = document.querySelector('.auth-portal')!
    vi.spyOn(auth, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    expect(getAssistantVisibleScope()).toBeUndefined()
    await expect(captureAssistantPage(scope, new AbortController().signal, true)).rejects.toThrow(
      '登录',
    )
    auth.remove()
    render.mockRejectedValue(new Error('绘图失败'))
    await expect(captureAssistantPage(scope, new AbortController().signal, true)).rejects.toThrow(
      '绘图失败',
    )
    expect(document.body.children).toHaveLength(1)
    await expect(captureAssistantPage(scope, AbortSignal.abort(), true)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(document.body.children).toHaveLength(1)
  })
})
