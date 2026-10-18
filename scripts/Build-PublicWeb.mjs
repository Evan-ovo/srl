import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import process from 'node:process'
import console from 'node:console'
import { unzipSync } from 'fflate'
import { productCommit } from './PublicRelease.mjs'
import releaseConfig from '../public-release.config.json' with { type: 'json' }

export function unpackPublicWeb(bytes, manifest) {
  if (
    bytes.length !== manifest.web.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.web.sha256
  )
    throw new Error('网页包大小或 SHA-256 与 Release 不一致')
  let expanded = 0
  const files = unzipSync(bytes, {
    filter(entry) {
      if (
        entry.name.startsWith('/') ||
        entry.name.includes('\\') ||
        entry.name.split('/').some((x) => x === '..' || x === '.') ||
        entry.name.includes(':')
      )
        throw new Error('网页包包含不安全路径')
      expanded += entry.originalSize
      if (expanded > 1024 * 1024 * 1024) throw new Error('网页构建产物超出 1 GiB 校验预算')
      return true
    },
  })
  if (!files['index.html'] || !files['sw.js'] || !files['__public-build-info.json'])
    throw new Error('网页包不完整')
  if (
    new TextDecoder().decode(files['__public-build-info.json']) !==
    JSON.stringify(manifest.buildInfo)
  )
    throw new Error('网页包与发布构建身份不符')
  delete files['__public-build-info.json']
  return files
}
export async function loadPublicWeb(
  repository,
  sourceCommit,
  { fetcher = globalThis.fetch, waitMs = 15 * 60_000, sleep = delay } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw new Error('网页发布来源无效')
  const base = `https://github.com/${repository}/releases/download/public-${sourceCommit}`
  const deadline = Date.now() + waitMs
  let response
  do {
    response = await fetcher(`${base}/public-release.json`, {
      signal: globalThis.AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      cache: 'no-store',
    })
    if (response.ok) break
    if (response.status !== 404 || Date.now() >= deadline)
      throw new Error(
        `对应提交的发布包尚不可用（HTTP ${response.status}）；请检查上游 Public release 工作流/签名配置，然后重试 CF 构建`,
      )
    console.log('对应提交仍在发布中，等待完整网页/APK候选，不部署旧版本…')
    await sleep(Math.min(15_000, Math.max(1, deadline - Date.now())))
  } while (!response.ok)
  const manifest = await response.json()
  if (
    manifest.repository !== repository ||
    manifest.sourceCommit !== sourceCommit ||
    manifest.web?.name !== 'public-web.zip' ||
    !/^[a-f0-9]{64}$/u.test(manifest.web.sha256) ||
    !Number.isSafeInteger(manifest.web.sizeBytes) ||
    manifest.web.sizeBytes < 1 ||
    manifest.web.sizeBytes > 512 * 1024 * 1024
  )
    throw new Error('网页 Release 清单无效或不属于当前产品提交')
  const archive = await fetcher(`${base}/public-web.zip`, {
    cache: 'no-store',
    signal: globalThis.AbortSignal.timeout(5 * 60_000),
  })
  if (!archive.ok) throw new Error(`网页发布包下载失败（HTTP ${archive.status}）`)
  return { files: unpackPublicWeb(new Uint8Array(await archive.arrayBuffer()), manifest), manifest }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  if (existsSync(resolve(root, 'dist')))
    throw new Error('当前目录已有 dist；请使用干净的 CF 构建检出，不覆盖已有产物')
  const { files, manifest } = await loadPublicWeb(
    process.env.SRL_RELEASE_REPOSITORY || releaseConfig.repository,
    productCommit(root),
  )
  for (const [name, bytes] of Object.entries(files)) {
    const file = resolve(root, 'dist', name)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, bytes)
  }
  writeFileSync(
    resolve(root, 'build-info.json'),
    JSON.stringify(manifest.buildInfo, null, 2) + '\n',
  )
  console.log(`已取得同一发布候选 ${manifest.buildInfo.buildId}；网页与APK功能包字节一致`)
}
