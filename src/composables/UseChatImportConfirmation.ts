import { chooseAction } from './UseConfirmDialog'
import type { ResourceService } from '../services/ResourceService'
import type { ImportOptions } from '../types/ResourceOperations'
import { RESOURCE_TYPE } from '../types/Resource'
import { readChatArchive } from '../services/TavernChatArchiveCodec.mjs'
import { hashBlob } from '../services/HashService'
import { materializeNativeFile } from '../core/NativeFileSource'

/** All receive/file-import entrances share this choice before any resource is written. */
export async function confirmChatImports(
  files: File[],
  resources: ResourceService,
  signal?: AbortSignal,
): Promise<ImportOptions | null> {
  const archives = files.filter((file) => /\.srlchat$/i.test(file.name))
  if (!archives.length) return {}
  const options: ImportOptions = { chatCharacterBindings: {}, saveChatCharacterHashes: [] }
  for (const file of archives) {
    signal?.throwIfAborted()
    const { card, chat, avatar } = await readChatArchive(
      await materializeNativeFile(file, { signal }),
    )
    signal?.throwIfAborted()
    const hash = await hashBlob(card)
    if (Object.hasOwn(options.chatCharacterBindings!, hash)) continue
    const match = await resources.findCharacterCardByContentHash(hash)
    const existing = match?.resource.type === RESOURCE_TYPE.CHARACTER_CARD ? match : undefined
    const choice = await chooseAction({
      centered: true,
      title: existing ? '确认聊天所属角色' : '导入聊天记录',
      message: existing
        ? `聊天：${chat.name}\n酒馆角色文件：${avatar}\n\n资源库已有：${existing.resource.name}\n文件：${existing.resource.fileName}\n标识：${existing.resource.id}\n\n${existing.matchedHistorical ? `随附卡与该资源组的历史版本「${existing.matchedFileName}」完全一致；确认后会绑定到同一资源组。` : existing.matchedBy === 'recognized-hash' ? '该随附文件的哈希此前已确认为此资源的重复文件。' : '随附卡与这张卡的文件内容完全一致。'}确认使用这张卡关联聊天吗？同批次此角色的聊天会采用相同选择。`
        : `聊天：${chat.name}\n角色文件：${avatar}\n\n默认只保存聊天，头像、阅读正则和角色脚本随聊天保留，不新增独立角色卡或脚本资源。全局和预设脚本需自行添加；读了么默认不运行脚本。同批次此角色的聊天会采用相同选择。`,
      confirmLabel: existing ? '使用这张卡' : '只保存聊天',
      alternativeLabel: existing ? '使用聊天自带资料' : '同时保存角色卡',
      cancelLabel: '取消导入',
    })
    if (choice === 'cancel') return null
    options.chatCharacterBindings![hash] =
      existing && choice === 'confirm' ? existing.resource.id : null
    if (!existing && choice === 'alternative') options.saveChatCharacterHashes!.push(hash)
  }
  return options
}
