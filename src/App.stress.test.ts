/** @vitest-environment jsdom */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { config as mountConfig, shallowMount } from '@vue/test-utils'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import type { ResourceSummary } from './types/Resource'
import { RESOURCE_TYPE } from './types/Resource'

const previousStubs = mountConfig.global.stubs
mountConfig.global.stubs = {
  ...previousStubs,
  LibraryToolbar: false,
  LibrarySidebar: false,
  LibraryProtectionPanel: false,
  LibraryImportChooser: false,
  LibraryLinkImportPanel: false,
  FeatureBackButton: false,
}
afterAll(() => {
  mountConfig.global.stubs = previousStubs
})

const stressApi = vi.hoisted(() => ({
  summaries: [] as ResourceSummary[],
  listResourceListSummaries: vi.fn(async () => stressApi.summaries),
  repairThumbnailAssets: vi.fn(async () => 0),
  upgradeLegacyJsonResources: vi
    .fn<(checkpoint?: () => Promise<void>) => Promise<number>>()
    .mockResolvedValue(0),
  backfillCardFingerprints: vi.fn(async () => 0),
  get: vi.fn(),
  initializeVaultOnce: vi.fn(async () => ({ enabled: false, locked: false })),
  vaultInitialization: undefined as Promise<{ enabled: boolean; locked: boolean }> | undefined,
}))

vi.mock('./core/ServiceWorkerUpdate', () => ({
  manualCheckForUpdate: vi.fn(async () => undefined),
}))

vi.mock('./core/OfficialAppRuntime', () => ({
  officialAppService: { list: vi.fn(async () => []) },
}))

vi.mock('./core/AppContainer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/AppContainer')>()
  return {
    ...actual,
    resourceService: {
      listResourceListSummaries: stressApi.listResourceListSummaries,
      repairThumbnailAssets: stressApi.repairThumbnailAssets,
      upgradeLegacyJsonResources: stressApi.upgradeLegacyJsonResources,
      backfillCardFingerprints: stressApi.backfillCardFingerprints,
      get: stressApi.get,
    },
    categoryService: {
      list: vi.fn(async () => []),
    },
    vaultService: {
      initialize: vi.fn(async () => ({ enabled: false, locked: false })),
    },
    initializeVaultOnce: () => (stressApi.vaultInitialization ??= stressApi.initializeVaultOnce()),
    recycleBinService: {
      list: vi.fn(async () => []),
    },
    cloudBackupService: {
      reconcileNativeJob: vi.fn(async () => undefined),
      runDueBackup: vi.fn(async () => undefined),
    },
  }
})

vi.mock('./core/LibraryContainer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./core/LibraryContainer')>()
  return {
    ...actual,
    resourceService: {
      listResourceListSummaries: stressApi.listResourceListSummaries,
      repairThumbnailAssets: stressApi.repairThumbnailAssets,
      upgradeLegacyJsonResources: stressApi.upgradeLegacyJsonResources,
      backfillCardFingerprints: stressApi.backfillCardFingerprints,
      get: stressApi.get,
    },
    categoryService: { list: vi.fn(async () => []) },
    initializeVaultOnce: () => (stressApi.vaultInitialization ??= stressApi.initializeVaultOnce()),
    browserStorageService: actual.browserStorageService,
    greetingResourceService: { onSaved: () => () => undefined },
    syncNativeResourceFiles: vi.fn(async () => undefined),
  }
})

const { default: App } = await import('./App.vue')

interface ResourceIndexStressMetric {
  count: number
  initialRenderMs: number
  searchP95Ms: number
  sortP95Ms: number
  maxInteractionMs: number
  renderedCards: number
  originalBlobReads: number
}

const stressMetrics: ResourceIndexStressMetric[] = []

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function createStressSummaries(count: number): ResourceSummary[] {
  const types = [
    RESOURCE_TYPE.CHARACTER_CARD,
    RESOURCE_TYPE.WORLD_BOOK,
    RESOURCE_TYPE.REGEX,
    RESOURCE_TYPE.PRESET,
  ]
  return Array.from({ length: count }, (_, index) => {
    const padded = String(index).padStart(5, '0')
    return {
      id: `stress-${padded}`,
      type: types[index % types.length]!,
      name: `压力资源 ${padded}`,
      description: `第 ${index} 条轻量摘要`,
      fileName: `resource-${padded}.${index % 4 === 0 ? 'png' : 'json'}`,
      mimeType: index % 4 === 0 ? 'image/png' : 'application/json',
      fileSize: 4_096 + index,
      contentHash: `hash-${padded}`,
      favorite: index % 10 === 0,
      categoryId: null,
      categoryIds: [],
      relatedResourceIds: [],
      tags: [`批次-${index % 20}`, index % 2 === 0 ? '偶数' : '奇数'],
      metadata: { author: `作者-${index % 100}` },
      versionCount: 1,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
    }
  })
}

describe('App 资源量压力回归', () => {
  it('前台操作打断维护后重新取得摘要，不携带旧快照继续写入', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let interrupted = false
    stressApi.upgradeLegacyJsonResources.mockImplementationOnce(async (checkpoint) => {
      await gate
      try {
        await checkpoint!()
      } catch (error) {
        interrupted = true
        throw error
      }
      return 0
    })
    const wrapper = shallowMount(App, { props: { accountLabel: '维护暂停回归' } })
    await vi.waitFor(() => expect(stressApi.upgradeLegacyJsonResources).toHaveBeenCalledTimes(1))
    await wrapper.get('.mobile-bottom-nav > button:nth-child(2)').trigger('click')
    release()
    await vi.waitFor(() => expect(interrupted).toBe(true))
    expect(stressApi.backfillCardFingerprints).not.toHaveBeenCalled()
    await wrapper.get('.mobile-bottom-nav > button:first-child').trigger('click')
    await vi.waitFor(() => expect(stressApi.backfillCardFingerprints).toHaveBeenCalledTimes(1))
    expect(stressApi.upgradeLegacyJsonResources).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
  it('存储统计未返回时资源列表已就绪', async () => {
    let releaseStorage!: (value: object) => void
    vi.spyOn(navigator.storage, 'estimate').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStorage = resolve
        }),
    )
    stressApi.summaries = createStressSummaries(24)
    const wrapper = shallowMount(App, { props: { accountLabel: '启动等待回归' } })
    await vi.waitFor(() => expect(wrapper.findAll('resource-card-stub')).toHaveLength(24))
    await vi.waitFor(() => expect(navigator.storage.estimate).toHaveBeenCalledTimes(1))
    expect(JSON.parse(sessionStorage.getItem('srl.startup.state.v1') ?? '{}').pending).toBe(false)
    await wrapper.get('.mobile-bottom-nav > button:nth-child(2)').trigger('click')
    releaseStorage({ usage: 0, quota: 1000000 })
    wrapper.unmount()
  })
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    stressApi.vaultInitialization = undefined
    stressApi.summaries = []
    stressApi.repairThumbnailAssets.mockResolvedValue(0)
    stressApi.upgradeLegacyJsonResources.mockResolvedValue(0)
    stressApi.backfillCardFingerprints.mockResolvedValue(0)
    stressApi.initializeVaultOnce.mockResolvedValue({ enabled: false, locked: false })
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ usage: 0, quota: 1_000_000_000 })),
        persisted: vi.fn(async () => false),
      },
    })
  })

  it('功能页打开全局导入时保持资源库失活并打开真实导入对话框，关闭后释放遮罩状态', async () => {
    const wrapper = shallowMount(App, { props: { accountLabel: '导入入口回归' } })
    await vi.waitFor(() => expect(stressApi.backfillCardFingerprints).toHaveBeenCalled())
    await wrapper.get('.mobile-bottom-nav > button:nth-child(2)').trigger('click')
    expect(wrapper.find('.library').exists()).toBe(true)
    expect(wrapper.find('.library').attributes('inert')).toBeDefined()
    expect(wrapper.find('.library').attributes('aria-hidden')).toBe('true')
    await wrapper.get('.mobile-bottom-nav__import').trigger('click')
    expect(wrapper.find('.library').exists()).toBe(true)
    await vi.waitFor(() =>
      expect(wrapper.find('[role="dialog"][aria-label="选择导入方式"]').exists()).toBe(true),
    )
    expect(wrapper.get('[role="dialog"][aria-label="选择导入方式"]').isVisible()).toBe(true)
    expect(document.body.classList.contains('modal-open')).toBe(true)
    await wrapper.get('.import-choice-card--link').trigger('click')
    expect(wrapper.get('[role="dialog"][aria-label="链接导入"]').isVisible()).toBe(true)
    await wrapper.get('[aria-label="返回导入方式"]').trigger('click')
    expect(wrapper.get('[role="dialog"][aria-label="选择导入方式"]').isVisible()).toBe(true)
    const resourceRoot = wrapper
      .findAll('.import-choice-card')
      .find(
        (button) => button.text().includes('本地文件') && button.text().includes('单个资源文件'),
      )
    expect(resourceRoot).toBeDefined()
    await resourceRoot!.trigger('click')
    expect(wrapper.text()).toContain('单个资源文件')
    expect(wrapper.text()).toContain('资源合集压缩包')
    expect(wrapper.text()).not.toContain('酒馆备份')
    await wrapper.get('[aria-label="返回导入方式"]').trigger('click')
    const backupRoot = wrapper
      .findAll('.import-choice-card')
      .find((button) => button.text().includes('备份文件'))
    await backupRoot!.trigger('click')
    expect(wrapper.text()).toContain('资源库备份')
    expect(wrapper.text()).toContain('酒馆备份')
    await wrapper.get('[aria-label="返回导入方式"]').trigger('click')
    const otherRoot = wrapper
      .findAll('.import-choice-card')
      .find((button) => button.text().includes('个人资料'))
    await otherRoot!.trigger('click')
    expect(wrapper.text()).toContain('添加番外指令')
    expect(wrapper.text()).toContain('收纳小手机')
    expect(wrapper.text()).toContain('保存密钥资料')
    await wrapper.get('[aria-label="关闭导入"]').trigger('click')
    expect(wrapper.find('.import-choice-overlay').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    wrapper.unmount()
  })

  it('由功能 APP 状态控制底栏真实挂载和占位，并在退出功能页后恢复', async () => {
    const wrapper = shallowMount(App, {
      props: { accountLabel: '底栏 Owner 回归' },
      global: {
        stubs: {
          FeatureHub: {
            name: 'FeatureHub',
            emits: ['feature-app-active', 'close'],
            template: '<section />',
          },
        },
      },
    })
    try {
      await vi.waitFor(() => expect(stressApi.backfillCardFingerprints).toHaveBeenCalled())
      expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(true)
      localStorage.setItem(
        'srl.appResume.v1',
        JSON.stringify({ feature: 'featureHub', subpage: 'extensions', savedAt: 1 }),
      )
      await wrapper.get('.mobile-bottom-nav > button:nth-child(2)').trigger('click')
      expect(JSON.parse(localStorage.getItem('srl.appResume.v1') ?? '{}')).toMatchObject({
        feature: 'featureHub',
        subpage: 'home',
      })
      const hub = wrapper.getComponent({ name: 'FeatureHub' })
      for (const active of [true, false, true, false]) {
        hub.vm.$emit('feature-app-active', active)
        await nextTick()
        expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(!active)
        expect(
          (wrapper.element as HTMLElement).style.getPropertyValue('--bottom-nav-reserved'),
        ).toBe(active ? '0px' : '')
      }
      hub.vm.$emit('feature-app-active', true)
      await nextTick()
      hub.vm.$emit('close')
      await nextTick()
      expect(wrapper.find('.library').exists()).toBe(true)
      expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(true)
      expect((wrapper.element as HTMLElement).style.getPropertyValue('--bottom-nav-reserved')).toBe(
        '',
      )
      await wrapper.get('.mobile-bottom-nav > button:nth-child(2)').trigger('click')
      expect(wrapper.find('.mobile-bottom-nav').exists()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('先显示轻量资源索引，再执行不阻塞首屏的存量维护', async () => {
    stressApi.summaries = createStressSummaries(500)
    let resolveUpgrade!: (count: number) => void
    stressApi.upgradeLegacyJsonResources.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveUpgrade = resolve
        }),
    )

    const wrapper = shallowMount(App, {
      props: { accountLabel: '启动顺序回归' },
    })

    await vi.waitFor(() => expect(wrapper.get('.toolbar__result').text()).toContain('500'))
    // The library lifecycle and Discord inbox both request the shared cached initialization promise.
    expect(stressApi.initializeVaultOnce).toHaveBeenCalled()
    await vi.waitFor(() => expect(stressApi.upgradeLegacyJsonResources).toHaveBeenCalledOnce())
    expect(stressApi.backfillCardFingerprints).not.toHaveBeenCalled()

    resolveUpgrade(0)
    await vi.waitFor(() => expect(stressApi.backfillCardFingerprints).toHaveBeenCalledOnce())
    wrapper.unmount()
  })

  afterAll(async () => {
    const evidencePath = process.env.SRL_STRESS_EVIDENCE_PATH
    if (!evidencePath) return
    await mkdir(path.dirname(evidencePath), { recursive: true })
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          environment: 'Vitest + jsdom，浅挂载真实 App 资源筛选/排序/分页计算',
          thresholds: {
            initialRenderMs: 2_500,
            filterSortP95Ms: 300,
            maxInteractionMs: 200,
          },
          metrics: stressMetrics,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  })

  it.each([500, 1_000, 3_000])(
    '%i 条轻量索引只渲染当前页，且筛选/排序 p95 不超过预算',
    async (count) => {
      stressApi.summaries = createStressSummaries(count)
      const startedAt = performance.now()
      const wrapper = shallowMount(App, {
        props: { accountLabel: '压力测试' },
      })

      await vi.waitFor(() =>
        expect(wrapper.get('.toolbar__result').text()).toContain(String(count)),
      )
      const initialRenderMs = performance.now() - startedAt
      expect(initialRenderMs).toBeLessThan(2_500)
      expect(wrapper.findAll('resource-card-stub')).toHaveLength(24)
      expect(stressApi.get).not.toHaveBeenCalled()

      const search = wrapper.get('input[type="search"]')
      const searchDurations: number[] = []
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const target = (iteration * 37) % count
        const searchStartedAt = performance.now()
        await search.setValue(`压力资源 ${String(target).padStart(5, '0')}`)
        await nextTick()
        searchDurations.push(performance.now() - searchStartedAt)
        expect(wrapper.get('.toolbar__result').text()).toContain('1 项')
      }
      expect(wrapper.findAll('resource-card-stub')).toHaveLength(1)

      await search.setValue('')
      const sort = wrapper.get('select[aria-label="资源排序"]')
      const sortDurations: number[] = []
      const sortValues = ['name', 'size', 'newest'] as const
      for (let iteration = 0; iteration < 18; iteration += 1) {
        const value = sortValues[iteration % sortValues.length]!
        const sortStartedAt = performance.now()
        await sort.setValue(value)
        await nextTick()
        sortDurations.push(performance.now() - sortStartedAt)
        expect((sort.element as HTMLSelectElement).value).toBe(value)
      }

      const searchP95Ms = percentile95(searchDurations)
      const sortP95Ms = percentile95(sortDurations)
      const maxInteractionMs = Math.max(...searchDurations, ...sortDurations)
      expect(searchP95Ms).toBeLessThanOrEqual(300)
      expect(sortP95Ms).toBeLessThanOrEqual(300)
      expect(maxInteractionMs).toBeLessThanOrEqual(200)
      expect(stressApi.get).not.toHaveBeenCalled()

      await wrapper.get('select[aria-label="每页资源数量"]').setValue(96)
      await vi.waitFor(() => expect(wrapper.findAll('resource-card-stub')).toHaveLength(96))
      const pageInput = wrapper.get('input[aria-label="跳转到资源页"]')
      expect((pageInput.element as HTMLInputElement).value).toBe('1')

      const nextButton = wrapper
        .get('.pagination')
        .findAll('button')
        .find((button) => button.text() === '下一页')!
      await nextButton.trigger('click')
      expect((pageInput.element as HTMLInputElement).value).toBe('2')
      expect(wrapper.findAll('resource-card-stub')).toHaveLength(Math.min(96, count - 96))

      await pageInput.setValue('4')
      expect((pageInput.element as HTMLInputElement).value).toBe('4')
      expect(wrapper.findAll('resource-card-stub')).toHaveLength(96)

      stressMetrics.push({
        count,
        initialRenderMs: rounded(initialRenderMs),
        searchP95Ms: rounded(searchP95Ms),
        sortP95Ms: rounded(sortP95Ms),
        maxInteractionMs: rounded(maxInteractionMs),
        renderedCards: 24,
        originalBlobReads: stressApi.get.mock.calls.length,
      })
      wrapper.unmount()
    },
  )
})
