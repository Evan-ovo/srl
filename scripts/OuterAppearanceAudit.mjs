/* global document, getComputedStyle, localStorage */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { auditButtonMaterial } from './SharedAppearanceAudit.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'outer-appearance')
const browser = await launchAuditBrowser(environment)
const baseline = process.env.SRL_OUTER_BASELINE === '1'
const transferOnly = process.env.SRL_OUTER_TRANSFER_ONLY === '1'
const mismatches = []
let context
await mkdir(environment.outputDir, { recursive: true })
const palette =
  `:root {--page-background:#faf4fc;--dialog-background:#f5e9ff;--dialog-border:#aa88bb;--dialog-radius:18px;--dialog-shadow:none;--button-background:#fff4e3;--button-border:#b89972;--button-color:#44335c;--button-radius:9px;--button-shadow:none;--button-primary-background:#8055aa;--button-primary-border:#8055aa;--button-primary-color:#fff;--control-background:#eaf4ff;--control-border:#8b9ec3;--control-radius:7px;--control-shadow:none;--selection-background:#ead9f5;--selection-border:#8055aa;--selection-color:#44335c;--selection-shadow:none;--notice-background:#f5e9ff;--notice-shadow:none;--color-accent:#8055aa;}` +
  (process.env.SRL_OUTER_LEGACY_PALETTE === '1'
    ? ''
    : ':root {--color-canvas:#faf4fc;--color-accent-soft:#ead9f5;--color-surface:#fffafb;--color-surface-raised:#fffeff;--color-ink:#44335c;--color-ink-soft:#71617e;--glass-panel:#f8effb;--glass-panel-strong:#fffafb;--glass-panel-muted:#f2e7f7;--glass-border:#aa88bb;--glass-shadow:none;--overlay-background:rgba(68,51,92,.58);}')
try {
  for (const width of process.env.SRL_OUTER_WIDTHS
    ? process.env.SRL_OUTER_WIDTHS.split(',').map(Number)
    : [320, 375, 390, 430, 1280])
    for (const theme of ['light', 'dark']) {
      context = await browser.newContext({
        viewport: { width, height: width === 1280 ? 1024 : 844 },
      })
      await prepareAuditContext(context, environment)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const home = async () => {
        await page.goto(environment.baseUrl)
        await page.locator('.app-shell').waitFor()
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value
          localStorage.setItem('srl-theme', value)
        }, theme)
        await page.addStyleTag({ content: palette })
      }
      const inspect = async (name, host, checks = []) => {
        await host.waitFor({ state: 'visible' })
        await page.mouse.move(0, 0)
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished.catch(() => undefined)),
          )
        })
        const size = await host.evaluate((element) => ({
          width: element.clientWidth,
          scroll: element.scrollWidth,
        }))
        if (!baseline) await auditButtonMaterial(host, `outer/${name}/${width}/${theme}`)
        assert.ok(
          size.scroll <= size.width + 2,
          `${name}/${width}/${theme}: horizontal overflow ${JSON.stringify(size)}`,
        )
        for (const [selector, property, expected, pseudo] of checks) {
          const target = host.locator(selector).first()
          if (!(await target.count())) throw new Error(`${name}: missing ${selector}`)
          const actual = await target.evaluate(
            (element, { property, pseudo }) => getComputedStyle(element, pseudo)[property],
            { property, pseudo },
          )
          if (actual !== expected)
            mismatches.push(
              `${name}/${width}/${theme} ${selector} ${property}: ${actual} != ${expected}`,
            )
        }
        if (theme === 'light' && [390, 1280].includes(width))
          await page.screenshot({
            path: resolve(environment.outputDir, `${name}-${width}.png`),
            animations: 'disabled',
          })
      }
      if (!transferOnly) {
        await home()
        await page
          .getByRole('button', { name: width < 800 ? '设置' : '打开设置', exact: true })
          .click()
        const settings = page.getByRole('dialog', { name: '设置', exact: true })
        await inspect('settings', settings)
        await settings.locator('.main-api-settings').scrollIntoViewIfNeeded()
        await inspect('settings-api', settings, [
          ['.main-api-settings__control', 'backgroundColor', 'rgb(234, 244, 255)', '::before'],
          ['.main-api-settings__button-face', 'backgroundColor', 'rgb(255, 244, 227)'],
        ])
        await settings.getByRole('button', { name: /^本地保险库/ }).click()
        const vault = page.getByRole('dialog', { name: '本地保险库', exact: true })
        await inspect('vault', vault, [
          ['input[type="password"]', 'backgroundColor', 'rgb(234, 244, 255)'],
        ])
      }
      await home()
      await page.getByRole('button', { name: '导出', exact: true }).click()
      const exporting = page.getByRole('dialog', { name: '导出资源', exact: true })
      await inspect('export', exporting, [
        ['.backup-scope-tree__search', 'backgroundColor', 'rgb(234, 244, 255)'],
      ])
      await exporting.getByRole('button', { name: /从备份恢复|恢复备份/ }).click()
      await inspect('restore', page.getByRole('dialog', { name: '恢复备份', exact: true }), [
        ['.restore-picker', 'backgroundColor', 'rgb(255, 244, 227)'],
        ['.restore-picker', 'borderTopColor', 'rgb(184, 153, 114)'],
        ['.restore-picker', 'borderTopLeftRadius', '9px'],
        ['.restore-picker', 'color', 'rgb(68, 51, 92)'],
      ])
      await home()
      await page.locator(width < 800 ? '.mobile-bottom-nav__import' : '.import-button').click()
      const importing = page.getByRole('dialog', { name: '选择导入方式', exact: true })
      await inspect('import', importing, [
        ['.import-choice-card', 'backgroundColor', 'rgb(255, 244, 227)'],
        ['.import-choice-card__icon', 'backgroundColor', 'rgb(234, 217, 245)'],
      ])
      await importing.getByRole('button', { name: /^链接.*链接导入/ }).click()
      await inspect('link-import', page.getByRole('dialog', { name: '链接导入', exact: true }), [
        ['textarea', 'backgroundColor', 'rgb(234, 244, 255)'],
      ])
      if (transferOnly) {
        assert.deepEqual(errors, [], `${width}/${theme}: page errors`)
        await context.close()
        context = undefined
        continue
      }
      await home()
      await page
        .locator(width < 800 ? '.sidebar button[aria-label="打开账号与设备"]' : '.account-trigger')
        .click()
      await inspect('account', page.getByRole('dialog', { name: '账号与设备', exact: true }))
      await page.locator('.account-feedback-entry').click()
      const feedback = page.getByRole('dialog', { name: '问题反馈', exact: true })
      await feedback.getByRole('tab', { name: '社区协助', exact: true }).click()
      await inspect('feedback-search', feedback, [
        ['input', 'backgroundColor', 'rgb(234, 244, 255)'],
      ])
      await feedback.getByRole('tab', { name: '我的反馈', exact: true }).click()
      await feedback.getByRole('button', { name: '提交反馈', exact: true }).click()
      await inspect('feedback-form', feedback, [
        ['.feedback-center__form input', 'backgroundColor', 'rgb(234, 244, 255)'],
        ['.feedback-center__form select', 'backgroundColor', 'rgb(234, 244, 255)'],
        ['.feedback-center__form textarea', 'backgroundColor', 'rgb(234, 244, 255)'],
      ])
      await home()
      await page
        .getByRole('button', { name: width < 800 ? '设置' : '打开设置', exact: true })
        .click()
      await page
        .getByRole('dialog', { name: '设置', exact: true })
        .getByRole('button', { name: /文件夹|分类管理/ })
        .click()
      await inspect(
        'categories',
        page
          .locator('.editor-sheet')
          .filter({ has: page.getByRole('heading', { name: /文件夹|分类/ }) }),
      )
      await home()
      await page.getByRole('button', { name: '功能', exact: true }).click()
      await page.getByRole('button', { name: 'APP 管理', exact: true }).click()
      await inspect('app-manager', page.locator('.official-app-manager'), [
        ['ul button', 'backgroundColor', 'rgb(255, 244, 227)'],
      ])
      assert.deepEqual(errors, [], `${width}/${theme}: page errors`)
      await context.close()
      context = undefined
    }
  if (mismatches.length) console.log(mismatches.join('\n'))
  if (!baseline) assert.deepEqual(mismatches, [], 'outer appearance variable coverage')
  console.log(
    `PASS: outer appearance ${baseline ? 'baseline' : 'verification'}, ${transferOnly ? 'import/link/export/restore' : 'settings/API/vault/import/link/export/restore/account/feedback/categories/APP manager'}; light/dark × selected viewports.`,
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
