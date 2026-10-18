import { Capacitor } from '@capacitor/core'
import { NativeArchiveTaskStore, type ArchiveTaskRecord } from '../storage/NativeArchiveTaskStore'
import { nativeFileSource, rememberNativeFile } from '../core/NativeFileSource'
import type { PreparedRestore, RestoreMode, ArchiveOptions } from '../types/Backup'
import type { ArchiveSource } from './ExportService'
import type { ResourceSummary, Category } from '../types/Resource'
import { hashBlob } from './HashService'
import { hashNativeFile, nativeFileSize } from '../core/NativeFileSource'

export interface RestoreRecoveryPayload {
  source?: { uri: string; name: string; size: number; hash: string }
  prepared?: PreparedRestore
  mode?: RestoreMode
  baseline?: string
  vaultEnabled: boolean
  completed: string[]
  credentials?: boolean
}

export interface RestoreRecoveryTask extends ArchiveTaskRecord {
  kind: 'restore'
  payload: RestoreRecoveryPayload
}

export interface ExportRecoveryTask extends ArchiveTaskRecord {
  kind: 'export'
  payload: {
    resources: ResourceSummary[]
    versions: ResourceSummary[]
    categories: Category[]
    options: Omit<ArchiveOptions, 'communitySourceAttachments' | 'readAlbumFile'>
    attachments: { assetId: string; hash: string; size: number }[]
    createdAt: string
    vaultEnabled: boolean
  }
}

export class ArchiveRecoveryService {
  readonly store: NativeArchiveTaskStore
  constructor(store = new NativeArchiveTaskStore()) {
    this.store = store
  }

  async createExport(
    source: ArchiveSource,
    categories: Category[],
    options: ArchiveOptions,
    vaultEnabled: boolean,
  ): Promise<ExportRecoveryTask | undefined> {
    const { communitySourceAttachments = [], readAlbumFile: _readAlbumFile, ...plan } = options
    const attachments: ExportRecoveryTask['payload']['attachments'] = []
    for (const entry of communitySourceAttachments)
      attachments.push({
        assetId: entry.assetId,
        hash: await hashBlob(entry.blob),
        size: entry.blob.size,
      })
    const task: ExportRecoveryTask = {
      version: 1,
      id: crypto.randomUUID(),
      kind: 'export',
      name: options.mode === 'full' ? '完整备份' : '所选资源备份',
      phase: '压缩文件',
      updatedAt: Date.now(),
      payload: {
        resources: source.resources,
        versions: source.versions,
        categories,
        options: plan,
        attachments,
        createdAt: new Date().toISOString(),
        vaultEnabled,
      },
    }
    try {
      await this.store.save(task)
      return task
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIMPLEMENTED') return undefined
      throw error
    }
  }

  async createRestore(
    file: File | undefined,
    vaultEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<RestoreRecoveryTask | undefined> {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return undefined
    const uri = file && nativeFileSource(file)
    const task: RestoreRecoveryTask = {
      version: 1,
      id: crypto.randomUUID(),
      kind: 'restore',
      name: file?.name ?? '恢复备份',
      phase: '预检',
      updatedAt: Date.now(),
      payload: {
        vaultEnabled,
        completed: [],
        source: file
          ? {
              uri: uri ?? '',
              name: file.name,
              size: nativeFileSize(file),
              hash: (await hashNativeFile(file, signal)) ?? (await hashBlob(file)),
            }
          : undefined,
      },
    }
    try {
      await this.store.save(task)
      return task
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIMPLEMENTED') return undefined
      throw error
    }
  }

  async readSource(task: RestoreRecoveryTask): Promise<File> {
    const source = task.payload.source
    if (!source) throw new Error('请重新选择原备份文件')
    if (!source.uri) {
      try {
        source.uri = await this.store.recoverSource(task.id, source.size, source.hash)
      } catch {
        throw new Error('原文件暂存尚未完成，请重新选择同一备份包继续预检')
      }
      await this.store.save(task)
    }
    // Recovery only needs a stable native source handle here. Do not pull a
    // multi-GB retained archive back into WebView memory just to recreate File.
    const file = rememberNativeFile(new File([], source.name), source.uri, source.size)
    if (((await hashNativeFile(file)) ?? (await hashBlob(file))) !== source.hash)
      throw new Error('备份原件已变化，不能继续旧任务')
    return file
  }

  async ensureSource(task: RestoreRecoveryTask, file: File, signal?: AbortSignal): Promise<void> {
    if (task.payload.source?.uri) return
    if (
      !task.payload.source ||
      nativeFileSize(file) !== task.payload.source.size ||
      ((await hashNativeFile(file, signal)) ?? (await hashBlob(file))) !== task.payload.source.hash
    )
      throw new Error('所选文件与原恢复任务不一致')
    task.phase = '保留备份原件'
    await this.store.save(task)
    const uri = await this.store.retainSource(task.id, file, task.payload.source.hash, signal)
    task.payload.source.uri = uri
    rememberNativeFile(file, uri)
    task.phase = '预检'
    await this.store.save(task)
  }

  async reselectSource(task: RestoreRecoveryTask, file: File): Promise<void> {
    const source = task.payload.source
    if (
      !source ||
      nativeFileSize(file) !== source.size ||
      ((await hashNativeFile(file)) ?? (await hashBlob(file))) !== source.hash
    )
      throw new Error('所选文件与原恢复任务不一致')
    source.uri = nativeFileSource(file) ?? ''
    await this.store.save(task)
    await this.ensureSource(task, file)
  }

  async savePrepared(task: RestoreRecoveryTask, prepared: PreparedRestore): Promise<void> {
    if (!prepared.staging) throw new Error('此恢复计划尚未保存文件检查点')
    // JSON keeps the plan, conflict IDs and scope, never native functions or file bodies.
    task.payload.prepared = JSON.parse(
      JSON.stringify(prepared, (key, value) =>
        key === 'originalBlob' || key === 'thumbnailBlob' || key === 'communitySourceAttachments'
          ? undefined
          : value,
      ),
    ) as PreparedRestore
    await this.store.save(task)
  }

  async step(
    task: RestoreRecoveryTask,
    key: string,
    action: () => void | Promise<void>,
  ): Promise<void> {
    if (task.payload.completed.includes(key)) return
    task.phase = key
    await this.store.save(task)
    await action()
    task.payload.completed.push(key)
    await this.store.save(task)
  }

  async baseline(resources: ResourceSummary[], categories: Category[]): Promise<string> {
    return hashBlob(
      new Blob([
        JSON.stringify({
          resources: resources
            .map((r) => [r.id, r.contentHash, r.updatedAt])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          categories: [...categories].sort((a, b) => a.id.localeCompare(b.id)),
        }),
      ]),
    )
  }
}
