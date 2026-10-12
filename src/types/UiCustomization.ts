import type { CustomCssScope } from './BrowserPreferences'

export const CUSTOM_UI_VIEWS_KEY = 'srl.ui.customViews.v1'
export const CUSTOM_UI_VIEWS_CHANGED = 'srl:custom-ui-views-changed'

export interface CustomUiFile {
  path: string
  contents: string
  encoding?: 'base64'
}

/** Author files only. Compiled code and live UI state never enter a theme or backup. */
export interface CustomUiView {
  entryPath: string
  files: CustomUiFile[]
  enabled: boolean
  /** Legacy theme field; network access now follows the global preview policy. */
  allowNetwork: boolean
}

export type CustomUiViews = Partial<Record<CustomCssScope, CustomUiView>>
export interface UiApplyOptions {
  assistant?: boolean
  views?: CustomUiViews
}

export interface UiControl {
  /** 当前快照内的操作标识，不得缓存后跨快照调用。 */
  id: string
  /** 控件的可访问名称。 */
  label: string
  /** 原控件的 HTML 标签。 */
  tag: string
  /** 原控件的输入类型。 */
  type: string
  /** 是否不可操作。 */
  disabled: boolean
  /** 允许展示时提供的输入值。 */
  value?: string
  /** 勾选状态；只在相应控件上提供。 */
  checked?: boolean
}

export interface UiViewSnapshot {
  /** 当前界面允许展示的 HTML，已过滤私密内容。 */
  html: string
  /** 当前可调用的原控件列表。 */
  controls: UiControl[]
  /** 当前浅色或深色主题。 */
  theme: string
  /** 当前界面范围。 */
  route?: string
  /** 原界面的排版、字号等环境属性。 */
  environment?: Record<string, string>
  /** 原生区域的 id、标签与名称；原生内容由原 APP 保持。 */
  nativeRegions?: Array<{ id: string; tag: string; label: string }>
}

export interface UiNativePlacement {
  id: string
  top: number
  left: number
  width: number
  height: number
}

export interface UiViewAction {
  /** 最新快照中可用的控件 id。 */
  id: string
  /** 要调用的原事件；仅支持列出的值。 */
  event: 'click' | 'input' | 'change' | 'submit' | 'scroll' | 'keydown'
  /** input/change 事件的字符串值。 */
  value?: string
  /** change 事件的勾选状态。 */
  checked?: boolean
  /** keydown 事件的按键。 */
  key?: string
  /** scroll 事件的顶部位置。 */
  top?: number
  /** scroll 事件的左侧位置。 */
  left?: number
}
