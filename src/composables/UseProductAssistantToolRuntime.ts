import { nextTick, ref, shallowRef, type Component, type Ref } from 'vue'
import { externalAppService } from '../core/AppContainer'
import { confirmAction } from './UseConfirmDialog'
import {
  EXTERNAL_APP_PERMISSION_LABELS,
  type ExternalAppToolDescriptor,
} from '../types/ExternalApp'
import { validateExternalAppToolArguments } from '../services/ExternalAppTools'
import type {
  AssistantExecution,
  AssistantReply,
  AssistantRequest,
  AssistantContext,
  AssistantImage,
} from '../services/ProductAssistantService'
import type { MainApiConfig } from '../services/MainApiService'

export interface ProductAssistantToolHost {
  invokeTool: (
    tool: ExternalAppToolDescriptor,
    args: string,
    signal: AbortSignal,
  ) => Promise<unknown>
}
/** Host-only navigation/screenshot capabilities; no APP may supply model images. */
export async function executeAssistantViewTool(
  reply: Extract<AssistantReply, { action: 'navigate' | 'view-current-ui' }>,
  request: AssistantRequest,
  signal: AbortSignal,
  isAlive: () => boolean,
  context: () => AssistantContext,
  navigate?: (id: string) => Promise<void>,
  capture?: (signal: AbortSignal) => Promise<AssistantImage>,
  getConfig?: () => MainApiConfig,
  canCapture: () => boolean = () => true,
): Promise<AssistantExecution> {
  if (signal.aborted || !isAlive()) throw new DOMException('已停止', 'AbortError')
  if (reply.action === 'view-current-ui') {
    if (!capture || !request.canCaptureCurrent) throw new Error('当前界面无法截图')
    const config = getConfig?.()
    const destination = config
      ? `${new URL(config.url).origin}（${config.model}）`
      : '本轮对话使用的 AI 服务'
    const accepted = await confirmAction(
      {
        title: '截图并发送给 AI',
        message: `将截取当前可见界面，并把遮蔽处理后的图片发送给：${destination}。请确认界面中没有不希望发送的内容；取消后不会截图或发送。`,
        confirmLabel: '截图并发送',
        centered: true,
      },
      signal,
    )
    if (!accepted || signal.aborted || !isAlive() || !canCapture())
      return { text: '已取消截图，未发送图片。', ok: false, cancelled: true }
    if (config && JSON.stringify(getConfig?.()) !== JSON.stringify(config))
      throw new Error('AI 目标已变化，未截图或发送，请重新发起')
    const image = await capture(signal)
    if (signal.aborted || !isAlive()) throw new DOMException('已停止', 'AbortError')
    if (!canCapture()) return { text: '截图权限已关闭，未发送图片。', ok: false, cancelled: true }
    return { text: '已截取当前界面。', image, modelImage: image }
  }
  const target = context().navigationTargets?.find((item) => item.id === reply.target)
  if (!navigate || !target) throw new Error('这个界面的入口暂不可用')
  return {
    text: `即将打开「${target.title}」。`,
    navigation: {
      target: target.id,
      title: target.title,
      ...(reply.guide ? { guide: reply.guide } : {}),
    },
    data: { queued: true, opened: false, target: target.id, entry: target.entry },
  }
}

/** Visible tool host and consent lifecycle; capabilities still belong to ExternalAppService. */
export function useProductAssistantToolRuntime(
  isAlive: () => boolean,
  toolHost: Readonly<Ref<ProductAssistantToolHost | null>>,
) {
  const toolHostComponent = shallowRef<Component>()
  const runningTool = ref<ExternalAppToolDescriptor>()
  async function execute(
    reply: Extract<AssistantReply, { action: 'custom-tools' }>,
    signal: AbortSignal,
    getConfig: () => MainApiConfig,
  ): Promise<AssistantExecution> {
    if (reply.operation === 'list') {
      if (!/^\d{1,9}$/u.test(reply.args.offset!)) throw new Error('工具分页偏移无效')
      return {
        text: '已查询已安装 APP 的自定义工具',
        data: await externalAppService.listCustomTools(
          reply.args.query === '*' ? '' : reply.args.query!,
          Number(reply.args.offset),
        ),
      }
    }
    const tool = await externalAppService.requireCustomTool(reply.args.id!, reply.args.fingerprint!)
    const args = validateExternalAppToolArguments(tool, reply.args.arguments!)
    const accepted = await confirmAction(
      {
        title: `运行“${tool.title}”`,
        confirmLabel: '运行工具',
        message: `APP：${tool.appName}\n工具版本：${tool.version}\n作用：${tool.description}\n能力：${tool.permissions.map((permission) => EXTERNAL_APP_PERMISSION_LABELS[permission]).join('、') || '无'}\n参数：${JSON.stringify(args, null, 2)}\n将启动此 APP 的脚本，并在原隔离环境中调用工具；资源或设备访问沿原权限询问。取消或报错不自动回滚已经发生的操作。工具返回数据会先展示，再由你决定是否发送给当前模型。`,
      },
      signal,
    )
    if (!accepted || signal.aborted || !isAlive())
      return { text: '已取消自定义工具运行。', ok: false, cancelled: true }
    // Load the existing host before mounting, so its exposed API exists on nextTick.
    toolHostComponent.value = (await import('../components/ExternalAppHost.vue')).default
    if (signal.aborted || !isAlive())
      return { text: '已取消自定义工具运行。', ok: false, cancelled: true }
    await externalAppService.requireCustomTool(tool.id, tool.fingerprint)
    runningTool.value = tool
    await nextTick()
    let result: unknown
    try {
      if (!toolHost.value) throw new Error('自定义工具运行界面未能加载')
      result = await toolHost.value.invokeTool(tool, reply.args.arguments!, signal)
    } catch (cause) {
      return {
        text: signal.aborted
          ? '工具调用已停止；已发生的操作保留。'
          : cause instanceof Error
            ? cause.message
            : '自定义工具执行失败；已发生的操作保留。',
        status: '工具调用未完成',
        ok: false,
        cancelled: signal.aborted,
        data: { resultWithheld: true },
      }
    } finally {
      runningTool.value = undefined
      await nextTick()
    }
    if (signal.aborted || !isAlive())
      return {
        text: '工具已执行，结果留在本机；已发生的操作保留。',
        status: '工具已执行',
        toolResult: { title: tool.title, json: JSON.stringify(result) },
        data: { executed: true, resultWithheld: true },
      }
    const config = getConfig()
    const destination = new URL(config.url)
    const share = await confirmAction(
      {
        title: '发送工具结果给 AI',
        confirmLabel: '发送此结果',
        cancelLabel: '仅留在本机',
        message: `工具：${tool.title}（${tool.appName}）\n发送到：${destination.origin}${destination.pathname}\n模型：${config.model}\n以下是工具返回的全部 JSON 数据：\n${JSON.stringify(result)}\n确认后发送给该模型；仅留在本机不会撤销已经执行的操作。`,
      },
      signal,
    )
    return {
      text:
        share && !signal.aborted
          ? `“${tool.title}”已执行，结果已获发送授权。`
          : `“${tool.title}”已执行；结果仅在本机当前聊天保留。`,
      status: '工具已执行',
      toolResult: { title: tool.title, json: JSON.stringify(result) },
      data:
        share && !signal.aborted
          ? { executed: true, result }
          : { executed: true, resultWithheld: true },
    }
  }
  return { toolHostComponent, runningTool, execute }
}
