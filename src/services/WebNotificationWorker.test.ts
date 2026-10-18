import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('the shipped service worker notification handler', () => {
  it.each(['backup', 'inbox'] as const)(
    'opens the %s destination for a warm or cold PWA without trusting notification URLs',
    async (kind) => {
      const handlers = new Map<string, (event: object) => void>()
      const sameOrigin = { url: 'https://example.com/', focus: vi.fn(), postMessage: vi.fn() }
      const foreign = { url: 'https://other.example/', focus: vi.fn(), postMessage: vi.fn() }
      const clients = { matchAll: vi.fn(async () => [foreign, sameOrigin]), openWindow: vi.fn() }
      runInNewContext(
        readFileSync(new URL('../../public/sw-share-target.js', import.meta.url), 'utf8'),
        {
          self: {
            addEventListener: (name: string, handler: (event: object) => void) =>
              handlers.set(name, handler),
            location: { origin: 'https://example.com' },
            clients,
          },
          URL,
        },
      )
      const pending: Promise<void>[] = [],
        close = vi.fn()
      const event = {
        notification: {
          data: {
            [kind === 'backup' ? 'srlBackup' : 'srlInbox']: true,
            url: 'https://untrusted.example/',
          },
          close,
        },
        waitUntil: (work: Promise<void>) => pending.push(work),
      }
      handlers.get('notificationclick')!(event)
      await Promise.all(pending)
      expect(sameOrigin.focus).toHaveBeenCalledOnce()
      expect(sameOrigin.postMessage).toHaveBeenCalledWith({ type: `srl:open-${kind}` })
      expect(foreign.focus).not.toHaveBeenCalled()
      clients.matchAll.mockResolvedValue([])
      handlers.get('notificationclick')!(event)
      await Promise.all(pending)
      expect(clients.openWindow).toHaveBeenCalledExactlyOnceWith(`/?open-${kind}=1`)
    },
  )
})
