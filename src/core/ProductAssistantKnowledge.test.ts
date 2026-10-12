import { describe, expect, it } from 'vitest'
import {
  assistantFeatureSourceRepositories,
  assistantKnowledgeForMode,
  DEFAULT_ASSISTANT_PROMPTS,
  findAssistantFeatureGuides,
  summarizeAssistantProblem,
} from './ProductAssistantKnowledge'

describe('assistant focused work and result-only replies', () => {
  it('uses the same minimal-tool and outcome-only rules in every active mode', () => {
    for (const mode of ['auto', 'features', 'appearance', 'creation'] as const) {
      const prompt = assistantKnowledgeForMode(mode)
      expect(prompt).toContain('已有可靠信息足以回答时直接回答，不为证明而调用工具')
      expect(prompt).toContain('已有充分证据或目标状态达成就停止')
      expect(prompt).toContain('不要把每次工具调用写成进度播报')
      expect(prompt).toContain('结束时只报告实际结果')
      expect(prompt).toContain('询问教程、用法或操作步骤时，优先在聊天中直接说明，不自动跳转')
      expect(prompt).toContain('查到一条覆盖问题的功能指南后停止，不为证明再读源码')
      expect(prompt).toContain('常规入口和教程不查GitHub')
    }
  })

  it('keeps the work discipline when tool calling is disabled', () => {
    expect(DEFAULT_ASSISTANT_PROMPTS.chat).toContain('已有可靠信息足以回答时直接回答')
    expect(DEFAULT_ASSISTANT_PROMPTS.chat).toContain('结束时只报告实际结果')
  })
})

describe('assistant verified feature guidance', () => {
  it('解释多线路预览下载的确认、平台范围和设备负担', () => {
    const guide = findAssistantFeatureGuides('增加多线路下载怎么开启')[0]
    expect(guide?.id).toBe('appearance')
    expect(guide?.steps.join()).toContain('HTML / CSS 预览安全')
    expect(guide?.steps.join()).toContain('3路提高到最多6路')
    expect(guide?.steps.join()).toContain('网页普通图片仍由浏览器调度')
    expect(guide?.troubleshooting.join()).toContain('不保证两倍速度')
  })
  it.each(['怎么从dc保存帖子', 'discord的帖子内容保存', '收件箱配对', '保存帖子到SRL'])(
    'finds dedicated post-saving guidance for %s instead of file download',
    (query) => {
      const guide = findAssistantFeatureGuides(query)[0]
      expect(guide?.id).toBe('discord-posts')
      expect(guide?.entry).toEqual(['功能', '收件箱', '连接设置'])
      expect(guide?.steps[0]).toContain('资源下载')
      expect(guide?.steps[0]).toContain('垃圾桶图标选择清理帖子收件、资源下载或两者')
      expect(guide?.steps.join()).toContain('只清理已完成的云端记录，本机内容不受影响')
      expect(guide?.steps.join()).toContain('待整理来源')
      expect(guide?.steps.join()).toContain('关联所选资源')
      expect(guide?.troubleshooting.join()).toContain('不等于本机已经保存')
      expect(guide?.owners[0]).toBe('src/components/DiscordSourceHandoffIntake.vue')
      expect(guide?.implementation).toContain('saveDelivery')
      expect(guide?.implementation).toContain('先保存并校验本机正文')
    },
  )
  it('finds operational steps and implementation owners from natural Chinese questions', () => {
    const [guide] = findAssistantFeatureGuides('我怎么导入世界书？导入以后需要确认什么？')
    expect(guide?.id).toBe('import')
    expect(guide?.steps.join()).toContain('等待确认')
    expect(guide?.owners).toContain('src/composables/UseLibraryImport.ts')
    expect(findAssistantFeatureGuides('AI 改了 CSS 但是美化预设没生效')[0]?.id).toBe('appearance')
    expect(findAssistantFeatureGuides('WebDAV 云备份失败')[0]?.id).toBe('backup')
    expect(findAssistantFeatureGuides('link-import')[0]?.id).toBe('link-import')
    expect(findAssistantFeatureGuides('缝了么打不开')[0]?.id).toBe('stitch')
  })
  it('explains that the Tavern extension instructions live in a collapsed connection-help panel', () => {
    const guide = findAssistantFeatureGuides('酒馆互传扩展怎么安装')[0]
    expect(guide?.id).toBe('bridge')
    expect(guide?.steps.join()).toContain('连接帮助 → 查看')
    expect(guide?.steps.join()).toContain('Install Extension')
    expect(guide?.steps.join()).toContain('离线 / 备用安装（ZIP 下载）')
  })
  it('suggests only the public repository associated with the selected feature', () => {
    const discord = assistantFeatureSourceRepositories([{ id: 'discord-posts' }])
    expect(discord.map(({ url }) => url)).toEqual([
      'https://github.com/jixiangruyi117/SillyTavernResourceLibrary-Public',
      'https://github.com/jixiangruyi117/SRL-Discord-Bridge',
    ])
    expect(discord[1].purpose).toContain('Worker 服务端模板')

    const tavern = assistantFeatureSourceRepositories([{ id: 'bridge' }])
    expect(tavern.map(({ url }) => url)).toEqual([
      'https://github.com/jixiangruyi117/SillyTavernResourceLibrary-Public',
      'https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge',
    ])
    expect(tavern[1].purpose).toContain('页面扩展和服务端兼容插件')
    expect(assistantFeatureSourceRepositories([{ id: 'import' }])).toHaveLength(1)
  })
  it.each([
    ['前端了么怎么把AI改动写进源码', 'frontend-workshop'],
    ['读了么的阅读正则为什么把整楼隐藏了', 'chat-reader'],
    ['NovelAI图生图要在哪里配置', 'image-generation'],
    ['生图结果怎么存到生图相册', 'image-album'],
    ['user才是老大怎么设置角色差分', 'user-persona'],
    ['抽了么怎么筛选七日未见', 'draw'],
    ['收藏柜拖动后会移动原文件吗', 'folders'],
    ['reasoning_content的400错误和主API有关吗', 'api'],
    ['AI标签建议需要审核才会写入吗', 'ai-tagging'],
    ['小手机里的私密字段谁能读', 'personal-resources'],
    ['图库怎么设置资源封面', 'gallery'],
    ['保险库和回收站有什么区别', 'data-protection'],
  ])('finds dedicated guidance for %s', (query, id) => {
    const guide = findAssistantFeatureGuides(query)[0]
    expect(guide?.id).toBe(id)
    expect(guide?.entry.length).toBeGreaterThan(0)
    expect(guide?.steps.length).toBeGreaterThan(0)
    expect(guide?.troubleshooting.length).toBeGreaterThan(0)
    expect(guide?.owners.length).toBeGreaterThan(0)
    if (id === 'data-protection') {
      expect(guide?.entry).toContain('本地保险库 / 回收站')
      expect(guide?.steps[0]).toContain('高亮“数据保护”按钮')
    }
  })
  it('bounds matching and excludes login even when mixed with another feature', () => {
    expect(findAssistantFeatureGuides('登录以后 CSS 失效')).toEqual([])
    expect(findAssistantFeatureGuides('login import')).toEqual([])
    expect(findAssistantFeatureGuides('')).toEqual([])
    expect(findAssistantFeatureGuides('未知按钮')).toEqual([])
    expect(findAssistantFeatureGuides('导入 CSS 云备份 APP 历史版本')).toHaveLength(3)
  })
})

describe('assistant error classifications', () => {
  it.each([
    ['HTTP 429', 'rate-limit'],
    ['API 返回 403', 'access'],
    ['状态码：404', 'not-found'],
    ['HTTP 503', 'network'],
    ['TypeError: Failed to fetch', 'network'],
    ['QuotaExceededError', 'storage'],
    ['ZIP 校验失败', 'format'],
    ['工具参数未结束，回复被截断', 'truncated'],
    ['模型不支持图片', 'unsupported'],
    ['CSS 草稿已变化，未覆盖手动修改', 'conflict'],
    ['AbortError', 'cancelled'],
    ['尚无可核验证据', 'unknown'],
  ])('returns a fixed category for %s without retaining error contents', (hint, kind) => {
    const value = summarizeAssistantProblem(
      new Error(
        `${hint} private-file.json https://example.com/?token=SECRET at privateFunction:99`,
      ),
    )
    expect(value.kind).toBe(kind)
    expect(value.nextStep).toBeTruthy()
    expect(JSON.stringify(value)).not.toMatch(/private-file|example.com|SECRET|privateFunction/u)
  })
  it('does not accept arbitrary numbers or objects as diagnostic evidence', () => {
    expect(summarizeAssistantProblem('HTTP 999').httpStatus).toBeUndefined()
    expect(summarizeAssistantProblem('HTTP 200').httpStatus).toBeUndefined()
    expect(summarizeAssistantProblem({ raw: 'PRIVATE_SECRET' })).toMatchObject({ kind: 'unknown' })
  })
})
