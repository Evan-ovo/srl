import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = (fileName: string) => readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf8')
const header = source('FeatureAppHeader.vue')
const shell = source('FeatureShell.vue')

function openingTags(content: string, componentName: string): string[] {
  const tags = [...content.matchAll(new RegExp(`<${componentName}\\b[\\s\\S]*?>`, 'g'))].map(
    (match) => match[0],
  )
  if (!tags.length) throw new Error(`未找到 <${componentName}>`)
  return tags
}

describe('Feature App Shell contract', () => {
  it('removes Header 的业务样式后门', () => {
    expect(shell).not.toContain('headerClass')
    expect(shell).not.toContain('header-class')
    expect(shell).not.toMatch(/\beyebrow\??:\s*string/)
    expect(shell).not.toMatch(/\bdescription\??:\s*string/)
    expect(header).not.toMatch(/\beyebrow\??:\s*string/)
    expect(header).not.toMatch(/\bdescription\??:\s*string/)
    expect(header).not.toContain('v-bind="$attrs"')
    expect(header).toContain('defineOptions({ inheritAttrs: false })')
  })

  it('keeps every internal Feature Header call free of class、eyebrow 与 description', () => {
    for (const fileName of [
      'AppearanceStudio.vue',
      'CloudBackupCenter.vue',
      'DuplicateCleaner.vue',
      'ExternalAppHost.vue',
      'ExternalAppManager.vue',
      'FolderLibraryView.vue',
      'FrontendWorkshopApp.vue',
      'FrontendWorkshopWorkbench.vue',
      'GeneratedImageAlbumApp.vue',
      'PresetStitcherApp.vue',
      'TavernBridgeCenter.vue',
      'UserPersonaApp.vue',
    ]) {
      for (const tag of openingTags(source(fileName), 'FeatureAppHeader')) {
        expect(tag, fileName).not.toMatch(/\bclass=/)
        expect(tag, fileName).not.toMatch(/\beyebrow=/)
        expect(tag, fileName).not.toMatch(/\bdescription=/)
      }
    }
    for (const tag of openingTags(source('FeatureHub.vue'), 'FeatureShell')) {
      expect(tag).not.toMatch(/\bheader-class=/)
    }
  })
})
