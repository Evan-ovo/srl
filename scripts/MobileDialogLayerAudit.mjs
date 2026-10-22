/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import console from 'node:console'
import process from 'node:process'
import { chromium } from 'playwright-core'
import { compileStyle } from '@vue/compiler-sfc'

// CSS layout fixtures, not full feature/device acceptance. Use the actual scoped
// styles after the shared stylesheet to catch lazy-loaded specificity conflicts.
const cases = [
  ['FolderLibrary', 'folder-organizer', 'folder-organizer__sheet'],
  ['FolderLibrary', 'folder-rename', 'folder-rename__sheet'],
  ['ResourceSourceLinks', 'resource-source-add-wrap', 'resource-source-add-sheet'],
  ['VersionArchive', 'version-import-overlay', 'version-import-dialog'],
  ['GeneratedImageAlbumApp', 'generated-album__detail-backdrop', 'generated-album__detail'],
  ['ExternalAppHost', 'external-app-resource-picker', 'external-app-resource-picker__panel'],
  ['PresetStitcherApp', 'stitch-sheet', 'stitch-sheet__panel'],
  ['FrontendWorkshopSourceAiWorkspace', 'source-ai-workspace'],
  ['FrontendWorkshopSourceEditor', 'frontend-workshop-source-editor'],
  ['FrontendWorkshopSourceComponentLibrary', 'frontend-workshop-source-components'],
  ['FrontendWorkshopLayoutStudio', 'layout-studio'],
  ['FrontendWorkshopProof', 'frontend-workshop__conversation-dialog'],
  ['FrontendWorkshopProof', 'frontend-workshop__manual-repair-dialog'],
  ['AiTagging', 'ai-tagging'],
  ['DiscordSourceHandoffIntake', 'discord-intake-overlay', 'discord-intake'],
]
const shared = (
  await Promise.all(
    ['Foundation', 'LayoutAndResponsive'].map((name) => readFile(`src/styles/${name}.css`, 'utf8')),
  )
).join('\n')
const styles = new Map()
for (const [name] of cases) {
  if (styles.has(name)) continue
  const { code, errors } = compileStyle({
    source: await readFile(`src/styles/${name}.css`, 'utf8'),
    id: 'data-v-audit',
    scoped: true,
  })
  assert.deepEqual(errors, [])
  styles.set(name, code)
}
const browser = await chromium.launch({
  executablePath:
    process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
})
try {
  for (const [width, height] of [
    [320, 800],
    [375, 812],
    [390, 844],
    [430, 932],
    [1280, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } })
    for (const theme of ['light', 'dark']) {
      for (const [sheet, layer, panel, usesViewportContract = true] of cases) {
        await page.setContent(
          `<html data-theme="${theme}"><body><div data-v-audit class="${layer}${usesViewportContract ? ' mobile-dialog-viewport' : ''}" role="${panel ? 'presentation' : 'dialog'}">${panel ? `<section data-v-audit class="${panel}" role="dialog"><div data-v-audit style="height:1200px">Long content</div></section>` : '<header data-v-audit>Header</header><main data-v-audit style="min-height:0;overflow:auto"><div style="height:1200px">Long content</div></main><footer data-v-audit>Actions</footer>'}</div></body></html>`,
        )
        await page.addStyleTag({ content: shared })
        await page.addStyleTag({ content: styles.get(sheet) })
        const measure = async (viewportHeight, offsetTop) =>
          page.evaluate(
            ({ viewportHeight, offsetTop, layer, panel }) => {
              const root = document.documentElement
              root.style.setProperty('--visual-viewport-height', `${viewportHeight}px`)
              root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
              root.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`)
              root.style.setProperty('--safe-top', '59px')
              root.style.setProperty('--safe-bottom', '34px')
              const rect = document.querySelector(`.${layer}`).getBoundingClientRect()
              const inner = panel
                ? document.querySelector(`.${panel}`).getBoundingClientRect()
                : rect
              return {
                top: rect.top,
                bottom: rect.bottom,
                innerTop: inner.top,
                innerBottom: inner.bottom,
                scrollWidth: root.scrollWidth,
              }
            },
            { viewportHeight, offsetTop, layer, panel },
          )
        const normal = await measure(height, 0)
        assert.ok(normal.scrollWidth <= width, `${layer}: horizontal overflow`)
        if (width <= 860) {
          for (const [size, offset] of [
            [420, 80],
            [336, 240],
            [height, 0],
          ]) {
            const rect = await measure(size, offset)
            assert.ok(
              Math.abs(rect.top - offset) <= 1 && Math.abs(rect.bottom - offset - size) <= 1,
              `${width}/${theme}/${layer}: ${JSON.stringify(rect)}`,
            )
            assert.ok(
              rect.innerTop >= rect.top - 1 && rect.innerBottom <= rect.bottom + 1,
              `${width}/${theme}/${panel}: clipped panel ${JSON.stringify(rect)}`,
            )
          }
        } else {
          const changed = await measure(height, 80)
          assert.equal(
            changed.top,
            normal.top,
            `${layer}: desktop must retain its original position`,
          )
        }
      }
      console.log(`${width}/${theme}: ${cases.length} scoped dialog layers and panels passed`)
    }
    await page.close()
  }

  const nestedPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const resourceDetails = await readFile('src/styles/ResourceDetails.css', 'utf8')
  const resourceList = await readFile('src/styles/ResourceList.css', 'utf8')
  const resourceGallery = await readFile('src/styles/ResourceGallery.css', 'utf8')
  const personalEditor = compileStyle({
    source: await readFile('src/styles/PersonalResourceEditor.css', 'utf8'),
    id: 'data-v-audit',
    scoped: true,
  })
  assert.deepEqual(personalEditor.errors, [])
  await nestedPage.setContent(`
    <html><body>
      <div class="srl-independent-page-outlet">
        <main class="srl-independent-page resource-detail-page" id="resource-detail">
          <section class="resource-detail-sheet" style="width:370px;height:650px;background:#ddd"></section>
        </main>
      </div>
      <div class="editor-overlay personal-resource-editor-overlay" data-v-audit id="personal-editor">
        <section class="editor-sheet personal-resource-editor" data-v-audit style="height:300px;background:white">
          <button>保存</button>
        </section>
      </div>
      <div class="editor-overlay resource-gallery-dialog" id="gallery-dialog" style="pointer-events:none"><section>图库添加</section></div>
      <div class="resource-image-viewer" id="gallery-viewer" style="pointer-events:none"><section>图片预览</section></div>
    </body></html>
  `)
  await nestedPage.addStyleTag({ content: shared })
  await nestedPage.addStyleTag({ content: resourceList })
  await nestedPage.addStyleTag({ content: resourceDetails })
  await nestedPage.addStyleTag({ content: resourceGallery })
  await nestedPage.addStyleTag({ content: personalEditor.code })
  const stack = await nestedPage.evaluate(() => {
    const parent = document.querySelector('#resource-detail')
    const child = document.querySelector('#personal-editor')
    const childPanel = document.querySelector('.personal-resource-editor')
    const top = document.elementFromPoint(195, 422)?.closest('#resource-detail, #personal-editor')
    return {
      parent: parent ? getComputedStyle(parent).position : '',
      outlet: getComputedStyle(document.querySelector('.srl-independent-page-outlet')).zIndex,
      child: child ? getComputedStyle(child).zIndex : '',
      dialog: getComputedStyle(document.querySelector('#gallery-dialog')).zIndex,
      viewer: getComputedStyle(document.querySelector('#gallery-viewer')).zIndex,
      top: top?.id,
      panelVisible: Boolean(childPanel && childPanel.getBoundingClientRect().width > 0),
    }
  })
  assert.equal(stack.parent, 'absolute', JSON.stringify(stack))
  assert.equal(stack.outlet, '80', JSON.stringify(stack))
  assert.ok(Number(stack.child) > Number(stack.outlet), JSON.stringify(stack))
  assert.ok(Number(stack.dialog) > Number(stack.outlet), JSON.stringify(stack))
  assert.ok(Number(stack.viewer) > Number(stack.outlet), JSON.stringify(stack))
  assert.equal(stack.top, 'personal-editor', JSON.stringify(stack))
  assert.equal(stack.panelVisible, true)
  const shiftedStack = await nestedPage.evaluate(() => {
    document.documentElement.style.setProperty('--layer-resource-detail', '90')
    return {
      outlet: Number(
        getComputedStyle(document.querySelector('.srl-independent-page-outlet')).zIndex,
      ),
      editor: Number(getComputedStyle(document.getElementById('personal-editor')).zIndex),
      dialog: Number(getComputedStyle(document.getElementById('gallery-dialog')).zIndex),
      viewer: Number(getComputedStyle(document.getElementById('gallery-viewer')).zIndex),
    }
  })
  assert.deepEqual(shiftedStack, { outlet: 90, editor: 91, dialog: 96, viewer: 98 })
  console.log('independent resource detail → teleported editor/gallery overlays stacking passed')
  await nestedPage.close()
} finally {
  await browser.close()
}
