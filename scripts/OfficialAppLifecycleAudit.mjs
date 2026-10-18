/* global document, innerWidth, localStorage, caches, window, indexedDB, fetch, getComputedStyle, navigator, Response, Cache, Request, location */
import assert from 'node:assert/strict'
import console from 'node:console'
import { auditButtonMaterial } from './SharedAppearanceAudit.mjs'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { officialAppIds } from './Check-FeatureContracts.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  findAuditFeature,
  saveAuditFailure,
  setAuditOffline,
  isExpectedOfflineApiError,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'official-apps')
const previewUrl = environment.baseUrl
const browser = await launchAuditBrowser(environment)
let context
try {
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: environment.storageState,
  })
  await prepareAuditContext(context, environment)
  await context.addInitScript(() => {
    window.__srlInstallBufferReads = undefined
    const read = Response.prototype.arrayBuffer
    Response.prototype.arrayBuffer = async function () {
      const bytes = await read.call(this)
      window.__srlInstallBufferReads?.push(bytes.byteLength)
      return bytes
    }
    if (typeof caches === 'undefined' || typeof Cache === 'undefined') return
    const appCaches = new WeakSet()
    const open = caches.open.bind(caches)
    caches.open = async (name) => {
      const cache = await open(name)
      if (name === 'srl-official-app-assets-v1') appCaches.add(cache)
      return cache
    }
    const match = Cache.prototype.match
    Cache.prototype.match = function (request, options) {
      if (appCaches.has(this) && window.__srlReadyChecks) {
        window.__srlReadyChecks.push(request instanceof Request ? request.url : String(request))
      }
      return match.call(this, request, options)
    }
  })
  const page = await context.newPage()
  const errors = []
  let offline = false
  const expectedNetworkErrors = []
  let currentAppName = 'startup'
  page.on('pageerror', (error) => {
    if (isExpectedOfflineApiError(error, environment, offline)) {
      expectedNetworkErrors.push(`${error.name}: ${error.message}`)
      return
    }
    errors.push(`${currentAppName}: ${error.stack || `${error.name}: ${error.message}`}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().startsWith('[SRL:'))
      errors.push(`${currentAppName}: ${message.text()}`)
  })
  const status = (text) => page.getByRole('status').filter({ hasText: text }).waitFor()
  const back = () => page.locator('.feature-app-header__back').first().click()
  const manager = async () => {
    await page.getByRole('button', { name: 'APP 管理', exact: true }).click()
    await page.locator('.official-app-manager').waitFor()
  }
  await page.goto(previewUrl)
  await page.getByRole('button', { name: '功能', exact: true }).click()
  await manager()
  await page.getByRole('button', { name: '查看 APP 管理说明' }).click()
  const managerHelp = page.locator('.official-app-manager__help-dialog')
  await managerHelp.waitFor({ state: 'visible' })
  assert.ok((await managerHelp.innerText()).includes('原有数据保留'))
  const helpGeometry = await managerHelp.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect()
    return { top: bounds.top, height: bounds.height, viewportHeight: window.innerHeight }
  })
  const helpCenter = helpGeometry.top + helpGeometry.height / 2
  assert.ok(
    Math.abs(helpCenter - helpGeometry.viewportHeight / 2) <= 2,
    `APP help dialog is not centered: ${JSON.stringify(helpGeometry)}`,
  )
  await managerHelp.getByRole('button', { name: '知道了' }).click()
  await managerHelp.waitFor({ state: 'hidden' })
  // A separate profile keeps the existing single-install/offline lifecycle intact.
  const batchContext = await browser.newContext({
    // Routing cannot hold requests served through a Service Worker. The main
    // profile below retains its Worker for the real install/offline lifecycle.
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: environment.storageState,
  })
  let batchPage
  try {
    await prepareAuditContext(batchContext, environment)
    batchPage = await batchContext.newPage()
    await batchPage.goto(previewUrl)
    await batchPage.getByRole('button', { name: '功能', exact: true }).tap()
    await batchPage.getByRole('button', { name: 'APP 管理', exact: true }).tap()
    await batchPage.locator('.official-app-manager[aria-busy="false"]').waitFor()
    const downloads = batchPage.locator('.official-app-manager__batch-download')
    for (const width of [320, 375, 390, 430]) {
      await batchPage.setViewportSize({ width, height: 844 })
      for (const theme of ['light', 'dark']) {
        await batchPage.evaluate((value) => {
          document.documentElement.dataset.theme = value
        }, theme)
        const bounds = await downloads.boundingBox()
        assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44)
        assert.equal(
          await batchPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        )
      }
    }
    await batchPage.locator('input[value="draw"]').locator('..').tap()
    await batchPage.locator('input[value="stitch"]').locator('..').tap()
    assert.equal(await downloads.getAttribute('aria-label'), '下载所选（2）')
    let releasePackages
    let requestsReady
    let requestsFailed
    let packageRequests = 0
    const packagesHeld = new Promise((accept) => {
      releasePackages = accept
    })
    const twoRequests = new Promise((accept, reject) => {
      requestsReady = accept
      requestsFailed = reject
    })
    const holdPackage = async (route) => {
      if (++packageRequests === 2) requestsReady()
      await packagesHeld
      await route.continue().catch(() => {})
    }
    await batchContext.route('**/*.srlapp', holdPackage)
    await downloads.tap()
    const requestTimer = setTimeout(
      () =>
        requestsFailed(new Error(`Expected 2 held package requests; observed ${packageRequests}`)),
      30_000,
    )
    try {
      await twoRequests
    } finally {
      clearTimeout(requestTimer)
    }
    await batchPage.getByRole('button', { name: '停止下载', exact: true }).tap()
    await batchPage.getByRole('status').filter({ hasText: '已停止下载，已完成 0 个' }).waitFor()
    assert.equal(packageRequests, 2)
    assert.equal(await batchPage.getByRole('button', { name: '卸载', exact: true }).count(), 0)
    releasePackages()
    await batchContext.unroute('**/*.srlapp', holdPackage)
    assert.equal(await batchPage.locator('input[value="draw"]').isChecked(), true)
    assert.equal(await batchPage.locator('input[value="stitch"]').isChecked(), true)
    await downloads.tap()
    await batchPage.getByRole('status').filter({ hasText: '下载结束：完成 2 个' }).waitFor()
    assert.equal(await batchPage.getByRole('button', { name: '卸载', exact: true }).count(), 2)
    await batchPage.evaluate(
      () =>
        new Promise((accept, reject) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          opening.onerror = () => reject(opening.error)
          opening.onsuccess = () => {
            const database = opening.result
            const transaction = database.transaction('settings', 'readwrite')
            const store = transaction.objectStore('settings')
            const getting = store.get('official-app:draw')
            getting.onsuccess = () => {
              const row = getting.result
              delete row.value.runtimeEntry
              store.put(row)
            }
            transaction.oncomplete = () => {
              database.close()
              accept()
            }
            transaction.onabort = () => {
              database.close()
              reject(transaction.error)
            }
          }
        }),
    )
    await batchPage.reload()
    await batchPage.getByRole('button', { name: '功能', exact: true }).tap()
    await batchPage.getByRole('button', { name: 'APP 管理', exact: true }).tap()
    await batchPage.locator('.official-app-manager[aria-busy="false"]').waitFor()
    const notice = batchPage.locator('.official-app-manager__updates-dialog')
    await notice.waitFor({ state: 'visible' })
    await notice.getByRole('button', { name: '稍后处理' }).tap()
    for (const width of [320, 375, 390, 430]) {
      await batchPage.setViewportSize({ width, height: 844 })
      assert.equal(
        await batchPage.evaluate(() => {
          const title = document.querySelector('.feature-app-header h1')
          return (
            document.documentElement.scrollWidth > innerWidth ||
            title.scrollWidth > title.clientWidth
          )
        }),
        false,
        `both batch actions/${width}`,
      )
      assert.equal(await batchPage.locator('.official-app-manager__batch-update').isVisible(), true)
    }
    assert.ok((await downloads.getAttribute('aria-label')).startsWith('下载全部'))
    const expectedDownloads = await batchPage
      .getByRole('button', { name: '下载', exact: true })
      .count()
    await downloads.tap()
    const batchPanel = batchPage.locator('.official-app-manager')
    // Bound each stalled phase, not the total duration of a multi-package batch.
    // WebKit's verified writes can advance normally for longer than 30 seconds.
    while ((await batchPanel.getAttribute('aria-busy')) === 'true') {
      const previous = await batchPanel.innerText()
      const change = await batchPage.waitForFunction((old) => {
        const panel = document.querySelector('.official-app-manager')
        return panel && (panel.getAttribute('aria-busy') !== 'true' || panel.innerText !== old)
      }, previous)
      await change.dispose()
    }
    await batchPage
      .getByRole('status')
      .filter({ hasText: `下载结束：完成 ${expectedDownloads} 个` })
      .waitFor()
    assert.equal(
      await batchPage.getByRole('button', { name: '卸载', exact: true }).count(),
      officialAppIds().length,
    )
    assert.equal(await downloads.count(), 0)
    console.log('多选下载、下载全部、刷新不复活、四种移动宽度浅深主题：通过')
  } catch (error) {
    const messages = await batchPage
      ?.getByRole('status')
      .allTextContents()
      .catch(() => [])
    await saveAuditFailure(
      batchContext,
      { ...environment, outputDir: resolve(environment.outputDir, 'batch') },
      error,
    )
    throw new Error(`APP 批量下载审计失败；当前状态：${messages?.join('；')}`, { cause: error })
  } finally {
    await batchContext.close()
  }
  const names = []
  for (const row of await page.locator('.official-app-manager li').all()) {
    const name = await row.locator('strong').innerText()
    names.push(name)
    const started = Date.now()
    await page.evaluate(() => {
      window.__srlInstallBufferReads = []
    })
    await row.getByRole('button', { name: '下载', exact: true }).tap()
    if (name === '前端了么') {
      await page.getByRole('button', { name: '查看 APP 管理说明' }).tap()
      await managerHelp.waitFor({ state: 'visible' })
      await managerHelp.getByRole('button', { name: '知道了' }).tap()
      await managerHelp.waitFor({ state: 'hidden' })
    }
    try {
      await status('安装成功')
    } catch (error) {
      const actual = await page.getByRole('status').allTextContents()
      throw new Error(`${name} 安装未完成；当前状态：${actual.join('；')}`, { cause: error })
    }
    const largeReads = await page.evaluate(() => {
      const reads = window.__srlInstallBufferReads
      window.__srlInstallBufferReads = undefined
      return reads.filter((size) => size > 4 * 1024 * 1024)
    })
    assert.deepEqual(largeReads, [], `${name} 安装时不得把大文件响应整体读进页面堆内存`)
    console.log(`安装通过：${name} / ${Date.now() - started} ms`)
  }
  assert.equal(names.length, officialAppIds().length)
  // Feature shell chunks use the normal runtime cache on first online visit.
  // Warm each installed APP before disabling the network so this checks a
  // real revisit offline, rather than an unvisited lazy chunk never precached.
  await back()
  const idsByName = new Map()
  for (const name of names) {
    currentAppName = `首次联网打开：${name}`
    await openAuditFeature(page, name)
    await page.waitForFunction(
      () =>
        !document.querySelector('.async-panel-loading') &&
        !document.querySelector('.official-app-install[aria-busy="true"]'),
    )
    assert.equal(
      await page.locator('.official-app-install,.async-panel-error,#srl-fatal-error').count(),
      0,
      `Online open failed before offline check: ${name}`,
    )
    idsByName.set(name, await page.locator('.feature-hub').getAttribute('data-feature-page'))
    const permission = page.locator('.external-app-permission')
    if (name === '读了么') {
      const reader = page.locator('.chat-reader-app__view')
      await reader.locator('#aboutBtn').waitFor({ state: 'visible' })
      assert.equal(await permission.count(), 0, '内置读了么普通读取不得重复确认')
      assert.ok(
        (await reader.locator('.chat-reader-surface').getAttribute('class')).includes(
          'builtin-shell',
        ),
      )
      assert.equal(await page.locator('iframe[title="读了么 内置 APP"]').count(), 0)
      assert.equal(await reader.locator('.topbar').isVisible(), false, '内置读了么不得显示重复页头')
    } else if (await permission.count()) {
      await permission.getByRole('button', { name: '仅同意这次' }).click()
    }
    await back()
  }
  if (process.env.SRL_AUDIT_NEXT_DIST) {
    const nextHtml = await readFile(resolve(process.env.SRL_AUDIT_NEXT_DIST, 'index.html'), 'utf8')
    const nextEntry = nextHtml.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/u)?.[1]
    assert.ok(nextEntry, '下一版本没有启动入口')
    const previousEntry = await page.locator('script[type="module"]').getAttribute('src')
    assert.notEqual(previousEntry, nextEntry, '两份候选的壳入口必须实际不同')
    const installedRecords = () =>
      page.evaluate(
        () =>
          new Promise((accept, reject) => {
            const opening = indexedDB.open('SillyTavernResourceLibrary')
            opening.onerror = () => reject(opening.error)
            opening.onsuccess = () => {
              const database = opening.result
              const transaction = database.transaction('settings', 'readonly')
              const getting = transaction.objectStore('settings').getAll()
              getting.onsuccess = () =>
                accept(
                  getting.result.filter((record) => String(record.id).startsWith('official-app:')),
                )
              transaction.oncomplete = () => database.close()
              transaction.onerror = () => reject(transaction.error)
            }
          }),
      )
    const before = await installedRecords()
    const nextInventory = JSON.parse(
      await readFile(resolve(process.env.SRL_AUDIT_NEXT_DIST, 'official-app-assets.json'), 'utf8'),
    )
    const nextCatalog = JSON.parse(
      await readFile(
        resolve(
          process.env.SRL_AUDIT_NEXT_DIST,
          'official-apps',
          nextInventory.shellVersion,
          'catalog.json',
        ),
        'utf8',
      ),
    )
    const oldById = new Map(before.map((row) => [row.value.id, row]))
    const unchanged = names.filter(
      (name) =>
        nextCatalog.apps[idsByName.get(name)].appContentRevision ===
        oldById.get(idsByName.get(name)).value.appContentRevision,
    )
    await page.evaluate(() => localStorage.setItem('srl.draw.showNames', 'true'))
    await new Promise((accept, reject) => {
      const receive = (message) => {
        if (message?.type !== 'srl-audit-upgrade-ready' || message.id !== 'upgrade') return
        process.removeListener('message', receive)
        accept()
      }
      process.on('message', receive)
      process.send({ type: 'srl-audit-upgrade', id: 'upgrade' }, (error) => {
        if (error) {
          process.removeListener('message', receive)
          reject(error)
        }
      })
    })
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update())
    let downloads = 0
    const capture = (request) => {
      if (request.url().endsWith('.srlapp')) downloads++
    }
    page.on('request', capture)
    await page.getByRole('button', { name: '立即刷新', exact: true }).click()
    await page.waitForFunction(
      (entry) => document.querySelector('script[type="module"]')?.getAttribute('src') === entry,
      nextEntry,
    )
    await page.getByRole('button', { name: '功能', exact: true }).click()
    for (const name of unchanged) {
      currentAppName = `更新后立即打开：${name}`
      await openAuditFeature(page, name)
      await page.waitForFunction(
        () =>
          !document.querySelector('.async-panel-loading,.official-app-install[aria-busy="true"]'),
      )
      assert.equal(
        await page.locator('.official-app-install,.async-panel-error,#srl-fatal-error').count(),
        0,
        name,
      )
      const permission = page.locator('.external-app-permission')
      if (name === '读了么') {
        await page
          .locator('.chat-reader-app__view')
          .locator('#aboutBtn')
          .waitFor({ state: 'visible' })
        assert.equal(await permission.count(), 0)
      }
      if (await permission.count())
        await permission.getByRole('button', { name: '仅同意这次' }).click()
      assert.ok((await page.locator('body').innerText()).includes(name))
      await back()
    }
    page.off('request', capture)
    assert.equal(downloads, 0, '普通壳更新不应重新下载APP')
    const after = await installedRecords()
    assert.equal(after.length, before.length, '不得卸载旧APP')
    for (const row of after) {
      const old = oldById.get(row.value.id)
      assert.equal(
        row.value.appContentRevision,
        old.value.appContentRevision,
        '不得自动升级APP内容',
      )
      assert.equal(row.value.installedAt, old.value.installedAt, '依赖修复保留原安装时间')
      const shell = new Map(nextInventory.shellFiles.map((file) => [file.path, file]))
      const moved = old.value.hostFiles.some((file) => shell.get(file.path)?.sha256 !== file.sha256)
      if (
        !moved ||
        nextCatalog.apps[row.value.id].appContentRevision !== old.value.appContentRevision
      )
        assert.deepEqual(row, old, '无须修复或内容已变化的APP保持原安装记录')
      else assert.equal(row.value.appContentHash, nextCatalog.apps[row.value.id].appContentHash)
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), 'true')
    assert.deepEqual(errors, [])
    console.log(
      `同源更新通过：真实SW接管、新壳入口、立即打开${unchanged.length}个未改动APP、零整包重下、数据/修订/安装时间保留`,
    )
    await mkdir(environment.outputDir, { recursive: true })
    await writeFile(
      resolve(environment.outputDir, 'upgrade-result.json'),
      JSON.stringify(
        {
          unchangedApps: unchanged.map((name) => idsByName.get(name)),
          zipDownloads: downloads,
          dataPreserved: true,
          contentRevisionsPreserved: true,
          errors,
        },
        null,
        2,
      ),
    )
  } else {
    // An intact installation from before runtime identity metadata must never
    // reach Vue rendering. Repair replaces program bytes without clearing data.
    const legacyEntry = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          opening.onerror = () => reject(opening.error)
          opening.onsuccess = () => {
            const database = opening.result
            const transaction = database.transaction('settings', 'readwrite')
            const settings = transaction.objectStore('settings')
            const getting = settings.get('official-app:draw')
            let entry
            getting.onsuccess = () => {
              const record = getting.result
              if (!record?.value?.runtimeEntry) {
                reject(new Error('Current runtime identity missing from installation'))
                return
              }
              entry = record.value.entry
              delete record.value.runtimeEntry
              settings.put(record)
            }
            transaction.oncomplete = () => {
              database.close()
              resolve(entry)
            }
            transaction.onerror = () => reject(transaction.error)
          }
        }),
    )
    await page.evaluate(() => localStorage.setItem('srl.draw.showNames', 'true'))
    const legacyModuleRequests = []
    const captureLegacyModule = (request) => {
      if (new URL(request.url()).pathname === legacyEntry) legacyModuleRequests.push(request.url())
    }
    page.on('request', captureLegacyModule)
    await page.reload()
    await page.getByRole('button', { name: '功能', exact: true }).click()
    // Reload first renders shared features, then asynchronously restores installed APPs.
    // This fixture starts on page one; wait for Draw's actual card before enumerating pages.
    await page.locator('.feature-app--draw').waitFor({ state: 'visible' })
    await openAuditFeature(page, '抽了么')
    await page.getByRole('button', { name: '下载兼容版本', exact: true }).waitFor()
    assert.deepEqual(
      legacyModuleRequests,
      [],
      'Legacy component imported before compatibility check',
    )
    assert.equal(await page.locator('#srl-fatal-error').count(), 0)
    page.off('request', captureLegacyModule)
    await page.getByRole('button', { name: '下载兼容版本', exact: true }).click()
    await page.locator('.draw-app__stats').waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), 'true')
    console.log('旧安装修复通过：导入前拦截、下载兼容包、原数据保留')
    await back()
    const markBatchRepair = () =>
      page.evaluate(
        () =>
          new Promise((accept, reject) => {
            const opening = indexedDB.open('SillyTavernResourceLibrary')
            opening.onerror = () => reject(opening.error)
            opening.onsuccess = () => {
              const database = opening.result
              const transaction = database.transaction('settings', 'readwrite')
              const store = transaction.objectStore('settings')
              for (const id of ['draw', 'stitch']) {
                const getting = store.get(`official-app:${id}`)
                getting.onsuccess = () => {
                  const record = getting.result
                  if (!record?.value?.runtimeEntry) {
                    transaction.abort()
                    return
                  }
                  delete record.value.runtimeEntry
                  store.put(record)
                }
              }
              transaction.oncomplete = () => {
                database.close()
                accept()
              }
              transaction.onabort = () => {
                database.close()
                reject(new Error('Batch repair fixture failed'))
              }
            }
          }),
      )
    const openBatchManager = async () => {
      await page.reload()
      await page.getByRole('button', { name: '功能', exact: true }).click()
      await manager()
      await page.locator('.official-app-manager__updates-dialog').waitFor({ state: 'visible' })
    }
    await markBatchRepair()
    await mkdir(environment.outputDir, { recursive: true })
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [
        [320, 800],
        [375, 812],
        [390, 844],
        [430, 932],
      ]) {
        await page.setViewportSize({ width, height })
        await openBatchManager()
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme
        }, theme)
        await auditButtonMaterial(
          page.locator('.official-app-manager__updates-dialog'),
          `APP updates/${width}/${theme}`,
        )
        if (width === 390 && theme === 'light')
          await page.screenshot({
            path: resolve(environment.outputDir, 'update-dialog-material-390.png'),
          })
        await page
          .locator('.official-app-manager__updates-footer')
          .getByRole('button', { name: '稍后处理' })
          .tap()
        for (const name of ['抽了么', '缝了么']) {
          const checkbox = page.getByRole('checkbox', { name: `选择更新${name}` })
          await checkbox.locator('..').tap()
          assert.equal(await checkbox.isChecked(), true)
        }
        const batchButton = page.getByRole('button', { name: '更新所选（2）', exact: true })
        await batchButton.scrollIntoViewIfNeeded()
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          titleFits: (() => {
            const title = document.querySelector('.feature-app-header h1')
            return title.scrollWidth <= title.clientWidth
          })(),
          controls: [
            ...document.querySelectorAll(
              '.official-app-manager button,.official-app-manager__select-update,.official-app-manager__batch-update',
            ),
          ].every((element) => {
            const box = element.getBoundingClientRect()
            return box.left >= 0 && box.right <= innerWidth && box.height >= 44
          }),
        }))
        assert.deepEqual(
          layout,
          { overflow: false, titleFits: true, controls: true },
          `${theme} ${width}: batch controls`,
        )
        await page.screenshot({
          path: resolve(environment.outputDir, `batch-${width}-${theme}.png`),
        })
      }
    }
    await page.getByRole('button', { name: '更新所选（2）', exact: true }).tap()
    await status('更新结束：完成 2 个')
    assert.equal(await page.locator('.official-app-manager__update-dot').count(), 0)
    assert.equal(
      await page.locator('.official-app-manager__progress').filter({ hasText: '更新成功' }).count(),
      2,
    )
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), 'true')
    await verifyBatchCompleteOnReentry()
    async function verifyBatchCompleteOnReentry() {
      // A fresh management visit must not ask for the same completed updates again.
      await page.reload()
      await page.getByRole('button', { name: '功能', exact: true }).click()
      await manager()
      await page.waitForFunction(
        (count) => document.querySelectorAll('.official-app-manager__latest').length === count,
        officialAppIds().length,
      )
      assert.equal(await page.locator('.official-app-manager__updates-dialog').count(), 0)
    }
    await markBatchRepair()
    await openBatchManager()
    await page
      .locator('.official-app-manager__updates-footer')
      .getByRole('button', { name: '更新全部（2）', exact: true })
      .tap()
    await status('更新结束：完成 2 个')
    assert.equal(await page.locator('.official-app-manager__update-dot').count(), 0)
    console.log(
      '批量更新通过：四宽度浅深色冷进入、真实触控多选和更新全部、两项就绪、再次进入不重复提醒、原数据保留',
    )
    await back()
    await openAuditFeature(page, '抽了么')
    await page.locator('.draw-app__stats').waitFor()
    const originalInstallations = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          opening.onerror = () => reject(opening.error)
          opening.onsuccess = () => {
            const database = opening.result
            const transaction = database.transaction('settings', 'readwrite')
            const settings = transaction.objectStore('settings')
            const getting = settings.getAll()
            getting.onerror = () => reject(getting.error)
            getting.onsuccess = () => {
              const installed = getting.result.filter((record) =>
                String(record.id).startsWith('official-app:'),
              )
              if (!installed.some((record) => record.id === 'official-app:draw')) {
                reject(new Error('Draw APP installation fixture missing'))
                return
              }
              const original = window.structuredClone(installed)
              for (const record of installed) {
                const owned = record.value.files.find((file) => !file.bundled)
                if (!owned) {
                  reject(new Error(`${record.id}: no APP-owned file in audit fixture`))
                  return
                }
                owned.sha256 = '0'.repeat(64)
                // A real host API mismatch must still be offered for explicit repair;
                // same-content file repairs are now handled on opening the APP.
                record.value.hostApiVersion = 1
                settings.put(record)
              }
              transaction.oncomplete = () => {
                database.close()
                resolve(original)
              }
            }
            transaction.onerror = () => reject(transaction.error)
          }
        }),
    )
    const updatePage = await context.newPage()
    let blockedUpdateDownloads = 0
    updatePage.on('request', (request) => {
      if (request.url().endsWith('.srlapp')) blockedUpdateDownloads++
    })
    await updatePage.goto(previewUrl)
    await updatePage.getByRole('button', { name: '功能', exact: true }).click()
    await updatePage.getByRole('button', { name: 'APP 管理', exact: true }).click()
    const updateDialog = updatePage.locator('.official-app-manager__updates-dialog')
    await updateDialog.waitFor({ state: 'visible' })
    assert.ok((await updateDialog.innerText()).includes('抽了么'))
    assert.equal(
      await updateDialog.locator('.official-app-manager__updates-list li').count(),
      officialAppIds().length,
    )
    assert.ok((await updateDialog.innerText()).includes('当前 APP 包版本：'))
    const latestVersion = await page.evaluate(
      async () =>
        (
          await (
            await fetch(
              `/official-apps/api-${(await (await fetch('/official-app-assets.json')).json()).hostApiVersion}/catalog.json`,
            )
          ).json()
        ).apps.draw[0].shellVersion,
    )
    const latestVersionLabel = latestVersion.replace(/^srl-/u, '').replace(/-v(\d+)$/u, ' (v$1)')
    assert.ok((await updateDialog.innerText()).includes(latestVersionLabel))
    const dialogLayout = await updateDialog.evaluate((dialog) => {
      const list = dialog.querySelector('.official-app-manager__updates-list')
      return {
        dialogTop: dialog.getBoundingClientRect().top,
        dialogHeight: dialog.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        listOverflowY: getComputedStyle(list).overflowY,
      }
    })
    assert.ok(
      dialogLayout.dialogHeight < dialogLayout.viewportHeight,
      'Update dialog must stay bounded',
    )
    assert.ok(
      Math.abs(
        dialogLayout.dialogTop - (dialogLayout.viewportHeight - dialogLayout.dialogHeight) / 2,
      ) < 2,
      'Update dialog must be centered in the viewport',
    )
    assert.ok(
      dialogLayout.listScrollHeight > dialogLayout.listClientHeight,
      'Update list should scroll internally',
    )
    assert.equal(dialogLayout.listOverflowY, 'auto')
    await updateDialog
      .locator('.official-app-manager__updates-list li')
      .filter({ hasText: '抽了么' })
      .getByRole('button', { name: '去更新', exact: true })
      .click()
    await updatePage
      .getByRole('status')
      .filter({ hasText: '其他页面正在使用这个 APP，请关闭后再更新' })
      .waitFor()
    assert.equal(blockedUpdateDownloads, 0, 'An active APP must reject update before downloading')
    await updatePage.close()
    await back()
    await page.evaluate(
      (records) =>
        new Promise((resolve, reject) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          opening.onerror = () => reject(opening.error)
          opening.onsuccess = () => {
            const database = opening.result
            const transaction = database.transaction('settings', 'readwrite')
            const settings = transaction.objectStore('settings')
            for (const record of records) settings.put(record)
            transaction.oncomplete = () => {
              database.close()
              resolve(true)
            }
            transaction.onerror = () => reject(transaction.error)
          }
        }),
      originalInstallations,
    )
    offline = true
    await setAuditOffline(context, environment, true)
    for (const name of names) {
      currentAppName = name
      await page.evaluate(() => {
        window.__srlReadyChecks = []
      })
      await openAuditFeature(page, name)
      await page.waitForFunction(
        () =>
          !document.querySelector('.async-panel-loading') &&
          !document.querySelector('.official-app-install[aria-busy="true"]'),
      )
      assert.equal(
        await page.locator('.official-app-install,.async-panel-error').count(),
        0,
        `First offline open failed: ${name}`,
      )
      const appId = await page.locator('.feature-hub').getAttribute('data-feature-page')
      assert.ok(officialAppIds().includes(appId), `没有识别当前 APP 页面：${name}`)
      assert.equal(
        await page.locator(`[data-official-app-ready="${appId}"]`).count(),
        1,
        `${name} 页面必须由当前官方 APP 就绪标记确认`,
      )
      const readiness = await page.evaluate(
        (id) =>
          new Promise((accept, reject) => {
            const reads = window.__srlReadyChecks
            window.__srlReadyChecks = undefined
            const opening = indexedDB.open('SillyTavernResourceLibrary')
            opening.onerror = () => reject(opening.error)
            opening.onsuccess = () => {
              const database = opening.result
              const transaction = database.transaction('settings', 'readonly')
              const getting = transaction.objectStore('settings').get(`official-app:${id}`)
              getting.onsuccess = () =>
                accept({
                  files: getting.result.value.files
                    .filter(
                      (file) =>
                        getting.result.value.assetMode === 'self-contained' || !file.bundled,
                    )
                    .map((file) => file.path),
                  reads: reads.map((path) => new URL(path, location.href).pathname),
                })
              transaction.oncomplete = () => database.close()
              transaction.onerror = () => reject(transaction.error)
            }
          }),
        appId,
      )
      for (const path of readiness.files)
        assert.equal(
          readiness.reads.filter((read) => read === path).length,
          0,
          `${name} 日常打开不得重跑文件齐全扫描：${path}`,
        )
      const permissionDialog = page.locator('.external-app-permission')
      if (name === '读了么') {
        await page
          .locator('.chat-reader-app__view')
          .locator('#aboutBtn')
          .waitFor({ state: 'visible' })
        assert.equal(await permissionDialog.count(), 0)
      }
      if (await permissionDialog.count())
        await permissionDialog.getByRole('button', { name: '仅同意这次' }).click()
      assert.ok(
        (await page.locator('body').innerText()).includes(name),
        `APP did not render offline: ${name}`,
      )
      if (name === '前端了么') {
        assert.equal(await page.locator('.fw-home__cover').count(), 0)
        assert.equal(await page.getByText('先选要制作的内容', { exact: true }).count(), 0)
        assert.equal(
          await page.locator('.fw-home > :first-child button').first().innerText(),
          '新建开场白\n可视化编辑\n›',
        )
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
          }, theme)
          for (const [width, height] of [
            [320, 800],
            [375, 812],
            [390, 844],
            [430, 932],
          ]) {
            await page.setViewportSize({ width, height })
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
            )
            await page.screenshot({
              path: resolve(environment.outputDir, `frontend-home-${theme}-${width}.png`),
            })
          }
        }
        await page.setViewportSize({ width: 390, height: 844 })
      }
      await back()
    }
    await setAuditOffline(context, environment, false)
    offline = false
    currentAppName = 'APP 管理'
    await manager()
    assert.equal(await page.locator('.official-app-manager__updates-dialog').count(), 0)
    assert.equal(await page.locator('.official-app-manager__update-dot').count(), 0)
    const draw = page.locator('.official-app-manager li').filter({ hasText: '抽了么' })
    await page.evaluate(() => localStorage.setItem('srl.draw.showNames', 'true'))
    const filesBefore = await page.evaluate(async () =>
      (await (await caches.open('srl-official-app-assets-v1')).keys()).map(
        (request) => new URL(request.url).pathname,
      ),
    )
    await draw.getByRole('button', { name: '卸载', exact: true }).click()
    await page.getByRole('button', { name: '确认仅卸载 APP', exact: true }).click()
    await status('已卸载')
    await page.getByRole('button', { name: '知道了', exact: true }).click()
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), 'true')
    const filesAfter = await page.evaluate(async () =>
      (await (await caches.open('srl-official-app-assets-v1')).keys()).map(
        (request) => new URL(request.url).pathname,
      ),
    )
    const removed = filesBefore.filter((path) => !filesAfter.includes(path))
    assert.ok(removed.some((path) => path.includes('/DrawApp-')))
    assert.ok(
      filesAfter.some((path) => path.includes('/AppContainer-')),
      'Shared dependency removed',
    )
    await back()
    assert.equal(
      await findAuditFeature(page, '抽了么'),
      null,
      'Uninstalled app must leave the desktop',
    )
    await manager()
    assert.equal(await page.locator('.official-app-manager__updates-dialog').count(), 0)
    await draw.getByRole('button', { name: '下载', exact: true }).click()
    await status('安装成功')
    await back()
    await openAuditFeature(page, '抽了么')
    await page.locator('.draw-app__stats').waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), 'true')
    await back()
    await manager()
    assert.equal(await page.locator('.official-app-manager__updates-dialog').count(), 0)
    await draw.getByRole('button', { name: '卸载', exact: true }).click()
    await page.getByLabel('同时删除 APP 数据').check()
    await page.getByRole('button', { name: '确认卸载并清除数据', exact: true }).click()
    await status('已卸载')
    await page.getByRole('button', { name: '知道了', exact: true }).click()
    assert.equal(await page.evaluate(() => localStorage.getItem('srl.draw.showNames')), null)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      for (const [width, height] of [
        [320, 800],
        [375, 812],
        [390, 844],
        [430, 932],
      ]) {
        await page.setViewportSize({ width, height })
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          controls: [...document.querySelectorAll('.official-app-manager button')].every(
            (button) => {
              const box = button.getBoundingClientRect()
              return box.left >= 0 && box.right <= innerWidth && box.height >= 44
            },
          ),
        }))
        assert.equal(layout.overflow, false, `${theme} ${width}: overflow`)
        assert.equal(layout.controls, true, `${theme} ${width}: clipped controls`)
      }
    }
    assert.deepEqual(errors, [])
    console.log(
      `离线只读 API 的预期网络失败：${expectedNetworkErrors.length}；其他运行时异常：${errors.length}`,
    )
    console.log(
      `Passed: install all ${officialAppIds().length}; active cross-tab update rejected before download; first offline open; uninstall frees files and retains shared code; retained-data reinstall; explicit data clearing; light/dark 320/375/390/430 layouts.`,
    )
  }
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
