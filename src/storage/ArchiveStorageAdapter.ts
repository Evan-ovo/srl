import type { Category, Resource } from '../types/Resource'
import type { NativeBackedResourceRecord } from '../types/Vault'

export interface ArchiveRestoreProgress {
  phase: 'prepare' | 'commit'
  completed: number
  total: number
  items?: { resources: number; versions: number; album: number; communityAttachments: number }
  fileName?: string
  transferredBytes?: number
  totalBytes?: number
}

export interface ArchiveStorageAdapter {
  isRestoreCommitted?(checkpointId: string): Promise<boolean>
  clearRestoreCheckpoint?(checkpointId: string): Promise<void>
  canRestoreNative?(): boolean
  listRestoreVersionKeys?(groupIds?: readonly string[]): Promise<string[]>
  restore(
    categories: Category[],
    resources: Resource[],
    versions?: Resource[],
    hydrate?: (resource: Resource) => Promise<Resource>,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void>
  restoreNative?(
    categories: Category[],
    resources: NativeBackedResourceRecord[],
    versions?: NativeBackedResourceRecord[],
    hydrate?: (resource: NativeBackedResourceRecord) => Promise<NativeBackedResourceRecord>,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
  ): Promise<void>
  replace(
    categories: Category[],
    resources: Resource[],
    versions?: Resource[],
    hydrate?: (resource: Resource) => Promise<Resource>,
    onProgress?: (progress: ArchiveRestoreProgress) => void,
    checkpointId?: string,
  ): Promise<void>
}
