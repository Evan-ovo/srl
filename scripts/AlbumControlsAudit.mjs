/* global window, document, navigator, getComputedStyle */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { auditEnvironment, launchAuditBrowser } from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'

const environment = auditEnvironment(undefined, 'album-controls')
if (!process.env.SRL_AUDIT_RUN) throw Error('Use audit:isolated with explicit run and port')
const fixture = resolve('.codex-tmp', environment.run, 'fixture')
const source = (path) => resolve(path).replaceAll('\\', '/')
await mkdir(fixture, { recursive: true })
await mkdir(environment.outputDir, { recursive: true })
const owner = 'src/components/GeneratedImageAlbumApp.vue'
const beforeRef = process.env.SRL_ALBUM_BEFORE_REF
const before = beforeRef
  ? execFileSync('git', ['show', `${beforeRef}:${owner}`], { encoding: 'utf8' })
  : await readFile(owner, 'utf8')
await writeFile(
  resolve(fixture, 'Before.css'),
  beforeRef
    ? execFileSync('git', ['show', `${beforeRef}:src/styles/GeneratedImageAlbumApp.css`])
    : await readFile('src/styles/GeneratedImageAlbumApp.css'),
)
await writeFile(
  resolve(fixture, 'Before.vue'),
  before
    .replace('src="../styles/GeneratedImageAlbumApp.css"', 'src="./Before.css"')
    .replace(/from '\.\.\//gu, `from '${source('src')}/`)
    .replace(/from '\.\//gu, `from '${source('src/components')}/`),
)
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'Container.js'),
  `
import {FrontendWorkshopImageHostingService} from '${source('src/services/FrontendWorkshopImageHostingService.ts')}'
const credentials=new Map()
const repository={read:async key=>credentials.get(key)||'',save:async(key,value)=>credentials.set(key,value),clear:async key=>credentials.delete(key)}
export const frontendWorkshopImageHostingService=new FrontendWorkshopImageHostingService(fetch,repository)
frontendWorkshopImageHostingService.status=async()=>({configured:false,membership:{registered:false},capacity:{uploadEnabled:false}})
window.albumCalls={list:0,imports:0,saves:0}
const save=frontendWorkshopImageHostingService.saveSelfHostedConfiguration.bind(frontendWorkshopImageHostingService)
frontendWorkshopImageHostingService.saveSelfHostedConfiguration=async value=>{const result=await save(value);window.albumCalls.saves++;return result}
export const generatedImageAlbumService={list:async()=>{window.albumCalls.list++;return {items:[],total:0,page:1,pageSize:18,pageCount:1,categories:[],mimeTypes:[]}},importFile:async file=>{if(file.type!=='image/png'||!file.size)throw Error('Invalid fixture import');window.albumCalls.imports++}}
`,
)
await writeFile(
  resolve(fixture, 'main.js'),
  `import {createApp,h} from 'vue';import Confirm from '${source('src/components/ConfirmDialog.vue')}';import Before from './Before.vue';import After from '${source(owner)}';import '${source('src/styles/Foundation.css')}';import '${source('src/styles/AppShell.css')}';import '${source('src/styles/GlassRefinement.css')}';document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';createApp({render:()=>h('div',[h(new URLSearchParams(location.search).has('before')?Before:After),h(Confirm)])}).mount('#app')`,
)
const directory = resolve(fixture, 'dist')
await build({
  configFile: false,
  root: fixture,
  plugins: [vue()],
  logLevel: 'error',
  resolve: {
    dedupe: ['vue'],
    alias: [
      { find: /^.*\/core\/ImageAlbumContainer$/u, replacement: source(`${fixture}/Container.js`) },
    ],
  },
  build: { outDir: directory, emptyOutDir: true, chunkSizeWarningLimit: 5000 },
})
const preview = await startAuditPreview({
  directory,
  port: Number(new URL(environment.baseUrl).port),
  run: environment.run,
})
const browser = await launchAuditBrowser(environment)
const results = []
try {
  for (const width of [320, 375, 390, 430])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: true,
        isMobile: true,
      })
      const page = await context.newPage()
      const errors = []
      const remoteCalls = []
      let remoteDeletes = 0
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', {
            value: {
              writeText: async (text) => {
                window.copiedRemoteLink = text
              },
            },
          })
        })
        await page.route('https://img.example/**', async (route) => {
          const request = route.request(),
            url = new URL(request.url())
          const headers = {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, DELETE, OPTIONS',
            'access-control-allow-headers': 'authorization',
            'content-type': 'application/json',
          }
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
          if (url.pathname.startsWith('/api/manage/delete/')) {
            remoteDeletes++
            return route.fulfill({ headers, body: '{"success":true}' })
          }
          if (url.pathname === '/api/manage/list') {
            const query = Object.fromEntries(url.searchParams)
            remoteCalls.push(query)
            const all = [
              {
                name: '旅行/山间.png',
                metadata: {
                  FileType: 'image/png',
                  FileSizeBytes: 1654000,
                  TimeStamp: '1792324800000',
                },
              },
              { name: '秋日.mp4', metadata: { FileType: 'video/mp4', FileSizeBytes: 23674880 } },
              { name: '雨声.mp3', metadata: { FileType: 'audio/mpeg', FileSizeBytes: 3145728 } },
              {
                name: '资料.zip',
                metadata: { FileType: 'application/zip', FileSizeBytes: 126815 },
              },
            ]
            const files =
              query.start === '50'
                ? [{ name: '下一页.pdf', metadata: { FileType: 'application/pdf' } }]
                : query.fileType === 'other' || query.search
                  ? all.slice(-1)
                  : all
            return route.fulfill({
              headers,
              body: JSON.stringify({
                files,
                directories: query.dir ? [] : ['旅行'],
                totalCount: query.fileType || query.search ? 1 : 55,
                isIndexedResponse: true,
              }),
            })
          }
          return route.fulfill({
            headers: { ...headers, 'content-type': 'image/svg+xml' },
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#b6d5d0"/><circle cx="94" cy="30" r="14" fill="#f4e4b9"/><path d="M0 128V90L46 40 90 104 110 72 128 98V128" fill="#557e77"/></svg>',
          })
        })
        await page.goto(`${preview.url}/?theme=${theme}`)
        await page.locator('.generated-album__toolbar').waitFor()
        const metrics = await page.evaluate(() => {
          const button = document.querySelector('.generated-album__import'),
            face = button.querySelector('span')
          const search = document.querySelector('.generated-album__search').getBoundingClientRect(),
            hit = button.getBoundingClientRect()
          return {
            shadow: getComputedStyle(button).boxShadow,
            faceShadow: getComputedStyle(face).boxShadow,
            hitHeight: hit.height,
            faceHeight: face.getBoundingClientRect().height,
            separated: hit.left >= search.right - 1,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          }
        })
        assert.equal(
          metrics.shadow,
          'none',
          'Import hit target must not draw a second control shadow',
        )
        assert.ok(
          metrics.faceShadow !== 'none' &&
            metrics.hitHeight >= 44 &&
            metrics.faceHeight <= 36 &&
            metrics.separated &&
            metrics.overflow <= 1,
          JSON.stringify(metrics),
        )
        if (width === 390)
          await page.screenshot({ path: resolve(environment.outputDir, `album-${theme}.png`) })
        const direct = page.getByRole('button', { name: '自建图床设置', exact: true })
        if (await direct.count()) await direct.tap()
        else {
          await page.getByRole('button', { name: '相册设置', exact: true }).tap()
          await page.getByRole('button', { name: '自建图床连接', exact: true }).tap()
        }
        const dialog = page.locator(
          '.generated-album__settings--hosting, .generated-album__hosting-page',
        )
        const publicPage = (await page.locator('.generated-album__hosting-page').count()) > 0
        if (publicPage)
          assert.equal(await page.getByRole('dialog', { name: '自建图床', exact: true }).count(), 0)
        await dialog.getByLabel('图床地址', { exact: true }).focus()
        await page.keyboard.press('Tab')
        assert.equal(
          await dialog
            .getByLabel('上传凭据', { exact: true })
            .evaluate((element) => element === document.activeElement),
          true,
        )
        await dialog.getByLabel('图床地址', { exact: true }).fill('https://img.example')
        await dialog.getByLabel('上传凭据', { exact: true }).fill('example-token')
        await dialog.getByRole('button', { name: '保存连接', exact: true }).tap()
        await dialog.getByRole('region', { name: '远端文件', exact: true }).waitFor()
        assert.equal(
          await page.getByText('自建图床仅在本次打开期间连接。', { exact: true }).count(),
          0,
        )
        assert.deepEqual(await page.evaluate(() => window.albumCalls), {
          list: 1,
          imports: 0,
          saves: 1,
        })
        const remote = dialog.getByRole('region', { name: '远端文件', exact: true })
        await remote.getByText('资料.zip', { exact: true }).waitFor()
        const remoteMetrics = await dialog.evaluate((element) => ({
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        assert.ok(
          remoteMetrics.scrollWidth <= remoteMetrics.width + 1,
          JSON.stringify(remoteMetrics),
        )
        const density = await remote.evaluate((element) => {
          const rows = Array.from(element.querySelectorAll('.remote-files__file')).map(
            (row) => row.getBoundingClientRect().height,
          )
          const search = element.querySelector('input[type="search"]').getBoundingClientRect()
          const type = element.querySelector('select').getBoundingClientRect()
          const actions = Array.from(element.querySelectorAll('.remote-files__actions button')).map(
            (button) => button.getBoundingClientRect().height,
          )
          const pageInput = element.querySelector('.inline-page-jump').getBoundingClientRect()
          const pageTarget = element.querySelector('.remote-files__jump').getBoundingClientRect()
          return {
            rows,
            sameToolbarRow: Math.abs(search.top - type.top) < 2,
            touchTargets: actions.every((height) => height >= 44),
            pageInputWidth: pageInput.width,
            pageInputHeight: pageInput.height,
            pageTargetHeight: pageTarget.height,
          }
        })
        assert.ok(
          density.rows.every((height) => height <= 76) &&
            density.sameToolbarRow &&
            density.touchTargets &&
            density.pageInputWidth >= 32 &&
            density.pageInputHeight >= 24 &&
            density.pageInputHeight <= 32 &&
            density.pageTargetHeight >= 44,
          JSON.stringify(density),
        )
        if (width === 390 && theme === 'light')
          await page.screenshot({ path: resolve(environment.outputDir, 'self-hosted.png') })
        if (width === 390)
          await page.screenshot({
            path: resolve(environment.outputDir, `remote-files-${theme}.png`),
          })
        await remote.getByRole('button', { name: '复制 资料.zip 的直链', exact: true }).tap()
        assert.equal(
          await page.evaluate(() => window.copiedRemoteLink),
          'https://img.example/file/%E8%B5%84%E6%96%99.zip',
        )
        await remote.getByRole('button', { name: '下一页', exact: true }).tap()
        await remote.getByText('下一页.pdf', { exact: true }).waitFor()
        assert.equal(remoteCalls.at(-1).start, '50')
        await remote.getByRole('textbox', { name: '跳转页码' }).fill('1')
        await remote.getByRole('textbox', { name: '跳转页码' }).press('Enter')
        await remote.getByText('资料.zip', { exact: true }).waitFor()
        assert.equal(remoteCalls.at(-1).start, '0')
        await remote.getByRole('button', { name: '全部文件', exact: true }).tap()
        await remote.getByRole('button', { name: '旅行', exact: true }).tap()
        await remote.getByRole('button', { name: '旅行', exact: true }).waitFor()
        assert.equal(remoteCalls.at(-1).dir, '旅行')
        await remote.getByRole('combobox', { name: '远端文件类型' }).selectOption('other')
        await remote.getByText('资料.zip', { exact: true }).waitFor()
        await remote.getByRole('button', { name: '删除 资料.zip', exact: true }).tap()
        const confirmation = page.getByRole('alertdialog')
        await confirmation.getByRole('button', { name: '取消', exact: true }).tap()
        assert.equal(remoteDeletes, 0)
        await remote.getByRole('button', { name: '删除 资料.zip', exact: true }).tap()
        await confirmation.getByRole('button', { name: '永久删除', exact: true }).tap()
        await remote.getByText('已删除“资料.zip”，本地文件保留。', { exact: true }).waitFor()
        assert.equal(remoteDeletes, 1)
        await page
          .getByRole('button', { name: publicPage ? '返回相册' : '关闭自建图床设置', exact: true })
          .tap()
        assert.ok(
          await page.evaluate(
            () =>
              document.activeElement?.getAttribute('aria-label') === '自建图床设置' ||
              document.activeElement?.getAttribute('aria-label') === '相册设置',
          ),
        )
        const chosen = page.waitForEvent('filechooser')
        await page.locator('.generated-album__import').tap()
        const chooser = await chosen
        assert.ok(chooser.isMultiple())
        await chooser.setFiles({
          name: 'fixture.png',
          mimeType: 'image/png',
          buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        })
        await page.getByText('已导入 1 张图片。', { exact: true }).waitFor()
        assert.deepEqual(errors, [])
        results.push({
          width,
          theme,
          ...metrics,
          ...density,
          publicPage,
          imported: 1,
          connectionSaved: true,
          remoteFileDeleted: true,
          pageJump: true,
        })
      } finally {
        await context.close()
      }
    }
  if (beforeRef) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    })
    try {
      const page = await context.newPage()
      await page.goto(`${preview.url}/?before`)
      await page.locator('.generated-album__toolbar').waitFor()
      const shadow = await page
        .locator('.generated-album__import')
        .evaluate((element) => getComputedStyle(element).boxShadow)
      assert.notEqual(shadow, 'none', 'Committed baseline must reproduce the extra shadow')
      await page.screenshot({ path: resolve(environment.outputDir, 'before.png') })
      results.push({ baseline: true, shadow })
    } finally {
      await context.close()
    }
  }
  await writeFile(
    resolve(environment.outputDir, 'result.json'),
    JSON.stringify({ engine: environment.engine, checks: results }, null, 2) + '\n',
  )
  console.log(
    `Album controls passed: ${environment.engine}, eight width/theme cases, real touch chooser and self-hosted form${beforeRef ? ', baseline reproduced' : ''}`,
  )
} finally {
  await browser.close()
  await preview.close()
}
