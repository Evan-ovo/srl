import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const projectRoot = resolve(import.meta.dirname, '..')
const readJson = async (path) => JSON.parse(await readFile(resolve(projectRoot, path), 'utf8'))
const buildInfo = await readJson('build-info.json')
const packageJson = await readJson('package.json')
const failures = []

const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

requireValue(
  packageJson.version === buildInfo.webVersion,
  'package.json version 与 webVersion 不一致',
)
requireValue(
  buildInfo.androidVersionName === buildInfo.webVersion,
  'androidVersionName 与 webVersion 不一致',
)
requireValue(
  Number.isInteger(buildInfo.androidVersionCode) && buildInfo.androidVersionCode > 0,
  'androidVersionCode 必须是正整数',
)
// PUBLIC-ONLY: Public keeps its own stable artifact identity and never uses
// the official worker release version format.
if (buildInfo.buildId.startsWith('srl-public-')) {
  const publicWorkerVersion = /^public-sync-release-\d+-(v\d+)$/u.exec(
    buildInfo.workerDeployVersion,
  )
  const publicBuildVersion = /^srl-public-(\d+\.\d+\.\d+)-(v\d+)$/u.exec(buildInfo.buildId)
  requireValue(Boolean(publicWorkerVersion), 'Public workerDeployVersion 格式无效')
  requireValue(Boolean(publicBuildVersion), 'Public buildId 格式无效')
  requireValue(
    publicBuildVersion?.[1] === buildInfo.webVersion,
    'Public buildId 未包含当前 webVersion',
  )
  requireValue(
    publicBuildVersion?.[2] === publicWorkerVersion?.[1],
    'Public buildId 与 workerDeployVersion 修订号不一致',
  )
} else {
  requireValue(/^v\d+$/u.test(buildInfo.workerDeployVersion), 'workerDeployVersion 必须为 v + 数字')
  requireValue(
    buildInfo.buildId === `srl-${buildInfo.webVersion}-${buildInfo.workerDeployVersion}`,
    'buildId 未包含当前 webVersion 与 workerDeployVersion',
  )
}
for (const field of ['databaseVersion', 'bridgeProtocolVersion', 'nativeApiVersion']) {
  requireValue(Number.isInteger(buildInfo[field]) && buildInfo[field] > 0, `${field} 必须是正整数`)
}

const sourceChecks = [
  ['android/app/build.gradle', 'buildInfo.androidVersionCode'],
  ['android/nativeapp/build.gradle', 'buildInfo.androidVersionCode'],
  ['src/database/AppDatabase.ts', 'BUILD_INFO.databaseVersion'],
  ['src/services/TavernBridgeProtocol.ts', 'BUILD_INFO.bridgeProtocolVersion'],
  ['cloudflare/WorkerAssets.js', 'buildInfo.workerDeployVersion'],
  ['cloudflare/Worker.js', "from './WorkerAssets.js'"],
  [
    'android/app/src/main/java/buzz/jixiangruyi1207/srl/NativePlatformPlugin.java',
    'BuildConfig.SRL_NATIVE_API_VERSION',
  ],
  [
    'android/app/src/main/java/buzz/jixiangruyi1207/srl/NativePreviewAssetPlugin.java',
    'BuildConfig.VERSION_NAME',
  ],
]
for (const [path, marker] of sourceChecks) {
  const source = await readFile(resolve(projectRoot, path), 'utf8')
  requireValue(source.includes(marker), `${path} 未读取统一 BuildInfo`)
}

if (failures.length) {
  throw new Error(`BuildInfo 校验失败：\n- ${failures.join('\n- ')}`)
}
process.stdout.write(`BuildInfo 一致：${buildInfo.buildId}\n`)
