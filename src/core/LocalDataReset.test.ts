/** @vitest-environment jsdom */
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginLocalDataReset,
  clearBrowserLocalData,
  consumeLocalDataResetPermit,
  installLocalDataResetBoundary,
  LOCAL_DATA_RESET_KEY,
  LOCAL_DATA_RESET_PHRASE,
  readLocalDataReset,
  stopIncompleteLocalDataReset,
} from './LocalDataReset'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistrations: vi.fn(async () => [{ unregister: vi.fn(async () => true) }]),
    },
  })
  vi.stubGlobal('caches', {
    keys: vi.fn(async () => ['srl-share-intake', 'srl-apps']),
    delete: vi.fn(async () => true),
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function seed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('data').put('private-data', 'record')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
describe('explicit browser factory reset', () => {
  it('stops before the next database and cannot turn a completed generation back into a failed one', async () => {
    beginLocalDataReset(LOCAL_DATA_RESET_PHRASE, vi.fn())
    const token = consumeLocalDataResetPermit()!,
      controller = new AbortController(),
      drop = vi.spyOn(indexedDB, 'deleteDatabase')
    await expect(
      clearBrowserLocalData(token, () => controller.abort(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(drop).toHaveBeenCalledOnce()
    stopIncompleteLocalDataReset(token)
    expect(readLocalDataReset()?.phase).toBe('stopped')
    expect(consumeLocalDataResetPermit()).toBeUndefined()
    localStorage.setItem(LOCAL_DATA_RESET_KEY, JSON.stringify({ token, phase: 'complete' }))
    stopIncompleteLocalDataReset(token)
    expect(readLocalDataReset()?.phase).toBe('complete')
  })
  it('does not break ordinary startup when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(installLocalDataResetBoundary(vi.fn())).toBe(false)
    expect(readLocalDataReset()).toBeUndefined()
  })
  it('rejects incomplete acknowledgement before writing an intent or navigating', () => {
    const replace = vi.fn()
    expect(() => beginLocalDataReset('我已了解', replace)).toThrow('尚未完整')
    expect(localStorage.length).toBe(0)
    expect(replace).not.toHaveBeenCalled()
  })
  it('consumes its launch permit once and clears databases, cached files, credentials and preferences', async () => {
    const database = await seed('SillyTavernResourceLibrary')
    database.close()
    const credentials = await seed('srl-cloud-credentials-v3')
    credentials.close()
    const future = await seed('srl-new-module')
    future.close()
    localStorage.setItem('srl-setting', 'value')
    sessionStorage.setItem('secret-session', 'value')
    const replace = vi.fn()
    beginLocalDataReset(LOCAL_DATA_RESET_PHRASE.toUpperCase().replace(/，|。/g, ' '), replace)
    expect(replace).toHaveBeenCalledWith(
      expect.stringMatching(/^\/\?srl-local-reset=[^#]+#srl-local-data-reset$/),
    )
    const permit = consumeLocalDataResetPermit()!
    expect(permit).toBeTruthy()
    expect(consumeLocalDataResetPermit()).toBeUndefined()
    await clearBrowserLocalData(permit, vi.fn())
    expect(await indexedDB.databases()).toEqual([])
    expect(Object.keys(localStorage)).toEqual([LOCAL_DATA_RESET_KEY])
    expect(sessionStorage.length).toBe(0)
    expect(caches.delete).toHaveBeenCalledTimes(2)
    expect(readLocalDataReset()?.phase).toBe('complete')
    await expect(clearBrowserLocalData(permit, vi.fn())).rejects.toThrow('已停止')
  })
  it('does not pretend success or retry when a database operation fails', async () => {
    beginLocalDataReset(LOCAL_DATA_RESET_PHRASE, vi.fn())
    const permit = consumeLocalDataResetPermit()!
    const request = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    await expect(clearBrowserLocalData(permit, vi.fn())).rejects.toThrow('disk unavailable')
    expect(readLocalDataReset()?.phase).toBe('pending')
    expect(request).toHaveBeenCalledOnce()
    expect(consumeLocalDataResetPermit()).toBeUndefined()
    expect(caches.delete).not.toHaveBeenCalled()
  })
  it('keeps a blocked deletion pending and completes only after the other connection closes', async () => {
    const held = await seed('SillyTavernResourceLibrary')
    held.onversionchange = () => {}
    beginLocalDataReset(LOCAL_DATA_RESET_PHRASE, vi.fn())
    const progress = vi.fn()
    const pending = clearBrowserLocalData(consumeLocalDataResetPermit()!, progress)
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(expect.stringContaining('请关闭其他')),
    )
    expect(readLocalDataReset()?.phase).toBe('pending')
    held.close()
    await pending
    expect(readLocalDataReset()?.phase).toBe('complete')
  })
  it('fences other live and suspended pages using the same generation after completion', () => {
    const listen = vi.spyOn(window, 'addEventListener'),
      replace = vi.fn()
    expect(installLocalDataResetBoundary(replace)).toBe(false)
    const listeners = listen.mock.calls.filter(
      ([name]) => String(name) === 'storage' || String(name) === 'pageshow',
    )
    try {
      localStorage.setItem(
        LOCAL_DATA_RESET_KEY,
        JSON.stringify({ token: 'other-page', phase: 'pending' }),
      )
      window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_DATA_RESET_KEY }))
      expect(replace).toHaveBeenCalledOnce()
      localStorage.setItem(
        LOCAL_DATA_RESET_KEY,
        JSON.stringify({ token: 'other-page', phase: 'complete' }),
      )
      window.dispatchEvent(new Event('pageshow'))
      expect(replace).toHaveBeenCalledTimes(2)
      expect(consumeLocalDataResetPermit()).toBeUndefined()
    } finally {
      for (const [name, listener] of listeners)
        window.removeEventListener(name, listener as EventListener)
    }
  })
})
