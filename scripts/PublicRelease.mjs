import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextEncoder } from 'node:util'
import process from 'node:process'
import console from 'node:console'
import { zipSync } from 'fflate'

// Keep this list aligned with the release workflow. Documentation-only syncs reuse the last product build.
export const RELEASE_PATHS = [
  'src',
  'android',
  'public',
  'cloudflare',
  'patches',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'build-info.json',
  'capacitor.config.ts',
  'vite.config.ts',
  'public-release.config.json',
  '.github/workflows/public-release.yml',
]
export function productCommit(root = process.cwd()) {
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], options).trim() === 'true') {
    // Workers Builds may use a shallow checkout. Without ancestry a docs-only
    // HEAD looks like a new product and points at a Release that was never built.
    try {
      execFileSync('git', ['fetch', '--unshallow', '--filter=blob:none', 'origin'], options)
    } catch {
      throw new Error('无法补全产品提交历史；请检查构建环境的 Git origin 读取权限后重试')
    }
  }
  return execFileSync('git', ['log', '-1', '--format=%H', '--', ...RELEASE_PATHS], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
}
export function releaseBuildInfo(build, commitCount) {
  if (!Number.isSafeInteger(commitCount) || commitCount < 1 || commitCount > 2_000_000_000)
    throw new Error('无法为发布生成递增 Android versionCode')
  const code = 1_000_000 + commitCount
  return {
    ...build,
    androidVersionCode: code,
    buildId: `srl-public-${build.webVersion}-v${code}`,
    workerDeployVersion: `public-sync-release-${code}-v${code}`,
  }
}
export function prepareRelease(root = process.cwd()) {
  const sourceCommit = productCommit(root)
  const count = Number(
    execFileSync('git', ['rev-list', '--count', sourceCommit], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  )
  const build = releaseBuildInfo(JSON.parse(readFileSync(resolve(root, 'build-info.json'))), count)
  writeFileSync(resolve(root, 'build-info.json'), JSON.stringify(build, null, 2) + '\n')
  return { sourceCommit, tag: `public-${sourceCommit}`, versionCode: build.androidVersionCode }
}
export async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function packageRelease(root, apk, repository, output) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('发布仓库必须为 owner/repo')
  const buildInfo = JSON.parse(readFileSync(resolve(root, 'build-info.json')))
  const sourceCommit = productCommit(root)
  const archive = {}
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('网页产物不能包含符号链接')
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else archive[relative(resolve(root, 'dist'), path).replaceAll('\\', '/')] = readFileSync(path)
    }
  }
  visit(resolve(root, 'dist'))
  if (!archive['index.html'] || !archive['sw.js'])
    throw new Error('网页候选缺少首页或 Service Worker')
  archive['__public-build-info.json'] = new TextEncoder().encode(JSON.stringify(buildInfo))
  mkdirSync(output, { recursive: true })
  const webPath = resolve(output, 'public-web.zip')
  writeFileSync(webPath, zipSync(archive, { level: 1 }))
  copyFileSync(apk, resolve(output, 'SRL_Pubilc.apk'))
  const manifest = {
    repository,
    sourceCommit,
    buildInfo,
    applicationId: JSON.parse(readFileSync(resolve(root, 'public-release.config.json')))
      .applicationId,
    versionCode: buildInfo.androidVersionCode,
    versionName: buildInfo.androidVersionName,
    apkName: 'SRL_Pubilc.apk',
    sha256: await fileSha256(apk),
    sizeBytes: statSync(apk).size,
    web: {
      name: 'public-web.zip',
      sha256: await fileSha256(webPath),
      sizeBytes: statSync(webPath).size,
    },
  }
  writeFileSync(resolve(output, 'public-release.json'), JSON.stringify(manifest, null, 2) + '\n')
  const apkManifest = { ...manifest }
  delete apkManifest.web
  delete apkManifest.buildInfo
  writeFileSync(
    resolve(output, 'release-notes.md'),
    `Public ${manifest.versionName}，构建 ${manifest.versionCode}。\n\n共享功能更新与修复。安装前请保存未完成工作；更新完成由系统确认。\n\n<!-- srl-public-apk:${JSON.stringify(apkManifest)} -->\n`,
  )
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  if (process.argv[2] === 'prepare') {
    const release = prepareRelease(root)
    if (process.env.GITHUB_OUTPUT)
      for (const [key, value] of Object.entries(release))
        writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' })
    console.log(release)
  } else if (process.argv[2] === 'package') {
    const apk = resolve(root, 'android/app/build/outputs/apk/release/app-release.apk')
    if (!existsSync(apk)) throw new Error('缺少已验签的 Release APK')
    await packageRelease(
      root,
      apk,
      process.env.GITHUB_REPOSITORY ||
        JSON.parse(readFileSync('public-release.config.json')).repository,
      resolve(root, '.codex-tmp/public-release'),
    )
  } else throw new Error('用法：node scripts/PublicRelease.mjs prepare|package')
}
