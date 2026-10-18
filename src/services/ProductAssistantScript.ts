import { confirmAction } from '../composables/UseConfirmDialog'

/** Runs user-authorized JavaScript in the resource-library page's origin. */
export async function runAssistantPageScript(
  code: string,
  signal: AbortSignal,
  isAllowed: () => boolean = () => true,
): Promise<unknown> {
  const source = code.trim()
  if (!source || source.length > 30_000) throw new Error('脚本不能为空或超过30000字')
  signal.throwIfAborted()
  if (!isAllowed()) throw new Error('页面脚本权限已关闭')
  const accepted = await confirmAction(
    {
      title: '运行页面脚本',
      message: `脚本可访问当前页面、本机存储和网络，也可能接触密钥或登录信息。返回结果会发送给当前 AI。停止助手只能阻止后续步骤，不能强制终止脚本已创建的计时器、请求或撤回已发生的修改；重新加载页面可结束当前页面脚本，但不会撤销已保存或已发送的内容。\n\n本次脚本：\n${source}`,
      confirmLabel: '运行本次脚本',
      centered: true,
      danger: true,
    },
    signal,
  )
  signal.throwIfAborted()
  if (!accepted) throw new DOMException('已取消页面脚本', 'AbortError')
  if (!isAllowed()) throw new Error('页面脚本权限已关闭，本次脚本未运行')
  const execute = new Function(
    'signal',
    `"use strict"; return (async () => {\n${source}\n})()`,
  ) as (signal: AbortSignal) => Promise<unknown>
  const result = await execute(signal)
  signal.throwIfAborted()
  if (result === undefined) return undefined
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(result)
  } catch {
    throw new Error('脚本已运行，但返回值无法序列化给 AI')
  }
  if (serialized === undefined) return String(result).slice(0, 16_000)
  if (serialized.length > 16_000) throw new Error('脚本已运行，但返回结果超过16000字，未发送给 AI')
  return JSON.parse(serialized) as unknown
}
