// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  attachmentFormat,
  attachmentMediaType,
  attachmentTablePage,
  attachmentTextFile,
  attachmentZipDirectory,
  readAttachmentText,
} from './AttachmentDocument'

beforeAll(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
})
afterAll(() => vi.unstubAllGlobals())
describe('attachment text and archive views', () => {
  it('recognizes media, code, subtitles and tables without exposing executable formats as documents', () => {
    for (const name of ['a.MP3', 'a.m4a', 'a.wav', 'a.ogg', 'a.flac'])
      expect(attachmentFormat(name)).toBe('audio')
    for (const name of ['a.MP4', 'a.webm', 'a.mov']) expect(attachmentFormat(name)).toBe('video')
    for (const name of ['a.jpg', 'a.gif', 'a.avif']) expect(attachmentFormat(name)).toBe('image')
    for (const name of ['a.jsonl', 'a.html', 'a.js', 'a.yml', 'a.srt', 'a.lrc'])
      expect(attachmentFormat(name)).toBe('code')
    expect(attachmentFormat('a.tsv')).toBe('table')
    expect(attachmentMediaType('a.MP3')).toBe('audio/mpeg')
    expect(attachmentMediaType('a.mp4')).toBe('video/mp4')
    expect(attachmentFormat('a.svg')).toBe('other')
    expect(attachmentFormat('a.exe')).toBe('other')
  })
  it('pages CSV including quoted newlines, escaped quotes, empty cells and CRLF without reading later rows', () => {
    const source =
      '名称,说明,空\r\n"a,b","第一行\r\n第二行 ""引号""",\r\n' + 'x,y,z\n'.repeat(100) + '"未闭合'
    const first = attachmentTablePage(source, ',')
    expect(first.rows).toHaveLength(50)
    expect(first.rows[1]).toEqual(['a,b', '第一行\r\n第二行 "引号"', ''])
    expect(first.hasMore).toBe(true)
    const second = attachmentTablePage(source, ',', first.next)
    expect(second.rows).toHaveLength(50)
    expect(() => attachmentTablePage(source, ',', second.next)).toThrow('未闭合')
    expect(attachmentTablePage('a\tb\r\n1\t2', '\t').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(attachmentTablePage('a,b,', ',').rows).toEqual([['a', 'b', '']])
    expect(attachmentTablePage('', ',').rows).toEqual([])
    expect(() => attachmentTablePage('"a"x,b', ',')).toThrow('引号格式')
    expect(() => attachmentTablePage('x,'.repeat(200), ',')).toThrow('200 列')
  })
  it('reads Markdown text with the existing decoder and preview limit without offering text writes', async () => {
    expect(attachmentFormat('README.MD')).toBe('markdown')
    expect(attachmentFormat('作者.markdown')).toBe('markdown')
    const source = '# 标题\n\n**正文**'
    expect(await readAttachmentText(new File([source], '说明.md'))).toBe(source)
    expect(() => attachmentTextFile('说明.md', '改动')).toThrow('只保存 TXT')
    const large = new File(['original'], '大文件.md')
    Object.defineProperty(large, 'size', { value: 16 * 1024 * 1024 + 1 })
    const read = vi.spyOn(large, 'arrayBuffer')
    await expect(readAttachmentText(large)).rejects.toThrow('16 MiB')
    expect(read).not.toHaveBeenCalled()
  })
  it('reads empty TXT, UTF16 and GBK and writes UTF8 without changing newlines', async () => {
    expect(await readAttachmentText(new File([], '空.txt'))).toBe('')
    expect(
      await readAttachmentText(
        new File([new Uint8Array([255, 254, 45, 78, 135, 101])], '中文.txt'),
      ),
    ).toBe('中文')
    expect(
      await readAttachmentText(new File([new Uint8Array([214, 208, 206, 196])], '中文.txt')),
    ).toBe('中文')
    const edited = attachmentTextFile('说明.txt', '改后\r\n第二行')
    expect(await edited.text()).toBe('改后\r\n第二行')
  })
  it('lists a ZIP directory without inflating entries or reading the payload', async () => {
    const bytes = zipSync(
      { '目录/内容.txt': strToU8('内容'.repeat(100000)), 'empty/': new Uint8Array() },
      { level: 0 },
    )
    const file = new File([new Uint8Array(bytes)], '素材.zip')
    const slice = vi.spyOn(file, 'slice')
    const buffer = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('不能整文件读取'))
    const entries = await attachmentZipDirectory(file)
    expect(entries[0]).toMatchObject({ name: '目录/内容.txt', size: 600000 })
    expect(entries[1]?.name).toBe('empty/')
    expect(buffer).not.toHaveBeenCalled()
    expect(
      slice.mock.calls.reduce((sum, [start = 0, end = file.size]) => sum + end - start, 0),
    ).toBeLessThan(67000)
  })
  it('reports corrupt/encrypted/unsafe ZIP and cancellation without affecting its original', async () => {
    await expect(attachmentZipDirectory(new Blob(['not ZIP']))).rejects.toThrow()
    const unsafe = new Blob([new Uint8Array(zipSync({ '../escape.txt': strToU8('x') }))])
    await expect(attachmentZipDirectory(unsafe)).rejects.toThrow('不安全')
    const c = new AbortController()
    c.abort()
    await expect(attachmentZipDirectory(new Blob([]), c.signal)).rejects.toThrow()
    expect(attachmentFormat('作者.DOCX')).toBe('word')
    expect(attachmentFormat('files.7z')).toBe('other')
  })
})
