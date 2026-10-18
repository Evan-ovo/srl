import type { CustomCssScope } from './BrowserPreferences'

export const CUSTOM_UI_VIEWS_KEY = 'srl.ui.customViews.v1'
export const CUSTOM_UI_VIEWS_CHANGED = 'srl:custom-ui-views-changed'
/** Cancelable request to open the host's appearance quick menu, including when Vue is off. */
export const CUSTOM_UI_APPEARANCE_MENU_REQUEST = 'srl:appearance-quick-menu'

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
/** A live, memory-only appearance session; exiting returns to its retained source page. */
export interface AppearancePreviewRequest {
  css: string
  views: CustomUiViews
  scope?: CustomCssScope
  /** Existing navigation destination to return to; defaults to the appearance editor. */
  returnTo?: string
  onExit(): void
}
export interface UiApplyOptions {
  /** Temporary live preview; never persists CSS, Vue, or preset selection. */
  preview?: { onExit(): void; beforeExit?(): Promise<boolean> }
  /** Explicit safe exit: close Vue while keeping CSS, or restore the uncustomized appearance. */
  recovery?: 'vue' | 'default'
  assistant?: boolean
  views?: CustomUiViews
  /** 显式应用已保存的 CSS 预设；试用恢复时一并恢复原预设选择。 */
  presetId?: string
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
  /** Visible rectangular pieces in local coordinates; absent in older runtimes. */
  visibleRects?: Array<{ top: number; left: number; width: number; height: number }>
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
