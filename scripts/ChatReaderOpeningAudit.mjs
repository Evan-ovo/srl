import { importReaderFixtureFiles } from './ChatReaderAuditSupport.mjs'
/* global requestAnimationFrame, document */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'

/** Reproduce a tall HTML-only opening with a Tavern avatar/header and a slow author stylesheet. */
export async function auditReaderOpening({ page, app, out }) {
  await page.reload()
  await importReaderFixtureFiles(page, {
    name: '长开场分页.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(
      [
        JSON.stringify({
          name: '陆沉',
          is_user: false,
          mes: '```html\n<!doctype html><html><head><link rel="stylesheet" href="https://reader.invalid/slow-opening.css"></head><body><main style="min-height:2200px"><h1>完整开场白</h1><p>外部样式未完成时也可以阅读。</p><button onclick="this.textContent=\'交互成功\'">展开详情</button></main></body></html>\n```',
        }),
        JSON.stringify({
          name: '陆沉',
          is_user: false,
          mes: [0, 1]
            .map(
              (index) =>
                '```html\n<html><head><link rel="stylesheet" href="https://reader.invalid/panel-' +
                index +
                '.css"></head><body><main style="min-height:100px">面板 ' +
                index +
                '</main><script>document.querySelector("main").style.minHeight="500px"</script></body></html>\n```',
            )
            .join('\n'),
        }),
      ].join('\n'),
    ),
  })
  await page.getByText('长开场分页', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await app.locator('[data-role="unbound"]').tap()
  await app.locator('.chat-open').filter({ hasText: '长开场分页' }).tap()
  const option = app.locator('#bindSelect option').filter({ hasText: '陆沉' })
  await app.locator('#bindSelect').selectOption(await option.getAttribute('value'))
  await app.locator('#bindConfirm').tap()
  await app.locator('#sheet').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  await app.locator('[data-role]').filter({ hasText: '陆沉' }).tap()
  await app.locator('.chat-open').filter({ hasText: '长开场分页' }).tap()
  await app.locator('.mes_text').first().waitFor()
  const tools = async () => {
    if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
  }
  await tools()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('[data-reading-mode="simple"]').tap()
  await app.locator('[data-setting="layout"][data-value="tavern"]').tap()
  await app.locator('[data-setting="mode"][data-value="page"]').tap()
  await app.locator('#opt-remote').setChecked(true)
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('[data-progress-mode="chapters"]').tap()
  await app.locator('[data-jump="0"]').tap()
  await tools()
  await app.locator('[data-panel="appearance"]').tap()
  await app.getByText('自定义 CSS / 导入美化', { exact: true }).tap()
  await app.locator('#cssInput').fill('')
  await app.locator('#applyCss').tap()
  await app.locator('#sheetClose').tap()
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [2549, 1332],
  ]) {
    await page.setViewportSize({ width, height })
    await app
      .locator('#readingFlow')
      .evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
    const panel = await app.locator('[data-chat-frontend]').first().boundingBox()
    const viewport = await app.locator('#readingViewport').boundingBox()
    assert.ok(
      Math.abs(panel.x - viewport.x) < 2,
      'opening starts on page one, with its avatar and name',
    )
    assert.match(await app.locator('#readerPosition').textContent(), /本段 1\/1 页/)
    assert.ok(await app.locator('#readingPage').evaluate((el) => el.clientHeight > 2200))
    assert.equal(
      await app
        .locator('[data-chat-frontend]')
        .first()
        .evaluate((el) => el.getClientRects().length),
      1,
      'a tall status panel is never fragmented into blank browser columns',
    )
  }
  let release, requested
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const seen = new Promise((resolve) => {
    requested = resolve
  })
  const slowCss = async (route) => {
    requested()
    await gate
    await route.fulfill({ body: '/* ready */', contentType: 'text/css' })
  }
  await page.context().route('https://reader.invalid/slow-opening.css', slowCss)
  try {
    await tools()
    await app.locator('#readerMore').tap()
    await app.locator('#fullPreview').tap()
    await app.locator('#enableInteractions').tap()
    await seen
    await app.getByRole('heading', { name: '完整开场白', exact: true }).waitFor()
    await page.screenshot({ path: resolve(out, 'opening-while-loading.png') })
    release()
    const frame = app
      .frameLocator('iframe[title="第 1 楼状态栏 1"]')
      .frameLocator('div.TH-render > iframe')
    await frame.getByRole('button', { name: '展开详情', exact: true }).tap()
    await frame.getByRole('button', { name: '交互成功', exact: true }).waitFor()
    assert.equal(await app.getByRole('heading', { name: '完整开场白', exact: true }).count(), 0)
    assert.match(await app.locator('#readerPosition').textContent(), /本段 1\/1 页/)
    await page.screenshot({ path: resolve(out, 'opening-ready.png') })
  } finally {
    release()
    await page.context().unroute('https://reader.invalid/slow-opening.css', slowCss)
  }
  // Both placeholders begin in one column. Later completions must not
  // make the reader follow a panel that was pushed onto the next column.
  await page.setViewportSize({ width: 390, height: 844 })
  const releases = [],
    gates = []
  for (let index = 0; index < 2; index++) {
    gates[index] = new Promise((resolve) => {
      releases[index] = resolve
    })
    await page.context().route('https://reader.invalid/panel-' + index + '.css', async (route) => {
      await gates[index]
      await route.fulfill({ body: '/* ready */', contentType: 'text/css' })
    })
  }
  try {
    await tools()
    await app.locator('[data-panel="display"]').tap()
    await app.locator('[data-setting="layout"][data-value="novel"]').tap()
    await app.locator('#sheetClose').tap()
    await tools()
    await app.locator('[data-panel="progress"]').tap()
    const requests = [0, 1].map((index) =>
      page.waitForRequest('https://reader.invalid/panel-' + index + '.css', { timeout: 12000 }),
    )
    await app.locator('[data-jump="1"]').tap()
    await Promise.all(requests)
    const reader = page
    for (let index = 0; index < 2; index++) {
      releases[index]()
      await reader.waitForFunction(
        (index) =>
          document
            .querySelector('.chat-reader-app__view')
            .shadowRoot.querySelector('#readingFlow')
            .shadowRoot.querySelector('[data-chat-frontend="' + index + '"]')
            .getBoundingClientRect().height >= 500,
        index,
      )
      const panel = await app.locator('[data-chat-frontend="0"]').boundingBox()
      const viewport = await app.locator('#readingViewport').boundingBox()
      assert.ok(
        Math.abs(panel.x - viewport.x) < 2,
        'loading a later panel keeps the current panel in view',
      )
      assert.match(await app.locator('#readerPosition').textContent(), /本段 1\//)
    }
    await page.screenshot({ path: resolve(out, 'panels-keep-reading-position.png') })
  } finally {
    releases.forEach((release) => release())
    for (let index = 0; index < 2; index++)
      await page.context().unroute('https://reader.invalid/panel-' + index + '.css')
  }
}
