import { extractExtraStoryText } from '../parser/ExtraStoryText'
import { zipArchiveChunks } from '../utils/ZipArchiveStream'

export function attachmentFormat(name: string): 'txt' | 'word' | 'pdf' | 'zip' | 'other' {
  const ext = name.split('.').at(-1)?.toLowerCase()
  if (ext === 'txt') return 'txt'
  if (ext === 'doc' || ext === 'docx') return 'word'
  if (ext === 'pdf' || ext === 'zip') return ext
  return 'other'
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
