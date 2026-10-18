import { ref, watch, onBeforeUnmount, type Ref } from 'vue'
import { mainApiService, productAssistantWorkspaceService as workspace } from '../core/AppContainer'
import { confirmAction } from './UseConfirmDialog'
import type { MainApiConfig } from '../services/MainApiService'
import type { AssistantRequest, AssistantTurn } from '../services/ProductAssistantService'
import type { AssistantPreferences } from '../services/ProductAssistantWorkspaceService'
import { normalizeAssistantToolCallLimit } from '../services/ProductAssistantTools'
import {
  ProductAssistantContextService,
  validAssistantSummary,
  planAssistantCompression,
  estimateAssistantInput,
  describeAssistantInput,
  withAssistantSummary,
  type AssistantContextSummary,
} from '../services/ProductAssistantContext'

/** Compression and send review share the existing chat, API and persistence owners. */
export function useProductAssistantContext(options: {
  history: Ref<AssistantTurn[]>
  preferences: Ref<AssistantPreferences>
  busy: Ref<boolean>
  phase: Ref<string>
  error: Ref<string>
  initializing: Ref<boolean>
  consent: Set<string>
  persist: () => Promise<void>
  getRequest: () => AssistantRequest
  openSettings: () => void
}) {
  const summary = ref<AssistantContextSummary>()
  const status = ref('')
  const compressing = ref(false)
  const service = new ProductAssistantContextService(mainApiService)
  let alive = true,
    validation = 0
  let manualController: AbortController | undefined
  watch(
    options.history,
    () => {
      const candidate = summary.value,
        revision = ++validation
      if (!candidate) return
      void validAssistantSummary(options.history.value, candidate).then((valid) => {
        if (alive && revision === validation && summary.value === candidate && !valid) {
          summary.value = undefined
          status.value = '摘要已失效，可重新压缩'
          void options.persist().catch(() => {
            if (alive) options.error.value = '摘要状态保存失败'
          })
        }
      })
    },
    { deep: true },
  )
  async function reviewedSummary(request: AssistantRequest) {
    if (summary.value && !(await validAssistantSummary(request.history, summary.value))) {
      summary.value = undefined
      status.value = '摘要已失效，可重新压缩'
    }
    return summary.value
  }
  async function applyCompression(
    request: AssistantRequest,
    config: MainApiConfig,
    signal: AbortSignal,
    threshold?: number,
  ) {
    const previous = await reviewedSummary(request)
    const plan = planAssistantCompression(
      request.history,
      previous,
      threshold === undefined ? 3000 : Math.floor(threshold / 4),
    )
    const next = await service.compress(request.history, previous, plan, config, signal, (text) => {
      if (alive) options.phase.value = text
    })
    if (!alive || signal.aborted) throw new DOMException('已取消压缩', 'AbortError')
    summary.value = next
    try {
      await options.persist()
    } catch (cause) {
      summary.value = previous
      throw cause
    }
    status.value = `已压缩 ${next.count} 条${plan.remaining ? `，还有 ${plan.remaining} 条` : ''}`
    return withAssistantSummary(request, next)
  }
  async function prepareSend(request: AssistantRequest, signal: AbortSignal) {
    const config = workspace.config(mainApiService.getConfig())
    if (!config.url || !config.model) {
      options.openSettings()
      throw new Error('请在设置中填写助手 API，或配置主 API')
    }
    const url = new URL(config.url),
      destination = `${url.origin}${url.pathname}`
    const threshold = options.preferences.value.compressionTokenThreshold
    const key = JSON.stringify([
      config.protocol,
      config.url,
      config.model,
      request.canCaptureUi !== false,
      request.canCaptureCurrent,
      request.toolCallingEnabled !== false,
      request.toolCallLimit,
      threshold,
      request.preferenceMemories,
      request.history.some((turn) => turn.role === 'user' && turn.images?.length),
      request.history
        .filter((turn) => turn.role === 'user' && !turn.contextExcluded)
        .flatMap((turn) => turn.designReferences ?? [])
        .map(({ id }) => id),
      'custom-tools-v1',
      request.taskSkill ? [request.taskSkill.id, request.taskSkill.version] : null,
      request.referenceResources?.map((item) => [item.id, item.contentHash]),
    ])
    const previous = await reviewedSummary(request)
    const prepared = withAssistantSummary(request, previous)
    const automaticEnabled =
      options.preferences.value.autoCompressContext && threshold !== undefined
    const plan = automaticEnabled
      ? planAssistantCompression(request.history, previous, Math.floor(threshold! / 4))
      : { start: 0, end: 0, batches: [], remaining: 0, inputTokens: 0 }
    const automatic = Boolean(
      automaticEnabled && plan.end > plan.start && estimateAssistantInput(prepared) > threshold!,
    )
    const estimate = options.preferences.value.estimateInputTokens
      ? estimateAssistantInput(prepared) + (automatic ? plan.inputTokens + 1200 : 0)
      : 0
    const first = !options.consent.has(key)
    if (first || options.preferences.value.estimateInputTokens || automatic) {
      const message = [
        `发送到：${destination}\n模型：${config.model}`,
        request.canCaptureCurrent
          ? '助手如需查看当前界面，会另行询问；确认后截图会发送到上述 AI 服务。'
          : '',
        request.canRunPageScripts
          ? '页面脚本另行确认；停止助手不能强制终止脚本或撤销已发生的操作。'
          : '',
        automatic
          ? `先压缩较早对话：${plan.end - plan.start} 条，${plan.batches.length} 次请求。`
          : '',
        request.toolCallingEnabled === false
          ? '工具调用已关闭：一次普通对话请求，压缩另计。'
          : request.toolCallLimit == null
            ? '工具不限次数，可能多次请求并计费，可随时停止。'
            : `工具上限 ${normalizeAssistantToolCallLimit(request.toolCallLimit)} 次，可能多次请求并计费。`,
        request.history.some(
          (turn) => turn.role === 'user' && !turn.contextExcluded && turn.designReferences?.length,
        )
          ? '附加的 JSON 设计参考会作为风格数据发送给当前模型，不会执行文件内容。'
          : '',
        request.referenceResources?.length
          ? `选定的${request.referenceResources.length}份资料：仅名称和按需检索片段会发送给该模型，不执行资料代码。`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
      const parts = options.preferences.value.estimateInputTokens
        ? describeAssistantInput(prepared, automatic ? plan : undefined)
        : undefined
      const accepted = await confirmAction({
        title: options.preferences.value.estimateInputTokens
          ? `预计输入约 ${estimate.toLocaleString()} tokens`
          : '开始和 AI 对话',
        confirmLabel: '确认发送',
        message,
        tokenReview: parts
          ? {
              total: estimate,
              parts,
              model: config.model,
              destination,
              compression: automatic
                ? `压缩 ${plan.end - plan.start} 条 · ${plan.batches.length} 次请求`
                : undefined,
            }
          : undefined,
      })
      if (!accepted || signal.aborted || !alive) return
      options.consent.add(key)
    }
    const nextRequest = automatic
      ? await applyCompression(request, config, signal, threshold)
      : prepared
    if (automatic && plan.remaining)
      throw new Error(`已保存本次摘要，还有 ${plan.remaining} 条较早消息，请继续压缩后生成`)
    return { config, request: nextRequest }
  }
  async function compress() {
    if (options.busy.value || options.initializing.value) return
    options.busy.value = true
    compressing.value = true
    options.error.value = ''
    manualController = new AbortController()
    const signal = manualController.signal
    try {
      const config = workspace.config(mainApiService.getConfig())
      if (!config.url || !config.model) throw new Error('请先配置助手 API 或主 API')
      const destination = new URL(config.url).origin
      const request = options.getRequest()
      const threshold = options.preferences.value.compressionTokenThreshold
      const plan = planAssistantCompression(
        request.history,
        await reviewedSummary(request),
        threshold === undefined ? 3000 : Math.floor(threshold / 4),
      )
      if (!plan.batches.length)
        throw new Error(
          plan.remaining ? '较早消息过长，请先编辑精简' : '目前没有需要压缩的较早消息',
        )
      if (
        !(await confirmAction({
          title: '压缩当前对话',
          confirmLabel: '确认压缩',
          message: `发送到：${destination}\n压缩 ${plan.end - plan.start} 条较早消息，${plan.batches.length} 次模型请求，预计输入约 ${plan.inputTokens.toLocaleString()} tokens。\n原消息与APP源码保留，近期原文按token保留；已总结部分退出默认上下文，可按关键词回查。手动排除的消息不发送、不总结。${plan.remaining ? `还有 ${plan.remaining} 条可分次继续压缩。` : ''}`,
        })) ||
        signal.aborted ||
        !alive
      )
        return
      await applyCompression(request, config, signal, threshold)
    } catch (cause) {
      if (alive)
        options.error.value = signal.aborted
          ? '已取消压缩，原聊天保留'
          : cause instanceof Error
            ? cause.message
            : '压缩失败，原聊天保留'
    } finally {
      manualController = undefined
      if (alive) {
        options.busy.value = false
        compressing.value = false
        options.phase.value = ''
      }
    }
  }
  onBeforeUnmount(() => {
    alive = false
    manualController?.abort()
  })
  return {
    summary,
    status,
    compressing,
    prepareSend,
    compress,
    stop: () => manualController?.abort(),
    restore: (value?: AssistantContextSummary) => {
      summary.value = value
      status.value = value ? `已压缩 ${value.count} 条` : ''
    },
  }
}
