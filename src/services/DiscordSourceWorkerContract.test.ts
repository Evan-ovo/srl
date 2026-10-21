import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const readWorkerModule = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL('../../workers/discord-source-bridge/src/' + name + '.ts', import.meta.url),
    ),
    'utf8',
  )
const workerSource = [
  readWorkerModule('DiscordSourceProtocol'),
  readWorkerModule('DiscordWorkerHttp'),
  readWorkerModule('DiscordSourceCapture'),
  readWorkerModule('index'),
].join('\n')

describe('Discord setup Worker contract', () => {
  it('exposes an authenticated real command-status endpoint', () => {
    expect(workerSource).toContain("url.pathname === '/setup/status'")
    expect(workerSource).toContain('commandRegistered: applicationIdMatches')
    expect(workerSource).toContain('discordApplicationCommandsUrl(env)')
    expect(workerSource).toContain('/oauth2/applications/@me')
    expect(workerSource).toContain('publicKeyMatches')
  })

  it('reports D1 health and per-variable presence without exposing credentials', () => {
    expect(workerSource).toContain("url.pathname === '/health'")
    expect(workerSource).toContain("await env.DB.prepare('SELECT 1 FROM handoffs LIMIT 1').first()")
    expect(workerSource).toContain('discordVariables')
    expect(workerSource).toContain('applicationId: Boolean(env.DISCORD_APPLICATION_ID?.trim())')
    expect(workerSource).toContain('publicKey: Boolean(env.DISCORD_PUBLIC_KEY?.trim())')
    expect(workerSource).toContain('botToken: Boolean(env.DISCORD_BOT_TOKEN?.trim())')
  })

  it('rejects command registration when SRL and Worker Application IDs disagree', () => {
    expect(workerSource).toContain("error: 'application_id_mismatch'")
    expect(workerSource).toContain('requestedApplicationId !== env.DISCORD_APPLICATION_ID')
    expect(workerSource).toContain('status: 409')
  })
})
