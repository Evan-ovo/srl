/* global document */
import { importReaderFixtureFiles } from './ChatReaderAuditSupport.mjs'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'

/** Continue the normal reader audit, using its installed APP and isolated library. */
export async function auditReaderAppearance({ page, app, card, out }) {
  const appearance = async () => {
    if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
    await app.locator('[data-panel="appearance"]').tap()
    await app.locator('#appearanceScope').waitFor()
  }
  const leave = async () => {
    for (let layer = 0; layer < 4 && (await app.locator('#sheet[open]').count()); layer++) {
      const title = await app.locator('#sheetTitle').innerText()
      await app.locator('#sheetClose').tap()
      await page.waitForFunction((title) => {
        const root = document.querySelector('.chat-reader-app__view').shadowRoot
        return (
          !root.querySelector('#sheet').open ||
          root.querySelector('#sheetTitle').textContent !== title
        )
      }, title)
    }
    assert.equal(await app.locator('#sheet[open]').count(), 0, 'all reader sheet levels closed')
    if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
    await app.locator('#readerBack').tap()
    await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  }
  const openRole = async (name, title) => {
    await app.locator('[data-role]').filter({ hasText: name }).tap()
    await app.locator('.chat-open').filter({ hasText: title }).tap()
    await app.locator('.mes_text').first().waitFor()
  }
  await app.locator('.chat-open').first().tap()
  await app.locator('.mes_text').first().waitFor()
  await appearance()
  assert.equal(await app.locator('#appearanceScope').inputValue(), 'default')
  await app.locator('#appearanceScope').selectOption('character')
  await app.getByText('正在调整「陆沉」的外观与正则方案，同角色聊天共用。').waitFor()
  await app.locator('[data-theme="green"]').tap()
  await app.locator('[data-theme="green"].active').waitFor()
  const expectedFont = String(parseInt(await app.locator('#fontValue').innerText()) + 1) + 'px'
  await app.locator('#fontPlus').tap()
  await app.locator('#fontValue').filter({ hasText: expectedFont }).waitFor()
  const font = await app.locator('#fontValue').innerText()
  const defaultCss = await app.locator('#cssInput').inputValue()
  const characterCss = '#chat .mes_text{color:rgb(12,34,56)}'
  await app.getByText('自定义 CSS / 导入美化', { exact: true }).tap()
  await app.locator('#cssInput').fill('/* 尚未应用的草稿 */')
  await app.locator('#defaultCss').tap()
  const originalCss = await app.locator('#defaultCssSource').inputValue()
  assert.match(originalCss, /\.mes_text|\.reading-flow/)
  assert.doesNotMatch(originalCss, /#library|\.role-row|\.floor-picker/)
  const exported = page.waitForEvent('download')
  await app.locator('#exportDefaultCss').tap()
  const file = await exported
  assert.equal(file.suggestedFilename(), '读了么-默认正文.css')
  await app.locator('#backToCss').tap()
  assert.equal(await app.locator('#cssInput').inputValue(), '/* 尚未应用的草稿 */')
  await app.locator('#cssInput').fill(characterCss)
  await app.locator('#applyCss').tap()
  await app.locator('#panelAppearance').selectOption('reader')
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#regexRules').tap()
  const rule = app.locator('[data-rule="character:status"]')
  const group = rule.locator('xpath=ancestor::details[1]')
  if (!(await group.evaluate((el) => el.open))) await group.locator('summary').tap()
  await rule.setChecked(false)
  await app.locator('#applyRules').tap()
  await appearance()
  await app.locator('#appearanceScope').selectOption('default')
  await app.getByText(/正在调整默认外观/).waitFor()
  assert.equal(await app.locator('[data-theme="night"]').getAttribute('class'), 'swatch active')
  assert.notEqual(await app.locator('#fontValue').innerText(), font)
  await app.locator('#appearanceScope').selectOption('character')
  await app.getByText(/正在调整「陆沉」/).waitFor()
  assert.equal(await app.locator('#fontValue').innerText(), font)
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ]) {
    await page.setViewportSize({ width, height })
    assert.ok(await app.locator('#sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    assert.ok(
      await app
        .locator('label[for=appearanceScope]')
        .evaluate((el) => el.getBoundingClientRect().height < 30),
      'scope label stays on one line',
    )
  }
  await page.screenshot({ path: resolve(out, 'character-appearance.png') })
  await leave()

  // Reload preserves the real extension store; import and bind new samples through normal UI.
  await page.reload()
  const chatFile = (name, speaker) => ({
    name: name + '.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(
      JSON.stringify({ user_name: '许安', character_name: speaker, chat_metadata: {} }) +
        '\n' +
        JSON.stringify({
          name: speaker,
          is_user: false,
          mes: '<status>跨聊天方案</status>\n新聊天正文',
        }),
    ),
  })
  await importReaderFixtureFiles(page, [
    {
      name: '沈青.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...card, data: { ...card.data, name: '沈青' } })),
    },
    chatFile('另一段雨夜', '陆沉'),
    chatFile('沈青初见', '沈青'),
  ])
  await page.getByText('沈青初见', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await app.locator('[data-role="unbound"]').tap()
  for (const [name, title] of [
    ['陆沉', '另一段雨夜'],
    ['沈青', '沈青初见'],
  ]) {
    await app.locator('.chat-open').filter({ hasText: title }).tap()
    const label = await app.locator('#bindSelect option').filter({ hasText: name }).innerText()
    await app.locator('#bindSelect').selectOption({ label })
    await app.locator('#bindConfirm').tap()
    await app.locator('#sheet').waitFor({ state: 'hidden' })
  }
  await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  await openRole('陆沉', '另一段雨夜')
  await appearance()
  assert.equal(await app.locator('#appearanceScope').inputValue(), 'character')
  assert.equal(await app.locator('#fontValue').innerText(), font)
  assert.equal(await app.locator('#panelAppearance').inputValue(), 'reader')
  assert.equal(await app.locator('#cssInput').inputValue(), characterCss)
  assert.equal(await app.locator('[data-theme="green"]').getAttribute('class'), 'swatch active')
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#regexRules').tap()
  if (!(await group.evaluate((el) => el.open))) await group.locator('summary').tap()
  assert.equal(await rule.isChecked(), false, 'same character inherits saved rule after reload')
  await leave()
  await openRole('沈青', '沈青初见')
  await appearance()
  assert.equal(await app.locator('#appearanceScope').inputValue(), 'default')
  assert.equal(await app.locator('#cssInput').inputValue(), defaultCss)
  assert.equal(await app.locator('[data-theme="night"]').getAttribute('class'), 'swatch active')
  assert.notEqual(await app.locator('#fontValue').innerText(), font)
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#regexRules').tap()
  if (!(await group.evaluate((el) => el.open))) await group.locator('summary').tap()
  assert.equal(await rule.isChecked(), true, 'different character keeps archived rule settings')
  await leave()
  await openRole('陆沉', '另一段雨夜')
  await appearance()
  await app.locator('#resetAppearance').tap()
  await app.getByText(/正在调整默认外观/).waitFor()
  assert.equal(await app.locator('#appearanceScope').inputValue(), 'default')
  assert.equal(await app.locator('[data-theme="night"]').getAttribute('class'), 'swatch active')
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="display"]').tap()
  await app.locator('#regexRules').tap()
  if (!(await group.evaluate((el) => el.open))) await group.locator('summary').tap()
  assert.equal(await rule.isChecked(), true, 'reset returns to this chat archived switches')
  await app.locator('[data-rule="character:hide-all"]').setChecked(true)
  await app.locator('#applyRules').tap()
  await app.locator('#sheetTitle').filter({ hasText: '这一楼被正则隐藏了' }).waitFor()
  await app.locator('[data-disable-rule="character:hide-all"]').waitFor()
  await page.screenshot({ path: resolve(out, 'hidden-rule-confirmation.png') })
  await app.locator('#keepHidden').tap()
  await app.locator('[data-hidden-rules]').tap()
  await app.locator('#disableHidden').tap()
  await app.locator('.mes_text').filter({ hasText: '新聊天正文' }).waitFor()
  await leave()
}
