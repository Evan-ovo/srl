import type {
  MainApiContentPart,
  MainApiMessage,
  MainApiProtocol,
  MainApiTokenUsage,
  MainApiTool,
  MainApiToolCall,
} from './MainApiService'
export function responseTextFromJson(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): string {
  if (protocol === 'anthropic-compatible') {
    const content = body.content as Array<{ type?: string; text?: string }> | undefined
    return (
      content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('') ?? ''
    )
  }
  const choices = body.choices as
    Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> | undefined
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((item) => item.type !== 'reasoning' && item.type !== 'thinking')
      .map((item) => item.text ?? '')
      .join('')
  return ''
}

export function readNativeSearchResult(body: Record<string, unknown>, protocol: MainApiProtocol) {
  const anthropic = protocol === 'anthropic-compatible'
  const blocks = (anthropic ? body.content : body.output) as
    Array<Record<string, unknown>> | undefined
  if (
    !Array.isArray(blocks) ||
    body.status === 'incomplete' ||
    body.error ||
    ['max_tokens', 'pause_turn'].includes(String(body.stop_reason))
  )
    throw new Error('原生搜索没有完整返回；未获得可核验资料')
  const performed = blocks.some((block) =>
    anthropic
      ? block.type === 'server_tool_use' && block.name === 'web_search'
      : block.type === 'web_search_call' && block.status === 'completed',
  )
  const sources: Array<{ title: string; url: string }> = []
  let text = ''
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result' && !Array.isArray(block.content))
      throw new Error('服务商搜索工具返回错误，未获得可核验资料')
    const content = anthropic
      ? [block]
      : Array.isArray(block.content)
        ? (block.content as Array<Record<string, unknown>>)
        : []
    for (const part of content) {
      if (part.type !== 'text' && part.type !== 'output_text') continue
      text += String(part.text ?? '')
      const citations = (part.citations ?? part.annotations ?? []) as Array<Record<string, unknown>>
      for (const citation of citations) {
        const raw = citation.url
        if (typeof raw !== 'string') continue
        try {
          const url = new URL(raw)
          if (url.protocol !== 'https:' || url.username || url.password) continue
        } catch {
          continue
        }
        if (!sources.some((source) => source.url === raw))
          sources.push({ title: String(citation.title ?? raw).slice(0, 200), url: raw })
      }
    }
  }
  if (!performed || !text.trim() || !sources.length)
    throw new Error('服务商未执行搜索或没有返回来源；不能作为联网证据')
  return {
    text,
    sources: sources.slice(0, 10),
    usage: tokenUsageFromJson(body, 'anthropic-compatible'),
    finishReason: 'stop',
    reasoning: undefined,
    toolCalls: undefined,
    providerContent: undefined,
  }
}

export function responseFinishReason(body: Record<string, unknown>, protocol: MainApiProtocol) {
  const choices = body.choices as Array<{ finish_reason?: unknown }> | undefined
  const delta = body.delta as { stop_reason?: unknown } | undefined
  const reason =
    protocol === 'anthropic-compatible'
      ? (body.stop_reason ?? delta?.stop_reason)
      : choices?.[0]?.finish_reason
  return typeof reason === 'string' && reason ? reason : undefined
}

export function responseToolCalls(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): MainApiToolCall[] {
  const choices = body.choices as Array<{ message?: { tool_calls?: unknown[] } }> | undefined
  const raw =
    protocol === 'anthropic-compatible'
      ? Array.isArray(body.content)
        ? body.content.filter((item) => item?.type === 'tool_use')
        : []
      : (choices?.[0]?.message?.tool_calls ?? [])
  const seen = new Set<string>()
  return raw.map((item) => {
    const record = item as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const id = record.id
    const name = protocol === 'anthropic-compatible' ? record.name : fn?.name
    const args = protocol === 'anthropic-compatible' ? JSON.stringify(record.input) : fn?.arguments
    if (
      typeof id !== 'string' ||
      !id ||
      seen.has(id) ||
      typeof name !== 'string' ||
      !name ||
      typeof args !== 'string' ||
      (protocol === 'openai-compatible' && record.type !== 'function')
    )
      throw new Error('API 返回了无效或重复的工具调用，未执行操作')
    seen.add(id)
    return { id, name, arguments: args }
  })
}

/** Recover a complete assistant DSML reply, never examples embedded in ordinary text. */
export function normalizeDsmlToolReply(
  text: string,
  nativeCalls: MainApiToolCall[],
  offeredTools: readonly MainApiTool[],
): { text: string; toolCalls: MainApiToolCall[] } {
  const unchanged = { text, toolCalls: nativeCalls }
  const source = text.trim()
  // "calls" is the wrapper observed in a provider reply; V4's published name is "tool_calls".
  if (!/^<([｜|]{1,2})DSML\1[ \t]*(?:tool_calls|calls)(?:>|\s|$)/u.test(source)) return unchanged
  if (nativeCalls.length) return { text: '', toolCalls: nativeCalls }
  const invalid = () => new Error('API 的文字工具调用格式不完整或不在本轮工具范围内；未执行操作')
  if (!offeredTools.length) throw invalid()
  const block = source.match(
    /^<(([｜|]{1,2})DSML\2)[ \t]*(tool_calls|calls)>([\s\S]*)<\/\1[ \t]*\3>\s*(?:<｜end▁of▁sentence｜>)?$/u,
  )
  if (!block) throw invalid()
  const marker = block[1]!.replace(/\|/gu, '\\|')
  const calls: MainApiToolCall[] = []
  let remaining = block[4]!.trim()
  const invocation = new RegExp(
    `^<${marker}[ \\t]*invoke name="([^"<>]+)">([\\s\\S]*?)<\\/${marker}[ \\t]*invoke>`,
    'u',
  )
  const parameter = new RegExp(
    `^<${marker}[ \\t]*parameter name="([^"<>]+)" string="(true|false)">([\\s\\S]*?)<\\/${marker}[ \\t]*parameter>`,
    'u',
  )
  while (remaining) {
    const invoke = remaining.match(invocation)
    if (!invoke || !offeredTools.some((tool) => tool.name === invoke[1])) throw invalid()
    const args: Record<string, unknown> = Object.create(null)
    let parameters = invoke[2]!.trim()
    while (parameters) {
      const entry = parameters.match(parameter)
      if (!entry || Object.hasOwn(args, entry[1]!)) throw invalid()
      try {
        args[entry[1]!] = entry[2] === 'true' ? entry[3]! : JSON.parse(entry[3]!)
      } catch {
        throw invalid()
      }
      parameters = parameters.slice(entry[0].length).trim()
    }
    calls.push({
      id: `dsml_${crypto.randomUUID()}`,
      name: invoke[1]!,
      arguments: JSON.stringify(args),
    })
    remaining = remaining.slice(invoke[0].length).trim()
  }
  if (!calls.length) throw invalid()
  return { text: '', toolCalls: calls }
}

function reasoningFragments(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    return reasoningFragments(record.thinking ?? record.text ?? record.content)
  })
}

function combineReasoning(...values: unknown[]): string | undefined {
  const unique = [...new Set(values.flatMap(reasoningFragments))]
  return unique.length ? unique.join('\n') : undefined
}

export function responseReasoningFromJson(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): string | undefined {
  if (protocol === 'anthropic-compatible') {
    const content = body.content as Array<Record<string, unknown>> | undefined
    return combineReasoning(
      content
        ?.filter((item) => item.type === 'thinking' || item.type === 'reasoning')
        .map((item) => item.thinking ?? item.text),
    )
  }
  const choices = body.choices as Array<{ message?: Record<string, unknown> }> | undefined
  const message = choices?.[0]?.message
  if (typeof message?.reasoning_content === 'string') return message.reasoning_content
  const content = Array.isArray(message?.content)
    ? (message.content as Array<Record<string, unknown>>)
        .filter((item) => item.type === 'reasoning' || item.type === 'thinking')
        .map((item) => item.text ?? item.thinking)
    : undefined
  return combineReasoning(message?.reasoning_content, message?.reasoning, content)
}

export function openAiMessages(
  messages: MainApiMessage[],
  requireReasoning = false,
): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content || (message.toolCalls?.length ? null : '')
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.dataUrl, detail: 'auto' } },
          ),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
    ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    ...(message.role === 'assistant' && (message.reasoning !== undefined || requireReasoning)
      ? { reasoning_content: message.reasoning ?? '' }
      : {}),
  }))
}

export function anthropicMessages(messages: MainApiMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: textOnly(message.content),
        ...(message.toolError ? { is_error: true } : {}),
      }
      const previous = output[output.length - 1]
      if (
        previous?.role === 'user' &&
        Array.isArray(previous.content) &&
        previous.content.every((item) => item.type === 'tool_result')
      )
        previous.content.push(block)
      else output.push({ role: 'user', content: [block] })
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      output.push({
        role: 'assistant',
        content: message.providerContent ?? [
          ...(textOnly(message.content) ? [{ type: 'text', text: textOnly(message.content) }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: JSON.parse(call.arguments),
          })),
        ],
      })
    } else output.push({ role: message.role, content: anthropicContent(message.content) })
  }
  return output
}

function anthropicContent(
  content: MainApiMessage['content'],
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const match = part.dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/)
    if (!match) throw new Error('参考图不是有效的 base64 图片数据')
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2],
      },
    }
  })
}

export function textOnly(content: MainApiMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is Extract<MainApiContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function estimateTextTokens(value: string): number {
  let units = 0
  for (const character of value) {
    if (/\s/u.test(character)) units += 0.08
    else if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) units += 1
    else if (character.codePointAt(0)! > 0xffff) units += 2
    else units += 0.28
  }
  return Math.max(1, Math.ceil(units))
}

export function estimateMainApiTokens(messages: MainApiMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens =
      typeof message.content === 'string'
        ? estimateTextTokens(message.content)
        : message.content.reduce(
            (sum, part) => sum + (part.type === 'text' ? estimateTextTokens(part.text) : 1_000),
            0,
          )
    return (
      total +
      contentTokens +
      (message.reasoning ? estimateTextTokens(message.reasoning) : 0) +
      (message.toolCalls ? estimateTextTokens(JSON.stringify(message.toolCalls)) : 0) +
      4
    )
  }, 2)
}

export function tokenUsageFromJson(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): Omit<MainApiTokenUsage, 'source'> | undefined {
  if (protocol === 'anthropic-compatible') {
    const rootUsage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined
    const messageUsage = (body.message as { usage?: typeof rootUsage } | undefined)?.usage
    const usage = rootUsage ?? messageUsage
    if (!usage) return undefined
    const inputTokens = Math.max(0, Number(usage.input_tokens) || 0)
    const outputTokens = Math.max(0, Number(usage.output_tokens) || 0)
    if (!inputTokens && !outputTokens) return undefined
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
  }
  const usage = body.usage as
    { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
  if (!usage) return undefined
  const inputTokens = Math.max(0, Number(usage.prompt_tokens) || 0)
  const outputTokens = Math.max(0, Number(usage.completion_tokens) || 0)
  const totalTokens = Math.max(inputTokens + outputTokens, Number(usage.total_tokens) || 0)
  if (!totalTokens) return undefined
  return { inputTokens, outputTokens, totalTokens }
}

export function streamedTextFromEvent(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): string {
  if (protocol === 'anthropic-compatible') {
    const delta = body.delta as { type?: string; text?: string } | undefined
    return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : ''
  }
  const choices = body.choices as Array<{ delta?: Record<string, unknown> }> | undefined
  return responseTextFromJson({ choices: [{ message: choices?.[0]?.delta }] }, protocol)
}

export function streamedReasoningFromEvent(
  body: Record<string, unknown>,
  protocol: MainApiProtocol,
): string | undefined {
  if (protocol === 'anthropic-compatible') {
    const delta = body.delta as { type?: string; thinking?: string; text?: string } | undefined
    if (delta?.type !== 'thinking_delta') return undefined
    return typeof delta.thinking === 'string' ? delta.thinking : combineReasoning(delta.text)
  }
  const choices = body.choices as Array<{ delta?: Record<string, unknown> }> | undefined
  return responseReasoningFromJson({ choices: [{ message: choices?.[0]?.delta }] }, protocol)
}
