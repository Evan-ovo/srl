/* global document, localStorage, window, getComputedStyle, navigator */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'ui-customization')
const browser = await launchAuditBrowser(environment)
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
await prepareAuditContext(context, environment)
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => {
  if (!error.message.includes('UI审计运行失败')) errors.push(error.message)
})
const expand = async (locator) => {
  if (!(await locator.evaluate((element) => element.open)))
    await locator.locator(':scope > summary').click()
}
const appearance = async () => {
  await openAuditFeature(page, '外观')
  await expand(page.locator('.appearance-advanced'))
}
async function auditCardSettings() {
  if (!process.env.SRL_APPEARANCE_CARD_CSS) return
  const cardContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await prepareAuditContext(cardContext, environment)
  const cardPage = await cardContext.newPage()
  try {
    await cardPage.goto(environment.baseUrl)
    await cardPage.getByLabel('选择单个资源文件，可多选', { exact: true }).setInputFiles([
      ...[1, 2].map((index) => ({
        name: `card-settings-${index}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
              name: `排版测试${index}`,
              description: index === 1 ? '短说明' : '较长的合成说明。'.repeat(20),
              personality: '',
              scenario: '',
              first_mes: '合成测试',
              creator: 'fixture',
              tags: [],
            },
          }),
        ),
      })),
      {
        name: 'card-settings-world.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            name: '短世界书',
            entries: { 0: { uid: 0, key: ['测试'], content: '合成内容', comment: '测试' } },
          }),
        ),
      },
    ])
    await cardPage.locator('.resource-card').nth(2).waitFor()
    const results = []
    for (const skin of ['default', 'cotton']) {
      if (skin === 'cotton') {
        await cardPage.getByRole('button', { name: '功能', exact: true }).click()
        await openAuditFeature(cardPage, '外观')
        await cardPage.locator('[data-appearance-preset-import]').setInputFiles({
          name: 'cotton-card-test.css',
          mimeType: 'text/css',
          buffer: await readFile(process.env.SRL_APPEARANCE_CARD_CSS),
        })
        await cardPage.getByRole('button', { name: '保留更改', exact: true }).click()
        await cardPage.locator('.feature-app-header__back').first().click()
        await cardPage.getByRole('button', { name: '返回资源库', exact: true }).click()
      }
      for (const [height, label] of [
        ['natural', '各自高度'],
        ['uniform', '统一按最长内容'],
        ['fixed', '统一按固定长度'],
      ]) {
        for (const [orientation, title, ratio] of [
          ['portrait', '全部竖版', '2 / 3'],
          ['landscape', '全部横版', '3 / 2'],
        ]) {
          await cardPage.getByRole('button', { name: '功能', exact: true }).click()
          await openAuditFeature(cardPage, '外观')
          await cardPage.getByRole('radio', { name: /^卡片浏览/ }).click()
          const dialog = cardPage.getByRole('dialog', { name: '卡片浏览外观', exact: true })
          await dialog.getByRole('radio', { name: new RegExp('^' + label) }).click()
          await dialog.getByRole('radio', { name: new RegExp('^' + title) }).click()
          await dialog.getByRole('button', { name: '关闭卡片方向选择', exact: true }).click()
          assert.equal(
            await cardPage.locator('html').getAttribute('data-resource-card-height'),
            height,
          )
          assert.equal(
            await cardPage.locator('html').getAttribute('data-mobile-card-orientation'),
            orientation,
          )
          await cardPage.locator('.feature-app-header__back').first().click()
          await cardPage.getByRole('button', { name: '返回资源库', exact: true }).click()
          await cardPage.locator('.resource-card').first().waitFor({ state: 'visible' })
          if (height === 'uniform')
            await cardPage.waitForFunction(() => {
              const heights = [...document.querySelectorAll('.resource-card')].map(
                (card) => card.getBoundingClientRect().height,
              )
              return Math.max(...heights) - Math.min(...heights) < 2
            })
          const values = await cardPage.locator('.resource-card').evaluateAll((cards) =>
            cards.map((card) => ({
              height: card.getBoundingClientRect().height,
              ratio: card.querySelector('.resource-card__name-cover')
                ? getComputedStyle(card.querySelector('.resource-card__name-cover')).aspectRatio
                : '',
              bodyHeight: getComputedStyle(card.querySelector('.resource-card__body')).height,
            })),
          )
          if (height !== 'uniform') {
            const covers = values.filter((value) => value.ratio)
            assert.ok(covers.length >= 2)
            covers.forEach((value) =>
              assert.equal(value.ratio, ratio, `${skin}/${height}/${orientation}: 封面比例`),
            )
          }
          if (height === 'natural')
            assert.ok(
              Math.max(...values.map((value) => value.height)) -
                Math.min(...values.map((value) => value.height)) >
                10,
              '夹具在自然高度下应有差异',
            )
          if (height === 'uniform')
            assert.ok(
              Math.max(...values.map((value) => value.height)) -
                Math.min(...values.map((value) => value.height)) <
                2,
              `${skin}/${orientation}: 统一高度`,
            )
          results.push({ skin, height, orientation, values })
          if (skin === 'cotton' && height === 'fixed')
            await cardPage.screenshot({
              animations: 'disabled',
              path: `${environment.outputDir}/cards-cotton-${orientation}.png`,
            })
        }
      }
    }
    const conflicting = await cardPage.addStyleTag({
      content: '.resource-card__name-cover { aspect-ratio: 1 !important; }',
    })
    assert.equal(
      await cardPage
        .locator('.resource-card__name-cover')
        .first()
        .evaluate((element) => getComputedStyle(element).aspectRatio),
      '1 / 1',
    )
    await conflicting.evaluate((element) => element.remove())
    assert.equal(
      await cardPage
        .locator('.resource-card__name-cover')
        .first()
        .evaluate((element) => getComputedStyle(element).aspectRatio),
      '3 / 2',
    )
    console.log('卡片设置真实切换', JSON.stringify(results))
  } finally {
    await cardContext.close()
  }
}
try {
  await page.goto(environment.baseUrl)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const remoteSwitch = settings
    .locator('.settings-switch-row')
    .filter({ hasText: '允许远程资源' })
    .getByRole('checkbox')
  assert.equal(await remoteSwitch.isChecked(), false, '全局联网默认关闭')
  await remoteSwitch.locator('..').locator('i').click()
  assert.equal(await remoteSwitch.isChecked(), true)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('srl.preview.allowRemoteResources')),
    'true',
  )
  await remoteSwitch.locator('..').locator('i').click()
  assert.equal(await remoteSwitch.isChecked(), false)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('srl.preview.allowRemoteResources')),
    'false',
  )
  await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
  for (const theme of ['light', 'dark'])
    for (const width of [240, 260, 280, 300, 320, 375, 390, 430, 1024]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      for (const batch of [false, true]) {
        if (batch) await page.getByRole('button', { name: '多选', exact: true }).click()
        for (const sort of ['newest', 'name', 'size']) {
          await page.getByLabel('资源排序', { exact: true }).selectOption(sort)
          const dimensions = await page.locator('.toolbar__meta').evaluate((element) => {
            const sort = element.querySelector('select')
            const actions = element.querySelector('.toolbar__actions')
            const a = sort.getBoundingClientRect(),
              b = actions.getBoundingClientRect()
            return {
              sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 3,
              noOverflow: element.scrollWidth <= element.clientWidth,
              layout: `${element.scrollWidth}/${element.clientWidth},sort=${a.width},actions=${b.width},result=${element.querySelector('.toolbar__result').getBoundingClientRect().width},right=${b.right}`,
              textWidth:
                sort.clientWidth -
                parseFloat(getComputedStyle(sort).paddingRight) -
                parseFloat(getComputedStyle(sort).paddingLeft),
              fontSize: parseFloat(getComputedStyle(sort).fontSize),
            }
          })
          assert.ok(
            dimensions.sameRow && dimensions.noOverflow,
            `${theme}/${width}/${batch}: 工具栏同排且不溢出 (${dimensions.layout})`,
          )
          assert.ok(
            dimensions.textWidth >= dimensions.fontSize * (width < 300 ? 1.5 : 4),
            width < 300 ? '最窄屏仍能看见部分排序选项' : '四字排序文字应完整显示',
          )
          await page.getByRole('button', { name: '名称相似', exact: true }).click({ trial: true })
        }
        if (!batch && (width === 240 || width === 320)) {
          await page.getByLabel('资源排序', { exact: true }).selectOption('newest')
          await page
            .locator('.toolbar')
            .screenshot({ path: `${environment.outputDir}/toolbar-${width}-${theme}.png` })
        }
        if (batch) await page.getByRole('button', { name: '退出多选', exact: true }).click()
      }
    }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '功能', exact: true }).click()
  await appearance()
  await page.getByRole('tab', { name: '功能桌面', exact: true }).click()
  const editor = page.locator('.appearance-ui-editor')
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [
      [320, 800],
      [240, 800],
      [280, 800],
      [375, 812],
      [390, 844],
      [430, 932],
      [1024, 844],
    ]) {
      await page.setViewportSize({ width, height })
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      const dimensions = await page
        .locator('.appearance-panel--code > header')
        .evaluate((element) => {
          const title = element.querySelector('h2').getBoundingClientRect()
          const buttons = [
            ...element.querySelectorAll('.appearance-original-css-actions button'),
          ].map((button) => button.getBoundingClientRect())
          const help = element.querySelector('.appearance-code-help').getBoundingClientRect()
          return {
            sameRow: Math.abs(buttons[0].top - buttons[1].top) < 1,
            separate: title.bottom <= buttons[0].top,
            helpAligned:
              Math.abs((help.top + help.bottom) / 2 - (title.top + title.bottom) / 2) < 3,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
          }
        })
      assert.ok(
        dimensions.sameRow && dimensions.separate && dimensions.helpAligned && !dimensions.overflow,
        `CSS顶部布局 ${theme}/${width}: ${JSON.stringify(dimensions)}`,
      )
    }
  }
  const compactMeasurements = []
  for (const width of [240, 280, 320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    compactMeasurements.push(
      await page.locator('.appearance-panel--code').evaluate((element) => {
        const buttons = [...element.querySelectorAll('.appearance-original-css-actions > button')]
        return {
          width: window.innerWidth,
          panelHeight: element.getBoundingClientRect().height,
          buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
          faceHeights: buttons.map(
            (button) =>
              (button.querySelector('.appearance-action-face') || button).getBoundingClientRect()
                .height,
          ),
        }
      }),
    )
    await page
      .locator('.appearance-panel--code')
      .screenshot({ path: `${environment.outputDir}/appearance-code-${width}.png` })
    if (width === 390) {
      await page.locator('.feature-app-header').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${environment.outputDir}/appearance-overview-390.png` })
    }
  }
  console.log('外观紧凑布局测量', JSON.stringify(compactMeasurements))
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await editor.locator('.appearance-ui-editor__vue').evaluate((node) => node.open),
    false,
    'Vue默认折叠',
  )
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page
    .locator('.appearance-advanced')
    .screenshot({ path: environment.outputDir + '/vue-folded.png' })
  await page
    .locator('.appearance-panel--code > header')
    .screenshot({ path: environment.outputDir + '/vue-help-entry.png' })
  await page.getByRole('button', { name: '接口参考', exact: true }).click()
  const help = page.locator('dialog.appearance-code-reference')
  await help.waitFor()
  await help.getByRole('button', { name: '全局接口', exact: true }).click()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await help.getByRole('button', { name: '一键复制', exact: true }).click()
  await help.getByRole('status').filter({ hasText: '当前教程已复制' }).waitFor()
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes('page.click'))
  await page.screenshot({ path: environment.outputDir + '/vue-reference.png' })
  await help.getByRole('button', { name: '关闭接口参考', exact: true }).click()
  await expand(editor.locator('.appearance-ui-editor__vue'))
  await editor.getByRole('button', { name: '创建 Vue 模板', exact: true }).click()
  assert.equal(
    await editor.locator('.appearance-ui-editor__enable input').isChecked(),
    false,
    '创建不自动启用',
  )
  await page
    .locator('.appearance-advanced')
    .screenshot({ path: environment.outputDir + '/vue-expanded.png' })
  const starter = await editor.locator('.appearance-ui-editor__source textarea').inputValue()
  const editedStarter = starter
    .replace("const title = ref('')", "const title = ref('Vue 标题验收')")
    .replace(
      '<Region body />',
      '<button type="button" @click="showMenu = !showMenu">自定义菜单</button><p v-if="showMenu" id="vue-local-state">自定义交互已打开</p><Region body />',
    )
  await editor.locator('.appearance-ui-editor__source textarea').fill(editedStarter)
  await editor.getByRole('button', { name: '预览', exact: true }).click()
  const starterFrame = editor.locator('.appearance-ui-editor__preview iframe[title="自定义界面"]')
  await starterFrame.waitFor()
  const starterApp = starterFrame.contentFrame().frameLocator('iframe')
  await starterApp.getByRole('heading', { name: 'Vue 标题验收', exact: true }).waitFor()
  await starterApp.getByRole('button', { name: '自定义菜单', exact: true }).click()
  await starterApp.locator('#vue-local-state').waitFor()
  await starterApp.getByRole('button', { name: '返回', exact: true }).click()
  assert.equal(
    await page.locator('.feature-hub').getAttribute('data-feature-page'),
    'appearance',
    '只读预览不导航原APP',
  )
  await editor.screenshot({ path: environment.outputDir + '/vue-advanced-template.png' })
  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  await editor
    .locator('textarea')
    .fill(
      '<script>throw new Error("UI审计运行失败")</script><template><div>失败夹具</div></template>',
    )
  await editor.getByRole('button', { name: '预览', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: '自定义界面运行失败' }).waitFor()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  const source = `<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
const view = ref({ html: '', controls: [] as { id: string, label: string }[] })
let stop: (() => void) | undefined
onMounted(() => { stop = window.srlUi.subscribe(value => { view.value = value }) })
onBeforeUnmount(() => stop?.())
function open() { const control = view.value.controls.find(item => item.label.includes('外观')); if (control) window.srlUi.invoke({ id: control.id, event: 'click' }) }
</script><template><div id="audit-custom-view"><button aria-label="SVG外观" @click="open"><svg viewBox="0 0 100 44" width="100" height="44"><path d="M20 0H80L100 22L80 44H20L0 22Z" fill="currentColor"/><text x="50" y="28" text-anchor="middle" fill="white">外观</text></svg></button><div v-html="view.html"></div></div></template><style>#audit-custom-view>button{padding:0;border:0;background:none;color:var(--color-accent);clip-path:polygon(20% 0,80% 0,100% 50%,80% 100%,20% 100%,0 50%)}</style>`
  await editor.locator('textarea').fill(source)
  await editor.getByRole('button', { name: '预览', exact: true }).click()
  const preview = editor.locator('.appearance-ui-editor__preview iframe')
  await preview.waitFor()
  await preview.contentFrame().frameLocator('iframe').locator('#audit-custom-view').waitFor()
  await editor.locator('textarea').fill(`${source}\n`)
  await editor.locator('textarea').evaluate((element) => {
    element.scrollTop = 0
  })
  assert.ok(
    await editor.locator('.appearance-ui-editor__preview').isVisible(),
    '编辑源码时预览保持打开',
  )
  await preview.waitFor()
  await preview.contentFrame().frameLocator('iframe').locator('#audit-custom-view').waitFor()
  await editor.screenshot({ path: `${environment.outputDir}/appearance-editor.png` })
  assert.equal(await preview.getAttribute('sandbox'), 'allow-scripts')
  assert.equal(
    await preview
      .contentFrame()
      .frameLocator('iframe')
      .locator('html')
      .evaluate(() => {
        try {
          return Boolean(window.top.document)
        } catch {
          return false
        }
      }),
    false,
    '作者源码不能访问主页面',
  )
  const requests = []
  await context.route('https://ui-audit.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.abort()
  })
  await preview
    .contentFrame()
    .frameLocator('iframe')
    .locator('html')
    .evaluate(() => {
      window.location.href = 'https://ui-audit.invalid/navigation'
    })
  assert.deepEqual(requests, [], '禁止联网的界面不能通过容器导航发送请求')
  assert.equal(page.url(), environment.baseUrl + '/')
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await editor.getByLabel('启用此界面的 Vue', { exact: true }).check()
  await page.getByRole('button', { name: '保存并应用', exact: true }).click()
  await page.getByRole('button', { name: '运行并试用', exact: true }).click()
  await page.getByRole('button', { name: '保留更改', exact: true }).click()
  // The feature-specific appearance editor stays native while the generic desktop is replaced.
  const frame = page.locator('.srl-custom-ui-surface.is-ready iframe')
  await frame.waitFor()
  await frame
    .contentFrame()
    .frameLocator('iframe')
    .locator('.feature-app-header__back')
    .first()
    .click()
  await frame.contentFrame().frameLocator('iframe').locator('#audit-custom-view').waitFor()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('srl.ui.customViews.v1')))
  assert.ok(saved.features.enabled)
  for (const theme of ['light', 'dark'])
    for (const width of [320, 375, 390, 430, 1024]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await frame
        .contentFrame()
        .frameLocator('iframe')
        .getByRole('button', { name: 'SVG外观', exact: true })
        .click({ trial: true })
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${theme}/${width}: 主界面横向溢出`,
      )
    }
  await page.setViewportSize({ width: 390, height: 844 })
  await frame
    .contentFrame()
    .frameLocator('iframe')
    .getByRole('button', { name: 'SVG外观', exact: true })
    .click()
  await page.locator('.appearance-studio').waitFor({ state: 'attached' })
  // The custom desktop also receives the new native route and can invoke its Back control.
  await frame.contentFrame().frameLocator('iframe').locator('.feature-app-header__back').click()
  await frame.contentFrame().frameLocator('iframe').locator('.feature-desktop').waitFor()
  await page.screenshot({ path: `${environment.outputDir}/custom-svg.png`, fullPage: true })
  await page.getByRole('button', { name: '恢复原界面', exact: true }).click()
  await frame.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.srl-ui-controller-hidden').count(), 0)
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('srl.ui.customViews.v1')).features.enabled,
    ),
    false,
  )
  await appearance()
  await page.getByRole('tab', { name: /^功能桌面/u }).click()
  await expand(editor.locator('.appearance-ui-editor__vue'))
  assert.equal(await editor.locator('textarea').inputValue(), `${source}\n`)
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [], '源码导航在整个审计期间未发送联网请求')
  await auditCardSettings()
  console.log(
    '界面源码审计通过：Vue/TS/SVG、隔离预览、问号参考复制与折叠展开、原功能动作、九种宽度/明暗主题与恢复原界面',
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await context.close()
  await browser.close()
}
