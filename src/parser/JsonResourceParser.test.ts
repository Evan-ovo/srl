import { describe, expect, it } from 'vitest'

import { RESOURCE_TYPE } from '../types/Resource'
import { JSON_RESOURCE_PARSER_VERSION, JsonResourceParser } from './JsonResourceParser'

function jsonFile(data: unknown, name = 'resource.json'): File {
  return new File([JSON.stringify(data)], name, { type: 'application/json' })
}

describe('JsonResourceParser', () => {
  const parser = new JsonResourceParser()
  it('accepts explicitly unencrypted key cards without leaking values into metadata, and rejects unmarked private plaintext', async () => {
    const document = {
      format: 'srl-personal-resource',
      version: 1,
      kind: 'secret',
      name: 'Plain key',
      text: '',
      url: '',
      attachments: [],
      fields: [{ id: 'key', label: 'Key', value: 'synthetic-private-value', private: true }],
    }
    const parsed = await parser.parse(jsonFile({ ...document, protection: 'none' }))
    expect(parsed.type).toBe('secret')
    expect(parsed.metadata).toMatchObject({ secretProtection: 'none', privateFieldCount: 1 })
    expect(JSON.stringify(parsed)).not.toContain('synthetic-private-value')
    await expect(parser.parse(jsonFile(document))).rejects.toThrow('保护方式')
    await expect(
      parser.parse(
        jsonFile({
          ...document,
          protection: 'none',
          fields: Array.from({ length: 30 }, (_, i) => ({
            id: String(i),
            label: 'Key',
            value: 'x'.repeat(80000),
            private: true,
          })),
        }),
      ),
    ).rejects.toThrow('2 MB')
  })
  it('keeps Tavern bindings distinct from persona-specific character variants', async () => {
    const cardHash = 'a'.repeat(64)
    const result = await parser.parse(
      jsonFile({
        personas: { 'alice.png': 'Alice' },
        persona_descriptions: {
          'alice.png': {
            description: 'Global',
            connections: [{ type: 'character', id: 'native.png' }],
            srl_persona_character_bindings: {
              'native.png': { avatar: 'native.png', name: '酒馆绑定卡', hash: cardHash },
              'profile.png': { avatar: 'profile.png', name: '专属人设卡', hash: cardHash },
            },
            srl_persona_profile: {
              version: 1,
              sections: [{ id: 'base', name: '基础设定', text: 'Global' }],
              variants: {
                'profile.png': { defaultVersionId: 'v1', versions: { v1: { name: 'v1' } } },
              },
            },
          },
        },
      }),
    )

    expect(result.metadata).toMatchObject({
      personaNativeCharacterNames: ['酒馆绑定卡'],
      personaProfileCharacterNames: ['专属人设卡'],
      personaCharacterNames: ['酒馆绑定卡', '专属人设卡'],
    })
  })

  it('classifies portable opening sets without mistaking them for character cards', async () => {
    const payload = {
      format: 'srl-greeting',
      version: 1,
      name: '开场',
      first_mes: ' <body>主开场白</body> ',
      alternate_greetings: [' 备用一 '],
      companion_scripts: [],
    }
    expect(await parser.parse(jsonFile(payload))).toMatchObject({
      type: RESOURCE_TYPE.GREETING,
      name: '开场',
      metadata: { itemCount: 2 },
    })
    await expect(parser.parse(jsonFile({ ...payload, alternate_greetings: [23] }))).rejects.toThrow(
      '开场白资源',
    )
    await expect(parser.parse(jsonFile({ ...payload, version: 2 }))).rejects.toThrow('不支持')
  })

  it.each([
    ['world book', { name: 'Lore', entries: { 0: { content: 'Text' } } }, RESOURCE_TYPE.WORLD_BOOK],
    [
      'SillyTavern persona backup',
      {
        personas: { 'alice.png': 'Alice' },
        persona_descriptions: {
          'alice.png': { description: 'Archivist', position: 0, lorebook: 'Archive' },
        },
        default_persona: 'alice.png',
      },
      RESOURCE_TYPE.USER_PERSONA,
    ],
    [
      'quick reply set',
      {
        version: 2,
        name: 'Tools',
        disableSend: false,
        qrList: [{ label: 'Run', message: '/run' }],
      },
      RESOURCE_TYPE.QUICK_REPLY,
    ],
    [
      'regex script',
      { scriptName: 'Clean', findRegex: '/foo/g', replaceString: 'bar', placement: [2] },
      RESOURCE_TYPE.REGEX,
    ],
    [
      'Tavern Helper regex view',
      {
        id: 'clean',
        script_name: 'Clean',
        enabled: true,
        find_regex: '/foo/g',
        replace_string: 'bar',
      },
      RESOURCE_TYPE.REGEX,
    ],
    [
      'theme',
      { name: 'Archive', blur_strength: 12, main_text_color: 'rgba(1,2,3,1)' },
      RESOURCE_TYPE.BEAUTIFICATION,
    ],
    [
      'generation preset',
      { chat_completion_source: 'openai', temperature: 1, top_p: 1, openai_max_context: 8192 },
      RESOURCE_TYPE.PRESET,
    ],
    [
      'extension manifest',
      { display_name: 'Notebook', loading_order: 10, js: 'index.js', css: 'style.css' },
      RESOURCE_TYPE.PLUGIN,
    ],
    [
      'STscript',
      { type: 'stscript', name: 'Greeting', script: '/echo hello' },
      RESOURCE_TYPE.SCRIPT,
    ],
    [
      'Tavern Helper script',
      {
        id: 'scroll-tools',
        name: '回顶/回底',
        content: "(function () { 'use strict'; const version = '1.0' })()",
        info: '工具脚本',
        buttons: [{ name: '回顶' }],
      },
      RESOURCE_TYPE.SCRIPT,
    ],
    ['unknown object', { title: 'Data', values: [1, 2, 3] }, RESOURCE_TYPE.OTHER],
  ])('detects %s', async (_label, data, expectedType) => {
    expect((await parser.parse(jsonFile(data))).type).toBe(expectedType)
  })

  it('detects a collection of regex scripts', async () => {
    const result = await parser.parse(
      jsonFile([
        { scriptName: 'One', findRegex: 'one', replaceString: '1' },
        { scriptName: 'Two', findRegex: 'two', replaceString: '2' },
      ]),
    )

    expect(result.type).toBe(RESOURCE_TYPE.REGEX)
    expect(result.description).toContain('2 条')
  })

  it('uses the file name for a legacy single global regex labeled only by its scope', async () => {
    const script = { scriptName: '清理思维链', findRegex: '/foo/g', replaceString: 'bar' }
    const result = await parser.parse(
      jsonFile({ global: [script], sourceName: '全局正则' }, '清理思维链.json'),
    )

    expect(result).toMatchObject({
      type: RESOURCE_TYPE.REGEX,
      name: '清理思维链',
      metadata: { regexScope: 'global', sourceName: '全局正则', itemCount: 1 },
    })
  })

  it('keeps the source name of a multi-script global regex collection', async () => {
    const scripts = [
      { scriptName: '一', findRegex: '/one/g', replaceString: '1' },
      { scriptName: '二', findRegex: '/two/g', replaceString: '2' },
    ]
    const result = await parser.parse(
      jsonFile({ global: scripts, sourceName: '全局正则' }, '规则备份.json'),
    )

    expect(result.name).toBe('全局正则')
    expect(result.metadata).toMatchObject({ regexScope: 'global', itemCount: 2 })
  })

  it('detects a Tavern Helper script tree and counts scripts inside folders', async () => {
    const result = await parser.parse(
      jsonFile([
        {
          type: 'script',
          id: 'single',
          name: '单条脚本',
          enabled: true,
          content: 'const single = true',
          button: { enabled: true, buttons: [] },
        },
        {
          type: 'folder',
          id: 'tools',
          name: '工具',
          scripts: [
            {
              type: 'script',
              id: 'nested',
              name: '嵌套脚本',
              enabled: true,
              content: 'const nested = true',
              button: { enabled: true, buttons: [{ name: '运行', visible: true }] },
            },
          ],
        },
      ]),
    )

    expect(result).toMatchObject({
      type: RESOURCE_TYPE.SCRIPT,
      description: '酒馆助手脚本库，包含 2 个脚本',
      metadata: {
        parserVersion: JSON_RESOURCE_PARSER_VERSION,
        detectedVariant: 'tavernHelperScriptTree',
        itemCount: 2,
      },
    })
  })

  it('extracts JSON character card metadata and tags', async () => {
    const card = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Archivist',
        description: 'Keeps the archive.',
        personality: 'Careful',
        scenario: 'In a library',
        first_mes: 'Welcome.',
        mes_example: '{{char}}: Hello',
        tags: [' Library, Reference ', 'Quiet', 'Library'],
        creator: 'SRL',
        character_version: '2.0',
        alternate_greetings: ['Good evening.'],
      },
    }

    const result = await parser.parse(jsonFile(card, 'Archivist.json'))

    expect(result.type).toBe(RESOURCE_TYPE.CHARACTER_CARD)
    expect(result.name).toBe('Archivist')
    expect(result.description).toBe('Keeps the archive.')
    expect(result.tags).toEqual(['Library', 'Reference', 'Quiet'])
    expect(result.metadata).toMatchObject({
      parserVersion: JSON_RESOURCE_PARSER_VERSION,
      detectedVariant: 'characterCardJson',
      creator: 'SRL',
      characterVersion: '2.0',
      card,
    })
  })

  it('does not mistake plain content packages for executable scripts', async () => {
    const result = await parser.parse(
      jsonFile({ id: 'note', name: 'Note', content: 'plain text', info: 'memo', buttons: [] }),
    )

    expect(result.type).toBe(RESOURCE_TYPE.OTHER)
  })

  it('detects preset-owned regex scripts and exposes their count', async () => {
    const result = await parser.parse(
      jsonFile({
        name: 'Writer preset',
        temperature: 0.8,
        top_p: 0.9,
        top_k: 40,
        prompts: [{ identifier: 'main', content: 'Write clearly.' }],
        prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
        extensions: {
          regex_scripts: [
            {
              scriptName: 'Panel',
              findRegex: '<panel>(.*?)</panel>',
              replaceString: '<div>$1</div>',
            },
          ],
        },
      }),
    )

    expect(result).toMatchObject({
      type: RESOURCE_TYPE.PRESET,
      description: 'SillyTavern 生成与提示词预设 · 1 条配套正则',
      metadata: {
        parserVersion: JSON_RESOURCE_PARSER_VERSION,
        presetRegexCount: 1,
        promptCount: 1,
      },
    })
  })

  it('rejects primitive JSON roots', async () => {
    await expect(parser.parse(jsonFile('text'))).rejects.toThrow('JSON 顶层必须是对象或数组')
  })
})
