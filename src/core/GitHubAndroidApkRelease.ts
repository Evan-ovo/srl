// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=github-android-apk-release
import config from '../../public-release.config.json'

export const APK_RELEASE_REPOSITORY =
  import.meta.env.VITE_SRL_APK_UPDATE_REPOSITORY || config.repository
const MAX_MANIFEST_LENGTH = 128 * 1024

/** The existing Release asset is public CDN content, independent of REST API IP quotas. */
export function parseGitHubApkRelease(value: unknown, repository = APK_RELEASE_REPOSITORY) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('APK 更新仓库配置无效')
  if (!value || typeof value !== 'object') throw new Error('APK 更新清单格式无效')
  const manifest = value as {
    repository: string
    versionCode: number
    versionName: string
    sha256: string
    sizeBytes: number
    apkName: string
    applicationId: string
    sourceCommit: string
  }
  if (
    manifest.repository !== repository ||
    manifest.applicationId !== config.applicationId ||
    !Number.isSafeInteger(manifest.versionCode) ||
    manifest.versionCode <= 0 ||
    typeof manifest.versionName !== 'string' ||
    !manifest.versionName ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    manifest.sizeBytes <= 0 ||
    typeof manifest.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit) ||
    typeof manifest.apkName !== 'string' ||
    !/^[\w.-]+\.apk$/u.test(manifest.apkName)
  )
    throw new Error('APK 更新清单、下载来源或完整性信息不一致')
  return {
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    // Pin the APK to the validated manifest's immutable product tag, never latest or a supplied URL.
    apkUrl: `https://github.com/${repository}/releases/download/public-${manifest.sourceCommit}/${manifest.apkName}`,
  }
}

export async function loadAndroidApkRelease(): Promise<{ status: number; release?: unknown }> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(APK_RELEASE_REPOSITORY)) throw new Error('APK 更新仓库配置无效')
  const response = await fetch(
    `https://github.com/${APK_RELEASE_REPOSITORY}/releases/latest/download/public-release.json`,
    {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
    },
  )
  if (!response.ok) return { status: response.status }
  if (Number(response.headers.get('content-length')) > MAX_MANIFEST_LENGTH)
    throw new Error('APK 更新清单过大')
  const text = await response.text()
  if (text.length > MAX_MANIFEST_LENGTH) throw new Error('APK 更新清单过大')
  return { status: response.status, release: parseGitHubApkRelease(JSON.parse(text)) }
}
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=github-android-apk-release
