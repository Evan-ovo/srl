/* global URL, document, getComputedStyle, navigator, performance, window */
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { chromium } from 'playwright-core'

const PROJECT_ROOT = process.cwd()
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'artifacts', 'mobile-audit-20260729')
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots')
const FIXTURE_DIR = path.join(OUTPUT_DIR, 'runtime-fixtures')
const CHARACTER_PATH = path.join(FIXTURE_DIR, 'synthetic-mobile-audit-character.json')
const CHARACTER_V2_PATH = path.join(FIXTURE_DIR, 'synthetic-mobile-audit-character-v2.json')
const WORLD_BOOK_PATH = path.join(FIXTURE_DIR, 'synthetic-mobile-audit-worldbook.json')
const BACKUP_PATH = path.join(OUTPUT_DIR, 'workflow-v63-synthetic-backup.zip')
const BASE_URL = process.env.SRL_AUDIT_BASE_URL || 'http://127.0.0.1:5173/'
const ASSET_ORIGIN = process.env.SRL_AUDIT_ASSET_ORIGIN
const REPORT_PATH = path.join(
  OUTPUT_DIR,
  path.basename(process.env.SRL_AUDIT_OUTPUT_FILENAME || 'mobile-workflow-v63-goal.json'),
)
const SCREENSHOT_PREFIX = process.env.SRL_AUDIT_SCREENSHOT_PREFIX || 'v63-goal-'
const USERNAME = process.env.SRL_AUDIT_USERNAME
const PASSWORD = process.env.SRL_AUDIT_PASSWORD
const EDGE_PATH =
  process.env.SRL_AUDIT_BROWSER ||
  (process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : chromium.executablePath())
const VAULT_PASSWORD = 'SRL-Audit-Only-2026'

if (!USERNAME || !PASSWORD) {
  throw new Error('缺少 SRL_AUDIT_USERNAME 或 SRL_AUDIT_PASSWORD 环境变量')
}

const characterFixture = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '移动端审计角色',
    description: '仅用于 SRL 移动端质量专项的合成角色，不含真实人物或私人数据。',
    personality: '稳定、简洁、可验证。',
    scenario: '在隔离的临时浏览器中检查资源详情与开场白预览。',
    first_mes: '你好，{{user}}。我是 {{char}}。',
    alternate_greetings: ['第二条移动端审计开场白。'],
    creator: 'SRL Mobile Audit',
    character_version: 'audit-1',
    tags: ['合成测试', '移动端'],
  },
}

const characterV2Fixture = {
  ...characterFixture,
  data: {
    ...characterFixture.data,
    name: '移动端审计角色二号',
    description: '用于移动端批量、关系与版本工作流的第二个合成角色。',
    first_mes: '你好，{{user}}。这是第二个移动端审计角色。',
    character_version: 'audit-2',
  },
}

const worldBookFixture = {
  name: '移动端审计世界书',
  description: '仅用于移动端质量专项的合成世界书。',
  entries: {
    0: {
      uid: 0,
      key: ['移动端审计'],
      keysecondary: [],
      comment: '移动端审计条目',
      content: '这是一条不包含真实数据的合成世界书内容。',
      constant: true,
      selective: false,
      order: 100,
      position: 0,
      disable: false,
    },
  },
}

async function writeJsonFixture(filePath, fixture) {
  await writeFile(filePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
}

await Promise.all([
  access(EDGE_PATH),
  mkdir(SCREENSHOT_DIR, { recursive: true }),
  mkdir(FIXTURE_DIR, { recursive: true }),
])
await Promise.all([
  writeJsonFixture(CHARACTER_PATH, characterFixture),
  writeJsonFixture(CHARACTER_V2_PATH, characterV2Fixture),
  writeJsonFixture(WORLD_BOOK_PATH, worldBookFixture),
])

const browser = await chromium.launch({
  executablePath: EDGE_PATH,
  headless: true,
  args: ['--disable-background-networking', '--disable-component-update'],
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
  reducedMotion: 'reduce',
  serviceWorkers: 'block',
  acceptDownloads: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 SRL-Workflow-Audit/1.0',
})
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
const checkpoints = []
const assertions = {}
const observations = {}
const consoleErrors = []
let auditFailure

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500))
})
page.on('pageerror', (error) => consoleErrors.push(error.message.slice(0, 500)))

async function visible(locator) {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible()) return item
  }
  throw new Error(`没有找到可见控件：${await locator.first().evaluateAll((items) => items.length)}`)
}

async function clickVisible(locator) {
  const control = await visible(locator)
  await control.click()
  return control
}

async function checkpoint(name) {
  await page.waitForTimeout(180)
  const metrics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const isVisible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      )
    }
    const belongsToHorizontalScroller = (element) => {
      let ancestor = element.parentElement
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor)
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          ancestor.scrollWidth > ancestor.clientWidth + 1
        ) {
          return true
        }
        ancestor = ancestor.parentElement
      }
      return false
    }
    const hasLargeLabel = (element) => {
      if (element.tagName !== 'INPUT') return false
      const type = element.getAttribute('type')
      if (type !== 'checkbox' && type !== 'radio') return false
      const label = element.closest('label')
      if (!label || !isVisible(label)) return false
      const rect = label.getBoundingClientRect()
      return rect.width >= 44 && rect.height >= 44
    }
    const identify = (element) => ({
      tag: element.tagName.toLowerCase(),
      text: (
        element.getAttribute('aria-label') ||
        element.textContent?.replace(/\s+/g, ' ').trim() ||
        ''
      ).slice(0, 72),
    })
    const activeModal = Array.from(
      document.querySelectorAll(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
      ),
    )
      .filter(isVisible)
      .at(-1)
    const overflow = Array.from(document.body.querySelectorAll('*'))
      .filter(isVisible)
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return (
          !element.closest('[data-audit-ignore-overflow]') &&
          !belongsToHorizontalScroller(element) &&
          (rect.left < -1 || rect.right > viewportWidth + 1)
        )
      })
      .slice(0, 20)
      .map(identify)
    const smallTargets = Array.from(
      document.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]',
      ),
    )
      .filter(isVisible)
      .filter((element) => !activeModal || activeModal.contains(element))
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        if (style.pointerEvents === 'none' || hasLargeLabel(element)) return false
        if (element.tagName === 'INPUT' && element.getAttribute('type') === 'range') {
          return rect.width < 44
        }
        return rect.width < 44 || rect.height < 44
      })
      .slice(0, 30)
      .map(identify)
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      theme: document.documentElement.dataset.theme,
      online: navigator.onLine,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      overflow,
      smallTargets,
      activeElement: identify(document.activeElement),
    }
  })
  const entry = { name, ...metrics }
  checkpoints.push(entry)
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${SCREENSHOT_PREFIX}workflow-${name}.png`),
    animations: 'disabled',
  })
  if (entry.horizontalOverflow || entry.overflow.length) {
    throw new Error(`${name} 出现横向溢出：${JSON.stringify(entry.overflow)}`)
  }
  if (entry.smallTargets.length) {
    throw new Error(`${name} 出现小于 44px 的触控目标：${JSON.stringify(entry.smallTargets)}`)
  }
}

function resourceCard(name) {
  return page
    .locator('.resource-card')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first()
}

async function openResource(name) {
  const card = resourceCard(name)
  await card.waitFor()
  await card.getByRole('button', { name: '查看并编辑资源详情' }).click()
  await page.getByRole('dialog', { name: '资源详情' }).waitFor()
}

async function closeNotice() {
  const close = page.getByRole('button', { name: '关闭通知' })
  if ((await close.count()) && (await close.first().isVisible())) await close.first().click()
}

try {
  if (ASSET_ORIGIN) {
    const baseOrigin = new URL(BASE_URL).origin
    await page.route(`${baseOrigin}/**`, async (route) => {
      const requestUrl = new URL(route.request().url())
      if (requestUrl.pathname.startsWith('/api/')) {
        await route.continue()
        return
      }
      const headers = await route.request().allHeaders()
      delete headers.cookie
      delete headers.origin
      delete headers.referer
      const assetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, ASSET_ORIGIN)
      const response = await route.fetch({ url: assetUrl.toString(), headers })
      await route.fulfill({ response })
    })
  }

  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.getByPlaceholder('输入内测账号').fill(USERNAME)
  await page.getByPlaceholder('输入密码').fill(PASSWORD)
  await page.locator('.auth-form__primary').click()
  await page.locator('.app-shell').waitFor({ timeout: 30_000 })
  consoleErrors.length = 0

  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  await clickVisible(page.getByRole('button', { name: '切换为深色模式' }))
  assertions.darkThemeApplied =
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark'
  await checkpoint('dark-theme')
  await clickVisible(page.getByRole('button', { name: '切换为浅色模式' }))
  assertions.lightThemeRestored =
    (await page.evaluate(() => document.documentElement.dataset.theme)) ===
    (initialTheme || 'light')

  const settingsButton = page.getByRole('button', { name: /设置|打开设置/ })
  if (!(await settingsButton.count())) {
    throw new Error(
      `恢复后未找到设置入口：${JSON.stringify({
        dialogs: await page.locator('[role="dialog"], [role="alertdialog"]').allTextContents(),
        buttons: (await page.getByRole('button').allTextContents()).slice(0, 40),
        body: (await page.locator('body').innerText()).slice(0, 500),
      })}`,
    )
  }
  await clickVisible(settingsButton)
  const remoteRow = page.locator('.settings-switch-row').filter({ hasText: '允许远程资源' })
  const scriptRow = page
    .locator('.settings-switch-row')
    .filter({ hasText: '完整运行隔离 JavaScript' })
  const remoteInput = remoteRow.locator('input')
  await remoteRow.click()
  assertions.remotePreviewEnabled = await remoteInput.isChecked()
  await scriptRow.click()
  await page.getByRole('alertdialog', { name: '高风险预览确认' }).waitFor()
  await page.keyboard.press('Escape')
  assertions.scriptPreviewCancelKeptDisabled = !(await scriptRow.locator('input').isChecked())
  await scriptRow.click()
  await page.getByRole('alertdialog', { name: '高风险预览确认' }).waitFor()
  await page.getByRole('button', { name: '开启脚本预览' }).click()
  assertions.scriptPreviewConfirmed = await scriptRow.locator('input').isChecked()
  await scriptRow.click()
  await remoteRow.click()
  assertions.previewPermissionsRestored =
    !(await scriptRow.locator('input').isChecked()) &&
    !(await remoteRow.locator('input').isChecked())
  await checkpoint('preview-permissions')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' })
  assertions.escapeClosedSettings = true

  const importInput = page.locator('input.import-button__input')
  await importInput.setInputFiles([CHARACTER_PATH, CHARACTER_V2_PATH, WORLD_BOOK_PATH])
  const versionImportDialog = page.getByRole('dialog', {
    name: /发现可能的新版本|这份卡内容已经存在/,
  })
  const versionCandidateDetected = await versionImportDialog
    .waitFor({ timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  if (versionCandidateDetected) {
    await versionImportDialog.getByRole('button', { name: '作为独立资源' }).click()
    await versionImportDialog.waitFor({ state: 'hidden', timeout: 20_000 })
  }
  assertions.versionCandidateHandled = true
  await page.getByText('移动端审计角色', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByText('移动端审计角色二号', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByText('移动端审计世界书', { exact: true }).first().waitFor({ timeout: 20_000 })
  assertions.localMultiImport = true
  await closeNotice()

  await openResource('移动端审计角色')
  await page.getByLabel('资源名称').fill('移动端审计角色·已验证')
  await page.getByLabel('资源描述').fill('已通过移动端详情、链接、关联和版本工作流验证。')
  await page.getByRole('button', { name: '添加链接' }).click()
  await page.getByPlaceholder('例：作者 DC 原帖').fill('审计 GitHub Release')
  await page
    .getByPlaceholder('https://discord.com/channels/...')
    .fill('https://github.com/SillyTavern/SillyTavern/releases/tag/1.13.4')
  await page.getByPlaceholder('可选：发布社区、版本、作者说明').fill('隔离审计链接')
  await page.getByRole('tab', { name: '关联' }).click()
  await page.getByPlaceholder('搜索名称、文件名或资源类型').fill('移动端审计世界书')
  const relation = page.locator('.resource-relation').filter({ hasText: '移动端审计世界书' })
  await relation.locator('input[type="checkbox"]').first().check()
  await page.getByRole('button', { name: '保存修改' }).click()
  await page.getByText('资源详情已保存', { exact: true }).waitFor()
  assertions.detailSaved = await page
    .getByText('移动端审计角色·已验证', { exact: true })
    .isVisible()
  await closeNotice()

  await openResource('移动端审计角色·已验证')
  observations.sourceLinkValues = await page
    .locator('.resource-links input')
    .evaluateAll((inputs) => inputs.map((input) => input.value))
  assertions.sourceLinkPersisted = observations.sourceLinkValues.includes('审计 GitHub Release')
  await page.getByRole('tab', { name: '关联' }).click()
  const persistedRelation = page
    .locator('.resource-relation')
    .filter({ hasText: '移动端审计世界书' })
  assertions.relationPersisted = await persistedRelation
    .locator('input[type="checkbox"]')
    .first()
    .isChecked()
  await page.getByRole('tab', { name: '版本' }).click()
  const versionSelect = page.locator('.manual-version-panel select')
  const versionOption = versionSelect.locator('option').filter({ hasText: '移动端审计角色二号' })
  const versionOptionValue = await versionOption
    .getAttribute('value', { timeout: 5_000 })
    .catch(() => null)
  if (!versionOptionValue) {
    throw new Error(
      `手动版本候选缺少“移动端审计角色二号”：${JSON.stringify(await versionSelect.locator('option').allTextContents())}`,
    )
  }
  await versionSelect.selectOption(versionOptionValue)
  await page.getByPlaceholder('可选：例如 2026.7 修订版 / 人设小改').fill('移动端手动归档')
  await page.getByRole('button', { name: '加入为历史版本' }).click()
  await page.getByRole('alertdialog', { name: '并入历史版本' }).waitFor()
  await page.getByRole('button', { name: '并入历史' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.resource-version-card').length === 2,
    undefined,
    { timeout: 30_000 },
  )
  observations.versionCardCount = await page.locator('.resource-version-card').count()
  observations.versionNoteValues = await page
    .locator('.resource-version-card__note textarea')
    .evaluateAll((inputs) => inputs.map((input) => input.value))
  observations.versionTabText = await page.getByRole('tab', { name: /版本/ }).innerText()
  assertions.manualVersionMerged =
    observations.versionCardCount === 2 &&
    observations.versionNoteValues.includes('移动端手动归档') &&
    observations.versionTabText.includes('2')
  await checkpoint('detail-links-relations-versions')
  const resourceDetailDialog = page.getByRole('dialog', { name: '资源详情' })
  await resourceDetailDialog.getByRole('button', { name: /^(关闭|返回资源库)$/ }).click()
  await resourceDetailDialog.waitFor({ state: 'hidden' })
  await closeNotice()

  await context.setOffline(true)
  await page.locator('input[type="search"]').fill('移动端审计角色·已验证')
  await openResource('移动端审计角色·已验证')
  assertions.offlineLocalDetailAvailable =
    (await page.evaluate(() => navigator.onLine)) === false &&
    (await page.getByRole('dialog', { name: '资源详情' }).isVisible())
  await checkpoint('offline-local-detail')
  const offlineDetailDialog = page.getByRole('dialog', { name: '资源详情' })
  await offlineDetailDialog.getByRole('button', { name: /^(关闭|返回资源库)$/ }).click()
  await offlineDetailDialog.waitFor({ state: 'hidden' })
  await context.setOffline(false)
  await page.locator('input[type="search"]').fill('')

  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: 125_000,
    uploadThroughput: 62_500,
    connectionType: 'cellular3g',
  })
  const weakNetworkStartedAt = performance.now()
  await clickVisible(page.getByRole('button', { name: '导出' }))
  await page.getByRole('dialog', { name: '导出资源' }).waitFor({ timeout: 20_000 })
  const weakNetworkPanelMs = Math.round((performance.now() - weakNetworkStartedAt) * 10) / 10
  assertions.weakNetworkAsyncPanelLoaded = weakNetworkPanelMs < 20_000
  await checkpoint('weak-network-export-panel')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: 'none',
  })

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const download = await downloadPromise
  await download.saveAs(BACKUP_PATH)
  assertions.fullExportDownloaded = await access(BACKUP_PATH).then(
    () => true,
    () => false,
  )
  await page.getByRole('button', { name: '关闭' }).click()
  await closeNotice()

  await page.getByRole('button', { name: '多选' }).click()
  await page.getByRole('button', { name: '选择 移动端审计世界书' }).click()
  await page.locator('.batch-bar__button--danger').click()
  const batchDeleteDialog = page.getByRole('alertdialog', { name: '批量删除' })
  await batchDeleteDialog.waitFor()
  await batchDeleteDialog.getByRole('button', { name: '删除' }).click()
  await page.getByText('已删除 1 项资源', { exact: true }).waitFor()
  assertions.batchDeleteCompleted = (await resourceCard('移动端审计世界书').count()) === 0
  await closeNotice()

  await clickVisible(page.getByRole('button', { name: '导出' }))
  await page.getByRole('button', { name: '从 ZIP 恢复备份' }).click()
  const restoreDialog = page.getByRole('dialog', { name: '恢复备份' })
  await restoreDialog.waitFor()
  await restoreDialog.locator('input[type="file"]').setInputFiles(BACKUP_PATH)
  await restoreDialog.getByText('安全新增', { exact: true }).waitFor({ timeout: 20_000 })
  await restoreDialog.getByRole('button', { name: '确认新增' }).click()
  await restoreDialog.getByText('备份已安全恢复', { exact: true }).waitFor({ timeout: 20_000 })
  assertions.backupRestoreCompleted =
    (await restoreDialog.getByText('新增资源').count()) > 0 ||
    (await restoreDialog.getByText('恢复资源').count()) > 0
  await checkpoint('backup-restored')
  await restoreDialog.getByRole('button', { name: '返回资源库' }).click()
  await page.getByText('移动端审计世界书', { exact: true }).first().waitFor()

  const restoredSettingsButton = page.locator('.mobile-bottom-nav button').filter({
    hasText: '设置',
  })
  await restoredSettingsButton.waitFor({ state: 'visible' })
  await restoredSettingsButton.evaluate((button) => button.focus())
  await page.waitForFunction(
    (button) => document.activeElement === button,
    await restoredSettingsButton.elementHandle(),
  )
  await page.keyboard.press('Enter')
  const restoredSettingsDialog = page.getByRole('dialog', { name: '设置' })
  await restoredSettingsDialog.waitFor()
  assertions.keyboardOpenedSettingsAfterRestore = true
  await restoredSettingsDialog.getByRole('button', { name: /本地保险库/ }).click()
  const vaultDialog = page.getByRole('dialog', { name: '本地保险库' })
  await vaultDialog.waitFor()
  await vaultDialog.getByLabel('设置密码').fill(VAULT_PASSWORD)
  await vaultDialog.getByLabel('再次输入').fill(VAULT_PASSWORD)
  await vaultDialog.getByRole('button', { name: '开启本地加密' }).click()
  await page
    .getByRole('alertdialog', { name: '开启本地保险库' })
    .getByRole('button', { name: '开启加密', exact: true })
    .click()
  await vaultDialog.getByText('已开启', { exact: true }).waitFor({ timeout: 30_000 })
  assertions.vaultEnabled = true
  await vaultDialog.getByRole('button', { name: '立即锁定' }).click()
  const unlockDialog = page.getByRole('dialog', { name: '解锁本地保险库' })
  await unlockDialog.waitFor()
  await unlockDialog.getByLabel('加密密码').fill('wrong-audit-password')
  await unlockDialog.getByRole('button', { name: '解锁资源库' }).click()
  await page
    .getByText(/密码|解锁失败/)
    .first()
    .waitFor({ timeout: 20_000 })
  assertions.wrongVaultPasswordRejected = await unlockDialog.isVisible()
  await unlockDialog.getByLabel('加密密码').fill(VAULT_PASSWORD)
  await unlockDialog.getByRole('button', { name: '解锁资源库' }).click()
  await page.getByText('本地保险库已解锁', { exact: true }).waitFor({ timeout: 30_000 })
  assertions.vaultUnlocked = !(await unlockDialog.isVisible())
  await checkpoint('vault-unlocked')
  await closeNotice()
  await page.locator('.mobile-bottom-nav button').filter({ hasText: '设置' }).click()
  const reopenedSettingsDialog = page.getByRole('dialog', { name: '设置' })
  await reopenedSettingsDialog.waitFor()
  await reopenedSettingsDialog.getByRole('button', { name: /本地保险库/ }).click()
  await vaultDialog.waitFor()
  await vaultDialog.getByRole('button', { name: '关闭并解密本地数据' }).click()
  const disableVaultDialog = page.getByRole('alertdialog', { name: '关闭本地加密' })
  await disableVaultDialog.waitFor()
  await disableVaultDialog.getByRole('button', { name: '关闭并解密' }).click()
  await vaultDialog.getByText('未开启', { exact: true }).waitFor({ timeout: 30_000 })
  assertions.vaultDisabled = true

  const expectedConsolePatterns = [/serviceworker/i, /sandboxed frame/i]
  const uniqueConsoleErrors = Array.from(new Set(consoleErrors))
  const unexpectedConsoleErrors = uniqueConsoleErrors.filter(
    (message) => !expectedConsolePatterns.some((pattern) => pattern.test(message)),
  )
  const failedAssertions = Object.entries(assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  if (failedAssertions.length || unexpectedConsoleErrors.length) {
    throw new Error(
      `工作流断言失败：${JSON.stringify({ failedAssertions, unexpectedConsoleErrors })}`,
    )
  }

  await page
    .getByRole('dialog', { name: '本地保险库' })
    .getByRole('button', { name: '关闭' })
    .click()
  await closeNotice()
  await clickVisible(page.getByRole('button', { name: /打开账号与设备|账号/ }))
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.locator('.auth-portal').waitFor({ timeout: 20_000 })

  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        isolation:
          '临时浏览器上下文；只导入合成资源，导出、删除、恢复和加密均不接触用户真实 IndexedDB 或云端。',
        viewport: { width: 390, height: 844 },
        weakNetworkPanelMs,
        assertions,
        observations,
        checkpoints,
        consoleErrors: uniqueConsoleErrors,
        unexpectedConsoleErrors,
        auditFailure: undefined,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
} catch (error) {
  auditFailure =
    error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error)
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        assertions,
        observations,
        checkpoints,
        consoleErrors: Array.from(new Set(consoleErrors)),
        auditFailure,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
} finally {
  await context.close()
  await browser.close()
}

if (auditFailure) throw new Error(auditFailure)
