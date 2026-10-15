/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbExternalAppStorage } from '../storage/IndexedDbExternalAppStorage'
import { ExternalAppService } from './ExternalAppService'
import {
  ProductAssistantAppSession,
  type AssistantAppOperation,
} from './ProductAssistantAppSession'

const databases: AppDatabase[] = []
function setup() {
  const db = new AppDatabase(`assistant-app-${crypto.randomUUID()}`)
  databases.push(db)
  const service = new ExternalAppService(new IndexedDbExternalAppStorage(db))
  const session = new ProductAssistantAppSession(service)
  const host = {
    showPreview: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn(() => ({
      state: 'running',
      messages: [] as string[],
      revision: session.summary()?.revision,
    })),
    confirmInstall: vi.fn().mockResolvedValue(true),
    exportFile: vi.fn().mockResolvedValue(undefined),
  }
  const run = (operation: AssistantAppOperation, args: Record<string, string> = {}) =>
    session.execute(
      { action: 'app', operation, args },
      session.summary(),
      new AbortController().signal,
      host,
    )
  const source = {
    'index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><button>打卡</button><script src="app.js"></script></body></html>',
    'app.css': 'button { color: red }',
    'app.js': 'const missingCounter = 1; window.counter = missingCounter',
  }
  const create = (files: Record<string, string> = source) =>
    run('create', {
      name: '阅读打卡',
      description: '每日阅读记录',
      files: JSON.stringify(files),
      permissions: '["app.storage"]',
    })
  return { service, session, host, run, create, source }
}
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close()
    await AppDatabase.delete(db.name)
  }
  vi.restoreAllMocks()
})
describe('assistant APP drafts using the real package/storage owner', () => {
  it('persists a making plan, records actual version checks and invalidates them on writes/restoration', async () => {
    const { service, session, run, create, host } = setup()
    await create()
    const tasks = [
      {
        id: 'button',
        title: '按钮交互',
        implemented: true,
        checks: [{ action: 'text', selector: '#status', expected: '已保存' }],
      },
    ]
    await run('plan', { tasks: JSON.stringify(tasks) })
    expect(session.summary()?.tasks?.[0]?.result).toBeUndefined()
    const test = vi.fn(async (items, revision) =>
      items.map((item: object) => ({ ...item, result: { revision, state: 'passed', checked: 1 } })),
    )
    await session.execute(
      { action: 'app', operation: 'test', args: {} },
      session.summary(),
      new AbortController().signal,
      { ...host, test },
    )
    expect(test).toHaveBeenCalledOnce()
    expect(session.summary()?.tasks?.[0]?.result?.state).toBe('passed')
    const snapshot = session.snapshot()!
    const restored = new ProductAssistantAppSession(service)
    await restored.restore(snapshot)
    expect(restored.summary()?.tasks?.[0]?.title).toBe('按钮交互')
    expect(restored.summary()?.tasks?.[0]?.result).toBeUndefined()
    await run('read', { path: 'app.js' })
    await run('write', { path: 'app.js', content: 'window.counter = 2' })
    expect(session.summary()?.tasks?.[0]?.result).toBeUndefined()
    expect(session.snapshot()?.tasks?.[0]?.title).toBe('按钮交互')
  })
  it('restores source and custom tool declarations without installing or running scripts and requires fresh reads', async () => {
    const { service, session, run, create, host } = setup()
    await create()
    await run('tools', {
      tools: JSON.stringify([
        {
          name: 'notes',
          title: '笔记',
          description: '保存笔记',
          version: '1.0.0',
          apiVersion: 'srl-app-tools@1',
          permissions: ['app.storage'],
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ]),
    })
    const snapshot = session.snapshot()!
    const restored = new ProductAssistantAppSession(service)
    await restored.restore(JSON.parse(JSON.stringify(snapshot)))
    const summary = restored.summary()!
    expect(summary.id).toBe(snapshot.manifest.id)
    expect(summary.tools).toEqual(['notes'])
    expect(restored.preview(summary)).toBeUndefined()
    expect(await service.get(summary.id)).toBeUndefined()
    const execute = (operation: AssistantAppOperation, args: Record<string, string>) =>
      restored.execute(
        { action: 'app', operation, args },
        restored.summary(),
        new AbortController().signal,
        host,
      )
    await expect(
      execute('write', { path: 'app.css', content: 'button{color:blue}' }),
    ).rejects.toThrow('先 read')
    expect((await execute('read', { path: 'app.css' })).data?.content).toBe(
      snapshot.source['app.css'],
    )
    await execute('write', { path: 'app.css', content: 'button{color:blue}' })
    expect(restored.snapshot()?.source['app.css']).toBe('button{color:blue}')
    expect(restored.snapshot()?.manifest.tools).toEqual(snapshot.manifest.tools)
  })
  it('configures persistent tools through the existing manifest pipeline, requires reading before replacement, and keeps code/data through reinstall and export', async () => {
    const { service, session, run, create, host } = setup()
    await create()
    const tools = [
      {
        name: 'record_reading',
        title: '阅读打卡',
        description: '保存一次阅读记录',
        version: '1.0.0',
        apiVersion: 'srl-app-tools@1',
        permissions: ['app.storage'],
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
    ]
    await run('tools', { tools: JSON.stringify(tools) })
    expect(session.summary()?.tools).toEqual(['record_reading'])
    expect((await service.listCustomTools()).items).toEqual([])
    await run('preview')
    const preview = session.preview(session.summary()!)!
    expect(preview.manifest.tools).toEqual(tools)
    await expect(run('tools', { tools: '[]' })).rejects.toThrow('manifest.json')
    await run('install')
    const id = session.summary()!.id
    const descriptor = (await service.listCustomTools('阅读')).items[0]!
    expect(descriptor).toMatchObject({ id: `${id}/record_reading`, available: true, appId: id })
    expect(await service.requireCustomTool(descriptor.id, descriptor.fingerprint)).toEqual(
      descriptor,
    )
    await service.setData(id, 'count', 7)
    await run('export')
    const reimported = await service.inspect(host.exportFile.mock.calls[0]![0])
    expect(reimported.manifest.tools).toEqual(tools)
    expect(new TextDecoder().decode(reimported.packageFiles['app.js'])).toContain('missingCounter')
    await service.install(reimported)
    expect(await service.getData(id, 'count')).toBe(7)
    await run('read', { path: 'manifest.json' })
    await run('tools', { tools: '[]' })
    await run('install')
    expect((await service.listCustomTools()).items).toEqual([])
    await expect(service.requireCustomTool(descriptor.id, descriptor.fingerprint)).rejects.toThrow(
      '已移除',
    )
    expect(await service.getData(id, 'count')).toBe(7)
    await run('undo')
    expect(session.summary()?.tools).toEqual(['record_reading'])
    expect((await service.listCustomTools()).items).toEqual([])
  })
  it('creates a unique valid package without installing, mounts only after preview, and exports the same source', async () => {
    const { service, session, host, run, create } = setup()
    const receipt = await create()
    expect(receipt.app?.id).toMatch(/^com\.srl\.ai\./)
    expect(await service.list()).toEqual([])
    expect(session.preview(session.summary()!)).toBeUndefined()
    await run('preview')
    expect(session.preview(session.summary()!)?.runtimeHtml).toContain('srl:connect')
    expect(host.showPreview).toHaveBeenCalledOnce()
    await run('export')
    const exported = await service.inspect(host.exportFile.mock.calls[0]![0])
    expect(exported.manifest.id).toBe(receipt.app!.id)
    expect(exported.manifest.icon).toBeUndefined()
    expect(exported.iconDataUrl).toBeUndefined()
    expect(exported.packageFiles['icon.svg']).toBeUndefined()
    expect(new TextDecoder().decode(exported.packageFiles['app.css'])).toBe('button { color: red }')
    expect(await service.list()).toEqual([])
  })
  it('keeps an explicitly authored APP icon instead of replacing it with the host default', async () => {
    const { service, host, run, create, source } = setup()
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="#ff8800"/></svg>'
    await create({ ...source, 'icon.svg': icon })
    await run('export')
    const exported = await service.inspect(host.exportFile.mock.calls[0]![0])
    expect(exported.manifest.icon).toBe('icon.svg')
    expect(new TextDecoder().decode(exported.packageFiles['icon.svg'])).toBe(icon)
    expect(exported.iconDataUrl).toBe(`data:image/svg+xml;base64,${btoa(icon)}`)
  })
  it('requires reading the current version before replacement, preserves siblings, and rejects stale writes', async () => {
    const { session, run, create } = setup()
    await create()
    const first = session.summary()!
    await expect(run('write', { path: 'app.css', content: 'button{color:green}' })).rejects.toThrow(
      '先 read_app_file',
    )
    await run('read', { path: 'app.css' })
    await run('write', { path: 'app.css', content: 'button{color:green}' })
    expect(session.summary()!.id).toBe(first.id)
    expect((await run('read', { path: 'app.js' })).data?.content).toContain('missingCounter')
    await expect(
      session.execute(
        { action: 'app', operation: 'write', args: { path: 'new.js', content: '' } },
        first,
        new AbortController().signal,
        setup().host,
      ),
    ).rejects.toThrow('草稿已变化')
    await expect(run('write', { path: 'app.css', content: '' })).rejects.toThrow('先 read_app_file')
    await run('undo')
    expect((await run('read', { path: 'app.css' })).data?.content).toContain('red')
  })
  it('never reads other APP/host files, rejects paths, manifest edits, oversized source, unsupported permissions and empty entry', async () => {
    const { run, create, source } = setup()
    await expect(create({ ...source, 'index.html': '' })).rejects.toThrow('非空 HTML')
    await expect(create({ ...source, '../login.js': 'private' })).rejects.toThrow()
    await expect(create({ ...source, 'manifest.json': '{}' })).rejects.toThrow('清单')
    await expect(create({ ...source, 'app.js': 'a'.repeat(40001) })).rejects.toThrow('40000')
    await expect(
      run('create', {
        name: '不合法',
        description: 'x',
        files: JSON.stringify(source),
        permissions: '["host.auth"]',
      }),
    ).rejects.toThrow('权限')
    await create()
    await expect(run('read', { path: 'src/App.vue' })).rejects.toThrow('没有此文件')
    await run('read', { path: 'manifest.json' })
    await expect(run('write', { path: 'manifest.json', content: '{}' })).rejects.toThrow('清单')
  })
  it('blocks a late creation after clear, and aborted creation, without persisting anything', async () => {
    const { service, session, host, source } = setup()
    const original = service.createSourcePreview.bind(service)
    let release!: () => void
    vi.spyOn(service, 'createSourcePreview').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(...args)
    })
    const args = {
      name: '稍后',
      description: 'x',
      files: JSON.stringify(source),
      permissions: '[]',
    }
    const pending = session.execute(
      { action: 'app', operation: 'create', args },
      undefined,
      new AbortController().signal,
      host,
    )
    session.clear()
    release()
    await expect(pending).rejects.toThrow('会话已重置')
    expect(session.summary()).toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    await expect(
      session.execute(
        { action: 'app', operation: 'create', args },
        undefined,
        controller.signal,
        host,
      ),
    ).rejects.toThrow('已停止')
    expect(await service.list()).toEqual([])
  })
  it('confirms and verifies installation, retains stored data through update/undo/clear, and cancels without writes', async () => {
    const { service, session, host, run, create } = setup()
    await create()
    const id = session.summary()!.id
    host.confirmInstall.mockResolvedValueOnce(false)
    expect((await run('install')).ok).toBe(false)
    expect(await service.get(id)).toBeUndefined()
    await run('install')
    expect(session.summary()!.installedRevision).toBe(session.summary()!.revision)
    await service.setData(id, 'days', [1, 2])
    await run('read', { path: 'app.css' })
    await run('write', { path: 'app.css', content: 'button{color:blue}' })
    expect(new TextDecoder().decode((await service.get(id))!.packageFiles!['app.css'])).toContain(
      'red',
    )
    await run('install')
    expect(await service.getData(id, 'days')).toEqual([1, 2])
    await run('undo')
    session.clear()
    expect(new TextDecoder().decode((await service.get(id))!.packageFiles!['app.css'])).toContain(
      'blue',
    )
    expect(await service.getData(id, 'days')).toEqual([1, 2])
  })
  it('keeps only five source undo steps and invalidates reads across every revision', async () => {
    const { run, create } = setup()
    await create()
    for (let i = 1; i <= 7; i++) {
      await run('read', { path: 'app.css' })
      await run('write', { path: 'app.css', content: `button{order:${i}}` })
    }
    for (let i = 0; i < 5; i++) await run('undo')
    await expect(run('undo')).rejects.toThrow('没有可撤销')
    await expect(run('write', { path: 'app.css', content: '' })).rejects.toThrow('先 read_app_file')
    expect((await run('read', { path: 'app.css' })).data?.content).toBe('button{order:2}')
  })
  it('returns only bounded diagnostic classifications and known source identifiers, never raw trial input/logs', async () => {
    const { session, host, run, create } = setup()
    await create()
    host.diagnostics.mockReturnValue({
      state: 'error',
      revision: session.summary()!.revision,
      messages: [
        'PRIVATE_INPUT',
        'ReferenceError: privateSecret is not defined',
        'ReferenceError: missingCounter is not defined',
        'TypeError: PRIVATE_FORM_VALUE',
      ],
    })
    const result = await run('errors')
    expect(result.data?.errors).toEqual([
      { kind: 'unknown' },
      { kind: 'reference' },
      { kind: 'reference', identifier: 'missingCounter' },
      { kind: 'type' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|privateSecret/)
    host.diagnostics.mockReturnValue({ state: 'running', messages: [], revision: -1 })
    expect((await run('errors')).data?.state).toBe('not-previewed')
  })
})
