/* global document, window, getComputedStyle, innerWidth, HTMLTextAreaElement */
import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build as bundle } from 'esbuild'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { launchAuditBrowser, auditEnvironment } from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'

const root = process.cwd(),
  fixture = resolve(root, '.codex-tmp', process.env.SRL_AUDIT_RUN, 'setup-ui')
const output = resolve(process.env.SRL_AUDIT_OUTPUT_DIR)
const path = (p) => resolve(root, p).replaceAll('\\', '/')
const permissionSource = await readFile(
  resolve(root, 'src/services/DiscordSetupService.ts'),
  'utf8',
)
const permissionText = permissionSource.match(/message:\s*'([^']*)'/u)?.[1]?.replaceAll('\\n', '\n')
if (!permissionText?.includes('本次 Discord Bridge'))
  throw new Error('Permission dialog text not found in its Service owner')
const permissionOptions = JSON.stringify({
  title: '开启蒜惹菈代理模式？',
  centered: true,
  confirmLabel: '确认权限并开启',
  cancelLabel: '暂不开启',
  message: permissionText,
})
await mkdir(output, { recursive: true })
await mkdir(fixture, { recursive: true })
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'main.js'),
  `
import {createApp,h,ref} from 'vue';
import Pet from '${path('src/components/ProductAssistantPet.vue')}';
import Guide from '${path('src/components/DiscordSetupGuideDrawer.vue')}';
import '${path('src/styles/ProductAssistantPet.css')}';
import Setup from '${path('src/components/DiscordSetupAssistant.vue')}';
import Confirm from '${path('src/components/ConfirmDialog.vue')}';
import Header from '${path('src/components/FeatureAppHeader.vue')}';
import '${path('src/styles/ProductAssistant.css')}';
import {confirmAction} from '${path('src/composables/UseConfirmDialog.ts')}';
window.testUnlock=()=>confirmAction({title:'先设置密钥统一密码',centered:true,secretUnlock:true,confirmLabel:'继续配置',cancelLabel:'暂不配置'});
import '${path('src/styles/Foundation.css')}';
import '${path('src/styles/GlassRefinement.css')}';
document.documentElement.dataset.theme=new URL(location.href).searchParams.get('theme')||'light';
const guideOpen=ref(true);const returnView=new URL(location.href).searchParams.get('screen')==='return-browser';createApp({render:()=>returnView?h('section',{class:'product-assistant'},[h(Header,{title:'蒜惹菈',layout:'panel',backLabel:'返回功能桌面',onBack:()=>window.exited=true},{actions:()=>[h('button',{class:'assistant-return-browser',onClick:()=>window.returned=true},'返回网页配置'),h('button',{class:'feature-header-action','aria-label':'聊天设置'},'⋯')]}),h('div',{class:'chat-messages'},[h('article',{class:'chat-message chat-message--assistant'},[h('div',{class:'chat-message__content'},'Discord 授权已完成，返回网页继续配置。')])]),h('form',{class:'chat-composer'},[h('div',{class:'chat-configuration-actions'},[h('span','已暂停'),h('button',{type:'button'},'网页配置操作')]),h('div',{class:'chat-composer__row'},[h('textarea',{placeholder:'说说你想改什么…'})])])]):h('main',{style:'padding:12px'},[h(Confirm),h(Setup),h(Guide,{open:guideOpen.value,onClose:()=>guideOpen.value=false,deploymentMode:'github',applicationId:'',publicKey:'',botToken:'',installationUrl:'',developerAppUrl:'',developerBotUrl:''}),h(Pet,{theme:document.documentElement.dataset.theme,layoutMode:'grid',uiFontScale:'standard',customCss:'',navigate:async()=>{}})])}).mount('#app');
const style=document.createElement('style');style.textContent='body{margin:0;color:var(--color-ink);background:linear-gradient(145deg,var(--color-accent-soft),var(--color-canvas));font-family:sans-serif}';document.head.append(style);
`,
)
const mocks = {
  SecretResourceService: `let unlocked=false;export const secretResourceService={hasPassword:async()=>false,isUnlocked:()=>unlocked,setPassword:async()=>{unlocked=true}}`,
  AppContainer: `import {confirmAction} from '${path('src/composables/UseConfirmDialog.ts')}';export const productAssistantWorkspaceService={preferences:()=>({name:'蒜惹菈',petAssetMode:'svg',petWalkingAnimation:false}),savePreferences:async()=>{}};const saved={task:'configure',step:'wrangler-edit',startedAt:1,mode:'agent'};let permitted=false;const allow=async()=>{if(permitted)return true;permitted=await confirmAction(${permissionOptions});return permitted};export const discordSetupService={current:async()=>saved,start:async(task,from,mode)=>{if(mode==='agent'&&!await allow())return {cancelled:true};window.lastSetup={task,from,mode};return {}},restart:async(task,mode)=>{permitted=false;if(mode==='agent'&&!await allow())return {cancelled:true};window.lastSetup={task,mode};saved.mode=mode;saved.task=task;saved.step=task==='configure'?'discord-app':'discord-install';window.dispatchEvent(new Event('srl:discord-setup-changed'));return {}},resume:async()=>{if(saved.mode==='agent'&&!await allow())return {cancelled:true};window.lastResume={...saved};return {}},open:async()=>{},next:async()=>{window.nextCalled=true}}`,
  AppearanceStudio: `export default {template:'<div>聊天夹具</div>'}`,
  UseProductAssistantPreferences: `import {ref} from 'vue';export const useProductAssistantPreferences=()=>ref({name:'蒜惹菈',petAssetMode:'svg',petWalkingAnimation:false})`,
  ProductAssistantScreenshot: `export const captureAssistantPage=async()=>{}`,
  ProductAssistantPetAssets: `export const loadAssistantPetAssets=async()=>undefined;export const releaseAssistantPetAssets=()=>{};export const downloadAssistantPetAssets=async()=>{}`,
  NativeDiscordSetupBrowser: `import {reactive} from 'vue';export const hasDiscordSetupBrowser=()=>true;export const discordSetupSession=reactive({active:false,browserVisible:false});export const nativeDiscordSetupBrowser={pet:async({dataUrl})=>{window.petFrame=dataUrl}}`,
}
await build({
  configFile: false,
  root: fixture,
  logLevel: 'error',
  plugins: [
    {
      name: 'setup-fixture',
      enforce: 'pre',
      resolveId(source) {
        const name = source
          .split('/')
          .at(-1)
          ?.replace(/\.(ts|vue)$/, '')
        if (Object.hasOwn(mocks, name)) return '\0setup:' + name
      },
      load(id) {
        if (id.startsWith('\0setup:')) return mocks[id.slice(7)]
      },
    },
    vue(),
  ],
  build: { outDir: resolve(fixture, 'dist') },
})
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(process.env.SRL_PREVIEW_URL).port),
  run: process.env.SRL_AUDIT_RUN,
})
const browser = await launchAuditBrowser(auditEnvironment())
let cases = 0
if (process.env.SRL_DISCORD_UI_SCOPE === 'return-browser') {
  try {
    for (const [width, height] of [
      [320, 800],
      [375, 812],
      [390, 844],
      [430, 932],
    ]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height },
          hasTouch: true,
          isMobile: true,
        })
        try {
          const page = await context.newPage()
          await page.goto(process.env.SRL_PREVIEW_URL + '?screen=return-browser&theme=' + theme)
          const button = page.getByRole('button', { name: '返回网页配置', exact: true }).last()
          await button.waitFor()
          const valid = await page.evaluate(() => {
            const title = document.querySelector('.feature-app-header h1').getBoundingClientRect()
            const button = document
              .querySelector('.assistant-return-browser')
              .getBoundingClientRect()
            return (
              document.documentElement.scrollWidth <= innerWidth &&
              title.top < 80 &&
              getComputedStyle(document.querySelector('.chat-composer')).backgroundColor ===
                'rgba(0, 0, 0, 0)' &&
              title.right <= button.left &&
              button.right <= innerWidth
            )
          })
          if (!valid)
            throw new Error('Return header overflows or overlaps at ' + width + '/' + theme)
          await page.getByRole('button', { name: '返回功能桌面', exact: true }).tap()
          if (
            !(await page.evaluate(() => window.exited)) ||
            (await page.evaluate(() => window.returned))
          )
            throw new Error('Back action loops into the browser')
          await button.tap()
          if (!(await page.evaluate(() => window.returned)))
            throw new Error('Return action not dispatched')
          if ((width === 320 && theme === 'light') || (width === 430 && theme === 'dark'))
            await page.screenshot({
              path: resolve(output, 'return-' + width + '-' + theme + '.png'),
            })
          cases++
        } finally {
          await context.close()
        }
      }
    }
    console.log(
      'Return-to-browser header passed: ' +
        cases +
        ' touch viewport/theme cases; native dialog/device not exercised.',
    )
  } finally {
    await browser.close()
    await preview.close()
  }
  process.exit(0)
}
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        isMobile: true,
      })
      await context.route('**/tutorials/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname
        if (!/^\/tutorials\/(?:discord-github\/)?[a-z0-9-]+\.(png|jpg)$/.test(pathname))
          return route.abort()
        await route.fulfill({
          body: await readFile(resolve(root, 'public', pathname.slice(1))),
          contentType: pathname.endsWith('.png') ? 'image/png' : 'image/jpeg',
        })
      })
      try {
        const page = await context.newPage(),
          errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(preview.url + '?theme=' + theme)
        await page.getByText('蒜惹菈网页协助', { exact: true }).waitFor()
        if (await page.locator('select').count())
          throw Error('Debug task selectors are still visible')
        await page.waitForFunction(() => window.petFrame?.startsWith('data:image/png;base64,'))
        if (width === 390 && theme === 'light')
          await writeFile(
            resolve(fixture, 'test-pet.png'),
            Buffer.from(
              await page.evaluate(() => window.petFrame.slice('data:image/png;base64,'.length)),
              'base64',
            ),
          )
        const surface = await page
          .locator('.discord-guide-drawer')
          .evaluate((e) => getComputedStyle(e).backgroundColor)
        if (theme === 'dark' && surface === 'rgb(248, 251, 251)')
          throw Error('Tutorial still uses obsolete light fallback')
        const pet = page.getByRole('button', { name: '蒜惹菈快捷对话', exact: true })
        await pet.tap()
        await pet.tap()
        if (await page.getByRole('group', { name: '需要我的帮助嘛？', exact: true }).count())
          throw Error('Help opened before third tap')
        await pet.tap()
        const question = page.getByRole('group', { name: '需要我的帮助嘛？', exact: true })
        await question.waitFor()
        await question.getByRole('button', { name: '不是', exact: true }).tap()
        await question.waitFor({ state: 'hidden' })
        await pet.tap()
        await pet.tap()
        await pet.tap()
        await question.waitFor()
        await page.screenshot({ path: resolve(output, `${width}-${theme}-help.png`) })
        await question.getByRole('button', { name: '是', exact: true }).tap()
        const assertCentered = async (dialog) => {
          const box = await dialog.boundingBox()
          if (
            !box ||
            Math.abs(box.x + box.width / 2 - width / 2) > 1 ||
            Math.abs(box.y + box.height / 2 - height / 2) > 1
          )
            throw Error('Help dialog is not centered: ' + JSON.stringify(box))
        }
        const resume = page.getByRole('dialog', { name: '继续上次配置？', exact: true })
        await resume.waitFor()
        await page.waitForFunction(
          () => getComputedStyle(document.querySelector('.action-sheet')).opacity === '1',
        )
        await assertCentered(resume)
        if (!(await resume.textContent()).includes('上次停在：编辑 Wrangler 三个空'))
          throw Error('Saved step was not shown')
        await page.screenshot({ path: resolve(output, `${width}-${theme}-resume.png`) })
        await resume.getByRole('button', { name: '继续上次配置', exact: true }).tap()
        const permission = page.getByRole('alertdialog', {
          name: '开启蒜惹菈代理模式？',
          exact: true,
        })
        await permission.waitFor()
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.confirm-dialog__overlay')).opacity === '1',
        )
        await assertCentered(permission)
        const content = permission.locator('p')
        if (!(await content.textContent()).includes('模型不读取或接收秘密值'))
          throw Error('Permission boundary missing')
        await content.evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await content.evaluate((el) => {
          el.scrollTop = 0
        })
        await page.screenshot({ path: resolve(output, `${width}-${theme}-permissions.png`) })
        await permission.getByRole('button', { name: '暂不开启', exact: true }).tap()
        if (await page.evaluate(() => window.lastResume))
          throw Error('Agent resumed after cancelled permissions')
        await resume.getByRole('button', { name: '继续上次配置', exact: true }).tap()
        await permission.getByRole('button', { name: '确认权限并开启', exact: true }).tap()
        await resume.waitFor({ state: 'hidden' })
        const continued = await page.evaluate(() => window.lastResume)
        if (
          continued?.step !== 'wrangler-edit' ||
          continued.startedAt !== 1 ||
          (await page.evaluate(() => window.lastSetup || window.nextCalled))
        )
          throw Error('Continuing changed or advanced the saved task')
        await pet.tap()
        await pet.tap()
        await pet.tap()
        await question.getByRole('button', { name: '是', exact: true }).tap()
        await resume.getByRole('button', { name: '重新开始', exact: true }).tap()
        if (await page.evaluate(() => window.lastSetup))
          throw Error('Restart reset progress before choosing a route')
        const menu = page.getByRole('dialog', { name: '这次需要怎样的帮助？', exact: true })
        await menu.waitFor()
        await menu.screenshot({ path: resolve(output, `${width}-${theme}-menu.png`) })
        await assertCentered(menu)
        await menu
          .getByRole('button', { name: '之前配置过 Discord Bridge，这次只是更新', exact: true })
          .tap()
        const updates = page.getByRole('dialog', { name: '这次更新什么？', exact: true })
        await updates.waitFor()
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.action-sheet')).opacity === '1' &&
            !document.querySelector('button:active'),
        )
        await page.screenshot({ path: resolve(output, `${width}-${theme}-updates.png`) })
        await assertCentered(updates)
        await updates
          .getByRole('button', { name: '仅更新指令（Worker 已经更新过）', exact: true })
          .tap()
        await updates.waitFor({ state: 'hidden' })
        const mode = page.getByRole('dialog', { name: '选择部署协助模式', exact: true })
        await mode.waitFor()
        await assertCentered(mode)
        if (await page.evaluate(() => window.lastSetup))
          throw Error('Task started before mode choice')
        await page.screenshot({ path: resolve(output, width + '-' + theme + '-mode.png') })
        await mode
          .getByRole('button', { name: theme === 'dark' ? /代理模式/ : /省 Token 模式/ })
          .tap()
        if (theme === 'dark') {
          await permission.waitFor()
          await assertCentered(permission)
          if (await page.evaluate(() => window.lastSetup))
            throw Error('Agent task started before permission confirmation')
          await permission.getByRole('button', { name: '确认权限并开启', exact: true }).tap()
        }
        await mode.waitFor({ state: 'hidden' })
        await page.evaluate(() => {
          void window.testUnlock()
        })
        const unlock = page.getByRole('alertdialog', { name: '先设置密钥统一密码', exact: true })
        await unlock.waitFor()
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.confirm-dialog__overlay')).opacity === '1',
        )
        await assertCentered(unlock)
        if (!(await unlock.getByRole('button', { name: '继续配置', exact: true }).isDisabled()))
          throw Error('Task continued before unlock')
        await unlock.locator('input').nth(0).fill('local-test-password')
        await unlock.locator('input').nth(1).fill('local-test-password')
        await page.screenshot({ path: resolve(output, `${width}-${theme}-unlock.png`) })
        await unlock.getByRole('button', { name: '保存统一密码', exact: true }).tap()
        await unlock.getByRole('button', { name: '继续配置', exact: true }).tap()
        await unlock.waitFor({ state: 'hidden' })
        await page.getByRole('button', { name: '关闭GitHub 部署教程', exact: true }).last().tap()
        await page.waitForFunction(() => !document.querySelector('button:active'))
        const receipt = await page.evaluate(() => window.lastSetup)
        if (
          receipt?.task !== 'update-commands-only' ||
          receipt.from !== undefined ||
          receipt.mode !== (theme === 'dark' ? 'agent' : 'economy')
        )
          throw Error('Native checkpoint chooser was bypassed')
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw Error('Horizontal overflow')
        for (const el of await page.locator('.discord-setup-assistant button').all()) {
          const box = await el.boundingBox()
          if (!box || box.height < 44 || box.x < 0 || box.x + box.width > width + 1)
            throw Error(
              'Touch bounds ' + JSON.stringify({ width, theme, box, text: await el.textContent() }),
            )
        }
        const color = await page
          .locator('.discord-setup-assistant strong')
          .evaluate((e) => getComputedStyle(e).color)
        if (theme === 'dark' && color === 'rgb(24, 56, 66)') throw Error('Dark ink did not change')
        await page.getByRole('button', { name: '继续', exact: true }).tap()
        await resume.waitFor()
        await resume.getByRole('button', { name: '继续上次配置', exact: true }).tap()
        await resume.waitFor({ state: 'hidden' })
        await page.waitForFunction(
          () =>
            !document.querySelector('button:active') &&
            !document.querySelector('.discord-setup-assistant button:disabled'),
        )
        if (errors.length) throw Error(errors.join('\n'))
        await page.locator('main').screenshot({ path: resolve(output, `${width}-${theme}.png`) })
        cases++
      } finally {
        await context.close()
      }
    }
  const context = await browser.newContext()
  try {
    await context.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<textarea name="content" style="width:500px;height:500px"></textarea>',
      }),
    )
    const page = await context.newPage()
    await page.goto('https://github.com/fixture/SRL-Discord-Bridge/edit/main/wrangler.jsonc')
    const executor = await readFile(path('android/app/src/main/assets/discord-setup.js'), 'utf8')
    const module = await bundle({
      entryPoints: [path('src/services/DiscordBridgeDeployService.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
    })
    const template = (
      await import(
        'data:text/javascript;base64,' + Buffer.from(module.outputFiles[0].text).toString('base64')
      )
    ).DISCORD_BRIDGE_WRANGLER_TEMPLATE
    await page.evaluate(
      ({ executor, template }) => {
        const run = (0, eval)('(' + executor.trim().replace(/;\s*$/, '') + ')')
        if (!run('template', { template }).ok) throw Error('Native executor template did not write')
        const guided = run('guide', { step: 'wrangler-edit' })
        if (
          !guided.ok ||
          !guided.waitingForUser ||
          !guided.guideAnchor ||
          Object.values(guided.guideAnchor).some((value) => value < 0 || value > 1)
        )
          throw Error('Guide did not locate the visible editor and pause')
        if (run('validate', {}).ok) throw Error('Placeholders passed')
        const value = JSON.parse(template)
        value.d1_databases[0].database_id = '12345678-1234-5678-9abc-123456789abc'
        value.vars.DISCORD_APPLICATION_ID = '1234567890123456789'
        value.vars.DISCORD_PUBLIC_KEY = 'a'.repeat(64)
        document.querySelector('textarea').value = JSON.stringify(value)
        const result = run('validate', { expectedApplicationId: value.vars.DISCORD_APPLICATION_ID })
        if (!result.ok || JSON.stringify(result).includes(value.vars.DISCORD_PUBLIC_KEY))
          throw Error('Complete local validation/secret suppression failed')
      },
      { executor, template },
    )
  } finally {
    await context.close()
  }
  for (const width of [320, 375, 390, 430]) {
    for (const theme of ['light', 'dark']) {
      const secretContext = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: true,
        isMobile: true,
      })
      try {
        await secretContext.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;background:${theme === 'dark' ? '#191c22' : '#fff'};color:${theme === 'dark' ? '#fff' : '#111'};font:16px sans-serif}form{display:grid;gap:10px}input,textarea,select,button{font:inherit;min-height:44px;max-width:100%;box-sizing:border-box}textarea{height:100px}</style><form><label for="type">Type</label><select id="type"><option>Text</option><option>Secret</option></select><label for="name">Variable name</label><input id="name"><label for="value">Value</label><textarea id="value"></textarea><button type="button">Deploy</button></form>`,
          }),
        )
        const secretPage = await secretContext.newPage()
        await secretPage.goto(
          'https://dash.cloudflare.com/fixture/workers/services/view/srl-discord-source-bridge/production/settings',
        )
        const executor = await readFile(
          path('android/app/src/main/assets/discord-setup.js'),
          'utf8',
        )
        await secretPage.evaluate(
          ({ executor }) => {
            window.secretRun = (0, eval)('(' + executor.trim().replace(/;\s*$/, '') + ')')
            window.secretPayload = {
              step: 'cf-secret',
              secretStage: 'prepare',
              secretMarker: 'browser-fixture',
            }
            Object.defineProperty(document.getElementById('value'), 'value', {
              get() {
                throw Error('Executor read Secret')
              },
            })
            window.secretRun('prepare-secret', window.secretPayload)
            const ready = window.secretRun('prepare-secret', window.secretPayload)
            if (
              !ready.ok ||
              ready.secretStage !== 'input' ||
              !ready.waitingForUser ||
              !ready.guideAnchor
            )
              throw Error('Secret handoff was not prepared')
            const guide = ready.guideAnchor
            if (Object.values(guide).some((value) => value < 0 || value > 1))
              throw Error('Secret guide escaped viewport')
            document.querySelector('button').addEventListener('click', () => {
              window.secretClicked = true
            })
          },
          { executor },
        )
        if (await secretPage.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw Error('Secret form overflow')
        await secretPage.screenshot({
          path: resolve(output, `${width}-${theme}-secret-handoff.png`),
        })
        await secretPage.locator('#value').tap()
        await secretPage.keyboard.insertText('FIXTURE_USER_TYPED_VALUE')
        await secretPage.evaluate(() => {
          if (
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get.call(
              document.getElementById('value'),
            ) !== 'FIXTURE_USER_TYPED_VALUE'
          )
            throw Error('User typing failed')
          const receipt = window.secretRun('submit-secret', {
            ...window.secretPayload,
            secretStage: 'submit',
          })
          if (
            !receipt.ok ||
            receipt.secretStage !== 'submitted' ||
            !window.secretClicked ||
            JSON.stringify(receipt).includes('FIXTURE_USER_TYPED_VALUE')
          )
            throw Error('Secret submission/receipt failed')
        })
        await secretContext.unroute('**/*')
        const appId = '1234567890123456789'
        const root = 'https://fixture.account.workers.dev'
        await secretContext.route('**/*', (route) => {
          const url = new URL(route.request().url())
          const body = url.pathname.endsWith('/information')
            ? '<label for="endpoint">Interactions Endpoint URL</label><input id="endpoint"><button id="assist">请助手协助</button><button id="save">保存</button>'
            : url.pathname.endsWith('/installation')
              ? `<div style="height:1000px">Installation</div><label>Install Link</label><input readonly value="https://discord.com/oauth2/authorize?client_id=${appId}"><button id="install">打开安装链接</button>`
              : '<p>安装目标和授权由用户选择</p><button id="authorize">授权</button>'
          return route.fulfill({
            contentType: 'text/html',
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font:16px sans-serif;background:${theme === 'dark' ? '#191c22' : '#fff'};color:${theme === 'dark' ? '#fff' : '#111'}}input,button{display:block;min-height:44px;width:100%;box-sizing:border-box;margin:8px 0;font:inherit}</style>${body}`,
          })
        })
        const publicPage = await secretContext.newPage()
        await publicPage.goto(`https://discord.com/developers/applications/${appId}/information`)
        await publicPage.evaluate(
          ({ executor, appId, root }) => {
            window.publicRun = (0, eval)('(' + executor.trim().replace(/;\s*$/, '') + ')')
            document.getElementById('assist').addEventListener('click', () => {
              window.receipt = window.publicRun('fill-endpoint', {
                step: 'discord-endpoint',
                expectedApplicationId: appId,
                value: root + '/interactions',
              })
            })
            document.getElementById('save').addEventListener('click', () => {
              window.savedEndpoint = document.getElementById('endpoint').value
            })
          },
          { executor, appId, root },
        )
        await publicPage.locator('#assist').tap()
        if ((await publicPage.locator('#endpoint').inputValue()) !== root + '/interactions')
          throw Error('Endpoint was not filled')
        if (
          !(await publicPage.evaluate(() => window.receipt.waitingForUser && !window.savedEndpoint))
        )
          throw Error('Endpoint did not wait for save')
        await publicPage.locator('#save').tap()
        if ((await publicPage.evaluate(() => window.savedEndpoint)) !== root + '/interactions')
          throw Error('Touch save did not use endpoint')
        await publicPage.goto(`https://discord.com/developers/applications/${appId}/installation`)
        await publicPage.evaluate(
          ({ executor, appId }) => {
            const run = (0, eval)('(' + executor.trim().replace(/;\s*$/, '') + ')')
            document.getElementById('install').addEventListener('click', () => {
              const result = run('open-install', {
                step: 'discord-install',
                expectedApplicationId: appId,
              })
              if (!result.ok) throw Error('Install link not located')
              // Browser fixture simulates native loadUrl; Java policy is tested separately.
              window.location.assign(result.installUrl)
            })
          },
          { executor, appId },
        )
        await publicPage.locator('#install').tap()
        await publicPage.waitForURL(`https://discord.com/oauth2/authorize?client_id=${appId}`)
        await publicPage.evaluate(
          ({ executor }) => {
            const run = (0, eval)('(' + executor.trim().replace(/;\s*$/, '') + ')')
            if (!run('inspect', {}).waitingForUser) throw Error('Authorization page was inspected')
          },
          { executor },
        )
        if (await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          throw Error('Public configuration overflow')
      } finally {
        await secretContext.close()
      }
    }
  }
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify({
      cases,
      native: 'mock',
      accounts: 'none',
      executor: 'bundled Chromium fixture',
      secret:
        '8 touch viewport/theme handoffs, no value reads, fixed submission; native policy tested separately in JVM; dialogs/device unverified',
      publicConfiguration:
        '8 touch endpoint fills/save handoffs and same-App install link openings; browser simulates native navigation, real sites/device unverified',
      input: 'touch',
      widths: [320, 375, 390, 430],
      themes: ['light', 'dark'],
    }),
  )
  console.log(
    'Setup UI passed: 8 triple-tap touch viewport/theme cases; bundled executor Chromium fixture passed',
  )
} finally {
  await browser.close()
  await preview.close()
}
