/* global document, localStorage, navigator */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import console from 'node:console'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'relay-settings')
const browser = await launchAuditBrowser(environment)
await mkdir(environment.outputDir, { recursive: true })
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [1280, 800],
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height },
        hasTouch: true,
        isMobile: width < 600,
      })
      await prepareAuditContext(context, environment, { trace: false })
      const requests = []
      let healthy = true
      await context.addCookies([
        { name: 'relay-fixture', value: 'must-not-send', url: 'https://worker.example' },
      ])
      await context.route('**/api/cloud/health', async (route) => {
        requests.push(route.request().url())
        assert.equal(route.request().headers().cookie, undefined)
        await route.fulfill({
          status: healthy ? 200 : 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, service: 'srl-koofr-worker' }),
          headers: { 'Access-Control-Allow-Origin': environment.baseUrl },
        })
      })
      await context.route('**/api/bridge/health', async (route) => {
        requests.push(route.request().url())
        assert.equal(route.request().headers().cookie, undefined)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, service: 'srl-bridge-cloudflare' }),
          headers: { 'Access-Control-Allow-Origin': environment.baseUrl },
        })
      })
      const joins = []
      await context.route('**/api/bridge/join', async (route) => {
        joins.push(route.request().url())
        await route.fulfill({ status: 403, body: '{}' })
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const open = async () => {
        await page.getByRole('button', { name: /^(打开设置|设置)$/u }).tap()
        const panel = page.getByRole('dialog', { name: '设置', exact: true })
        return panel.getByRole('region', { name: '中继服务' })
      }
      try {
        await page.goto(environment.baseUrl)
        await page.getByRole('button', { name: /^(打开设置|设置)$/u }).waitFor()
        await page.evaluate((value) => {
          localStorage.setItem('srl-theme', value)
          document.documentElement.dataset.theme = value
        }, theme)
        let settings = await open()
        assert.ok((await settings.innerText()).includes('当前使用：未配置'))
        await settings
          .getByRole('textbox', { name: '自建 Worker 地址' })
          .fill('https://worker.example')
        await settings.getByRole('button', { name: '检查连接', exact: true }).tap()
        await settings.getByRole('status').filter({ hasText: '检测通过' }).waitFor()
        await settings.getByRole('button', { name: '保存', exact: true }).tap()
        await settings
          .getByText('当前使用：自建中继 · https://worker.example', { exact: true })
          .waitFor()
        await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
        await page.reload()
        // Downloaded APP modules require the real SW controller for their local file domain.
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
        settings = await open()
        await settings
          .getByText('当前使用：自建中继 · https://worker.example', { exact: true })
          .waitFor()
        healthy = false
        await settings.getByRole('button', { name: '检查连接', exact: true }).tap()
        await settings.getByRole('status').filter({ hasText: '503' }).waitFor()
        assert.equal(requests.length, 3)
        assert.ok(requests.every((url) => url.startsWith('https://worker.example/')))
        await settings
          .getByRole('textbox', { name: '自建 Worker 地址' })
          .fill('https://worker.example/private')
        await settings.getByRole('button', { name: '保存', exact: true }).tap()
        await settings.getByRole('status').filter({ hasText: '不能包含' }).waitFor()
        assert.equal(
          await page.evaluate(() => localStorage.getItem('srl.publicWorker.baseUrl.v1')),
          'https://worker.example',
        )
        await settings.getByRole('button', { name: '查看自部署中继教程' }).tap()
        const guide = page.locator('.relay-worker-guide')
        await guide.waitFor()
        assert.ok(
          await guide
            .locator('a[href="https://github.com/jixiangruyi117/SRL-Worker-Public/fork"]')
            .count(),
        )
        await guide.getByRole('button', { name: '返回设置' }).tap()
        await guide.waitFor({ state: 'hidden' })
        await settings.getByRole('button', { name: '清除地址', exact: true }).tap()
        await settings.getByText('当前使用：未配置', { exact: true }).waitFor()
        const geometry = await settings.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
          page: document.documentElement.clientWidth,
          pageScroll: document.documentElement.scrollWidth,
        }))
        assert.ok(
          geometry.scroll <= geometry.client + 1 && geometry.pageScroll <= geometry.page + 1,
          JSON.stringify(geometry),
        )
        await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
        await page.getByRole('button', { name: '功能', exact: true }).tap()
        await page.getByRole('button', { name: 'APP 管理', exact: true }).tap()
        const app = page.locator('.official-app-manager li').filter({ hasText: '酒馆互传' })
        await app.getByRole('button', { name: '下载', exact: true }).tap()
        await app.getByText(/已安装/u).waitFor()
        await page.locator('.feature-app-header__back').first().tap()
        await openAuditFeature(page, '酒馆互传')
        const form = page.locator('.tavern-device-join')
        assert.equal(await form.locator('input').isDisabled(), true)
        await form.getByRole('button', { name: '中继码未开启', exact: true }).tap()
        const dialog = page.locator('.confirm-dialog__overlay.is-centered[open] .confirm-dialog')
        await dialog.waitFor()
        assert.ok((await dialog.innerText()).includes('中继码功能已停用，请自部署worker'))
        const box = await dialog.boundingBox()
        assert.ok(box && Math.abs(box.x + box.width / 2 - width / 2) < 2)
        assert.ok(box && Math.abs(box.y + box.height / 2 - height / 2) < 2)
        assert.deepEqual(joins, [])
        await page.screenshot({ path: `${environment.outputDir}/relay-${width}-${theme}.png` })
        await dialog.getByRole('button', { name: '知道了', exact: true }).tap()
        await dialog.waitFor({ state: 'hidden' })
        assert.deepEqual(errors, [])
        console.log(
          `PASS relay settings: ${width} ${theme}; required custom worker check/save/reopen/failure/no fallback/invalid repair/guide/clear/disabled codes/centered prompt/no join`,
        )
      } catch (error) {
        await saveAuditFailure(context, environment, error)
        throw error
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
