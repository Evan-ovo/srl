import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const secrets = vi.hoisted(() => ({ hasPassword: vi.fn(), isUnlocked: vi.fn(), protect: vi.fn() }))
const choose = vi.hoisted(() => vi.fn())
vi.mock('../composables/UseConfirmDialog', () => ({ chooseAction: choose }))
vi.mock('./SecretResourceService', () => ({ secretResourceService: secrets }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, convertFileSrc: (uri: string) => uri },
  registerPlugin: () => ({}),
}))
import { protectPersonalImport, validateSecretResource } from './PersonalResourceImport'
import { parsePersonalResource } from '../types/PersonalResource'
import { rememberNativeFile, nativeFileSource } from '../core/NativeFileSource'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
beforeEach(() => choose.mockResolvedValue('alternative'))
const plain = {
  format: 'srl-personal-resource',
  version: 1,
  kind: 'secret',
  name: 'Test',
  text: '',
  url: '',
  attachments: [],
  fields: [{ id: 'key', label: 'Key', value: 'synthetic-value', private: true }],
}
it('keeps an explicit unencrypted choice across file import without prompts or password reads', async () => {
  const file = new File([JSON.stringify({ ...plain, protection: 'none' })], 'plain.json')
  const password = vi.fn()
  expect(await protectPersonalImport(file, password)).toBe(file)
  await validateSecretResource(file)
  expect(choose).not.toHaveBeenCalled()
  expect(password).not.toHaveBeenCalled()
  expect(secrets.hasPassword).not.toHaveBeenCalled()
})
it('allows a legacy plaintext file to be imported without establishing a password', async () => {
  choose.mockResolvedValue('confirm')
  const file = await protectPersonalImport(
    new File([JSON.stringify(plain)], 'legacy.json'),
    vi.fn(),
  )
  expect(JSON.parse(await file.text())).toMatchObject({ protection: 'none', fields: plain.fields })
  await validateSecretResource(file)
  expect(secrets.hasPassword).not.toHaveBeenCalled()
})
it('keeps the original unchanged when plaintext import is cancelled', async () => {
  choose.mockResolvedValue('cancel')
  const file = new File([JSON.stringify(plain)], 'legacy.json')
  await expect(protectPersonalImport(file, vi.fn())).rejects.toThrow('取消')
  expect(JSON.parse(await file.text())).toEqual(plain)
  expect(secrets.protect).not.toHaveBeenCalled()
})
it('rejects contradictory protection markers and incomplete legacy encrypted records', async () => {
  expect(() =>
    parsePersonalResource({
      ...plain,
      protection: 'none',
      protected: { salt: 's', iv: 'i', data: 'd', iterations: 310000 },
    }),
  ).toThrow('保护方式')
  expect(() => parsePersonalResource({ ...plain, protection: 'other' })).toThrow('保护方式')
  await expect(validateSecretResource(new Blob([JSON.stringify(plain)]))).rejects.toThrow(
    '保护方式',
  )
})

it('prompts and protects the real private fields of a native shared JSON before persistence', async () => {
  const value = {
    format: 'srl-personal-resource',
    version: 1,
    kind: 'secret',
    name: 'Key',
    text: '',
    url: '',
    attachments: [],
    fields: [{ id: 'key', label: 'Key', value: 'private', private: true }],
  }
  const bytes = new Blob([JSON.stringify(value)])
  const placeholder = rememberNativeFile(new File([], 'key.json'), 'file:///key', bytes.size)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => bytes }))
  secrets.hasPassword.mockResolvedValue(true)
  secrets.isUnlocked.mockReturnValue(false)
  secrets.protect.mockResolvedValue({
    ...value,
    fields: [{ ...value.fields[0], value: '' }],
    protected: { data: 'sealed' },
  })
  const password = vi.fn().mockResolvedValue('password')
  const file = await protectPersonalImport(placeholder, password)
  expect(password).toHaveBeenCalledOnce()
  expect(secrets.protect).toHaveBeenCalledWith(value, 'password')
  expect(JSON.parse(await file.text()).fields[0].value).toBe('')
  expect(nativeFileSource(file)).toBeUndefined()
})

it('uses declared native size to skip oversized JSON without fetching it into the WebView', async () => {
  const file = rememberNativeFile(new File([], 'large.json'), 'file:///large', 3 * 1024 * 1024)
  const fetchFile = vi.fn()
  vi.stubGlobal('fetch', fetchFile)
  expect(await protectPersonalImport(file, vi.fn())).toBe(file)
  expect(fetchFile).not.toHaveBeenCalled()
})
