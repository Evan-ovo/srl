import { createCloudReadBudget } from './CloudBackupHttp'
import { hashCloudBlob } from './CloudArchiveCodec'
import type { GitHubBundleManifest } from './GitHubBackupBundle'
import type { CloudBackupTransportContext } from './CloudBackupTransportContext'
import { withAbort } from '../utils/Abortable'

export interface CloudReadPart {
  key: string
  size: number
  sha256: string
  describeFailure?: (error: unknown) => unknown
  download(signal: AbortSignal): Promise<Response>
}

/** One bounded transport window; failure cancels only unshared reads of that resource. */
export function createCloudObjectReader(
  context: CloudBackupTransportContext,
  provider: string,
  resolve: (object: GitHubBundleManifest) => Promise<CloudReadPart[]>,
  concurrency: number,
  byteBudget: number,
): (object: GitHubBundleManifest) => Promise<Blob> {
  const reserve = createCloudReadBudget(concurrency, byteBudget)
  let cached: { key: string; blob: Blob } | undefined
  context.signal?.addEventListener(
    'abort',
    () => {
      cached = undefined
    },
    { once: true },
  )
  type Entry = {
    promise: Promise<Blob>
    users: number
    settled: boolean
    release?: () => void
    blob?: Blob
    controller: AbortController
  }
  const inFlight = new Map<string, Entry>()
  const acquire = (part: CloudReadPart, fileName: string) => {
    context.signal?.throwIfAborted()
    if (cached?.key === part.key)
      return { promise: Promise.resolve(cached.blob), release: () => undefined }
    let entry = inFlight.get(part.key)
    if (!entry) {
      // A tiny unique tail must not evict the large verified chunk shared by later originals.
      const controller = new AbortController()
      const abort = () => controller.abort(context.signal?.reason)
      if (context.signal?.aborted) abort()
      else context.signal?.addEventListener('abort', abort, { once: true })
      const created = { users: 0, settled: false, controller } as Entry
      created.promise = (async () => {
        created.release = await reserve(part.size, controller.signal)
        controller.signal.throwIfAborted()
        const response = await part.download(controller.signal)
        const blob = await context.readResponseBlob(response, part.size, fileName)
        controller.signal.throwIfAborted()
        if (blob.size !== part.size || (await hashCloudBlob(blob)) !== part.sha256)
          throw new Error(`${provider} 对象分块校验失败：${part.key}`)
        controller.signal.throwIfAborted()
        created.blob = blob
        return blob
      })()
        .catch((error: unknown) => {
          if (controller.signal.aborted) throw controller.signal.reason
          throw part.describeFailure?.(error) ?? error
        })
        .finally(() => {
          context.signal?.removeEventListener('abort', abort)
          controller.abort()
          created.settled = true
          if (!created.users) created.release?.()
        })
      void created.promise.catch(() => undefined)
      inFlight.set(part.key, created)
      entry = created
    }
    const held = entry
    held.users++
    let released = false
    return {
      promise: held.promise,
      release: () => {
        if (released) return
        released = true
        held.users--
        // The first consumer releases the transport slot. Other consumers may wait
        // for earlier chunks in a different order; retaining the slot deadlocks them.
        if (held.settled) held.release?.()
        if (held.users) return
        if (inFlight.get(part.key) === held) inFlight.delete(part.key)
        if (!held.settled) held.controller.abort(new DOMException('资源读取已结束', 'AbortError'))
        if (
          !context.signal?.aborted &&
          held.blob &&
          part.size <= byteBudget &&
          (!cached || part.size >= cached.blob.size)
        )
          cached = { key: part.key, blob: held.blob }
      },
    }
  }
  return async (object) => {
    context.signal?.throwIfAborted()
    // Resolve all locations before reserving bytes; a slow container cannot starve its head.
    const parts = await resolve(object)
    context.signal?.throwIfAborted()
    // Location/state validation stays first. Native CAS reuse verifies the complete original SHA.
    const local = context.readLocalObject
      ? await withAbort(context.readLocalObject(object), context.signal)
      : undefined
    context.signal?.throwIfAborted()
    if (local) return local
    const leases = new Map<number, ReturnType<typeof acquire>>()
    let next = 0
    let firstFailure: unknown
    let rejectFailure!: (error: unknown) => void
    const failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject
    })
    void failure.catch(() => undefined)
    const fill = () => {
      while (next < parts.length && leases.size < concurrency && !firstFailure) {
        const index = next++
        const lease = acquire(parts[index]!, object.fileName)
        void lease.promise.catch((error: unknown) => {
          if (!firstFailure) {
            firstFailure = error
            rejectFailure(error)
          }
        })
        leases.set(index, lease)
      }
    }
    const blobs: Blob[] = []
    try {
      fill()
      for (const [index, descriptor] of object.parts.entries()) {
        const lease = leases.get(index)!
        const stored = await Promise.race([lease.promise, failure])
        context.signal?.throwIfAborted()
        const blob = stored.slice(
          descriptor.offset ?? 0,
          (descriptor.offset ?? 0) + descriptor.size,
        )
        if (blob.size !== descriptor.size)
          throw new Error(`${provider} 对象分块校验失败：${descriptor.name}`)
        blobs.push(blob)
        leases.delete(index)
        lease.release()
        fill()
      }
      const result = new Blob(blobs, { type: 'application/octet-stream' })
      const part = object.parts.length === 1 && object.parts[0]!
      const verified =
        part &&
        (part.offset ?? 0) === 0 &&
        (part.storedSize ?? part.size) === object.totalSize &&
        part.size === object.totalSize &&
        part.sha256 === object.totalSha256
      if (
        result.size !== object.totalSize ||
        (!verified && (await hashCloudBlob(result)) !== object.totalSha256)
      )
        throw new Error(`${provider} 对象完整性校验失败：${object.fileName}`)
      context.signal?.throwIfAborted()
      return result
    } catch (error) {
      cached = undefined
      throw error
    } finally {
      const pending = [...leases.values()]
      for (const lease of pending) lease.release()
      await Promise.allSettled(pending.map((lease) => lease.promise))
    }
  }
}
