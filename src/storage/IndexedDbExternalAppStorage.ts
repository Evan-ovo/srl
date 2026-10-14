import type { AppDatabase } from '../database/AppDatabase'
import {
  externalAppDataId,
  type ExternalAppDataRecord,
  type InstalledExternalApp,
  type InstalledExternalAppSummary,
} from '../types/ExternalApp'
import type { ExternalAppStorageAdapter } from './ExternalAppStorageAdapter'

export class IndexedDbExternalAppStorage implements ExternalAppStorageAdapter {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  async list(): Promise<InstalledExternalAppSummary[]> {
    return (await this.database.externalApps.toArray()).sort(
      (left, right) => right.updatedAt - left.updatedAt,
    )
  }

  async getSummary(id: string): Promise<InstalledExternalAppSummary | undefined> {
    return this.database.externalApps.get(id)
  }

  async mutateMetadata(
    id: string,
    change: (current: InstalledExternalAppSummary) => Partial<InstalledExternalAppSummary>,
  ): Promise<void> {
    await this.database.transaction('rw', this.database.externalApps, async () => {
      const current = await this.database.externalApps.get(id)
      if (!current) throw new Error('APP 不存在或已卸载')
      await this.database.externalApps.update(id, change(current))
    })
  }

  async get(id: string): Promise<InstalledExternalApp | undefined> {
    const [app, runtime] = await Promise.all([
      this.database.externalApps.get(id),
      this.database.externalAppRuntimes.get(id),
    ])
    if (!app || !runtime) return undefined
    return {
      ...app,
      runtimeHtml: runtime.runtimeHtml,
      ...(runtime.packageFiles ? { packageFiles: runtime.packageFiles } : {}),
    }
  }

  async save(app: InstalledExternalApp): Promise<void> {
    const { runtimeHtml, packageFiles, ...summary } = app
    await this.database.transaction(
      'rw',
      this.database.externalApps,
      this.database.externalAppRuntimes,
      async () => {
        await this.database.externalApps.put(summary)
        await this.database.externalAppRuntimes.put({
          id: app.id,
          runtimeHtml,
          ...(packageFiles ? { packageFiles } : {}),
          updatedAt: app.updatedAt,
        })
      },
    )
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.database.externalApps.update(id, { enabled, updatedAt: Date.now() })
  }

  async updateMetadata(id: string, changes: Partial<InstalledExternalAppSummary>): Promise<void> {
    await this.database.externalApps.update(id, changes)
  }

  async delete(id: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.externalApps,
      this.database.externalAppRuntimes,
      async () => {
        await this.database.externalApps.delete(id)
        await this.database.externalAppRuntimes.delete(id)
      },
    )
  }

  async clearData(appId: string): Promise<void> {
    const records = await this.database.externalAppData.where('appId').equals(appId).toArray()
    if (records.length)
      await this.database.externalAppData.bulkDelete(records.map((record) => record.id))
  }

  async getData(appId: string, key: string): Promise<ExternalAppDataRecord | undefined> {
    return this.database.externalAppData.get(externalAppDataId(appId, key))
  }

  async getDataMany(
    appId: string,
    keys: string[],
  ): Promise<Array<ExternalAppDataRecord | undefined>> {
    return this.database.externalAppData.bulkGet(keys.map((key) => externalAppDataId(appId, key)))
  }
  async listData(appId: string): Promise<ExternalAppDataRecord[]> {
    return this.database.externalAppData.where('appId').equals(appId).toArray()
  }

  async listDataAppIds(): Promise<string[]> {
    // Some WebKit engines reject nextunique index cursors. A normal key cursor
    // keeps the same result without materializing APP data bodies.
    const ids = new Set<string>()
    await this.database.externalAppData.orderBy('appId').eachKey((key) => {
      if (typeof key === 'string') ids.add(key)
    })
    return [...ids]
  }

  async setData(record: ExternalAppDataRecord): Promise<void> {
    await this.database.externalAppData.put(record)
  }

  async deleteData(appId: string, key: string): Promise<void> {
    await this.database.externalAppData.delete(externalAppDataId(appId, key))
  }
}
