/* global document, localStorage, getComputedStyle, indexedDB, navigator */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { auditButtonMaterial } from './SharedAppearanceAudit.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'
import {
  prepareInstallableStateData,
  auditInstallableStates,
  auditUnpaintedControls,
} from './InstallableAppearanceStates.mjs'

const apps = [
  ['draw', '抽了么', '.draw-actions'],
  ['stitch', '缝了么', '.stitch'],
  ['frontendWorkshop', '前端了么', '.fw-workbench'],
  ['imageGeneration', 'AI 生图', '.image-generation-app'],
  ['imageAlbum', '生图相册', '.generated-album'],
  ['userPersona', 'user才是老大', '.persona-app'],
  ['tavernBridge', '酒馆互传', '.tavern-bridge'],
  ['assistant', '蒜惹菈', '.product-assistant'],
]
const environment = auditEnvironment(undefined, 'installable-appearance')
const baseline = process.env.SRL_INSTALLABLE_BASELINE === '1'
const deep = process.env.SRL_INSTALLABLE_DEEP === '1'
const selectedApps = process.env.SRL_INSTALLABLE_APP_FILTER
  ? apps.filter(([id]) => process.env.SRL_INSTALLABLE_APP_FILTER.split(',').includes(id))
  : apps
assert.ok(selectedApps.length, 'Unknown installable APP filter')
const drawBeforeCss = process.env.SRL_DRAW_BASELINE_CSS
  ? await readFile(process.env.SRL_DRAW_BASELINE_CSS, 'utf8')
  : ''
async function material(page, selector, expected, pseudo = null) {
  if (baseline) return
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  const actual = await page
    .locator(selector)
    .first()
    .evaluate((element, pseudo) => {
      const style = getComputedStyle(element, pseudo)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderTopColor,
      }
    }, pseudo)
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, `${selector}: ${key}`)
}
async function drawData(page, remove = false) {
  if (!remove) {
    await page.getByLabel('选择单个资源文件，可多选', { exact: true }).setInputFiles(
      Array.from({ length: 10 }, (_, index) => ({
        name: 'appearance-character-' + index + '.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
              name: '样式角色' + String(index + 1).padStart(2, '0'),
              description: '隔离外观测试',
              personality: '',
              scenario: '',
              first_mes: '',
              mes_example: '',
              creator_notes: '',
              system_prompt: '',
              post_history_instructions: '',
              alternate_greetings: [],
              tags: [],
              creator: '',
              character_version: '',
              extensions: {},
            },
          }),
        ),
      })),
    )
    await page.waitForFunction(
      async () =>
        new Promise((accept, reject) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          opening.onerror = () => reject(opening.error)
          opening.onsuccess = () => {
            const db = opening.result,
              tx = db.transaction('resourceSummaries'),
              request = tx.objectStore('resourceSummaries').getAll()
            request.onsuccess = () =>
              accept(
                request.result.filter((record) => /^样式角色\d{2}$/.test(record.name)).length ===
                  10,
              )
            tx.oncomplete = () => db.close()
          }
        }),
    )
    return
  }
  await page.evaluate(
    async () =>
      new Promise((accept, reject) => {
        const opening = indexedDB.open('SillyTavernResourceLibrary')
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const db = opening.result,
            tx = db.transaction(
              ['resources', 'resourceSummaries', 'resourceListSummaries'],
              'readwrite',
            ),
            request = tx.objectStore('resourceSummaries').getAll()
          request.onsuccess = () => {
            for (const record of request.result)
              if (/^样式角色\d{2}$/.test(record.name))
                for (const name of ['resources', 'resourceSummaries', 'resourceListSummaries'])
                  tx.objectStore(name).delete(record.id)
          }
          tx.oncomplete = () => {
            db.close()
            accept()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
}
const ordinary = { backgroundColor: 'rgb(255, 244, 227)', color: 'rgb(68, 51, 92)' }
const primary = { backgroundColor: 'rgb(128, 85, 170)', color: 'rgb(255, 255, 255)' }
const controls = {
  draw: ['.draw-actions > button:not(.draw-actions__primary)', ordinary],
  stitch: ['.stitch input[type="search"]', { backgroundColor: 'rgb(234, 244, 255)' }],
  frontendWorkshop: ['.fw-home__create button', ordinary],
  imageGeneration: ['.image-generation-app .btn:not(.primary)', ordinary],
  imageAlbum: ['.generated-album__import > span', { backgroundColor: ordinary.backgroundColor }],
  userPersona: ['.persona-app__toolbar button', ordinary],
  tavernBridge: [".tavern-bridge__primary[data-relay-enabled='false']", ordinary],
  assistant: ['.product-assistant .feature-header-action', ordinary, '::before'],
}
const palette =
  ':root {--page-background:#faf4fc;--dialog-background:#f5e9ff;--dialog-border:#aa88bb;--dialog-radius:18px;--dialog-shadow:none;--button-background:#fff4e3;--button-border:#b89972;--button-color:#44335c;--button-radius:9px;--button-shadow:none;--button-primary-background:#8055aa;--button-primary-border:#8055aa;--button-primary-color:#fff;--control-background:#eaf4ff;--control-border:#8b9ec3;--control-radius:7px;--control-shadow:none;--selection-background:#ead9f5;--selection-border:#8055aa;--selection-color:#44335c;--selection-shadow:none;--color-accent:#8055aa;}' +
  (deep
    ? ':root {--color-canvas:#faf4fc;--color-surface:#fffafb;--color-surface-raised:#fffeff;--color-ink:#44335c;--color-ink-soft:#71617e;--color-accent-soft:#ead9f5;--color-line:#ddcddd;--color-line-strong:#aa88bb;--glass-panel:#f8effb;--glass-panel-strong:#fffafb;--glass-panel-muted:#f2e7f7;--glass-border:#aa88bb;--glass-shadow:none;}'
    : '')
const browser = await launchAuditBrowser(environment)
let context
await mkdir(environment.outputDir, { recursive: true })
try {
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await prepareAuditContext(context, environment)
  const page = await context.newPage(),
    errors = []
  page.setDefaultTimeout(30000)
  await page.goto(environment.baseUrl)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.app-shell').waitFor()
  await page.getByRole('button', { name: '功能', exact: true }).click()
  await page.getByRole('button', { name: 'APP 管理', exact: true }).click()
  await page.locator('.official-app-manager li').first().waitFor()
  for (const [, name] of apps) {
    const row = page
      .locator('.official-app-manager li')
      .filter({ has: page.locator('strong').filter({ hasText: new RegExp('^' + name + '$') }) })
    await row.getByRole('button', { name: '下载', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '安装成功' }).waitFor()
    console.log(`Installed: ${name}`)
  }

  for (const width of process.env.SRL_INSTALLABLE_WIDTHS
    ? process.env.SRL_INSTALLABLE_WIDTHS.split(',').map(Number)
    : baseline
      ? [390, 1280]
      : [320, 375, 390, 430, 1280])
    for (const theme of baseline ? ['light'] : ['light', 'dark']) {
      await page.setViewportSize({
        width,
        height: { 320: 800, 375: 812, 390: 844, 430: 932 }[width] ?? 1024,
      })
      await page.evaluate((value) => localStorage.setItem('srl-theme', value), theme)
      for (const [id, name, ready] of selectedApps) {
        await page.goto(environment.baseUrl)
        await page.locator('.app-shell').waitFor()
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
        if (deep) await prepareInstallableStateData(page, id)
        if (id === 'draw') {
          await drawData(page)
          await page
            .getByText(/^样式角色\d{2}$/, { exact: true })
            .first()
            .waitFor()
        }
        await page.addStyleTag({ content: palette })
        await page.getByRole('button', { name: '功能', exact: true }).click()
        if (!baseline && (await page.locator('.feature-desktop__pagination').isVisible())) {
          await material(
            page,
            '.feature-desktop__pagination > button:not(.feature-desktop__page-dot):not(:disabled)',
            ordinary,
          )
          const dots = page.locator('.feature-desktop__page-dot')
          for (const size of await dots.evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().height),
          ))
            assert.ok(size < 20, 'Pagination dots must keep their small geometry')
          await dots.last().click()
          assert.equal(await dots.last().getAttribute('aria-current'), 'page')
          await page.getByRole('button', { name: '上一页应用', exact: true }).click()
          assert.equal(await dots.first().getAttribute('aria-current'), 'page')
        }
        await openAuditFeature(page, name)
        await page.locator(ready).first().waitFor()
        if (deep && id === 'frontendWorkshop') {
          await page.locator('.fw-home, .fw-editor').first().waitFor()
          const projectHome = page.getByRole('button', { name: '返回项目首页', exact: true })
          if (await projectHome.isVisible()) await projectHome.click()
          await page.locator('.fw-home__create').waitFor()
        }
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all(
            document
              .getAnimations()
              .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
              .map((a) => a.finished.catch(() => undefined)),
          )
        })
        const geometry = await page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }))
        assert.ok(
          geometry.scroll <= geometry.client + 2,
          name + '/' + width + '/' + theme + ': horizontal overflow ' + JSON.stringify(geometry),
        )
        await material(page, ...controls[id])
        if (!baseline) await auditUnpaintedControls(page)
        if (!baseline) await auditButtonMaterial(page.locator('body'), `${id}/${width}/${theme}`)
        const capture = async (state = id) => {
          if (theme === 'light' && [390, 1280].includes(width))
            await page.screenshot({
              path: resolve(environment.outputDir, state + '-' + width + '.png'),
              animations: 'disabled',
            })
        }
        await capture()
        console.log('Captured: ' + width + '/' + theme + '/' + name)
        if (id === 'draw') {
          await page.getByRole('button', { name: '十连抽', exact: true }).click()
          const carousel = page.getByRole('dialog', { name: '十连抽结果', exact: true })
          await carousel.waitFor()
          await page
            .locator('.draw-carousel__filmstrip button[data-draw-index="9"].is-revealed')
            .waitFor()
          await page.locator('.draw-carousel__filmstrip button[data-draw-index="0"]').click()
          await page.locator('.draw-carousel__main-card--revealed').waitFor()
          assert.equal(await page.locator('.draw-carousel__filmstrip button').count(), 10)
          await material(page, '.draw-carousel', { backgroundColor: 'rgb(245, 233, 255)' })
          await material(page, '.draw-carousel__done', ordinary)
          await material(page, '.draw-carousel__primary', primary)
          await material(page, '.draw-carousel__filmstrip button.is-active', {
            backgroundColor: 'rgb(234, 217, 245)',
            borderColor: 'rgb(128, 85, 170)',
          })
          await material(page, '.draw-carousel__front', { backgroundColor: 'rgb(234, 244, 255)' })
          if (drawBeforeCss && theme === 'light' && [390, 1280].includes(width)) {
            const before = await page.addStyleTag({ content: drawBeforeCss })
            await capture('draw-ten-before')
            await before.evaluate((element) => element.remove())
          }
          await capture('draw-ten')
          await page.locator('.draw-carousel__controls button').last().click()
          await page
            .locator('.draw-carousel__filmstrip button[data-draw-index="1"].is-active')
            .waitFor()
          await carousel.getByRole('button', { name: '完成', exact: true }).click()
          await carousel.waitFor({ state: 'hidden' })
          await drawData(page, true)
          console.log('Ten-pull colors and navigation passed: ' + width + '/' + theme)
        }
        if (id === 'imageAlbum') {
          await page.getByRole('button', { name: '相册设置', exact: true }).click()
          await page.locator('.generated-album__settings').waitFor()
          await material(page, '.generated-album__settings', {
            backgroundColor: 'rgb(245, 233, 255)',
          })
          await capture('album-settings')
          await page.getByRole('button', { name: '关闭相册设置', exact: true }).click()
        }
        if (id === 'userPersona') {
          await page.getByRole('button', { name: '新建', exact: true }).click()
          await page.locator('.persona-app textarea').first().waitFor()
          await material(page, '.persona-app textarea', { backgroundColor: 'rgb(234, 244, 255)' })
          await capture('persona-editor')
        }
        if (id === 'tavernBridge') {
          await page.getByRole('button', { name: '酒馆互传设置', exact: true }).click()
          await page.locator('.tavern-transfer-settings').waitFor()
          const carrySwitch = page.getByRole('switch', {
            name: '聊天记录互传携带脚本',
            exact: true,
          })
          const original = await carrySwitch.isChecked()
          await carrySwitch.uncheck()
          await material(page, '.tavern-transfer-settings [role="switch"]', {
            backgroundColor: 'rgb(234, 244, 255)',
            borderColor: 'rgb(139, 158, 195)',
          })
          await carrySwitch.check()
          await material(page, '.tavern-transfer-settings [role="switch"]', {
            backgroundColor: 'rgb(128, 85, 170)',
            borderColor: 'rgb(128, 85, 170)',
          })
          await material(
            page,
            '.tavern-transfer-settings [role="switch"]',
            {
              backgroundColor: 'rgb(255, 255, 255)',
            },
            '::before',
          )
          await carrySwitch.setChecked(original)
          await capture('tavern-settings')
          await page.getByRole('button', { name: '关闭互传设置', exact: true }).click()
        }
        if (id === 'assistant') {
          await material(page, '.chat-composer__row', { backgroundColor: 'rgb(234, 244, 255)' })
          await material(page, '.chat-composer textarea', { backgroundColor: 'rgba(0, 0, 0, 0)' })
          await page.locator('.chat-composer textarea').fill('隔离外观测试，不发送')
          await material(page, '.chat-send svg', ordinary)
          await material(page, '.chat-generate svg', primary)
          await page.locator('.chat-composer textarea').fill('')
          await page.getByRole('button', { name: '聊天设置', exact: true }).click()
          await page.locator('.chat-settings').waitFor()
          const networkSwitch = page.getByRole('switch', { name: '联网工具', exact: true })
          await material(page, '[role="switch"][aria-label="联网工具"]', {
            backgroundColor: 'rgb(234, 244, 255)',
            borderColor: 'rgb(139, 158, 195)',
          })
          await networkSwitch.check()
          await material(page, '[role="switch"][aria-label="联网工具"]', {
            backgroundColor: 'rgb(128, 85, 170)',
            borderColor: 'rgb(128, 85, 170)',
          })
          await material(
            page,
            '[role="switch"][aria-label="联网工具"]',
            {
              backgroundColor: 'rgb(255, 255, 255)',
            },
            '::before',
          )
          await networkSwitch.uncheck()
          await capture('assistant-settings')
        }
        if (deep) await auditInstallableStates({ page, id, capture, baseline })
      }
      if (deep && theme === 'light' && [390, 1280].includes(width)) {
        await page.goto(environment.baseUrl)
        await page.locator('.app-shell').waitFor()
        await page.getByRole('button', { name: '功能', exact: true }).click()
        await openAuditFeature(page, '外观')
        await page.locator('.appearance-panel').first().waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({
          path: resolve(environment.outputDir, 'background-default-' + width + '.png'),
          animations: 'disabled',
        })
        await page.addStyleTag({ content: palette })
        await material(page, '.appearance-panel', { backgroundColor: 'rgb(255, 250, 251)' })
        await material(page, width > 860 ? 'body' : '.feature-hub', {
          backgroundColor: 'rgb(250, 244, 252)',
        })
        await page.screenshot({
          path: resolve(environment.outputDir, 'background-themed-' + width + '.png'),
          animations: 'disabled',
        })
      }
      assert.deepEqual(errors, [], width + '/' + theme + ': page errors')
    }
  await context.tracing.stop()
  await context.close()
  context = undefined
  console.log(
    `PASS: ${selectedApps.length} installable APP entries and their secondary states; desktop Chromium only.`,
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
