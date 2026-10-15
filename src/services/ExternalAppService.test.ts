/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'

import { strToU8, unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { AppDatabase } from '../database/AppDatabase'
import { IndexedDbExternalAppStorage } from '../storage/IndexedDbExternalAppStorage'
import { ExternalAppService } from './ExternalAppService'

const databases: AppDatabase[] = []

it('checks a reading permission group from one live summary and rejects revoked, disabled or missing grants', async () => {
  const permissions = ['resources.library.read', 'resources.content.read'] as const
  const storage = {
    getSummary: vi.fn(
      async () => ({ enabled: true, manifest: { permissions: [...permissions] } }) as unknown,
    ),
  }
  const service = new ExternalAppService(storage as never)
  expect(await service.hasPermission('app', [...permissions])).toBe(true)
  expect(storage.getSummary).toHaveBeenCalledTimes(1)
  storage.getSummary.mockResolvedValue({
    enabled: true,
    manifest: { permissions: [permissions[0]] },
  })
  expect(await service.hasPermission('app', [...permissions])).toBe(false)
  expect(await service.hasPermission('app', permissions[0])).toBe(true)
  storage.getSummary.mockResolvedValue({
    enabled: false,
    manifest: { permissions: [...permissions] },
  })
  expect(await service.hasPermission('app', [...permissions])).toBe(false)
  storage.getSummary.mockResolvedValue(undefined)
  expect(await service.hasPermission('app', [...permissions])).toBe(false)
})

it('trusts only inspected build-shipped reader bytes, never an ID or restored fingerprint alone', async () => {
  const service = createService('builtin-reader-identity')
  const preview = await service.inspect(createPackage({ ...manifest, id: 'com.srl.duleme' }))
  const installed = await service.install(preview, 'trustedCompatible')
  expect(service.isBuiltinReader(installed)).toBe(false)
  service.registerBuiltinReader(preview)
  expect(service.isBuiltinReader(installed)).toBe(true)
  expect(
    service.isBuiltinReader({ ...installed, runtimeHtml: '<html>forged runtime</html>' }),
  ).toBe(false)
  expect(service.isBuiltinReader({ ...installed, packageFingerprint: 'different' })).toBe(false)
  expect(service.isBuiltinReader({ ...installed, runtimeMode: 'isolated' })).toBe(false)
  expect(service.isBuiltinReader({ ...installed, enabled: false })).toBe(false)
})

function createService(name: string): ExternalAppService {
  const database = new AppDatabase(name)
  databases.push(database)
  return new ExternalAppService(new IndexedDbExternalAppStorage(database))
}

function createPackage(
  manifest: Record<string, unknown>,
  extraFiles: Record<string, Uint8Array | string> = {},
): File {
  const archive = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'index.html': strToU8(
      '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><img src="images/logo.svg"><script src="app.js"></script></body></html>',
    ),
    'app.css': strToU8('.logo { background: url("images/logo.svg"); }'),
    'app.js': strToU8('window.appLoaded = true'),
    'images/logo.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ...Object.fromEntries(
      Object.entries(extraFiles).map(([path, value]) => [
        path,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    ),
  })
  return new File([archive], 'memo.srlapp', { type: 'application/zip' })
}

const manifest = {
  schemaVersion: 1,
  id: 'com.example.memo',
  name: '离线备忘',
  version: '1.0.0',
  entry: 'index.html',
  permissions: ['app.storage'],
}

it('reads an installed APP summary without loading its runtime table', async () => {
  const database = new AppDatabase(`app-summary-${crypto.randomUUID()}`)
  databases.push(database)
  await database.externalApps.put({ id: manifest.id, manifest, enabled: true } as never)
  const runtimeRead = vi.spyOn(database.externalAppRuntimes, 'get')
  const service = new ExternalAppService(new IndexedDbExternalAppStorage(database))
  expect(await service.getSummary(manifest.id)).toMatchObject({ id: manifest.id, enabled: true })
  expect(runtimeRead).not.toHaveBeenCalled()
})

afterEach(async () => {
  const opened = databases.splice(0)
  const names = opened.map((database) => database.name)
  opened.forEach((database) => database.close())
  await Promise.all(names.map((name) => indexedDB.deleteDatabase(name)))
})

describe('ExternalAppService', () => {
  it.each([128, 129])(
    'keeps the third-party package boundary at %i total archive entries',
    async (total) => {
      const service = createService(`third-party-file-boundary-${total}-${crypto.randomUUID()}`)
      const extras = Object.fromEntries(
        Array.from({ length: total - 5 }, (_, index) => [`extra-${index}.txt`, 'fixture']),
      )
      const installing = service.install(createPackage(manifest, extras))
      if (total === 128) {
        await installing
        expect(await service.getSummary(manifest.id)).toBeDefined()
      } else {
        await expect(installing).rejects.toThrow('安装包文件数量超过限制')
        expect(await service.getSummary(manifest.id)).toBeUndefined()
      }
    },
  )
  it('reads live installation summaries without loading executable package data', async () => {
    const database = new AppDatabase(`summary-${crypto.randomUUID()}`)
    databases.push(database)
    const storage = new IndexedDbExternalAppStorage(database)
    const service = new ExternalAppService(storage)
    await service.install(createPackage(manifest))
    const fullRead = vi.spyOn(storage, 'get')
    expect(await service.getSummary(manifest.id)).toMatchObject({ enabled: true })
    await service.setEnabled(manifest.id, false)
    expect(await service.getSummary(manifest.id)).toMatchObject({ enabled: false })
    expect(await service.getSummary('missing')).toBeUndefined()
    expect(fullRead).not.toHaveBeenCalled()
  })

  it('discovers only installed declarations, pages metadata, disables incompatible/denied tools, detects source changes and preserves backup source/data', async () => {
    const service = createService(`tools-${crypto.randomUUID()}`)
    const definition = {
      name: 'note',
      title: '笔记工具',
      description: '保存笔记',
      version: '1.0.0',
      apiVersion: 'srl-app-tools@1',
      permissions: ['app.storage'],
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }
    const current = {
      ...manifest,
      schemaVersion: 2,
      apiVersion: 'srl-app-api@1',
      tools: [definition],
    }
    const installed = await service.install(createPackage(current))
    await service.setData(installed.id, 'note', '私有资料')
    let descriptor = (await service.listCustomTools('笔记')).items[0]!
    expect(descriptor).toMatchObject({ available: true, fingerprint: installed.packageFingerprint })
    await service.setEnabled(installed.id, false)
    expect((await service.listCustomTools()).items[0]).toMatchObject({
      available: false,
      unavailableReason: 'APP 已停用',
    })
    await expect(service.requireCustomTool(descriptor.id, descriptor.fingerprint)).rejects.toThrow(
      '停用',
    )
    await service.setEnabled(installed.id, true)
    await service.install(createPackage(current), 'trustedCompatible')
    expect((await service.listCustomTools()).items[0]).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining('标准隔离模式'),
    })
    await service.install(createPackage(current), 'isolated')
    await service.updateSourceFile(installed.id, 'app.js', 'window.updated = true')
    await expect(service.requireCustomTool(descriptor.id, descriptor.fingerprint)).rejects.toThrow(
      '版本已变化',
    )
    const future = createPackage({
      ...current,
      tools: [{ ...definition, apiVersion: 'srl-app-tools@2' }],
    })
    await service.install(future)
    expect((await service.listCustomTools()).items[0]).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining('源码保留'),
    })
    const target = createService(`tools-restored-${crypto.randomUUID()}`)
    await target.importPortableState(await service.exportPortableState())
    expect((await target.listCustomTools()).items[0]).toMatchObject({ available: false })
    expect((await target.get(installed.id))?.packageFiles?.['app.js']).toBeDefined()
    await target.setEnabled(installed.id, true)
    expect(await target.getData(installed.id, 'note')).toBe('私有资料')
    await service.install(createPackage(current))
    await service.setAllowedPermissions(installed.id, [])
    expect((await service.listCustomTools()).items[0]).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining('权限'),
    })
    await service.setAllowedPermissions(installed.id, ['app.storage'])
    descriptor = (await service.listCustomTools()).items[0]!
    for (let index = 0; index < 21; index++)
      await service.install(createPackage({ ...current, id: `com.example.page-${index}` }))
    const page = await service.listCustomTools()
    expect(page.items).toHaveLength(20)
    expect(page.total).toBe(22)
    expect(page.nextOffset).toBe(20)
    expect((await service.listCustomTools('', 20)).items).toHaveLength(2)
    expect(JSON.stringify(page)).not.toContain('runtimeHtml')
    expect(JSON.stringify(page)).not.toContain('私有资料')
    await service.uninstall(installed.id)
    await expect(service.requireCustomTool(descriptor.id, descriptor.fingerprint)).rejects.toThrow(
      '已移除',
    )
  })
  it('keeps reader data through promotion and backs it up separately from third-party code', async () => {
    const id = 'com.srl.duleme'
    const service = createService(`reader-${crypto.randomUUID()}`)
    await service.install(createPackage({ ...manifest, id }))
    await service.setData(id, 'chat:rain', { note: '留住这一楼', marks: [{ floor: 2, reply: 1 }] })
    await service.install(createPackage({ ...manifest, id, version: '2.0.0' }))
    expect(await service.getData(id, 'chat:rain')).toMatchObject({ note: '留住这一楼' })
    expect(await service.list()).toEqual([])
    expect(await service.exportPortableState()).toEqual({ apps: [], data: [] })
    const data = await service.exportReaderData()
    const restored = createService(`reader-restore-${crypto.randomUUID()}`)
    await restored.importReaderData(data)
    await restored.install(createPackage({ ...manifest, id }))
    expect(await restored.getData(id, 'chat:rain')).toEqual(data[0]!.value)
  })
  it('restores exported apps disabled and without their former grants', async () => {
    const source = createService(`external-export-${crypto.randomUUID()}`)
    await source.install(createPackage(manifest))
    await source.setData(manifest.id, 'note', { text: 'backup me' })
    const target = createService(`external-import-${crypto.randomUUID()}`)

    await target.importPortableState(await source.exportPortableState())

    expect(await target.get(manifest.id)).toMatchObject({ enabled: false, grantedPermissions: [] })
    await expect(target.getData(manifest.id, 'note')).rejects.toThrow('本地存储权限')
  })

  it('inspects a self-contained package without persisting it before confirmation', async () => {
    const service = createService(`external-app-${crypto.randomUUID()}`)

    const preview = await service.inspect(createPackage(manifest))

    expect(preview.manifest.name).toBe('离线备忘')
    expect(preview.runtimeHtml).toContain("connect-src 'none'")
    expect(preview.runtimeHtml).toContain("for (const name of ['localStorage', 'sessionStorage'])")
    expect(preview.runtimeHtml.indexOf('const createMemoryStorage')).toBeLessThan(
      preview.runtimeHtml.indexOf('window.appLoaded = true'),
    )
    expect(preview.runtimeHtml).toContain('diagnostics.splice(0).forEach')
    expect(preview.runtimeHtml).toContain("Object.defineProperty(navigator, 'locks'")
    expect(preview.runtimeHtml).toContain("exitFullscreen: () => request('ui.exitFullscreen'")
    expect(preview.runtimeHtml).toContain("setTitle: (title) => request('ui.title'")
    expect(preview.runtimeHtml).toContain('files: Object.freeze({')
    expect(preview.runtimeHtml).toContain('SRL_RUNTIME_BRIDGE_V4')
    expect(preview.runtimeHtml).toContain("'srl:host-hold-start'")
    expect(preview.runtimeHtml).toContain('HOLD_MOVE_TOLERANCE_PX = 18')
    expect(preview.runtimeHtml).toContain("window.addEventListener('pointermove'")
    expect(preview.runtimeHtml).toContain("window.addEventListener('touchmove'")
    expect(preview.runtimeHtml).toContain("window.addEventListener('touchend'")
    expect(preview.runtimeHtml).toContain("window.addEventListener('blur', endHostHoldGesture")
    expect(preview.runtimeHtml).not.toContain(
      "window.addEventListener('pointercancel', () => sendHostHoldSignal('srl:host-hold-end'",
    )
    expect(await service.get(manifest.id)).toBeUndefined()
  })

  it('refreshes an installed package runtime when the host bridge changes', async () => {
    const database = new AppDatabase(`external-runtime-migration-${crypto.randomUUID()}`)
    databases.push(database)
    const storage = new IndexedDbExternalAppStorage(database)
    const service = new ExternalAppService(storage)
    const installed = await service.install(createPackage(manifest))
    await storage.save({
      ...installed,
      runtimeHtml: '<!doctype html><html><body><!-- SRL_RUNTIME_BRIDGE_V2 -->legacy</body></html>',
    })

    const migrated = await service.get(manifest.id)

    expect(migrated?.runtimeHtml).toContain('SRL_RUNTIME_BRIDGE_V4')
    expect((await storage.get(manifest.id))?.runtimeHtml).toContain('srl:host-hold-start')
  })

  it('installs a Vue-reactive preview as plain IndexedDB data', async () => {
    const service = createService(`external-reactive-preview-${crypto.randomUUID()}`)
    const preview = reactive(await service.inspect(createPackage(manifest)))

    await expect(service.install(preview)).resolves.toMatchObject({ id: manifest.id })
  })

  it('accepts a package with a static asset larger than 5 MiB within the new package budget', async () => {
    const service = createService(`external-large-asset-${crypto.randomUUID()}`)
    const largeAsset = new Uint8Array(6 * 1024 * 1024)

    const preview = await service.inspect(
      createPackage(manifest, { 'images/hero.webp': largeAsset }),
    )

    expect(preview.manifest.id).toBe(manifest.id)
  })

  it('turns a single HTML page into a local APP and preserves its trusted compatibility runtime', async () => {
    const service = createService(`external-html-${crypto.randomUUID()}`)
    const html = new File(
      [
        '<!doctype html><html><head><script src="https://cdn.example/app.js"></script></head><body><img src="https://images.example/card.png"></body></html>',
      ],
      '我的工具.html',
      { type: 'text/html' },
    )

    const preview = await service.inspect(html)

    expect(preview.sourceKind).toBe('html')
    expect(preview.manifest.id).toMatch(/^local\./)
    expect(preview.runtimeHtml).not.toContain('cdn.example')
    expect(preview.compatibleRuntimeHtml).toContain('https://cdn.example/app.js')
    expect(preview.compatibleRuntimeHtml).toContain('connect-src https:')

    const installed = await service.install(preview, 'trustedCompatible')
    expect(installed.runtimeMode).toBe('trustedCompatible')
    expect(installed.runtimeHtml).toContain('https://images.example/card.png')
    expect(installed.packageFiles?.['我的工具.html']).toBeDefined()
    const exported = await service.exportPackage(installed.id)
    const contents = unzipSync(new Uint8Array(await exported.arrayBuffer()))
    expect(contents['我的工具.html']).toBeDefined()
    expect(contents['manifest.json']).toBeDefined()
  })

  it('creates a standard editable template package with app metadata', async () => {
    const service = createService(`external-template-${crypto.randomUUID()}`)

    const template = service.createTemplatePackage()
    const preview = await service.inspect(template)

    expect(preview.manifest.icon).toBeUndefined()
    expect(preview.iconDataUrl).toBeUndefined()
    expect(preview.manifest.splashColor).toBeUndefined()
    expect(preview.manifest.orientation).toBe('auto')
    expect(preview.packageFiles['app.js']).toBeDefined()
  })

  it('uses themed default covers for quick imports without adding images to the package', async () => {
    const service = createService(`external-themed-${crypto.randomUUID()}`)
    const preview = await service.inspect(new File(['<p>local</p>'], 'local.html'))
    expect(preview.manifest.icon).toBeUndefined()
    expect(preview.manifest.splashColor).toBeUndefined()
    expect(preview.iconDataUrl).toBeUndefined()
    expect(Object.keys(preview.packageFiles)).toEqual(['local.html'])
    const installed = await service.install(preview)
    expect(
      (await service.list()).find((app) => app.id === installed.id)?.iconDataUrl,
    ).toBeUndefined()
    const restored = await service.inspect(await service.exportPackage(installed.id))
    expect(restored.manifest.icon).toBeUndefined()
    expect(restored.iconDataUrl).toBeUndefined()
  })

  it('renders existing generated covers through the theme while preserving custom images and stored bytes', async () => {
    const service = createService(`external-legacy-cover-${crypto.randomUUID()}`)
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#237f87"/><path fill="#fff" d="M25 28h46v40H25z" opacity=".92"/><path fill="#237f87" d="M34 38h28v5H34zm0 11h20v5H34z"/></svg>'
    const app = await service.install(
      createPackage(
        { ...manifest, icon: 'srl-app-icon.svg' },
        { 'srl-app-icon.svg': strToU8(svg) },
      ),
    )
    const original = `data:image/svg+xml;base64,${btoa(svg)}`
    await service.updatePresentation(app.id, manifest.name, original)
    expect((await service.list())[0]?.iconDataUrl).toBeUndefined()
    expect((await service.get(app.id))?.iconDataUrl).toBe(original)
    expect((await service.get(app.id))?.packageFiles?.['srl-app-icon.svg']).toEqual(strToU8(svg))
    const custom = `data:image/svg+xml;base64,${btoa(svg.replace('#237f87', '#ff8800'))}`
    await service.updatePresentation(app.id, manifest.name, custom)
    expect((await service.list())[0]?.iconDataUrl).toBe(custom)
  })
  it('uses the theme for previously generated AI APP covers without changing stored presentation or package bytes', async () => {
    const service = createService(`external-legacy-ai-cover-${crypto.randomUUID()}`)
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#5b7d71"/><path d="M19 21h26M19 32h19M19 43h13" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>'
    const app = await service.install(
      createPackage({ ...manifest, icon: 'icon.svg' }, { 'icon.svg': strToU8(svg) }),
    )
    const original = `data:image/svg+xml;base64,${btoa(svg)}`
    await service.updatePresentation(app.id, manifest.name, original)
    expect((await service.list())[0]?.iconDataUrl).toBeUndefined()
    expect((await service.get(app.id))?.iconDataUrl).toBe(original)
    const exported = await service.inspect(await service.exportPackage(app.id))
    expect(exported.iconDataUrl).toBeUndefined()
    expect(Array.from(exported.packageFiles['icon.svg']!)).toEqual(Array.from(strToU8(svg)))
  })

  it('records and revokes a persistent runtime permission without granting undeclared access', async () => {
    const service = createService(`external-permission-${crypto.randomUUID()}`)
    const installed = await service.install(
      createPackage({
        ...manifest,
        schemaVersion: 2,
        apiVersion: 'srl-app-api@1',
        permissionLevel: 'selectedRead',
        permissions: ['resources.selected.read'],
      }),
    )

    await service.grantPersistentPermission(installed.id, 'resources.selected.read')
    await service.recordPermissionDecision(installed.id, {
      permission: 'resources.selected.read',
      method: 'resources.pick',
      decision: 'always',
      summary: '用户选择资源后读取。',
    })

    expect(await service.hasPersistentPermission(installed.id, 'resources.selected.read')).toBe(
      true,
    )
    expect((await service.get(installed.id))?.permissionAudit).toHaveLength(1)
    await expect(
      service.grantPersistentPermission(installed.id, 'resources.write'),
    ).rejects.toThrow('未在清单中声明')
    await service.revokePersistentPermission(installed.id)
    expect(await service.hasPersistentPermission(installed.id, 'resources.selected.read')).toBe(
      false,
    )
  })

  it('installs a self-contained package and persists app-local data across service instances', async () => {
    const name = `external-app-${crypto.randomUUID()}`
    const first = createService(name)
    const installed = await first.install(createPackage(manifest))

    expect(installed.enabled).toBe(true)
    expect(installed.runtimeHtml).toContain("connect-src 'none'")
    expect(installed.runtimeHtml).toContain('window.srlApp')
    expect(installed.runtimeHtml).toContain("update: (change) => request('resources.update'")
    expect(installed.runtimeHtml).not.toContain('drafts.create')
    expect(installed.runtimeHtml).toContain('data:image/svg+xml;base64,')
    expect(installed.runtimeHtml).not.toContain('src="app.js"')

    await first.setData(installed.id, 'draft', { text: 'hello' })

    const second = createService(name)
    expect(await second.getData(installed.id, 'draft')).toEqual({ text: 'hello' })

    await second.setEnabled(installed.id, false)
    expect((await second.get(installed.id))?.enabled).toBe(false)
    await second.uninstall(installed.id)
    expect(await second.get(installed.id)).toBeUndefined()

    const third = createService(name)
    const reinstalled = await third.install(createPackage(manifest))
    expect(await third.getData(reinstalled.id, 'draft')).toEqual({ text: 'hello' })
    await third.clearData(reinstalled.id)
    expect(await third.getData(reinstalled.id, 'draft')).toBeNull()
  })

  it('keeps runtime HTML out of the list result and reports bounded per-app storage health', async () => {
    const service = createService(`external-health-${crypto.randomUUID()}`)
    const installed = await service.install(createPackage(manifest))

    const summary = (await service.list())[0]
    expect(summary).toBeDefined()
    expect('runtimeHtml' in summary!).toBe(false)

    await service.setData(installed.id, 'draft', { text: 'saved locally' })
    const health = await service.getHealth(installed.id)
    expect(health.packageBytes).toBeGreaterThan(0)
    expect(health.dataBytes).toBeGreaterThan(0)
    expect(health.dataEntries).toBe(1)
    expect(health.dataLimitBytes).toBe(1024 * 1024)

    await service.recordRuntimeError(installed.id, new Error('startup failed'))
    expect((await service.getHealth(installed.id)).lastError).toBe('startup failed')
    expect((await service.getHealth(installed.id)).consecutiveFailures).toBe(1)
  })

  it('only clears crash history after a healthy SDK connection and disables the failing app at three errors', async () => {
    const service = createService(`external-watchdog-${crypto.randomUUID()}`)
    const installed = await service.install(createPackage(manifest))

    await service.recordRuntimeError(installed.id, 'first')
    await service.recordLaunch(installed.id)
    expect((await service.getHealth(installed.id)).consecutiveFailures).toBe(1)
    await service.recordRuntimeError(installed.id, 'second')
    const health = await service.recordRuntimeError(installed.id, 'third')

    expect(health?.disabledByWatchdog).toBe(true)
    expect((await service.get(installed.id))?.enabled).toBe(false)
    await service.setEnabled(installed.id, true)
    await service.recordHealthyLaunch(installed.id)
    expect((await service.getHealth(installed.id)).consecutiveFailures).toBe(0)
  })

  it('reports browser persistence and worker requirements before installation', async () => {
    const service = createService(`external-preflight-${crypto.randomUUID()}`)
    const html = new File(
      [
        '<!doctype html><script>indexedDB.open("app"); navigator.serviceWorker.register("sw.js"); localStorage.getItem("x"); fetch("/api")</script>',
      ],
      '检查.html',
      { type: 'text/html' },
    )

    const preview = await service.inspect(html)

    expect(preview.compatibility.map((notice) => notice.code)).toEqual(
      expect.arrayContaining([
        'isolated-persistence',
        'worker',
        'session-storage',
        'external-or-absolute-path',
        'viewport',
      ]),
    )
    expect(preview.packageBytes).toBeGreaterThan(0)
  })

  it('rejects unsupported permissions before an app reaches the runtime', async () => {
    const service = createService(`external-app-${crypto.randomUUID()}`)

    await expect(
      service.install(
        createPackage({
          ...manifest,
          permissions: ['app.storage', 'resources.read'],
        }),
      ),
    ).rejects.toThrow('APP 声明了暂不支持的权限')
  })

  it('rejects a package whose declared icon is missing', async () => {
    const service = createService(`external-missing-icon-${crypto.randomUUID()}`)

    await expect(
      service.inspect(
        createPackage({
          ...manifest,
          schemaVersion: 2,
          apiVersion: 'srl-app-api@1',
          permissionLevel: 'isolated',
          icon: 'missing.svg',
          permissions: [],
        }),
      ),
    ).rejects.toThrow('图标文件')
  })

  it('does not expose app storage without an explicit storage permission', async () => {
    const service = createService(`external-app-${crypto.randomUUID()}`)
    const installed = await service.install(
      createPackage({ ...manifest, id: 'com.example.no-storage', permissions: [] }),
    )

    await expect(service.removeData(installed.id, 'draft')).rejects.toThrow('本地存储权限')
  })

  it('clears persisted runtime permission grants when an upgraded package changes', async () => {
    const name = `external-app-${crypto.randomUUID()}`
    const service = createService(name)
    await service.install(createPackage(manifest))
    const upgrade = createPackage({
      ...manifest,
      schemaVersion: 2,
      apiVersion: 'srl-app-api@1',
      permissionLevel: 'selectedRead',
      version: '1.1.0',
      permissions: ['app.storage', 'resources.selected.read'],
    })

    const preview = await service.inspect(upgrade)
    expect(preview.requiresReauthorization).toBe(true)
    expect(preview.permissionLevel).toBe('selectedRead')
    await service.grantPersistentPermission(manifest.id, 'app.storage')
    const installed = await service.install(upgrade)
    expect(installed.grantedPermissions).toEqual([])
    expect(installed.persistentPermissionGrants).toEqual([])
    expect((await createService(name).get(installed.id))?.persistentPermissionGrants).toEqual([])
  })

  it('changes permissions and enabled state without rewriting the large runtime record', async () => {
    const name = `external-metadata-${crypto.randomUUID()}`
    const database = new AppDatabase(name)
    databases.push(database)
    const service = new ExternalAppService(new IndexedDbExternalAppStorage(database))
    const installed = await service.install(
      createPackage(manifest, { 'large.js': new Uint8Array(6 * 1024 * 1024) }),
    )
    const putRuntime = vi.spyOn(database.externalAppRuntimes, 'put')

    await service.grantPersistentPermission(installed.id, 'app.storage')
    await service.setEnabled(installed.id, false)
    await service.recordPermissionDecision(installed.id, {
      permission: 'app.storage',
      method: 'storage.get',
      decision: 'always',
      summary: 'test',
    })

    expect(putRuntime).not.toHaveBeenCalled()
    expect((await service.get(installed.id))?.persistentPermissionGrants).toEqual(['app.storage'])
  })
  it('distinguishes duplicate packages, changed content and newly requested abilities', async () => {
    const service = createService(`external-compare-${crypto.randomUUID()}`)
    const original = await service.install(createPackage(manifest))
    const duplicate = await service.inspect(createPackage(manifest))
    expect(duplicate.previousInstallation).toMatchObject({ id: original.id, version: '1.0.0' })
    expect(duplicate.contentChanged).toBe(false)
    expect(duplicate.addedPermissions).toEqual([])
    const changed = await service.inspect(createPackage({ ...manifest, version: '1.0.1' }))
    expect(changed.contentChanged).toBe(true)
    expect(changed.addedPermissions).toEqual([])
    expect(changed.requiresReauthorization).toBe(true)
  })

  it('lets a quick webpage explicitly update an existing app without losing its data', async () => {
    const service = createService(`external-target-${crypto.randomUUID()}`)
    const original = await service.install(createPackage(manifest))
    await service.setData(original.id, 'draft', { text: '保留草稿' })
    const incoming = await service.inspect(
      new File(['<p>新版网页</p>'], 'new.html', { type: 'text/html' }),
    )
    expect(incoming.manifest.id).not.toBe(original.id)
    const configured = await service.configurePreview(incoming, { updateAppId: original.id })
    expect(configured.manifest.id).toBe(original.id)
    expect(configured.previousInstallation?.name).toBe(original.manifest.name)
    expect(configured.packageFingerprint).toBe(incoming.packageFingerprint)
    expect(configured.packageFiles).toBe(incoming.packageFiles)
    expect(incoming.manifest.id).not.toBe(original.id)
    await service.install(configured)
    expect(await service.list()).toHaveLength(1)
    expect((await service.exportPortableState()).data).toEqual([
      expect.objectContaining({ appId: original.id, key: 'draft', value: { text: '保留草稿' } }),
    ])
  })

  it('supports selecting another quick-import HTML entry and refuses to retarget authored packages', async () => {
    const service = createService(`external-entry-${crypto.randomUUID()}`)
    const incoming = await service.inspect([
      new File(['<p>首页</p>'], 'index.html'),
      new File(['<p>另一个入口</p>'], 'other.html'),
    ])
    const selected = await service.configurePreview(incoming, { entry: 'other.html' })
    expect(selected.runtimeHtml).toContain('另一个入口')
    await expect(service.configurePreview(incoming, { entry: 'absent.html' })).rejects.toThrow(
      '包内 HTML',
    )
    const authored = await service.inspect(createPackage(manifest))
    await expect(service.configurePreview(authored, { entry: 'index.html' })).rejects.toThrow(
      '作者声明',
    )
  })

  it('switches installed runtime modes without discarding data and invalidates remembered grants', async () => {
    const service = createService(`external-mode-${crypto.randomUUID()}`)
    const app = await service.install(
      createPackage({
        ...manifest,
        schemaVersion: 2,
        apiVersion: 'srl-app-api@1',
        permissions: ['app.storage', 'resources.library.read'],
      }),
    )
    await service.setData(app.id, 'note', 'keep')
    await service.grantPersistentPermission(app.id, 'resources.library.read')
    await service.recordPermissionDecision(app.id, {
      permission: 'resources.library.read',
      method: 'resources.list',
      decision: 'always',
      summary: '读取摘要',
    })
    await service.setRuntimeMode(app.id, 'trustedCompatible')
    const changed = await service.get(app.id)
    expect(changed?.runtimeMode).toBe('trustedCompatible')
    expect(changed?.runtimeHtml).toContain('connect-src https:')
    expect(changed?.persistentPermissionGrants).toEqual([])
    expect(await service.getData(app.id, 'note')).toBe('keep')
    await service.setRuntimeMode(app.id, 'isolated')
    expect((await service.get(app.id))?.runtimeHtml).toContain("connect-src 'none'")
  })

  it('does not retain authorization across a same-package runtime mode change', async () => {
    const service = createService(`external-reinstall-mode-${crypto.randomUUID()}`)
    const file = createPackage({
      ...manifest,
      schemaVersion: 2,
      apiVersion: 'srl-app-api@1',
      permissions: ['resources.library.read'],
    })
    const app = await service.install(file)
    await service.grantPersistentPermission(app.id, 'resources.library.read')
    await service.recordPermissionDecision(app.id, {
      permission: 'resources.library.read',
      method: 'resources.list',
      decision: 'always',
      summary: '读取摘要',
    })
    const preview = await service.inspect(file)
    const installed = await service.install(preview, 'trustedCompatible')
    expect(installed.persistentPermissionGrants).toEqual([])
  })

  it('lists and clears only uninstalled third-party data, preserving reader and installed app data', async () => {
    const service = createService(`external-retained-${crypto.randomUUID()}`)
    const removed = await service.install(createPackage(manifest))
    await service.setData(removed.id, 'note', 'retained')
    const kept = await service.install(createPackage({ ...manifest, id: 'com.example.kept' }))
    await service.setData(kept.id, 'note', 'installed')
    const reader = await service.install(createPackage({ ...manifest, id: 'com.srl.duleme' }))
    await service.setData(reader.id, 'note', 'reader')
    await service.uninstall(removed.id)
    const retained = await service.listRetainedData()
    expect(retained).toEqual([expect.objectContaining({ appId: removed.id, dataEntries: 1 })])
    const exported = await service.exportData(removed.id)
    expect(JSON.parse(await exported.text()).records[0].value).toBe('retained')
    await expect(service.clearRetainedData(kept.id)).rejects.toThrow('管理页')
    await service.clearRetainedData(removed.id)
    expect(await service.listRetainedData()).toEqual([])
    expect(await service.getData(kept.id, 'note')).toBe('installed')
    expect(await service.getData(reader.id, 'note')).toBe('reader')
  })

  it('resets watchdog suspension when the user explicitly re-enables the app', async () => {
    const service = createService(`external-watchdog-reset-${crypto.randomUUID()}`)
    const app = await service.install(createPackage(manifest))
    for (let index = 0; index < 3; index++) await service.recordRuntimeError(app.id, 'broken')
    expect((await service.getHealth(app.id)).disabledByWatchdog).toBe(true)
    await service.setEnabled(app.id, true)
    expect((await service.getHealth(app.id)).disabledByWatchdog).toBe(false)
    expect((await service.getHealth(app.id)).consecutiveFailures).toBe(0)
    await service.recordRuntimeError(app.id, 'new failure')
    expect((await service.get(app.id))?.enabled).toBe(true)
  })

  it('does not mistake closing HTML tags for external resources', async () => {
    const service = createService(`external-no-false-warning-${crypto.randomUUID()}`)
    const preview = await service.inspect(
      new File(
        ['<!doctype html><meta name="viewport" content="width=device-width"><p>纯本地</p>'],
        'offline.html',
      ),
    )
    expect(preview.compatibility.some((item) => item.code === 'external-or-absolute-path')).toBe(
      false,
    )
  })
  it('installs quick webpages with an htm entry', async () => {
    const service = createService(`external-htm-${crypto.randomUUID()}`)
    const preview = await service.inspect(
      new File(['<p>网页</p>'], 'index.htm', { type: 'text/html' }),
    )
    expect(preview.manifest.entry).toBe('index.htm')
    expect((await service.install(preview)).manifest.entry).toBe('index.htm')
  })
  it('uses the selected folder name rather than its first CSS file, including single-file folders', async () => {
    const service = createService(`external-folder-name-${crypto.randomUUID()}`)
    const css = new File(['p{}'], 'app.css')
    const html = new File(['<p>网页</p>'], 'index.html')
    Object.defineProperty(css, 'webkitRelativePath', { value: '我的工具.v2/app.css' })
    Object.defineProperty(html, 'webkitRelativePath', { value: '我的工具.v2/index.html' })
    for (const files of [[css, html], [html]]) {
      const preview = await service.inspect(files)
      expect(preview.manifest.name).toBe('我的工具.v2')
      expect(preview.manifest.entry).toBe('index.html')
      expect(preview.sourceKind).toBe('folder')
    }
  })
  it('exports the saved local icon so it survives reinstalling the package', async () => {
    const service = createService(`external-export-icon-${crypto.randomUUID()}`)
    const app = await service.install(createPackage(manifest))
    const icon = 'data:image/png;base64,aWNvbg=='
    await service.updatePresentation(app.id, '新名称', icon)
    const inspected = await service.inspect(await service.exportPackage(app.id))
    expect(inspected.manifest.name).toBe('新名称')
    expect(inspected.iconDataUrl).toBe(icon)
  })
  it('exports a cleared icon without resurrecting the package icon', async () => {
    const service = createService(`external-export-no-icon-${crypto.randomUUID()}`)
    const app = await service.install(createPackage({ ...manifest, icon: 'images/logo.svg' }))
    await service.updatePresentation(app.id, manifest.name, '')
    const preview = await service.inspect(await service.exportPackage(app.id))
    expect(preview.manifest.icon).toBeUndefined()
    expect(preview.iconDataUrl).toBeUndefined()
  })
  it('explains that a remote display icon needs an uploaded image for package export', async () => {
    const service = createService(`external-export-url-${crypto.randomUUID()}`)
    const app = await service.install(createPackage(manifest))
    await service.updatePresentation(app.id, manifest.name, 'https://example.com/icon.png')
    await expect(service.exportPackage(app.id)).rejects.toThrow('链接图标仅用于本机显示')
    expect((await service.get(app.id))?.iconDataUrl).toBe('https://example.com/icon.png')
  })
  it('enumerates retained app IDs without unique cursors or reading all data bodies', async () => {
    const service = createService(`external-key-cursor-${crypto.randomUUID()}`)
    const app = await service.install(createPackage(manifest))
    await service.setData(app.id, 'one', 1)
    await service.setData(app.id, 'two', 2)
    await service.uninstall(app.id)
    const original = IDBIndex.prototype.openKeyCursor
    const cursor = vi.spyOn(IDBIndex.prototype, 'openKeyCursor').mockImplementation(function (
      this: IDBIndex,
      query,
      direction,
    ) {
      if (direction === 'nextunique' || direction === 'prevunique')
        throw new DOMException('Unable to open cursor', 'UnknownError')
      return original.call(this, query, direction)
    })
    try {
      expect(await service.listRetainedData()).toEqual([
        expect.objectContaining({ appId: app.id, dataEntries: 2 }),
      ])
    } finally {
      cursor.mockRestore()
    }
  })
})
