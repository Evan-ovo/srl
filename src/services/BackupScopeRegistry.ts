import { isResourceAttachment, isResourceOwnedFile } from '../types/ResourceAttachment'
import type { ArchivePortableSelection } from '../types/Backup'
import type { CloudBackupContentSelection } from '../types/CloudBackup'
import { isResourceGalleryImage } from '../types/ResourceGallery'
import {
  RESOURCE_TYPE,
  RESOURCE_TYPE_LABELS,
  type ResourceSummary,
  type ResourceType,
} from '../types/Resource'

export const BACKUP_SCOPE_REGISTRY_VERSION = 1

export type BackupScopeGroupId = 'tavernResources' | 'manualResources' | 'extraContent'
export type BackupScopeId =
  | 'extra.resourceAttachments'
  | 'extra.resourceGallery'
  | 'resource.characterCard'
  | 'resource.greeting'
  | 'resource.chat'
  | 'resource.worldBook'
  | 'resource.userPersona'
  | 'resource.beautification'
  | 'resource.regex'
  | 'resource.preset'
  | 'resource.quickReply'
  | 'resource.script'
  | 'resource.plugin'
  | 'resource.other'
  | 'resource.extraStory'
  | 'resource.pocketPhone'
  | 'resource.secret'
  | 'extra.communitySources'
  | 'extra.externalApps'
  | 'extra.chatReader'
  | 'extra.assistantData'
  | 'extra.aiTaggingState'
  | 'extra.stitchWork'
  | 'extra.frontendWorkshopComponents'
  | 'extra.frontendWorkshopProjects'
  | 'extra.imageGeneration'
  | 'extra.generatedImageAlbum'
  | 'extra.appearance'
  | 'extra.generalPreferences'
  | 'extra.characterDraw'
  | 'extra.cloudBackup'
  | 'extra.credentials'
  | 'extra.plaintextSecretCopy'

export interface BackupScopeDefinition {
  id: BackupScopeId
  group: BackupScopeGroupId
  label: string
  description: string
  resourceType?: ResourceType
  sensitive?: boolean
  privacyWarning?: boolean
  defaultLocal: boolean
  defaultCloud: boolean
}

export const BACKUP_SCOPE_GROUPS: ReadonlyArray<{
  id: BackupScopeGroupId
  label: string
  description: string
}> = [
  { id: 'tavernResources', label: '酒馆资源', description: '角色卡、正则、美化、世界书和常用资源' },
  { id: 'manualResources', label: '手动添加资源', description: '番外、小手机和密钥等独立资源' },
  { id: 'extraContent', label: '额外资源', description: '社区内容、APP 数据、设置与工作草稿' },
]

const resourceScope = (
  id: BackupScopeId,
  resourceType: ResourceType,
  group: BackupScopeGroupId,
): BackupScopeDefinition => ({
  id,
  group,
  label: RESOURCE_TYPE_LABELS[resourceType],
  description: `${RESOURCE_TYPE_LABELS[resourceType]}资源及其文件内容`,
  resourceType,
  sensitive: resourceType === RESOURCE_TYPE.SECRET,
  defaultLocal: resourceType !== RESOURCE_TYPE.SECRET,
  defaultCloud: resourceType !== RESOURCE_TYPE.SECRET,
})

export const BACKUP_SCOPE_REGISTRY: ReadonlyArray<BackupScopeDefinition> = [
  {
    id: 'extra.resourceGallery',
    group: 'extraContent',
    label: '资源图库',
    description:
      '所选资源的图片、直链、备注与按资源类型保存的分类（含空分类）；可能包含聊天截图。封面始终随资源保存。',
    privacyWarning: true,
    defaultLocal: true,
    defaultCloud: false,
  },
  {
    id: 'extra.resourceAttachments',
    group: 'extraContent',
    label: '资源附件',
    description: '所选资源的附件原件、编辑内容与历史版本；可能包含私人文档。',
    privacyWarning: true,
    defaultLocal: true,
    defaultCloud: false,
  },
  resourceScope('resource.characterCard', RESOURCE_TYPE.CHARACTER_CARD, 'tavernResources'),
  resourceScope('resource.chat', RESOURCE_TYPE.CHAT, 'tavernResources'),
  resourceScope('resource.greeting', RESOURCE_TYPE.GREETING, 'tavernResources'),
  resourceScope('resource.worldBook', RESOURCE_TYPE.WORLD_BOOK, 'tavernResources'),
  resourceScope('resource.userPersona', RESOURCE_TYPE.USER_PERSONA, 'tavernResources'),
  resourceScope('resource.beautification', RESOURCE_TYPE.BEAUTIFICATION, 'tavernResources'),
  resourceScope('resource.regex', RESOURCE_TYPE.REGEX, 'tavernResources'),
  resourceScope('resource.preset', RESOURCE_TYPE.PRESET, 'tavernResources'),
  resourceScope('resource.quickReply', RESOURCE_TYPE.QUICK_REPLY, 'tavernResources'),
  resourceScope('resource.script', RESOURCE_TYPE.SCRIPT, 'tavernResources'),
  resourceScope('resource.plugin', RESOURCE_TYPE.PLUGIN, 'tavernResources'),
  resourceScope('resource.other', RESOURCE_TYPE.OTHER, 'tavernResources'),
  resourceScope('resource.extraStory', RESOURCE_TYPE.EXTRA_STORY, 'manualResources'),
  resourceScope('resource.pocketPhone', RESOURCE_TYPE.POCKET_PHONE, 'manualResources'),
  {
    ...resourceScope('resource.secret', RESOURCE_TYPE.SECRET, 'manualResources'),
    description: '保留各卡片的保护方式；未加密卡片可直接读取，已加密卡片仍需原密码',
  },
  {
    id: 'extra.communitySources',
    group: 'extraContent',
    label: 'Discord 社区内容',
    description: '帖子正文、评论和已保存附件，可能包含个人信息',
    privacyWarning: true,
    defaultLocal: true,
    defaultCloud: false,
  },
  {
    id: 'extra.externalApps',
    group: 'extraContent',
    label: '第三方 APP 数据',
    description: 'APP 清单、本地数据和权限状态，恢复后保持禁用',
    privacyWarning: true,
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.chatReader',
    group: 'extraContent',
    label: '读了么阅读数据',
    description: '阅读进度、备注、收藏、回复选择和角色阅读外观；聊天原件请同时选择聊天记录',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.assistantData',
    group: 'extraContent',
    label: '蒜惹菈本地资料',
    description: '聊天记录、记忆、项目草稿、任务模板与偏好；可能包含私密对话，仅在单独选择后备份',
    sensitive: true,
    privacyWarning: true,
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.aiTaggingState',
    group: 'extraContent',
    label: 'AI 标签工作区',
    description: '标签草稿、撤销记录和已保存的规则模板（含系统提示词）',
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.stitchWork',
    group: 'extraContent',
    label: '预设缝合工作区',
    description: '缝合草稿与检查点',
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.frontendWorkshopComponents',
    group: 'extraContent',
    label: '前端组件库',
    description: 'Source Component 组件源码、运行要求、来源和授权；不包含项目收录关系',
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.frontendWorkshopProjects',
    group: 'extraContent',
    label: '前端项目与创作记录',
    description: '作品原始源码、恢复版本、组件收录关系与已保存 AI 会话',
    privacyWarning: true,
    defaultLocal: true,
    defaultCloud: false,
  },
  {
    id: 'extra.imageGeneration',
    group: 'extraContent',
    label: '生图配置与草稿',
    description: '连接配置、各供应商草稿和提示词模板；API 密钥需另选应用凭据',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.generatedImageAlbum',
    group: 'extraContent',
    label: '生图相册',
    description: '已保存原图、分类、生成参数与托管地址；可能包含私人图片',
    privacyWarning: true,
    defaultLocal: true,
    defaultCloud: false,
  },
  {
    id: 'extra.appearance',
    group: 'extraContent',
    label: '外观与 CSS',
    description: '主题、排版、自定义 CSS 与预设',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.generalPreferences',
    group: 'extraContent',
    label: '常用偏好',
    description: '预览安全、导入偏好与搜索历史',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.characterDraw',
    group: 'extraContent',
    label: '抽了么记录',
    description: '累计次数、遇见记录和名字显示偏好',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.cloudBackup',
    group: 'extraContent',
    label: '云备份配置',
    description: 'Provider、目录、频率和保护选项，不包含凭据',
    defaultLocal: true,
    defaultCloud: true,
  },
  {
    id: 'extra.credentials',
    group: 'extraContent',
    label: '应用凭据',
    description:
      '主 API、生图 API、助手 GitHub 读取令牌、旧前端 API、自建图床、云备份和 Bot 凭据；不含网页登录或设备授权',
    sensitive: true,
    defaultLocal: false,
    defaultCloud: false,
  },
  {
    id: 'extra.plaintextSecretCopy',
    group: 'extraContent',
    label: '明文密钥副本',
    description: '为已加密卡片另存可直接读取的字段，需确认；未加密卡片无需此项',
    sensitive: true,
    defaultLocal: false,
    defaultCloud: false,
  },
]

export interface BackupSelectionTreeState {
  resourceIds: Set<string>
  scopes: Set<BackupScopeId>
}

export function createDefaultBackupSelection(
  resources: readonly ResourceSummary[],
  mode: 'local' | 'cloud',
): BackupSelectionTreeState {
  const selectedResourceTypes = new Set(
    BACKUP_SCOPE_REGISTRY.filter((scope) =>
      mode === 'local' ? scope.defaultLocal : scope.defaultCloud,
    )
      .map((scope) => scope.resourceType)
      .filter((type): type is ResourceType => Boolean(type)),
  )
  return {
    resourceIds: new Set(
      resources
        .filter(
          (resource) => !isResourceOwnedFile(resource) && selectedResourceTypes.has(resource.type),
        )
        .map((resource) => resource.id),
    ),
    scopes: new Set(
      BACKUP_SCOPE_REGISTRY.filter((scope) =>
        mode === 'local' ? scope.defaultLocal : scope.defaultCloud,
      ).map((scope) => scope.id),
    ),
  }
}

export function scopeForResource(
  resource: Pick<ResourceSummary, 'type'>,
): BackupScopeDefinition | undefined {
  return BACKUP_SCOPE_REGISTRY.find((scope) => scope.resourceType === resource.type)
}

export function toArchivePortableSelection(
  state: BackupSelectionTreeState,
): ArchivePortableSelection {
  return {
    resourceAttachments: state.scopes.has('extra.resourceAttachments'),
    resourceGallery: state.scopes.has('extra.resourceGallery'),
    personalResources: {
      extraStory: state.scopes.has('resource.extraStory'),
      pocketPhone: state.scopes.has('resource.pocketPhone'),
      secret: state.scopes.has('resource.secret'),
    },
    plaintextSecretCopy: state.scopes.has('extra.plaintextSecretCopy'),
    appearance: state.scopes.has('extra.appearance'),
    cloudBackup: state.scopes.has('extra.cloudBackup'),
    characterDraw: state.scopes.has('extra.characterDraw'),
    generalPreferences: state.scopes.has('extra.generalPreferences'),
    mainApiProfiles: state.scopes.has('extra.credentials'),
    aiTaggingState: state.scopes.has('extra.aiTaggingState'),
    externalApps: state.scopes.has('extra.externalApps'),
    chatReader: state.scopes.has('extra.chatReader'),
    assistantData: state.scopes.has('extra.assistantData'),
    stitchWork: state.scopes.has('extra.stitchWork'),
    frontendWorkshopComponents: state.scopes.has('extra.frontendWorkshopComponents'),
    frontendWorkshopProjects: state.scopes.has('extra.frontendWorkshopProjects'),
    imageGeneration: state.scopes.has('extra.imageGeneration'),
    generatedImageAlbum: state.scopes.has('extra.generatedImageAlbum'),
    communitySources: state.scopes.has('extra.communitySources'),
  }
}

export function toCloudContentSelection(
  state: BackupSelectionTreeState,
): CloudBackupContentSelection {
  return {
    resourceAttachments: state.scopes.has('extra.resourceAttachments'),
    resourceGallery: state.scopes.has('extra.resourceGallery'),
    personalResources: {
      extraStory: state.scopes.has('resource.extraStory'),
      pocketPhone: state.scopes.has('resource.pocketPhone'),
      secret: state.scopes.has('resource.secret'),
    },
    plaintextSecretCopy: state.scopes.has('extra.plaintextSecretCopy'),
    credentials: state.scopes.has('extra.credentials'),
    aiTaggingState: state.scopes.has('extra.aiTaggingState'),
    externalApps: state.scopes.has('extra.externalApps'),
    chatReader: state.scopes.has('extra.chatReader'),
    assistantData: state.scopes.has('extra.assistantData'),
    stitchWork: state.scopes.has('extra.stitchWork'),
    frontendWorkshopComponents: state.scopes.has('extra.frontendWorkshopComponents'),
    frontendWorkshopProjects: state.scopes.has('extra.frontendWorkshopProjects'),
    imageGeneration: state.scopes.has('extra.imageGeneration'),
    generatedImageAlbum: state.scopes.has('extra.generatedImageAlbum'),
    resourceIds: [...state.resourceIds],
    communitySources: state.scopes.has('extra.communitySources'),
    appearance: state.scopes.has('extra.appearance'),
    cloudBackup: state.scopes.has('extra.cloudBackup'),
    characterDraw: state.scopes.has('extra.characterDraw'),
    generalPreferences: state.scopes.has('extra.generalPreferences'),
  }
}

export function registeredBackupScopeIds(): Set<string> {
  return new Set(BACKUP_SCOPE_REGISTRY.map((scope) => scope.id))
}

export function resourceRestoreScopeIds(
  resources: readonly ResourceSummary[],
  includeEmptyGallery = false,
): BackupScopeId[] {
  const types = new Set(resources.filter((r) => !isResourceOwnedFile(r)).map((r) => r.type))
  return BACKUP_SCOPE_REGISTRY.filter((scope) =>
    scope.resourceType
      ? types.has(scope.resourceType)
      : scope.id === 'extra.resourceAttachments'
        ? resources.some(isResourceAttachment)
        : scope.id === 'extra.resourceGallery' &&
          (includeEmptyGallery || resources.some(isResourceGalleryImage)),
  ).map((scope) => scope.id)
}
