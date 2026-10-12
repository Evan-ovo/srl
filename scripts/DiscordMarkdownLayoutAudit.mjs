/* global document */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { auditEnvironment, launchAuditBrowser } from './AuditEnvironment.mjs'
import { startAuditPreview } from './AuditPreviewServer.mjs'

const environment = auditEnvironment(undefined, 'discord-markdown')
if (!process.env.SRL_AUDIT_RUN || !process.env.SRL_AUDIT_OUTPUT_DIR)
  throw new Error('Use audit:isolated with an explicit run and output')
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = resolve(root, '.codex-tmp', environment.run, 'markdown-ui')
const source = (path) => resolve(root, path).replaceAll('\\', '/')
const content = [
  '# 开场白',
  '- 开场白分为两个时间点。三年前和三年后。',
  '- 建议按顺序阅读||想快速阅读者可以先看摘要再继续正文||',
  '- 感谢示例作者https://discord.com/channels/123/456',
  '- **粗体**，*斜体*、`代码`和[链接](https://example.com)，继续正文。',
  '1. **编号项**的正文和||说明||',
  '> 引用**重点**，保持原文。',
  '普通段落：https://example.com/image.png?rand=2',
  '```txt',
  '<img src=x onerror=alert(1)>',
  '```',
].join('\n')
await mkdir(fixture, { recursive: true })
await mkdir(environment.outputDir, { recursive: true })
await writeFile(
  resolve(fixture, 'index.html'),
  '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/main.js"></script>',
)
await writeFile(
  resolve(fixture, 'main.js'),
  `
import {createApp,h} from 'vue'
import Markdown from '${source('src/components/DiscordMarkdownText.vue')}'
import '${source('src/styles/Foundation.css')}'
import '${source('src/styles/GlassRefinement.css')}'
document.documentElement.dataset.theme=new URL(location.href).searchParams.get('theme') || 'light'
createApp({render:()=>h('main',{style:'margin:12px;padding:12px;min-width:0;font-size:16px;line-height:1.6;background:var(--color-surface);color:var(--color-ink)'},[h(Markdown,{content:${JSON.stringify(content)}})])}).mount('#app')
`,
)
await build({
  configFile: false,
  root: fixture,
  plugins: [vue()],
  build: { outDir: resolve(fixture, 'dist') },
})
const preview = await startAuditPreview({
  directory: resolve(fixture, 'dist'),
  port: Number(new URL(environment.baseUrl).port),
  run: environment.run,
})
let browser
const results = []
try {
  browser = await launchAuditBrowser(environment)
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true })
      try {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${preview.url}/?theme=${theme}`)
        await page.locator('.discord-markdown__line--list-item').first().waitFor()
        const geometry = await page.evaluate(() => {
          const lines = [...document.querySelectorAll('.discord-markdown__line--list-item')]
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            lines: lines.map((line) => {
              const box = line.getBoundingClientRect()
              const body = line.querySelector('.discord-markdown__content')
              const spoiler = line.querySelector('.is-spoiler')?.getBoundingClientRect()
              const link = line.querySelector('a')?.getBoundingClientRect()
              return {
                width: box.width,
                children: line.children.length,
                bodyWidth: body?.getBoundingClientRect().width ?? 0,
                spoilerWidth: spoiler?.width,
                spoilerHeight: spoiler?.height,
                linkWidth: link?.width,
                linkHeight: link?.height,
              }
            }),
          }
        })
        results.push({ width, theme, ...geometry })
        await page.screenshot({
          path: resolve(environment.outputDir, `markdown-${width}-${theme}.png`),
        })
        await writeFile(
          resolve(environment.outputDir, 'geometry.json'),
          JSON.stringify(results, null, 2),
        )
        assert.ok(geometry.overflow <= 1, 'Page overflow')
        for (const line of geometry.lines) {
          assert.equal(
            line.children,
            2,
            'List marker and complete inline body must be the only grid items',
          )
          assert.ok(line.bodyWidth > line.width * 0.75, 'Body fell into the narrow marker column')
          if (line.spoilerWidth !== undefined)
            assert.ok(line.spoilerHeight < 80, 'Spoiler wrapped one character per line')
          if (line.linkWidth !== undefined)
            assert.ok(line.linkHeight < 80, 'Link wrapped into a narrow column')
        }
        assert.equal(
          await page.locator('a[href="https://discord.com/channels/123/456"]').count(),
          1,
        )
        assert.equal(await page.locator('img').count(), 0)
        assert.deepEqual(errors, [])
        console.log(`PASS Discord Markdown: ${width} ${theme}; inline list/spoiler/link/code`)
      } finally {
        await context.close()
      }
    }
} finally {
  if (browser) await browser.close()
  await preview.close()
}
