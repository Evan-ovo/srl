import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { unzipSync, strFromU8 } from 'fflate'
import { resolve } from 'node:path'

async function returnToRoles(page, app) {
  await page.locator('.chat-reader-app[aria-busy="false"]').waitFor()
  if ((await page.locator('.chat-reader-app').getAttribute('data-reader-page')) === 'reader') {
    await app.locator('#readerMenu').tap()
    await app.locator('#readerBack').tap()
    await page.locator('.chat-reader-app[data-reader-page="chats"]').waitFor()
  }
  if ((await page.locator('.chat-reader-app').getAttribute('data-reader-page')) === 'chats')
    await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  await page.locator('.chat-reader-app[data-reader-page="roles"]').waitFor()
}

// Runs only against ChatReaderAudit's isolated browser database and synthetic records.
export async function auditReaderBackup({ page, app, out }) {
  await page.reload()
  await page.getByRole('button', { name: '导出', exact: true }).tap()
  const exportDialog = page.getByRole('dialog', { name: '导出资源', exact: true })
  await exportDialog.getByRole('button', { name: /^额外资源/ }).tap()
  assert.match(
    await exportDialog.getByRole('button', { name: /^读了么阅读数据/ }).getAttribute('class'),
    /is-selected/,
  )
  const downloadEvent = page.waitForEvent('download')
  await exportDialog.getByRole('button', { name: '导出全部资源', exact: true }).tap()
  const download = await downloadEvent
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  const entries = unzipSync(buffer)
  const manifest = JSON.parse(strFromU8(entries['manifest.json']))
  const reader = manifest.portableData.chatReader
  assert.ok(
    reader.some((record) => record.value?.note === '测试备注'),
    'notes included by default',
  )
  assert.ok(
    reader.some((record) => record.value?.marks?.length),
    'bookmarks included by default',
  )
  assert.equal(manifest.portableData.externalApps, undefined, 'no third-party code required')
  for (const chat of manifest.resources.filter((resource) => resource.type === 'chat')) {
    if (chat.metadata.chatDisplayRegexId)
      assert.ok(
        manifest.resources.some((resource) => resource.id === chat.metadata.chatDisplayRegexId),
      )
  }
  await exportDialog.waitFor({ state: 'hidden' })
  const companionId = manifest.resources.find(
    (resource) => resource.type === 'chat' && resource.metadata.chatDisplayRegexId,
  )?.metadata.chatDisplayRegexId
  if (companionId) {
    const companion = manifest.resources.find((resource) => resource.id === companionId)
    const card = page.getByRole('button', { name: `查看 ${companion.name} 详情`, exact: true })
    assert.equal(await card.count(), 0, 'companion hidden from library by default')
    await page.getByRole('button', { name: '设置', exact: true }).tap()
    const toggle = page.getByRole('checkbox', { name: /^隐藏聊天记录配套正则/ })
    await page.locator('.settings-switch-row').filter({ hasText: '隐藏聊天记录配套正则' }).tap()
    assert.equal(await toggle.isChecked(), false)
    await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
    await card.waitFor()
    await page.getByRole('button', { name: '设置', exact: true }).tap()
    await page.locator('.settings-switch-row').filter({ hasText: '隐藏聊天记录配套正则' }).tap()
    assert.equal(await toggle.isChecked(), true)
    await page.getByRole('button', { name: '关闭设置', exact: true }).tap()
    await card.waitFor({ state: 'hidden' })
  }
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.getByRole('button', { name: 'APP 管理', exact: true }).tap()
  const row = page.locator('.official-app-manager li').filter({ hasText: '读了么' })
  await row.getByRole('button', { name: '卸载', exact: true }).tap()
  await page.getByRole('button', { name: '确认仅卸载 APP', exact: true }).tap()
  await page.getByRole('button', { name: '知道了', exact: true }).tap()
  await row.getByRole('button', { name: '下载', exact: true }).tap()
  await row.getByText(/已安装/).waitFor()
  await page.getByRole('button', { name: '返回功能桌面', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await returnToRoles(page, app)
  await app.locator('[data-role]').filter({ hasText: '陆沉' }).tap()
  await app.getByText('测试备注', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.getByRole('button', { name: 'APP 管理', exact: true }).tap()
  await row.getByRole('button', { name: '清理数据', exact: true }).tap()
  await page.getByRole('button', { name: '确认清理数据', exact: true }).tap()
  await page.getByText(/已清理该 APP 的独占数据/).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '导出', exact: true }).tap()
  await page.getByRole('button', { name: /^从 ZIP 恢复备份/ }).tap()
  const restore = page.getByRole('dialog', { name: '恢复备份' })
  await restore
    .locator('input[type="file"]')
    .setInputFiles({ name: 'reader-backup.zip', mimeType: 'application/zip', buffer })
  await restore.getByRole('button', { name: '确认新增', exact: true }).tap()
  await restore.getByText('备份已安全恢复', { exact: true }).waitFor()
  await restore.getByRole('button', { name: '返回资源库', exact: true }).tap()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await returnToRoles(page, app)
  await app.locator('[data-role]').filter({ hasText: '陆沉' }).tap()
  await app.getByText('测试备注', { exact: true }).waitFor()
  await page.screenshot({ path: resolve(out, 'reader-backup-restored.png') })
}
