import { confirmAction } from '../composables/UseConfirmDialog'
import { taskCenter, type TaskCenter } from '../core/TaskCenter'
import { isAssistantBrowserUrl } from './AssistantBrowserUrl'
import { withAbort } from '../utils/Abortable'
import {
  assistantBrowserSession,
  nativeAssistantBrowser,
  type AssistantBrowserRuntime,
  type AssistantBrowserEvent,
} from './AssistantBrowserRuntime'

/** General task owner; Discord retains its own workflow on the same native executor. */
export class AssistantBrowserTaskService {
  private task?: {
    id: string
    conversationId: string
    url: string
    controller: AbortController
    finished: boolean
    sharedChat: boolean
    agentRunId: string
  }
  private revision = 0
  private activeCalls = 0
  private pauseReceipt?: { controller: AbortController; promise: Promise<void> }
  private listener?: Awaited<ReturnType<AssistantBrowserRuntime['addListener']>>
  private listening?: Promise<void>
  private listenerGeneration = 0
  private readonly browser: AssistantBrowserRuntime
  private readonly tasks: TaskCenter
  private readonly confirm: typeof confirmAction
  constructor(
    browser: AssistantBrowserRuntime = nativeAssistantBrowser,
    tasks: TaskCenter = taskCenter,
    confirm: typeof confirmAction = confirmAction,
  ) {
    this.browser = browser
    this.tasks = tasks
    this.confirm = confirm
  }
  owns(conversationId: string) {
    return this.task?.conversationId === conversationId
  }
  async recover(conversationId: string, sharedChat = true, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.task) return this.owns(conversationId)
    if (!this.browser.currentTask) return false
    const revision = this.revision
    const lookup = this.browser.currentTask()
    const page = signal ? await withAbort(lookup, signal) : await lookup
    signal?.throwIfAborted()
    if (
      !page.active ||
      page.purpose !== 'general' ||
      page.conversationId !== conversationId ||
      !page.runId
    )
      return false
    if (this.revision !== revision) return false
    if (this.task) return this.owns(conversationId)
    const task = {
      id: page.runId,
      conversationId,
      url: page.url,
      controller: new AbortController(),
      finished: page.finished,
      agentRunId: page.agentRunId || crypto.randomUUID(),
      sharedChat,
    }
    if (page.paused || page.finished) task.controller.abort()
    this.task = task
    ++this.revision
    this.publish(!page.paused && !page.finished)
    this.tasks.start({
      operationId: task.id,
      name: '恢复网页协助',
      phase: page.finished ? '已完成' : page.paused ? '已暂停，等待明确继续' : '原网页任务已恢复',
      cancelable: !page.finished,
      cancel: () => this.close(),
      action: { label: '查看原网页', run: () => this.returnToBrowser() },
    })
    if (page.finished) this.tasks.complete(task.id)
    try {
      const listening = this.listen()
      if (signal) await withAbort(listening, signal)
      else await listening
      signal?.throwIfAborted()
      return true
    } catch (error) {
      if (signal?.aborted && this.task === task) void this.pause().catch(() => undefined)
      throw error
    }
  }
  async showProgress(text: string) {
    if (!this.task || this.task.finished || this.task.controller.signal.aborted) return
    this.tasks.update(this.task.id, { phase: text })
    await this.browser.message({ text: '', phase: text })
  }
  private publish(running: boolean) {
    if (!this.task && assistantBrowserSession.purpose !== 'general') return
    assistantBrowserSession.active = Boolean(this.task)
    assistantBrowserSession.purpose = 'general'
    assistantBrowserSession.assistantConversationId = this.task?.conversationId ?? ''
    assistantBrowserSession.webStepActive = Boolean(this.task)
    assistantBrowserSession.agentRunning = running
    assistantBrowserSession.completed = this.task?.finished === true
  }
  private async listen() {
    if (this.listener) return
    if (this.listening) return this.listening
    const generation = this.listenerGeneration
    const registration = this.browser
      .addListener('browserAction', (event) => {
        const controller = this.task?.controller
        void this.onEvent(event).catch((error: unknown) => {
          const task = this.task
          if (!task || task.id !== event.runId || task.controller !== controller) return
          this.tasks.update(task.id, {
            phase: error instanceof Error ? error.message : '网页操作未成功，可查看原因后继续',
          })
        })
      })
      .then(async (handle) => {
        if (generation !== this.listenerGeneration) await handle.remove()
        else this.listener = handle
      })
      .finally(() => {
        if (this.listening === registration) this.listening = undefined
      })
    this.listening = registration
    await registration
  }
  private async onEvent(event: AssistantBrowserEvent) {
    const task = this.task
    if (!task || event.runId !== task.id || event.conversationId !== task.conversationId) return
    if (event.action === 'visibility')
      assistantBrowserSession.browserVisible = event.visible === true
    else if (event.action === 'return' || event.action === 'browser-close') await this.close(false)
    else if (event.action === 'agent-pause') await this.pause()
    else if (event.action === 'agent-resume' || event.action === 'resume') {
      if (task.finished) {
        await this.browser.message({
          text: '本次任务已完成。新任务请提出新的目标，不重复刚才的提交。',
        })
        return
      }
      await this.resume(task.conversationId)
      this.requestContinuation(task)
    } else if (event.action === 'quick-chat' || event.action === 'fullscreen') {
      if (!task.sharedChat) {
        await this.browser.close({ keepRunning: true, ownerRunId: task.id })
        window.dispatchEvent(
          new CustomEvent('srl:native-deep-link', { detail: { kind: 'assistant' } }),
        )
        return
      }
      window.dispatchEvent(
        new CustomEvent('srl:assistant-browser-chat', {
          detail: { fullscreen: event.action === 'fullscreen', petBounds: event.petBounds },
        }),
      )
    } else if (event.action === 'download-progress') {
      if (typeof event.bytes === 'number')
        this.tasks.updateTransfer(task.id, { transferredBytes: event.bytes })
    } else if (
      event.action === 'page-ready' &&
      !event.paused &&
      !event.loading &&
      !this.activeCalls &&
      !task.finished &&
      !task.controller.signal.aborted
    ) {
      this.tasks.update(task.id, { phase: '网页已就绪，继续观察实际结果' })
      this.requestContinuation(task)
    }
  }
  private requestContinuation(task: NonNullable<AssistantBrowserTaskService['task']>) {
    window.dispatchEvent(
      new CustomEvent('srl:assistant-browser-ready', {
        detail: { conversationId: task.conversationId },
      }),
    )
  }
  async returnToBrowser(showControls = false) {
    const task = this.task
    if (!task) throw new Error('当前没有保留的网页任务')
    if (!showControls && this.browser.chatPresentation) {
      await this.browser.chatPresentation({ mode: 'browser', conversationId: task.conversationId })
      assistantBrowserSession.browserVisible = true
      return
    }
    await this.browser.open(this.options(task, showControls))
  }
  private options(task: NonNullable<AssistantBrowserTaskService['task']>, showControls = false) {
    return {
      site: 'general',
      purpose: 'general' as const,
      step: 'browser-general',
      title: '网页协助',
      hint: '按用户当前目标和实际页面结果操作；有错误先处理错误，不重复已成功的工作。',
      steps: [],
      template: '',
      mode: 'agent' as const,
      agentRunId: task.controller.signal.aborted || task.finished ? '' : task.agentRunId,
      ownerTaskId: task.id,
      conversationId: task.conversationId,
      resumeCurrent: true,
      showControls,
    }
  }
  async pause() {
    const task = this.task
    if (!task || task.finished) return
    if (this.pauseReceipt?.controller === task.controller) return this.pauseReceipt.promise
    const revision = ++this.revision
    const controller = task.controller
    const promise = Promise.resolve().then(async () => {
      try {
        await this.browser.pauseAgent({ ownerRunId: task.id })
        if (this.task === task && this.revision === revision)
          this.tasks.update(task.id, { phase: '已暂停，可操作网页或明确继续' })
      } catch (error) {
        if (this.pauseReceipt?.controller === controller) this.pauseReceipt = undefined
        if (this.task === task && this.revision === revision)
          this.tasks.update(task.id, { phase: '已停止继续操作，网页暂停回执未确认' })
        throw error
      }
    })
    // Cancellation and the visible stop button can arrive together; share their primary receipt.
    this.pauseReceipt = { controller, promise }
    task.controller.abort(new DOMException('用户已暂停网页操作', 'AbortError'))
    this.publish(false)
    window.dispatchEvent(
      new CustomEvent('srl:assistant-browser-stop', {
        detail: { conversationId: task.conversationId },
      }),
    )
    // Older runtimes benefit from cancelWait; the primary pause also clears all native waits.
    void this.browser.cancelWait({ ownerRunId: task.id }).catch(() => undefined)
    return promise
  }
  async resume(conversationId: string, modelSignal?: AbortSignal) {
    modelSignal?.throwIfAborted()
    const task = this.task
    if (!task || task.conversationId !== conversationId || task.finished)
      throw new Error('网页任务已结束或不属于当前聊天')
    if (assistantBrowserSession.purpose !== 'general')
      throw new Error('网页已交给另一任务，不恢复旧任务')
    if (assistantBrowserSession.agentRunning && !task.controller.signal.aborted) return
    const revision = ++this.revision
    this.pauseReceipt = undefined
    task.controller.abort(new DOMException('续接请求已被替代', 'AbortError'))
    const controller = new AbortController()
    task.controller = controller
    task.agentRunId = crypto.randomUUID()
    const stop = () => {
      if (this.task === task && task.controller === controller)
        void this.pause().catch(() => undefined)
    }
    modelSignal?.addEventListener('abort', stop, { once: true })
    try {
      await withAbort(this.browser.open(this.options(task)), controller.signal)
      modelSignal?.throwIfAborted()
      if (this.task !== task || this.revision !== revision || controller.signal.aborted)
        throw new DOMException('继续请求已过期，不恢复旧操作', 'AbortError')
      this.publish(true)
      this.tasks.update(task.id, { phase: '已继续，请重新观察页面' })
    } catch (error) {
      if (this.task === task && this.revision === revision) {
        controller.abort(new DOMException('续接未成功', 'AbortError'))
        this.publish(false)
        this.tasks.update(task.id, { phase: '未能继续网页任务，可查看原因后明确继续' })
      }
      throw error
    } finally {
      modelSignal?.removeEventListener('abort', stop)
    }
  }
  async close(closeWindow = true, stopModel = true) {
    const task = this.task
    if (!task) return
    ++this.listenerGeneration
    const listener = this.listener
    this.listening = undefined
    this.listener = undefined
    this.task = undefined
    this.pauseReceipt = undefined
    ++this.revision
    task.controller.abort(new DOMException('网页任务已关闭', 'AbortError'))
    this.publish(false)
    if (stopModel)
      window.dispatchEvent(
        new CustomEvent('srl:assistant-browser-stop', {
          detail: { conversationId: task.conversationId },
        }),
      )
    if (assistantBrowserSession.purpose === 'general')
      assistantBrowserSession.browserVisible = false
    try {
      if (assistantBrowserSession.purpose === 'general') {
        void this.browser.cancelWait({ ownerRunId: task.id }).catch(() => undefined)
        if (closeWindow) await this.browser.close({ ownerRunId: task.id })
      }
    } finally {
      if (!task.finished) this.tasks.cancelled(task.id)
      this.tasks.setAction(task.id, undefined)
      // A late registration already removes itself through listenerGeneration in listen().
      // Closing must not wait for a bridge registration that has not returned.
      // Retired callbacks are rejected by run/conversation identity, even if removal is delayed.
      void listener?.remove().catch(() => undefined)
    }
  }
  async execute(
    args: Record<string, string>,
    conversationId: string,
    modelSignal: AbortSignal,
    options: { sharedChat?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    ++this.activeCalls
    try {
      return await this.perform(args, conversationId, modelSignal, options.sharedChat !== false)
    } finally {
      --this.activeCalls
    }
  }
  private bound(
    task: NonNullable<AssistantBrowserTaskService['task']>,
    signal = task.controller.signal,
  ): AssistantBrowserRuntime {
    const agentRunId = task.controller.signal.aborted ? undefined : task.agentRunId
    const identityMethods = new Set([
      'inspect',
      'listTabs',
      'switchTab',
      'readPage',
      'capture',
      'back',
      'wait',
      'act',
      'download',
      'pauseAgent',
    ])
    return new Proxy(this.browser, {
      get: (target, key) => {
        const method = Reflect.get(target, key)
        if (typeof method !== 'function' || !identityMethods.has(String(key))) return method
        return (options?: object) => {
          if (key !== 'pauseAgent') signal.throwIfAborted()
          const result = method.call(target, {
            ...options,
            ownerRunId: task.id,
            ...(task.controller.signal.aborted ? {} : { ownerAgentRunId: agentRunId }),
          })
          // Finish and cleanup intentionally run after the operation lease has been aborted.
          return key === 'pauseAgent' ? result : withAbort(result, signal)
        }
      },
    })
  }
  private async perform(
    args: Record<string, string>,
    conversationId: string,
    modelSignal: AbortSignal,
    sharedChat: boolean,
  ): Promise<Record<string, unknown>> {
    modelSignal.throwIfAborted()
    let operation = args.operation ?? ''
    if (operation === 'resume' && !this.task)
      await this.recover(conversationId, sharedChat, modelSignal)
    if (operation === 'open' && (!this.owns(conversationId) || this.task?.finished)) {
      const url = new URL(args.url ?? '')
      if (!isAssistantBrowserUrl(url)) throw new Error('请提供公开 HTTPS 地址')
      if (assistantBrowserSession.active && assistantBrowserSession.purpose !== 'general')
        throw new Error('Discord 配置仍在使用网页，请先关闭或完成该任务')
      const previousTask = this.task,
        previousRevision = this.revision
      if (
        !(await this.confirm(
          {
            title: '开启网页协助',
            centered: true,
            confirmLabel: '开启',
            message: `目标：${url.origin}。助手读取页面并按你的要求操作；登录和秘密值由你填写。重要提交、上传、下载按实际对象确认。`,
          },
          modelSignal,
        ))
      )
        return { ok: false, cancelled: true, hint: '用户取消开启网页' }
      modelSignal.throwIfAborted()
      if (this.task !== previousTask || this.revision !== previousRevision)
        throw new Error('确认期间网页任务已变化，请重新核对目标')
      await this.close(true, false)
      const task = {
        id: crypto.randomUUID(),
        conversationId,
        url: url.href,
        controller: new AbortController(),
        finished: false,
        sharedChat,
        agentRunId: crypto.randomUUID(),
      }
      this.task = task
      const revision = ++this.revision
      this.publish(true)
      this.tasks.start({
        operationId: task.id,
        name: `网页协助 · ${url.hostname}`,
        phase: '打开网页',
        cancelable: true,
        cancel: () => this.close(),
        action: { label: '查看网页任务', run: () => this.returnToBrowser() },
      })
      try {
        const stop = () => {
          void (this.listener ? this.pause() : this.close()).catch(() => undefined)
        }
        modelSignal.addEventListener('abort', stop, { once: true })
        try {
          await withAbort(this.listen(), task.controller.signal)
          if (this.task !== task || this.revision !== revision)
            throw new DOMException('打开任务已取消', 'AbortError')
          modelSignal.throwIfAborted()
          await withAbort(
            this.browser.open({ ...this.options(task), url: url.href, resumeCurrent: false }),
            task.controller.signal,
          )
          const page = await withAbort(this.browser.waitReady(), task.controller.signal)
          if (this.task !== task || this.revision !== revision || modelSignal.aborted)
            throw new DOMException('打开任务已取消', 'AbortError')
          return { ok: true, ...page }
        } finally {
          modelSignal.removeEventListener('abort', stop)
        }
      } catch (error) {
        if (this.task === task && modelSignal.aborted && !task.controller.signal.aborted)
          await this.close()
        if (this.task === task && !modelSignal.aborted && !task.controller.signal.aborted) {
          this.tasks.fail(task.id, error)
          await this.close()
        }
        throw error
      }
    }
    const task = this.task
    if (!task || task.conversationId !== conversationId)
      throw new Error('当前聊天没有网页任务，请先打开网站')
    if (
      assistantBrowserSession.purpose !== 'general' ||
      assistantBrowserSession.assistantConversationId !== conversationId
    ) {
      await this.close(false)
      throw new Error('网页已交给另一任务，原任务不会继续操作')
    }
    if (operation === 'close') {
      await this.close()
      return { ok: true, closed: true }
    }
    if (operation === 'pause') {
      await this.pause()
      return { ok: true, paused: true }
    }
    if (operation === 'resume') {
      if (
        !(await this.confirm(
          {
            title: '继续网页任务',
            centered: true,
            message: '允许助手从当前网页继续操作吗？',
            confirmLabel: '继续',
          },
          modelSignal,
        ))
      )
        return { ok: false, paused: true }
      modelSignal.throwIfAborted()
      await this.resume(conversationId, modelSignal)
      operation = 'inspect'
    }
    if (task.finished) throw new Error('任务已结束，不能执行迟到动作；新任务请重新打开网站')
    if (task.controller.signal.aborted && !['inspect', 'list-tabs'].includes(operation))
      throw new Error('用户已接手或暂停；需要明确继续后再操作')
    const browser = this.bound(
      task,
      task.controller.signal.aborted ? modelSignal : task.controller.signal,
    )
    const revision = this.revision
    const check = () => {
      modelSignal.throwIfAborted()
      if (this.task !== task || this.revision !== revision)
        throw new DOMException('任务已变化，旧结果已丢弃', 'AbortError')
      if (
        assistantBrowserSession.purpose !== 'general' ||
        assistantBrowserSession.assistantConversationId !== conversationId
      )
        throw new DOMException('网页已交给另一任务，旧结果已丢弃', 'AbortError')
    }
    const stop = () => {
      void this.pause().catch(() => undefined)
    }
    modelSignal.addEventListener('abort', stop, { once: true })
    try {
      this.tasks.update(task.id, { phase: `网页操作：${operation}` })
      let result: Record<string, unknown>
      if (operation === 'inspect') result = { ...(await browser.inspect({ query: args.query })) }
      else if (operation === 'list-tabs') result = await browser.listTabs()
      else if (operation === 'finish') {
        if (!args.query?.trim())
          throw new Error('请提供本任务实际完成结果的页面文字作为 query，再核验结束')
        const page = await browser.inspect({ query: args.query })
        check()
        if (page.loading || page.failed || page.paused || page.searchMatched !== true)
          throw new Error('当前页面未核验到完成结果，不标记完成；继续观察实际结果')
        task.finished = true
        ++this.revision
        task.controller.abort()
        this.publish(false)
        await browser.pauseAgent({ finished: true })
        this.tasks.complete(task.id)
        return { ok: true, verified: true, ...page }
      } else if (operation === 'switch-tab')
        result = {
          ...(await browser.switchTab({ tabId: Number(args.tab_id ?? args.target) })),
        }
      else {
        const documentId = Number(args.document_id),
          tabId = Number(args.tab_id)
        if (!Number.isSafeInteger(documentId) || !Number.isSafeInteger(tabId))
          throw new Error('动作需要最近观察的 document_id 和 tab_id，请先 inspect')
        if (operation === 'read-page')
          result = {
            ...(await browser.readPage({
              documentId,
              tabId,
              query: args.query,
              region: args.region,
              offset: Number(args.offset ?? 0),
            })),
          }
        else if (operation === 'screenshot') {
          const image = await browser.capture({ documentId, tabId })
          result = { imageDataUrl: image.dataUrl, documentId: image.documentId, tabId: image.tabId }
        } else if (operation === 'back') result = { ...(await browser.back({ tabId })) }
        else if (operation === 'wait')
          result = {
            ...(await browser.wait({
              documentId,
              tabId,
              milliseconds: Number(args.milliseconds ?? 1000),
            })),
          }
        else if (operation === 'download') {
          if (!browser.download)
            throw new Error('当前 APK 尚不支持网页文件下载，请更新 APK 或用网站原下载入口')
          result = await browser.download({
            documentId,
            tabId,
            target: args.target ?? '',
            destination: args.destination === 'import' ? 'import' : 'downloads',
          })
        } else
          result = await browser.act({
            operation: operation === 'open' ? 'navigate' : operation,
            documentId,
            tabId,
            target: args.target,
            value: args.value,
            url: args.url,
            key: args.key,
            direction: args.direction as 'up' | 'down' | undefined,
          })
      }
      check()
      return { ok: result.ok !== false, ...result }
    } finally {
      modelSignal.removeEventListener('abort', stop)
    }
  }
}
export const assistantBrowserTaskService = new AssistantBrowserTaskService()
