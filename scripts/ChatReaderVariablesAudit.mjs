import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export async function auditChatVariables({ page, app, out }) {
  await app.locator('#readerMore').tap()
  await app.locator('#variableReview').tap()
  await app.locator('.variable-change').first().waitFor()
  const text = await app.locator('#variableResults').innerText()
  assert.match(text, /第 5 楼 · 回复 2/)
  assert.match(text, /中间 3 楼未保存快照/)
  assert.match(text, /公园/)
  assert.match(text, /修改 \+8/)
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ]) {
    await page.setViewportSize({ width, height })
    assert.ok(await app.locator('#sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  }
  await page.screenshot({ path: resolve(out, 'variable-changes.png') })
  await app.locator('[data-variable-floor="3"]').tap()
  await app.getByText('本楼当前回复没有保存变量快照，无法判断变化。', { exact: true }).waitFor()
  await app.locator('[data-variable-jump="0"]').tap()
  await app.locator('#readerPosition').filter({ hasText: '第 1 /' }).waitFor({ state: 'attached' })
  if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
  await app.locator('#readerMore').tap()
  await app.locator('#variableReview').tap()
  await app
    .getByText('这是此前首次保存的变量快照，没有更早的快照可供比较。', { exact: true })
    .waitFor()
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('[data-jump="4"]').tap()
  await app.locator('.mes_text').filter({ hasText: '备用回复展示正文' }).waitFor()
}
