/* global document, localStorage, indexedDB, getComputedStyle, Blob */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { auditButtonMaterial } from './SharedAppearanceAudit.mjs'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'resident-appearance')
const browser = await launchAuditBrowser(environment)
const baseline = process.env.SRL_RESIDENT_BASELINE === '1'
const palette =
  ':root {--page-background:#faf4fc;--dialog-background:#f5e9ff;--dialog-border:#aa88bb;--dialog-radius:18px;--dialog-shadow:none;--button-background:#fff4e3;--button-border:#b89972;--button-color:#44335c;--button-radius:9px;--button-shadow:none;--button-primary-background:#8055aa;--button-primary-border:#8055aa;--button-primary-color:#fff;--control-background:#eaf4ff;--control-border:#8b9ec3;--control-radius:7px;--control-shadow:none;--selection-background:#ead9f5;--selection-border:#8055aa;--selection-color:#44335c;--selection-shadow:none;--color-accent:#8055aa;--folder-cover-background:#8055aa;--folder-cover-color:#fff;--folder-indicator-color:#8055aa;}'
let context
const mismatches = []
await mkdir(environment.outputDir, { recursive: true })
try {
  for (const width of baseline ? [390, 1280] : [320, 375, 390, 430, 1280]) {
    for (const theme of baseline ? ['light'] : ['light', 'dark']) {
      context = await browser.newContext({
        viewport: { width, height: { 320: 800, 375: 812, 390: 844, 430: 932 }[width] ?? 1024 },
        hasTouch: width < 800,
      })
      await prepareAuditContext(context, environment)
      await context.addInitScript((value) => localStorage.setItem('srl-theme', value), theme)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(environment.baseUrl)
      await page.locator('.app-shell').waitFor()
      // Isolated folder data; reload before each entry keeps the lazy CSS dependency cold.
      await page.evaluate(async () => {
        await new Promise((accept, reject) => {
          const request = indexedDB.open('SillyTavernResourceLibrary')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction(['categories', 'resources', 'resourceSummaries'], 'readwrite')
            tx.objectStore('categories').put({
              id: 'resident-style-folder',
              name: '样式测试',
              color: '#1f6654',
              createdAt: 1,
              updatedAt: 1,
            })
            for (const type of ['worldBook', 'regex']) {
              const originalBlob = new Blob(
                [
                  JSON.stringify(
                    type === 'worldBook'
                      ? {
                          name: '测试世界书',
                          entries: {
                            0: { uid: 0, key: ['城市'], content: '隔离测试城市', comment: '城市' },
                          },
                        }
                      : {
                          id: 'resident-regex',
                          scriptName: '测试正则',
                          findRegex: '/test/g',
                          replaceString: '示例',
                          placement: [1, 2],
                          disabled: false,
                        },
                  ),
                ],
                { type: 'application/json' },
              )
              const summary = {
                id: `resident-${type}`,
                name: `测试${type}`,
                description: '',
                type,
                fileName: `${type}.json`,
                mimeType: 'application/json',
                fileSize: originalBlob.size,
                contentHash: type.padEnd(64, '0'),
                favorite: false,
                categoryId: 'resident-style-folder',
                categoryIds: ['resident-style-folder'],
                tags: [],
                metadata: {},
                createdAt: 1,
                updatedAt: 1,
              }
              tx.objectStore('resources').put({ ...summary, originalBlob })
              tx.objectStore('resourceSummaries').put(summary)
              const unfiled = {
                ...summary,
                id: `resident-unfiled-${type}`,
                categoryId: null,
                categoryIds: [],
              }
              tx.objectStore('resources').put({ ...unfiled, originalBlob })
              tx.objectStore('resourceSummaries').put(unfiled)
            }
            tx.oncomplete = () => {
              db.close()
              accept()
            }
            tx.onerror = () => {
              db.close()
              reject(tx.error)
            }
          }
        })
      })
      const entry = async (name) => {
        await page.goto(environment.baseUrl)
        await page.locator('.app-shell').waitFor()
        await page.addStyleTag({ content: palette })
        await page.getByRole('button', { name: '功能', exact: true }).click()
        await openAuditFeature(page, name)
      }
      const inspect = async (name, selector, checks = []) => {
        const host = page.locator(selector).first()
        await host.waitFor({ state: 'visible' })
        if (!baseline) await auditButtonMaterial(host, `resident/${name}/${width}/${theme}`)
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
              .map((animation) => animation.finished.catch(() => undefined)),
          )
        })
        // The page header follows viewport width and may extend past the capped studio grid.
        const size = await host.evaluate((element) => {
          const contents = element.matches('.appearance-studio, .cloud-center')
            ? [...element.children].filter((child) => !child.matches('.feature-app-header'))
            : [element]
          return {
            contents: contents.map((content) => ({
              width: content.clientWidth,
              scroll: content.scrollWidth,
            })),
            viewport: document.documentElement.clientWidth,
            page: document.documentElement.scrollWidth,
          }
        })
        assert.ok(
          size.contents.every((content) => content.scroll <= content.width + 2) &&
            size.page <= size.viewport + 2,
          `${name}/${width}/${theme}: overflow ${JSON.stringify(size)}`,
        )
        for (const [targetSelector, property, expected, pseudo] of checks) {
          const target = host.locator(targetSelector).first()
          assert.ok(await target.count(), `${name}: missing ${targetSelector}`)
          const actual = await target.evaluate(
            (element, args) => getComputedStyle(element, args.pseudo)[args.property],
            { property, pseudo },
          )
          if (actual !== expected)
            mismatches.push(
              `${name}/${width}/${theme} ${targetSelector} ${property}: ${actual} != ${expected}`,
            )
          if (
            property === 'backgroundColor' &&
            !targetSelector.endsWith(' i') &&
            ['rgb(255, 244, 227)', 'rgb(128, 85, 170)', 'rgb(234, 217, 245)'].includes(expected)
          ) {
            const foreground = await target.evaluate((element) => getComputedStyle(element).color)
            const expectedForeground =
              expected === 'rgb(128, 85, 170)' ? 'rgb(255, 255, 255)' : 'rgb(68, 51, 92)'
            if (foreground !== expectedForeground)
              mismatches.push(
                `${name}/${width}/${theme} ${targetSelector} color: ${foreground} != ${expectedForeground}`,
              )
          }
        }
        if (
          [
            'cloud-scope',
            'inbox-settings',
            'inbox-cleanup',
            'extensions-preview',
            'folder-organizer',
          ].includes(name)
        ) {
          const background = await host.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          )
          if (background !== 'rgb(245, 233, 255)')
            mismatches.push(`${name}/${width}/${theme}: dialog background ${background}`)
        }
        if (theme === 'light' && [390, 1280].includes(width))
          await page.screenshot({
            path: resolve(environment.outputDir, `${name}-${width}.png`),
            animations: 'disabled',
          })
      }
      const ordinary = (selector) => [selector, 'backgroundColor', 'rgb(255, 244, 227)']
      const field = (selector) => [selector, 'backgroundColor', 'rgb(234, 244, 255)']
      const selected = (selector) => [selector, 'backgroundColor', 'rgb(234, 217, 245)']
      const primary = (selector) => [selector, 'backgroundColor', 'rgb(128, 85, 170)']
      await entry('外观')
      await inspect('appearance', '.appearance-studio')
      await entry('云备份')
      await inspect('cloud-github', '.cloud-center', [
        ordinary('.cloud-config__actions button'),
        field('.cloud-config input:not([type="checkbox"])'),
        selected('.cloud-provider-tabs .is-active'),
        primary('.cloud-primary-actions .button--primary'),
      ])
      await page.locator('.cloud-provider-tabs button').nth(1).click()
      await page
        .locator('.cloud-provider-tabs button.is-active')
        .filter({ hasText: 'Koofr' })
        .waitFor()
      await inspect('cloud-webdav', '.cloud-center', [
        field('.cloud-config input:not([type="checkbox"])'),
        selected('.cloud-provider-tabs .is-active'),
      ])
      await page.locator('.cloud-backup-scope__header button').click()
      await inspect('cloud-scope', '.cloud-scope-dialog', [
        ordinary('footer button'),
        primary('.cloud-scope-dialog__confirm'),
        ['.backup-scope-tree__filters i', 'backgroundColor', 'rgb(128, 85, 170)'],
      ])
      await page
        .locator('.cloud-scope-dialog')
        .getByRole('button', { name: '取消', exact: true })
        .click()
      if (!baseline) {
        await page.addStyleTag({
          content: '.feature-hub[data-feature-page="cloud"] {--control-background:#d5ead6;}',
        })
        const local = await page
          .locator('.cloud-config input:not([type="checkbox"])')
          .first()
          .evaluate((element) => getComputedStyle(element).backgroundColor)
        assert.equal(
          local,
          'rgb(213, 234, 214)',
          'Cloud local variable should override global control material',
        )
      }
      await entry('收件箱')
      await inspect('inbox', '.discord-inbox-center__content', [
        ordinary('.discord-inbox-center__secondary button'),
        ordinary('.discord-downloads button'),
      ])
      await page.getByRole('button', { name: '收件箱设置', exact: true }).click()
      await inspect('inbox-settings', '.discord-inbox-dialog')
      await page
        .locator('.discord-inbox-dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await page.getByRole('button', { name: '清理云端', exact: true }).click()
      await inspect('inbox-cleanup', '.discord-inbox-dialog', [
        primary('.discord-inbox-dialog__primary'),
      ])
      await page
        .locator('.discord-inbox-dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await entry('扩展')
      await inspect('extensions', '.external-app-manager')
      await page
        .locator('.external-app-manager__file')
        .first()
        .setInputFiles({
          name: '样式测试.html',
          mimeType: 'text/html',
          buffer: Buffer.from(
            '<!doctype html><html><title>样式测试</title><body><h1>独立内容</h1></body></html>',
          ),
        })
      await inspect('extensions-preview', '.external-app-manager__preview', [
        field('select'),
        ordinary('.external-app-manager__trial-toolbar button'),
        primary('.external-app-manager__confirm'),
      ])
      await page.getByRole('button', { name: '取消安装', exact: true }).click()
      await entry('收藏柜')
      await inspect('cabinet', '.folder-library', [
        [
          '.visual-folder[data-folder-order-id="resident-style-folder"] .visual-folder__cover',
          'backgroundColor',
          'rgb(128, 85, 170)',
        ],
      ])
      await page
        .locator('[data-folder-order-id="resident-style-folder"] .visual-folder__open')
        .click()
      await inspect('folder-detail', '.folder-library', [
        field('.folder-detail__search'),
        selected('.folder-type-filter .is-active'),
        primary('.folder-detail__thumb'),
      ])
      await page.getByRole('button', { name: '添加资源到当前文件夹', exact: true }).click()
      await inspect('folder-organizer', '.folder-organizer__sheet', [
        field('.folder-tray__search'),
        selected('.folder-type-filter .is-active'),
        primary('.folder-tray__thumb'),
      ])
      if (!baseline) {
        await page.addStyleTag({
          content: ':root {--folder-cover-background:initial;--folder-cover-color:initial;}',
        })
        assert.equal(
          await page
            .locator('.folder-detail__thumb')
            .first()
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          'rgb(31, 102, 84)',
          'Without a cover override, the saved category color remains available',
        )
      }
      assert.deepEqual(errors, [], `${width}/${theme}: page errors`)
      await context.tracing.stop()
      await context.close()
      context = undefined
    }
  }
  if (baseline) console.log(`BASELINE: ${mismatches.length} material mismatches captured.`)
  else assert.deepEqual(mismatches, [], 'Resident APP material tokens')
  console.log(
    'PASS: resident APP cold entries, cloud providers/scope, inbox settings/cleanup, extension installation preview/cancel, cabinet folder/detail/organizer; desktop Chromium only.',
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
