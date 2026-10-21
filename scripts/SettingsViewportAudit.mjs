/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import console from 'node:console'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium, webkit } from 'playwright-core'

const css = (
  await Promise.all(
    [
      'Foundation',
      'ResourceList',
      'LayoutAndResponsive',
      'GlassRefinement',
      'PersonalResourceEditor',
    ].map((name) => readFile(`src/styles/${name}.css`, 'utf8')),
  )
).join('\n')
const engine = process.env.SRL_SETTINGS_BROWSER_ENGINE || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch({
  executablePath: engine === 'webkit' ? undefined : process.env.EDGE_PATH || undefined,
  headless: true,
})
const html = `<!doctype html><html class="modal-open"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
*{box-sizing:border-box}html,body{margin:0;min-height:0}:root{--safe-top:0px;--safe-right:0px;--safe-bottom:34px;--safe-left:0px;--mobile-gutter:16px}.editor-overlay{animation:none!important}
</style></head><body class="modal-open"><button style="position:fixed;inset:auto 0 0;height:80px">后页导航</button><div class="editor-overlay layout-settings-overlay"><section class="layout-settings-page" role="dialog"><header class="editor-sheet__header layout-settings__header"><h2>设置</h2><button>关闭</button></header><div class="settings-sections"><label>配置名称<input value="主 API"></label><div style="height:1200px"></div></div><footer class="layout-settings__footer"><span>本机保存</span><button>完成</button></footer></section></div></body></html>`
let cases = 0
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [844, 390],
    [1440, 900],
  ])
    for (const theme of ['light', 'dark']) {
      // A fresh mobile page avoids WebKit retaining fixed-layer geometry from a previous width.
      const page = await browser.newPage({
        viewport: { width, height },
        hasTouch: true,
        isMobile: width <= 860,
      })
      try {
        await page.setContent(html)
        const geometry = async (visible, offset = 0, keyboardOpen = visible < height) => {
          await page.evaluate(
            ({ height, visible, offset, theme, keyboardOpen }) => {
              const root = document.documentElement
              root.dataset.theme = theme
              root.dataset.iosKeyboardOpen = String(keyboardOpen)
              root.dataset.visualViewportReduced = String(visible < height)
              for (const [name, value] of Object.entries({
                '--visual-viewport-height': visible,
                '--app-viewport-height': visible,
                '--layout-viewport-height': height,
                '--visual-viewport-offset-top': offset,
              }))
                root.style.setProperty(name, `${value}px`)
            },
            { height, visible, offset, theme, keyboardOpen },
          )
          return page.evaluate(() => {
            const rect = (selector) => {
              const b = document.querySelector(selector).getBoundingClientRect()
              return { top: b.top, right: b.right, bottom: b.bottom, left: b.left }
            }
            const overflow = (selector) =>
              getComputedStyle(document.querySelector(selector)).overflowY
            return {
              overlay: rect('.layout-settings-overlay'),
              sheet: rect('.layout-settings-page'),
              header: rect('.layout-settings__header'),
              content: rect('.settings-sections'),
              footer: rect('.layout-settings__footer'),
              sheetOverflow: overflow('.layout-settings-page'),
              contentOverflow: overflow('.settings-sections'),
              rootOverflow: overflow('html'),
              bodyOverflow: overflow('body'),
              coversUnderlyingPage: document
                .querySelector('.layout-settings-overlay')
                .contains(document.elementFromPoint(10, document.defaultView.innerHeight - 1)),
            }
          })
        }
        const check = (state, visible = height, offset = 0) => {
          assert.deepEqual(state.overlay, {
            top: offset,
            right: width,
            bottom: offset + height,
            left: 0,
          })
          assert.deepEqual(state.sheet, {
            top: offset,
            right: width,
            bottom: offset + visible,
            left: 0,
          })
          assert.equal(state.header.top, offset)
          assert.equal(state.footer.bottom, offset + visible)
          assert.ok(state.header.bottom <= state.content.top)
          assert.ok(state.content.bottom <= state.footer.top)
          assert.equal(state.sheetOverflow, 'hidden')
          assert.equal(state.contentOverflow, 'auto')
          assert.equal(state.coversUnderlyingPage, true)
          if (width <= 860) {
            assert.equal(state.rootOverflow, 'hidden')
            assert.equal(state.bodyOverflow, 'hidden')
          }
          cases++
        }
        check(await geometry(height))
        if (width <= 860) {
          for (const offset of [0, 70]) check(await geometry(300, offset), 300, offset)
          // Main intentionally does not identify a zoomed viewport as keyboard-only.
          // Background coverage must not depend on that semantic marker.
          for (const offset of [0, 70]) check(await geometry(300, offset, false), 300, offset)
          check(await geometry(height))
          for (const keyboardOpen of [true, false]) {
            await page.setContent(
              `<!doctype html><html class="modal-open" data-ios-keyboard-open="${keyboardOpen}" data-visual-viewport-reduced="true"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root{--visual-viewport-height:300px;--app-viewport-height:300px;--visual-viewport-offset-top:70px;--layout-viewport-height:${height}px;--safe-top:0px;--safe-bottom:0px;--safe-left:0px;--safe-right:0px}html,body{margin:0}.editor-overlay{animation:none}</style><body class="modal-open"><div class="editor-overlay personal-resource-editor-overlay"><section class="editor-sheet personal-resource-editor"><header class="editor-sheet__header"><h2>番外指令</h2></header><form class="editor-form"><label>正文<textarea rows="12"></textarea></label><div style="height:900px"></div><button>保存</button></form></section></div></body></html>`,
            )
            const bottomSheet = await page.evaluate(() => {
              const overlay = document.querySelector('.editor-overlay'),
                sheet = document.querySelector('.editor-sheet')
              const background = overlay.getBoundingClientRect(),
                panel = sheet.getBoundingClientRect()
              return {
                height: background.height,
                top: panel.top,
                bottom: panel.bottom,
                covered: overlay.contains(
                  document.elementFromPoint(
                    10,
                    Math.min(390, document.defaultView.innerHeight - 1),
                  ),
                ),
              }
            })
            assert.ok(
              bottomSheet.height >= height && bottomSheet.covered,
              'bottom sheet backdrop ' + JSON.stringify({ width, ...bottomSheet }),
            )
            assert.ok(
              bottomSheet.top >= 70 && bottomSheet.bottom <= 371,
              'bottom sheet remains above keyboard ' + JSON.stringify({ width, ...bottomSheet }),
            )
            cases++
          }
        }
      } finally {
        await page.close()
      }
    }
  console.log(
    `PASS (${engine}): ${cases} settings full-page / keyboard / pan / restoration geometries`,
  )
} finally {
  await browser.close()
}
