import { describe, expect, it, vi } from 'vitest'
import { CloudBackupTransport } from './CloudBackupTransport'
import type { CloudObjectPlan } from './CloudStructuredSnapshot'
import { hashCloudBlob } from './CloudArchiveCodec'

class Transport extends CloudBackupTransport {
  materialize(plan: CloudObjectPlan, signal?: AbortSignal) {
    return this.materializeCloudObject(plan, signal)
  }
}
const plan = (blob: Blob, hash: string): CloudObjectPlan => ({
  name: 'chunk',
  size: blob.size,
  hash,
  source: { kind: 'range', contentHash: hash, offset: 0, size: blob.size },
  contentType: 'application/octet-stream',
  loadBlob: async () => blob,
})

describe('detached verified cloud upload chunks', () => {
  it('copies only bounded windows and preserves the exact chunk bytes', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 7)
    bytes[bytes.length - 1] = 251
    const source = new Blob([bytes]),
      hash = await hashCloudBlob(source)
    const slice = vi.spyOn(source, 'slice')
    vi.spyOn(source, 'arrayBuffer').mockRejectedValue(Error('whole chunk read forbidden'))
    const output = await new Transport().materialize(plan(source, hash))
    expect(output).not.toBe(source)
    expect(await output.arrayBuffer()).toEqual(bytes.buffer)
    expect(slice).toHaveBeenCalledTimes(4)
    for (const [start, end] of slice.mock.calls)
      expect(end! - start!).toBeLessThanOrEqual(1024 * 1024)
  })
  it('rejects mismatched source bytes before upload', async () => {
    await expect(
      new Transport().materialize(plan(new Blob(['wrong']), 'a'.repeat(64))),
    ).rejects.toThrow('本机摘要校验失败')
  })
  it('does not read another window after cancellation', async () => {
    const source = new Blob([new Uint8Array(3 * 1024 * 1024)]),
      controller = new AbortController()
    const originalSlice = source.slice.bind(source)
    const slice = vi.spyOn(source, 'slice').mockImplementation((start, end) => {
      const part = originalSlice(start, end)
      vi.spyOn(part, 'arrayBuffer').mockImplementation(async () => {
        controller.abort()
        return new ArrayBuffer(part.size)
      })
      return part
    })
    await expect(
      new Transport().materialize(plan(source, 'a'.repeat(64)), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(slice).toHaveBeenCalledOnce()
  })
})
