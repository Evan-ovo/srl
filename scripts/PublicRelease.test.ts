import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import {
  packageRelease,
  prepareRelease,
  productCommit,
  releaseBuildInfo,
} from './PublicRelease.mjs'
import { loadPublicWeb, unpackPublicWeb } from './Build-PublicWeb.mjs'
import { parseGitHubApkRelease } from '../src/core/GitHubAndroidApkRelease'

const commit = 'a'.repeat(40)
const repository = 'owner/project'
const buildInfo = { buildId: 'public-test', webVersion: '0.0.243' }
function fixture(extra = {}) {
  const bytes = zipSync({
    'index.html': new Uint8Array([1]),
    'sw.js': new Uint8Array([2]),
    '__public-build-info.json': new TextEncoder().encode(JSON.stringify(buildInfo)),
    ...extra,
  })
  const manifest = {
    repository,
    sourceCommit: commit,
    buildInfo,
    web: {
      name: 'public-web.zip',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
  return { bytes, manifest }
}
describe('Public release candidate', () => {
  it('reuses a product across documentation syncs and publishes the exact named APK and web bytes', async () => {
    const parent = resolve('.codex-tmp')
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(resolve(parent, '20261018-release-script-'))
    if (
      !root.startsWith(parent + sep) ||
      !root.startsWith(resolve(parent, '20261018-release-script-'))
    )
      throw new Error('Unsafe fixture path')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
    try {
      git('init', '-b', 'main')
      git('config', 'user.name', 'Release fixture')
      git('config', 'user.email', 'fixture@users.noreply.github.com')
      writeFileSync(
        resolve(root, 'build-info.json'),
        JSON.stringify({ webVersion: '1.0.0', androidVersionName: '1.0.0' }),
      )
      writeFileSync(
        resolve(root, 'public-release.config.json'),
        JSON.stringify({ applicationId: 'app.srl.publicedition' }),
      )
      git('add', '--', 'build-info.json', 'public-release.config.json')
      git('commit', '-m', 'product')
      const product = productCommit(root)
      writeFileSync(resolve(root, 'README.md'), 'documentation only')
      git('add', '--', 'README.md')
      git('commit', '-m', 'docs')
      expect(productCommit(root)).toBe(product)
      const shallow = resolve(root, 'shallow-checkout')
      execFileSync('git', ['clone', '--depth=1', pathToFileURL(root).href, shallow], {
        stdio: 'pipe',
      })
      expect(
        execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: shallow })
          .toString()
          .trim(),
      ).toBe('true')
      expect(productCommit(shallow)).toBe(product)
      expect(prepareRelease(root)).toMatchObject({
        sourceCommit: product,
        tag: `public-${product}`,
        versionCode: 1000001,
      })
      mkdirSync(resolve(root, 'dist'))
      writeFileSync(resolve(root, 'dist/index.html'), 'web bytes')
      writeFileSync(resolve(root, 'dist/sw.js'), 'service worker bytes')
      const apk = resolve(root, 'input.apk')
      writeFileSync(apk, new Uint8Array([1, 2, 3]))
      const output = resolve(root, 'packaged')
      const result = await packageRelease(root, apk, repository, output)
      expect(readFileSync(resolve(output, result.apkName))).toEqual(readFileSync(apk))
      expect(result.apkName).toBe('SRL_Pubilc.apk')
      // The updater consumes the actual published asset, not an independently generated index.
      expect(
        parseGitHubApkRelease(
          JSON.parse(readFileSync(resolve(output, 'public-release.json'), 'utf8')),
          repository,
        ),
      ).toMatchObject({
        versionCode: result.versionCode,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
        apkUrl: `https://github.com/${repository}/releases/download/public-${product}/SRL_Pubilc.apk`,
      })
      const files = unpackPublicWeb(readFileSync(resolve(output, 'public-web.zip')), result)
      expect(new TextDecoder().decode(files['index.html'])).toBe('web bytes')
      expect(readFileSync(resolve(output, 'release-notes.md'), 'utf8')).toContain(
        `"sourceCommit":"${product}"`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('generates monotonic versions independently of upstream Android numbering', () => {
    expect(
      releaseBuildInfo({ webVersion: '1', androidVersionName: '1' }, 20).androidVersionCode,
    ).toBe(1000020)
    expect(releaseBuildInfo({ webVersion: '1' }, 21).androidVersionCode).toBe(1000021)
    expect(() => releaseBuildInfo({}, 0)).toThrow()
  })
  it('restores exactly the web bytes and strips the build envelope', () => {
    const { bytes, manifest } = fixture()
    expect(unpackPublicWeb(bytes, manifest)).toEqual({
      'index.html': new Uint8Array([1]),
      'sw.js': new Uint8Array([2]),
    })
    expect(() => unpackPublicWeb(bytes.slice(1), manifest)).toThrow('SHA-256')
    expect(() => unpackPublicWeb(bytes, { ...manifest, buildInfo: {} })).toThrow('构建身份')
  })
  it.each(['../escape', '/absolute', 'C:/drive', 'nested/../../escape', 'bad\\path'])(
    'rejects archive traversal %s',
    (path) => {
      const { bytes, manifest } = fixture({ [path]: new Uint8Array([3]) })
      expect(() => unpackPublicWeb(bytes, manifest)).toThrow('不安全路径')
    },
  )
  it('waits for the exact candidate once and downloads its complete archive once', async () => {
    const { bytes, manifest } = fixture()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json(manifest))
      .mockResolvedValueOnce(new Response(bytes))
    const sleep = vi.fn(async () => {})
    const result = await loadPublicWeb(repository, commit, { fetcher, sleep })
    expect(result.manifest.sourceCommit).toBe(commit)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([url]) => url.includes(`public-${commit}/`))).toBe(true)
  })
  it('fails a missing or wrong candidate without falling back to latest', async () => {
    await expect(
      loadPublicWeb(repository, commit, {
        waitMs: 0,
        fetcher: async () => new Response('', { status: 404 }),
      }),
    ).rejects.toThrow('尚不可用')
    const { manifest } = fixture()
    await expect(
      loadPublicWeb(repository, commit, {
        fetcher: async () => Response.json({ ...manifest, sourceCommit: 'b'.repeat(40) }),
      }),
    ).rejects.toThrow('当前产品提交')
  })
})
