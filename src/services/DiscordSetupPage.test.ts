import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { DISCORD_BRIDGE_WRANGLER_TEMPLATE } from './DiscordBridgeDeployService'
const source = readFileSync(
  new URL('../../android/app/src/main/assets/assistant-browser.js', import.meta.url),
  'utf8',
)
function page(
  html: string,
  url = 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc',
) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  // jsdom fixtures only; actual native WebView/login compatibility requires device evidence.
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 20, height: 20, top: 0, left: 0, bottom: 20, right: 20 }] as unknown as DOMRectList
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const run = dom.window.eval(source) as (
    operation: string,
    payload: Record<string, unknown>,
  ) => Record<string, unknown>
  return {
    dom,
    run: (operation: string, payload: Record<string, unknown> = {}) => run(operation, payload),
    document: dom.window.document,
  }
}
function filled() {
  const value = JSON.parse(DISCORD_BRIDGE_WRANGLER_TEMPLATE)
  value.d1_databases[0].database_id = '12345678-1234-5678-9abc-123456789abc'
  value.vars.DISCORD_APPLICATION_ID = '1234567890123456789'
  value.vars.DISCORD_PUBLIC_KEY = 'a'.repeat(64)
  return value
}
function validate(value: unknown, expectedApplicationId?: string) {
  const f = page('<textarea name="content"></textarea>')
  f.document.querySelector('textarea')!.value =
    typeof value === 'string' ? value : JSON.stringify(value)
  const receipt = f.run('validate', { expectedApplicationId })
  f.dom.window.close()
  return receipt
}
describe('bundled external-page executor', () => {
  it('understands general titles, body, forms, links, regions and slices without reading password values', () => {
    const f = page(
      '<title>资料查询</title><main><h1>结果</h1><p>提交已成功</p><section aria-label="详细资料"><p>' +
        'abcdef '.repeat(900) +
        '</p></section><form aria-label="查询"><label for="name">姓名</label><input id="name"><button>提交</button></form><a href="https://example.org/file.json" download>下载文件</a></main>',
      'https://example.org/form',
    )
    const snapshot = f.run('inspect', { general: true, query: '提交已成功' })
    expect(snapshot).toMatchObject({ title: '资料查询', pageAccess: 'public', searchMatched: true })
    expect(snapshot.text).toContain('提交已成功')
    expect(snapshot.regions).toBeDefined()
    expect(snapshot.forms).toBeDefined()
    expect(snapshot.links).toBeDefined()
    const first = f.run('read-page', { general: true, offset: 0, limit: 400 })
    expect(first.nextOffset).toBe(400)
    const next = f.run('read-page', { general: true, offset: first.nextOffset, limit: 400 })
    expect(next.text).not.toBe(first.text)
    f.dom.window.close()
  })
  it('supports user-selected file uploads and returns a native key action rather than a fake default event', () => {
    const f = page(
      '<label for="file">附件</label><input id="file" type="file"><label for="name">姓名</label><input id="name">',
      'https://example.org/form',
    )
    const snapshot = f.run('inspect', { general: true })
    const controls = snapshot.controls as Array<{ target: string; label: string }>
    const file = controls.find((control) => control.label === '附件')!,
      name = controls.find((control) => control.label === '姓名')!
    expect(f.run('upload', { general: true, ...file })).toMatchObject({
      ok: true,
      clickPoint: expect.any(Object),
    })
    expect(f.run('press', { general: true, nativeKey: true, key: 'Tab', ...name })).toMatchObject({
      ok: true,
      keyDispatch: true,
    })
    f.dom.window.close()
  })
  it('fills a normal general text area while retaining the Discord Wrangler-only path', () => {
    const f = page(
      '<label for="description">介绍</label><textarea id="description" name="content"></textarea>',
      'https://example.org/form',
    )
    const snapshot = f.run('inspect', { general: true })
    const control = (snapshot.controls as Array<{ target: string; label: string }>)[0]!
    expect(f.run('fill', { general: true, ...control, value: 'ordinary text' })).toMatchObject({
      ok: true,
      filled: true,
    })
    f.dom.window.close()
  })
  it('reports same-App authorization success without inspecting password or other field values', () => {
    const f = page(
      '<h1>成功！</h1><p>已获得授权并添加至您的 APP！</p><p>您现在可以关闭此窗口或标签页。</p><input type="hidden">',
      'https://discord.com/oauth2/authorize?client_id=1234567890123456789',
    )
    Object.defineProperty(f.document.querySelector('input')!, 'value', {
      get() {
        throw new Error('private field read')
      },
    })
    const info = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
    expect(
      f.run('watch-installation', {
        expectedApplicationId: '1234567890123456789',
        marker: 'srl-12345678-1234-1234-1234-123456789abc',
      }),
    ).toMatchObject({ installationCompleted: true })
    expect(info).toHaveBeenCalledOnce()
    expect(f.dom.window.__srlDiscordInstallationCancel).toBeUndefined()
    f.dom.window.close()
  })
  it('observes the authorization SPA completion once, and rejects another App or a login form', async () => {
    const f = page(
      '<form><input type="password"><button>成功</button></form>',
      'https://discord.com/oauth2/authorize?client_id=1234567890123456789',
    )
    const payload = {
      expectedApplicationId: '1234567890123456789',
      marker: 'srl-12345678-1234-1234-1234-123456789abc',
    }
    const info = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
    expect(
      f.run('watch-installation', { ...payload, expectedApplicationId: '2234567890123456789' }),
    ).toMatchObject({ ok: false })
    expect(f.run('watch-installation', payload)).toMatchObject({
      installationCompleted: false,
      observing: true,
    })
    f.document.body.innerHTML =
      '<h1>Success!</h1><p>Successfully added to your app.</p><p>You can close this window.</p>'
    await Promise.resolve()
    expect(info).toHaveBeenCalledOnce()
    f.document.body.appendChild(f.document.createElement('p'))
    await Promise.resolve()
    expect(info).toHaveBeenCalledOnce()
    f.dom.window.close()
  })
  it('does not trust unbound redirected success or a generic success caption', () => {
    const f = page('<h1>Success!</h1>', 'https://discord.com/oauth2/authorized')
    const payload = {
      expectedApplicationId: '1234567890123456789',
      marker: 'srl-12345678-1234-1234-1234-123456789abc',
    }
    expect(f.run('watch-installation', payload)).toMatchObject({ ok: false })
    expect(f.run('watch-installation', { ...payload, installationStarted: true })).toMatchObject({
      installationCompleted: false,
    })
    f.dom.window.close()
  })
  it('observes the public Worker site without treating it as GitHub or deployment proof', () => {
    const f = page(
      '<h1>SRL Discord Bridge</h1><a href="/interactions">Interactions Endpoint URL</a>',
      'https://preview-abc.bridge.account.workers.dev/',
    )
    try {
      expect(f.run('inspect')).toMatchObject({
        pageKind: 'worker-site',
        headings: ['SRL Discord Bridge'],
      })
      expect(f.run('verify-step', { step: 'cf-deploy' })).not.toMatchObject({ verified: true })
    } finally {
      f.dom.window.close()
    }
  })
  it('keeps public Worker routes and long names readable without returning input secrets', () => {
    const route = 'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/workers/new'
    const name = 'my-team-production-discord-source-worker'
    const f = page(
      `<h1>${route}</h1><button>${name}</button><label>API Secret<input id="secret" value="PRIVATE_SECRET"></label>`,
      route,
    )
    Object.defineProperty(f.document.querySelector('#secret'), 'value', {
      get: () => {
        throw new Error('Secret read')
      },
    })
    const observed = f.run('inspect')
    expect(observed.headings).toContain(route)
    expect(JSON.stringify(observed.controls)).toContain(name)
    expect(JSON.stringify(observed)).not.toContain('PRIVATE_SECRET')
    f.dom.window.close()
  })
  it.each([
    '<h1>Authorize Cloudflare Workers and Pages</h1><input type="password"><button>Authorize Cloudflare Workers and Pages</button>',
    '<h1>Authorize Other App</h1><button>Authorize Other App</button>',
  ])('does not authorize a password gate or an unrelated OAuth app', (html) => {
    const f = page(html, 'https://github.com/login/oauth/authorize')
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const observed = f.run('inspect')
    if (Array.isArray(observed.controls))
      f.run('click', { ...observed.controls[0], autonomous: true })
    else expect(observed).toMatchObject({ waitingForUser: true })
    expect(clicked).not.toHaveBeenCalled()
    f.dom.window.close()
  })

  it.each(['Authorize Cloudflare Workers and Pages', 'Authorize'])(
    'authorizes the verified Cloudflare consent using its actual %s button',
    (button) => {
      const f = page(
        `<h1>Authorize Cloudflare Workers and Pages</h1><button>${button}</button>`,
        'https://github.com/login/oauth/authorize',
      )
      const controls = f.run('inspect').controls as Array<Record<string, unknown>>
      expect(controls).toHaveLength(1)
      expect(f.run('click', { ...controls[0], autonomous: true })).toMatchObject({
        ok: true,
        dispatched: true,
      })
      f.dom.window.close()
    },
  )

  it('does not require narrowing an existing Cloudflare installation that already covers the task repository', () => {
    const f = page(
      '<h1>Cloudflare Workers and Pages</h1><form><label><input type="radio" value="all" checked>All repositories</label><button>Save</button></form>',
      'https://github.com/settings/installations/1234',
    )
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(
      f.run('click', {
        ...controls.find((c) => c.label === 'Save'),
        autonomous: true,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }),
    ).toMatchObject({ ok: true, dispatched: true })
    f.dom.window.close()
  })
  it('observes public controls outside the viewport before directing focus', () => {
    const f = page(
      '<button>Connect GitHub</button>',
      'https://dash.cloudflare.com/account/workers-and-pages/create',
    )
    const button = f.document.querySelector('button')!
    button.getClientRects = () =>
      [
        { width: 80, height: 30, top: 1800, left: 20, bottom: 1830, right: 100 },
      ] as unknown as DOMRectList
    expect(f.run('inspect').controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Connect GitHub', visible: false }),
      ]),
    )
    f.dom.window.close()
  })
  it('prepares a verified native click without dispatching a synthetic DOM click', () => {
    const f = page(
      '<button>Connect GitHub</button>',
      'https://dash.cloudflare.com/account/workers-and-pages/create',
    )
    const button = f.document.querySelector('button')!
    button.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 }) as DOMRect
    f.document.elementFromPoint = () => button
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(f.run('click', { ...controls[0], nativeClick: true })).toMatchObject({
      ok: true,
      clickPoint: { x: 30, y: 20 },
    })
    expect(clicked).not.toHaveBeenCalled()
    f.document.elementFromPoint = () => f.document.body
    expect(f.run('click', { ...controls[0], nativeClick: true })).toMatchObject({ ok: false })
    f.dom.window.close()
  })
  it('accepts a selected repository chip whose removal button contains its repository name', () => {
    const f = page(
      '<h1>Cloudflare Workers and Pages</h1><form><label><input type="radio" value="selected" checked>Only select repositories</label><div>SRL-Discord-Bridge<button aria-label="Remove SRL-Discord-Bridge">×</button></div><button>Save</button></form>',
      'https://github.com/settings/installations/1234',
    )
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(
      f.run('click', {
        ...controls.find((c) => c.label === 'Save'),
        autonomous: true,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }),
    ).toMatchObject({ ok: true, dispatched: true })
    f.dom.window.close()
  })

  it('distinguishes a disabled GitHub installation Save from stale controls and agent permission', () => {
    const f = page(
      '<h1>Cloudflare Workers and Pages</h1><form><label><input type="radio" value="all" checked>All repositories</label><button disabled>Save</button></form>',
      'https://github.com/settings/installations/1234',
    )
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const save = controls.find((control) => control.label === 'Save')!
    expect(save).toMatchObject({ disabled: true })
    const receipt = f.run('click', {
      ...save,
      autonomous: true,
      expectedFork: 'test-user/SRL-Discord-Bridge',
    })
    expect(receipt).toMatchObject({ ok: false })
    expect(JSON.stringify(receipt)).toContain('网站将此控件标为禁用')
    expect(JSON.stringify(receipt)).toContain('覆盖本次 Fork')
    expect(JSON.stringify(receipt)).not.toContain('控件已变化')
    expect(clicked).not.toHaveBeenCalled()
    f.dom.window.close()
  })
  it.each([
    '/apps/cloudflare-workers-and-pages/installations/new',
    '/apps/cloudflare-workers-and-pages/installations/new/permissions/authorize',
  ])('selects and authorizes the task repository on GitHub %s', (path) => {
    const f = page(
      '<h1>Install Cloudflare Workers and Pages</h1><form><label><input type="radio" name="scope" value="all">All repositories</label><label><input type="radio" name="scope" value="selected" checked>Only select repositories</label><select multiple><option selected>test-user/SRL-Discord-Bridge</option><option>Other</option></select><button>Install &amp; Authorize</button></form>',
      'https://github.com' + path,
    )
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const observation = f.run('inspect')
    expect(observation.ok).toBe(true)
    const controls = observation.controls as Array<Record<string, unknown>>
    const authorize = controls.find((control) => control.label === 'Install & Authorize')!
    expect(authorize).toBeDefined()
    expect(
      f.run('click', {
        ...authorize,
        autonomous: true,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }),
    ).toMatchObject({ ok: true, dispatched: true, verified: false })
    expect(clicked).toHaveBeenCalledOnce()
    f.dom.window.close()
  })
  it.each([
    {
      scope: 'all',
      repositories: ['test-user/SRL-Discord-Bridge'],
      path: '/apps/cloudflare-workers-and-pages/installations/new',
      autonomous: true,
    },
    {
      scope: 'selected',
      repositories: ['another-user/unrelated'],
      path: '/apps/cloudflare-workers-and-pages/installations/new',
      autonomous: true,
    },
    {
      scope: 'selected',
      repositories: ['test-user/SRL-Discord-Bridge', 'another-user/unrelated'],
      path: '/apps/cloudflare-workers-and-pages/installations/new',
      autonomous: true,
    },
    {
      scope: 'selected',
      repositories: ['test-user/SRL-Discord-Bridge'],
      path: '/apps/unrelated-app/installations/new',
      autonomous: true,
    },
    {
      scope: 'selected',
      repositories: ['test-user/SRL-Discord-Bridge'],
      path: '/apps/cloudflare-workers-and-pages/installations/new',
      autonomous: false,
    },
  ])('does not grant an unverified repository installation scope: %j', (scenario) => {
    const f = page(
      `<h1>Cloudflare Workers and Pages</h1><form><label><input type="radio" checked value="${scenario.scope}">${scenario.scope === 'all' ? 'All repositories' : 'Only select repositories'}</label><select multiple>${scenario.repositories.map((name) => `<option selected>${name}</option>`).join('')}</select><button>Install &amp; Authorize</button></form>`,
      'https://github.com' + scenario.path,
    )
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const authorize = controls.find((control) => control.label === 'Install & Authorize')!
    expect(
      f.run('click', {
        ...authorize,
        autonomous: scenario.autonomous,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }).ok,
    ).toBe(false)
    expect(clicked).not.toHaveBeenCalled()
    f.dom.window.close()
  })
  it('adds the task repository to an existing installation without removing other repository access', () => {
    const f = page(
      '<h1>Configure Cloudflare Workers and Pages</h1><form><label><input type="radio" value="selected" checked>Only select repositories</label><select multiple><option selected>test-user/Existing</option><option selected>test-user/SRL-Discord-Bridge</option></select><button>Save</button></form>',
      'https://github.com/settings/installations/123',
    )
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(
      f.run('click', {
        ...controls.find((item) => item.label === 'Save'),
        autonomous: true,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }),
    ).toMatchObject({ ok: true, dispatched: true, verified: false })
    expect(clicked).toHaveBeenCalledOnce()
    expect(f.document.querySelectorAll('option:checked')).toHaveLength(2)
    f.dom.window.close()
  })
  it('still stops at password verification inside a GitHub repository installation', () => {
    const f = page(
      '<h1>Cloudflare Workers and Pages</h1><input type="password" value="PRIVATE_PASSWORD"><button>Install &amp; Authorize</button>',
      'https://github.com/apps/cloudflare-workers-and-pages/installations/new',
    )
    Object.defineProperty(f.document.querySelector('input'), 'value', {
      get() {
        throw new Error('Password read')
      },
    })
    expect(f.run('inspect')).toMatchObject({
      ok: false,
      waitingForUser: true,
      pageAccess: 'authentication',
    })
    expect(JSON.stringify(f.run('inspect'))).not.toContain('PRIVATE_PASSWORD')
    f.dom.window.close()
  })
  it('finds icon controls by their public title and dispatches the observed control', () => {
    const f = page(
      '<button title="Close search"><svg></svg></button><button aria-label="Actual name" title="Other name"></button>',
    )
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const close = controls.find((item) => item.label === 'Close search')!
    expect(close).toBeDefined()
    expect(f.run('click', close)).toMatchObject({ ok: true, dispatched: true, verified: false })
    expect(clicked).toHaveBeenCalledOnce()
    expect(controls).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Actual name' })]),
    )
    f.dom.window.close()
  })
  it('observes public form rejection text without exposing inputs or secret feedback', () => {
    const f = page(
      '<form><label>Application name<input value="current-value"></label><p>Application name cannot contain discord</p><p>Token invalid: PRIVATE_VALUE</p><p hidden>Error hidden</p></form>',
    )
    const input = f.document.querySelector('input')!
    Object.defineProperty(input, 'value', {
      get() {
        throw new Error('Input read')
      },
    })
    const result = f.run('inspect')
    expect(result.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Application name cannot contain discord',
          kind: 'result-text',
          sensitive: false,
        }),
      ]),
    )
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE')
    expect(JSON.stringify(result)).not.toContain('current-value')
    expect(JSON.stringify(result)).not.toContain('Error hidden')
    f.dom.window.close()
  })
  it('reports disabled submit controls without mistaking a valid editor for saved GitHub content', () => {
    const f = page(
      '<textarea name="content"></textarea><button disabled>Commit changes...</button>',
    )
    f.document.querySelector('textarea')!.value = JSON.stringify(filled())
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const commit = controls.find((control) => control.label === 'Commit changes...')
    expect(commit).toMatchObject({ kind: 'button', disabled: true, sensitive: false })
    expect(f.run('click', commit!)).toMatchObject({ ok: false })
    expect(clicked).not.toHaveBeenCalled()
    expect(f.run('validate')).toMatchObject({ ok: true, formatOnly: true })
    expect(f.run('verify-step', { step: 'github-save', autonomous: true })).toMatchObject({
      ok: false,
    })
    f.dom.window.close()
  })
  it('observes accessible tabs, menus, radios and switches, and refuses disabled controls', () => {
    const f = page(
      '<div role="tab" aria-labelledby="title">ignored</div><span id="title">Build settings</span><div role="menuitem">Import repository</div><div role="radio" aria-checked="true">main</div><div role="switch" aria-checked="false">Automatic deployments</div><div role="link">Deployments</div><div role="button" aria-disabled="true">Unavailable</div>',
    )
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tab', label: 'Build settings' }),
        expect.objectContaining({ kind: 'menuitem', label: 'Import repository' }),
        expect.objectContaining({ kind: 'radio', checked: true }),
        expect.objectContaining({ kind: 'switch', checked: false }),
        expect.objectContaining({ kind: 'link', label: 'Deployments' }),
      ]),
    )
    const unavailable = controls.find((item) => item.label === 'Unavailable')!
    expect(unavailable).toMatchObject({ disabled: true })
    expect(f.run('click', unavailable)).toMatchObject({ ok: false })
    const tab = controls.find((item) => item.kind === 'tab')!
    expect(f.run('click', tab)).toMatchObject({ ok: true, dispatched: true })
    f.document.querySelector('[role=tab]')!.setAttribute('aria-disabled', 'true')
    expect(f.run('click', tab).ok).toBe(false)
    f.dom.window.close()
  })
  it('scrolls the observed menu instead of an unrelated larger page panel', () => {
    const f = page(
      '<main style="overflow-y:auto"></main><div role="listbox" aria-label="Repository choices" style="overflow-y:auto"></div>',
    )
    const main = f.document.querySelector('main')!,
      menu = f.document.querySelector('[role=listbox]')!
    Object.defineProperties(main, {
      clientHeight: { value: 700 },
      clientWidth: { value: 800 },
      scrollHeight: { value: 2000 },
    })
    Object.defineProperties(menu, {
      clientHeight: { value: 150 },
      clientWidth: { value: 250 },
      scrollHeight: { value: 1000 },
    })
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const control = controls.find((item) => item.kind === 'listbox')!
    expect(control).toBeDefined()
    expect(f.run('scroll', { ...control, direction: 'down' })).toMatchObject({
      ok: true,
      moved: true,
    })
    expect(menu.scrollTop).toBe(105)
    expect(main.scrollTop).toBe(0)
    menu.setAttribute('aria-label', 'Changed menu')
    expect(f.run('scroll', { ...control, direction: 'down' }).ok).toBe(false)
    f.dom.window.close()
  })
  it.each([
    '<a href="https://bridge.account.workers.dev/">Visit</a>',
    '<label>Worker URL<input readonly value="https://bridge.account.workers.dev/"></label>',
    '<code>https://bridge.account.workers.dev/</code>',
  ])(
    'collects the actual Worker root from rendered public content outside the viewport: %s',
    (html) => {
      const f = page(
        html +
          '<a hidden href="https://bridge.other.workers.dev/">Old</a><label>Token<input value="https://bridge.private.workers.dev/"></label>',
        'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
      )
      f.dom.window.HTMLElement.prototype.getClientRects = () =>
        [
          { width: 20, height: 20, top: 2000, bottom: 2020, left: 0, right: 20 },
        ] as unknown as DOMRectList
      Object.defineProperty(f.document.querySelector('input:not([readonly])'), 'value', {
        get() {
          throw new Error('Secret read')
        },
      })
      expect(f.run('collect-worker')).toEqual({
        ok: true,
        workerUrl: 'https://bridge.account.workers.dev',
      })
      f.document.body.insertAdjacentHTML(
        'beforeend',
        '<code>https://bridge.another.workers.dev/</code>',
      )
      expect(f.run('collect-worker').ok).toBe(false)
      f.dom.window.close()
    },
  )
  it('lets the agent select a public root when multiple domains are shown, including a bare hostname', () => {
    const f = page(
      '<code>bridge.account.workers.dev</code><code>https://bridge.old-account.workers.dev/</code>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/settings/domains',
    )
    try {
      const controls = f.run('inspect', { query: 'bridge.account' }).controls as Array<
        Record<string, string>
      >
      expect(controls).toHaveLength(1)
      expect(f.run('collect-worker', controls[0])).toMatchObject({
        ok: true,
        workerUrl: 'https://bridge.account.workers.dev',
      })
      f.document.querySelector('code')!.textContent = 'bridge.changed.workers.dev'
      expect(f.run('collect-worker', controls[0]).ok).toBe(false)
    } finally {
      f.dom.window.close()
    }
  })
  it.each(['Serving all incoming traffic', 'Running in production', '正在为生产流量提供服务'])(
    'exposes unfamiliar public result wording %s and accepts an explicit assessment tied to that fresh observation',
    (text) => {
      const f = page(
        `<section><h2>Production</h2><output>${text}</output></section><code>` +
          'a'.repeat(64) +
          '</code>',
        'https://dash.cloudflare.com/account/workers/services/view/renamed-bridge/deployments',
      )
      try {
        const controls = f.run('inspect').controls as Array<Record<string, string>>
        const statusTarget = controls.find((control) => control.label === text)!
        expect(statusTarget).toBeDefined()
        expect(JSON.stringify(controls)).not.toContain('a'.repeat(64))
        const payload = {
          step: 'cf-deploy',
          autonomous: true,
          statusTarget,
          deploymentAssessment: 'deployed',
        }
        expect(f.run('verify-step', payload)).toMatchObject({ verified: true })
        f.document.querySelector('output')!.textContent = 'Still waiting'
        expect(f.run('verify-step', payload).ok).toBe(false)
      } finally {
        f.dom.window.close()
      }
    },
  )
  it.each(['Pending', 'Running', 'Deploying', 'Build successful', 'Deployment failed'])(
    'rejects an assessment contradicted by the actual result: %s',
    (text) => {
      const f = page(
        `<output>${text}</output>`,
        'https://dash.cloudflare.com/account/workers/services/view/bridge/deployments',
      )
      try {
        const statusTarget = (f.run('inspect').controls as Array<Record<string, string>>)[0]
        expect(
          f.run('verify-step', {
            step: 'cf-deploy',
            autonomous: true,
            statusTarget,
            deploymentAssessment: 'deployed',
          }),
        ).not.toMatchObject({ verified: true })
      } finally {
        f.dom.window.close()
      }
    },
  )
  it('keeps public controls available in both build and variable settings', () => {
    const f = page(
      '<button>Connect GitHub</button>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/settings/builds',
    )
    expect(f.run('inspect', { step: 'cf-deploy' })).toMatchObject({ ok: true })
    f.dom.reconfigure({
      url: 'https://dash.cloudflare.com/account/workers/services/view/bridge/settings/variables',
    })
    expect(f.run('inspect', { step: 'cf-deploy' })).toMatchObject({ ok: true })
    f.dom.window.close()
  })
  it.each(['settings', 'production/settings', 'settings/bindings', 'settings/triggers'])(
    'operates public Worker %s without requiring a tutorial stage change',
    (path) => {
      const f = page(
        '<button>Add binding</button>',
        'https://dash.cloudflare.com/account/workers/services/view/bridge/' + path,
      )
      const controls = f.run('inspect', { step: 'd1-create' }).controls as Array<
        Record<string, unknown>
      >
      expect(controls).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'Add binding' })]),
      )
      expect(f.run('click', controls[0])).toMatchObject({ ok: true, dispatched: true })
      f.dom.window.close()
    },
  )
  it('observes public settings without reading the variable value column', () => {
    const f = page(
      '<table><tr><th>Name</th><th>Value</th></tr><tr><td>DISCORD_BOT_TOKEN</td><td id="private">PRIVATE</td></tr></table>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/settings',
    )
    Object.defineProperty(f.document.getElementById('private'), 'textContent', {
      get() {
        throw new Error('Secret read')
      },
    })
    expect(f.run('inspect')).toMatchObject({ ok: true })
    f.dom.window.close()
  })
  it('prepares the Secret section below the viewport without reading existing values', () => {
    const f = page(
      '<section><h2>Variables and secrets</h2><button>Add</button></section>',
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings',
    )
    f.dom.window.HTMLElement.prototype.getClientRects = () =>
      [
        { width: 20, height: 20, top: 2000, bottom: 2020, left: 0, right: 20 },
      ] as unknown as DOMRectList
    const clicked = vi.fn()
    f.document.querySelector('button')!.addEventListener('click', clicked)
    expect(
      f.run('prepare-secret', {
        step: 'cf-secret',
        secretStage: 'prepare',
        secretMarker: 'srl-test',
      }),
    ).toMatchObject({ ok: true, dispatched: true, secretStage: 'prepare' })
    expect(clicked).toHaveBeenCalledOnce()
    f.dom.window.close()
  })
  it('edits the existing named Secret instead of adding a duplicate, without reading its value column', () => {
    const f = page(
      '<section><h2>Variables and secrets</h2><table><thead><tr><th>Name</th><th>Value</th><th>Actions</th></tr></thead><tbody><tr><td>DISCORD_BOT_TOKEN</td><td id="secret">encrypted</td><td><button>Edit</button></td></tr></tbody></table><button>Add</button></section>',
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/settings',
    )
    Object.defineProperty(f.document.getElementById('secret'), 'textContent', {
      get() {
        throw new Error('Existing secret value read')
      },
    })
    const edit = vi.fn(),
      add = vi.fn()
    f.document.querySelector('td button')!.addEventListener('click', edit)
    f.document.querySelector('section > button')!.addEventListener('click', add)
    expect(
      f.run('prepare-secret', {
        step: 'cf-secret',
        secretStage: 'prepare',
        secretMarker: 'srl-test',
      }),
    ).toMatchObject({ ok: true, dispatched: true })
    expect(edit).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
    f.dom.window.close()
  })
  it('exposes public field validation feedback and keeps aria-labelled credentials sensitive', () => {
    const f = page(
      '<label for="name">Application name</label><input id="name" aria-invalid="true" aria-errormessage="error"><p id="error">Application name cannot contain discord</p><span id="token-label">Bot Token</span><input aria-labelledby="token-label" aria-invalid="true" aria-errormessage="private-error"><p id="private-error">PRIVATE_SECRET</p>',
    )
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Application name',
          invalid: true,
          feedback: ['Application name cannot contain discord'],
        }),
        expect.objectContaining({ label: 'Bot Token', sensitive: true }),
      ]),
    )
    expect(JSON.stringify(controls)).not.toContain('PRIVATE_SECRET')
    f.dom.window.close()
  })
  it.each(['textbox', 'combobox', 'searchbox', 'spinbutton'])(
    'fills the observed ordinary native input with role %s and verifies readback',
    (role) => {
      const f = page(`<input aria-label="Build setting" role="${role}">`)
      const control = (f.run('inspect').controls as Array<Record<string, unknown>>)[0]
      expect(control).toMatchObject({ kind: role, sensitive: false })
      expect(f.run('fill', { ...control, value: 'public setting' })).toMatchObject({
        ok: true,
        filled: true,
      })
      expect(f.document.querySelector('input')!.value).toBe('public setting')
      f.dom.window.close()
    },
  )
  it('selects an observed custom option through its real click handler, without claiming selection succeeded', () => {
    const f = page('<div role="option" aria-selected="false">main</div>')
    const selected = vi.fn(() =>
      f.document.querySelector('[role=option]')!.setAttribute('aria-selected', 'true'),
    )
    f.document.querySelector('[role=option]')!.addEventListener('click', selected)
    const control = (f.run('inspect').controls as Array<Record<string, unknown>>)[0]!
    expect(f.run('select', control)).toMatchObject({ ok: true, dispatched: true, verified: false })
    expect(selected).toHaveBeenCalledOnce()
    expect(f.run('inspect').controls).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'option', checked: true })]),
    )
    f.dom.window.close()
  })
  it('observes plain active production status and ignores hidden editor textareas', () => {
    const f = page(
      '<textarea hidden name="content">old</textarea><div class="CodeMirror"></div><span>Active</span>',
    )
    const value = JSON.stringify(filled())
    Object.assign(f.document.querySelector('.CodeMirror')!, {
      CodeMirror: { getValue: () => value, setValue: vi.fn() },
    })
    expect(f.run('validate').ok).toBe(true)
    expect(f.run('inspect').controls).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Active', kind: 'result-text' })]),
    )
    f.dom.window.close()
  })
  it('inspects a D1 settings page and captures its UUID without a false secret-page handoff', () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = page(
      '<h1>srl-discord-source-handoff</h1><dl><dt>Database ID</dt><dd>' + uuid + '</dd></dl>',
      'https://dash.cloudflare.com/account/d1/databases/' + uuid + '/settings',
    )
    expect(f.run('inspect', { step: 'd1-uuid' })).toMatchObject({ ok: true, pageKind: 'd1-detail' })
    expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true })).toMatchObject({
      ok: true,
      parameters: { databaseId: uuid },
    })
    f.dom.window.close()
  })
  it.each(['settings', 'console', '', 'metrics'])(
    'collects the current D1 detail identity on %s without requiring a visible ID field',
    (tab) => {
      const uuid = '12345678-1234-5678-9abc-123456789abc'
      const f = page(
        '<h1>srl-discord-source-handoff</h1><a role="tab">Overview</a><a role="tab">Settings</a>',
        `https://dash.cloudflare.com/account/workers/d1/databases/${uuid}/${tab}`,
      )
      expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true })).toMatchObject({
        ok: true,
        parameters: { databaseId: uuid },
      })
      expect(f.run('collect-config', { step: 'd1-uuid' })).toMatchObject({ ok: false })
      f.dom.window.close()
    },
  )
  it('rejects an ID field that conflicts with the current D1 detail identity', () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = page(
      '<dl><dt>Database ID</dt><dd>87654321-1234-5678-9abc-123456789abc</dd></dl>',
      `https://dash.cloudflare.com/account/d1/databases/${uuid}/settings`,
    )
    expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true })).toMatchObject({
      ok: false,
    })
    f.dom.window.close()
  })
  it.each(['?database_id=', '#', '/'])(
    'does not mistake UUIDs in list URLs, fragments or database links for the selected database (%s)',
    (suffix) => {
      const uuid = '12345678-1234-5678-9abc-123456789abc'
      const f = page(
        `<a href="/account/d1/databases/${uuid}/settings">srl-discord-source-handoff</a>`,
        `https://dash.cloudflare.com/account/d1/${suffix}${uuid}`,
      )
      expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true })).toMatchObject({
        ok: false,
      })
      f.dom.window.close()
    },
  )
  it('does not bypass an explicitly selected invalid field using the D1 route identity', () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = page(
      '<span data-srl-discord-control="1">Settings</span>',
      `https://dash.cloudflare.com/account/d1/databases/${uuid}/settings`,
    )
    expect(
      f.run('collect-config', {
        step: 'd1-uuid',
        allowParameters: true,
        databaseIdTarget: { target: '1', label: 'Database ID' },
      }),
    ).toMatchObject({ ok: false })
    f.dom.window.close()
  })
  it('collects the explicitly observed named database link from a D1 list with multiple databases', () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = page(
      `<a href="/account/workers/d1/databases/87654321-1234-5678-9abc-123456789abc">Other database</a><a href="/account/workers/d1/databases/${uuid}/settings">srl-discord-source-handoff</a>`,
      'https://dash.cloudflare.com/account/workers/d1',
    )
    expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true }).ok).toBe(false)
    const observed = f.run('inspect', { query: 'srl-discord-source-handoff' }).controls as {
      target: string
      label: string
    }[]
    expect(observed).toHaveLength(1)
    expect(
      f.run('collect-config', {
        step: 'd1-uuid',
        allowParameters: true,
        databaseIdTarget: observed[0],
      }),
    ).toMatchObject({ ok: true, parameters: { databaseId: uuid } })
    expect(JSON.stringify(observed)).not.toContain(uuid)
    f.document.querySelectorAll('a')[1]!.textContent = 'Changed database name'
    expect(
      f.run('collect-config', {
        step: 'd1-uuid',
        allowParameters: true,
        databaseIdTarget: observed[0],
      }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('captures actual public App fields on a renamed information route', () => {
    const id = '1234567890123456789',
      key = 'a'.repeat(64)
    const f = page(
      `<dl><dt>Application ID</dt><dd>${id}</dd><dt>Public Key</dt><dd>${key}</dd></dl><label>Interactions Endpoint URL<input></label><a href="https://discord.com/oauth2/authorize?client_id=${id}&scope=applications.commands">Install</a>`,
      `https://discord.com/developers/applications/${id}/general-information`,
    )
    expect(f.run('collect-config', { step: 'discord-app', allowParameters: true })).toMatchObject({
      ok: true,
      parameters: { applicationId: id, publicKey: key },
    })
    const endpoint = {
      step: 'discord-endpoint',
      autonomous: true,
      expectedApplicationId: id,
      value: 'https://example.workers.dev/interactions',
    }
    expect(f.run('fill-endpoint', endpoint).ok).toBe(true)
    expect(f.run('verify-step', endpoint)).toMatchObject({ ok: true, verified: true })
    expect(f.run('open-install', { step: 'discord-install', expectedApplicationId: id }).ok).toBe(
      true,
    )
    f.dom.window.close()
  })
  it.each([
    'https://example.com/account/d1/databases/12345678-1234-5678-9abc-123456789abc',
    '/account/d1?database=12345678-1234-5678-9abc-123456789abc',
    '/account/d1/databases/not-a-uuid',
    'https://[',
  ])('rejects unrelated or malformed selected database links (%s)', (href) => {
    const f = page(
      `<a href="${href}">Target database</a>`,
      'https://dash.cloudflare.com/account/d1/',
    )
    const observed = f.run('inspect', { query: 'Target database' }).controls as {
      target: string
      label: string
    }[]
    expect(
      f.run('collect-config', {
        step: 'd1-uuid',
        allowParameters: true,
        databaseIdTarget: observed[0],
      }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  const appId = '1234567890123456789'
  it('captures only a unique explicitly displayed Token for the requested App; ordinary inspection stays blocked', () => {
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
    const f = page(
      `<label>Bot Token<input value="${token}"></label><label hidden>Password<input type="password" autocomplete="current-password"></label>`,
      `https://discord.com/developers/applications/${appId}/bot`,
    )
    Object.defineProperty(f.document.querySelector('input[type=password]'), 'value', {
      get() {
        throw new Error('Login secret read')
      },
    })
    expect(f.run('inspect')).toMatchObject({ ok: false, waitingForUser: true })
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: true,
      secret: token,
    })
    expect(f.run('capture-bot-secret', { expectedApplicationId: '9876543210123456789' }).ok).toBe(
      false,
    )
    f.document.body.insertAdjacentHTML('beforeend', `<label>Token<input value="${token}"></label>`)
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: true,
      secret: token,
    })
    f.document.body.insertAdjacentHTML(
      'beforeend',
      `<label>Token<input value="${'D'.repeat(24)}.${'E'.repeat(6)}.${'F'.repeat(32)}"></label>`,
    )
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: false,
      reason: 'ambiguous-token',
    })
    f.dom.window.close()
  })
  it('captures reset Token text and an unlinked readonly field in its labelled section, including below the viewport', () => {
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
    for (const field of [
      `<code>${token}</code>`,
      `<input readonly value="${token}">`,
      `${token}<button>Copy</button>`,
    ]) {
      const f = page(
        `<section><div>Token</div><div>${field}<button>Copy</button></div></section><section hidden><h3>Token</h3><input value="${'D'.repeat(24)}.${'E'.repeat(6)}.${'F'.repeat(32)}"></section>`,
        `https://discord.com/developers/applications/${appId}/bot`,
      )
      f.dom.window.HTMLElement.prototype.getClientRects = () =>
        [
          { width: 20, height: 20, top: 2000, bottom: 2020, left: 0, right: 20 },
        ] as unknown as DOMRectList
      expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
        ok: true,
        secret: token,
      })
      expect(f.run('inspect')).toMatchObject({ ok: false, waitingForUser: true })
      f.dom.window.close()
    }
  })
  it('ignores masked and old hidden Token controls without reading login passwords or unrelated page text', () => {
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
    const f = page(
      `<label>Token<input value="********"></label><section><h3>Bot Token</h3><code>${token}</code></section><section><h3>Description</h3><code>${'D'.repeat(24)}.${'E'.repeat(6)}.${'F'.repeat(32)}</code></section>`,
      `https://discord.com/developers/applications/${appId}/bot`,
    )
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: true,
      secret: token,
    })
    f.document.body.insertAdjacentHTML(
      'beforeend',
      '<label>Password<input type="password" autocomplete="current-password"></label>',
    )
    Object.defineProperty(f.document.querySelector('input[type=password]'), 'value', {
      get() {
        throw new Error('Verification password must not be read')
      },
    })
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: false,
      reason: 'verification-required',
    })
    f.dom.window.close()
  })
  it('does not read a Token still masked by a password control', () => {
    const f = page(
      '<label>Token<input type="password"></label>',
      `https://discord.com/developers/applications/${appId}/bot`,
    )
    Object.defineProperty(f.document.querySelector('input'), 'value', {
      get() {
        throw new Error('Masked Token must not be read')
      },
    })
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: false,
      reason: 'token-not-displayed',
    })
    f.dom.window.close()
  })
  it('locates a uniquely displayed Token even when the website changes its field caption', () => {
    const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
    const f = page(
      `<section><h3>Your bot credential</h3><div><span>${token}</span></div></section>`,
      `https://discord.com/developers/applications/${appId}/bot`,
    )
    expect(f.run('capture-bot-secret', { expectedApplicationId: appId })).toEqual({
      ok: true,
      secret: token,
    })
    expect(f.run('inspect')).toMatchObject({ ok: false, waitingForUser: true })
    f.dom.window.close()
  })
  it('fills and clears ordinary textareas while leaving secrets, readonly fields and configuration editors untouched', () => {
    const f = page(
      '<label>Description<textarea name="description"></textarea></label><label>Token<textarea name="token"></textarea></label><label>Fixed<input readonly name="fixed"></label><label>Config<textarea name="content">original file</textarea></label>',
      'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc',
    )
    const controls = f.run('inspect').controls as Array<Record<string, unknown>>
    const description = controls.find((control) => control.label === 'Description')!
    expect(f.run('fill', { ...description, value: 'My application description' })).toMatchObject({
      ok: true,
      filled: true,
    })
    expect(
      f.document.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!.value,
    ).toBe('My application description')
    expect(f.run('fill', { ...description, value: '' })).toMatchObject({ ok: true, filled: true })
    const token = controls.find((control) => control.label === 'Token')!
    Object.defineProperty(f.document.querySelector('textarea[name="token"]'), 'value', {
      get: () => {
        throw new Error('Secret read')
      },
      set: () => {
        throw new Error('Secret write')
      },
    })
    expect(f.run('fill', { ...token, value: 'must not write' })).toMatchObject({
      ok: false,
      waitingForUser: true,
    })
    expect(
      f.run('fill', {
        ...controls.find((control) => control.label === 'Fixed'),
        value: 'must not write',
      }).ok,
    ).toBe(false)
    expect(
      f.run('fill', {
        ...controls.find((control) => control.label === 'Config'),
        value: 'replace file',
      }).ok,
    ).toBe(false)
    expect(f.document.querySelector<HTMLTextAreaElement>('textarea[name="content"]')!.value).toBe(
      'original file',
    )
    f.dom.window.close()
  })
  it('reports an explicitly empty Discord list without treating loading as no applications', () => {
    const empty = page(
      '<h1>Applications</h1><p>You haven’t created any applications yet.</p><button>New Application</button>',
      'https://discord.com/developers/applications',
    )
    expect(empty.run('inspect').applicationList).toEqual({ state: 'empty', count: 0 })
    empty.dom.window.close()
    const loading = page(
      '<h1>Applications</h1><p>Loading applications…</p><button>New Application</button>',
      'https://discord.com/developers/applications',
    )
    expect(loading.run('inspect').applicationList).toEqual({ state: 'unknown', count: 0 })
    loading.dom.window.close()
  })
  it('counts existing Discord applications across the rendered list, deduplicating routes and excluding hidden or external links', () => {
    const f = page(
      '<a href="/developers/applications/' +
        appId +
        '/information">My bridge</a><a href="/developers/applications/' +
        appId +
        '/installation">Installation</a><a href="/developers/applications/2234567890123456789/information">Other bot</a><a hidden href="/developers/applications/3234567890123456789/information">Hidden</a><a href="https://example.com/developers/applications/4234567890123456789/information">External</a>',
      'https://discord.com/developers/applications',
    )
    expect(f.run('inspect').applicationList).toEqual({ state: 'available', count: 2 })
    const found = f.run('inspect', { query: 'New Application' })
    expect(found.applicationList).toEqual({ state: 'available', count: 2 })
    expect(JSON.stringify(found)).not.toContain(appId)
    f.dom.window.close()
  })
  it('uses the same observed controls to create an App and then reads its public parameters locally', () => {
    const f = page(
      '<p>No applications yet</p><button id="new">New Application</button>',
      'https://discord.com/developers/applications',
    )
    f.document.querySelector('#new')!.addEventListener('click', () => {
      f.document.body.innerHTML =
        '<section role="dialog"><label>App name<input name="app-name"></label><button id="create">Create</button></section>'
      f.document.querySelector('#create')!.addEventListener('click', () => {
        expect(f.document.querySelector('input')!.value).toBe('SRL Bridge')
        f.dom.reconfigure({
          url: 'https://discord.com/developers/applications/' + appId + '/information',
        })
        f.document.body.innerHTML =
          '<label>Application ID<input readonly value="' +
          appId +
          '"></label><label>Public Key<input readonly value="' +
          'a'.repeat(64) +
          '"></label>'
      })
    })
    const controls = () => f.run('inspect').controls as Array<Record<string, unknown>>
    expect(
      f.run(
        'click',
        controls().find((item) => item.label === 'New Application')!,
      ),
    ).toMatchObject({ ok: true, dispatched: true })
    expect(
      f.run('fill', {
        ...controls().find((item) => item.label === 'App name'),
        value: 'SRL Bridge',
      }),
    ).toMatchObject({ ok: true, filled: true })
    expect(
      f.run(
        'click',
        controls().find((item) => item.label === 'Create')!,
      ),
    ).toMatchObject({ ok: true, dispatched: true })
    expect(f.run('collect-config', { step: 'discord-app', allowParameters: true })).toMatchObject({
      ok: true,
      parameters: { applicationId: appId, publicKey: 'a'.repeat(64) },
    })
    f.dom.window.close()
  })
  it('finds a renamed-layout navigation item off screen and focuses it without user handoff', () => {
    const f = page(
      '<aside><h3>Application settings</h3><a href="/developers/applications/' +
        appId +
        '/information">General Information</a></aside>',
      'https://discord.com/developers/applications/' + appId + '/installation',
    )
    const link = f.document.querySelector('a')!
    let top = 1800
    link.getClientRects = () =>
      [
        { width: 20, height: 20, top, left: 0, bottom: top + 20, right: 20 },
      ] as unknown as DOMRectList
    link.scrollIntoView = vi.fn(() => {
      top = 20
    })
    expect(f.run('inspect').controls).toEqual(
      expect.arrayContaining([expect.objectContaining({ visible: false })]),
    )
    const found = f.run('inspect', { query: 'general   information' })
    const control = (found.controls as Array<Record<string, unknown>>)[0]!
    expect(control).toMatchObject({
      label: 'General Information',
      visible: false,
      context: 'Application settings',
    })
    expect(f.run('focus', control)).toMatchObject({ ok: true, focused: true, moved: true })
    expect(link.scrollIntoView).toHaveBeenCalledOnce()
    expect((f.run('inspect').controls as unknown[]).length).toBe(1)
    f.dom.window.close()
  })
  it('keeps page headings when a search does not match the visible Cloudflare creation controls', () => {
    const f = page(
      '<h1>Make something new</h1><button>Connect GitHub</button><button>Connect with GitLab</button>',
      'https://dash.cloudflare.com/example-account/workers-and-pages/create',
    )
    expect(f.run('inspect', { query: 'worker list deployments' })).toMatchObject({
      controls: [],
      headings: ['Make something new'],
      searchMatched: false,
    })
    expect(f.run('inspect')).toMatchObject({
      controls: [
        expect.objectContaining({ label: 'Connect GitHub' }),
        expect.objectContaining({ label: 'Connect with GitLab' }),
      ],
      headings: ['Make something new'],
    })
    f.dom.window.close()
  })
  it('bounds search results and focuses a captioned readonly text field without returning its value', () => {
    const many = page(
      Array.from({ length: 40 }, (_, index) => '<button>Settings ' + index + '</button>').join(''),
    )
    const result = many.run('inspect', { query: 'settings' })
    expect(result.truncated).toBe(true)
    expect(result.controls).toHaveLength(25)
    many.dom.window.close()
    const f = page(
      '<dl><dt>Public Key</dt><dd>' + 'a'.repeat(64) + '</dd></dl>',
      'https://discord.com/developers/applications/' + appId + '/information',
    )
    const snapshot = f.run('inspect', { query: 'public key' })
    const target = (snapshot.controls as Array<Record<string, unknown>>).find(
      (item) => item.kind === 'parameter-field',
    )!
    expect(JSON.stringify(snapshot)).not.toContain('a'.repeat(64))
    expect(f.run('focus', target)).toMatchObject({ ok: true, focused: true })
    f.dom.window.close()
  })
  it('searches field captions without reading values and leaves hidden/private fields excluded', () => {
    const f = page(
      '<section><h5>Signing verification key</h5><div><input readonly id="signing"></div></section><section hidden><h5>Signing verification key</h5><input id="hidden"></section><label>Bot Token<input name="token"></label>',
      'https://discord.com/developers/applications/' + appId + '/information',
    )
    for (const input of f.document.querySelectorAll('input'))
      Object.defineProperty(input, 'value', {
        get: () => {
          throw new Error('inspection read a value')
        },
      })
    const found = f.run('inspect', { query: 'verification key' })
    const fields = (found.controls as Array<Record<string, unknown>>).filter(
      (item) => item.kind === 'input',
    )
    expect(fields).toHaveLength(1)
    expect(fields[0]!.label).toBe('Signing verification key')
    expect(JSON.stringify(found)).not.toContain('secret')
    expect(f.run('inspect', { query: 'a'.repeat(64) }).ok).toBe(true)
    expect(f.run('inspect', { query: 'sk-' + 'a'.repeat(64) }).ok).toBe(false)
    f.dom.window.close()
  })
  it('can scroll back up when a field was passed rather than asking the user to find it', () => {
    const f = page('<main>Application settings</main>')
    const main = f.document.querySelector('main')!
    main.style.overflowY = 'auto'
    Object.defineProperties(main, {
      clientHeight: { value: 200 },
      clientWidth: { value: 300 },
      scrollHeight: { value: 1000 },
    })
    main.scrollTop = 500
    expect(f.run('scroll', { direction: 'up' })).toMatchObject({ moved: true })
    expect(main.scrollTop).toBe(360)
    expect(f.run('scroll', { direction: 'sideways' }).ok).toBe(false)
    f.dom.window.close()
  })
  it('waits on the selected running status once without reading form values', async () => {
    const f = page(
      '<section><div role="status">Deploying production</div><label>API key<input name="api_key"></label></section>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
    )
    const secret = f.document.querySelector('input')!
    Object.defineProperty(secret, 'value', {
      get: () => {
        throw new Error('secret read')
      },
    })
    const ping = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
    const snapshot = f.run('inspect', { step: 'cf-deploy' })
    const status = (snapshot.controls as Array<Record<string, string>>).find(
      (item) => item.kind === 'status',
    )!
    const payload = {
      ...status,
      step: 'cf-deploy',
      marker: 'srl-12345678-1234-1234-1234-123456789abc',
    }
    expect(f.run('watch-status', payload)).toMatchObject({ observing: true })
    f.document.querySelector('[role="status"]')!.textContent = 'Success'
    await Promise.resolve()
    expect(ping).toHaveBeenCalledExactlyOnceWith('SRL_DISCORD_READY:' + payload.marker)
    expect(f.run('check-status', payload)).toMatchObject({ changed: true })
    f.document.querySelector('[role="status"]')!.textContent = 'Active'
    await Promise.resolve()
    expect(ping).toHaveBeenCalledOnce()
    f.dom.window.close()
  })
  it('wakes once when a page replaces the entire pending status card without reading secrets', async () => {
    const f = page(
      '<main><section><div role="status">Building</div></section><label>API key<input name="api_key"></label></main>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
    )
    Object.defineProperty(f.document.querySelector('input')!, 'value', {
      get() {
        throw new Error('secret read')
      },
    })
    const ping = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
    const controls = f.run('inspect').controls as Array<Record<string, string>>
    const payload = {
      ...controls.find((control) => control.kind === 'status')!,
      marker: 'srl-12345678-1234-1234-1234-123456789abc',
    }
    expect(f.run('watch-status', payload)).toMatchObject({ observing: true })
    f.document.querySelector('section')!.outerHTML =
      '<section><div role="status">Success</div></section>'
    await Promise.resolve()
    const calls = ping.mock.calls
    expect(f.run('check-status', payload)).toMatchObject({ changed: true })
    f.dom.window.close()
    expect(calls).toEqual([['SRL_DISCORD_READY:' + payload.marker]])
  })
  it.each(['text', 'hidden'])(
    'wakes for a %s status change with a stable accessible label and ignores unrelated mutations',
    async (change) => {
      const f = page(
        '<main><section><div role="status" aria-label="Deployment status">Building</div></section><aside>Other</aside></main>',
        'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
      )
      const ping = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
      const controls = f.run('inspect').controls as Array<Record<string, string>>
      const payload = {
        ...controls.find((control) => control.kind === 'status')!,
        marker: 'srl-12345678-1234-1234-1234-123456789abc',
      }
      expect(f.run('watch-status', payload)).toMatchObject({ observing: true })
      f.document.querySelector('aside')!.textContent = 'Changed elsewhere'
      await Promise.resolve()
      expect(ping).not.toHaveBeenCalled()
      const status = f.document.querySelector('[role="status"]')! as HTMLElement
      if (change === 'text') status.textContent = 'Success'
      else status.style.visibility = 'hidden'
      await Promise.resolve()
      expect(f.run('check-status', payload)).toMatchObject({ changed: true })
      status.textContent = 'Active'
      await Promise.resolve()
      expect(ping).toHaveBeenCalledExactlyOnceWith('SRL_DISCORD_READY:' + payload.marker)
      f.dom.window.close()
    },
  )
  it.each(['Success', 'Building failed', 'Deploying cancelled'])(
    'keeps waiting through pending timers and phase text until %s',
    async (result) => {
      const f = page(
        '<section><div role="status">Building 1s</div></section>',
        'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
      )
      const ping = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
      const controls = f.run('inspect').controls as Array<Record<string, string>>
      const payload = {
        ...controls.find((control) => control.kind === 'status')!,
        marker: 'srl-12345678-1234-1234-1234-123456789abc',
      }
      expect(f.run('watch-status', payload)).toMatchObject({ observing: true })
      const status = f.document.querySelector('[role="status"]')!
      for (const text of ['Building 2s', 'Queued', 'Deploying production']) {
        status.textContent = text
        await Promise.resolve()
        expect(ping).not.toHaveBeenCalled()
        expect(f.run('check-status', payload)).toMatchObject({ changed: false })
      }
      status.textContent = result
      await Promise.resolve()
      expect(ping).toHaveBeenCalledExactlyOnceWith('SRL_DISCORD_READY:' + payload.marker)
      expect(f.run('check-status', payload)).toMatchObject({ changed: true })
      f.dom.window.close()
    },
  )
  it('cancels status observation and rejects nonpending or private-page waits', async () => {
    const f = page(
      '<section><div role="status">Building</div></section>',
      'https://dash.cloudflare.com/account/workers/services/view/bridge/production',
    )
    const ping = vi.spyOn(f.dom.window.console, 'info').mockImplementation(() => {})
    const snapshot = f.run('inspect', { step: 'cf-deploy' })
    const status = (snapshot.controls as Array<Record<string, string>>)[0]!
    const payload = {
      ...status,
      step: 'cf-deploy',
      marker: 'srl-12345678-1234-1234-1234-123456789abc',
    }
    expect(f.run('watch-status', payload)).toMatchObject({ observing: true })
    f.run('cancel-wait')
    f.document.querySelector('[role="status"]')!.textContent = 'Success'
    await Promise.resolve()
    expect(ping).not.toHaveBeenCalled()
    expect(f.run('watch-status', { ...payload, label: 'Success' }).ok).toBe(false)
    f.dom.reconfigure({
      url: 'https://dash.cloudflare.com/account/workers/services/view/bridge/production/settings/variables',
    })
    expect(f.run('watch-status', payload)).toMatchObject({ ok: false })
    f.dom.window.close()
  })
  it('selects a real dropdown option without exposing or accepting an arbitrary value', () => {
    const f = page(
      '<label for="repository">Repository</label><select id="repository"><option>Choose repository</option><option>SRL-Discord-Bridge</option></select>',
    )
    const snapshot = f.run('inspect')
    const option = (snapshot.controls as Array<Record<string, string>>).find(
      (item) => item.label === 'SRL-Discord-Bridge',
    )!
    expect(option.kind).toBe('option')
    expect(f.run('select', { target: option.target, label: option.label })).toMatchObject({
      ok: true,
    })
    expect(f.document.querySelector('select')!.selectedIndex).toBe(1)
    f.dom.window.close()
  })
  it('requires a fresh readonly result and rejects a changed or failed sync status', () => {
    const f = page(
      '<div id="status">This branch is up to date with main.</div><button>main</button><a href="/test-user/SRL-Discord-Bridge/commit/' +
        'a'.repeat(40) +
        '">latest commit</a>',
      'https://github.com/test-user/SRL-Discord-Bridge',
    )
    const snapshot = f.run('inspect')
    const control = (snapshot.controls as Array<Record<string, string>>).find(
      (item) => item.kind === 'result-text',
    )!
    expect(
      f.run('verify-step', {
        step: 'github-sync',
        autonomous: true,
        statusTarget: control,
        expectedFork: 'test-user/SRL-Discord-Bridge',
      }),
    ).toMatchObject({ verified: true })
    f.document.getElementById('status')!.textContent = 'Sync failed, conflicts detected'
    expect(
      f.run('verify-step', { step: 'github-sync', autonomous: true, statusTarget: control }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('verifies the actual committed Wrangler values and rejects another D1 or an editor URL', () => {
    const f = page(
      '<textarea id="read-only-cursor-text-area"></textarea><a href="/test-user/SRL-Discord-Bridge/commit/' +
        'a'.repeat(40) +
        '">latest commit</a>',
      'https://github.com/test-user/SRL-Discord-Bridge/blob/main/wrangler.jsonc',
    )
    const value = filled()
    f.document.querySelector('textarea')!.value = JSON.stringify(value)
    const payload = {
      step: 'github-save',
      autonomous: true,
      expectedApplicationId: appId,
      expectedPublicKey: value.vars.DISCORD_PUBLIC_KEY,
      expectedDatabaseId: value.d1_databases[0].database_id,
      expectedFork: 'test-user/SRL-Discord-Bridge',
    }
    expect(f.run('verify-step', payload)).toMatchObject({ verified: true })
    expect(
      f.run('verify-step', {
        ...payload,
        expectedDatabaseId: '87654321-1234-5678-9abc-123456789abc',
      }).ok,
    ).toBe(false)
    f.dom.reconfigure({
      url: 'https://github.com/test-user/SRL-Discord-Bridge/edit/main/wrangler.jsonc',
    })
    expect(f.run('verify-step', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it('does not mark an unsaved or rejected Discord endpoint as complete', () => {
    const f = page(
      '<label for="endpoint">Interactions Endpoint URL</label><input id="endpoint"><button>Save Changes</button>',
      `https://discord.com/developers/applications/${appId}/information`,
    )
    const value = 'https://example.account.workers.dev/interactions'
    f.document.querySelector('input')!.value = value
    const payload = {
      step: 'discord-endpoint',
      autonomous: true,
      expectedApplicationId: appId,
      value,
    }
    expect(f.run('verify-step', payload).ok).toBe(false)
    f.document.querySelector('button')!.disabled = true
    expect(f.run('verify-step', payload)).toMatchObject({ verified: true })
    f.document.body.insertAdjacentHTML('beforeend', '<div role="alert">Validation failed</div>')
    expect(f.run('verify-step', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it('reads the current GitHub route-data shape as a complete committed file, rejecting truncated or foreign data', () => {
    const value = filled(),
      revision = 'c'.repeat(40)
    const refInfo = { name: 'main', currentOid: revision }
    // Shape verified against the public GitHub file viewer; no executable script or upload token is used.
    const data = {
      payload: {
        codeViewLayoutRoute: {
          repo: { ownerLogin: 'test-user', name: 'SRL-Discord-Bridge' },
          path: 'wrangler.jsonc',
          refInfo,
        },
        codeViewBlobLayoutRoute: {
          path: 'wrangler.jsonc',
          refInfo,
          blob: { truncated: false, large: false, viewable: true },
        },
        'codeViewBlobLayoutRoute.StyledBlob': {
          rawLines: JSON.stringify(value, null, 2).split('\n'),
        },
      },
    }
    const f = page(
      '<script type="application/json" data-target="react-app.embeddedData"></script>',
      'https://github.com/test-user/SRL-Discord-Bridge/blob/main/wrangler.jsonc',
    )
    const node = f.document.querySelector('script')!
    const payload = {
      step: 'github-save',
      autonomous: true,
      expectedFork: 'test-user/SRL-Discord-Bridge',
      expectedApplicationId: appId,
      expectedPublicKey: value.vars.DISCORD_PUBLIC_KEY,
      expectedDatabaseId: value.d1_databases[0].database_id,
    }
    node.textContent = JSON.stringify(data)
    expect(f.run('verify-step', payload)).toMatchObject({ verified: true, revision })
    data.payload.codeViewBlobLayoutRoute.blob.truncated = true
    node.textContent = JSON.stringify(data)
    expect(f.run('verify-step', payload).ok).toBe(false)
    data.payload.codeViewBlobLayoutRoute.blob.truncated = false
    data.payload.codeViewLayoutRoute.repo.ownerLogin = 'another-user'
    node.textContent = JSON.stringify(data)
    expect(f.run('verify-step', payload).ok).toBe(false)
    expect(JSON.stringify(f.run('verify-step', payload))).not.toContain(
      value.vars.DISCORD_PUBLIC_KEY,
    )
    f.dom.window.close()
  })
  it('uses the model-selected public endpoint field when the caption differs from the tutorial', () => {
    const f = page(
      '<label for="endpoint">Interaction Callback Address</label><input id="endpoint"><label for="key">Public Key</label><input id="key" readonly>',
      `https://discord.com/developers/applications/${appId}/information`,
    )
    const observation = f.run('inspect')
    const control = (observation.controls as Array<Record<string, string>>).find(
      (item) => item.label === 'Interaction Callback Address',
    )!
    const payload = {
      step: 'discord-endpoint',
      autonomous: true,
      expectedApplicationId: appId,
      value: 'https://example.workers.dev/interactions',
      target: control.target,
      label: control.label,
    }
    expect(f.run('fill-endpoint', payload)).toMatchObject({
      ok: true,
      filled: true,
      waitingForUser: false,
    })
    expect(f.run('verify-step', payload)).toMatchObject({ verified: true })
    f.document.querySelector('label')!.textContent = 'Different field'
    expect(f.run('verify-step', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it.each(
    ['Active deployment', 'Current deployment', 'Production deployment active'].flatMap((text) =>
      ['', '/production', '/deployments'].map((tab) => [text, tab]),
    ),
  )(
    'accepts the current production status %s on %s without requiring a new Git build',
    (text, tab) => {
      const f = page(
        `<h1>Deployments</h1><section><h3>${text}</h3><span>Manual deployment</span><span>100%</span></section>`,
        `https://dash.cloudflare.com/account/workers/services/view/bridge${tab}`,
      )
      try {
        const controls = f.run('inspect').controls as Array<Record<string, string>>
        const statusTarget = controls.find((control) => control.label === text)!
        expect(statusTarget).toBeDefined()
        expect(
          f.run('verify-step', {
            step: 'cf-deploy',
            autonomous: true,
            statusTarget,
            deploymentAssessment: 'deployed',
          }),
        ).toMatchObject({ verified: true })
      } finally {
        f.dom.window.close()
      }
    },
  )
  it.each(['settings', 'builds', 'production/settings'])(
    'does not treat Active deployment in %s as a production result',
    (tab) => {
      const f = page(
        '<div role="status">Active deployment</div>',
        `https://dash.cloudflare.com/account/workers/services/view/bridge/${tab}`,
      )
      try {
        const statusTarget = (f.run('inspect').controls as Array<Record<string, string>>)[0]!
        expect(
          f.run('verify-step', {
            step: 'cf-deploy',
            autonomous: true,
            statusTarget,
            deploymentAssessment: 'deployed',
          }),
        ).not.toMatchObject({ verified: true })
      } finally {
        f.dom.window.close()
      }
    },
  )
  it('accepts successful production deployment without matching repository or commit text', () => {
    const revision = 'a'.repeat(40)
    const f = page(
      '<h1>Production deployments</h1><section>' +
        'Deployment details '.repeat(60) +
        '<div><div><div><div><div><div><span id="status">Deployed successfully</span></div></div></div></div></div></div></section>',
      'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production',
    )
    const observation = f.run('inspect')
    const control = (observation.controls as Array<Record<string, string>>).find(
      (item) => item.kind === 'result-text',
    )!
    const payload = {
      step: 'cf-deploy',
      autonomous: true,
      statusTarget: control,
      expectedFork: 'test-user/SRL-Discord-Bridge',
      expectedRevision: revision,
    }
    expect(f.run('verify-step', payload)).toMatchObject({ verified: true })
    expect(f.run('verify-step', { ...payload, expectedRevision: 'b'.repeat(40) })).toMatchObject({
      verified: true,
    })
    expect(
      f.run('verify-step', { ...payload, expectedFork: 'another-user/a-different-name' }),
    ).toMatchObject({ verified: true })
    f.document.getElementById('status')!.textContent = 'Build successful'
    const buildObservation = f.run('inspect')
    const buildControl = (buildObservation.controls as Array<Record<string, string>>).find(
      (item) => item.kind === 'result-text',
    )!
    expect(f.run('verify-step', { ...payload, statusTarget: buildControl }).ok).toBe(false)
    for (const text of ['Failed', 'Pending', 'Deploying']) {
      f.document.getElementById('status')!.textContent = text
      const observed = f.run('inspect')
      const selected = (observed.controls as Array<Record<string, string>>).find(
        (item) => item.label === text,
      )!
      expect(f.run('verify-step', { ...payload, statusTarget: selected }).ok).toBe(false)
    }
    f.dom.window.close()
  })
  it('observes only public field handles on a Worker form and blocks generic value access', () => {
    const f = page(
      '<form><label for="name">Name</label><input id="name"><label for="type">Type</label><select id="type"><option>Secret</option></select><label for="value">Value</label><input id="value"></form>',
      'https://dash.cloudflare.com/account/workers/services/view/another-worker/settings',
    )
    for (const el of f.document.querySelectorAll('input'))
      Object.defineProperty(el, 'value', {
        get: () => {
          throw new Error('Secret form values must not be read')
        },
      })
    expect(f.run('inspect', { step: 'cf-deploy' })).toMatchObject({ ok: true })
    for (const operation of ['collect-config', 'fill'])
      expect(f.run(operation, { step: 'cf-deploy', allowParameters: true })).toMatchObject({
        ok: false,
      })
    f.dom.window.close()
  })
  it('fills only the labelled interaction field on the same App and waits for save', () => {
    const f = page(
      '<label for="endpoint">Interactions Endpoint URL</label><input id="endpoint">',
      `https://discord.com/developers/applications/${appId}/information`,
    )
    const value = 'https://example.account.workers.dev/interactions'
    const receipt = f.run('fill-endpoint', {
      step: 'discord-endpoint',
      expectedApplicationId: appId,
      value,
    })
    expect(receipt).toMatchObject({ ok: true, filled: true, waitingForUser: true })
    expect(f.document.querySelector<HTMLInputElement>('#endpoint')!.value).toBe(value)
    expect(JSON.stringify(receipt)).not.toContain(value)
    expect(
      f.run('fill-endpoint', {
        step: 'discord-endpoint',
        expectedApplicationId: '9876543210123456789',
        value,
      }).ok,
    ).toBe(false)
    f.document.body.insertAdjacentHTML(
      'beforeend',
      '<label for="other">Interactions Endpoint URL</label><input id="other">',
    )
    expect(
      f.run('fill-endpoint', { step: 'discord-endpoint', expectedApplicationId: appId, value }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('selects one official install URL from the correct App without clicking authorization', () => {
    const url = `https://discord.com/oauth2/authorize?client_id=${appId}`
    const f = page(
      `<label>Install Link</label><input readonly value="${url}"><a href="${url}">Install</a>`,
      `https://discord.com/developers/applications/${appId}/installation`,
    )
    const payload = { step: 'discord-install', expectedApplicationId: appId }
    expect(f.run('open-install', payload)).toEqual({ ok: true, installUrl: url })
    const input = f.document.querySelector('input')!
    f.document.querySelector('a')!.remove()
    for (const bad of [
      url + '&redirect_uri=https://example.com',
      url + '&scope=identify',
      url + '&client_id=' + appId,
      url.replace('discord.com', 'discord.com.example'),
      url.replace(appId, '9876543210123456789'),
    ]) {
      input.value = bad
      expect(f.run('open-install', payload).ok).toBe(false)
    }
    input.value = url
    f.document.body.insertAdjacentHTML(
      'beforeend',
      `<a href="${url}&amp;integration_type=1">Another</a>`,
    )
    expect(f.run('open-install', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it('does not inspect or automate the installation authorization page', () => {
    const f = page('<button>Authorize</button>', 'https://discord.com/oauth2/authorize')
    expect(
      f.run('open-install', { step: 'discord-install', expectedApplicationId: appId }),
    ).toEqual({ ok: false, waitingForUser: true, pageAccess: 'authentication' })
    expect(f.run('inspect')).toEqual({
      ok: false,
      waitingForUser: true,
      pageAccess: 'authentication',
    })
    f.dom.window.close()
  })
  const secretUrl =
    'https://dash.cloudflare.com/account/workers/services/view/srl-discord-source-bridge/production/settings'
  const secretPayload = { step: 'cf-secret', secretStage: 'prepare', secretMarker: 'test-session' }
  const secretHtml =
    '<form><label for="type">Type</label><select id="type"><option value="plain">Text</option><option value="encrypted">Secret</option></select><label for="name">Variable name</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><button type="button">Deploy</button></form>'
  it.each(['prepare', 'input', 'submit', 'saved', 'submitted'])(
    'reports the saved Secret row during %s without reading its value',
    (stage) => {
      const f = page(
        '<table><tr><th>Type</th><th>Key</th><th>Value</th></tr><tr><td>Secret (encrypted)</td><td>DISCORD_BOT_TOKEN</td><td id="private-value">PRIVATE_SECRET</td></tr></table>',
        secretUrl,
      )
      Object.defineProperty(f.document.querySelector('#private-value'), 'textContent', {
        get() {
          throw new Error('Secret row value must not be read')
        },
      })
      const receipt = f.run('inspect', { ...secretPayload, secretStage: stage })
      expect(receipt).toMatchObject({ secretSavedOnPage: true })
      expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SECRET')
      if (stage === 'input') expect(receipt).not.toHaveProperty('controls')
      f.dom.window.close()
    },
  )
  it.each(['Text', 'Secret'])(
    'does not treat an open edit form or a %s row alone as newly saved',
    (type) => {
      const f = page(
        `<table><tr><th>Name</th><th>Type</th><th>Value</th></tr><tr><td>DISCORD_BOT_TOKEN</td><td>${type}</td><td>PRIVATE_SECRET</td></tr></table>${type === 'Secret' ? secretHtml : ''}`,
        secretUrl,
      )
      expect(f.run('inspect', secretPayload)).toMatchObject({ secretSavedOnPage: false })
      f.dom.window.close()
    },
  )
  function secretFixture(html = secretHtml) {
    const f = page(html, secretUrl)
    const value = f.document.querySelector('#value')!
    Object.defineProperty(value, 'value', {
      get() {
        throw new Error('Secret value must never be read')
      },
    })
    Object.defineProperty(value, 'textContent', {
      get() {
        throw new Error('Secret text must never be read')
      },
    })
    f.dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
      new f.dom.window.DOMRect(100, 200, 250, 44)
    return f
  }
  it('recovers a changed Secret layout with public targets, without reading its value', () => {
    const f = page(
      '<section><h3>Environment configuration</h3><div><div><div><div><button>Add a secret</button></div></div></div></div></section>',
      secretUrl.replace('srl-discord-source-bridge', 'renamed-bridge'),
    )
    expect(f.run('prepare-secret', secretPayload)).toMatchObject({ ok: false, recovery: true })
    const entry = (
      f.run('inspect', { ...secretPayload, query: 'add' }).controls as Array<Record<string, string>>
    )[0]!
    f.document.querySelector('button')!.addEventListener('click', () => {
      f.document.body.innerHTML =
        '<div role="dialog"><label>Key name<input id="key"></label><label>Storage class<select id="class"><option>Secret</option></select></label><label>Credential value<textarea id="payload"></textarea></label><button>Save changes and deploy</button></div>'
      Object.defineProperty(f.document.querySelector('#payload'), 'value', {
        get() {
          throw new Error('Secret read')
        },
        set() {},
      })
    })
    expect(f.run('click', { ...secretPayload, ...entry })).toMatchObject({
      ok: true,
      dispatched: true,
    })
    const fields = f.run('inspect', secretPayload).controls as Array<Record<string, string>>
    const payload = {
      ...secretPayload,
      secretNameTarget: fields.find((x) => x.label === 'Key name'),
      secretTypeTarget: fields.find((x) => x.label.startsWith('Storage class')),
      secretValueTarget: fields.find((x) => x.label === 'Credential value'),
    }
    expect(f.run('prepare-secret', payload)).toMatchObject({ ok: true, secretStage: 'input' })
    expect(f.document.querySelector<HTMLInputElement>('#key')!.value).toBe('DISCORD_BOT_TOKEN')
    expect(f.run('inspect', { ...secretPayload, secretStage: 'input' })).toMatchObject({
      ok: false,
      waitingForUser: true,
    })
    const buttons = f.run('inspect', { ...secretPayload, secretStage: 'submit' }).controls as Array<
      Record<string, string>
    >
    const save = buttons.find((x) => x.label === 'Save changes and deploy')!
    expect(
      f.run('submit-secret', { ...secretPayload, secretStage: 'submit', ...save }),
    ).toMatchObject({ ok: true, secretStage: 'submitted' })
    f.dom.window.close()
  })
  it('refuses changed selected Secret fields and never writes to a stale form', () => {
    const f = secretFixture()
    const fields = f.run('inspect', secretPayload).controls as Array<Record<string, string>>
    const payload = {
      ...secretPayload,
      secretNameTarget: fields.find((x) => x.label === 'Variable name'),
      secretTypeTarget: fields.find((x) => x.label === 'Type'),
      secretValueTarget: fields.find((x) => x.label === 'Value'),
    }
    f.document.querySelector('label[for="name"]')!.textContent = 'Another field'
    expect(f.run('prepare-secret', payload).ok).toBe(false)
    expect(f.document.querySelector<HTMLInputElement>('#name')!.value).toBe('')
    f.dom.window.close()
  })
  it('selects one actual same-App installation link from multiple candidates', () => {
    const id = '1234567890123456789'
    const f = page(
      `<a href="https://discord.com/oauth2/authorize?client_id=${id}&integration_type=0">Guild install</a><a href="https://discord.com/oauth2/authorize?client_id=${id}&integration_type=1">User install</a>`,
      `https://discord.com/developers/applications/${id}/installation`,
    )
    expect(f.run('open-install', { expectedApplicationId: id, step: 'discord-install' }).ok).toBe(
      false,
    )
    const selected = (f.run('inspect').controls as Array<Record<string, string>>).find(
      (x) => x.label === 'User install',
    )!
    expect(
      f.run('open-install', { ...selected, expectedApplicationId: id, step: 'discord-install' }),
    ).toMatchObject({
      ok: true,
      installUrl: `https://discord.com/oauth2/authorize?client_id=${id}&integration_type=1`,
    })
    f.document.querySelectorAll('a')[1]!.href = 'https://example.com/'
    expect(
      f.run('open-install', { ...selected, expectedApplicationId: id, step: 'discord-install' }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it.each(['native', 'aria', 'switch'] as const)(
    'prepares Key/Value and a %s Secret checkbox, blindly fills, and adds/deploys without reading values',
    (kind) => {
      const toggle =
        kind === 'native'
          ? '<label for="encrypted">Secret</label><input id="encrypted" type="checkbox">'
          : `<div id="encrypted" role="${kind === 'switch' ? 'switch' : 'checkbox'}" aria-label="${kind === 'switch' ? 'Encrypt this value' : 'Secret (encrypted)'}" aria-checked="false"></div>`
      const f = secretFixture(
        `<form><label for="name">Key</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea>${toggle}<button type="button">Add variable and deploy</button></form>`,
      )
      const checkbox = f.document.querySelector<HTMLElement>('#encrypted')!
      if (kind === 'native')
        Object.defineProperty(checkbox, 'value', {
          get() {
            throw new Error('Checkbox value must not be read')
          },
        })
      else
        checkbox.addEventListener('click', () =>
          checkbox.setAttribute(
            'aria-checked',
            checkbox.getAttribute('aria-checked') === 'true' ? 'false' : 'true',
          ),
        )
      const clicked = vi.fn()
      checkbox.addEventListener('click', clicked)
      expect(f.run('prepare-secret', secretPayload)).toMatchObject({
        ok: true,
        secretStage: 'prepare',
        preparedAction: 'type',
      })
      expect(f.run('prepare-secret', secretPayload)).toMatchObject({
        ok: true,
        secretStage: 'input',
      })
      expect(clicked).toHaveBeenCalledOnce()
      expect(f.document.querySelector<HTMLInputElement>('#name')!.value).toBe('DISCORD_BOT_TOKEN')
      const secret = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
      const transferred = f.run('fill-stored-secret', {
        ...secretPayload,
        secretStage: 'input',
        secret,
      })
      expect(transferred).toMatchObject({ ok: true, secretStage: 'submit' })
      expect(JSON.stringify(transferred)).not.toContain(secret)
      expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
        ok: true,
        secretStage: 'submitted',
        dispatched: true,
      })
      expect(clicked).toHaveBeenCalledOnce()
      f.dom.window.close()
    },
  )
  it.each(['automatic', 'selected'] as const)(
    'submits the %s dialog footer after binding fields inside a nested Secret row',
    (mode) => {
      const f = secretFixture(
        '<button id="outside">Add 1 variable and deploy</button><div role="dialog"><h2>Add environment variable</h2><div class="content"><div class="row"><label for="name">Key</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><label for="encrypted">Secret</label><input id="encrypted" type="checkbox" checked></div></div><footer><button id="deploy" type="button">Add 1 variable and deploy</button></footer></div>',
      )
      const fields = f.run('inspect', secretPayload).controls as Array<Record<string, unknown>>
      const payload = {
        ...secretPayload,
        secretNameTarget: fields.find((x) => x.label === 'Key'),
        secretTypeTarget: fields.find((x) => x.label === 'Secret'),
        secretValueTarget: fields.find((x) => x.label === 'Value'),
      }
      const deploy = vi.fn()
      const outside = vi.fn()
      f.document.querySelector('#deploy')!.addEventListener('click', deploy)
      f.document.querySelector('#outside')!.addEventListener('click', outside)
      expect(f.run('prepare-secret', payload)).toMatchObject({ ok: true, secretStage: 'input' })
      expect(
        f.run('fill-stored-secret', {
          ...secretPayload,
          secretStage: 'input',
          secret: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`,
        }),
      ).toMatchObject({ ok: true, secretStage: 'submit' })
      const buttons = f.run('inspect', { ...secretPayload, secretStage: 'submit' })
        .controls as Array<Record<string, unknown>>
      const selected = buttons.find(
        (x) =>
          x.target ===
          f.document.querySelector('#deploy')!.getAttribute('data-srl-discord-control'),
      )!
      const wrong = buttons.find(
        (x) =>
          x.target ===
          f.document.querySelector('#outside')!.getAttribute('data-srl-discord-control'),
      )!
      expect(
        f.run('submit-secret', {
          ...secretPayload,
          secretStage: 'submit',
          ...wrong,
          label: 'Old label',
        }).ok,
      ).toBe(false)
      expect(
        f.run('submit-secret', {
          ...secretPayload,
          secretStage: 'submit',
          ...(mode === 'selected' ? selected : {}),
        }),
      ).toMatchObject({ ok: true, secretStage: 'submitted', dispatched: true })
      expect(deploy).toHaveBeenCalledOnce()
      expect(outside).not.toHaveBeenCalled()
      f.dom.window.close()
    },
  )
  it('uses a freshly selected custom save control outside the field container, without a fixed label', () => {
    const f = secretFixture(
      '<form><div><label for="name">Key</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><label for="encrypted">Secret</label><input id="encrypted" type="checkbox" checked></div></form><div role="button" id="apply">Apply changes</div><div role="button" id="publish">Confirm production release</div><button id="reveal">Show secret</button><button>Delete Worker</button>',
    )
    expect(f.run('prepare-secret', secretPayload)).toMatchObject({ secretStage: 'input' })
    expect(
      f.run('fill-stored-secret', {
        ...secretPayload,
        secretStage: 'input',
        secret: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`,
      }),
    ).toMatchObject({ secretStage: 'submit' })
    const buttons = f.run('inspect', { ...secretPayload, secretStage: 'submit' }).controls as Array<
      Record<string, unknown>
    >
    const apply = buttons.find((x) => x.label === 'Apply changes')!
    const reveal = buttons.find((x) => x.label === 'Show secret')!
    const deletion = buttons.find((x) => x.label === 'Delete Worker')!
    const clicked = vi.fn()
    expect(
      f.run('submit-secret', { ...secretPayload, secretStage: 'submit', ...deletion }).ok,
    ).toBe(false)
    f.document.querySelector('#apply')!.addEventListener('click', clicked)
    expect(f.run('focus', { ...secretPayload, secretStage: 'submit', ...apply })).toMatchObject({
      ok: true,
    })
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit', ...reveal }).ok).toBe(
      false,
    )
    expect(
      f.run('submit-secret', { ...secretPayload, secretStage: 'submit', ...apply }),
    ).toMatchObject({ ok: true, secretStage: 'saved' })
    expect(clicked).toHaveBeenCalledOnce()
    const next = f.run('inspect', { ...secretPayload, secretStage: 'saved' }).controls as Array<
      Record<string, unknown>
    >
    const publish = next.find((x) => x.label === 'Confirm production release')!
    const deployed = vi.fn()
    f.document.querySelector('#publish')!.addEventListener('click', deployed)
    expect(
      f.run('submit-secret', { ...secretPayload, secretStage: 'saved', ...publish }),
    ).toMatchObject({ ok: true, secretStage: 'submitted' })
    expect(deployed).toHaveBeenCalledOnce()
    f.dom.window.close()
  })
  it.each(['submit', 'saved'] as const)(
    'allows public browser controls during Secret %s while protecting the value',
    (stage) => {
      const f = secretFixture(secretHtml + '<button id="menu">More options</button>')
      Object.defineProperty(f.document, 'scrollingElement', { value: f.document.documentElement })
      Object.defineProperties(f.document.documentElement, {
        clientHeight: { value: 300 },
        scrollHeight: { value: 900 },
      })
      const controls = f.run('inspect', { ...secretPayload, secretStage: stage }).controls as Array<
        Record<string, unknown>
      >
      const menu = controls.find((x) => x.label === 'More options')!
      const clicked = vi.fn()
      f.document.querySelector('#menu')!.addEventListener('click', clicked)
      expect(f.run('focus', { ...secretPayload, secretStage: stage, ...menu })).toMatchObject({
        ok: true,
      })
      expect(
        f.run('scroll', { ...secretPayload, secretStage: stage, direction: 'down' }),
      ).toMatchObject({ ok: true })
      expect(f.run('click', { ...secretPayload, secretStage: stage, ...menu })).toMatchObject({
        ok: true,
        dispatched: true,
      })
      expect(clicked).toHaveBeenCalledOnce()
      const name = controls.find((x) => x.label === 'Variable name')!
      expect(
        f.run('fill', {
          ...secretPayload,
          secretStage: stage,
          ...name,
          value: 'DISCORD_BOT_TOKEN',
        }),
      ).toMatchObject({ ok: true, filled: true })
      const value = controls.find((x) => x.label === 'Value')!
      expect(
        f.run('fill', { ...secretPayload, secretStage: stage, ...value, value: 'forbidden' }).ok,
      ).toBe(false)
      f.dom.window.close()
    },
  )
  it('binds selected Key/Value/Secret checkbox targets and exposes only checked state', () => {
    const f = secretFixture(
      '<div role="dialog"><label for="name">Key</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><label for="encrypted">Secret</label><input id="encrypted" type="checkbox" checked><button>Add variable and deploy</button></div>',
    )
    const fields = f.run('inspect', secretPayload).controls as Array<Record<string, unknown>>
    const selected = fields.find((x) => x.label === 'Secret')!
    expect(selected).toMatchObject({ kind: 'checkbox', sensitive: false, checked: true })
    const payload = {
      ...secretPayload,
      secretNameTarget: fields.find((x) => x.label === 'Key'),
      secretTypeTarget: selected,
      secretValueTarget: fields.find((x) => x.label === 'Value'),
    }
    expect(f.run('prepare-secret', payload)).toMatchObject({ ok: true, secretStage: 'input' })
    f.document.querySelector<HTMLInputElement>('#encrypted')!.checked = false
    expect(
      f.run('fill-stored-secret', {
        ...secretPayload,
        secretStage: 'input',
        secret: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`,
      }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('does not treat a plaintext checkbox as Secret encryption or fill its value', () => {
    const f = secretFixture(
      '<form><label for="name">Key</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><input type="checkbox" id="plaintext" aria-label="Not encrypted / plaintext"><button>Add variable and deploy</button></form>',
    )
    const fields = f.run('inspect', secretPayload).controls as Array<Record<string, string>>
    expect(
      f.run('prepare-secret', {
        ...secretPayload,
        secretNameTarget: fields.find((x) => x.label === 'Key'),
        secretTypeTarget: fields.find((x) => x.label.includes('plaintext')),
        secretValueTarget: fields.find((x) => x.label === 'Value'),
      }),
    ).toMatchObject({ ok: false, recovery: true })
    expect(f.document.querySelector<HTMLInputElement>('#name')!.value).toBe('')
    f.dom.window.close()
  })
  it('blindly fills only the prepared fixed Secret form, without reading or returning the value', () => {
    const f = secretFixture()
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    const secret = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`
    const payload = { ...secretPayload, secretStage: 'input', secret }
    expect(f.run('fill-stored-secret', { ...payload, secretMarker: 'wrong' }).ok).toBe(false)
    const result = f.run('fill-stored-secret', payload)
    expect(result).toMatchObject({ ok: true, secretStage: 'submit' })
    expect(JSON.stringify(result)).not.toContain(secret)
    const getter = Object.getOwnPropertyDescriptor(
      f.dom.window.HTMLTextAreaElement.prototype,
      'value',
    )!.get!
    expect(getter.call(f.document.querySelector('#value'))).toBe(secret)
    f.document.body.innerHTML = secretHtml
    expect(f.run('fill-stored-secret', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it('prepares the exact name and Secret type, points at Value, and never reads the secret', () => {
    const f = secretFixture()
    expect(f.run('prepare-secret', secretPayload)).toMatchObject({
      ok: true,
      secretStage: 'prepare',
    })
    expect(f.document.querySelector<HTMLSelectElement>('#type')!.value).toBe('encrypted')
    const ready = f.run('prepare-secret', secretPayload)
    expect(ready).toMatchObject({ ok: true, secretStage: 'input', waitingForUser: true })
    expect(f.document.querySelector<HTMLInputElement>('#name')!.value).toBe('DISCORD_BOT_TOKEN')
    expect(ready.guideAnchor).toBeTruthy()
    expect(f.run('inspect', { step: 'cf-secret', secretStage: 'input' })).toEqual({
      ok: false,
      waitingForUser: true,
      secretSavedOnPage: false,
    })
    expect(f.run('inspect')).toMatchObject({ ok: true })
    f.dom.window.close()
  })
  it('submits only after handoff, refuses changed forms, and never reads the value during submission', () => {
    const f = secretFixture()
    let clicks = 0
    f.document.querySelector('button')!.addEventListener('click', () => clicks++)
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'input' }).ok).toBe(false)
    const type = f.document.querySelector<HTMLSelectElement>('#type')!
    type.value = 'plain'
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' }).ok).toBe(false)
    type.value = 'encrypted'
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      ok: true,
      secretStage: 'submitted',
      waitingForUser: true,
    })
    expect(clicks).toBe(1)
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' }).ok).toBe(false)
    f.dom.window.close()
  })
  it('distinguishes a closed form from a missing submit button without claiming the value was never filled', () => {
    const f = secretFixture()
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    f.document.querySelector('button')!.remove()
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('按钮')],
    })
    f.document.body.innerHTML = '<h2>Variables and Secrets</h2>'
    const closed = f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })
    expect(closed).toMatchObject({ ok: false, errors: [expect.stringContaining('表单')] })
    expect(JSON.stringify(closed)).not.toContain('未填写')
    f.dom.window.close()
  })
  it('does not submit a replaced form or prepare another existing variable', () => {
    const f = secretFixture()
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    f.document.body.innerHTML = secretHtml
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' }).ok).toBe(false)
    f.document.querySelector<HTMLInputElement>('#name')!.value = 'OTHER_SETTING'
    expect(f.run('prepare-secret', secretPayload).ok).toBe(false)
    f.dom.window.close()
  })
  it('rebinds a remounted submit form without reading the existing secret or adding a new variable', () => {
    const f = secretFixture()
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    f.document.body.innerHTML = secretHtml
    f.document.querySelector<HTMLInputElement>('#name')!.value = 'DISCORD_BOT_TOKEN'
    f.document.querySelector<HTMLSelectElement>('#type')!.value = 'encrypted'
    Object.defineProperty(f.document.querySelector('#value'), 'value', {
      get() {
        throw new Error('Secret read')
      },
    })
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('绑定')],
    })
    expect(f.run('prepare-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      ok: true,
      secretStage: 'input',
    })
    expect(
      f.run('fill-stored-secret', {
        ...secretPayload,
        secretStage: 'input',
        secret: `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(32)}`,
      }),
    ).toMatchObject({ ok: true, secretStage: 'submit' })
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      ok: true,
      secretStage: 'submitted',
    })
    f.dom.window.close()
  })
  it('observes and clicks the saved row action without reading the explicitly headed Value column', () => {
    const f = page(
      '<table><tr><th>Name</th><th>Type</th><th>Value</th></tr><tr><td>DISCORD_BOT_TOKEN</td><td>Secret</td><td id="private-value">PRIVATE_SECRET<button>Copy</button></td><td><button id="edit">Edit variable</button></td></tr></table>',
      secretUrl,
    )
    Object.defineProperty(f.document.querySelector('#private-value'), 'textContent', {
      get() {
        throw new Error('Secret value read')
      },
    })
    const receipt = f.run('inspect', secretPayload)
    const controls = receipt.controls as Array<Record<string, unknown>>
    const edit = controls.find((x) => x.label === 'Edit variable')!
    expect(edit).toMatchObject({ context: 'DISCORD_BOT_TOKEN', sensitive: false })
    expect(controls.some((x) => x.label === 'Copy')).toBe(false)
    const clicked = vi.fn()
    f.document.querySelector('#edit')!.addEventListener('click', clicked)
    expect(f.run('click', { ...secretPayload, ...edit })).toMatchObject({
      ok: true,
      dispatched: true,
    })
    expect(clicked).toHaveBeenCalledOnce()
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SECRET')
    f.dom.window.close()
  })
  it('navigates Settings and the scoped Add button without general page inspection', () => {
    const f = page('<button>Settings</button>', secretUrl.replace('/settings', ''))
    let clicked = false
    f.document.querySelector('button')!.addEventListener('click', () => {
      clicked = true
    })
    expect(f.run('prepare-secret', secretPayload)).toMatchObject({ ok: true, dispatched: true })
    expect(clicked).toBe(true)
    f.document.body.innerHTML =
      '<section><h2>Variables and Secrets</h2><button>Add</button></section><section><button>Add</button></section>'
    expect(f.run('prepare-secret', secretPayload).ok).toBe(true)
    f.document.querySelector('section')!.insertAdjacentHTML('beforeend', '<button>Add</button>')
    expect(f.run('prepare-secret', secretPayload).ok).toBe(false)
    f.dom.window.close()
  })
  it('supports a separate Save then deployment confirmation without reading values', () => {
    const f = secretFixture(secretHtml.replace('>Deploy<', '>Save<'))
    f.run('prepare-secret', secretPayload)
    f.run('prepare-secret', secretPayload)
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' })).toMatchObject({
      secretStage: 'saved',
    })
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'saved' }).ok).toBe(false)
    f.document.body.innerHTML = '<div role="dialog"><button>Deploy</button></div>'
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'saved' })).toMatchObject({
      ok: true,
      secretStage: 'submitted',
    })
    f.dom.window.close()
  })
  it('refuses secret preparation outside production, login or without native permission', () => {
    for (const url of [
      secretUrl.replace('production', 'staging'),
      'https://dash.cloudflare.com/login',
    ]) {
      const f = page(secretHtml, url)
      expect(f.run('prepare-secret', secretPayload).ok).toBe(false)
      f.dom.window.close()
    }
    const f = secretFixture()
    expect(f.run('prepare-secret', { ...secretPayload, secretMarker: '' }).ok).toBe(false)
    f.dom.window.close()
  })
  it('allows only the labelled Secret value password field, while refusing unrelated login fields', () => {
    const f = secretFixture(
      secretHtml.replace('<textarea id="value"></textarea>', '<input type="password" id="value">'),
    )
    f.run('prepare-secret', secretPayload)
    expect(f.run('prepare-secret', secretPayload)).toMatchObject({ ok: true, secretStage: 'input' })
    f.document.body.insertAdjacentHTML(
      'beforeend',
      '<input type="password" aria-label="Login password">',
    )
    expect(f.run('submit-secret', { ...secretPayload, secretStage: 'submit' }).ok).toBe(false)
    f.dom.window.close()
  })
  it('collects only the two labelled App parameters after local permission, never a Bot Token', () => {
    const id = '1234567890123456789',
      key = 'a'.repeat(64)
    const f = page(
      `<label for="appid">Application ID</label><input id="appid" readonly value="${id}"><label for="public">Public Key</label><input id="public" readonly value="${key}"><label for="bot">Bot Token</label><input id="bot" value="SECRET_DO_NOT_READ">`,
      `https://discord.com/developers/applications/${id}/information`,
    )
    expect(f.run('collect-config', { step: 'discord-app' }).ok).toBe(false)
    expect(f.run('collect-config', { step: 'discord-app', allowParameters: true })).toEqual({
      ok: true,
      parameters: { applicationId: id, publicKey: key },
    })
    expect(JSON.stringify(f.run('inspect'))).not.toContain(key)
    expect(
      f.run('collect-config', {
        step: 'discord-app',
        allowParameters: true,
        expectedApplicationId: '9999999999999999999',
      }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('requires one labelled D1 UUID and does not scrape Bot or authorization pages', () => {
    const uuid = '12345678-1234-5678-9abc-123456789abc'
    const f = page(
      `<dl><dt>Database ID</dt><dd>${uuid}</dd></dl>`,
      'https://dash.cloudflare.com/account/d1/database',
    )
    expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true })).toEqual({
      ok: true,
      parameters: { databaseId: uuid },
    })
    f.document.body.insertAdjacentHTML(
      'beforeend',
      '<dl><dt>Database ID</dt><dd>99999999-1234-5678-9abc-123456789abc</dd></dl>',
    )
    expect(f.run('collect-config', { step: 'd1-uuid', allowParameters: true }).ok).toBe(false)
    f.dom.window.close()
    for (const url of [
      'https://discord.com/oauth2/authorize',
      'https://discord.com/developers/applications/1234567890123456789/bot',
    ]) {
      const f = page(
        '<label>Public Key</label><span>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</span>',
        url,
      )
      expect(f.run('collect-config', { step: 'discord-app', allowParameters: true }).ok).toBe(false)
      f.dom.window.close()
    }
  })
  it('reads labelled public fields below the fold in heading/wrapper layouts without touching a Token', () => {
    const f = page(
      `<section><div><h5>Application ID</h5></div><div><input value="${appId}"></div></section>
       <section><div><h5>Public Key</h5></div><div><div>${'a'.repeat(64)}</div></div></section>
       <section><h5>Bot Token</h5><input id="bot-token"></section>`,
      `https://discord.com/developers/applications/${appId}/information`,
    )
    f.dom.window.HTMLElement.prototype.getClientRects = () =>
      [
        { width: 20, height: 20, top: 2200, left: 0, bottom: 2220, right: 20 },
      ] as unknown as DOMRectList
    Object.defineProperty(f.document.querySelector('#bot-token'), 'value', {
      get: () => {
        throw new Error('Token must never be read')
      },
    })
    expect(f.run('collect-config', { step: 'discord-app', allowParameters: true })).toEqual({
      ok: true,
      parameters: { applicationId: appId, publicKey: 'a'.repeat(64) },
    })
    f.dom.window.close()
  })
  it('explains application-list versus missing-public-field failures without returning partial values', () => {
    const f = page(
      '<a href="/developers/applications/1234567890123456789/information">My App</a>',
      'https://discord.com/developers/applications',
    )
    const payload = { step: 'discord-app', allowParameters: true }
    expect(f.run('collect-config', payload)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('应用列表')],
    })
    f.dom.reconfigure({ url: `https://discord.com/developers/applications/${appId}/information` })
    f.document.body.innerHTML = `<label for="appid">Application ID</label><input id="appid" value="${appId}">`
    const receipt = f.run('collect-config', payload)
    expect(receipt).toMatchObject({ ok: false, errors: [expect.stringContaining('Public Key')] })
    expect(JSON.stringify(receipt)).not.toContain(appId)
    expect(receipt).not.toHaveProperty('parameters')
    f.dom.window.close()
  })
  it('rejects a matching public-key-shaped value in another field group and hidden stale fields', () => {
    const f = page(
      `<section><label for="appid">Application ID</label><input id="appid" value="${appId}"></section>
       <section><h5>Public Key</h5><input value="not a public key"></section>
       <section><h5>Bot Token</h5><input id="bot-token" value="${'b'.repeat(64)}"></section>
       <section hidden><h5>Public Key</h5><input value="${'a'.repeat(64)}"></section>`,
      `https://discord.com/developers/applications/${appId}/information`,
    )
    Object.defineProperty(f.document.querySelector('#bot-token'), 'value', {
      get: () => {
        throw new Error('Token must never be read')
      },
    })
    const receipt = f.run('collect-config', { step: 'discord-app', allowParameters: true })
    expect(receipt).toMatchObject({ ok: false, errors: [expect.stringContaining('Public Key')] })
    expect(receipt).not.toHaveProperty('parameters')
    f.dom.window.close()
  })
  it('lets a model select semantically related fields rather than requiring tutorial labels', () => {
    const f = page(
      `<section><h5>Client Identifier</h5><input value="${appId}"></section>
      <section><h5>Signature Verification Key</h5><code>${'a'.repeat(64)}</code></section>
      <section><h5>Client Secret</h5><input id="secret"></section>`,
      `https://discord.com/developers/applications/${appId}/information`,
    )
    Object.defineProperty(f.document.querySelector('#secret'), 'value', {
      get: () => {
        throw new Error('Secret must never be read')
      },
    })
    const observation = f.run('inspect')
    expect(observation).toMatchObject({
      pageKind: 'discord-app-information',
      headings: ['Client Identifier', 'Signature Verification Key', 'Client Secret'],
    })
    expect(JSON.stringify(observation)).not.toContain(appId)
    expect(JSON.stringify(observation)).not.toContain('a'.repeat(64))
    const controls = observation.controls as Array<{ target: string; label: string; kind: string }>
    const applicationIdTarget = controls.find((item) => item.label === 'Client Identifier')!
    const publicKeyTarget = controls.find((item) => item.label === 'Signature Verification Key')!
    const payload = {
      step: 'discord-app',
      allowParameters: true,
      applicationIdTarget,
      publicKeyTarget,
    }
    expect(f.run('collect-config', payload)).toMatchObject({
      ok: true,
      parameters: { applicationId: appId, publicKey: 'a'.repeat(64) },
    })
    f.document.querySelector('h5')!.textContent = 'Changed field'
    expect(f.run('collect-config', payload).ok).toBe(false)
    f.dom.window.close()
  })
  it('writes the complete filled Wrangler and validates in the same local action before pausing', () => {
    const f = page('<textarea name="content"></textarea>')
    const template = JSON.stringify(filled())
    expect(
      f.run('template', {
        template,
        validateTemplate: true,
        expectedApplicationId: '1234567890123456789',
      }),
    ).toEqual({ ok: true, written: true, waitingForUser: true, formatOnly: true })
    expect(f.document.querySelector('textarea')!.value).toBe(template)
    const bad = filled()
    bad.vars.DISCORD_PUBLIC_KEY = 'invalid'
    expect(f.run('template', { template: JSON.stringify(bad), validateTemplate: true }).ok).toBe(
      false,
    )
    f.dom.window.close()
  })
  it('points to the associated field with bounded coordinates and pauses without returning its value', () => {
    const f = page(
      '<label for="uuid">Database ID</label><input id="uuid" value="PRIVATE_VALUE">',
      'https://dash.cloudflare.com/account/d1/database',
    )
    f.dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
      new f.dom.window.DOMRect(100, 200, 250, 44)
    const result = f.run('guide', { step: 'd1-uuid' })
    expect(result).toMatchObject({ ok: true, waitingForUser: true })
    expect(result.guideAnchor).toEqual({
      left: 100 / 1024,
      top: 200 / 768,
      right: 350 / 1024,
      bottom: 244 / 768,
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE')
    f.dom.window.close()
  })
  it('checks all three fields but never returns source or field values', () => {
    const receipt = validate(filled())
    expect(receipt).toMatchObject({ ok: true, formatOnly: true, errors: [] })
    for (const value of [
      '1234567890123456789',
      '12345678-1234-5678-9abc-123456789abc',
      'a'.repeat(64),
    ])
      expect(JSON.stringify(receipt)).not.toContain(value)
  })
  it('rejects placeholders, malformed JSON, numeric IDs and wrong key lengths', () => {
    expect(validate(DISCORD_BRIDGE_WRANGLER_TEMPLATE).ok).toBe(false)
    expect(validate('{bad json').ok).toBe(false)
    const value = filled()
    value.vars.DISCORD_APPLICATION_ID = 12345
    value.vars.DISCORD_PUBLIC_KEY = 'z'.repeat(64)
    value.d1_databases[0].database_id = 'database-name'
    expect(validate(value).errors).toHaveLength(3)
  })
  it('rejects secret fields without echoing their contents and checks App identity', () => {
    const value = filled()
    value.vars.DISCORD_BOT_TOKEN = 'EXAMPLE_SECRET_SHOULD_NEVER_LEAVE_BROWSER'
    const receipt = validate(value)
    expect(receipt.ok).toBe(false)
    expect(JSON.stringify(receipt)).not.toContain(value.vars.DISCORD_BOT_TOKEN)
    expect(validate(filled(), '9999999999999999999')).toMatchObject({
      ok: false,
      errors: ['Application ID 与前面选择的 Discord App 不一致'],
    })
  })
  it('does not accept missing or changed fixed D1/Worker configuration', () => {
    for (const change of [
      (value: ReturnType<typeof filled>) => {
        value.d1_databases[0].binding = 'OTHER'
      },
      (value: ReturnType<typeof filled>) => {
        value.main = '../other.ts'
      },
      (value: ReturnType<typeof filled>) => {
        value.vars.HANDOFF_TTL_SECONDS = '-999'
      },
    ]) {
      const value = filled()
      change(value)
      expect(validate(value).ok).toBe(false)
    }
    expect(validate(null).ok).toBe(false)
  })
  it('requires the complete CodeMirror document, refusing a viewport-only editor', () => {
    const f = page(
      '<div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">{</div></div></div>',
    )
    expect(f.run('validate').ok).toBe(false)
    const content = f.document.querySelector('.cm-content')!
    Object.assign(content, {
      cmView: {
        view: { state: { doc: { toString: () => JSON.stringify(filled()) } }, dispatch: () => {} },
      },
    })
    expect(f.run('validate').ok).toBe(true)
    f.dom.window.close()
  })
  it('inserts the canonical template through the actual supported editor and verifies readback', () => {
    const f = page('<textarea name="content"></textarea>')
    expect(f.run('template', { template: DISCORD_BRIDGE_WRANGLER_TEMPLATE })).toMatchObject({
      ok: true,
      written: true,
    })
    expect(f.document.querySelector('textarea')!.value).toBe(DISCORD_BRIDGE_WRANGLER_TEMPLATE)
    expect(f.run('validate').ok).toBe(false)
    f.dom.window.close()
  })
  it('supports the newer CodeMirror tile owner without reading viewport text', () => {
    const f = page('<div class="cm-content">only the visible line</div>')
    Object.assign(f.document.querySelector('.cm-content')!, {
      cmTile: {
        root: {
          view: {
            state: { doc: { toString: () => JSON.stringify(filled()) } },
            dispatch: () => {},
          },
        },
      },
    })
    expect(f.run('validate').ok).toBe(true)
    expect(
      f.dom.window.eval(`(${source.trim().replace(/;$/u, '')})("validate", {})`),
    ).toMatchObject({ ok: true })
    f.dom.window.close()
  })
  it('does not inspect login forms or serialize secret input/textarea values', () => {
    const login = page('<label>Password<input type="password" value="PRIVATE"></label>')
    expect(login.run('inspect')).toEqual({
      ok: false,
      waitingForUser: true,
      pageAccess: 'authentication',
    })
    login.dom.window.close()
    const f = page(
      '<label>Bot Token<input name="token" value="PRIVATE_SECRET"></label><textarea name="notes">PRIVATE_SOURCE</textarea><button>Save</button>',
    )
    const receipt = f.run('inspect')
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SECRET')
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SOURCE')
    const controls = receipt.controls as Array<{
      target: string
      label: string
      sensitive: boolean
    }>
    const token = controls.find((control) => control.sensitive)!
    expect(
      f.run('fill', { target: token.target, label: token.label, value: 'unsafe' }),
    ).toMatchObject({ ok: false, waitingForUser: true })
    f.dom.window.close()
  })
  it('rejects detached/relabelled controls and destructive sync choices', () => {
    const f = page('<button>Update branch</button><button>Discard commits</button>')
    const controls = f.run('inspect').controls as Array<{ target: string; label: string }>
    expect(f.run('click', { ...controls[1] })).toMatchObject({ waitingForUser: true })
    f.document.querySelector('button')!.textContent = 'Other action'
    expect(f.run('click', { ...controls[0] }).ok).toBe(false)
    f.dom.window.close()
  })
  it('does not reuse a target number after a new snapshot reorders the DOM', () => {
    const f = page('<button>Settings</button><button>Save</button>')
    const first = f.run('inspect', { startSequence: 0 }).controls as Array<{
      target: string
      label: string
    }>
    const inserted = f.document.createElement('button')
    inserted.textContent = 'Other'
    f.document.body.prepend(inserted)
    f.run('inspect', { startSequence: 100 })
    expect(f.run('click', { ...first[1] }).ok).toBe(false)
    f.dom.window.close()
  })
  it.each([
    '/jixiangruyi117/SRL-Discord-Bridge',
    'https://github.com/jixiangruyi117/SRL-Discord-Bridge',
    '/jixiangruyi117/SRL-Discord-Bridge/',
  ])('recognizes the upstream from the actual Fork relation link %s', (href) => {
    const f = page(`<span>forked from <a href="${href}">SRL-Discord-Bridge</a></span>`)
    expect(f.run('inspect').forkOfTarget).toBe(true)
    f.document.querySelector('span')!.firstChild!.textContent = 'README reference to '
    expect(f.run('inspect').forkOfTarget).toBe(false)
    f.dom.window.close()
  })
  it('recognizes nested offscreen Fork metadata without admitting a foreign or credentialed upstream', () => {
    const f = page(
      '<span>forked from <small><a href="https://github.com/jixiangruyi117/SRL-Discord-Bridge">upstream</a></small></span>',
    )
    f.dom.window.HTMLElement.prototype.getClientRects = () =>
      [
        { width: 20, height: 20, top: -50, bottom: -30, left: 0, right: 20 },
      ] as unknown as DOMRectList
    expect(f.run('inspect').forkOfTarget).toBe(true)
    for (const href of [
      'https://github.com.example/jixiangruyi117/SRL-Discord-Bridge',
      'https://secret@github.com/jixiangruyi117/SRL-Discord-Bridge',
      'https://github.com/other/SRL-Discord-Bridge',
    ]) {
      f.document.querySelector('a')!.href = href
      expect(f.run('inspect').forkOfTarget).toBe(false)
    }
    f.dom.window.close()
  })
  it('collects only one uncredentialed production Worker root, refusing ambiguity and signed URLs', () => {
    const f = page(
      '<a href="https://example.account.workers.dev/">Visit</a><a href="https://example.account.workers.dev/?token=PRIVATE">Signed</a>',
      'https://dash.cloudflare.com/account/workers/services/view/example/production',
    )
    expect(f.run('collect-worker')).toEqual({
      ok: true,
      workerUrl: 'https://example.account.workers.dev',
    })
    const second = f.document.createElement('a')
    second.href = 'https://other.account.workers.dev/'
    f.document.body.append(second)
    expect(f.run('collect-worker').ok).toBe(true)
    second.href = 'https://example.other-account.workers.dev/'
    expect(f.run('collect-worker').ok).toBe(false)
    f.dom.window.close()
  })
  it('never collects a Worker from the account overview', () => {
    const f = page(
      '<a href="https://example.account.workers.dev/">Visit</a>',
      'https://dash.cloudflare.com/',
    )
    expect(f.run('collect-worker').ok).toBe(false)
    f.dom.window.close()
  })
})

describe('interaction configuration conflict', () => {
  it('keeps an existing different endpoint until its exact value is confirmed and rejects a concurrent edit', () => {
    const id = '1234567890123456789'
    const old = 'https://old.workers.dev/interactions'
    const f = page(
      '<label for="endpoint">Interactions Endpoint URL</label><input id="endpoint">',
      'https://discord.com/developers/applications/' + id + '/information',
    )
    const field = f.document.querySelector<HTMLInputElement>('input')!
    field.value = old
    const payload = {
      step: 'discord-endpoint',
      expectedApplicationId: id,
      value: 'https://new.workers.dev/interactions',
      autonomous: true,
    }
    expect(f.run('fill-endpoint', payload)).toMatchObject({
      ok: false,
      configurationConflict: true,
      previousEndpoint: old,
    })
    expect(field.value).toBe(old)
    field.value = 'https://changed.workers.dev/interactions'
    expect(f.run('fill-endpoint', { ...payload, confirmedPreviousEndpoint: old })).toMatchObject({
      ok: false,
      configurationConflict: true,
    })
    expect(
      f.run('fill-endpoint', { ...payload, confirmedPreviousEndpoint: field.value }),
    ).toMatchObject({ ok: true, filled: true })
    expect(f.run('fill-endpoint', payload)).toMatchObject({ ok: true, filled: true })
    f.dom.window.close()
  })
})

// Actual saved configurations and owner repositories are equivalent paths, not tutorial exceptions.
describe('goal-based configuration and repository evidence', () => {
  it('accepts JSONC, custom names/date/entrypoint, extra bindings and an adjusted public TTL', () => {
    const value = filled()
    value.name = 'my-existing-worker'
    value.main = 'dist/worker.js'
    value.compatibility_date = '2026-10-01'
    value.d1_databases[0].database_name = 'existing-db'
    value.d1_databases.unshift({ binding: 'ANOTHER_DB', database_name: 'other' })
    value.vars.EXTRA_LABEL = 'public-option'
    value.vars.HANDOFF_TTL_SECONDS = '2400'
    value.observability = { enabled: true }
    const jsonc = '/* current config */' + JSON.stringify(value).replace(/}$/, ',}')
    expect(validate(jsonc)).toMatchObject({ ok: true, errors: [] })
  })
  it('does not expose maintainer source ownership as a browser repository kind', () => {
    const f = page(
      '<meta name="user-login" content="account"><button>release</button><a href="/account/worker/commit/' +
        'a'.repeat(40) +
        '">commit</a>',
      'https://github.com/account/worker',
    )
    expect(f.run('inspect').repository).toBeUndefined()
    f.dom.window.close()
  })
  it('validates an already saved JSONC on the actual branch without opening the editor', () => {
    const repo = 'test-user/renamed-bridge',
      branch = 'release/stable',
      value = filled()
    const f = page(
      '<textarea id="read-only-cursor-text-area"></textarea><a href="/' +
        repo +
        '/commit/' +
        'b'.repeat(40) +
        '">saved</a>',
      'https://github.com/' + repo + '/blob/' + branch + '/wrangler.json',
    )
    f.document.querySelector('textarea')!.value = '// kept settings\n' + JSON.stringify(value)
    const options = {
      autonomous: true,
      expectedFork: repo,
      expectedBranch: branch,
      expectedFile: 'wrangler.json',
      expectedApplicationId: value.vars.DISCORD_APPLICATION_ID,
      expectedPublicKey: value.vars.DISCORD_PUBLIC_KEY,
      expectedDatabaseId: value.d1_databases[0].database_id,
    }
    expect(f.run('validate', options).ok).toBe(true)
    expect(f.run('verify-step', { ...options, step: 'github-save' })).toMatchObject({
      verified: true,
      revision: 'b'.repeat(40),
    })
    expect(
      f.run('verify-step', { ...options, expectedBranch: 'main', step: 'github-save' }).ok,
    ).toBe(false)
    f.dom.window.close()
  })
  it('preserves legitimate configuration, confirms parameter conflicts and rejects a changed editor after consent', () => {
    const f = page('<textarea name="content"></textarea>')
    const original = filled(),
      target = filled()
    original.name = 'my-worker'
    original.vars.EXTRA_LABEL = 'keep'
    original.vars.DISCORD_APPLICATION_ID = '2234567890123456789'
    const edit = f.document.querySelector('textarea')!
    edit.value = JSON.stringify(original)
    const payload = {
      template: JSON.stringify(target),
      preserveConfiguration: true,
      validateTemplate: true,
    }
    const conflict = f.run('template', payload)
    expect(conflict).toMatchObject({ ok: false, configurationConflict: true })
    expect(JSON.parse(edit.value).vars.DISCORD_APPLICATION_ID).toBe(
      original.vars.DISCORD_APPLICATION_ID,
    )
    edit.value = edit.value.replace('my-worker', 'a-new-edit')
    const changed = f.run('template', {
      ...payload,
      configurationConfirmation: conflict.configurationConfirmation,
    })
    expect(changed.ok).toBe(false)
    expect(
      f.run('template', {
        ...payload,
        configurationConfirmation: changed.configurationConfirmation,
      }),
    ).toMatchObject({ ok: true, written: true })
    expect(JSON.parse(edit.value)).toMatchObject({
      name: 'a-new-edit',
      vars: { EXTRA_LABEL: 'keep', DISCORD_APPLICATION_ID: target.vars.DISCORD_APPLICATION_ID },
    })
    f.dom.window.close()
  })
})

it('requires a separate full-replacement decision for a damaged configuration', () => {
  const f = page('<textarea name="content"></textarea>')
  const edit = f.document.querySelector('textarea')!
  edit.value = '{ malformed draft'
  const payload = {
    template: JSON.stringify(filled()),
    preserveConfiguration: true,
    validateTemplate: true,
  }
  const first = f.run('template', payload)
  expect(first).toMatchObject({ ok: false, configurationConflict: true, replacementRequired: true })
  expect(edit.value).toBe('{ malformed draft')
  expect(
    f.run('template', { ...payload, configurationConfirmation: first.configurationConfirmation }),
  ).toMatchObject({ ok: true, written: true })
  expect(JSON.parse(edit.value).vars.DISCORD_APPLICATION_ID).toBe('1234567890123456789')
  f.dom.window.close()
})
