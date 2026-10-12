import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = new URL('../extensions/duleme/', import.meta.url)
const html = readFileSync(new URL('index.html', root), 'utf8')
const source = readFileSync(new URL('app.js', root), 'utf8')
const windows: JSDOM[] = []
afterEach(() => windows.splice(0).forEach((dom) => dom.window.close()))

async function reader(
  preferences: Record<string, unknown> = {},
  storage?: Map<string, unknown>,
  pauseFirstRead = false,
  failFirstRead = false,
  scriptRules: Array<{ key: string; sourceId: string; name: string; enabled: boolean }> = [],
  unrelatedCharacters = 0,
  builtinReader = false,
  paragraphCount = 1,
) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  windows.push(dom)
  const { window } = dom
  const document = window.document
  let maskPatternBuilds = 0
  window.RegExp = new Proxy(window.RegExp, {
    construct(target, args) {
      if (String(args[0]).includes('测试用户')) maskPatternBuilds++
      return Reflect.construct(target, args)
    },
  })
  window.scrollTo = () => {}
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
  const library = [
    { id: 'role', name: '角色', type: 'characterCard' },
    { id: 'chat', name: '记录', type: 'chat', relatedResourceIds: ['role'], messageCount: 12 },
    ...Array.from({ length: unrelatedCharacters }, (_, i) => ({
      id: `unused-${i}`,
      name: `其它角色 ${i}`,
      type: 'characterCard',
    })),
  ]
  const listResources = vi.fn(
    async (options: { types: string[]; ids?: string[]; offset: number; limit: number }) => {
      const matches = library.filter(
        (r) => options.types.includes(r.type) && (!options.ids || options.ids.includes(r.id)),
      )
      const items = matches.slice(options.offset, options.offset + options.limit)
      return {
        items,
        nextOffset:
          options.offset + items.length < matches.length ? options.offset + items.length : null,
      }
    },
  )
  Object.assign(window, {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(target: Element) {
        this.callback([{ target, isIntersecting: true }])
      }
      unobserve() {}
      disconnect() {}
    },
  })
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() } })
  const saved =
    storage ||
    new Map<string, unknown>([['preferences-v1', { progressMode: 'chapters', ...preferences }]])
  const indexWrites: Array<{ resumeReading?: boolean }> = []
  let startFirstRead!: () => void
  let releaseFirstRead!: () => void
  const firstReadStarted = new Promise<void>((resolve) => (startFirstRead = resolve))
  const firstReadGate = new Promise<void>((resolve) => (releaseFirstRead = resolve))
  let readCalls = 0
  const setReaderNavigation = vi.fn<(_state: { page: string }) => Promise<void>>(async () => {})
  const setLoading = vi.fn(async () => {})
  const thumbnail = vi.fn(async () => null)
  const readChat = vi.fn(
    async (options: {
      offset: number
      interactive: boolean
      limit?: number
      scriptListOnly?: boolean
      scriptSources?: string[]
    }) => {
      if (readCalls++ === 0) {
        startFirstRead()
        if (pauseFirstRead) await firstReadGate
        if (failFirstRead) throw new Error('读取夹具暂时失败')
      }
      return {
        contentHash: 'fixture',
        total: 12,
        userNames: ['测试用户'],
        regexRules: [],
        scriptRules: scriptRules.filter(
          (rule) => rule.sourceId === 'character' || options.scriptSources?.includes(rule.sourceId),
        ),
        nextOffset:
          options.offset + (options.limit || 1) < 12 ? options.offset + (options.limit || 1) : null,
        previewDocumentUrl: 'data:text/html,fixture',
        messages: options.scriptListOnly
          ? []
          : Array.from({ length: Math.min(options.limit || 1, 12 - options.offset) }, (_, i) => ({
              index: options.offset + i,
              depth: 0,
              message: { name: '角色', mes: '测试用户的正文', is_user: false },
              html:
                '<p>测试用户的正文</p>'.repeat(paragraphCount) +
                '<div data-chat-frontend="0"></div>',
              frontends: ['<p>测试用户的静态状态</p>'],
              interactiveFrontends: ['<p>测试用户的交互状态</p>'],
            })),
      }
    },
  )
  Object.assign(window, {
    srlApp: {
      ready: async () => {},
      capabilities: async () => ({ runtime: { network: true, builtinReader } }),
      storage: {
        get: async (key: string) => structuredClone(saved.get(key)),
        set: async (key: string, value: unknown) => {
          if (key === 'reader-index-v1') indexWrites.push(value as { resumeReading?: boolean })
          saved.set(key, structuredClone(value))
        },
      },
      ui: { setReaderNavigation, setLoading, exitFullscreen: async () => {} },
      resources: {
        readChat,
        thumbnail,
        list: listResources,
      },
    },
  })
  window.eval(source)
  const click = async (selector: string) => {
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull())
    ;(document.querySelector(selector) as HTMLElement).click()
  }
  const swipe = (direction: 'next' | 'previous') => {
    const viewport = document.querySelector('#readingViewport')!
    const from = direction === 'next' ? 240 : 80
    const to = direction === 'next' ? 80 : 240
    viewport.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: from }))
    viewport.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: to }))
  }
  if (!(saved.get('reader-index-v1') as { resumeReading?: boolean })?.resumeReading) {
    await click('[data-role="role"]')
    await click('[data-chat="chat"]')
  }
  if (pauseFirstRead) await firstReadStarted
  else if (failFirstRead)
    await vi.waitFor(() =>
      expect(document.querySelector('#toast')?.textContent).toContain('读取夹具暂时失败'),
    )
  else
    await vi.waitFor(() =>
      expect(document.querySelector('#readerSubtitle')?.textContent).toBeTruthy(),
    )
  const shadow = document.querySelector('#readingFlow')!.shadowRoot!
  const waitUntilReady = async () => {
    await vi.waitFor(() =>
      expect(document.querySelector('#readerSubtitle')?.textContent).toBeTruthy(),
    )
    await vi.waitFor(() =>
      expect(indexWrites.filter((value) => value.resumeReading).length).toBeGreaterThanOrEqual(2),
    )
  }
  return {
    document,
    shadow,
    click,
    swipe,
    readChat,
    listResources,
    saved,
    get maskPatternBuilds() {
      return maskPatternBuilds
    },
    releaseFirstRead,
    waitUntilReady,
    close: () => dom.window.close(),
    setReaderNavigation,
    setLoading,
    thumbnail,
  }
}

describe('reader controls and identity display boundaries', () => {
  it('loads only bound cards for the home page and still offers all cards when rebinding', async () => {
    const app = await reader({}, undefined, false, false, [], 1000)
    expect(app.listResources).toHaveBeenCalledTimes(2)
    expect(app.listResources).toHaveBeenNthCalledWith(1, {
      types: ['chat'],
      offset: 0,
      limit: 50,
      snapshot: true,
    })
    expect(app.listResources).toHaveBeenNthCalledWith(2, {
      snapshot: true,
      types: ['characterCard'],
      ids: ['role'],
      offset: 0,
      limit: 50,
    })
    await app.click('#readerBack')
    await app.click('[data-note="chat"]')
    await app.click('#rebind')
    await vi.waitFor(() =>
      expect(app.document.querySelectorAll('#bindSelect option')).toHaveLength(1002),
    )
    expect(app.document.querySelector('option[value="unused-999"]')?.textContent).toContain(
      '其它角色 999',
    )
    app.close()
  })
  it('distinguishes saving selections from running scripts and avoids restarting unchanged scripts', async () => {
    const app = await reader({ renderMode: 'full' }, undefined, false, false, [
      { key: 'mvu-schema', sourceId: 'character', name: 'MVU 变量结构', enabled: false },
    ])
    await app.click('[data-panel="display"]')
    await app.click('#manageScripts')
    await vi.waitFor(() => expect(app.document.querySelector('#applyScripts')).not.toBeNull())
    expect(app.readChat).toHaveBeenCalledWith(
      expect.objectContaining({ scriptList: true, scriptListOnly: true }),
    )
    expect(app.document.querySelector('#applyScripts')?.textContent).toBe('保存选择（不运行）')
    ;(app.document.querySelector('[data-script]') as HTMLInputElement).checked = true
    const beforeSave = app.readChat.mock.calls.length
    await app.click('#applyScripts')
    await vi.waitFor(() =>
      expect(app.saved.get('chat:chat')).toMatchObject({
        scripts: false,
        scriptOverrides: { 'mvu-schema': true },
      }),
    )
    expect(app.readChat.mock.calls.length).toBe(beforeSave)
    expect(app.document.querySelector('#sheetFeedback')?.textContent).toContain('脚本未运行')
    await app.click('#scriptsEnabled')
    expect(app.document.querySelector('#applyScripts')?.textContent).toBe('启用并应用')
    await app.click('#applyScripts')
    await vi.waitFor(() =>
      expect(app.document.querySelector('#sheetFeedback')?.textContent).toBe('已开启所选脚本运行'),
    )
    expect(app.readChat).toHaveBeenCalledWith(
      expect.objectContaining({
        scripts: true,
        scriptOverrides: { 'mvu-schema': true },
      }),
    )
    const afterEnable = app.readChat.mock.calls.length
    await app.click('#applyScripts')
    await vi.waitFor(() =>
      expect(app.document.querySelector('#sheetFeedback')?.textContent).toContain('无需重新加载'),
    )
    expect(app.readChat.mock.calls.length).toBe(afterEnable)
    await app.click('#scriptsEnabled')
    await app.click('#applyScripts')
    await vi.waitFor(() => expect(app.saved.get('chat:chat')).toMatchObject({ scripts: false }))
    expect(app.readChat).toHaveBeenLastCalledWith(expect.objectContaining({ scripts: false }))
  })

  it('reuses the validated script catalog after removing a source instead of immediately fetching it again', async () => {
    const saved = new Map<string, unknown>([
      ['preferences-v1', { renderMode: 'full', progressMode: 'chapters' }],
      ['chat:chat', { scriptSources: ['manual'] }],
    ])
    const app = await reader({}, saved, false, false, [
      { key: 'manual-rule', sourceId: 'manual', name: '手动脚本', enabled: false },
    ])
    await app.click('[data-panel="display"]')
    await app.click('#manageScripts')
    const proseReads = app.readChat.mock.calls.filter(([options]) => !options.scriptListOnly).length
    await app.click('[data-script-remove="manual"]')
    await vi.waitFor(() => expect(app.saved.get('chat:chat')).toMatchObject({ scriptSources: [] }))
    await vi.waitFor(() => expect(app.document.querySelector('#applyScripts')).not.toBeNull())
    const catalogs = app.readChat.mock.calls.filter(([options]) => options.scriptListOnly)
    expect(catalogs).toHaveLength(2)
    expect(app.readChat.mock.calls.filter(([options]) => !options.scriptListOnly)).toHaveLength(
      proseReads,
    )
  })
  it('uses the validated page to display a regex-source change without reading that page twice', async () => {
    const saved = new Map<string, unknown>([
      ['preferences-v1', { progressMode: 'chapters', renderMode: 'simple' }],
      ['chat:chat', { regexSources: { character: 'manual-regex' } }],
    ])
    const app = await reader({}, saved)
    await app.click('[data-panel="display"]')
    await app.click('#regexRules')
    const before = app.readChat.mock.calls.length
    await app.click('[data-regex-restore="character"]')
    await vi.waitFor(() => expect(app.saved.get('chat:chat')).toMatchObject({ regexSources: {} }))
    await vi.waitFor(() =>
      expect(app.document.querySelector('#sheetFeedback')?.textContent).toContain(
        '已恢复聊天随附正则',
      ),
    )
    expect(app.readChat.mock.calls).toHaveLength(before + 1)
    expect(app.shadow.querySelector('[data-floor="0"]')?.textContent).toContain('测试用户的正文')
  })
  it('compiles masking once per DOM pass while masking every text node completely', async () => {
    const small = await reader(
      { mask: true, renderMode: 'simple' },
      undefined,
      false,
      false,
      [],
      0,
      false,
      1,
    )
    const large = await reader(
      { mask: true, renderMode: 'simple' },
      undefined,
      false,
      false,
      [],
      0,
      false,
      60,
    )
    expect(large.maskPatternBuilds).toBe(small.maskPatternBuilds)
    expect(large.maskPatternBuilds).toBeGreaterThan(0)
    expect(large.shadow.querySelector('.mes_text')?.textContent).not.toContain('测试用户')
    expect(large.shadow.querySelector('.mes_text')?.querySelectorAll('p')).toHaveLength(60)
  })
  it('clears dormant script selections without reading the prose or fetching the catalog again', async () => {
    const app = await reader({ renderMode: 'full' }, undefined, false, false, [
      { key: 'phone', sourceId: 'character', name: '手机', enabled: true },
    ])
    await app.click('[data-panel="display"]')
    await app.click('#manageScripts')
    await vi.waitFor(() => expect(app.document.querySelector('#applyScripts')).not.toBeNull())
    const before = app.readChat.mock.calls.length
    await app.click('#disableScripts')
    await vi.waitFor(() =>
      expect(app.saved.get('chat:chat')).toMatchObject({ scripts: false, scriptOverrides: {} }),
    )
    expect(app.readChat.mock.calls).toHaveLength(before)
    expect((app.document.querySelector('[data-script]') as HTMLInputElement).checked).toBe(false)
  })
  it('keeps interrupted reading resumable after a failed restore read', async () => {
    const saved = new Map<string, unknown>([
      ['reader-index-v1', { lastChat: 'chat', resumeReading: true }],
      ['chat:chat', { position: { floor: 7, ratio: 0.4 } }],
    ])
    const failed = await reader({}, saved, false, true)
    expect(failed.readChat).toHaveBeenCalledWith(expect.objectContaining({ offset: 7 }))
    expect(saved.get('reader-index-v1')).toMatchObject({ resumeReading: true })
    const restored = await reader({}, saved)
    expect(restored.shadow.querySelector('[data-floor="7"]')).not.toBeNull()
    expect(saved.get('chat:chat')).toMatchObject({ position: { floor: 7, ratio: 0.4 } })
  })

  it('returns rule and script managers to display settings and removes the duplicate appearance entry', async () => {
    const app = await reader()
    await app.click('[data-panel="display"]')
    await app.click('#regexRules')
    expect(app.document.querySelectorAll('.reader-rule-group')).toHaveLength(3)
    expect(app.document.querySelectorAll('.reader-rule-group[open]')).toHaveLength(0)
    await app.click('#sheetClose')
    expect(app.document.querySelector('#sheetTitle')?.textContent).toBe('阅读显示')
    await app.click('#manageScripts')
    await vi.waitFor(() => expect(app.document.querySelector('#applyScripts')).not.toBeNull())
    expect(app.document.querySelectorAll('.reader-rule-group[open]')).toHaveLength(0)
    await app.click('#sheetClose')
    expect(app.document.querySelector('#sheetTitle')?.textContent).toBe('阅读显示')
    await app.click('#sheetClose')
    expect((app.document.querySelector('#sheet') as HTMLDialogElement).open).toBe(false)
    await app.click('[data-panel="appearance"]')
    expect(app.document.querySelector('#appearanceRules')).toBeNull()
    expect(app.document.querySelector('.appearance-reset > #resetAppearance')).not.toBeNull()
  })

  it('keeps resumed startup unpublished until the final appearance and saved floor are ready', async () => {
    const saved = new Map<string, unknown>([
      ['preferences-v1', { theme: 'night', font: 23, leading: 2.1 }],
      ['appearance:role', { enabled: true, values: { font: 27, leading: 2.3 } }],
      ['reader-index-v1', { lastChat: 'chat', resumeReading: true }],
      ['chat:chat', { position: { floor: 7, ratio: 0.4 } }],
    ])
    const app = await reader({}, saved, true, false, [], 0, true)
    expect(app.document.documentElement.hasAttribute('data-reader-starting')).toBe(true)
    expect(app.document.documentElement.classList.contains('builtin-shell')).toBe(true)
    expect(app.document.documentElement.style.getPropertyValue('--font')).toBe('27px')
    expect(app.document.documentElement.style.getPropertyValue('--leading')).toBe('2.3')
    expect(app.document.documentElement.style.colorScheme).toBe('dark')
    expect(app.document.querySelector('[data-role]')).toBeNull()
    expect(app.thumbnail).toHaveBeenCalledExactlyOnceWith('role')
    expect(app.setReaderNavigation.mock.calls.every(([state]) => state.page === 'reader')).toBe(
      true,
    )
    expect(app.setLoading).not.toHaveBeenCalled()
    app.releaseFirstRead()
    await app.waitUntilReady()
    await vi.waitFor(() => expect(app.setLoading).toHaveBeenCalledExactlyOnceWith(''))
    expect(app.document.documentElement.hasAttribute('data-reader-starting')).toBe(false)
    expect(app.shadow.querySelector('[data-floor="7"]')).not.toBeNull()
  })

  it('publishes a failed startup with a visible error', async () => {
    const saved = new Map<string, unknown>([
      ['reader-index-v1', { lastChat: 'chat', resumeReading: true }],
    ])
    const app = await reader({}, saved, false, true, [], 0, true)
    await vi.waitFor(() => expect(app.setLoading).toHaveBeenCalledExactlyOnceWith(''))
    expect(app.document.documentElement.hasAttribute('data-reader-starting')).toBe(false)
    expect(app.document.querySelector('#toast')?.textContent).toContain('读取夹具暂时失败')
  })

  it.each([false, true])(
    'passes the saved remote-resources setting to chat reads: %s',
    async (remote) => {
      const app = await reader({ remote, renderMode: 'full' })
      expect(app.readChat).toHaveBeenCalledWith(expect.objectContaining({ remote }))
      expect(app.readChat.mock.calls.every(([input]) => input.remote === remote)).toBe(true)
    },
  )

  it('restores an interrupted reading session but respects an explicit return to the list', async () => {
    const app = await reader()
    expect(app.saved.get('reader-index-v1')).toMatchObject({
      lastChat: 'chat',
      resumeReading: true,
    })
    app.swipe('next')
    await vi.waitFor(() =>
      expect(app.saved.get('chat:chat')).toMatchObject({ position: { floor: 1 } }),
    )
    app.close()
    const restored = await reader({}, app.saved)
    await restored.waitUntilReady()
    expect(restored.document.querySelector('#reader')?.hasAttribute('hidden')).toBe(false)
    expect(restored.shadow.querySelector('[data-floor="1"]')).not.toBeNull()
    await restored.click('#readerBack')
    await vi.waitFor(
      () => expect(restored.saved.get('reader-index-v1')).toMatchObject({ resumeReading: false }),
      { timeout: 10000 },
    )
    expect(restored.document.querySelector('#reader')?.hasAttribute('hidden')).toBe(true)
  }, 15000)
  it('marks the chat resumable before its initial resource read completes', async () => {
    const app = await reader({}, undefined, true)
    expect(app.saved.get('reader-index-v1')).toMatchObject({
      lastChat: 'chat',
      resumeReading: true,
    })
    app.releaseFirstRead()
    await app.waitUntilReady()
  })
  it('removes chapter buttons and navigates scroll reading by horizontal swipe', async () => {
    const app = await reader({ css: '#chat button{position:absolute;top:45%}' })
    expect(app.document.querySelector('#chapterNav')).toBeNull()
    app.swipe('next')
    await vi.waitFor(() => expect(app.shadow.querySelector('[data-floor="1"]')).not.toBeNull())
    expect(app.readChat).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }))
    app.swipe('previous')
    await vi.waitFor(() => expect(app.shadow.querySelector('[data-floor="0"]')).not.toBeNull())
    expect(app.readChat).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, backward: true }),
    )
  })

  it('offers continuous scroll and keeps only the latest five rendered floors', async () => {
    const app = await reader()
    await app.click('[data-panel="display"]')
    await app.click('[data-setting="mode"][data-value="continuous"]')
    await vi.waitFor(() =>
      expect(app.readChat).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 })),
    )
    expect(app.document.querySelector('#prevPage')?.hasAttribute('hidden')).toBe(true)
    expect(app.shadow.querySelectorAll('[data-floor]')).toHaveLength(5)

    const viewport = app.document.querySelector('#readingViewport')!
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1200 },
    })
    ;(viewport as HTMLElement).scrollTop = 800
    viewport.dispatchEvent(new app.document.defaultView!.Event('scroll'))
    await vi.waitFor(() =>
      expect(app.readChat).toHaveBeenCalledWith(expect.objectContaining({ offset: 5, limit: 3 })),
    )
    await vi.waitFor(() => expect(app.shadow.querySelectorAll('[data-floor]')).toHaveLength(5))
    expect(
      [...app.shadow.querySelectorAll('[data-floor]')].map((el) => el.getAttribute('data-floor')),
    ).toEqual(['3', '4', '5', '6', '7'])
    ;(viewport as HTMLElement).scrollTop = 0
    viewport.dispatchEvent(new app.document.defaultView!.Event('scroll'))
    await vi.waitFor(() =>
      expect(
        [...app.shadow.querySelectorAll('[data-floor]')].map((el) => el.getAttribute('data-floor')),
      ).toEqual(['0', '1', '2', '3', '4']),
    )
    ;(viewport as HTMLElement).scrollTop = 800
    viewport.dispatchEvent(new app.document.defaultView!.Event('scroll'))
    await vi.waitFor(() =>
      expect(
        [...app.shadow.querySelectorAll('[data-floor]')].map((el) => el.getAttribute('data-floor')),
      ).toEqual(['3', '4', '5', '6', '7']),
    )
  })

  it('allows full mode with body masking and explicitly identifies the unmasked panel', async () => {
    const app = await reader({ mask: true, replacement: '某某' })
    expect(app.shadow.querySelector('.mes_text p')?.textContent).toBe('某某的正文')
    await app.click('[data-panel="display"]')
    await app.click('[data-reading-mode="full"]')
    expect(app.document.querySelector('#sheetBody')?.textContent).toContain('交互状态栏保持原文')
    await app.click('#enableInteractions')
    await vi.waitFor(() => expect(app.shadow.querySelector('iframe')).not.toBeNull())
    expect(app.readChat).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }))
    expect(app.shadow.querySelector('.mes_text p')?.textContent).toBe('某某的正文')
    expect(app.document.querySelector('#readerSubtitle')?.textContent).toContain('状态栏未打码')
    await app.click('[data-panel="display"]')
    await app.click('#opt-mask')
    await vi.waitFor(() =>
      expect(app.shadow.querySelector('.mes_text p')?.textContent).toBe('测试用户的正文'),
    )
    expect(app.saved.get('preferences-v1')).toMatchObject({
      mask: false,
      replacement: '某某',
      renderMode: 'full',
    })
  })

  it('remounts full panels after applying CSS without changing the reading mode', async () => {
    const app = await reader({ renderMode: 'full' })
    await vi.waitFor(() => expect(app.shadow.querySelector('iframe')).not.toBeNull())
    const oldFrame = app.shadow.querySelector('iframe')!
    await app.click('[data-panel="appearance"]')
    ;(app.document.querySelector('#cssInput') as HTMLTextAreaElement).value =
      '#chat{background:pink}'
    await app.click('#applyCss')
    await vi.waitFor(() => {
      expect(app.shadow.querySelector('iframe')).not.toBeNull()
      expect(app.shadow.querySelector('iframe')).not.toBe(oldFrame)
    })
    expect(oldFrame.isConnected).toBe(false)
    expect(app.saved.get('preferences-v1')).toMatchObject({
      renderMode: 'full',
      css: '#chat{background:pink}',
    })
  })
})
