/** @vitest-environment jsdom */
import { flushPromises, mount, enableAutoUnmount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  native: false,
  configured: false,
  unlocked: false,
  setPassword: vi.fn(),
  unlock: vi.fn(),
  lock: vi.fn(),
  enableRecovery: vi.fn(),
  recoverPassword: vi.fn(),
  recovery: vi.fn(),
  clearRecovery: vi.fn(),
}))
vi.mock('../services/SecretResourceService', () => ({
  secretResourceService: {
    hasPassword: async () => state.configured,
    isUnlocked: () => state.unlocked,
    setPassword: state.setPassword,
    unlock: state.unlock,
    lock: state.lock,
    enableRecovery: state.enableRecovery,
    recoverPassword: state.recoverPassword,
  },
}))
vi.mock('../core/NativeSecurity', () => ({
  isNativeSecurityAvailable: () => state.native,
  getNativeSecretRecoveryState: state.recovery,
  clearNativeSecretRecovery: state.clearRecovery,
}))
import SecretProtectionSettings from './SecretProtectionSettings.vue'
enableAutoUnmount(afterEach)
beforeEach(() => {
  vi.resetAllMocks()
  state.native = false
  state.configured = false
  state.unlocked = false
  state.setPassword.mockImplementation(async () => {
    state.configured = true
    state.unlocked = true
  })
})
function button(w: ReturnType<typeof mount>, label: string) {
  return w.findAll('button').find((b) => b.text() === label)!
}
it('opens the existing password form immediately for task unlock and emits readiness only after success', async () => {
  const w = mount(SecretProtectionSettings, { props: { unlockOnly: true } })
  await flushPromises()
  expect(w.findAll('input')).toHaveLength(2)
  expect(w.emitted('ready')).toBeUndefined()
  await w.findAll('input')[0]!.setValue('shared-password')
  await w.findAll('input')[1]!.setValue('shared-password')
  await w.find('form').trigger('submit')
  await flushPromises()
  expect(state.setPassword).toHaveBeenCalledWith('shared-password')
  expect(w.emitted('ready')).toHaveLength(1)
  expect(w.findAll('input')).toHaveLength(0)
})
it('sets the shared password only after matching confirmation and clears the form on success', async () => {
  const w = mount(SecretProtectionSettings)
  await flushPromises()
  await button(w, '设置统一密码').trigger('click')
  const inputs = w.findAll('input')
  await inputs[0]!.setValue('shared-password')
  await inputs[1]!.setValue('other-password')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(state.setPassword).not.toHaveBeenCalled()
  expect(w.text()).toContain('两次密码不一致')
  await inputs[1]!.setValue('shared-password')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(state.setPassword).toHaveBeenCalledWith('shared-password')
  expect(w.find('form').exists()).toBe(false)
  expect(button(w, '锁定统一密码')).toBeDefined()
  expect(button(w, '忘记密码？指纹找回')).toBeUndefined()
  expect(state.recovery).not.toHaveBeenCalled()
})
it('does not reset an existing password and shows recovered values only after a successful native result', async () => {
  state.native = true
  state.configured = true
  state.recovery.mockResolvedValue({ available: true, enabled: true })
  const w = mount(SecretProtectionSettings)
  await flushPromises()
  expect(button(w, '设置统一密码')).toBeUndefined()
  state.recoverPassword.mockRejectedValueOnce(new Error('指纹取消'))
  await button(w, '忘记密码？指纹找回').trigger('click')
  await flushPromises()
  expect(w.find('input[readonly]').exists()).toBe(false)
  expect(state.setPassword).not.toHaveBeenCalled()
  state.recoverPassword.mockImplementation(async () => {
    state.unlocked = true
    return 'recovered-password'
  })
  await button(w, '忘记密码？指纹找回').trigger('click')
  await flushPromises()
  expect((w.get('input[readonly]').element as HTMLInputElement).value).toBe('recovered-password')
  await button(w, '锁定统一密码').trigger('click')
  expect(state.lock).toHaveBeenCalled()
  expect(w.find('input[readonly]').exists()).toBe(false)
})
it('does not offer unavailable recovery methods on older APKs', async () => {
  state.native = true
  state.configured = true
  state.recovery.mockRejectedValue(new Error('not implemented'))
  const w = mount(SecretProtectionSettings)
  await flushPromises()
  expect(w.text()).toContain('请更新 APK')
  expect(button(w, '忘记密码？指纹找回')).toBeUndefined()
})

it('does not advertise an incomplete native recovery record as usable', async () => {
  state.native = true
  state.configured = true
  state.recovery.mockResolvedValue({ available: true, enabled: false, status: 'invalid' })
  const w = mount(SecretProtectionSettings)
  await flushPromises()
  expect(w.text()).toContain('恢复记录不完整')
  expect(button(w, '忘记密码？指纹找回')).toBeUndefined()
  expect(button(w, '开启指纹找回')).toBeDefined()
  expect(state.clearRecovery).not.toHaveBeenCalled()
  expect(state.setPassword).not.toHaveBeenCalled()
})
