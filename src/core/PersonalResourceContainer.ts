import { appDatabase } from './AppDatabaseInstance'
import { resourceService } from './LibraryContainer'
import { IndexedDbRestoreStagingStore } from '../storage/IndexedDbRestoreStagingStore'
import { PersonalResourceService } from '../services/PersonalResourceService'
import { PlainSecretCopyRestoreError } from '../services/PersonalResourceBackup'
import { restoredSecretSourceHash } from '../utils/RestoreIdentity'
export const personalResourceService = new PersonalResourceService(
  resourceService,
  new IndexedDbRestoreStagingStore(appDatabase),
)

export async function restorePlainSecretCopies(
  copies: import('../services/PersonalResourceBackup').PlainSecretCopy[],
): Promise<void> {
  if (!Array.isArray(copies) || !copies.length) return
  try {
    const summaries = await resourceService.listResourceListSummaries({ types: ['secret'] })
    const byHash = new Map<string, (typeof summaries)[number]>()
    const completed = new Set<string>()
    for (const resource of summaries) {
      if (!byHash.has(resource.contentHash)) byHash.set(resource.contentHash, resource)
      const source = restoredSecretSourceHash(resource)
      if (source) completed.add(source)
    }
    const pending = copies.filter(
      (copy) => byHash.has(copy.contentHash) && !completed.has(copy.contentHash),
    )
    if (!pending.length) return
    const { confirmAction } = await import('../composables/UseConfirmDialog')
    if (
      !(await confirmAction({
        title: '恢复明文密钥副本',
        message: `备份包含 ${pending.length} 张尚未转换的密钥卡明文副本。是否使用本机查看密码重新加密保存？取消则只保留已恢复的加密原件。`,
        confirmLabel: '重新加密保存',
      }))
    )
      return
    const { secretResourceService } = await import('../services/SecretResourceService')
    const { requestSecretPassword } = await import('../composables/UseSecretPasswordPrompt')
    if (!(await secretResourceService.hasPassword()))
      throw new PlainSecretCopyRestoreError(
        '加密原件已保留；当前未读取到本机统一密码设置。请在总设置核对保存状态，再重试明文密钥副本。',
      )
    const password = secretResourceService.isUnlocked()
      ? undefined
      : await requestSecretPassword(
          '输入本机总设置中的统一密码，用于重新加密明文副本。取消不影响加密原件。',
        )
    if (!password && !secretResourceService.isUnlocked()) return
    const { parsePersonalResource } = await import('../types/PersonalResource')
    const prepared = []
    for (const copy of pending) {
      const document = parsePersonalResource(copy.document)
      if (document.kind !== 'secret') throw new Error('明文密钥副本类型无效')
      const target = byHash.get(copy.contentHash)
      if (!target) continue
      const resource = await resourceService.get(target.id)
      if (!resource) continue
      prepared.push({
        resource,
        document: await secretResourceService.protect(document, password),
        sourceHash: copy.contentHash,
      })
    }
    for (const item of prepared)
      await personalResourceService.save(item.document, new Map(), item.resource, item.sourceHash)
  } catch (error) {
    if (error instanceof PlainSecretCopyRestoreError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new PlainSecretCopyRestoreError(error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
}
