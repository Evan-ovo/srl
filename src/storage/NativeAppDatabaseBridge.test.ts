import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const state = vi.hoisted(() => ({ platform: 'android', native: true, available: true }))
const plugin = vi.hoisted(() => ({
  getAssetImageSources: vi.fn(),
  queryKeyPage: vi.fn(),
  getStatus: vi.fn(),
  getBlobPath: vi.fn(),
  getRecordKeys: vi.fn(),
  countRecords: vi.fn(),
  haveSameRecordKeys: vi.fn(),
  countIndexEntries: vi.fn(),
  verifyStore: vi.fn(),
  getRecord: vi.fn(),
  getRecords: vi.fn(),
  getRecordsByKeys: vi.fn(),
  putRecords: vi.fn(),
  applyBatch: vi.fn(),
  deleteRecords: vi.fn(),
  clearStore: vi.fn(),
  getState: vi.fn(),
  putState: vi.fn(),
  beginBlob: vi.fn(),
  appendBlob: vi.fn(),
  completeBlob: vi.fn(),
  readBlobChunk: vi.fn(),
  deleteBlob: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => state.native,
    getPlatform: () => state.platform,
    isPluginAvailable: () => state.available,
    convertFileSrc: (path: string) => `https://localhost/_capacitor_file_${path}`,
  },
  registerPlugin: () => plugin,
}))

import { nativeAppDatabase, APP_DATABASE_STORES } from './NativeAppDatabaseBridge'
import { hashBlob } from '../services/HashService'

function encodeBase64(value: string): string {
  return btoa(value)
}

describe('NativeAppDatabaseBridge', () => {
  it('reads a bounded batch of image descriptions without fetching any binary', async () => {
    plugin.getAssetImageSources.mockResolvedValueOnce({ rows: [{ key: '"a"', fallback: true }] })
    await expect(nativeAppDatabase.getAssetImageSources(['"a"'])).resolves.toEqual([
      { key: '"a"', fallback: true },
    ])
    expect(plugin.getAssetImageSources).toHaveBeenCalledWith({ keys: ['"a"'] })
    expect(plugin.getRecord).not.toHaveBeenCalled()
    expect(plugin.getBlobPath).not.toHaveBeenCalled()
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
    await expect(nativeAppDatabase.getAssetImageSources([])).rejects.toThrow('批次无效')
    await expect(nativeAppDatabase.getAssetImageSources(Array(33).fill('"a"'))).rejects.toThrow(
      '批次无效',
    )
  })

  it('forwards bounded key ranges and revision anchors without fetching records', async () => {
    const query = {
      indexName: 'updatedAt',
      lower: '2',
      upper: '10',
      reverse: true,
      afterKey: '9',
      afterPrimaryKey: '"id"',
      limit: 7,
      revision: '3',
    }
    plugin.queryKeyPage.mockResolvedValueOnce({
      rows: [{ indexKey: '8', primaryKey: '"next"' }],
      revision: '3',
    })
    await expect(nativeAppDatabase.queryKeyPage('resourceListSummaries', query)).resolves.toEqual({
      rows: [{ indexKey: '8', primaryKey: '"next"' }],
      revision: '3',
    })
    expect(plugin.queryKeyPage).toHaveBeenCalledWith({ store: 'resourceListSummaries', query })
    expect(plugin.getRecords).not.toHaveBeenCalled()
    expect(plugin.getRecordsByKeys).not.toHaveBeenCalled()
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
  })

  it('reads only the requested range and keeps the original attachment identity fixed', async () => {
    const expected = { size: 9, mimeType: 'text/plain', sha256: 'a'.repeat(64) }
    plugin.readBlobChunk.mockResolvedValueOnce({
      found: true,
      blob: { ...expected, offset: 3, data: btoa('def'), eof: false },
    })
    expect(
      new TextDecoder().decode(
        await nativeAppDatabase.readBlobRange(
          'resources',
          '"chat"',
          '/originalBlob',
          3,
          3,
          expected,
        ),
      ),
    ).toBe('def')
    expect(plugin.readBlobChunk).toHaveBeenCalledWith({
      store: 'resources',
      key: '"chat"',
      fieldPath: '/originalBlob',
      offset: 3,
      length: 3,
    })
    expect(plugin.getBlobPath).not.toHaveBeenCalled()
    plugin.readBlobChunk.mockResolvedValueOnce({
      found: true,
      blob: { ...expected, sha256: 'b'.repeat(64), offset: 6, data: btoa('ghi'), eof: true },
    })
    await expect(
      nativeAppDatabase.readBlobRange('resources', '"chat"', '/originalBlob', 6, 3, expected),
    ).rejects.toThrow('已变化')
    plugin.readBlobChunk.mockResolvedValueOnce({ found: false })
    await expect(
      nativeAppDatabase.readBlobRange('resources', '"chat"', '/originalBlob', 6, 3, expected),
    ).rejects.toThrow('不存在')
  })

  it.each([
    { offset: 2 },
    { size: 10 },
    { mimeType: 'text/html' },
    { data: btoa('de') },
    { eof: true },
  ])('rejects a malformed bounded chunk: %j', async (patch) => {
    const expected = { size: 9, mimeType: 'text/plain', sha256: 'a'.repeat(64) }
    plugin.readBlobChunk.mockResolvedValueOnce({
      found: true,
      blob: { ...expected, offset: 3, data: btoa('def'), eof: false, ...patch },
    })
    await expect(
      nativeAppDatabase.readBlobRange('resources', '"chat"', '/originalBlob', 3, 3, expected),
    ).rejects.toThrow()
  })

  it('validates an empty attachment and caps reads at the actual EOF', async () => {
    const expected = { size: 0, mimeType: 'text/plain', sha256: 'a'.repeat(64) }
    plugin.readBlobChunk.mockResolvedValueOnce({
      found: true,
      blob: { ...expected, offset: 0, data: '', eof: true },
    })
    expect(
      (
        await nativeAppDatabase.readBlobRange(
          'resources',
          '"chat"',
          '/originalBlob',
          0,
          0,
          expected,
        )
      ).byteLength,
    ).toBe(0)
    expect(plugin.readBlobChunk).toHaveBeenCalledWith({
      store: 'resources',
      key: '"chat"',
      fieldPath: '/originalBlob',
      offset: 0,
      length: 1,
    })
    plugin.readBlobChunk.mockResolvedValueOnce({
      found: true,
      blob: { ...expected, size: 3, offset: 1, data: btoa('bc'), eof: true },
    })
    expect(
      new TextDecoder().decode(
        await nativeAppDatabase.readBlobRange(
          'resources',
          '"chat"',
          '/originalBlob',
          1,
          256 * 1024,
          { ...expected, size: 3 },
        ),
      ),
    ).toBe('bc')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('compares complete key sets in one native call without transferring the keys', async () => {
    plugin.haveSameRecordKeys.mockResolvedValueOnce({ equal: false })
    await expect(
      nativeAppDatabase.haveSameRecordKeys('resources', 'resourceListSummaries'),
    ).resolves.toBe(false)
    expect(plugin.haveSameRecordKeys).toHaveBeenCalledWith({
      leftStore: 'resources',
      rightStore: 'resourceListSummaries',
    })
    expect(plugin.getRecordKeys).not.toHaveBeenCalled()
  })

  it('reads an attachment through the native file path with one bridge call and preserves MIME', async () => {
    plugin.getBlobPath.mockResolvedValueOnce({
      found: true,
      blob: { path: '/data/asset', size: 3, mimeType: 'image/png', sha256: 'a'.repeat(64) },
    })
    const fetcher = vi.fn().mockResolvedValue(new Response(new Blob(['abc'])))
    vi.stubGlobal('fetch', fetcher)
    const blob = await nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob', 'a'.repeat(64))
    expect(await blob?.text()).toBe('abc')
    expect(blob?.type).toBe('image/png')
    expect(plugin.getBlobPath).toHaveBeenCalledOnce()
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledWith('https://localhost/_capacitor_file_/data/asset')
  })

  it('does not hide native file failures by silently reading all Base64 chunks', async () => {
    plugin.getBlobPath.mockRejectedValueOnce(new Error('attachment damaged'))
    await expect(nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob')).rejects.toThrow(
      'attachment damaged',
    )
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
  })

  it('rejects a file path with changed hash or truncated response', async () => {
    plugin.getBlobPath.mockResolvedValue({
      found: true,
      blob: { path: '/data/asset', size: 4, mimeType: 'text/plain', sha256: 'a'.repeat(64) },
    })
    const fetcher = vi.fn().mockResolvedValue(new Response('abc'))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob', 'b'.repeat(64)),
    ).rejects.toThrow('附件在读取期间已变化')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob')).rejects.toThrow(
      '大小校验失败',
    )
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
  })
  it('rejects a blob reference changing between chunks even when size and MIME remain equal', async () => {
    plugin.readBlobChunk
      .mockResolvedValueOnce({
        found: true,
        blob: {
          size: 2,
          mimeType: 'text/plain',
          sha256: 'a'.repeat(64),
          offset: 0,
          data: btoa('a'),
          eof: false,
        },
      })
      .mockResolvedValueOnce({
        found: true,
        blob: {
          size: 2,
          mimeType: 'text/plain',
          sha256: 'b'.repeat(64),
          offset: 1,
          data: btoa('b'),
          eof: true,
        },
      })
    await expect(nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob')).rejects.toThrow(
      '附件在读取期间已变化',
    )
  })
  it('checks the record descriptor hash on the first attachment chunk', async () => {
    plugin.readBlobChunk.mockResolvedValue({
      found: true,
      blob: {
        size: 1,
        mimeType: 'text/plain',
        sha256: 'b'.repeat(64),
        offset: 0,
        data: btoa('b'),
        eof: true,
      },
    })
    await expect(
      nativeAppDatabase.readBlob('assetFiles', 'asset', 'blob', 'a'.repeat(64)),
    ).rejects.toThrow('附件在读取期间已变化')
  })
  it('keeps the TypeScript whitelist, native SQLite whitelist and status enumeration identical', () => {
    for (const [file, pattern] of [
      ['NativeAppDatabase.java', /STORES =[^]*?Arrays\.asList\(([^]*?)\)\)\);/],
      ['NativeAppDatabasePlugin.java', /String\[\] stores = new String\[\] \{([^]*?)\};/],
    ] as const) {
      const source = readFileSync(
        new URL(
          `../../android/app/src/main/java/buzz/jixiangruyi1207/srl/${file}`,
          import.meta.url,
        ),
        'utf8',
      )
      const names = [...source.match(pattern)![1]!.matchAll(/"([a-zA-Z]+)"/g)].map(
        (match) => match[1],
      )
      expect(new Set(names)).toEqual(new Set(APP_DATABASE_STORES))
    }
  })
  beforeEach(() => {
    vi.clearAllMocks()
    plugin.getBlobPath.mockReset().mockRejectedValue({ code: 'UNIMPLEMENTED' })
    state.platform = 'android'
    state.native = true
    state.available = true
    plugin.beginBlob.mockResolvedValue({ token: 'token', offset: 0, alreadyStored: false })
    plugin.appendBlob.mockImplementation(async ({ offset, data }) => {
      const binary = atob(data)
      return { offset: offset + binary.length }
    })
    plugin.completeBlob.mockImplementation(async () => {
      const source = plugin.beginBlob.mock.calls.at(-1)![0]
      return { sha256: source.sourceSha256, size: source.size, mimeType: source.mimeType }
    })
  })

  it('reads only keys/count and performs the explicit native integrity audit', async () => {
    plugin.getRecordKeys.mockResolvedValue({ keys: ['"a"'], nextKey: null })
    plugin.countRecords.mockResolvedValue({ count: 3000 })
    plugin.verifyStore.mockResolvedValue({ records: 3000, files: 232, bytes: 3 * 1024 ** 3 })
    expect(await nativeAppDatabase.getRecordKeys('resources', undefined, 1000)).toEqual({
      keys: ['"a"'],
      nextKey: null,
    })
    expect(plugin.getRecordKeys).toHaveBeenCalledWith({
      store: 'resources',
      afterKey: undefined,
      limit: 1000,
    })
    expect(await nativeAppDatabase.countRecords('resources')).toBe(3000)
    plugin.countIndexEntries.mockResolvedValue({ count: 232 })
    expect(await nativeAppDatabase.countIndexEntries('resources', 'type', '"characterCard"')).toBe(
      232,
    )
    expect(plugin.countIndexEntries).toHaveBeenCalledWith({
      store: 'resources',
      indexName: 'type',
      indexKey: '"characterCard"',
    })
    expect(await nativeAppDatabase.verifyStore('resources')).toMatchObject({ files: 232 })
    expect(plugin.getRecords).not.toHaveBeenCalled()
    expect(plugin.readBlobChunk).not.toHaveBeenCalled()
  })

  it('streams a large Blob in bounded chunks and verifies native offsets', async () => {
    const blob = new Blob([new Uint8Array(1024 * 1024 + 7)], { type: 'application/octet-stream' })
    await expect(
      nativeAppDatabase.writeBlob('assetFiles', 'asset-1', 'blob', blob),
    ).resolves.toEqual({
      sha256: await hashBlob(blob),
      size: blob.size,
      mimeType: blob.type,
    })
    expect(plugin.appendBlob).toHaveBeenCalledTimes(2)
    const chunks = plugin.appendBlob.mock.calls.map(([call]) => atob(call.data).length)
    expect(chunks).toEqual([1024 * 1024, 7])
    expect(plugin.completeBlob).toHaveBeenCalledWith({ token: 'token' })
  })

  it('resumes a partially staged Blob from the native byte offset', async () => {
    plugin.beginBlob.mockResolvedValue({
      token: 'resumable-token',
      offset: 2,
      alreadyStored: false,
    })
    await nativeAppDatabase.writeBlob('assetFiles', 'asset-2', 'blob', new Blob(['abcdef']))
    expect(plugin.beginBlob).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSha256: await hashBlob(new Blob(['abcdef'])) }),
    )
    expect(plugin.appendBlob).toHaveBeenCalledTimes(1)
    expect(plugin.appendBlob).toHaveBeenCalledWith({
      token: 'resumable-token',
      offset: 2,
      data: encodeBase64('cdef'),
    })
  })

  it('rejects native completion with changed bytes even when size and MIME match', async () => {
    plugin.completeBlob.mockResolvedValue({
      size: 3,
      mimeType: 'text/plain',
      sha256: 'a'.repeat(64),
    })
    await expect(
      nativeAppDatabase.writeBlob(
        'assetFiles',
        'asset-1',
        'blob',
        new Blob(['abc'], { type: 'text/plain' }),
      ),
    ).rejects.toThrow('读回校验失败')
  })

  it('persists migration checkpoints through native app state', async () => {
    plugin.getState.mockResolvedValue({ found: true, value: '{"copied":5}' })
    plugin.putState.mockResolvedValue(undefined)
    await nativeAppDatabase.putState('migration:resources', '{"copied":5}')
    await expect(nativeAppDatabase.getState('migration:resources')).resolves.toBe('{"copied":5}')
    expect(plugin.putState).toHaveBeenCalledWith({
      key: 'migration:resources',
      value: '{"copied":5}',
    })
  })

  it('exposes one native transaction for coordinated multi-table resource changes', async () => {
    plugin.applyBatch.mockResolvedValue({ applied: 2 })
    const operations = [
      {
        type: 'put' as const,
        store: 'resources' as const,
        rows: [{ key: '"r1"', value: { id: 'r1' } }],
      },
      { type: 'delete' as const, store: 'resourceListSummaries' as const, keys: ['"stale"'] },
    ]
    await expect(nativeAppDatabase.applyBatch(operations)).resolves.toBe(2)
    expect(plugin.applyBatch).toHaveBeenCalledWith({ operations })
  })

  it('reconstructs a Blob from native ranged reads and rejects PWA access', async () => {
    plugin.readBlobChunk.mockResolvedValue({
      found: true,
      blob: {
        mimeType: 'text/plain',
        size: 11,
        sha256: 'c'.repeat(64),
        offset: 0,
        data: encodeBase64('hello world'),
        eof: true,
      },
    })
    const restored = await nativeAppDatabase.readBlob('assetFiles', 'asset-1', 'blob')
    await expect(restored?.text()).resolves.toBe('hello world')

    state.native = false
    await expect(nativeAppDatabase.status()).rejects.toThrow('Android 原生数据库不可用')
    expect(plugin.getStatus).not.toHaveBeenCalled()
  })
})
