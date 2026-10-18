// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { openAttachmentWord } from './AttachmentWordEditing'

beforeAll(() => {
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('Blob', NodeBlob)
})
afterAll(() => vi.unstubAllGlobals())
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const documentXml = `<w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t>你好</w:t></w:r><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>世界</w:t></w:r><w:r><w:drawing><r:embed r:id="image1"/></w:drawing></w:r></w:p><w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>表格正文</w:t><w:tab/><w:t>另一片段</w:t><w:br/><w:t>下一行</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:headerReference r:id="header1"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
const entries = {
  'word/document.xml': strToU8(documentXml),
  'word/styles.xml': strToU8('<styles>作者自定义样式</styles>'),
  'word/header1.xml': strToU8('<header>原始页眉</header>'),
  'word/footer1.xml': strToU8('<footer>原始页脚</footer>'),
  'word/_rels/document.xml.rels': strToU8('<Relationships>图片/超链接关系</Relationships>'),
  'word/media/image1.png': new Uint8Array([137, 80, 78, 71, 0, 255]),
  'customXml/item1.xml': strToU8('<author-data>未知作者数据</author-data>'),
  '[Content_Types].xml': strToU8('<Types>原始内容类型</Types>'),
}
function fixture() {
  return new File([new Uint8Array(zipSync(entries))], '作者原件.docx')
}
function parse(bytes: Uint8Array) {
  return new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml')
}
describe('DOCX text-only editing with original formatting', () => {
  it('keeps every non-body part byte-identical and preserves styles, images, tables, sections and links', async () => {
    const editor = await openAttachmentWord(fixture())
    expect(editor.fields.map((field) => field.text)).toEqual([
      '你好世界',
      '表格正文',
      '另一片段',
      '下一行',
    ])
    editor.setText(0, '你好勇敢世界')
    editor.setText(0, '您好勇敢世界')
    editor.setText(1, '修改表格文字')
    const saved = await editor.file()
    expect(saved.name).toBe('作者原件.docx')
    const result = unzipSync(new Uint8Array(await saved.arrayBuffer()))
    expect(
      Object.keys(result)
        .filter((key) => !key.endsWith('/'))
        .sort(),
    ).toEqual(Object.keys(entries).sort())
    for (const [name, original] of Object.entries(entries)) {
      if (name !== 'word/document.xml')
        expect(Array.from(result[name]!)).toEqual(Array.from(original))
    }
    const xml = parse(result['word/document.xml']!)
    expect(xml.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(
      [...xml.getElementsByTagNameNS(ns, 't')].slice(0, 2).map((el) => el.textContent),
    ).toEqual(['您好', '勇敢世界'])
    for (const tag of ['pPr', 'rPr', 'drawing', 'tblPr', 'tcPr', 'sectPr']) {
      const serialize = (doc: Document) =>
        [...doc.getElementsByTagNameNS(ns, tag)].map((node) =>
          new XMLSerializer().serializeToString(node),
        )
      expect(serialize(xml)).toEqual(serialize(parse(entries['word/document.xml'])))
    }
    expect(xml.getElementsByTagNameNS(ns, 'tab')).toHaveLength(1)
    expect(xml.getElementsByTagNameNS(ns, 'br')).toHaveLength(1)
  })
  it('returns the untouched original when no text changed, and handles deletions/insertion across runs', async () => {
    const file = fixture()
    const editor = await openAttachmentWord(file)
    expect(await editor.file()).toBe(file)
    editor.setText(0, '你世界')
    editor.setText(0, '你世界！')
    editor.setText(2, '')
    const reopened = await openAttachmentWord(await editor.file())
    expect(reopened.fields.map((field) => field.text)).toEqual([
      '你世界！',
      '表格正文',
      '',
      '下一行',
    ])
    expect(() => editor.setText(0, '新增\n段落')).toThrow('保留排版')
  })
  it('does not flatten legacy DOC, malformed documents or unsupported body structures', async () => {
    await expect(openAttachmentWord(new File(['doc'], '旧版.doc'))).rejects.toThrow('另存为 DOCX')
    const malformed = new File(
      [new Uint8Array(zipSync({ 'word/document.xml': strToU8('<broken>') }))],
      '损坏.docx',
    )
    await expect(openAttachmentWord(malformed)).rejects.toThrow('XML')
    const controller = new AbortController()
    controller.abort()
    await expect(openAttachmentWord(fixture(), controller.signal)).rejects.toThrow()
  })
})
