import { describe, expect, it } from 'vitest'

import {
  applyEntryEdit,
  auditPresetAssembly,
  buildBaseAssembly,
  buildFavoriteEntry,
  buildPickEntry,
  buildStitchReview,
  createPresetPromptSlotMacro,
  defaultStitchName,
  estimatePromptSimilarity,
  getPromptDisplayTokens,
  listPromptVariables,
  listPresetRegexScripts,
  listPromptSetVariables,
  listPresetSegments,
  parsePresetText,
  readPresetPromptSlots,
  serializeStitchedPreset,
  stitchPreset,
} from './PresetStitcher'

function makeBase(): Record<string, unknown> {
  return {
    temperature: 0.8,
    custom_unknown_field: { keep: true },
    prompts: [
      {
        identifier: 'main',
        name: '主提示',
        role: 'system',
        content: '你是一个助手。',
        system_prompt: true,
        extra_field: 'keep-me',
      },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
      { identifier: 'orphan-1', name: '孤儿段', role: 'system', content: '不在顺序里' },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ],
  }
}

function makeSource(): Record<string, unknown> {
  return {
    prompts: [
      { identifier: 'style-1', name: '文风段', role: 'system', content: '用轻小说文风。' },
      { identifier: 'main', name: '主提示', role: 'system', content: '来源里的同名主提示' },
      { identifier: 'srcMarker', name: 'World Info', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: 'style-1', enabled: true },
          { identifier: 'main', enabled: false },
          { identifier: 'srcMarker', enabled: true },
        ],
      },
    ],
    extensions: {
      regex_scripts: [
        { id: 'rx-1', scriptName: '状态栏正则', findRegex: '/a/g', replaceString: 'b' },
      ],
    },
  }
}

describe('listPresetSegments', () => {
  it.each([100001, '100001'])('优先使用酒馆全局排序组 %s，而不是更长的旧组', (id) => {
    const base = makeBase()
    base.prompt_order = [
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'orphan-1', enabled: true },
          { identifier: 'chatHistory', enabled: false },
        ],
      },
      {
        character_id: id,
        order: [
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'main', enabled: false },
        ],
      },
    ]
    const original = JSON.stringify(base)
    expect(listPresetSegments(base).map((s) => [s.identifier, s.enabled, s.inOrder])).toEqual([
      ['chatHistory', true, true],
      ['main', false, true],
      ['orphan-1', false, false],
    ])
    const assembly = buildBaseAssembly(base)
    expect(assembly.map((s) => s.identifier)).toEqual(['chatHistory', 'main'])
    const output = stitchPreset(base, assembly).preset
    expect(
      (output.prompt_order as { character_id: unknown; order: unknown[] }[]).find(
        (group) => String(group.character_id) === '100001',
      )?.order,
    ).toEqual([
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'main', enabled: false },
    ])
    expect(JSON.stringify(base)).toBe(original)
  })

  it('全局组为空时不借用旧组的排序或启停状态', () => {
    const base = makeBase()
    base.prompt_order = [
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
      { character_id: 100001, order: [] },
    ]
    expect(listPresetSegments(base).every((s) => !s.inOrder && !s.enabled)).toBe(true)
    expect(buildBaseAssembly(base)).toEqual([])
  })

  it('没有全局组的旧格式使用首个有效组，不按组长度猜测', () => {
    const base = makeBase()
    base.prompt_order = [
      { character_id: 8, order: null },
      { character_id: 9, order: [{ identifier: 'chatHistory', enabled: true }] },
      {
        character_id: 10,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ]
    expect(buildBaseAssembly(base).map((s) => s.identifier)).toEqual(['chatHistory'])
  })

  it('按 prompt_order 排序，marker 标记为不可缝，孤儿段附在末尾', () => {
    const segments = listPresetSegments(makeBase())
    expect(segments.map((s) => s.identifier)).toEqual(['main', 'chatHistory', 'orphan-1'])
    expect(segments[0].stitchable).toBe(true)
    expect(segments[0].role).toBe('system')
    expect(segments[1].marker).toBe(true)
    expect(segments[1].stitchable).toBe(false)
    expect(segments[2].inOrder).toBe(false)
    expect(segments[2].enabled).toBe(false)
  })

  it('停用状态来自 prompt_order 的 enabled', () => {
    const segments = listPresetSegments(makeSource())
    expect(segments.find((s) => s.identifier === 'main')?.enabled).toBe(false)
    expect(segments.find((s) => s.identifier === 'style-1')?.enabled).toBe(true)
  })
})

describe('候选检查工具', () => {
  it('高亮宏时保留原文，并区分读取、写入和普通宏', () => {
    const value = getPromptDisplayTokens(
      '<daily_limits>{{user}} {{getvar::mood}} {{setvar::mood::warm}}</daily_limits>',
    )
    expect(value).toEqual([
      { text: '<daily_limits>', kind: 'plain' },
      { text: '{{user}}', kind: 'plain' },
      { text: ' ', kind: 'plain' },
      { text: '{{getvar::mood}}', kind: 'read' },
      { text: ' ', kind: 'plain' },
      { text: '{{setvar::mood::warm}}', kind: 'write' },
      { text: '</daily_limits>', kind: 'plain' },
    ])
  })

  it('识别正文近似度与 setvar 写入变量', () => {
    expect(estimatePromptSimilarity(' 你好 世界 ', '你好世界')).toBe(1)
    expect(estimatePromptSimilarity('完全不同', '另一个条目')).toBeLessThan(0.72)
    expect(listPromptSetVariables('{{setvar::mood::warm}} {{setglobalvar::scene::night}}')).toEqual(
      ['mood', 'scene'],
    )
  })

  it('区分聊天与全局变量读写，并检查未配对宏和未关闭条件块', () => {
    expect(
      listPromptVariables(
        '{{getvar::mood}} {{setvar::mood::warm}} {{getglobalvar::mood}} {{setglobalvar::mood::cold}}',
      ),
    ).toEqual([
      { scope: 'chat', operation: 'read', name: 'mood' },
      { scope: 'chat', operation: 'write', name: 'mood' },
      { scope: 'global', operation: 'read', name: 'mood' },
      { scope: 'global', operation: 'write', name: 'mood' },
    ])

    const assembly = buildBaseAssembly(makeBase())
    applyEntryEdit(assembly[0], {
      name: '错误宏',
      role: 'system',
      content: '{{getvar::missing}} }} {{if mood}}没有结束',
    })
    const report = auditPresetAssembly(assembly)
    expect(report.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['braces', 'condition', 'unwritten-read']),
    )
  })

  it('识别酒馆变量简写、读存在宏、增减写入和带保留空白标记的条件块', () => {
    expect(
      listPromptVariables(
        '{{.localRead}} {{$globalRead}} {{ .localWrite = yes }} {{ $globalWrite ||= ready }} {{.score += 10}} {{.fallback ?? Guest}} {{.status == active}} {{hasvar::known}} {{incglobalvar::count}}',
      ),
    ).toEqual([
      { scope: 'chat', operation: 'read', name: 'localRead' },
      { scope: 'global', operation: 'read', name: 'globalRead' },
      { scope: 'chat', operation: 'write', name: 'localWrite' },
      { scope: 'global', operation: 'write', name: 'globalWrite' },
      { scope: 'chat', operation: 'write', name: 'score' },
      { scope: 'chat', operation: 'read', name: 'fallback' },
      { scope: 'chat', operation: 'read', name: 'status' },
      { scope: 'chat', operation: 'read', name: 'known' },
      { scope: 'global', operation: 'write', name: 'count' },
    ])

    const assembly = buildBaseAssembly(makeBase())
    applyEntryEdit(assembly[0], {
      name: '保留空白条件',
      role: 'system',
      content: '{{ # if .localRead }}没有结束',
    })
    expect(auditPresetAssembly(assembly).issues.map((issue) => issue.kind)).toContain('condition')
  })

  it('只在两个启用条目写入同一作用域变量时提示重复写入', () => {
    const assembly = buildBaseAssembly(makeBase())
    const first = assembly[0]
    const second = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    const global = buildPickEntry('res-b', '来源预设', makeSource(), 'main')!
    applyEntryEdit(first, { name: first.name, role: first.role, content: '{{setvar::mood::warm}}' })
    applyEntryEdit(second, {
      name: second.name,
      role: second.role,
      content: '{{setvar::mood::cold}}',
    })
    applyEntryEdit(global, {
      name: global.name,
      role: global.role,
      content: '{{setglobalvar::mood::cold}}',
    })
    const report = auditPresetAssembly([...assembly, second, global])
    expect(report.issues.filter((issue) => issue.kind === 'repeated-write')).toHaveLength(1)
    expect(report.issues.find((issue) => issue.kind === 'repeated-write')?.title).toContain(
      '聊天：mood',
    )
    second.enabled = false
    expect(
      auditPresetAssembly([...assembly, second, global]).issues.filter(
        (issue) => issue.kind === 'repeated-write',
      ),
    ).toHaveLength(0)
  })
})

describe('stitchPreset', () => {
  it('空挑选返回与底板语义等价的副本，未知字段透传', () => {
    const base = makeBase()
    const { preset, provenance } = stitchPreset(base, buildBaseAssembly(base))
    expect(provenance).toEqual([])
    expect(JSON.parse(serializeStitchedPreset(preset))).toEqual(base)
  })

  it('无冲突挑选段插入 prompts 并按装配顺序进入 prompt_order', () => {
    const base = makeBase()
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    const assembly = [...buildBaseAssembly(base)]
    assembly.splice(1, 0, pick)
    const { preset, provenance } = stitchPreset(base, assembly)
    const prompts = preset.prompts as Record<string, unknown>[]
    expect(prompts.map((p) => p.identifier)).toContain('style-1')
    const order = (preset.prompt_order as { order: { identifier: string }[] }[])[0].order
    expect(order.map((o) => o.identifier)).toEqual(['main', 'style-1', 'chatHistory'])
    expect(provenance).toEqual([
      {
        kind: 'segment',
        resourceId: 'res-b',
        resourceName: '来源预设',
        identifier: 'style-1',
        finalIdentifier: 'style-1',
        name: '文风段',
      },
    ])
  })

  it('identifier 冲突时换新 uuid 并加「·缝」后缀，原底板段不动', () => {
    const base = makeBase()
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'main')!
    const assembly = [...buildBaseAssembly(base), pick]
    const { preset, provenance } = stitchPreset(base, assembly)
    const prompts = preset.prompts as Record<string, unknown>[]
    const added = prompts.find((p) => p.content === '来源里的同名主提示')!
    expect(added.identifier).not.toBe('main')
    expect(added.name).toBe('主提示·缝')
    expect(prompts.find((p) => p.identifier === 'main')?.name).toBe('主提示')
    expect(provenance[0].finalIdentifier).toBe(added.identifier)
    const order = (preset.prompt_order as { order: { identifier: string }[] }[])[0].order
    expect(order.at(-1)?.identifier).toBe(added.identifier)
  })

  it('marker 段不可作为挑选单元', () => {
    expect(buildPickEntry('res-b', '来源预设', makeSource(), 'srcMarker')).toBeUndefined()
  })

  it('导出占位项清单与最终 prompt identifier 对齐，并声明空值隐藏整条', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base)
    const macro = createPresetPromptSlotMacro('文风', 'slot-0001')
    applyEntryEdit(assembly[0]!, {
      name: '角色文风',
      role: 'system',
      content: `写作风格：${macro}`,
    })

    const { preset } = stitchPreset(base, assembly)
    expect((preset.prompts as Record<string, unknown>[])[0]?.content).toBe(`写作风格：${macro}`)
    expect(preset.extensions).toMatchObject({
      srl_prompt_slots: {
        schemaVersion: 1,
        entries: [
          {
            identifier: 'main',
            name: '角色文风',
            emptyBehavior: 'hide-entry',
            slots: [{ id: 'slot-0001', label: '文风' }],
          },
        ],
      },
    })
  })

  it('装配区停用底板段只改 prompt_order 的 enabled', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base)
    assembly[0].enabled = false
    const { preset } = stitchPreset(base, assembly)
    const order = (
      preset.prompt_order as { order: { identifier: string; enabled: boolean }[] }[]
    )[0].order
    expect(order[0]).toEqual({ identifier: 'main', enabled: false })
    const prompts = preset.prompts as Record<string, unknown>[]
    expect(prompts.find((p) => p.identifier === 'main')?.extra_field).toBe('keep-me')
  })

  it('编辑只写入工作副本中的已识别 prompt 字段，底板未知字段保持不变', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base)
    applyEntryEdit(assembly[0], {
      name: '改写主提示',
      role: 'assistant',
      content: '你好 {{user}}，我是 {{char}}。',
    })
    const { preset } = stitchPreset(base, assembly)
    const prompt = (preset.prompts as Record<string, unknown>[]).find(
      (item) => item.identifier === 'main',
    )!
    expect(prompt).toMatchObject({
      name: '改写主提示',
      role: 'assistant',
      content: '你好 {{user}}，我是 {{char}}。',
      extra_field: 'keep-me',
      system_prompt: true,
    })
    expect(preset.custom_unknown_field).toEqual({ keep: true })
    expect((base.prompts as Record<string, unknown>[])[0].name).toBe('主提示')
  })

  it('评审归为新增、删除、修改三类，修改项合并正文、启停和顺序变化', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base)
    applyEntryEdit(assembly[0], { name: '主提示', role: 'system', content: '已编辑' })
    assembly[0].enabled = false
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    assembly.splice(0, 2, pick, assembly[1], assembly[0])
    const review = buildStitchReview(base, assembly, [
      {
        sourceResourceId: 'res-b',
        sourceName: '来源预设',
        scripts: listPresetRegexScripts(makeSource()),
      },
    ])
    expect(review.map((item) => item.kind)).toEqual(['add', 'edit', 'edit', 'regex'])
    expect(review.find((item) => item.kind === 'add')?.detail).toContain('最前面')
    expect(review.find((item) => item.kind === 'add')?.afterContent).toBe('用轻小说文风。')
    const mainEdit = review.find((item) => item.beforeContent === '你是一个助手。')
    expect(mainEdit?.afterContent).toBe('已编辑')
    expect(mainEdit?.detail).toContain('状态：启用 → 停用')
    expect(mainEdit?.detail).toContain('顺序：第 1 位 → 第 2 位')
  })

  it('修改新加入的来源条目仍只算新增，并展示最终正文', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base)
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    applyEntryEdit(pick, { name: '专属文风', role: 'system', content: '最终写作规则' })
    assembly.push(pick)

    const review = buildStitchReview(base, assembly)
    expect(review.map((item) => item.kind)).toEqual(['add'])
    expect(review[0]?.afterContent).toBe('最终写作规则')
  })

  it('被移出装配的底板条目列为删除并保留被删正文', () => {
    const base = makeBase()
    const assembly = buildBaseAssembly(base).filter((entry) => entry.identifier !== 'main')

    const removed = buildStitchReview(base, assembly).find((item) => item.kind === 'remove')
    expect(removed).toMatchObject({
      title: '删除「主提示」',
      beforeContent: '你是一个助手。',
    })
  })

  it('收藏快照可独立构建挑选行，不依赖来源资源仍保留完整 prompt', () => {
    const favorite = buildFavoriteEntry({
      id: 'favorite-1',
      sourceResourceId: 'deleted-source',
      sourceName: '已删除来源',
      identifier: 'style-1',
      name: '收藏文风',
      role: 'system',
      content: '收藏内容',
      prompt: { identifier: 'style-1', name: '收藏文风', role: 'system', content: '收藏内容' },
      createdAt: 1,
      updatedAt: 1,
    })
    const { preset, provenance } = stitchPreset(makeBase(), [
      ...buildBaseAssembly(makeBase()),
      favorite,
    ])
    expect((preset.prompts as Record<string, unknown>[]).at(-1)?.content).toBe('收藏内容')
    expect(provenance.at(-1)?.resourceId).toBe('deleted-source')
  })

  it('整组正则并入 extensions.regex_scripts，id 冲突换新', () => {
    const base = makeBase()
    const source = makeSource()
    const scripts = listPresetRegexScripts(source)
    const first = stitchPreset(base, buildBaseAssembly(base), [
      { sourceResourceId: 'res-b', sourceName: '来源预设', scripts },
    ])
    const merged = (first.preset.extensions as { regex_scripts: Record<string, unknown>[] })
      .regex_scripts
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('rx-1')
    // 再缝一次同组：id 已占用则换新
    const second = stitchPreset(first.preset, buildBaseAssembly(first.preset), [
      { sourceResourceId: 'res-b', sourceName: '来源预设', scripts },
    ])
    const twice = (second.preset.extensions as { regex_scripts: Record<string, unknown>[] })
      .regex_scripts
    expect(twice).toHaveLength(2)
    expect(twice[1].id).not.toBe('rx-1')
    expect(second.provenance[0].kind).toBe('regex')
  })

  it('底板没有 prompt_order 时为挑选段新建默认顺序组', () => {
    const base = { prompts: [] }
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    const { preset } = stitchPreset(base, [pick])
    const groups = preset.prompt_order as { character_id: number; order: unknown[] }[]
    expect(groups[0].character_id).toBe(100001)
    expect(groups[0].order).toEqual([{ identifier: 'style-1', enabled: true }])
  })

  it('多 character 组同步重建，各组私有条目保留在末尾', () => {
    const base = makeBase()
    ;(base.prompt_order as Record<string, unknown>[]).push({
      character_id: 100000,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'group-only', enabled: true },
      ],
    })
    const pick = buildPickEntry('res-b', '来源预设', makeSource(), 'style-1')!
    const { preset } = stitchPreset(base, [...buildBaseAssembly(base), pick])
    const groups = preset.prompt_order as { order: { identifier: string }[] }[]
    expect(groups[1].order.map((o) => o.identifier)).toEqual([
      'main',
      'chatHistory',
      'style-1',
      'group-only',
    ])
  })
})

describe('辅助函数', () => {
  it('创建并识别命名占位宏，拒绝会破坏语法的名称', () => {
    const macro = createPresetPromptSlotMacro('状态栏', 'slot-0002')
    expect(macro).toBe('{{srl_slot::slot-0002::状态栏}}')
    expect(readPresetPromptSlots(`状态：${macro} ${macro}`)).toEqual([
      { id: 'slot-0002', label: '状态栏' },
    ])
    expect(() => createPresetPromptSlotMacro('状态:栏', 'slot-0003')).toThrow(/不能包含/)
  })

  it('parsePresetText 拒绝非对象顶层', () => {
    expect(parsePresetText('[1,2]')).toBeUndefined()
    expect(parsePresetText('not json')).toBeUndefined()
    expect(parsePresetText('{"a":1}')).toEqual({ a: 1 })
  })

  it('defaultStitchName 处理空名称', () => {
    expect(defaultStitchName('破限A')).toBe('破限A·缝合')
    expect(defaultStitchName('  ')).toBe('未命名预设·缝合')
  })
})
