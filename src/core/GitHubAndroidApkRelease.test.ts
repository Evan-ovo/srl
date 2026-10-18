// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=github-android-apk-release-tests
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAndroidApkRelease, parseGitHubApkRelease } from './GitHubAndroidApkRelease'

const repository = 'jixiangruyi117/SillyTavernResourceLibrary-Public'
const commit = 'a'.repeat(40)
const manifest = {
  repository,
  applicationId: 'app.srl.publicedition',
  sourceCommit: commit,
  versionCode: 1000012,
  versionName: '0.0.243',
  apkName: 'SRL_Pubilc.apk',
  sizeBytes: 123,
  sha256: 'b'.repeat(64),
}
afterEach(() => vi.unstubAllGlobals())
describe('GitHub APK release', () => {
  it('reads the static release manifest and constructs a pinned repository download', () => {
    expect(parseGitHubApkRelease(manifest, repository)).toMatchObject({
      versionCode: 1000012,
      sizeBytes: 123,
      sha256: manifest.sha256,
      apkUrl: `https://github.com/${repository}/releases/download/public-${commit}/SRL_Pubilc.apk`,
    })
  })
  it.each([
    { repository: 'other/repository' },
    { applicationId: 'other.app' },
    { sourceCommit: '../bad' },
    { sourceCommit: 'c'.repeat(39) },
    { sizeBytes: 0 },
    { sizeBytes: 1.5 },
    { sha256: 'invalid' },
    { apkName: '../bad.apk' },
    { apkName: 'other.apk?url=https://example.com' },
    { versionCode: -1 },
    { versionCode: '1000012' },
    { versionName: '' },
  ])('rejects an invalid or foreign manifest %j', (change) => {
    expect(() => parseGitHubApkRelease({ ...manifest, ...change }, repository)).toThrow()
  })
  it('rejects malformed and API release responses instead of trusting their URLs', () => {
    for (const value of [
      null,
      [],
      'invalid',
      { draft: false, tag_name: `public-${commit}`, assets: [] },
    ])
      expect(() => parseGitHubApkRelease(value, repository)).toThrow()
    expect(() => parseGitHubApkRelease(manifest, 'invalid')).toThrow()
    expect(
      parseGitHubApkRelease({ ...manifest, apkUrl: 'https://example.com/bad.apk' }).apkUrl,
    ).toContain(`https://github.com/${repository}/releases/download/`)
  })
  it('uses the anonymous static asset once, following CDN redirects without an API request', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(manifest))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadAndroidApkRelease()).toMatchObject({
      status: 200,
      release: { versionCode: 1000012 },
    })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `https://github.com/${repository}/releases/latest/download/public-release.json`,
      {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
      },
    )
  })
  it.each([404, 403, 429, 503])(
    'returns HTTP %s without an API fallback or retry',
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('', { status }))
      vi.stubGlobal('fetch', fetcher)
      expect(await loadAndroidApkRelease()).toEqual({ status })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
  it('does not use a token or API fallback on network failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadAndroidApkRelease()).rejects.toThrow('offline')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized or non-JSON manifests', async () => {
    const text = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(128 * 1024 + 1) }),
          text,
        }),
    )
    await expect(loadAndroidApkRelease()).rejects.toThrow('过大')
    expect(text).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(128 * 1024 + 1))))
    await expect(loadAndroidApkRelease()).rejects.toThrow('过大')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not a manifest</html>')))
    await expect(loadAndroidApkRelease()).rejects.toThrow()
  })
})
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=github-android-apk-release-tests
