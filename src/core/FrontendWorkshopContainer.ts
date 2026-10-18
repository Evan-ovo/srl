import { FrontendWorkshopAiLocalStorage } from '../storage/FrontendWorkshopAiLocalStorage'
import { FrontendWorkshopSourceAiRecovery } from '../services/FrontendWorkshopSourceAiRecovery'
import { FrontendWorkshopSourceAiReferenceCache } from '../services/FrontendWorkshopSourceAiReferenceCache'
import { IndexedDbFrontendWorkshopProjectStorage } from '../storage/IndexedDbFrontendWorkshopProjectStorage'
import { IndexedDbFrontendWorkshopSourceComponentStorage } from '../storage/IndexedDbFrontendWorkshopSourceComponentStorage'
import { IndexedDbFrontendWorkshopSourceDocumentStorage } from '../storage/IndexedDbFrontendWorkshopSourceDocumentStorage'
import { FrontendWorkshopProjectService } from '../services/FrontendWorkshopProjectService'
import { FrontendWorkshopSourceAiApplicationService } from '../services/FrontendWorkshopSourceAiApplicationService'
import { FrontendWorkshopSourceAiHostReferenceCatalogResolver } from '../services/FrontendWorkshopSourceAiHostReferenceCatalogResolver'
import { FrontendWorkshopSourceAiHostReferenceService } from '../services/FrontendWorkshopSourceAiHostReferenceService'
import { FrontendWorkshopSourceAiRequestService } from '../services/FrontendWorkshopSourceAiRequestService'
import { FrontendWorkshopSourceAiSessionService } from '../services/FrontendWorkshopSourceAiSessionService'
import { FrontendWorkshopSourceAiTransportService } from '../services/FrontendWorkshopSourceAiTransportService'
import { FrontendWorkshopSourceCheckpointService } from '../services/FrontendWorkshopSourceCheckpointService'
import type { FrontendWorkshopBrowserSourceCompilerService } from '../services/FrontendWorkshopBrowserSourceCompilerService'
import { FrontendWorkshopSourceComponentService } from '../services/FrontendWorkshopSourceComponentService'
import { FrontendWorkshopSourceDocumentService } from '../services/FrontendWorkshopSourceDocumentService'
import { FrontendWorkshopSourceHistoryService } from '../services/FrontendWorkshopSourceHistoryService'
import { FrontendWorkshopSourcePatchService } from '../services/FrontendWorkshopSourcePatchService'
import { appDatabase as database } from './AppDatabaseInstance'
import { mainApiService } from './AppContainer'

const frontendWorkshopProjectStorage = new IndexedDbFrontendWorkshopProjectStorage(database)
export const exportPortableWorkshopProjects = () =>
  frontendWorkshopProjectStorage.exportPortableState()
export const importPortableWorkshopProjects = (
  data: import('../storage/FrontendWorkshopProjectStorage').FrontendWorkshopBackup,
) => frontendWorkshopProjectStorage.importPortableState(data)
const frontendWorkshopSourceComponentStorage = new IndexedDbFrontendWorkshopSourceComponentStorage(
  database,
)
const frontendWorkshopSourceDocumentStorage = new IndexedDbFrontendWorkshopSourceDocumentStorage(
  database,
)

export const frontendWorkshopProjectService = new FrontendWorkshopProjectService(
  frontendWorkshopProjectStorage,
)
export const frontendWorkshopSourceDocumentService = new FrontendWorkshopSourceDocumentService(
  frontendWorkshopSourceDocumentStorage,
)
let frontendWorkshopBrowserSourceCompilerServicePromise:
  Promise<FrontendWorkshopBrowserSourceCompilerService> | undefined
export function loadFrontendWorkshopBrowserSourceCompilerService(): Promise<FrontendWorkshopBrowserSourceCompilerService> {
  frontendWorkshopBrowserSourceCompilerServicePromise ??=
    import('../services/FrontendWorkshopBrowserSourceCompilerService').then(
      ({ FrontendWorkshopBrowserSourceCompilerService }) =>
        new FrontendWorkshopBrowserSourceCompilerService(),
    )
  return frontendWorkshopBrowserSourceCompilerServicePromise
}
export const frontendWorkshopSourcePatchService = new FrontendWorkshopSourcePatchService(
  frontendWorkshopSourceDocumentService,
)
export const frontendWorkshopSourceHistoryService = new FrontendWorkshopSourceHistoryService(
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourcePatchService,
)
export const frontendWorkshopSourceComponentService = new FrontendWorkshopSourceComponentService(
  frontendWorkshopSourceComponentStorage,
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceHistoryService,
)
export const frontendWorkshopSourceAiApplicationService =
  new FrontendWorkshopSourceAiApplicationService(
    frontendWorkshopSourceDocumentService,
    frontendWorkshopSourceHistoryService,
  )
export const frontendWorkshopSourceCheckpointService = new FrontendWorkshopSourceCheckpointService(
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceHistoryService,
)
export const frontendWorkshopAiLocalStorage = new FrontendWorkshopAiLocalStorage(database)
export const frontendWorkshopSourceAiRecovery = new FrontendWorkshopSourceAiRecovery(
  frontendWorkshopAiLocalStorage,
)
export const frontendWorkshopSourceAiSessionService = new FrontendWorkshopSourceAiSessionService(
  frontendWorkshopSourceAiApplicationService,
  frontendWorkshopSourceCheckpointService,
  frontendWorkshopSourceAiRecovery,
)
export const frontendWorkshopSourceAiTransportService =
  new FrontendWorkshopSourceAiTransportService(mainApiService)
export const frontendWorkshopSourceAiHostReferenceResolver =
  new FrontendWorkshopSourceAiHostReferenceCatalogResolver(
    new FrontendWorkshopSourceAiReferenceCache(frontendWorkshopAiLocalStorage),
  )
export const frontendWorkshopSourceAiHostReferenceService =
  new FrontendWorkshopSourceAiHostReferenceService(
    frontendWorkshopSourceAiTransportService,
    frontendWorkshopSourceAiHostReferenceResolver,
  )
export const frontendWorkshopSourceAiRequestService = new FrontendWorkshopSourceAiRequestService(
  frontendWorkshopSourceDocumentService,
  frontendWorkshopSourceAiSessionService,
  frontendWorkshopSourceAiHostReferenceService,
  frontendWorkshopSourceCheckpointService,
)
