/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  allowDiscordAttachmentRetry,
  clearShareTargetQuery,
  downloadSharedDiscordAttachment,
  shouldAutoResumeSharedImport,
  shouldShowSharedImportRouteChoices,
  takeSharedFileBatch,
  takeSharedFileBatches,
  cloudWebResourceBatch,
  takeSharedFiles,
} from './ShareTargetIntake'
import { nativeFileSource, nativeFileSize } from '../core/NativeFileSource'
import { getNativePreparedImport } from '../services/NativePreparedImport'

const native = vi.hoisted(() => ({
  enabled: false,
  getPendingShare: vi.fn(),
  cleanupPendingShare: vi.fn(),
  setPendingShareRoute: vi.fn(),
  downloadDiscordAttachment: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.enabled,
    convertFileSrc: (uri: string) => uri,
  },
  registerPlugin: () => native,
}))

type StoredEntry = Response

it('hides route choices whenever a shared batch already has a saved route', () => {
  expect(shouldShowSharedImportRouteChoices({ route: 'resource' })).toBe(false)
  expect(shouldShowSharedImportRouteChoices({})).toBe(true)
})

it('keeps independent downloaded attachments and acknowledgements separate, preserving native sizes', async () => {
  native.enabled = true
  vi.stubGlobal('caches', undefined)
  native.getPendingShare.mockResolvedValue({
    files: [
      {
        name: 'first.json',
        type: 'application/json',
        uri: 'file:///first.json',
        size: 4096,
        cleanupToken: 'staged-first',
        discordSourceToken: 'source-first',
      },
      {
        name: 'second.json',
        type: 'application/json',
        uri: 'file:///second.json',
        size: 8192,
        cleanupToken: 'staged-second',
        discordSourceToken: 'source-second',
      },
    ],
  })
  const batches = await takeSharedFileBatches()
  expect(batches).toHaveLength(2)
  expect(batches[0]?.nativeShareTokens).toEqual(['staged-first', 'source-first'])
  expect(nativeFileSize(batches[0]!.files[0]!)).toBe(4096)
  expect(nativeFileSize(batches[1]!.files[0]!)).toBe(8192)
  await batches[0]!.acknowledge()
  expect(native.cleanupPendingShare).toHaveBeenCalledWith({ tokens: ['staged-first'] })
  expect(native.cleanupPendingShare).not.toHaveBeenCalledWith({ tokens: ['staged-second'] })
  await batches[1]!.acknowledge()
})

it('hydrates active native downloads even when no new files are ready', async () => {
  native.enabled = true
  vi.stubGlobal('caches', undefined)
  native.getPendingShare.mockResolvedValue({
    files: [],
    downloads: [{ token: 'active-token', workId: 'work', name: 'pending.json' }],
  })
  const hydrate = vi.fn()
  expect(await takeSharedFileBatches(hydrate)).toEqual([])
  expect(hydrate).toHaveBeenCalledWith({
    token: 'active-token',
    workId: 'work',
    name: 'pending.json',
  })
})

function createFakeCaches(initial: Record<string, Record<string, StoredEntry>>) {
  const stores = new Map<string, Map<string, StoredEntry>>(
    Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))]),
  )
  return {
    keys: async () => Array.from(stores.keys()),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        match: async (key: string) => store.get(key),
        put: async (key: string, value: StoredEntry) => void store.set(key, value),
        delete: async (key: string) => store.delete(key),
      }
    },
    delete: async (name: string) => stores.delete(name),
    has: (name: string) => stores.has(name),
  }
}

it('keeps paired cloud downloads out of the ordinary share queue', async () => {
  native.enabled = true
  vi.stubGlobal('caches', undefined)
  native.getPendingShare.mockResolvedValue({
    files: [
      {
        name: 'cloud.json',
        type: 'application/json',
        uri: 'file:///cloud.json',
        cloudLibraryId: 'library-1',
      },
    ],
    discordUrls: [
      {
        name: 'cloud.json',
        cleanupToken: 'cloud-token',
        discordUrl: 'https://cdn.discordapp.com/a',
        cloudLibraryId: 'library-1',
      },
    ],
  })
  expect(await takeSharedFileBatches()).toEqual([])
})

it('retains Web encrypted-import aliases for cloud replay and cleans them only after confirmation', async () => {
  const file = new File(['{}'], 'secret.json')
  const id = 'cloud-checkpoint-test'
  const batch = cloudWebResourceBatch(file, id)
  await batch.markImportStarted?.()
  await batch.markImportItemCompleted?.('b'.repeat(64), 'a'.repeat(64))
  const resumed = cloudWebResourceBatch(file, id)
  expect(resumed.completedImportAliases?.['a'.repeat(64)]).toBe('b'.repeat(64))
  expect(resumed.completedContentHashes).toEqual(expect.arrayContaining(['b'.repeat(64)]))
  await resumed.acknowledge()
  expect(cloudWebResourceBatch(file, id).completedImportAliases).toEqual({})
})

afterEach(() => {
  vi.unstubAllGlobals()
  native.enabled = false
  vi.clearAllMocks()
})

describe('native pending intake', () => {
  it('复用 Android 原生解析结果，不要求前台重复读取原件解析', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const parsed = {
      type: 'characterCard',
      name: '原生解析角色卡',
      description: 'description',
      tags: ['tag'],
      metadata: {
        card: { name: '原生解析角色卡' },
        cardContentHash: 'native-full-hash',
        cardCoreHash: 'native-core-hash',
        cardFingerprintVersion: 4,
      },
    }
    native.getPendingShare.mockResolvedValue({
      files: [
        {
          name: 'character.json',
          type: 'application/json',
          uri: 'file:///character.json',
          size: 100,
          cleanupToken: 'native-card-result',
          route: 'resource',
          nativeCharacterCardResult: {
            state: 'parsed',
            parsedResourceUri: 'file:///character.character-card.json',
          },
        },
      ],
    })
    const fetchFile = vi.fn().mockResolvedValue({ ok: true, json: async () => parsed })
    vi.stubGlobal('fetch', fetchFile)

    const batch = await takeSharedFileBatch()
    const prepared = getNativePreparedImport(batch.files[0]!)
    expect(prepared?.parsed).toEqual(parsed)
    expect(prepared).toEqual({ parsed })
    expect(fetchFile).toHaveBeenCalledTimes(1)
  })

  it('回前台和重复 ready 不重复投递；确认导入前仍保留原件', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const shared = {
      name: 'backup.zip',
      type: 'application/zip',
      uri: 'file:///backup.zip',
      cleanupToken: 'resume-test',
      route: 'libraryBackup',
    }
    native.getPendingShare.mockResolvedValue({ files: [shared] })
    const fetchFile = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['zip']) })
    vi.stubGlobal('fetch', fetchFile)
    const batch = await takeSharedFileBatch()
    expect(batch.files).toHaveLength(1)
    expect(batch.route).toBe('libraryBackup')
    expect((await takeSharedFileBatch()).files).toEqual([])
    expect((await takeSharedFileBatch()).files).toEqual([])
    expect(fetchFile).not.toHaveBeenCalled()
    expect(batch.files[0]?.size).toBe(0)
    expect(nativeFileSource(batch.files[0]!)).toBe('file:///backup.zip')
    expect(native.cleanupPendingShare).not.toHaveBeenCalled()
    await batch.setRoute?.('libraryBackup')
    expect(native.setPendingShareRoute).toHaveBeenCalledWith({
      tokens: ['resume-test'],
      route: 'libraryBackup',
    })
    expect(localStorage.getItem('srl.shared-import-route.v1.resume-test')).toContain(
      'libraryBackup',
    )
    // 文件同名不能作为身份：新分享有自己的 token，仍须接收。
    native.getPendingShare.mockResolvedValue({
      files: [shared, { ...shared, cleanupToken: 'new-test' }],
    })
    const next = await takeSharedFileBatch()
    expect(next.files).toHaveLength(1)
    await batch.acknowledge()
    await next.acknowledge()
    expect(native.cleanupPendingShare).toHaveBeenCalledWith({ tokens: ['resume-test'] })
    expect(native.cleanupPendingShare).toHaveBeenCalledWith({ tokens: ['new-test'] })
  })

  it('旧 APK 没有原生用途持久化时，页面重建后仍恢复已选用途', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const shared = {
      name: 'backup.zip',
      type: 'application/zip',
      uri: 'file:///backup.zip',
      cleanupToken: 'legacy-route-resume-test',
    }
    native.getPendingShare.mockResolvedValue({ files: [shared] })
    native.setPendingShareRoute.mockRejectedValueOnce(
      Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }),
    )
    const first = await takeSharedFileBatch()
    await first.setRoute?.('libraryBackup')
    expect(localStorage.getItem('srl.shared-import-route.v1.legacy-route-resume-test')).toContain(
      'libraryBackup',
    )

    // A WebView recreation creates a fresh module-level delivered-token set.
    vi.resetModules()
    const { takeSharedFileBatch: takeAfterReload } = await import('./ShareTargetIntake')
    const resumed = await takeAfterReload()
    expect(resumed.route).toBe('libraryBackup')
    expect(resumed.routeWasPersisted).toBe(true)
    await resumed.acknowledge()
    expect(localStorage.getItem('srl.shared-import-route.v1.legacy-route-resume-test')).toBeNull()
  })

  it('Android 原生暂存元数据恢复用途时不依赖 WebView localStorage', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const token = 'native-route-resume-test'
    const shared = {
      name: 'backup.zip',
      type: 'application/zip',
      uri: 'file:///backup.zip',
      cleanupToken: token,
    }
    native.getPendingShare.mockResolvedValue({ files: [shared] })
    const first = await takeSharedFileBatch()
    await first.setRoute?.('libraryBackup')
    expect(native.setPendingShareRoute).toHaveBeenCalledWith({
      tokens: [token],
      route: 'libraryBackup',
    })
    localStorage.removeItem(`srl.shared-import-route.v1.${token}`)

    native.getPendingShare.mockResolvedValue({
      files: [{ ...shared, route: 'libraryBackup' }],
    })
    vi.resetModules()
    const { takeSharedFileBatch: takeAfterReload } = await import('./ShareTargetIntake')
    const resumed = await takeAfterReload()
    expect(resumed.route).toBe('libraryBackup')
    expect(resumed.routeWasPersisted).toBe(true)
    await resumed.acknowledge()
  })

  it('导入进程重启后标记中断批次，要求用户确认后再重放并在确认清理后解除标记', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const token = 'interrupted-import-test'
    const shared = {
      name: 'resource.json',
      type: 'application/json',
      uri: 'file:///resource.json',
      cleanupToken: token,
      route: 'resource',
    }
    native.getPendingShare.mockResolvedValue({ files: [shared] })
    const first = await takeSharedFileBatch()
    expect(first.interrupted).toBe(false)
    expect(shouldAutoResumeSharedImport(first)).toBe(true)
    await first.markImportStarted?.()
    await first.markImportItemCompleted?.('a'.repeat(64))
    await first.markImportItemCompleted?.('a'.repeat(64), 'b'.repeat(64))

    vi.resetModules()
    const { takeSharedFileBatch: takeAfterRestart } = await import('./ShareTargetIntake')
    const resumed = await takeAfterRestart()
    expect(resumed.route).toBe('resource')
    expect(resumed.interrupted).toBe(true)
    expect(resumed.completedContentHashes).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(resumed.completedImportAliases).toEqual({ ['b'.repeat(64)]: 'a'.repeat(64) })
    expect(shouldAutoResumeSharedImport(resumed)).toBe(false)
    await resumed.markImportStarted?.()
    expect(localStorage.getItem(`srl.shared-import-attempt.v1.${token}`)).not.toContain(
      'a'.repeat(64),
    )
    expect(localStorage.getItem(`srl.shared-import-item.v1.${token}.${'a'.repeat(64)}`)).toBe('1')
    await resumed.acknowledge()
    expect(resumed.interrupted).toBe(true)
    expect(localStorage.getItem('srl.shared-import-attempt.v1.interrupted-import-test')).toBeNull()
    expect(localStorage.getItem(`srl.shared-import-item.v1.${token}.${'a'.repeat(64)}`)).toBeNull()
    expect(localStorage.getItem(`srl.shared-import-item.v1.${token}.${'b'.repeat(64)}`)).toBeNull()
  })

  it('资源 ZIP 分享保持原生暂存，不在 intake 读取 ZIP Blob', async () => {
    native.enabled = true
    native.getPendingShare.mockResolvedValue({
      files: [
        {
          name: 'retry.zip',
          type: 'application/zip',
          uri: 'file:///retry.zip',
          cleanupToken: 'retry-test',
          route: 'resource',
        },
      ],
    })
    const fetchFile = vi.fn()
    vi.stubGlobal('fetch', fetchFile)
    const batch = await takeSharedFileBatch()
    expect(batch.files).toHaveLength(1)
    expect(batch.files[0]?.size).toBe(0)
    expect(nativeFileSource(batch.files[0]!)).toBe('file:///retry.zip')
    expect(fetchFile).not.toHaveBeenCalled()
    await batch.acknowledge()
  })

  it('URL 直传只显示附件信息，用户确认后才调用原生下载', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const attachment = {
      name: '角色卡.png',
      type: 'application/octet-stream',
      cleanupToken: 'discord-url-12345678-1234-1234-1234-123456789012',
      discordUrl:
        'https://cdn.discordapp.com/attachments/123/456/%E8%A7%92%E8%89%B2%E5%8D%A1.png?ex=abc&hm=def',
    }
    native.getPendingShare.mockResolvedValue({
      files: [
        {
          name: 'pending.json',
          type: 'application/json',
          uri: 'file:///pending.json',
          cleanupToken: 'unrelated-file',
        },
      ],
      discordUrls: [attachment],
    })
    const fetchFile = vi.fn()
    vi.stubGlobal('fetch', fetchFile)

    const batch = await takeSharedFileBatch()
    expect(batch.files).toEqual([])
    expect(batch.discordAttachment).toEqual(attachment)
    expect(fetchFile).not.toHaveBeenCalled()
    await downloadSharedDiscordAttachment(attachment)
    expect(native.downloadDiscordAttachment).toHaveBeenCalledWith({
      token: attachment.cleanupToken,
    })
    expect(native.cleanupPendingShare).not.toHaveBeenCalled()
  })

  it('失败后重投递同一 URL 分享，取消时按 token 清理', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const attachment = {
      name: 'character.json',
      type: 'application/octet-stream',
      cleanupToken: 'discord-url-12345678-1234-1234-1234-123456789013',
      discordUrl: 'https://cdn.discordapp.com/attachments/123/456/character.json?ex=abc&hm=def',
    }
    native.getPendingShare.mockResolvedValue({
      files: [
        {
          name: 'pending.json',
          type: 'application/json',
          uri: 'file:///pending.json',
          cleanupToken: 'unrelated-file',
        },
      ],
      discordUrls: [attachment],
    })
    const batch = await takeSharedFileBatch()
    expect((await takeSharedFileBatch()).discordAttachment).toBeUndefined()
    allowDiscordAttachmentRetry(attachment.cleanupToken)
    const retry = await takeSharedFileBatch()
    expect(retry.discordAttachment).toEqual(attachment)
    expect(retry.files).toEqual([])
    await batch.acknowledge()
    await retry.acknowledge()
    expect(native.cleanupPendingShare.mock.calls).toEqual([
      [{ tokens: [attachment.cleanupToken] }],
      [{ tokens: [attachment.cleanupToken] }],
    ])
  })

  it('200 条链接只读一次原生快照，全部进入独立批次并保留普通文件与逐项取消边界', async () => {
    native.enabled = true
    vi.stubGlobal('caches', undefined)
    const attachments = Array.from({ length: 200 }, (_, index) => ({
      name: `${index}.json`,
      type: 'application/json',
      cleanupToken: `discord-url-snapshot-${index}`,
      discordUrl: `https://cdn.discordapp.com/attachments/1/${index}/card.json?ex=abc&hm=${index}`,
    }))
    native.getPendingShare.mockResolvedValue({
      files: [
        {
          name: 'other.json',
          type: 'application/json',
          uri: 'file:///other.json',
          cleanupToken: 'snapshot-file',
        },
      ],
      discordUrls: attachments,
    })
    const batches = await takeSharedFileBatches()
    expect(native.getPendingShare).toHaveBeenCalledTimes(1)
    expect(batches).toHaveLength(200)
    expect(batches.slice(0, 200).map((batch) => batch.discordAttachment)).toEqual(attachments)
    const fileBatches = await takeSharedFileBatches()
    expect(fileBatches[0]?.files[0]?.name).toBe('other.json')
    expect(native.getPendingShare).toHaveBeenCalledTimes(2)
    await batches[99]!.acknowledge()
    expect(native.cleanupPendingShare).toHaveBeenCalledExactlyOnceWith({
      tokens: ['discord-url-snapshot-99'],
    })
    // Retained URLs/files were delivered once; a repeated ready event cannot create duplicate confirmations.
    allowDiscordAttachmentRetry('discord-url-snapshot-99')
    native.getPendingShare.mockResolvedValue({
      files: [],
      discordUrls: attachments.filter((_, index) => index !== 99),
    })
    expect(await takeSharedFileBatches()).toEqual([])
  })
})

describe('takeSharedFiles', () => {
  it('从暂存缓存还原文件并在取走后删除缓存', async () => {
    window.history.pushState(null, '', '/?share-target=intake-1')
    const fake = createFakeCaches({
      'srl-share-intake': {
        '/srl-shared/intake-1/manifest': new Response(
          JSON.stringify({ files: [{ name: '角色卡.png', type: 'image/png' }] }),
        ),
        // 保持 Blob 与 jsdom File 属于同一 realm，避免 Node Response 产生跨 realm Blob。
        '/srl-shared/intake-1/0': {
          blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
        } as Response,
      },
    })
    vi.stubGlobal('caches', fake)

    const files = await takeSharedFiles()

    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('角色卡.png')
    expect(files[0].type).toBe('image/png')
    expect(await files[0].text()).toBe('png-bytes')
    expect(fake.has('srl-share-intake')).toBe(true)
  })

  it('没有暂存缓存时返回空数组', async () => {
    vi.stubGlobal('caches', createFakeCaches({}))
    expect(await takeSharedFiles()).toEqual([])
  })

  it('缓存存在但缺当前 intake manifest 时不误删其他待处理分享', async () => {
    const fake = createFakeCaches({ 'srl-share-intake': {} })
    vi.stubGlobal('caches', fake)
    expect(await takeSharedFiles()).toEqual([])
    expect(fake.has('srl-share-intake')).toBe(true)
  })

  it('浏览器不支持 Cache Storage 时静默返回空', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await takeSharedFiles()).toEqual([])
  })
})

describe('clearShareTargetQuery', () => {
  it('只在带 share-target 参数时改写地址', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    window.history.pushState(null, '', '/?share-target=received')
    clearShareTargetQuery()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')

    replaceState.mockClear()
    window.history.pushState(null, '', '/')
    clearShareTargetQuery()
    expect(replaceState).not.toHaveBeenCalled()
  })
})
