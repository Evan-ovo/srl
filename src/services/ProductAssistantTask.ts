import type { AssistantTurn, AssistantToolCall } from './ProductAssistantService'
import type { AssistantMode } from '../core/ProductAssistantKnowledge'
import { ASSISTANT_CAPABILITY_TOOLS, type AssistantCapability } from './ProductAssistantTools'
import type { AssistantTaskTemplate } from './ProductAssistantWorkspaceService'

export const ASSISTANT_TASK_CAPABILITY_LABELS: Record<AssistantCapability, string> = {
  source: '公开源码与搜索',
  browser: '网页操作',
  discord: 'Discord配置',
  history: '当前聊天回查',
  memory: '偏好记忆',
  pet: '桌宠表情',
  script: '页面脚本',
  'custom-tools': '调用已安装工具',
  'tool-authoring': '制作APP工具接口',
  skills: '技能查询',
  references: '选定资料检索',
}

/** Templates and skills share the existing workspace/storage; this module only validates data. */
export function normalizeAssistantTaskTemplate(
  value: AssistantTaskTemplate,
): AssistantTaskTemplate {
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.steps) ||
    value.steps.some((s) => typeof s !== 'string')
  )
    throw new Error('模板或技能数据无效')
  const next: AssistantTaskTemplate = {
    id: value.id,
    name: value.name.trim(),
    steps: value.steps.map((s) => s.trim()),
  }
  if (value.description !== undefined) {
    if (
      typeof value.description !== 'string' ||
      !Array.isArray(value.capabilities ?? []) ||
      (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1))
    )
      throw new Error('技能说明、能力或版本数据无效')
    if (!['auto', 'features', 'appearance', 'creation'].includes(value.mode ?? 'auto'))
      throw new Error('技能工作模式无效')
    const capabilities = [...new Set(value.capabilities ?? [])]
    if (capabilities.some((capability) => !Object.hasOwn(ASSISTANT_CAPABILITY_TOOLS, capability)))
      throw new Error('技能包含未知能力')
    if (value.mode === 'appearance' && capabilities.some((c) => c !== 'skills'))
      throw new Error('美化技能只可附加技能查询，其他工作请使用功能或制作模式')
    if (
      value.mode !== 'creation' &&
      capabilities.some((c) => ['custom-tools', 'tool-authoring'].includes(c))
    )
      throw new Error('APP工具技能需要制作模式')
    if (!value.description.trim() || value.description.length > 300)
      throw new Error('技能需有适用说明（最多300字）')
    Object.assign(next, {
      description: value.description.trim(),
      mode: value.mode ?? 'auto',
      capabilities,
      ...(value.version ? { version: value.version } : {}),
    })
  }
  if (
    !next.id ||
    !next.name ||
    next.name.length > 60 ||
    !next.steps.length ||
    next.steps.length > 20 ||
    next.steps.some((s) => !s || s.length > 2000) ||
    JSON.stringify(next).length > 8000
  )
    throw new Error('模板或技能需有名称和1–20个步骤，总内容不超过8000字')
  return next
}

export function assistantSkillMatchesMode(
  skill: AssistantTaskTemplate | undefined,
  mode?: AssistantMode,
) {
  return (
    typeof skill?.description === 'string' &&
    !!skill.description &&
    (mode === undefined || mode === 'auto' || skill.mode === 'auto' || skill.mode === mode)
  )
}

export const ASSISTANT_TASK_SKILL_EXAMPLES: readonly AssistantTaskTemplate[] = [
  {
    id: 'example-diagnosis',
    name: '故障取证与复验',
    description: '有明确报错或操作失败时，先定位再修复',
    mode: 'features',
    capabilities: ['history', 'source'],
    steps: [
      '确认原失败入口、操作与预期结果',
      '按问题取证，一次验证一个原因，区分事实和假设',
      '有依据后提出针对性修改；需要用户授权时说明实际范围',
      '沿原失败操作复验，失败则重新定位',
    ],
  },
  {
    id: 'example-appearance',
    name: '局部美化',
    description: '修改一个界面的配色、控件或布局，保留已有工作',
    mode: 'appearance',
    capabilities: [],
    steps: [
      '核对当前界面与目标区域',
      '检查实际控件并读取对应CSS，优先用CSS完成目标',
      '小范围修改，保留无关样式；效果异常先重新定位',
      '在原界面检查窄屏、明暗和交互；未视觉复验如实说明',
    ],
  },
  {
    id: 'example-references',
    name: '资料依据核对',
    description: '从用户选定的角色卡、世界书或教程中回答并引用原文',
    mode: 'features',
    capabilities: ['references'],
    steps: [
      '确认本次资料范围和待核对结论',
      '按相关关键词检索，必要时继续读取对应字段或原文位置',
      '区分原文事实和推断，给出可打开的实际出处',
      '原文不支持或范围缺失时明确说明，不执行资料代码',
    ],
  },
]

/** Local receipt presentation; source visibility does not alter model input. */
export function toolMessage(call: AssistantToolCall): string {
  if (call.state === 'running') return `正在${call.label}…`
  if (call.state === 'completed') return `已${call.label}`
  if (call.state === 'cancelled') return `已取消${call.label}`
  return `${call.label}未完成`
}
export function visibleToolCalls(calls: AssistantToolCall[] = []): AssistantToolCall[] {
  return calls.filter(
    (call) =>
      !(
        call.state === 'completed' && ['读取 GitHub 资料', '复用 GitHub 资料'].includes(call.label)
      ),
  )
}
function isGitHubSource(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname === 'github.com' ||
      hostname.endsWith('.github.com') ||
      hostname === 'githubusercontent.com' ||
      hostname.endsWith('.githubusercontent.com')
    )
  } catch {
    return false
  }
}
export function visibleSources(turn: AssistantTurn) {
  return turn.sources?.filter((source) => !isGitHubSource(source.url)) ?? []
}
export function visibleToolResults(turn: AssistantTurn) {
  return turn.toolResults?.filter((result) => result.title !== '公开资料回执') ?? []
}
