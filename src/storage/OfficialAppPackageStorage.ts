import type { InstalledOfficialApp, OfficialAppFile, OfficialAppId } from '../types/OfficialApp'

export interface OfficialAppPackageStorage {
  list(): Promise<InstalledOfficialApp[]>
  get?(id: OfficialAppId): Promise<InstalledOfficialApp | undefined>
  save(app: InstalledOfficialApp): Promise<void>
  remove(id: OfficialAppId): Promise<void>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  repairUnreadableFile?(path: string, bytes: Uint8Array): Promise<boolean>
  hasFile(path: string, size: number, bundled?: boolean): Promise<boolean>
  hasFiles?(files: readonly Pick<OfficialAppFile, 'path' | 'size'>[]): Promise<boolean>
  hasFileHash(path: string, size: number, sha256: string, bundled?: boolean): Promise<boolean>
  deleteFile(path: string, bundled?: boolean): Promise<void>
}
