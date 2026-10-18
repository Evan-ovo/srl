import type {
  FrontendWorkshopProject,
  FrontendWorkshopProjectLastGoodRecord,
} from '../types/FrontendWorkshopProject'
import { isRecord } from '../utils/UnknownValue'

export interface FrontendWorkshopBackup {
  version: 1
  projects: FrontendWorkshopProject[]
  lastGood: FrontendWorkshopProjectLastGoodRecord[]
  documents: import('../types/FrontendWorkshopSourceDocument').FrontendWorkshopSourceDocument[]
  documentLastGood: import('../types/FrontendWorkshopSourceDocument').FrontendWorkshopSourceDocumentLastGoodRecord[]
  components: import('../types/FrontendWorkshopSourceComponent').FrontendWorkshopSourceComponent[]
  sessions: import('../types/Resource').AppSetting[]
}

export function parseFrontendWorkshopBackup(value: unknown): FrontendWorkshopBackup {
  if (!isRecord(value) || value.version !== 1) throw new Error('前端项目备份格式无效')
  for (const key of [
    'projects',
    'lastGood',
    'documents',
    'documentLastGood',
    'components',
    'sessions',
  ]) {
    const rows = value[key]
    if (!Array.isArray(rows)) throw new Error('前端项目备份格式无效')
    const seen = new Set<string>()
    const identity = key === 'documents' || key === 'documentLastGood' ? 'projectId' : 'id'
    for (const row of rows) {
      if (
        !isRecord(row) ||
        typeof row[identity] !== 'string' ||
        !row[identity] ||
        seen.has(row[identity])
      )
        throw new Error('前端项目备份身份无效或重复')
      seen.add(row[identity])
    }
  }
  const data = value as unknown as FrontendWorkshopBackup
  for (const row of data.documents)
    if (typeof row.authorSource !== 'string') throw new Error('前端项目原始源码无效')
  for (const row of data.lastGood)
    if (!row.project || row.projectId !== row.project.id || row.id !== row.projectId)
      throw new Error('前端项目恢复版本身份无效')
  for (const row of data.documentLastGood)
    if (
      !row.document ||
      row.document.projectId !== row.projectId ||
      typeof row.document.authorSource !== 'string'
    )
      throw new Error('前端源码恢复版本无效')
  for (const row of data.components)
    if (
      !Array.isArray(row.projectIds) ||
      row.projectIds.some((id) => typeof id !== 'string') ||
      !row.provenance ||
      !row.source ||
      typeof row.source.html !== 'string'
    )
      throw new Error('前端组件收录记录无效')
  for (const row of data.sessions)
    if (
      !row.id.startsWith('frontend-workshop-ai-local:session:') ||
      !row.id.slice('frontend-workshop-ai-local:session:'.length)
    )
      throw new Error('前端项目会话引用无效')
  return data
}

export interface FrontendWorkshopProjectStorage {
  list(): Promise<FrontendWorkshopProject[]>
  get(id: string): Promise<FrontendWorkshopProject | undefined>
  put(project: FrontendWorkshopProject): Promise<void>
  putAtomic(project: FrontendWorkshopProject, lastGood?: FrontendWorkshopProject): Promise<void>
  getLastGood(id: string): Promise<FrontendWorkshopProjectLastGoodRecord | undefined>
  delete(id: string): Promise<void>
  /** Persistent idempotent marker: every production/test storage must guarantee one-shot maintenance. */
  hasMaintenanceMarker(id: string): Promise<boolean>
  setMaintenanceMarker(id: string): Promise<void>
  /** One-shot cleanup for retired Source/component metadata owned by the same FrontendWorkshop store. */
  cleanupLegacyAuxiliaryData(): Promise<void>
}
