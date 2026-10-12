import type { AppDatabase } from '../database/AppDatabase'
import {
  normalizeDiscordSetupState,
  type DiscordSetupState,
} from '../services/DiscordSetupWorkflow'
export interface DiscordSetupStorage {
  read(): Promise<DiscordSetupState | undefined>
  save(state: DiscordSetupState): Promise<void>
}
/** One bounded settings record; no resources, browser cookies, editor source or secrets. */
export class IndexedDbDiscordSetupStorage implements DiscordSetupStorage {
  private readonly database: AppDatabase
  constructor(database: AppDatabase) {
    this.database = database
  }
  async read() {
    return normalizeDiscordSetupState(
      (await this.database.settings.get('assistant.discord-setup'))?.value,
    )
  }
  async save(state: DiscordSetupState) {
    const value = normalizeDiscordSetupState(state)
    if (!value) throw new Error('Discord 配置步骤无效，未保存')
    await this.database.settings.put({
      id: 'assistant.discord-setup',
      value,
      updatedAt: Date.now(),
    })
  }
}
