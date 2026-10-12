/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { parse, compileStyle } from '@vue/compiler-sfc'

/** Detect a native bevel in actual visible product controls, including nested modal actions. */
export async function auditButtonMaterial(host, state) {
  const native = await host.locator('button').evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length)
      .flatMap((element) => {
        const css = getComputedStyle(element)
        const borders = [
          css.borderTopStyle,
          css.borderRightStyle,
          css.borderBottomStyle,
          css.borderLeftStyle,
        ]
        return borders.some((border) => ['outset', 'inset', 'groove', 'ridge'].includes(border))
          ? [
              {
                label: element.getAttribute('aria-label') || element.textContent.trim(),
                classes: element.className,
                borders,
              },
            ]
          : []
      }),
  )
  assert.deepEqual(native, [], state + ': residual browser button material')
}

// CSS cascade fixtures check shared tokens; the caller separately exercises real Vue dialogs.
export async function auditSharedAppearance(browser) {
  const files = [
    'Foundation',
    'AppShell',
    'DesignSystemRefinement',
    'ResourceList',
    'LayoutAndResponsive',
    'DataTransferPanels',
    'ResourceDetails',
    'ResourceGallery',
    'AppearanceStudio',
    'GlassRefinement',
    'ConfirmDialog',
    'ProjectActivityCenter',
    'ProjectNoticeDialog',
    'VersionArchive',
    'DuplicateCleaner',
    'CharacterCardMigrationReview',
    'PerformanceMonitor',
    'WorldBookBrowser',
    'ExternalAppHost',
    'AiTagging',
    'CharacterCardContentWorkbench',
    'FrontendWorkshopProof',
    'FrontendWorkshopImageDrafts',
    'TavernBridgeCenter',
    'FrontendWorkshopDesignAppearance',
    'FrontendWorkshopDelivery',
  ]
  const styles = await Promise.all(
    files.map((name) => readFile(new URL(`../src/styles/${name}.css`, import.meta.url), 'utf8')),
  )
  styles.push(await readFile(new URL('../src/AdminConsole.css', import.meta.url), 'utf8'))
  const manager = parse(
    await readFile(new URL('../src/components/OfficialAppManager.vue', import.meta.url), 'utf8'),
  ).descriptor
  for (const style of manager.styles) {
    const compiled = compileStyle({
      source: style.content,
      id: 'data-v-manager-audit',
      scoped: style.scoped,
    })
    assert.deepEqual(compiled.errors, [])
    styles.push(compiled.code)
  }
  for (const name of ['ActionSheet', 'NativeExportDialog', 'ProductAssistantTokenReview']) {
    const { descriptor } = parse(
      await readFile(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8'),
    )
    styles.push(...descriptor.styles.map((style) => style.content))
  }
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.setContent(`<style>${styles.join('\n')}\n*,*::before,*::after{transition:none!important;animation:none!important}</style>
      <main id="app">
        <button class="button button--primary" id="primary">保存</button>
        <dialog open class="chat-image-viewer"><button id="image-viewer-close">关闭</button></dialog>
        <label class="tavern-transfer-settings__row"><input type="checkbox" role="switch" id="transfer-switch"></label>
        <label class="chat-settings-toggle"><input type="checkbox" role="switch" id="assistant-switch"></label>
        <dialog open class="confirm-dialog official-app-manager__dialog" data-v-manager-audit>
          <ul class="official-app-manager__updates-list" data-v-manager-audit><li data-v-manager-audit>
            <div class="official-app-manager__updates-actions" data-v-manager-audit>
              <button class="confirm-dialog__confirm" id="nested-update-primary" data-v-manager-audit>去更新</button>
              <button id="nested-update-skip" data-v-manager-audit>跳过 APP 当前版本</button>
            </div>
          </li></ul>
          <form data-v-manager-audit><footer data-v-manager-audit><span data-v-manager-audit><button id="nested-confirm-cancel" data-v-manager-audit>取消</button></span></footer></form>
        </dialog>
        <div class="resource-gallery__toolbar"><input class="field__control" id="gallery-search"><button class="button button--primary" id="gallery-add">添加</button></div>
        <div class="appearance-preset-fields"><input id="preset-input"><select id="preset-select"><option>预设</option></select></div>
        <div class="settings-number-row__control"><input id="number-input"></div>
        <label class="resource-detail__folder-option" id="folder-option"><input type="checkbox">测试文件夹</label>
        <div class="mobile-brand-actions"><button id="mobile-icon">筛选</button></div>
        <nav><button class="nav-item nav-item--active" id="nav-choice">全部资源</button></nav>
        <div class="resource-detail__tabs"><button class="resource-detail__tab--active" id="detail-choice">详情</button></div>
        <button class="icon-button icon-button--active" id="icon-choice">收藏</button>
        <div class="settings-theme"><button role="radio" aria-checked="true" id="theme-choice">浅色</button></div>
        <div class="font-scale-options"><button role="radio" aria-checked="true" id="font-choice">标准</button></div>
        <div class="cabinet-density"><button role="radio" aria-checked="true" id="cabinet-choice">四列</button></div>
        <button class="layout-option layout-option--active" id="layout-choice">卡片</button>
        <div class="appearance-scope-tabs"><button role="tab" aria-selected="true" id="scope-choice">全局</button></div>
        <div class="editor-sheet" id="editor"></div>
        <section class="confirm-dialog" id="confirm"><footer>
          <button id="secondary">取消</button>
          <button class="confirm-dialog__confirm" id="confirm-primary">继续</button>
          <button class="confirm-dialog__confirm confirm-dialog__confirm--danger" id="danger">删除</button>
        </footer></section>
        <div class="version-diff" id="version"></div>
        <div class="action-sheet__panel" id="actions"></div>
        <div class="project-notice" id="project"></div>
        <div class="notice" id="notice"></div>
        <button class="activity-center__trigger" id="activity-trigger">通知</button>
        <section class="activity-center__panel" id="activity-panel"><button id="activity-button">关闭</button></section>
        <div class="activity-center__focused-progress" id="progress"></div>
        <div style="--color-accent:#224488;--color-on-accent:#fff"><button class="button button--primary" id="local-primary">局部主色</button></div>

        <section class="duplicate-cleaner-sheet" id="clean-dialog"><div class="duplicate-cleaner"><p class="duplicate-cleaner__message" id="clean-notice">清理提示</p><div class="duplicate-cleaner__group"><ul><li><button id="clean-button">保留</button></li></ul></div><button class="duplicate-cleaner__clean" id="clean-primary">清理</button></div></section>
        <section class="migration-review" id="migration-dialog"><input class="migration-review__search" id="migration-input"><footer class="migration-review__footer"><button id="migration-button">取消</button><button class="migration-review__apply" id="migration-primary">应用</button></footer></section>
        <details id="srl-performance-monitor"><summary>性能监控</summary><button class="srl-performance-monitor__copy" id="monitor-button">复制</button><textarea class="srl-performance-monitor__diagnostic-text" id="monitor-input"></textarea></details>
        <section class="admin-console"><div class="admin-console__create"><form><input id="admin-input"><button id="admin-primary">保存</button></form></div><nav class="admin-console__pagination"><button id="admin-button">下一页</button></nav></section>
        <div class="lore-browser"><label class="lore-search" id="lore-search"><input></label><div class="lore-pagination"><button id="lore-button">下一页</button></div></div>
        <section class="external-app-permission__panel" id="external-dialog"><button id="external-button">取消</button><button class="external-app-permission__always" id="external-primary">允许</button></section>
        <div class="card-content-workbench"><button id="card-button">导入</button><button class="is-primary" id="card-primary">保存</button></div>
        <section class="ai-tagging"><label class="ai-tagging__field"><input id="tag-input"></label><button id="tag-button">预览</button><footer class="ai-tagging__footer"><button class="is-primary" id="tag-primary">应用</button></footer></section>
        <section class="frontend-workshop__manual-repair-dialog"><section id="repair-dialog"><textarea id="repair-input"></textarea></section></section>
        <section class="frontend-workbench__image-template-drawer" id="draft-dialog"></section>
        <div class="assistant-token-review__detail-header"><button id="token-button">返回</button></div>
<div class="action-sheet__actions"><button class="action-sheet__action--selected" id="action-choice">选中</button></div><div class="ai-tagging__candidate is-selected" id="tag-choice">选中候选</div><article class="resource-row--selected" id="row-choice">选中资源</article><div class="tavern-bridge-resource-card is-selected" id="tavern-choice">选中互传资源</div><div class="resource-detail-sheet--content-editor"><button class="button button--primary resource-detail__editor-save" id="editor-primary">保存</button></div><footer class="version-import-dialog__actions"><button class="button button--primary" id="version-primary">导入</button></footer><div class="frontend-workshop frontend-workshop__delivery-actions"><button id="delivery-primary">导出</button></div>      </main>`)
    const measure = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[id]')].map((element) => {
            const css = getComputedStyle(element)
            return [
              element.id,
              {
                background: css.backgroundColor,
                image: css.backgroundImage,
                color: css.color,
                radius: css.borderTopLeftRadius,
                border: css.borderTopColor,
                shadow: css.boxShadow,
              },
            ]
          }),
        ),
      )
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      const defaults = await measure()
      await auditButtonMaterial(page.locator('body'), `shared/${theme}`)
      assert.equal(defaults.primary.background, defaults['confirm-primary'].background)
      assert.equal(defaults.primary.color, defaults['confirm-primary'].color)
      for (const id of [
        'theme-choice',
        'font-choice',
        'cabinet-choice',
        'layout-choice',
        'scope-choice',
      ]) {
        assert.equal(
          defaults[id].background,
          defaults['theme-choice'].background,
          `${id}: common selected background`,
        )
        assert.equal(
          defaults[id].border,
          defaults['theme-choice'].border,
          `${id}: common selected border`,
        )
      }
      assert.equal(
        defaults['local-primary'].background,
        'rgb(34, 68, 136)',
        'local accent must resolve at the button',
      )
      assert.notEqual(
        defaults.danger.background,
        defaults['confirm-primary'].background,
        'danger must remain distinct',
      )
      await page.addStyleTag({ content: ':root { --radius-control:17px; --radius-panel:19px; }' })
      const radii = await measure()
      assert.equal(
        radii.primary.radius,
        '17px',
        'legacy glass control radius follows the common token',
      )
      assert.equal(radii.secondary.radius, '17px')
      assert.equal(
        radii.editor.radius,
        '19px',
        'legacy glass panel radius follows the common token',
      )
      assert.equal(radii.confirm.radius, '19px')
      await page
        .locator('head > style')
        .last()
        .evaluate((element) => element.remove())
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 })
        await page.addStyleTag({
          content: `:root {
          --dialog-background:#e8f2fc; --dialog-radius:12px; --dialog-border:#112233; --dialog-shadow:none;
          --notice-background:#daeaf8; --notice-radius:9px; --notice-border:#334455; --notice-shadow:none;
          --button-radius:7px; --button-background:#eeddee; --button-color:#223344;
          --control-background:#faf0e0; --control-border:#774433; --control-radius:8px;
          --selection-background:#ccddee; --selection-border:#667788; --selection-color:#112233; --selection-shadow:none;
          --color-accent:#8055aa; --color-on-accent:#ffffff; --button-primary-background:#335599; --button-primary-color:#fff7d1; --button-primary-border:#9f3666; --color-danger:#a82f3d; --color-on-danger:#ffffff;
        }`,
        })
        const custom = await measure()
        for (const id of ['transfer-switch', 'assistant-switch']) {
          assert.equal(
            custom[id].background,
            'rgb(250, 240, 224)',
            `${id}: unchecked control material`,
          )
          const control = page.locator('#' + id)
          assert.equal(
            await control.evaluate((element) => getComputedStyle(element).appearance),
            'none',
          )
          // This is an overlapping CSS cascade fixture; real toggles are exercised by APP audits.
          await control.evaluate((element) => {
            element.checked = true
          })
          const on = await control.evaluate((element) => ({
            background: getComputedStyle(element).backgroundColor,
            knob: getComputedStyle(element, '::before').backgroundColor,
          }))
          assert.deepEqual(on, { background: 'rgb(51, 85, 153)', knob: 'rgb(255, 247, 209)' })
          await control.evaluate((element) => {
            element.checked = false
          })
        }
        for (const id of [
          'editor',
          'confirm',
          'version',
          'actions',
          'project',
          'clean-dialog',
          'migration-dialog',
          'external-dialog',
          'repair-dialog',
        ]) {
          assert.equal(
            custom[id].background,
            'rgb(232, 242, 252)',
            `${theme}/${width}: ${id} background`,
          )
          assert.equal(custom[id].radius, '12px', `${theme}/${width}: ${id} radius`)
          assert.equal(
            custom[id].border,
            id === 'repair-dialog' ? 'rgb(168, 47, 61)' : 'rgb(17, 34, 51)',
            `${id} border`,
          )
          assert.equal(custom[id].shadow, 'none', `${id} shadow`)
        }
        for (const id of [
          'notice',
          'activity-trigger',
          'activity-panel',
          'progress',
          'clean-notice',
          'srl-performance-monitor',
        ]) {
          assert.equal(
            custom[id].background,
            'rgb(218, 234, 248)',
            `${theme}/${width}: ${id} background`,
          )
          assert.equal(custom[id].radius, '9px', `${id} radius`)
          assert.equal(custom[id].border, 'rgb(51, 68, 85)', `${id} border`)
          assert.equal(custom[id].shadow, 'none', `${id} shadow`)
        }
        for (const id of [
          'primary',
          'nested-update-primary',
          'confirm-primary',
          'gallery-add',
          'clean-primary',
          'migration-primary',
          'admin-primary',
          'external-primary',
          'card-primary',
          'tag-primary',
          'editor-primary',
          'version-primary',
          'delivery-primary',
        ]) {
          assert.equal(
            custom[id].background,
            'rgb(51, 85, 153)',
            `${id} primary background independent of accent`,
          )
          assert.equal(custom[id].color, 'rgb(255, 247, 209)', `${id} contrast`)
          assert.equal(custom[id].radius, '7px', `${id} radius`)
          assert.equal(custom[id].border, 'rgb(159, 54, 102)', `${id}: primary border`)
        }
        assert.equal(custom['draft-dialog'].background, 'rgb(232, 242, 252)')
        assert.equal(custom['draft-dialog'].shadow, 'none')
        assert.equal(custom.danger.background, 'rgb(168, 47, 61)')
        for (const id of [
          'secondary',
          'image-viewer-close',
          'nested-update-skip',
          'nested-confirm-cancel',
          'activity-button',
          'folder-option',
          'clean-button',
          'migration-button',
          'monitor-button',
          'admin-button',
          'lore-button',
          'external-button',
          'card-button',
          'tag-button',
          'token-button',
          ...(width <= 860 ? ['mobile-icon'] : []),
        ]) {
          assert.equal(custom[id].background, 'rgb(238, 221, 238)', `${id} background`)
          assert.equal(custom[id].color, 'rgb(34, 51, 68)', `${id} color`)
          assert.equal(custom[id].radius, '7px', `${id} radius`)
        }
        for (const id of [
          'gallery-search',
          'preset-input',
          'preset-select',
          'number-input',
          'migration-input',
          'monitor-input',
          'admin-input',
          'lore-search',
          'tag-input',
          'repair-input',
        ]) {
          assert.equal(custom[id].background, 'rgb(250, 240, 224)', `${id}: control background`)
          assert.equal(custom[id].border, 'rgb(119, 68, 51)', `${id}: control border`)
          assert.equal(custom[id].radius, '8px', `${id}: control radius`)
        }
        for (const id of [
          'theme-choice',
          'font-choice',
          'cabinet-choice',
          'layout-choice',
          'scope-choice',
          'nav-choice',
          'detail-choice',
        ]) {
          assert.equal(custom[id].background, 'rgb(204, 221, 238)', `${id}: selected background`)
          if (id !== 'detail-choice')
            assert.equal(custom[id].border, 'rgb(102, 119, 136)', `${id}: selected border`)
          assert.equal(custom[id].color, 'rgb(17, 34, 51)', `${id}: selected text`)
          assert.equal(custom[id].shadow, 'none', `${id}: selected shadow`)
        }
        for (const id of ['action-choice', 'tag-choice', 'row-choice', 'tavern-choice']) {
          assert.equal(
            custom[id].background,
            'rgb(204, 221, 238)',
            `${id}: independent selection material`,
          )
          assert.equal(custom[id].color, 'rgb(17, 34, 51)', `${id}: selected text`)
        }
        assert.equal(custom['icon-choice'].background, 'rgb(204, 221, 238)')
        assert.equal(custom['icon-choice'].color, 'rgb(17, 34, 51)')
        assert.equal(
          await page
            .locator('#detail-choice')
            .evaluate((element) => getComputedStyle(element, '::after').backgroundColor),
          'rgb(102, 119, 136)',
        )
        await page
          .locator('head > style')
          .last()
          .evaluate((element) => element.remove())
      }
    }
  } finally {
    await context.close()
  }
}
