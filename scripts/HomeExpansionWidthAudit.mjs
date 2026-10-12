/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import console from 'node:console'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'home-expansion')
const results = []
await mkdir(environment.outputDir, { recursive: true })
for (const touch of [false, true]) {
  // Match desktop IAB's classic scrollbars; Playwright otherwise hides them in headless mode.
  const browser = await launchAuditBrowser(environment, {
    ...(touch ? {} : { ignoreDefaultArgs: ['--hide-scrollbars'] }),
  })
  const context = await browser.newContext({
    viewport: { width: 390, height: 800 },
    hasTouch: touch,
    isMobile: touch,
  })
  await prepareAuditContext(context, environment, { trace: false })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const measure = async (state) => ({
    state,
    ...(await page.evaluate(() => ({
      gutter: getComputedStyle(document.documentElement).scrollbarGutter,
      widths: ['.app-shell', '.sidebar', '.library', '.toolbar'].map(
        (selector) => document.querySelector(selector).getBoundingClientRect().width,
      ),
      overflow: document.body.scrollWidth - document.body.clientWidth,
    }))),
  })
  try {
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [
        [319, 615],
        [319, 800],
        [390, 800],
        [430, 932],
        [1024, 800],
      ]) {
        await page.setViewportSize({ width, height })
        await page.goto(environment.baseUrl)
        const protection = page.locator('[aria-controls="data-protection-panel"]')
        await protection.waitFor()
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value
        }, theme)
        const states = [await measure('closed')]
        assert.equal(states[0].gutter, touch ? 'auto' : 'stable')
        if (!touch && theme === 'light' && width === 390)
          await page.screenshot({ path: `${environment.outputDir}/home-closed-390.png` })
        await protection.click()
        await page.locator('#data-protection-panel').waitFor()
        states.push(await measure('protection-open'))
        if (!touch && theme === 'light' && width === 390)
          await page.screenshot({ path: `${environment.outputDir}/home-expanded-390.png` })
        await protection.click()
        await page.locator('#data-protection-panel').waitFor({ state: 'hidden' })
        states.push(await measure('protection-closed'))
        const filters = page.getByRole('button', { name: '展开文件夹与标签筛选', exact: true })
        if (await filters.isVisible()) {
          await filters.click()
          assert.equal(await filters.getAttribute('aria-expanded'), 'true')
          states.push(await measure('filters-open'))
          await filters.click()
          assert.equal(await filters.getAttribute('aria-expanded'), 'false')
          states.push(await measure('filters-closed'))
        }
        for (const state of states) {
          assert.ok(state.overflow <= 1, `${touch}/${theme}/${width}: 横向溢出`)
          state.widths.forEach((value, index) =>
            assert.ok(
              Math.abs(value - states[0].widths[index]) < 1,
              `${touch}/${theme}/${width}/${state.state}: 宽度变化`,
            ),
          )
        }
        results.push({ touch, theme, width, height, states })
      }
    }
    assert.deepEqual(errors, [])
  } catch (error) {
    await saveAuditFailure(context, environment, error)
    throw error
  } finally {
    await browser.close()
  }
}
await writeFile(
  `${environment.outputDir}/width-result.json`,
  JSON.stringify({ status: 'passed', results }, null, 2) + '\n',
)
console.log(
  '首页展开通过：桌面经典滚动条与模拟触摸/浅深色共20态，数据保护与筛选展开收起宽度稳定，无横向溢出',
)
