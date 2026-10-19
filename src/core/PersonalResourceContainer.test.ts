import { beforeEach, expect, it, vi } from 'vitest'
import type { PlainSecretCopy } from '../services/PersonalResourceBackup'
const state = vi.hoisted(() => ({
  configured: true,
  unlocked: true,
  confirm: vi.fn(),
  password: vi.fn(),
  protect: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  hasPassword: vi.fn(),
}))
vi.mock('./AppDatabaseInstance', () => ({ appDatabase: {} }))
vi.mock('./LibraryContainer', () => ({
  resourceService: { listResourceListSummaries: state.list, get: state.get },
}))
vi.mock('../services/PersonalResourceService', () => ({
  PersonalResourceService: class {
    save = state.save
  },
}))
vi.mock('../composables/UseConfirmDialog', () => ({ confirmAction: state.confirm }))
vi.mock('../composables/UseSecretPasswordPrompt', () => ({ requestSecretPassword: state.password }))
vi.mock('../services/SecretResourceService', () => ({
  secretResourceService: {
    hasPassword: state.hasPassword,
    isUnlocked: () => state.unlocked,
    protect: state.protect,
  },
}))
import { restorePlainSecretCopies } from './PersonalResourceContainer'
import { PlainSecretCopyRestoreError } from '../services/PersonalResourceBackup'
const copy: PlainSecretCopy = {
  contentHash: 'a'.repeat(64),
  document: {
    format: 'srl-personal-resource',
    version: 1,
    kind: 'secret',
    name: 'fixture',
    text: '',
    url: '',
    attachments: [],
    fields: [{ id: 'key', label: 'Key', value: 'synthetic-private', private: true }],
  },
}
beforeEach(() => {
  vi.resetAllMocks()
  state.configured = true
  state.unlocked = true
  state.hasPassword.mockImplementation(async () => state.configured)
  state.confirm.mockResolvedValue(true)
  state.password.mockResolvedValue('fixture-password')
  state.protect.mockResolvedValue({
    ...copy.document,
    fields: [],
    protected: { data: 'ciphertext' },
  })
  state.list.mockResolvedValue([
    { id: 'secret-id', type: 'secret', contentHash: copy.contentHash, metadata: {} },
  ])
  state.get.mockResolvedValue({ id: 'secret-id', type: 'secret', contentHash: copy.contentHash })
})
it('uses a verified local unlocked session instead of asking for the password again', async () => {
  await restorePlainSecretCopies([copy])
  expect(state.password).not.toHaveBeenCalled()
  expect(state.list).toHaveBeenCalledExactlyOnceWith({ types: ['secret'] })
  expect(state.protect).toHaveBeenCalledWith(copy.document, undefined)
  expect(state.save).toHaveBeenCalledOnce()
  expect(state.save).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Map),
    expect.anything(),
    copy.contentHash,
  )
})
it('does not prompt, re-encrypt or save a copy whose converted current bytes still match its restore identity', async () => {
  state.list.mockResolvedValue([
    {
      id: 'converted',
      type: 'secret',
      contentHash: 'b'.repeat(64),
      metadata: {
        restoredSecretSourceHash: copy.contentHash,
        restoredSecretContentHash: 'b'.repeat(64),
      },
    },
  ])
  await restorePlainSecretCopies([copy])
  expect(state.confirm).not.toHaveBeenCalled()
  expect(state.hasPassword).not.toHaveBeenCalled()
  expect(state.protect).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
})
it('identifies unreadable password state as only the optional plaintext-copy step', async () => {
  state.configured = false
  await expect(restorePlainSecretCopies([copy])).rejects.toBeInstanceOf(PlainSecretCopyRestoreError)
  expect(state.password).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
})
it('keeps the plaintext step identity when the credential owner reports a storage error', async () => {
  state.hasPassword.mockRejectedValue(new Error('credential read failed'))
  await expect(restorePlainSecretCopies([copy])).rejects.toMatchObject({
    name: 'PlainSecretCopyRestoreError',
    message: 'credential read failed',
  })
  expect(state.save).not.toHaveBeenCalled()
})
it.each(['confirm', 'password'])(
  'honors %s cancellation without saving or producing another prompt',
  async (where) => {
    state.unlocked = false
    if (where === 'confirm') state.confirm.mockResolvedValue(false)
    else state.password.mockResolvedValue(undefined)
    await restorePlainSecretCopies([copy])
    expect(state.save).not.toHaveBeenCalled()
    expect(state.confirm).toHaveBeenCalledOnce()
    expect(state.password).toHaveBeenCalledTimes(where === 'password' ? 1 : 0)
  },
)
