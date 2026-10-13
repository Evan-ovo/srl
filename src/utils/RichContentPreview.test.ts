/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'

import {
  buildArchivedChatFrontendDocument,
  buildRichContentPreview,
  hasRichPreviewContent,
  replacePreviewMacros,
  requiresSynchronousGreetingFormatting,
} from './RichContentPreview'
import { replacePreviewPickMacros } from './RichPreviewMessagePreparation'

const staticPolicy = { allowRemoteResources: false, allowScripts: false }
const scriptPolicy = { allowRemoteResources: true, allowScripts: true }

it('carries each vendor source once for archived script floors while preserving ordered child initialization', () => {
  const jquery = 'window.JQUERY_VENDOR_ONCE={};'
  const vue = 'window.VUE_VENDOR_ONCE={};'
  const css = '.FONT_VENDOR_ONCE{color:blue}'
  const snapshot = {
    message_id: 0,
    last_message_id: 0,
    name: '角色',
    role: 'assistant' as const,
    is_hidden: false,
    message: '正文',
    data: {},
    extra: {},
    swipe_id: 0,
  }
  const result = buildRichContentPreview(
    Array(8).fill('```html\n<body>状态</body>\n```').join('\n\n'),
    '角色',
    scriptPolicy,
    [{ id: 'phone', name: '手机', content: 'console.log("phone")' }],
    { archivedMessage: snapshot, vendorLibs: { jquery, vue, fontAwesomeCss: css } },
  )
  for (const marker of ['JQUERY_VENDOR_ONCE', 'VUE_VENDOR_ONCE', 'FONT_VENDOR_ONCE'])
    expect(result.document.split(marker)).toHaveLength(2)
  const body = readOuterBody(result.document)
  const children = [
    ...body.querySelectorAll<HTMLIFrameElement>(
      '.TH-render iframe,#srl-tavern-helper-script-runtimes iframe',
    ),
  ]
  expect(children).toHaveLength(9)
  expect(
    [...body.querySelectorAll<HTMLIFrameElement>('.TH-render iframe')].every(
      (frame) => frame.getAttribute('loading') === 'eager',
    ),
  ).toBe(true)
  for (const frame of children) {
    const child = frame.srcdoc
    expect(child).toContain('__SRL_PREVIEW_VENDOR_DOCUMENTS__')
    expect(child).not.toContain('VUE_VENDOR_ONCE')
    expect(child.indexOf('document.write')).toBeLessThan(child.indexOf('body>'))
  }
  const prose = buildRichContentPreview(
    '正文',
    '角色',
    scriptPolicy,
    [{ id: 'phone', name: '手机', content: 'console.log("phone")' }],
    { archivedMessage: snapshot, vendorLibs: { jquery, vue, fontAwesomeCss: css } },
  )
  expect(prose.document).not.toContain('FONT_VENDOR_ONCE')
  expect(prose.document).toContain('VUE_VENDOR_ONCE')
})

it('matches both archived iframe documents to the reader color scheme without changing card colors', () => {
  const snapshot = {
    message_id: 0,
    last_message_id: 0,
    name: '角色',
    role: 'assistant' as const,
    is_hidden: false,
    message: '',
    data: {},
    extra: {},
    swipe_id: 0,
  }
  const result = buildArchivedChatFrontendDocument(
    '<body><style>.card{background:skyblue}</style><div class="card">状态</div></body>',
    staticPolicy,
    undefined,
    snapshot,
    '#d0d3c6',
    'dark',
  )
  expect(result).toContain(':root{color-scheme:dark}')
  const child = readFrontendSrcdoc(result)
  expect(child).toContain(':root{color-scheme:dark}')
  expect(child).toContain('background:skyblue')
  expect(child).toContain('html,body{background:transparent!important}')
  const original = readFrontendSrcdoc(
    buildArchivedChatFrontendDocument('<body>状态</body>', staticPolicy, undefined, snapshot),
  )
  expect(original).not.toContain(':root{color-scheme:dark}')
})

function readOuterBody(documentSource: string): HTMLElement {
  return new DOMParser().parseFromString(documentSource, 'text/html').body
}

function readFrontendSrcdoc(documentSource: string): string {
  const iframe =
    readOuterBody(documentSource).querySelector<HTMLIFrameElement>('div.TH-render iframe')
  return iframe?.getAttribute('srcdoc') ?? ''
}

it('relaxes only animated disclosure caps, retaining collapse and deliberate scrolling', () => {
  const markup = `<style>
    .contents{max-height:2000px;overflow:hidden;transition:max-height .4s}
    .closed .contents{max-height:0}
    .scroll{max-height:200px;overflow:auto;transition:max-height .4s}
    .closed .scroll{max-height:0}
    .crop{max-height:100px;overflow:hidden;transition:max-height .4s}
  </style><div class="closed"><div class="contents">内容</div></div>`
  const source = buildArchivedChatFrontendDocument(markup, scriptPolicy, undefined, {
    message_id: 0,
    last_message_id: 0,
    name: '角色',
    role: 'assistant',
    is_hidden: false,
    message: '',
    data: {},
    extra: {},
    swipe_id: 0,
  })
  const child = new DOMParser().parseFromString(readFrontendSrcdoc(source), 'text/html')
  const runtime = child.querySelector('script[data-srl-archive-disclosures]')?.textContent
  expect(runtime).toBeTruthy()
  const style = document.createElement('style')
  // Only the author stylesheet is needed to exercise the CSSOM adaptation.
  style.textContent = markup.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  document.head.append(style)
  try {
    new Function('document', 'CSSRule', runtime!)(document, CSSRule)
    const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[]
    expect(rules[0]!.style.getPropertyValue('max-height')).toBe('none')
    expect(rules[1]!.style.getPropertyValue('max-height')).toBe('0px')
    expect(rules[2]!.style.getPropertyValue('max-height')).toBe('200px')
    expect(rules[4]!.style.getPropertyValue('max-height')).toBe('100px')
  } finally {
    style.remove()
  }
})

function readHostContext(documentSource: string): {
  formattedGreetings?: string[]
} {
  const document = new DOMParser().parseFromString(documentSource, 'text/html')
  const runtime = Array.from(document.scripts)
    .map((script) => script.textContent ?? '')
    .find((script) => script.includes('__SRL_RENDER_COMPAT_HOST__'))
  const match = runtime?.match(/const context=(\{.*?\});const tavernEvents=/s)
  return match ? (JSON.parse(match[1]) as { formattedGreetings?: string[] }) : {}
}

describe('RichContentPreview 兼容渲染链', () => {
  it('外层高度包含折叠外边距，并在展开后允许缩回内容高度', () => {
    const result = buildRichContentPreview(
      '<details><summary>标题</summary>正文</details>',
      '折叠',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )
    const parsed = new DOMParser().parseFromString(result.document, 'text/html')
    const script = Array.from(parsed.scripts).find((item) =>
      item.textContent?.includes("type:'SRL_PREVIEW_HEIGHT'"),
    )?.textContent
    expect(script).toBeTruthy()
    const body = { scrollHeight: 46 }
    const root = { offsetHeight: 76, clientHeight: 1200, scrollHeight: 1200 }
    const postMessage = vi.fn()
    let resize = () => {}
    const Observer = class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
    }
    new Function(
      'document',
      'window',
      'parent',
      'requestAnimationFrame',
      'ResizeObserver',
      script ?? '',
    )(
      { body, documentElement: root, readyState: 'complete' },
      { addEventListener: vi.fn() },
      { postMessage },
      (callback: () => void) => callback(),
      Observer,
    )
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'SRL_PREVIEW_HEIGHT', height: 76 }, '*')
    body.scrollHeight = 1146
    root.offsetHeight = 1176
    resize()
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'SRL_PREVIEW_HEIGHT', height: 1176 }, '*')
    body.scrollHeight = 46
    root.offsetHeight = 76
    resize()
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'SRL_PREVIEW_HEIGHT', height: 76 }, '*')
  })

  it('普通 CSS 形状的文字只经过 SillyTavern Markdown，不进入自定义 CSS 解释器', () => {
    const result = buildRichContentPreview(
      '城堡外墙。\n\n.status-card { color: red; padding: 12px; }\n\n这是一段正文。',
      '正文',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )
    const body = readOuterBody(result.document)

    expect(body.querySelector('.mes_text')?.innerHTML).toContain(
      '<p>.status-card { color: red; padding: 12px; }</p>',
    )
    expect(body.querySelector('.mes_text style')).toBeNull()
    expect(result.hasRichContent).toBe(false)
  })

  it('不再加入正文/CSS猜测、模拟数据或空页面诊断', () => {
    const result = buildRichContentPreview('普通正文。', '正文', scriptPolicy)

    expect(result.document).not.toContain('未识别为 CSS')
    expect(result.document).not.toContain('脚本没有生成可见预览')
    expect(result.document).not.toContain('sampleMvuData')
    expect(result.document).not.toContain('window.TavernHelper=helper')
    expect(result.document).not.toContain('__SRL_PREVIEW_MEMORY_STORAGE__')
  })

  it('严格保留 TavernHelper 的 TH-render、pre、hidden! 与 iframe 层级', () => {
    const result = buildRichContentPreview(
      '前文。\n\n```html\n<!doctype html><html><body><div>状态栏</div></body></html>\n```\n\n后文。',
      '助手前端',
      scriptPolicy,
      [],
      { renderShell: 'content' },
    )
    const body = readOuterBody(result.document)
    const wrapper = body.querySelector('div.TH-render')

    expect(wrapper).not.toBeNull()
    expect(wrapper?.children[0]?.tagName).toBe('PRE')
    expect(wrapper?.children[0]?.classList.contains('hidden!')).toBe(true)
    expect(wrapper?.children[1]?.tagName).toBe('IFRAME')
    expect(wrapper?.querySelector('iframe')?.id).toBe('TH-message--0--0')
    expect(wrapper?.querySelector('iframe')?.hasAttribute('sandbox')).toBe(false)
    expect(body.textContent).toContain('前文。')
    expect(body.textContent).toContain('后文。')
  })

  it('在依赖之后安装 SRL Host adapter，再挂载作者正文', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><main>前端正文</main></body></html>\n```',
      '助手前端',
      scriptPolicy,
      [],
      {
        renderShell: 'content',
        vendorLibs: {
          jquery: 'window.jQuery=window.$=function(){}',
          vue: 'window.Vue={}',
          vueRouter: 'window.VueRouter={}',
        },
      },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('<!DOCTYPE html>')
    expect(srcdoc.indexOf('<meta charset="utf-8">')).toBeLessThan(srcdoc.indexOf('<body>'))
    expect(srcdoc).toContain('html,body{margin:0!important;padding:0;overflow:hidden!important;')
    expect(srcdoc).toContain('window.jQuery=window.$=function(){}')
    expect(srcdoc.indexOf('window.jQuery=window.$=function(){}')).toBeLessThan(
      srcdoc.indexOf('window.parent.__SRL_RENDER_COMPAT_HOST__'),
    )
    expect(srcdoc).toContain('<main>前端正文</main>')
  })

  it('脚本预览使用关闭即清空的隔离内存存储，不读取主站 localStorage', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><script>localStorage.setItem("mode","ready")</script></body></html>\n```',
      '临时存储',
      scriptPolicy,
      [
        {
          id: 'storage',
          source: 'character',
          name: '存储脚本',
          content: 'localStorage.getItem("mode")',
        },
      ],
      { renderShell: 'content' },
    )
    const body = readOuterBody(result.document)
    const messageDocument = readFrontendSrcdoc(result.document)
    const scriptDocument =
      body
        .querySelector<HTMLIFrameElement>('#srl-tavern-helper-script-runtimes iframe')
        ?.getAttribute('srcdoc') ?? ''

    expect(result.document).toContain('__SRL_EPHEMERAL_STORAGE__')
    expect(messageDocument).toContain('storage=window.parent?.__SRL_EPHEMERAL_STORAGE__')
    expect(scriptDocument).toContain('storage=window.parent?.__SRL_EPHEMERAL_STORAGE__')
    expect(result.document).not.toContain('srl.preview.allowScripts')

    const staticResult = buildRichContentPreview('普通正文', '静态', staticPolicy)
    expect(staticResult.document).not.toContain('__SRL_EPHEMERAL_STORAGE__')
  })

  it('通过共享 Host 为脚本建立独立隐藏 iframe，并按脚本 id 排序', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><button onclick="setChatMessages([{message_id:0,swipe_id:1}])">切换</button></body></html>\n```',
      '助手前端',
      scriptPolicy,
      [
        { id: 'z-script', source: 'character', name: '后脚本', content: 'window.z = true' },
        {
          id: 'a-script',
          source: 'character',
          name: '前脚本',
          content: 'eventOn(tavern_events.APP_READY, () => {})',
          data: { enabled: true },
        },
      ],
      {
        renderShell: 'content',
        greetingContents: ['开场白一', '开场白二'],
        greetingIndex: 0,
      },
    )
    const body = readOuterBody(result.document)
    const frames = Array.from(
      body.querySelectorAll<HTMLIFrameElement>('#srl-tavern-helper-script-runtimes iframe'),
    )

    expect(result.runtimeScriptCount).toBe(2)
    expect(frames.map((frame) => frame.id)).toEqual([
      'TH-script--前脚本--a-script',
      'TH-script--后脚本--z-script',
    ])
    const firstScriptDocument = frames[0]?.getAttribute('srcdoc') ?? ''
    expect(firstScriptDocument).toContain('<script type="module">')
    expect(firstScriptDocument).toContain('eventOn(tavern_events.APP_READY, () => {})')
    expect(firstScriptDocument).not.toContain('safeWindow')
    expect(firstScriptDocument).not.toContain('data-srl-original-href')
    expect(firstScriptDocument).not.toContain('wrapAuthorScriptContent')
    expect(firstScriptDocument).toContain(
      'const meta={"id":"a-script","name":"前脚本","source":"character"',
    )
    expect(result.document).toContain('"greetings":["开场白一","开场白二"]')
    expect(result.document).toContain(
      'parent.postMessage({protocol,type:control.greetingNavigate,target:requested}',
    )
    expect(result.document).toContain('setChatMessage(meta,fields,messageId,options={})')
    expect(firstScriptDocument).toContain('getChatMessages:(...args)=>invoke')
    expect(firstScriptDocument).toContain('replaceVariables:(...args)=>invoke')
    expect(firstScriptDocument).not.toContain('import * as z')
    expect(result.document).not.toContain('window.Mvu=')
    expect(result.compatibilityDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'message.format',
          implementationStatus: 'PARTIAL',
          parityStatus: 'UNVERIFIED',
        }),
        expect.objectContaining({
          capability: 'mvu.opening-preview',
          implementationStatus: 'UNSUPPORTED',
          parityStatus: 'UNSUPPORTED_HOST_BOUND',
        }),
      ]),
    )
  })

  it('普通多 opening context 只登记 current formatter 输出，alternates 保持 raw', () => {
    const greetings = Array.from({ length: 10 }, (_, index) => `**开场 ${index}**`)
    const result = buildRichContentPreview(
      greetings[1],
      'current first',
      scriptPolicy,
      [{ id: 'runtime', name: 'runtime', content: 'void 0' }],
      { greetingContents: greetings, greetingIndex: 1 },
    )
    const formattedGreetings = readHostContext(result.document).formattedGreetings

    expect(formattedGreetings?.[0]).toBe('**开场 0**')
    expect(formattedGreetings?.[1]).toContain('<strong>开场 1</strong>')
    expect(formattedGreetings?.[2]).toBe('**开场 2**')
  })

  it('formatAsDisplayedMessage 常规与 literal property 写法触发同步 compatibility escape hatch', () => {
    const greetings = ['**开场 A**', '**开场 B**']
    expect(requiresSynchronousGreetingFormatting(greetings, [])).toBe(false)
    expect(
      requiresSynchronousGreetingFormatting(greetings, [
        {
          id: 'direct',
          name: 'direct',
          content: 'formatAsDisplayedMessage(message)',
        },
      ]),
    ).toBe(true)
    expect(
      requiresSynchronousGreetingFormatting(greetings, [
        {
          id: 'literal',
          name: 'literal',
          content: "TavernHelper['formatAsDisplayedMessage'](message)",
        },
      ]),
    ).toBe(true)

    const result = buildRichContentPreview(
      greetings[1],
      'sync formatter',
      scriptPolicy,
      [
        {
          id: 'literal',
          name: 'literal',
          content: "TavernHelper['formatAsDisplayedMessage']('**开场 A**')",
        },
      ],
      { greetingContents: greetings, greetingIndex: 1 },
    )
    const formattedGreetings = readHostContext(result.document).formattedGreetings
    expect(formattedGreetings?.[0]).toContain('<strong>开场 A</strong>')
    expect(formattedGreetings?.[1]).toContain('<strong>开场 B</strong>')
  })

  it('Trusted outer shell 内联 deterministic vendor，不依赖主站外部 vendor URL', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body>vendor</body></html>\n```',
      'vendor',
      scriptPolicy,
      [],
      { vendorLibs: { vendorGlobals: 'Object.defineProperties(globalThis,{})' } },
    )

    const outerPolicy = result.document.match(/Content-Security-Policy" content="([^"]+)"/)?.[1]
    expect(outerPolicy).toContain("script-src 'unsafe-inline' 'unsafe-eval' data: blob:")
    expect(result.document).toContain('<script>Object.defineProperties(globalThis,{})</script>')
    expect(outerPolicy).not.toContain("script-src 'self'")
    expect(outerPolicy).not.toContain('script-src https:')
  })

  it('脚本权限关闭时不启动配套脚本 iframe', () => {
    const result = buildRichContentPreview(
      '普通正文。',
      '静态',
      staticPolicy,
      [{ id: 'blocked', source: 'character', name: '脚本', content: 'window.started = true' }],
      { renderShell: 'content' },
    )

    expect(result.runtimeScriptCount).toBe(0)
    expect(result.blockedScripts).toBe(true)
    expect(result.document).not.toContain('TH-script--脚本--blocked')
    expect(result.document).not.toContain('window.started = true')
  })

  it('TavernHelper 视口变量来自资源库主窗口，而不是内容 iframe 自身高度', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><main style="min-height:100vh">前端正文</main></body></html>\n```',
      '助手前端',
      scriptPolicy,
      [],
      { renderShell: 'content' },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(result.document).toContain("data.type==='SRL_HOST_VIEWPORT_HEIGHT'")
    expect(srcdoc).toContain("event.data?.type==='SRL_VIEWPORT_HEIGHT'")
    expect(srcdoc).not.toContain('window.parent.innerHeight')
    expect(srcdoc).toContain('min-height:var(--TH-viewport-height)')
  })

  it('脚本关闭时仅阻止助手前端块中的可执行内容，不伪造执行结果', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><div id="app">静态内容</div><script>app.remove()</script></body></html>\n```',
      '静态',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('静态内容')
    expect(srcdoc).not.toContain('app.remove()')
    expect(srcdoc).not.toContain('脚本已运行')
    expect(result.blockedScripts).toBe(true)
  })

  it('脚本关闭时完整移除 javascript 链接，避免 Android 把残留地址交给外部应用', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><a id="jump" href="javascript:void(0)" onclick="setChatMessages([{message_id:0,swipe_id:1}])">切换</a></body></html>\n```',
      '静态',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('<a id="jump">切换</a>')
    expect(srcdoc).not.toContain('href="void(0)"')
    expect(srcdoc).not.toContain('javascript:void(0)')
    expect(srcdoc).not.toContain('onclick=')
  })

  it('脚本关闭时仍允许本地编译器的白名单备用开场白跳转', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><button data-srl-greeting-target="1" onclick="setChatMessages([{message_id:0,swipe_id:1}])">旧港失踪案</button></body></html>\n```',
      '开场白组',
      staticPolicy,
      [],
      { renderShell: 'content', greetingContents: ['主开场白', '旧港失踪案'] },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('data-srl-greeting-target="1"')
    expect(srcdoc).toContain('onclick="setChatMessages([{message_id:0,swipe_id:1}])"')
    expect(srcdoc).toContain("querySelectorAll('[data-srl-greeting-target]')")
    expect(srcdoc).toContain('window.setChatMessages')
    expect(srcdoc).toContain(
      "parent.postMessage({type:'SRL_GREETING_NAVIGATE',target:swipeId},'*')",
    )
    expect(result.document).toContain(
      "parent.postMessage({type:'SRL_GREETING_NAVIGATE',target:swipeId},'*')",
    )
  })

  it('脚本开启时仅在助手 iframe 内消费 javascript 链接，保留作者 href 语义', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><a id="jump" href="javascript:void(0)" onclick="setChatMessages([{message_id:0,swipe_id:1}])">切换</a></body></html>\n```',
      '动态',
      scriptPolicy,
      [],
      { renderShell: 'content', greetingContents: ['一', '二'] },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain("target.closest('a[href]')")
    expect(srcdoc).toContain('event.preventDefault()')
    expect(srcdoc).toContain("'unsafe-eval'")
    expect(srcdoc).toContain('<a id="jump" href="javascript:void(0)"')
    expect(srcdoc).toContain('onclick="setChatMessages')
    expect(srcdoc).not.toContain('data-srl-original-href')
    expect(srcdoc).not.toContain("attributeFilter:['href','xlink:href']")
    expect(srcdoc).not.toContain('neutralizeAnchor')
    expect(srcdoc).not.toContain('safeWindow')
    expect(srcdoc).not.toContain('window.open=')
  })

  it('脚本开启时不预改写作者 bare void 链接', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><a id="jump" href="void(0)" onclick="setChatMessages([{message_id:0,swipe_id:1}])">切换</a></body></html>\n```',
      '动态',
      scriptPolicy,
      [],
      { renderShell: 'content', greetingContents: ['一', '二'] },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('<a id="jump" href="void(0)"')
    expect(srcdoc).not.toContain('data-srl-original-href')
  })

  it('脚本开启时保留 TavernHelper frontend 的普通 HTTPS anchor', () => {
    const result = buildRichContentPreview(
      '```html\n<html><body><a id="reference" href="https://example.com/reference">参考资料</a></body></html>\n```',
      '普通链接',
      scriptPolicy,
      [],
      { renderShell: 'content' },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('<a id="reference" href="https://example.com/reference"')
    expect(srcdoc).not.toContain('data-srl-original-href')
    expect(srcdoc).not.toContain('window.open=')
    expect(srcdoc).not.toContain('safeWindow')
  })

  it('保留 frontend 的 stylesheet 与普通页面 href', () => {
    const result = buildRichContentPreview(
      '```html\n<html><head><link rel="stylesheet" href="https://example.com/theme.css"></head><body><a href="https://example.com/page">页面</a></body></html>\n```',
      '资源链接',
      scriptPolicy,
      [],
      { renderShell: 'content' },
    )
    const srcdoc = readFrontendSrcdoc(result.document)

    expect(srcdoc).toContain('<link rel="stylesheet" href="https://example.com/theme.css">')
    expect(srcdoc).toContain('<a href="https://example.com/page">页面</a>')
    expect(srcdoc).not.toContain('data-srl-original-href')
  })

  it('普通消息内脚本仍在 SillyTavern 消息净化阶段删除', () => {
    const result = buildRichContentPreview(
      '<div id="keep">正文</div><script>document.querySelector("#keep").remove()</script>',
      '消息',
      scriptPolicy,
      [],
      { renderShell: 'content' },
    )

    expect(readOuterBody(result.document).textContent).toContain('正文')
    expect(result.document).not.toContain('document.querySelector(&quot;#keep&quot;)')
    expect(result.document).not.toContain('document.querySelector("#keep")')
  })

  it('style 与作者 class 使用 SillyTavern 的 custom- 和 mes_text 作用域', () => {
    const result = buildRichContentPreview(
      '<style>.card{color:red}</style><div class="card">状态</div>',
      '样式',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )

    expect(result.document).toContain('.mes_text .custom-card')
    expect(result.document).toContain('class="custom-card"')
  })

  it('使用 SRL 自有确定性选择算法生成稳定 pick 预览', () => {
    const source = '{{char}} / {{user}} / {{pick::甲::乙}} / {{roll::1d6}}'
    const context = { charName: '林默', userName: '顾黎', chatId: '预览聊天' }
    const first = replacePreviewMacros(source, context)
    const second = replacePreviewMacros(source, context)

    expect(first).toBe(second)
    expect(first).toMatch(/^林默 \/ 顾黎 \/ (甲|乙) \/ \{\{roll::1d6\}\}$/)
    expect(first).not.toContain('{{pick::')
  })

  it('没有 pick 时不遍历全文计算随机种子', () => {
    const source = '长开场正文'.repeat(10000)
    const seedSource = `fixture-chat\u0000${source}`
    let seedReads = 0
    const iterator = String.prototype[Symbol.iterator]
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (
      this: string,
    ) {
      if (this.toString() === seedSource) seedReads++
      return iterator.call(this)
    })
    try {
      expect(replacePreviewPickMacros(source, source, 'fixture-chat')).toBe(source)
      expect(seedReads).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('惰性种子保留多个 pick、大小写、转义逗号和替换后偏移的既有选择', () => {
    const source = '{{char}} / {{pick::甲::乙::丙}} / {{PICK:一\\,二,三}} / {{pick::红::蓝}}'
    expect(replacePreviewMacros(source, { charName: '角色', chatId: 'fixture-chat' })).toBe(
      '角色 / 乙 / 三 / 蓝',
    )
  })

  it('兼容消息壳在同一文档保留 mes DOM，并由独立网格布局分配头像与正文', () => {
    const avatarUrl = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
    const result = buildRichContentPreview('状态正文。', '测试角色', staticPolicy, [], {
      renderShell: 'message',
      messageAvatarMode: 'visible',
      charAvatarUrl: avatarUrl,
    })
    const body = readOuterBody(result.document)
    const message = body.querySelector('.mes')

    expect(body.classList.contains('hideChatAvatars')).toBe(false)
    expect(message?.getAttribute('mesid')).toBe('0')
    expect(message?.getAttribute('is_user')).toBe('false')
    expect(message?.querySelector('.mesAvatarWrapper .avatar img')?.getAttribute('src')).toBe(
      avatarUrl,
    )
    expect(message?.querySelector('.ch_name .name_text')?.textContent).toBe('测试角色')
    expect(message?.querySelector('.mes_block .mes_text')?.textContent).toContain('状态正文。')
    expect(body.querySelector('[data-srl-preview-shell="message"]')).not.toBeNull()
    expect(result.document).toContain('grid-template-columns:auto minmax(0,1fr)')
    expect(result.document).toContain('padding-inline-start:var(--srl-message-gap);overflow:hidden')
    expect(result.document).toContain(
      'padding-block:5px;padding-inline-end:var(--mes-right-spacing);overflow-wrap:anywhere',
    )
  })

  it('隐藏头像保留兼容 DOM，并让独立消息网格释放头像宽度', () => {
    const result = buildRichContentPreview('状态正文。', '测试角色', staticPolicy, [], {
      renderShell: 'message',
      messageAvatarMode: 'hidden',
    })
    const body = readOuterBody(result.document)

    expect(body.classList.contains('hideChatAvatars')).toBe(true)
    expect(body.classList.contains('no-timer')).toBe(true)
    expect(body.classList.contains('no-tokenCount')).toBe(true)
    expect(body.classList.contains('no-mesIDDisplay')).toBe(true)
    expect(body.querySelector('.mesAvatarWrapper .avatar')).not.toBeNull()
    expect(result.document).toContain(
      'body.hideChatAvatars .mes{grid-template-columns:0 minmax(0,1fr)}',
    )
    expect(result.document).toContain(
      'body.hideChatAvatars .mesAvatarWrapper{visibility:hidden;min-width:0;width:0;overflow:hidden}',
    )
    expect(result.document).toContain(
      'body.hideChatAvatars.no-timer.no-tokenCount.no-mesIDDisplay .swipe_left{left:0}',
    )
  })

  it('开场白内容模式只输出 mes_text，不加入角色头像或消息名', () => {
    const result = buildRichContentPreview('开场白正文。', '角色名', staticPolicy, [], {
      renderShell: 'content',
      sourceKind: 'openingArchive',
    })
    const body = readOuterBody(result.document)

    expect(body.querySelector('.mes_text')?.textContent).toContain('开场白正文。')
    expect(body.querySelector('.avatar')).toBeNull()
    expect(body.querySelector('.ch_name')).toBeNull()
    expect(body.className).toBe('')
    expect(result.document).toContain('--SmartThemeBodyColor:#1f2925')
    expect(result.document).toContain(':root{color-scheme:light}')
    expect(result.document).toContain('--SmartThemeEmColor:#66706a')
  })

  it('开场白内容模式在深色主题使用可读的主题正文色', () => {
    const result = buildRichContentPreview('开场白正文。', '角色名', staticPolicy, [], {
      renderShell: 'content',
      sourceKind: 'openingArchive',
      contentTheme: 'dark',
    })

    expect(result.document).toContain('--SmartThemeBodyColor:#edf0e8')
    expect(result.document).toContain(':root{color-scheme:dark}')
    expect(result.document).toContain('--SmartThemeEmColor:#a5afa8')
  })

  it('开场白文档上报并响应折叠内容状态，不自动改变作者默认值', () => {
    const result = buildRichContentPreview(
      '<details><summary>标题</summary>正文</details>',
      '折叠',
      staticPolicy,
      [],
      {
        renderShell: 'content',
        sourceKind: 'openingArchive',
      },
    )
    const details = readOuterBody(result.document).querySelector('details')

    expect(details?.hasAttribute('open')).toBe(false)
    expect(result.document).toContain("type:'SRL_PREVIEW_DETAILS_STATE'")
    expect(result.document).toContain("data.type!=='SRL_SET_DETAILS_OPEN'")
    expect(result.document).toContain('item.open=data.open===true')
  })

  it('外层和助手 iframe 都从内容高度开始，不增加白色最小占位块', () => {
    const result = buildRichContentPreview(
      '```html\n<body><div>42px 内容</div></body>\n```',
      '高度',
      staticPolicy,
      [],
      { renderShell: 'content' },
    )

    expect(result.document).toContain('div.TH-render>iframe{display:block;width:100%;height:0')
    expect(result.document).not.toContain('min-height:160px')
    expect(result.document).not.toContain('background:#fff')
  })

  it('脚本关闭时仍只按显式 opt-in 注入受控 Workshop Behavior Runtime', () => {
    const source =
      '<section data-srl-behavior-config="{&quot;behaviors&quot;:[],&quot;states&quot;:[],&quot;interactionBindings&quot;:[]}"></section>'

    const disabled = buildRichContentPreview(source, 'Workshop', staticPolicy, [], {
      renderShell: 'content',
      frontendWorkshopBehaviorRuntime: false,
    })

    expect(disabled.document).not.toContain('data-srl-workshop-behavior-runtime="1"')

    const enabled = buildRichContentPreview(source, 'Workshop', staticPolicy, [], {
      renderShell: 'content',
      frontendWorkshopBehaviorRuntime: true,
    })

    expect(enabled.document).toContain('data-srl-workshop-behavior-runtime="1"')
    expect(enabled.runtimeScriptCount).toBe(0)
    expect(enabled.blockedScripts).toBe(false)
  })

  it('富内容判断以酒馆格式化结果与助手命中为准，不解析裸 CSS', () => {
    expect(hasRichPreviewContent('.status-card { color:red }')).toBe(false)
    expect(hasRichPreviewContent('<style>.card{color:red}</style><div>状态</div>')).toBe(true)
    expect(hasRichPreviewContent('```html\n<body><main>前端</main></body>\n```')).toBe(true)
    expect(hasRichPreviewContent('```html\n<section>代码示例</section>\n```')).toBe(false)
  })
})
