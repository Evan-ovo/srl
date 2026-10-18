import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { CloudBackupTransport } from './CloudBackupTransport'
class Transport extends CloudBackupTransport {
  context(signal: AbortSignal) {
    return this.getTransportContext(signal)
  }
}
it('aborts only its own real HTTP stream, rejects late reuse, and permits a fresh explicit request', async () => {
  let requests = 0
  let started!: () => void, disconnected!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const stopped = new Promise<void>((resolve) => {
    disconnected = resolve
  })
  const server = createServer((request, response) => {
    requests++
    if (request.url === '/slow') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.write('started')
      response.once('close', disconnected)
      started()
    } else response.end('complete')
  })
  server.listen(5363, '127.0.0.1')
  await once(server, 'listening')
  const controller = new AbortController()
  const transport = new Transport()
  const first = transport.context(controller.signal)
  const second = transport.context(new AbortController().signal)
  try {
    const reading = first
      .cloudFetch('http://127.0.0.1:5363/slow', {}, 'github')
      .then((response) => response.text())
    const rejected = expect(reading).rejects.toBeDefined()
    await ready
    const unrelated = second
      .cloudFetch('http://127.0.0.1:5363/fast', {}, 'github')
      .then((response) => response.text())
    controller.abort(new DOMException('stopped', 'AbortError'))
    await rejected
    await stopped
    expect(await unrelated).toBe('complete')
    const count = requests
    await expect(
      Promise.resolve().then(() => first.cloudFetch('http://127.0.0.1:5363/late', {}, 'github')),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toBe(count)
    expect(
      await (
        await transport
          .context(new AbortController().signal)
          .cloudFetch('http://127.0.0.1:5363/retry', {}, 'github')
      ).text(),
    ).toBe('complete')
    expect(requests).toBe(count + 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
