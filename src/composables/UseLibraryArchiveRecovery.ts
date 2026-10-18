import { requestWebBackgroundAudio } from '../services/WebBackgroundKeepAlive'
import type { LibraryArchiveContext } from './UseLibraryArchive'
import type { RestoreRecoveryTask, ExportRecoveryTask } from '../services/ArchiveRecoveryService'

import { discardCheckpointArchive } from '../core/NativeArchiveExport'

import { noticeCenter } from '../core/NoticeCenter'

import { confirmAction } from '../composables/UseConfirmDialog'

import {
  archiveRecoveryService,
  initializeVaultOnce,
  vaultService,
  restoreService,
} from '../core/LibraryContainer'

import { mutationGuard } from '../core/MutationGuard'

import type { ArchivePortableSelection, PreparedRestore, RestoreMode } from '../types/Backup'

export interface UseLibraryArchiveRecoveryContext {
  recovering: Set<string>
  getContext: () => LibraryArchiveContext
  performExport: (
    details: {
      mode: 'full' | 'partial'
      resourceIds?: string[]
      includeAllCategories?: boolean
      splitSizeBytes?: number
      resourceContent: 'original' | 'modified'
      portableSelection: ArchivePortableSelection
    },
    resumed?: ExportRecoveryTask,
  ) => Promise<void>
  resumeRestoreTask: (id: string) => Promise<void>
  restoreRecovery: RestoreRecoveryTask | undefined
  handleRestoreInspect: (file: File, recovery?: RestoreRecoveryTask) => Promise<void>
  performRestoreConfirm: (
    prepared: PreparedRestore,
    mode: RestoreMode,
    resumed?: RestoreRecoveryTask,
  ) => Promise<void>
}
export function offerExportRecovery(
  operations: UseLibraryArchiveRecoveryContext,
  task: ExportRecoveryTask,
): void {
  noticeCenter.push({
    id: `archive:${task.id}`,
    type: 'info',
    persistent: true,
    message: `导出任务待继续：${task.name}`,
    details: '已压缩文件会校验后复用；尚未压缩的资源若已变化，会停止并提示重新导出。',
    actions: [
      {
        label: '继续导出',
        run: async () => {
          if (operations.recovering.has(task.id) || operations.getContext().isExporting.value)
            return
          operations.recovering.add(task.id)
          try {
            await initializeVaultOnce()
            if (vaultService.getStatus().locked) throw new Error('请先解锁资源库，再继续导出')
            const saved = (await archiveRecoveryService.store.read(task.id)) as
              ExportRecoveryTask | undefined
            if (!saved) return
            if (saved.phase === '完成') {
              await discardCheckpointArchive(saved.id)
              await archiveRecoveryService.store.remove(saved.id)
              noticeCenter.dismiss(`archive:${saved.id}`)
              return
            }
            if (saved.payload.vaultEnabled !== vaultService.isEnabled())
              throw new Error('加密状态已变化，请放弃旧任务后重新导出')
            noticeCenter.dismiss(`archive:${saved.id}`)
            await mutationGuard.run('archive:export', () =>
              operations.performExport(
                {
                  ...saved.payload.options,
                  resourceContent: saved.payload.options.resourceContent ?? 'original',
                  portableSelection: saved.payload.options.portableSelection ?? {},
                },
                saved,
              ),
            )
          } catch (error) {
            operations
              .getContext()
              .showNotice(error instanceof Error ? error.message : '无法继续导出')
          } finally {
            operations.recovering.delete(task.id)
          }
        },
      },
      {
        label: '放弃任务',
        run: async () => {
          if (operations.recovering.has(task.id) || operations.getContext().isExporting.value)
            return
          if (
            !(await confirmAction({
              title: '放弃导出任务',
              message: '清理压缩检查点和未完成的目标文件，已经保存成功的备份会保留。',
              confirmLabel: '放弃任务',
            }))
          )
            return
          await discardCheckpointArchive(task.id)
          await archiveRecoveryService.store.remove(task.id)
          noticeCenter.dismiss(`archive:${task.id}`)
        },
      },
    ],
  })
}

export function offerRestoreRecovery(
  operations: UseLibraryArchiveRecoveryContext,
  task: RestoreRecoveryTask,
): void {
  noticeCenter.push({
    id: `archive:${task.id}`,
    type: 'info',
    persistent: true,
    message: `恢复任务待继续：${task.name}`,
    details: `已保存进度：${task.phase}。继续前会核对文件及资源库状态。`,
    actions: [
      { label: '继续恢复', run: () => operations.resumeRestoreTask(task.id) },
      {
        label: '放弃任务',
        run: async () => {
          const context = operations.getContext()
          if (operations.recovering.size || context.isRestoring.value) return
          context.isRestoring.value = true
          try {
            if (
              !(await confirmAction({
                title: '放弃恢复任务',
                message: '删除此任务的临时文件和检查点，已写入的资源和原始备份不会删除。',
                confirmLabel: '放弃任务',
              }))
            )
              return
            if (task.payload.prepared)
              await restoreService.revivePrepared(task.payload.prepared).dispose?.()
            await restoreService.clearRestoreCheckpoint(task.id)
            await archiveRecoveryService.store.remove(task.id)
            if (operations.restoreRecovery?.id === task.id) operations.restoreRecovery = undefined
            noticeCenter.dismiss(`archive:${task.id}`)
          } finally {
            context.isRestoring.value = false
          }
        },
      },
    ],
  })
}

export async function resumeRestoreTask(
  operations: UseLibraryArchiveRecoveryContext,
  id: string,
): Promise<void> {
  const context = operations.getContext()
  if (operations.recovering.size || context.isRestoring.value) return
  operations.recovering.add(id)
  let ownsRestoreBusy = false
  let releaseAudio = () => undefined as void
  try {
    releaseAudio = await requestWebBackgroundAudio('继续导入备份')
    await initializeVaultOnce()
    const task = (await archiveRecoveryService.store.read(id)) as RestoreRecoveryTask | undefined
    if (!task || task.kind !== 'restore') return
    if (vaultService.getStatus().locked) throw new Error('请先解锁资源库，再继续恢复任务')
    if (task.payload.vaultEnabled !== vaultService.isEnabled())
      throw new Error('资源库加密状态已变化，请放弃旧任务并重新预检')
    if (task.phase === '完成') {
      if (task.payload.prepared)
        await restoreService.revivePrepared(task.payload.prepared).dispose?.()
      await restoreService.clearRestoreCheckpoint(task.id)
      await archiveRecoveryService.store.remove(task.id)
      noticeCenter.dismiss(`archive:${id}`)
      return
    }
    operations.restoreRecovery = task
    context.isRestorePanelOpen.value = true
    context.restoreReport.value = undefined
    if (!task.payload.prepared || !task.payload.mode) {
      // Before confirmation, rebuild conflict/replacement plans against the current library.
      // Verified extraction entries are reused, but serialized closures cannot be revived.
      await context.loadLibrary()
      await operations.handleRestoreInspect(await archiveRecoveryService.readSource(task), task)
      return
    }
    context.isRestoring.value = true
    ownsRestoreBusy = true
    const prepared = await restoreService.resumePrepared(task.payload.prepared)
    context.preparedRestore.value = prepared
    await context.loadLibrary()
    if (
      !(await restoreService.isRestoreCommitted(task.id)) &&
      task.payload.baseline !==
        (await archiveRecoveryService.baseline(context.resources.value, context.categories.value))
    ) {
      throw new Error('资源库在中断后发生变化；为避免覆盖新修改，请放弃此任务并重新预检备份')
    }
    if (
      !(await confirmAction({
        title: '继续恢复备份',
        message: `继续“${task.name}”的${task.payload.mode === 'replace' ? '整库覆盖' : '安全新增'}任务。已提交的资源不会重复写入，未完成的设置将继续恢复。`,
        confirmLabel: '继续恢复',
        danger: task.payload.mode === 'replace',
      }))
    )
      return
    noticeCenter.dismiss(`archive:${id}`)
    await mutationGuard.run(`archive:restore:${task.payload.mode}`, () =>
      operations.performRestoreConfirm(prepared, task.payload.mode!, task),
    )
  } catch (error) {
    operations.getContext().showNotice(error instanceof Error ? error.message : '恢复任务无法继续')
  } finally {
    releaseAudio()
    if (ownsRestoreBusy) context.isRestoring.value = false
    operations.recovering.delete(id)
  }
}
