/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { URL, URLSearchParams } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { auditEnvironment, launchAuditBrowser } from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'

// Mount real overlay components with the shell CSS loaded before lazy panel CSS.
// Controlled inset values test consumption, not a physical iPhone's WebKit behavior.
const environment = auditEnvironment(undefined, 'safe-area-overlays')
if (!process.env.SRL_AUDIT_RUN || !process.env.SRL_AUDIT_OUTPUT_DIR)
  throw new Error('Use audit:isolated with explicit run and output')
const fixture = resolve('.codex-tmp', environment.run, 'overlay-ui')
const source = (file) => resolve(file).replaceAll('\\', '/')
await mkdir(fixture, { recursive: true })
await mkdir(environment.outputDir, { recursive: true })
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'main.js'),
  `
import {createApp,h,ref} from 'vue'
import '${source('src/styles/Foundation.css')}'
import '${source('src/Styles.css')}'
import Recycle from '${source('src/components/RecycleBinPanel.vue')}'
import Relay from '${source('src/components/RelayWorkerDeployGuidePage.vue')}'
import Guide from '${source('src/components/DiscordSetupGuideDrawer.vue')}'
import Manual from '${source('src/components/DiscordManualDeployDrawer.vue')}'
const params=new URL(location.href).searchParams
const root=document.documentElement
root.dataset.theme=params.get('theme')
root.style.setProperty('--safe-top',params.get('top')+'px')
root.style.setProperty('--safe-right',params.get('right')+'px')
root.style.setProperty('--safe-bottom',params.get('bottom')+'px')
root.style.setProperty('--safe-left',params.get('left')+'px')
root.style.setProperty('--app-viewport-height',innerHeight+'px')
root.style.setProperty('--visual-viewport-height',innerHeight+'px')
root.style.setProperty('--visual-viewport-offset-top','0px')
const visible=ref(true), close=()=>{visible.value=false}
const records=Array.from({length:30},(_,i)=>({id:String(i),reason:'已删除资源 '+i,createdAt:1,resourceCount:1,size:100}))
const props={open:true,applicationId:'123',publicKey:'fixture',botToken:'',installationUrl:'https://example.invalid/',developerAppUrl:'https://example.invalid/',developerBotUrl:'https://example.invalid/',onClose:close}
createApp({render:()=>visible.value ? ({
 recycle:()=>h(Recycle,{records,busy:false,onClose:close}),
 relay:()=>h(Relay,{onClose:close}),
 guide:()=>h(Guide,props),manual:()=>h(Manual,props),
}[params.get('panel')]()) : h('p',{'data-closed':''},'已关闭')}).mount('#app')
`,
)
await build({
  configFile: false,
  root: fixture,
  plugins: [
    vue(),
    {
      name: 'manual-source-fixture',
      resolveId(id) {
        if (id === 'virtual:srl-discord-manual-worker-source') return '\0manual-source-fixture'
      },
      load(id) {
        if (id === '\0manual-source-fixture') return 'export default "// Layout fixture only"'
      },
    },
  ],
  build: { outDir: resolve(fixture, 'dist') },
})
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(environment.baseUrl).port),
  run: environment.run,
})
let browser
const results = []
const panels = {
  recycle: ['.recycle-bin-sheet', '.recycle-bin-sheet__content', '关闭'],
  relay: ['.relay-worker-guide', '.relay-worker-guide__scroll', '返回设置'],
  guide: ['.discord-guide-drawer', '.discord-guide-drawer__body', '关闭一键部署教程'],
  manual: ['.discord-manual-drawer', '.discord-manual-body', '关闭'],
}
try {
  browser = await launchAuditBrowser(environment)
  for (const [width, height, top, right, bottom, left] of [
    [320, 800, 59, 0, 34, 0],
    [375, 812, 59, 0, 34, 0],
    [390, 844, 59, 0, 34, 0],
    [430, 932, 59, 0, 34, 0],
    [768, 1024, 59, 0, 34, 0],
    [844, 390, 0, 21, 21, 59],
    [1280, 800, 0, 0, 0, 0],
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true })
      try {
        const page = await context.newPage()
        for (const [panel, [hostSelector, scrollSelector, closeName]] of Object.entries(panels)) {
          await page.goto(
            preview.url + '/?' + new URLSearchParams({ panel, theme, top, right, bottom, left }),
          )
          const host = page.locator(hostSelector)
          await host.waitFor()
          await page.evaluate(async () => {
            await Promise.all(
              document
                .getAnimations()
                .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
                .map((a) => a.finished.catch(() => {})),
            )
          })
          const close = host.getByRole('button', { name: closeName, exact: true })
          const box = await close.boundingBox()
          const geometry = await host.evaluate((el) => ({
            width: el.clientWidth,
            scroll: el.scrollWidth,
          }))
          const entry = { panel, width, height, theme, box, geometry }
          results.push(entry)
          await writeFile(
            resolve(environment.outputDir, 'geometry.json'),
            JSON.stringify(results, null, 2),
          )
          const safe =
            box &&
            box.y >= top - 1 &&
            box.x >= left - 1 &&
            box.x + box.width <= width - right + 1 &&
            box.y + box.height <= height - bottom + 1
          assert.ok(safe, JSON.stringify(entry))
          if (panel === 'recycle') {
            const padding = await host.evaluate((el) => {
              const style = getComputedStyle(el)
              const overlay = el.parentElement
              const sheet = el.getBoundingClientRect()
              const bounds = overlay.getBoundingClientRect()
              return {
                top: parseFloat(style.paddingTop),
                bottom: parseFloat(style.paddingBottom),
                sheetBottom: sheet.bottom,
                overlayBottom: bounds.bottom,
                overlayBackground: getComputedStyle(overlay).backgroundColor,
                sheetBackground: style.backgroundColor,
                radius: style.borderTopLeftRadius,
              }
            })
            assert.ok(
              padding.top <= 28 && padding.bottom <= 28,
              'Recycle sheet must retain ordinary spacing, not a second safe inset: ' +
                JSON.stringify(padding),
            )
            assert.ok(
              Math.abs(padding.sheetBottom - (padding.overlayBottom - bottom)) <= 1,
              JSON.stringify(padding),
            )
            assert.equal(
              padding.overlayBackground,
              padding.sheetBackground,
              'The safe area must share the full-page background',
            )
            assert.equal(padding.radius, '0px')
          }
          assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(entry))
          if (width === 390 && theme === 'light')
            await page.screenshot({ path: resolve(environment.outputDir, panel + '.png') })
          const scroller = page.locator(scrollSelector)
          if (panel === 'recycle' && width === 390 && environment.engine === 'chromium') {
            const cdp = await context.newCDPSession(page)
            const bounds = await scroller.boundingBox()
            for (let swipe = 0; swipe < 12; swipe++) {
              const state = await scroller.evaluate((el) => ({
                top: el.scrollTop,
                height: el.clientHeight,
                total: el.scrollHeight,
              }))
              if (state.top + state.height >= state.total - 2) break
              const x = bounds.x + bounds.width / 2,
                start = bounds.y + bounds.height - 40,
                end = bounds.y + 40
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x, y: start }],
              })
              for (let step = 1; step <= 12; step++)
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [{ x, y: start + ((end - start) * step) / 12 }],
                })
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
              await page.waitForFunction(
                ({ selector, before }) => document.querySelector(selector).scrollTop > before,
                { selector: scrollSelector, before: state.top },
              )
            }
            const end = await scroller.evaluate((el) => ({
              top: el.scrollTop,
              height: el.clientHeight,
              total: el.scrollHeight,
            }))
            assert.ok(
              end.top + end.height >= end.total - 2,
              'Native touch scroll must reach the last item: ' + JSON.stringify(end),
            )
            await cdp.detach()
          }
          // Browser scroll API tests scroll bounds; touch taps below test actual controls.
          const scroll = await scroller.evaluate((el) => {
            el.scrollTop = el.scrollHeight
            return {
              top: el.scrollTop,
              height: el.clientHeight,
              total: el.scrollHeight,
              bottom: el.getBoundingClientRect().bottom,
            }
          })
          assert.ok(
            scroll.top + scroll.height >= scroll.total - 2 && scroll.bottom <= height - bottom + 1,
            JSON.stringify({ entry, scroll }),
          )
          if (panel === 'recycle') {
            const last = await host.locator('.recycle-bin-item').last().boundingBox()
            const next = await host
              .getByRole('button', { name: '下一页', exact: true })
              .boundingBox()
            assert.ok(
              last.y + last.height <= height - bottom + 1 &&
                next.y + next.height <= height - bottom + 1,
              'Last row and pagination must be fully visible',
            )
            if (width === 390 && theme === 'light')
              await page.screenshot({ path: resolve(environment.outputDir, 'recycle-bottom.png') })
            await host.getByRole('button', { name: '下一页', exact: true }).tap()
            assert.equal(await host.locator('.recycle-bin-item').count(), 6)
          }
          if (panel === 'relay') {
            await scroller.evaluate((el) => {
              el.scrollTop = 0
            })
            await host.getByRole('button', { name: '复制命令', exact: true }).tap()
            await page.waitForFunction(
              () =>
                document.body.textContent.includes('已复制') ||
                document.body.textContent.includes('复制失败'),
            )
          }
          await close.tap()
          await page.locator('[data-closed]').waitFor()
        }
      } finally {
        await context.close()
      }
    }
  console.log('Safe-area overlays passed: ' + results.length + ' layouts / ' + environment.engine)
} finally {
  await browser?.close()
  await preview.close()
}
