import JSZip from 'jszip'
import { attachmentZipDirectory } from './AttachmentDocument'

const WORD_NS = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
export interface WordTextField {
  text: string
  original: string
  paragraph: number
}
export interface WordTextEditor {
  fields: WordTextField[]
  setText(index: number, text: string): void
  file(): Promise<File>
}

/** Edit only existing body text runs. Styles, tables, drawings and other package parts survive. */
export async function openAttachmentWord(
  file: File,
  signal?: AbortSignal,
): Promise<WordTextEditor> {
  if (!/\.docx$/iu.test(file.name))
    throw new Error('旧版 DOC 暂只支持查看；请另存为 DOCX 后编辑并保留排版')
  if (file.size > 16 * 1024 * 1024) throw new Error('此 Word 超过 16 MiB 编辑范围，仍可完整导出')
  const entries = await attachmentZipDirectory(file, signal)
  const bodyEntry = entries.find((entry) => entry.name === 'word/document.xml')
  if (!bodyEntry) throw new Error('Word 缺少正文')
  if (
    entries.reduce((sum, entry) => sum + entry.size, 0) > 64 * 1024 * 1024 ||
    bodyEntry.size > 16 * 1024 * 1024
  )
    throw new Error('Word 展开内容超过编辑范围，仍可完整导出')
  const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()))
  const source = await zip.file('word/document.xml')?.async('string')
  signal?.throwIfAborted()
  if (!source || /<!DOCTYPE/iu.test(source)) throw new Error('Word 正文无效或已加密')
  const xml = new DOMParser().parseFromString(source, 'application/xml')
  if (xml.getElementsByTagName('parsererror').length) throw new Error('Word 正文 XML 已损坏')
  const isWord = (element: Element, name: string) =>
    WORD_NS.has(element.namespaceURI ?? '') && element.localName === name
  const body = [...xml.getElementsByTagNameNS('*', 'body')].find((element) =>
    isWord(element, 'body'),
  )
  if (!body) throw new Error('Word 缺少正文')
  const fields: WordTextField[] = []
  const groups: Element[][] = []
  const paragraphs = [...body.getElementsByTagNameNS('*', 'p')].filter((element) =>
    isWord(element, 'p'),
  )
  for (const [index, paragraph] of paragraphs.entries()) {
    let group: Element[] = []
    const flush = () => {
      if (!group.length) return
      const text = group.map((element) => element.textContent ?? '').join('')
      groups.push(group)
      fields.push({ text, original: text, paragraph: index + 1 })
      group = []
    }
    const visit = (element: Element) => {
      if (element !== paragraph && isWord(element, 'p')) return
      // Deleted revisions and field instructions are document structure, not editable prose.
      if (isWord(element, 'del') || isWord(element, 'instrText')) return
      if (isWord(element, 't')) {
        group.push(element)
        return
      }
      if (isWord(element, 'br') || isWord(element, 'tab') || isWord(element, 'cr')) {
        flush()
        return
      }
      for (const child of element.children) visit(child)
    }
    visit(paragraph)
    flush()
  }
  if (!fields.length) throw new Error('此文档没有可编辑的正文文字，原文档仍可查看和导出')
  return {
    fields,
    setText(index, text) {
      const field = fields[index]
      const nodes = groups[index]
      if (!field || !nodes) throw new Error('正文片段已经不存在')
      if (/[\r\n\t]/u.test(text))
        throw new Error('为保留排版，请只修改段内文字；原有换行和制表位置保持不变')
      if ([...text].some((char) => char.codePointAt(0)! < 32))
        throw new Error('正文包含 Word 不支持的控制字符')
      const previous = field.text
      let start = 0
      while (start < previous.length && start < text.length && previous[start] === text[start])
        start++
      let suffix = 0
      while (
        suffix < previous.length - start &&
        suffix < text.length - start &&
        previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]
      )
        suffix++
      const end = previous.length - suffix
      const inserted = text.slice(start, text.length - suffix)
      let offset = 0
      let placed = false
      for (const [nodeIndex, node] of nodes.entries()) {
        const value = node.textContent ?? ''
        const nodeStart = offset
        offset += value.length
        // At a boundary, new text inherits the following run's style; appending uses the last run.
        const ownsInsertion = !placed && (start < offset || nodeIndex === nodes.length - 1)
        const left = value.slice(0, Math.max(0, Math.min(value.length, start - nodeStart)))
        const right = value.slice(Math.max(0, Math.min(value.length, end - nodeStart)))
        const next = left + (ownsInsertion ? inserted : '') + right
        if (ownsInsertion) placed = true
        if (next !== value) {
          node.textContent = next
          node.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
        }
      }
      field.text = text
    },
    async file() {
      signal?.throwIfAborted()
      if (!fields.some((field) => field.text !== field.original)) return file
      zip.file('word/document.xml', new XMLSerializer().serializeToString(xml))
      const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
      signal?.throwIfAborted()
      return new File([new Uint8Array(bytes)], file.name, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    },
  }
}
