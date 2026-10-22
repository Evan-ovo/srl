/* global document, localStorage */
// SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=public-privacy-browser-audit
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { auditEnvironment, launchAuditBrowser } from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'
const environment = auditEnvironment(undefined, 'public-privacy')
if (!process.env.SRL_AUDIT_RUN) throw Error('Use audit:isolated with explicit run and port')
const fixture = resolve('.codex-tmp', environment.run, 'fixture')
const path = (value) => resolve(value).replaceAll('\\', '/')
await mkdir(fixture, { recursive: true })
await mkdir(environment.outputDir, { recursive: true })
const files = {
  'index.html':
    '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="srl-independent-page-outlet" class="srl-independent-page-outlet"></div><div id="app"></div><script type="module" src="/main.js"></script>',
  'Capacitor.js': `export const Capacitor = {isNativePlatform:()=>true,getPlatform:()=> 'android'};export const registerPlugin = () => ({getCurrentVersion:async()=>({versionCode:1,versionName:'1'}),setAcknowledgedVersion:async()=>undefined,getAcknowledgedVersion:async()=>({version:''})});`,
  'Platform.js': `import {checkForAndroidAppUpdate} from '${path('src/core/AndroidAppUpdate.ts')}';export const platform = {update:{isAndroidApk:()=>true,check:checkForAndroidAppUpdate},security:{getState:async()=>null},backup:{getStatus:async()=>null},systemUi:{getState:async()=>null}}`,
  'Container.js': `import {BrowserStorageService} from '${path('src/services/BrowserStorageService.ts')}';export const browserStorageService=new BrowserStorageService();export const discordInboxAutomationSettingsService={load:async()=>({}),save:async()=>undefined};`,
  'Pwa.js': 'export const registerSW=()=>()=>undefined;',
  'Mirror.js': 'export const getNativeResourceStorageInfo=async()=>null',
  'Haptics.js':
    'export const triggerNativeHaptic=()=>undefined;export const isNativeHapticsEnabled=()=>false;export const setNativeHapticsEnabled=()=>undefined;',
  'Empty.vue': '<template><span hidden></span></template>',
  'View.vue': `<script setup>
import {ref} from 'vue'
import Notice from '${path('src/components/ProjectNoticeDialog.vue')}'
import Settings from '${path('src/components/LayoutSettingsPanel.vue')}'
import {acknowledgeProjectNotice,hasAcknowledgedProjectNoticePersisted} from '${path('src/services/BrowserDevicePreferences.ts')}'
import {installAndroidAppUpdateChecks} from '${path('src/core/AndroidAppUpdate.ts')}'
const notice=ref(!(await hasAcknowledgedProjectNoticePersisted())),settings=ref(false)
installAndroidAppUpdateChecks()
function acknowledge(){acknowledgeProjectNotice();notice.value=false}
const props={vaultEnabled:false,allowRemotePreviews:false,allowScriptPreviews:false,preloadGreetingPreviews:false,preloadBeautificationPreviews:false,extractCharacterAssets:false,hideCharacterAssets:false,hideChatDisplayRegex:false,showManuallyBoundResources:false,blurThumbnails:false,autoDownloadDiscordShareLinks:false,persistResourceVersionMatchCache:false,skipVersionComparisonOnImport:false,showPerformanceMonitor:false,hiddenCharacterAssetCount:0}
</script><template><button type="button" @click="settings=true">打开设置</button><Teleport to="#srl-independent-page-outlet"><Settings v-if="settings" v-bind="props" @close="settings=false"/></Teleport><Notice :open="notice" @acknowledged="acknowledge"/></template>`,
  'main.js': `import {createApp,h,Suspense} from 'vue';import View from './View.vue';import '${path('src/styles/Foundation.css')}';import '${path('src/styles/DesignSystemRefinement.css')}';import '${path('src/Styles.css')}';import '${path('src/styles/ProjectNoticeDialog.css')}';document.documentElement.dataset.theme=localStorage.getItem('privacy-audit-theme')||'light';document.documentElement.style.setProperty('--app-viewport-height',window.innerHeight+'px');createApp({render:()=>h(Suspense,null,{default:()=>h(View)})}).mount('#app');`,
}
for (const [name, source] of Object.entries(files)) await writeFile(resolve(fixture, name), source)
const aliases = [
  { find: 'virtual:pwa-register', replacement: resolve(fixture, 'Pwa.js') },
  { find: '@capacitor/core', replacement: resolve(fixture, 'Capacitor.js') },
  ...['LibraryContainer', 'PlatformService', 'NativeHaptics'].map((name, index) => ({
    find: new RegExp(`/core/${name}\\.ts$|^\\.\\./core/${name}$`),
    replacement: resolve(fixture, ['Container.js', 'Platform.js', 'Haptics.js'][index]),
  })),
  { find: /^\.\.\/storage\/NativeResourceFileMirror$/, replacement: resolve(fixture, 'Mirror.js') },
  ...[
    'MainApiSettings',
    'RelayWorkerSettings',
    'SecretProtectionSettings',
    'ResourceHealthCenter',
    'LocalDataResetControls',
  ].map((name) => ({
    find: new RegExp(`^\\./${name}\\.vue$`),
    replacement: resolve(fixture, 'Empty.vue'),
  })),
]
await build({
  configFile: false,
  root: fixture,
  plugins: [vue()],
  resolve: { alias: aliases },
  build: { outDir: resolve(fixture, 'dist'), emptyOutDir: false, target: 'esnext', minify: false },
  logLevel: 'warn',
})
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(environment.baseUrl).port),
  run: environment.run,
})
const browser = await launchAuditBrowser(environment)
const cases = []
try {
  for (const width of [320, 375, 390, 430])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      })
      let requests = 0
      const errors = []
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript((theme) => {
        localStorage.setItem('privacy-audit-theme', theme)
      }, theme)
      await page.route('https://github.com/**/public-release.json', (route) => {
        requests++
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            repository: 'jixiangruyi117/SillyTavernResourceLibrary-Public',
            applicationId: 'app.srl.publicedition',
            versionCode: 1,
            versionName: '1',
            sha256: 'a'.repeat(64),
            sizeBytes: 123,
            apkName: 'SRL_Pubilc.apk',
            sourceCommit: 'a'.repeat(40),
          }),
        })
      })
      await page.goto(preview.url)
      const notice = page.getByRole('dialog', { name: '使用前说明' })
      await notice.waitFor()
      assert.equal(
        await notice.getByRole('checkbox', { name: '自动检查 APK 更新' }).isChecked(),
        false,
      )
      const body = notice.locator('.project-notice__body')
      await body.locator('section').last().scrollIntoViewIfNeeded()
      await page.waitForTimeout(5100)
      assert.equal(requests, 0, 'unread/opted-out startup must not request GitHub')
      await notice.getByRole('button', { name: '我已阅读，进入资源库' }).tap()
      await page.getByRole('button', { name: '打开设置' }).tap()
      const settings = page.getByRole('main', { name: '设置', exact: true })
      const toggle = settings.getByRole('checkbox', { name: '自动检查 APK 更新' })
      const toggleRow = toggle.locator('..')
      await toggleRow.scrollIntoViewIfNeeded()
      await toggleRow.tap()
      await page.waitForFunction(
        () => localStorage.getItem('srl.apk-update.last-check-at') !== null,
      )
      await page.waitForTimeout(100)
      assert.equal(requests, 1)
      await toggleRow.tap()
      assert.equal(
        await page.evaluate(() => localStorage.getItem('srl.apk-update.automatic-enabled.v1')),
        'false',
      )
      await settings.getByRole('button', { name: '检查 APK 版本更新' }).tap()
      await page.waitForTimeout(150)
      assert.equal(requests, 2, 'manual check remains available')
      await settings.getByRole('button', { name: '隐私与网络说明' }).tap()
      await notice.waitFor()
      assert.equal(await notice.getByRole('button', { name: '关闭说明' }).isEnabled(), true)
      assert.equal(await notice.getByRole('checkbox').count(), 0)
      for (const summary of await notice.locator('summary').all()) {
        await summary.scrollIntoViewIfNeeded()
        await summary.tap()
      }
      const overflow = await notice.evaluate((element) => ({
        shell: element.scrollWidth - element.clientWidth,
        body:
          element.querySelector('.project-notice__body').scrollWidth -
          element.querySelector('.project-notice__body').clientWidth,
      }))
      assert.ok(overflow.shell <= 1 && overflow.body <= 1, JSON.stringify(overflow))
      for (const summary of await notice.locator('summary').all()) {
        await summary.scrollIntoViewIfNeeded()
        await summary.tap()
      }
      await body.evaluate((element) => {
        element.scrollTop = 0
      })
      await notice.getByRole('button', { name: '关闭说明' }).focus()
      if (width === 390)
        await page.screenshot({ path: resolve(environment.outputDir, `privacy-${theme}.png`) })
      await notice.getByRole('button', { name: '关闭说明' }).tap()
      assert.equal(
        await settings
          .getByRole('button', { name: '隐私与网络说明' })
          .evaluate((element) => document.activeElement === element),
        true,
      )
      await settings.getByRole('button', { name: '关闭设置', exact: true }).tap()
      await page.reload()
      await page.waitForTimeout(3200)
      assert.equal(await page.getByRole('dialog', { name: '使用前说明' }).count(), 0)
      assert.equal(requests, 2, 'disabled preference persists across reload')
      assert.deepEqual(errors, [])
      cases.push({ width, theme, requests, overflow })
      await context.close()
    }
  await writeFile(
    resolve(environment.outputDir, 'result.json'),
    JSON.stringify({ engine: environment.engine, cases }, null, 2),
  )
  console.log(`Public privacy: ${cases.length} touch/layout/persistence cases passed`)
} finally {
  await browser.close()
  await preview.close()
}
// SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=public-privacy-browser-audit
