import { afterEach, expect, it, vi } from 'vitest'
import { createFolderThumbnailCache } from './FolderThumbnailCache'
import type { ResourceSummary } from '../types/Resource'

const source = (id: string) => ({ id, contentHash: id, thumbnailAssetId: id }) as ResourceSummary
afterEach(() => vi.restoreAllMocks())

it('retains native addresses within the entry budget without creating or revoking object URLs', () => {
  const create = vi.spyOn(URL, 'createObjectURL')
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const cache = createFolderThumbnailCache(1, 4)
  const first = cache.acquire(source('a'), 'https://native/a')!
  first.release()
  const reused = cache.acquire(source('a'))!
  expect(reused.url).toBe(first.url)
  expect(reused.native).toBe(true)
  reused.release()
  const next = cache.acquire(source('b'), 'https://native/b')!
  expect(cache.acquire(source('a'))).toBeUndefined()
  cache.invalidate(source('b'), 'https://native/old')
  const current = cache.acquire(source('b'))!
  expect(current.url).toBe(next.url)
  current.release()
  cache.invalidate(source('b'), next.url)
  expect(cache.acquire(source('b'))).toBeUndefined()
  next.release()
  cache.clear()
  expect(create).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

it('bounds retained bytes and entries, without revoking a displayed image', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const cache = createFolderThumbnailCache(2, 4)
  const first = cache.acquire(source('a'), new Blob(['aa']))!
  const second = cache.acquire(source('b'), new Blob(['bb']))!
  second.release()
  const third = cache.acquire(source('c'), new Blob(['cc']))!
  expect(revoke).toHaveBeenCalledWith(second.url)
  expect(revoke).not.toHaveBeenCalledWith(first.url)
  expect(cache.acquire(source('b'))).toBeUndefined()
  const oversized = cache.acquire(source('large'), new Blob(['12345']))!
  oversized.release()
  expect(revoke).toHaveBeenCalledWith(oversized.url)
  expect(cache.acquire(source('large'))).toBeUndefined()
  first.release()
  third.release()
  cache.clear()
  expect(revoke).toHaveBeenCalledWith(first.url)
  expect(revoke).toHaveBeenCalledWith(third.url)
})

it('discards removed or replaced sources and clears late leases exactly once', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const cache = createFolderThumbnailCache()
  const old = cache.acquire(source('a'), new Blob(['a']))!
  cache.prune([{ ...source('a'), thumbnailAssetId: 'replacement' }])
  expect(cache.acquire(source('a'))).toBeUndefined()
  old.release()
  old.release()
  expect(revoke).toHaveBeenCalledExactlyOnceWith(old.url)
  const next = cache.acquire(source('b'), new Blob(['b']))!
  next.release()
  cache.prune([])
  expect(cache.acquire(source('b'))).toBeUndefined()
  expect(revoke).toHaveBeenCalledWith(next.url)
  cache.clear()
})
