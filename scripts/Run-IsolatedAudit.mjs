import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { startAuditPreview } from './AuditPreviewServer.mjs'
import { createAuditApiFixture } from './AuditEnvironment.mjs'

export const AUDIT_SUITES = {
  // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=privacy-audit-suite
  'public-privacy': 'scripts/PublicPrivacyAudit.mjs',
  // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=privacy-audit-suite
  'album-controls': 'scripts/AlbumControlsAudit.mjs',
  'safe-area-overlays': 'scripts/SafeAreaOverlaysAudit.mjs',
  startup: 'scripts/StartupLoadingAudit.mjs',
  'installable-appearance': 'scripts/InstallableAppearanceAudit.mjs',
  'discord-markdown': 'scripts/DiscordMarkdownLayoutAudit.mjs',
  'discord-handoff': 'scripts/DiscordHandoffPageAudit.mjs',
  'discord-inbox': 'scripts/DiscordInboxUiAudit.mjs',
  'discord-setup': 'scripts/DiscordSetupUiAudit.mjs',
  'official-apps': 'scripts/OfficialAppLifecycleAudit.mjs',
  appearance: 'scripts/AppearanceScopeAudit.mjs',
  'outer-appearance': 'scripts/OuterAppearanceAudit.mjs',
  'resident-appearance': 'scripts/ResidentAppearanceAudit.mjs',
  'ui-customization': 'scripts/UiCustomizationAudit.mjs',
  'appearance-reference': 'scripts/AppearanceReferenceAudit.mjs',
  'home-expansion': 'scripts/HomeExpansionWidthAudit.mjs',
  'detail-layout': 'scripts/ResourceDetailLayoutAudit.mjs',
  'world-book': 'scripts/WorldBookBrowserAudit.mjs',
  'storage-settings': 'scripts/ResourceRecoveryAudit.mjs',
  'intake-files': 'scripts/NativeIntakeFilesAudit.mjs',
  stress: 'scripts/BrowserStressAudit.mjs',
  assistant: 'scripts/ProductAssistantPetAudit.mjs',
  'api-config': 'scripts/ApiConfigurationAudit.mjs',
  'relay-settings': 'scripts/RelayWorkerSettingsAudit.mjs',
  'tag-version': 'scripts/TagVersionPerformanceAudit.mjs',
  'reader-scripts': 'scripts/ChatReaderScriptsAudit.mjs',
  'reader-startup': 'scripts/ChatReaderAudit.mjs',
  'reader-native': 'scripts/ChatReaderAudit.mjs',
  'app-entry': 'scripts/AppEntryAudit.mjs',
  'chat-script-transfer': 'scripts/ChatScriptTransferAudit.mjs',
  'preview-loading': 'scripts/GreetingPreviewLoadingAudit.mjs',
  'assistant-workflows': 'scripts/ProductAssistantWorkflowAudit.mjs',
  'assistant-tasks': 'scripts/ProductAssistantTaskAudit.mjs',
  'tavern-live': 'scripts/TavernLiveTransferAudit.mjs',
}

export function parseAuditArguments(args) {
  const options = {}
  const allowed = new Set(['suite', 'run', 'port', 'dist', 'next-dist', 'engine'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/u, '')
    if (!allowed.has(key) || !args[index].startsWith('--') || !args[index + 1] || key in options)
      throw new Error(`无效的测试参数：${args[index]}`)
    options[key] = args[index + 1]
  }
  if (!Object.hasOwn(AUDIT_SUITES, options.suite))
    throw new Error(`请选择 ${Object.keys(AUDIT_SUITES).join('、')}`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(options.run || ''))
    throw new Error('必须通过 --run 指定本次独立运行名称')
  const port = Number(options.port)
  if (!/^\d+$/u.test(options.port || '') || port < 1024 || port > 65535 || port === 5173)
    throw new Error('必须明确指定隔离端口（1024～65535，保留人工验收的 5173）')
  const engine = options.engine || 'chromium'
  if (
    !['chromium', 'webkit'].includes(engine) ||
    (options.suite === 'stress' && engine !== 'chromium')
  )
    throw new Error('压力测试只支持 Chromium；其他审计可选 Chromium/WebKit')
  if (options['next-dist'] && options.suite !== 'official-apps')
    throw new Error('下一版本候选仅用于 official-apps 更新审计')
  return {
    ...options,
    port,
    engine,
    dist: resolve(options.dist || 'dist'),
    nextDist: options['next-dist'] ? resolve(options['next-dist']) : undefined,
  }
}

export function runAuditCommand(script, args = [], env = process.env, control) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: control ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      windowsHide: true,
    })
    if (control)
      child.on('message', (message) => {
        if (message?.type === 'srl-audit-upgrade' && control.upgrade) {
          control.upgrade()
          child.send({ type: 'srl-audit-upgrade-ready', id: message.id })
          return
        }
        if (message?.type !== 'srl-audit-network' || typeof message.offline !== 'boolean') return
        control(message.offline)
        child.send({ type: 'srl-audit-network-ready', id: message.id })
      })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      if (code === 0) accept()
      else reject(new Error(`${script}: ${signal || `退出码 ${code}`}`))
    })
  })
}

// A gate group may share expensive validation. Standalone audits always validate fully.
export function createAuditValidationSession(command = runAuditCommand, read = readFile) {
  const inventories = new Map()
  const httpChecked = new Set()
  const fingerprint = async (directory) =>
    createHash('sha256')
      .update(await read(resolve(directory, 'official-app-assets.json')))
      .digest('hex')
  return {
    async local(directory) {
      directory = resolve(directory)
      const current = await fingerprint(directory)
      if (inventories.has(directory)) {
        if (inventories.get(directory) !== current) throw new Error('共用候选产物清单发生变化')
        return
      }
      await command('scripts/Check-OfficialAppPackages.mjs', [directory])
      if (current !== (await fingerprint(directory)))
        throw new Error('校验期间候选产物清单发生变化')
      inventories.set(directory, current)
    },
    async http(url, directory) {
      directory = resolve(directory)
      if (!inventories.has(directory)) throw new Error('必须先校验本地候选')
      if (httpChecked.has(directory)) return
      await command('scripts/Verify-OfficialAppDeployment.mjs', [url])
      httpChecked.add(directory)
    },
    async finish() {
      for (const [directory, original] of inventories) {
        if (original !== (await fingerprint(directory))) throw new Error('共用候选产物清单发生变化')
        // Also catches replaced asset/package bytes with an unchanged inventory.
        await command('scripts/Check-OfficialAppPackages.mjs', [directory])
      }
    },
  }
}

export async function runIsolatedAudit(options, validation) {
  const checkLocal = validation
    ? (directory) => validation.local(directory)
    : (directory) => runAuditCommand('scripts/Check-OfficialAppPackages.mjs', [directory])
  const output = resolve('.codex-tmp', options.run)
  await mkdir(resolve('.codex-tmp'), { recursive: true })
  // Exclusive reservation prevents two chats from overwriting evidence under one run name.
  await mkdir(output)
  const result = {
    run: options.run,
    suite: options.suite,
    engine: options.engine,
    offlineMethod:
      options.suite === 'official-apps'
        ? options.engine === 'webkit'
          ? 'isolated-origin-unreachable'
          : 'browser-offline'
        : undefined,
    status: 'blocked',
    steps: [],
  }
  let preview
  let phase = '产物完整性预检'
  try {
    if (
      [
        'safe-area-overlays',
        'discord-markdown',
        'discord-handoff',
        'discord-inbox',
        'discord-setup',
        'preview-loading',
        'album-controls',
        // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=privacy-audit-isolated
        'public-privacy',
        // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=privacy-audit-isolated
        'startup',
      ].includes(options.suite)
    ) {
      phase =
        options.suite === 'safe-area-overlays'
          ? '独立弹层安全区组件隔离浏览器审计'
          : options.suite === 'startup'
            ? '启动会话与返回隔离浏览器审计'
            : options.suite === 'discord-markdown'
              ? 'Discord 帖子 Markdown 排版隔离浏览器审计'
              : options.suite === 'discord-setup'
                ? 'Discord 网页协助组件隔离浏览器审计'
                : options.suite === 'preview-loading'
                  ? '开场白渐进加载组件隔离浏览器审计'
                  : options.suite === 'discord-inbox'
                    ? '收件箱组件隔离浏览器审计'
                    : 'Worker 接收页隔离浏览器审计'
      // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=privacy-audit-label
      if (options.suite === 'public-privacy') phase = 'Public隐私说明与联网偏好隔离浏览器审计'
      // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=privacy-audit-label
      await runAuditCommand(AUDIT_SUITES[options.suite], [], {
        ...process.env,
        SRL_AUDIT_MODE: 'fixture',
        SRL_AUDIT_RUN: options.run,
        SRL_AUDIT_ENGINE: options.engine,
        SRL_AUDIT_OUTPUT_DIR: resolve(output, 'results'),
        SRL_PREVIEW_URL: `http://127.0.0.1:${options.port}`,
        SRL_BOOT_AUDIT_PORT: String(options.port),
        SRL_AUDIT_DIST: options.dist,
      })
      result.steps.push(phase)
      result.status = 'passed'
      console.log(`${phase}通过：${options.run} / ${options.engine}`)
      return result
    }
    await checkLocal(options.dist)
    const inventoryPath = resolve(options.dist, 'official-app-assets.json')
    const original = await readFile(inventoryPath)
    result.buildId = JSON.parse(original).shellVersion
    const fingerprint = createHash('sha256').update(original).digest('hex')
    let nextFingerprint
    if (options.nextDist) {
      await checkLocal(options.nextDist)
      nextFingerprint = createHash('sha256')
        .update(await readFile(resolve(options.nextDist, 'official-app-assets.json')))
        .digest('hex')
    }
    result.steps.push(phase)
    phase = '隔离服务启动'
    preview = await startAuditPreview({
      directory: options.dist,
      nextDirectory: options.nextDist,
      port: options.port,
      run: options.run,
      apiFixture: createAuditApiFixture(options.run),
      bridgeUrl: options.suite === 'tavern-live' ? process.env.SRL_AUDIT_RELAY_URL : undefined,
    })
    phase = '下载清单与安装包 HTTP 预检'
    if (validation) await validation.http(preview.url, options.dist)
    else await runAuditCommand('scripts/Verify-OfficialAppDeployment.mjs', [preview.url])
    result.steps.push(phase)
    phase = '浏览器功能审计'
    result.status = 'failed'
    const control = preview.setNetworkUnavailable
    control.upgrade = preview.activateNext
    await runAuditCommand(
      AUDIT_SUITES[options.suite],
      [],
      {
        ...process.env,
        SRL_AUDIT_MODE: 'fixture',
        SRL_AUDIT_FIXTURE_TRANSPORT: 'http',
        SRL_AUDIT_RUN: options.run,
        SRL_AUDIT_ENGINE: options.engine,
        SRL_AUDIT_OUTPUT_DIR: resolve(output, 'results'),
        SRL_PREVIEW_URL: preview.url,
        SRL_AUDIT_BASE_URL: preview.url + '/',
        SRL_AUDIT_NETWORK_CONTROL: 'ipc',
        SRL_AUDIT_NEXT_DIST: options.nextDist || '',
      },
      control,
    )
    result.steps.push(phase)
    phase = '候选产物未被并行构建替换'
    if (
      createHash('sha256')
        .update(await readFile(inventoryPath))
        .digest('hex') !== fingerprint
    )
      throw new Error('测试期间产物清单发生变化，请使用该聊天独立的 --dist')
    await checkLocal(options.dist)
    if (options.nextDist) {
      if (
        createHash('sha256')
          .update(await readFile(resolve(options.nextDist, 'official-app-assets.json')))
          .digest('hex') !== nextFingerprint
      )
        throw new Error('下一版本候选测试期间被替换')
      await checkLocal(options.nextDist)
      result.steps.push('同源真实SW更新与安装保留')
    }
    result.steps.push(phase)
    result.status = 'passed'
    console.log(`隔离审计通过：${options.run} / ${result.buildId} / ${options.engine}`)
  } catch (error) {
    result.failure = { phase, message: error.message }
    throw new Error(`${phase}：${error.message}`, { cause: error })
  } finally {
    if (preview) await preview.close()
    await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runIsolatedAudit(parseAuditArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
