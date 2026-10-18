/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { OfficialAppService } from './OfficialAppService'
import { hashBytes } from './HashService'
import type { OfficialAppPackageStorage } from '../storage/OfficialAppPackageStorage'
import type { InstalledOfficialApp, OfficialAppId, OfficialAppPackage } from '../types/OfficialApp'

describe('official APP package lifecycle', () => {
  it('shares concurrent catalog requests but fetches fresh data after completion or failure', async () => {
    const { service, fetcher } = await fixture()
    const original = fetcher.getMockImplementation()!
    let finish!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const first = service.catalog()
    const second = service.catalog()
    finish(await original('https://library.test/catalog.json'))
    expect(await first).toEqual(await second)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(service.catalog()).rejects.toThrow('offline')
    await expect(service.catalog()).resolves.toMatchObject({ schemaVersion: 1 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('excludes retired installed APPs without deleting their records or files', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const retiredId = 'removedApp' as OfficialAppId
    const retired = { ...records.get('draw')!, id: retiredId }
    records.set(retiredId, retired)
    const deleteFile = vi.spyOn(storage, 'deleteFile')
    storage.get = vi.fn(async (id) => records.get(id))

    expect((await service.list()).map((app) => app.id)).toEqual(['draw'])
    expect(service.installedSnapshot.map((app) => app.id)).toEqual(['draw'])
    expect(await service.getReadyPackage(retiredId)).toBeUndefined()
    await expect(service.install(retiredId)).rejects.toThrow('APP 标识无效')
    expect(records.get(retiredId)).toEqual(retired)
    expect(deleteFile).not.toHaveBeenCalled()
    expect(clearData).not.toHaveBeenCalled()
    expect(clearStyles).not.toHaveBeenCalled()
  })

  it('retains the installed directory across entries and publishes real installation changes', async () => {
    const { service } = await fixture()
    const list = vi.spyOn(storage, 'list')
    const changes = vi.fn()
    const stop = service.subscribeInstalled(changes)
    await Promise.all([service.loadInstalled(), service.loadInstalled()])
    expect(list).toHaveBeenCalledOnce()
    await service.loadInstalled()
    expect(list).toHaveBeenCalledOnce()
    await service.install('draw')
    expect(service.installedSnapshot.map((app) => app.id)).toEqual(['draw'])
    await service.uninstall('draw', false)
    expect(service.installedSnapshot).toEqual([])
    expect(changes).toHaveBeenLastCalledWith([])
    stop()
  })

  it('opens without checking package files and detects same-sized corruption on an explicit status check', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const hasFile = vi.spyOn(storage, 'hasFile')
    const hash = vi.spyOn(storage, 'hasFileHash')
    await service.getReadyPackage('draw')
    await service.getReadyPackage('draw')
    expect(hasFile).not.toHaveBeenCalled()
    expect(hash).not.toHaveBeenCalled()
    files.set('/assets/draw-123.js', new Uint8Array(files.get('/assets/draw-123.js')!.length))
    expect(await service.checkInstalledStatus()).toEqual([{ id: 'draw', ready: false }])
    expect(await service.ready('draw')).toBe(false)
    expect(await service.getReadyPackage('draw')).toBeUndefined()
    await service.install('draw')
    expect(await service.getReadyPackage('draw')).toMatchObject({ id: 'draw' })
    expect(await service.checkInstalledStatus()).toEqual([{ id: 'draw', ready: true }])
  })
  it('opens an installed APP with a targeted settings read and no full installation scan', async () => {
    const { service } = await fixture()
    await service.install('draw')
    storage.get = vi.fn(async (id) => records.get(id))
    const list = vi
      .spyOn(storage, 'list')
      .mockRejectedValue(new Error('must not scan all APP settings'))
    expect(await service.getReadyPackage('draw')).toMatchObject({ id: 'draw' })
    expect(storage.get).toHaveBeenCalledExactlyOnceWith('draw')
    expect(list).not.toHaveBeenCalled()
  })
  it('does not commit or report a successful installation when final readiness fails', async () => {
    const { service } = await fixture()
    storage.hasFiles = async () => false
    await expect(service.install('draw')).rejects.toThrow('可启动')
    expect(records.has('draw')).toBe(false)
    expect(files.size).toBe(0)
  })

  let records: Map<OfficialAppId, InstalledOfficialApp>
  let files: Map<string, Uint8Array>
  let storage: OfficialAppPackageStorage
  const clearData = vi.fn(async () => {})
  const clearStyles = vi.fn(async () => {})
  beforeEach(() => {
    records = new Map()
    files = new Map()
    clearData.mockClear()
    clearStyles.mockClear()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (
          _name: string,
          optionsOrAction: unknown,
          action?: (lock: object) => Promise<unknown>,
        ) => (action ? action({}) : (optionsOrAction as () => Promise<unknown>)()),
      },
    })
    storage = {
      list: async () => [...records.values()],
      save: async (app) => {
        records.set(app.id, app)
      },
      remove: async (id) => {
        records.delete(id)
      },
      hasFile: async (path, size) => files.get(path)?.length === size,
      hasFileHash: async (path, size, sha256, bundled) => {
        void bundled
        const data = files.get(path)
        return Boolean(data && data.length === size && (await hashBytes(data)) === sha256)
      },
      writeFile: async (path, data) => {
        files.set(path, data)
      },
      deleteFile: async (path) => {
        files.delete(path)
      },
    }
  })
  async function fixture(id: OfficialAppId = 'draw', mutate?: (app: OfficialAppPackage) => void) {
    const payload = new TextEncoder().encode('export default {}')
    const app: OfficialAppPackage = {
      schemaVersion: 1,
      shellVersion: 'test-shell',
      hostApiVersion: 1,
      appContentRevision: 1,
      id,
      entry: `/assets/${id}-123.js`,
      styles: [],
      files: [],
    }
    for (const path of [app.entry, '/assets/shared-123.js'])
      app.files.push({ path, size: payload.length, sha256: await hashBytes(payload) })
    mutate?.(app)
    if (app.assetMode === 'self-contained' && app.hostFiles === undefined)
      app.hostFiles = [{ ...app.files[1]! }]
    const ownedFiles = app.files
      .filter((file) => app.assetMode === 'self-contained' || !file.bundled)
      .map(({ path, size, sha256 }) => [path, size, sha256] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    app.appContentHash = await hashBytes(new TextEncoder().encode(JSON.stringify(ownedFiles)))
    const archive = Object.fromEntries(app.files.map((file) => [file.path.slice(1), payload]))
    archive['manifest.json'] = new TextEncoder().encode(JSON.stringify(app))
    const bytes = zipSync(archive)
    const descriptor = {
      shellVersion: 'test-shell',
      hostApiVersion: 1,
      assetMode: app.assetMode,
      appContentHash: app.appContentHash,
      appContentRevision: app.appContentRevision!,
      hostFiles: app.hostFiles ?? [],
      runtimeEntry: app.runtimeEntry,
      url: `/official-apps/test-shell/${id}.srlapp`,
      sha256: await hashBytes(bytes),
      downloadBytes: bytes.length,
      entry: app.entry,
    }
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('catalog.json')
        ? new Response(
            JSON.stringify({
              schemaVersion: 1,
              hostApiVersion: 1,
              apps: { [id]: [descriptor] },
            }),
          )
        : new Response(new Uint8Array(bytes).buffer),
    )
    const service = new OfficialAppService(
      storage,
      'test-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => Object.fromEntries(app.files.map((file) => [file.path, file])),
    )
    return { service, fetcher, app, bytes }
  }
  async function batchFixture(ids: OfficialAppId[]) {
    const packages = await Promise.all(ids.map((id) => fixture(id)))
    const apps = Object.assign(
      {},
      ...(await Promise.all(
        packages.map(
          async ({ fetcher }) =>
            (await (await fetcher('https://library.test/official-apps/catalog.json')).json()).apps,
        ),
      )),
    )
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('catalog.json'))
        return new Response(JSON.stringify({ schemaVersion: 1, hostApiVersion: 1, apps }))
      const pkg = packages.find(({ app }) => String(input).endsWith(`/${app.id}.srlapp`))!
      return new Response(new Uint8Array(pkg.bytes).buffer)
    })
    const service = new OfficialAppService(
      storage,
      'test-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
    )
    return { service, fetcher, packages }
  }

  it('downloads at most two packages together and commits files one APP at a time', async () => {
    const { service, fetcher, packages } = await batchFixture(['draw', 'stitch', 'chatReader'])
    const release = new Map<string, () => void>()
    const originalFetch = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, options) => {
      if (!String(input).endsWith('catalog.json')) {
        await new Promise<void>((resolve) => release.set(String(input), resolve))
      }
      return originalFetch(input, options)
    })
    let writing = 0
    let maximumWriting = 0
    const originalWrite = storage.writeFile
    storage.writeFile = async (...args) => {
      writing++
      maximumWriting = Math.max(maximumWriting, writing)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await originalWrite(...args)
      writing--
    }
    const installing = service.installMany(['draw', 'stitch', 'chatReader'])
    await vi.waitFor(() => expect(release.size).toBe(2))
    expect(records.size).toBe(0)
    release.get('https://library.test/official-apps/test-shell/draw.srlapp')!()
    await vi.waitFor(() => expect(release.size).toBe(3))
    for (const resolve of release.values()) resolve()
    expect(await installing).toEqual(packages.map(({ app }) => ({ id: app.id })))
    expect(maximumWriting).toBe(1)
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('catalog.json'))).toHaveLength(
      1,
    )
    expect(records.size).toBe(3)
  })

  it('reuses only shared file hashes proved within the batch and deduplicates selected APPs', async () => {
    const { service } = await batchFixture(['draw', 'stitch'])
    storage.hasFileHash = vi.fn(storage.hasFileHash)
    expect(await service.installMany(['draw', 'draw', 'stitch'])).toEqual([
      { id: 'draw' },
      { id: 'stitch' },
    ])
    expect(
      vi
        .mocked(storage.hasFileHash)
        .mock.calls.filter(([path]) => path === '/assets/shared-123.js'),
    ).toHaveLength(2)
    vi.mocked(storage.hasFileHash).mockClear()
    await service.installMany(['draw', 'stitch'])
    expect(
      vi
        .mocked(storage.hasFileHash)
        .mock.calls.filter(([path]) => path === '/assets/shared-123.js'),
    ).toHaveLength(1)
  })

  it('rolls back one failed installation, invalidates shared proof, and finishes other selected APPs', async () => {
    const { service } = await batchFixture(['draw', 'stitch'])
    const originalSave = storage.save
    storage.save = async (app) => {
      if (app.id === 'draw') throw new Error('quota')
      await originalSave(app)
    }
    const result = await service.installMany(['draw', 'stitch'])
    expect(result[0]?.error?.message).toBe('quota')
    expect(result[1]).toEqual({ id: 'stitch' })
    expect(records.has('draw')).toBe(false)
    expect((await service.getReadyPackage('stitch'))?.id).toBe('stitch')
    expect(files.has('/assets/draw-123.js')).toBe(false)
    expect(files.has('/assets/shared-123.js')).toBe(true)
  })
  it('reports real download bytes and rejects an APP in use before its package is fetched', async () => {
    const { service, fetcher, packages } = await batchFixture(['draw', 'stitch'])
    const request = navigator.locks.request.bind(navigator.locks)
    vi.spyOn(navigator.locks, 'request').mockImplementation(
      async (name, optionsOrAction, action) => {
        if (name === 'srl-official-app-use:draw') return action!(null as never)
        return request(name, optionsOrAction as never, action as never)
      },
    )
    const progress = vi.fn()
    const results = await service.installMany(['draw', 'stitch'], progress)
    expect(results[0]?.error?.message).toContain('其他页面正在使用')
    expect(results[1]).toEqual({ id: 'stitch' })
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/draw.srlapp'))).toBe(false)
    expect(progress).toHaveBeenCalledWith({
      id: 'stitch',
      stage: 'downloading',
      downloadedBytes: packages[1]!.bytes.length,
      totalBytes: packages[1]!.bytes.length,
    })
    expect(progress).toHaveBeenCalledWith({
      id: 'stitch',
      stage: 'installing',
      completedFiles: 2,
      totalFiles: 2,
    })
    expect(progress).toHaveBeenCalledWith({ id: 'stitch', stage: 'done' })
    expect(
      progress.mock.calls.some(([event]) => event.id === 'draw' && event.stage === 'done'),
    ).toBe(false)
  })
  it('reads only the requested installation during readiness checks', async () => {
    const { service } = await fixture()
    await service.install('draw')
    storage.get = vi.fn(async (id) => records.get(id))
    const list = vi.spyOn(storage, 'list')
    expect(await service.ready('draw')).toBe(true)
    expect(storage.get).toHaveBeenCalledExactlyOnceWith('draw')
    expect(list).not.toHaveBeenCalled()
  })

  it('installs verified program bytes, retains user data on uninstall, then reinstalls', async () => {
    const { service, fetcher } = await fixture()
    await service.install('draw')
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://library.test/official-apps/api-1/catalog.json',
    )
    expect(await service.ready('draw')).toBe(true)
    expect(records.get('draw')?.appContentRevision).toBe(1)
    expect(files.size).toBe(2)
    expect(await service.uninstall('draw', false)).toBeGreaterThan(0)
    expect(files.size).toBe(0)
    expect(records.size).toBe(0)
    expect(clearData).not.toHaveBeenCalled()
    expect(clearStyles).not.toHaveBeenCalled()
    await service.install('draw')
    expect(await service.ready('draw')).toBe(true)
  })

  it('rejects APP archives whose file count exceeds the bounded package limit', async () => {
    const { service } = await fixture('draw', (candidate) => {
      for (let index = 0; index < 254; index++)
        candidate.files.push({
          path: `/assets/extra-${index}.js`,
          size: 1,
          sha256: 'a'.repeat(64),
        })
    })

    await expect(service.install('draw')).rejects.toThrow('安装包文件数量超过限制')
    expect(records.size).toBe(0)
    expect(files.size).toBe(0)
  })

  it.each([129, 256])(
    'installs an official package with %i total entries including its manifest',
    async (total) => {
      const { service } = await fixture('draw', (candidate) => {
        for (let index = 0; index < total - 3; index++)
          candidate.files.push({ ...candidate.files[0]!, path: `/assets/extra-${index}.js` })
      })
      await service.install('draw')
      expect(await service.ready('draw')).toBe(true)
      expect(files.size).toBe(total - 1)
    },
  )

  it('rejects a second APP install instead of leaving it queued behind the active download', async () => {
    const { service, fetcher } = await fixture()
    const request = vi.fn(
      (
        name: string,
        optionsOrAction: unknown,
        action?: (lock: object | null) => Promise<unknown>,
      ) => {
        if (name === 'srl-official-app-download-active' && action) return action(null)
        return action ? action({}) : (optionsOrAction as () => Promise<unknown>)()
      },
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request,
      },
    })

    await expect(service.install('draw')).rejects.toThrow(
      '另一个内置 APP 正在下载或更新，请完成后再试',
    )
    expect(request).toHaveBeenCalledWith(
      'srl-official-app-download-active',
      { ifAvailable: true },
      expect.any(Function),
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not report an APP update for a newer shell when its owned package bytes are unchanged', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const installed = records.get('draw')!
    installed.shellVersion = 'srl-0.0.120-v278'
    records.set('draw', installed)
    await expect(service.availableUpdates()).resolves.toEqual({})
  })

  it('blocks an old shared runtime even when its cached bytes are intact', async () => {
    const { app, fetcher } = await fixture('draw', (candidate) => {
      candidate.files[1]!.bundled = true
    })
    files.set(app.entry, new TextEncoder().encode('export default {}'))
    files.set(app.files[1]!.path, new TextEncoder().encode('export default {}'))
    records.set('draw', { ...app, installedAt: Date.now() })
    const service = new OfficialAppService(
      storage,
      'newer-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => ({
        '/assets/shared-123.js': {
          size: app.files[1]!.size + 1,
          sha256: 'a'.repeat(64),
        },
      }),
    )

    await expect(service.ready('draw')).resolves.toBe(false)
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: { requiresAssetRepair: true, requiresHostUpdate: false },
    })
    expect(clearData).not.toHaveBeenCalled()
  })

  it('blocks a cached shared chunk absent from the currently running shell', async () => {
    const { app, fetcher } = await fixture('draw', (candidate) => {
      candidate.files[1]!.bundled = true
    })
    files.set(app.entry, new TextEncoder().encode('export default {}'))
    files.set(app.files[1]!.path, new TextEncoder().encode('export default {}'))
    records.set('draw', { ...app, installedAt: Date.now() })
    const service = new OfficialAppService(
      storage,
      'newer-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => ({}),
    )

    await expect(service.ready('draw')).resolves.toBe(false)
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: { requiresAssetRepair: true, requiresHostUpdate: false },
    })
  })

  it('announces a compatibility update only when the installed host API version is incompatible', async () => {
    const { service } = await fixture()
    await service.install('draw')
    records.set('draw', { ...records.get('draw')!, hostApiVersion: 0 })

    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: {
        currentVersion: '1',
        latestVersion: '1',
        requiresHostUpdate: true,
      },
    })
  })

  it('does not report an update when owned bytes change without an explicit revision bump', async () => {
    const { service, fetcher } = await fixture()
    await service.install('draw')
    const legacyInstalled = records.get('draw')!
    delete legacyInstalled.appContentRevision
    records.set('draw', legacyInstalled)
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = (await response.json()) as {
        apps: Record<string, Array<{ appContentHash: string; [key: string]: unknown }>>
      }
      catalog.apps.draw[0]!.appContentHash = 'a'.repeat(64)
      return new Response(JSON.stringify(catalog))
    })
    await expect(service.availableUpdates()).resolves.toEqual({})
  })

  it('reports an APP update when its explicit content revision increases', async () => {
    const { service, fetcher } = await fixture()
    await service.install('draw')
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = (await response.json()) as {
        apps: Record<string, Array<{ appContentRevision: number; [key: string]: unknown }>>
      }
      catalog.apps.draw[0]!.appContentRevision = 2
      catalog.apps.draw[0]!.shellVersion = 'srl-0.0.127-v287'
      return new Response(JSON.stringify(catalog))
    })
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: {
        currentVersion: '1',
        latestVersion: '2',
        latestShellVersion: 'srl-0.0.127-v287',
        requiresHostUpdate: false,
      },
    })
  })

  it('checks the committed installation when a download finishes during the catalog request', async () => {
    const { service, fetcher } = await fixture()
    await service.install('draw')
    const upgraded = await fixture('draw', (app) => {
      app.appContentRevision = 2
    })
    const catalog = await upgraded.fetcher('https://library.test/official-apps/api-1/catalog.json')
    let finishCatalog!: (response: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishCatalog = resolve
        }),
    )
    const checking = service.availableUpdates()
    await upgraded.service.install('draw')
    expect(records.get('draw')?.appContentRevision).toBe(2)
    finishCatalog(catalog)
    await expect(checking).resolves.toEqual({})
  })

  it('selects an older candidate when the newest package needs different shared shell files', async () => {
    const { service, fetcher } = await fixture()
    const original = fetcher.getMockImplementation()!
    const incompatible = {
      shellVersion: 'newer-shell',
      hostApiVersion: 1,
      hostFiles: [
        { path: '/assets/new-shared.js', size: 1, sha256: 'a'.repeat(64), bundled: true },
      ],
      url: '/official-apps/newer-shell/draw-new.srlapp',
      sha256: 'b'.repeat(64),
      downloadBytes: 1,
      installedBytes: 1,
      entry: '/assets/draw-new.js',
    }
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = (await response.json()) as {
        apps: Record<string, Array<typeof incompatible>>
      }
      catalog.apps.draw = [incompatible, ...catalog.apps.draw]
      return new Response(JSON.stringify(catalog))
    })
    await service.install('draw')
    const packageRequests = fetcher.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.endsWith('.srlapp'))
    expect(packageRequests).toEqual(['https://library.test/official-apps/test-shell/draw.srlapp'])
  })
  it('deletes styles only with a separate explicit choice, including an already uninstalled APP', async () => {
    const { service } = await fixture()
    await service.install('draw')
    await service.uninstall('draw', true)
    expect(clearStyles).not.toHaveBeenCalled()
    await service.uninstall('draw', true, true)
    expect(clearStyles).toHaveBeenCalledExactlyOnceWith('draw')
    await expect(service.uninstall('draw', false, true)).rejects.toThrow('同时选择')
  })
  it('clears a selected APP data without uninstalling its verified program files', async () => {
    const { service } = await fixture()
    await service.install('draw')
    await service.clearAppData('draw', true)
    expect(clearData).toHaveBeenCalledExactlyOnceWith('draw')
    expect(clearStyles).toHaveBeenCalledExactlyOnceWith('draw')
    expect(await service.ready('draw')).toBe(true)
    expect(files.size).toBe(2)
    expect(records.has('draw')).toBe(true)
  })
  it('refuses APP data cleanup while the APP is in use', async () => {
    const { service } = await fixture()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (
          _name: string,
          optionsOrAction: unknown,
          action?: (lock: object | null) => Promise<unknown>,
        ) => (action ? action(null) : (optionsOrAction as () => Promise<unknown>)()),
      },
    })
    await expect(service.clearAppData('draw')).rejects.toThrow('正在使用')
    expect(clearData).not.toHaveBeenCalled()
  })

  it('refuses to replace APP files while another page holds the use lock', async () => {
    const { service, fetcher } = await fixture()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (
          name: string,
          optionsOrAction: unknown,
          action?: (lock: object | null) => Promise<unknown>,
        ) => {
          if (name.startsWith('srl-official-app-use:')) return action?.(null)
          return action ? action({}) : (optionsOrAction as () => Promise<unknown>)()
        },
      },
    })
    await expect(service.install('draw')).rejects.toThrow('请关闭后再更新')
    expect(fetcher).not.toHaveBeenCalled()
    expect(files.size).toBe(0)
    expect(records.size).toBe(0)
  })

  it('keeps shared files until the last owner is removed and clears only the selected app data', async () => {
    const draw = await fixture('draw')
    const stitch = await fixture('stitch')
    await draw.service.install('draw')
    await stitch.service.install('stitch')
    await draw.service.uninstall('draw', true)
    expect(clearData).toHaveBeenCalledExactlyOnceWith('draw')
    expect(files.has('/assets/draw-123.js')).toBe(false)
    expect(await stitch.service.ready('stitch')).toBe(true)
    await stitch.service.uninstall('stitch', false)
    expect(files.size).toBe(0)
  })
  it('rejects corrupt download bytes before writing anything', async () => {
    const { service, fetcher } = await fixture()
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (String(input).endsWith('.srlapp')) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        bytes[0] ^= 1
        return new Response(bytes)
      }
      return response
    })
    await expect(service.install('draw')).rejects.toThrow('校验失败')
    expect(files.size).toBe(0)
  })
  it.each(['wrong-host-api', 'unsafe-path', 'bad-file-hash'])(
    'rejects %s without touching a previous installation',
    async (reason) => {
      const { service } = await fixture('draw', (app) => {
        if (reason === 'wrong-host-api') app.hostApiVersion = 99
        if (reason === 'unsafe-path') app.files[1]!.path = '/assets/../escape.js'
        if (reason === 'bad-file-hash') app.files[1]!.sha256 = 'f'.repeat(64)
      })
      files.set('/assets/existing.js', new Uint8Array([1]))
      await expect(service.install('draw')).rejects.toThrow()
      expect([...files.keys()]).toEqual(['/assets/existing.js'])
      expect(records.size).toBe(0)
    },
  )
  it('rolls back newly staged files on storage failure', async () => {
    const { service, app } = await fixture('draw', (candidate) => {
      candidate.assetMode = 'self-contained'
      candidate.files[1]!.bundled = true
    })
    const deleted: Array<[string, boolean | undefined]> = []
    storage.deleteFile = async (path, bundled) => {
      deleted.push([path, bundled])
      files.delete(path)
    }
    storage.save = async () => {
      throw new Error('quota')
    }
    await expect(service.install('draw')).rejects.toThrow('quota')
    expect(files.size).toBe(0)
    expect(records.size).toBe(0)
    expect(deleted).toContainEqual([app.files[1]!.path, false])
  })
  it('keeps the installed version usable when staging a newer package fails', async () => {
    const older = await fixture()
    await older.service.install('draw')
    const oldEntry = records.get('draw')!.entry
    const newer = await fixture('draw', (app) => {
      app.shellVersion = 'new-shell'
      app.entry = '/assets/draw-456.js'
      app.files[0]!.path = app.entry
      app.files[1]!.path = '/assets/shared-456.js'
    })
    const writeFile = storage.writeFile.bind(storage)
    const deleteFile = storage.deleteFile.bind(storage)
    let failedStageCleanup = false
    storage.writeFile = async (path, data) => {
      if (path === '/assets/shared-456.js') throw new Error('quota')
      await writeFile(path, data)
    }
    storage.deleteFile = async (path, bundled) => {
      if (path === '/assets/draw-456.js' && !failedStageCleanup) {
        failedStageCleanup = true
        throw new Error('temporary filesystem failure')
      }
      await deleteFile(path, bundled)
    }

    await expect(newer.service.install('draw')).rejects.toThrow('quota')

    expect(records.get('draw')?.entry).toBe(oldEntry)
    expect(await older.service.ready('draw')).toBe(true)
    expect(records.get('draw')?.pendingCleanupFiles?.map((file) => file.path)).toContain(
      '/assets/draw-456.js',
    )
    expect(files.has('/assets/draw-456.js')).toBe(true)
    expect(files.has('/assets/draw-123.js')).toBe(true)
  })
  it('repairs same-sized corrupted files during update without hashing on readiness checks', async () => {
    const { service, app } = await fixture()
    await service.install('draw')
    const entryBytes = files.get(app.entry)!
    files.set(app.entry, new Uint8Array(entryBytes.length).fill(0))

    // Readiness stays a cheap existence/size check; hashing happens only on install/update.
    expect(await service.ready('draw')).toBe(true)
    await service.install('draw')
    expect(await hashBytes(files.get(app.entry)!)).toBe(app.files[0]!.sha256)
  })
  it('persists and retries old-file cleanup after the new version is committed', async () => {
    const older = await fixture()
    await older.service.install('draw')
    const oldEntry = records.get('draw')!.entry
    const newer = await fixture('draw', (app) => {
      app.shellVersion = 'new-shell'
      app.entry = '/assets/draw-456.js'
      app.files[0]!.path = app.entry
      app.files[1]!.path = '/assets/shared-456.js'
    })
    const deleteFile = storage.deleteFile.bind(storage)
    storage.deleteFile = async (path, bundled) => {
      if (path === oldEntry) throw new Error('temporary filesystem failure')
      await deleteFile(path, bundled)
    }

    await newer.service.install('draw')
    expect(records.get('draw')?.entry).toBe('/assets/draw-456.js')
    expect(records.get('draw')?.pendingCleanupFiles?.map((file) => file.path)).toContain(oldEntry)
    expect(files.has(oldEntry)).toBe(true)

    storage.deleteFile = deleteFile
    await newer.service.install('draw')
    expect(records.get('draw')?.pendingCleanupFiles).toBeUndefined()
    expect(files.has(oldEntry)).toBe(false)
  })
  it('keeps an intact installed APP ready when only the shell version changes', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const installed = records.get('draw')!
    records.set('draw', { ...installed, shellVersion: 'previous-shell' })
    expect(await service.ready('draw')).toBe(true)
  })

  it('keeps an installed entry ready across a shell rebuild when its host API and files remain available', async () => {
    const { service, fetcher } = await fixture()
    await service.install('draw')
    fetcher.mockClear()
    const upgradedShell = new OfficialAppService(
      storage,
      'next-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
    )
    expect(await upgradedShell.ready('draw')).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires an APP update when its host API changes', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const incompatibleShell = new OfficialAppService(
      storage,
      'next-shell',
      fetch,
      'https://library.test',
      clearData,
      clearStyles,
      2,
    )
    expect(await incompatibleShell.ready('draw')).toBe(false)
  })

  it('rejects legacy APPs when the current shell no longer owns their shared chunk', async () => {
    const { app } = await fixture()
    records.set('draw', {
      ...app,
      installedAt: Date.now(),
      files: app.files.map((file, index) => ({ ...file, bundled: index > 0 })),
    })
    files.set(app.entry, new TextEncoder().encode('export default {}'))
    files.set(app.files[1]!.path, new TextEncoder().encode('export default {}'))
    delete records.get('draw')!.appContentHash
    const upgradedShell = new OfficialAppService(
      storage,
      'next-shell',
      fetch,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => ({}),
    )
    expect(await upgradedShell.ready('draw')).toBe(false)
  })

  it('rejects a stale cached chunk whose bytes do not match the installed manifest', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const installed = records.get('draw')!
    const shared = installed.files[1]!
    shared.bundled = true
    delete installed.appContentHash
    records.set('draw', installed)
    files.set(shared.path, new Uint8Array(shared.size).fill(0))
    const upgradedShell = new OfficialAppService(
      storage,
      'next-shell',
      fetch,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => ({
        [shared.path]: { size: shared.size, sha256: 'a'.repeat(64) },
      }),
    )
    expect(await upgradedShell.ready('draw')).toBe(false)
  })

  it('uses current shell dependencies when their local APP copy is missing', async () => {
    const { service } = await fixture()
    await service.install('draw')
    const installed = records.get('draw')!
    delete installed.appContentHash
    installed.files[1]!.bundled = true
    records.set('draw', installed)
    files.delete(installed.files[1]!.path)
    const upgradedShell = new OfficialAppService(
      storage,
      'next-shell',
      fetch,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => ({}),
    )
    expect(await upgradedShell.ready('draw')).toBe(false)
    expect(installed.hostApiVersion).toBe(1)
    await expect(service.ready('draw')).resolves.toBe(true)
    await expect(service.availableUpdates()).resolves.toEqual({})
  })

  it('stores every self-contained APP asset locally, including files shared with the shell', async () => {
    const { app, service } = await fixture('draw', (candidate) => {
      candidate.assetMode = 'self-contained'
      candidate.files[1]!.bundled = true
    })

    await service.install('draw')

    const installed = records.get('draw')!
    expect(installed.assetMode).toBe('self-contained')
    expect(installed.files.every((file) => file.bundled === false)).toBe(true)
    expect(files.size).toBe(app.files.length)
    expect(await service.ready('draw')).toBe(true)
  })

  it('detects missing or truncated installed files instead of reporting ready', async () => {
    const { service } = await fixture()
    await service.install('draw')
    files.set('/assets/draw-123.js', new Uint8Array([1]))
    expect(await service.ready('draw')).toBe(false)
    await service.install('draw')
    expect(await service.ready('draw')).toBe(true)
  })

  it('uses bulk readiness checks when available without bypassing a failed result', async () => {
    const { service } = await fixture()
    await service.install('draw')
    storage.hasFiles = vi.fn(async () => true)
    const individual = vi.spyOn(storage, 'hasFile')
    expect(await service.ready('draw')).toBe(true)
    expect(storage.hasFiles).toHaveBeenCalledWith(records.get('draw')!.files)
    expect(individual).not.toHaveBeenCalled()
    vi.mocked(storage.hasFiles).mockResolvedValueOnce(false)
    expect(await service.ready('draw')).toBe(false)
  })

  it('keeps self-contained APPs usable across shell versions only with the same Vue runtime', async () => {
    const { app, fetcher } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
      app.files[1]!.bundled = true
    })
    const originalFetch = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = await response.json()
      catalog.apps.draw.push({
        ...catalog.apps.draw[0],
        shellVersion: 'srl-older-shell',
        appContentRevision: 1,
        assetMode: 'host',
        hostFiles: [{ path: '/assets/old-shared.js', size: 10, sha256: 'a'.repeat(64) }],
      })
      return new Response(JSON.stringify(catalog))
    })
    const getShellFiles = vi.fn(async () =>
      Object.fromEntries(app.hostFiles!.map((file) => [file.path, file])),
    )
    const service = new OfficialAppService(
      storage,
      'rebuilt-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      getShellFiles,
    )

    await service.install('draw')
    fetcher.mockClear()
    await expect(service.ready('draw')).resolves.toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    await expect(service.availableUpdates()).resolves.toEqual({})
    expect(getShellFiles).toHaveBeenCalled()

    files.delete(records.get('draw')!.entry)
    await expect(service.ready('draw')).resolves.toBe(false)
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: { requiresAssetRepair: true, requiresHostUpdate: false },
    })
    await service.install('draw')
    await expect(service.ready('draw')).resolves.toBe(true)
    expect(getShellFiles).toHaveBeenCalled()
  })

  it('blocks a self-contained APP with another Vue runtime without clearing its data', async () => {
    const { service, app } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
    })
    await service.install('draw')
    const runtime = records.get('draw')!.hostFiles![0]!
    runtime.path = '/assets/old-vue.js'
    records.get('draw')!.files[1]!.path = runtime.path
    // The package's own integrity remains valid; only runtime identity is wrong.
    delete records.get('draw')!.appContentHash
    files.set(runtime.path, files.get(app.files[1]!.path)!)
    await expect(service.ready('draw')).resolves.toBe(false)
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: { requiresAssetRepair: true, currentVersion: '1', latestVersion: '1' },
    })
    expect(clearData).not.toHaveBeenCalled()
  })

  it('repairs legacy self-contained records that cannot prove shared runtime identity', async () => {
    const { service } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
    })
    await service.install('draw')
    delete records.get('draw')!.hostFiles
    await expect(service.ready('draw')).resolves.toBe(false)
    await service.install('draw')
    await expect(service.ready('draw')).resolves.toBe(true)
    expect(clearData).not.toHaveBeenCalled()
    expect(clearStyles).not.toHaveBeenCalled()
  })

  it('opens offline after validating shared services against the local shell manifest', async () => {
    const { app, fetcher } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
      app.runtimeEntry = app.files[1]!.path
    })
    const getShellFiles = vi.fn(async () =>
      Object.fromEntries(app.files.map((file) => [file.path, file])),
    )
    const service = new OfficialAppService(
      storage,
      'rebuilt-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      getShellFiles,
      app.runtimeEntry,
    )
    await service.install('draw')
    fetcher.mockClear()
    await expect(service.ready('draw')).resolves.toBe(true)
    expect(getShellFiles).toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the installed APP across shell releases without downloading a rebuilt package', async () => {
    const { app, fetcher } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
      app.runtimeEntry = app.files[1]!.path
    })
    const oldShell = new OfficialAppService(
      storage,
      'shell-before',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => Object.fromEntries(app.files.map((file) => [file.path, file])),
      app.runtimeEntry,
    )
    await oldShell.install('draw')
    const installed = records.get('draw')!
    const originalFetcher = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await originalFetcher(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = await response.json()
      catalog.apps.draw.unshift({
        ...catalog.apps.draw[0],
        shellVersion: 'shell-after',
        appContentHash: 'f'.repeat(64),
        url: '/official-apps/shell-after/rebuilt.srlapp',
      })
      return new Response(JSON.stringify(catalog))
    })
    fetcher.mockClear()
    const newShell = new OfficialAppService(
      storage,
      'shell-after',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => Object.fromEntries(app.files.map((file) => [file.path, file])),
      app.runtimeEntry,
    )
    await expect(newShell.ready('draw')).resolves.toBe(true)
    await expect(newShell.availableUpdates()).resolves.toEqual({})
    expect(fetcher.mock.calls.every(([input]) => String(input).endsWith('catalog.json'))).toBe(true)
    expect(records.get('draw')).toBe(installed)
    expect(clearData).not.toHaveBeenCalled()
    expect(clearStyles).not.toHaveBeenCalled()
  })

  it.each(['host', 'self-contained'] as const)(
    'rejects intact %s APP bytes from a different renderer before loading components',
    async (assetMode) => {
      const { app, fetcher } = await fixture('draw', (app) => {
        app.assetMode = assetMode
        app.runtimeEntry = app.files[1]!.path
        app.hostFiles = [{ ...app.files[1]! }]
      })
      const service = new OfficialAppService(
        storage,
        'current-shell',
        fetcher,
        'https://library.test',
        clearData,
        clearStyles,
        1,
        async () => Object.fromEntries(app.files.map((file) => [file.path, file])),
        app.runtimeEntry,
      )
      await service.install('draw')
      const installed = records.get('draw')!
      for (const file of installed.files)
        expect(await storage.hasFile(file.path, file.size)).toBe(true)
      installed.runtimeEntry = '/assets/old-vue.js'
      installed.hostFiles = [{ ...installed.files[1]!, path: installed.runtimeEntry }]
      installed.files[1] = installed.hostFiles[0]!
      files.set(installed.runtimeEntry, new TextEncoder().encode('export default {}'))
      delete installed.appContentHash
      await expect(service.ready('draw')).resolves.toBe(false)
      await expect(service.availableUpdates()).resolves.toMatchObject({
        draw: {
          requiresAssetRepair: true,
          requiresHostUpdate: false,
          currentVersion: '1',
          latestVersion: '1',
        },
      })
      await service.install('draw')
      await expect(service.ready('draw')).resolves.toBe(true)
      expect(clearData).not.toHaveBeenCalled()
      expect(clearStyles).not.toHaveBeenCalled()
    },
  )

  it('does not select a newer APP backed by another Vue renderer', async () => {
    const { app, fetcher } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
      app.runtimeEntry = app.files[1]!.path
    })
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (!String(input).endsWith('catalog.json')) return response
      const catalog = await response.json()
      catalog.apps.draw.unshift({
        ...catalog.apps.draw[0],
        runtimeEntry: '/assets/other-vue.js',
        appContentRevision: 99,
      })
      return new Response(JSON.stringify(catalog))
    })
    const service = new OfficialAppService(
      storage,
      'current-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => Object.fromEntries(app.files.map((file) => [file.path, file])),
      app.runtimeEntry,
    )
    await service.install('draw')
    expect(records.get('draw')!.appContentRevision).toBe(1)
    await expect(service.availableUpdates()).resolves.toEqual({})
  })

  it('rejects old database/service modules even when the Vue renderer is unchanged', async () => {
    const { app, fetcher } = await fixture('draw', (candidate) => {
      candidate.assetMode = 'self-contained'
      candidate.runtimeEntry = candidate.files[1]!.path
      candidate.hostFiles = candidate.files.map((file) => ({ ...file }))
    })
    const shellFiles = Object.fromEntries(app.files.map((file) => [file.path, { ...file }]))
    const service = new OfficialAppService(
      storage,
      'current-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      async () => shellFiles,
      app.runtimeEntry,
    )
    await service.install('draw')
    shellFiles[app.entry] = { ...shellFiles[app.entry]!, sha256: 'f'.repeat(64) }
    await expect(service.ready('draw')).resolves.toBe(false)
    expect(records.get('draw')).toBeDefined()
    expect(clearData).not.toHaveBeenCalled()
    await expect(service.install('draw')).rejects.toThrow()
  })

  it('reports a host incompatibility even when a newer content revision is also available', async () => {
    const { service } = await fixture('draw', (app) => {
      app.assetMode = 'self-contained'
      app.appContentRevision = 2
    })
    await service.install('draw')
    records.set('draw', {
      ...records.get('draw')!,
      appContentRevision: 1,
      hostApiVersion: 0,
    })
    await expect(service.availableUpdates()).resolves.toMatchObject({
      draw: { currentVersion: '1', latestVersion: '2', requiresHostUpdate: true },
    })
    await expect(service.ready('draw')).resolves.toBe(false)
  })

  it('does not infer legacy runtime compatibility from cached bytes when evidence is unavailable', async () => {
    const { app, fetcher } = await fixture('draw', (candidate) => {
      candidate.files[1]!.bundled = true
    })
    records.set('draw', { ...app, installedAt: Date.now() })
    for (const file of app.files)
      files.set(file.path, new TextEncoder().encode('export default {}'))
    const getShellFiles = vi.fn(async () => {
      throw new Error('Shell manifest unavailable offline')
    })
    const service = new OfficialAppService(
      storage,
      'next-shell',
      fetcher,
      'https://library.test',
      clearData,
      clearStyles,
      1,
      getShellFiles,
    )
    await expect(service.ready('draw')).rejects.toThrow('Shell manifest unavailable offline')
    expect(getShellFiles).toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
