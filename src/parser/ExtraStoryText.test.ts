// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { extractExtraStoryText } from './ExtraStoryText'
const file = (data: string | Uint8Array, name: string) =>
  new NodeFile([data], name) as unknown as File
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const docx = (body: string) =>
  file(
    zipSync({
      'word/document.xml': strToU8(
        `<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`,
      ),
      'word/media/image.png': new Uint8Array(1000),
    }),
    '番外.docx',
  )
describe('local extra-story document extraction', () => {
  it.each([
    [new TextEncoder().encode('原文\r\n{{user}}'), '原文\r\n{{user}}'],
    [new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]), '中文'],
    [new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]), '中文'],
    [new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), '中文'],
  ])('decodes UTF-8, UTF-16 BOM and GBK without losing text', async (bytes, text) => {
    expect(await extractExtraStoryText(file(bytes, '正文.txt'))).toBe(text)
  })
  it('reads DOCX paragraphs, tabs, breaks and table text without executing content', async () => {
    expect(
      await extractExtraStoryText(
        docx(
          '<w:p><w:r><w:t>第一段 &amp; {{user}}</w:t><w:tab/><w:t>空格</w:t><w:br/><w:t>换行</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>已删除</w:delText></w:r></w:del><w:r><w:t>第二段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        ),
      ),
    ).toBe('第一段 & {{user}}\t空格\n换行\n第二段\n甲\t乙')
  })
  it('reads a real legacy Word97 DOC fixture including lists and tables', async () => {
    const bytes = readFileSync('fixtures/extra-story/word97-showcase.doc')
    const text = await extractExtraStoryText(file(bytes, '旧版.doc'))
    expect(text).toContain('1. Open the OLE2 compound file')
    expect(text).toContain('Introduction\t1')
    expect(text).toContain('Design\tDone\tAlpaq92')
  })
  it('rejects corrupt/encrypted/empty documents and cancellation without returning partial text', async () => {
    for (const source of [
      file('not a word file', 'bad.doc'),
      file(zipSync({ 'other.xml': strToU8('<root/>') }), 'bad.docx'),
      docx('<w:p/>'),
      docx('<w:p>'),
    ]) {
      await expect(extractExtraStoryText(source)).rejects.toThrow()
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractExtraStoryText(file('body', 'body.txt'), controller.signal),
    ).rejects.toThrow()
  })
  it('rejects a cyclic legacy DOC directory chain instead of following repeated sectors', async () => {
    const bytes = new Uint8Array(readFileSync('fixtures/extra-story/word97-showcase.doc'))
    const view = new DataView(bytes.buffer)
    const sectorBytes = 1 << view.getUint16(30, true)
    const directory = view.getUint32(48, true)
    const fat = view.getUint32(76, true)
    view.setUint32((fat + 1) * sectorBytes + directory * 4, directory, true)
    await expect(extractExtraStoryText(file(bytes, 'cyclic.doc'))).rejects.toThrow('无法读取')
  })
})
