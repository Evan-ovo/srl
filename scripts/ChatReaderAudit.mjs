import { importReaderFixtureFiles } from './ChatReaderAuditSupport.mjs'
/* global window, document, localStorage, getComputedStyle, navigator, requestAnimationFrame */
import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { auditEnvironment, launchAuditBrowser, prepareAuditContext } from './AuditEnvironment.mjs'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { auditChatVariables } from './ChatReaderVariablesAudit.mjs'
import { auditReaderOpening } from './ChatReaderOpeningAudit.mjs'
import { auditReaderAppearance } from './ChatReaderAppearanceAudit.mjs'
import { auditReaderBackup } from './ChatReaderBackupAudit.mjs'
const environment = auditEnvironment(undefined, 'reader-native')
const out = environment.outputDir
await mkdir(out, { recursive: true })
const browser = await launchAuditBrowser(environment)
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})
await prepareAuditContext(context, environment, { trace: false })
console.log('BROWSER', browser.version())
await context.route('https://**/*', (route) =>
  route.request().resourceType() === 'stylesheet'
    ? route.fulfill({ body: '/* offline font fixture */', contentType: 'text/css' })
    : route.abort(),
)
await context.routeWebSocket(environment.baseUrl.replace('http:', 'ws:') + '/**', () => {})
await context.addInitScript(
  () =>
    window === window.top &&
    localStorage.setItem('srl.projectNotice.acknowledgedVersion', '2026-09-21-v2'),
)
const page = await context.newPage()
const importFixtureFiles = (files) => importReaderFixtureFiles(page, files)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 500))
})
page.setDefaultTimeout(12000)
let png,
  imageRequests = 0
await context.route('https://reader.invalid/image.png', async (route) => {
  imageRequests++
  await route.fulfill({ body: png, contentType: 'image/png' })
})
let decorationRequests = 0,
  fontRequests = 0
await context.route('https://reader.invalid/decoration.png', async (route) => {
  decorationRequests++
  await route.fulfill({ body: png, contentType: 'image/png' })
})
await context.route('https://reader.invalid/fonts.css', async (route) => {
  await route.fulfill({
    body: '@font-face{font-family:ReaderFixture;src:url(https://reader.invalid/font.woff2)}body{display:none}',
    contentType: 'text/css',
    headers: { 'access-control-allow-origin': '*' },
  })
})
await context.route('https://reader.invalid/font.woff2', async (route) => {
  fontRequests++
  await route.fulfill({
    body: await readFile('node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2'),
    contentType: 'font/woff2',
    headers: { 'access-control-allow-origin': '*' },
  })
})
page.on('requestfailed', (r) => console.log('FAILED REQUEST', r.url(), r.failure()))
try {
  await page.addLocatorHandler(
    page.locator('#srl-update-notice').getByRole('button', { name: '稍后', exact: true }),
    (el) => el.tap(),
  )
  await page.goto(environment.baseUrl)
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '陆沉',
      description: '测试卡',
      first_mes: '你好',
      personality: '安静',
      scenario: '雨夜',
      mes_example: '',
      extensions: {
        regex_scripts: [
          {
            id: 'hide-all',
            scriptName: '测试隐藏整楼',
            findRegex: '/[\\s\\S]+/g',
            replaceString: '',
            placement: [2],
            markdownOnly: true,
            disabled: true,
          },
          {
            id: 'status',
            scriptName: '状态栏',
            findRegex: '<status>(.*?)</status>',
            replaceString: '<details><summary>状态</summary>$1</details>',
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            disabled: false,
            minDepth: null,
            maxDepth: null,
          },
        ],
      },
    },
  }
  png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 320
      c.height = 480
      const ctx = c.getContext('2d')
      const gradient = ctx.createLinearGradient(0, 0, 320, 480)
      gradient.addColorStop(0, '#faf3d7')
      gradient.addColorStop(0.5, '#68896b')
      gradient.addColorStop(1, '#102619')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 320, 480)
      ctx.fillStyle = '#173528'
      ctx.beginPath()
      ctx.moveTo(0, 480)
      ctx.lineTo(70, 90)
      ctx.lineTo(140, 480)
      ctx.fill()
      ctx.fillStyle = '#fff8dd'
      ctx.beginPath()
      ctx.arc(245, 65, 35, 0, Math.PI * 2)
      ctx.fill()
      return c.toDataURL().split(',')[1]
    }),
    'base64',
  )
  const data = Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'))
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write('tEXt', 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  const cardPng = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
  const rows = Array.from({ length: 45 }, (_, i) => ({
    name: i % 2 ? '许安' : '陆沉',
    is_user: !!(i % 2),
    mes:
      i === 0
        ? '你好，{{user}}。\n![测试直链](https://reader.invalid/image.png)\n<status>心情：平静</status>\n\n' +
          '雨落在窗外，陆沉把书放在桌上。\n\n'.repeat(20)
        : i === 4
          ? '```html\n<!doctype html><html><body><button style="min-height:48px;padding:12px" onclick="this.textContent=\'已点击\';this.nextElementSibling.hidden=false;console.log(\'reader-full-click\')">互动状态栏</button><div hidden style="height:1200px;position:relative"><span>展开的状态详情</span><button style="min-height:48px;position:absolute;bottom:0" onclick="this.textContent=\'末尾操作成功\'">状态栏末尾</button></div></body></html>\n```'
          : `第${i + 1}楼，许安沿着小路散步。`,
  }))
  rows[4].swipes = [rows[4].mes, '备用回复展示正文']
  rows[4].swipe_id = 0
  rows[0].variables = [{ stat_data: { 地点: '家', 好感: 1, 任务: false } }]
  rows[4].variables = [
    { stat_data: { 地点: '基地', 好感: 5, 任务: true } },
    { stat_data: { 地点: '公园', 好感: 9, 任务: true } },
  ]
  await importFixtureFiles([
    { name: '陆沉.png', mimeType: 'image/png', buffer: cardPng },
    {
      name: '雨夜.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(
        [{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }, ...rows]
          .map((x) => JSON.stringify(x))
          .join('\n'),
      ),
    },
  ])
  await page.getByText('雨夜', { exact: true }).first().waitFor()
  console.log('Imported synthetic PNG card and 45-floor chat')
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.getByRole('button', { name: '返回资源库', exact: true }).tap()
  await importFixtureFiles({
    name: '阅读美化.css',
    mimeType: 'text/css',
    buffer: Buffer.from(
      '@import url("https://reader.invalid/fonts.css");#chat .mes_text{color:rgb(90,70,50)}.mes_block{background-image:url(https://reader.invalid/decoration.png)}#top-bar{display:none}',
    ),
  })
  await page.getByText('阅读美化', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.getByRole('button', { name: 'APP 管理', exact: true }).tap()
  const officialReader = page.locator('.official-app-manager li').filter({ hasText: '读了么' })
  await officialReader.getByRole('button', { name: '下载', exact: true }).tap()
  await officialReader.getByText(/已安装/).waitFor()
  await page.getByRole('button', { name: '返回功能桌面', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  console.log('Opened reader')
  await page.screenshot({ path: resolve(out, 'first.png') })
  const grant = page.getByRole('button', { name: '以后允许此权限', exact: true })
  await page.addLocatorHandler(grant, async () => {
    await grant.tap()
  })
  const app = page.locator('.chat-reader-app__view')
  await app.locator('.chat-reader-surface.builtin-shell').waitFor()
  assert.equal(
    await app.locator('.topbar').isVisible(),
    false,
    'only the shared host header is visible',
  )
  await page.getByRole('button', { name: '返回功能桌面', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await app.locator('.chat-reader-surface.builtin-shell').waitFor()
  await app.locator('#aboutBtn').tap()
  await page.keyboard.press('Escape')
  assert.equal(
    await app.locator('#sheet').evaluate((el) => el.open),
    false,
    'back closes a sheet before exiting the reader',
  )
  await page.getByRole('button', { name: '搜索', exact: true }).tap()
  await app.locator('#librarySearch').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '搜索', exact: true }).tap()
  // Override the environment-derived tokens, which SystemInsetsService refreshes on resize.
  // This tests the shared token contract without pretending desktop Chromium is a real iPhone.
  const simulatedInsets = await page.addStyleTag({
    content: ':root{--safe-top:47px!important;--safe-bottom:34px!important}',
  })
  await page.getByRole('button', { name: '角色沉浸背景', exact: true }).tap()
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="角色沉浸背景"]')?.getAttribute('aria-pressed') ===
      'true',
  )
  assert.equal(
    await page
      .getByRole('button', { name: '角色沉浸背景', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  if (!process.env.SRL_CHAT_BRIDGE_ROOT) {
    await app.locator('[data-role="unbound"]').tap()
    assert.equal(
      await app.locator('.character-cover').count(),
      0,
      'no image has a plain background',
    )
    await app.locator('[data-chat]').tap()
    await app
      .locator('#bindSelect')
      .selectOption({ label: await app.locator('#bindSelect option').nth(1).innerText() })
    await app.locator('#bindConfirm').tap()
    await page.getByRole('button', { name: '返回角色列表', exact: true }).tap({ trial: true })
    await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  } else {
    assert.equal(
      await app.locator('[data-role="unbound"]').count(),
      0,
      'transfer automatically binds the real card',
    )
    assert.equal(
      await app.locator('[data-role]').count(),
      1,
      'repeat delivery does not duplicate roles',
    )
  }
  await app.locator('.role-row img.avatar').waitFor()
  assert.equal(
    await app.locator('.role-row img.avatar').evaluate((img) => img.naturalWidth > 0),
    true,
  )
  await page.screenshot({ path: resolve(out, 'roles.png') })
  await app.locator('[data-role]').first().tap()
  await app.locator('.character-cover').waitFor()
  await app.locator('#toast').waitFor({ state: 'hidden' })
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ]) {
    await page.setViewportSize({ width, height })
    const header = await page.locator('.chat-reader-app [data-srl-feature-header]').boundingBox()
    const frame = await page.locator('.chat-reader-app__view').boundingBox()
    assert.equal(header.y, 47, 'shared top inset is consumed exactly once')
    assert.equal(
      await page.locator('.chat-reader-app').evaluate((el) => getComputedStyle(el).backgroundColor),
      await app
        .locator('.chat-reader-surface')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'header and safe-area background follow the reader theme',
    )
    assert.equal(
      frame.y,
      header.y + header.height,
      'iframe starts directly after the shared header',
    )
    assert.equal(Math.round(frame.y + frame.height), height - 34, 'host reserves the bottom inset')
    assert.equal(
      await app
        .locator('.chat-reader-surface')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--reader-safe-top').trim()),
      '0px',
    )
    assert.equal(
      await app
        .locator('.chat-reader-surface')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      `cover overflow ${width}`,
    )
    await page.screenshot({ path: resolve(out, `character-cover-${width}.png`) })
  }
  await simulatedInsets.evaluate((el) => {
    el.textContent =
      ':root{--safe-top:0px!important;--safe-bottom:21px!important;--safe-left:44px!important;--safe-right:44px!important}'
  })
  await page.setViewportSize({ width: 844, height: 390 })
  const landscapeFrame = await page.locator('.chat-reader-app__view').boundingBox()
  assert.equal(landscapeFrame.x, 44)
  assert.equal(landscapeFrame.width, 844 - 88)
  assert.equal(Math.round(landscapeFrame.y + landscapeFrame.height), 390 - 21)
  await page.screenshot({ path: resolve(out, 'builtin-landscape-insets.png') })
  await simulatedInsets.evaluate((el) => {
    el.textContent = ':root{--safe-top:47px!important;--safe-bottom:34px!important}'
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '角色沉浸背景', exact: true }).tap()
  await app.locator('.character-cover').waitFor({ state: 'detached' })
  assert.equal(await app.locator('.character-cover').count(), 0, 'cover can be disabled')
  await page.getByRole('button', { name: '角色沉浸背景', exact: true }).tap()
  await app.locator('.character-cover').waitFor()
  await app.locator('[data-chat]').tap()
  await app.locator('.mes_text').first().waitFor()
  assert.equal(
    await page.locator('.chat-reader-app [data-srl-feature-header]').count(),
    0,
    'reading has no permanent host toolbar',
  )
  const readingFrame = await page.locator('.chat-reader-app__view').boundingBox()
  assert.equal(readingFrame.y, 47)
  assert.equal(Math.round(readingFrame.height), 844 - 47 - 34)
  assert.equal(
    await app.locator('#reader').evaluate((el) => el.style.backgroundImage),
    '',
    'character cover does not affect the reader',
  )
  console.log('reading', await app.locator('#readerSubtitle').innerText())
  assert.match(await app.locator('.mes_text').first().innerText(), /你好，许安/)
  assert.equal(
    await app.locator('.reading-end').count(),
    0,
    'earlier batches must not claim completion',
  )
  assert.equal(await app.locator('.mes_text details summary').first().innerText(), '状态')
  assert.equal(imageRequests, 0, 'remote media remains off by default')
  await page.screenshot({ path: resolve(out, 'reader.png') })
  await app.locator('#readerMenu').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#opt-remote').tap()
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text img').waitFor()
  await app.locator('.mes_text img').evaluate((img) => img.decode())
  assert.ok(imageRequests > 0, 'authorized remote image loads')
  await app.locator('[data-panel="appearance"]').tap()
  await app.getByText('自定义 CSS / 导入美化', { exact: true }).tap()
  await app.locator('#cssInput').fill('.mes_text { color: rgb(90, 70, 50); }')
  await app.locator('#libraryCss').tap()
  await app.locator('[data-library-style]').filter({ hasText: '阅读美化' }).tap()
  assert.match(await app.locator('#cssInput').inputValue(), /mes_text/)
  assert.doesNotMatch(await app.locator('#cssInput').inputValue(), /top-bar/)
  await app.locator('#applyCss').tap()
  await app.locator('#sheetClose').tap()
  assert.equal(
    await app
      .locator('.mes_text')
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    'rgb(90, 70, 50)',
  )
  assert.match(
    await app
      .locator('.mes_block')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundImage),
    /decoration.png/,
  )
  await app
    .locator('.mes_block')
    .first()
    .evaluate(() => document.fonts.load('18px ReaderFixture', '\uf007'))
  assert.ok(fontRequests > 0, 'imported font bytes load without importing global body styles')
  assert.ok(decorationRequests > 0, 'CSS decoration image loads when remote media is allowed')
  assert.equal(
    await app
      .locator('.mes_text p')
      .first()
      .evaluate((el) => getComputedStyle(el).lineHeight),
    '33.3px',
  )
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#opt-remote').tap()
  await app.locator('#sheetClose').tap()
  assert.equal(
    await app
      .locator('.mes_block')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundImage),
    'none',
  )
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#opt-remote').tap()
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('45')
  await app.locator('#jump').tap()
  await app.locator('[data-floor="44"]').waitFor()
  for (const renderMode of ['simple', 'plain', 'full']) {
    await app.locator('[data-panel="display"]').tap()
    if (!(await app.locator(`[data-reading-mode="${renderMode}"].active`).count())) {
      await app.locator(`[data-reading-mode="${renderMode}"]`).tap()
      if (renderMode === 'full') await app.locator('#enableInteractions').tap()
      await app.locator('#sheet[open]').waitFor({ state: 'hidden' })
      await app
        .locator('#readerSubtitle')
        .filter({
          hasText: { simple: '精简阅读', plain: '纯净阅读', full: '完整阅读' }[renderMode],
        })
        .waitFor({ state: 'attached' })
    } else await app.locator('#sheetClose').tap()
    for (const layout of ['novel', 'tavern']) {
      for (const mode of ['continuous', 'scroll', 'page']) {
        await app.locator('[data-panel="display"]').tap()
        await app.locator(`[data-reading-mode="${renderMode}"].active`).waitFor()
        await app.locator(`[data-setting="layout"][data-value="${layout}"]`).tap()
        await app.locator(`[data-setting="layout"][data-value="${layout}"].active`).waitFor()
        await app.locator(`[data-setting="mode"][data-value="${mode}"]`).tap()
        await app.locator('#sheetClose').tap()
        await app.locator('[data-panel="progress"]').tap()
        await app.locator('#floorNumber').fill('45')
        await app.locator('#jump').tap()
        await app.locator('[data-floor="44"]').waitFor()
        const end = app.locator('.reading-end')
        await end.getByText('已阅读完全部内容', { exact: true }).waitFor()
        assert.equal(await end.count(), 1)
        const isVisibleInReader = () =>
          end.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const v = document
              .querySelector('.chat-reader-app__view')
              .shadowRoot.querySelector('#readingViewport')
              .getBoundingClientRect()
            return (
              r.left >= v.left - 1 &&
              r.right <= v.right + 1 &&
              r.top >= v.top - 1 &&
              r.bottom <= v.bottom + 1
            )
          })
        if (mode === 'page') {
          for (let i = 0; i < 10 && !(await isVisibleInReader()); i++)
            await app.locator('#nextPage').tap()
          assert.equal(
            await app.locator('#nextPage').isDisabled(),
            true,
            'no blank page after completion',
          )
        } else {
          await end.scrollIntoViewIfNeeded()
        }
        assert.ok(await isVisibleInReader(), `completion visible: ${renderMode}/${layout}/${mode}`)
        if (renderMode === 'simple' && layout === 'novel')
          await page.screenshot({ path: resolve(out, `reading-end-${mode}.png`) })
      }
    }
  }
  await app.locator('[data-panel="display"]').tap()
  await app.locator('[data-reading-mode="simple"]').tap()
  await app.locator('#sheet[open]').waitFor({ state: 'hidden' })
  await app
    .locator('#readerSubtitle')
    .filter({ hasText: '精简阅读' })
    .waitFor({ state: 'attached' })
  await app.locator('[data-panel="display"]').tap()
  await app.locator('[data-reading-mode="simple"].active').waitFor()
  await app.locator('[data-setting="layout"][data-value="novel"]').tap()
  await app.locator('[data-setting="mode"][data-value="scroll"]').tap()
  await app.locator('#sheetClose').tap()
  console.log(
    'PASS end-of-record marker: three render modes, two layouts, three navigation modes; no blank trailing page',
  )
  await app.locator('[data-panel="bookmarks"]').tap()
  await app.locator('#markCurrent').tap()
  await app.locator('[data-mark-jump]').waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('.identity-settings summary').tap()
  await app.locator('#replacement').fill('测试匿名')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已更新打码文字' }).waitFor()
  assert.equal(await app.locator('#opt-mask').isChecked(), true)
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text').first().filter({ hasText: '测试匿名' }).waitFor()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('.identity-settings summary').tap()
  // Updating an already active mask must render again from the original text.
  await app.locator('#maskWords').fill('小路')
  await app.locator('#replacement').fill('A')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已更新打码文字' }).waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text').first().filter({ hasText: '沿着A散步' }).waitFor()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('.identity-settings summary').tap()
  await app.locator('#replacement').fill('B')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已更新打码文字' }).waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text').first().filter({ hasText: '沿着B散步' }).waitFor()
  assert.doesNotMatch(await app.locator('.mes_text').first().innerText(), /沿着A散步|沿着小路散步/)
  await app.locator('[data-panel="display"]').tap()
  await app.locator('.identity-settings summary').tap()
  await app.locator('#maskMode').selectOption('cover')
  await app.locator('#maskWords').fill('  许安  ')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已开启文字遮挡' }).waitFor()
  await page.screenshot({ path: resolve(out, 'mask-settings.png') })
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text').first().filter({ hasText: '▇▇' }).waitFor()
  assert.doesNotMatch(await app.locator('.mes_text').first().textContent(), /许安|测试匿名/)
  await app.locator('[data-panel="display"]').tap()
  await app.locator('.identity-settings summary').tap()
  await app.locator('#maskMode').selectOption('replace')
  await app.locator('#replacement').fill('某某')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已更新打码文字' }).waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('.mes_text').first().filter({ hasText: '某某' }).waitFor()
  assert.doesNotMatch(await app.locator('.mes_text').first().innerText(), /许安/)
  await app.locator('[data-panel="search"]').tap()
  await app.locator('#textSearch').fill('第25楼')
  await app.locator('#runSearch').tap()
  await app.locator('[data-jump="24"]').tap()
  await app.locator('[data-floor="24"]').waitFor()
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ]) {
    await page.setViewportSize({ width, height })
    assert.equal(
      await app
        .locator('.chat-reader-surface')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      `overflow ${width}`,
    )
    await page.screenshot({ path: resolve(out, `reader-${width}.png`) })
  }
  await app.locator('[data-panel="display"]').tap()
  await app.locator('[data-setting="mode"][data-value="page"]').tap()
  await app.locator('#sheetClose').tap()
  await app.locator('#prevPage').tap()
  await app.locator('[data-floor="21"]').waitFor({ state: 'attached' })
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#opt-mask').tap()
  await app.locator('.mes_text').first().filter({ hasText: '许安' }).waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('5')
  await app.locator('#jump').tap()
  const previewFloor = await app.locator('[data-floor="4"]').boundingBox()
  const previewTouch = await context.newCDPSession(page)
  await previewTouch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: previewFloor.x + previewFloor.width - 8, y: previewFloor.y + 16 }],
  })
  await app.locator('#fullPreview').waitFor()
  await previewTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await previewTouch.detach()
  assert.equal(await app.locator('#sheetTitle').innerText(), '第 5 楼')
  await app.locator('#fullPreview').tap()
  await app.locator('#enableInteractions').tap()
  assert.equal(
    await page.locator('.chat-reader-preview').count(),
    0,
    'full mode stays in the reader',
  )
  const inline = app
    .frameLocator('iframe[title="第 5 楼状态栏 1"]')
    .frameLocator('div.TH-render > iframe')
  const panelBeforeExpand = await app.locator('iframe[title="第 5 楼状态栏 1"]').boundingBox()
  await inline.getByRole('button', { name: '互动状态栏', exact: true }).tap()
  await inline.getByRole('button', { name: '已点击', exact: true }).waitFor()
  const readerFrame = page
  await readerFrame.waitForFunction(
    () =>
      parseFloat(
        document
          .querySelector('.chat-reader-app__view')
          .shadowRoot.querySelector('#readingFlow')
          .shadowRoot.querySelector('iframe').style.height,
      ) >= 1200,
  )
  const panelAfterExpand = await app.locator('iframe[title="第 5 楼状态栏 1"]').boundingBox()
  assert.ok(
    Math.abs(panelAfterExpand.x - panelBeforeExpand.x) < 2,
    'expanded panel stays on the same page',
  )
  assert.ok(panelAfterExpand.height > 1200, 'full HTML height is not capped by the text page')
  assert.equal(
    await app.locator('#chapterNav').count(),
    0,
    'no chapter navigation buttons interrupt the reading flow',
  )
  const viewportBeforeResize = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 600 })
  await app
    .locator('#readingViewport')
    .evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const inlineGeometry = await app.locator('iframe[title="第 5 楼状态栏 1"]').evaluate((frame) => ({
    height: frame.getBoundingClientRect().height,
    viewport: document
      .querySelector('.chat-reader-app__view')
      .shadowRoot.querySelector('#readingViewport').clientHeight,
  }))
  assert.ok(
    inlineGeometry.height > inlineGeometry.viewport,
    'HTML remains fully extended when the viewport shrinks',
  )
  const scrollArea = await app.locator('#readingViewport').boundingBox()
  await page.mouse.move(scrollArea.x + scrollArea.width / 2, scrollArea.y + scrollArea.height / 2)
  await page.mouse.wheel(0, 1600)
  await inline.getByRole('button', { name: '状态栏末尾', exact: true }).tap()
  await inline.getByRole('button', { name: '末尾操作成功', exact: true }).waitFor()
  assert.equal(
    await app.locator('#reader').evaluate((el) => el.scrollTop),
    0,
    'focusing a panel never scrolls the fixed reader chrome',
  )
  assert.equal(
    await app.locator('#readingPage').evaluate((el) => el.scrollLeft),
    0,
    'focused HTML does not scroll the clipped page sideways',
  )
  assert.ok(
    await app.locator('#readingViewport').evaluate((el) => el.scrollTop > 500),
    'the reading page scrolls, not a nested status viewport',
  )
  assert.ok(
    await inline.locator('html').evaluate((el) => el.scrollHeight <= el.clientHeight + 2),
    'no internal iframe scroll is needed',
  )
  await app.locator('#nextPage').tap()
  assert.ok(
    await app
      .locator('#readingViewport')
      .evaluate((el) => el.scrollTop === 0 && el.scrollHeight <= el.clientHeight + 2),
    'ordinary text resumes normal page height',
  )
  await app.locator('#prevPage').tap()
  await page.setViewportSize(viewportBeforeResize)
  assert.equal(
    await inline.locator('body').evaluate(() => {
      try {
        return Boolean(window.parent.parent.document)
      } catch {
        return false
      }
    }),
    false,
  )
  await app.locator('[data-panel="appearance"]').tap()
  await app.locator('[data-theme="night"]').tap()
  await app.locator('[data-theme="night"].active').waitFor()
  await app.locator('#panelAppearance').selectOption('reader')
  await app.locator('#sheetClose').tap()
  await inline.locator('body').waitFor()
  await readerFrame.waitForFunction(() =>
    document
      .querySelector('.chat-reader-app__view')
      .shadowRoot.querySelector('#readingFlow')
      .shadowRoot.querySelector('iframe'),
  )
  assert.equal(
    await inline.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  )
  assert.equal(
    await inline.locator('html').evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  )
  await inline
    .locator('xpath=//style[contains(text(), "currentColor 25%")]')
    .waitFor({ state: 'attached' })
  const panelBodyBeforeFontChange = await inline.locator('body').elementHandle()
  await app.locator('[data-panel="appearance"]').tap()
  await app.locator('#fontPlus').tap()
  await app.locator('#fontValue').filter({ hasText: '19px' }).waitFor()
  await app.locator('#sheetClose').tap()
  assert.ok(
    await panelBodyBeforeFontChange.evaluate((el) => el.isConnected),
    'changing body font size preserves the interactive panel document',
  )
  assert.equal(
    await app
      .frameLocator('iframe[title="第 5 楼状态栏 1"]')
      .locator('html')
      .evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  )
  await app.locator('#readerBack').tap()
  await app.locator('[data-chat]').tap()
  await app.locator('[data-chat-frontend] iframe').waitFor()
  await app.locator('#readerMenu').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('[data-reading-mode="simple"]').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('[data-progress-mode="chapters"]').tap()
  await app.locator('[data-jump="4"]').tap()
  assert.equal(
    await app.locator('[data-floor]').count(),
    1,
    'chapter mode only renders its chosen floor',
  )
  await app.locator('#readerBack').tap()
  await app.locator('[data-chat]').tap()
  await app.locator('[data-floor="4"]').waitFor()
  assert.equal(
    await app.locator('[data-floor]').count(),
    1,
    'chapter resume keeps the selected floor',
  )
  await app.locator('#readerPosition').tap()
  await app.locator('[data-jump="4"]').tap()
  await app.locator('#readerMenu').tap()
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="1"]').tap()
  await app.locator('.mes_text').filter({ hasText: '备用回复展示正文' }).waitFor()
  await auditChatVariables({ page, app, out })
  await app.locator('[data-panel="bookmarks"]').tap()
  await app.locator('#markCurrent').tap()
  await app.locator('[data-mark-jump]').filter({ hasText: '回复 2' }).waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="0"]').tap()
  await app.locator('[data-chat-frontend]').waitFor()
  await app.locator('[data-panel="bookmarks"]').tap()
  await app.locator('[data-mark-jump]').filter({ hasText: '回复 2' }).tap()
  await app.locator('.mes_text').filter({ hasText: '备用回复展示正文' }).waitFor()
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('#compareReplies').tap()
  await app.locator('#compareFrom').selectOption('0')
  await app.locator('#compareTo').selectOption('1')
  await app.locator('#runCompare').tap()
  await app.locator('#replyDiff .added').filter({ hasText: '备用回复展示正文' }).waitFor()
  assert.equal(await app.locator('#replyDiff script').count(), 0)
  await page.screenshot({ path: resolve(out, 'reply-diff.png') })
  await app.locator('#sheetClose').tap()
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="0"]').tap()
  await app.locator('[data-chat-frontend]').waitFor()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('[data-progress-mode="jump"]').tap()
  await app.locator('[data-progress-mode="jump"].active').waitFor()
  await app.locator('#sheetClose').tap()

  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('1')
  await app.locator('#jump').tap()
  await app.locator('[data-floor="0"]').waitFor()
  await app.locator('.mes_text img').evaluate((img) => img.decode())
  const beforeSwipe = await app.locator('#readerPosition').textContent()
  await app.locator('#readingFlow').evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const original = window.Range.prototype.getClientRects
    window.readerMeasureCount = 0
    window.restoreReaderMeasure = () => {
      window.Range.prototype.getClientRects = original
    }
    window.Range.prototype.getClientRects = function () {
      window.readerMeasureCount++
      return original.call(this)
    }
  })
  const viewport = await app.locator('#readingViewport').boundingBox()
  const cdp = await context.newCDPSession(page)
  const y = viewport.y + viewport.height * 0.6,
    x = viewport.x + viewport.width * 0.8
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let step = 1; step <= 6; step++) {
    await delay(50)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - step * 24, y }],
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.notEqual(
    await app.locator('#readerPosition').textContent(),
    beforeSwipe,
    'real horizontal swipe turns a page',
  )
  console.log('SWIPE', beforeSwipe, await app.locator('#readerPosition').textContent())
  const measurements = await app.locator('#readingFlow').evaluate(() => {
    window.restoreReaderMeasure()
    return window.readerMeasureCount
  })
  assert.equal(
    measurements,
    0,
    'turning a measured page reuses layout instead of measuring every text node',
  )
  console.log('PASS page turn: 0 repeated text-range measurements')
  const savedPosition = await app.locator('#readerPosition').textContent()
  await app.locator('#readerBack').tap()
  await app.locator('[data-chat]').tap()
  await app.locator('.mes_text').first().waitFor()
  await app.locator('.mes_text img').evaluate((img) => img.decode())
  await app
    .locator('#readerPosition')
    .filter({ hasText: savedPosition })
    .waitFor({ state: 'attached' })
  assert.equal(
    await app.locator('#readerPosition').textContent(),
    savedPosition,
    'resume saved reading position',
  )
  await app.locator('#readerMenu').tap()
  await app.locator('#readerBack').tap()
  await app.locator('[data-chat]').waitFor({ state: 'visible' })
  const chatButton = await app.locator('[data-chat]').boundingBox()
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: chatButton.x + chatButton.width / 2, y: chatButton.y + chatButton.height / 2 },
    ],
  })
  await app.locator('#noteInput').waitFor()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await app.locator('#noteInput').fill('测试备注')
  await app.locator('#saveNote').tap()
  await app.getByText('测试备注', { exact: true }).waitFor()
  await app.locator('#toast').waitFor({ state: 'hidden' })
  await page.screenshot({ path: resolve(out, 'chats.png') })
  await page.reload()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await app.locator('[data-role]').first().tap()
  await app.locator('.character-cover').waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: '角色沉浸背景', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'cover preference survives reload',
  )
  await app.locator('.chat-open').first().tap()
  await app.locator('.mes_text').first().waitFor()
  await app.locator('.mes_text img').evaluate((img) => img.decode())
  await app
    .locator('#readerPosition')
    .filter({ hasText: savedPosition })
    .waitFor({ state: 'attached' })
  assert.equal(
    await app.locator('#readerPosition').textContent(),
    savedPosition,
    'progress survives a full host reload',
  )
  await page.screenshot({ path: resolve(out, 'resume.png') })
  await app.locator('#readerMenu').tap()
  await app.locator('[data-panel="appearance"]').tap()
  await app.locator('[data-theme="night"]').tap()
  await app.locator('#sheetClose').tap()
  await app.locator('#readerBack').tap()
  await app.locator('.character-cover .chat-row').waitFor()
  assert.equal(await app.getByText('长按记录，添加备注或整理', { exact: true }).count(), 0)
  assert.equal(
    await app.locator('.character-head').evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  )
  assert.match(
    await app
      .locator('.chat-row')
      .first()
      .evaluate((el) => getComputedStyle(el).backdropFilter),
    /blur/,
  )
  await page.screenshot({ path: resolve(out, 'character-cover-night.png') })
  console.log(
    'PASS PNG/import/install/bind/cover-toggle/regex/remote-media/CSS/jump/bookmark/mask/search/touch-swipe/inline-full/expand-in-page/chapters/alternate-replies/library-CSS/long-press-notes/reload-resume/four-mobile-widths',
  )
  await auditReaderAppearance({ page, app, card, out })
  console.log('PASS role appearance/default inheritance/regex profile/reload/cross-chat/reset')
  await auditReaderOpening({ page, app, out })
  console.log('PASS tall opening/page one/five sizes/readable while loading/interactive handoff')
  await auditReaderBackup({ page, app, out })
  console.log(
    'PASS hidden regex setting/builtin backup/uninstall retains data/clear isolated data/restore notes',
  )
  assert.deepEqual(errors, [], 'no browser page errors')
} catch (e) {
  console.error('Browser errors:', errors)
  console.error(
    'Reader notice:',
    await page
      .locator('.chat-reader-app__view')
      .locator('#toast')
      .textContent()
      .catch(() => 'unavailable'),
  )
  await page.screenshot({ path: resolve(out, 'failure.png') })
  throw e
} finally {
  await browser.close()
}
