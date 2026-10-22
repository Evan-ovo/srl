/* global document, window, getComputedStyle */
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
      'ResourceDetails',
      'VersionArchive',
      'GlassRefinement',
      'PersonalResourceEditor',
      'PerformanceMonitor',
    ].map((name) => readFile(`src/styles/${name}.css`, 'utf8')),
  )
).join('\n')
const engine = process.env.SRL_AUDIT_ENGINE || process.env.SRL_SETTINGS_BROWSER_ENGINE || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch({
  executablePath: engine === 'webkit' ? undefined : process.env.EDGE_PATH || undefined,
  headless: true,
})
const html = `<!doctype html><html class="modal-open"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
*{box-sizing:border-box}html,body{margin:0;min-height:0}:root{--safe-top:0px;--safe-right:0px;--safe-bottom:34px;--safe-left:0px;--mobile-gutter:16px}.srl-independent-page-outlet{animation:none!important}
</style></head><body class="modal-open"><button style="position:fixed;inset:auto 0 0;height:80px">后页导航</button><div class="srl-independent-page-outlet"><main class="srl-independent-page layout-settings-page"><header class="editor-sheet__header layout-settings__header"><h2>设置</h2><button>关闭</button></header><div class="settings-sections"><label>配置名称<input value="主 API"></label><div style="height:1200px"></div></div><footer class="layout-settings__footer"><span>本机保存</span><button>完成</button></footer></main></div></body></html>`
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
        // A long library behind a modal must not remain a scrollable document.
        // overflow:hidden alone passes geometric checks but still permits focus scrolling.
        await page.evaluate((height) => {
          // Main publishes the measured layout baseline in CSS pixels before mounting panels.
          document.documentElement.style.setProperty('--layout-viewport-height', `${height}px`)
          document.documentElement.classList.remove('modal-open')
          document.body.classList.remove('modal-open')
          const background = document.createElement('main')
          background.style.height = '7889px'
          const marker = document.createElement('span')
          marker.id = 'background-marker'
          marker.style.cssText = 'display:block;position:relative;top:1300px'
          background.append(marker)
          document.body.prepend(background)
        }, height)
        for (const openingTop of [0, 1200, 1800, 900]) {
          await page.evaluate((top) => {
            window.scrollTo({ top, behavior: 'instant' })
            document.body.style.setProperty('--modal-scroll-offset-top', `${-window.scrollY}px`)
            document.documentElement.classList.add('modal-open')
            document.body.classList.add('modal-open')
          }, openingTop)
          const lock = await page.evaluate(() => {
            window.scrollTo({ top: 441, behavior: 'instant' })
            document.body.scrollTop = 441
            const content = document.querySelector('.settings-sections')
            content.scrollTop = 500
            return {
              scrollY: window.scrollY,
              bodyPosition: getComputedStyle(document.body).position,
              bodyTop: document.body.getBoundingClientRect().top,
              bodyBottom: document.body.getBoundingClientRect().bottom,
              bodyScroll: document.body.scrollTop,
              markerTop: document.querySelector('#background-marker').getBoundingClientRect().top,
              contentScroll: content.scrollTop,
            }
          })
          if (width <= 860) {
            assert.equal(lock.scrollY, 0, `long background drift: ${JSON.stringify(lock)}`)
            assert.equal(lock.bodyPosition, 'static', 'iOS PWA body must stay in normal flow')
            assert.equal(lock.bodyTop, 0 - openingTop)
            assert.equal(lock.bodyBottom, height)
            assert.equal(lock.bodyScroll, 0)
            assert.equal(lock.markerTop, 1300 - openingTop)
          } else {
            assert.notEqual(lock.bodyPosition, 'fixed')
            assert.equal(lock.scrollY, 441)
          }
          assert.ok(lock.contentScroll > 0, 'modal content remains independently scrollable')
          await page.evaluate((top) => {
            document.documentElement.classList.remove('modal-open')
            document.body.classList.remove('modal-open')
            document.body.style.removeProperty('--modal-scroll-offset-top')
            window.scrollTo({ top, behavior: 'instant' })
          }, openingTop)
          assert.equal(await page.evaluate(() => window.scrollY), openingTop)
          cases++
        }
        await page.setContent(html)
        await page.evaluate(() => {
          const homeHeader = document.createElement('header')
          homeHeader.id = 'home-header-layer'
          homeHeader.style.cssText =
            'position:fixed;inset:0 0 auto;height:56px;z-index:20;background:#f00'
          const homeNavigation = document.createElement('nav')
          homeNavigation.id = 'home-navigation-layer'
          homeNavigation.style.cssText =
            'position:fixed;inset:auto 0 0;height:80px;z-index:75;background:#f00'
          const performanceMonitor = document.createElement('details')
          performanceMonitor.id = 'srl-performance-monitor'
          performanceMonitor.style.cssText =
            'position:fixed;inset:auto 8px 8px auto;width:120px;height:44px'
          document.body.append(homeHeader, homeNavigation, performanceMonitor)
        })
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
              outlet: rect('.srl-independent-page-outlet'),
              sheet: rect('.layout-settings-page'),
              viewportOffset: getComputedStyle(document.documentElement).getPropertyValue(
                '--visual-viewport-offset-top',
              ),
              pagePosition: getComputedStyle(document.querySelector('.layout-settings-page'))
                .position,
              pageInset: getComputedStyle(document.querySelector('.layout-settings-page')).inset,
              header: rect('.layout-settings__header'),
              content: rect('.settings-sections'),
              footer: rect('.layout-settings__footer'),
              footerDisplay: getComputedStyle(document.querySelector('.layout-settings__footer'))
                .display,
              sheetOverflow: overflow('.layout-settings-page'),
              contentOverflow: overflow('.settings-sections'),
              rootOverflow: overflow('html'),
              bodyOverflow: overflow('body'),
              outletBackground: getComputedStyle(
                document.querySelector('.srl-independent-page-outlet'),
              ).backgroundColor,
              emptyOutletBackground: (() => {
                const outlet = document.createElement('div')
                outlet.className = 'srl-independent-page-outlet'
                document.body.append(outlet)
                const background = getComputedStyle(outlet).backgroundColor
                outlet.remove()
                return background
              })(),
              coversUnderlyingPage: (() => {
                const style = getComputedStyle(document.documentElement)
                const viewportHeight = Number.parseFloat(
                  style.getPropertyValue('--visual-viewport-height'),
                )
                const viewportTop = Number.parseFloat(
                  style.getPropertyValue('--visual-viewport-offset-top'),
                )
                return document
                  .querySelector('.srl-independent-page.layout-settings-page')
                  .contains(document.elementFromPoint(10, viewportTop + viewportHeight - 1))
              })(),
              homeLayering: (() => {
                const panel = document.querySelector('.srl-independent-page.layout-settings-page')
                const height = Number.parseFloat(
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--visual-viewport-height',
                  ),
                )
                const offset = Number.parseFloat(
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--visual-viewport-offset-top',
                  ),
                )
                const monitor = document
                  .querySelector('#srl-performance-monitor')
                  .getBoundingClientRect()
                return {
                  homeHeaderCovered: panel.contains(document.elementFromPoint(8, offset + 8)),
                  homeBottomCovered: panel.contains(
                    document.elementFromPoint(8, offset + height - 8),
                  ),
                  performanceCapsuleAbove:
                    document.elementFromPoint(
                      monitor.left + monitor.width / 2,
                      monitor.top + monitor.height / 2,
                    )?.id === 'srl-performance-monitor',
                }
              })(),
            }
          })
        }
        const check = (state, visible = height, offset = 0) => {
          assert.deepEqual(state.outlet, {
            top: 0,
            right: width,
            bottom: height,
            left: 0,
          })
          assert.deepEqual(state.sheet, {
            top: offset,
            right: width,
            bottom: offset + visible,
            left: 0,
          })
          assert.equal(state.header.top, offset)
          assert.ok(state.header.bottom <= state.content.top)
          if (width <= 860 && visible < height) {
            assert.equal(state.footerDisplay, 'none', '输入时设置完成栏应隐藏并释放空间')
            assert.equal(state.content.bottom, offset + visible)
          } else {
            assert.notEqual(state.footerDisplay, 'none', '收键盘后恢复设置完成栏')
            assert.equal(state.footer.bottom, offset + visible)
            assert.ok(state.content.bottom <= state.footer.top)
          }
          assert.equal(state.sheetOverflow, 'hidden')
          assert.equal(state.contentOverflow, 'auto')
          assert.notEqual(state.outletBackground, 'rgba(0, 0, 0, 0)')
          assert.equal(state.emptyOutletBackground, 'rgba(0, 0, 0, 0)')
          assert.equal(state.coversUnderlyingPage, true)
          assert.deepEqual(state.homeLayering, {
            homeHeaderCovered: true,
            homeBottomCovered: true,
            performanceCapsuleAbove: true,
          })
          if (width <= 860) {
            assert.equal(state.rootOverflow, 'hidden')
            assert.equal(state.bodyOverflow, 'clip')
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
              `<!doctype html><html class="modal-open" data-ios-keyboard-open="${keyboardOpen}" data-visual-viewport-reduced="true"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}:root{--visual-viewport-height:300px;--app-viewport-height:300px;--visual-viewport-offset-top:70px;--layout-viewport-height:${height}px;--safe-top:0px;--safe-bottom:0px;--safe-left:0px;--safe-right:0px}html,body{margin:0}.editor-overlay{animation:none}</style><body class="modal-open"><div class="srl-independent-page-outlet"><main class="srl-independent-page resource-detail-page"><section class="resource-detail-sheet"><header class="resource-detail__header"><h2>番外指令</h2></header><form class="editor-form"><label>正文<textarea rows="12"></textarea></label><div style="height:900px"></div><button>保存</button></form></section></main></div></body></html>`,
            )
            const bottomSheet = await page.evaluate(() => {
              const overlay = document.querySelector('.resource-detail-page'),
                sheet = document.querySelector('.resource-detail-sheet')
              const background = overlay.getBoundingClientRect(),
                panel = sheet.getBoundingClientRect()
              return {
                height: background.height,
                top: panel.top,
                bottom: panel.bottom,
                covered: (() => {
                  const style = getComputedStyle(document.documentElement)
                  const top = Number.parseFloat(
                    style.getPropertyValue('--visual-viewport-offset-top'),
                  )
                  const height = Number.parseFloat(
                    style.getPropertyValue('--visual-viewport-height'),
                  )
                  return overlay.contains(document.elementFromPoint(10, top + height - 1))
                })(),
              }
            })
            assert.ok(
              bottomSheet.height >= 300 && bottomSheet.covered,
              'bottom sheet backdrop ' + JSON.stringify({ width, ...bottomSheet }),
            )
            assert.ok(
              bottomSheet.top >= 70 && bottomSheet.bottom <= 371,
              'bottom sheet remains above keyboard ' + JSON.stringify({ width, ...bottomSheet }),
            )
            cases++
          }
          // Portrait full pages must keep their footer at the expanded viewport edge.
          // The v352 phone trace shrank inner/visual height by 59px when body was fixed.
          for (const detail of [false, true]) {
            const safeTop = width > height ? 0 : 59
            const safeBottom = width > height ? 21 : 34
            const pageContent = detail
              ? `<section class="resource-detail-sheet"><header class="resource-detail__header"><h2>资源详情</h2></header><div class="resource-detail__layout"><form style="height:1600px"><label>正文<textarea rows="3">保留输入与选择</textarea></label></form></div><footer class="editor-form__actions resource-detail__actions"><span>当前内容已保存</span><div><button class="button">取消</button><button class="button">保存修改</button></div></footer></section>`
              : `<header class="editor-sheet__header layout-settings__header"><h2>设置</h2></header><div class="settings-sections"><form style="height:1600px"><label>正文<textarea rows="3">保留输入与选择</textarea></label></form></div><footer class="layout-settings__footer"><span>当前内容已保存</span><div><button class="button">取消</button><button class="button">保存修改</button></div></footer>`
            await page.setContent(
              `<!doctype html><html class="modal-open"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}:root{--safe-top:${safeTop}px;--safe-bottom:${safeBottom}px;--safe-left:0px;--safe-right:0px;--layout-viewport-height:${height}px;--app-viewport-height:${height}px;--visual-viewport-height:${height}px;--visual-viewport-offset-top:0px}</style><body class="modal-open" style="--modal-scroll-offset-top:-1200px"><main style="height:7889px"></main><div class="srl-independent-page-outlet"><main class="srl-independent-page ${detail ? 'resource-detail-page' : 'layout-settings-page'}">${pageContent}</main></div></body></html>`,
            )
            await page.locator('textarea').tap()
            for (const visible of [height, 300, height, 260, height, 320, height]) {
              const state = await page.evaluate((visible) => {
                const root = document.documentElement
                const expanded = Number.parseFloat(
                  getComputedStyle(root).getPropertyValue('--layout-viewport-height'),
                )
                root.dataset.iosKeyboardOpen = String(visible < expanded)
                root.dataset.visualViewportReduced = String(visible < expanded)
                root.style.setProperty('--app-viewport-height', `${visible}px`)
                root.style.setProperty('--visual-viewport-height', `${visible}px`)
                window.scrollTo({ top: 882, behavior: 'instant' })
                document.body.scrollTop = 441
                const panel = document.querySelector('.srl-independent-page')
                const footer = document.querySelector('footer')
                const input = document.querySelector('textarea')
                return {
                  bodyPosition: getComputedStyle(document.body).position,
                  panelBottom: panel.getBoundingClientRect().bottom,
                  footerBottom: footer.getBoundingClientRect().bottom,
                  footerDisplay: getComputedStyle(footer).display,
                  footerMarginBottom: getComputedStyle(footer).marginBottom,
                  footerPaddingBottom: getComputedStyle(footer).paddingBottom,
                  panelPaddingBottom: getComputedStyle(panel).paddingBottom,
                  bodyScroll: document.body.scrollTop,
                  scrollY: window.scrollY,
                  innerHeight: window.innerHeight,
                  text: input.value,
                  focused: document.activeElement === input,
                }
              }, visible)
              assert.equal(state.bodyPosition, 'static')
              assert.equal(state.innerHeight, height)
              assert.equal(state.panelBottom, visible)
              assert.equal(state.bodyScroll, 0)
              assert.equal(state.scrollY, 0)
              assert.equal(state.text, '保留输入与选择')
              assert.equal(state.focused, true)
              if (visible < height) assert.equal(state.footerDisplay, 'none')
              else {
                assert.equal(
                  state.footerBottom,
                  visible,
                  JSON.stringify({ detail, width, height, visible, ...state }),
                )
                if (detail)
                  assert.ok(
                    Number.parseFloat(state.footerPaddingBottom) >= safeBottom,
                    'resource detail action content respects the safe-area inset ' +
                      JSON.stringify({ detail, width, height, safeBottom, ...state }),
                  )
              }
              cases++
            }
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
