/** @vitest-environment jsdom */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyPersonaBackup,
  parseSillyTavernPersonaBackup,
} from '../parser/SillyTavernPersonaBackup'
import { RESOURCE_TYPE, type Resource, type ResourceSummary } from '../types/Resource'
import type {
  SillyTavernPersonaBackup,
  UserPersonaEntry,
  UserPersonaDraft,
  UserPersonaProfile,
} from '../types/UserPersona'
import { dirtyStateRegistry } from '../core/DirtyStateRegistry'
import UserPersonaApp from './UserPersonaApp.vue'
const mocks = vi.hoisted(() => ({
  templates: [] as Array<{ id: string; name: string; description: string }>,
  chooseAction: vi.fn(),
  confirmAction: vi.fn(),
  userPersonaService: {
    load: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    importFiles: vi.fn(),
    loadAvatarResource: vi.fn(),
    cacheAvatarFile: vi.fn(),
    cacheAvatarFromUrl: vi.fn(),
  },
  resourceService: {
    importFiles: vi.fn(),
    listResourceListSummaries: vi.fn(),
    updateDetails: vi.fn(),
  },
  recycleBinService: {
    moveToRecycleBin: vi.fn(),
    movePersonaVersionToRecycleBin: vi.fn(),
    movePersonaCharacterToRecycleBin: vi.fn(),
  },
}))
vi.mock('../core/AppContainer', () => ({
  ...mocks,
  assetStore: { getBlob: vi.fn() },
  browserStorageService: {
    getUserPersonaTemplates: () => mocks.templates,
    setUserPersonaTemplates: (items: typeof mocks.templates) => (mocks.templates = items),
  },
}))
vi.mock('../composables/UseConfirmDialog', () => mocks)
vi.mock('../core/PlatformService', () => ({
  platform: { files: { isImagePickerAvailable: async () => false } },
}))
const wrappers: VueWrapper[] = []
function render(resources: ResourceSummary[] = []) {
  const wrapper = mount(UserPersonaApp, {
    props: { resources, categories: [] },
    global: {
      stubs: {
        TavernBridgeCenter: {
          name: 'TavernBridgeCenter',
          template: '<button class="transfer-back" @click="$emit(\'back\')">返回人设</button>',
          emits: ['back', 'import-files'],
        },
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}
function summary(id: string, type: ResourceSummary['type'], name = id): ResourceSummary {
  return {
    id,
    name,
    type,
    fileName: `${id}.${type === RESOURCE_TYPE.CHARACTER_CARD ? 'png' : 'json'}`,
    metadata: {},
    tags: [],
    categoryIds: [],
    relatedResourceIds: [],
    sourceLinks: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as ResourceSummary
}
function persona(backup?: SillyTavernPersonaBackup): Resource {
  return {
    ...summary('personas', RESOURCE_TYPE.USER_PERSONA),
    originalBlob: new Blob([JSON.stringify(backup ?? multiBackup)], { type: 'application/json' }),
    relatedResourceIds: ['manual-link'],
  } as Resource
}
const multiBackup: SillyTavernPersonaBackup = {
  personas: { 'a.png': '甲', 'b.png': '乙' },
  persona_descriptions: {
    'a.png': { description: '甲描述', connections: [] },
    'b.png': {
      description: '乙描述',
      title: '乙备注',
      lorebook: 'world',
      connections: [
        { type: 'character', id: 'old.png' },
        { type: 'group', id: 'group-1' },
      ],
      custom: '保留',
    },
  },
  default_persona: 'a.png',
  customRoot: '保留',
}
async function click(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find((b) => b.text() === text)
  if (button) await button.trigger('click')
  else {
    const teleported = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === text,
    )
    expect(teleported, text).toBeDefined()
    teleported!.click()
  }
  await flushPromises()
}
async function openSecond(wrapper: VueWrapper) {
  await wrapper.get('.persona-app__list-item').trigger('click')
  await flushPromises()
  await wrapper.get('select').setValue('b.png')
  await flushPromises()
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.resourceService.listResourceListSummaries.mockReset().mockResolvedValue([])
  mocks.templates = []
  mocks.chooseAction.mockImplementation(async (options: { title: string }) =>
    options.title === '资源文件版本' ? 'confirm' : 'cancel',
  )
  mocks.confirmAction.mockResolvedValue(true)
  mocks.userPersonaService.loadAvatarResource.mockResolvedValue(undefined)
  mocks.userPersonaService.load.mockResolvedValue({
    resource: persona(),
    view: parseSillyTavernPersonaBackup(multiBackup),
  })
  mocks.userPersonaService.save.mockImplementation(
    async (_id: string, backup: SillyTavernPersonaBackup) => {
      mocks.userPersonaService.load.mockResolvedValue({
        resource: persona(backup),
        view: parseSillyTavernPersonaBackup(backup),
      })
      return persona(backup)
    },
  )
  mocks.userPersonaService.create.mockImplementation(async (draft: UserPersonaDraft) => {
    const backup = createEmptyPersonaBackup(draft)
    mocks.userPersonaService.load.mockResolvedValue({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    return persona(backup)
  })
  mocks.recycleBinService.movePersonaVersionToRecycleBin.mockImplementation(
    async ({
      resourceId,
      avatarId,
      characterId,
      versionId,
    }: {
      resourceId: string
      avatarId: string
      characterId: string
      versionId: string
    }) => {
      const loaded = await mocks.userPersonaService.load(resourceId)
      const backup = JSON.parse(JSON.stringify(loaded.view.raw)) as SillyTavernPersonaBackup
      const descriptor = backup.persona_descriptions[avatarId] as Record<string, unknown>
      const profile = descriptor.srl_persona_profile as UserPersonaProfile
      const variant = profile.variants[characterId]!
      delete variant.versions[versionId]
      if (variant.chatVersions) {
        for (const [chatId, selectedId] of Object.entries(variant.chatVersions))
          if (selectedId === versionId) delete variant.chatVersions[chatId]
      }
      const remaining = Object.keys(variant.versions)
      if (!remaining.length) delete profile.variants[characterId]
      else if (variant.defaultVersionId === versionId) variant.defaultVersionId = remaining[0]!
      descriptor.srl_persona_profile = profile
      mocks.userPersonaService.load.mockResolvedValue({
        resource: persona(backup),
        view: parseSillyTavernPersonaBackup(backup),
      })
      return { id: 'recycled-persona-version', itemKind: 'persona-version' }
    },
  )
  mocks.recycleBinService.movePersonaCharacterToRecycleBin.mockImplementation(
    async ({
      resourceId,
      avatarId,
      characterId,
    }: {
      resourceId: string
      avatarId: string
      characterId: string
    }) => {
      const loaded = await mocks.userPersonaService.load(resourceId)
      const entries = loaded.view.entries.map((entry: UserPersonaEntry) => {
        if (entry.avatarId !== avatarId) return entry
        const profile = structuredClone(entry.profile)
        delete profile.variants[characterId]
        return { ...entry, profile }
      })
      mocks.userPersonaService.load.mockResolvedValue({
        resource: loaded.resource,
        view: { ...loaded.view, entries },
      })
      return { id: 'recycled-persona-character', itemKind: 'persona-character' }
    },
  )
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:avatar'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  document.body.innerHTML = ''
})
describe('人设列表和单页编辑', () => {
  it('opens and repeatedly saves imported global sections without dirtying or duplicating text', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'me.png': '林予' },
      default_persona: 'me.png',
      persona_descriptions: {
        'me.png': {
          description: '身份设定\n\n外貌设定',
          srl_persona_profile: {
            version: 1,
            sections: [
              { id: 'base', name: '基础设定', text: '身份设定' },
              { id: 'legacy', name: '兼容内容', text: '外貌设定' },
            ],
            variants: {},
          },
        },
      },
    }
    const w = render([persona(backup)])
    mocks.userPersonaService.load.mockResolvedValueOnce({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    expect(w.find('.persona-app__save-state.is-dirty').exists()).toBe(false)
    for (const note of ['第一次备注', '第二次备注']) {
      await w.get('[name="personaNote"]').setValue(note)
      await click(w, '保存')
      const saved = mocks.userPersonaService.save.mock.calls.at(-1)![1] as SillyTavernPersonaBackup
      const entry = parseSillyTavernPersonaBackup(saved).entries[0]!
      expect(entry.description).toBe('身份设定\n\n外貌设定')
      expect(entry.profile.sections.map((section) => section.text)).toEqual([
        '身份设定',
        '外貌设定',
      ])
    }
  })

  it('adds characters from the content page and returns to the real parent when cancelled', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'me.png': '林予' },
      persona_descriptions: {
        'me.png': {
          description: '全局内容',
          srl_persona_profile: {
            version: 1,
            sections: [{ id: 'base', name: '基础设定', text: '全局内容' }],
            variants: {
              'char.png': {
                defaultVersionId: 'first',
                versions: { first: { name: '初识', overrides: {}, addition: '补充' } },
              },
            },
          },
        },
      },
    }
    const w = render([persona(backup), summary('char', RESOURCE_TYPE.CHARACTER_CARD, '苏砚')])
    mocks.userPersonaService.load.mockResolvedValueOnce({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    await click(w, '添加角色')
    expect(w.get('.persona-app').attributes('data-page')).toBe('character-picker')
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('profile-sections')
    expect(mocks.userPersonaService.save).not.toHaveBeenCalled()
  })

  it('shows inherited global content, protects mode cancellation, and applies text tools only to the supplement', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'me.png': '林予' },
      persona_descriptions: {
        'me.png': {
          description: '全局内容',
          srl_persona_profile: {
            version: 1,
            sections: [{ id: 'base', name: '基础设定', text: '全局内容' }],
            variants: {
              'char.png': {
                defaultVersionId: 'first',
                versions: { first: { name: '初识', overrides: {}, addition: '专属补充' } },
              },
            },
          },
        },
      },
    }
    const w = render([persona(backup), summary('char', RESOURCE_TYPE.CHARACTER_CARD, '苏砚')])
    mocks.userPersonaService.load.mockResolvedValueOnce({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    await w.findAll('.persona-app__navigation-item').at(-1)!.trigger('click')
    expect(w.get('.persona-app__inherited-text').text()).toBe('全局内容')
    const mode = w.get('[aria-label="基础设定内容方式"]')
    await mode.setValue('disable')
    expect(w.get('.persona-app__profile-preview-prompt').text()).toBe('专属补充')
    mocks.confirmAction.mockResolvedValueOnce(false)
    await mode.setValue('inherit')
    await flushPromises()
    expect((mode.element as HTMLSelectElement).value).toBe('disable')
    await mode.setValue('inherit')
    await flushPromises()
    expect(w.get('.persona-app__profile-preview-prompt').text()).toBe('全局内容\n专属补充')
    const addition = w.get<HTMLTextAreaElement>('[aria-label="当前角色卡的追加人设"]')
    await addition.trigger('focus')
    addition.element.setSelectionRange(2, 2)
    await click(w, '{{char}}')
    expect(addition.element.value).toBe('专属{{char}}补充')
    expect(addition.element.selectionStart).toBe(10)
    await click(w, '模板')
    await w.get('[aria-label="人物模板"]').setValue('brief')
    await click(w, '应用模板')
    await click(w, '保存')
    const saved = mocks.userPersonaService.save.mock.calls.at(-1)![1] as SillyTavernPersonaBackup
    const entry = parseSillyTavernPersonaBackup(saved).entries[0]!
    expect(entry.description).toBe('全局内容')
    expect(entry.profile.variants['char.png']!.versions.first!.addition).toContain(
      '{{user}} 是一名',
    )
  })

  it('finds persona summaries by associated character name without loading their files', async () => {
    const resource = persona()
    resource.metadata.personaProfileCharacterNames = ['苏砚']
    const w = render([resource])
    await w.get('[aria-label="搜索人设"]').setValue('苏砚')
    expect(w.findAll('.persona-app__list-item')).toHaveLength(1)
    expect(mocks.userPersonaService.load).not.toHaveBeenCalled()
  })
  it('offers a direct history action and confirms unsaved edits before opening versions', async () => {
    const w = render([persona()])
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    await w.get('[aria-label="更多人设操作"]').trigger('click')
    expect(document.body.textContent).toContain('查看历史版本')
    expect(document.body.textContent).toContain('发送整份人设文件到酒馆')
    await Array.from(document.querySelectorAll<HTMLButtonElement>('.action-sheet__actions button'))
      .find((button) => button.textContent?.includes('查看历史版本'))!
      .click()
    await flushPromises()
    expect(w.emitted('open-history')?.[0]?.[0]).toMatchObject({ id: 'personas' })

    await w.get('textarea').setValue('未保存的编辑')
    mocks.chooseAction.mockResolvedValueOnce('cancel')
    await w.get('[aria-label="更多人设操作"]').trigger('click')
    await Array.from(document.querySelectorAll<HTMLButtonElement>('.action-sheet__actions button'))
      .find((button) => button.textContent?.includes('查看历史版本'))!
      .click()
    await flushPromises()
    expect(w.emitted('open-history')).toHaveLength(1)
    expect(w.get('textarea').element.value).toBe('未保存的编辑')
  })
  it('offers one creation entry and one transfer entry, with all identity fields on the same page', async () => {
    const w = render()
    expect(w.findAll('button').filter((b) => b.text() === '新建')).toHaveLength(1)
    expect(w.findAll('button').filter((b) => b.text() === '酒馆互传')).toHaveLength(1)
    await click(w, '新建')
    expect(w.find('[name="personaName"]').exists()).toBe(true)
    expect(w.find('[name="personaNote"]').exists()).toBe(true)
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.findAll('.feature-back-button')).toHaveLength(1)
    expect(w.findAll('button').filter((b) => b.text() === '保存')).toHaveLength(1)
    expect(w.find('.persona-app__creation-steps').exists()).toBe(false)
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('list')
    expect(w.emitted('back')).toBeUndefined()
    await w.get('.feature-back-button').trigger('click')
    expect(w.emitted('back')).toHaveLength(1)
  })
  it('inserts both placeholders at the selection and restores the caret', async () => {
    const w = render()
    await click(w, '新建')
    const field = w.get('textarea')
    await field.setValue('前旧后')
    const textarea = field.element as HTMLTextAreaElement
    textarea.setSelectionRange(1, 2)
    await click(w, '{{char}}')
    expect(textarea.value).toBe('前{{char}}后')
    expect(textarea.selectionStart).toBe(9)
    await click(w, '{{user}}')
    expect(textarea.value).toBe('前{{char}}{{user}}后')
  })
  it('saves name, note, description, injection and both bindings to a persona resource', async () => {
    const w = render([
      summary('char', RESOURCE_TYPE.CHARACTER_CARD),
      summary('world', RESOURCE_TYPE.WORLD_BOOK),
    ])
    await click(w, '新建')
    await w.get('[name="personaName"]').setValue('新名字')
    await w.get('[name="personaNote"]').setValue('备注')
    await w.get('textarea').setValue('{{user}} 与 {{char}}')
    await w.get('.persona-app__injection select').setValue(4)
    await w.get('input[type="number"]').setValue(5)
    await w.get('.persona-app__bindings select').setValue('world')
    await w.get('input[type="checkbox"]').setValue(true)
    await click(w, '保存')
    expect(mocks.userPersonaService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '新名字',
        title: '备注',
        description: '{{user}} 与 {{char}}',
        position: 4,
        depth: 5,
        lorebook: 'world',
        connections: [{ type: 'character', id: 'char.png' }],
      }),
      ['world', 'char'],
      null,
    )
    expect(w.text()).toContain('已保存到资源库')
    expect(dirtyStateRegistry.hasDirtyState('user-persona')).toBe(false)
  })
  it('adds a character profile from the menu and creates an independent named version', async () => {
    const w = render([summary('char', RESOURCE_TYPE.CHARACTER_CARD, '侦探')])
    await click(w, '新建')
    await w.get('[name="personaName"]').setValue('同一个我')
    await w.get('textarea#persona-description').setValue('全局身份')
    await w.get('[aria-label="更多人设操作"]').trigger('click')
    await click(w, '增加角色卡专属人设')
    await w.findAll('.persona-app__navigation-item').at(-1)!.trigger('click')
    await w.get('[aria-label="当前角色卡的追加人设"]').setValue('与侦探是多年搭档。')
    await w.get('[aria-label="版本操作"]').trigger('click')
    await click(w, '增加其他版本')
    await w.get('[aria-label="角色人设版本名称"]').setValue('潜伏时期')
    await w.get('[aria-label="当前角色卡的追加人设"]').setValue('正在执行潜伏任务。')
    await click(w, '保存')
    const [createdValue, relatedIds] = mocks.userPersonaService.create.mock.calls[0]!
    const createdDraft = createdValue as UserPersonaDraft
    expect(createdDraft.profile.sections[0]).toEqual(
      expect.objectContaining({ id: 'base', name: '基础设定', text: '全局身份' }),
    )
    const variant = createdDraft.profile.variants['char.png']!
    expect(Object.values(variant.versions).map((version) => version.name)).toEqual([
      '版本 1',
      '潜伏时期',
    ])
    expect(Object.values(variant.versions).map((version) => version.addition)).toEqual([
      '与侦探是多年搭档。',
      '正在执行潜伏任务。',
    ])
    expect(relatedIds).toEqual(['char'])
  })
  it('moves a whole character persona and its versions to recycle bin immediately', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'me.png': 'Me' },
      persona_descriptions: {
        'me.png': {
          description: '全局内容',
          srl_persona_profile: {
            version: 1,
            sections: [{ id: 'base', name: '基础设定', text: '全局内容' }],
            variants: {
              'char.png': {
                defaultVersionId: 'v1',
                versions: {
                  v1: { name: '初遇', overrides: {}, addition: '第一次相遇。' },
                  v2: { name: '重逢', overrides: {}, addition: '多年后重逢。' },
                },
              },
            },
          },
        },
      },
    }
    const w = render([persona(backup), summary('char', RESOURCE_TYPE.CHARACTER_CARD, '侦探')])
    mocks.userPersonaService.load.mockResolvedValue({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    await w.get('[aria-label="删除侦探的人设"]').trigger('click')
    await flushPromises()
    const confirmation = mocks.confirmAction.mock.calls.at(-1)?.[0] as {
      message: string
      confirmLabel: string
    }
    expect(confirmation.message).toContain('移入回收站')
    expect(confirmation.message).not.toContain('点击右上角“保存”')
    expect(confirmation.confirmLabel).toBe('移入回收站')
    expect(mocks.recycleBinService.movePersonaCharacterToRecycleBin).toHaveBeenCalledWith({
      resourceId: 'personas',
      avatarId: 'me.png',
      characterId: 'char.png',
      characterName: '侦探',
    })
    expect(w.text()).toContain('已移入回收站')
  })
  it('keeps version navigation compact and supports preview, long-press actions, and editing', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'me.png': 'Me' },
      persona_descriptions: {
        'me.png': {
          description: '全局内容',
          srl_persona_profile: {
            version: 1,
            sections: [{ id: 'base', name: '基础设定', text: '全局内容' }],
            variants: {
              'char.png': {
                defaultVersionId: 'v1',
                versions: {
                  v1: { name: '初遇', overrides: {}, addition: '第一次相遇。' },
                  v2: { name: '重逢', overrides: {}, addition: '多年后重逢。' },
                },
              },
            },
          },
        },
      },
    }
    const w = render([persona(backup), summary('char', RESOURCE_TYPE.CHARACTER_CARD, '侦探')])
    mocks.userPersonaService.load.mockResolvedValueOnce({
      resource: persona(backup),
      view: parseSillyTavernPersonaBackup(backup),
    })
    await w.get('.persona-app__list-item').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('profile-sections')
    expect(w.text()).toContain('全局人设')
    expect(w.text()).not.toContain('选择要查看或编辑的人设内容')
    await w.findAll('.persona-app__navigation-item').at(-1)!.trigger('click')
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    expect(w.text()).toContain('初遇')
    expect(w.text()).not.toContain('选择一个版本查看或编辑内容')
    await w.findAll('.persona-app__version-preview-toggle').at(1)!.trigger('click')
    expect(w.text()).toContain('多年后重逢。')

    const pointerDown = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(pointerDown, 'button', { value: 0 })
    w.findAll('.persona-app__version-card').at(1)!.element.dispatchEvent(pointerDown)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(document.body.textContent).toContain('版本操作')
    expect(document.body.textContent).toContain('设为默认版本')
    expect(document.body.textContent).toContain('重命名')
    expect(document.body.textContent).toContain('移入回收站')
    document.querySelector<HTMLButtonElement>('[aria-label="关闭操作面板"]')!.click()
    await flushPromises()
    await w.findAll('.persona-app__version-more').at(1)!.trigger('click')
    await click(w, '重命名')
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    const renameDialog = document.querySelector(
      '[role="dialog"][aria-labelledby="persona-version-rename-title"]',
    )!
    expect(renameDialog).toBeTruthy()
    const renameInput = renameDialog.querySelector<HTMLInputElement>('[aria-label="版本名称"]')!
    renameInput.value = '重逢·改名'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    await click(w, '确定')
    expect(w.text()).toContain('重逢·改名')
    await w.findAll('.persona-app__version-more').at(1)!.trigger('click')
    await click(w, '设为默认版本')
    expect(w.findAll('.persona-app__version-badge').at(1)!.text()).toBe('默认')

    await w.findAll('.persona-app__version-edit').at(1)!.trigger('click')
    await w.get('[aria-label="角色人设版本名称"]').setValue('重逢·调整版')
    await w.get('[aria-label="版本操作"]').trigger('click')
    expect(document.body.textContent).toContain('增加其他版本')
    expect(document.body.textContent).not.toContain('重命名当前版本')
    document.querySelector<HTMLButtonElement>('[aria-label="关闭操作面板"]')!.click()
    await flushPromises()
    await click(w, '保存')
    expect((w.get('[aria-label="角色人设版本名称"]').element as HTMLInputElement).value).toBe(
      '重逢·调整版',
    )
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')

    const recycledBeforeFirstDelete =
      mocks.recycleBinService.movePersonaVersionToRecycleBin.mock.calls.length
    await w.findAll('.persona-app__version-more').at(1)!.trigger('click')
    await click(w, '移入回收站')
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    expect(w.text()).toContain('初遇')
    expect(w.findAll('.persona-app__version-card')).toHaveLength(1)
    expect(w.find('.persona-app__version-card').text()).not.toContain('重逢·调整版')
    expect(mocks.recycleBinService.movePersonaVersionToRecycleBin).toHaveBeenCalledTimes(
      recycledBeforeFirstDelete + 1,
    )
    expect(mocks.recycleBinService.movePersonaVersionToRecycleBin.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        resourceId: 'personas',
        avatarId: 'me.png',
        characterId: 'char.png',
        versionId: 'v2',
      }),
    )
    await w.find('.persona-app__version-edit').trigger('click')
    expect((w.get('[aria-label="角色人设版本名称"]').element as HTMLInputElement).value).toBe(
      '初遇',
    )
    expect(
      (w.get('[aria-label="当前角色卡的追加人设"]').element as HTMLTextAreaElement).value,
    ).toBe('第一次相遇。')

    await w.get('[aria-label="版本操作"]').trigger('click')
    await click(w, '增加其他版本')
    expect((w.get('[aria-label="角色人设版本名称"]').element as HTMLInputElement).value).toBe(
      '新版本',
    )
    await w.get('[aria-label="角色人设版本名称"]').setValue('潜伏时期')
    await w.get('[aria-label="当前角色卡的追加人设"]').setValue('正在执行潜伏任务。')
    await click(w, '保存')
    expect((w.get('[aria-label="角色人设版本名称"]').element as HTMLInputElement).value).toBe(
      '潜伏时期',
    )
    expect(mocks.chooseAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '资源文件版本',
        message: expect.stringContaining('与角色卡下的“人设版本”互相独立'),
      }),
    )
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    expect(w.text()).toContain('潜伏时期')
    await w.findAll('.persona-app__version-more').at(-1)!.trigger('click')
    mocks.confirmAction.mockResolvedValueOnce(false)
    await click(w, '移入回收站')
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    expect(w.text()).toContain('潜伏时期')
    expect(mocks.confirmAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('可在“数据保护 → 回收站”恢复'),
      }),
    )
    const recycledBeforeConfirmedDelete =
      mocks.recycleBinService.movePersonaVersionToRecycleBin.mock.calls.length
    mocks.confirmAction.mockResolvedValueOnce(true)
    await w.findAll('.persona-app__version-more').at(-1)!.trigger('click')
    await click(w, '移入回收站')
    expect(w.get('.persona-app').attributes('data-page')).toBe('versions')
    expect(w.findAll('.persona-app__version-card')).toHaveLength(1)
    expect(w.find('.persona-app__version-card').text()).not.toContain('潜伏时期')
    expect(mocks.recycleBinService.movePersonaVersionToRecycleBin).toHaveBeenCalledTimes(
      recycledBeforeConfirmedDelete + 1,
    )
    await w.find('.persona-app__version-edit').trigger('click')
    expect((w.get('[aria-label="角色人设版本名称"]').element as HTMLInputElement).value).toBe(
      '初遇',
    )

    expect(w.text()).toContain('全局人设')
    expect(w.text()).toContain('最终人设预览')
    await w.get('[aria-label="基础设定内容方式"]').setValue('replace')
    const replacement = w.get('[aria-label="替换基础设定内容"]')
    expect((replacement.element as HTMLTextAreaElement).value).toBe('全局内容')
    await replacement.setValue('只对此版本生效的改写')
    mocks.confirmAction.mockResolvedValueOnce(true)
    await click(w, '恢复使用全局内容')
    expect((w.get('[aria-label="基础设定内容方式"]').element as HTMLSelectElement).value).toBe(
      'inherit',
    )
    expect(w.find('[aria-label="替换基础设定内容"]').exists()).toBe(false)
    expect(mocks.confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '恢复使用全局内容',
        message: expect.stringContaining('不会影响全局内容或其他版本'),
      }),
    )
  })
  it('protects dirty drafts on cancel and failed save, then returns to the list after successful save', async () => {
    const w = render()
    await click(w, '新建')
    await w.get('textarea').setValue('未保存描述')
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('textarea').element.value).toBe('未保存描述')
    mocks.chooseAction.mockResolvedValue('confirm')
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toContain('人设名称不能为空')
    expect(w.get('.persona-app').attributes('data-page')).toBe('editor')
    await w.get('[name="personaName"]').setValue('保存人设')
    await w.get('.feature-back-button').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').attributes('data-page')).toBe('list')
    expect(w.emitted('back')).toBeUndefined()
  })
  it('keeps the selected non-default persona after save and preserves unknown data and other entries', async () => {
    const w = render([persona()])
    await openSecond(w)
    await w.get('[name="personaName"]').setValue('乙改名')
    await click(w, '保存')
    expect(w.get<HTMLInputElement>('[name="personaName"]').element.value).toBe('乙改名')
    expect(w.get('textarea').element.value).toBe('乙描述')
    const saved = mocks.userPersonaService.save.mock.calls[0]![1]
    expect(saved).toMatchObject({
      default_persona: 'a.png',
      customRoot: '保留',
      personas: { 'a.png': '甲', 'b.png': '乙改名' },
      persona_descriptions: { 'b.png': { custom: '保留' } },
    })
    expect(dirtyStateRegistry.hasDirtyState('user-persona')).toBe(false)
  })
  it('clears selected worldbook and char bindings without dropping group or manual links', async () => {
    const w = render([
      persona(),
      summary('old', RESOURCE_TYPE.CHARACTER_CARD),
      summary('world', RESOURCE_TYPE.WORLD_BOOK),
    ])
    await openSecond(w)
    await w.get('.persona-app__bindings select').setValue('')
    await w.get('input[type="checkbox"]').setValue(false)
    await click(w, '保存')
    expect(mocks.userPersonaService.save).toHaveBeenCalledWith(
      'personas',
      expect.objectContaining({
        persona_descriptions: expect.objectContaining({
          'b.png': expect.objectContaining({
            lorebook: '',
            connections: [{ type: 'group', id: 'group-1' }],
          }),
        }),
      }),
      ['manual-link'],
      '编辑用户人设',
      null,
      false,
    )
  })
  it('asks on each changed save, preserves the draft on cancel, and passes the explicit history choice', async () => {
    const w = render([persona()])
    await openSecond(w)
    await w.get('textarea').setValue('少改两个字')
    mocks.chooseAction.mockResolvedValueOnce('cancel')
    await click(w, '保存')
    expect(mocks.userPersonaService.save).not.toHaveBeenCalled()
    expect(w.get('textarea').element.value).toBe('少改两个字')
    expect(dirtyStateRegistry.hasDirtyState('user-persona')).toBe(true)
    mocks.chooseAction.mockResolvedValueOnce('alternative')
    await click(w, '保存')
    expect(mocks.userPersonaService.save.mock.calls[0]?.[5]).toBe(true)
    await w.get('textarea').setValue('再次小改')
    await click(w, '保存')
    expect(mocks.userPersonaService.save.mock.calls[1]?.[5]).toBe(false)
    expect(mocks.chooseAction).toHaveBeenCalledTimes(3)
  })
  it('saves and reuses a template across mounts without silently replacing edited text', async () => {
    const w = render()
    await click(w, '新建')
    await w.get('textarea').setValue('模板正文')
    await click(w, '模板')
    await click(w, '存为模板')
    await w.get('[aria-label="模板名称"]').setValue('我的模板')
    await click(w, '保存模板')
    const second = render()
    await click(second, '新建')
    await click(second, '模板')
    await second.get('[aria-label="人物模板"]').setValue(mocks.templates[0]!.id)
    await click(second, '应用模板')
    expect(second.get('textarea').element.value).toBe('模板正文')
    await second.get('textarea').setValue('保留修改')
    await second.get('[aria-label="人物模板"]').setValue('blank')
    mocks.confirmAction.mockResolvedValueOnce(false)
    await click(second, '应用模板')
    expect(second.get('textarea').element.value).toBe('保留修改')
  })
  it('caches URL images as covers and leaves the JSON free of image sources', async () => {
    const cover = {
      ...summary('cover', RESOURCE_TYPE.OTHER),
      metadata: {
        assetKind: 'userPersonaAvatar',
        avatarId: 'cover.png',
        sourceUrl: 'https://example.com/a.png',
      },
      originalBlob: new Blob(['png']),
    } as Resource
    mocks.userPersonaService.cacheAvatarFromUrl.mockResolvedValue(cover)
    const w = render()
    await click(w, '新建')
    await w.get('[name="personaName"]').setValue('封面测试')
    await w.get('input[type="url"]').setValue('https://example.com/a.png')
    await click(w, '保存')
    expect(mocks.userPersonaService.cacheAvatarFromUrl).toHaveBeenCalled()
    const args = mocks.userPersonaService.create.mock.calls[0]!
    expect(args[1]).toEqual(['cover'])
    expect(args[2]).toEqual(cover)
    expect(JSON.stringify(args[0])).not.toContain('https://')
  })
  it('does not load all persona blobs just to show the list, and can search older saved names', async () => {
    const w = render(
      Array.from({ length: 40 }, (_, i) =>
        summary(String(i), RESOURCE_TYPE.USER_PERSONA, `人设${i}`),
      ),
    )
    expect(w.findAll('.persona-app__list-item')).toHaveLength(30)
    expect(mocks.userPersonaService.load).not.toHaveBeenCalled()
    await w.get('[aria-label="搜索人设"]').setValue('人设39')
    expect(w.findAll('.persona-app__list-item')).toHaveLength(1)
  })
  it('returns from shared transfer to the persona list', async () => {
    const w = render()
    await click(w, '酒馆互传')
    await w.get('.transfer-back').trigger('click')
    await flushPromises()
    expect(w.get('.persona-app').isVisible()).toBe(true)
    expect(w.emitted('back')).toBeUndefined()
  })
  it.each(['other-resource', 'persona-without-bindings'])(
    'does not scan the catalogue for transferred %s',
    async (kind) => {
      const resource =
        kind === 'other-resource'
          ? summary('card', RESOURCE_TYPE.CHARACTER_CARD)
          : persona(multiBackup)
      mocks.resourceService.importFiles.mockResolvedValue([{ status: 'imported', resource }])
      const file = new File(['{}'], 'transfer.json')
      Object.defineProperty(file, 'text', { value: vi.fn(async () => JSON.stringify(multiBackup)) })
      const complete = vi.fn()
      const w = render()
      await click(w, '酒馆互传')
      w.findComponent({ name: 'TavernBridgeCenter' }).vm.$emit('import-files', [file], complete)
      await flushPromises()

      expect(mocks.resourceService.listResourceListSummaries).not.toHaveBeenCalled()
      expect(mocks.resourceService.updateDetails).not.toHaveBeenCalled()
      expect(w.emitted('library-changed')).toHaveLength(1)
      expect(w.text()).toContain('已接收 1 项')
      expect(complete).toHaveBeenCalledOnce()
    },
  )
  it('shares a fresh catalogue for bound personas within a transfer while preserving manual links and catalogue order', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'a.png': '甲' },
      persona_descriptions: {
        'a.png': {
          srl_persona_character_bindings: {
            'saved.png': { avatar: 'saved.png', name: '角色', hash: 'a'.repeat(64) },
          },
        },
      },
    }
    const files = ['first', 'second'].map((name) => {
      const file = new File(['{}'], `${name}.json`)
      Object.defineProperty(file, 'text', { value: async () => JSON.stringify(backup) })
      return file
    })
    mocks.resourceService.importFiles.mockResolvedValue([
      { status: 'imported', resource: { ...persona(backup), id: 'first' } },
      { status: 'duplicate', resource: { ...persona(backup), id: 'second' } },
    ])
    mocks.resourceService.listResourceListSummaries
      .mockResolvedValueOnce([
        ...Array.from({ length: 10000 }, (_, i) => summary(`unrelated-${i}`, RESOURCE_TYPE.OTHER)),
        { ...summary('card-2', RESOURCE_TYPE.CHARACTER_CARD), contentHash: 'a'.repeat(64) },
        { ...summary('wrong-type', RESOURCE_TYPE.OTHER), contentHash: 'a'.repeat(64) },
        { ...summary('card-1', RESOURCE_TYPE.CHARACTER_CARD), contentHash: 'a'.repeat(64) },
      ])
      .mockResolvedValueOnce([
        { ...summary('new-card', RESOURCE_TYPE.CHARACTER_CARD), contentHash: 'a'.repeat(64) },
      ])
    const w = render()
    await click(w, '酒馆互传')
    w.findComponent({ name: 'TavernBridgeCenter' }).vm.$emit('import-files', files)
    await flushPromises()
    expect(mocks.resourceService.listResourceListSummaries).toHaveBeenCalledOnce()
    expect(mocks.resourceService.updateDetails).toHaveBeenCalledTimes(2)
    for (const [, details] of mocks.resourceService.updateDetails.mock.calls) {
      expect(details.relatedResourceIds).toEqual(['manual-link', 'card-2', 'card-1'])
    }
    expect(w.text()).toContain('已接收 1 项，跳过重复 1 项')

    await click(w, '酒馆互传')
    w.findComponent({ name: 'TavernBridgeCenter' }).vm.$emit('import-files', files)
    await flushPromises()
    expect(mocks.resourceService.listResourceListSummaries).toHaveBeenCalledTimes(2)
    expect(mocks.resourceService.updateDetails).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'second' }),
      expect.objectContaining({ relatedResourceIds: ['manual-link', 'new-card'] }),
    )
  })

  it('reports binding read failures after a successful import without retrying the catalogue for each persona', async () => {
    const backup: SillyTavernPersonaBackup = {
      personas: { 'a.png': '甲' },
      persona_descriptions: {
        'a.png': {
          srl_persona_character_bindings: {
            card: { avatar: 'card.png', name: '角色', hash: 'a'.repeat(64) },
          },
        },
      },
    }
    const files = ['first', 'second'].map((name) => {
      const file = new File(['{}'], `${name}.json`)
      Object.defineProperty(file, 'text', { value: async () => JSON.stringify(backup) })
      return file
    })
    mocks.resourceService.importFiles.mockResolvedValue(
      files.map((file) => ({
        status: 'imported',
        resource: { ...persona(backup), id: file.name },
      })),
    )
    mocks.resourceService.listResourceListSummaries.mockRejectedValueOnce(
      new Error('catalogue failed'),
    )
    const complete = vi.fn()
    const w = render()
    await click(w, '酒馆互传')
    w.findComponent({ name: 'TavernBridgeCenter' }).vm.$emit('import-files', files, complete)
    await flushPromises()

    expect(mocks.resourceService.listResourceListSummaries).toHaveBeenCalledOnce()
    expect(mocks.resourceService.importFiles).toHaveBeenCalledOnce()
    expect(mocks.resourceService.updateDetails).not.toHaveBeenCalled()
    expect(w.emitted('library-changed')).toHaveLength(1)
    expect(w.get('[role="alert"]').text()).toContain('first.json 已接收，但角色卡关系未能更新')
    expect(w.get('[role="alert"]').text()).toContain('second.json 已接收，但角色卡关系未能更新')
    expect(w.text()).toContain('已接收 2 项')
    expect(complete).toHaveBeenCalledOnce()
  })
  it('surfaces JSON import failures', async () => {
    mocks.userPersonaService.importFiles.mockRejectedValue(new Error('导入失败测试'))
    const w = render()
    const input = w.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['{}'], 'personas.json')] })
    await input.trigger('change')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toContain('导入失败测试')
  })
})
