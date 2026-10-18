// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import {
  attachmentFormat,
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
