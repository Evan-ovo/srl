import { importReaderFixtureFiles } from './ChatReaderAuditSupport.mjs'
/* global document, window, requestAnimationFrame */
import assert from 'node:assert/strict'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { mkdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { resolve } from 'node:path'
import { auditEnvironment, launchAuditBrowser, prepareAuditContext } from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'reader-scripts')
const browser = await launchAuditBrowser(environment)
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})
await prepareAuditContext(context, environment, { trace: false })
await mkdir(environment.outputDir, { recursive: true })
const page = await context.newPage()
const errors = []
const runtimeErrors = []
page.on('console', (message) => {
  if (['error', 'warning'].includes(message.type()) && runtimeErrors.length < 20)
    runtimeErrors.push(message.text().slice(0, 600))
})
page.on('pageerror', (error) =>
  errors.push(
    error.message
      .replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[data module]')
      .slice(0, 600),
  ),
)
page.setDefaultTimeout(15000)
const phoneCode = `const doc=parent.document;doc.documentElement.dataset.phoneStarts=String(Number(doc.documentElement.dataset.phoneStarts||0)+1);const floor=getLastMessageId();const reply=getChatMessages(String(floor))[0].swipe_id;const vars=getVariables({type:'message',message_id:floor});initializeGlobal('ReaderPhone',{floor,reply,vars});const node=doc.createElement('p');node.id='phone-output';node.style.cssText='position:fixed;top:0;left:0;z-index:2;pointer-events:none';node.textContent='手机：楼'+floor+' 回复'+reply+' '+vars.stat_data.place;doc.body.append(node);const absolute=doc.createElement('aside');absolute.id='phone-absolute';absolute.style.cssText='position:absolute;top:12px;left:8px;width:20px;height:20px;pointer-events:none';doc.body.append(absolute);eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED,id=>{doc.documentElement.dataset.renderedFloor=String(id);const floor=id;const reply=getChatMessages(String(floor))[0].swipe_id;const vars=getVariables({type:'message'});initializeGlobal('ReaderPhone',{floor,reply,vars});node.textContent='手机：楼'+floor+' 回复'+reply+' '+vars.stat_data.place});
if(typeof Vue!=='object')throw Error('Vue dependency missing');
const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('phone-controls',1);request.onupgradeneeded=()=>request.result.createObjectStore('prefs');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
await new Promise((resolve,reject)=>{const tx=db.transaction('prefs','readwrite');tx.objectStore('prefs').put(360,'width');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
const overlay=doc.createElement('div');overlay.id='phone-overlay';overlay.textContent='全屏手机';overlay.style.cssText='position:fixed;inset:0;z-index:999999;background:ivory';doc.body.append(overlay);
appendInexistentScriptButtons([{name:'手机显隐切换',visible:true}]);eventOn(getButtonEvent('手机显隐切换'),()=>overlay.hidden=!overlay.hidden);`
const frontend =
  '```html\n<body><p id="panel">等待手机</p><script>(async()=>{await waitGlobalInitialized("ReaderPhone");if(typeof $.fn.draggable!=="function")throw Error("jQuery UI missing after floor update");parent.__readerPanelStarts??={};parent.__readerPanelStarts[window.name]=(parent.__readerPanelStarts[window.name]||0)+1;const paint=()=>document.querySelector("#panel").textContent="面板：楼"+getCurrentMessageId()+" 回复"+getChatMessages(String(getCurrentMessageId()))[0].swipe_id+" "+getVariables({type:"message"}).stat_data.place;paint();eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED,paint)})()</script></body>\n```'
const panelCount = 8
const floorText =
  '许安开头\n\n' +
  Array(panelCount)
    .fill(frontend + '\n\n许安中段')
    .join('\n\n') +
  '\n\n许安尾声'
const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '阅读脚本测试角色',
    description: '隔离验收夹具',
    first_mes: '你好',
    personality: '',
    scenario: '',
    mes_example: '',
    character_book: { name: '阅读脚本测试世界书', entries: [] },
    extensions: {
      tavern_helper: {
        scripts: [
          {
            type: 'script',
            id: 'phone',
            name: '阅读手机',
            content: phoneCode,
            enabled: true,
            data: { label: '原件配置' },
          },
        ],
      },
    },
  },
}
const rows = Array.from({ length: 12 }, (_, floor) => ({
  name: '阅读脚本测试角色',
  is_user: false,
  mes: floorText,
  swipe_id: 0,
  swipes: [floorText, '许安备用正文'],
  variables: [{ stat_data: { place: floor ? '基地' : '家' } }, { stat_data: { place: '公园' } }],
}))
const script = {
  type: 'script',
  id: 'library',
  name: '资源库验收脚本',
  enabled: false,
  content: `parent.document.documentElement.dataset.libraryStarts=String(Number(parent.document.documentElement.dataset.libraryStarts||0)+1);`,
}
try {
  await page.addLocatorHandler(
    page.locator('#srl-update-notice').getByRole('button', { name: '稍后', exact: true }),
    (el) => el.tap(),
  )
  await page.goto(environment.baseUrl)
  await importReaderFixtureFiles(page, [
    {
      name: '阅读脚本测试角色.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(card)),
    },
    {
      name: '阅读脚本测试.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n')),
    },
    {
      name: '资源库验收脚本.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(script)),
    },
  ])
  await page.getByText('资源库验收脚本', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.getByRole('button', { name: 'APP 管理', exact: true }).tap()
  const official = page.locator('.official-app-manager li').filter({ hasText: '读了么' })
  await official.getByRole('button', { name: '下载', exact: true }).tap()
  await official.getByText(/已安装/).waitFor()
  await page.getByRole('button', { name: '返回功能桌面', exact: true }).tap()
  const grant = page.getByRole('button', { name: '以后允许此权限', exact: true })
  await page.addLocatorHandler(grant, (el) => el.tap())
  await page.locator('.feature-app--reader').tap()
  const app = page.locator('.chat-reader-app__view')
  await app.locator('[data-role="unbound"]').tap()
  await app.locator('[data-chat]').tap()
  await app
    .locator('#bindSelect')
    .selectOption({ label: await app.locator('#bindSelect option').nth(1).innerText() })
  await app.locator('#bindConfirm').tap()
  await app.locator('#toast').filter({ hasText: '角色绑定已保存到资源库' }).waitFor()
  await page.getByRole('button', { name: '返回角色列表', exact: true }).tap()
  await app.locator('[data-role]').first().tap()
  await app.locator('[data-chat]').tap()
  await app.locator('.mes_text').first().waitFor()
  const display = async () => {
    if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
    await app.locator('[data-panel="display"]').tap()
  }
  const manager = async () => {
    await app.locator('#manageScripts').tap()
    await app.locator('#applyScripts').waitFor()
  }
  const expandGroups = async () => {
    while (await app.locator('.reader-rule-group:not([open]) > summary').count())
      await app.locator('.reader-rule-group:not([open]) > summary').first().tap()
  }
  const closeManager = async () => {
    await app.locator('#sheetClose').tap()
    assert.equal(await app.locator('#sheetTitle').innerText(), '阅读显示')
    await app.locator('#sheetClose').tap()
  }
  const outer = () => app.frameLocator('iframe[data-whole-floor]').first()
  const verifyPhone = async (floor, reply, place) => {
    await outer().locator('#phone-output').waitFor()
    const frame = await (
      await app.locator('iframe[data-whole-floor]').first().elementHandle()
    ).contentFrame()
    await frame.waitForFunction((floor) => window.__SRL_ARCHIVED_READER_FLOOR__ === floor, floor)
    await frame.waitForFunction(
      ({ floor, reply, place }) => {
        const runtime = document.querySelector(
          '#srl-tavern-helper-script-runtimes iframe',
        )?.contentWindow
        return (
          runtime?.getChatMessages(String(floor))[0]?.swipe_id === reply &&
          runtime.getVariables({ type: 'message', message_id: floor }).stat_data?.place === place
        )
      },
      { floor, reply, place },
    )
    const saved = await frame.evaluate((floor) => {
      const runtime = document.querySelector(
        '#srl-tavern-helper-script-runtimes iframe',
      ).contentWindow
      return {
        message: runtime.getChatMessages(String(floor))[0],
        vars: runtime.getVariables({ type: 'message', message_id: floor }),
      }
    }, floor)
    assert.equal(saved.message.swipe_id, reply)
    assert.equal(saved.vars.stat_data.place, place)
    assert.equal(await frame.evaluate(() => document.documentElement.dataset.phoneStarts), '1')
    assert.equal(await frame.evaluate(() => document.documentElement.dataset.libraryStarts), '1')
    return frame
  }
  await display()
  assert.equal(await app.locator('#manageScripts').count(), 1)
  if (environment.engine === 'chromium') {
    const area = await app.locator('#sheet').boundingBox()
    const before = await app.locator('#sheet').evaluate((el) => el.scrollTop)
    const touch = await context.newCDPSession(page)
    const x = area.x + area.width / 2,
      startY = area.y + area.height - 50
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY }],
    })
    for (let step = 1; step <= 8; step++)
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY - (Math.min(350, area.height - 100) * step) / 8 }],
      })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await touch.detach()
    const readerFrame = page
    await readerFrame.waitForFunction(
      (before) =>
        document.querySelector('.chat-reader-app__view').shadowRoot.querySelector('#sheet')
          .scrollTop > before,
      before,
    )
  }
  await app.locator('#regexRules').tap()
  assert.equal(await app.locator('.reader-rule-group').count(), 3)
  assert.equal(await app.locator('.reader-rule-group[open]').count(), 0)
  await app.locator('#sheetClose').tap()
  assert.equal(await app.locator('#sheetTitle').innerText(), '阅读显示')
  await manager()
  await app.locator('[data-script]').waitFor({ state: 'attached' })
  assert.equal(await app.locator('#scriptsEnabled').isChecked(), false)
  assert.equal(await app.locator('[data-script]').isChecked(), false)
  await app.locator('#pickScripts').tap()
  await app.locator('[data-script-pick]').filter({ hasText: '资源库验收脚本' }).tap()
  await app.locator('[data-script]').nth(1).waitFor({ state: 'attached' })
  assert.equal(await app.locator('[data-script]:checked').count(), 0)
  await closeManager()
  await display()
  await app.locator('[data-reading-mode="full"]').tap()
  await app.locator('#enableInteractions').tap()
  await display()
  await manager()
  await app.locator('[data-script]').nth(1).waitFor({ state: 'attached' })
  await app.locator('label[for="scriptsEnabled"]').tap()
  await expandGroups()
  for (const checkbox of await app.locator('[data-script]').all())
    await app.locator(`label[for="${await checkbox.getAttribute('id')}"]`).tap()
  await app.locator('#applyScripts').tap()
  await closeManager()
  await verifyPhone(0, 0, '家')
  await outer().locator('#phone-overlay').waitFor()
  await app.locator('#readerScripts').tap()
  await app.getByRole('button', { name: '手机显隐切换', exact: true }).tap()
  await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
  await app.locator('#readerScripts').tap()
  await app.getByRole('button', { name: '手机显隐切换', exact: true }).tap()
  await outer().locator('#phone-overlay').waitFor({ state: 'visible' })
  await app.locator('#readerScripts').tap()
  await app.getByRole('button', { name: '手机显隐切换', exact: true }).tap()
  await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
  assert.equal(await app.locator('iframe[data-whole-floor]').count(), 1)
  assert.equal(await outer().locator('.TH-render > iframe').count(), panelCount)
  for (let index = 0; index < panelCount; index++)
    await outer()
      .frameLocator(`iframe[id="TH-message--0--${index}"]`)
      .getByText('面板：楼0 回复0 家', { exact: true })
      .waitFor()
  const outerFrame = await (
    await app.locator('iframe[data-whole-floor]').first().elementHandle()
  ).contentFrame()
  const isolation = await outerFrame.evaluate(() => {
    const children = [...document.querySelectorAll('.TH-render > iframe')].map(
      (frame) => frame.contentWindow,
    )
    return {
      vueInstances: new Set(children.map((child) => child.Vue)).size,
      jqueryInstances: new Set(children.map((child) => child.jQuery)).size,
      vendorsFrozen: Object.isFrozen(window.__SRL_PREVIEW_VENDOR_DOCUMENTS__),
    }
  })
  assert.equal(isolation.vueInstances, panelCount)
  assert.equal(isolation.jqueryInstances, panelCount)
  assert.equal(isolation.vendorsFrozen, true)
  assert.match(await outer().locator('.mes_text').innerText(), /许安中段/)
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('2')
  await app.locator('#jump').tap()
  await verifyPhone(1, 0, '基地')
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="1"]').tap()
  await verifyPhone(1, 1, '公园')
  assert.equal(
    await outer().locator('.TH-render > iframe').count(),
    0,
    'script-only alternate reply works',
  )
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="0"]').tap()
  await verifyPhone(1, 0, '基地')
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('1')
  await app.locator('#jump').tap()
  await verifyPhone(0, 0, '家')
  await display()
  await app.locator('#opt-mask').tap()
  await app.getByText('用户名称与打码', { exact: true }).tap()
  await app.locator('#maskWords').fill('许安')
  await app.locator('#saveMask').tap()
  await app.locator('#sheetFeedback').filter({ hasText: '已更新打码文字' }).waitFor()
  await app.locator('#sheetClose').tap()
  await verifyPhone(0, 0, '家')
  await outer().getByText('某某开头', { exact: true }).waitFor()
  assert.doesNotMatch(await outer().locator('.mes_text').innerText(), /许安/)
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ])
    for (const theme of ['paper', 'night']) {
      await page.setViewportSize({ width, height })
      if (await app.locator('#readerMenu').isVisible()) await app.locator('#readerMenu').tap()
      await app.locator('[data-panel="appearance"]').tap()
      assert.equal(await app.locator('#appearanceRules').count(), 0)
      await app.locator(`[data-theme="${theme}"]`).tap()
      await app.locator('#sheetClose').tap()
      await display()
      assert.equal(await app.locator('#manageScripts').count(), 1)
      await app.locator('#regexRules').tap()
      assert.equal(await app.locator('.reader-rule-group[open]').count(), 0)
      await page.screenshot({
        path: resolve(environment.outputDir, `regex-groups-${width}-${theme}.png`),
      })
      await app.locator('#sheetClose').tap()
      assert.equal(await app.locator('#sheetTitle').innerText(), '阅读显示')
      await app.locator('#manageScripts').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: resolve(environment.outputDir, `scripts-collapsed-${width}-${theme}.png`),
      })
      await manager()
      assert.equal(await app.locator('.reader-rule-group[open]').count(), 0)
      await expandGroups()
      assert.equal(
        await app
          .locator('.reader-rule-group > summary')
          .first()
          .evaluate((el) => document.defaultView.getComputedStyle(el).webkitTapHighlightColor),
        'rgba(0, 0, 0, 0)',
      )
      assert.equal(await app.locator('[data-script]:checked').count(), 2)
      assert.equal(await app.locator('#scriptsEnabled').isChecked(), true)
      assert.ok(
        await app.locator('#sheetBody').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        `settings overflow ${width} ${theme}`,
      )
      await app.locator('#applyScripts').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: resolve(environment.outputDir, `scripts-expanded-${width}-${theme}.png`),
      })
      await closeManager()
      await verifyPhone(0, 0, '家')
    }
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('2')
  await app.locator('#jump').tap()
  await verifyPhone(1, 0, '基地')
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="1"]').tap()
  await verifyPhone(1, 1, '公园')
  await page.reload()
  await page.getByRole('button', { name: '功能', exact: true }).tap()
  await page.locator('.feature-app--reader').tap()
  await verifyPhone(1, 1, '公园')
  assert.equal(await app.locator('#library').isVisible(), false)
  await app.locator('#readerMenu').tap()
  const scriptOnlyFrame = await (
    await app.locator('iframe[data-whole-floor]').elementHandle()
  ).contentFrame()
  await app.locator('#readerMore').tap()
  await app.locator('#floorSwipes').tap()
  await app.locator('[data-reply="0"]').tap()
  await verifyPhone(1, 0, '基地')
  assert.equal(
    await (await app.locator('iframe[data-whole-floor]').elementHandle()).contentFrame(),
    scriptOnlyFrame,
    'adding frontends must retain a prose-only script session',
  )
  const persistentFrame = await (
    await app.locator('iframe[data-whole-floor]').elementHandle()
  ).contentFrame()
  await display()
  await app.locator('[data-setting="mode"][data-value="continuous"]').tap()
  await app.locator('#sheetClose').tap()
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('7')
  await app.locator('#jump').tap()
  await verifyPhone(6, 0, '基地')
  assert.equal(
    await (await app.locator('iframe[data-whole-floor]').elementHandle()).contentFrame(),
    persistentFrame,
  )
  await app.locator('#readerScripts').tap()
  await app.getByRole('button', { name: '手机显隐切换', exact: true }).tap()
  await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
  await app.locator('#readerScripts').tap()
  await page.screenshot({ path: resolve(environment.outputDir, 'script-actions-compact-390.png') })
  const controls = await app.locator('.script-action-button').evaluateAll((buttons) =>
    buttons.map((button) => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    })),
  )
  assert.ok(
    controls.every((button) => button.height >= 44 && button.height <= 48 && button.width < 210),
  )
  await app.locator('#sheetClose').tap()
  for (let check = 0; check < 3; check++) {
    await page.waitForTimeout(200)
    assert.equal(
      await app.locator('iframe[data-whole-floor]').getAttribute('data-script-floor'),
      '6',
      'loading must not advance the restored floor',
    )
  }
  if (environment.engine === 'chromium') {
    const touch = await context.newCDPSession(page)
    const viewport = await app.locator('#readingViewport').boundingBox()
    const floors = [],
      movements = []
    const starts = {}
    for (const direction of [-1, -1, -1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1]) {
      const x = viewport.x + viewport.width / 2,
        startY = viewport.y + viewport.height * (direction < 0 ? 0.72 : 0.28)
      const mounted = await persistentFrame.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('div.TH-render>iframe')].map((frame) => [
            frame.name,
            window.__readerPanelStarts?.[frame.name],
          ]),
        ),
      )
      for (const name of Object.keys(starts)) if (!(name in mounted)) delete starts[name]
      for (const [name, count] of Object.entries(mounted)) {
        if (name in starts)
          assert.equal(count, starts[name], 'retained frontend must not reload: ' + name)
        else if (count !== undefined) starts[name] = count
      }
      const stable = await persistentFrame.evaluate(() => ({
        top: document.querySelector('#phone-absolute').getBoundingClientRect().top,
        outer: window.scrollY,
        chatHeight: document.querySelector('#chat').clientHeight,
        viewport: window.innerHeight,
      }))
      assert.equal(stable.outer, 0, 'author body UI must stay in the viewport')
      assert.equal(
        stable.chatHeight,
        stable.viewport,
        'chat height must represent the visible viewport',
      )
      const before = await persistentFrame.evaluate(() => document.querySelector('#chat').scrollTop)
      await persistentFrame.evaluate(() => {
        const anchor = [...document.querySelectorAll('#chat>[data-floor]')].find(
          (section) => section.getBoundingClientRect().bottom > 5,
        )
        const evidence = { active: true, tops: [] }
        window.__readerGestureEvidence = evidence
        const sample = () => {
          if (!evidence.active || !anchor?.isConnected) return
          evidence.tops.push(anchor.getBoundingClientRect().top)
          requestAnimationFrame(sample)
        }
        sample()
      })
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y: startY }],
      })
      for (let step = 1; step <= 12; step++) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: startY + (direction * 220 * step) / 12 }],
        })
        await page.waitForTimeout(20)
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(350)
      const evidence = await persistentFrame.evaluate(() => {
        window.__readerGestureEvidence.active = false
        return {
          absoluteTop: document.querySelector('#phone-absolute').getBoundingClientRect().top,
          outerTop: window.scrollY,
          tops: window.__readerGestureEvidence.tops,
          after: document.querySelector('#chat').scrollTop,
          panels: Object.fromEntries(
            [...document.querySelectorAll('div.TH-render>iframe')].map((frame) => [
              frame.name,
              window.__readerPanelStarts?.[frame.name],
            ]),
          ),
          floor: window.__SRL_ARCHIVED_READER_FLOOR__,
        }
      })
      assert.equal(
        evidence.absoluteTop,
        stable.top,
        'absolute author UI must not move with the chat',
      )
      assert.equal(evidence.outerTop, 0, 'chat touch must not scroll the author UI document')
      const reverse = Math.max(
        0,
        ...evidence.tops
          .slice(1)
          .map((top, index) =>
            direction < 0 ? top - evidence.tops[index] : evidence.tops[index] - top,
          ),
      )
      assert.ok(reverse <= 3, 'visible content must not jerk against the swipe: ' + reverse)
      const floor = evidence.floor
      floors.push(floor)
      movements.push({ direction, before, after: evidence.after, floor, reverse })
      const previous = floors.at(-2) ?? 6
      assert.ok(Math.abs(floor - previous) <= 1, 'one short swipe must not jump several floors')
      assert.ok(
        direction < 0 ? floor >= previous : floor <= previous,
        'floor movement must follow the swipe',
      )
      await verifyPhone(floor, 0, '基地')
      assert.equal(
        await (await app.locator('iframe[data-whole-floor]').elementHandle()).contentFrame(),
        persistentFrame,
      )
      for (const [name, count] of Object.entries(starts))
        if (name in evidence.panels)
          assert.equal(evidence.panels[name], count, 'retained frontend must not reload: ' + name)
      await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
    }
    await touch.detach()
    console.log('Touch scroll evidence: ' + JSON.stringify(movements))
    assert.ok(Math.max(...floors) >= 7, 'touch scrolling must reach another saved floor')
    assert.ok(floors.at(-1) <= 6, 'backwards scrolling must return to the starting floor')
    console.log(
      'PASS native scrolling with retained frontend documents, one script window and per-floor saved variables',
    )
  }
  await app.locator('[data-panel="progress"]').tap()
  await app.locator('#floorNumber').fill('2')
  await app.locator('#jump').tap()
  await verifyPhone(1, 0, '基地')
  if (process.env.SRL_READER_PHONE_SOURCE) {
    const actualSource = await readFile(process.env.SRL_READER_PHONE_SOURCE, 'utf8')
    const actualUrl =
      'https://cdn.jsdelivr.net/gh/baibai-git/baibai_phone/index.js?srl-audit=reader-phone'
    await page.route(actualUrl, (route) =>
      route.fulfill({
        body: actualSource,
        contentType: 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
      }),
    )
    await importReaderFixtureFiles(page, {
      name: '真实柏柏脚本.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          type: 'script',
          id: 'baibai-acceptance',
          name: '真实柏柏',
          content: `await import(${JSON.stringify(actualUrl)})`,
        }),
      ),
    })
    await display()
    if (!(await app.locator('#opt-remote').isChecked()))
      await app.locator('label[for="opt-remote"]').tap()
    await manager()
    await app.locator('#pickScripts').tap()
    await app.locator('[data-script-pick]').filter({ hasText: '真实柏柏' }).tap()
    const actualRow = app.locator('.setting-row').filter({ hasText: '真实柏柏' })
    await actualRow.locator('label').waitFor({ state: 'attached' })
    await expandGroups()
    const actualScriptId = await actualRow.locator('input').getAttribute('data-script')
    await actualRow.locator('label').tap()
    await app.locator('#applyScripts').tap()
    await closeManager()
    const actual = outer().locator('#baibai_phone')
    await actual.waitFor({ state: 'visible' })
    await app.locator('#readerScripts').tap()
    await app
      .locator(`[data-script-action="手机显隐切换"]:not([data-script-id="${actualScriptId}"])`)
      .tap()
    await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
    await page.screenshot({ path: resolve(environment.outputDir, 'baibai-visible.png') })
    await app.locator('#readerScripts').tap()
    await app
      .locator(`[data-script-action="手机显隐切换"][data-script-id="${actualScriptId}"]`)
      .tap()
    await actual.waitFor({ state: 'hidden' })
    await outer().locator('#phone-overlay').waitFor({ state: 'hidden' })
    const actualNode = await actual.elementHandle()
    const actualFrame = await (
      await app.locator('iframe[data-whole-floor]').elementHandle()
    ).contentFrame()
    await app.locator('[data-panel="progress"]').tap()
    await app.locator('#floorNumber').fill('3')
    await app.locator('#jump').tap()
    await verifyPhone(2, 0, '基地')
    await actual.waitFor({ state: 'hidden' })
    assert.equal(
      await actualNode.evaluate((node) => node.isConnected),
      true,
      'the original phone DOM must survive a floor change',
    )
    assert.equal(
      await (await app.locator('iframe[data-whole-floor]').elementHandle()).contentFrame(),
      actualFrame,
    )
    await app.locator('#readerScripts').tap()
    await app
      .locator(`[data-script-action="手机显隐切换"][data-script-id="${actualScriptId}"]`)
      .tap()
    await actual.waitFor({ state: 'visible' })
    await app.locator('#readerScripts').tap()
    await app.getByRole('button', { name: '停止脚本，返回正文', exact: true }).tap()
    await app.locator('iframe[data-whole-floor]').waitFor({ state: 'detached' })
    console.log(
      'PASS original baibai program with fixture card: boot, host controls, hide/show, stop; source bytes unchanged',
    )
  }
  await display()
  await manager()
  await app.locator('#disableScripts').tap()
  await app.locator('#scriptsEnabled:not(:checked)').waitFor()
  await closeManager()
  await app.locator('iframe[data-whole-floor]').waitFor({ state: 'detached' })
  await display()
  await manager()
  assert.equal(await app.locator('#scriptsEnabled').isChecked(), false)
  assert.equal(await app.locator('[data-script]:checked').count(), 0)
  assert.deepEqual(errors, [])
  console.log(
    'PASS real SDK script selection / opt-in / one companion across eight panels / shared static vendors and distinct child instances / per-floor variables / masking / off / manager return navigation / cold host restoration / four mobile widths and two themes',
  )
} catch (error) {
  console.log(JSON.stringify({ errors, runtimeErrors }))
  await page.screenshot({ path: resolve(environment.outputDir, 'failure.png') })
  throw error
} finally {
  await context.close()
  await browser.close()
}
