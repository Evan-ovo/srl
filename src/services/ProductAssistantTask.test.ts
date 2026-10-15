import { describe, expect, it } from 'vitest'
import { normalizeAssistantTaskTemplate } from './ProductAssistantTask'
import { buildAssistantMessages, getAssistantRequestTools } from './ProductAssistantRequest'
import type { AssistantRequest } from './ProductAssistantService'
const legacy = { id: 'task', name: '检查', steps: ['保存', '重载核对'] }
const skill = {
  ...legacy,
  description: '检查保存失败',
  mode: 'features' as const,
  capabilities: ['skills' as const],
}
const request = {
  presetId: 'p',
  appliedCss: '',
  css: {},
  scopes: [],
  currentScope: 'library',
  history: [{ role: 'user', text: '检查保存' }],
  mode: 'features',
} as AssistantRequest
describe('assistant skills', () => {
  it('preserves old template data and validates a skill without granting permission', () => {
    expect(normalizeAssistantTaskTemplate(legacy)).toEqual(legacy)
    expect(normalizeAssistantTaskTemplate(skill)).toMatchObject(skill)
    expect(() =>
      normalizeAssistantTaskTemplate({ ...skill, capabilities: ['not-real' as never] }),
    ).toThrow('未知')
    expect(() =>
      normalizeAssistantTaskTemplate({ ...skill, mode: 'appearance', capabilities: ['browser'] }),
    ).toThrow('美化')
  })
  it('keeps skill bodies out of ordinary, disabled and incompatible requests', () => {
    expect(JSON.stringify(buildAssistantMessages(request))).not.toContain(skill.description)
    expect(JSON.stringify(buildAssistantMessages({ ...request, taskSkill: skill }))).toContain(
      skill.description,
    )
    expect(
      JSON.stringify(
        buildAssistantMessages({ ...request, taskSkill: skill, toolCallingEnabled: false }),
      ),
    ).not.toContain(skill.description)
    expect(
      JSON.stringify(buildAssistantMessages({ ...request, taskSkill: skill, mode: 'appearance' })),
    ).not.toContain(skill.description)
    const tools = getAssistantRequestTools({
      ...request,
      taskSkill: { ...skill, capabilities: ['source', 'script', 'skills'] },
      canUseNetwork: false,
      canRunPageScripts: false,
    })
    expect(tools.map((item) => item.name)).toContain('read_task_skill')
    expect(tools.map((item) => item.name)).not.toContain('record_task_assessment')
    expect(tools.map((item) => item.name)).not.toContain('read_webpage')
    expect(tools.map((item) => item.name)).not.toContain('run_page_script')
  })
  it('allows appearance skills to recall the current chat and selected or public references', () => {
    const appearance = {
      ...skill,
      mode: 'appearance' as const,
      capabilities: ['history', 'references', 'source'] as const,
    }
    expect(
      normalizeAssistantTaskTemplate({ ...appearance, capabilities: [...appearance.capabilities] }),
    ).toMatchObject(appearance)
    const names = getAssistantRequestTools({
      ...request,
      mode: 'appearance',
      taskSkill: { ...appearance, capabilities: [...appearance.capabilities] },
      canUseNetwork: true,
      canSearchWeb: true,
    }).map(({ name }) => name)
    expect(names).toEqual(
      expect.arrayContaining(['read_conversation', 'read_webpage', 'update_css']),
    )
    expect(names).not.toContain('browser')
  })
})
