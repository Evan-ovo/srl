import { describe, expect, it, vi } from 'vitest'

import {
  createStructuredSnapshot,
  decodeStructuredSnapshot,
  encodeStructuredSnapshot,
  isStructuredSnapshot,
  materializeStructuredResources,
  parseStructuredSnapshot,
  structuredSnapshotName,
} from './CloudStructuredSnapshot'
import {
  RESOURCE_TYPE,
  toResourceListSummary,
  toResourceSummary,
  type Resource,
} from '../types/Resource'
import { hashCloudBlob } from './CloudArchiveCodec'
import { SecretResourceService } from './SecretResourceService'
import { parsePersonalResource } from '../types/PersonalResource'
import type { ResourceByteSource } from '../types/ResourceReadSource'

function resource(id: string, body: string): Resource {
  return {
    id,
    type: RESOURCE_TYPE.OTHER,
    name: id,
    description: '',
    fileName: `${id}.json`,
    mimeType: 'application/json',
    fileSize: body.length,
    contentHash: '0'.repeat(64),
    favorite: false,
    categoryId: null,
    tags: [],
    metadata: {},
    originalBlob: new Blob([body], { type: 'application/json' }),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('CloudStructuredSnapshot', () => {
  it('materializes an encrypted or legacy candidate once instead of reopening the full original per part', async () => {
    const original = resource('legacy-original', '')
    original.originalBlob = new Blob([new Uint8Array(33 * 1024 * 1024 + 19)])
    original.fileSize = original.originalBlob.size
    original.contentHash = await hashCloudBlob(original.originalBlob)
    const loadSource = vi.fn(async () => ({
      ...toResourceSummary(original),
      originalSource: original.originalBlob,
      requiresWholeRead: true,
    }))
    const planned = await createStructuredSnapshot(
      [{ summary: toResourceSummary(original), load: async () => original, loadSource }],
      [],
      [],
      { version: 1 },
    )
    expect(planned.objectPlans.length).toBeGreaterThan(1)
    for (const part of planned.objectPlans) {
      expect(part.blob).toBeInstanceOf(Blob)
      expect(await hashCloudBlob(part.blob!)).toBe(part.hash)
    }
    expect(loadSource).toHaveBeenCalledTimes(1)
  })
  it('plans current and historical attachments without hydrating originals and loads only a selected upload range', async () => {
    const original = resource('bounded-media', '')
    original.originalBlob = new Blob([new Uint8Array(33 * 1024 * 1024 + 19)])
    original.fileSize = original.originalBlob.size
    original.contentHash = await hashCloudBlob(original.originalBlob)
    const ranges: number[] = []
    const source: ResourceByteSource = {
      size: original.fileSize,
      text: async () => {
        throw new Error('no full text')
      },
      slice(start = 0, end = original.fileSize) {
        ranges.push(end - start)
        return { arrayBuffer: () => original.originalBlob.slice(start, end).arrayBuffer() }
      },
    }
    let changed = false
    const load = vi.fn(async () => {
      throw new Error('must not hydrate')
    })
    const candidate = {
      summary: toResourceSummary(original),
      load,
      loadSource: async () => ({
        ...toResourceSummary(original),
        updatedAt: changed ? 2 : 1,
        originalSource: source,
      }),
    }
    const planned = await createStructuredSnapshot([candidate], [], [], { version: 1 })
    expect(load).not.toHaveBeenCalled()
    expect(planned.chunks.size).toBe(0)
    expect(planned.objectPlans.every((plan) => !plan.blob)).toBe(true)
    expect(planned.localReadBytes).toBe(original.fileSize)
    expect(ranges.reduce((sum, size) => sum + size, 0)).toBe(original.fileSize)
    expect(Math.max(...ranges)).toBeLessThanOrEqual(1024 * 1024)
    const plan = planned.objectPlans[0]!
    const beforeUpload = ranges.length
    const chunk = await plan.loadBlob!()
    expect(ranges.slice(beforeUpload)).toEqual([plan.size])
    expect(chunk.size).toBeLessThan(original.fileSize)
    expect(await hashCloudBlob(chunk)).toBe(plan.hash)
    changed = true
    await expect(plan.loadBlob!()).rejects.toThrow('资源发生变化')
    changed = false
    const historical = await createStructuredSnapshot([], [candidate], [], { version: 1 })
    expect(historical.snapshot.versions[0]!.id).toBe(original.id)
    expect(historical.descriptorUpdates[0]!.historical).toBe(true)
    expect(load).not.toHaveBeenCalled()
  })
  it('maps large upload chunks back to NativeLibrary byte ranges', async () => {
    const body = new Uint8Array(5 * 1024 * 1024).fill(0x5a)
    const original = resource('large-native', '')
    original.originalBlob = new Blob([body], { type: 'application/octet-stream' })
    original.fileSize = original.originalBlob.size
    original.contentHash = await hashCloudBlob(original.originalBlob)

    const created = await createStructuredSnapshot([original], [], [], { version: 1 })

    expect(created.nativeSources.size).toBe(created.chunks.size)
    for (const [name, source] of created.nativeSources) {
      expect(source.kind).toBe('range')
      if (source.kind !== 'range') throw new Error('large chunk must be a range source')
      expect(source.contentHash).toBe(original.contentHash)
      const nativeSlice = original.originalBlob.slice(source.offset, source.offset + source.size)
      expect(await hashCloudBlob(nativeSlice)).toBe(name.replace('srl-chunk--sha256-', ''))
    }
  })

  it('reuses maintained large-object descriptors when only a new 2 MiB resource is added', async () => {
    const large = resource('descriptor-large', '')
    large.originalBlob = new Blob([new Uint8Array(5 * 1024 * 1024).fill(0x37)])
    large.fileSize = large.originalBlob.size
    large.contentHash = await hashCloudBlob(large.originalBlob)
    const first = await createStructuredSnapshot([large], [], [], { version: 1 })
    const descriptor = first.descriptorUpdates[0]?.descriptor
    expect(descriptor?.parts?.length).toBeGreaterThan(0)
    large.backupDescriptor = descriptor

    const added = resource('descriptor-added', '')
    added.originalBlob = new Blob([new Uint8Array(2 * 1024 * 1024).fill(0x52)])
    added.fileSize = added.originalBlob.size
    added.contentHash = await hashCloudBlob(added.originalBlob)
    const second = await createStructuredSnapshot([large, added], [], [], { version: 1 })

    expect(second.localReadBytes).toBe(added.fileSize)
    expect(second.descriptorUpdates.some((item) => item.id === large.id)).toBe(false)
    expect(second.snapshot.resources.find((item) => item.id === large.id)?.object.parts).toEqual(
      first.snapshot.resources[0]?.object.parts,
    )
  })

  it('plans descriptor-backed resources from summaries without hydrating their original blobs', async () => {
    const original = resource('lazy-descriptor', '{"stable":true}')
    original.contentHash = await hashCloudBlob(original.originalBlob)
    const first = await createStructuredSnapshot([original], [], [], { version: 1 })
    original.backupDescriptor = first.descriptorUpdates[0]?.descriptor
    const load = vi.fn(async () => original)

    const planned = await createStructuredSnapshot(
      [{ summary: toResourceSummary(original), load }],
      [],
      [],
      { version: 1 },
    )

    expect(load).not.toHaveBeenCalled()
    expect(planned.localReadBytes).toBe(0)
    expect(planned.chunks.size).toBe(0)
    expect(planned.objectPlans).toHaveLength(1)
    await expect(planned.objectPlans[0]?.loadBlob?.()).resolves.toBeInstanceOf(Blob)
    expect(load).toHaveBeenCalledOnce()
  })

  it('hydrates partial list summaries before reusing objects so custom metadata is not lost', async () => {
    const original = resource('partial-summary', '{"stable":true}')
    original.metadata = { nested: { value: 'retain' }, longText: 'x'.repeat(4000) }
    original.contentHash = await hashCloudBlob(original.originalBlob)
    const first = await createStructuredSnapshot([original], [], [], { version: 1 })
    original.backupDescriptor = first.descriptorUpdates[0]!.descriptor
    const load = vi.fn(async () => original)
    const next = await createStructuredSnapshot(
      [{ summary: toResourceListSummary(original), summaryIsPartial: true, load }],
      [],
      [],
      { version: 1 },
    )
    expect(next.snapshot.resources[0]!.metadata).toEqual(original.metadata)
    expect(load).toHaveBeenCalledOnce()
    expect(next.localReadBytes).toBe(0)
  })

  it('keeps resource bytes outside the snapshot manifest in content-addressed chunks', async () => {
    const original = resource('one', '{"a":1}')
    original.contentHash = await hashCloudBlob(original.originalBlob)
    const created = await createStructuredSnapshot([original], [], [], {
      version: 1,
    })

    expect(isStructuredSnapshot(created.snapshot)).toBe(true)
    expect('originalBlob' in (created.snapshot.resources[0] ?? {})).toBe(false)
    expect(created.snapshot.resources[0]?.object.parts[0]?.name).toMatch(/^srl-chunk--sha256-/)
    expect(created.chunks.size).toBe(1)

    const parsed = parseStructuredSnapshot(JSON.parse(JSON.stringify(created.snapshot)))
    const restored = await materializeStructuredResources(parsed.resources, async (object) => {
      return new Blob(
        object.parts.map((part) => {
          const stored = created.chunks.get(part.name)!
          return stored.slice(part.offset ?? 0, (part.offset ?? 0) + part.size)
        }),
      )
    })
    expect(await restored[0]?.originalBlob.text()).toBe('{"a":1}')
  })

  it('round-trips an encrypted secret resource through a structured cloud snapshot', async () => {
    const credentials = new Map<string, string>()
    const secrets = new SecretResourceService({
      save: async (key, value) => void credentials.set(key, value),
      read: async (key) => credentials.get(key) ?? '',
      clear: async (key) => void credentials.delete(key),
    })
    const password = 'fixture-secret-password'
    const document = {
      format: 'srl-personal-resource' as const,
      version: 1 as const,
      kind: 'secret' as const,
      name: 'fixture secret',
      text: '',
      url: '',
      attachments: [],
      fields: [{ id: 'token', label: 'Token', value: 'fixture-private-value', private: true }],
    }
    await secrets.setPassword(password)
    try {
      const protectedDocument = await secrets.protect(document)
      const original = resource('encrypted-secret', JSON.stringify(protectedDocument))
      original.type = RESOURCE_TYPE.SECRET
      original.fileName = 'secret.json'
      original.contentHash = await hashCloudBlob(original.originalBlob)
      const created = await createStructuredSnapshot([original], [], [], { version: 1 })
      const snapshot = parseStructuredSnapshot(JSON.parse(JSON.stringify(created.snapshot)))
      const restored = await materializeStructuredResources(
        snapshot.resources,
        async (object) =>
          new Blob(
            object.parts.map((part) => {
              const stored = created.chunks.get(part.name)!
              return stored.slice(part.offset ?? 0, (part.offset ?? 0) + part.size)
            }),
          ),
      )
      const roundTripped = parsePersonalResource(JSON.parse(await restored[0]!.originalBlob.text()))

      await expect(secrets.reveal(roundTripped, password)).resolves.toEqual(document.fields)
    } finally {
      secrets.lock()
    }
  })

  it('creates immutable per-resource objects so changing one of 100 cards adds only one object', async () => {
    const resources = await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const item = resource(`small-${index}`, JSON.stringify({ index, value: `card-${index}` }))
        item.contentHash = await hashCloudBlob(item.originalBlob)
        return item
      }),
    )

    const first = await createStructuredSnapshot(resources, [], [], { version: 1 })
    const descriptors = new Map(first.descriptorUpdates.map((item) => [item.id, item.descriptor]))
    for (const item of resources) item.backupDescriptor = descriptors.get(item.id)

    expect(first.chunks.size).toBe(resources.length)

    const changed = resources[42]!
    changed.originalBlob = new Blob(['{"index":42,"value":"changed-card"}'])
    changed.fileSize = changed.originalBlob.size
    changed.contentHash = await hashCloudBlob(changed.originalBlob)
    const second = await createStructuredSnapshot(resources, [], [], { version: 1 })
    const firstNames = new Set(first.chunks.keys())
    const newUploadObjects = [...second.chunks.keys()].filter((name) => !firstNames.has(name))

    expect(newUploadObjects).toHaveLength(1)
    expect(
      second.snapshot.resources
        .filter((item) => item.id !== changed.id)
        .every((item) => firstNames.has(item.object.parts[0]!.name)),
    ).toBe(true)
  })

  it('compresses metadata-heavy manifests and still reads legacy plain JSON snapshots', async () => {
    const original = resource('heavy-card', '{"card":true}')
    original.contentHash = await hashCloudBlob(original.originalBlob)
    original.metadata = {
      card: {
        name: '测试角色',
        description: '重复的角色设定内容。'.repeat(20_000),
      },
    }
    const created = await createStructuredSnapshot([original], [], [], { version: 1 })
    const plain = new Blob([JSON.stringify(created.snapshot)], { type: 'application/json' })
    const compressed = await encodeStructuredSnapshot(created.snapshot)

    expect(structuredSnapshotName()).toMatch(/\.srlmanifest\.v3\.json\.gz$/)
    expect(compressed.type).toBe('application/gzip')
    expect(compressed.size).toBeLessThan(plain.size / 10)
    await expect(decodeStructuredSnapshot(compressed)).resolves.toEqual(created.snapshot)
    await expect(decodeStructuredSnapshot(plain)).resolves.toEqual(created.snapshot)
  })

  it('keeps high-entropy character card data only in the content object and rebuilds it on restore', async () => {
    let state = 0x12345678
    const highEntropy = Array.from({ length: 512 * 1024 }, () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return String.fromCharCode(33 + (state % 90))
    }).join('')
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '高熵角色卡',
        description: '用于验证真实卡体不会进入快照清单',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        extensions: { embeddedAsset: highEntropy },
      },
    }
    const original = resource('high-entropy-card', JSON.stringify(card))
    original.type = RESOURCE_TYPE.CHARACTER_CARD
    original.mimeType = 'application/json'
    original.metadata = { format: 'json', card, customFlag: 'keep-me' }
    original.contentHash = await hashCloudBlob(original.originalBlob)

    const created = await createStructuredSnapshot([original], [], [], { version: 1 })
    const stored = created.snapshot.resources[0]!
    const compressed = await encodeStructuredSnapshot(created.snapshot)

    expect(stored.metadata.card).toBeUndefined()
    expect(stored.metadata.customFlag).toBe('keep-me')
    expect(compressed.size).toBeLessThan(8 * 1024)

    const restored = await materializeStructuredResources(created.snapshot.resources, async () =>
      original.originalBlob.slice(),
    )
    expect(restored[0]?.metadata.card).toEqual(card)
    expect(restored[0]?.metadata.customFlag).toBe('keep-me')
  })
})

describe('metadata-only descriptor reuse', () => {
  it('preserves full custom metadata without loading an unchanged original until a missing object is needed', async () => {
    const original = resource('unchanged-native', '{"stable":true}')
    original.contentHash = await hashCloudBlob(original.originalBlob)
    original.backupDescriptor = (
      await createStructuredSnapshot([original], [], [], { version: 1 })
    ).descriptorUpdates[0]!.descriptor
    original.metadata = { nested: { value: 'preserve' }, longText: 'x'.repeat(10_000) }
    const metadata = toResourceSummary(original)
    const load = vi.fn(async () => original)
    const loadSummary = vi.fn(async () => metadata)
    const planned = await createStructuredSnapshot(
      [{ summary: toResourceListSummary(original), summaryIsPartial: true, loadSummary, load }],
      [],
      [],
      { version: 1 },
    )
    expect(planned.snapshot.resources[0]!.metadata).toEqual(original.metadata)
    expect(loadSummary).toHaveBeenCalledOnce()
    expect(load).not.toHaveBeenCalled()
    expect(planned.localReadBytes).toBe(0)
    expect(await planned.objectPlans[0]!.loadBlob!()).toBeInstanceOf(Blob)
    expect(load).toHaveBeenCalledOnce()
  })
})
