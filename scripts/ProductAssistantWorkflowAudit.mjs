/* global document, window, innerWidth, indexedDB, getComputedStyle */
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
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
const environment = auditEnvironment(undefined, 'assistant-workflows')
const historyRecoveryOnly = process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'history-recovery'
const githubPublicLive = process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'github-public-live'
const githubReadOnly = process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'github-read'
const currentViewOnly = process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'current-view'
const promptOnly = process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'prompt-reasoning'
const reasoningOnly = promptOnly || process.env.SRL_ASSISTANT_AUDIT_SCOPE === 'reasoning'
const reasoningFixture =
  '  先核对用户的问题。\n<script>不会执行的文本</script>\n' +
  '这是模型返回的思考内容。'.repeat(300) +
  '  '
const browser = await launchAuditBrowser(environment)
let context
await mkdir(environment.outputDir, { recursive: true })
try {
  for (const [width, height] of githubPublicLive
    ? [[390, 844]]
    : [
        [320, 800],
        [375, 812],
        [390, 844],
        [430, 932],
      ]) {
    for (const theme of githubPublicLive ? ['light'] : ['light', 'dark']) {
      context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        serviceWorkers: historyRecoveryOnly ? 'allow' : 'block',
      })
      await prepareAuditContext(context, environment, { trace: false })
      const page = await context.newPage()
      let requests = 0
      const requestBodies = []
      let commands = [
        {
          name: 'create_app',
          args: {
            name: '接续日记',
            description: '跨聊天继续制作',
            permissions: '[]',
            files: JSON.stringify({
              'index.html': '<!doctype html><html><body>第一版日记</body></html>',
            }),
          },
        },
      ]
      await context.route(
        currentViewOnly
          ? 'https://api.deepseek.com/**'
          : 'https://assistant-workflow-test.invalid/**',
        async (route) => {
          requests++
          const requestBody = route.request().postDataJSON()
          requestBodies.push(requestBody)
          if (currentViewOnly)
            assert.ok(
              requestBody.messages
                .filter((item) => item.role === 'assistant')
                .every((item) => typeof item.reasoning_content === 'string'),
              'DeepSeek thinking field included on every assistant message',
            )
          const command = commands.shift()
          const message = command
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `workflow-${requests}`,
                    type: 'function',
                    function: { name: command.name, arguments: JSON.stringify(command.args) },
                  },
                ],
              }
            : { role: 'assistant', content: '已按工具回执处理。' }
          if (currentViewOnly)
            message.reasoning_content = requests % 2 ? '  fixture thinking\n' : ''
          if (reasoningOnly) message.reasoning_content = requests % 2 ? reasoningFixture : ''
          await route.fulfill({
            json: {
              id: `reply-${requests}`,
              choices: [{ message, finish_reason: command ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 10 },
            },
          })
        },
      )
      const chat = page.locator('.product-assistant')
      const tap = async (locator) => {
        await locator.scrollIntoViewIfNeeded()
        await locator.tap()
      }
      const back = () => tap(chat.getByRole('button', { name: '返回功能桌面', exact: true }))
      const settings = () => tap(chat.getByRole('button', { name: '聊天设置', exact: true }))
      const screenshot = async (name) => {
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          'page overflow',
        )
        assert.ok(
          await chat.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          'chat overflow',
        )
        const sizes = await chat
          .locator(
            '.chat-workflow button:visible,.chat-template-editor input:visible,.chat-template-editor textarea:visible',
          )
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
        assert.ok(
          sizes.every((size) => size >= 44),
          '44px touch targets',
        )
        await page.screenshot({
          path: resolve(environment.outputDir, `${name}-${width}-${theme}.png`),
        })
      }
      const records = async () =>
        page.evaluate(async () => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          const db = await new Promise((accept, reject) => {
            opening.onsuccess = () => accept(opening.result)
            opening.onerror = () => reject(opening.error)
          })
          try {
            const transaction = db.transaction('settings', 'readonly')
            const request = transaction.objectStore('settings').getAll()
            const rows = await new Promise((accept, reject) => {
              request.onsuccess = () => accept(request.result)
              request.onerror = () => reject(request.error)
            })
            return rows.filter((row) => row.id.startsWith('assistant.'))
          } finally {
            db.close()
          }
        })
      const generate = async (text) => {
        await chat.getByLabel('发送消息', { exact: true }).fill(text)
        await tap(chat.getByRole('button', { name: '发送', exact: true }))
        await tap(chat.getByRole('button', { name: '生成回复', exact: true }))
        const confirm = page.getByRole('button', { name: '确认发送', exact: true })
        if (await confirm.isVisible()) await tap(confirm)
        await chat.getByRole('button', { name: '生成回复', exact: true }).waitFor()
        assert.equal(await chat.locator('.chat-error').count(), 0)
      }
      await page.goto(environment.baseUrl, { waitUntil: 'domcontentloaded' })
      await tap(page.getByRole('button', { name: '功能', exact: true }))
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      if (historyRecoveryOnly) {
        await tap(page.getByRole('button', { name: 'APP 管理', exact: true }))
        const manager = page.locator('.official-app-manager')
        await manager.waitFor()
        await tap(
          manager.locator('li').filter({ hasText: '蒜惹菈' }).getByRole('button', {
            name: '下载',
            exact: true,
          }),
        )
        await page.getByRole('status').filter({ hasText: '安装成功' }).waitFor()
        await tap(page.locator('.feature-app-header__back').first())
      }
      await openAuditFeature(page, '蒜惹菈')
      if (historyRecoveryOnly) {
        await chat.getByLabel('发送消息', { exact: true }).fill('当前对话保留')
        await page.waitForFunction(async () => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          const db = await new Promise((accept, reject) => {
            opening.onsuccess = () => accept(opening.result)
            opening.onerror = () => reject(opening.error)
          })
          try {
            const transaction = db.transaction('settings', 'readonly')
            const request = transaction.objectStore('settings').get('assistant.active')
            return await new Promise((accept, reject) => {
              request.onsuccess = () => accept(Boolean(request.result?.value))
              request.onerror = () => reject(request.error)
            })
          } finally {
            db.close()
          }
        })
        await page.evaluate(async () => {
          const opening = indexedDB.open('SillyTavernResourceLibrary')
          const db = await new Promise((accept, reject) => {
            opening.onsuccess = () => accept(opening.result)
            opening.onerror = () => reject(opening.error)
          })
          try {
            const transaction = db.transaction('settings', 'readwrite')
            transaction.objectStore('settings').put({
              id: 'assistant.chat:lost-history-fixture',
              updatedAt: 1,
              value: {
                id: 'lost-history-fixture',
                title: '更新前的历史夹具',
                updatedAt: 1,
                history: [{ id: 'old-message', role: 'user', text: '保留的历史正文' }],
                input: '未发送的旧输入',
                images: [],
              },
            })
            await new Promise((accept, reject) => {
              transaction.oncomplete = accept
              transaction.onerror = () => reject(transaction.error)
              transaction.onabort = () => reject(transaction.error)
            })
          } finally {
            db.close()
          }
        })
        const activeBefore = (await records()).find((row) => row.id === 'assistant.active')?.value
        await settings()
        await tap(chat.getByRole('button', { name: '历史对话', exact: false }))
        const gear = chat.getByRole('button', { name: '历史设置', exact: true })
        assert.equal(await chat.getByRole('button', { name: '找回历史', exact: true }).count(), 0)
        assert.ok(await gear.evaluate((node) => node.getBoundingClientRect().height >= 44))
        await screenshot('history-list')
        await tap(gear)
        const dialog = page.getByRole('dialog', { name: '历史设置', exact: true })
        const panel = dialog.locator('.chat-history-recovery')
        const geometry = await panel.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            width: innerWidth,
            height: window.innerHeight,
          }
        })
        assert.ok(Math.abs(geometry.x - geometry.width / 2) <= 2)
        assert.ok(Math.abs(geometry.y - geometry.height / 2) <= 2, 'dialog centered vertically')
        await screenshot('history-options')
        await tap(dialog.getByRole('button', { name: '关闭', exact: true }))
        assert.equal(
          (await records()).some((row) => row.id === 'assistant.summary:lost-history-fixture'),
          false,
        )
        await tap(gear)
        const recovery = dialog.getByRole('button', { name: '找回历史', exact: true })
        await tap(recovery)
        await dialog.getByText('检查完成：找回 0 条，修复列表 1 条', { exact: true }).waitFor()
        const recoveredChat = chat
          .locator('.chat-history-open')
          .filter({ hasText: '更新前的历史夹具' })
        await recoveredChat.waitFor()
        assert.equal(
          (await records()).find((row) => row.id === 'assistant.active')?.value,
          activeBefore,
        )
        assert.equal(requests, 0, 'recovery must not call the model')
        assert.ok(await recovery.evaluate((node) => node.getBoundingClientRect().height >= 44))
        await screenshot('history-recovered')
        await tap(recovery)
        await dialog.getByText(/检查完成：找回 0 条，修复列表 0 条/).waitFor()
        assert.equal(
          (await records()).filter((row) => row.id === 'assistant.summary:lost-history-fixture')
            .length,
          1,
        )
        const focus = await dialog.evaluate((node) => ({
          inside: node.contains(document.activeElement),
          tag: document.activeElement?.tagName,
          label: document.activeElement?.textContent?.slice(0, 80),
        }))
        assert.ok(focus.inside, `recovery must retain dialog focus: ${JSON.stringify(focus)}`)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await gear.waitFor()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await tap(page.getByRole('button', { name: '功能', exact: true }))
        await openAuditFeature(page, '蒜惹菈')
        await settings()
        await tap(chat.getByRole('button', { name: '历史对话', exact: false }))
        await tap(recoveredChat)
        await chat.getByText('保留的历史正文', { exact: true }).waitFor()
        assert.equal(
          await chat.getByLabel('发送消息', { exact: true }).inputValue(),
          '未发送的旧输入',
        )
        assert.equal(requests, 0)
        console.log(
          `PASS ${environment.engine} ${width} ${theme}: header SVG, centered dialog/close/results/Escape, real stored list repair, no model request, repeat idempotency and reload/open original body`,
        )
        await context.close()
        context = undefined
        continue
      }
      await settings()
      await chat.getByLabel('助手工作模式').selectOption('creation')
      const compressionThreshold = chat.getByLabel('自动压缩 token 阈值', { exact: true })
      assert.equal(await compressionThreshold.getAttribute('max'), null, 'no arbitrary 64k ceiling')
      await compressionThreshold.fill('1000000')
      await chat.getByLabel('每次生成工具调用上限', { exact: true }).fill('32')
      await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
      assert.equal(
        (await records()).find((row) => row.id === 'assistant.preferences').value
          .compressionTokenThreshold,
        1000000,
      )
      await compressionThreshold.fill('')
      assert.equal(
        'contextTokenLimit' in
          (await records()).find((row) => row.id === 'assistant.preferences').value,
        false,
        'new saves contain only the compression threshold',
      )
      await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
      assert.equal(
        (await records()).find((row) => row.id === 'assistant.preferences').value
          .compressionTokenThreshold,
        undefined,
      )
      await tap(chat.getByRole('button', { name: '助手 API', exact: true }))
      await tap(chat.getByRole('button', { name: '新增', exact: true }))
      await chat.getByLabel('配置名称', { exact: true }).fill('隔离工作流 API')
      await chat
        .getByLabel('API URL', { exact: true })
        .fill(
          currentViewOnly
            ? 'https://api.deepseek.com'
            : 'https://assistant-workflow-test.invalid/v1',
        )
      await chat.locator('.inline-model-picker input').fill('workflow-fixture')
      await chat.getByLabel('API 密钥', { exact: true }).fill('workflow-fixture-key')
      await tap(chat.getByRole('button', { name: '保存并用于助手', exact: true }))
      await back()
      await back()
      if (reasoningOnly) {
        commands = []
        let originalCommon = ''
        let originalCreation = ''
        let customCommon = ''
        let customCreation = ''
        if (promptOnly) {
          await settings()
          assert.equal(
            await chat.locator('.chat-prompt-editor').count(),
            0,
            'editor is a separate page',
          )
          const links = await chat.locator('.chat-settings-links > button').allTextContents()
          const memoryIndex = links.findIndex((label) => label.includes('偏好记忆'))
          assert.ok(
            links[memoryIndex + 1].includes('系统提示词'),
            'prompt entry immediately below memory',
          )
          await tap(chat.getByRole('button', { name: '系统提示词', exact: true }))
          const editor = chat.locator('.chat-prompt-editor')
          const text = editor.getByLabel('系统提示词内容', { exact: true })
          const section = editor.getByLabel('提示词部分', { exact: true })
          originalCommon = await text.inputValue()
          assert.ok(
            originalCommon.includes('默认先用一句话直接回答'),
            'original public rules editable',
          )
          customCommon = `${originalCommon}\n提示词验收通用标记`
          await text.fill(customCommon)
          await section.selectOption('creation')
          originalCreation = await text.inputValue()
          customCreation = `${originalCreation}\n提示词验收制作标记`
          await text.fill(customCreation)
          assert.equal(
            (await records()).find((row) => row.id === 'assistant.preferences').value
              .promptOverrides,
            undefined,
            'edits are not effective before saving',
          )
          await back()
          const exit = page.getByRole('alertdialog', { name: '有修改未保存', exact: true })
          await exit.waitFor()
          await tap(exit.getByRole('button', { name: '继续编辑', exact: true }))
          assert.equal(await text.inputValue(), customCreation, 'staying preserves prompt draft')
          await screenshot('prompt-editor')
          await tap(chat.getByRole('button', { name: '保存提示词', exact: true }))
          const savedPrompts = (await records()).find((row) => row.id === 'assistant.preferences')
            .value.promptOverrides
          assert.deepEqual(savedPrompts, { common: customCommon, creation: customCreation })
          await back()
          await back()
        }
        await generate('测试返回的思考内容')
        if (promptOnly) {
          const sentPrompt = requestBodies.at(-1).messages[0].content
          assert.ok(
            sentPrompt.includes(`${customCommon}\n${customCreation}`),
            'edited sections reach actual request',
          )
        }
        const trigger = chat.getByRole('button', { name: '查看这条回复的思考内容', exact: true })
        assert.equal(await trigger.count(), 1)
        const hit = await trigger.boundingBox()
        const pill = await trigger.locator(':scope > span').boundingBox()
        const avatar = await chat.locator('.chat-message--assistant .chat-avatar').boundingBox()
        const bubble = await chat.locator('.chat-message--assistant .chat-bubble').boundingBox()
        const question = await chat.locator('.chat-message--user .chat-bubble').boundingBox()
        assert.ok(hit.width >= 44 && hit.height >= 44, 'reasoning chip touch target')
        assert.ok(pill.height <= 28, 'small visible pill')
        assert.ok(bubble.width < width - 140, 'short replies retain their natural compact width')
        assert.ok(
          hit.x >= avatar.x + avatar.width &&
            pill.y + pill.height <= bubble.y &&
            Math.abs(bubble.y - avatar.y) < 2,
          'thinking above reply, bubble aligned with avatar',
        )
        assert.ok(
          hit.y >= question.y + question.height - 1,
          'touch target does not cover previous question',
        )
        await screenshot('reasoning-chip')
        const beforeView = requests
        await tap(trigger)
        const dialog = page.getByRole('dialog', { name: '思考内容', exact: true })
        await dialog.waitFor()
        assert.equal(
          await dialog.locator('pre').textContent(),
          reasoningFixture,
          'exact returned text',
        )
        assert.equal(await dialog.locator('script').count(), 0, 'escaped HTML')
        assert.ok(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          'dialog wraps long content',
        )
        await page.screenshot({
          path: resolve(environment.outputDir, `reasoning-viewer-${width}-${theme}.png`),
        })
        await tap(dialog.getByRole('button', { name: '关闭思考内容', exact: true }))
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(requests, beforeView, 'viewing has no API request')
        await generate('测试空思考返回')
        assert.equal(await trigger.count(), 1, 'empty reasoning creates no second chip')
        const saved = (await records()).find((row) => row.id.startsWith('assistant.chat:'))
        assert.equal(
          saved.value.history.filter((turn) => turn.role === 'assistant')[0].reasoning,
          reasoningFixture,
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await tap(page.getByRole('button', { name: '功能', exact: true }))
        await openAuditFeature(page, '蒜惹菈')
        if (promptOnly) {
          await settings()
          const editor = chat.locator('.chat-prompt-editor')
          await tap(chat.getByRole('button', { name: '系统提示词', exact: true }))
          const text = editor.getByLabel('系统提示词内容', { exact: true })
          const section = editor.getByLabel('提示词部分', { exact: true })
          assert.equal(await text.inputValue(), customCommon, 'custom public rules survive reload')
          await section.selectOption('creation')
          assert.equal(await text.inputValue(), customCreation)
          await tap(editor.getByRole('button', { name: '恢复默认', exact: true }))
          assert.equal(await text.inputValue(), originalCreation)
          await tap(chat.getByRole('button', { name: '保存提示词', exact: true }))
          assert.deepEqual(
            (await records()).find((row) => row.id === 'assistant.preferences').value
              .promptOverrides,
            { common: customCommon },
          )
          await section.selectOption('common')
          await tap(editor.getByRole('button', { name: '恢复默认', exact: true }))
          assert.equal(await text.inputValue(), originalCommon)
          await tap(chat.getByRole('button', { name: '保存提示词', exact: true }))
          assert.equal(
            (await records()).find((row) => row.id === 'assistant.preferences').value
              .promptOverrides,
            undefined,
          )
          await back()
          await back()
          await generate('恢复默认后的回复')
          assert.equal(
            requestBodies.at(-1).messages[0].content.includes('提示词验收'),
            false,
            'restored default used by next generation',
          )
        }
        await tap(trigger.first())
        await dialog.waitFor()
        assert.equal(
          await dialog.locator('pre').textContent(),
          reasoningFixture,
          'saved thinking survives reload',
        )
        await tap(dialog.getByRole('button', { name: '关闭思考内容', exact: true }))
        console.log(
          `PASS ${environment.engine} ${width} ${theme}: raised chip, avatar-aligned reply, 44px touch, escaped reasoning, no extra API, persisted reopen${promptOnly ? ', original prompt edits/draft exit/reload/restore/request verified' : ''}`,
        )
        await context.close()
        context = undefined
        continue
      }
      if (githubPublicLive) {
        const calls = []
        context.on('request', (request) => {
          if (request.url().startsWith('https://api.github.com/'))
            calls.push({
              url: request.url(),
              hasAuthorization: Boolean(request.headers().authorization),
              method: request.method(),
            })
        })
        await settings()
        await chat.getByLabel('助手工作模式').selectOption('features')
        await tap(chat.getByLabel('联网工具', { exact: true }))
        assert.equal(await chat.getByLabel('公开源码免确认', { exact: true }).isChecked(), false)
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await chat
          .locator('.chat-settings-save [role="status"]')
          .filter({ hasText: '已保存' })
          .waitFor()
        await back()
        commands = [
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/octocat/Hello-World', path: '' },
          },
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/octocat/Hello-World', path: 'README' },
          },
        ]
        await chat.getByLabel('发送消息', { exact: true }).fill('读取公开测试仓库目录和README')
        await tap(chat.getByRole('button', { name: '发送', exact: true }))
        await tap(chat.getByRole('button', { name: '生成回复', exact: true }))
        const confirmSend = page.getByRole('button', { name: '确认发送', exact: true })
        if (await confirmSend.isVisible()) await tap(confirmSend)
        await tap(page.getByRole('button', { name: '确认读取', exact: true }))
        await tap(
          page
            .getByRole('alertdialog')
            .filter({ hasText: 'README' })
            .getByRole('button', { name: '确认读取', exact: true }),
        )
        await chat.getByRole('button', { name: '生成回复', exact: true }).waitFor()
        const receipts = requestBodies
          .at(-1)
          .messages.filter((item) => item.role === 'tool')
          .map((item) => JSON.parse(item.content))
        if (
          receipts.every(
            (item) => item.ok === false && /GitHub API 请求额度已用完/u.test(item.error),
          )
        ) {
          assert.equal(calls.length, 2, 'quota stops at metadata, no content fetch or retry')
          assert.ok(calls.every((call) => !call.hasAuthorization && call.method === 'GET'))
          assert.ok(
            receipts.every((item) => !/\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(item.error)),
            'quota error does not expose upstream IP',
          )
          await writeFile(
            resolve(environment.outputDir, 'github-public-live-outcome.json'),
            JSON.stringify({
              status: 'blocked-anonymous-quota',
              requests: calls.length,
              noRetry: true,
              contentRead: false,
            }) + '\n',
          )
          await screenshot('github-public-quota')
          console.log(
            'BLOCKED real anonymous GitHub reading: shared-network quota exhausted; actual tool reports quota without upstream body/IP, no retry; authenticated live reading remains untested',
          )
          await context.close()
          context = undefined
          continue
        }
        assert.equal(receipts[0].ok, true, String(receipts[0].error))
        assert.equal(receipts[1].ok, true, String(receipts[1].error))
        assert.equal(receipts[0].kind, 'directory')
        assert.ok(receipts[0].entries.some((item) => item.path === 'README'))
        assert.equal(receipts[1].kind, 'file')
        assert.equal(receipts[1].complete, true)
        assert.ok(receipts[1].text.trim().length > 0)
        assert.match(receipts[1].sha, /^[a-f0-9]{40}$/u)
        assert.ok(calls.every((call) => !call.hasAuthorization && call.method === 'GET'))
        assert.equal(calls.length, 4)
        await screenshot('github-public-live')
        console.log(
          `PASS real GitHub API through browser CORS: public directory, full README (${receipts[1].totalCharacters} chars), anonymous quota ${JSON.stringify(receipts[1].quota)}; model response is a fixture`,
        )
        await context.close()
        context = undefined
        continue
      }
      if (githubReadOnly) {
        const githubRequests = []
        await context.route('https://api.github.com/**', async (route) => {
          assert.equal(route.request().method(), 'GET', 'read-only GitHub method')
          const url = route.request().url()
          githubRequests.push({ url, authorization: route.request().headers().authorization })
          let data
          if (url === 'https://api.github.com/repos/example/public-repo')
            data = { private: false, visibility: 'public', default_branch: 'main' }
          else if (url === 'https://api.github.com/repos/example/public-repo/contents?ref=main')
            data = [
              ...Array.from({ length: 260 }, (_, i) => ({
                type: 'file',
                path: `Other${i}.md`,
                size: 10,
                sha: 'other-sha',
              })),
              { type: 'file', path: 'README.md', size: 7000, sha: 'fixture-sha' },
            ]
          else if (
            url === 'https://api.github.com/repos/example/public-repo/contents/README.md?ref=main'
          )
            data = {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from('GitHub 公开测试源码'.repeat(5000)).toString('base64'),
              sha: 'fixture-sha',
            }
          else throw new Error('unexpected GitHub endpoint')
          await route.fulfill({
            json: data,
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': String(5000 - githubRequests.length),
            },
          })
        })
        await settings()
        await chat.getByLabel('助手工作模式').selectOption('auto')
        await tap(chat.getByLabel('联网工具', { exact: true }))
        const keyInput = chat.getByLabel('GitHub 令牌', { exact: true })
        await keyInput.fill('github_pat_browser_fixture')
        assert.equal(await keyInput.getAttribute('type'), 'password')
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await chat
          .locator('.chat-settings-save [role="status"]')
          .filter({ hasText: '已保存' })
          .waitFor()
        assert.ok(
          !JSON.stringify(await records()).includes('github_pat_browser_fixture'),
          'no GitHub token in assistant settings/chat records',
        )
        await keyInput.scrollIntoViewIfNeeded()
        await screenshot('github-read-settings')
        await back()
        commands = [
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/example/public-repo', path: '', query: 'README' },
          },
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/example/public-repo', path: 'README.md', offset: '0' },
          },
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/example/public-repo', path: 'README.md' },
          },
        ]
        await chat
          .getByLabel('发送消息', { exact: true })
          .fill('查看公开项目目录，再完整读取README')
        await tap(chat.getByRole('button', { name: '发送', exact: true }))
        await tap(chat.getByRole('button', { name: '生成回复', exact: true }))
        const confirmSend = page.getByRole('button', { name: '确认发送', exact: true })
        if (await confirmSend.isVisible()) await tap(confirmSend)
        assert.ok((await page.getByRole('alertdialog').innerText()).includes('文件名筛选=README'))
        await tap(page.getByRole('button', { name: '确认读取', exact: true }))
        await tap(
          page
            .getByRole('alertdialog')
            .filter({ hasText: 'README.md' })
            .getByRole('button', { name: '确认读取', exact: true }),
        )
        await chat.getByRole('button', { name: '生成回复', exact: true }).waitFor()
        assert.equal(await chat.locator('.chat-error').count(), 0)
        assert.deepEqual(
          githubRequests.map((request) => request.url),
          [
            'https://api.github.com/repos/example/public-repo',
            'https://api.github.com/repos/example/public-repo/contents?ref=main',
            'https://api.github.com/repos/example/public-repo',
            'https://api.github.com/repos/example/public-repo/contents/README.md?ref=main',
          ],
        )
        assert.ok(
          githubRequests.every(
            (request) => request.authorization === 'Bearer github_pat_browser_fixture',
          ),
        )
        assert.ok(
          !JSON.stringify(requestBodies).includes('github_pat_browser_fixture'),
          'GitHub token never enters model payloads',
        )
        assert.ok(
          JSON.stringify(requestBodies).includes('GitHub 公开测试源码'.repeat(5000)),
          'actual tool receipt reaches the model',
        )
        assert.ok(
          requestBodies.some((body) =>
            body.tools?.some(
              (tool) =>
                tool.function?.name === 'get_feature_help' &&
                tool.function.description.includes(
                  'https://github.com/jixiangruyi117/SillyTavernResourceLibrary-Public',
                ),
            ),
          ),
          'automatic mode receives the designated source repository',
        )
        assert.equal(await chat.getByText('已复用 GitHub 资料', { exact: true }).count(), 1)
        assert.ok(
          !requestBodies.at(-1).tools?.length,
          'duplicate-only round ends with tools disabled',
        )
        assert.equal(
          await chat
            .getByRole('button', { name: '查看公开资料回执结果（本机）', exact: true })
            .count(),
          2,
          'duplicate read adds no result card',
        )
        await tap(
          chat.getByRole('button', { name: '查看公开资料回执结果（本机）', exact: true }).first(),
        )
        const directoryDialog = chat.getByRole('dialog', { name: '本机工具结果', exact: true })
        assert.ok((await directoryDialog.innerText()).includes('筛选：readme · 全目录 261 项'))
        assert.equal(await directoryDialog.locator('li').count(), 1)
        assert.ok((await directoryDialog.innerText()).includes('README.md'))
        await screenshot('github-filtered-directory')
        await tap(directoryDialog.getByRole('button', { name: '关闭', exact: true }))
        await tap(
          chat.getByRole('button', { name: '查看公开资料回执结果（本机）', exact: true }).last(),
        )
        const resultDialog = chat.getByRole('dialog', { name: '本机工具结果', exact: true })
        assert.ok((await resultDialog.innerText()).includes('已读完整文件'))
        assert.equal(await resultDialog.getByText('原始 JSON', { exact: true }).count(), 0)
        assert.equal(await resultDialog.locator(':scope > pre').count(), 0)
        await tap(resultDialog.getByText('查看源码', { exact: true }))
        assert.equal(
          await resultDialog.locator('pre').innerText(),
          'GitHub 公开测试源码'.repeat(5000),
        )
        assert.ok(
          await resultDialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          'result dialog has no horizontal overflow',
        )
        await screenshot('github-readable-receipt')
        await tap(resultDialog.getByRole('button', { name: '关闭', exact: true }))
        await settings()
        await tap(chat.getByLabel('公开源码免确认', { exact: true }))
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await chat
          .locator('.chat-settings-save [role="status"]')
          .filter({ hasText: '已保存' })
          .waitFor()
        await screenshot('github-read-without-confirmation')
        await back()
        const beforeAutomaticRead = githubRequests.length
        const beforeAutomaticModels = requestBodies.length
        commands = [
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/example/public-repo', path: '' },
          },
          {
            name: 'read_webpage',
            args: { url: 'https://github.com/example/public-repo', path: 'README.md', offset: '0' },
          },
        ]
        await generate('免确认读取完整目录和六万多字源码')
        assert.equal(await page.getByRole('button', { name: '确认读取', exact: true }).count(), 0)
        assert.equal(
          githubRequests.length - beforeAutomaticRead,
          4,
          'two public reads without per-read approval',
        )
        const automaticResults = requestBodies
          .slice(beforeAutomaticModels)
          .at(-1)
          .messages.filter((item) => item.role === 'tool')
          .map((item) => JSON.parse(item.content))
        assert.equal(
          automaticResults[0].entries.length,
          261,
          'full directory, no twenty-entry pages',
        )
        assert.equal(automaticResults[0].complete, true)
        assert.equal(automaticResults[0].nextOffset, null)
        assert.equal(automaticResults[1].text.length, 65000)
        assert.equal(automaticResults[1].complete, true)
        assert.equal(automaticResults[1].nextOffset, null)
        assert.ok(!JSON.stringify(requestBodies).includes('github_pat_browser_fixture'))
        await settings()
        await tap(chat.getByLabel('模型原生搜索', { exact: true }))
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await chat
          .locator('.chat-settings-save [role="status"]')
          .filter({ hasText: '已保存' })
          .waitFor()
        await back()
        commands = [{ name: 'search_web', args: { query: '公开功能说明' } }]
        await chat.getByLabel('发送消息', { exact: true }).fill('测试原生搜索仍须确认')
        await tap(chat.getByRole('button', { name: '发送', exact: true }))
        await tap(chat.getByRole('button', { name: '生成回复', exact: true }))
        if (await confirmSend.isVisible()) await tap(confirmSend)
        const searchConfirmation = page.getByRole('alertdialog', { name: '联网搜索', exact: true })
        await searchConfirmation.waitFor()
        await tap(searchConfirmation.getByRole('button', { name: '取消', exact: true }))
        await chat.getByRole('button', { name: '生成回复', exact: true }).waitFor()
        assert.equal(
          githubRequests.length - beforeAutomaticRead,
          4,
          'cancelled search never reads GitHub',
        )
        const reopen = async () => {
          await page.reload({ waitUntil: 'domcontentloaded' })
          await tap(page.getByRole('button', { name: '功能', exact: true }))
          await openAuditFeature(page, '蒜惹菈')
          await settings()
        }
        await reopen()
        assert.equal(
          await chat.getByLabel('公开源码免确认', { exact: true }).isChecked(),
          true,
          'opt-in survives reload',
        )
        await keyInput.waitFor({ state: 'visible' })
        await page.waitForFunction(
          () =>
            document.querySelector('input[aria-label="GitHub 令牌"]')?.value ===
            'github_pat_browser_fixture',
        )
        await chat.getByLabel('GitHub 令牌保存方式', { exact: true }).selectOption('session')
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await chat
          .locator('.chat-settings-save [role="status"]')
          .filter({ hasText: '已保存' })
          .waitFor()
        assert.equal(
          (await records()).find((row) => row.id === 'assistant.preferences').value
            .githubReadPersistence,
          'session',
          'session choice committed before reload',
        )
        await reopen()
        assert.equal(
          await chat.getByLabel('GitHub 令牌保存方式', { exact: true }).inputValue(),
          'session',
        )
        await page.waitForFunction(
          () => document.querySelector('input[aria-label="GitHub 令牌"]')?.disabled === false,
        )
        assert.equal(await keyInput.inputValue(), '', 'session key disappears on reload')
        console.log(
          `PASS ${environment.engine} ${width} ${theme}: full 261-entry directory and 65000-character file without read dialogs; native search still confirms; masked token, no model leak, opt-in/local reopen and session clear`,
        )
        await context.close()
        context = undefined
        continue
      }
      if (currentViewOnly) {
        await settings()
        await chat.getByLabel('助手工作模式').selectOption('appearance')
        await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
        await back()
        commands = [
          { name: 'get_ui_regions', args: {} },
          { name: 'read_css', args: { scope: 'app:assistant' } },
          {
            name: 'update_css',
            args: {
              scope: 'app:assistant',
              css: ':scope .chat-bubble { border: 1px solid rgb(130, 167, 211); }',
              description: '只改聊天气泡边框',
            },
          },
          { name: 'capture_ui', args: { scope: 'app:assistant' } },
          { name: 'capture_current_ui', args: {} },
        ]
        await generate('美化当前聊天页，保留其它页面。PRIVATE_CHAT_CONTENT')
        assert.match(requestBodies[0].messages[0].content, /当前区域：app:assistant/u)
        assert.match(requestBodies[0].messages[0].content, /"scope":"app:assistant"/u)
        const tools = requestBodies.flatMap((body) =>
          body.messages
            .filter((item) => item.role === 'tool')
            .map((item) => JSON.parse(item.content)),
        )
        assert.equal(tools.find((item) => item.currentScope)?.currentScope, 'app:assistant')
        assert.ok(
          tools.every((item) => item.ok !== false),
          'real screenshot and CSS tools succeed',
        )
        assert.equal(await page.locator('.library').isVisible(), false, 'home remains hidden')
        assert.equal(
          await chat
            .locator('.chat-bubble')
            .first()
            .evaluate((node) => getComputedStyle(node).borderTopColor),
          'rgb(130, 167, 211)',
        )
        const image = requestBodies
          .flatMap((body) => body.messages)
          .find(
            (item) =>
              Array.isArray(item.content) && item.content.some((part) => part.type === 'image_url'),
          )
        assert.ok(image, 'current-view pixels reach the model after paired tool receipts')
        const part = image.content.find((item) => item.type === 'image_url')
        assert.match(part.image_url.url, /^data:image\/jpeg;base64,/u)
        await writeFile(
          resolve(environment.outputDir, `assistant-current-view-${width}-${theme}.jpg`),
          Buffer.from(part.image_url.url.split(',')[1], 'base64'),
        )
        await screenshot('assistant-current-view-chat')
        const savedChat = (await records()).find((row) => row.id.startsWith('assistant.chat:'))
        assert.equal(
          savedChat.value.history.at(-1).reasoning,
          '',
          'empty thinking persists through the original workspace storage',
        )
        const beforeImage = savedChat.value.history.find((turn) => turn.comparison)?.comparison
          .before
        assert.ok(beforeImage?.dataUrl, 'actual before screenshot retained with the comparison')
        await writeFile(
          resolve(environment.outputDir, `assistant-before-chat-${width}-${theme}.jpg`),
          Buffer.from(beforeImage.dataUrl.split(',')[1], 'base64'),
        )
        await generate('继续核对当前页，不改其它内容。')
        const assistantHistory = requestBodies
          .at(-1)
          .messages.filter((item) => item.role === 'assistant' && !item.tool_calls)
        assert.ok(
          assistantHistory.some((item) => item.reasoning_content === ''),
          'empty final reasoning survives saved chat and the next request',
        )
        console.log(
          `PASS ${environment.engine} ${width} ${theme}: actual assistant scope, local before/after and current-view pixels; home remains hidden`,
        )
        await context.close()
        context = undefined
        continue
      }
      await generate('制作日记 APP')
      await chat.locator('.chat-app-preview').waitFor()
      await screenshot('chat-compact')
      assert.ok(
        (await chat.locator('.chat-app-preview').boundingBox()).height <= 112,
        'compact draft card without preview',
      )
      const appActions = await chat.locator('.chat-app-preview button').evaluateAll((nodes) =>
        nodes.map((node) => ({
          font: parseFloat(getComputedStyle(node).fontSize),
          height: node.getBoundingClientRect().height,
        })),
      )
      assert.ok(
        appActions.every((item) => item.font >= 12 && item.font <= 13 && item.height >= 44),
        'small labels with retained touch targets',
      )
      const composerTargets = await chat.locator('.chat-send,.chat-generate').evaluateAll((nodes) =>
        nodes.map((node) => ({
          button: node.getBoundingClientRect().width,
          icon: node.querySelector('svg').getBoundingClientRect().width,
        })),
      )
      assert.ok(
        composerTargets.every((item) => item.button >= 44 && item.icon === 30),
        'compact visible controls, separate 44px targets',
      )
      const initial = await records()
      const firstId = initial.find((row) => row.id === 'assistant.active').value
      const project = initial.find((row) => row.id.startsWith('assistant.project:')).value
      assert.equal(project.name, '接续日记')
      assert.equal(
        initial.find((row) => row.id === `assistant.chat:${firstId}`).value.draft,
        undefined,
      )
      await settings()
      await tap(chat.getByRole('button', { name: 'APP 项目', exact: false }))
      await chat.getByRole('button', { name: '在新聊天继续 接续日记', exact: true }).waitFor()
      await screenshot('projects')
      const help = chat.getByRole('button', { name: '接续说明', exact: true })
      assert.equal(await help.locator('svg').count(), 1)
      await tap(help)
      await page.getByRole('alertdialog', { name: '接续说明', exact: true }).waitFor()
      await screenshot('project-help')
      await tap(page.getByRole('button', { name: '知道了', exact: true }))
      await tap(chat.getByRole('button', { name: '在新聊天继续 接续日记', exact: true }))
      await chat.getByLabel('发送消息', { exact: true }).waitFor()
      const continued = await records()
      const secondId = continued.find((row) => row.id === 'assistant.active').value
      assert.notEqual(secondId, firstId)
      assert.deepEqual(
        continued.find((row) => row.id === `assistant.chat:${secondId}`).value.history,
        [],
      )
      assert.equal(
        continued.find((row) => row.id === `assistant.chat:${secondId}`).value.projectId,
        project.id,
      )
      await screenshot('continued-chat')
      commands = [
        { name: 'read_app_file', args: { path: 'index.html' } },
        {
          name: 'write_app_file',
          args: {
            path: 'index.html',
            content: '<!doctype html><html><body>第二版日记</body></html>',
          },
        },
      ]
      await generate('把第一版改为第二版')
      assert.ok(
        (await records())
          .find((row) => row.id === `assistant.project:${project.id}`)
          .value.draft.source['index.html'].includes('第二版日记'),
      )
      await settings()
      await tap(chat.getByRole('button', { name: '历史对话', exact: false }))
      await tap(chat.locator('.chat-history-open').filter({ hasText: '制作日记 APP' }))
      await settings()
      await tap(chat.getByRole('button', { name: 'APP 项目', exact: false }))
      const latest = await records()
      assert.equal(
        latest.find((row) => row.id === `assistant.chat:${firstId}`).value.projectVersion,
        2,
      )
      await back()
      await back()
      await chat.getByLabel('发送消息', { exact: true }).fill('保留已有要求')
      await settings()
      await tap(chat.getByRole('button', { name: '任务模板', exact: false }))
      assert.equal(await chat.locator('.feature-app-header [aria-label="新建模板"] svg').count(), 1)
      await tap(chat.getByRole('button', { name: '新建模板', exact: true }))
      await chat.getByLabel('模板名称', { exact: true }).fill('检查保存')
      await chat.getByLabel('模板操作步骤', { exact: true }).fill('先预览 APP\n点击保存并重载核对')
      await screenshot('template-editor')
      await back()
      await page.getByRole('alertdialog').waitFor()
      await tap(page.getByRole('button', { name: '继续编辑', exact: true }))
      assert.equal(await chat.getByLabel('模板名称', { exact: true }).inputValue(), '检查保存')
      await tap(chat.getByRole('button', { name: '保存模板', exact: true }))
      await chat.getByRole('button', { name: '使用模板 检查保存', exact: true }).waitFor()
      const stepDetail = chat.locator('.chat-template-detail')
      assert.equal(await stepDetail.getAttribute('open'), null)
      await screenshot('templates')
      await tap(stepDetail.locator('summary'))
      assert.equal(await stepDetail.locator('li').count(), 2)
      await screenshot('template-steps')
      await tap(stepDetail.locator('summary'))
      await tap(chat.getByRole('button', { name: '编辑模板 检查保存', exact: true }))
      assert.equal(await chat.getByLabel('模板名称', { exact: true }).inputValue(), '检查保存')
      await tap(chat.getByRole('button', { name: '取消', exact: true }))
      const beforeUse = requests
      await tap(chat.getByRole('button', { name: '使用模板 检查保存', exact: true }))
      await chat.getByLabel('发送消息', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(
        await chat.getByLabel('发送消息', { exact: true }).inputValue(),
        '保留已有要求\n\n检查保存\n1. 先预览 APP\n2. 点击保存并重载核对',
      )
      assert.equal(requests, beforeUse, 'no model request on template use')
      assert.ok(
        (await chat.getByLabel('发送消息', { exact: true }).boundingBox()).height > 44,
        'multiline template resizes after composer becomes visible',
      )
      await screenshot('template-composer')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await tap(page.getByRole('button', { name: '功能', exact: true }))
      await openAuditFeature(page, '蒜惹菈')
      await chat.getByLabel('发送消息', { exact: true }).waitFor()
      await page.waitForFunction(() => {
        const composer = document.querySelector(
          '.product-assistant textarea[aria-label="发送消息"]',
        )
        return composer && !composer.disabled
      })
      assert.ok(
        (await chat.getByLabel('发送消息', { exact: true }).inputValue()).includes('检查保存'),
      )
      await settings()
      await tap(chat.getByRole('button', { name: '任务模板', exact: false }))
      await chat.getByRole('button', { name: '使用模板 检查保存', exact: true }).waitFor()
      await back()
      assert.equal(
        await chat.getByLabel('每次生成工具调用上限', { exact: true }).inputValue(),
        '32',
      )
      assert.equal(
        await chat.getByLabel('自动压缩 token 阈值', { exact: true }).inputValue(),
        '',
        'blank budget survives reload',
      )
      assert.ok(
        !(await chat.textContent()).includes('工具流程可能多轮请求'),
        'removed constant explanation',
      )
      await chat.getByLabel('每次生成工具调用上限', { exact: true }).fill('1')
      await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
      await screenshot('tool-budget-settings')
      await chat.getByLabel('自动压缩 token 阈值', { exact: true }).fill('1')
      assert.equal(await chat.getByLabel('自动压缩上下文', { exact: true }).isChecked(), false)
      await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
      await back()
      const beforeBudget = requests
      commands = [
        { name: 'read_app_file', args: { path: 'index.html' } },
        { name: 'write_app_file', args: { path: 'index.html', content: '不应写入' } },
      ]
      await generate('核对文件，工具限一次')
      assert.equal(requests, beforeBudget + 2, 'compression threshold does not cap tool-loop input')
      assert.equal(requestBodies.at(-1).tools, undefined, 'final budget response has no tools')
      assert.ok((await chat.textContent()).includes('1/1'))
      assert.equal(
        (await records()).find((row) => row.id === `assistant.project:${project.id}`).value.version,
        2,
        'over-budget write was not applied',
      )
      await screenshot('tool-budget-chat')
      await settings()
      await tap(chat.getByRole('switch', { name: '工具调用', exact: true }))
      await tap(chat.getByRole('button', { name: '保存设置', exact: true }))
      await screenshot('tools-disabled-settings')
      await back()
      const beforeDisabled = requests
      commands = [{ name: 'create_app', args: { name: '不应创建', files: '{}' } }]
      await generate('关闭工具后尝试制作 APP')
      assert.equal(requests, beforeDisabled + 1, 'single request with tools off')
      assert.equal(requestBodies.at(-1).tools, undefined, 'no provider tool definitions')
      assert.ok((await chat.textContent()).includes('未执行本轮工具'))
      assert.equal(
        (await records()).filter((row) => row.id.startsWith('assistant.project:')).length,
        1,
        'unexpected tool did not create a project',
      )
      assert.equal(
        (await records()).find((row) => row.id === `assistant.project:${project.id}`).value.version,
        2,
      )
      await screenshot('tools-disabled-chat')
      await settings()
      assert.equal(
        await chat.getByRole('switch', { name: '工具调用', exact: true }).isChecked(),
        false,
      )
      console.log(
        `PASS ${environment.engine} ${width} ${theme}: clean settings; million/blank compression threshold save/reload; tool budget boundaries; projects/templates`,
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
