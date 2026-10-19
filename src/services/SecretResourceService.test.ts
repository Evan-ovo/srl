import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SecretResourceService } from './SecretResourceService'
import type { PersonalResourceDocument } from '../types/PersonalResource'
const native = vi.hoisted(() => ({ available: true, save: vi.fn(), recover: vi.fn() }))
vi.mock('../core/NativeSecurity', () => ({
  isNativeSecurityAvailable: () => native.available,
  saveNativeSecretRecovery: native.save,
  recoverNativeSecretPassword: native.recover,
}))
beforeEach(() => {
  native.available = true
  vi.resetAllMocks()
})
function setup() {
  const values = new Map<string, string>()
  const credentials = {
    read: vi.fn(async (key: string) => values.get(key) ?? ''),
    save: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    clear: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
  return { owner: new SecretResourceService(credentials), credentials, values }
}
const document: PersonalResourceDocument = {
  format: 'srl-personal-resource',
  version: 1,
  kind: 'secret',
  name: '自定义资料',
  text: '',
  url: '',
  attachments: [],
  fields: [
    { id: 'key', label: '任意字段', value: 'native-secret', private: true },
    { id: 'public', label: '备注地址', value: 'public-value', private: false },
  ],
}
describe('shared secret password and native recovery', () => {
  it('does not announce an unlocked password when persistence cannot be read back', async () => {
    const { owner, credentials } = setup()
    credentials.read.mockResolvedValue('')
    await expect(owner.setPassword('test-password')).rejects.toThrow('读回')
    expect(owner.isUnlocked()).toBe(false)
  })
  it('requires explicit settings setup, shares one password across resources and keeps encrypted originals portable', async () => {
    const { owner, credentials } = setup()
    await expect(owner.protect(document, 'test-password')).rejects.toThrow('总设置')
    expect(credentials.save).not.toHaveBeenCalled()
    await owner.setPassword('test-password')
    const first = await owner.protect(document)
    const second = await owner.protect({ ...document, name: '另一个资源' })
    expect(JSON.stringify(first)).not.toContain('native-secret')
    expect(first.fields[1]?.value).toBe('public-value')
    expect((await owner.reveal(second))[0]?.value).toBe('native-secret')
    expect(credentials.save).toHaveBeenCalledTimes(1)
    owner.lock()
    await expect(owner.protect(document)).rejects.toThrow('解锁')
    await expect(owner.unlock('wrong-password')).rejects.toThrow()
    expect(owner.isUnlocked()).toBe(false)
    await owner.unlock('test-password')
    await expect(owner.setPassword('replacement-password')).rejects.toThrow('已设置')
    const otherDevice = setup().owner
    expect((await otherDevice.reveal(first, 'test-password'))[0]?.value).toBe('native-secret')
    expect(await otherDevice.hasPassword()).toBe(false)
    const tampered = {
      ...first,
      protected: {
        ...first.protected!,
        data: first.protected!.data.replace(/^./, first.protected!.data[0] === 'A' ? 'B' : 'A'),
      },
    }
    await expect(otherDevice.reveal(tampered, 'test-password')).rejects.toThrow('损坏')
  })
  it('verifies the existing password before enrollment; cancellation does not rewrite password or documents', async () => {
    const { owner, credentials, values } = setup()
    await owner.setPassword('test-password')
    const encrypted = await owner.protect(document)
    const config = values.get('personal-resources.password')
    await expect(owner.enableRecovery('wrong-password')).rejects.toThrow()
    expect(native.save).not.toHaveBeenCalled()
    native.save.mockRejectedValueOnce(new Error('取消指纹'))
    await expect(owner.enableRecovery('test-password')).rejects.toThrow('取消')
    expect(values.get('personal-resources.password')).toBe(config)
    expect(credentials.save).toHaveBeenCalledTimes(1)
    expect((await owner.reveal(encrypted))[0]?.value).toBe('native-secret')
    await owner.enableRecovery('test-password')
    expect(native.save).toHaveBeenLastCalledWith('test-password')
    // Recovery material is owned by the auth-bound native store, never the ordinary credential store.
    expect(values.size).toBe(1)
  })
  it('recovers the original password only after native decryption and validates it against the existing verifier', async () => {
    const { owner, credentials } = setup()
    await owner.setPassword('test-password')
    const encrypted = await owner.protect(document)
    owner.lock()
    native.recover.mockRejectedValueOnce(new Error('未通过指纹验证'))
    await expect(owner.recoverPassword()).rejects.toThrow('未通过')
    expect(owner.isUnlocked()).toBe(false)
    native.recover.mockResolvedValueOnce('stale-password')
    await expect(owner.recoverPassword()).rejects.toThrow()
    expect(owner.isUnlocked()).toBe(false)
    native.recover.mockResolvedValue('test-password')
    expect(await owner.recoverPassword()).toBe('test-password')
    expect((await owner.revealBiometric(encrypted))[0]?.value).toBe('native-secret')
    expect(credentials.save).toHaveBeenCalledTimes(1)
  })
  it('never exposes native recovery on web', async () => {
    native.available = false
    const owner = setup().owner
    await expect(owner.enableRecovery('test-password')).rejects.toThrow('仅支持安卓')
    await expect(owner.recoverPassword()).rejects.toThrow('仅支持安卓')
    expect(native.save).not.toHaveBeenCalled()
    expect(native.recover).not.toHaveBeenCalled()
  })
})
