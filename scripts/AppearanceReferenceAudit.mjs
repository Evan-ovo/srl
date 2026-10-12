/* global document, window, navigator, getComputedStyle, PerformanceObserver, performance */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import console from 'node:console'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'appearance-reference')
const browser = await launchAuditBrowser(environment)
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  acceptDownloads: true,
})
await prepareAuditContext(context, environment, { trace: false })
await mkdir(environment.outputDir, { recursive: true })
const page = await context.newPage()
const errors = []
const referenceRequests = []
page.on('request', (request) => {
  if (request.url().includes('_virtual_srl-appearance-reference-'))
    referenceRequests.push(request.url())
})
await page.addInitScript(() => {
  window.__srlReferenceLongTasks = []
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      window.__srlReferenceLongTasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: 'longtask', buffered: true })
})
const cdp = environment.engine === 'chromium' ? await context.newCDPSession(page) : undefined
const heap = async () => (cdp ? (await cdp.send('Runtime.getHeapUsage')).usedSize : null)
const measurements = []
const measure = async (stage, action) => {
  const started = await page.evaluate(() => performance.now())
  await action()
  const ended = await page.evaluate(() => performance.now())
  const tasks = await page.evaluate(
    ({ started, ended }) =>
      window.__srlReferenceLongTasks.filter(
        (entry) => entry.start >= started && entry.start < ended,
      ),
    { started, ended },
  )
  measurements.push({
    stage,
    elapsedMs: ended - started,
    tutorialRequests: referenceRequests.length,
    heapBytes: await heap(),
    longTasks: tasks,
  })
}
page.on('pageerror', (error) => errors.push(error.message))
const guide = page.locator('.appearance-code-reference')
try {
  await page.goto(environment.baseUrl)
  await page.getByRole('button', { name: '功能', exact: true }).click()
  // Install a real candidate package through the normal UI, then verify the handbook reads its CSS.
  await page.getByRole('button', { name: 'APP 管理', exact: true }).click()
  await page.locator('.official-app-manager').waitFor()
  await page
    .locator('.official-app-manager li')
    .filter({ has: page.getByText('缝了么', { exact: true }) })
    .getByRole('button', { name: '下载', exact: true })
    .click()
  await page.getByRole('status').filter({ hasText: '安装成功' }).waitFor()
  await page.getByRole('button', { name: '返回功能桌面', exact: true }).click()
  await openAuditFeature(page, '外观')
  assert.equal(await page.getByText('常用样式变量', { exact: true }).count(), 0)
  assert.equal(await page.getByText('每个预设互相独立', { exact: false }).count(), 0)
  const open = async () => page.getByRole('button', { name: '接口参考', exact: true }).click()
  measurements.push({
    stage: 'appearance-before-question',
    tutorialRequests: referenceRequests.length,
    heapBytes: await heap(),
  })
  await measure('question-choice', async () => {
    await open()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.reference-choice button')].every(
        (button) => !button.disabled,
      ),
    )
  })
  await guide
    .getByRole('button', { name: '单独 APP 接口', exact: true })
    .waitFor({ state: 'visible' })
  await measure('app-directory', async () => {
    await guide.getByRole('button', { name: '单独 APP 接口', exact: true }).click()
    await guide.locator('.reference-app-list').waitFor({ state: 'visible' })
  })
  assert.equal(referenceRequests.length, 0, '问号与APP目录不提前下载完整接口正文')
  await measure('first-app-detail', async () => {
    await guide.getByRole('button', { name: /^缝了么/u }).click()
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.reference-footer [role="status"]')
          ?.textContent.includes('正在读取'),
    )
    await guide.locator('.reference-variable').first().waitFor({ state: 'visible' })
  })
  assert.equal(
    await guide
      .locator('.reference-variable ul, .reference-selectors pre, .reference-vue dl')
      .count(),
    0,
    '折叠详情不挂载隐藏正文',
  )
  await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
  await measure('repeat-app-detail', async () => {
    await guide.getByRole('button', { name: /^缝了么/u }).click()
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.reference-footer [role="status"]')
          ?.textContent.includes('正在读取'),
    )
  })
  await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
  await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme)
    for (const [width, height] of [
      [240, 800],
      [319, 615],
      [320, 800],
      [375, 812],
      [390, 844],
      [430, 932],
      [800, 800],
      [1024, 800],
    ]) {
      await page.setViewportSize({ width, height })
      await guide.getByRole('button', { name: '全局接口', exact: true }).click()
      if (width === 390 && theme === 'light') {
        await page.screenshot({ path: `${environment.outputDir}/reference-global-390.png` })
      }
      const shape = await guide.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        scroll: element.scrollWidth,
        client: element.clientWidth,
        viewport: window.innerWidth,
      }))
      assert.ok(
        Math.abs(shape.width - width) < 1 &&
          Math.abs(shape.height - height) < 1 &&
          shape.scroll <= shape.client + 1,
        JSON.stringify(shape),
      )
      const controls = await guide.evaluate((element) => {
        const input = element.querySelector('.reference-search input'),
          content = element.querySelector('.reference-content')
        const style = getComputedStyle(content)
        return {
          inputHeight: input.getBoundingClientRect().height,
          inputFont: getComputedStyle(input).fontSize,
          family: getComputedStyle(element).fontFamily,
          left: parseFloat(style.paddingLeft),
          right: parseFloat(style.paddingRight),
          iconBackgrounds: [
            ...element.querySelectorAll('.reference-header button.reference-icon'),
          ].map((node) => getComputedStyle(node).backgroundColor),
          header: [...element.querySelectorAll('.reference-header > button, .reference-header h2')]
            .filter((node) => node.getClientRects().length)
            .map((node) => {
              const r = node.getBoundingClientRect()
              return { left: r.left, right: r.right }
            }),
        }
      })
      assert.ok(
        Math.abs(controls.inputHeight - 36) < 1 && controls.inputFont === '14px',
        `紧凑搜索 ${theme}/${width}: ${JSON.stringify(controls)}`,
      )
      assert.equal(controls.left, controls.right, '正文不为目录预留整列空间')
      assert.ok(controls.family.includes('sans-serif'), '教程沿项目UI字体，不回退默认衬线字体')
      assert.ok(
        controls.iconBackgrounds.every((value) => value === 'rgba(0, 0, 0, 0)'),
        '图标工具不使用大底色',
      )
      assert.ok(
        controls.header.every(
          (rect, index) => !index || rect.left >= controls.header[index - 1].right - 1,
        ),
        '标题与工具不重叠',
      )
      const navigation = guide.getByRole('complementary', { name: '教程快速跳转', exact: true })
      const contentBounds = async () =>
        guide.locator('.reference-content').evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            scroll: element.scrollTop,
          }
        })
      assert.equal(await navigation.isVisible(), false)
      await guide.getByRole('searchbox', { name: '查找', exact: true }).fill('不存在的变量')
      const closedBounds = await contentBounds()
      await guide.getByRole('button', { name: '展开教程导航', exact: true }).click()
      await navigation.waitFor()
      assert.equal(
        await guide.locator('.reference-nav-backdrop').count(),
        0,
        '目录无遮罩，不禁用下层界面',
      )
      assert.equal(
        await navigation.getByRole('button', { name: '关闭教程导航', exact: true }).count(),
        0,
        '箭头是唯一目录开关，不重复放关闭叉',
      )
      assert.deepEqual(await contentBounds(), closedBounds, '展开导航不移动或挤压下层正文')
      const handleShape = await guide
        .locator('.reference-navigation-handle')
        .evaluate((element) => {
          const hit = element.getBoundingClientRect()
          const face = element.querySelector('span').getBoundingClientRect()
          const nav = element.parentElement
            .querySelector('.reference-navigation')
            .getBoundingClientRect()
          const toolbar = element
            .closest('dialog')
            .querySelector('.reference-header')
            .getBoundingClientRect()
          return {
            hit: hit.width,
            face: face.width,
            left: hit.left,
            right: hit.right,
            top: hit.top,
            navTop: nav.top,
            navBottom: nav.bottom,
            toolbarBottom: toolbar.bottom,
          }
        })
      assert.ok(
        handleShape.hit >= 44 &&
          handleShape.face <= 26 &&
          handleShape.left >= 0 &&
          handleShape.right <= width,
        '小箭头与透明点击区都在视口内',
      )
      assert.ok(
        handleShape.top < height * 0.25 &&
          handleShape.navTop === 0 &&
          handleShape.navBottom === height,
        '箭头位于右上，目录独立覆盖全屏高度，不被顶部栏或底部栏截断',
      )
      await guide.getByRole('button', { name: '收起教程导航', exact: true }).click()
      await navigation.waitFor({ state: 'hidden' })
      assert.deepEqual(await contentBounds(), closedBounds, '箭头收起导航不改变正文滚动或尺寸')
      await guide.getByRole('button', { name: '展开教程导航', exact: true }).click()
      assert.equal(await navigation.locator('select').count(), 0, '导航不能退化为下拉框')
      const directorySearch = navigation.getByRole('searchbox', {
        name: '搜索教程目录',
        exact: true,
      })
      assert.ok(await navigation.getByRole('button', { name: /^缝了么/u }).isVisible())
      await directorySearch.fill('缝了么')
      assert.equal(
        await navigation.locator('section button').count(),
        1,
        '目录按APP筛选，与正文筛选独立',
      )
      assert.equal(
        await navigation
          .locator('.reference-navigation-list')
          .evaluate((element) => element.scrollWidth - element.clientWidth),
        0,
      )
      if (width === 390 && theme === 'light')
        await page.screenshot({ path: `${environment.outputDir}/reference-sidebar-390.png` })
      await navigation.getByRole('button', { name: /^缝了么/u }).click()
      await navigation.waitFor({ state: 'hidden' })
      assert.equal(
        await guide.getByRole('searchbox', { name: '查找', exact: true }).inputValue(),
        '',
      )
      const chapter = guide.locator('[data-reference-chapter="stitch"]')
      assert.equal(
        await guide.locator('[data-reference-chapter]').count(),
        1,
        '目录切换对应正文，不重复主区域APP目录',
      )
      await chapter.waitFor()
      await guide.getByRole('button', { name: '展开教程导航', exact: true }).click()
      await directorySearch.fill('')
      assert.ok(
        (await navigation.locator('[aria-current="location"]').innerText()).includes('缝了么'),
      )
      assert.equal(await navigation.locator('[aria-current="location"] b').innerText(), '✓')
      await navigation.getByRole('button', { name: '设置页面', exact: true }).click()
      await guide.getByRole('button', { name: '展开教程导航', exact: true }).click()
      await directorySearch.fill('不存在的APP')
      assert.equal(await navigation.locator('section button').count(), 0)
      assert.ok(await navigation.getByText('没有找到匹配的 APP。', { exact: true }).isVisible())
      await directorySearch.fill('')
      if (width === 390 && theme === 'light')
        await page.screenshot({ path: `${environment.outputDir}/reference-sidebar-full-390.png` })
      if (width === 1024 && theme === 'light')
        await page.screenshot({
          path: `${environment.outputDir}/reference-sidebar-desktop-1024.png`,
        })
      await directorySearch.press('Escape')
      await navigation.waitFor({ state: 'hidden' })
      assert.ok(await guide.isVisible(), 'Escape先关闭目录，保留教程')
      assert.ok(
        await guide
          .getByRole('button', { name: '展开教程导航', exact: true })
          .evaluate((element) => element === document.activeElement),
      )
      await guide.getByRole('button', { name: '展开教程导航', exact: true }).click()
      await navigation.getByRole('button', { name: /^缝了么/u }).click()
      assert.equal(
        await chapter.locator('.reference-vue').getAttribute('open'),
        null,
        'Vue 默认折叠',
      )
      const content = guide.locator('.reference-content')
      const overflow = await content.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      )
      assert.ok(overflow <= 1, `${theme}/${width} overflow ${overflow}`)
      await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
      await guide.getByRole('button', { name: '单独 APP 接口', exact: true }).click()
      const rows = await guide.locator('.reference-app-list button').evaluateAll((elements) =>
        elements.map((element) => {
          const row = element.getBoundingClientRect(),
            title = element.querySelector('strong').getBoundingClientRect()
          return {
            height: row.height,
            font: getComputedStyle(element).fontSize,
            titleInside:
              title.top >= row.top &&
              title.bottom <= row.bottom &&
              title.left >= row.left &&
              title.right <= row.right,
            overflow: element.scrollWidth - element.clientWidth,
          }
        }),
      )
      assert.ok(
        rows.every(
          (row) => row.titleInside && row.overflow <= 1 && row.height >= 43 && row.font === '14px',
        ),
        `APP列表不能压缩/裁字 ${theme}/${width}: ${JSON.stringify(rows)}`,
      )
      if (width === 319 && theme === 'light')
        await page.screenshot({ path: `${environment.outputDir}/reference-app-list-319.png` })
      await guide.getByRole('button', { name: '设置页面', exact: true }).click()
      await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
      await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await page.screenshot({ path: `${environment.outputDir}/reference-choice-390.png` })
  await guide.getByRole('button', { name: '单独 APP 接口', exact: true }).click()
  await page.screenshot({ path: `${environment.outputDir}/reference-app-list-390.png` })
  await guide.getByRole('button', { name: /^缝了么/u }).click()
  await page.screenshot({ path: `${environment.outputDir}/reference-app-390.png` })
  const variable = guide
    .locator('.reference-variable')
    .filter({ has: page.locator('summary > code').filter({ hasText: /^--button-background$/u }) })
    .first()
  await variable.locator(':scope > summary').click()
  await variable.locator('ul').waitFor({ state: 'visible' })
  assert.ok((await variable.locator('ul').innerText()).includes('使用：'))
  assert.ok((await variable.innerText()).includes('普通按钮背景'))
  const vue = guide.locator('.reference-vue')
  await vue.locator(':scope > summary').click()
  await vue.locator('dl').waitFor({ state: 'visible' })
  assert.equal(await vue.getAttribute('open'), '')
  await vue.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${environment.outputDir}/reference-vue-390.png` })
  const selectors = guide.locator('.reference-selectors')
  await selectors.locator(':scope > summary').click()
  const source = selectors.locator('details').first()
  await source.locator(':scope > summary').click()
  await source.locator('pre').waitFor({ state: 'visible' })
  assert.ok((await source.locator('pre').innerText()).includes('作用：'))
  for (const [label, kind] of [
    ['仅导出 CSS 接口', 'css'],
    ['仅导出 Vue 教程', 'vue'],
    ['两者都导出', 'both'],
  ]) {
    await guide.getByRole('button', { name: '导出教程', exact: true }).click()
    const downloadPending = page.waitForEvent('download')
    await guide.getByRole('button', { name: label, exact: true }).click()
    const download = await downloadPending
    assert.equal(download.suggestedFilename(), `SRL-缝了么接口-${kind}.md`)
    const markdown = await readFile(await download.path(), 'utf8')
    assert.ok(markdown.includes('## 缝了么'))
    assert.equal(markdown.includes('### CSS 接口'), kind !== 'vue')
    assert.equal(markdown.includes('page.click(selector)'), kind !== 'css')
    assert.ok(markdown.includes('源码版本：'))
    if (kind !== 'vue') {
      assert.ok(markdown.includes('已安装 APP 样式：'))
      assert.ok(markdown.includes('#### /assets/'), '来自实际安装包的 CSS，不冒充源码文件')
    }
    if (kind !== 'css') {
      assert.ok(markdown.includes('UiViewSnapshot.controls: UiControl[]'))
      assert.ok(markdown.includes('page.Region.selector'))
    }
    assert.ok(!markdown.includes('## 前端了么'))
  }
  await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
  await guide.getByRole('button', { name: '返回教程列表', exact: true }).click()
  await guide.getByRole('button', { name: '全局接口', exact: true }).click()
  await guide.getByRole('searchbox').fill('--button-background')
  assert.ok((await guide.locator('.reference-content').innerText()).includes('普通按钮背景'))
  await guide.getByRole('searchbox').fill('不存在的接口-abcdef')
  assert.ok((await guide.locator('.reference-content').innerText()).includes('没有找到匹配的接口'))
  await guide.getByRole('searchbox').fill('')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await guide.getByRole('button', { name: '一键复制', exact: true }).click()
  await guide.getByRole('status').filter({ hasText: '当前教程已复制' }).waitFor()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.ok(
    copied.includes('## 缝了么') &&
      copied.includes('## 前端了么') &&
      copied.includes('page.click(selector)'),
  )
  assert.equal(copied.match(/## Vue 用法与接口/gu).length, 1)
  await guide.getByRole('button', { name: '导出教程', exact: true }).click()
  const allDownloadPending = page.waitForEvent('download')
  await guide.getByRole('button', { name: '两者都导出', exact: true }).click()
  const allDownload = await allDownloadPending
  const allMarkdown = await readFile(await allDownload.path(), 'utf8')
  assert.ok(
    allMarkdown.replaceAll('\r\n', '\n') === copied.replaceAll('\r\n', '\n'),
    '下载与剪贴板内容一致（忽略系统换行格式）',
  )
  await guide.getByRole('button', { name: '关闭接口参考', exact: true }).click()
  await guide.waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  await writeFile(
    `${environment.outputDir}/reference-result.json`,
    JSON.stringify(
      {
        status: 'passed',
        widths: [240, 319, 320, 375, 390, 430, 800, 1024],
        themes: ['light', 'dark'],
        exports: ['css', 'vue', 'both', 'global-both'],
        globalMarkdownBytes: Buffer.byteLength(copied),
        installedCss:
          'stitch: verified candidate package; per-asset source positions and package identity exported',
        generatedVue: ['UiViewSnapshot.controls', 'page.Region.selector'],
        measurements,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    '接口教程通过：36px搜索/14px字号、16种尺寸主题、边缘箭头展开收起不改变正文、独立目录搜索/选中/末项/Esc、四种导出与剪贴板读回',
  )
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await browser.close()
}
