/* global document, window, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import process from 'node:process'
import console from 'node:console'
import { auditEnvironment, launchAuditBrowser } from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'assistant-keyboard-layout')
if (!process.env.SRL_AUDIT_RUN) throw Error('Use audit:isolated with an explicit run and port')
const seen = new Set()
async function stylesheet(path) {
  path = resolve(path)
  if (seen.has(path)) return ''
  seen.add(path)
  let text = await readFile(path, 'utf8')
  for (const match of [...text.matchAll(/@import ['"]([^'"]+)['"];?/gu)])
    text = text.replace(match[0], await stylesheet(resolve(dirname(path), match[1])))
  return text
}
let css = ''
for (const path of [
  'src/styles/Foundation.css',
  'src/Styles.css',
  'src/styles/FeatureDesktop.css',
  'src/styles/AppearanceStudio.css',
  'src/styles/ProductAssistant.css',
  'src/styles/ProductAssistantPet.css',
  'src/styles/FeatureAppHeader.css',
])
  css += await stylesheet(path)

// This fixture exercises production CSS and the full-chat DOM structure, not AI/storage behavior.
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><div id="app"><div class="app-shell" style="--bottom-nav-reserved:0px">
<div class="fixture-prior-feature" style="position:fixed;inset:0;z-index:90;background:rgb(255,0,0)"></div>
<main class="feature-hub feature-hub--app feature-hub--assistant">
<section class="appearance-studio appearance-studio--chat"><div class="appearance-studio__content"><div class="product-assistant">
<header class="feature-app-header"><button type="button">返回</button><h1>助手</h1></header>
<section class="chat-messages">${'<p>可滚动的历史消息</p>'.repeat(80)}</section>
<form class="chat-composer"><div class="chat-composer__row"><button type="button">图片</button>
<textarea rows="1" aria-label="发送消息"></textarea><button type="button">发送</button><button type="button">生成</button></div></form>
</div></div></section></main></div></div>`
const browser = await launchAuditBrowser(environment)
const results = []
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [844, 390],
    [1200, 900],
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: true })
      try {
        await context.route('**/*', (route) => route.abort())
        const page = await context.newPage()
        await page.setContent(html)
        const mobile = width <= 860
        const geometry = async (visibleHeight, offset = 0) =>
          page.evaluate(
            async (state) => {
              const root = document.documentElement
              root.dataset.theme = state.theme
              root.dataset.iosKeyboardOpen = String(state.visibleHeight < state.height)
              root.dataset.visualViewportReduced = String(state.visibleHeight < state.height)
              for (const [name, value] of Object.entries({
                '--safe-top': state.landscape ? '0px' : '47px',
                '--safe-bottom': state.landscape ? '21px' : '34px',
                '--safe-left': state.landscape ? '47px' : '0px',
                '--safe-right': state.landscape ? '47px' : '0px',
                '--layout-viewport-height': `${state.height}px`,
                '--app-viewport-height': `${state.visibleHeight}px`,
                '--visual-viewport-height': `${state.visibleHeight}px`,
                '--visual-viewport-offset-top': `${state.offset}px`,
              }))
                root.style.setProperty(name, value)
              for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
              const hub = document.querySelector('.feature-hub')
              const composer = document.querySelector('.chat-composer')
              const input = document.querySelector('textarea')
              const box = hub.getBoundingClientRect()
              const content = hub.querySelector('.appearance-studio').getBoundingClientRect()
              const field = input.getBoundingClientRect()
              return {
                top: box.top,
                bottom: content.bottom,
                backingBottom: box.bottom,
                assistantLayer: Number.parseInt(getComputedStyle(hub).zIndex, 10),
                assistantBackground: getComputedStyle(hub).backgroundColor,
                topmostAtPageBody:
                  document
                    .elementFromPoint(
                      Math.min(window.innerWidth - 1, 8),
                      Math.min(window.innerHeight - 1, 8),
                    )
                    ?.closest('.feature-hub--assistant') !== null,
                fieldTop: field.top,
                fieldBottom: field.bottom,
                padding: parseFloat(getComputedStyle(composer).paddingBottom),
                overflow: getComputedStyle(root).overflowY,
                fieldHeight: field.height,
                draft: input.value,
                scroll: document.querySelector('.chat-messages').scrollTop,
                horizontalOverflow: root.scrollWidth > window.innerWidth,
              }
            },
            { visibleHeight, offset, height, theme, landscape: mobile && width > height },
          )
        const initial = await geometry(height)
        await page.locator('.chat-messages').evaluate((node) => {
          node.innerHTML = '<p>你好，我是蒜惹菈。</p>'
        })
        const shortChat = await page.locator('.product-assistant').evaluate((node) => {
          const box = node.getBoundingClientRect()
          const host = node.closest('.feature-hub').getBoundingClientRect()
          const composer = node.querySelector('.chat-composer').getBoundingClientRect()
          return { bottom: box.bottom, hostBottom: host.bottom, composerBottom: composer.bottom }
        })
        assert.ok(
          Math.abs(shortChat.hostBottom - shortChat.composerBottom) < 2,
          `short chat fills its actual AppearanceStudio wrapper: ${JSON.stringify(shortChat)}`,
        )
        await page.locator('.chat-messages').evaluate((node) => {
          node.innerHTML = '<p>可滚动的历史消息</p>'.repeat(80)
        })
        assert.equal(
          initial.padding,
          mobile && width > height ? 21 : 34,
          'safe area is consumed once, without an added 16px',
        )
        assert.equal(initial.horizontalOverflow, false)
        if (mobile && width > height) {
          const controls = await page
            .locator('.feature-app-header button, .chat-composer button')
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const box = node.getBoundingClientRect()
                return { left: box.left, right: box.right }
              }),
            )
          assert.ok(
            controls.every((box) => box.left >= 47 && box.right <= width - 47),
            JSON.stringify({
              width,
              controls,
              header: await page.locator('.feature-app-header').evaluate((node) => {
                const s = getComputedStyle(node),
                  p = node.parentElement.getBoundingClientRect(),
                  r = node.getBoundingClientRect()
                return {
                  left: s.left,
                  transform: s.transform,
                  width: s.width,
                  minWidth: s.minWidth,
                  margin: s.margin,
                  pLeft: p.left,
                  pWidth: p.width,
                  rectLeft: r.left,
                }
              }),
            }),
          )
        }
        if (!mobile) {
          assert.notEqual(initial.overflow, 'hidden', 'desktop document scrolling is unchanged')
          results.push({ width, theme, desktop: true })
          continue
        }
        assert.ok(initial.assistantLayer > 90, 'assistant page stacks above retained feature APPs')
        assert.equal(
          initial.assistantBackground,
          theme === 'dark' ? 'rgb(31, 50, 58)' : 'rgb(242, 249, 250)',
        )
        assert.equal(initial.topmostAtPageBody, true, 'assistant covers the prior full-page APP')
        assert.equal(initial.overflow, 'hidden', 'full chat locks the host document')
        const input = page.getByLabel('发送消息', { exact: true })
        await input.tap()
        await input.fill('保留中文草稿')
        await page.locator('.chat-messages').evaluate((node) => {
          node.scrollTop = 120
        })
        for (let cycle = 0; cycle < 3; cycle++) {
          for (const [visibleHeight, offset] of [
            [height - 100, 0],
            [height - 200, 35],
            [Math.max(240, height - 424), 90],
          ]) {
            const state = await geometry(visibleHeight, offset)
            assert.ok(Math.abs(state.top - offset) < 1, 'chat follows visual viewport origin')
            assert.ok(
              Math.abs(state.bottom - offset - visibleHeight) < 1,
              'chat ends at keyboard edge',
            )
            assert.ok(
              state.backingBottom >= offset + height - 1,
              'assistant page backing covers the full layout viewport',
            )
            assert.ok(
              state.fieldTop >= offset && state.fieldBottom <= offset + visibleHeight,
              JSON.stringify({ width, visibleHeight, offset, cycle, state }),
            )
            assert.equal(state.padding, 6, 'only a compact gap remains above keyboard')
            assert.equal(state.scroll, 120, 'typing does not move a manually scrolled history')
            assert.equal(state.draft, '保留中文草稿')
          }
          await input.evaluate((node) => {
            node.style.height = '112px'
          })
          const expanded = await geometry(Math.max(280, height - 424), 60)
          assert.equal(expanded.fieldHeight, 112)
          assert.ok(expanded.fieldBottom <= 60 + Math.max(280, height - 424))
          await input.evaluate((node) => {
            node.style.height = ''
          })
          const restored = await geometry(height)
          assert.equal(restored.top, initial.top)
          assert.equal(restored.bottom, initial.bottom)
          assert.equal(restored.padding, initial.padding)
          assert.equal(restored.draft, '保留中文草稿')
        }
        await page.getByRole('button', { name: '发送', exact: true }).tap()
        await page.locator('.feature-hub').evaluate((node) => {
          node.classList.remove('feature-hub--assistant')
          node.innerHTML = '<section style="height:1800px">普通外观文档页</section>'
        })
        const documentScroll = await page.evaluate(() => {
          window.scrollTo(0, 80)
          return {
            overflow: getComputedStyle(document.documentElement).overflowY,
            y: window.scrollY,
          }
        })
        assert.notEqual(
          documentScroll.overflow,
          'hidden',
          'leaving chat releases its host scroll lock',
        )
        assert.ok(documentScroll.y > 0, 'ordinary appearance page can still scroll')
        results.push({
          width,
          theme,
          cycles: 3,
          initialPadding: initial.padding,
          keyboardPadding: 6,
        })
        // ProductAssistantPet teleports a native dialog outside #app. A fixture
        // kept inside #app misses the mobile typography cascade at that entry.
        await page.setContent(html)
        await page.evaluate(() => {
          const dialog = document.createElement('dialog')
          dialog.className = 'assistant-pet-dialog assistant-pet-dialog--expanded'
          Object.assign(dialog.style, {
            left: '0px',
            top: 'var(--visual-viewport-offset-top, 0px)',
            width: '100vw',
            height: 'var(--app-viewport-height, 100dvh)',
          })
          dialog.append(document.querySelector('.appearance-studio'))
          document.querySelector('.feature-hub').remove()
          document.body.append(dialog)
          dialog.showModal()
        })
        for (const fontScale of ['small', 'normal', 'large']) {
          const state = await page.evaluate(async (fontScale) => {
            document.documentElement.dataset.fontScale = fontScale
            const field = document.querySelector('textarea')
            field.focus({ preventScroll: true })
            await new Promise(requestAnimationFrame)
            const r = field.getBoundingClientRect()
            const row = field.closest('.chat-composer__row')
            return {
              font: parseFloat(getComputedStyle(field).fontSize),
              left: r.left,
              right: r.right,
              rowLeft: row.getBoundingClientRect().left,
              rowRight: row.getBoundingClientRect().right,
              outsideApp: !field.closest('#app'),
              explicitRole: field.closest('dialog').hasAttribute('role'),
            }
          }, fontScale)
          results.push({ width, theme, fontScale, label: 'native pet dialog', ...state })
          assert.equal(state.outsideApp, true)
          assert.equal(state.explicitRole, false)
          assert.ok(state.font >= 16, 'native chat focus font ' + JSON.stringify(state))
          assert.ok(state.rowLeft >= 0 && state.rowRight <= width, JSON.stringify(state))
          assert.ok(state.left >= state.rowLeft && state.right <= state.rowRight)
        }
        for (let cycle = 0; cycle < 3; cycle++) {
          for (const [visibleHeight, offset] of [
            [height, 0],
            [300, 35],
            [height, 0],
          ]) {
            const state = await page.evaluate(
              async ({ visibleHeight, offset }) => {
                const root = document.documentElement
                root.style.setProperty('--app-viewport-height', `${visibleHeight}px`)
                root.style.setProperty('--visual-viewport-offset-top', `${offset}px`)
                root.dataset.iosKeyboardOpen = String(visibleHeight === 300)
                document.querySelector('textarea').focus({ preventScroll: true })
                await new Promise(requestAnimationFrame)
                const dialog = document.querySelector('dialog').getBoundingClientRect()
                const controls = [...document.querySelectorAll('.chat-composer__row > *')].map(
                  (node) => {
                    const r = node.getBoundingClientRect()
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
                  },
                )
                return { top: dialog.top, height: dialog.height, controls }
              },
              { visibleHeight, offset },
            )
            assert.equal(state.top, offset)
            assert.equal(state.height, visibleHeight)
            assert.ok(
              state.controls.every(
                (r) =>
                  r.left >= 0 &&
                  r.right <= width &&
                  r.top >= offset &&
                  r.bottom <= offset + visibleHeight,
              ),
              JSON.stringify(state),
            )
          }
        }
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--app-viewport-height', '300px')
          document.documentElement.style.setProperty('--visual-viewport-offset-top', '35px')
          const marker = document.createElement('div')
          marker.id = 'pet-backdrop-rear-marker'
          Object.assign(marker.style, { position: 'fixed', inset: '0', background: 'rgb(255,0,0)' })
          document.body.prepend(marker)
        })
        const clip = { x: 10, y: Math.min(height - 20, 355), width: 20, height: 10 }
        const red = await page.screenshot({ clip })
        await page.locator('#pet-backdrop-rear-marker').evaluate((node) => {
          node.style.background = 'rgb(0,0,255)'
        })
        const blue = await page.screenshot({ clip })
        assert.ok(
          red.equals(blue),
          'expanded native assistant must hide the rear page below its keyboard viewport',
        )
        results.push({ width, theme, label: 'native pet full-page backdrop' })
      } finally {
        await context.close()
      }
    }
  await mkdir(environment.outputDir, { recursive: true })
  await writeFile(
    resolve(environment.outputDir, 'geometry.json'),
    JSON.stringify(
      {
        engine: environment.engine,
        evidence:
          'production CSS with representative DOM and controlled geometry; not physical iOS keyboard',
        results,
      },
      null,
      2,
    ),
  )
  console.log(`助手键盘布局：${environment.engine} ${results.length} 组通过`)
} finally {
  await browser.close()
}
