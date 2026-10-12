import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MainApiService, type MainApiTool, type MainApiMessage } from './MainApiService'
import type { LocalCredentialRepository } from './LocalCredentialStore'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

class MemoryCredentialStore implements LocalCredentialRepository {
  readonly values = new Map<string, string>()
  async save(identifier: string, secret: string) {
    this.values.set(identifier, secret)
  }
  async read(identifier: string) {
    return this.values.get(identifier) ?? ''
  }
  async clear(identifier: string) {
    this.values.delete(identifier)
  }
}

describe('native tool calling transport', () => {
  it.each(['', '  原始思考\n\n'])(
    'replays DeepSeek reasoning exactly, including empty values: %j',
    async (reasoning) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    reasoning_content: reasoning,
                    tool_calls: [
                      {
                        id: 'r',
                        type: 'function',
                        function: { name: 'read_css', arguments: '{"scope":"library"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: '完成', reasoning_content: '最终思考' },
                },
              ],
            }),
          ),
        )
      vi.stubGlobal('fetch', fetcher)
      const service = new MainApiService()
      const config = {
        ...service.getConfig(),
        url: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      }
      const tools: MainApiTool[] = [
        {
          name: 'read_css',
          description: 'read',
          parameters: {
            type: 'object',
            properties: { scope: { type: 'string' } },
            required: ['scope'],
            additionalProperties: false,
          },
        },
      ]
      const first = await service.completeWithUsage([{ role: 'user', content: '读样式' }], config, {
        tools,
      })
      expect(first.reasoning).toBe(reasoning)
      await service.completeWithUsage(
        [
          { role: 'assistant', content: '旧回复，无原始思考' },
          { role: 'user', content: '继续' },
          {
            role: 'assistant',
            content: first.text,
            reasoning: first.reasoning,
            toolCalls: first.toolCalls,
          },
          { role: 'tool', content: '{}', toolCallId: 'r' },
        ],
        config,
        { tools },
      )
      const body = JSON.parse(fetcher.mock.calls[1]![1].body)
      expect(body.messages[0].reasoning_content).toBe('')
      expect(body.messages[2].reasoning_content).toBe(reasoning)
    },
  )
  it.each([0, 4096])(
    'keeps connection tests at 8 tokens without changing the saved output limit (%s)',
    async (maxTokens) => {
      const service = new MainApiService()
      service.saveConfig({ ...service.getConfig(), maxTokens })
      const complete = vi.spyOn(service, 'complete').mockResolvedValue('OK')
      await service.testConnection()
      expect(complete.mock.calls[0]![1]?.maxTokens).toBe(8)
      expect(service.getConfig().maxTokens).toBe(maxTokens)
    },
  )
  const config = { url: 'https://example.com/v1', model: 'test', maxTokens: 1000, stream: true }
  const tools: MainApiTool[] = [
    {
      name: 'read_css',
      description: '读取样式',
      parameters: {
        type: 'object',
        properties: { scope: { type: 'string' } },
        required: ['scope'],
        additionalProperties: false,
      },
    },
  ]
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.restoreAllMocks()
  })
  it.each([0, 32000])(
    'uses query-only Responses search and respects the configured output limit %s',
    async (maxTokens) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 30 },
            output: [
              { type: 'web_search_call', status: 'completed' },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '公开资料',
                    annotations: [
                      { type: 'url_citation', url: 'https://example.com/docs', title: '资料' },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      )
      vi.stubGlobal('fetch', fetcher)
      const service = new MainApiService()
      const reply = await service.completeWithUsage(
        [{ role: 'user', content: '公开查询' }],
        { ...config, maxTokens, url: 'https://example.com/v1/chat/completions' },
        { webSearch: true },
      )
      expect(fetcher.mock.lastCall![0]).toBe('https://example.com/v1/responses')
      const body = JSON.parse(fetcher.mock.lastCall![1].body)
      if (maxTokens) expect(body.max_output_tokens).toBe(maxTokens)
      else expect(body).not.toHaveProperty('max_output_tokens')
      expect(body).toMatchObject({
        store: false,
        stream: false,
        tool_choice: 'required',
        tools: [{ type: 'web_search' }],
      })
      expect(reply.sources).toEqual([{ title: '资料', url: 'https://example.com/docs' }])
      expect(reply.usage.totalTokens).toBe(50)
      expect(reply.toolCalls).toBeUndefined()
      expect(service.getConfig().stream).toBe(false)
    },
  )
  it('preserves the Anthropic Messages endpoint and native search citations', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            { type: 'server_tool_use', name: 'web_search' },
            {
              type: 'web_search_tool_result',
              content: [{ type: 'web_search_result', url: 'https://example.com/docs' }],
            },
            {
              type: 'text',
              text: '资料',
              citations: [
                {
                  type: 'web_search_result_location',
                  url: 'https://example.com/docs',
                  title: '资料',
                },
              ],
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const reply = await new MainApiService().completeWithUsage(
      [{ role: 'user', content: '公开查询' }],
      { ...config, protocol: 'anthropic-compatible' },
      { webSearch: true },
    )
    expect(fetcher.mock.lastCall![0]).toBe('https://example.com/v1/messages')
    expect(JSON.parse(fetcher.mock.lastCall![1].body).tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
    ])
    expect(JSON.parse(fetcher.mock.lastCall![1].body).max_tokens).toBe(config.maxTokens)
    await expect(
      new MainApiService().completeWithUsage(
        [{ role: 'user', content: '公开查询' }],
        { ...config, protocol: 'anthropic-compatible', maxTokens: 0 },
        { webSearch: true },
      ),
    ).rejects.toThrow('Anthropic Messages 协议要求')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(reply.sources).toHaveLength(1)
  })
  it('never claims an ordinary model answer is searched and does not retry unsupported search', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '我想当然的回答' }] }],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(
      new MainApiService().completeWithUsage([{ role: 'user', content: '公开查询' }], config, {
        webSearch: true,
      }),
    ).rejects.toThrow('未执行搜索')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('accepts tool-only OpenAI replies and preserves call IDs and native tool results', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call1',
                      type: 'function',
                      function: { name: 'read_css', arguments: '{"scope":"library"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '已读取' } }] }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    const service = new MainApiService()
    const messages: MainApiMessage[] = [{ role: 'user', content: '读取资源库样式' }]
    const result = await service.completeWithUsage(messages, config, { tools })
    expect(result.toolCalls).toEqual([
      { id: 'call1', name: 'read_css', arguments: '{"scope":"library"}' },
    ])
    expect(result.usage.source).toBe('estimated')
    await service.completeWithUsage(
      [
        ...messages,
        { role: 'assistant', content: '', toolCalls: result.toolCalls },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call1' },
      ],
      config,
      { tools },
    )
    const body = JSON.parse(fetcher.mock.calls[1]![1].body)
    expect(body).toMatchObject({ stream: false, tool_choice: 'auto', parallel_tool_calls: false })
    expect(body.tools[0].function).toMatchObject({
      name: 'read_css',
      strict: true,
      parameters: { additionalProperties: false },
    })
    expect(body.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call1',
            type: 'function',
            function: { name: 'read_css', arguments: '{"scope":"library"}' },
          },
        ],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call1' },
    ])
  })
  it.each(['calls', 'tool_calls'])(
    'recovers complete DSML %s through the existing tool protocol',
    async (wrapper) => {
      const dsml = `<｜DSML｜${wrapper}><｜DSML｜invoke name="read_css"><｜DSML｜parameter name="scope" string="true">library</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜${wrapper}>`
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: dsml, reasoning_content: 'original reasoning' },
                },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: '已读取' } }],
            }),
          ),
        )
      vi.stubGlobal('fetch', fetcher)
      const service = new MainApiService()
      const deepseek = {
        ...config,
        url: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-flash',
      }
      const first = await service.completeWithUsage(
        [{ role: 'user', content: '读样式' }],
        deepseek,
        { tools },
      )
      expect(first.text).toBe('')
      expect(first.toolCalls).toHaveLength(1)
      expect(first.toolCalls![0]).toMatchObject({
        name: 'read_css',
        arguments: '{"scope":"library"}',
      })
      expect(first.toolCalls![0]!.id).toBeTruthy()
      expect(first.reasoning).toBe('original reasoning')
      await service.completeWithUsage(
        [
          {
            role: 'assistant',
            content: first.text,
            toolCalls: first.toolCalls,
            reasoning: first.reasoning,
          },
          { role: 'tool', toolCallId: first.toolCalls![0]!.id, content: '{"ok":true}' },
        ],
        deepseek,
        { tools },
      )
      const replay = JSON.parse(fetcher.mock.calls[1]![1].body).messages
      expect(replay[0]).toMatchObject({
        content: null,
        reasoning_content: 'original reasoning',
        tool_calls: [
          {
            id: first.toolCalls![0]!.id,
            function: { name: 'read_css', arguments: '{"scope":"library"}' },
          },
        ],
      })
      expect(replay[1].tool_call_id).toBe(first.toolCalls![0]!.id)
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )
  it.each(['｜', '|', '｜｜', '||'])(
    'preserves DSML %s parameter types and call order',
    async (pipe) => {
      const token = `${pipe}DSML${pipe}`
      const content = `<${token}tool_calls><${token}invoke name="read_css"><${token}parameter name="scope" string="true">a & <b>\n c</${token}parameter><${token}parameter name="options" string="false">{"offset":2,"enabled":false,"items":["x"],"empty":null}</${token}parameter></${token}invoke><${token}invoke name="read_css"></${token}invoke></${token}tool_calls>`
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content } }] }))),
      )
      const reply = await new MainApiService().completeWithUsage(
        [{ role: 'user', content: '读' }],
        config,
        { tools },
      )
      expect(reply.toolCalls).toHaveLength(2)
      expect(JSON.parse(reply.toolCalls![0]!.arguments)).toEqual({
        scope: 'a & <b>\n c',
        options: { offset: 2, enabled: false, items: ['x'], empty: null },
      })
      expect(reply.toolCalls![1]!.arguments).toBe('{}')
      expect(reply.toolCalls![0]!.id).not.toBe(reply.toolCalls![1]!.id)
    },
  )
  it.each(['｜DSML｜', '｜｜DSML｜｜ '])(
    'keeps native calls authoritative over %s text without executing twice',
    async (marker) => {
      const content = `<${marker}calls><${marker}invoke name="read_css"></${marker}invoke></${marker}calls>`
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content,
                    tool_calls: [
                      {
                        id: 'native',
                        type: 'function',
                        function: { name: 'read_css', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            }),
          ),
        ),
      )
      const reply = await new MainApiService().completeWithUsage(
        [{ role: 'user', content: '读' }],
        config,
        { tools },
      )
      expect(reply.toolCalls).toEqual([{ id: 'native', name: 'read_css', arguments: '{}' }])
      expect(reply.text).toBe('')
    },
  )
  it.each([
    '<｜DSML｜calls><｜DSML｜invoke name="unknown"></｜DSML｜invoke></｜DSML｜calls>',
    '<｜DSML｜calls><｜DSML｜invoke name="read_css"><｜DSML｜parameter name="scope" string="true">library</｜DSML｜parameter><｜DSML｜parameter name="scope" string="true">other</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>',
    '<｜DSML｜calls><｜DSML｜invoke name="read_css"><｜DSML｜parameter name="scope" string="false">not-json</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>',
    '<｜DSML｜calls><｜DSML｜invoke name="read_css">',
    '<｜DSML｜calls></｜DSML｜calls>',
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="unknown"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_css">',
    '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_css"><｜｜DSML｜｜ parameter name="scope" string="true">a</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="scope" string="true">b</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
  ])('rejects ambiguous/incomplete DSML without a retry or a success reply', async (content) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    await expect(
      new MainApiService().completeWithUsage([{ role: 'user', content: '读' }], config, { tools }),
    ).rejects.toThrow('工具调用')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['｜DSML｜', '｜｜DSML｜｜ '])(
    'does not turn quoted %s examples into tools',
    async (marker) => {
      const content = `这是协议示例：\n\`\`\`xml\n<${marker}calls><${marker}invoke name="read_css"></${marker}invoke></${marker}calls>\n\`\`\``
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content } }] }))),
      )
      const reply = await new MainApiService().completeWithUsage(
        [{ role: 'user', content: '解释协议' }],
        config,
        { tools },
      )
      expect(reply.text).toBe(content)
      expect(reply.toolCalls).toBeUndefined()
    },
  )
  it.each(['｜DSML｜', '｜｜DSML｜｜ '])(
    'does not execute %s blocks when tools are disabled',
    async (marker) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: `<${marker}calls><${marker}invoke name="read_css"></${marker}invoke></${marker}calls>`,
                  },
                },
              ],
            }),
          ),
        ),
      )
      await expect(
        new MainApiService().completeWithUsage([{ role: 'user', content: '读' }], {
          ...config,
          stream: false,
        }),
      ).rejects.toThrow('工具调用')
    },
  )
  it('preserves signed Anthropic blocks and groups all results into one user message', async () => {
    const content = [
      { type: 'thinking', thinking: 'thinking', signature: 'signed' },
      { type: 'tool_use', id: 'a', name: 'read_css', input: { scope: 'library' } },
      { type: 'tool_use', id: 'b', name: 'read_css', input: { scope: 'details' } },
    ]
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stop_reason: 'tool_use', content })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] }),
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    const service = new MainApiService()
    const override = { ...config, protocol: 'anthropic-compatible' as const }
    const first = await service.completeWithUsage([{ role: 'user', content: '读取' }], override, {
      tools,
    })
    await service.completeWithUsage(
      [
        { role: 'user', content: '读取' },
        {
          role: 'assistant',
          content: first.text,
          toolCalls: first.toolCalls,
          providerContent: first.providerContent,
        },
        { role: 'tool', toolCallId: 'a', content: '读取成功' },
        { role: 'tool', toolCallId: 'b', content: '区域不存在', toolError: true },
      ],
      override,
      { tools },
    )
    const body = JSON.parse(fetcher.mock.calls[1]![1].body)
    expect(body.tools[0]).toEqual({
      name: tools[0]!.name,
      description: tools[0]!.description,
      input_schema: tools[0]!.parameters,
    })
    expect(body.messages[1].content).toEqual(content)
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '读取成功' },
        { type: 'tool_result', tool_use_id: 'b', content: '区域不存在', is_error: true },
      ],
    })
    expect(body.stream).toBe(false)
  })
  it.each(['', 'duplicate'])(
    'rejects incomplete/duplicate OpenAI call IDs (%s) before execution',
    async (invalid) => {
      const entry = {
        id: invalid ? 'same' : '',
        type: 'function',
        function: { name: 'read_css', arguments: '{}' },
      }
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [{ message: { tool_calls: invalid ? [entry, entry] : [entry] } }],
            }),
          ),
        ),
      )
      await expect(
        new MainApiService().completeWithUsage([{ role: 'user', content: '读' }], config, {
          tools,
        }),
      ).rejects.toThrow('工具调用')
    },
  )
})

describe('MainApiService', () => {
  it('reports partial stream text before unexpected EOF and marks the reply incomplete', async () => {
    const service = new MainApiService()
    const onText = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    )
    const result = await service.completeWithUsage(
      [{ role: 'user', content: 'hello' }],
      { url: 'https://example.com', model: 'test', stream: true },
      { onText },
    )
    expect(onText).toHaveBeenCalledWith('partial')
    expect(result).toMatchObject({ text: 'partial', finishReason: 'incomplete' })
  })
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('imports a complete profile state and keeps its selected profile', () => {
    const service = new MainApiService()
    const imported = service.importProfilesState({
      activeProfileId: 'remote',
      profiles: [
        {
          id: 'remote',
          name: '远端',
          protocol: 'openai-compatible',
          url: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'test',
          stream: false,
          reasoningEffort: 'auto',
          temperature: 0.7,
          topP: 1,
          maxTokens: 0,
          frequencyPenalty: 0,
          presencePenalty: 0,
        },
      ],
    })

    expect(imported.activeProfileId).toBe('remote')
    expect(service.getConfig().apiKey).toBe('secret')
  })

  it('moves a legacy plaintext API key into protected storage and rehydrates it', async () => {
    localStorage.setItem(
      'srl.mainApi.profiles.v2',
      JSON.stringify({
        activeProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: '主 API',
            protocol: 'openai-compatible',
            url: 'https://api.example.com/v1',
            apiKey: 'legacy-secret',
            model: 'example-model',
          },
        ],
      }),
    )
    const credentials = new MemoryCredentialStore()
    const first = new MainApiService(credentials)

    await first.initializeCredentials()

    expect(credentials.values.get('main-api:default')).toBe('legacy-secret')
    expect(localStorage.getItem('srl.mainApi.profiles.v2')).not.toContain('legacy-secret')
    expect(localStorage.getItem('srl.mainApi.config.v1')).toBeNull()

    const reopened = new MainApiService(credentials)
    await reopened.initializeCredentials()
    expect(reopened.getConfig().apiKey).toBe('legacy-secret')
  })

  it('keeps session-only API keys out of persistent storage', async () => {
    const credentials = new MemoryCredentialStore()
    const service = new MainApiService(credentials)
    await service.initializeCredentials()
    service.saveProfile({
      ...service.getActiveProfile(),
      apiKey: 'temporary-secret',
      credentialPersistence: 'session',
    })
    await service.awaitCredentialWrites()

    expect(service.getConfig().apiKey).toBe('temporary-secret')
    expect(credentials.values.size).toBe(0)
    expect(localStorage.getItem('srl.mainApi.profiles.v2')).not.toContain('temporary-secret')
  })

  it('does not delete legacy plaintext when protected migration fails', async () => {
    localStorage.setItem(
      'srl.mainApi.config.v1',
      JSON.stringify({
        protocol: 'openai-compatible',
        url: 'https://api.example.com/v1',
        apiKey: 'keep-on-failure',
      }),
    )
    const credentials = new MemoryCredentialStore()
    credentials.save = async () => {
      throw new Error('device store unavailable')
    }
    const service = new MainApiService(credentials)

    await expect(service.initializeCredentials()).rejects.toThrow('device store unavailable')
    expect(localStorage.getItem('srl.mainApi.config.v1')).toContain('keep-on-failure')
    expect(service.getConfig().apiKey).toBe('keep-on-failure')
  })

  it('uses an OpenAI-compatible chat-completions endpoint and parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    service.saveConfig({
      protocol: 'openai-compatible',
      url: 'https://api.example.com/v1',
      apiKey: 'secret',
      model: 'example-model',
      stream: false,
      reasoningEffort: 'low',
      temperature: 0.4,
      topP: 0.8,
      maxTokens: 393216,
      frequencyPenalty: 0.2,
      presencePenalty: -0.1,
    })

    await expect(service.complete([{ role: 'user', content: 'hello' }])).resolves.toBe('OK')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/chat/completions')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'example-model',
      temperature: 0.4,
      top_p: 0.8,
      max_tokens: 393216,
      reasoning_effort: 'low',
    })
  })

  it('returns provider token usage and falls back to a marked estimate when absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '完成' } }],
            usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '继续完成' } }] }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    const config = {
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'usage-model',
    }

    await expect(
      service.completeWithUsage([{ role: 'user', content: '生成状态栏' }], config),
    ).resolves.toMatchObject({
      text: '完成',
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        source: 'provider',
      },
    })
    const estimated = await service.completeWithUsage(
      [{ role: 'user', content: '继续生成状态栏' }],
      config,
    )
    expect(estimated.usage.source).toBe('estimated')
    expect(estimated.usage.totalTokens).toBeGreaterThan(0)
  })

  it.each([false, true])('不把兼容接口内容数组中的推理拼进 JSON 正文 stream=%s', async (stream) => {
    const content = [
      { type: 'reasoning', text: '先分析范围' },
      { type: 'thinking', text: '再生成补丁' },
      { type: 'text', text: '{"edits":[]}' },
    ]
    const body = stream
      ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
      : JSON.stringify({ choices: [{ message: { content } }] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const service = new MainApiService()
    const result = await service.completeWithUsage([{ role: 'user', content: '修改' }], {
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'test',
      stream,
    })
    expect(JSON.parse(result.text)).toEqual({ edits: [] })
    expect(result.reasoning).toBe('先分析范围\n再生成补丁')
  })

  it.each(['openai-compatible', 'anthropic-compatible'] as const)(
    '保留 %s 的非流式和流式输出截断原因',
    async (protocol) => {
      const openai = protocol === 'openai-compatible'
      const body = openai
        ? { choices: [{ message: { content: '{' }, finish_reason: 'length' }] }
        : { content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens' }
      const events = openai
        ? [
            { choices: [{ delta: { content: '{' } }] },
            { choices: [{ delta: {}, finish_reason: 'length' }] },
          ]
        : [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: '{' } },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
          ]
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response(JSON.stringify(body)))
          .mockResolvedValueOnce(
            new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
          ),
      )
      const service = new MainApiService()
      const config = {
        ...service.getConfig(),
        url: 'https://api.example.com/v1',
        model: 'test',
        protocol,
        maxTokens: 128,
      }
      for (const stream of [false, true]) {
        await expect(
          service.completeWithUsage([{ role: 'user', content: '修改' }], { ...config, stream }),
        ).resolves.toMatchObject({ text: '{', finishReason: openai ? 'length' : 'max_tokens' })
      }
    },
  )

  it('只返回 Provider 明确提供的非流式 reasoning 字段', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '完成', reasoning_content: '先核对结构，再生成补丁。' } },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: '先确认写入范围。' },
              { type: 'text', text: '完成' },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    const base = { ...service.getConfig(), url: 'https://api.example.com/v1', model: 'reasoning' }

    await expect(
      service.completeWithUsage([{ role: 'user', content: '修改' }], base),
    ).resolves.toMatchObject({ text: '完成', reasoning: '先核对结构，再生成补丁。' })
    await expect(
      service.completeWithUsage([{ role: 'user', content: '修改' }], {
        ...base,
        protocol: 'anthropic-compatible',
        maxTokens: 2048,
      }),
    ).resolves.toMatchObject({ text: '完成', reasoning: '先确认写入范围。' })
  })

  it('honors a caller timeout beyond the former 600 second cap without changing saved config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new MainApiService()
    const config = {
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'slow-model',
    }

    await expect(
      service.completeWithUsage([{ role: 'user', content: 'hello' }], config, {
        timeoutMs: 900_000,
      }),
    ).resolves.toMatchObject({ text: 'OK' })

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 900_000)
    expect(service.getConfig()).not.toHaveProperty('timeoutMs')
  })

  it('does not add an automatic timeout when the caller does not set one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '慢慢完成' } }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const service = new MainApiService()
    const config = {
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'slow-model',
    }

    await expect(
      service.completeWithUsage([{ role: 'user', content: '继续' }], config),
    ).resolves.toMatchObject({ text: '慢慢完成' })

    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('passes caller cancellation to the in-flight provider fetch', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('cancelled', 'AbortError')),
              { once: true },
            )
          }),
      ),
    )
    const service = new MainApiService()
    const pending = service.complete(
      [{ role: 'user', content: '分析' }],
      { ...service.getConfig(), url: 'https://api.example.com/v1', model: 'cancel-model' },
      { signal: controller.signal, timeoutMs: null },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('translates reference images for OpenAI-compatible vision models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    const config = {
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'vision-model',
    }

    await service.complete(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '只参考配色' },
            { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
          ],
        },
      ],
      config,
    )

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ content: unknown[] }>
    }
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '只参考配色' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' },
      },
    ])
  })

  it('uses automatic token limits by default and parses an OpenAI-compatible stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"先检查"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"你"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"好"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    service.saveConfig({
      ...service.getConfig(),
      url: 'https://api.example.com/v1',
      model: 'stream-model',
      stream: true,
      maxTokens: 0,
    })

    await expect(
      service.completeWithUsage([{ role: 'user', content: 'hello' }]),
    ).resolves.toMatchObject({ text: '你好', reasoning: '先检查' })
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('pulls and normalizes available models from the configured models endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'model-b', owned_by: 'example' },
            { id: 'model-a', name: 'Model A' },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()

    await expect(
      service.listModels({
        ...service.getConfig(),
        url: 'https://api.example.com/v1/chat/completions',
        apiKey: 'secret',
      }),
    ).resolves.toEqual([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'model-b' },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/models')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer secret',
    )
  })

  it('parses Anthropic-compatible text deltas and requires an explicit token limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先确认"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"完"}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"成"}}',
            '',
          ].join('\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()
    const config = {
      ...service.getConfig(),
      protocol: 'anthropic-compatible' as const,
      url: 'https://api.example.com/v1',
      model: 'claude-example',
      stream: true,
      maxTokens: 2048,
    }

    await expect(
      service.completeWithUsage([{ role: 'user', content: 'hello' }], config),
    ).resolves.toMatchObject({ text: '完成', reasoning: '先确认' })
    await expect(
      service.complete([{ role: 'user', content: 'hello' }], { ...config, maxTokens: 0 }),
    ).rejects.toThrow('Anthropic Messages 协议要求')
  })

  it('translates reference images for Anthropic-compatible vision models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '完成' }] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = new MainApiService()

    await service.complete(
      [
        { role: 'system', content: '设计状态栏' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '参考结构' },
            { type: 'image', dataUrl: 'data:image/webp;base64,AQID' },
          ],
        },
      ],
      {
        ...service.getConfig(),
        protocol: 'anthropic-compatible',
        url: 'https://api.example.com/v1',
        model: 'claude-vision',
        maxTokens: 2048,
      },
    )

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ content: unknown[] }>
    }
    expect(body.messages[0]?.content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'AQID' },
    })
  })

  it('migrates the old single config and keeps multiple named profiles', () => {
    localStorage.setItem(
      'srl.mainApi.config.v1',
      JSON.stringify({
        protocol: 'openai-compatible',
        url: 'https://old.example.com/v1',
        model: 'old-model',
      }),
    )
    const service = new MainApiService()

    expect(service.getActiveProfile()).toMatchObject({
      name: '原主 API',
      url: 'https://old.example.com/v1',
    })

    const second = service.createProfile('绘图接口')
    service.saveProfile({
      ...second,
      url: 'https://new.example.com/v1',
      model: 'new-model',
    })
    service.setActiveProfile(second.id)

    expect(service.getProfiles()).toHaveLength(2)
    expect(service.getConfig()).toMatchObject({
      url: 'https://new.example.com/v1',
      model: 'new-model',
      maxTokens: 0,
      stream: false,
      reasoningEffort: 'auto',
    })
  })

  it('migrates the former 4096 default to automatic without changing newer profiles', () => {
    localStorage.setItem(
      'srl.mainApi.profiles.v2',
      JSON.stringify({
        activeProfileId: 'legacy',
        profiles: [
          {
            id: 'legacy',
            name: '旧配置',
            protocol: 'openai-compatible',
            url: 'https://api.example.com/v1',
            apiKey: '',
            model: 'example-model',
            temperature: 0.7,
            topP: 1,
            maxTokens: 4096,
            frequencyPenalty: 0,
            presencePenalty: 0,
          },
        ],
      }),
    )

    expect(new MainApiService().getConfig().maxTokens).toBe(0)
  })

  it('does not allow deleting the last API profile', () => {
    const service = new MainApiService()
    const only = service.getActiveProfile()

    expect(() => service.deleteProfile(only.id)).toThrow('至少保留一个')
  })
})
