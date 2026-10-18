/** @vitest-environment jsdom */
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'
import { featureAppUsageStore } from '../core/FeatureAppUsageStore'

import { RESOURCE_TYPE, type Category, type ResourceSummary } from '../types/Resource'
import type { InstalledExternalApp } from '../types/ExternalApp'
import FeatureHub from './FeatureHub.vue'
import FolderLibraryView from './FolderLibraryView.vue'
import ActionSheet from './ActionSheet.vue'
enableAutoUnmount(afterEach)
vi.mock('../core/OfficialAppRuntime', () => ({
  ensurePreinstalledOfficialApps: async () => undefined,
  officialAppService: {
    ready: async () => true,
    list: () => listOfficialApps(),
    installedSnapshot: [],
    loadInstalled: () => listOfficialApps(),
    subscribeInstalled: (listener: (apps: { id: string }[]) => void) => {
      installedListeners.add(listener)
      return () => installedListeners.delete(listener)
    },
  },
  acquireOfficialAppUse: async () => () => {},
  loadOfficialApp: async (id: string) => {
    if (id === 'draw') return (await import('./DrawApp.vue')).default
    if (id === 'assistant') return (await import('./ProductAssistant.vue')).default
    if (id === 'imageGeneration') return (await import('./ImageGenerationApp.vue')).default
    if (id === 'imageAlbum') return (await import('./GeneratedImageAlbumApp.vue')).default
    throw new Error('Unexpected test app')
  },
}))

vi.mock('./ImageGenerationApp.vue', () => ({
  __esModule: true,
  default: {
    emits: ['back'],
    template: '<button data-testid="generation-page" @click="$emit(\'back\')">AI 生图</button>',
  },
}))
vi.mock('./GeneratedImageAlbumApp.vue', () => ({
  __esModule: true,
  default: {
    emits: ['back'],
    template: '<button data-testid="album-page" @click="$emit(\'back\')">生图相册</button>',
  },
}))
vi.mock('./ProductAssistant.vue', () => ({
  default: {
    props: ['getContext', 'execute', 'navigate'],
    emits: ['back'],
    template:
      '<div data-testid="assistant-page">蒜惹菈<button class="feature-app-header__back" @click="$emit(\'back\')">返回</button><button data-testid="assistant-open-inbox" @click="navigate(\'inbox\')">打开收件箱</button><button data-testid="assistant-open-appearance" @click="navigate(\'appearance\')">打开外观</button></div>',
  },
}))
// This integration exercises navigation; package loading has dedicated Gate tests.
vi.mock('./OfficialAssistantGate.vue', async () => ({
  default: (await import('./ProductAssistant.vue')).default,
}))
vi.mock('./DiscordInboxCenter.vue', () => ({
  default: {
    emits: ['back'],
    template:
      '<div data-testid="inbox-page">收件箱<button @click="$emit(\'back\')">返回功能桌面</button></div>',
  },
}))

const { loadDrawState, listExternalApps, listOfficialApps, installedListeners } = vi.hoisted(
  () => ({
    installedListeners: new Set<(apps: { id: string }[]) => void>(),
    listOfficialApps: vi.fn(async () =>
      [
        'draw',
        // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-1
        // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-1
        'assistant',
        'stitch',
        'frontendWorkshop',
        'imageGeneration',
        'imageAlbum',
        'userPersona',
        'tavernBridge',
      ].map((id) => ({ id })),
    ),
    loadDrawState: vi.fn(),
    listExternalApps: vi.fn<() => Promise<InstalledExternalApp[]>>(async () => []),
  }),
)

vi.mock('../core/AppContainer', () => ({
  browserStorageService: {
    getPreviewPolicy: vi.fn(() => ({ allowScripts: false, allowRemoteResources: false })),
    onPreviewPolicyChange: vi.fn(() => () => {}),
    getDrawShowNames: vi.fn(() => false),
    setDrawShowNames: vi.fn(),
    getUserPersonaTemplates: vi.fn(() => []),
    setUserPersonaTemplates: vi.fn((value) => value),
  },
  characterDrawService: {
    load: loadDrawState,
    draw: vi.fn(),
    clear: vi.fn(),
  },
  resourceService: {
    get: vi.fn(),
  },
  externalAppService: {
    list: listExternalApps,
  },
  userPersonaService: {
    load: vi.fn(),
    create: vi.fn(),
    importFiles: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  },
}))

const categories: Category[] = [
  {
    id: 'folder-a',
    name: '古风收藏',
    color: '#486b5d',
    createdAt: 1,
    updatedAt: 1,
  },
]

const resources: ResourceSummary[] = [
  {
    id: 'resource-a',
    name: '青衣',
    description: '',
    type: RESOURCE_TYPE.CHARACTER_CARD,
    fileName: '青衣.png',
    mimeType: 'image/png',
    fileSize: 100,
    contentHash: 'a'.repeat(64),
    favorite: false,
    categoryId: 'folder-a',
    categoryIds: ['folder-a'],
    tags: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  },
]

function render(overrides: Record<string, unknown> = {}) {
  return mount(FeatureHub, {
    props: {
      resources,
      categories,
      theme: 'light',
      layoutMode: 'grid',
      uiFontScale: 'standard',
      customCss: '',
      folderBusy: false,
      cabinetResourceIds: [],
      ...overrides,
    },
  })
}

function countedResources(count: number) {
  const reads = { count: 0 }
  const rows = Array.from({ length: count }, (_, index): ResourceSummary => {
    const row = { ...resources[0]!, id: 'counted-' + index }
    Object.defineProperty(row, 'type', {
      enumerable: true,
      get: () => {
        reads.count++
        return index % 2 ? RESOURCE_TYPE.USER_PERSONA : RESOURCE_TYPE.PRESET
      },
    })
    return row
  })
  return { reads, rows }
}

function dispatchPointer(
  element: Element,
  type: string,
  options: { clientX: number; clientY: number; pointerId: number; pointerType: string },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY,
  })
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId },
    pointerType: { value: options.pointerType },
  })
  element.dispatchEvent(event)
}

describe('FeatureHub', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    localStorage.clear()
    loadDrawState.mockResolvedValue({ totalDraws: 0, totalSessions: 0, records: {}, history: [] })
    listExternalApps.mockResolvedValue([])
  })

  it.each([1000, 10000])(
    'does not rescan %i resource types for each desktop badge',
    async (count) => {
      const { rows, reads } = countedResources(count)
      const wrapper = render({ resources: rows })
      await flushPromises()
      expect(wrapper.get('.feature-app--stitch em').text()).toBe(`${count / 2} 个预设可用`)
      expect(reads.count).toBeLessThanOrEqual(count * 4)
    },
  )

  it('reuses resource type counts while paging through the desktop', async () => {
    const { rows, reads } = countedResources(1001)
    const wrapper = render({ resources: rows })
    await flushPromises()
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-2
    // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-2
    expect(wrapper.get('.feature-app--persona em').text()).toBe('500 份人设文件')
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-3
    // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-3
    reads.count = 0
    for (let index = 0; index < 4; index++) {
      await wrapper.get('[aria-label="下一页应用"]').trigger('click')
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-4
      // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-4
      await wrapper.get('[aria-label="上一页应用"]').trigger('click')
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-5
      expect(wrapper.get('.feature-app--persona em').text()).toBe('500 份人设文件')
      // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-5
      expect(wrapper.get('.feature-app--stitch em').text()).toBe('501 个预设可用')
    }
    expect(reads.count).toBe(0)
  })

  it('does not count resources for a desktop showing only static badges', async () => {
    featureAppUsageStore.togglePinned('builtIn:cloud')
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[aria-label="筛选功能"]').trigger('click')
    wrapper.findComponent(ActionSheet).vm.$emit('select', { id: 'pinned' })
    await flushPromises()
    expect(wrapper.findAll('.feature-desktop > .feature-app')).toHaveLength(1)
    const { rows, reads } = countedResources(1001)
    await wrapper.setProps({ resources: rows })
    expect(wrapper.get('.feature-app--cloud em').text()).toBe('每日异地快照')
    expect(reads.count).toBe(0)
  })

  it('keeps badge counts fresh on in-place resource and category changes', async () => {
    const rows = reactive<ResourceSummary[]>([
      { ...resources[0]!, id: 'persona', type: RESOURCE_TYPE.USER_PERSONA },
      {
        ...resources[0]!,
        id: 'hidden-persona',
        type: RESOURCE_TYPE.USER_PERSONA,
        categoryIds: ['hidden'],
        categoryId: 'hidden',
      },
      { ...resources[0]!, id: 'preset', type: RESOURCE_TYPE.PRESET },
      {
        ...resources[0]!,
        id: 'hidden-preset',
        type: RESOURCE_TYPE.PRESET,
        categoryIds: ['hidden'],
        categoryId: 'hidden',
      },
    ])
    const folders = reactive<Category[]>([
      ...categories,
      { ...categories[0]!, id: 'hidden', name: '隐藏', hidden: true },
    ])
    const wrapper = render({ resources: rows, categories: folders })
    await flushPromises()
    expect(wrapper.get('.feature-app--folders em').text()).toBe('2 个文件夹')
    expect(wrapper.get('.feature-app--stitch em').text()).toBe('1 个预设可用')
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-6
    // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-6
    expect(wrapper.get('.feature-app--persona em').text()).toBe('2 份人设文件')
    rows[2]!.type = RESOURCE_TYPE.USER_PERSONA
    await nextTick()
    expect(wrapper.get('.feature-app--persona em').text()).toBe('3 份人设文件')
    rows.push({ ...resources[0]!, id: 'added', type: RESOURCE_TYPE.USER_PERSONA })
    await nextTick()
    expect(wrapper.get('.feature-app--persona em').text()).toBe('4 份人设文件')
    rows.splice(1, 1)
    await nextTick()
    expect(wrapper.get('.feature-app--persona em').text()).toBe('3 份人设文件')
    rows[0]!.type = RESOURCE_TYPE.PRESET
    folders[1]!.hidden = false
    folders.push({ ...categories[0]!, id: 'new-folder' })
    await nextTick()
    expect(wrapper.get('.feature-app--persona em').text()).toBe('2 份人设文件')
    await wrapper.get('[aria-label="上一页应用"]').trigger('click')
    expect(wrapper.get('.feature-app--folders em').text()).toBe('3 个文件夹')
    expect(wrapper.get('.feature-app--stitch em').text()).toBe('2 个预设可用')
  })

  it('keeps fixed and recent groups behind the lightweight filter entry', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    const cloud = wrapper.get('.feature-app--cloud')
    dispatchPointer(cloud.element, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    await vi.advanceTimersByTimeAsync(550)
    dispatchPointer(cloud.element, 'pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    await cloud.trigger('click')
    expect(wrapper.attributes('data-feature-page')).toBe('home')
    vi.useRealTimers()

    await wrapper.get('.feature-app--draw').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.feature-app-header__back').exists()).toBe(true))
    await wrapper.get('.feature-app-header__back').trigger('click')

    await wrapper.get('[aria-label="筛选功能"]').trigger('click')
    wrapper.findComponent(ActionSheet).vm.$emit('select', { id: 'pinned' })
    await flushPromises()
    expect(wrapper.findAll('.feature-desktop > .feature-app')).toHaveLength(1)
    expect(wrapper.get('.feature-app--cloud').text()).toContain('云备份')

    await wrapper.get('[aria-label="筛选功能"]').trigger('click')
    wrapper.findComponent(ActionSheet).vm.$emit('select', { id: 'recent' })
    await flushPromises()
    expect(wrapper.findAll('.feature-desktop > .feature-app')).toHaveLength(1)
    expect(wrapper.get('.feature-app--draw').text()).toContain('抽了么')
  })

  it('opens the visual folder cabinet from the feature desktop', async () => {
    const wrapper = render()

    expect(wrapper.get('.feature-app--folders').text()).toContain('收藏柜')
    await wrapper.get('.feature-app--folders').trigger('click')

    expect(wrapper.attributes('data-feature-page')).toBe('folders')
    expect(document.body.classList.contains('folder-desktop-open')).toBe(true)
    expect(wrapper.get('.folder-library').text()).toContain('古风收藏')
    await wrapper.get('[aria-label="打开古风收藏"]').trigger('click')
    expect(wrapper.findAll('.feature-app-header')).toHaveLength(1)
    expect(wrapper.get('.feature-app-header h1').text()).toBe('古风收藏')
    expect(wrapper.find('.folder-detail__header').exists()).toBe(false)
    await wrapper.get('[aria-label="返回收藏柜"]').trigger('click')
    expect(wrapper.attributes('data-feature-page')).toBe('folders')
    expect(wrapper.get('.feature-app-header h1').text()).toBe('收藏柜')

    await wrapper.get('.feature-app-header__back').trigger('click')
    expect(document.body.classList.contains('folder-desktop-open')).toBe(false)
  })

  it('retains covers across cabinet entries and clears them when library data is removed', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const wrapper = render()
    await wrapper.setProps({
      resources: [{ ...resources[0]!, thumbnailBlob: new Blob(['cover']) }],
    })
    await wrapper.get('.feature-app--folders').trigger('click')
    await flushPromises()
    const url = wrapper.get('.visual-folder__mosaic img').attributes('src')
    await wrapper.get('.feature-app-header__back').trigger('click')
    expect(revoke).not.toHaveBeenCalledWith(url)
    await wrapper.get('.feature-app--folders').trigger('click')
    expect(wrapper.get('.visual-folder__mosaic img').attributes('src')).toBe(url)
    await wrapper.get('.feature-app-header__back').trigger('click')
    await wrapper.setProps({ resources: [] })
    expect(revoke).toHaveBeenCalledWith(url)
  })

  it('clears retained covers when the desktop is hidden for an ongoing assistant', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const wrapper = render()
    await wrapper.setProps({
      resources: [{ ...resources[0]!, thumbnailBlob: new Blob(['cover']) }],
    })
    await wrapper.get('.feature-app--folders').trigger('click')
    await flushPromises()
    const url = wrapper.get('.visual-folder__mosaic img').attributes('src')
    await wrapper.get('.feature-app-header__back').trigger('click')
    await wrapper.setProps({ active: false })
    expect(revoke).toHaveBeenCalledWith(url)
  })

  it('renders built-in feature apps in their registered order', async () => {
    const wrapper = render()
    await flushPromises()

    const firstPage = wrapper.findAll('.feature-desktop > .feature-app')
    await wrapper.get('button[aria-label="下一页应用"]').trigger('click')
    expect(
      [...firstPage, ...wrapper.findAll('.feature-desktop > .feature-app')].map((app) =>
        app.classes().find((className) => className.startsWith('feature-app--')),
      ),
    ).toEqual([
      // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-7
      // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-7
      'feature-app--draw',
      'feature-app--appearance',
      'feature-app--assistant',
      'feature-app--folders',
      'feature-app--inbox',
      'feature-app--cloud',
      'feature-app--bridge',
      'feature-app--stitch',
      'feature-app--frontend',
      'feature-app--imageGeneration',
      'feature-app--imageAlbum',
      'feature-app--persona',
      'feature-app--extensions',
    ])
    expect(wrapper.find('.feature-app--extensions').exists()).toBe(true)
  })

  it('opens the inbox from the first desktop page without choosing a resource', async () => {
    const wrapper = render()
    try {
      await flushPromises()
      expect(wrapper.get('.feature-app--inbox').text()).toContain('收件箱')
      await wrapper.get('.feature-app--inbox').trigger('click')
      await vi.waitFor(() => expect(wrapper.find('[data-testid="inbox-page"]').exists()).toBe(true))
      expect(wrapper.attributes('data-feature-page')).toBe('inbox')
      expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(false)
      await wrapper.get('[data-testid="inbox-page"] button').trigger('click')
      expect(wrapper.attributes('data-feature-page')).toBe('home')
      expect(wrapper.emitted('openResource')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('opens the AI assistant through the shared appearance owner without locking document scroll', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('.feature-app--assistant').trigger('click')
    await vi.dynamicImportSettled()
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="assistant-page"]').exists()).toBe(true),
    )
    expect(wrapper.attributes('data-feature-page')).toBe('assistant')
    expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(false)
    const studio = wrapper.findComponent({ name: 'AppearanceStudio' })
    const options = { views: {} }
    studio.vm.$emit('save-assistant-css', '.vue-trial{}', options)
    expect(wrapper.emitted('save-assistant-css')?.at(-1)).toEqual(['.vue-trial{}', options])
    studio.vm.$emit('save-assistant-css', '.css-only{}')
    expect(wrapper.emitted('save-assistant-css')?.at(-1)).toEqual(['.css-only{}'])
    await wrapper.get('.feature-app-header__back').trigger('click')
    expect(wrapper.attributes('data-feature-page')).toBe('home')
  })
  it('routes the assistant entry to the existing pet chat when shared chat mode is enabled', async () => {
    const wrapper = render({ sharedAssistantChat: true })
    try {
      await flushPromises()
      await wrapper.get('.feature-app--assistant').trigger('click')
      await flushPromises()

      expect(wrapper.emitted('open-assistant-chat')).toHaveLength(1)
      expect(wrapper.attributes('data-feature-page')).toBe('home')
      expect(wrapper.find('[data-testid="assistant-page"]').exists()).toBe(false)
      expect(wrapper.emitted('assistant-retained')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })
  it('restores the assistant route through the shared pet chat instead of mounting another chat', async () => {
    const previousResumeState = localStorage.getItem('srl.appResume.v1')
    localStorage.setItem(
      'srl.appResume.v1',
      JSON.stringify({ feature: 'featureHub', subpage: 'assistant', savedAt: 1 }),
    )
    const wrapper = render({ sharedAssistantChat: true })
    try {
      await flushPromises()

      expect(wrapper.emitted('open-assistant-chat')).toHaveLength(1)
      expect(wrapper.attributes('data-feature-page')).toBe('home')
      expect(wrapper.find('[data-testid="assistant-page"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      if (previousResumeState === null) localStorage.removeItem('srl.appResume.v1')
      else localStorage.setItem('srl.appResume.v1', previousResumeState)
    }
  })
  it('retains the same assistant after back, library hiding and reopening, without intercepting hidden back events', async () => {
    const wrapper = render()
    try {
      await flushPromises()
      await wrapper.get('.feature-app--assistant').trigger('click')
      await vi.dynamicImportSettled()
      await flushPromises()
      const chat = wrapper.get('[data-testid="assistant-page"]').element
      expect(wrapper.emitted('assistant-retained')).toHaveLength(1)
      await wrapper.get('[data-testid="assistant-page"] .feature-app-header__back').trigger('click')
      expect(wrapper.get('[data-testid="assistant-page"]').isVisible()).toBe(false)
      await wrapper.get('.feature-app--assistant').trigger('click')
      expect(wrapper.get('[data-testid="assistant-page"]').element).toBe(chat)
      await wrapper.setProps({ active: false })
      const detail = { handled: false }
      window.dispatchEvent(new CustomEvent('srl:back-request', { detail }))
      expect(detail.handled).toBe(false)
      expect(wrapper.emitted('assistant-visibility')?.at(-1)).toEqual([false])
      await wrapper.setProps({ active: true })
      expect(wrapper.get('[data-testid="assistant-page"]').element).toBe(chat)
      expect(wrapper.get('[data-testid="assistant-page"]').isVisible()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
  it.each(['inbox', 'appearance'])(
    'opens %s from the assistant through existing feature routes and leaves chat layout',
    async (target) => {
      const wrapper = render()
      try {
        await flushPromises()
        expect(wrapper.get('.feature-app--assistant strong').text()).toBe('蒜惹菈')
        await wrapper.get('.feature-app--assistant').trigger('click')
        await vi.waitFor(() =>
          expect(wrapper.find('[data-testid="assistant-page"]').exists()).toBe(true),
        )
        await wrapper.get(`[data-testid="assistant-open-${target}"]`).trigger('click')
        await flushPromises()
        expect(wrapper.attributes('data-feature-page')).toBe(target)
        expect(wrapper.classes()).not.toContain('feature-hub--assistant')
        expect(wrapper.get('[data-testid="assistant-page"]').isVisible()).toBe(false)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('leaves the chat layout when returning from the assistant', async () => {
    const wrapper = render()
    try {
      await flushPromises()
      await wrapper.get('.feature-app--assistant').trigger('click')
      await flushPromises()
      await vi.waitFor(() =>
        expect(wrapper.find('[data-testid="assistant-page"]').exists()).toBe(true),
      )
      expect(wrapper.classes()).toContain('feature-hub--assistant')
      await wrapper.get('[data-testid="assistant-page"] .feature-app-header__back').trigger('click')
      expect(wrapper.classes()).not.toContain('feature-hub--assistant')
      expect(wrapper.attributes('data-feature-page')).toBe('home')
    } finally {
      wrapper.unmount()
    }
  })

  // SRL-PUBLIC-SYNC: BEGIN PUBLIC-ONLY id=official-app-install-test
  it('removes uninstalled apps from the desktop while keeping management available', async () => {
    listOfficialApps.mockResolvedValueOnce([{ id: 'draw' }])
    const wrapper = render()
    await flushPromises()
    expect(wrapper.find('.feature-app--draw').exists()).toBe(true)
    expect(wrapper.find('.feature-app--stitch').exists()).toBe(false)
    await wrapper.get('.feature-app--folders').trigger('click')
    for (const listener of installedListeners) listener([])
    await wrapper.get('.feature-app-header__back').trigger('click')
    await flushPromises()
    expect(wrapper.find('.feature-app--draw').exists()).toBe(false)
    expect(wrapper.text()).toContain('APP 管理')
    wrapper.unmount()
  })
  // SRL-PUBLIC-SYNC: END PUBLIC-ONLY id=official-app-install-test

  it('restores the frontend workshop when its project resume state is present', async () => {
    localStorage.setItem(
      'srl.appResume.v1',
      JSON.stringify({ feature: 'frontendWorkshop', projectId: 'project-1', savedAt: 1 }),
    )

    const wrapper = render()
    await flushPromises()

    expect(wrapper.attributes('data-feature-page')).toBe('frontendWorkshop')
    expect(wrapper.emitted('feature-app-active')?.at(-1)).toEqual([true])
    expect(JSON.parse(localStorage.getItem('srl.appResume.v1') ?? '{}')).toMatchObject({
      feature: 'frontendWorkshop',
      projectId: 'project-1',
    })
  })

  it('keeps folder navigation in the cabinet and forwards resource details', async () => {
    const wrapper = render()
    await wrapper.get('.feature-app--folders').trigger('click')
    await wrapper.get('button[aria-label="打开古风收藏"]').trigger('click')
    await wrapper.get('.folder-detail__resource').trigger('click')

    expect(wrapper.emitted('openResource')).toEqual([
      [expect.objectContaining({ id: 'resource-a' })],
    ])
  })

  it('forwards cabinet desktop removal without turning it into resource deletion', async () => {
    const wrapper = render()
    await wrapper.get('.feature-app--folders').trigger('click')

    wrapper.getComponent(FolderLibraryView).vm.$emit('unpin', 'resource-a')

    expect(wrapper.emitted('cabinetUnpin')).toEqual([['resource-a']])
    expect(wrapper.emitted('delete')).toBeUndefined()
  })

  it('opens the user persona app from the feature desktop', async () => {
    const wrapper = render()
    await flushPromises()

    if (!wrapper.find('.feature-app--persona').exists())
      await wrapper.get('button[aria-label="下一页应用"]').trigger('click')

    expect(wrapper.get('.feature-app--persona').text()).toContain('user才是老大')
    await wrapper.get('.feature-app--persona').trigger('click')

    expect(wrapper.attributes('data-feature-page')).toBe('userPersona')
    expect(wrapper.get('.async-panel-loading').text()).toContain('正在打开user才是老大')
  })

  it('removes the retired bundle launcher from every desktop page', async () => {
    const wrapper = render()
    await flushPromises()
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=public-featurehub-test-ts-10
    for (let page = 0; page < 5 && !wrapper.find('.feature-app--persona').exists(); page += 1) {
      expect(wrapper.find('.feature-app--bundle').exists()).toBe(false)
      const next = wrapper.find('button[aria-label="下一页应用"]')
      if (!next.exists() || (next.element as HTMLButtonElement).disabled) break
      await next.trigger('click')
    }
    // SRL-PUBLIC-SYNC: END REPLACE id=public-featurehub-test-ts-10
    expect(wrapper.find('.feature-app--bundle').exists()).toBe(false)
    expect(wrapper.find('.feature-app--persona').exists()).toBe(true)
  })

  it('生图和相册使用各自路由，不依赖最近使用记录猜测入口', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('.feature-app--imageGeneration').trigger('click')
    expect(wrapper.attributes('data-feature-page')).toBe('imageGeneration')
    expect(wrapper.get('.async-panel-loading').text()).toContain('正在打开AI 生图')
  })

  it('opens local extension management from the feature desktop', async () => {
    const wrapper = render()

    expect(wrapper.get('.feature-app--extensions').text()).toContain('扩展')
    await wrapper.get('.feature-app--extensions').trigger('click')

    expect(wrapper.attributes('data-feature-page')).toBe('extensions')
  })

  it('puts enabled third-party apps into the same paged feature desktop', async () => {
    listExternalApps.mockResolvedValue([
      ...['one', 'two', 'three'].map((id, index) => ({
        id: `com.example.${id}`,
        enabled: true,
        installedAt: index,
        updatedAt: index,
        runtimeHtml: '',
        manifest: {
          schemaVersion: 1 as const,
          id: `com.example.${id}`,
          name: `第三方 ${index + 1}`,
          version: '1.0.0',
          entry: 'index.html',
        },
      })),
    ])
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('.feature-desktop__pagination').text()).toContain('‹')
    expect(wrapper.findAll('.feature-desktop > .feature-app')).toHaveLength(12)
    expect(wrapper.find('.feature-app--external').exists()).toBe(false)

    await wrapper.get('button[aria-label="下一页应用"]').trigger('click')
    expect(wrapper.find('.feature-app--external').text()).toContain('第三方 1')
    expect(
      wrapper
        .findAll('.feature-app--external')
        .map((app) => app.text())
        .join(' '),
    ).toContain('第三方 1')
    expect(wrapper.findAll('.feature-app--external').map((app) => app.text())).toEqual([
      expect.stringContaining('第三方 1'),
      expect.stringContaining('第三方 2'),
      expect.stringContaining('第三方 3'),
    ])
  })

  it('mounts generation and album as independent registered pages and restores either page', async () => {
    let wrapper = render()
    await flushPromises()
    expect(wrapper.emitted('feature-app-active')).toEqual([[false]])
    for (const [id, testId, scrollLock] of [
      ['imageGeneration', 'generation-page', true],
      ['imageAlbum', 'album-page', false],
    ]) {
      await wrapper.get(`.feature-app--${id}`).trigger('click')
      await flushPromises()
      expect(wrapper.attributes('data-feature-page')).toBe(id)
      expect(wrapper.emitted('feature-app-active')?.at(-1)).toEqual([true])
      expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(scrollLock)
      expect(document.documentElement.classList.contains('feature-app-scroll-lock')).toBe(
        scrollLock,
      )
      await vi.waitFor(() => expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true))
      wrapper.unmount()
      expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(false)
      wrapper = render()
      await flushPromises()
      expect(wrapper.attributes('data-feature-page')).toBe(id)
      expect(wrapper.emitted('feature-app-active')?.at(-1)).toEqual([true])
      await wrapper.get(`[data-testid="${testId}"]`).trigger('click')
      expect(wrapper.attributes('data-feature-page')).toBe('home')
      expect(wrapper.emitted('feature-app-active')?.at(-1)).toEqual([false])
      expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(false)
      expect(document.documentElement.classList.contains('feature-app-scroll-lock')).toBe(false)
    }
    wrapper.unmount()
  })

  it('keeps document scrolling available for the appearance app', async () => {
    const wrapper = render()
    await flushPromises()

    await wrapper.get('.feature-app--appearance').trigger('click')
    await flushPromises()

    expect(wrapper.attributes('data-feature-page')).toBe('appearance')
    expect(document.body.classList.contains('feature-app-scroll-lock')).toBe(false)
    expect(document.documentElement.classList.contains('feature-app-scroll-lock')).toBe(false)
    wrapper.unmount()
  })
})
