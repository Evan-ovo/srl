import type { Resource, ResourceSummary } from '../types/Resource'
import { includeChatCompanionIds } from '../types/Resource'
import { includeResourceGalleryIds } from '../types/ResourceGallery'
import type { CloudBackupConfig } from '../types/CloudBackup'
import { parsePersonalResource, type PersonalResourceDocument } from '../types/PersonalResource'

export interface PersonalResourceSelection {
  resourceAttachments?: boolean
  resourceGallery?: boolean
  extraStory?: boolean
  pocketPhone?: boolean
  secret?: boolean
  resourceIds?: string[]
}
export interface PlainSecretCopy {
  contentHash: string
  document: PersonalResourceDocument
}

/** Only the optional plaintext-copy step remains; encrypted originals and earlier extras stay saved. */
export class PlainSecretCopyRestoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlainSecretCopyRestoreError'
  }
}

export function includePersonalResource(
  resource: Pick<ResourceSummary, 'type'>,
  selection?: PersonalResourceSelection,
): boolean {
  if (resource.type === 'extraStory') return selection?.extraStory !== false
  if (resource.type === 'pocketPhone') return selection?.pocketPhone !== false
  if (resource.type === 'secret') return selection?.secret === true
  return true
}

export async function plaintextSecretCopies(
  resources: readonly Resource[],
  password: string,
): Promise<PlainSecretCopy[]> {
  const { secretResourceService } = await import('./SecretResourceService')
  const copies: PlainSecretCopy[] = []
  for (const resource of resources) {
    if (resource.type !== 'secret') continue
    if (resource.originalBlob.size > 2 * 1024 * 1024) throw new Error('密钥资源超过大小限制')
    const document = parsePersonalResource(JSON.parse(await resource.originalBlob.text()))
    const fields = await secretResourceService.reveal(document, password)
    copies.push({
      contentHash: resource.contentHash,
      document: { ...document, fields, protected: undefined },
    })
  }
  return copies
}

async function grantId(config: CloudBackupConfig): Promise<string> {
  const target =
    config.provider === 'github'
      ? ['github', config.owner.trim().toLowerCase(), config.repository.trim().toLowerCase()]
      : [
          'webdav',
          config.baseUrl.trim().replace(/\/+$/, ''),
          config.username.trim().toLowerCase(),
          config.folder.trim().replace(/^\/+|\/+$/g, '') || 'SRL-Backups',
        ]
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(target))),
  )
  return `personal-export.${Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('')}`
}
export async function savePlainSecretExportGrant(
  config: CloudBackupConfig,
  password: string,
): Promise<void> {
  const { localCredentialStore } = await import('./LocalCredentialStore')
  await localCredentialStore.save(await grantId(config), password)
}
export async function readPlainSecretExportGrant(config: CloudBackupConfig): Promise<string> {
  const { localCredentialStore } = await import('./LocalCredentialStore')
  return localCredentialStore.read(await grantId(config))
}
export async function clearPlainSecretExportGrant(config: CloudBackupConfig): Promise<void> {
  const { localCredentialStore } = await import('./LocalCredentialStore')
  await localCredentialStore.clear(await grantId(config))
}

export async function cloudPlainSecretCopies(
  config: CloudBackupConfig,
  resources: import('./ResourceService').ResourceService,
  selection?: PersonalResourceSelection,
): Promise<PlainSecretCopy[]> {
  if (selection && !includePersonalResource({ type: 'secret' }, selection)) return []
  const ids = selection?.resourceIds ? new Set(selection.resourceIds) : undefined
  const password = await readPlainSecretExportGrant(config)
  if (!password)
    throw new Error('当前备份目标尚未授权明文密钥副本，请在设置中确认，或关闭明文副本保留加密备份')
  if (ids?.size === 0) return []
  const summaries =
    typeof resources.listResourceListSummaries === 'function'
      ? await resources.listResourceListSummaries({
          types: ['secret'],
          ids: ids ? [...ids] : undefined,
        })
      : await resources.listSummaries()
  const copies: PlainSecretCopy[] = []
  const encoder = new TextEncoder()
  let outputBytes = 2 // JSON array brackets; each subsequent item adds one comma.
  for (const summary of summaries) {
    if (
      summary.type !== 'secret' ||
      summary.metadata.cloudBackupExcluded === true ||
      (ids && !ids.has(summary.id))
    )
      continue
    const resource = await resources.get(summary.id)
    if (!resource || resource.type !== 'secret' || resource.metadata.cloudBackupExcluded === true)
      continue
    for (const copy of await plaintextSecretCopies([resource], password)) {
      outputBytes += encoder.encode(JSON.stringify(copy)).length + (copies.length ? 1 : 0)
      if (outputBytes > 2 * 1024 * 1024)
        throw new Error('明文密钥副本超过 2 MB；请关闭明文副本，仍可完整备份加密原件')
      copies.push(copy)
    }
  }
  return copies
}

export function selectCloudResources(
  resources: ResourceSummary[],
  selection?: PersonalResourceSelection,
): ResourceSummary[] {
  const selectedIds = new Set(selection?.resourceIds ?? resources.map((r) => r.id))
  includeChatCompanionIds(resources, selectedIds)
  for (const resource of resources) {
    if (
      resource.metadata.cloudBackupExcluded === true ||
      !includePersonalResource(resource, selection)
    )
      selectedIds.delete(resource.id)
  }
  includeResourceGalleryIds(
    resources,
    selectedIds,
    selection?.resourceGallery === true,
    selection?.resourceAttachments === true,
  )
  return resources.filter(
    (resource) =>
      resource.metadata.cloudBackupExcluded !== true &&
      (!selectedIds || selectedIds.has(resource.id)) &&
      includePersonalResource(resource, selection),
  )
}
