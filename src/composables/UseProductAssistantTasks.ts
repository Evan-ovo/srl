import { ref, onBeforeUnmount, type Ref } from 'vue'
import type { AssistantMode } from '../core/ProductAssistantKnowledge'
import type { ResourceService } from '../services/ResourceService'
import type {
  AssistantConversation,
  AssistantTaskTemplate,
  ProductAssistantWorkspaceService,
} from '../services/ProductAssistantWorkspaceService'
import type {
  AssistantContext,
  AssistantExecution,
  AssistantReply,
  AssistantRequest,
} from '../services/ProductAssistantService'
import {
  assistantSkillMatchesMode,
  normalizeAssistantTaskTemplate,
} from '../services/ProductAssistantTask'
import {
  ProductAssistantReferenceReader,
  normalizeAssistantReferenceResources,
  type AssistantReferenceResource,
} from '../services/ProductAssistantReferences'
import { readAssistantOffset } from '../services/ProductAssistantTools'

/** Per-chat task data/consent adapter. Writes still belong to Workspace; reads to ResourceService. */
export function useProductAssistantTasks(options: {
  busy: Ref<boolean>
  error: Ref<string>
  mode: () => AssistantMode | undefined
  enabled: () => boolean
  isAlive: () => boolean
  persist: () => Promise<void>
  onScopeChange: () => void
  workspace: Pick<ProductAssistantWorkspaceService, 'templates' | 'templateText'>
  resources: Pick<ResourceService, 'getSummary' | 'get'>
}) {
  const taskSkill = ref<AssistantTaskTemplate>()
  const referenceResources = ref<AssistantReferenceResource[]>([])
  const reader = new ProductAssistantReferenceReader(
    options.resources,
    () => referenceResources.value,
  )
  const snapshot = () => ({
    taskSkill: taskSkill.value,
    referenceResources: referenceResources.value,
  })
  function load(value: Pick<AssistantConversation, 'taskSkill' | 'referenceResources'>) {
    const previous = JSON.stringify(snapshot())
    try {
      taskSkill.value = value.taskSkill
        ? normalizeAssistantTaskTemplate(value.taskSkill)
        : undefined
    } catch {
      taskSkill.value = undefined
      options.error.value = '已保存的技能数据无效，聊天保留，请重新选择技能'
    }
    try {
      referenceResources.value = normalizeAssistantReferenceResources(value.referenceResources)
    } catch {
      referenceResources.value = []
      options.error.value = '资料选择数据无效，聊天保留，请重新选择资料'
    }
    reader.clear()
    if (previous !== JSON.stringify(snapshot())) options.onScopeChange()
  }
  function context(): Pick<AssistantContext, 'taskSkill' | 'referenceResources' | 'mode'> {
    const manualMode = options.mode()
    return {
      ...(assistantSkillMatchesMode(taskSkill.value, manualMode)
        ? { taskSkill: taskSkill.value }
        : {}),
      referenceResources: referenceResources.value,
      mode: manualMode && manualMode !== 'auto' ? manualMode : (taskSkill.value?.mode ?? 'auto'),
    }
  }
  function templateText(value: AssistantTaskTemplate): string | undefined {
    if (value.description && !assistantSkillMatchesMode(value, options.mode())) {
      options.error.value = '技能与手动工作模式不匹配，请先在设置选择自动或对应模式'
      return undefined
    }
    return value.description
      ? `使用技能“${value.name}”：${value.description}`
      : options.workspace.templateText(value)
  }
  function useTemplate(value: AssistantTaskTemplate) {
    if (value.description) taskSkill.value = normalizeAssistantTaskTemplate(value)
  }
  async function selectReferenceResources(value: AssistantReferenceResource[]) {
    if (options.busy.value) return
    referenceResources.value = normalizeAssistantReferenceResources(value)
    reader.clear()
    options.onScopeChange()
    try {
      await options.persist()
    } catch (cause) {
      options.error.value =
        cause instanceof Error ? cause.message : '资料选择保存失败，当前选择保留'
    }
  }
  async function clearTaskSkill() {
    if (options.busy.value) return
    taskSkill.value = undefined
    options.onScopeChange()
    try {
      await options.persist()
    } catch {
      options.error.value = '技能选择保存失败，请勿离开'
    }
  }
  function check(signal: AbortSignal) {
    if (signal.aborted || !options.isAlive()) throw new DOMException('已停止', 'AbortError')
    if (!options.enabled()) throw new Error('工具调用已关闭，资料未发送')
  }
  async function execute(
    reply: AssistantReply,
    request: AssistantRequest,
    signal: AbortSignal,
  ): Promise<AssistantExecution | undefined> {
    if (reply.action === 'task-skills') {
      check(signal)
      const templates = await options.workspace.templates()
      check(signal)
      const skills = templates
        .filter((item) => item.description !== undefined)
        .map(normalizeAssistantTaskTemplate)
      if (reply.operation === 'list') {
        const terms =
          reply.args.query === '*'
            ? []
            : reply.args.query!.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
        return {
          text: '已查询本机任务技能',
          showInChat: false,
          data: {
            skills: skills
              .filter((item) =>
                terms.every((term) =>
                  `${item.name}\n${item.description}`.toLocaleLowerCase().includes(term),
                ),
              )
              .map(({ id, name, description, mode, version }) => ({
                id,
                name,
                description,
                mode,
                version: version ?? 1,
              })),
          },
        }
      }
      const skill = skills.find(
        (item) => item.id === reply.args.id && String(item.version ?? 1) === reply.args.version,
      )
      if (!skill) throw new Error('技能已变化或删除，请重新查询后加载')
      if (!assistantSkillMatchesMode(skill, request.mode))
        throw new Error('技能与当前工作模式不匹配')
      return { text: '已加载本轮任务技能', showInChat: false, data: { skill } }
    }
    if (reply.action === 'resource-references') {
      check(signal)
      const result =
        reply.operation === 'search'
          ? await reader.search(reply.args.query!, readAssistantOffset(reply.args.offset), signal)
          : await reader.read(
              reply.args.id!,
              reply.args.hash!,
              reply.args.locator!,
              readAssistantOffset(reply.args.offset),
              signal,
            )
      check(signal)
      return {
        text: '已读取选定资料的原文节选',
        showInChat: false,
        data: { ...result },
        resourceCitations: 'items' in result ? result.items : [result.citation],
      }
    }
    return undefined
  }
  onBeforeUnmount(() => reader.clear())
  return {
    taskSkill,
    referenceResources,
    snapshot,
    load,
    context,
    templateText,
    useTemplate,
    selectReferenceResources,
    clearTaskSkill,
    execute,
    clearCache: () => reader.clear(),
  }
}
