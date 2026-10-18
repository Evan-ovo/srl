import { AiTaggingDraftService } from '../services/AiTaggingDraftService'
import { AiTaggingService } from '../services/AiTaggingService'
import { CloudBackupService } from '../services/CloudBackupService'
import { MainApiService } from '../services/MainApiService'
import { ProductAssistantWorkspaceService } from '../services/ProductAssistantWorkspaceService'
import { IndexedDbProductAssistantStorage } from '../storage/IndexedDbProductAssistantStorage'
import { IndexedDbDiscordSetupStorage } from '../storage/IndexedDbDiscordSetupStorage'
import { DiscordSetupService } from '../services/DiscordSetupService'
import { IndexedDbExternalAppStorage } from '../storage/IndexedDbExternalAppStorage'
import { ExternalAppService } from '../services/ExternalAppService'
import { ExternalAppSdkService } from '../services/ExternalAppSdkService'
import { frontendWorkshopLegacyApiPreferenceService } from '../services/FrontendWorkshopLegacyApiPreferenceService'
import type { ArchivePortableData } from '../types/Backup'
import {
  browserStorageService,
  categoryService,
  characterDrawService,
  communitySourceService,
  database,
  exportService,
  resourceGalleryService,
  resourceService,
  restoreService,
  syncNativeResourceFiles,
} from './LibraryContainer'

export {
  assetStore,
  archiveRecoveryService,
  browserStorageService,
  categoryService,
  characterDrawService,
  communitySourceService,
  discordInboxAutomationSettingsService,
  communitySourceStorage,
  database,
  exportService,
  getNativeMirrorHealth,
  initializeVaultOnce,
  nativeResourceRecoveryService,
  resourceHealthStorage,
  resourceArchiveService,
  resourceAttachmentService,
  resourceGalleryService,
  resourceService,
  restoreService,
  recycleBinService,
  syncNativeResourceFiles,
  thumbnailService,
  greetingResourceService,
  userPersonaService,
  vaultService,
} from './LibraryContainer'

const externalAppStorage = new IndexedDbExternalAppStorage(database)
export const externalAppService = new ExternalAppService(externalAppStorage)
export const externalAppSdkService = new ExternalAppSdkService(externalAppService, resourceService)
export const mainApiService = new MainApiService()
export const discordSetupService = new DiscordSetupService(
  new IndexedDbDiscordSetupStorage(database),
)
const productAssistantStorage = new IndexedDbProductAssistantStorage(database)
export const productAssistantWorkspaceService = new ProductAssistantWorkspaceService(
  productAssistantStorage,
  mainApiService,
)
export const aiTaggingService = new AiTaggingService(mainApiService, resourceService)
export const aiTaggingDraftService = new AiTaggingDraftService()
export const cloudBackupService = new CloudBackupService(
  resourceService,
  categoryService,
  exportService,
  restoreService,
  async (selection) => ({
    version: 1,
    ...(await exportPortableApplicationData(selection)),
    ...(selection.communitySources
      ? { communitySources: { data: await communitySourceService.exportAll(), attachments: [] } }
      : {}),
    ...(selection.appearance
      ? { appearance: browserStorageService.exportAppearanceSettings() }
      : {}),
    ...(selection.characterDraw
      ? {
          characterDraw: {
            state: await characterDrawService.load(),
            showNames: browserStorageService.getDrawShowNames(),
          },
        }
      : {}),
    ...(selection.generalPreferences
      ? {
          generalPreferences: browserStorageService.exportGeneralPreferences(),
        }
      : {}),
    ...(selection.resourceGallery
      ? { resourceGalleryCategories: await resourceGalleryService.exportCategories() }
      : {}),
    ...(selection.aiTaggingState
      ? {
          aiTaggingState: {
            draft: aiTaggingDraftService.loadDraft(),
            undo: aiTaggingDraftService.loadUndo(),
          },
        }
      : {}),
    ...(selection.credentials
      ? {
          mainApiProfiles: mainApiService.getProfilesState(),
          credentials: await exportPortableCredentialBundle(),
        }
      : {}),
    ...(selection.externalApps
      ? { externalApps: await externalAppService.exportPortableState() }
      : {}),
    ...(selection.chatReader ? { chatReader: await externalAppService.exportReaderData() } : {}),
    ...(selection.assistantData
      ? { assistantData: await productAssistantStorage.exportPortableState() }
      : {}),
    ...(selection.stitchWork ? { stitchWork: browserStorageService.exportStitchWork() } : {}),
    ...(selection.frontendWorkshopComponents
      ? {
          frontendWorkshopComponents: await (
            await import('./FrontendWorkshopContainer')
          ).frontendWorkshopSourceComponentService.exportPortableState(),
        }
      : {}),
  }),
  async (data) => {
    await importPortableApplicationData(data)
    if (data.appearance) browserStorageService.importAppearanceSettings(data.appearance)
    if (data.cloudBackup) cloudBackupService.importPortableSettings(data.cloudBackup)
    if (data.characterDraw) {
      await characterDrawService.importState(data.characterDraw.state)
      browserStorageService.setDrawShowNames(data.characterDraw.showNames)
    }
    if (data.generalPreferences) {
      browserStorageService.importGeneralPreferences(data.generalPreferences)
    }
    if (data.mainApiProfiles) {
      mainApiService.importProfilesState(data.mainApiProfiles)
      await mainApiService.awaitCredentialWrites()
    }
    if (data.credentials) await importPortableCredentialBundle(data.credentials)
    if (data.resourceGalleryCategories)
      await resourceGalleryService.importCategories(data.resourceGalleryCategories)
    if (data.aiTaggingState?.draft) aiTaggingDraftService.saveDraft(data.aiTaggingState.draft)
    if (data.aiTaggingState?.undo) aiTaggingDraftService.saveUndo(data.aiTaggingState.undo)
    if (data.externalApps) await externalAppService.importPortableState(data.externalApps)
    if (data.chatReader) await externalAppService.importReaderData(data.chatReader)
    if (data.assistantData) await importPortableAssistantData(data.assistantData)
    if (data.stitchWork) browserStorageService.importStitchWork(data.stitchWork)
    if (data.frontendWorkshopComponents) {
      const { frontendWorkshopSourceComponentService } = await import('./FrontendWorkshopContainer')
      await frontendWorkshopSourceComponentService.importPortableState(
        data.frontendWorkshopComponents,
      )
    }
    if (data.plaintextSecretCopies?.length) {
      const { restorePlainSecretCopies } = await import('./PersonalResourceContainer')
      await restorePlainSecretCopies(data.plaintextSecretCopies)
    }
  },
  syncNativeResourceFiles,
  (assetId) => communitySourceService.getAttachmentBlob(assetId),
  async (id) =>
    (await import('./ImageAlbumContainer')).generatedImageAlbumService.getOriginalBlob(id),
)

export async function initializeCredentialServices(): Promise<void> {
  await mainApiService.initializeCredentials()
  await Promise.all([
    cloudBackupService.initializeCredentials(),
    frontendWorkshopLegacyApiPreferenceService.initializeCredentials({
      mode: 'main',
      savedProfileId: mainApiService.getActiveProfile().id,
      custom: mainApiService.getConfig(),
      credentialPersistence: 'local',
    }),
    import('../services/DiscordSourceSettingsService').then(
      ({ initializeDiscordSourceCredentials }) => initializeDiscordSourceCredentials(),
    ),
  ])
}

export async function exportPortableApplicationData(
  selection: Pick<
    import('../types/Backup').ArchivePortableSelection,
    'frontendWorkshopProjects' | 'imageGeneration' | 'generatedImageAlbum'
  >,
): Promise<Partial<ArchivePortableData>> {
  const data: Partial<ArchivePortableData> = {}
  if (selection.frontendWorkshopProjects)
    data.frontendWorkshopProjects = await (
      await import('./FrontendWorkshopContainer')
    ).exportPortableWorkshopProjects()
  if (selection.generatedImageAlbum)
    data.generatedImageAlbum = await (
      await import('./ImageAlbumContainer')
    ).generatedImageAlbumService.exportPortableState()
  if (selection.imageGeneration) {
    const { frontendWorkshopImageGenerationService } = await import('./ImageGenerationContainer')
    const { frontendWorkshopImageDraftService } =
      await import('../services/FrontendWorkshopImageDraftService')
    data.imageGeneration = {
      configurations: frontendWorkshopImageGenerationService.exportPortableSettings(),
      work: frontendWorkshopImageDraftService.exportPortableState(),
    }
  }
  return data
}

export async function importPortableApplicationData(data: ArchivePortableData): Promise<void> {
  if (data.frontendWorkshopProjects)
    await (
      await import('./FrontendWorkshopContainer')
    ).importPortableWorkshopProjects(data.frontendWorkshopProjects)
  if (data.imageGeneration) {
    await (
      await import('./ImageGenerationContainer')
    ).frontendWorkshopImageGenerationService.importPortableSettings(
      data.imageGeneration.configurations,
    )
    await (
      await import('../services/FrontendWorkshopImageDraftService')
    ).frontendWorkshopImageDraftService.importPortableState(data.imageGeneration.work)
  }
}

export async function exportPortableAssistantData() {
  return productAssistantStorage.exportPortableState()
}

export async function importPortableAssistantData(value: unknown): Promise<void> {
  await productAssistantStorage.importPortableState(value)
  await productAssistantWorkspaceService.reloadImportedPreferences()
}

export async function exportPortableCredentialBundle(): Promise<
  NonNullable<ArchivePortableData['credentials']>
> {
  const { frontendWorkshopImageHostingService } = await import('./ImageAlbumContainer')
  const { loadDiscordSourceConnectionSettings } =
    await import('../services/DiscordSourceSettingsService')
  await frontendWorkshopImageHostingService.initializeCredentials()
  return {
    version: 1,
    imageGeneration: await (async () => {
      const { frontendWorkshopImageGenerationService: service } =
        await import('./ImageGenerationContainer')
      await service.initializeCredentials()
      return service
        .exportConfigurations()
        .filter((config) => config.credentialPersistence !== 'session')
    })(),
    assistantGitHubReadToken:
      await productAssistantWorkspaceService.exportPortableGitHubCredential(),
    imageHosting: frontendWorkshopImageHostingService.exportSelfHostedConfiguration(),
    legacyFrontendWorkshopApi:
      frontendWorkshopLegacyApiPreferenceService.exportCustomConfiguration(),
    discordSource: loadDiscordSourceConnectionSettings().botToken
      ? loadDiscordSourceConnectionSettings()
      : undefined,
    cloudBackup: await cloudBackupService.exportPortableCredentials(),
  }
}

export async function importPortableCredentialBundle(
  value: NonNullable<ArchivePortableData['credentials']>,
): Promise<void> {
  if (value.assistantGitHubReadToken)
    await productAssistantWorkspaceService.importPortableGitHubCredential(
      value.assistantGitHubReadToken,
    )
  if (value.imageGeneration) {
    const { frontendWorkshopImageGenerationService } = await import('./ImageGenerationContainer')
    await frontendWorkshopImageGenerationService.initializeCredentials()
    await frontendWorkshopImageGenerationService.importConfigurations(value.imageGeneration)
  }
  if (value.imageHosting) {
    const { frontendWorkshopImageHostingService } = await import('./ImageAlbumContainer')
    await frontendWorkshopImageHostingService.initializeCredentials()
    await frontendWorkshopImageHostingService.saveSelfHostedConfiguration({
      ...value.imageHosting,
      remember: true,
    })
  }
  if (value.legacyFrontendWorkshopApi) {
    await frontendWorkshopLegacyApiPreferenceService.importCustomConfiguration(
      value.legacyFrontendWorkshopApi,
    )
  }
  if (value.productAssistantApi)
    await productAssistantWorkspaceService.importCustomConfiguration(value.productAssistantApi)
  if (value.discordSource?.botToken) {
    const { saveDiscordSourceConnectionSettings } =
      await import('../services/DiscordSourceSettingsService')
    await saveDiscordSourceConnectionSettings({
      ...value.discordSource,
      credentialPersistence: 'local',
    })
  }
  if (value.cloudBackup) await cloudBackupService.importPortableCredentials(value.cloudBackup)
}
