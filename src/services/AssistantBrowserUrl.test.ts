import { describe, expect, it } from 'vitest'
import { isAssistantBrowserUrl } from './AssistantBrowserUrl'
import { isSetupAgentUrl } from './DiscordSetupWorkflow'

describe('shared browser authority independent of workflow sites', () => {
  it.each([
    'https://github.com/login',
    'https://dash.cloudflare.com/login',
    'https://discord.com/developers/applications',
    'https://bridge.account.workers.dev/',
    'https://accounts.google.com/v3/signin/identifier',
    'https://developers.cloudflare.com/turnstile/',
    'https://docs.github.com/en/get-started',
    'https://example.org/form',
  ])('both task owners permit the public page %s', (address) => {
    const url = new URL(address)
    expect(isAssistantBrowserUrl(url)).toBe(true)
    expect(isSetupAgentUrl(url)).toBe(true)
  })

  it.each([
    'http://example.org/',
    'file:///private',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://host.internal/',
    'https://host.home.arpa/',
    'https://[::1]/',
    'https://user:password@example.org/',
    'https://example.org:444/',
  ])('neither owner opens a non-public address %s', (address) => {
    const url = new URL(address)
    expect(isAssistantBrowserUrl(url)).toBe(false)
    expect(isSetupAgentUrl(url)).toBe(false)
  })
})
