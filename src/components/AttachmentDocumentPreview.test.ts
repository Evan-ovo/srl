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
  vi.restoreAllMocks()
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

async function filePreview(name: string, content: string | Blob) {
  const resource = {
    id: name,
    fileName: name,
    mimeType: 'application/octet-stream',
    originalBlob: typeof content === 'string' ? new Blob([content]) : content,
  } as Resource
  const view = mount(AttachmentDocumentPreview, { props: { resource } })
  views.push(view)
  await flushPromises()
  return view
}

it('creates typed local media URLs without decoding bytes, and stops/releases the source on close', async () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  for (const [name, selector, mime] of [
    ['声音.mp3', 'audio', 'audio/mpeg'],
    ['视频.mp4', 'video', 'video/mp4'],
  ]) {
    const blob = new Blob(['fixture'])
    const read = vi.spyOn(blob, 'arrayBuffer')
    const view = await filePreview(name!, blob)
    expect(view.text()).not.toContain('暂不支持')
    const element = view.get(selector!)
    expect(element.attributes('controls')).toBeDefined()
    expect(element.attributes('preload')).toBe('metadata')
    expect(element.attributes('autoplay')).toBeUndefined()
    expect((create.mock.calls.at(-1)![0] as Blob).type).toBe(mime)
    expect(read).not.toHaveBeenCalled()
    await view.setProps({ active: false })
    expect(pause).toHaveBeenCalled()
    await element.trigger('error')
    expect(view.get('[role="alert"]').text()).toContain('格式或编码')
    view.unmount()
    views.splice(views.indexOf(view), 1)
  }
  expect(pause).toHaveBeenCalledTimes(4)
  expect(load).toHaveBeenCalledTimes(2)
  expect(revoke).toHaveBeenCalledTimes(2)
})

it('keeps HTML/code inert, bounds the rendered text and preserves Unicode across pages', async () => {
  const prefix = '<script>globalThis.executed=true</script>'
  const source = prefix + 'x'.repeat(32767 - prefix.length) + '😀' + '尾部'
  const view = await filePreview('示例.html', source)
  expect(view.find('script,iframe').exists()).toBe(false)
  const first = view.get('pre code').text()
  const next = view.findAll('button').find((button) => button.text() === '下一页')!
  await next.trigger('click')
  expect(first + view.get('pre code').text()).toBe(source)
  expect(first.length).toBeLessThanOrEqual(32768)
  expect(first.endsWith('x')).toBe(true)
})

it('reads text once across page changes, rejects oversized text before reading, and ignores a late closed read', async () => {
  const read = vi.spyOn(NodeBlob.prototype, 'arrayBuffer')
  const view = await filePreview('lines.jsonl', 'x'.repeat(40000))
  const count = read.mock.calls.length
  await view
    .findAll('button')
    .find((button) => button.text() === '下一页')!
    .trigger('click')
  await view
    .findAll('button')
    .find((button) => button.text() === '上一页')!
    .trigger('click')
  expect(read).toHaveBeenCalledTimes(count)
  const large = new Blob(['x'.repeat(16 * 1024 * 1024 + 1)])
  const oversized = await filePreview('large.json', large)
  expect(oversized.get('[role="alert"]').text()).toContain('16 MiB')
  expect(read).toHaveBeenCalledTimes(count)
  let finish!: (value: ArrayBuffer) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const late = mount(AttachmentDocumentPreview, {
    props: {
      resource: { id: 'late', fileName: 'late.json', originalBlob: new Blob(['late']) } as Resource,
    },
  })
  late.unmount()
  finish(new TextEncoder().encode('late').buffer)
  await flushPromises()
  expect(late.exists()).toBe(false)
})

it('renders bounded table pages as escaped cells and provides a raw view for malformed CSV', async () => {
  const view = await filePreview('数据.csv', '名称,正文\n<script>,"a,b"\n' + 'x,y\n'.repeat(52))
  expect(view.findAll('tbody tr')).toHaveLength(50)
  expect(view.find('script').exists()).toBe(false)
  expect(view.findAll('tbody tr')[1]!.text()).toContain('<script>')
  await view
    .findAll('button')
    .find((button) => button.text() === '下一页')!
    .trigger('click')
  expect(view.findAll('tbody tr')).toHaveLength(4)
  expect(view.find('tbody th').text()).toBe('51')
  await view
    .findAll('button')
    .find((button) => button.text() === '查看原文')!
    .trigger('click')
  expect(view.get('pre').text()).toContain('名称,正文')
  const malformed = await filePreview('不完整.csv', '"missing')
  expect(malformed.get('[role="alert"]').text()).toContain('引号未闭合')
  await malformed
    .findAll('button')
    .find((button) => button.text() === '查看原文')!
    .trigger('click')
  expect(malformed.get('pre').text()).toBe('"missing')
})

it('previews images with zoom and releases their URLs', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const view = await filePreview('动图.gif', new Blob(['gif']))
  expect(view.get('img').attributes('alt')).toBe('动图.gif')
  Object.defineProperty(view.get('img').element, 'naturalWidth', { value: 800 })
  await view.get('img').trigger('load')
  await view.get('select').setValue('2')
  expect(view.get('img').attributes('style')).toContain('1600px')
  view.unmount()
  views.splice(views.indexOf(view), 1)
  expect(revoke).toHaveBeenCalledWith('blob:image')
})
