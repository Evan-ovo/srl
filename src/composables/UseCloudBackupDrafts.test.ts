import { expect, it } from 'vitest'
import { cloudBackupSelectionModel } from './UseCloudBackupDrafts'
import { toCloudContentSelection } from '../services/BackupScopeRegistry'
import type { CloudBackupContentSelection } from '../types/CloudBackup'

it('reopens saved creative scopes exactly, including explicit deselection and older configurations', () => {
  const contentSelection: CloudBackupContentSelection = {
    generatedImageAlbum: true,
    frontendWorkshopProjects: true,
    frontendWorkshopComponents: true,
    imageGeneration: false,
  }
  const config = {
    provider: 'github' as const,
    owner: 'fixture',
    repository: 'backup',
    autoBackup: false,
    retention: 7,
    contentSelection,
  }
  const selected = toCloudContentSelection(cloudBackupSelectionModel(config, []))
  for (const key of [
    'generatedImageAlbum',
    'frontendWorkshopProjects',
    'frontendWorkshopComponents',
    'imageGeneration',
  ] as const)
    expect(selected[key]).toBe(contentSelection[key])
  const previous = toCloudContentSelection(
    cloudBackupSelectionModel({ ...config, contentSelection: {} }, []),
  )
  expect(previous.generatedImageAlbum).toBe(false)
  expect(previous.frontendWorkshopProjects).toBe(false)
  expect(previous.imageGeneration).toBe(false)
})
