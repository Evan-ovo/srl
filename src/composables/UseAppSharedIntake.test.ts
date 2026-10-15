/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useApp } from './UseApp'
import { taskCenter } from '../core/TaskCenter'
import type { SharedFileBatch } from '../utils/ShareTargetIntake'

const lifecycle = vi.hoisted(() => ({
  context: undefined as unknown,
  consume: vi.fn(async () => undefined),
}))
vi.mock('./UseLibraryLifecycle', () => ({
  useLibraryLifecycle: (context: unknown) => {
    lifecycle.context = context
    return { scheduleLibraryMaintenance: vi.fn(), consumeSharedFiles: lifecycle.consume }
  },
}))
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }))

const shareTokens = [
  'discord-url-11111111-1111-1111-1111-111111111111',
  'discord-url-22222222-2222-2222-2222-222222222222',
]
afterEach(() => {
  for (const task of taskCenter.list()) {
    if (!task.operationId.startsWith('native-download:')) continue
    taskCenter.complete(task.operationId)
    taskCenter.dismiss(task.operationId)
  }
  lifecycle.consume.mockClear()
})

function mountApp() {
  let app!: ReturnType<typeof useApp>
  const wrapper = mount(
    defineComponent({
      setup() {
        app = useApp()
        return () => null
      },
    }),
  )
  const context = lifecycle.context as Parameters<
    typeof import('./UseLibraryLifecycle').useLibraryLifecycle
  >[0]
  function download(phase: string, token: string, workId: string) {
    return context.handleNativeDownloadState?.(
      new CustomEvent('srl:native-share-download-' + phase, {
        detail: { token, workId, name: '测试附件.json' },
      }),
    )
  }
  return { app, wrapper, context, download }
}

it('releases the real share importer after an unsupported file so a queued character card is imported', async () => {
  const { app, wrapper, context } = mountApp()
  const failed = vi.fn(async () => undefined)
  const imported = vi.fn(async () => undefined)
  const taskIds = ['web-failure-share', 'web-success-share']
  try {
    context.receiveSharedFileBatch({
      files: [new File(['not-card'], 'unsupported.pdf')],
      recoveryId: taskIds[0],
      route: 'resource',
      automaticCloud: true,
      onFailure: failed,
      acknowledge: async () => undefined,
    })
    context.receiveSharedFileBatch({
      files: [
        new File(
          [
            JSON.stringify({
              spec: 'chara_card_v2',
              spec_version: '2.0',
              data: {
                name: 'Queued card after unsupported file',
                description: 'fixture',
                first_mes: 'Hello',
                extensions: {},
              },
            }),
          ],
          'queued-card.json',
          { type: 'application/json' },
        ),
      ],
      recoveryId: taskIds[1],
      route: 'resource',
      automaticCloud: true,
      acknowledge: imported,
    })
    await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce(), { timeout: 5000 })
    expect(failed).toHaveBeenCalledOnce()
    expect(app.isBusy.value).toBe(false)
    expect(app.pendingSharedFileBatch.value).toBeUndefined()
  } finally {
    wrapper.unmount()
  }
})

it('retains a paused web inbox batch without blocking unrelated shares and resumes only explicitly', async () => {
  const { app, wrapper, context } = mountApp()
  try {
    let allowed = false
    const paused: SharedFileBatch = {
      files: [new File(['{}'], 'paused.json')],
      canProcess: () => allowed,
      acknowledge: async () => undefined,
    }
    context.receiveSharedFileBatch(paused)
    expect(app.pendingSharedFileBatch.value).toBeUndefined()
    const other: SharedFileBatch = {
      files: [new File(['{}'], 'other.json')],
      acknowledge: async () => undefined,
    }
    context.receiveSharedFileBatch(other)
    expect(app.pendingSharedFileBatch.value).toBe(other)
    app.pendingSharedFileBatch.value = undefined
    await nextTick()
    window.dispatchEvent(new Event('srl:web-inbox-state'))
    expect(app.pendingSharedFileBatch.value).toBeUndefined()
    allowed = true
    window.dispatchEvent(new Event('srl:web-inbox-state'))
    expect(app.pendingSharedFileBatch.value).toBe(paused)
  } finally {
    wrapper.unmount()
  }
})

it('cloud download events do not create a second generic share task or disturb the active import', () => {
  const { app, wrapper, context } = mountApp()
  try {
    const current = batch(shareTokens[1]!)
    app.pendingSharedFileBatch.value = current
    for (const phase of ['started', 'completed', 'failed'])
      context.handleNativeDownloadState?.(
        new CustomEvent('srl:native-share-download-' + phase, {
          detail: { token: shareTokens[0], workId: 'cloud-work', name: 'cloud.json', cloud: true },
        }),
      )
    expect(
      taskCenter.list().some((task) => task.operationId === 'native-download:' + shareTokens[0]),
    ).toBe(false)
    expect(app.pendingSharedFileBatch.value).toBe(current)
  } finally {
    wrapper.unmount()
  }
})

it('native retry clears only its old error while stale receipts cannot poison the new attempt', () => {
  const { app, wrapper, download } = mountApp()
  try {
    app.pendingSharedFileBatch.value = batch(shareTokens[0]!)
    app.pendingSharedFileBatch.value.discordAttachment!.error = 'old failure'
    app.isImportChooserOpen.value = true
    download('started', shareTokens[0]!, 'old-work')
    download('failed', shareTokens[0]!, 'old-work')
    app.pendingSharedFileBatch.value = batch(shareTokens[0]!)
    download('started', shareTokens[0]!, 'new-work')
    expect(app.pendingSharedFileBatch.value).toBeUndefined()
    expect(app.isImportChooserOpen.value).toBe(false)
    expect(download('failed', shareTokens[0]!, 'old-work')).toBe(false)
    expect(taskCenter.active()).toHaveLength(1)
    download('completed', shareTokens[0]!, 'new-work')
    download('started', shareTokens[0]!, 'new-work')
    expect(taskCenter.list()[0]?.status).toBe('completed')
  } finally {
    wrapper.unmount()
  }
})

it('independent downloads preserve the active import and notification actions cannot switch it', async () => {
  const { app, wrapper, download } = mountApp()
  try {
    const active = batch(shareTokens[0]!)
    app.pendingSharedFileBatch.value = active
    app.isImportChooserOpen.value = true
    download('started', shareTokens[1]!, 'second-work')
    download('completed', shareTokens[1]!, 'second-work')
    await taskCenter.open('native-download:' + shareTokens[1])
    expect(app.pendingSharedFileBatch.value).toBe(active)
    expect(app.isImportChooserOpen.value).toBe(true)
    app.isBusy.value = true
    await taskCenter.open('native-download:' + shareTokens[1])
    expect(lifecycle.consume).toHaveBeenCalledTimes(1)
    expect(app.pendingSharedFileBatch.value).toBe(active)
  } finally {
    wrapper.unmount()
  }
})

function batch(
  token: string,
  acknowledge: SharedFileBatch['acknowledge'] = async () => undefined,
): SharedFileBatch {
  return {
    files: [],
    acknowledge,
    discordAttachment: {
      name: 'card.json',
      type: 'application/json',
      cleanupToken: token,
      discordUrl: 'https://cdn.discordapp.com/attachments/1/2/card.json',
    },
  }
}

it('a new share needing a choice opens above the feature desktop', () => {
  const { app, wrapper, context } = mountApp()
  try {
    app.isFeatureHubOpen.value = true
    context.receiveSharedFileBatch({
      files: [new File(['{}'], 'shared.json')],
      acknowledge: async () => undefined,
    })
    expect(app.isFeatureHubOpen.value).toBe(false)
    expect(app.isImportChooserOpen.value).toBe(true)
    expect(app.pendingSharedFileBatch.value?.files[0]?.name).toBe('shared.json')
  } finally {
    wrapper.unmount()
  }
})

describe('shared Discord intake callbacks', () => {
  it('keeps the next share open when an earlier repeated cancel finishes late', async () => {
    let app!: ReturnType<typeof useApp>
    const wrapper = mount(
      defineComponent({
        setup() {
          app = useApp()
          return () => null
        },
      }),
    )
    try {
      const completions: Array<() => void> = []
      const previous = batch(
        'discord-url-previous',
        () => new Promise<void>((resolve) => completions.push(resolve)),
      )
      app.pendingSharedFileBatch.value = previous
      app.isImportChooserOpen.value = true
      const first = app.cancelSharedDiscordAttachment()
      const repeated = app.cancelSharedDiscordAttachment()
      completions[0]!()
      await first
      expect(app.pendingSharedFileBatch.value).toBeUndefined()
      await nextTick()

      const incoming = batch('discord-url-next')
      app.pendingSharedFileBatch.value = incoming
      app.isImportChooserOpen.value = true
      completions[1]!()
      await repeated

      expect(app.pendingSharedFileBatch.value).toBe(incoming)
      expect(app.isImportChooserOpen.value).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
})
