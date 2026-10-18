import type { CloudBackupConfig } from '../types/CloudBackup'
import type { ResourceSummary } from '../types/Resource'
import {
  createDefaultBackupSelection,
  type BackupScopeId,
  type BackupSelectionTreeState,
} from '../services/BackupScopeRegistry'
import { ref } from 'vue'

import type {
  CloudBackupContentSelection,
  CloudBackupProtection,
  CloudBackupProvider,
  CloudBackupSchedule,
  GitHubBackupConfig,
  WebDavBackupConfig,
} from '../types/CloudBackup'

import type { Ref } from 'vue'

import type { CloudBackupSnapshot } from '../types/CloudBackup'

export const KOOFR_URL = 'https://app.koofr.net/dav/Koofr'

export const DEFAULT_SCHEDULE: CloudBackupSchedule = { mode: 'interval', value: 1, unit: 'days' }

export const DEFAULT_PROTECTION: CloudBackupProtection = {
  wifiOnly: false,
  chargingOnly: false,
}

export const DEFAULT_CONTENT_SELECTION: CloudBackupContentSelection = {
  credentials: false,
  aiTaggingState: false,
  externalApps: false,
  chatReader: true,
  assistantData: false,
  stitchWork: false,
  imageGeneration: true,
  generatedImageAlbum: false,
  frontendWorkshopProjects: false,
}

export function useCloudBackupDrafts(snapshot: Ref<CloudBackupSnapshot>) {
  const activeProvider = ref<CloudBackupProvider>(snapshot.value.activeProvider ?? 'github')

  const github = ref<
    GitHubBackupConfig & {
      schedule: CloudBackupSchedule
      protection: CloudBackupProtection
      contentSelection: CloudBackupContentSelection
    }
  >(
    snapshot.value.github
      ? {
          ...snapshot.value.github,
          schedule: snapshot.value.github.schedule ?? { ...DEFAULT_SCHEDULE },
          protection: snapshot.value.github.protection ?? { ...DEFAULT_PROTECTION },
          contentSelection: snapshot.value.github.contentSelection ?? {
            ...DEFAULT_CONTENT_SELECTION,
          },
        }
      : {
          provider: 'github',
          owner: '',
          repository: '',
          retention: 7,
          autoBackup: true,
          schedule: { ...DEFAULT_SCHEDULE },
          protection: { ...DEFAULT_PROTECTION },
          contentSelection: { ...DEFAULT_CONTENT_SELECTION },
        },
  )

  const webdav = ref<
    WebDavBackupConfig & {
      schedule: CloudBackupSchedule
      protection: CloudBackupProtection
      contentSelection: CloudBackupContentSelection
    }
  >(
    snapshot.value.webdav
      ? {
          ...snapshot.value.webdav,
          baseUrl: KOOFR_URL,
          schedule: snapshot.value.webdav.schedule ?? { ...DEFAULT_SCHEDULE },
          protection: snapshot.value.webdav.protection ?? { ...DEFAULT_PROTECTION },
          contentSelection: snapshot.value.webdav.contentSelection ?? {
            ...DEFAULT_CONTENT_SELECTION,
          },
        }
      : {
          provider: 'webdav',
          baseUrl: KOOFR_URL,
          folder: 'SRL-Backups',
          username: '',
          retention: 7,
          autoBackup: true,
          schedule: { ...DEFAULT_SCHEDULE },
          protection: { ...DEFAULT_PROTECTION },
          contentSelection: { ...DEFAULT_CONTENT_SELECTION },
        },
  )

  return { activeProvider, github, webdav }
}

export function cloudBackupSelectionModel(
  config: CloudBackupConfig,
  resources: readonly ResourceSummary[],
): BackupSelectionTreeState {
  const defaults = createDefaultBackupSelection(resources, 'cloud')
  const configured = config.contentSelection ?? {}
  const scopes = new Set(defaults.scopes)
  const setScope = (id: BackupScopeId, enabled: boolean | undefined, fallback: boolean) => {
    if (enabled ?? fallback) scopes.add(id)
    else scopes.delete(id)
  }
  setScope('resource.extraStory', configured.personalResources?.extraStory, true)
  setScope('resource.pocketPhone', configured.personalResources?.pocketPhone, true)
  setScope('resource.secret', configured.personalResources?.secret, false)
  setScope('extra.plaintextSecretCopy', configured.plaintextSecretCopy, false)
  setScope('extra.credentials', configured.credentials, false)
  setScope('extra.aiTaggingState', configured.aiTaggingState, false)
  setScope('extra.externalApps', configured.externalApps, false)
  setScope('extra.chatReader', configured.chatReader, true)
  setScope('extra.assistantData', configured.assistantData, false)
  setScope('extra.resourceGallery', configured.resourceGallery, false)
  setScope('extra.stitchWork', configured.stitchWork, false)
  setScope('extra.communitySources', configured.communitySources, false)
  setScope('extra.frontendWorkshopComponents', configured.frontendWorkshopComponents, false)
  setScope('extra.frontendWorkshopProjects', configured.frontendWorkshopProjects, false)
  setScope('extra.generatedImageAlbum', configured.generatedImageAlbum, false)
  setScope('extra.imageGeneration', configured.imageGeneration, false)
  setScope('extra.appearance', configured.appearance, true)
  setScope('extra.cloudBackup', configured.cloudBackup, true)
  setScope('extra.characterDraw', configured.characterDraw, true)
  setScope('extra.generalPreferences', configured.generalPreferences, true)
  return {
    resourceIds: new Set(configured.resourceIds ?? defaults.resourceIds),
    scopes,
  }
}
