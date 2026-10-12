/* global document, innerWidth, navigator, getComputedStyle */
import assert from 'node:assert/strict'
import console from 'node:console'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'api-config')
const browser = await launchAuditBrowser(environment)
let context
await mkdir(environment.outputDir, { recursive: true })
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
  ]) {
    for (const theme of ['light', 'dark']) {
      context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        serviceWorkers: 'allow',
      })
      await prepareAuditContext(context, environment, { trace: false })
      const page = await context.newPage()
      const tap = (locator) => locator.tap()
      const screenshot = async (name, panel) => {
        await panel.scrollIntoViewIfNeeded()
        await page.locator('#srl-offline-ready').waitFor({ state: 'hidden' })
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${name} page overflow`,
        )
        const geometry = await panel.evaluate((node) => {
          const right = node.getBoundingClientRect().right
          return {
            client: node.clientWidth,
            scroll: node.scrollWidth,
            overflow: [...node.querySelectorAll('*')]
              .filter((child) => child.getBoundingClientRect().right > right + 1)
              .map((child) => ({
                tag: child.tagName,
                type: child.getAttribute('type'),
                class: child.className,
                right: child.getBoundingClientRect().right - right,
                margin: getComputedStyle(child).margin,
              })),
          }
        })
        assert.ok(
          geometry.scroll <= geometry.client + 1,
          `${name} panel overflow: ${JSON.stringify(geometry)}`,
        )
        await page.screenshot({
          path: resolve(environment.outputDir, `${name}-${width}-${theme}.png`),
        })
      }
      const inspectApi = async (panel, assistant) => {
        const advanced = panel.locator('.main-api-settings__advanced')
        assert.equal(await advanced.getAttribute('open'), null)
        const compact = (await panel.boundingBox()).height
        const name = await panel.getByLabel('配置名称', { exact: true }).boundingBox()
        const protocol = await panel.getByLabel('接口协议', { exact: true }).boundingBox()
        assert.ok(Math.abs(name.y - protocol.y) < 2, 'name and protocol share one row')
        await screenshot(assistant ? 'assistant-api' : 'main-api', panel)
        await tap(advanced.locator(':scope > summary'))
        assert.ok((await panel.boundingBox()).height > compact + 200)
        const help = advanced.locator('.main-api-settings__help')
        assert.equal(await help.getAttribute('open'), null, 'API explanation starts folded')
        await tap(help.locator('summary'))
        assert.ok(await help.locator('p').isVisible())
        await tap(help.locator('summary'))
        const outputLimit = advanced.getByPlaceholder('留空不限制', { exact: true })
        assert.equal(await outputLimit.inputValue(), '', 'new profiles have no output cap')
        assert.equal(await outputLimit.getAttribute('max'), null, 'no arbitrary output ceiling')
        await outputLimit.fill('1000000')
        const saveOutput = async () => {
          await tap(
            panel.getByRole('button', {
              name: assistant ? '保存并用于助手' : '保存配置',
              exact: true,
            }),
          )
          await panel.getByRole('status').filter({ hasText: '已保存' }).waitFor()
        }
        await saveOutput()
        assert.equal(
          await outputLimit.inputValue(),
          '1000000',
          'million output cap retained on save',
        )
        await outputLimit.fill('')
        await saveOutput()
        assert.equal(
          await outputLimit.inputValue(),
          '',
          'cleared output cap remains blank after refresh',
        )
        await screenshot(
          assistant ? 'assistant-api-output-blank' : 'main-api-output-blank',
          advanced,
        )
        await advanced.locator('.main-api-settings__credential-mode select').selectOption('session')
        await advanced.getByPlaceholder('留空不限制', { exact: true }).first().fill('2048')
        await tap(advanced.locator(':scope > summary'))
        assert.ok((await advanced.locator(':scope > summary').innerText()).includes('仅本次使用'))
        await tap(panel.locator('.main-api-settings__profiletools summary'))
        assert.ok(await panel.getByRole('button', { name: '复制', exact: true }).isVisible())
        await tap(panel.locator('.main-api-settings__profiletools summary'))
        await tap(
          panel.getByRole('button', {
            name: assistant ? '保存并用于助手' : '保存配置',
            exact: true,
          }),
        )
        await panel.getByRole('status').filter({ hasText: '已保存' }).waitFor()
        // Real touch moves off the save button's global :active scale before measuring idle targets.
        await tap(panel.getByLabel('API URL', { exact: true }))
        const sizes = await panel
          .locator(
            '.main-api-settings__basic input,.main-api-settings__basic select,.main-api-settings__actions button',
          )
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              label: node.getAttribute('aria-label') || node.textContent || node.tagName,
              height: node.getBoundingClientRect().height,
              minimum: getComputedStyle(node).minHeight,
            })),
          )
        assert.ok(
          sizes.every((size) => size.height >= 44),
          `44px touch targets: ${JSON.stringify(sizes)}`,
        )
        const fieldFonts = await panel
          .locator('.main-api-settings__basic input,.main-api-settings__basic select')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              label:
                node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.tagName,
              font: getComputedStyle(node).fontSize,
            })),
          )
        assert.ok(
          fieldFonts.every((field) => field.font === '14px'),
          `consistent 14px field text: ${JSON.stringify(fieldFonts)}`,
        )
        const fieldFaces = await panel
          .locator('.main-api-settings__control')
          .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node, '::before').height))
        assert.ok(
          fieldFaces.every((height) => height === '36px'),
          '36px field surfaces',
        )
        const faces = await panel
          .locator('.main-api-settings__actions .main-api-settings__button-face')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
        assert.ok(
          faces.length > 0 && faces.every((size) => size >= 34 && size <= 36),
          'readable compact button faces',
        )
        const actionRow = await panel.locator('.main-api-settings__actions').evaluate((node) => {
          const [save, test] = node.querySelectorAll(':scope > button')
          const container = node.getBoundingClientRect()
          const first = save.getBoundingClientRect()
          const second = test.getBoundingClientRect()
          return {
            aligned: Math.abs(first.y - second.y) < 1,
            equal: Math.abs(first.width - second.width) < 1,
            full:
              Math.abs(first.left - container.left) < 1 &&
              Math.abs(second.right - container.right) < 1,
            faces: [save, test].every(
              (button) =>
                Math.abs(
                  button.querySelector('.main-api-settings__button-face').getBoundingClientRect()
                    .width - button.getBoundingClientRect().width,
                ) < 1,
            ),
          }
        })
        assert.ok(
          Object.values(actionRow).every(Boolean),
          'API action buttons equally fill one row',
        )
      }
      await page.goto(environment.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: '设置', exact: true }).waitFor()
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      await tap(page.getByRole('button', { name: '设置', exact: true }))
      const main = page.locator('.layout-settings-page .main-api-settings')
      await main.waitFor()
      await main.getByLabel('API URL', { exact: true }).fill('https://example.invalid/v1')
      await main.locator('.inline-model-picker input').fill('fixture-model')
      await inspectApi(main, false)
      const mainId = await main.getByLabel('API 配置', { exact: true }).inputValue()
      await tap(main.getByRole('button', { name: '新增', exact: true }))
      await main.getByLabel('配置名称', { exact: true }).fill('配置二')
      await main.getByLabel('API URL', { exact: true }).fill('https://example.invalid/v1')
      await main.locator('.inline-model-picker input').fill('fixture-second')
      await tap(main.getByRole('button', { name: '设为主 API', exact: true }))
      await main.getByRole('status').filter({ hasText: '已设为主 API' }).waitFor()
      await main.getByLabel('API 配置', { exact: true }).selectOption(mainId)
      await tap(main.locator('.main-api-settings__advanced > summary'))
      assert.equal(await main.getByPlaceholder('留空不限制', { exact: true }).inputValue(), '2048')
      assert.equal(
        await main.locator('.main-api-settings__credential-mode select').inputValue(),
        'session',
      )
      await tap(page.getByRole('button', { name: '关闭设置', exact: true }))
      await tap(page.getByRole('button', { name: '多选', exact: true }))
      await tap(page.getByRole('button', { name: 'AI 识别标签', exact: true }))
      const tagging = page.locator('.ai-tagging__api-config')
      await tagging.getByLabel('API 配置', { exact: true }).selectOption('temporary')
      await tap(tagging.locator('.ai-tagging__details-toggle'))
      await tagging.getByLabel('API 地址', { exact: true }).fill('https://example.invalid/v1')
      await screenshot('tagging-api', tagging)
      await tap(page.getByRole('button', { name: '关闭 AI 标签实验台', exact: true }))
      await page.getByRole('alertdialog').waitFor()
      await tap(page.getByRole('button', { name: '保存并退出', exact: true }))
      await page.locator('.ai-tagging').waitFor({ state: 'hidden' })
      await tap(page.getByRole('button', { name: '功能', exact: true }))
      await openAuditFeature(page, '蒜惹菈')
      const assistant = page.locator('.product-assistant')
      await tap(assistant.getByRole('button', { name: '聊天设置', exact: true }))
      const network = assistant.getByRole('switch', { name: '联网工具', exact: true })
      const settingsStatus = assistant.locator('.chat-settings-save [role="status"]')
      assert.equal(await network.isChecked(), false)
      await tap(network)
      await tap(assistant.getByRole('switch', { name: '模型原生搜索', exact: true }))
      await tap(assistant.getByRole('button', { name: '保存设置', exact: true }))
      await settingsStatus.filter({ hasText: /^已保存$/u }).waitFor()
      await tap(network)
      await settingsStatus.filter({ hasText: /^有修改，待保存$/u }).waitFor()
      await screenshot('assistant-settings-pending', assistant.locator('.chat-settings-save'))
      assert.equal(
        await assistant.getByRole('switch', { name: '模型原生搜索', exact: true }).count(),
        0,
      )
      await tap(assistant.getByRole('button', { name: '保存设置', exact: true }))
      await settingsStatus.filter({ hasText: /^已保存$/u }).waitFor()
      await tap(network)
      await tap(assistant.getByRole('button', { name: '返回功能桌面', exact: true }))
      const unsaved = page.getByRole('alertdialog', { name: '有修改未保存', exact: true })
      await unsaved.waitFor()
      await screenshot('assistant-unsaved-exit', unsaved)
      assert.ok(
        (
          await unsaved
            .locator('button')
            .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
        ).every((height) => height >= 44),
        'unsaved choices have 44px touch targets',
      )
      await tap(unsaved.getByRole('button', { name: '继续编辑', exact: true }))
      assert.equal(await network.isChecked(), true)
      await tap(assistant.getByRole('button', { name: '返回功能桌面', exact: true }))
      await tap(unsaved.getByRole('button', { name: '不保存退出', exact: true }))
      await assistant.getByRole('button', { name: '聊天设置', exact: true }).waitFor()
      await tap(assistant.getByRole('button', { name: '聊天设置', exact: true }))
      assert.equal(await network.isChecked(), false, 'discard keeps the stored switch off')
      await tap(network)
      await network.press('Escape')
      await unsaved.waitFor()
      await page.keyboard.press('Escape')
      await unsaved.waitFor({ state: 'hidden' })
      assert.equal(await network.isChecked(), true, 'Escape cancels the choice without exiting')
      await tap(assistant.getByRole('button', { name: '返回功能桌面', exact: true }))
      await tap(unsaved.getByRole('button', { name: '保存并退出', exact: true }))
      await assistant.getByRole('button', { name: '聊天设置', exact: true }).waitFor()
      await tap(assistant.getByRole('button', { name: '聊天设置', exact: true }))
      assert.equal(await network.isChecked(), true, 'save and exit persists through reopening')
      await tap(network)
      await tap(assistant.getByRole('button', { name: '保存设置', exact: true }))
      await settingsStatus.filter({ hasText: /^已保存$/u }).waitFor()
      await tap(assistant.getByRole('button', { name: '助手 API', exact: true }))
      await tap(assistant.getByRole('button', { name: '新增', exact: true }))
      await assistant.getByLabel('API URL', { exact: true }).fill('https://example.invalid/v1')
      await assistant.locator('.inline-model-picker input').fill('fixture-assistant')
      await inspectApi(assistant.locator('.main-api-settings'), true)
      for (let index = 0; index < 3; index++)
        await tap(assistant.getByRole('button', { name: '返回功能桌面', exact: true }))
      await tap(page.getByRole('button', { name: 'APP 管理', exact: true }))
      const manager = page.locator('.official-app-manager')
      await manager.waitFor()
      await tap(
        manager
          .locator('li')
          .filter({ hasText: 'AI 生图' })
          .getByRole('button', { name: '下载', exact: true }),
      )
      await manager.getByRole('status').filter({ hasText: '安装成功' }).waitFor()
      await tap(page.locator('.feature-app-header__back'))
      await page.evaluate(() => navigator.serviceWorker.ready)
      if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
        await tap(page.getByRole('button', { name: '功能', exact: true }))
      }
      await openAuditFeature(page, 'AI 生图')
      await page.locator('.image-generation-app').waitFor()
      const image = page.locator('.image-generation-app')
      for (const provider of ['NovelAI', 'OpenAI']) {
        await tap(image.getByRole('button', { name: provider, exact: true }))
        await tap(image.getByRole('button', { name: '模型 / 连接', exact: true }))
        const connection = image.locator('.image-generation-connection')
        assert.equal(
          await connection.locator('.image-generation-connection__advanced').getAttribute('open'),
          null,
        )
        await connection.getByLabel('API 地址', { exact: true }).fill('https://example.invalid/v1')
        await connection.getByLabel('模型 ID', { exact: true }).fill('fixture-image')
        await connection.getByLabel('API 密钥', { exact: true }).fill('api-config-fixture-key')
        await screenshot(`image-${provider.toLowerCase()}-api`, connection)
        await tap(connection.locator('summary'))
        await connection.getByLabel('密钥保存方式', { exact: true }).selectOption('session')
        await tap(connection.getByRole('button', { name: '恢复默认地址', exact: true }))
        assert.ok(
          !(await connection.getByLabel('API 地址', { exact: true }).inputValue()).includes(
            'example.invalid',
          ),
        )
        await tap(connection.locator('summary'))
        await tap(connection.getByRole('button', { name: '保存连接', exact: true }))
        await image.getByRole('status').filter({ hasText: /保存/ }).waitFor()
      }
      console.log(
        `PASS ${environment.engine} ${width} ${theme}: main/assistant/tagging/image APIs; collapse, profile activation, retained parameters, save and reset`,
      )
      await context.close()
      context = undefined
    }
  }
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await context?.close()
  await browser.close()
}
