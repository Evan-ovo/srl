/** @vitest-environment jsdom */
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assistantPetCue, publishAssistantPetCue } from '../core/ProductAssistantPetState'
import { assistantGuidanceAnchor, setAssistantHelpSurface } from '../core/ProductAssistantGuidance'
import { discordSetupSession, nativeDiscordSetupBrowser } from '../services/AssistantBrowserRuntime'
const { petWorkspace, confirmPetAssets, loadPetAssets, downloadPetAssets, releasePetAssets } =
  vi.hoisted(() => ({
    petWorkspace: {
      preferences: vi.fn(() => ({ desktopPet: true })),
      savePreferences: vi.fn(async (value: unknown) => value),
    },
    confirmPetAssets: vi.fn(),
    loadPetAssets: vi.fn(),
    downloadPetAssets: vi.fn(),
    releasePetAssets: vi.fn(),
  }))
vi.mock('../core/AppContainer', () => ({
  productAssistantWorkspaceService: petWorkspace,
  discordSetupService: {
    returnToBrowser: vi.fn(async () => {
      discordSetupSession.browserVisible = true
    }),
  },
}))
vi.mock('./DiscordSetupHelp.vue', () => ({
  default: { props: ['open'], template: '<div v-if="open" class="help-wizard">配置选择</div>' },
}))
vi.mock('../services/AssistantBrowserRuntime', async () => {
  const { reactive } = await import('vue')
  return {
    hasDiscordSetupBrowser: () => true,
    discordSetupSession: reactive({ active: false, browserVisible: false }),
    nativeDiscordSetupBrowser: { pet: vi.fn(), chatPresentation: vi.fn(async () => {}) },
  }
})
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: confirmPetAssets }))
vi.mock('../services/ProductAssistantPetAssets', () => ({
  downloadAssistantPetAssets: downloadPetAssets,
  loadAssistantPetAssets: loadPetAssets,
  releaseAssistantPetAssets: releasePetAssets,
}))
vi.mock('../composables/UseProductAssistantPreferences', () => ({
  useProductAssistantPreferences: () => preferences,
}))
vi.mock('./AppearanceStudio.vue', () => ({
  default: {
    name: 'AppearanceStudioStub',
    props: ['navigate', 'compact'],
    emits: ['assistant-activity', 'expand', 'back'],
    template: `<div :data-compact="compact"><button @click="navigate('inbox')">打开 Discord 配置</button><button @click="navigate('cloud', 'backup')">打开云备份并指路</button><button @click="$emit('expand')">切换全屏</button><button @click="$emit('back')">返回</button><button @click="$emit('assistant-activity', true)">开始生成</button><button @click="$emit('assistant-activity', false)">结束生成</button><slot name="task-preview" /></div>`,
  },
}))
import ProductAssistantPet from './ProductAssistantPet.vue'
const preferences = ref({
  name: '蒜惹菈',
  desktopPet: true,
  petAssetMode: 'svg' as 'images' | 'svg' | undefined,
  aiPetExpressions: false,
  petWalkingAnimation: true,
})
let wrapper: VueWrapper | undefined
let mediaChanged: (() => void) | undefined
let reduced = false
const addMediaListener = vi.fn((_event: string, listener: () => void) => {
  mediaChanged = listener
})
const removeMediaListener = vi.fn()
beforeEach(() => {
  discordSetupSession.active = false
  discordSetupSession.assistantConversationId = ''
  discordSetupSession.browserVisible = false
  discordSetupSession.webStepActive = false
  discordSetupSession.agentRunning = false
  preferences.value = {
    name: '蒜惹菈',
    desktopPet: true,
    petAssetMode: 'svg',
    aiPetExpressions: false,
    petWalkingAnimation: true,
  }
  petWorkspace.preferences.mockReturnValue({ desktopPet: true })
  petWorkspace.savePreferences.mockClear()
  confirmPetAssets.mockReset().mockResolvedValue(false)
  loadPetAssets.mockReset().mockResolvedValue(undefined)
  downloadPetAssets.mockReset().mockResolvedValue(undefined)
  releasePetAssets.mockReset()
  assistantPetCue.value = undefined
  assistantGuidanceAnchor.value = undefined
  reduced = false
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced
    },
    addEventListener: addMediaListener,
    removeEventListener: removeMediaListener,
  }))
  HTMLDialogElement.prototype.show = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.clearAllMocks()
})
function renderPet() {
  wrapper = mount(ProductAssistantPet, {
    attachTo: document.body,
    props: {
      theme: 'light',
      layoutMode: 'grid',
      uiFontScale: 'standard',
      customCss: '',
      navigate: vi.fn().mockResolvedValue(undefined),
    },
  })
  return document.querySelector<HTMLButtonElement>('.assistant-pet')!
}
it('reuses the existing compact pet dialog for browser chat and closes it when returning to the browser', async () => {
  discordSetupSession.active = true
  discordSetupSession.assistantConversationId = 'setup-chat'
  discordSetupSession.browserVisible = false
  renderPet()
  try {
    window.dispatchEvent(new Event('srl:discord-setup-quick-chat'))
    await flushPromises()
    const dialog = document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('[data-compact="true"]')).not.toBeNull()
    discordSetupSession.browserVisible = true
    await flushPromises()
    expect(dialog.open).toBe(false)
  } finally {
    discordSetupSession.active = false
    discordSetupSession.assistantConversationId = ''
    discordSetupSession.browserVisible = false
  }
})
it('rests and walks only while idle, pauses for chat and shows actual generation activity', async () => {
  vi.useFakeTimers()
  const pet = renderPet()
  expect(pet.dataset.pose).toBe('idle')
  await vi.advanceTimersByTimeAsync(10000)
  expect(pet.dataset.pose).toBe('walk')
  expect(pet.classList.contains('assistant-pet--walk')).toBe(true)
  expect(pet.querySelector('.assistant-pet-run')).toBeNull()
  expect(pet.querySelector('.assistant-pet-orb')).not.toBeNull()
  expect(pet.querySelector('img')).toBeNull()
  await vi.advanceTimersByTimeAsync(24000)
  expect(pet.dataset.pose).toBe('sleep')
  pet.click()
  await flushPromises()
  expect(pet.dataset.pose).toBe('chat')
  expect(pet.classList.contains('assistant-pet--walk')).toBe(false)
  const action = (text: string) =>
    Array.from(document.querySelectorAll('button'))
      .find((el) => el.textContent === text)!
      .click()
  action('开始生成')
  await flushPromises()
  expect(pet.dataset.pose).toBe('thinking')
  action('结束生成')
  await flushPromises()
  expect(pet.dataset.pose).toBe('chat')
  await vi.advanceTimersByTimeAsync(60000)
  expect(pet.dataset.pose).toBe('chat')
  wrapper!.unmount()
  wrapper = undefined
  expect(vi.getTimerCount()).toBe(0)
  expect(removeMediaListener).toHaveBeenCalledWith('change', mediaChanged)
})
it('offers contextual help after three taps and opens the route chooser only on yes', async () => {
  const owner = Symbol('tutorial')
  const tutorial = document.createElement('section')
  tutorial.dataset.assistantHelpContext = 'discord-bridge'
  document.body.append(tutorial)
  vi.spyOn(tutorial, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 320, 500),
  ] as unknown as DOMRectList)
  setAssistantHelpSurface(owner, 'discord-bridge')
  try {
    const pet = renderPet()
    const tap = async () => {
      pet.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
      await flushPromises()
    }
    await tap()
    await tap()
    expect(document.querySelector('.assistant-pet-dialog')).toBeNull()
    expect(document.querySelector('.assistant-pet-help-question')).toBeNull()
    await tap()
    expect(document.querySelector('.assistant-pet-help-question')?.textContent).toContain(
      '需要我的帮助嘛？',
    )
    Array.from(document.querySelectorAll('.assistant-pet-help-question button'))
      .find((button) => button.textContent === '不是')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.help-wizard')).toBeNull()
    await tap()
    await tap()
    await tap()
    Array.from(document.querySelectorAll('.assistant-pet-help-question button'))
      .find((button) => button.textContent === '是')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.help-wizard')).not.toBeNull()
    setAssistantHelpSurface(owner)
    await flushPromises()
    expect(document.querySelector('.help-wizard')).toBeNull()
  } finally {
    setAssistantHelpSurface(owner)
  }
})
it('keeps the operation pet hidden in full chat instead of overriding its visibility', async () => {
  const pet = renderPet()
  await wrapper!.setProps({ hidden: true })
  expect(pet.style.display).toBe('none')
  discordSetupSession.active = true
  await flushPromises()
  expect(pet.style.display).toBe('none')
  expect(pet.classList.contains('assistant-pet--assistance')).toBe(true)
})
it('mounts the task chat in the background, expands the same instance with a webpage preview and returns without pausing', async () => {
  discordSetupSession.active = true
  discordSetupSession.assistantConversationId = 'task-preview'
  discordSetupSession.webStepActive = true
  discordSetupSession.agentRunning = true
  const pet = renderPet()
  await flushPromises()
  const studio = wrapper!.findComponent({ name: 'AppearanceStudioStub' })
  const instance = studio.vm
  const dialog = document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!
  expect(dialog.open).toBe(false)
  expect(studio.attributes('background-task')).toBe('true')
  window.dispatchEvent(new Event('srl:discord-setup-quick-chat'))
  await flushPromises()
  expect(dialog.open).toBe(true)
  expect(vi.mocked(nativeDiscordSetupBrowser.chatPresentation!)).toHaveBeenLastCalledWith({
    mode: 'compact',
    conversationId: 'task-preview',
  })
  expect(document.querySelector('.assistant-browser-preview')).toBeNull()
  expect(pet.style.display).not.toBe('none')
  await studio.vm.$emit('expand')
  await flushPromises()
  expect(studio.vm).toBe(instance)
  expect(pet.style.display).toBe('none')
  expect(vi.mocked(nativeDiscordSetupBrowser.chatPresentation!)).toHaveBeenLastCalledWith(
    expect.objectContaining({
      mode: 'fullscreen',
      conversationId: 'task-preview',
      bounds: expect.objectContaining({ viewportWidth: innerWidth }),
    }),
  )
  expect(discordSetupSession.agentRunning).toBe(true)
  document.querySelector<HTMLButtonElement>('.assistant-browser-preview')!.click()
  await flushPromises()
  expect(dialog.open).toBe(false)
  expect(discordSetupSession.browserVisible).toBe(true)
  expect(discordSetupSession.agentRunning).toBe(true)
  expect(document.documentElement.dataset.assistantBrowserChat).toBeUndefined()
})
it('stops idle timers when reduced motion or page visibility changes, and wakes without timer duplication', async () => {
  vi.useFakeTimers()
  const pet = renderPet()
  await vi.advanceTimersByTimeAsync(10000)
  reduced = true
  mediaChanged!()
  await flushPromises()
  expect(pet.dataset.pose).toBe('idle')
  expect(pet.querySelector('.assistant-pet-run')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  reduced = false
  mediaChanged!()
  expect(vi.getTimerCount()).toBe(1)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(vi.getTimerCount()).toBe(0)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(10000)
  expect(pet.dataset.pose).toBe('walk')
})
it('keeps the quick chat open while navigating to Discord setup', async () => {
  const navigate = vi.fn().mockResolvedValue(undefined)
  const wrapper = mount(ProductAssistantPet, {
    attachTo: document.body,
    props: { theme: 'light', layoutMode: 'grid', uiFontScale: 'standard', customCss: '', navigate },
  })
  try {
    document.querySelector<HTMLButtonElement>('.assistant-pet')!.click()
    await flushPromises()
    const button = Array.from(document.querySelectorAll('button')).find(
      (el) => el.textContent === '打开 Discord 配置',
    )!
    expect(button).toBeDefined()
    button.click()
    await flushPromises()
    expect(navigate).toHaveBeenCalledWith('inbox')
    expect(document.querySelector('.assistant-pet-dialog')?.hasAttribute('open')).toBe(true)
  } finally {
    wrapper.unmount()
  }
})
it('expands and collapses the same chat window without opening a second assistant', async () => {
  const pet = renderPet()
  pet.click()
  await flushPromises()
  const dialog = document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!
  const studio = wrapper!.findComponent({ name: 'AppearanceStudioStub' })
  expect(dialog.style.width).toBe('300px')
  expect(studio.attributes('data-compact')).toBe('true')

  Array.from(dialog.querySelectorAll('button'))
    .find((button) => button.textContent === '切换全屏')!
    .click()
  await flushPromises()
  expect(document.querySelector('.assistant-pet-dialog')).toBe(dialog)
  expect(dialog.style.left).toBe('0px')
  expect(dialog.style.top).toBe('0px')
  expect(dialog.style.width).toBe(`${innerWidth}px`)
  expect(dialog.style.height).toBe(`${innerHeight}px`)
  expect(studio.attributes('data-compact')).toBe('false')
  expect(wrapper!.findComponent({ name: 'AppearanceStudioStub' }).vm).toBe(studio.vm)

  Array.from(dialog.querySelectorAll('button'))
    .find((button) => button.textContent === '返回')!
    .click()
  await flushPromises()
  expect(dialog.hasAttribute('open')).toBe(true)
  expect(dialog.style.width).toBe('300px')
  expect(studio.attributes('data-compact')).toBe('true')
})
it('opens the existing assistant chat expanded when the feature hub requests the shared conversation', async () => {
  renderPet()
  try {
    await wrapper!.setProps({ openChatRequest: 1 })
    await flushPromises()

    const dialog = document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.classList.contains('assistant-pet-dialog--expanded')).toBe(true)
    expect(
      wrapper!.findComponent({ name: 'AppearanceStudioStub' }).attributes('data-compact'),
    ).toBe('false')
  } finally {
    wrapper!.unmount()
    wrapper = undefined
  }
})
it('keeps the active chat mounted after close and restores its activity on reopening', async () => {
  const pet = renderPet()
  pet.click()
  await flushPromises()
  const studio = wrapper!.findComponent({ name: 'AsyncComponentWrapper' })
  const chat = document.querySelector('.assistant-pet-dialog')!
  Array.from(chat.querySelectorAll('button'))
    .find((button) => button.textContent === '开始生成')!
    .click()
  await flushPromises()
  expect(pet.dataset.pose).toBe('thinking')
  await new DOMWrapper(chat).trigger('keydown', { key: 'Escape' })
  expect(chat.hasAttribute('open')).toBe(false)
  expect(pet.dataset.pose).toBe('thinking')
  pet.click()
  await flushPromises()
  expect(document.querySelector('.assistant-pet-dialog')).toBe(chat)
  expect(wrapper!.findComponent({ name: 'AsyncComponentWrapper' }).vm).toBe(studio.vm)
  expect(chat.hasAttribute('open')).toBe(true)
})
it('resizes with pointer deltas, bounds the window to the viewport and retains size after close', async () => {
  const pet = renderPet()
  pet.click()
  await flushPromises()
  const dialog = new DOMWrapper(document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!)
  const handle = new DOMWrapper(
    document.querySelector<HTMLButtonElement>('[aria-label="调整快捷对话大小"]')!,
  )
  expect(dialog.element.style.width).toBe('300px')
  expect(dialog.element.style.height).toBe('340px')
  const pointer = async (type: string, id: number, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: id })
    handle.element.dispatchEvent(event)
    await flushPromises()
  }
  await pointer('pointerdown', 4, 500, 400)
  await pointer('pointermove', 4, 460, 450)
  await pointer('pointerup', 4, 460, 450)
  expect(dialog.element.style.width).toBe('260px')
  expect(dialog.element.style.height).toBe('290px')
  await dialog.trigger('keydown', { key: 'Escape' })
  pet.click()
  await flushPromises()
  expect(dialog.element.style.width).toBe('260px')
  expect(dialog.element.style.height).toBe('290px')
  await pointer('pointerdown', 5, 0, 0)
  await pointer('pointermove', 5, 10000, 10000)
  expect(
    parseFloat(dialog.element.style.left) + parseFloat(dialog.element.style.width),
  ).toBeLessThanOrEqual(innerWidth - 8)
  expect(
    parseFloat(dialog.element.style.top) + parseFloat(dialog.element.style.height),
  ).toBeLessThanOrEqual(innerHeight - 8)
})
it('follows a dragged cat and limits enlargement to the free space beside it', async () => {
  const pet = renderPet()
  pet.click()
  await flushPromises()
  const dialog = document.querySelector<HTMLDialogElement>('.assistant-pet-dialog')!
  expect(document.querySelector('.assistant-pet-look')).toBeNull()
  const originalTop = dialog.style.top
  vi.spyOn(pet, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(parseFloat(pet.style.left), parseFloat(pet.style.top), 88, 88),
  )
  for (const [type, y] of [
    ['pointerdown', 600],
    ['pointermove', 400],
  ] as const) {
    const event = new MouseEvent(type, { button: 0, clientX: 40, clientY: y, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: 7 })
    pet.dispatchEvent(event)
    await flushPromises()
  }
  expect(dialog.style.top).not.toBe(originalTop)
  const handle = new DOMWrapper(
    document.querySelector<HTMLButtonElement>('[aria-label="调整快捷对话大小"]')!,
  )
  for (let index = 0; index < 60; index++) await handle.trigger('keydown', { key: 'ArrowDown' })
  const top = parseFloat(dialog.style.top)
  const bottom = top + parseFloat(dialog.style.height)
  const catTop = parseFloat(pet.style.top)
  expect(bottom <= catTop || top >= catTop + 88).toBe(true)
  expect(top).toBeGreaterThanOrEqual(8)
  expect(bottom).toBeLessThanOrEqual(innerHeight - 8)
})
it('opens with two taps but holding alone never opens chat', async () => {
  vi.useFakeTimers()
  const pet = renderPet()
  const pointer = (type: string) => {
    const event = new MouseEvent(type, { button: 0, clientX: 30, clientY: 30, bubbles: true })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    pet.dispatchEvent(event)
  }
  pointer('pointerdown')
  await flushPromises()
  expect(pet.dataset.pose).toBe('lifted')
  expect(pet.querySelector('.assistant-pet-orb')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  expect(document.querySelector('.assistant-pet-dialog')).toBeNull()
  pointer('pointerup')
  pet.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
  await flushPromises()
  expect(document.querySelector('.assistant-pet-dialog')).toBeNull()
  pet.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }))
  await flushPromises()
  expect(document.querySelector('.assistant-pet-dialog')).not.toBeNull()
})
it('asks before downloading pet pictures and remembers the light SVG choice', async () => {
  preferences.value.petAssetMode = undefined
  const pet = renderPet()
  await flushPromises()
  expect(confirmPetAssets).toHaveBeenCalledWith(
    expect.objectContaining({
      title: '蒜惹菈桌宠图片还没下载',
      confirmLabel: '下载桌宠图片',
      cancelLabel: '先用 SVG 悬浮球',
    }),
  )
  expect(pet.querySelector('.assistant-pet-orb')).not.toBeNull()
  expect(downloadPetAssets).not.toHaveBeenCalled()
  expect(petWorkspace.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ petAssetMode: 'svg' }),
  )
})
it('uses the local SVG during a browser task without hiding asset consent behind the native window', async () => {
  discordSetupSession.active = true
  preferences.value.petAssetMode = undefined
  const pet = renderPet()
  await flushPromises()
  expect(pet.querySelector('.assistant-pet-orb')).not.toBeNull()
  expect(confirmPetAssets).not.toHaveBeenCalled()
  expect(downloadPetAssets).not.toHaveBeenCalled()
  expect(petWorkspace.savePreferences).not.toHaveBeenCalled()
})
it('downloads only after the confirmation and switches to cached artwork', async () => {
  preferences.value.petAssetMode = undefined
  confirmPetAssets.mockResolvedValue(true)
  loadPetAssets
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ 'assistant-pet.png': 'blob:pet-idle' })
  petWorkspace.savePreferences.mockImplementation(async (value: unknown) => {
    preferences.value.petAssetMode = 'images'
    return value
  })
  const pet = renderPet()
  await flushPromises()
  expect(downloadPetAssets).toHaveBeenCalledOnce()
  expect(petWorkspace.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ petAssetMode: 'images' }),
  )
  await flushPromises()
  expect(pet.querySelector('img')?.getAttribute('src')).toBe('blob:pet-idle')
})
it('uses cached art after download and releases its object URLs when the pet closes', async () => {
  preferences.value.petAssetMode = 'images'
  loadPetAssets.mockResolvedValue({ 'assistant-pet.png': 'blob:pet-idle' })
  const pet = renderPet()
  await flushPromises()
  expect(pet.querySelector('img')?.getAttribute('src')).toBe('blob:pet-idle')
  wrapper!.unmount()
  wrapper = undefined
  expect(releasePetAssets).toHaveBeenCalledWith({ 'assistant-pet.png': 'blob:pet-idle' })
})
it('refreshes the running pet when settings finishes downloading its pictures', async () => {
  const pet = renderPet()
  await flushPromises()
  expect(pet.querySelector('img')).toBeNull()

  loadPetAssets.mockResolvedValue({ 'assistant-pet.png': 'blob:pet-new' })
  window.dispatchEvent(new Event('srl:assistant-pet-assets-updated'))
  await flushPromises()

  expect(pet.querySelector('img')?.getAttribute('src')).toBe('blob:pet-new')
})
it('disables autonomous walking through its setting but keeps the interaction pose and chat', async () => {
  vi.useFakeTimers()
  preferences.value.petWalkingAnimation = false
  const pet = renderPet()
  await vi.advanceTimersByTimeAsync(60000)
  expect(pet.dataset.pose).toBe('idle')
  expect(pet.querySelector('.assistant-pet-run')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  pet.click()
  await flushPromises()
  expect(pet.dataset.pose).toBe('chat')
})
it('uses AI expressions only while enabled, expires cues and releases timers on teardown', async () => {
  vi.useFakeTimers()
  const pet = renderPet()
  publishAssistantPetCue('我吗？', 'curious')
  await flushPromises()
  expect(pet.dataset.pose).toBe('idle')
  expect(document.querySelector('.assistant-pet-bubble')).toBeNull()
  preferences.value.aiPetExpressions = true
  publishAssistantPetCue('好香呀～', 'drool')
  await flushPromises()
  expect(pet.dataset.pose).toBe('drool')
  expect(document.querySelector('.assistant-pet-bubble')?.textContent).toBe('好香呀～')
  preferences.value.aiPetExpressions = false
  await flushPromises()
  expect(pet.dataset.pose).toBe('idle')
  preferences.value.aiPetExpressions = true
  publishAssistantPetCue('我吗？', 'curious')
  await flushPromises()
  await vi.advanceTimersByTimeAsync(8000)
  expect(pet.dataset.pose).toBe('idle')
  expect(document.querySelector('.assistant-pet-bubble')).toBeNull()
  wrapper!.unmount()
  wrapper = undefined
  expect(vi.getTimerCount()).toBe(0)
})
it('guides beside a real control in its native dialog without persisting automatic travel', async () => {
  reduced = true
  document.body.innerHTML = '<dialog open><button id="destination">目标功能</button></dialog>'
  const target = document.querySelector<HTMLButtonElement>('#destination')!
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(250, 200, 100, 44))
  const pet = renderPet()
  assistantGuidanceAnchor.value = { element: target, text: '资源搜索在这里哦～' }
  await flushPromises()
  expect(document.querySelector('dialog .assistant-pet')).toBe(pet)
  expect(pet.style.left).toBe('358px')
  expect(document.querySelector('.assistant-pet-bubble')?.textContent).toBe('资源搜索在这里哦～')
  expect(pet.dataset.pose).toBe('chat')
  assistantGuidanceAnchor.value = undefined
  await flushPromises()
  expect(pet.parentElement).toBe(document.body)
})
