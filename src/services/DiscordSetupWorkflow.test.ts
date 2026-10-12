import { describe, expect, it } from 'vitest'
import { isSetupAgentUrl, isSetupForkPage } from './DiscordSetupWorkflow'

describe('Worker public page authority', () => {
  it.each(['/', '/interactions', '/health'])('allows the deployed Worker at %s', (path) => {
    expect(isSetupAgentUrl(new URL(`https://preview-abc.bridge.account.workers.dev${path}`))).toBe(
      true,
    )
  })
  it.each([
    'https://workers.dev/',
    'https://bridge.account.workers.dev.example/',
    'https://credential@bridge.account.workers.dev/',
    'http://bridge.account.workers.dev/',
    'https://bridge.account.workers.dev:444/',
  ])('rejects a lookalike or unsupported Worker origin: %s', (url) => {
    expect(isSetupAgentUrl(new URL(url))).toBe(false)
  })
})

describe('authorized Fork identity across public page layouts', () => {
  const repo = 'test-user/SRL-Discord-Bridge'
  it.each(['', '/', '/tree/main', '/new-layout/synchronization'])(
    'accepts the bound repository at %s without requiring its homepage',
    (path) => {
      expect(isSetupForkPage(new URL(`https://github.com/${repo}${path}`), repo)).toBe(true)
    },
  )
  it.each([
    `https://github.com/${repo}-copy/tree/main`,
    'https://github.com/other-user/SRL-Discord-Bridge/tree/main',
    `https://github.com.example/${repo}`,
    `https://credential@github.com/${repo}`,
    `http://github.com/${repo}`,
  ])('rejects a different repository or untrusted origin: %s', (url) => {
    expect(isSetupForkPage(new URL(url), repo)).toBe(false)
  })
  it('does not infer an authorized repository from a page when the task has no binding', () => {
    expect(isSetupForkPage(new URL(`https://github.com/${repo}`))).toBe(false)
  })
})
