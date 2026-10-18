/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OFFICIAL_APP_IDS } from '../types/OfficialApp'

const state = vi.hoisted(() => ({ install: vi.fn(), ready: vi.fn(), native: true }))
vi.mock('virtual:srl-official-app-entries', () => ({ entries: {}, runtimeEntry: undefined }))
vi.mock('./AppDatabaseInstance', () => ({ appDatabase: {} }))
vi.mock('../storage/InstalledOfficialAppStorage', () => ({
  InstalledOfficialAppStorage: class {},
}))
vi.mock('../storage/OfficialAppDataStorage', () => ({ clearOfficialAppData: vi.fn() }))
vi.mock('../utils/CapacitorDetection', () => ({ isCapacitorApp: () => state.native }))
vi.mock('../services/OfficialAppService', () => ({
  OfficialAppService: class {
    install = state.install
    ready = state.ready
  },
}))

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  state.native = true
  state.install.mockReset().mockResolvedValue(undefined)
  state.ready.mockReset().mockResolvedValue(false)
  vi.stubGlobal('__SRL_PREINSTALL_OFFICIAL_APPS__', true)
  vi.stubGlobal('__SRL_PREINSTALL_OFFICIAL_APP_IDS__', null)
})
afterEach(() => vi.unstubAllGlobals())

it('keeps already usable built-in APPs without reinstalling after a shell update', async () => {
  state.ready.mockResolvedValue(true)
  const { ensurePreinstalledOfficialApps } = await import('./OfficialAppRuntime')
  await ensurePreinstalledOfficialApps()
  expect(state.ready).toHaveBeenCalled()
  expect(state.install).not.toHaveBeenCalled()
})

it('uses working fetch when the optional native fetch alias is absent', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('app'))
  vi.stubGlobal('fetch', fetcher)
  const { fetchOfficialAppAsset } = await import('./OfficialAppRuntime')
  expect(await (await fetchOfficialAppAsset('/assets/app.js')).text()).toBe('app')
  expect(fetcher).toHaveBeenCalledWith('/assets/app.js', undefined)
})

it('installs only the selected apps and does not reinstall them on the next entry', async () => {
  vi.stubGlobal('__SRL_PREINSTALL_OFFICIAL_APP_IDS__', ['chatReader', 'tavernBridge'])
  const { ensurePreinstalledOfficialApps } = await import('./OfficialAppRuntime')
  await ensurePreinstalledOfficialApps()
  await ensurePreinstalledOfficialApps()
  expect(state.install.mock.calls.map(([id]) => id)).toEqual(['chatReader', 'tavernBridge'])
})

it('retains the existing full-preinstallation scope when no selection is supplied', async () => {
  const { ensurePreinstalledOfficialApps } = await import('./OfficialAppRuntime')
  await ensurePreinstalledOfficialApps()
  expect(state.install.mock.calls.map(([id]) => id)).toEqual(
    // SRL-PUBLIC-SYNC: BEGIN REPLACE id=optional-app-ids
    OFFICIAL_APP_IDS.filter((id) => id !== 'assistant'),
    // SRL-PUBLIC-SYNC: END REPLACE id=optional-app-ids
  )
})

it.each(['normal APK', 'web'])('does not preinstall in %s mode', async (mode) => {
  vi.stubGlobal('__SRL_PREINSTALL_OFFICIAL_APP_IDS__', ['chatReader', 'tavernBridge'])
  if (mode === 'normal APK') vi.stubGlobal('__SRL_PREINSTALL_OFFICIAL_APPS__', false)
  else state.native = false
  const { ensurePreinstalledOfficialApps } = await import('./OfficialAppRuntime')
  await ensurePreinstalledOfficialApps()
  expect(state.install).not.toHaveBeenCalled()
})
