/** @vitest-environment jsdom */
import { defineComponent, h, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { useProductAssistantTasks } from './UseProductAssistantTasks'
const skill = {
  id: 's',
  name: '核对',
  steps: ['检查'],
  description: '先取证再复验',
  mode: 'features' as const,
  capabilities: ['skills' as const],
  version: 1,
}
function setup() {
  const error = ref('')
  const enabled = ref(true)
  const persist = vi.fn(async () => {})
  const workspace = {
    templates: vi.fn(async () => [skill]),
    templateText: (value: typeof skill) => value.name,
  }
  let tasks!: ReturnType<typeof useProductAssistantTasks>
  const w = mount(
    defineComponent({
      setup() {
        tasks = useProductAssistantTasks({
          error,
          busy: ref(false),
          mode: () => 'features',
          enabled: () => enabled.value,
          isAlive: () => true,
          persist,
          onScopeChange: vi.fn(),
          workspace,
          resources: { get: vi.fn(), getSummary: vi.fn() },
        })
        return () => h('div')
      },
    }),
  )
  return { tasks, w, error, persist, enabled, workspace }
}
it('normalizes a Vue reactive skill snapshot and loads it without executing or reading tools', () => {
  const { tasks, w, workspace } = setup()
  try {
    tasks.useTemplate(reactive(skill))
    expect(tasks.snapshot().taskSkill).toMatchObject(skill)
    expect(tasks.context().taskSkill).toMatchObject(skill)
    tasks.load({ taskSkill: skill, referenceResources: [] })
    expect(workspace.templates).not.toHaveBeenCalled()
  } finally {
    w.unmount()
  }
})
it('does not return a skill body when tool permission is revoked during its read', async () => {
  const { tasks, w, enabled, workspace } = setup()
  try {
    workspace.templates.mockImplementationOnce(async () => {
      enabled.value = false
      return [skill]
    })
    await expect(
      tasks.execute(
        { action: 'task-skills', operation: 'read', args: { id: 's', version: '1' } },
        {
          ...tasks.context(),
          presetId: 'p',
          css: {},
          appliedCss: '',
          scopes: [],
          currentScope: 'library',
          history: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('工具调用已关闭')
  } finally {
    w.unmount()
  }
})
it('strips unrelated backup fields from reference scope and preserves the chat on invalid skill data', () => {
  const { tasks, w, error } = setup()
  try {
    tasks.load({
      taskSkill: { ...skill, capabilities: ['invalid' as never] },
      referenceResources: [
        { id: 'book', name: '书', contentHash: 'hash', credentials: 'must not be copied' } as never,
      ],
    })
    expect(tasks.snapshot().taskSkill).toBeUndefined()
    expect(tasks.snapshot().referenceResources).toEqual([
      { id: 'book', name: '书', contentHash: 'hash' },
    ])
    expect(error.value).toContain('技能数据无效')
  } finally {
    w.unmount()
  }
})
