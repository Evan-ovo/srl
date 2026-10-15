import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database/AppDatabase'

const state = vi.hoisted(() => ({ active: true, vault: false }))
const sources = vi.hoisted(() => vi.fn())
vi.mock('./AndroidNativeDexieCore', () => ({
  isAndroidNativeAppDatabaseActive: () => state.active,
  runAndroidNativeRead: (_transaction: unknown, read: () => Promise<unknown>) => read(),
}))
vi.mock('./NativeAppDatabaseBridge', () => ({
  nativeAppDatabase: { getAssetImageSources: sources },
}))
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({}),
  Capacitor: { convertFileSrc: (path: string) => `https://localhost/_capacitor_file_${path}` },
}))
vi.mock('../services/HashService', () => ({ hashBlob: vi.fn() }))
import { IndexedDbAssetStore } from './IndexedDbAssetStore'

function makeStore() {
  const transaction = vi.fn(async (...args: unknown[]) =>
    (args.at(-1) as (tx: unknown) => Promise<unknown>)({ idbtrans: {} }),
  )
  const get = vi.fn()
  const database = { transaction, assets: { get }, assetFiles: { get } } as unknown as AppDatabase
  const vault = { isEnabled: () => state.vault, protectBlob: vi.fn(), revealBlob: vi.fn() }
  return { store: new IndexedDbAssetStore(database, vault), transaction, get }
}
function row(key: string) {
  return {
    key,
    blob: {
      path: 'file:///data/preview.bin',
      size: 12,
      mimeType: 'image/webp',
      sha256: 'a'.repeat(64),
    },
  }
}
beforeEach(() => {
  state.active = true
  state.vault = false
  sources.mockImplementation(async (keys: string[]) => keys.map(row))
})
afterEach(() => vi.clearAllMocks())

it('combines same-turn reads, deduplicates in-flight images and never materializes file bytes', async () => {
  const { store, get, transaction } = makeStore()
  const first = store.getImageUrl('a')
  expect(store.getImageUrl('a')).toBe(first)
  const values = await Promise.all([first, store.getImageUrl('b'), store.getImageUrl('c')])
  expect(values.every((value) => value?.startsWith('https://localhost/'))).toBe(true)
  expect(sources).toHaveBeenCalledExactlyOnceWith(['"a"', '"b"', '"c"'], [])
  expect(transaction).toHaveBeenCalledTimes(1)
  expect(get).not.toHaveBeenCalled()
  await store.getImageUrl('a')
  expect(sources).toHaveBeenCalledTimes(2) // no stale persistent result cache
})

it('bounds batches at 32 and retains requests arriving while a bridge call is in flight', async () => {
  const { store } = makeStore()
  const promises = Array.from({ length: 65 }, (_, index) => store.getImageUrl(String(index)))
  await Promise.all(promises)
  expect(sources.mock.calls.map(([keys]) => keys.length)).toEqual([32, 32, 1])
  let complete!: (rows: ReturnType<typeof row>[]) => void
  sources.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const first = store.getImageUrl('first')
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  const later = store.getImageUrl('later')
  complete([row('"first"')])
  await expect(first).resolves.toBeTruthy()
  await expect(later).resolves.toBeTruthy()
  expect(sources.mock.calls.at(-1)?.[0]).toEqual(['"later"'])
})

it('keeps simultaneous small and full requests for one image separate without changing their identities', async () => {
  const { store } = makeStore()
  await Promise.all([store.getImageUrl('same', 'card'), store.getImageUrl('same', 'preview')])
  expect(sources.mock.calls).toEqual([
    [['"same"'], ['"same"']],
    [['"same"'], []],
  ])
})

it('does not contact native storage for Web, inactive storage or an enabled vault', async () => {
  const { store } = makeStore()
  state.active = false
  expect(await store.getImageUrl('a')).toBeUndefined()
  state.active = true
  state.vault = true
  expect(await store.getImageUrl('a')).toBeUndefined()
  state.vault = false
  const pending = store.getImageUrl('a')
  state.vault = true
  expect(await pending).toBeUndefined()
  expect(sources).not.toHaveBeenCalled()
})

it('discards a direct address when the vault is enabled during the native read', async () => {
  let complete!: (rows: ReturnType<typeof row>[]) => void
  sources.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const { store } = makeStore()
  const pending = store.getImageUrl('a')
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  state.vault = true
  complete([row('"a"')])
  await expect(pending).resolves.toBeUndefined()
})

it('uses the existing blob route for encrypted rows and remembers only an absent native capability', async () => {
  const { store } = makeStore()
  sources.mockResolvedValueOnce([{ key: '"encrypted"', fallback: true }])
  await expect(store.getImageUrl('encrypted')).resolves.toBeUndefined()
  sources.mockRejectedValueOnce(Object.assign(new Error('old APK'), { code: 'UNIMPLEMENTED' }))
  await expect(store.getImageUrl('a')).resolves.toBeUndefined()
  await expect(store.getImageUrl('b')).resolves.toBeUndefined()
  expect(sources).toHaveBeenCalledTimes(2)
})

it('isolates corrupt rows and does not hide actual failures as a compatibility fallback', async () => {
  const { store } = makeStore()
  sources.mockResolvedValueOnce([row('"good"'), { key: '"bad"', error: '附件已变化' }])
  const results = await Promise.allSettled([store.getImageUrl('good'), store.getImageUrl('bad')])
  expect(results[0]?.status).toBe('fulfilled')
  expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('附件已变化') })
  sources.mockRejectedValueOnce(new Error('database failed'))
  await expect(store.getImageUrl('broken')).rejects.toThrow('database failed')
  expect(sources).toHaveBeenCalledTimes(2)
})

it('rejects missing results and invalid display descriptors', async () => {
  const { store } = makeStore()
  sources.mockResolvedValueOnce([])
  await expect(store.getImageUrl('missing')).rejects.toThrow('结果缺失')
  sources.mockResolvedValueOnce([
    { ...row('"bad"'), blob: { ...row('').blob, path: 'https://untrusted.invalid/a' } },
  ])
  await expect(store.getImageUrl('bad')).rejects.toThrow('描述无效')
})
