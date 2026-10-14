/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectAssistantAppearance,
  inspectAssistantCssSelectors,
  verifyAssistantAppearance,
} from './ProductAssistantAppearanceInspection'
import type { AppearanceScope } from '../core/AppearanceScopes'

const scope: AppearanceScope = { value: 'library', title: '资源库', selector: '.library', hint: '' }
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('外观检查证据', () => {
  it('优先采样深层控件并保留安全类型/禁用状态，不回传文本、表单值或认证节点', () => {
    document.body.innerHTML = `<main class="library">${'<div class="decorative"></div>'.repeat(100)}<input type="text" value="SECRET" placeholder="SECRET"><select><option>SECRET</option></select><textarea>SECRET</textarea><button role="switch" disabled>SECRET</button><input type="password" value="SECRET"><div data-sensitive><button class="private">SECRET</button></div><div class="auth-portal"><input></div></main>`
    const result = inspectAssistantAppearance(scope, 'dark')
    expect(result.nodes).toHaveLength(64)
    expect(result.nodes.filter((node) => 'control' in node).map((node) => node.control)).toEqual([
      'text',
      'select',
      'textarea',
      'switch',
    ])
    expect(result.nodes.find((node) => node.control === 'switch')?.disabled).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|private|auth-portal|password|placeholder|value/u,
    )
    expect(result.visible).toBe(false)
    expect(result.sampled).toBe(true)
  })

  it('保留条件与零命中证据；不把关键帧或未知容器条件误判为已应用', () => {
    document.body.innerHTML =
      '<main class="library"><button class="save"></button><div class="resource-card"></div></main>'
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const result = inspectAssistantCssSelectors(
      scope,
      ':scope { color: red } .save::before { content:"" } .missing { color:red } @media (min-width: 900px) { .save { color: blue } } @container (width > 500px) { .save { padding: 2px } } @keyframes spin { to { opacity: 0 } }',
    )
    expect(result.rules.find((rule) => rule.selector === '.save::before')?.matched).toBe(1)
    expect(result.rules.find((rule) => rule.selector === '.missing')).toMatchObject({
      matched: 0,
      issue: expect.stringContaining('交互状态'),
    })
    expect(result.rules.find((rule) => rule.conditions[0]?.startsWith('@media'))).toMatchObject({
      matched: 1,
      active: false,
    })
    expect(
      result.rules.find((rule) => rule.conditions[0]?.startsWith('@container'))?.active,
    ).toBeNull()
    expect(result.total).toBe(5)
    expect(result.rules.map((rule) => rule.selector)).not.toContain('to')
  })

  it('识别无条件锁死卡片尺寸；按模式限定的规则保留且不阻止写入', () => {
    document.body.innerHTML = '<main class="library"><div class="resource-card"></div></main>'
    const result = inspectAssistantCssSelectors(
      scope,
      '.resource-card { height: 150px !important } [data-resource-card-height="fixed"] .resource-card { height: 150px }',
    )
    expect(result.layoutRisks).toHaveLength(1)
    expect(result.layoutRisks?.[0]).toContain('可能覆盖横竖/高度切换')
  })

  it('全局匹配排除隐私节点；后台/未挂载不能伪称已视觉验收', () => {
    document.body.innerHTML =
      '<main class="library"></main><aside><button></button></aside><div class="auth-portal"><button></button></div>'
    expect(
      inspectAssistantCssSelectors(scope, 'button { color: red }', true).rules[0]?.matched,
    ).toBe(1)
    document.body.replaceChildren()
    expect(verifyAssistantAppearance(scope, 'light', '.save {color:red}')).toMatchObject({
      available: false,
      visualReview: '未视觉核验',
    })
    expect(() => inspectAssistantAppearance(scope, 'light')).toThrow('尚未挂载')
  })
})
