import { afterEach, expect, it, vi } from 'vitest'
import type { ResourceSummary } from '../types/Resource'
import { ContentSearchCache, searchContentIdentity, yieldContentSearch } from './ContentSearchCache'

it('reuses exact and logically implied answers only for the actual content identity', () => {
  const cache = new ContentSearchCache()
  cache.begin('needle')
  cache.put('needle', 'one', true)
  cache.put('needle', 'two', false)
  expect(cache.get('needle', 'one')).toBe(true)
  expect(cache.get('need', 'one')).toBe(true)
  expect(cache.get('needle plus', 'two')).toBe(false)
  expect(cache.get('needle plus', 'one')).toBeUndefined()
  expect(cache.get('need', 'two')).toBeUndefined()
  expect(cache.get('different', 'one')).toBeUndefined()
  cache.retain(new Set(['two']))
  expect(cache.get('needle', 'one')).toBeUndefined()
  cache.clear()
  expect(cache.usage).toEqual({ queries: 0, items: 0, accountedBytes: 0 })
})

it('bounds queries, entries and accounted bytes even for huge identities, queries and libraries', () => {
  const cache = new ContentSearchCache()
  for (let q = 0; q < 6; q++) {
    cache.begin(`query-${q}`)
    for (let i = 0; i < 40_000; i++) cache.put(`query-${q}`, String(i), i % 2 === 0)
    expect(cache.usage.queries).toBeLessThanOrEqual(4)
    expect(cache.usage.items).toBeLessThanOrEqual(32768)
    expect(cache.usage.accountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(cache.get(`query-${q}`, '0')).toBe(true)
  }
  cache.begin('q'.repeat(2 * 1024 * 1024))
  expect(cache.usage.accountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  cache.begin('z'.repeat(1024 * 1024))
  expect(cache.usage.accountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  cache.put('z'.repeat(1024 * 1024), 'x'.repeat(4 * 1024 * 1024), true)
  expect(cache.usage.accountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
})

it('retains all 10,050 answers with realistic UUID and SHA-256 identities within its budget', () => {
  const cache = new ContentSearchCache()
  const identities = Array.from({ length: 10_050 }, (_, i) =>
    searchContentIdentity({
      id: `12345678-1234-1234-1234-${String(i).padStart(12, '0')}`,
      contentHash: i.toString(16).padStart(64, 'a'),
      mimeType: 'application/json',
      fileName: 'fixture.json',
    } as ResourceSummary),
  )
  cache.begin('needle')
  for (const [i, identity] of identities.entries()) cache.put('needle', identity, i % 3 === 0)
  expect(cache.usage.items).toBe(10_050)
  expect(cache.usage.accountedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  for (const [i, identity] of identities.entries())
    expect(cache.get('needle', identity)).toBe(i % 3 === 0)
})

it('uses ID, actual hash and JSON eligibility; display metadata does not invalidate content', () => {
  const original = {
    id: 'a',
    contentHash: 'hash',
    mimeType: 'application/json',
    fileName: 'a.json',
  } as ResourceSummary
  const identity = searchContentIdentity(original)
  expect(searchContentIdentity({ ...original, name: 'renamed', fileName: 'renamed.json' })).toBe(
    identity,
  )
  expect(searchContentIdentity({ ...original, contentHash: 'new' })).not.toBe(identity)
  expect(searchContentIdentity({ ...original, id: 'b' })).not.toBe(identity)
  expect(
    searchContentIdentity({ ...original, mimeType: 'text/plain', fileName: 'a.txt' }),
  ).not.toBe(identity)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('closes both MessageChannel ports after yielding a task', async () => {
  const port1 = { onmessage: undefined as (() => void) | undefined, close: vi.fn() }
  const port2 = { postMessage: vi.fn(), close: vi.fn() }
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = port1
      port2 = port2
    },
  )
  const yielded = yieldContentSearch()
  expect(port2.postMessage).toHaveBeenCalledOnce()
  expect(port1.close).not.toHaveBeenCalled()
  port1.onmessage!()
  await yielded
  expect(port1.close).toHaveBeenCalledOnce()
  expect(port2.close).toHaveBeenCalledOnce()
})

it('closes both ports when posting a yield fails', async () => {
  const port1 = { close: vi.fn() }
  const port2 = {
    postMessage: () => {
      throw new Error('closed')
    },
    close: vi.fn(),
  }
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = port1
      port2 = port2
    },
  )
  await expect(yieldContentSearch()).rejects.toThrow('closed')
  expect(port1.close).toHaveBeenCalledOnce()
  expect(port2.close).toHaveBeenCalledOnce()
})

it('falls back to a timer task when MessageChannel is unavailable', async () => {
  vi.stubGlobal('MessageChannel', undefined)
  const timer = vi.spyOn(globalThis, 'setTimeout')
  await yieldContentSearch()
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 0)
})
