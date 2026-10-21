import { extractExtraStoryText } from '../parser/ExtraStoryText'
import { zipArchiveChunks } from '../utils/ZipArchiveStream'

export function attachmentFormat(
  name: string,
):
  | 'txt'
  | 'markdown'
  | 'word'
  | 'pdf'
  | 'zip'
  | 'audio'
  | 'video'
  | 'image'
  | 'code'
  | 'table'
  | 'other' {
  const ext = name.split('.').at(-1)?.toLowerCase()
  if (ext === 'txt') return 'txt'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (ext === 'pdf' || ext === 'zip') return ext
  if (ext && ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'].includes(ext))
    return 'audio'
  if (ext && ['mp4', 'm4v', 'webm', 'ogv', 'mov'].includes(ext)) return 'video'
  if (ext && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico'].includes(ext))
    return 'image'
  if (ext === 'csv' || ext === 'tsv') return 'table'
  if (
    ext &&
    [
      'json',
      'jsonl',
      'yaml',
      'yml',
      'xml',
      'html',
      'htm',
      'js',
      'mjs',
      'cjs',
      'ts',
      'tsx',
      'jsx',
      'vue',
      'css',
      'scss',
      'less',
      'ini',
      'conf',
      'cfg',
      'log',
      'py',
      'sh',
      'bat',
      'sql',
      'srt',
      'vtt',
      'lrc',
    ].includes(ext)
  )
    return 'code'
  return 'other'
}

/** Known extensions also repair empty/generic MIME types without decoding media bytes. */
export function attachmentMediaType(name: string): string {
  const types: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    mov: 'video/quicktime',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  }
  return types[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** One page only: do not materialize millions of CSV rows to render a small table. */
export function attachmentTablePage(source: string, delimiter: ',' | '\t', start = 0) {
  const rows: string[][] = []
  let offset = start
  while (offset < source.length && rows.length < 50) {
    const row: string[] = []
    let value = '',
      quoted = false,
      closed = false
    for (;;) {
      const char = source[offset]
      if (char === undefined) {
        if (quoted) throw new Error('表格引号未闭合，请切换原文查看')
        row.push(value)
        break
      }
      offset++
      if (quoted) {
        if (char === '"') {
          if (source[offset] === '"') {
            value += '"'
            offset++
          } else {
            quoted = false
            closed = true
          }
        } else value += char
      } else if (char === delimiter || char === '\n' || char === '\r') {
        row.push(value)
        if (row.length > 200) throw new Error('此表格超过 200 列展示范围，请切换原文查看')
        value = ''
        closed = false
        if (char !== delimiter) {
          if (char === '\r' && source[offset] === '\n') offset++
          break
        }
      } else if (char === '"' && !value && !closed) quoted = true
      else {
        if (closed || char === '"') throw new Error('表格引号格式异常，请切换原文查看')
        value += char
      }
    }
    if (row.length > 200) throw new Error('此表格超过 200 列展示范围，请切换原文查看')
    rows.push(row)
  }
  return { rows, next: offset, hasMore: offset < source.length }
}

export async function readAttachmentText(file: File, signal?: AbortSignal): Promise<string> {
  if (file.size > 16 * 1024 * 1024) throw new Error('此文件超过 16 MiB 文本预览范围，仍可完整导出')
  if (attachmentFormat(file.name) === 'word') return extractExtraStoryText(file, signal)
  const bytes = new Uint8Array(await file.arrayBuffer())
  signal?.throwIfAborted()
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}

/** TXT keeps its original file name; Word editing is owned by AttachmentWordEditing. */
export function attachmentTextFile(name: string, text: string): File {
  if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024)
    throw new Error('编辑后的文本超过 16 MiB，请拆分文件')
  if (attachmentFormat(name) !== 'txt') throw new Error('此入口只保存 TXT 正文')
  return new File([text], name, { type: 'text/plain;charset=utf-8' })
}

export async function attachmentZipDirectory(file: Blob, signal?: AbortSignal) {
  let entries: Array<{ name: string; size: number; compressedSize: number }> = []
  // Read the existing validated central directory only; never inflate or write entries.
  for await (const chunk of zipArchiveChunks(
    file,
    undefined,
    true,
    undefined,
    signal,
    (directory) => {
      entries = directory
    },
    true,
  ))
    void chunk
  signal?.throwIfAborted()
  return entries
}
