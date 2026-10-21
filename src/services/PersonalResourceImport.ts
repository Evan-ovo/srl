import { parsePersonalResource, type PersonalResourceDocument } from '../types/PersonalResource'
import { secretResourceService } from './SecretResourceService'
import { materializeNativeFile, nativeFileSize } from '../core/NativeFileSource'
import { chooseAction } from '../composables/UseConfirmDialog'

export async function protectPersonalImport(
  file: File,
  requestPassword: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<File> {
  signal?.throwIfAborted()
  if (!/\.json$/i.test(file.name) || nativeFileSize(file) > 2 * 1024 * 1024) return file
  file = await materializeNativeFile(file, { signal })
  let value: unknown
  try {
    value = JSON.parse(await file.text())
  } catch {
    signal?.throwIfAborted()
    return file
  }
  signal?.throwIfAborted()
  if (
    !value ||
    typeof value !== 'object' ||
    !('format' in value) ||
    value.format !== 'srl-personal-resource'
  )
    return file
  const document = parsePersonalResource(value)
  if (
    document.kind !== 'secret' ||
    document.protection === 'none' ||
    !document.fields.some((field) => field.private && field.value)
  )
    return file
  const choice = await chooseAction(
    {
      title: '导入密钥资料',
      message:
        '此文件包含未加密的私密字段。可直接保存，或使用统一密码加密；不加密时，本机原件和备份中可直接读取这些字段。',
      confirmLabel: '不加密导入',
      alternativeLabel: '使用密码加密',
      cancelLabel: '取消导入',
    },
    signal,
  )
  signal?.throwIfAborted()
  if (choice === 'cancel') throw new Error('已取消密钥导入；原文件未修改')
  if (choice === 'confirm')
    return new File(
      [JSON.stringify({ ...document, protection: 'none', protected: undefined })],
      file.name,
      {
        type: 'application/json',
      },
    )
  if (!(await secretResourceService.hasPassword()))
    throw new Error('请先在总设置中设置密钥统一密码，再导入原文件；原文件未修改')
  const password = secretResourceService.isUnlocked() ? undefined : await requestPassword()
  if (!password && !secretResourceService.isUnlocked())
    throw new Error('已取消密钥导入；原文件未修改')
  const protectedDocument = await secretResourceService.protect(document, password)
  signal?.throwIfAborted()
  return new File([JSON.stringify(protectedDocument)], file.name, { type: 'application/json' })
}

export async function validateSecretResource(blob: Blob): Promise<void> {
  if (blob.size > 2 * 1024 * 1024) throw new Error('密钥资源超过大小限制')
  const document = parsePersonalResource(JSON.parse(await blob.text()))
  validateSecretDocument(document)
}
export function validateSecretDocument(document: PersonalResourceDocument): void {
  if (
    document.kind !== 'secret' ||
    (document.protection !== 'none' &&
      (document.fields.some((field) => field.private && field.value) ||
        (document.fields.some((field) => field.private) && !document.protected)))
  )
    throw new Error('密钥资源保护方式不完整；请通过文件导入选择不加密或使用统一密码加密')
}
