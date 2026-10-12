/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'

import { BrowserStorageService } from './BrowserStorageService'

describe('BrowserStorageService cabinet desktop resources', () => {
  it('defaults modified tags to preserved and includes the explicit choice in portable preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getModifiedResourceSyncTags()).toBe(false)
    service.setModifiedResourceSyncTags(true)
    const saved = service.exportGeneralPreferences()
    expect(saved.modifiedResourceSyncTags).toBe(true)
    localStorage.clear()
    service.importGeneralPreferences(saved)
    expect(new BrowserStorageService().getModifiedResourceSyncTags()).toBe(true)
    service.importGeneralPreferences({ ...saved, modifiedResourceSyncTags: undefined })
    expect(service.getModifiedResourceSyncTags()).toBe(true)
    service.setModifiedResourceSyncTags(false)
    expect(service.getModifiedResourceSyncTags()).toBe(false)
  })
  it('defaults chat script carriage on and persists an off choice through reopening and backup', () => {
    const service = new BrowserStorageService()
    expect(service.getTavernChatCarryScripts()).toBe(true)
    service.setTavernChatCarryScripts(false)
    expect(new BrowserStorageService().getTavernChatCarryScripts()).toBe(false)
    const saved = service.exportGeneralPreferences()
    localStorage.clear()
    service.importGeneralPreferences(saved)
    expect(service.getTavernChatCarryScripts()).toBe(false)
    service.importGeneralPreferences({ ...saved, tavernChatCarryScripts: undefined })
    expect(service.getTavernChatCarryScripts()).toBe(false)
  })
  it('defaults bridge sending to modified and restores its choice through portable preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getTavernSendContent()).toBe('modified')
    service.setTavernSendContent('original')
    expect(new BrowserStorageService().getTavernSendContent()).toBe('original')
    const saved = service.exportGeneralPreferences()
    expect(saved.tavernSendContent).toBe('original')
    localStorage.clear()
    service.importGeneralPreferences(saved)
    expect(service.getTavernSendContent()).toBe('original')
    service.importGeneralPreferences({ ...saved, tavernSendContent: undefined })
    expect(service.getTavernSendContent()).toBe('original')
    localStorage.setItem('srl.tavern.sendContent', 'invalid')
    expect(service.getTavernSendContent()).toBe('modified')
  })
  it('imports older preferences while dropping the retired history retention field on export', () => {
    const service = new BrowserStorageService()
    const legacyPreferences = {
      ...service.exportGeneralPreferences(),
      historySnapshotLimit: 2,
      hideChatDisplayRegex: false,
    }
    service.importGeneralPreferences(legacyPreferences)
    expect(service.getHideChatDisplayRegex()).toBe(false)
    expect(service.exportGeneralPreferences()).not.toHaveProperty('historySnapshotLimit')
  })
  it('keeps same-name candidates opt-in and restores them through portable preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getSameNameVersionCandidates()).toBe(false)
    service.setSameNameVersionCandidates(true)
    const preferences = service.exportGeneralPreferences()
    expect(preferences.sameNameVersionCandidates).toBe(true)
    localStorage.clear()
    service.importGeneralPreferences(preferences)
    expect(new BrowserStorageService().getSameNameVersionCandidates()).toBe(true)
    service.importGeneralPreferences({ ...preferences, sameNameVersionCandidates: undefined })
    expect(service.getSameNameVersionCandidates()).toBe(false)
  })
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'srl_project_notice=; Max-Age=0; Path=/'
  })
  it('defaults to hiding companion chat regex and preserves the choice in portable preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getHideChatDisplayRegex()).toBe(true)
    service.setHideChatDisplayRegex(false)
    const saved = service.exportGeneralPreferences()
    expect(saved.hideChatDisplayRegex).toBe(false)
    localStorage.clear()
    service.importGeneralPreferences(saved)
    expect(service.getHideChatDisplayRegex()).toBe(false)
  })

  it('keeps Discord direct-link auto-download off by default and portable when enabled', () => {
    const service = new BrowserStorageService()
    expect(service.getAutoDownloadDiscordShareLinks()).toBe(false)
    service.setAutoDownloadDiscordShareLinks(true)
    const saved = service.exportGeneralPreferences()
    expect(saved.autoDownloadDiscordShareLinks).toBe(true)
    localStorage.clear()
    service.importGeneralPreferences(saved)
    expect(service.getAutoDownloadDiscordShareLinks()).toBe(true)
  })

  it('remembers bottom and side drawer sizes separately and tolerates corrupt preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getFrontendWorkshopDrawerSize()).toEqual({ bottom: 0.46, side: 0.32 })
    service.setFrontendWorkshopDrawerSize({ bottom: 0.7, side: 0.5 })
    expect(new BrowserStorageService().getFrontendWorkshopDrawerSize()).toEqual({
      bottom: 0.7,
      side: 0.5,
    })
    localStorage.setItem('srl.frontendWorkshop.drawerSize', '{bad')
    expect(service.getFrontendWorkshopDrawerSize()).toEqual({ bottom: 0.46, side: 0.32 })
    localStorage.setItem('srl.frontendWorkshop.drawerSize', '{"bottom":100,"side":-1}')
    expect(service.getFrontendWorkshopDrawerSize()).toEqual({ bottom: 0.95, side: 0.12 })
  })

  it('persists only supported font scale tiers and includes them in appearance backups', () => {
    const service = new BrowserStorageService()

    expect(service.getUiFontScale()).toBe('standard')
    expect(service.setUiFontScale('large')).toBe('large')
    expect(service.exportAppearanceSettings().fontScale).toBe('large')

    localStorage.setItem('srl.ui.fontScale', 'huge')
    expect(service.getUiFontScale()).toBe('standard')

    service.importAppearanceSettings({
      theme: 'light',
      layoutMode: 'grid',
      fontScale: 'small',
      customCss: '',
      presets: [],
      activePresetId: '',
    })
    expect(service.getUiFontScale()).toBe('small')
  })

  it('为开场白和美化分别保存预下载偏好，并兼容旧的两字段预览设置', () => {
    const service = new BrowserStorageService()

    expect(service.getPreviewPolicy()).toEqual({
      allowRemoteResources: false,
      allowScripts: false,
      preloadGreetingResources: false,
      preloadBeautificationResources: false,
      increaseDownloadConcurrency: false,
    })

    service.setPreviewPolicy({
      allowRemoteResources: true,
      allowScripts: false,
      preloadGreetingResources: true,
      preloadBeautificationResources: false,
    })

    expect(service.getPreviewPolicy()).toEqual({
      allowRemoteResources: true,
      allowScripts: false,
      preloadGreetingResources: true,
      preloadBeautificationResources: false,
      increaseDownloadConcurrency: false,
    })
    expect(service.setPreviewPolicy({ allowRemoteResources: false, allowScripts: false })).toEqual({
      allowRemoteResources: false,
      allowScripts: false,
      preloadGreetingResources: false,
      preloadBeautificationResources: false,
      increaseDownloadConcurrency: false,
    })
  })

  it('确认后的并发档本机保存，旧配置与换机恢复不会自动增加设备负担', () => {
    const service = new BrowserStorageService()
    service.setPreviewPolicy({
      allowRemoteResources: true,
      allowScripts: false,
      increaseDownloadConcurrency: true,
    })
    expect(new BrowserStorageService().getPreviewPolicy().increaseDownloadConcurrency).toBe(true)
    const preferences = service.exportGeneralPreferences()
    service.importGeneralPreferences(preferences)
    expect(service.getPreviewPolicy().increaseDownloadConcurrency).toBe(false)
  })

  it('persists a unique ordered list and includes it in portable preferences', () => {
    const service = new BrowserStorageService()
    service.setCabinetResourceIds(['resource-b', 'resource-a', 'resource-b', ''])

    expect(service.getCabinetResourceIds()).toEqual(['resource-b', 'resource-a'])
    expect(service.exportGeneralPreferences().cabinetResourceIds).toEqual([
      'resource-b',
      'resource-a',
    ])
  })

  it('only remembers the project notice on this device and does not export it as a preference', () => {
    const service = new BrowserStorageService()

    expect(service.hasAcknowledgedProjectNotice()).toBe(false)
    service.acknowledgeProjectNotice()
    expect(service.hasAcknowledgedProjectNotice()).toBe(true)
    expect(service.exportGeneralPreferences()).not.toHaveProperty('projectNoticeAcknowledged')

    localStorage.clear()
    expect(service.hasAcknowledgedProjectNotice()).toBe(true)
    document.cookie = 'srl_project_notice=; Max-Age=0; Path=/'
    expect(service.hasAcknowledgedProjectNotice()).toBe(false)
  })

  it('restores cabinet resource ids from portable preferences', () => {
    const service = new BrowserStorageService()
    service.importGeneralPreferences({
      previewPolicy: { allowRemoteResources: false, allowScripts: false },
      extractCharacterAssets: false,
      hideCharacterAssets: true,
      hideChatDisplayRegex: true,
      searchHistory: [],
      cabinetResourceIds: ['resource-a', 'resource-a', 'resource-c'],
    })

    expect(service.getCabinetResourceIds()).toEqual(['resource-a', 'resource-c'])
  })

  it('persists sparse mixed cabinet slots and restores them with portable preferences', () => {
    const service = new BrowserStorageService()
    service.setCabinetLayout([
      { kind: 'resource', id: 'resource-a', slot: 0, columnSpan: 1, rowSpan: 1 },
      { kind: 'folder', id: 'folder-a', slot: 5, columnSpan: 1, rowSpan: 1 },
      { kind: 'folder', id: 'folder-a', slot: 8, columnSpan: 1, rowSpan: 1 },
      { kind: 'resource', id: '', slot: 2, columnSpan: 1, rowSpan: 1 },
    ])

    expect(service.getCabinetLayout()).toEqual([
      { kind: 'resource', id: 'resource-a', slot: 0, columnSpan: 1, rowSpan: 1 },
      { kind: 'folder', id: 'folder-a', slot: 5, columnSpan: 1, rowSpan: 1 },
    ])
    expect(service.exportGeneralPreferences().cabinetLayout).toEqual(service.getCabinetLayout())

    localStorage.clear()
    service.importGeneralPreferences({
      previewPolicy: { allowRemoteResources: false, allowScripts: false },
      extractCharacterAssets: false,
      hideCharacterAssets: true,
      hideChatDisplayRegex: true,
      searchHistory: [],
      cabinetResourceIds: ['resource-a'],
      cabinetLayout: [{ kind: 'folder', id: 'folder-a', slot: 3, columnSpan: 1, rowSpan: 1 }],
    })
    expect(service.getCabinetLayout()).toEqual([
      { kind: 'folder', id: 'folder-a', slot: 3, columnSpan: 1, rowSpan: 1 },
    ])
  })

  it('persists only supported cabinet column counts and includes them in portable preferences', () => {
    const service = new BrowserStorageService()
    expect(service.getCabinetColumns()).toBe(4)

    service.setCabinetColumns(2)
    expect(service.getCabinetColumns()).toBe(2)
    expect(service.exportGeneralPreferences().cabinetColumns).toBe(2)

    localStorage.setItem('srl.cabinet.columns', '8')
    expect(service.getCabinetColumns()).toBe(4)
  })

  it('restores cabinet columns from portable preferences', () => {
    const service = new BrowserStorageService()
    service.importGeneralPreferences({
      previewPolicy: { allowRemoteResources: false, allowScripts: false },
      extractCharacterAssets: false,
      hideCharacterAssets: true,
      hideChatDisplayRegex: true,
      searchHistory: [],
      cabinetColumns: 3,
    })

    expect(service.getCabinetColumns()).toBe(3)
  })

  it('persists valid custom persona templates and restores them with portable preferences', () => {
    const service = new BrowserStorageService()
    const templates = service.setUserPersonaTemplates([
      { id: 'custom-city', name: '  都市玩家  ', description: '{{user}} 喜欢推理。' },
      { id: 'built-in-id', name: '不能覆盖内置', description: '忽略' },
      { id: 'custom-empty', name: '空内容', description: '  ' },
    ])

    expect(templates).toEqual([
      { id: 'custom-city', name: '都市玩家', description: '{{user}} 喜欢推理。' },
    ])
    expect(service.getUserPersonaTemplates()).toEqual(templates)
    expect(service.exportGeneralPreferences().userPersonaTemplates).toEqual(templates)

    localStorage.clear()
    service.importGeneralPreferences({
      previewPolicy: { allowRemoteResources: false, allowScripts: false },
      extractCharacterAssets: false,
      hideCharacterAssets: true,
      hideChatDisplayRegex: true,
      searchHistory: [],
      userPersonaTemplates: templates,
    })
    expect(service.getUserPersonaTemplates()).toEqual(templates)
  })

  it('persists stitch favorites and the preferred main side through portable preferences', () => {
    const service = new BrowserStorageService()
    const favorites = service.setStitchFavorites([
      {
        id: 'favorite-1',
        sourceResourceId: 'preset-1',
        sourceName: '来源预设',
        identifier: 'style-1',
        name: '文风段',
        role: 'system',
        content: '轻小说文风',
        prompt: {
          identifier: 'style-1',
          name: '文风段',
          role: 'system',
          content: '轻小说文风',
          unknown: { keep: true },
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    service.setStitchMainSide('left')
    expect(service.getStitchFavorites()).toEqual(favorites)
    expect(service.exportGeneralPreferences()).toMatchObject({
      stitchFavorites: favorites,
      stitchMainSide: 'left',
    })

    const portable = service.exportGeneralPreferences()
    localStorage.clear()
    service.importGeneralPreferences(portable)
    expect(service.getStitchFavorites()).toEqual(favorites)
    expect(service.getStitchMainSide()).toBe('left')
  })

  it('persists stitch templates through portable preferences', () => {
    const service = new BrowserStorageService()
    const templates = service.setStitchTemplates([
      {
        id: 'template-1',
        name: '常用文风',
        entries: [
          {
            id: 'favorite-1',
            sourceName: '来源预设',
            identifier: 'style-1',
            name: '文风段',
            role: 'system',
            content: '轻小说文风',
            prompt: {
              identifier: 'style-1',
              name: '文风段',
              role: 'system',
              content: '轻小说文风',
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    expect(service.getStitchTemplates()).toEqual(templates)
    const portable = service.exportGeneralPreferences()
    localStorage.clear()
    service.importGeneralPreferences(portable)
    expect(service.getStitchTemplates()).toEqual(templates)
  })

  it('saves and clears one manual preset stitch checkpoint', () => {
    const service = new BrowserStorageService()
    const checkpoint = {
      baseId: 'base-1',
      name: '检查点预设',
      savedAt: 1_700_000_000_000,
      entries: [{ origin: 'base' as const, identifier: 'main', enabled: true }],
      regexPickIds: [],
    }
    service.setPresetStitchCheckpoint(checkpoint)
    expect(service.getPresetStitchCheckpoint()).toEqual(checkpoint)
    service.clearPresetStitchCheckpoint()
    expect(service.getPresetStitchCheckpoint()).toBeUndefined()
  })
})

it('round-trips selected chat scripts in the existing transfer draft and rejects unsafe source IDs', () => {
  const service = new BrowserStorageService()
  const item = {
    key: 'chat:one',
    name: '雨夜',
    label: '聊天',
    detail: '',
    status: 'pending' as const,
    readingScriptIds: ['scriptGlobal:phone', 'scriptPreset:preset'],
  }
  const draft = {
    direction: 'pull' as const,
    origin: 'https://tavern.test',
    policy: 'copy' as const,
    at: Date.now(),
    items: [item],
  }
  service.setBridgeTransferDraft(draft)
  expect(service.getBridgeTransferDraft()?.items[0]?.readingScriptIds).toEqual(
    item.readingScriptIds,
  )
  for (const ids of [['character:secret'], Array.from({ length: 9 }, () => 'scriptGlobal:a')]) {
    service.setBridgeTransferDraft({ ...draft, items: [{ ...item, readingScriptIds: ids }] })
    expect(service.getBridgeTransferDraft()).toBeUndefined()
  }
  service.setBridgeTransferDraft({ ...draft, items: [{ ...item, readingScriptIds: undefined }] })
  expect(service.getBridgeTransferDraft()?.items).toHaveLength(1)
  localStorage.removeItem('srl-bridge-transfer-draft')
})
