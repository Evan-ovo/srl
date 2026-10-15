import { expect, it } from 'vitest'
import {
  gitHubWranglerSource,
  githubConfigurationConflict,
  githubWranglerMatches,
  readGitHubWrangler,
} from './DiscordSetupGitHub'

const applicationId = '1234567890123456789'
const values = {
  applicationId,
  publicKey: 'a'.repeat(64),
  databaseId: '12345678-1234-5678-9abc-123456789abc',
}
it('fills only public configuration and validates task identity', () => {
  const source = gitHubWranglerSource(values, applicationId)
  expect(source).not.toContain('DISCORD_BOT_TOKEN')
  expect(githubWranglerMatches(source, source)).toBe(true)
  expect(() => gitHubWranglerSource(values, '2345678901234567890')).toThrow('不一致')
  expect(() =>
    gitHubWranglerSource({ ...values, databaseId: 'database-name' }, applicationId),
  ).toThrow('格式')
})
it('keeps quoted URLs and comment-like strings when reading existing JSONC', () => {
  expect(
    readGitHubWrangler(
      '{/* note */"url":"https://example.com/a//b",\n"text":"/* literal */",\n// line\n"array":[1,2,/* trailing */],}',
    ),
  ).toEqual({ url: 'https://example.com/a//b', text: '/* literal */', array: [1, 2] })
  expect(() => readGitHubWrangler('{/* broken')).toThrow('未结束')
})
it('distinguishes an already configured fork from placeholders and an actual parameter conflict', () => {
  const source = gitHubWranglerSource(values, applicationId)
  expect(githubConfigurationConflict(source, source)).toBe(false)
  expect(
    githubConfigurationConflict(source.replace(applicationId, '2345678901234567890'), source),
  ).toBe(true)
  expect(githubWranglerMatches(source.replace('1200', '2400'), source)).toBe(true)
  expect(
    githubConfigurationConflict(source.replace(applicationId, '【paste App ID】'), source),
  ).toBe(false)
})

it('preserves existing deployment choices while changing only the three task parameters', () => {
  const original = JSON.parse(gitHubWranglerSource(values, applicationId))
  original.name = 'existing-name'
  original.compatibility_date = '2026-10-01'
  original.vars.EXTRA = 'public'
  original.observability = { enabled: true }
  original.d1_databases[0].database_name = 'existing-db'
  original.vars.DISCORD_APPLICATION_ID = '2234567890123456789'
  const result = JSON.parse(gitHubWranglerSource(values, applicationId, JSON.stringify(original)))
  expect(result).toMatchObject({
    name: 'existing-name',
    compatibility_date: '2026-10-01',
    vars: { EXTRA: 'public', DISCORD_APPLICATION_ID: applicationId },
    observability: { enabled: true },
  })
  expect(result.d1_databases[0].database_name).toBe('existing-db')
  expect(
    githubWranglerMatches(JSON.stringify(result), gitHubWranglerSource(values, applicationId)),
  ).toBe(true)
})

it('does not echo a malformed old file and distinguishes additional database bindings from conflicts', () => {
  expect(() => readGitHubWrangler('{"password":"PRIVATE_SAMPLE" broken}')).toThrow('未回传源码')
  try {
    readGitHubWrangler('{"password":"PRIVATE_SAMPLE" broken}')
  } catch (error) {
    expect(String(error)).not.toContain('PRIVATE_SAMPLE')
  }
  const source = JSON.parse(gitHubWranglerSource(values, applicationId))
  source.d1_databases.unshift({ binding: 'EXTRA', database_id: 'other' })
  expect(githubConfigurationConflict(JSON.stringify(source), JSON.stringify(source))).toBe(false)
})
