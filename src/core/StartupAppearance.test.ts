/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStartupAppearance,
  placeStartupAppearanceAfterApplicationStyles,
} from './StartupAppearance'
import { CUSTOM_UI_STYLE_ID } from '../services/BrowserAppearancePreferences'

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.getElementById(CUSTOM_UI_STYLE_ID)?.remove()
  document.getElementById('srl-test-application-style')?.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

describe('启动页复用现有自定义CSS与恢复事务', () => {
  it('启动即读取已应用CSS，重复调用只有原来的一个style，保留保存内容', () => {
    const css = ':root { --boot-background:#ffeafa } #srl-boot h1 { font-size:24px }'
    localStorage.setItem('srl.ui.customCss', css)
    localStorage.setItem('srl-theme', 'dark')
    applyStartupAppearance()
    applyStartupAppearance()
    expect(document.querySelectorAll('#' + CUSTOM_UI_STYLE_ID)).toHaveLength(1)
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)?.textContent).toBe(css)
    expect(localStorage.getItem('srl.ui.customCss')).toBe(css)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('主界面样式加载后将用户CSS移到末尾，使全局颜色变量覆盖默认值', () => {
    localStorage.setItem('srl.ui.customCss', ':root { --color-accent: #e45a9b }')
    applyStartupAppearance()
    const applicationStyle = document.createElement('style')
    applicationStyle.id = 'srl-test-application-style'
    applicationStyle.textContent = ':root { --color-accent: #1d707b }'
    document.head.append(applicationStyle)

    placeStartupAppearanceAfterApplicationStyles()

    const styles = [...document.head.querySelectorAll('style')]
    expect(styles.indexOf(applicationStyle)).toBeLessThan(
      styles.indexOf(document.getElementById(CUSTOM_UI_STYLE_ID) as HTMLStyleElement),
    )
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)?.textContent).toContain('#e45a9b')
  })
  it('中断的试用先恢复上版CSS和Vue，避免启动又应用未确认样式', () => {
    localStorage.setItem('srl.ui.customCss', '*{display:none}')
    localStorage.setItem(
      'srl.appearance.pending.v1',
      JSON.stringify({
        previousCss: '#srl-boot { color:purple }',
        nextCss: '*{display:none}',
        expiresAt: 1,
        previousViews: '{}',
      }),
    )
    applyStartupAppearance()
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)?.textContent).toContain('color:purple')
    expect(localStorage.getItem('srl.ui.customCss')).toContain('color:purple')
    expect(localStorage.getItem('srl.appearance.pending.v1')).toBeNull()
    expect(localStorage.getItem('srl.ui.customViews.v1')).toBe('{}')
  })
  it('安全模式不注入CSS，不清除用户样式或预设', () => {
    localStorage.setItem('srl.ui.customCss', '*{display:none}')
    sessionStorage.setItem('srl.safeMode.session.v1', 'safe')
    applyStartupAppearance()
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)).toBeNull()
    expect(localStorage.getItem('srl.ui.customCss')).toBe('*{display:none}')
  })
  it('联网遵守已有设置，关闭时阻止外部资源但保留局部图片', () => {
    localStorage.setItem(
      'srl.ui.customCss',
      '#srl-boot { background:url(https://example.com/a.png) }',
    )
    applyStartupAppearance()
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)?.textContent).not.toContain('example.com')
    localStorage.setItem('srl.preview.allowRemoteResources', 'true')
    applyStartupAppearance()
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)?.textContent).toContain('example.com')
  })
  it('存储不可读时仍能正常启动，不创建额外缓存', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => applyStartupAppearance()).not.toThrow()
    expect(document.getElementById(CUSTOM_UI_STYLE_ID)).toBeNull()
  })
})
