/** @vitest-environment node */
import assert from 'node:assert/strict'
import { beforeEach, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  chunks: [] as string[],
  paths: [] as string[],
  deleted: [] as string[],
  shared: [] as string[],
  onWrite: async (): Promise<void> => undefined,
  onShare: async (): Promise<void> => undefined,
}))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Filesystem: {
    readdir: async () => ({ files: [] }),
    writeFile: async ({ data, path }: { data: string; path: string }) => {
      state.paths.push(path)
      state.chunks.push(data)
      await state.onWrite()
    },
    appendFile: async ({ data }: { data: string }) => {
      state.chunks.push(data)
      await state.onWrite()
    },
    deleteFile: async ({ path }: { path: string }) => {
      state.deleted.push(path)
    },
    rmdir: async ({ path }: { path: string }) => {
      state.deleted.push(path)
    },
    getUri: async ({ path }: { path: string }) => ({ uri: `content://${path}` }),
  },
}))
vi.mock('@capacitor/share', () => ({
  Share: {
    share: async ({ url }: { url: string }) => {
      state.shared.push(url)
      await state.onShare()
    },
  },
}))
vi.mock('../types/Resource', () => ({ RESOURCE_TYPE: {}, RESOURCE_TYPE_LABELS: {} }))

import { downloadBlob, shareNativeStream } from './LibraryFormatting'
import { taskCenter } from '../core/TaskCenter'

beforeEach(() => {
  state.chunks = []
  state.paths = []
  state.deleted = []
  state.shared = []
  state.onWrite = async () => undefined
  state.onShare = async () => undefined
  for (const task of taskCenter.list()) taskCenter.dismiss(task.operationId)
})

it('shares an exact file through the common bounded writer with truthful phases', async () => {
  const source = Uint8Array.from({ length: 1_200_007 }, (_, i) => i % 251)
  state.onShare = async () => {
    const task = taskCenter.active()[0]!
    assert.equal(task.phase, '等待系统分享')
    assert.equal(task.cancelable, false)
    assert.equal(task.transfer, undefined)
  }
  await downloadBlob(new Blob([source]), 'test.bin')
  assert.equal(state.chunks.length, 3)
  assert.deepEqual(
    Buffer.concat(state.chunks.map((value) => Buffer.from(value, 'base64'))),
    Buffer.from(source),
  )
  assert.equal(state.deleted.length, 0)
  assert.equal(state.shared.length, 1)
  assert.equal(taskCenter.list()[0]?.status, 'completed')
})

it('does not open a browser download or system share after cancellation and clears only its export directory', async () => {
  state.onWrite = async () => {
    const task = taskCenter.active()[0]!
    taskCenter.cancel(task.operationId)
  }
  await assert.rejects(
    downloadBlob(new Blob([new Uint8Array(1_200_007)]), 'test.bin'),
    /导出已取消/,
  )
  assert.equal(state.chunks.length, 1)
  assert.equal(state.shared.length, 0)
  assert.equal(state.deleted.length, 1)
  assert.match(state.paths[0]!, /^exports\/\d+-[0-9a-f-]{36}\/test\.bin$/)
  assert.equal(state.deleted[0], state.paths[0]!.slice(0, state.paths[0]!.lastIndexOf('/')))
  assert.equal(taskCenter.list()[0]?.status, 'cancelled')
})

it('surfaces write failures and cleans the current partial cache file', async () => {
  state.onWrite = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(downloadBlob(new Blob(['abc']), 'test.txt'), /disk full/)
  assert.equal(state.deleted.length, 1)
  assert.equal(state.deleted[0], state.paths[0]!.slice(0, state.paths[0]!.lastIndexOf('/')))
  assert.equal(state.shared.length, 0)
  assert.equal(taskCenter.list()[0]?.status, 'failed')
})

it('keeps a handed-off file available to other apps even if the share promise rejects', async () => {
  state.onShare = async () => {
    throw new Error('share cancelled')
  }
  await assert.rejects(downloadBlob(new Blob(['abc']), 'test.txt'), /share cancelled/)
  assert.equal(state.deleted.length, 0)
  assert.equal(state.shared.length, 1)
  assert.equal(taskCenter.list()[0]?.status, 'failed')
})

it('supports empty files without reporting a fictional byte total', async () => {
  await downloadBlob(new Blob(), 'empty.txt')
  assert.deepEqual(state.chunks, [''])
  assert.equal(state.shared.length, 1)
  assert.equal(taskCenter.list()[0]?.status, 'completed')
})

it('streams an archive into the existing cache with one owning task and shares only complete bytes', async () => {
  const bytes = Uint8Array.from({ length: 1_200_007 }, (_, index) => index % 251)
  const operationId = taskCenter.start({ name: '下载云备份', cancelable: true })
  const onHandoff = vi.fn()
  state.onShare = async () => {
    assert.deepEqual(
      Buffer.concat(state.chunks.map((value) => Buffer.from(value, 'base64'))),
      Buffer.from(bytes),
    )
    assert.equal(taskCenter.list().length, 1)
    assert.equal(onHandoff.mock.calls.length, 1)
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  await shareNativeStream(stream, 'cloud.zip', { operationId, onHandoff })
  assert.equal(state.chunks.length, 3)
  assert.equal(state.shared.length, 1)
  assert.equal(taskCenter.list()[0]?.status, 'running') // The existing download owner finishes its own task.
})

it('cancels a streaming archive during a native write and clears its partial file before handoff', async () => {
  const controller = new AbortController()
  const operationId = taskCenter.start({ name: '下载云备份', cancelable: true })
  const onHandoff = vi.fn()
  state.onWrite = async () => controller.abort(new DOMException('停止下载', 'AbortError'))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1_200_007))
      controller.close()
    },
  })
  await assert.rejects(
    shareNativeStream(stream, 'cloud.zip', { operationId, signal: controller.signal, onHandoff }),
    { name: 'AbortError' },
  )
  assert.equal(state.chunks.length, 1)
  assert.equal(state.deleted.length, 1)
  assert.equal(state.shared.length, 0)
  assert.equal(onHandoff.mock.calls.length, 0)
})

it('preserves an empty streaming archive as an actual empty file', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  await shareNativeStream(stream, 'empty.zip')
  assert.deepEqual(state.chunks, [''])
  assert.equal(state.shared.length, 1)
})
