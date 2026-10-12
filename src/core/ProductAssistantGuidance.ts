import { shallowRef } from 'vue'
export interface AssistantGuideStep {
  target: string
  text: string
}
export interface AssistantGuide {
  id: string
  destination: string
  title: string
  steps: readonly AssistantGuideStep[]
}
/** Reviewed action hooks only. Models cannot supply CSS selectors or automatic clicks. */
export const ASSISTANT_GUIDES: readonly AssistantGuide[] = [
  {
    id: 'library-search',
    destination: 'library',
    title: '查找资源',
    steps: [
      { target: 'library-search', text: '在这里输入资源名称或关键词。' },
      { target: 'library-search-scope', text: '需要按作者或正文查找时，在这里切换范围。' },
    ],
  },
  {
    id: 'data-protection',
    destination: 'library',
    title: '数据保护',
    steps: [
      {
        target: 'data-protection-open',
        text: '在资源库页面点“数据保护”展开面板，可查看本地保险库、回收站和存储状态。Android APK 的原生资源库尚未就绪时，可在面板中重启并重试迁移；重试会从保留的 IndexedDB 副本重新复制，需要额外设备空间。迁移完成后可查看旧副本记录数，并主动校验后清理旧副本；当前原生主库保留。',
      },
    ],
  },
  {
    id: 'inbox-connection',
    destination: 'inbox',
    title: '收件箱连接设置',
    steps: [
      { target: 'inbox-connection-settings', text: '点右上角“连接设置”配置 Worker 和收件库配对。' },
    ],
  },
  {
    id: 'discord-oneclick-tutorial',
    destination: 'inbox',
    title: 'Discord Cloudflare 一键部署教程',
    steps: [
      {
        target: 'discord-oneclick-tutorial-content',
        text: '已打开“连接设置 → Cloudflare 一键部署”教程，可以直接查看步骤。',
      },
    ],
  },
  {
    id: 'discord-github-tutorial',
    destination: 'inbox',
    title: 'Discord GitHub 部署教程',
    steps: [
      {
        target: 'discord-github-tutorial-content',
        text: '已打开“连接设置 → GitHub 仓库部署”教程。后续同步 Fork 更新的步骤在教程末尾；使用 Update branch，不要点 Discard commits。',
      },
    ],
  },
  {
    id: 'discord-manual-deploy-tutorial',
    destination: 'inbox',
    title: 'Discord 浏览器手动部署教程',
    steps: [
      {
        target: 'discord-manual-deploy-tutorial-content',
        text: '已打开“连接设置 → 浏览器手动部署”教程，可以直接查看步骤。',
      },
    ],
  },
  {
    id: 'inbox-post-claim',
    destination: 'inbox',
    title: '领取帖子',
    steps: [
      {
        target: 'inbox-post-claim',
        text: '在“帖子收件”区域点“领取”，把云端暂存的帖子保存到本机。',
      },
    ],
  },
  {
    id: 'inbox-resource-claim',
    destination: 'inbox',
    title: '领取资源',
    steps: [
      {
        target: 'inbox-resource-claim',
        text: '在“资源下载”区域点“领取”，下载并处理云端暂存的附件。',
      },
    ],
  },
  {
    id: 'inbox-cloud-cleanup',
    destination: 'inbox',
    title: '清理云端记录',
    steps: [
      {
        target: 'inbox-cloud-cleanup',
        text: '在收件箱的“帖子收件”区域点“清理云端”，清除已结束任务的云端记录。',
      },
    ],
  },
  {
    id: 'import',
    destination: 'import',
    title: '本地资源导入',
    steps: [
      { target: 'import-resource', text: '点“资源”，进入本地资源导入。' },
      { target: 'import-file', text: '点“单个资源文件”选择文件，完成后查看导入结果。' },
    ],
  },
  {
    id: 'link-import',
    destination: 'link-import',
    title: '链接导入',
    steps: [
      { target: 'import-links', text: '在这里填写资源链接，一行一个。' },
      { target: 'import-links-start', text: '核对链接后点这里开始导入。' },
    ],
  },
  {
    id: 'appearance',
    destination: 'appearance',
    title: '自定义美化',
    steps: [
      { target: 'appearance-css', text: '展开自定义 CSS，选择预设与界面区域。' },
      { target: 'appearance-scope', text: '在这里选择要美化的界面。' },
      { target: 'appearance-save', text: '修改后保存并应用；试用提示中可以保留或恢复。' },
    ],
  },
  {
    id: 'backup',
    destination: 'cloud',
    title: '云备份',
    steps: [
      { target: 'backup-provider', text: '先选择你使用的云端备份方式。' },
      { target: 'backup-create', text: '在原设置中配置并测试连接后，从这里创建备份。' },
    ],
  },
  {
    id: 'tavern-transfer',
    destination: 'tavernBridge',
    title: '酒馆互传',
    steps: [
      {
        target: 'tavern-transfer-entry',
        text: '从这里开始把内容传到酒馆哦～',
      },
    ],
  },
  {
    id: 'tavern-transfer-install',
    destination: 'tavernBridge',
    title: '安装酒馆互传扩展',
    steps: [
      {
        target: 'tavern-transfer-install-content',
        text: '已为你展开酒馆互传安装教程，可以直接查看安装步骤哦～',
      },
    ],
  },
  {
    id: 'stitch',
    destination: 'stitch',
    title: '缝了么',
    steps: [
      { target: 'stitch-search', text: '搜索要作为底板的酒馆预设。' },
      { target: 'stitch-base', text: '从列表选择主预设，再进入填充与导出流程。' },
    ],
  },
  {
    id: 'apps',
    destination: 'extensions',
    title: '第三方 APP',
    steps: [
      { target: 'extensions-import', text: '从这里选择 HTML、ZIP 或 .srlapp，先预览再确认安装。' },
    ],
  },
]
export const assistantGuidance = shallowRef<AssistantGuide>()
export const assistantGuidanceAnchor = shallowRef<{ element: HTMLElement; text: string }>()
/** Explicit mounted help surfaces; future tutorials add a reviewed context ID here. */
export type AssistantHelpContext = 'discord-bridge'
export const assistantHelpContext = shallowRef<AssistantHelpContext>()
const helpSurfaces = new Map<symbol, AssistantHelpContext>()
export function setAssistantHelpSurface(owner: symbol, context?: AssistantHelpContext) {
  if (context) helpSurfaces.set(owner, context)
  else helpSurfaces.delete(owner)
  assistantHelpContext.value = [...helpSurfaces.values()].at(-1)
}
export function visibleAssistantHelpContext(): AssistantHelpContext | undefined {
  const context = assistantHelpContext.value
  if (!context) return
  return [
    ...document.querySelectorAll<HTMLElement>(`[data-assistant-help-context="${context}"]`),
  ].some(
    (element) =>
      element.getClientRects().length &&
      !element.closest('[inert]') &&
      getComputedStyle(element).visibility !== 'hidden',
  )
    ? context
    : undefined
}
export function findAssistantGuide(id: string, destination?: string) {
  return ASSISTANT_GUIDES.find(
    (guide) => guide.id === id && (!destination || guide.destination === destination),
  )
}
export function startAssistantGuidance(id: string, destination: string) {
  const guide = findAssistantGuide(id, destination)
  if (!guide) throw new Error('这个界面没有对应的已核验指路步骤')
  assistantGuidance.value = guide
}
