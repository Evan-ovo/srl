<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import FeatureAppHeader from './FeatureAppHeader.vue'
import { SRL_BACK_REQUEST_EVENT, type SrlBackRequestDetail } from '../composables/UseBackStack'
import {
  mountAppearancePalette,
  type PalettePorts,
} from '../composables/AppearancePaletteController.js'
const props = withDefaults(defineProps<{ ports: PalettePorts; active?: boolean }>(), {
  active: true,
})
const host = ref<HTMLElement>()
let controller: ReturnType<typeof mountAppearancePalette> | undefined
function handleBack(event: Event) {
  if (!props.active || document.body.classList.contains('modal-open')) return
  if (host.value?.querySelector('dialog[open]')) return
  if (event instanceof KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
  } else {
    const detail = (event as CustomEvent<SrlBackRequestDetail>).detail
    if (!detail || detail.handled) return
    detail.handled = true
  }
  event.stopImmediatePropagation()
  void controller?.back()
}
onMounted(() => {
  if (host.value) {
    controller = mountAppearancePalette(host.value, props.ports)
    controller.setActive(props.active)
  }
  window.addEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
  window.addEventListener('keydown', handleBack, true)
})
onBeforeUnmount(() => {
  window.removeEventListener(SRL_BACK_REQUEST_EVENT, handleBack, true)
  window.removeEventListener('keydown', handleBack, true)
  controller?.dispose()
})
watch(
  () => props.active,
  (active) => controller?.setActive(active),
)
</script>
<template>
  <div id="srl-appearance-palette" ref="host">
    <section class="e-window" aria-label="顶部预览与横向设置栏的外观示意">
      <FeatureAppHeader
        title="调色"
        title-id="e-page-title"
        layout="panel"
        back-label="返回外观"
        @back="controller?.back()"
        ><template #actions>
          <button id="e-import" type="button" aria-label="导入 CSS" title="导入 CSS">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
            </svg>
          </button>
          <input id="e-import-file" type="file" accept=".css,text/css" hidden />
          <div
            id="e-theme"
            class="settings-theme"
            role="radiogroup"
            aria-label="调整浅色或深色外观"
          >
            <button type="button" data-theme-value="light" role="radio" aria-checked="true">
              浅色</button
            ><button type="button" data-theme-value="dark" role="radio" aria-checked="false">
              深色
            </button>
          </div></template
        ></FeatureAppHeader
      >
      <section id="e-palette-page" class="e-palette-page" hidden>
        <div class="e-layout">
          <div class="e-preview-wrap">
            <div id="e-preview" class="e-preview" inert>
              <div id="e-library-scene" class="e-preview-scene e-library-scene">
                <div class="e-preview-header palette-sample-header">
                  <strong class="palette-sample-title">你的私人资源档案</strong
                  ><span id="e-icon" class="e-icon-face"
                    ><svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="19" cy="12" r="1.5" fill="currentColor" /></svg
                  ></span>
                </div>
                <div id="e-search" class="e-native-toolbar">
                  <span aria-hidden="true">⌕</span><span>搜索名称、标签和解析内容</span>
                </div>
                <div class="e-native-filter">
                  <span id="e-filter">全部资源 1</span><span id="e-filter-idle">角色卡 1</span
                  ><span>我的收藏 0</span>
                </div>
                <article id="e-card" class="e-card palette-sample-card">
                  <div class="palette-sample-card__body">
                    <div id="e-secondary" class="palette-sample-card__eyebrow">
                      <span>角色卡</span><span>12.0 KB</span>
                    </div>
                    <div class="palette-sample-card__compact-title">
                      <strong id="e-title" class="palette-sample-card__title">月下旅人</strong
                      ><small id="e-link">查看详情 →</small>
                    </div>
                    <p id="e-file" class="palette-sample-card__file">月下旅人.json</p>
                  </div>
                </article>
                <div class="e-preview-actions">
                  <span id="e-ordinary" class="e-action-face">取消</span
                  ><span id="e-action" class="e-action-face">保存</span>
                </div>
              </div>
              <div id="e-dialog-scene" class="e-preview-scene" hidden>
                <div id="e-demo-dialog" class="e-demo-panel">
                  <div class="e-demo-row">
                    <strong>编辑资源</strong><span id="e-demo-highlight">最近使用</span>
                  </div>
                  <span id="e-demo-muted">资源名称</span>
                  <div id="e-demo-field" class="e-demo-input">月下旅人</div>
                  <div id="e-demo-raised" class="e-demo-input">未放入文件夹</div>
                  <div id="e-demo-surface" class="e-demo-input">资源信息</div>
                  <div class="e-preview-actions">
                    <span id="e-dialog-cancel" class="e-action-face">取消</span
                    ><span id="e-dialog-save" class="e-action-face">保存</span>
                  </div>
                </div>
              </div>
              <div id="e-notice-scene" class="e-preview-scene" hidden>
                <div id="e-notice-panel" class="e-demo-panel">
                  <strong>资源管理</strong>
                  <div id="e-success" class="e-demo-notice">✓ 已保存到资源库</div>
                  <div id="e-warning" class="e-demo-notice">
                    <span id="e-warning-icon">!</span> 有相似资源，请检查
                  </div>
                  <div id="e-danger" class="e-demo-notice">
                    删除资源
                    <span
                      id="e-danger-button"
                      class="e-action-face"
                      style="display: inline-grid; float: right"
                      >删除</span
                    >
                  </div>
                </div>
              </div>
              <div id="e-viewer-scene" class="e-preview-scene e-viewer-scene" hidden>
                <div class="e-demo-row">
                  <strong>图片查看</strong
                  ><span id="e-viewer-close" class="e-icon-face"
                    ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                      <path d="m5 5 14 14M19 5 5 19" /></svg
                  ></span>
                </div>
                <div class="e-viewer-picture">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="m3 17 6-6 5 5 3-3 4 4" />
                  </svg>
                </div>
                <div class="e-demo-row">
                  <span>1 / 3</span><span id="e-viewer-save" class="e-action-face">保存图片</span>
                </div>
              </div>
            </div>
          </div>
          <div class="e-target-wrap">
            <select id="e-group" aria-label="调色分类"></select>
            <nav id="e-targets" class="e-targets" aria-label="选择调整部位"></nav>
          </div>
          <div id="e-editor-scroll" class="e-editor">
            <p id="e-error" class="e-help" role="alert" hidden></p>
            <section id="e-edit" aria-label="调整所选位置">
              <div id="e-color-pane">
                <div id="e-effects" class="e-effects" aria-label="颜色效果">
                  <button class="cursor-interaction" data-type="solid">纯色</button
                  ><button class="cursor-interaction" data-type="gradient">渐变</button
                  ><button class="cursor-interaction" data-type="mix">混色</button>
                </div>
                <div id="e-colors" class="e-colors"></div>
                <section class="e-color-editor" aria-label="调色盘与颜色数值">
                  <div id="e-sv" class="e-sv cursor-interaction" role="img" aria-label="二维色盘">
                    <span id="e-sv-marker" class="e-sv-marker"></span>
                  </div>
                  <label class="e-hue-label"
                    ><span>色系</span
                    ><input id="e-hue" type="range" min="0" max="360" step="1" aria-label="色系"
                  /></label>
                  <div class="e-color-values">
                    <select id="e-format" aria-label="颜色数值格式">
                      <option value="hex">HEX</option>
                      <option value="rgb">RGB</option></select
                    ><label id="e-hex-field" class="e-hex-field"
                      ><input
                        id="e-hex"
                        type="text"
                        maxlength="7"
                        spellcheck="false"
                        autocomplete="off"
                        aria-label="HEX 色号"
                        placeholder="#6A8CAF"
                    /></label>
                    <div id="e-rgb-fields" class="e-rgb-fields" hidden>
                      <label
                        >R<input
                          id="e-r"
                          type="number"
                          min="0"
                          max="255"
                          step="1"
                          inputmode="numeric"
                          aria-label="红色 R" /></label
                      ><label
                        >G<input
                          id="e-g"
                          type="number"
                          min="0"
                          max="255"
                          step="1"
                          inputmode="numeric"
                          aria-label="绿色 G" /></label
                      ><label
                        >B<input
                          id="e-b"
                          type="number"
                          min="0"
                          max="255"
                          step="1"
                          inputmode="numeric"
                          aria-label="蓝色 B"
                      /></label>
                    </div>
                  </div>
                  <p id="e-color-error" class="e-color-error" role="alert" hidden></p>
                  <div id="e-remove-row" class="e-remove-row" hidden>
                    <button id="e-remove" type="button">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                        <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v8m4-8v8" /></svg
                      ><span id="e-remove-label"></span>
                    </button>
                  </div>
                </section>
                <details id="e-more">
                  <summary class="cursor-interaction">细节</summary>
                  <label class="e-field"
                    ><span>饱和度<output id="e-saturation-value"></output></span
                    ><input
                      id="e-saturation"
                      type="range"
                      min="0"
                      max="100"
                      aria-label="饱和度" /></label
                  ><label class="e-field"
                    ><span>明暗<output id="e-brightness-value"></output></span
                    ><input
                      id="e-brightness"
                      type="range"
                      min="0"
                      max="100"
                      aria-label="明暗" /></label
                  ><label class="e-field"
                    ><span>透明度<output id="e-alpha-value"></output></span
                    ><input id="e-alpha" type="range" min="0" max="100" aria-label="透明度"
                  /></label>
                  <div id="e-gradient-options">
                    <label class="e-field"
                      ><span>渐变方向<output id="e-angle-value"></output></span
                      ><input id="e-angle" type="range" min="0" max="360" aria-label="渐变方向"
                    /></label>
                  </div>
                  <div id="e-glow-options">
                    <div id="e-glow-picker" class="e-colors"></div>
                    <label class="e-field"
                      ><span>柔光浓淡<output id="e-strength-value"></output></span
                      ><input id="e-strength" type="range" min="0" max="100" aria-label="柔光浓淡"
                    /></label>
                  </div>
                </details>
              </div>
              <div id="e-shape-pane" hidden>
                <div class="e-shapes" aria-label="按钮形状">
                  <button class="cursor-interaction" data-radius="0">
                    <span class="e-shape-sample" style="border-radius: 0" aria-hidden="true"></span
                    >直角</button
                  ><button class="cursor-interaction" data-radius="8">
                    <span
                      class="e-shape-sample"
                      style="border-radius: 4px"
                      aria-hidden="true"
                    ></span
                    >小圆角</button
                  ><button class="cursor-interaction" data-radius="16">
                    <span
                      class="e-shape-sample"
                      style="border-radius: 7px"
                      aria-hidden="true"
                    ></span
                    >大圆角</button
                  ><button class="cursor-interaction" data-radius="999">
                    <span
                      class="e-shape-sample"
                      style="border-radius: 99px"
                      aria-hidden="true"
                    ></span
                    >胶囊形
                  </button>
                </div>
                <details>
                  <summary class="cursor-interaction">圆角</summary>
                  <label class="e-field"
                    ><span>圆角大小<output id="e-radius-value"></output></span
                    ><input
                      id="e-radius"
                      type="range"
                      min="0"
                      max="32"
                      step="0.01"
                      aria-label="圆角大小"
                  /></label>
                </details>
              </div>
              <details>
                <summary class="cursor-interaction">作用范围</summary>
                <p id="e-impact-detail" class="e-help"></p>
                <p class="e-help">不含作品内容、图片、系统界面及自定义 Vue。</p>
              </details>
            </section>
            <section id="e-finish" aria-label="保存与导出" hidden>
              <div class="e-finish-actions">
                <button id="e-save-preset" class="e-primary cursor-interaction">保存为预设</button
                ><button id="e-export" class="cursor-interaction">下载 CSS</button
                ><button id="e-draft-toggle" class="cursor-interaction">发布到资源广场</button
                ><button id="e-continue" class="cursor-interaction">继续调整</button>
              </div>
              <p id="e-result" class="e-help" role="status" hidden></p>
              <details id="e-css-details">
                <summary class="cursor-interaction">CSS</summary>
                <textarea
                  id="e-css"
                  aria-label="自动生成的 CSS"
                  readonly
                  spellcheck="false"
                ></textarea>
              </details>
            </section>
            <p id="e-status" class="e-status" aria-live="polite" hidden></p>
          </div>
          <footer id="e-actions" class="e-foot">
            <button id="e-undo" class="cursor-interaction" disabled>撤销</button>
            <button id="e-reset" class="cursor-interaction">还原这项</button>
            <button id="e-live-preview" class="cursor-interaction">预览</button>
            <button id="e-done" class="e-primary cursor-interaction">保存与导出</button>
          </footer>
        </div>
      </section>
      <dialog id="e-preset-dialog" aria-labelledby="e-preset-title">
        <h3 id="e-preset-title">保存为预设</h3>
        <label class="e-name"
          >名称<input
            id="e-preset-name"
            type="text"
            value="我的配色"
            required
            maxlength="40"
            autocomplete="off"
        /></label>
        <div class="e-dialog-actions">
          <button id="e-preset-cancel" type="button" class="cursor-interaction">取消</button
          ><button id="e-preset-commit" type="button" class="e-primary cursor-interaction">
            保存
          </button>
        </div>
      </dialog>
    </section>
  </div>
</template>
<style src="../styles/AppearancePalette.css"></style>
