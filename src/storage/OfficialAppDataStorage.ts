import type { AppDatabase } from '../database/AppDatabase'
import type { OfficialAppId } from '../types/OfficialApp'
import { localCredentialStore } from '../services/LocalCredentialStore'
import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import { IndexedDbExternalAppStorage } from './IndexedDbExternalAppStorage'

const keys: Partial<Record<OfficialAppId, string[]>> = {
  draw: ['srl.draw.showNames'],
  stitch: [
    'srl.stitch.draft',
    'srl.stitch.checkpoint',
    'srl.stitch.recentPresets',
    'srl.stitch.favoriteEntries',
    'srl.stitch.templates',
    'srl.stitch.mainSide',
  ],
  frontendWorkshop: [
    'srl.frontendWorkshop.recentColors',
    'srl.frontendWorkshop.versions.v1',
    'srl.frontendWorkshop.drafts.v1',
    'srl.frontendWorkshop.recovery.v1',
    'srl.frontendWorkshop.conversation.v1',
  ],
  imageGeneration: [
    'srl.frontendWorkshop.imageGeneration.config.v1',
    'srl.frontendWorkshop.imageGeneration.draft.v1',
    'srl.frontendWorkshop.imageGeneration.templates.v1',
  ],
  userPersona: ['srl.userPersona.templates'],
}

export async function clearOfficialAppData(
  database: AppDatabase,
  id: OfficialAppId,
): Promise<void> {
  localStorage.setItem(`srl.officialApps.dataRevision.${id}`, crypto.randomUUID())
  if (id === 'chatReader')
    await new IndexedDbExternalAppStorage(database).clearData(CHAT_READER_APP_ID)
  if (id === 'draw') await database.settings.delete('feature.characterDraw')
  if (id === 'frontendWorkshop') {
    const tables = [
      database.frontendWorkshopProjects,
      database.frontendWorkshopProjectLastGood,
      database.frontendWorkshopSourceDocuments,
      database.frontendWorkshopSourceDocumentLastGood,
      database.frontendWorkshopSourceComponents,
    ]
    await database.transaction('rw', tables, async () => {
      for (const table of tables) await table.clear()
    })
  }
  if (id === 'imageAlbum')
    await database.transaction(
      'rw',
      [database.generatedImages, database.generatedImageFiles],
      async () => {
        await database.generatedImages.clear()
        await database.generatedImageFiles.clear()
      },
    )
  if (id === 'imageGeneration')
    for (const provider of ['openai', 'novelai', 'custom'])
      await localCredentialStore.clear(`image-generation:${provider}`)
  if (id === 'assistant') {
    await database.settings.where('id').startsWith('assistant.').delete()
    const { clearAssistantPetAssets } = await import('../services/ProductAssistantPetAssets')
    await clearAssistantPetAssets()
  }
  for (const key of keys[id] ?? []) localStorage.removeItem(key)
}
