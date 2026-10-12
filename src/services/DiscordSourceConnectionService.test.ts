import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getDiscordWorkerEndpoints,
  normalizeDiscordWorkerBaseUrl,
  checkDiscordWorker,
  diagnoseDiscordConfiguration,
} from './DiscordSourceConnectionService'

describe('DiscordSourceConnectionService', () => {
  afterEach(() => vi.unstubAllGlobals())
  const settings = {
    workerBaseUrl: 'https://example.workers.dev',
    applicationId: '1234567890123456789',
    botToken: 'LOCAL_TEST_SECRET',
  }
  const health = {
    ok: true,
    database: true,
    applicationId: settings.applicationId,
    discordConfigured: true,
    discordVariables: { applicationId: true, publicKey: true, botToken: true },
  }
  it.each([
    [{ ...health, database: false }, 'd1-error'],
    [{ ...health, applicationId: '9876543210123456789' }, 'discord-invalid'],
    [{ ...health, discordVariables: undefined }, 'outdated'],
    [
      { ...health, discordVariables: { applicationId: true, publicKey: true, botToken: false } },
      'discord-missing',
    ],
  ])(
    'diagnoses an actionable health problem without reading credentials or echoing remote values',
    async (payload, state) => {
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify({ ...payload, secret: settings.botToken })),
      )
      vi.stubGlobal('fetch', fetcher)
      const result = await diagnoseDiscordConfiguration(settings, new AbortController().signal)
      expect(result.state).toBe(state)
      expect(fetcher).toHaveBeenCalledOnce()
      expect(JSON.stringify(result)).not.toContain(settings.botToken)
      expect(JSON.stringify(result)).not.toContain(settings.applicationId)
    },
  )
  it.each([true, false])(
    'diagnoses registered=%s using health and authenticated status without registering anything',
    async (commandRegistered) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(health)))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              applicationIdMatches: true,
              publicKeyMatches: true,
              commandRegistered,
              secret: settings.botToken,
            }),
          ),
        )
      vi.stubGlobal('fetch', fetcher)
      const result = await diagnoseDiscordConfiguration(settings, new AbortController().signal)
      expect(result).toMatchObject({ state: 'ready', commandRegistered, workerHealthy: true })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        'https://example.workers.dev/health',
        'https://example.workers.dev/setup/status',
      ])
      expect(JSON.stringify(result)).not.toContain(settings.botToken)
    },
  )
  it('keeps missing local credentials and a mismatched Secret explicit, and never echoes an error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(health))),
    )
    expect(
      await diagnoseDiscordConfiguration(
        { ...settings, botToken: '' },
        new AbortController().signal,
      ),
    ).toMatchObject({ state: 'need-token' })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(health)))
        .mockResolvedValueOnce(new Response(settings.botToken, { status: 401 })),
    )
    const result = await diagnoseDiscordConfiguration(settings, new AbortController().signal)
    expect(result.state).toBe('discord-invalid')
    expect(JSON.stringify(result)).not.toContain(settings.botToken)
  })
  it.each([
    [404, {}, 'outdated'],
    [403, {}, 'discord-invalid'],
    [
      200,
      { applicationIdMatches: false, publicKeyMatches: true, commandRegistered: true },
      'discord-invalid',
    ],
    [
      200,
      { applicationIdMatches: true, publicKeyMatches: false, commandRegistered: true },
      'discord-invalid',
    ],
    [200, { commandRegistered: true }, 'outdated'],
  ] as const)(
    'classifies status %s without registering, changing configuration or returning credentials',
    async (code, body, state) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(health)))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...body, secret: settings.botToken }), { status: code }),
        )
      vi.stubGlobal('fetch', fetcher)
      const result = await diagnoseDiscordConfiguration(settings, new AbortController().signal)
      expect(result.state).toBe(state)
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
      expect(JSON.stringify(result)).not.toContain(settings.botToken)
    },
  )
  it('propagates cancellation without performing the next request', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async () => {
      controller.abort()
      return new Response(JSON.stringify(health))
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(diagnoseDiscordConfiguration(settings, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('preserves standalone D1 health testing before an App has been entered on the connection screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ applicationId: null, database: true, discordConfigured: false }),
          ),
        ),
    )
    expect(
      await checkDiscordWorker(
        { workerBaseUrl: settings.workerBaseUrl, applicationId: '' },
        'health',
        new AbortController().signal,
      ),
    ).toEqual({ configured: false })
  })
  it('confirms registration through a second real status check and keeps raw data local', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ applicationId: settings.applicationId })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            applicationId: settings.applicationId,
            applicationIdMatches: true,
            publicKeyMatches: true,
            commandRegistered: true,
            leaked: settings.botToken,
          }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    const receipt = await checkDiscordWorker(settings, 'register', new AbortController().signal)
    expect(receipt).toEqual({ configured: true, commandRegistered: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { Authorization: `Bearer ${settings.botToken}` },
    })
    expect(fetcher.mock.calls[1]![0]).toBe('https://example.workers.dev/setup/status')
    expect(JSON.stringify(receipt)).not.toContain(settings.botToken)
  })
  it.each([
    { applicationId: '9876543210123456789', database: true },
    { applicationId: settings.applicationId, database: false },
    { database: true },
  ])('rejects missing identity, another App and a broken D1', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))))
    await expect(
      checkDiscordWorker(settings, 'health', new AbortController().signal),
    ).rejects.toThrow()
  })
  it('does not forward server error text or follow redirects carrying a Bot Token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(settings.botToken, { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      checkDiscordWorker(settings, 'status', new AbortController().signal),
    ).rejects.toThrow('HTTP 403')
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error')
  })
  it('does not fetch after stop or mark a missing command as registered', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          applicationId: settings.applicationId,
          applicationIdMatches: true,
          publicKeyMatches: true,
          commandRegistered: false,
        }),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort()
    await expect(checkDiscordWorker(settings, 'register', controller.signal)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      await checkDiscordWorker(settings, 'status', new AbortController().signal),
    ).toMatchObject({ commandRegistered: false })
  })
  it('accepts a bare workers.dev host and adds https', () => {
    expect(normalizeDiscordWorkerBaseUrl('example.workers.dev')).toBe('https://example.workers.dev')
  })

  it('removes trailing slashes from the base URL', () => {
    expect(normalizeDiscordWorkerBaseUrl(' https://example.workers.dev/// ')).toBe(
      'https://example.workers.dev',
    )
  })

  it('accepts a pasted interactions URL without duplicating the suffix', () => {
    const endpoints = getDiscordWorkerEndpoints('https://example.workers.dev/interactions')
    expect(endpoints).toEqual({
      baseUrl: 'https://example.workers.dev',
      interactionsUrl: 'https://example.workers.dev/interactions',
      healthUrl: 'https://example.workers.dev/health',
      registerUrl: 'https://example.workers.dev/setup/register',
      statusUrl: 'https://example.workers.dev/setup/status',
    })
  })

  it('strips other known endpoint suffixes but preserves an intentional base path', () => {
    expect(normalizeDiscordWorkerBaseUrl('https://example.com/srl/setup/register')).toBe(
      'https://example.com/srl',
    )
    expect(normalizeDiscordWorkerBaseUrl('https://example.com/srl/health')).toBe(
      'https://example.com/srl',
    )
    expect(normalizeDiscordWorkerBaseUrl('https://example.com/srl/setup/status')).toBe(
      'https://example.com/srl',
    )
  })

  it('rejects non-http protocols and credential-bearing URLs', () => {
    expect(normalizeDiscordWorkerBaseUrl('javascript:alert(1)')).toBe('')
    expect(normalizeDiscordWorkerBaseUrl('https://user:pass@example.workers.dev')).toBe('')
  })
})
