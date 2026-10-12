import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  checkSourceBudgets,
  countSourceLines,
  inspectSourceStructure,
} from './Check-SourceStructure.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))

const config = {
  defaultMaxLines: 1000,
  exceptions: { 'src/Workflow.vue': { maxLines: 1200, reason: '同一工作流的模板与协调状态' } },
}

describe('source structure budgets', () => {
  it('audits the working tree after a tracked deletion and still reports a stale budget', () => {
    vi.mocked(execFileSync).mockImplementation((_command, args) =>
      args.includes('--deleted') ? 'src/Retired.vue\0' : 'src/Retired.vue\0src/Active.ts\0',
    )
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (String(path).endsWith('SourceStructureBudget.json'))
        return JSON.stringify({
          defaultMaxLines: 1000,
          exceptions: { 'src/Retired.vue': { maxLines: 1200, reason: 'old owner' } },
        })
      if (String(path).endsWith('Active.ts')) return 'export const active = true\n'
      throw new Error('Deleted files must not be read')
    })
    const result = inspectSourceStructure('fixture')
    expect(result.files).toEqual([{ path: 'src/Active.ts', lines: 1 }])
    expect(result.errors).toEqual(['src/Retired.vue: 文件已退出检查范围，请移除旧预算。'])
  })

  it('counts CRLF and LF consistently without charging a final newline', () => {
    expect(countSourceLines('a\r\nb\r\n')).toBe(2)
    expect(countSourceLines('a\nb\n')).toBe(2)
    expect(countSourceLines('')).toBe(0)
  })
  it('rejects a newly introduced oversized module', () => {
    expect(
      checkSourceBudgets([{ path: 'src/New.ts', lines: 1001 }], {
        defaultMaxLines: 1000,
        exceptions: {},
      }),
    ).toHaveLength(1)
  })
  it('allows shrinking a documented workflow but rejects growth', () => {
    expect(checkSourceBudgets([{ path: 'src/Workflow.vue', lines: 1100 }], config)).toEqual([])
    expect(checkSourceBudgets([{ path: 'src/Workflow.vue', lines: 1201 }], config)).toHaveLength(1)
  })
  it('requires retiring exceptions after deletion or sufficient reduction', () => {
    expect(checkSourceBudgets([], config)).toHaveLength(1)
    expect(checkSourceBudgets([{ path: 'src/Workflow.vue', lines: 900 }], config)).toHaveLength(1)
  })
})
