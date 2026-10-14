import type {
  ExternalAppDataRecord,
  InstalledExternalApp,
  InstalledExternalAppSummary,
} from '../types/ExternalApp'

export interface ExternalAppStorageAdapter {
  list(): Promise<InstalledExternalAppSummary[]>
  getSummary(id: string): Promise<InstalledExternalAppSummary | undefined>
  mutateMetadata(
    id: string,
    change: (current: InstalledExternalAppSummary) => Partial<InstalledExternalAppSummary>,
  ): Promise<void>
  get(id: string): Promise<InstalledExternalApp | undefined>
  save(app: InstalledExternalApp): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  updateMetadata(id: string, changes: Partial<InstalledExternalAppSummary>): Promise<void>
  delete(id: string): Promise<void>
  clearData(appId: string): Promise<void>
  getData(appId: string, key: string): Promise<ExternalAppDataRecord | undefined>
  getDataMany?(appId: string, keys: string[]): Promise<Array<ExternalAppDataRecord | undefined>>
  listData(appId: string): Promise<ExternalAppDataRecord[]>
  listDataAppIds?(): Promise<string[]>
  setData(record: ExternalAppDataRecord): Promise<void>
  deleteData(appId: string, key: string): Promise<void>
}
