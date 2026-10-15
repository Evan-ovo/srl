import type { ResourceService } from './ResourceService'
import { JsonResourceParser } from '../parser/JsonResourceParser'
import { RESOURCE_TYPE, getRelatedResourceIds, type Resource } from '../types/Resource'
import { parseGreetingResource } from '../types/GreetingResource'
import { inspectGreetingScripts, type GreetingScriptChoice } from '../utils/GreetingScriptMerge'
import { isRecord } from '../utils/UnknownValue'
import { hashBytes } from './HashService'
import {
  createModifiedCharacterResource,
  readCharacterCardOverrides,
} from '../utils/CharacterCardCustomization'

/** Coordinates the existing import/version owners; does not maintain another resource store. */
export class GreetingResourceService {
  private saveQueue: Promise<unknown> = Promise.resolve()
  // Keep only digests, never greeting text or files. Content changes naturally invalidate a hit.
  private readonly contentSignatures = new Map<string, string>()
  private rememberSignature(hash: string, signature: string): void {
    if (!hash) return
    this.contentSignatures.delete(hash)
    this.contentSignatures.set(hash, signature)
    if (this.contentSignatures.size > 512)
      this.contentSignatures.delete(this.contentSignatures.keys().next().value!)
  }
  private readonly savedListeners = new Set<() => void>()
  onSaved(listener: () => void): () => void {
    this.savedListeners.add(listener)
    return () => {
      this.savedListeners.delete(listener)
    }
  }
  private saved(resource: Resource): Resource {
    this.savedListeners.forEach((listener) => listener())
    return resource
  }
  private readonly resources: ResourceService
  constructor(resources: ResourceService) {
    this.resources = resources
  }

  async save(file: File): Promise<Resource> {
    const operation = this.saveQueue.then(() => this.saveOnce(file))
    this.saveQueue = operation.catch(() => undefined)
    return operation
  }

  private async saveOnce(file: File): Promise<Resource> {
    const document = parseGreetingResource(JSON.parse(await file.text()))
    const content = (value: typeof document) =>
      hashBytes(
        new TextEncoder().encode(
          JSON.stringify([value.first_mes, value.alternate_greetings, value.companion_scripts]),
        ),
      )
    const signature = await content(document)
    const candidates = await this.resources.listResourceListSummaries({
      types: [RESOURCE_TYPE.GREETING],
    })
    for (const candidate of candidates) {
      const cached = candidate.contentHash
        ? this.contentSignatures.get(candidate.contentHash)
        : undefined
      if (cached && cached !== signature) continue
      const existing = await this.resources.get(candidate.id)
      if (!existing) continue
      if (cached === signature && existing.contentHash === candidate.contentHash)
        return this.saved(existing)
      let value: typeof document
      try {
        value = parseGreetingResource(JSON.parse(await existing.originalBlob.text()))
      } catch {
        continue
      }
      const existingSignature = await content(value)
      this.rememberSignature(existing.contentHash, existingSignature)
      if (existingSignature === signature) return this.saved(existing)
    }
    const parsed = await new JsonResourceParser().parse(file)
    if (parsed.type !== RESOURCE_TYPE.GREETING) throw new Error('请选择开场白资源文件')
    const result = await this.resources.importPreparedFile(file, parsed)
    if (result.status === 'failed' || result.status === 'versionCandidate')
      throw new Error(result.status === 'failed' ? result.message : '开场白保存失败')
    this.rememberSignature(result.resource.contentHash, signature)
    return this.saved(result.resource)
  }

  async apply(
    greetingId: string,
    characterId: string,
    mode: 'version' | 'new',
    expectedHash: string,
    scriptChoice?: GreetingScriptChoice,
  ): Promise<Resource> {
    const [greeting, character] = await Promise.all([
      this.resources.get(greetingId),
      this.resources.get(characterId),
    ])
    if (!greeting || greeting.type !== RESOURCE_TYPE.GREETING)
      throw new Error('开场白资源已经不存在')
    if (!character || character.type !== RESOURCE_TYPE.CHARACTER_CARD)
      throw new Error('请选择仍然存在的角色卡')
    if (character.contentHash !== expectedHash) throw new Error('角色卡已更新，请重新选择后预览')
    const incoming = parseGreetingResource(
      JSON.parse(await greeting.originalBlob.text()),
    ).companion_scripts
    if (incoming.length && isRecord(character.metadata.card)) {
      const existing = inspectGreetingScripts(character.metadata.card, incoming)
      const hasMissing =
        incoming.length > 0 &&
        !incoming.every((script) =>
          inspectGreetingScripts(character.metadata.card as Record<string, unknown>, [script]).some(
            (item) => item.identical,
          ),
        )
      if (existing.length && hasMissing && !scriptChoice)
        throw new Error('请先选择配套脚本的处理方式')
    }
    const related = (
      await Promise.all(getRelatedResourceIds(character).map((id) => this.resources.get(id)))
    ).filter((item): item is Resource => Boolean(item))
    const overrides = {
      ...readCharacterCardOverrides(character.metadata),
      greetingResourceId: greeting.id,
    }
    const modified = await createModifiedCharacterResource(
      {
        ...character,
        metadata: { ...character.metadata, characterOverrides: overrides },
      },
      [...related.filter((item) => item.id !== greeting.id), greeting],
      scriptChoice,
    )
    if ((await this.resources.get(characterId))?.contentHash !== expectedHash)
      throw new Error('角色卡已更新，请重新选择后预览')
    const file = new File([modified.originalBlob], character.fileName, { type: modified.mimeType })
    if (mode === 'version')
      return this.saved(
        await this.resources.importAsVersion(
          file,
          characterId,
          true,
          `应用开场白：${greeting.name}`,
          undefined,
          {},
          true,
        ),
      )
    const parsed = await new JsonResourceParser().parse(
      new File([JSON.stringify(modified.metadata.card)], 'card.json', { type: 'application/json' }),
    )
    const result = await this.resources.importPreparedFile(
      file,
      {
        ...parsed,
        name: `${character.name} · ${greeting.name}`,
        thumbnailBlob: character.thumbnailBlob,
        metadata: {
          ...modified.metadata,
          cardContentHash: undefined,
          cardCoreHash: undefined,
          cardFingerprintVersion: undefined,
          manuallyBoundResourceIds: undefined,
        },
      },
      { allowContentDuplicate: true },
    )
    if (result.status !== 'imported')
      throw new Error(result.status === 'failed' ? result.message : '另存角色卡失败')
    return this.saved(result.resource)
  }
}
