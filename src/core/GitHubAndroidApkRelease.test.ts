// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=github-android-apk-release-tests
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAndroidApkRelease, parseGitHubApkRelease } from './GitHubAndroidApkRelease'

const repository = 'jixiangruyi117/SillyTavernResourceLibrary-Public'
const commit = 'a'.repeat(40)
const manifest = {
  applicationId: 'app.srl.publicedition',
  sourceCommit: commit,
  versionCode: 1000012,
  versionName: '0.0.243',
  apkName: 'SRL_Pubilc.apk',
  sizeBytes: 123,
  sha256: 'b'.repeat(64),
}
function fixture(change = {}) {
  const value = { ...manifest, ...change }
  return {
    draft: false,
    prerelease: false,
    tag_name: `public-${commit}`,
    body: `更新说明\n<!-- srl-public-apk:${JSON.stringify(value)} -->`,
    assets: [
      {
        name: manifest.apkName,
        size: manifest.sizeBytes,
        digest: `sha256:${manifest.sha256}`,
        browser_download_url: `https://github.com/${repository}/releases/download/public-${commit}/${manifest.apkName}`,
      },
    ],
  }
}
afterEach(() => vi.unstubAllGlobals())
describe('GitHub APK release', () => {
  it('resolves only the matching complete APK asset and removes metadata from notes', () => {
    expect(parseGitHubApkRelease(fixture(), repository)).toMatchObject({
      versionCode: 1000012,
      notes: '更新说明',
      sizeBytes: 123,
    })
  })
  it.each([
    { applicationId: 'other.app' },
    { sourceCommit: 'c'.repeat(40) },
    { sizeBytes: 124 },
    { sha256: 'd'.repeat(64) },
    { apkName: '../bad.apk' },
    { versionCode: -1 },
  ])('rejects a mismatched manifest %j', (change) => {
    expect(() => parseGitHubApkRelease(fixture(change), repository)).toThrow()
  })
  it('rejects drafts, missing assets and cross-repository downloads', () => {
    expect(() => parseGitHubApkRelease({ ...fixture(), draft: true }, repository)).toThrow()
    expect(() => parseGitHubApkRelease({ ...fixture(), assets: [] }, repository)).toThrow()
    expect(() => parseGitHubApkRelease(fixture(), 'other/repository')).toThrow()
  })
  it('uses the anonymous API once; an unpublished channel does not start a download', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadAndroidApkRelease()).toEqual({ status: 404 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  })
})
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=github-android-apk-release-tests
