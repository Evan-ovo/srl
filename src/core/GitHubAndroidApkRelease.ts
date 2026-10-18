// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=github-android-apk-release
import config from '../../public-release.config.json'

export const APK_RELEASE_REPOSITORY =
  import.meta.env.VITE_SRL_APK_UPDATE_REPOSITORY || config.repository
const MANIFEST = /<!-- srl-public-apk:(\{[^\n]*\}) -->/u

export function parseGitHubApkRelease(value: unknown, repository = APK_RELEASE_REPOSITORY) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('APK 更新仓库配置无效')
  if (!value || typeof value !== 'object') throw new Error('GitHub Release 格式无效')
  const release = value as {
    draft?: boolean
    prerelease?: boolean
    tag_name?: string
    body?: string
    assets?: Array<{ name: string; browser_download_url: string; size: number; digest?: string }>
  }
  if (release.draft || release.prerelease || !/^public-[a-f0-9]{40}$/u.test(release.tag_name || ''))
    throw new Error('该 Release 不是已发布的 Public APK 版本')
  const body = release.body || ''
  if (body.length > 128 * 1024) throw new Error('GitHub Release 说明过大')
  const match = MANIFEST.exec(body)
  if (!match) throw new Error('该 Release 缺少 Public APK 更新清单')
  const manifest = JSON.parse(match[1]!) as {
    versionCode: number
    versionName: string
    sha256: string
    sizeBytes: number
    apkName: string
    applicationId: string
    sourceCommit: string
  }
  const asset = release.assets?.find((item) => item.name === manifest.apkName)
  if (
    manifest.applicationId !== config.applicationId ||
    !Number.isSafeInteger(manifest.versionCode) ||
    manifest.versionCode <= 0 ||
    typeof manifest.versionName !== 'string' ||
    !manifest.versionName ||
    !/^[a-f0-9]{64}$/iu.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    manifest.sizeBytes <= 0 ||
    release.tag_name !== `public-${manifest.sourceCommit}` ||
    !asset ||
    asset.size !== manifest.sizeBytes ||
    !/^[\w.-]+\.apk$/u.test(manifest.apkName) ||
    asset.browser_download_url !==
      `https://github.com/${repository}/releases/download/${release.tag_name}/${manifest.apkName}` ||
    (asset.digest && asset.digest.toLowerCase() !== `sha256:${manifest.sha256.toLowerCase()}`)
  )
    throw new Error('APK 更新清单、下载来源或完整性信息不一致')
  return {
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    apkUrl: asset.browser_download_url,
    notes: body.replace(MANIFEST, '').trim(),
  }
}

export async function loadAndroidApkRelease(): Promise<{ status: number; release?: unknown }> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(APK_RELEASE_REPOSITORY)) throw new Error('APK 更新仓库配置无效')
  const response = await fetch(
    `https://api.github.com/repos/${APK_RELEASE_REPOSITORY}/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    },
  )
  if (!response.ok) return { status: response.status }
  return { status: response.status, release: parseGitHubApkRelease(await response.json()) }
}
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=github-android-apk-release
