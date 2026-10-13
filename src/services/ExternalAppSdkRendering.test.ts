/** @vitest-environment jsdom */
import { Blob } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { ExternalAppSdkService } from './ExternalAppSdkService'
import { ChatReaderService } from './ChatReaderService'
import * as readerRendering from './ChatReaderRendering'
import type { Resource } from '../types/Resource'
import { toResourceSummary } from '../types/Resource'
import type { ResourceReadSource } from '../types/ResourceReadSource'
import { applyCharacterGreetingRegex } from '../utils/CharacterGreetingRegex'

vi.mock('./ChatReaderRendering', async (original) => {
  const actual = await original<typeof import('./ChatReaderRendering')>()
  return {
    ...actual,
    transformChatInputs: async (inputs: import('./ChatReaderRendering').ChatRenderInput[]) =>
      inputs.map((input) =>
        applyCharacterGreetingRegex([input.source], input.rules, input.context),
      ),
  }
})

function resource(id: string, type: Resource['type'], source: unknown, metadata = {}): Resource {
  return {
    id,
    type,
    name: id,
    metadata: { ...(type === 'chat' ? { messageCount: 1 } : {}), ...metadata },
    originalBlob: new Blob([typeof source === 'string' ? source : JSON.stringify(source)]),
    contentHash: id,
    relatedResourceIds: [],
  } as unknown as Resource
}
function sdkWith(items: Resource[]) {
  const resources = { get: vi.fn(async (id: string) => items.find((item) => item.id === id)) }
  const getReadSource = vi.fn(async (id: string): Promise<ResourceReadSource | undefined> => {
    const item = await resources.get(id)
    return item ? { ...toResourceSummary(item), originalSource: item.originalBlob } : undefined
  })
  const externalApps = {
    hasPermission: vi.fn(async () => true),
    get: vi.fn(async () => {
      throw new Error('阅读权限核对不得加载完整 APP 包')
    }),
    getSummary: vi.fn(async () => ({ runtimeMode: 'trustedCompatible' })),
  }
  return {
    sdk: new ExternalAppSdkService(externalApps as never, { ...resources, getReadSource } as never),
    resources: { ...resources, getReadSource },
    externalApps,
  }
}
const rule = {
  id: 'display',
  scriptName: '面板',
  findRegex: 'STATUS',
  replaceString: '<div>正确状态栏</div>',
  placement: [2],
  markdownOnly: true,
}

describe('reader SDK rendering path', () => {
  it('paginates selected real snapshots without running display regex or reading script sources', async () => {
    const raw = [
      { name: '用户', is_user: true, mes: 'USER' },
      {
        name: '角色',
        is_user: false,
        mes: '旧',
        swipe_id: 0,
        swipes: ['旧', '备选'],
        variables: [{ v: 0 }, { v: 1 }],
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n')
    const { sdk, resources } = sdkWith([
      resource('chat', 'chat', raw, {
        messageCount: 2,
        chatCharacter: { hash: 'a'.repeat(64), name: '角色', card: { name: '角色' } },
      }),
    ])
    const result = await sdk.readChat('reader', {
      id: 'chat',
      snapshotsOnly: true,
      limit: 50,
      replyOverrides: { '1': 1 },
      scripts: true,
      scriptSources: ['missing'],
    })
    expect(result.messages.map((x) => x.snapshot)).toMatchObject([
      { message_id: 0, message: 'USER' },
      { message_id: 1, message: '备选', data: { v: 1 }, swipe_id: 1 },
    ])
    expect(result.previewCapabilities).toMatchObject({ archivedReaderHistory: true })
    expect(resources.getReadSource.mock.calls.map(([id]) => id)).toEqual(['chat'])
  })
  it('still rejects genuinely oversized saved variables without truncating their originals or raising the budget', async () => {
    const card = resource('card', 'characterCard', '', {
      card: {
        name: '角色',
        scripts: [{ type: 'script', id: 'phone', name: '手机', content: 'console.log("phone")' }],
      },
    })
    const raw = JSON.stringify({
      name: '角色',
      is_user: false,
      mes: '正文',
      variables: [{ large: 'x'.repeat(3 * 1024 * 1024) }],
    })
    const chat = resource('chat', 'chat', raw)
    chat.relatedResourceIds = ['card']
    const { sdk } = sdkWith([chat, card])
    const catalog = await sdk.readChat('reader', { id: 'chat', scriptListOnly: true })
    await expect(
      sdk.readChat('reader', {
        id: 'chat',
        interactive: true,
        scripts: true,
        scriptOverrides: { [catalog.scriptRules[0]!.key]: true },
      }),
    ).rejects.toThrow('渲染内容过大')
    expect(await chat.originalBlob.text()).toBe(raw)
  })
  it('prepares display rules once for a page and reuses them across floors while keeping depth-specific results', async () => {
    const card = resource('card', 'characterCard', '', {
      card: { name: '角色', extensions: { regex_scripts: [rule] } },
    })
    const raw = [0, 1, 2]
      .map((index) => JSON.stringify({ name: '角色', is_user: false, mes: 'STATUS ' + index }))
      .join('\n')
    const chat = resource('chat', 'chat', raw, {
      messageCount: 3,
      visibleMessageCount: 3,
      format: 'jsonl',
    })
    chat.relatedResourceIds = ['card']
    const { sdk } = sdkWith([chat, card])
    const prepare = vi.spyOn(readerRendering, 'chatRegexRules')
    const inputs = vi.spyOn(readerRendering, 'chatRenderInput')
    try {
      const result = await sdk.readChat('reader', { id: 'chat', limit: 3 })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(inputs).toHaveBeenCalledTimes(3)
      const prepared = inputs.mock.calls[0]![3]
      expect(prepared).toBeDefined()
      expect(inputs.mock.calls.every((call) => call[3] === prepared)).toBe(true)
      expect(result.messages.map((entry) => entry.depth)).toEqual([2, 1, 0])
      expect(result.messages.every((entry) => entry.html.includes('正确状态栏'))).toBe(true)
      expect(await chat.originalBlob.text()).toBe(raw)
    } finally {
      prepare.mockRestore()
      inputs.mockRestore()
    }
  })
  it('lists scripts without reading or formatting chat floors, then still honors manual-source changes', async () => {
    const card = resource('card', 'characterCard', '', {
      card: {
        name: '角色',
        scripts: [{ type: 'script', id: 'role', name: '手机', content: 'console.log("role")' }],
      },
    })
    const chat = resource('chat', 'chat', 'not needed for this metadata request', {
      messageCount: 1000,
    })
    chat.relatedResourceIds = ['card']
    const { sdk, externalApps } = sdkWith([chat, card])
    const read = vi
      .spyOn(ChatReaderService.prototype, 'readResource')
      .mockRejectedValue(new Error('floor must not be read'))
    const format = vi.spyOn(readerRendering, 'formatChatResult')
    try {
      const catalog = await sdk.readChat('reader', {
        id: 'chat',
        scriptList: true,
        scriptListOnly: true,
        remote: true,
        interactive: true,
      })
      expect(catalog.scriptRules).toHaveLength(1)
      expect(catalog.messages).toEqual([])
      expect(catalog.total).toBe(1000)
      expect(read).not.toHaveBeenCalled()
      expect(format).not.toHaveBeenCalled()
      expect(
        externalApps.hasPermission.mock.calls.flatMap((call: unknown[]) => call[1]),
      ).not.toContain('network.https')
      await expect(
        sdk.readChat('reader', { id: 'chat', scriptListOnly: true, scriptSources: ['missing'] }),
      ).rejects.toThrow('所选脚本来源已不存在')
    } finally {
      read.mockRestore()
      format.mockRestore()
    }
  })
  it.each([1, 4, 8])(
    'keeps %s small status panels and one role script within the response budget',
    async (count) => {
      const code = 'initializeGlobal("Phone", { ready: true });'
      const card = resource('card', 'characterCard', '', {
        card: {
          name: '角色',
          scripts: [{ type: 'script', id: 'phone', name: '手机', content: code }],
        },
      })
      const panel = '```html\n<body><p>状态</p></body>\n```'
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({
          name: '角色',
          is_user: false,
          mes: Array(count).fill(panel).join('\n\n'),
        }),
      )
      chat.relatedResourceIds = ['card']
      const { sdk } = sdkWith([chat, card])
      const catalog = await sdk.readChat('reader', { id: 'chat', scriptList: true })
      const full = await sdk.readChat('reader', {
        id: 'chat',
        interactive: true,
        scripts: true,
        scriptOverrides: { [catalog.scriptRules[0]!.key]: true },
      })
      const bytes = new TextEncoder().encode(JSON.stringify(full.messages[0])).length
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      const template = document.createElement('template')
      template.innerHTML = full.messages[0]!.interactiveDocument!
      expect(template.content.querySelectorAll('.TH-render > iframe')).toHaveLength(count)
      expect(full.messages[0]!.scriptCount).toBe(1)
    },
  )
  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])(
    'lists scripts from %s character card data',
    async (spec) => {
      const data = {
        name: '角色',
        extensions: {
          tavern_helper: {
            scripts: [
              {
                type: 'script',
                id: 'phone',
                name: '手机',
                content: 'console.log("phone")',
                enabled: true,
              },
            ],
          },
        },
      }
      const card = resource('card', 'characterCard', '', {
        card: spec === 'legacy' ? data : { spec, data },
      })
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({ name: '角色', mes: '正文', is_user: false }),
      )
      chat.relatedResourceIds = ['card']
      const { sdk } = sdkWith([chat, card])
      const catalog = await sdk.readChat('reader', { id: 'chat', scriptList: true })
      expect(catalog.scriptRules).toHaveLength(1)
      expect(catalog.scriptRules[0]).toMatchObject({ name: '手机', enabled: false })
      // A separately saved full card must not bypass the chat's carry exclusion.
      chat.metadata.chatCharacter = { carryReadingScripts: false }
      const excluded = await sdk.readChat('reader', { id: 'chat', scriptList: true })
      expect(excluded.scriptRules).toEqual([])
      expect(card.metadata.card).toEqual(spec === 'legacy' ? data : { spec, data })
    },
  )
  it('keeps scripts opt-in and runs one shared floor host across panels and selected replies', async () => {
    const code =
      'initializeGlobal("Phone", { floor: getCurrentMessageId(), data: getVariables({type:"message"}) });'
    const card = resource('card', 'characterCard', '', {
      card: {
        name: '角色',
        extensions: {
          tavern_helper: {
            scripts: [
              { type: 'script', id: 'phone', name: '小手机', content: code, enabled: true },
            ],
          },
        },
      },
    })
    const frontend =
      '```html\n<body><p>状态</p><script>waitGlobalInitialized("Phone");</script></body>\n```'
    const mes = '开头\n\n' + frontend + '\n\n中间正文\n\n' + frontend + '\n\n尾声'
    const rows = [0, 1].map((floor) => ({
      name: '角色',
      is_user: false,
      mes,
      swipe_id: 0,
      swipes: [mes, mes],
      variables: [
        { floor, reply: 0 },
        { floor, reply: 1 },
      ],
    }))
    const chat = resource('chat', 'chat', rows.map((row) => JSON.stringify(row)).join('\n'), {
      format: 'jsonl',
      messageCount: 2,
    })
    chat.relatedResourceIds = ['card']
    const library = resource('library-phone', 'script', {
      type: 'script',
      id: 'library',
      name: '资源脚本',
      content: 'console.log("library-phone")',
      enabled: false,
    })
    const { sdk, resources } = sdkWith([card, chat, library])
    const off = await sdk.readChat('reader', {
      id: 'chat',
      scriptSources: ['library-phone'],
      interactive: true,
    })
    expect(off.messages[0]!.scriptCount).toBe(0)
    expect(resources.get.mock.calls.map(([id]) => id)).not.toContain('library-phone')
    const catalog = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['library-phone'],
    })
    expect(catalog.scriptRules.map((rule) => rule.enabled)).toEqual([false, false])
    expect(catalog.scriptRules[0]).not.toHaveProperty('content')
    const overrides = Object.fromEntries(catalog.scriptRules.map((rule) => [rule.key, true]))
    const result = await sdk.readChat('reader', {
      id: 'chat',
      offset: 1,
      limit: 1,
      interactive: true,
      scripts: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
      replyOverrides: { '1': 1 },
    })
    const entry = result.messages[0]!
    expect(entry.scriptCount).toBe(2)
    expect(entry.interactiveFrontends).toEqual([])
    const template = document.createElement('template')
    template.innerHTML = entry.interactiveDocument!
    expect(
      template.content.querySelectorAll('#srl-tavern-helper-script-runtimes iframe'),
    ).toHaveLength(2)
    expect(
      [...template.content.querySelectorAll('.TH-render > iframe')].map((frame) => frame.id),
    ).toEqual(['TH-message--1--0', 'TH-message--1--1'])
    expect(entry.interactiveDocument).toContain('"floor":1,"reply":1')
    const body = template.content.querySelector('#chat')!.innerHTML
    expect(body.indexOf('中间正文')).toBeGreaterThan(body.indexOf('TH-message--1--0'))
    expect(body.indexOf('中间正文')).toBeLessThan(body.indexOf('TH-message--1--1'))
    expect(await chat.originalBlob.text()).toBe(rows.map((row) => JSON.stringify(row)).join('\n'))
    library.originalBlob = new Blob([
      JSON.stringify({
        type: 'script',
        id: 'library',
        name: '资源脚本',
        content: 'console.log("updated")',
      }),
    ]) as unknown as Resource['originalBlob']
    const changed = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
    })
    expect(changed.scriptRules.map((rule) => rule.enabled)).toEqual([true, false])
    const plain = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
      interactive: true,
      textOnly: true,
    })
    expect(plain.messages[0]!.interactiveDocument).toBeUndefined()
    expect(plain.messages[0]!.scriptCount).toBe(0)
  })
  it('runs scripts on prose-only floors and rejects unsupported or missing sources', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: '纯正文', is_user: false }),
    )
    const library = resource('phone', 'script', 'console.log("phone")')
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    chat.relatedResourceIds = ['card']
    const stscript = resource('slash', 'script', '/echo hi', { variant: 'stscript' })
    const apk = resource('apk', 'pocketPhone', 'binary')
    const { sdk, externalApps } = sdkWith([chat, card, library, stscript, apk])
    const list = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['phone'],
    })
    const result = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['phone'],
      scriptOverrides: { [list.scriptRules[0]!.key]: true },
      interactive: true,
    })
    expect(result.messages[0]!.interactiveDocument).toContain('srl-tavern-helper-script-runtimes')
    expect(result.messages[0]!.frontendCount).toBe(0)
    for (const id of ['slash', 'apk'])
      await expect(
        sdk.readChat('reader', { id: 'chat', scriptList: true, scriptSources: [id] }),
      ).rejects.toThrow('不支持')
    await expect(
      sdk.readChat('reader', { id: 'chat', scriptList: true, scriptSources: ['missing'] }),
    ).rejects.toThrow('不存在')
    const missing = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['missing'],
      interactive: true,
    })
    expect(missing.messages[0]!.html).toContain('纯正文')
    expect(missing.messages[0]!.scriptErrors.join()).toContain('不存在')
    externalApps.getSummary.mockResolvedValue({ runtimeMode: 'isolated' })
    await expect(
      sdk.readChat('reader', { id: 'chat', interactive: true, scripts: true }),
    ).rejects.toThrow('信任兼容')
  })
  it('keeps the selected character identity when a script runs on an archived user floor', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '实际用户', mes: '用户发言', is_user: true }),
    )
    const script = resource('phone', 'script', 'console.log(getCurrentCharacterName())')
    const card = resource('card', 'characterCard', '', { card: { data: { name: '实际角色' } } })
    chat.relatedResourceIds = ['card']
    const { sdk } = sdkWith([chat, card, script])
    const catalog = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['phone'],
    })
    const result = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      interactive: true,
      scriptSources: ['phone'],
      scriptOverrides: { [catalog.scriptRules[0]!.key]: true },
    })
    expect(result.messages[0]?.interactiveDocument).toContain('"charName":"实际角色"')
    expect(result.messages[0]?.interactiveDocument).toContain('"name":"实际用户"')
  })
  it('reuses raw floors while rebuilding each selected reply snapshot and checking current permissions', async () => {
    const frontend =
      '```html\n<body><p>状态栏</p><script>getCurrentMessageId(); getVariables({type:"message"});</script></body>\n```'
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    const rows = [0, 1].map((floor) => ({
      name: '角色',
      mes: frontend,
      is_user: false,
      swipes: [frontend, frontend],
      swipe_id: 0,
      variables: [{ stat_data: { floor, reply: 0 } }, { stat_data: { floor, reply: 1 } }],
    }))
    const chat = resource('chat', 'chat', rows.map((row) => JSON.stringify(row)).join('\n'), {
      format: 'jsonl',
      messageCount: 2,
      visibleMessageCount: 2,
    })
    chat.relatedResourceIds = ['card']
    const { sdk, resources, externalApps } = sdkWith([chat, card])
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    const staticPage = await sdk.readChat('reader', { id: 'chat', limit: 2 })
    expect(staticPage.messages.map((entry) => entry.snapshot.data)).toEqual(
      rows.map((row) => row.variables[0]),
    )
    expect(resources.get.mock.calls.filter(([id]) => id === 'chat')).toHaveLength(1)
    slices.mockClear()
    resources.get.mockClear()
    const second = await sdk.readChat('reader', {
      id: 'chat',
      offset: 1,
      limit: 1,
      interactive: true,
      replyOverrides: { '1': 1 },
    })
    const first = await sdk.readChat('reader', {
      id: 'chat',
      offset: 0,
      limit: 1,
      interactive: true,
    })
    expect(slices).not.toHaveBeenCalled()
    expect(second.messages[0]!.snapshot).toMatchObject({
      message_id: 1,
      swipe_id: 1,
      data: { stat_data: { floor: 1, reply: 1 } },
    })
    expect(first.messages[0]!.snapshot).toMatchObject({
      message_id: 0,
      swipe_id: 0,
      data: { stat_data: { floor: 0, reply: 0 } },
    })
    expect(second.messages[0]!.interactiveFrontends[0]).toContain('"floor":1,"reply":1')
    expect(first.messages[0]!.interactiveFrontends[0]).toContain('"floor":0,"reply":0')
    expect(await chat.originalBlob.text()).toBe(rows.map((row) => JSON.stringify(row)).join('\n'))
    resources.get.mockClear()
    externalApps.hasPermission.mockResolvedValue(false)
    await expect(sdk.readChat('reader', { id: 'chat', offset: 1 })).rejects.toThrow('未获得')
    expect(resources.get).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'keeps remote media and interactive network policy controlled by the setting: %s',
    async (remote) => {
      const frontend =
        '```html\n<body><img src="https://example.com/cover.png"><script>console.log("local")</script></body>\n```'
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({ name: '角色', mes: frontend, is_user: false }),
      )
      const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
      chat.relatedResourceIds = ['card']
      const sdk = new ExternalAppSdkService(
        {
          hasPermission: async () => true,
          getSummary: async () => ({ runtimeMode: 'trustedCompatible' }),
        } as never,
        { get: async (id: string) => [chat, card].find((item) => item.id === id) } as never,
      )
      const result = await sdk.readChat('reader', { id: 'chat', remote, interactive: true })
      const doc = new DOMParser().parseFromString(
        result.messages[0]!.interactiveFrontends[0]!,
        'text/html',
      )
      const csp = doc
        .querySelector('meta[http-equiv="Content-Security-Policy"]')!
        .getAttribute('content')!
      // The outer snapshot keeps fetch blocked; remote media/dependencies are separately gated.
      expect(csp).toContain("connect-src 'none'")
      expect(result.messages[0]!.frontends[0]!.includes('https://example.com/cover.png')).toBe(
        remote,
      )
      expect(csp.includes('img-src data: blob: https:')).toBe(remote)
      expect(csp.includes('font-src data: blob: https:')).toBe(remote)
      expect(csp.includes("script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:")).toBe(
        remote,
      )
    },
  )
  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])(
    'lists scripts from %s character card data',
    async (spec) => {
      const data = {
        name: '角色',
        extensions: {
          tavern_helper: {
            scripts: [
              {
                type: 'script',
                id: 'phone',
                name: '手机',
                content: 'console.log("phone")',
                enabled: true,
              },
            ],
          },
        },
      }
      const card = resource('card', 'characterCard', '', {
        card: spec === 'legacy' ? data : { spec, data },
      })
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({ name: '角色', mes: '正文', is_user: false }),
      )
      chat.relatedResourceIds = ['card']
      const { sdk } = sdkWith([chat, card])
      const catalog = await sdk.readChat('reader', { id: 'chat', scriptList: true })
      expect(catalog.scriptRules).toHaveLength(1)
      expect(catalog.scriptRules[0]).toMatchObject({ name: '手机', enabled: false })
    },
  )
  it('keeps scripts opt-in and runs one shared floor host across panels and selected replies', async () => {
    const code =
      'initializeGlobal("Phone", { floor: getCurrentMessageId(), data: getVariables({type:"message"}) });'
    const card = resource('card', 'characterCard', '', {
      card: {
        name: '角色',
        extensions: {
          tavern_helper: {
            scripts: [
              { type: 'script', id: 'phone', name: '小手机', content: code, enabled: true },
            ],
          },
        },
      },
    })
    const frontend =
      '```html\n<body><p>状态</p><script>waitGlobalInitialized("Phone");</script></body>\n```'
    const mes = '开头\n\n' + frontend + '\n\n中间正文\n\n' + frontend + '\n\n尾声'
    const rows = [0, 1].map((floor) => ({
      name: '角色',
      is_user: false,
      mes,
      swipe_id: 0,
      swipes: [mes, mes],
      variables: [
        { floor, reply: 0 },
        { floor, reply: 1 },
      ],
    }))
    const chat = resource('chat', 'chat', rows.map((row) => JSON.stringify(row)).join('\n'), {
      format: 'jsonl',
      messageCount: 2,
    })
    chat.relatedResourceIds = ['card']
    const library = resource('library-phone', 'script', {
      type: 'script',
      id: 'library',
      name: '资源脚本',
      content: 'console.log("library-phone")',
      enabled: false,
    })
    const { sdk, resources } = sdkWith([card, chat, library])
    const off = await sdk.readChat('reader', {
      id: 'chat',
      scriptSources: ['library-phone'],
      interactive: true,
    })
    expect(off.messages[0]!.scriptCount).toBe(0)
    expect(resources.get.mock.calls.map(([id]) => id)).not.toContain('library-phone')
    const catalog = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['library-phone'],
    })
    expect(catalog.scriptRules.map((rule) => rule.enabled)).toEqual([false, false])
    expect(catalog.scriptRules[0]).not.toHaveProperty('content')
    const overrides = Object.fromEntries(catalog.scriptRules.map((rule) => [rule.key, true]))
    const result = await sdk.readChat('reader', {
      id: 'chat',
      offset: 1,
      limit: 1,
      interactive: true,
      scripts: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
      replyOverrides: { '1': 1 },
    })
    const entry = result.messages[0]!
    expect(entry.scriptCount).toBe(2)
    expect(entry.interactiveFrontends).toEqual([])
    const template = document.createElement('template')
    template.innerHTML = entry.interactiveDocument!
    expect(
      template.content.querySelectorAll('#srl-tavern-helper-script-runtimes iframe'),
    ).toHaveLength(2)
    expect(
      [...template.content.querySelectorAll('.TH-render > iframe')].map((frame) => frame.id),
    ).toEqual(['TH-message--1--0', 'TH-message--1--1'])
    expect(entry.interactiveDocument).toContain('"floor":1,"reply":1')
    const body = template.content.querySelector('#chat')!.innerHTML
    expect(body.indexOf('中间正文')).toBeGreaterThan(body.indexOf('TH-message--1--0'))
    expect(body.indexOf('中间正文')).toBeLessThan(body.indexOf('TH-message--1--1'))
    expect(await chat.originalBlob.text()).toBe(rows.map((row) => JSON.stringify(row)).join('\n'))
    library.originalBlob = new Blob([
      JSON.stringify({
        type: 'script',
        id: 'library',
        name: '资源脚本',
        content: 'console.log("updated")',
      }),
    ]) as unknown as Resource['originalBlob']
    const changed = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
    })
    expect(changed.scriptRules.map((rule) => rule.enabled)).toEqual([true, false])
    const plain = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['library-phone'],
      scriptOverrides: overrides,
      interactive: true,
      textOnly: true,
    })
    expect(plain.messages[0]!.interactiveDocument).toBeUndefined()
    expect(plain.messages[0]!.scriptCount).toBe(0)
  })
  it('runs scripts on prose-only floors and rejects unsupported or missing sources', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: '纯正文', is_user: false }),
    )
    const library = resource('phone', 'script', 'console.log("phone")')
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    chat.relatedResourceIds = ['card']
    const stscript = resource('slash', 'script', '/echo hi', { variant: 'stscript' })
    const apk = resource('apk', 'pocketPhone', 'binary')
    const { sdk, externalApps } = sdkWith([chat, card, library, stscript, apk])
    const list = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['phone'],
    })
    const result = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['phone'],
      scriptOverrides: { [list.scriptRules[0]!.key]: true },
      interactive: true,
    })
    expect(result.messages[0]!.interactiveDocument).toContain('srl-tavern-helper-script-runtimes')
    expect(result.messages[0]!.frontendCount).toBe(0)
    for (const id of ['slash', 'apk'])
      await expect(
        sdk.readChat('reader', { id: 'chat', scriptList: true, scriptSources: [id] }),
      ).rejects.toThrow('不支持')
    await expect(
      sdk.readChat('reader', { id: 'chat', scriptList: true, scriptSources: ['missing'] }),
    ).rejects.toThrow('不存在')
    const missing = await sdk.readChat('reader', {
      id: 'chat',
      scripts: true,
      scriptSources: ['missing'],
      interactive: true,
    })
    expect(missing.messages[0]!.html).toContain('纯正文')
    expect(missing.messages[0]!.scriptErrors.join()).toContain('不存在')
    externalApps.getSummary.mockResolvedValue({ runtimeMode: 'isolated' })
    await expect(
      sdk.readChat('reader', { id: 'chat', interactive: true, scripts: true }),
    ).rejects.toThrow('信任兼容')
  })
  it('reuses raw floors while rebuilding each selected reply snapshot and checking current permissions', async () => {
    const frontend =
      '```html\n<body><p>状态栏</p><script>getCurrentMessageId(); getVariables({type:"message"});</script></body>\n```'
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    const rows = [0, 1].map((floor) => ({
      name: '角色',
      mes: frontend,
      is_user: false,
      swipes: [frontend, frontend],
      swipe_id: 0,
      variables: [{ stat_data: { floor, reply: 0 } }, { stat_data: { floor, reply: 1 } }],
    }))
    const chat = resource('chat', 'chat', rows.map((row) => JSON.stringify(row)).join('\n'), {
      format: 'jsonl',
      messageCount: 2,
      visibleMessageCount: 2,
    })
    chat.relatedResourceIds = ['card']
    const { sdk, resources, externalApps } = sdkWith([chat, card])
    const slices = vi.spyOn(chat.originalBlob, 'slice')
    const staticPage = await sdk.readChat('reader', { id: 'chat', limit: 2 })
    expect(staticPage.messages.map((entry) => entry.snapshot.data)).toEqual(
      rows.map((row) => row.variables[0]),
    )
    expect(resources.get.mock.calls.filter(([id]) => id === 'chat')).toHaveLength(1)
    slices.mockClear()
    resources.get.mockClear()
    const second = await sdk.readChat('reader', {
      id: 'chat',
      offset: 1,
      limit: 1,
      interactive: true,
      replyOverrides: { '1': 1 },
    })
    const first = await sdk.readChat('reader', {
      id: 'chat',
      offset: 0,
      limit: 1,
      interactive: true,
    })
    expect(slices).not.toHaveBeenCalled()
    expect(second.messages[0]!.snapshot).toMatchObject({
      message_id: 1,
      swipe_id: 1,
      data: { stat_data: { floor: 1, reply: 1 } },
    })
    expect(first.messages[0]!.snapshot).toMatchObject({
      message_id: 0,
      swipe_id: 0,
      data: { stat_data: { floor: 0, reply: 0 } },
    })
    expect(second.messages[0]!.interactiveFrontends[0]).toContain('"floor":1,"reply":1')
    expect(first.messages[0]!.interactiveFrontends[0]).toContain('"floor":0,"reply":0')
    expect(await chat.originalBlob.text()).toBe(rows.map((row) => JSON.stringify(row)).join('\n'))
    resources.get.mockClear()
    externalApps.hasPermission.mockResolvedValue(false)
    await expect(sdk.readChat('reader', { id: 'chat', offset: 1 })).rejects.toThrow('未获得')
    expect(resources.get).not.toHaveBeenCalled()
  })
  it.each([
    resource('css', 'beautification', '.mes_text{color:red}', { format: 'css' }),
    resource(
      'theme',
      'beautification',
      { custom_css: '.mes_text{color:red}', main_text_color: '#123456' },
      { format: 'json' },
    ),
    resource(
      'colors-only',
      'beautification',
      { main_text_color: '#123456', chat_tint_color: '#fff' },
      { format: 'json' },
    ),
  ])('selects library style $id through the same SDK as the app', async (item) => {
    const { sdk } = sdkWith([item])
    const result = await sdk.readerStyle('reader', { id: item.id })
    expect(result.css).toMatch(/color:/)
  })
  it.each([
    ['beautification', 1024 ** 3, '超过 256 KiB'],
    ['regex', 20, '请选择资源库中的美化'],
  ] as const)('rejects style %s/%i before reading source text', async (type, size, error) => {
    const item = resource('selected', type, '', { format: 'css' })
    const { sdk, resources } = sdkWith([item])
    const text = vi.fn(async () => '.mes_text{color:red}')
    resources.getReadSource.mockResolvedValue({
      ...toResourceSummary(item),
      fileSize: 1,
      originalSource: { size, text, slice: item.originalBlob.slice.bind(item.originalBlob) },
    })
    await expect(sdk.readerStyle('reader', { id: item.id })).rejects.toThrow(error)
    expect(text).not.toHaveBeenCalled()
    expect(resources.get).not.toHaveBeenCalled()
  })
  it('allows a style at the existing size boundary using source size, regardless of fileSize', async () => {
    const item = resource('selected', 'beautification', '', { format: 'css' })
    const { sdk, resources } = sdkWith([item])
    const text = vi.fn(async () => '.mes_text{color:red}')
    resources.getReadSource.mockResolvedValue({
      ...toResourceSummary(item),
      fileSize: 1024 ** 3,
      originalSource: {
        size: 256 * 1024,
        text,
        slice: item.originalBlob.slice.bind(item.originalBlob),
      },
    })
    expect((await sdk.readerStyle('reader', { id: item.id })).css).toContain('color:red')
    expect(text).toHaveBeenCalledOnce()
    expect(resources.get).not.toHaveBeenCalled()
  })
  it.each([
    ['regex', 1024 ** 3, false],
    ['beautification', 20, false],
    ['regex', 2 * 1024 * 1024, true],
  ] as const)(
    'bounds attached display regex %s/%i before reading text',
    async (type, size, accepted) => {
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({ name: '角色', mes: 'STATUS', is_user: false }),
        {
          chatDisplayRegexId: 'attached',
        },
      )
      const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
      chat.relatedResourceIds = ['card']
      const item = resource('attached', type, '')
      const { sdk, resources } = sdkWith([chat, card, item])
      const originalRead = resources.getReadSource.getMockImplementation()!
      const text = vi.fn(async () => JSON.stringify({ global: [rule] }))
      resources.getReadSource.mockImplementation(async (id) =>
        id === item.id
          ? {
              ...toResourceSummary(item),
              fileSize: accepted ? 1024 ** 3 : 1,
              originalSource: {
                size,
                text,
                slice: item.originalBlob.slice.bind(item.originalBlob),
              },
            }
          : originalRead(id),
      )
      const result = await sdk.readChat('reader', { id: chat.id, textOnly: true })
      expect(text).toHaveBeenCalledTimes(accepted ? 1 : 0)
      expect(resources.get.mock.calls.map(([id]) => id)).not.toContain(item.id)
      if (accepted) {
        expect(result.messages[0]?.displaySource).toBe('<div>正确状态栏</div>')
        expect(result.messages[0]?.errors).not.toContain(
          '随附显示正则不存在或超过 2 MiB，未加载；可在显示正则中替换来源',
        )
      } else {
        expect(result.messages[0]?.displaySource).toBe('STATUS')
        expect(result.messages[0]?.errors).toContain(
          '随附显示正则不存在或超过 2 MiB，未加载；可在显示正则中替换来源',
        )
      }
    },
  )
  it('replaces preset display rules without changing binding, originals or another group', async () => {
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: 'STATUS', is_user: false }),
    )
    chat.relatedResourceIds = ['card']
    const preset = resource('old-preset', 'preset', { extensions: { regex_scripts: [rule] } })
    const { sdk, resources } = sdkWith([card, chat, preset])
    const result = await sdk.readChat('reader', {
      id: 'chat',
      regexSources: { preset: 'old-preset' },
      textOnly: true,
    })
    expect(result.regexSources).toEqual({ preset: { id: 'old-preset', name: 'old-preset' } })
    expect(result.messages[0]?.html).toBe('')
    expect(result.messages[0]?.displaySource).toBe('<div>正确状态栏</div>')
    expect(result.characterId).toBe('card')
    expect(chat.relatedResourceIds).toEqual(['card'])
    expect(await chat.originalBlob.text()).toContain('STATUS')
    expect(resources.get.mock.calls.map(([id]) => id)).not.toContain('unselected')
    await expect(
      sdk.readChat('reader', { id: 'chat', regexSources: { preset: 'card' } }),
    ).rejects.toThrow('类型不适用')
    await expect(
      sdk.readChat('reader', { id: 'chat', regexSources: { preset: 'missing' } }),
    ).rejects.toThrow('已不存在')
  })
  it.each([
    ['regex', 1024 ** 3, '正则来源超过 2 MiB'],
    ['script', 1024 ** 3, '脚本来源超过 2 MiB'],
    ['regex', 2 * 1024 * 1024, ''],
    ['script', 2 * 1024 * 1024, ''],
  ] as const)(
    'checks selected %s source size %i before reading content',
    async (type, size, error) => {
      const chat = resource(
        'chat',
        'chat',
        JSON.stringify({ name: '角色', mes: 'STATUS', is_user: false }),
      )
      const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
      chat.relatedResourceIds = ['card']
      const selected = resource('selected', type, '')
      const { sdk, resources } = sdkWith([chat, card, selected])
      const originalRead = resources.getReadSource.getMockImplementation()!
      const text = vi.fn(async () =>
        type === 'regex' ? JSON.stringify([rule]) : 'console.log("ok")',
      )
      resources.getReadSource.mockImplementation(async (id) =>
        id === selected.id
          ? {
              ...toResourceSummary(selected),
              fileSize: error ? 1 : 1024 ** 3,
              originalSource: {
                size,
                text,
                slice: selected.originalBlob.slice.bind(selected.originalBlob),
              },
            }
          : originalRead(id),
      )
      const read = () =>
        sdk.readChat('reader', {
          id: chat.id,
          ...(type === 'regex'
            ? { regexSources: { global: selected.id }, textOnly: true }
            : {
                scriptList: true,
                scriptSources: [selected.id],
              }),
        })
      if (error) await expect(read()).rejects.toThrow(error)
      else {
        const result = await read()
        if (type === 'regex')
          expect(result.messages[0]?.displaySource).toBe('<div>正确状态栏</div>')
        else expect(result.scriptRules).toHaveLength(1)
      }
      expect(text).toHaveBeenCalledTimes(error ? 0 : 1)
      expect(resources.get.mock.calls.map(([id]) => id)).not.toContain(selected.id)
    },
  )
  it('reads selected character regex metadata without reading its PNG content', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: 'STATUS', is_user: false }),
    )
    const card = resource('card', 'characterCard', '', {
      card: { name: '角色', extensions: { regex_scripts: [rule] } },
    })
    chat.relatedResourceIds = [card.id]
    const { sdk, resources } = sdkWith([chat, card])
    const originalRead = resources.getReadSource.getMockImplementation()!
    const text = vi.fn(async () => {
      throw new Error('PNG must not be read')
    })
    resources.getReadSource.mockImplementation(async (id) =>
      id === card.id
        ? {
            ...toResourceSummary(card),
            originalSource: {
              size: 1024 ** 3,
              text,
              slice: card.originalBlob.slice.bind(card.originalBlob),
            },
          }
        : originalRead(id),
    )
    const result = await sdk.readChat('reader', {
      id: chat.id,
      regexSources: { character: card.id },
      textOnly: true,
    })
    expect(result.messages[0]?.displaySource).toBe('<div>正确状态栏</div>')
    expect(text).not.toHaveBeenCalled()
    resources.getReadSource.mockClear()
    resources.get.mockClear()
    resources.getReadSource.mockRejectedValue(new Error('附件已变更'))
    await expect(sdk.readerStyle('reader', { id: 'style' })).rejects.toThrow('附件已变更')
    expect(resources.get).not.toHaveBeenCalled()
  })
  it('keeps disabled rules and rejects prompt-only replacements', async () => {
    const card = resource('card', 'characterCard', '', { card: { name: '角色' } })
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: 'STATUS', is_user: false }),
    )
    chat.relatedResourceIds = ['card']
    const rules = resource('rules', 'regex', [{ ...rule, disabled: true }])
    const { sdk } = sdkWith([card, chat, rules])
    const result = await sdk.readChat('reader', {
      id: 'chat',
      regexSources: { character: 'rules' },
    })
    expect(result.messages[0]?.html).toContain('STATUS')
    expect(result.regexRules[0]?.enabled).toBe(false)
    rules.originalBlob = new Blob([
      JSON.stringify([{ ...rule, markdownOnly: false, promptOnly: true }]),
    ]) as unknown as globalThis.Blob
    await expect(
      sdk.readChat('reader', { id: 'chat', regexSources: { character: 'rules' } }),
    ).rejects.toThrow('没有显示正则')
  })
})

describe('retired automatic reading script references', () => {
  it('ignores old automatic references and still supports the same resource when manually selected', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: '正文', is_user: false }),
      {
        chatReadingScriptId: 'attached',
        chatCharacter: {
          hash: 'a'.repeat(64),
          name: '角色',
          avatar: 'a.png',
          card: { name: '角色' },
        },
      },
    )
    const attached = resource('attached', 'script', {
      scripts: [
        {
          type: 'script',
          id: 'a',
          name: '随附手机',
          content: 'console.log("attached")',
          enabled: true,
        },
      ],
    })
    const { sdk, resources } = sdkWith([chat, attached])
    const off = await sdk.readChat('reader', { id: 'chat', interactive: true })
    expect(off.messages[0]?.scriptCount).toBe(0)
    expect(resources.get.mock.calls.map(([id]) => id)).not.toContain('attached')
    const catalog = await sdk.readChat('reader', { id: 'chat', scriptList: true })
    expect(catalog.scriptRules).toEqual([])
    expect(resources.get.mock.calls.map(([id]) => id)).not.toContain('attached')
    const selected = await sdk.readChat('reader', {
      id: 'chat',
      scriptList: true,
      scriptSources: ['attached'],
    })
    expect(selected.scriptRules).toHaveLength(1)
    expect(selected.scriptRules[0]).toMatchObject({ sourceId: 'attached', enabled: false })
    expect(selected.scriptRules[0]).not.toHaveProperty('content')
    const full = await sdk.readChat('reader', {
      id: 'chat',
      interactive: true,
      scripts: true,
      scriptSources: ['attached'],
      scriptOverrides: { [selected.scriptRules[0]!.key]: true },
    })
    expect(full.messages[0]?.scriptCount).toBe(1)
    expect(chat.metadata.chatReadingScriptId).toBe('attached')
  })
  it('keeps the script manager and ordinary prose available when an attached resource is missing', async () => {
    const chat = resource(
      'chat',
      'chat',
      JSON.stringify({ name: '角色', mes: '正文', is_user: false }),
      {
        chatReadingScriptId: 'missing',
        chatCharacter: {
          hash: 'a'.repeat(64),
          name: '角色',
          avatar: 'a.png',
          card: { name: '角色' },
        },
      },
    )
    const { sdk } = sdkWith([chat])
    const catalog = await sdk.readChat('reader', { id: 'chat', scriptList: true })
    expect(catalog.scriptRules).toEqual([])
    expect(catalog.scriptErrors).toEqual([])
    expect(
      (await sdk.readChat('reader', { id: 'chat', interactive: true })).messages[0]?.scriptCount,
    ).toBe(0)
    await expect(
      sdk.readChat('reader', { id: 'chat', scriptList: true, scriptSources: ['missing'] }),
    ).rejects.toThrow('所选脚本来源已不存在')
    expect(chat.metadata.chatReadingScriptId).toBe('missing')
  })
})
