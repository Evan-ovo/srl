/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest'
import { readUiViewPreview, updateUiViewPreview } from './UiViewPreview'

afterEach(() => document.body.replaceChildren())

it('只读预览保留当前页面文字和控件，排除私密内容且不提交真实操作', () => {
  const root = document.createElement('main')
  root.className = 'library'
  root.innerHTML =
    '<h1>实际列表</h1><input aria-label="搜索" value="当前条件"><button>导出</button><section data-private>不允许读取</section>'
  const handler = vi.fn()
  root.querySelector('button')!.onclick = handler
  document.body.append(root)
  const { snapshot, live } = readUiViewPreview('library', '资源库')
  expect(live).toBe(true)
  expect(snapshot.html).toContain('实际列表')
  expect(snapshot.html).not.toContain('不允许读取')
  expect(snapshot.html).toContain('data-srl-view-root')
  const button = snapshot.controls.find((item) => item.label === '导出')!
  updateUiViewPreview(snapshot, { id: button.id, event: 'click' })
  expect(handler).not.toHaveBeenCalled()
  const input = snapshot.controls.find((item) => item.label === '搜索')!
  const changed = updateUiViewPreview(snapshot, { id: input.id, event: 'input', value: '预览条件' })
  expect(changed.controls.find((item) => item.id === input.id)?.value).toBe('预览条件')
  expect(root.querySelector('input')!.value).toBe('当前条件')
})

it('未显示或联网预览使用明确的APP示例，不读取现场', () => {
  document.body.innerHTML = '<main class="library"><button>真实资源</button></main>'
  const fixture = readUiViewPreview('library', '资源库', false)
  expect(fixture.live).toBe(false)
  expect(fixture.snapshot.html).not.toContain('真实资源')
  expect(fixture.snapshot.html).toContain('资源库')
  expect(() => updateUiViewPreview(fixture.snapshot, { id: 'expired', event: 'click' })).toThrow()
})
