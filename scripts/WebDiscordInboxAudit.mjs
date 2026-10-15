/* global window, document, innerWidth, getComputedStyle */
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import {
  auditEnvironment,
  launchAuditBrowser,
  createAuditStorageContext,
} from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = process.env.SRL_AUDIT_RUN
const output = process.env.SRL_AUDIT_OUTPUT_DIR
if (!run || !output) throw new Error('Use audit:isolated with an explicit run and output')
const fixture = resolve(root, '.codex-tmp', run, 'web-inbox')
const source = (path) => resolve(root, path).replaceAll('\\', '/')
await mkdir(fixture, { recursive: true })
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'main.js'),
  `
import {createApp,h,ref} from 'vue'
import Settings from '${source('src/components/LayoutSettingsPanel.vue')}'
import Mode from '${source('src/components/DiscordNativeInboxMode.vue')}'
import Posts from '${source('src/components/DiscordSourceHandoffIntake.vue')}'
import Activity from '${source('src/components/ProjectActivityCenter.vue')}'
import {noticeCenter,isCompletedNotice} from '${source('src/core/NoticeCenter.ts')}'
import {useLibraryNavigation} from '${source('src/composables/UseLibraryNavigation.ts')}'
import {readAppResumeState} from '${source('src/core/AppResumeState.ts')}'
import {useDiscordResourceInbox} from '${source('src/composables/UseDiscordResourceInbox.ts')}'
import {resourceService,communitySourceService,communitySourceStorage,initializeVaultOnce,vaultService,discordInboxAutomationSettingsService,database,parserRegistry} from '${source('src/core/LibraryContainer.ts')}'
import {saveDiscordSourceConnectionSettings,saveDiscordInboxPairing} from '${source('src/services/DiscordSourceSettingsService.ts')}'
import {pauseWebDiscordInbox,webDiscordInboxState} from '${source('src/services/WebDiscordInboxSession.ts')}'
import {webBackgroundAudioState} from '${source('src/services/WebBackgroundKeepAlive.ts')}'
import '${source('src/styles/Foundation.css')}'
import '${source('src/styles/GlassRefinement.css')}'
import '${source('src/styles/LayoutAndResponsive.css')}'
await initializeVaultOnce()
const pair=async()=>{
await saveDiscordSourceConnectionSettings({workerBaseUrl:'https://worker.example',credentialPersistence:'session'})
await saveDiscordInboxPairing({libraryId:'fixture-library',name:'测试库',secret:'fixture-only',code:'fixture',expiresAt:Date.now()+3600000})
}
await discordInboxAutomationSettingsService.save({bindSameName:true,bindSameAuthor:false,bindNextPng:false,bindForeground:false,preferPngContainer:false,downloadPostMedia:false})
const metrics={parsed:0,imported:0,errors:[],mediaCalls:0,mediaError:'',wav:document.createElement('audio').canPlayType('audio/wav')}
const originalPlay=HTMLMediaElement.prototype.play
HTMLMediaElement.prototype.play=function(){metrics.mediaCalls++;return originalPlay.call(this).catch(error=>{metrics.mediaError=error.name+': '+error.message;throw error})}
const parse=parserRegistry.parse.bind(parserRegistry)
parserRegistry.parse=async(...args)=>{metrics.parsed++;return parse(...args)}
const vault=ref(vaultService.getStatus())
const settingsProps={vaultEnabled:false,allowRemotePreviews:true,allowScriptPreviews:false,preloadGreetingPreviews:true,preloadBeautificationPreviews:true,extractCharacterAssets:false,hideCharacterAssets:false,hideChatDisplayRegex:true,showManuallyBoundResources:true,blurThumbnails:false,autoDownloadDiscordShareLinks:false,persistResourceVersionMatchCache:true,skipVersionComparisonOnImport:false,showPerformanceMonitor:false,hiddenCharacterAssetCount:0}
window.audit={metrics,pair,notices:()=>noticeCenter.list().map(notice=>({id:notice.id,message:notice.message,completed:isCompletedNotice(notice)})),destination:readAppResumeState,states:()=>({audio:webBackgroundAudioState(),inbox:webDiscordInboxState()}),read:async()=>({resources:await database.resources.toArray(),sources:await communitySourceService.listPendingSources(),bindings:await database.resourceSourceBindings.toArray()}),reopen:async()=>{database.close();await database.open();return database.resourceSourceBindings.toArray()},pause:pauseWebDiscordInbox}
createApp({setup(){
  const settingsOpen=ref(true)
  const navigation=useLibraryNavigation(()=>({isFeatureHubOpen:ref(false)}))
  window.addEventListener('srl:native-deep-link',navigation.handleNativeDeepLink)
  useDiscordResourceInbox(vault, async batch=>{
    batch.onProcessingStarted?.()
    try{
      await resourceService.importFiles(batch.files,{completedContentHashes:batch.completedContentHashes,completedImportAliases:batch.completedImportAliases,onItemComplete:async result=>{if(result.status==='imported'){metrics.imported++;await batch.markImportItemCompleted?.(result.resource.contentHash)}await batch.onItemComplete?.(result)}})
      await batch.acknowledge()
    }catch(error){metrics.errors.push(error.message);await batch.onFailure?.(error.message)}
    finally{batch.onProcessingSettled?.()}
  })
  return ()=>h('main',{style:'max-width:640px;margin:auto;padding:16px'},[h('button',{onClick:()=>settingsOpen.value=true},'打开设置'),settingsOpen.value?h(Settings,{...settingsProps,onClose:()=>settingsOpen.value=false}):null,h(Mode),h(Posts),h(Activity)])
}}).mount('#app')
if('serviceWorker' in navigator){await navigator.serviceWorker.register('/sw-share-target.js');await navigator.serviceWorker.ready}
window.audit.ready=true
`,
)
await build({
  configFile: false,
  logLevel: 'warn',
  root: fixture,
  publicDir: false,
  plugins: [
    {
      name: 'web-inbox-unused-preview-fixture',
      resolveId(id) {
        if (id === 'virtual:srl-preview-vendor-globals-source') return '\0inbox-unused-preview'
        if (id === 'virtual:pwa-register') return '\0inbox-unused-update'
      },
      load(id) {
        if (id === '\0inbox-unused-preview') return 'export default ""'
        if (id === '\0inbox-unused-update') return 'export const registerSW=()=>async()=>{}'
      },
    },
    vue(),
  ],
  build: { outDir: resolve(fixture, 'dist'), target: 'esnext' },
})
await copyFile(
  resolve(root, 'public/sw-share-target.js'),
  resolve(fixture, 'dist/sw-share-target.js'),
)
await copyFile(
  resolve(root, 'public/manifest.webmanifest'),
  resolve(fixture, 'dist/manifest.webmanifest'),
)
await mkdir(output, { recursive: true })
const environment = auditEnvironment(undefined, 'web-discord-inbox')
const url = process.env.SRL_PREVIEW_URL
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(url).port),
  run,
})
const browser = await launchAuditBrowser(environment)
const context = await createAuditStorageContext(browser, environment, {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
})
let available = false
let postSaved = false
let imported = false
let downloads = 0
const jobId = '11111111-1111-4111-a111-111111111111'
const unsupportedId = '99999999-9999-4999-a999-999999999999'
let failedAcknowledgements = 0
const card = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '后台收件验收角色',
    description: 'fixture',
    personality: '',
    scenario: '',
    first_mes: '你好',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: 'fixture',
    character_version: '1',
    extensions: {},
  },
})
const capture = {
  channelId: '22222',
  messageId: '33333',
  isStarter: true,
  canonicalUrl: 'https://discord.com/channels/11111/22222/33333',
  authorId: '44444',
  authorName: 'fixture',
  content: '后台收件验收角色',
  title: '后台收件验收角色',
  timestamp: '2026-10-15T00:00:00.000Z',
  attachments: [],
  embeds: [],
  forumTags: [],
}
await context.route('https://worker.example/**', async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname
  let json
  if (path === '/inbox/jobs')
    json = {
      jobs:
        available && !postSaved
          ? [{ id: 'post-fixture', createdAt: 1, state: 'pending', title: capture.title }]
          : [],
      recent: [],
      hasMore: false,
    }
  else if (path === '/inbox/jobs/post-fixture')
    json = {
      capture,
      delivery: { id: 'post-fixture', libraryId: 'fixture-library', capturedAt: 1 },
    }
  else if (path === '/inbox/jobs/post-fixture/ack') {
    postSaved = true
    json = { ok: true }
  } else if (path === '/inbox/waiting-sources') json = { sourceKeyHashes: [], nextCursor: null }
  else if (path === '/inbox/resources')
    json = {
      jobs:
        available && !imported
          ? [
              {
                id: unsupportedId,
                libraryId: 'fixture-library',
                name: 'unsupported.pdf',
                size: 8,
                state: 'queued',
                createdAt: 1,
                updatedAt: 1,
                expiresAt: 9999999999999,
              },
              {
                id: jobId,
                libraryId: 'fixture-library',
                name: 'card.json',
                size: card.length,
                state: 'queued',
                createdAt: 2,
                updatedAt: 2,
                expiresAt: 9999999999999,
              },
            ]
          : [],
      recent: [],
      hasMore: false,
    }
  else if (path === `/inbox/resources/${unsupportedId}/file`) {
    downloads++
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: 'not-card' })
    return
  } else if (
    path === `/inbox/resources/${unsupportedId}/ack` &&
    request.postDataJSON().state === 'failed'
  ) {
    failedAcknowledgements++
    await route.fulfill({ status: 503, body: 'fixture ACK unavailable' })
    return
  } else if (path === `/inbox/resources/${unsupportedId}/ack`) json = { ok: true }
  else if (path === `/inbox/resources/${jobId}/file`) {
    downloads++
    await route.fulfill({ status: 200, contentType: 'application/json', body: card })
    return
  } else if (path === `/inbox/resources/${jobId}/ack`) {
    if (request.postDataJSON().state === 'imported') imported = true
    json = { ok: true }
  } else if (path.endsWith('/ack-bound')) json = { ok: true }
  else throw new Error('Unexpected fixture request ' + path)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await page.goto(url)
  await page.waitForFunction(() => window.audit?.ready === true)
  const start = page.getByRole('checkbox', { name: '后台音频保活', exact: true })
  const audioToggle = start.locator('..')
  await audioToggle.tap()
  await Promise.race([
    page.waitForFunction(() => document.querySelector('input[aria-label="后台音频保活"]')?.checked),
    page
      .getByRole('alert')
      .waitFor()
      .then(async () => {
        throw Error(await page.getByRole('alert').innerText())
      }),
  ])
  if ((await page.evaluate(() => window.audit.states())).inbox.status === 'running')
    throw Error('Audio setting enabled receiving without an explicit inbox action')
  await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
  await page.evaluate(() => window.audit.pair())
  await page.getByRole('button', { name: '开启收件模式', exact: true }).tap()
  await page.getByRole('button', { name: '停止收件', exact: true }).waitFor()
  // Tasks are created only after the retention session starts; they were not buffered at startup.
  const cover = await context.newPage()
  await cover.goto('about:blank')
  await cover.bringToFront()
  const visibility = await page.evaluate(() => document.visibilityState)
  available = true
  await page.waitForFunction(() => window.audit.metrics.imported === 1, {}, { timeout: 45000 })
  await page.waitForFunction(
    async () => (await window.audit.read()).bindings.length === 1,
    {},
    { timeout: 15000 },
  )
  const completed = await page.evaluate(async () => ({
    metrics: window.audit.metrics,
    data: await window.audit.read(),
  }))
  if (
    downloads !== 2 ||
    failedAcknowledgements !== 1 ||
    completed.metrics.imported !== 1 ||
    completed.metrics.errors.length ||
    completed.data.resources.length !== 1
  )
    throw Error('Incomplete or repeated import: ' + JSON.stringify(completed))
  await page.bringToFront()
  await cover.close()
  await page.locator('.activity-center__trigger').tap()
  const history = page.locator('.activity-center__completed')
  for (const width of [320, 375, 390, 430])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      const bounds = await page.locator('#srl-activity-panel').boundingBox()
      const toggle = await history.locator('summary').boundingBox()
      if (
        !bounds ||
        bounds.x < 0 ||
        bounds.x + bounds.width > width ||
        bounds.y < 0 ||
        !toggle ||
        toggle.height < 44
      )
        throw Error('Activity history exceeds the viewport or has a small toggle')
      await page.screenshot({
        path: resolve(output, `activity-${width}-${theme}.png`),
        fullPage: true,
      })
    }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  if ((await history.getAttribute('open')) !== null)
    throw Error('Completed activity was not folded by default')
  if (await history.locator('.activity-card').first().isVisible())
    throw Error('Completed history occupies the pending view')
  await history.locator('summary').tap()
  if (!(await history.locator('.activity-card').first().isVisible()))
    throw Error('Completed history cannot be expanded')
  await history.locator('summary').tap()
  await page.getByRole('button', { name: '查看收件箱', exact: true }).first().tap()
  if (await page.locator('#srl-activity-panel').count())
    throw Error('Inbox navigation left the activity drawer open')
  if ((await page.evaluate(() => window.audit.destination())).subpage !== 'inbox')
    throw Error('Inbox notification did not navigate')
  await page.locator('.activity-center__trigger').tap()
  await page.getByRole('button', { name: '清理完成项', exact: true }).tap()
  const notices = await page.evaluate(() => window.audit.notices())
  if (
    notices.some((notice) => notice.completed) ||
    !notices.some((notice) => notice.message.includes('unsupported.pdf'))
  )
    throw Error('Completed results were not cleared or a failed item was removed')
  await page.getByRole('button', { name: '收起任务与通知', exact: true }).tap()
  await page.getByRole('button', { name: '打开设置', exact: true }).tap()
  if (!(await start.isChecked())) throw Error('Closing settings stopped the audio session')
  await audioToggle.tap()
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="后台音频保活"]')
    return !input?.checked && !input?.disabled
  })
  if ((await page.evaluate(() => window.audit.states())).inbox.status !== 'running')
    throw Error('Stopping global audio stopped receiving')
  await audioToggle.tap()
  await page.waitForFunction(() => window.audit.states().audio.status === 'running')
  await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
  await page.getByRole('button', { name: '停止收件', exact: true }).tap()
  await page.getByRole('button', { name: '开启收件模式', exact: true }).waitFor()
  if ((await page.evaluate(() => window.audit.states())).audio.status !== 'running')
    throw Error('Stopping receiving stopped global audio')
  await page.getByRole('button', { name: '打开设置', exact: true }).tap()
  const notificationStatus = page.locator('.settings-notification-status')
  if ((await notificationStatus.innerText()) !== '授权')
    throw Error('Expected explicit permission entry')
  await context.grantPermissions(['notifications'], { origin: url })
  await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
  await page.getByRole('button', { name: '打开设置', exact: true }).tap()
  if ((await notificationStatus.innerText()) !== '已授权')
    throw Error('Granted state was not reflected')
  const reopened = await page.evaluate(() => window.audit.reopen())
  if (reopened.length !== 1) throw Error('Binding was not durable after reopening IndexedDB')
  for (const width of [320, 375, 390, 430, 768])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw Error('Horizontal overflow')
      await audioToggle.scrollIntoViewIfNeeded()
      const toggle = await audioToggle.boundingBox()
      if (!toggle || toggle.height < 44) throw Error('Small touch target')
      const permissionLayout = await notificationStatus.evaluate((node) => ({
        whiteSpace: getComputedStyle(node).whiteSpace,
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        height: node.clientHeight,
        fontSize: parseFloat(getComputedStyle(node).fontSize),
      }))
      if (
        permissionLayout.whiteSpace !== 'nowrap' ||
        permissionLayout.scrollWidth > permissionLayout.width ||
        permissionLayout.height > permissionLayout.fontSize * 2
      )
        throw Error('Notification permission text wrapped: ' + JSON.stringify(permissionLayout))
      await page.screenshot({
        path: resolve(output, `${environment.engine}-${width}-${theme}.png`),
        fullPage: true,
      })
    }
  const parsed = completed.metrics.parsed
  await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
  await page.getByRole('button', { name: '开启收件模式', exact: true }).tap()
  await page.getByRole('button', { name: '停止收件', exact: true }).waitFor()
  await page.waitForTimeout(500)
  if (downloads !== 2 || (await page.evaluate(() => window.audit.metrics.parsed)) !== parsed)
    throw Error('Foreground/resume replayed a completed file')
  await page.getByRole('button', { name: '停止收件', exact: true }).tap()
  await page.getByRole('button', { name: '打开设置', exact: true }).tap()
  await audioToggle.tap()
  await page.waitForFunction(() => window.audit.states().audio.status === 'off')
  if (errors.length) throw Error(errors.join('\n'))
  await writeFile(
    resolve(output, 'web-inbox.json'),
    JSON.stringify(
      {
        engine: environment.engine,
        visibility,
        downloads,
        failedAcknowledgements,
        parsed,
        imported: completed.metrics.imported,
        durableBindings: reopened.length,
        media: 'real audio playback; OS background retention unverified',
        independentControls:
          'audio without pairing; audio and inbox start/stop do not alter each other',
        notifications: 'API unit coverage; iOS OS display unverified',
        worker: 'fixture',
        storage: 'real IndexedDB',
        completedActivity: 'default folded; real touch expands; pending work stays visible',
        screens: 18,
      },
      null,
      2,
    ),
  )
  console.log('Web inbox browser pipeline passed: ' + environment.engine)
} catch (error) {
  const diagnostics = await page
    .evaluate(() => ({ text: document.body.innerText, metrics: window.audit?.metrics }))
    .catch(() => null)
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify({ error: error.message, errors, diagnostics }, null, 2),
  )
  await page
    .screenshot({ path: resolve(output, 'failure.png'), fullPage: true })
    .catch(() => undefined)
  throw error
} finally {
  await context.close()
  await browser.close()
  await preview.close()
}
