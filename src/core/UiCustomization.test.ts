/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createUiView, normalizeUiViews, resolveUiCssAssets } from './UiCustomization'
import { BrowserStorageService } from '../services/BrowserStorageService'
import { createUiDomSession, UI_PRIVATE_SELECTOR } from '../services/UiViewDom'
import { createUiViewDocument } from '../services/UiViewRuntime'
import { recoverInterruptedAppearance } from './AppearanceSafety'
import { CUSTOM_UI_VIEWS_KEY } from '../types/UiCustomization'

afterEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
})
describe('可编辑界面项目', () => {
  it('复制 Vue 响应式草稿，导入关闭运行和网络，保留全部文件与素材', () => {
    const view = { ...createUiView(), enabled: true, allowNetwork: true }
    view.files.push({ path: '按钮.svg', contents: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const saved = normalizeUiViews(reactive({ library: view }))
    expect(saved.library?.enabled).toBe(true)
    expect(normalizeUiViews(saved, true).library).toEqual({
      ...view,
      enabled: false,
      allowNetwork: false,
    })
    saved.library!.files[0]!.contents = 'changed'
    expect(view.files[0]!.contents).not.toBe('changed')
    expect(
      resolveUiCssAssets('a{background:url("srl-ui-asset:library/按钮.svg")}', { library: view }),
    ).toContain('data:image/svg+xml;charset=utf-8,')
    expect(resolveUiCssAssets('a{background:url("srl-ui-asset:library/missing.png")}', saved)).toBe(
      'a{background:none}',
    )
  })
  it.each(['../escape.vue', '/root.vue', 'a//b.vue', 'a/./b.vue', 'a\\b.vue'])(
    '拒绝越界或歧义路径 %s',
    (path) => {
      expect(() =>
        normalizeUiViews({
          library: { ...createUiView(), entryPath: path, files: [{ path, contents: '' }] },
        }),
      ).toThrow()
    },
  )
  it('拒绝重复文件、原型键、无效二进制和超过编译器预算的内容', () => {
    const view = createUiView()
    expect(() =>
      normalizeUiViews({ library: { ...view, files: [...view.files, ...view.files] } }),
    ).toThrow()
    expect(() => normalizeUiViews(JSON.parse('{"__proto__":{}}'))).toThrow()
    expect(() =>
      normalizeUiViews({
        library: { ...view, files: [{ path: 'View.vue', contents: '???', encoding: 'base64' }] },
      }),
    ).toThrow()
    expect(() =>
      normalizeUiViews({
        library: { ...view, files: [{ path: 'View.vue', contents: '汉'.repeat(2 * 1024 * 1024) }] },
      }),
    ).toThrow(/5 MiB/u)
  })
  it('存储读回、便携备份恢复和中断恢复均保留项目；恢复不自动运行', () => {
    const storage = new BrowserStorageService()
    const view = { ...createUiView(), enabled: true, allowNetwork: true }
    storage.setCustomUiViews({ library: view })
    const saved = storage.exportAppearanceSettings()
    localStorage.clear()
    storage.importAppearanceSettings(saved)
    expect(storage.getCustomUiViews().library).toEqual({
      ...view,
      enabled: false,
      allowNetwork: false,
    })
    localStorage.setItem(
      'srl.appearance.pending.v1',
      JSON.stringify({
        previousCss: '.safe{}',
        nextCss: '.bad{}',
        expiresAt: Date.now() + 1000,
        previousViews: JSON.stringify({ library: view }),
      }),
    )
    expect(recoverInterruptedAppearance()).toBe('.safe{}')
    expect(JSON.parse(localStorage.getItem(CUSTOM_UI_VIEWS_KEY)!)).toEqual({ library: view })
  })
  it('隔离文档仅启用脚本；网络权限明确区分，不开放父页面或嵌套框架', () => {
    expect(createUiViewDocument('', false)).toContain("connect-src 'none'")
    expect(createUiViewDocument('', true)).toContain('connect-src https:')
    expect(createUiViewDocument('', true)).toContain("frame-src 'none'")
  })
})
describe('界面与原功能的边界', () => {
  it('显式原生工作区保留Shadow实例，正文和内部操作不进入作者快照', () => {
    const root = document.createElement('section')
    const workspace = document.createElement('div')
    workspace.setAttribute('data-srl-native-root', '')
    workspace.setAttribute('aria-label', '读了么阅读工作区')
    const shadow = workspace.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button>内部翻页</button><p>不能复制的正文</p>'
    root.append(workspace)
    document.body.append(root)
    const session = createUiDomSession(root, UI_PRIVATE_SELECTOR)
    const state = session.read()
    expect(state.nativeRegions).toEqual([
      expect.objectContaining({ tag: 'div', label: '读了么阅读工作区' }),
    ])
    expect(state.html).not.toMatch(/不能复制的正文|内部翻页/u)
    expect(state.controls).toEqual([])
    expect(session.native(state.nativeRegions![0]!.id)).toBe(workspace)
    expect(workspace.shadowRoot).toBe(shadow)
  })
  it('原控件执行真实点击、输入；禁用、只读、已移除控件拒绝执行', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<button>执行</button><input aria-label="名字"><input readonly><button disabled>禁用</button>'
    document.body.append(root)
    const session = createUiDomSession(root, UI_PRIVATE_SELECTOR)
    const state = session.read()
    const clicked = vi.fn()
    const input = vi.fn()
    root.querySelector('button')!.addEventListener('click', clicked)
    root.querySelector('input')!.addEventListener('input', input)
    session.invoke({ id: state.controls[0]!.id, event: 'click' })
    session.invoke({ id: state.controls[1]!.id, event: 'input', value: '新名字' })
    expect(clicked).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledOnce()
    expect(root.querySelector('input')!.value).toBe('新名字')
    expect(() =>
      session.invoke({ id: state.controls[2]!.id, event: 'input', value: '禁止' }),
    ).toThrow()
    expect(() => session.invoke({ id: state.controls[3]!.id, event: 'click' })).toThrow()
    root.querySelector('button')!.remove()
    expect(() => session.invoke({ id: state.controls[0]!.id, event: 'click' })).toThrow()
  })
  it('原生阅读器、画布、文件输入及私密区域只提供占位位置，绝不复制密钥值', () => {
    const root = document.createElement('section')
    root.innerHTML =
      '<div data-private><input value="my-private-secret"></div><input type="password" value="another-secret"><canvas></canvas><iframe srcdoc="secret-code"></iframe><input type="file"><details><summary>展开</summary><button>不可见操作</button></details>'
    document.body.append(root)
    const session = createUiDomSession(root, UI_PRIVATE_SELECTOR)
    const state = session.read()
    expect(state.nativeRegions).toHaveLength(5)
    expect(state.html).not.toMatch(/my-private-secret|another-secret|secret-code|不可见操作/u)
    expect(session.native(state.nativeRegions![0]!.id)).toBe(root.firstElementChild)
    expect(() => session.invoke({ id: state.nativeRegions![0]!.id, event: 'click' })).toThrow()
    root.querySelector('details')!.open = true
    expect(session.read().html).toContain('不可见操作')
  })
})
