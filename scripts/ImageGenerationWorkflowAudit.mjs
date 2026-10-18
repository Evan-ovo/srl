/* global document, localStorage, innerHeight */
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import console from 'node:console'
import process from 'node:process'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { startAuditPreview } from './AuditPreviewServer.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  createAuditStorageContext,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

// Production UI/controller, request builders/transports and album storage; only HTTP is a fixture.
const environment = auditEnvironment(undefined, 'image-generation')
await mkdir(environment.outputDir, { recursive: true })
const fixture = resolve('.codex-tmp', environment.run, 'fixture')
const source = (file) => resolve(file).replaceAll('\\', '/')
await mkdir(fixture, { recursive: true })
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'main.js'),
  `
import {createApp,ref,h} from 'vue'
import ImageGenerationApp from '${source('src/components/ImageGenerationApp.vue')}'
import GeneratedImageAlbumApp from '${source('src/components/GeneratedImageAlbumApp.vue')}'
import ConfirmDialog from '${source('src/components/ConfirmDialog.vue')}'
import '${source('src/styles/Foundation.css')}'
import '${source('src/styles/GlassRefinement.css')}'
document.documentElement.dataset.theme=localStorage.getItem('srl-theme')||'light'
document.documentElement.style.setProperty('--app-viewport-height',innerHeight+'px')
createApp({setup(){const album=ref(false);return ()=>h('div',[album.value?h(GeneratedImageAlbumApp,{onBack:()=>album.value=false}):h(ImageGenerationApp,{onOpenAlbum:()=>album.value=true}),h(ConfirmDialog)])}}).mount('#app')
`,
)
await build({
  root: fixture,
  configFile: false,
  publicDir: false,
  plugins: [vue()],
  resolve: { dedupe: ['vue'] },
  logLevel: 'error',
  build: { outDir: resolve(fixture, 'dist') },
})
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(environment.baseUrl).port),
  run: environment.run,
})
const browser = await launchAuditBrowser(environment)
const checks = []
try {
  const viewports = [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [844, 390],
    [1280, 900],
  ]
  const selected = process.env.SRL_IMAGE_AUDIT_WIDTHS?.split(',').map(Number)
  for (const [width, height] of viewports.filter(
    ([width]) => !selected || selected.includes(width),
  )) {
    for (const theme of ['light', 'dark']) {
      const context = await createAuditStorageContext(browser, environment, {
        viewport: { width, height },
        hasTouch: width < 1000,
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const tap = (locator) => (width < 1000 ? locator.tap() : locator.click())
      const button = (text) => page.getByRole('button', { name: text, exact: true })
      let status = 200,
        requests = 0
      let release
      let hold = false
      let editedWithAlias = false
      let image
      await context.route('https://**/*', async (route) => {
        if (
          !route.request().url().startsWith('https://image.novelai.net/') &&
          !route.request().url().startsWith('https://relay.example/')
        )
          return route.abort()
        requests++
        if (route.request().url().endsWith('/images/edits'))
          editedWithAlias = route.request().postData()?.includes('vendor-alias') ?? false
        if (route.request().url().endsWith('/models'))
          return route.fulfill({
            json: {
              data: [
                {
                  id: 'gpt-image-2',
                  capabilities: {
                    quality: true,
                    output_format: true,
                    output_compression: true,
                    background: true,
                    edits: true,
                    image_input: true,
                    multi_image: true,
                    mask: true,
                  },
                },
              ],
            },
          })
        if (hold)
          await new Promise((accept) => {
            release = accept
          })
        if (status !== 200)
          return route
            .fulfill({ status, json: { error: { message: 'fixture permission denied' } } })
            .catch(() => {})
        if (route.request().url().includes('novelai'))
          return route
            .fulfill({ status, contentType: 'image/png', body: Buffer.from(image, 'base64') })
            .catch(() => {})
        return route.fulfill({ status, json: { data: [{ b64_json: image }] } }).catch(() => {})
      })
      try {
        await context.addInitScript((value) => localStorage.setItem('srl-theme', value), theme)
        await page.goto(environment.baseUrl)
        await page.getByLabel('画面描述', { exact: true }).waitFor()
        image = await page.evaluate(() => {
          const canvas = document.createElement('canvas')
          canvas.width = 256
          canvas.height = 384
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = '#c9d9d5'
          ctx.fillRect(0, 0, 256, 384)
          ctx.fillStyle = '#31564f'
          ctx.beginPath()
          ctx.arc(128, 145, 55, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillRect(58, 214, 140, 130)
          ctx.fillStyle = '#ffffff'
          ctx.font = '18px sans-serif'
          ctx.fillText('TEST RESPONSE', 48, 40)
          return canvas.toDataURL('image/png').split(',')[1]
        })
        const layout = await page.locator('.image-generation-app').evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          scroll: el.querySelector('.image-generation-controls').getBoundingClientRect().height,
          open: el.querySelectorAll('details[open]').length,
          overflow: el.scrollWidth > el.clientWidth,
        }))
        assert.equal(layout.open, 0)
        assert.equal(layout.overflow, false)
        assert.ok(layout.width <= width)
        assert.ok(layout.scroll > height * 0.44, JSON.stringify(layout))
        await tap(button('生成图片'))
        await page.getByRole('alert').waitFor()
        assert.equal(await page.getByRole('alert').count(), 1)
        assert.match(await page.getByRole('alert').innerText(), /API 密钥/)
        await page.locator('input[type=password]').fill('fixture-only-key')
        await tap(page.locator('.image-generation-connection__advanced > summary'))
        await page.getByLabel('密钥保存方式').selectOption('session')
        await tap(button('保存连接'))
        await page.getByRole('status').waitFor()
        assert.equal(await page.getByRole('alert').count(), 0)
        await tap(button('完成'))
        await page.getByLabel('画面描述', { exact: true }).fill('隔离测试：人物肖像，柔和光线')
        if (width === 390) {
          // Contract simulation only; this is not an iPhone keyboard measurement.
          await page.evaluate(() => {
            document.documentElement.style.setProperty('--app-viewport-height', '300px')
            document.documentElement.dataset.iosKeyboardOpen = 'true'
          })
          assert.ok(
            (await page.locator('.image-generation-controls').evaluate((el) => el.clientHeight)) >
              100,
          )
          assert.equal(await button('生成图片').isVisible(), false)
          await page.evaluate(() => {
            document.documentElement.style.setProperty('--app-viewport-height', innerHeight + 'px')
            delete document.documentElement.dataset.iosKeyboardOpen
          })
          await page.screenshot({ path: resolve(environment.outputDir, `editor-${theme}.png`) })
          await tap(button('更多参数'))
          await page.screenshot({
            path: resolve(environment.outputDir, `parameters-novelai-${theme}.png`),
          })
          await tap(button('创作'))
        }
        await tap(button('生成图片'))
        await page.locator('.image-generation-result img').waitFor()
        await page.waitForFunction(
          () => document.querySelector('.image-generation-result img')?.naturalWidth === 256,
        )
        assert.equal(requests, 1)
        await tap(button('保存到生图相册'))
        await button('已保存到生图相册').waitFor()
        assert.equal(await page.getByRole('alert').count(), 0)
        if (width === 390)
          await page.screenshot({ path: resolve(environment.outputDir, `result-${theme}.png`) })
        await tap(button('相册'))
        await page.locator('[aria-label="图片列表"] > button').waitFor()
        assert.equal(await page.locator('[aria-label="图片列表"] > button').count(), 1)
        // Reload proves that the actual album persisted the original and metadata.
        await page.reload()
        await page.getByLabel('画面描述', { exact: true }).waitFor()
        await tap(button('相册'))
        await page.locator('[aria-label="图片列表"] > button').waitFor()
        assert.equal(await page.locator('[aria-label="图片列表"] > button').count(), 1)
        await tap(page.locator('.feature-app-header').getByRole('button').first())
        await page.getByLabel('画面描述', { exact: true }).waitFor()
        // Reloading a session-only credential correctly requires configuration again.
        await tap(button('配置连接'))
        await page.locator('input[type=password]').fill('fixture-only-key')
        await tap(button('完成'))
        status = 401
        await tap(button('生成图片'))
        await page.getByRole('alert').waitFor()
        assert.equal(await page.getByRole('alert').count(), 1)
        assert.match(await page.getByRole('alert').innerText(), /HTTP 401.*API 密钥/)
        assert.equal(await page.getByRole('status').count(), 0)
        status = 200
        hold = true
        await tap(button('生成图片'))
        await page.waitForFunction(() =>
          document.querySelector('.generate')?.textContent.includes('取消等待'),
        )
        await tap(button('取消等待'))
        await page.getByRole('status').waitFor()
        hold = false
        release?.()
        assert.equal(await page.locator('.image-generation-result').count(), 0)
        // Switch to OpenAI and run actual multipart editing with an input file.
        await tap(button('连接设置'))
        await tap(button('OpenAI'))
        assert.equal(await page.getByLabel('实际模型类型', { exact: true }).count(), 0)
        await page.locator('input[type=url]').fill('https://relay.example/v1/images/generations')
        await page.locator('input[type=password]').fill('fixture-only-key')
        await page.getByLabel('模型 ID', { exact: true }).fill('vendor-alias')
        await page.getByLabel('实际模型类型', { exact: true }).selectOption('gpt-image-2')
        await tap(button('拉取模型'))
        await page.getByRole('status').waitFor()
        assert.equal(
          await page.getByLabel('实际模型类型', { exact: true }).inputValue(),
          'gpt-image-2',
        )
        if (width === 390)
          await page.screenshot({
            path: resolve(environment.outputDir, `connection-relay-${theme}.png`),
          })
        await tap(button('完成'))
        await tap(button('参考 / 改图'))
        await page
          .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
          .setInputFiles({
            name: 'reference.png',
            mimeType: 'image/png',
            buffer: Buffer.from(image, 'base64'),
          })
        await page.getByLabel('修改指令', { exact: true }).fill('把外套改成白色')
        await tap(button('生成图片'))
        await page.locator('.image-generation-result img').waitFor()
        assert.equal(editedWithAlias, true)
        assert.equal(await page.getByRole('alert').count(), 0)
        assert.deepEqual(errors, [])
        checks.push({ width, height, theme, layout, requests })
      } catch (error) {
        await saveAuditFailure(context, environment, error)
        throw new Error(
          `${width}x${height}/${theme}: ${error.message}; page errors: ${errors.join('; ')}`,
          { cause: error },
        )
      } finally {
        release?.()
        await context.close()
      }
    }
  }
  await writeFile(
    resolve(environment.outputDir, 'workflow.json'),
    JSON.stringify(
      {
        engine: environment.engine,
        source: 'production component/services + HTTP fixtures; no paid provider/device',
        checks,
      },
      null,
      2,
    ),
  )
  console.log(
    `PASS ${environment.engine}: ${checks.length} viewport/theme combinations; actual generation, cancellation, album save/reload, editing and single error feedback`,
  )
} finally {
  await browser.close()
  await preview.close()
}
