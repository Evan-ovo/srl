import { Unzip, UnzipInflate } from 'fflate'
import { zipArchiveChunks } from '../utils/ZipArchiveStream'

export const EXTRA_STORY_TEXT_ACCEPT =
  '.txt,.md,.doc,.docx,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 255 && bytes[1] === 254)
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 254 && bytes[1] === 255)
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}

async function docxText(file: File, signal?: AbortSignal): Promise<string> {
  let parts: Uint8Array<ArrayBuffer>[] = [],
    size = 0,
    found = false,
    complete = false
  let failure: Error | undefined
  const unzip = new Unzip((entry) => {
    if (entry.name !== 'word/document.xml') return
    if (found) throw new Error('Word 正文条目重复')
    found = true
    entry.ondata = (error, chunk, final) => {
      if (failure) return
      if (error) {
        failure = error
        return
      }
      size += chunk.length
      if (size > MAX_SOURCE_BYTES) {
        failure = new Error('Word 正文 XML 超过 16 MiB，请拆分文档')
        entry.terminate()
        parts = []
        return
      }
      parts.push(new Uint8Array(chunk))
      complete = final
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  for await (const chunk of zipArchiveChunks(
    file,
    (plan) => {
      if (plan.uncompressedBytes > MAX_SOURCE_BYTES)
        throw new Error('Word 正文 XML 超过 16 MiB，请拆分文档')
    },
    false,
    (path) => path === 'word/document.xml',
    signal,
  )) {
    unzip.push(chunk, false)
    if (failure) throw failure
  }
  unzip.push(new Uint8Array(), true)
  if (failure) throw failure
  if (!found || !complete) throw new Error('Word 文件缺少完整正文，可能已损坏或加密')
  const xml = await new Blob(parts).text()
  signal?.throwIfAborted()
  if (/<!DOCTYPE/iu.test(xml)) throw new Error('Word 正文 XML 格式无效')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('Word 正文 XML 格式无效')
  const body = Array.from(document.getElementsByTagNameNS('*', 'body')).find((element) =>
    WORD_NAMESPACES.has(element.namespaceURI ?? ''),
  )
  if (!body) throw new Error('Word 文件缺少正文')
  const chunks: string[] = []
  function visit(element: Element) {
    const word = WORD_NAMESPACES.has(element.namespaceURI ?? '')
    if (word && ['del', 'instrText'].includes(element.localName)) return
    if (word && element.localName === 't') {
      chunks.push(element.textContent ?? '')
      return
    }
    if (word && ['br', 'cr'].includes(element.localName)) {
      chunks.push('\n')
      return
    }
    if (word && element.localName === 'tab') {
      chunks.push('\t')
      return
    }
    for (const child of element.children) visit(child)
    if (word && element.localName === 'p') chunks.push('\n')
    if (word && element.localName === 'tc') {
      if (chunks.at(-1) === '\n') chunks.pop()
      chunks.push('\t')
    }
    if (word && element.localName === 'tr') {
      if (chunks.at(-1) === '\t') chunks.pop()
      chunks.push('\n')
    }
  }
  visit(body)
  if (chunks.at(-1) === '\n') chunks.pop()
  return chunks.join('')
}

/** Local, single-file body extraction. Images, macros and document code are never executed. */
export async function extractExtraStoryText(file: File, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!file.size || file.size > MAX_SOURCE_BYTES)
    throw new Error('请选择非空且不超过 16 MiB 的 TXT/Word 文件')
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  let text: string
  if (extension === 'docx') text = await docxText(file, signal)
  else if (extension === 'doc') {
    const { default: docToText } = await import('../vendor/legacy-word/DocToText.js')
    const bytes = await file.arrayBuffer()
    signal?.throwIfAborted()
    const body = docToText(new Uint8Array(bytes))
    if (body === null)
      throw new Error(
        '无法读取此 DOC，文件可能已加密、损坏或版本过旧；请用 Word 另存为 DOCX 后导入',
      )
    text = body
  } else if (extension === 'txt' || extension === 'md')
    text = decodeText(new Uint8Array(await file.arrayBuffer()))
  else throw new Error('请选择 TXT、MD、DOC 或 DOCX 文件')
  signal?.throwIfAborted()
  if (!text.trim()) throw new Error('文件中没有可提取的正文；图片扫描件需先转成文字')
  if (text.length > 1_000_000) throw new Error('番外正文超过 1000000 字符，请拆分文件')
  return text
}
