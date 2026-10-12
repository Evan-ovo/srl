/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { auditButtonMaterial } from './SharedAppearanceAudit.mjs'

const colors = {
  button: 'rgb(255, 244, 227)',
  primary: 'rgb(128, 85, 170)',
  control: 'rgb(234, 244, 255)',
  dialog: 'rgb(245, 233, 255)',
  canvas: 'rgb(250, 244, 252)',
  ink: 'rgb(68, 51, 92)',
}
export async function auditUnpaintedControls(page) {
  await page.mouse.move(0, 0)
  const controls = await page
    .locator(
      '.feature-back-button, .feature-header-action, .frontend-workbench__rail-tools > button, .chat-composer__row > button',
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length)
        .map((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            label: element.getAttribute('aria-label') || element.textContent.trim(),
            background: style.backgroundColor,
            image: style.backgroundImage,
            shadow: style.boxShadow,
            border: style.borderTopWidth,
            width: rect.width,
            height: rect.height,
          }
        }),
    )
  for (const control of controls) {
    assert.equal(control.background, 'rgba(0, 0, 0, 0)', control.label + ': duplicate background')
    assert.equal(control.image, 'none', control.label + ': duplicate background image')
    assert.equal(control.shadow, 'none', control.label + ': duplicate shadow')
    assert.equal(control.border, '0px', control.label + ': duplicate border')
    assert.ok(control.width >= 43 && control.height >= 43, control.label + ': touch size')
  }
}
function presetFile(name, prefix) {
  const prompts = Array.from({ length: 6 }, (_, index) => ({
    identifier: `${prefix}-${index}`,
    name: `${name}条目 ${index + 1}`,
    role: 'system',
    content: `请以清晰的语言描写场景，保留角色的行为和对话。测试正文 ${index + 1} {{user}} {{char}}`,
  }))
  return {
    name: name + '.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        name,
        temperature: 0.7,
        prompts,
        prompt_order: [
          {
            character_id: 100001,
            order: prompts.map(({ identifier }) => ({ identifier, enabled: true })),
          },
        ],
      }),
    ),
  }
}
export async function prepareInstallableStateData(page, id) {
  if (id !== 'stitch') return
  await page
    .getByLabel('选择单个资源文件，可多选', { exact: true })
    .setInputFiles([
      presetFile('样式主预设', 'appearance-base'),
      presetFile('样式填充预设', 'appearance-source'),
    ])
  await page.getByText('样式主预设', { exact: true }).first().waitFor()
}
export async function auditInstallableStates({ page, id, capture, baseline }) {
  async function state(name, checks = []) {
    await page.mouse.move(0, 0)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => undefined)),
      )
    })
    for (const [selector, kind, pseudo] of checks) {
      const actual = await page
        .locator(selector)
        .first()
        .evaluate((element, pseudo) => {
          const style = getComputedStyle(element, pseudo)
          return { background: style.backgroundColor, color: style.color }
        }, pseudo ?? null)
      if (actual.background !== colors[kind]) {
        console.log(`MATERIAL MISS ${name} ${selector}: ${actual.background} -> ${colors[kind]}`)
        if (!baseline) assert.equal(actual.background, colors[kind], name + ': ' + selector)
      }
    }
    if (!baseline) await auditUnpaintedControls(page)
    if (!baseline) await auditButtonMaterial(page.locator('body'), name)
    const geometry = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    assert.ok(geometry.scroll <= geometry.client + 2, name + ': horizontal overflow')
    await capture(name)
    console.log('Deep state checked: ' + name)
  }
  if (id === 'stitch') {
    await state('stitch-populated', [['.stitch__preset-list button', 'button']])
    await page.getByRole('button', { name: /样式主预设/ }).click()
    const source = page.getByRole('dialog', { name: '选择填充内容', exact: true })
    await source.waitFor()
    await state('stitch-source-picker', [
      ['.stitch-sheet__panel', 'dialog'],
      ['.stitch-sheet__panel input', 'control'],
    ])
    await source.getByRole('button', { name: /样式填充预设/ }).click()
    await page.locator('.stitch-pane--target').waitFor()
    await state('stitch-workbench')
    await page.getByRole('button', { name: '工作台更多操作', exact: true }).click()
    await state('stitch-tools', [
      ['.stitch-tools__menu', 'dialog'],
      ['.stitch-tools__menu button', 'button'],
    ])
    await page.getByRole('button', { name: '工作台更多操作', exact: true }).click()
    const row = page.locator('.stitch-pane--target .stitch-entry').first()
    await row.locator('.stitch-entry__copy').click()
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    await page.locator('.stitch-editor textarea').waitFor()
    await state('stitch-entry-editor', [
      ...(page.viewportSize().width <= 832 ? [['.stitch-editor', 'dialog']] : []),
      ['.stitch-editor textarea', 'control'],
      ['.stitch-editor__macros button', 'button'],
      ['.stitch-editor__actions .button--primary', 'primary'],
    ])
    await page.getByRole('button', { name: '写入聊天变量', exact: true }).click()
    const writer = page.getByRole('dialog', { name: '写入聊天变量', exact: true })
    await writer.waitFor()
    await state('stitch-variable-dialog', [
      ['.stitch-variable-writer', 'dialog'],
      ['.stitch-variable-writer input', 'control'],
    ])
    await writer.getByRole('button', { name: '取消', exact: true }).click()
    await page
      .locator('.stitch-editor textarea')
      .fill('已经修改的隔离样式测试正文 {{user}} {{char}}')
    await page
      .locator('.stitch-editor')
      .getByRole('button', { name: '保存修改', exact: true })
      .click()
    await page.getByRole('button', { name: '查看变更并导出', exact: true }).click()
    await page.locator('.stitch-review').waitFor()
    await state('stitch-review', [
      ['.stitch__generate input', 'control'],
      ['.stitch__generate .button--primary', 'primary'],
    ])
  }
  if (id === 'frontendWorkshop') {
    await page.getByRole('button', { name: '新建开场白', exact: true }).click()
    await page.getByRole('button', { name: '更多工具', exact: true }).click()
    await page.locator('.fw-popover--more').waitFor()
    await state('frontend-tools', [
      ['.fw-popover--more', 'dialog'],
      ['.fw-popover--more button', 'button'],
    ])
    await page
      .locator('.fw-popover--more')
      .getByRole('button', { name: '源码', exact: true })
      .click()
    const editor = page.getByRole('dialog', { name: '源码编辑', exact: true })
    await editor
      .getByRole('textbox', { name: 'HTML CSS JavaScript 源码' })
      .fill(
        '<!doctype html><html><head><style>body{margin:0;padding:24px;background:#fdf6ef;color:#453652;font:16px sans-serif}article{padding:20px;border:1px solid #b59abd;border-radius:16px}button{padding:8px 16px}</style></head><body><article><h1>隔离开场白</h1><p>用于检查真实工作台与属性面板。</p><button>作品内部按钮</button></article></body></html>',
      )
    await state('frontend-source-editor', [
      ['.frontend-workshop-source-editor', 'dialog'],
      ['.frontend-workshop-source-editor textarea', 'control'],
    ])
    await editor.locator('summary').click()
    await state('frontend-source-tools', [
      ['.frontend-workshop-source-editor__tool-menu', 'dialog'],
      ['.frontend-workshop-source-editor__tool-menu button', 'button'],
    ])
    await editor.locator('summary').click()
    await editor.getByRole('button', { name: '保存源码', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await page.locator('.frontend-workshop-source-preview[data-source-ready="true"]').waitFor()
    await state('frontend-canvas')
    await page.getByRole('button', { name: '更多工具', exact: true }).click()
    await page
      .locator('.fw-popover--more')
      .getByRole('button', { name: '组件库', exact: true })
      .click()
    await page.locator('.frontend-workshop-source-components').waitFor()
    await state('frontend-components', [
      ['.frontend-workshop-source-components', 'dialog'],
      ['.frontend-workshop-source-components__scopes button:not(.is-active)', 'button'],
    ])
    await page
      .locator('.frontend-workshop-source-components')
      .getByRole('button', { name: '返回开场白编辑', exact: true })
      .click()
    await page.getByRole('button', { name: '选择元素', exact: true }).click()
    await page
      .frameLocator('iframe[title="Source Runtime Preview"]')
      .frameLocator('iframe[title="FrontendWorkshop Source Runtime"]')
      .getByRole('heading', { name: '隔离开场白', exact: true })
      .click()
    await page.locator('.frontend-workshop-source-inspector:not(.is-empty)').waitFor()
    if (await page.getByRole('button', { name: '展开属性面板', exact: true }).isVisible())
      await page.getByRole('button', { name: '展开属性面板', exact: true }).click()
    await state('frontend-inspector', [['.source-inspector-body .is-primary', 'primary']])
    await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
    await page.getByRole('dialog', { name: '肘肘更健康', exact: true }).waitFor()
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
    await state('frontend-ai-settings', [
      ['.source-ai-workspace__settings', 'dialog'],
      ['.source-ai-workspace__settings button', 'button'],
    ])
  }
  if (id === 'imageGeneration') {
    await page.getByRole('button', { name: '模型 / 连接', exact: true }).click()
    await page.locator('.image-generation-app input[type="password"]').first().waitFor()
    await state('image-connection', [['.image-generation-app input[type="password"]', 'control']])
    await page.getByRole('button', { name: 'OpenAI', exact: true }).click()
    await state('image-openai-connection')
    await page.getByRole('button', { name: '结果', exact: true }).click()
    await state('image-results')
  }
  if (id === 'imageAlbum') {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 300
      const paint = canvas.getContext('2d')
      paint.fillStyle = '#ffe3c4'
      paint.fillRect(0, 0, 400, 300)
      paint.fillStyle = '#8055aa'
      paint.font = 'bold 36px sans-serif'
      paint.fillText('隔离图片', 110, 150)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await page.locator('.generated-album input[type="file"]').setInputFiles({
      name: '隔离相册样例.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })
    await page.getByRole('button', { name: '打开图片：隔离相册样例', exact: true }).first().click()
    await page.locator('.generated-album__detail').waitFor()
    await state('album-populated-detail', [
      ['.generated-album__detail', 'dialog'],
      ['.generated-album__edit-fields input', 'control'],
      ['.generated-album__detail-bar button', 'button'],
    ])
    await page.getByRole('button', { name: '关闭图片详情', exact: true }).click()
  }
  if (id === 'userPersona') {
    await page.getByRole('button', { name: '模板', exact: true }).click()
    await page.getByLabel('人物模板', { exact: true }).waitFor()
    await state('persona-templates', [['.persona-app select[aria-label="人物模板"]', 'control']])
    await page.getByRole('button', { name: '存为模板', exact: true }).click()
    await state('persona-template-editor', [
      ['.persona-app input[aria-label="模板名称"]', 'control'],
    ])
  }
  if (id === 'tavernBridge') {
    await page.getByRole('button', { name: '查看其他小工具', exact: true }).click()
    await page.locator('.author-tools-dialog').waitFor()
    await state('tavern-author-tools', [
      ['.author-tools-dialog__sheet', 'dialog'],
      ['.author-tools-dialog button', 'button'],
    ])
  }
  if (id === 'assistant') {
    await page.getByRole('button', { name: '历史对话', exact: false }).click()
    await state('assistant-history', [['.chat-history-search input', 'control']])
    await page.getByRole('button', { name: '历史设置', exact: true }).click()
    await page.locator('.chat-history-recovery').waitFor()
    await state('assistant-history-dialog', [
      ['.chat-history-recovery', 'dialog'],
      ['.chat-history-recovery button', 'button'],
    ])
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  }
}
