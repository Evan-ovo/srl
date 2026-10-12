export type BuiltInFeatureAppId =
  | 'chatReader'
  | 'draw'
  | 'appearance'
  | 'assistant'
  | 'folders'
  | 'inbox'
  | 'cloud'
  | 'tavernBridge'
  | 'stitch'
  | 'frontendWorkshop'
  | 'imageGeneration'
  | 'imageAlbum'
  | 'userPersona'
  | 'extensions'

export type BuiltInFeatureAppPage = BuiltInFeatureAppId

export const ASSISTANT_LIBRARY_DESTINATIONS = [
  { id: 'library', title: '资源库', entry: ['资源库'] },
  { id: 'favorites', title: '收藏', entry: ['资源库', '收藏'] },
  { id: 'import', title: '本地资源导入', entry: ['资源库', '导入'] },
  { id: 'link-import', title: '链接导入', entry: ['资源库', '导入', '链接导入'] },
  { id: 'settings', title: '资源库设置', entry: ['资源库', '设置'] },
] as const

export function getAssistantNavigationTargets(includeLibrary = false) {
  return [
    { id: 'home', title: '功能桌面', entry: ['功能'] },
    ...FEATURE_APP_REGISTRY.filter((app) => app.visible && app.id !== 'assistant').map((app) => ({
      id: app.id,
      title: app.name,
      entry: ['功能', app.name],
    })),
    // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=assistant-official-app-destination
    { id: 'officialApps', title: 'APP 管理', entry: ['功能', 'APP 管理'] },
    // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=assistant-official-app-destination
    ...(includeLibrary
      ? ASSISTANT_LIBRARY_DESTINATIONS.map((item) => ({ ...item, entry: [...item.entry] }))
      : []),
  ]
}

export interface FeatureAppDescriptorContext {
  drawCount: number
  folderCount: number
  presetCount: number
  userPersonaCount: number
  enabledExternalAppCount: number
}

export interface FeatureAppDescriptor {
  id: BuiltInFeatureAppId
  page: BuiltInFeatureAppPage
  name: string
  description: string
  icon: string
  sortOrder: number
  visible: boolean
  badge: string | ((context: FeatureAppDescriptorContext) => string)
}

export const FEATURE_APP_REGISTRY: readonly FeatureAppDescriptor[] = [
  {
    id: 'draw',
    page: 'draw',
    name: '抽了么',
    description: '从角色档案中随机相遇',
    icon: 'draw',
    sortOrder: 10,
    visible: true,
    badge: (context) => `${context.drawCount} 次`,
  },
  {
    id: 'chatReader',
    page: 'chatReader',
    name: '读了么',
    description: '按角色整理聊天、沉浸阅读与收藏',
    icon: 'reader',
    sortOrder: 15,
    visible: true,
    badge: '聊天记录阅读器',
  },
  {
    id: 'appearance',
    page: 'appearance',
    name: '外观',
    description: '主题、排版与自定义 CSS',
    icon: 'appearance',
    sortOrder: 20,
    visible: true,
    badge: '个性化工作台',
  },
  {
    id: 'assistant',
    page: 'assistant',
    name: '蒜惹菈',
    description: '功能问答、看图改 CSS 与美化预设',
    icon: 'assistant',
    sortOrder: 25,
    visible: true,
    badge: '使用主 API',
  },
  {
    id: 'folders',
    page: 'folders',
    name: '收藏柜',
    description: '可视化文件夹与拖放整理',
    icon: 'folders',
    sortOrder: 30,
    visible: true,
    badge: (context) => `${context.folderCount} 个文件夹`,
  },
  {
    id: 'inbox',
    page: 'inbox',
    name: '收件箱',
    description: 'Discord 帖子与资源下载',
    icon: 'inbox',
    sortOrder: 35,
    visible: true,
    badge: '领取 · 重试 · 关联',
  },
  {
    id: 'cloud',
    page: 'cloud',
    name: '云备份',
    description: 'GitHub 与 WebDAV',
    icon: 'cloud',
    sortOrder: 40,
    visible: true,
    badge: '每日异地快照',
  },
  {
    id: 'tavernBridge',
    page: 'tavernBridge',
    name: '酒馆互传',
    description: '角色卡、世界书与预设',
    icon: 'bridge',
    sortOrder: 50,
    visible: true,
    badge: '一次性安全连接',
  },
  {
    id: 'stitch',
    page: 'stitch',
    name: '缝了么',
    description: '从多个预设挑段缝合',
    icon: 'stitch',
    sortOrder: 60,
    visible: true,
    badge: (context) => `${context.presetCount} 个预设可用`,
  },
  {
    id: 'frontendWorkshop',
    page: 'frontendWorkshop',
    name: '前端了么',
    description: '状态栏正则与提示词',
    icon: 'frontend',
    sortOrder: 70,
    visible: true,
    badge: '酒馆格式工作台',
  },
  {
    id: 'imageGeneration',
    page: 'imageGeneration',
    name: 'AI 生图',
    description: 'NovelAI、OpenAI 与第三方兼容接口',
    icon: 'imageGeneration',
    sortOrder: 72,
    visible: true,
    badge: '生成 · 结果 · 存储 · 云端',
  },
  {
    id: 'imageAlbum',
    page: 'imageAlbum',
    name: '生图相册',
    description: '保存、整理与托管生成图片',
    icon: 'imageAlbum',
    sortOrder: 75,
    visible: true,
    badge: '本地原图档案',
  },
  {
    id: 'userPersona',
    page: 'userPersona',
    name: 'user才是老大',
    description: '名字、设定与专属世界',
    icon: 'persona',
    sortOrder: 80,
    visible: true,
    badge: (context) => `${context.userPersonaCount} 份人设文件`,
  },
  {
    id: 'extensions',
    page: 'extensions',
    name: '扩展',
    description: '导入、预览与管理本地第三方 APP',
    icon: 'extensions',
    sortOrder: 100,
    visible: true,
    badge: (context) => `${context.enabledExternalAppCount} 个已启用`,
  },
]

export function getFeatureAppDescriptor(id: BuiltInFeatureAppId): FeatureAppDescriptor {
  const descriptor = FEATURE_APP_REGISTRY.find((app) => app.id === id)
  if (!descriptor) throw new Error(`未注册的内置功能 APP：${id}`)
  return descriptor
}

export function getFeatureAppBadge(
  descriptor: FeatureAppDescriptor,
  context: FeatureAppDescriptorContext,
): string {
  return typeof descriptor.badge === 'function' ? descriptor.badge(context) : descriptor.badge
}
