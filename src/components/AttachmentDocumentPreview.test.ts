// @vitest-environment jsdom
import { File as NodeFile, Blob as NodeBlob } from 'node:buffer'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { Resource } from '../types/Resource'
import AttachmentDocumentPreview from './AttachmentDocumentPreview.vue'

const policy = ref({ allowRemoteResources: false, allowScripts: true })
vi.mock('../composables/UsePreviewPolicy', () => ({ usePreviewPolicy: () => policy }))
const views: ReturnType<typeof mount>[] = []
beforeAll(() => {
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('Blob', NodeBlob)
})
beforeEach(() => {
  policy.value = { allowRemoteResources: false, allowScripts: true }
})
afterEach(() => {
  for (const view of views) view.unmount()
  views.length = 0
})
afterAll(() => vi.unstubAllGlobals())

async function preview(markdown: string) {
  const view = mount(AttachmentDocumentPreview, {
    props: {
      resource: {
        id: 'md',
        fileName: '说明.md',
        mimeType: 'text/markdown',
        originalBlob: new Blob([markdown]),
      } as Resource,
    },
  })
  views.push(view)
  await vi.waitFor(() => expect(view.find('[role="status"]').exists()).toBe(false))
  return view
}

it('renders Markdown headings, lists, tables, quotes and code as read-only content', async () => {
  const view = await preview(
    '# 使用说明\n\n**重要** 与 *斜体*。\n\n- 第一项\n- 第二项\n\n| 名称 | 内容 |\n| --- | --- |\n| 作者 | 说明 |\n\n> 引用正文\n\n```js\nconst ready = true;\n```\n\n- [x] 已阅读\n- [ ] 待阅读',
  )
  expect(view.get('h1').text()).toBe('使用说明')
  expect(view.get('strong').text()).toBe('重要')
  expect(view.get('em').text()).toBe('斜体')
  expect(view.get('table td').text()).toBe('作者')
  expect(view.get('blockquote').text()).toBe('引用正文')
  expect(view.get('pre code').text()).toBe('const ready = true;')
  expect(view.findAll('input[type="checkbox"]')).toHaveLength(2)
  expect(
    view
      .findAll('input[type="checkbox"]')
      .every((input) => (input.element as HTMLInputElement).disabled),
  ).toBe(true)
  expect(view.find('textarea, [contenteditable], input:not([type="checkbox"])').exists()).toBe(
    false,
  )
  expect(view.text()).toContain('Markdown · 只读')
})

it('removes executable markup, styles and active form fields while retaining safe links and embedded images', async () => {
  const view = await preview(
    '<script>globalThis.mdExecuted = true</script>\n\n<style>body{display:none}</style>\n\n<iframe src="https://example.com/frame"></iframe>\n\n<input type="text" value="edit"><span contenteditable="true">正文</span>\n\n[链接](https://example.com) [危险](javascript:alert(1))\n\n![内嵌](data:image/png;base64,aGVsbG8=)\n\n<img src="https://example.com/image.png" onerror="alert(1)">',
  )
  expect(view.find('script, style, iframe, [contenteditable], input').exists()).toBe(false)
  expect(view.find('[onerror]').exists()).toBe(false)
  expect(view.get('a').attributes()).toMatchObject({
    href: 'https://example.com',
    target: '_blank',
    rel: 'noopener noreferrer',
  })
  expect(view.findAll('a')[1]!.attributes('href')).toBeUndefined()
  expect(view.findAll('img')[0]!.attributes('src')).toContain('data:image/png;base64,')
  expect(view.findAll('img')[1]!.attributes('src')).toBeUndefined()
})

it('follows the existing remote-resource preview policy without enabling document scripts', async () => {
  const view = await preview('![远程图片](https://example.com/preview.png)')
  expect(view.get('img').attributes('src')).toBeUndefined()
  policy.value.allowRemoteResources = true
  await flushPromises()
  expect(view.get('img').attributes('src')).toBe('https://example.com/preview.png')
  policy.value.allowRemoteResources = false
  await flushPromises()
  expect(view.get('img').attributes('src')).toBeUndefined()
})
