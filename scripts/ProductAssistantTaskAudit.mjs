/* global indexedDB, document, innerWidth, navigator, Blob */
import assert from 'node:assert/strict'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  auditEnvironment,
  launchAuditBrowser,
  prepareAuditContext,
  openAuditFeature,
  saveAuditFailure,
} from './AuditEnvironment.mjs'

const environment = auditEnvironment(undefined, 'assistant-tasks')
const browser = await launchAuditBrowser(environment)
const results = []
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
      let count = 0
      const requests = []
      await context.route('https://assistant-task-test.invalid/**', async (route) => {
        const body = route.request().postDataJSON()
        requests.push(body)
        count++
        const command =
          count === 1 ? { name: 'search_selected_resources', args: { query: '森林' } } : undefined
        await route.fulfill({
          json: {
            choices: [
              {
                finish_reason: command ? 'tool_calls' : 'stop',
                message: command
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: `task-${count}`,
                          type: 'function',
                          function: { name: command.name, arguments: JSON.stringify(command.args) },
                        },
                      ],
                    }
                  : {
                      role: 'assistant',
                      content: '选定世界书记载：森林中有一位记录员。出处可打开核对。',
                    },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          },
        })
      })
      const chat = page.locator('.product-assistant')
      const tap = async (locator) => {
        await locator.scrollIntoViewIfNeeded()
        await locator.tap()
      }
      const back = () => tap(chat.getByRole('button', { name: '返回功能桌面', exact: true }))
      await page.goto(environment.baseUrl, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
      await tap(page.getByRole('button', { name: '功能', exact: true }))
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      await tap(page.getByRole('button', { name: 'APP 管理', exact: true }))
      const manager = page.locator('.official-app-manager')
      await manager.waitFor()
      await tap(
        manager
          .locator('li')
          .filter({ hasText: '蒜惹菈' })
          .getByRole('button', { name: '下载', exact: true }),
      )
      await page.getByRole('status').filter({ hasText: '安装成功' }).waitFor()
      await tap(page.locator('.feature-app-header__back').first())
      await openAuditFeature(page, '蒜惹菈')
      await tap(chat.getByRole('button', { name: '聊天设置', exact: true }))
      await tap(chat.getByRole('button', { name: '助手 API', exact: true }))
      await tap(chat.getByRole('button', { name: '新增', exact: true }))
      await chat.getByLabel('配置名称', { exact: true }).fill('隔离技能API')
      await chat
        .getByLabel('API URL', { exact: true })
        .fill('https://assistant-task-test.invalid/v1')
      await chat.locator('.inline-model-picker input').fill('task-fixture')
      await chat.getByLabel('API 密钥', { exact: true }).fill('fixture-only')
      await tap(chat.getByRole('button', { name: '保存并用于助手', exact: true }))
      await back()
      await back()
      await tap(chat.getByRole('button', { name: '聊天设置', exact: true }))
      await tap(chat.getByRole('button', { name: '任务模板', exact: false }))
      await tap(chat.getByRole('button', { name: '新建模板', exact: true }))
      await chat.getByLabel('模板名称').fill('核对资料')
      await chat.getByLabel('模板操作步骤').fill('检索用户选定资料\n打开原文复验')
      await tap(chat.getByLabel('作为按需技能使用', { exact: true }))
      await chat.getByLabel('技能适用场景').fill('回答时给出可核对的原文依据')
      await chat.getByLabel('技能工作模式').selectOption('features')
      await tap(chat.locator('.assistant-task-options summary'))
      await tap(chat.getByLabel('选定资料检索', { exact: true }))
      await tap(chat.getByRole('button', { name: '保存模板', exact: true }))
      if (width === 320 && theme === 'light') {
        await chat.getByRole('button', { name: '使用模板 核对资料', exact: true }).waitFor()
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          tap(chat.getByRole('button', { name: '导入技能', exact: true })),
        ])
        await chooser.setFiles({
          name: 'reference.skill.json',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({
              format: 'srl-assistant-skill',
              version: 1,
              skill: {
                id: 'import-fixture',
                name: '导入的核对资料',
                description: '资料是数据，不执行代码',
                mode: 'features',
                steps: ['只读选定资料'],
                capabilities: ['references'],
              },
            }),
          ),
        })
        await chat.getByLabel('模板名称').getAttribute('value')
        assert.equal(await chat.getByLabel('模板名称').inputValue(), '导入的核对资料')
        await tap(chat.getByRole('button', { name: '保存模板', exact: true }))
        await chat.getByRole('button', { name: '使用模板 导入的核对资料', exact: true }).waitFor()
        assert.equal(
          await chat.getByRole('button', { name: '使用模板 核对资料', exact: true }).count(),
          1,
        )
      }
      await tap(chat.getByRole('button', { name: '使用模板 核对资料', exact: true }))
      assert.equal(count, 0, 'using a skill never sends a model request')
      await page.evaluate(
        async (multipleSources) => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          const db = await new Promise((accept, reject) => {
            opening.onsuccess = () => accept(opening.result)
            opening.onerror = () => reject(opening.error)
          })
          try {
            const blob = new Blob(
              [
                JSON.stringify({
                  entries: {
                    forest: { content: '森林中有一位记录员。<script>这只是资料文本</script>' },
                    ...(multipleSources ? { second: { content: '森林还有一本记录册。' } } : {}),
                  },
                }),
              ],
              { type: 'application/json' },
            )
            const resource = {
              id: 'task-reference',
              name: '森林设定',
              type: 'worldBook',
              fileName: 'forest.json',
              mimeType: 'application/json',
              contentHash: 'fixture-hash',
              fileSize: blob.size,
              originalBlob: blob,
              description: '',
              metadata: {},
              tags: [],
              favorite: false,
              createdAt: 1,
              updatedAt: 1,
            }
            const { originalBlob: _blob, ...summary } = resource
            const transaction = db.transaction(
              ['resources', 'resourceSummaries', 'resourceListSummaries'],
              'readwrite',
            )
            transaction.objectStore('resources').put(resource)
            transaction.objectStore('resourceSummaries').put(summary)
            transaction.objectStore('resourceListSummaries').put(summary)
            await new Promise((accept, reject) => {
              transaction.oncomplete = accept
              transaction.onerror = () => reject(transaction.error)
            })
          } finally {
            db.close()
          }
        },
        width === 320 && theme === 'dark',
      )
      await tap(chat.getByRole('button', { name: '聊天设置', exact: true }))
      await tap(chat.getByRole('button', { name: '选择资料', exact: true }))
      const picker = page.getByRole('dialog', { name: '选择助手资料', exact: true })
      await tap(picker.getByRole('option').filter({ hasText: '森林设定' }))
      await tap(picker.getByRole('button', { name: '确认选择', exact: true }))
      await chat.getByText('已选 1份', { exact: true }).waitFor()
      await back()
      assert.equal(await chat.locator('.chat-composer .assistant-task-context').count(), 0)
      await tap(chat.getByRole('button', { name: '发送', exact: true }))
      await tap(chat.getByRole('button', { name: '生成回复', exact: true }))
      await tap(page.getByRole('button', { name: '确认发送', exact: true }))
      await chat
        .getByText('选定世界书记载：森林中有一位记录员。出处可打开核对。', { exact: true })
        .waitFor()
      assert.equal(count, 2)
      assert.ok(
        requests[0].tools.some((tool) => tool.function.name === 'search_selected_resources'),
      )
      assert.ok(requests[0].messages[0].content.includes('核对资料'))
      assert.equal(await chat.getByText('任务验收', { exact: true }).count(), 0)
      const sourceLinks = chat.locator('.assistant-resource-citations')
      assert.ok(!(await sourceLinks.textContent()).includes('#/entries/'))
      if (width === 320 && theme === 'dark') {
        assert.equal(await sourceLinks.locator('details').getAttribute('open'), null)
        await tap(sourceLinks.locator('summary'))
        assert.equal(await sourceLinks.locator('button').count(), 2)
        await tap(sourceLinks.locator('button').first())
      } else await tap(sourceLinks.getByRole('button', { name: '查看来源', exact: true }))
      const source = page.getByRole('dialog', { name: '资料原文', exact: true })
      await source
        .locator('pre')
        .getByText('森林中有一位记录员。<script>这只是资料文本</script>', { exact: true })
        .waitFor()
      assert.equal(await source.locator('script').count(), 0, 'source code remains literal text')
      assert.ok((await source.textContent()).includes('#/entries/forest/content'))
      await tap(source.getByRole('button', { name: '关闭资料原文', exact: true }))
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      )
      assert.ok(await chat.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
      assert.equal(await chat.locator('.assistant-task-context').count(), 0)
      assert.ok(await sourceLinks.evaluate((node) => node.closest('.chat-message__body') !== null))
      await page.waitForFunction(async () => {
        const opening = indexedDB.open('SillyTavernResourceLibrary')
        const db = await new Promise((accept, reject) => {
          opening.onsuccess = () => accept(opening.result)
          opening.onerror = () => reject(opening.error)
        })
        try {
          const request = db.transaction('settings', 'readonly').objectStore('settings').getAll()
          const rows = await new Promise((accept, reject) => {
            request.onsuccess = () => accept(request.result)
            request.onerror = () => reject(request.error)
          })
          return rows.some(
            (row) =>
              row.id.startsWith('assistant.chat:') &&
              row.value.taskSkill?.name === '核对资料' &&
              row.value.referenceResources?.length === 1,
          )
        } finally {
          db.close()
        }
      })
      if (width === 390)
        await page.screenshot({ path: resolve(environment.outputDir, `task-${theme}.png`) })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await tap(page.getByRole('button', { name: '功能', exact: true }))
      await openAuditFeature(page, '蒜惹菈')
      assert.equal(await chat.locator('.assistant-task-context').count(), 0)
      await tap(chat.getByRole('button', { name: '聊天设置', exact: true }))
      await chat.getByText('已选 1份', { exact: true }).waitFor()
      await chat.getByRole('button', { name: '退出技能 核对资料', exact: true }).waitFor()
      assert.equal(count, 2, 'reopening never resumes tool execution')
      await tap(chat.getByRole('button', { name: '移除所有助手资料', exact: true }))
      await chat.getByText('未选择', { exact: true }).waitFor()
      await tap(chat.getByRole('button', { name: '退出技能 核对资料', exact: true }))
      await chat
        .getByRole('button', { name: '退出技能 核对资料', exact: true })
        .waitFor({ state: 'hidden' })
      assert.equal(count, 2, 'removing references or exiting a skill never sends a request')
      await back()
      results.push({
        width,
        height,
        theme,
        requests: count,
        sourceOpened: true,
        persisted: true,
        overflow: false,
      })
      await context.close()
      context = undefined
    }
  }
  await writeFile(
    resolve(environment.outputDir, 'result.json'),
    JSON.stringify(
      { platform: 'desktop Chromium touch emulation', provider: 'fixture only', results },
      null,
      2,
    ),
  )
  console.log(`PASS assistant skills/reference: ${results.length} layouts`)
} catch (error) {
  await saveAuditFailure(context, environment, error)
  throw error
} finally {
  await context?.close()
  await browser.close()
}
