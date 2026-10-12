/* global document, getComputedStyle */
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { openAuditFeature, prepareAuditContext } from './AuditEnvironment.mjs'

// Real application screenshots, with the same fixture, viewport and preset on both runs.
export async function captureAppearanceControls(browser, environment) {
  await mkdir(environment.outputDir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } })
  try {
    await prepareAuditContext(context, environment)
    const page = await context.newPage()
    await page.goto(environment.baseUrl)
    await page.getByRole('button', { name: '功能', exact: true }).click()
    await openAuditFeature(page, '外观')
    const studio = page.locator('.appearance-studio')
    await studio.waitFor()
    const capture = async (prefix) => {
      for (const theme of ['light', 'dark']) {
        await page.getByRole('radio', { name: theme === 'light' ? '浅色档案' : '深色档案' }).click()
        for (const [width, height] of [
          [1280, 1024],
          [390, 1000],
        ]) {
          await page.setViewportSize({ width, height })
          await studio.locator('.appearance-panel').first().scrollIntoViewIfNeeded()
          await page.screenshot({
            path: resolve(environment.outputDir, `${prefix}-${theme}-${width}.png`),
            animations: 'disabled',
          })
        }
      }
    }
    await capture('controls')
    const preset = {
      id: 'appearance-controls',
      name: '局部覆盖演示',
      createdAt: '',
      updatedAt: '',
      globalCss: `/*${'g'.repeat(250_000)}*/\n:root { --color-accent:#1d707b; --radius-control:6px; --selection-background:#eadff4; --button-background:#faf5ff; --button-shadow:none; }`,
      scopedCss: { appearance: ':scope { --color-accent:#8055aa; }' },
    }
    await page.locator('[data-appearance-preset-import]').setInputFiles({
      name: 'appearance-controls.srl-style.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'srl-appearance-preset', version: 1, preset })),
    })
    await page.getByRole('button', { name: '保留更改', exact: true }).click()
    const colors = await studio.evaluate((element) => ({
      global: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
      local: getComputedStyle(element).getPropertyValue('--color-accent').trim(),
    }))
    assert.equal(colors.global, '#1d707b', 'global accent must remain unchanged')
    assert.equal(colors.local, '#8055aa', 'APP variable must override the inherited global accent')
    await capture('local-override')
    await page.setViewportSize({ width: 1280, height: 1024 })
    await studio.locator('.appearance-preset-manager').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: resolve(environment.outputDir, 'preset-controls.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '清空草稿', exact: true }).click()
    await page.getByRole('alertdialog', { name: '清空草稿', exact: true }).waitFor()
    await page.screenshot({
      path: resolve(environment.outputDir, 'confirmation.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '取消', exact: true }).click()
    if (process.env.SRL_APPEARANCE_CAPTURE_CSS) {
      const buffer = await readFile(process.env.SRL_APPEARANCE_CAPTURE_CSS)
      await page.locator('[data-appearance-preset-import]').setInputFiles({
        name: 'cotton-candy.css',
        mimeType: 'text/css',
        buffer,
      })
      await page.getByRole('button', { name: '保留更改', exact: true }).click()
      await capture('cotton-controls')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(environment.baseUrl)
      await page.locator('.mobile-brand-actions').waitFor({ state: 'visible' })
      await page.screenshot({
        path: resolve(environment.outputDir, 'cotton-library.png'),
        animations: 'disabled',
      })
    }
  } finally {
    await context.close()
  }
}
