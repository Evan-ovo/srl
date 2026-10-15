import { describe, expect, it } from 'vitest'
import {
  isSetupAgentUrl,
  isSetupForkPage,
  normalizeDiscordSetupState,
  discordSetupUrl,
  validSetupBranch,
  DISCORD_SETUP_STEPS,
} from './DiscordSetupWorkflow'

it('gives compatible reuse and validation guidance for manual and agent paths', () => {
  const hint = (id: string) => DISCORD_SETUP_STEPS.find((step) => step.id === id)!.hint
  expect(hint('github-fork')).toContain('拥有源仓库则直接复用')
  expect(hint('d1-uuid')).toContain('不要求详情页面显示 UUID')
  expect(hint('wrangler-check')).toContain('JSON/JSONC')
  expect(hint('cf-deploy')).toContain('不能假定 npm run deploy')
  expect(hint('cf-secret')).toContain('已有值先核验，不重复添加')
  expect(hint('local-settings')).toContain('代理可回填')
})

describe('Worker public page authority', () => {
  it.each(['/', '/interactions', '/health'])('allows the deployed Worker at %s', (path) => {
    expect(isSetupAgentUrl(new URL(`https://preview-abc.bridge.account.workers.dev${path}`))).toBe(
      true,
    )
  })
  it.each([
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

it('retains an owner source binding and actual branch/file when continuing a task', () => {
  const state = normalizeDiscordSetupState({
    task: 'configure',
    step: 'wrangler-edit',
    startedAt: 1,
    forkRepo: 'jixiangruyi117/SRL-Discord-Bridge',
    repositoryKind: 'owned-source',
    githubBranch: 'release/stable',
    githubFile: 'wrangler.json',
  })!
  expect(state).toMatchObject({
    repositoryKind: 'owned-source',
    githubBranch: 'release/stable',
    githubFile: 'wrangler.json',
  })
  expect(discordSetupUrl(state)).toBe(
    'https://github.com/jixiangruyi117/SRL-Discord-Bridge/edit/release%2Fstable/wrangler.json',
  )
  expect(validSetupBranch('release/stable')).toBe(true)
  expect(validSetupBranch('../main')).toBe(false)
  expect(validSetupBranch('main?code=secret')).toBe(false)
})
