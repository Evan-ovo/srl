/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import console from 'node:console'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { chromium, webkit } from 'playwright-core'
import { compileStyle } from '@vue/compiler-sfc'

const [foundation, featureDesktop, featureHeader, featureBack, imageGenerationSource] =
  await Promise.all([
    readFile('src/styles/Foundation.css', 'utf8'),
    readFile('src/styles/FeatureDesktop.css', 'utf8'),
    readFile('src/styles/FeatureAppHeader.css', 'utf8'),
    readFile('src/styles/FeatureBackButton.css', 'utf8'),
    readFile('src/styles/ImageGenerationApp.css', 'utf8'),
  ])
const { code: imageGeneration, errors } = compileStyle({
  source: imageGenerationSource,
  id: 'data-v-image-generation-audit',
  scoped: true,
})
assert.deepEqual(errors, [])
const engine = process.env.SRL_AUDIT_ENGINE || process.env.SRL_STITCH_BROWSER_ENGINE || 'chromium'
const browserType = engine === 'webkit' ? webkit : chromium
const browser = await browserType.launch({
  executablePath: engine === 'webkit' ? undefined : process.env.EDGE_PATH || undefined,
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.setContent(`<!doctype html><html data-v-image-generation-audit><head><style>${foundation}
${featureDesktop}
${featureHeader}
${featureBack}
${imageGeneration}</style></head><body>
    <main class="feature-hub feature-hub--app" data-feature-page="imageGeneration" data-v-image-generation-audit>
      <section class="image-generation-app" data-v-image-generation-audit role="dialog" aria-modal="true">
        <header class="feature-app-header" data-v-image-generation-audit><button class="feature-back-button" data-v-image-generation-audit>返回</button><div data-v-image-generation-audit><h1 data-v-image-generation-audit>AI 生图</h1></div><div data-v-image-generation-audit></div></header>
        <main class="shell" data-v-image-generation-audit><section class="panel editor" data-v-image-generation-audit>

        <div class="providerbar" data-v-image-generation-audit>模型</div>
        <nav class="tabs" data-v-image-generation-audit>标签</nav>
        <section class="scroll image-generation-controls" data-v-image-generation-audit>
          <div data-v-image-generation-audit style="height:1200px"><textarea class="textarea" data-v-image-generation-audit aria-label="画面描述"></textarea></div>
        </section><footer class="footerbar" data-v-image-generation-audit><span class="cost" data-v-image-generation-audit>预计费用未知</span><button data-v-image-generation-audit>生成图片</button></footer></section></main>
      </section>
    </main>
    <div class="keyboard-safe-area-probe"></div>
  </body></html>`)
  await page.addStyleTag({
    content: `*{box-sizing:border-box}html,body{margin:0;min-height:0}.keyboard-safe-area-probe{height:var(--app-viewport-height);padding-bottom:var(--safe-bottom);background:tomato}:root{--app-viewport-height:844px;--safe-top:0px;--safe-right:0px;--safe-bottom:34px;--safe-left:0px;--visual-viewport-offset-top:0px;--mobile-gutter:16px}`,
  })
  const measure = () =>
    page.evaluate(() => {
      const root = document.querySelector('.feature-hub').getBoundingClientRect()
      const app = document.querySelector('.image-generation-app').getBoundingClientRect()
      const editor = document.querySelector('.editor').getBoundingClientRect()
      const scroller = document.querySelector('.image-generation-controls').getBoundingClientRect()
      const footer = document.querySelector('.footerbar').getBoundingClientRect()
      const probe = document.querySelector('.keyboard-safe-area-probe')
      return {
        rootBottom: root.bottom,
        appBottom: app.bottom,
        appTop: app.top,
        editorBottom: editor.bottom,
        scrollerBottom: scroller.bottom,
        scrollerHeight: document.querySelector('.image-generation-controls').clientHeight,
        textareaHeight: document.querySelector('textarea').getBoundingClientRect().height,
        footerBottom: footer.bottom,
        footerDisplay: document.defaultView.getComputedStyle(document.querySelector('.footerbar'))
          .display,
        providerDisplay: document.defaultView.getComputedStyle(
          document.querySelector('.providerbar'),
        ).display,
        tabsDisplay: document.defaultView.getComputedStyle(document.querySelector('.tabs')).display,
        safeBottom: document.defaultView.getComputedStyle(probe).paddingBottom,
      }
    })
  const back = page.getByRole('button', { name: '返回', exact: true })
  const normal = await back.evaluate((node) => getComputedStyle(node).backgroundColor)
  await back.hover()
  assert.notEqual(
    await back.evaluate((node) => getComputedStyle(node).backgroundColor),
    normal,
    'mouse hover feedback remains available',
  )
  await page.mouse.move(389, 843)
  await page.keyboard.press('Tab')
  assert.equal(
    await back.evaluate(
      (node) => node === document.activeElement && getComputedStyle(node).outlineWidth === '2px',
    ),
    true,
    'keyboard focus remains visible',
  )
  const closed = await measure()
  assert.deepEqual(
    {
      rootBottom: closed.rootBottom,
      appBottom: closed.appBottom,
      editorBottom: closed.editorBottom,
      safeBottom: closed.safeBottom,
    },
    { rootBottom: 844, appBottom: 844, editorBottom: 810, safeBottom: '34px' },
  )
  assert.ok(closed.footerBottom <= closed.appBottom)
  assert.ok(
    Math.abs(closed.appBottom - closed.footerBottom - 34) <= 1,
    'home inset plus the editor border',
  )
  assert.ok(closed.scrollerBottom < closed.footerBottom)
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-viewport-height', '420px')
    document.documentElement.style.setProperty('--visual-viewport-offset-top', '72px')
    document.documentElement.dataset.iosKeyboardOpen = 'true'
    document.documentElement.dataset.visualViewportReduced = 'true'
  })
  const open = await measure()
  assert.deepEqual(
    {
      rootBottom: open.rootBottom,
      appTop: open.appTop,
      appBottom: open.appBottom,
      editorBottom: open.editorBottom,
      safeBottom: open.safeBottom,
    },
    { rootBottom: 420, appTop: 72, appBottom: 492, editorBottom: 492, safeBottom: '0px' },
  )
  assert.equal(open.footerDisplay, 'none')
  assert.ok(open.scrollerBottom <= open.appBottom)
  assert.ok(open.scrollerHeight >= 100, `keyboard scroller collapsed to ${open.scrollerHeight}px`)
  assert.deepEqual([open.providerDisplay, open.tabsDisplay], ['none', 'none'])
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-viewport-height', '189px')
  })
  await page.locator('textarea').focus()
  const compactOpen = await measure()
  assert.ok(
    compactOpen.scrollerHeight >= 40,
    `189px keyboard viewport left only ${compactOpen.scrollerHeight}px for the input scroller`,
  )
  assert.ok(
    compactOpen.textareaHeight >= 132,
    `189px keyboard viewport must preserve the textarea's 132px minimum; got ${compactOpen.textareaHeight}px`,
  )
  assert.equal(
    await page
      .locator('.image-generation-controls')
      .evaluate((node) => getComputedStyle(node).overflowY),
    'auto',
    'the input scroller, not the textarea itself, owns the compact viewport overflow',
  )
  assert.equal(compactOpen.footerDisplay, 'none')
  assert.ok(compactOpen.scrollerBottom <= compactOpen.appBottom)
  await page.evaluate(() => {
    document.documentElement.dataset.iosKeyboardOpen = 'false'
  })
  const zoomed = await measure()
  assert.ok(
    zoomed.scrollerHeight >= 40 && zoomed.textareaHeight >= 132,
    'reduced zoom viewport preserves input area and scroll capacity ' + JSON.stringify(zoomed),
  )
  assert.equal(zoomed.safeBottom, '34px', 'zoom does not release keyboard-only system insets')
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-viewport-height', '844px')
    document.documentElement.style.setProperty('--visual-viewport-offset-top', '0px')
    delete document.documentElement.dataset.iosKeyboardOpen
    delete document.documentElement.dataset.visualViewportReduced
  })
  const restored = await measure()
  assert.deepEqual(restored, closed)
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '59px')
    document.documentElement.style.setProperty('--page-background', 'rgb(52,38,48)')
  })
  const notched = await measure()
  assert.equal(notched.appTop, 0, 'the app surface covers the status-bar region')
  assert.equal(notched.appBottom, 844, 'the app surface includes the home-indicator region')
  const pixels = await page.evaluate(() =>
    [10, 58, 70].map((y) => {
      const node = document.elementFromPoint(2, y)
      return {
        covered: Boolean(node?.closest('.image-generation-app')),
        background: getComputedStyle(document.querySelector('.image-generation-app'))
          .backgroundColor,
      }
    }),
  )
  assert.ok(pixels.every((row) => row.covered && row.background === 'rgb(52, 38, 48)'))
  console.log(
    `PASS (${engine}): iOS keyboard hides generation bar and keeps focused textarea in the viewport`,
  )
} finally {
  await browser.close()
}
