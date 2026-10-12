/* global document, localStorage, getComputedStyle, innerWidth */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { auditCabinetThumbnails } from './CabinetThumbnailAudit.mjs'
import { auditSharedAppearance } from './SharedAppearanceAudit.mjs'
import { captureAppearanceControls } from './AppearanceControlsCapture.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  findAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'appearance')
const browser = await launchAuditBrowser(environment)
let context
try {
  await captureAppearanceControls(browser, environment)
  await auditSharedAppearance(browser)
  await auditCabinetThumbnails(browser, environment)
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: environment.storageState,
  })
  await prepareAuditContext(context, environment)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const back = () => page.locator('.feature-app-header__back').first().click()
  const app = (name) => openAuditFeature(page, name)
  const manager = async () => {
    await page.getByRole('button', { name: 'APP 管理', exact: true }).click()
    await page.locator('.official-app-manager').waitFor()
  }
  const expand = async (details) => {
    if (!(await details.evaluate((element) => element.open)))
      await details.locator(':scope > summary').click()
  }
  const appearance = async () => {
    await app('外观')
    await page.locator('.appearance-studio').waitFor()
    await expand(page.locator('.appearance-advanced'))
  }
  const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor()
  const stored = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('srl.ui.customCssPresets')))
  await page.goto(environment.baseUrl)
  // 从首次资源库入口直接打开，不能依赖先访问功能桌面加载面板样式。
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.waitFor({ state: 'visible' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    )
    for (const [width, height] of [
      [320, 800],
      [375, 812],
      [390, 844],
      [430, 932],
    ]) {
      await page.setViewportSize({ width, height })
      const layout = await settings.evaluate((element) => ({
        display: getComputedStyle(element).display,
        width: element.getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }))
      assert.equal(layout.display, 'grid', `Cold settings style missing: ${theme} ${width}`)
      assert.ok(
        layout.width <= width + 1 && !layout.overflow,
        `Cold settings overflow: ${theme} ${width}`,
      )
    }
  }
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '功能', exact: true }).click()
  await appearance()
  await expand(page.locator('.appearance-inactive-scopes'))
  await page.getByRole('tab', { name: '抽了么', exact: true }).click()
  const preset = {
    id: 'fixture',
    name: '局部样式测试',
    globalCss: ':root { --audit-global: keep; }',
    scopedCss: {
      draw: ':scope { --audit-draw: kept; }',
      'app:imageGeneration': ':scope { --audit-image: retained; }',
    },
    createdAt: '',
    updatedAt: '',
  }
  await page.locator('[data-appearance-preset-import]').setInputFiles({
    name: 'audit.srl-style.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'srl-appearance-preset', version: 1, preset })),
  })
  await page.getByRole('button', { name: '保留更改', exact: true }).click()
  assert.equal((await stored())[0].scopedCss.draw, preset.scopedCss.draw)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-theme', value),
      theme,
    )
    await page.getByRole('button', { name: '清空草稿', exact: true }).click()
    const confirmation = page.getByRole('alertdialog', { name: '清空草稿', exact: true })
    await confirmation.waitFor({ state: 'visible' })
    const danger = await confirmation.locator('.confirm-dialog__confirm').evaluate((element) => {
      const css = getComputedStyle(element)
      return { background: css.backgroundColor, color: css.color }
    })
    assert.equal(danger.background, theme === 'dark' ? 'rgb(240, 168, 176)' : 'rgb(168, 73, 90)')
    assert.equal(danger.color, theme === 'dark' ? 'rgb(23, 39, 46)' : 'rgb(255, 255, 255)')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    await confirmation.waitFor({ state: 'hidden' })
    for (const [width, height] of [
      [320, 800],
      [375, 812],
      [390, 844],
      [430, 932],
    ]) {
      await page.setViewportSize({ width, height })
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `overflow ${theme} ${width}`,
      )
      await page
        .getByRole('group', { name: '抽了么原始 CSS', exact: true })
        .getByRole('button', { name: '复制原始 CSS', exact: true })
        .click({ trial: true })
    }
  }
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出可编辑预设', exact: false }).click()
  const bytes = []
  for await (const chunk of await (await downloadEvent).createReadStream()) bytes.push(chunk)
  assert.deepEqual(JSON.parse(Buffer.concat(bytes).toString()).preset.scopedCss, preset.scopedCss)
  await back()
  assert.equal(await findAuditFeature(page, '抽了么'), null, '未安装 APP 不应出现在桌面')
  assert.equal(
    await page
      .locator('.feature-hub')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('--audit-draw').trim()),
    '',
  )
  await manager()
  const draw = page.locator('.official-app-manager li').filter({ hasText: '抽了么' })
  await draw.getByRole('button', { name: '下载', exact: true }).click()
  await status('安装成功')
  await back()
  await appearance()
  await page.getByRole('tab', { name: /^抽了么/u }).waitFor()
  assert.ok(
    (await page.getByRole('tablist', { name: '选择要装修的界面' }).innerText()).includes('抽了么'),
  )
  await back()
  await app('抽了么')
  await page.locator('[data-official-app-ready="draw"]').waitFor({ state: 'attached' })
  assert.equal(
    await page
      .locator('.feature-hub')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('--audit-draw').trim()),
    'kept',
  )
  await back()
  await manager()
  await draw.getByRole('button', { name: '卸载', exact: true }).click()
  await page.getByRole('button', { name: '确认仅卸载 APP', exact: true }).click()
  await status('已卸载')
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  assert.equal((await stored())[0].scopedCss.draw, preset.scopedCss.draw)
  await back()
  await appearance()
  assert.ok(
    !(await page.getByRole('tablist', { name: '选择要装修的界面' }).innerText()).includes('抽了么'),
  )
  await expand(page.locator('.appearance-inactive-scopes'))
  assert.ok(
    (await page.getByRole('tablist', { name: '未安装 APP 的样式' }).innerText()).includes('抽了么'),
  )
  await back()
  await manager()
  await draw.getByRole('button', { name: '下载', exact: true }).click()
  await status('安装成功')
  await back()
  await app('抽了么')
  await page.locator('[data-official-app-ready="draw"]').waitFor({ state: 'attached' })
  assert.equal(
    await page
      .locator('.feature-hub')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('--audit-draw').trim()),
    'kept',
  )
  await back()
  await manager()
  await draw.getByRole('button', { name: '卸载', exact: true }).click()
  await page.getByLabel('同时删除 APP 数据', { exact: true }).check()
  assert.equal(
    await page.getByLabel('同时删除该 APP 的自定义样式', { exact: true }).isChecked(),
    false,
  )
  await page.getByRole('button', { name: '确认卸载并清除数据', exact: true }).click()
  await status('已卸载')
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  assert.equal((await stored())[0].scopedCss.draw, preset.scopedCss.draw)
  await draw.getByRole('button', { name: '清理数据', exact: true }).click()
  await page.getByLabel('同时删除该 APP 的自定义样式', { exact: true }).check()
  await page.getByRole('button', { name: '确认清理数据', exact: true }).click()
  await status('已清理该 APP 的独占数据')
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  const remaining = (await stored())[0]
  assert.equal(remaining.scopedCss.draw, undefined)
  assert.equal(remaining.scopedCss['app:imageGeneration'], preset.scopedCss['app:imageGeneration'])
  assert.equal(remaining.globalCss, preset.globalCss)
  assert.equal(
    await page.evaluate(() =>
      document.getElementById('srl-custom-ui-style').textContent.includes('--audit-draw'),
    ),
    false,
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS: cold settings and four viewports, registry scopes, dormant styles, editable export/import, installed-only CSS, uninstall/reinstall preservation, separate style deletion, global/other APP preservation, light/dark four viewports.',
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
