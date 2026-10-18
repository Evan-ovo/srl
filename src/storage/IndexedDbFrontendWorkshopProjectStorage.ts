import type { AppDatabase } from '../database/AppDatabase'
import type {
  FrontendWorkshopProject,
  FrontendWorkshopProjectLastGoodRecord,
} from '../types/FrontendWorkshopProject'
import type { FrontendWorkshopSourceComponent } from '../types/FrontendWorkshopSourceComponent'
import type {
  FrontendWorkshopSourceDocument,
  FrontendWorkshopSourceDocumentLastGoodRecord,
} from '../types/FrontendWorkshopSourceDocument'
import {
  parseFrontendWorkshopBackup,
  type FrontendWorkshopBackup,
  type FrontendWorkshopProjectStorage,
} from './FrontendWorkshopProjectStorage'
import { canonicalizeFingerprintValue } from '../services/CloudBackupPolicy'
import { hashBytes } from '../services/HashService'

const MAINTENANCE_SETTING_PREFIX = 'frontend-workshop-maintenance:'

function cloneProject(project: FrontendWorkshopProject): FrontendWorkshopProject {
  return structuredClone(project)
}

function currentSourceDocument(
  value: FrontendWorkshopSourceDocument,
): FrontendWorkshopSourceDocument {
  const document = structuredClone(value) as FrontendWorkshopSourceDocument
  const raw = document as unknown as Record<string, unknown>
  if (raw.origin === 'legacy-advanced-source') raw.origin = 'imported'
  return document
}

function currentSourceComponent(
  value: FrontendWorkshopSourceComponent,
): FrontendWorkshopSourceComponent {
  const raw = structuredClone(value) as unknown as Record<string, unknown>
  delete raw.assets
  const component = raw as unknown as FrontendWorkshopSourceComponent
  component.projectIds = Array.from(
    new Set((Array.isArray(component.projectIds) ? component.projectIds : []).filter(Boolean)),
  )
  return component
}

export class IndexedDbFrontendWorkshopProjectStorage implements FrontendWorkshopProjectStorage {
  private readonly database: AppDatabase

  constructor(database: AppDatabase) {
    this.database = database
  }

  async exportPortableState(includeComponents = true): Promise<FrontendWorkshopBackup> {
    const d = this.database
    const data = await d.transaction(
      'r',
      [
        d.frontendWorkshopProjects,
        d.frontendWorkshopProjectLastGood,
        d.frontendWorkshopSourceDocuments,
        d.frontendWorkshopSourceDocumentLastGood,
        d.frontendWorkshopSourceComponents,
        d.settings,
      ],
      async () => ({
        version: 1 as const,
        projects: await d.frontendWorkshopProjects.toArray(),
        lastGood: await d.frontendWorkshopProjectLastGood.toArray(),
        documents: await d.frontendWorkshopSourceDocuments.toArray(),
        documentLastGood: await d.frontendWorkshopSourceDocumentLastGood.toArray(),
        components: includeComponents ? await d.frontendWorkshopSourceComponents.toArray() : [],
        sessions: await d.settings
          .where('id')
          .startsWith('frontend-workshop-ai-local:session:')
          .toArray(),
      }),
    )
    const ids = new Set([
      ...data.projects.map((row) => row.id),
      ...data.documents.map((row) => row.projectId),
      ...data.lastGood.map((row) => row.projectId),
      ...data.documentLastGood.map((row) => row.projectId),
    ])
    data.components = data.components.filter((row) => row.projectIds.some((id) => ids.has(id)))
    return data
  }

  async importPortableState(value: FrontendWorkshopBackup): Promise<void> {
    const equal = (a: unknown, b: unknown) =>
      JSON.stringify(canonicalizeFingerprintValue(a)) ===
      JSON.stringify(canonicalizeFingerprintValue(b))
    const copy = structuredClone(parseFrontendWorkshopBackup(value))
    const ids = new Set([
      ...copy.projects.map((row) => row.id),
      ...copy.documents.map((row) => row.projectId),
      ...copy.lastGood.map((row) => row.projectId),
      ...copy.documentLastGood.map((row) => row.projectId),
      ...copy.sessions.map((row) => row.id.slice('frontend-workshop-ai-local:session:'.length)),
    ])
    const original = await this.exportPortableState(false)
    const maps = new Map<string, string>()
    const groups = (data: FrontendWorkshopBackup) => {
      const result = new Map<string, Record<string, unknown>>()
      const add = (id: string, key: string, value: unknown) => {
        const row = result.get(id) ?? {}
        row[key] = value
        result.set(id, row)
      }
      for (const row of data.projects) add(row.id, 'project', row)
      for (const row of data.lastGood) add(row.projectId, 'lastGood', row)
      for (const row of data.documents) add(row.projectId, 'document', row)
      for (const row of data.documentLastGood) add(row.projectId, 'documentLastGood', row)
      for (const row of data.sessions)
        add(row.id.slice('frontend-workshop-ai-local:session:'.length), 'session', row)
      return result
    }
    const incomingGroups = groups(copy),
      localGroups = groups(original)
    for (const id of ids) {
      const incoming = incomingGroups.get(id) ?? {},
        local = localGroups.get(id) ?? {}
      if (Object.values(local).some(Boolean) && !equal(incoming, local)) {
        const digest = await hashBytes(
          new TextEncoder().encode(JSON.stringify(canonicalizeFingerprintValue(incoming))),
        )
        maps.set(id, `${id}-restored-${digest.slice(0, 16)}`)
      } else maps.set(id, id)
    }
    const mapped = (id: string) => maps.get(id) ?? id
    for (const project of copy.projects) {
      const old = project.id
      project.id = mapped(old)
      if (project.document?.id === old) project.document.id = project.id
    }
    for (const row of copy.lastGood) {
      row.id = mapped(row.id)
      row.projectId = mapped(row.projectId)
      const old = row.project.id
      row.project.id = row.projectId
      if (row.project.document?.id === old) row.project.document.id = row.projectId
    }
    for (const row of copy.documents) row.projectId = mapped(row.projectId)
    for (const row of copy.documentLastGood) {
      row.projectId = mapped(row.projectId)
      row.document.projectId = row.projectId
    }
    for (const row of copy.sessions) {
      row.id =
        'frontend-workshop-ai-local:session:' +
        mapped(row.id.slice('frontend-workshop-ai-local:session:'.length))
      const record = (
        row.value as
          | {
              data?: import('../services/FrontendWorkshopSourceAiRecovery').FrontendWorkshopSourceAiRecoveryRecord
            }
          | undefined
      )?.data
      if (record?.version === 1 && record.snapshot) {
        record.snapshot.projectId = mapped(record.snapshot.projectId)
        for (const anchor of record.anchors ?? []) anchor.projectId = mapped(anchor.projectId)
        for (const generation of record.snapshot.generations ?? []) {
          if (generation.bundle) {
            generation.bundle.projectId = mapped(generation.bundle.projectId)
            generation.bundle.writeScope.projectId = mapped(generation.bundle.writeScope.projectId)
          }
          if (generation.proposal)
            generation.proposal.projectId = mapped(generation.proposal.projectId)
        }
      }
    }
    const localComponents = new Map(
      (
        await this.database.frontendWorkshopSourceComponents.bulkGet(
          copy.components.map((row) => row.id),
        )
      )
        .filter((row) => row !== undefined)
        .map((row) => [row.id, row]),
    )
    const componentIds = new Map<string, string>(),
      fallbackComponentIds = new Map<string, string>()
    const dependents = new Map<string, typeof copy.components>()
    const references = (component: FrontendWorkshopSourceComponent) => [
      ...component.dependencies
        .filter((row) => row.kind === 'component')
        .map((row) => row.specifier),
      ...(component.provenance.sourceComponentId ? [component.provenance.sourceComponentId] : []),
    ]
    for (const component of copy.components) {
      component.projectIds = component.projectIds.map(mapped)
      if (component.provenance.projectId)
        component.provenance.projectId = mapped(component.provenance.projectId)
      const digest = await hashBytes(
        new TextEncoder().encode(JSON.stringify(canonicalizeFingerprintValue(component))),
      )
      const fallback = component.id + '-restored-' + digest.slice(0, 16)
      fallbackComponentIds.set(component.id, fallback)
      for (const id of references(component)) {
        const group = dependents.get(id) ?? []
        group.push(component)
        dependents.set(id, group)
      }
    }
    const reverseFallback = new Map(
      [...fallbackComponentIds].map(([id, fallback]) => [fallback, id]),
    )
    const remapReferences = (
      component: FrontendWorkshopSourceComponent,
      resolve: (id: string) => string,
    ) => {
      const result = structuredClone(component)
      for (const dependency of result.dependencies)
        if (dependency.kind === 'component') dependency.specifier = resolve(dependency.specifier)
      if (result.provenance.sourceComponentId)
        result.provenance.sourceComponentId = resolve(result.provenance.sourceComponentId)
      return result
    }
    for (const component of copy.components) {
      const current = localComponents.get(component.id)
      const normalized = current
        ? remapReferences(current, (id) => reverseFallback.get(id) ?? id)
        : undefined
      componentIds.set(
        component.id,
        current && !equal(normalized, component)
          ? fallbackComponentIds.get(component.id)!
          : component.id,
      )
    }
    const queue = [...copy.components]
    for (let index = 0; index < queue.length; index++) {
      const component = queue[index]!,
        current = localComponents.get(component.id)
      if (!current || componentIds.get(component.id) !== component.id) continue
      if (
        !equal(
          current,
          remapReferences(component, (id) => componentIds.get(id) ?? id),
        )
      ) {
        componentIds.set(component.id, fallbackComponentIds.get(component.id)!)
        queue.push(...(dependents.get(component.id) ?? []))
      }
    }
    for (const component of copy.components) {
      component.id = componentIds.get(component.id)!
      for (const dependency of component.dependencies)
        if (dependency.kind === 'component')
          dependency.specifier = componentIds.get(dependency.specifier) ?? dependency.specifier
      if (component.provenance.sourceComponentId)
        component.provenance.sourceComponentId =
          componentIds.get(component.provenance.sourceComponentId) ??
          component.provenance.sourceComponentId
    }
    const d = this.database
    const tables = [
      d.frontendWorkshopProjects,
      d.frontendWorkshopProjectLastGood,
      d.frontendWorkshopSourceDocuments,
      d.frontendWorkshopSourceDocumentLastGood,
      d.frontendWorkshopSourceComponents,
      d.settings,
    ]
    const rows = [
      copy.projects,
      copy.lastGood,
      copy.documents,
      copy.documentLastGood,
      copy.components,
      copy.sessions,
    ]
    await d.transaction('rw', tables, async () => {
      for (const [index, table] of tables.entries())
        for (const row of rows[index]!) {
          const key =
            index === 2 || index === 3
              ? (row as { projectId: string }).projectId
              : (row as { id: string }).id
          const current = await table.get(key)
          if (current && !equal(current, row))
            throw new Error('前端项目恢复期间目标发生变化，已保留现有资料')
          await table.put(row as never)
          if (!equal(await table.get(key), row)) throw new Error('前端项目保存后读回失败')
        }
    })
  }

  async list(): Promise<FrontendWorkshopProject[]> {
    const projects = await this.database.frontendWorkshopProjects
      .orderBy('updatedAt')
      .reverse()
      .toArray()
    return projects.map(cloneProject)
  }

  async get(id: string): Promise<FrontendWorkshopProject | undefined> {
    const project = await this.database.frontendWorkshopProjects.get(id)
    return project ? cloneProject(project) : undefined
  }

  async put(project: FrontendWorkshopProject): Promise<void> {
    await this.database.frontendWorkshopProjects.put(cloneProject(project))
  }

  async putAtomic(
    project: FrontendWorkshopProject,
    lastGood?: FrontendWorkshopProject,
  ): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.frontendWorkshopProjects,
      this.database.frontendWorkshopProjectLastGood,
      async () => {
        if (lastGood) {
          const record: FrontendWorkshopProjectLastGoodRecord = {
            id: lastGood.id,
            projectId: lastGood.id,
            project: cloneProject(lastGood),
            savedAt: Date.now(),
          }
          await this.database.frontendWorkshopProjectLastGood.put(record)
        }
        await this.database.frontendWorkshopProjects.put(cloneProject(project))
      },
    )
  }

  async getLastGood(id: string): Promise<FrontendWorkshopProjectLastGoodRecord | undefined> {
    const record = await this.database.frontendWorkshopProjectLastGood.get(id)
    return record ? { ...record, project: cloneProject(record.project) } : undefined
  }

  async hasMaintenanceMarker(id: string): Promise<boolean> {
    const record = await this.database.settings.get(`${MAINTENANCE_SETTING_PREFIX}${id}`)
    return record?.value === true
  }

  async setMaintenanceMarker(id: string): Promise<void> {
    await this.database.settings.put({
      id: `${MAINTENANCE_SETTING_PREFIX}${id}`,
      value: true,
      updatedAt: Date.now(),
    })
  }

  async cleanupLegacyAuxiliaryData(): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.frontendWorkshopSourceDocuments,
      this.database.frontendWorkshopSourceDocumentLastGood,
      this.database.frontendWorkshopSourceComponents,
      async () => {
        const sourceDocuments = await this.database.frontendWorkshopSourceDocuments.toArray()
        for (const sourceDocument of sourceDocuments) {
          const raw = sourceDocument as unknown as Record<string, unknown>
          if (raw.origin !== 'legacy-advanced-source') continue
          await this.database.frontendWorkshopSourceDocuments.put(
            currentSourceDocument(sourceDocument),
          )
        }

        const lastGoodDocuments =
          await this.database.frontendWorkshopSourceDocumentLastGood.toArray()
        for (const record of lastGoodDocuments) {
          const raw = record.document as unknown as Record<string, unknown>
          if (raw.origin !== 'legacy-advanced-source') continue
          const cleanedRecord: FrontendWorkshopSourceDocumentLastGoodRecord = {
            ...record,
            document: currentSourceDocument(record.document),
          }
          await this.database.frontendWorkshopSourceDocumentLastGood.put(cleanedRecord)
        }

        const components = await this.database.frontendWorkshopSourceComponents.toArray()
        for (const component of components) {
          const raw = component as unknown as Record<string, unknown>
          const hadLegacyAssets = Object.hasOwn(raw, 'assets')
          const cleaned = currentSourceComponent(component)
          const existingProjectIds = Array.isArray(component.projectIds) ? component.projectIds : []
          if (
            hadLegacyAssets ||
            cleaned.projectIds.length !== existingProjectIds.length ||
            cleaned.projectIds.some((projectId, index) => projectId !== existingProjectIds[index])
          ) {
            await this.database.frontendWorkshopSourceComponents.put(cleaned)
          }
        }
      },
    )
  }

  /**
   * Project 是 Source Document 的生命周期 owner。删除工程时在同一 Dexie transaction
   * 内清理结构化 current / last_good 与 raw Source current / last_good，避免留下孤儿真源。
   * 只有删除路径发生这种级联；普通 Project save/normalize 仍然不能触碰 Source Document。
   */
  async delete(id: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.frontendWorkshopProjects,
      this.database.frontendWorkshopProjectLastGood,
      this.database.frontendWorkshopSourceDocuments,
      this.database.frontendWorkshopSourceDocumentLastGood,
      this.database.settings,
      async () => {
        await Promise.all([
          this.database.settings.delete('frontend-workshop-ai-local:session:' + id),
          this.database.frontendWorkshopProjects.delete(id),
          this.database.frontendWorkshopProjectLastGood.delete(id),
          this.database.frontendWorkshopSourceDocuments.delete(id),
          this.database.frontendWorkshopSourceDocumentLastGood.delete(id),
        ])
      },
    )
  }
}
