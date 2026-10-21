import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import type { FrontendWorkshopSourceComponentStorage } from '../storage/FrontendWorkshopSourceComponentStorage'
import {
  createFrontendWorkshopSourceComponent,
  FRONTEND_WORKSHOP_SOURCE_COMPONENT_SCHEMA_VERSION,
  type FrontendWorkshopSourceComponent,
  type FrontendWorkshopSourceComponentDraft,
} from '../types/FrontendWorkshopSourceComponent'
import type { FrontendWorkshopSourceDocument } from '../types/FrontendWorkshopSourceDocument'
import {
  createFrontendWorkshopSourceComponentAiProjection,
  createFrontendWorkshopSourceComponentInsertionPatch,
  extractFrontendWorkshopSourceComponentHtml,
  readFrontendWorkshopSourceComponentAiProjection,
  type FrontendWorkshopSourceComponentSelection,
} from '../utils/FrontendWorkshopSourceComponent'
import type { FrontendWorkshopSourceAiContextBundle } from '../utils/FrontendWorkshopSourceAiContext'
import type { FrontendWorkshopSourceAiProposal } from '../utils/FrontendWorkshopSourceAiProposal'
import { applyFrontendWorkshopSourcePatch } from '../utils/FrontendWorkshopSourcePatch'
import { createFrontendWorkshopValidatedSourceAiPatch } from './FrontendWorkshopSourceAiApplicationService'
import {
  FrontendWorkshopSourceRevisionConflictError,
  type FrontendWorkshopSourceDocumentService,
} from './FrontendWorkshopSourceDocumentService'
import type { FrontendWorkshopSourceHistoryService } from './FrontendWorkshopSourceHistoryService'

export interface FrontendWorkshopSourceComponentSelectionDraft {
  name: string
  description?: string
  tags?: string[]
}

export interface FrontendWorkshopSourceComponentInsertionResult {
  document: FrontendWorkshopSourceDocument
  projectAssociationUpdated: boolean
}

export const FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_FORMAT =
  'srl.frontend-workshop.source-component' as const
export const FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_VERSION = 1 as const

export interface FrontendWorkshopSourceComponentPackageManifest {
  format: typeof FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_FORMAT
  packageVersion: typeof FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_VERSION
  exportedAt: number
  component: Omit<
    FrontendWorkshopSourceComponent,
    'id' | 'revision' | 'provenance' | 'projectIds' | 'createdAt' | 'updatedAt'
  >
}

export interface FrontendWorkshopSourceComponentPortablePackage {
  blob: Blob
  fileName: string
  manifest: FrontendWorkshopSourceComponentPackageManifest
}

const MAX_PORTABLE_PACKAGE_BYTES = 4 * 1024 * 1024
const MAX_PORTABLE_PACKAGE_EXTRACTED_BYTES = 8 * 1024 * 1024
const MAX_PORTABLE_PACKAGE_FILE_BYTES = 8 * 1024 * 1024
const MAX_PORTABLE_PACKAGE_FILES = 1

export class FrontendWorkshopSourceComponentRevisionConflictError extends Error {
  readonly componentId: string
  readonly expectedRevision: number
  readonly actualRevision?: number

  constructor(componentId: string, expectedRevision: number, actualRevision?: number) {
    super(
      `Source Component revision 已失效：期望 ${expectedRevision}，实际 ${actualRevision ?? 'missing'}`,
    )
    this.name = 'FrontendWorkshopSourceComponentRevisionConflictError'
    this.componentId = componentId
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

function assertId(id: string): void {
  if (!id.trim()) throw new Error('Source Component 缺少 id')
}

function normalizedName(name: string): string {
  const value = name.trim()
  if (!value) throw new Error('Source Component 名称不能为空')
  return value.slice(0, 120)
}

function normalizedTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean))).slice(0, 24)
}

function validateComponent(component: FrontendWorkshopSourceComponent): void {
  assertId(component.id)
  normalizedName(component.name)
  if (component.schemaVersion !== FRONTEND_WORKSHOP_SOURCE_COMPONENT_SCHEMA_VERSION) {
    throw new Error(`不支持的 Source Component schemaVersion：${component.schemaVersion}`)
  }
  if (!Number.isInteger(component.revision) || component.revision < 1) {
    throw new Error('Source Component revision 必须是正整数')
  }
  if (typeof component.source.html !== 'string' || !component.source.html) {
    throw new Error('Source Component HTML 不能为空')
  }
  if (typeof component.source.css !== 'string' || typeof component.source.javascript !== 'string') {
    throw new Error('Source Component CSS/JavaScript 必须是字符串')
  }
  if (!/^[a-z][a-z0-9:._-]*$/iu.test(component.root.tagName)) {
    throw new Error('Source Component root tagName 无效')
  }
  if (
    typeof component.description !== 'string' ||
    !Array.isArray(component.tags) ||
    component.tags.some((tag) => typeof tag !== 'string')
  ) {
    throw new Error('Source Component 描述或标签无效')
  }
  if (
    !Array.isArray(component.dependencies) ||
    component.dependencies.some(
      (dependency) =>
        !dependency ||
        !['external-resource', 'host-api', 'component'].includes(dependency.kind) ||
        typeof dependency.specifier !== 'string' ||
        !dependency.specifier.trim() ||
        (dependency.optional !== undefined && typeof dependency.optional !== 'boolean'),
    )
  ) {
    throw new Error('Source Component dependency 无效')
  }
  for (const dependency of component.dependencies) {
    if (
      dependency.kind === 'external-resource' &&
      !/^https:\/\//iu.test(dependency.specifier.trim())
    ) {
      throw new Error('Source Component external-resource 必须使用 HTTPS')
    }
  }
  if (
    component.runtimeRequirements.hostProfile !== 'tavern-helper-message' ||
    typeof component.runtimeRequirements.requiresJavaScript !== 'boolean' ||
    typeof component.runtimeRequirements.requiresNetwork !== 'boolean' ||
    !Array.isArray(component.runtimeRequirements.hostApis) ||
    component.runtimeRequirements.hostApis.some((api) => typeof api !== 'string')
  ) {
    throw new Error('Source Component runtime requirements 无效')
  }
  if (
    !['unspecified', 'private', 'cc0', 'cc-by-4.0', 'mit', 'custom'].includes(
      component.sharePolicy.license,
    ) ||
    typeof component.sharePolicy.allowShare !== 'boolean' ||
    typeof component.sharePolicy.allowDerivatives !== 'boolean' ||
    (component.sharePolicy.notice !== undefined &&
      typeof component.sharePolicy.notice !== 'string') ||
    (component.sharePolicy.license === 'private' && component.sharePolicy.allowShare) ||
    (component.sharePolicy.license === 'custom' &&
      component.sharePolicy.allowShare &&
      !component.sharePolicy.notice?.trim())
  ) {
    throw new Error('Source Component license / share policy 无效')
  }
  if (
    !Number.isInteger(component.preview.viewportWidth) ||
    component.preview.viewportWidth < 240 ||
    component.preview.viewportWidth > 3840 ||
    !['auto', 'light', 'dark'].includes(component.preview.colorScheme)
  ) {
    throw new Error('Source Component preview 设置无效')
  }
}

function selectorForElementId(elementId: string | undefined): string | undefined {
  return elementId && /^[a-z_][a-z0-9_-]*$/iu.test(elementId) ? `#${elementId}` : undefined
}

function cloneComponent(
  component: FrontendWorkshopSourceComponent,
): FrontendWorkshopSourceComponent {
  return structuredClone(component)
}

function portablePackageFileName(name: string): string {
  const safeName = name
    .replace(/[\\/:*?"<>|]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  return `${safeName || 'Source Component'}.srlcomponent.zip`
}

function unpackPortablePackage(bytes: Uint8Array): Record<string, Uint8Array> {
  let fileCount = 0
  let totalBytes = 0
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        if (file.name !== 'component.json') {
          throw new Error('组件包包含旧二进制素材或未声明文件；当前版本只接受 component.json')
        }
        fileCount += 1
        totalBytes += file.originalSize
        if (fileCount > MAX_PORTABLE_PACKAGE_FILES) throw new Error('组件包文件数量超过限制')
        if (file.originalSize > MAX_PORTABLE_PACKAGE_FILE_BYTES) {
          throw new Error('组件包包含过大的文件')
        }
        if (totalBytes > MAX_PORTABLE_PACKAGE_EXTRACTED_BYTES) {
          throw new Error('组件包解压后的内容超过限制')
        }
        if (file.compression !== 0 && file.compression !== 8) {
          throw new Error('组件包使用了不支持的压缩算法')
        }
        return true
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('组件包')) throw error
    throw new Error('无法读取 Source Component 组件包', { cause: error })
  }
}

function parsePortablePackageManifest(
  bytes: Uint8Array | undefined,
  now: number,
): FrontendWorkshopSourceComponentPackageManifest {
  if (!bytes) throw new Error('组件包缺少 component.json')
  let candidate: unknown
  try {
    candidate = JSON.parse(strFromU8(bytes))
  } catch {
    throw new Error('组件包 component.json 不是有效 JSON')
  }
  if (!candidate || typeof candidate !== 'object') throw new Error('组件包 manifest 无效')
  const manifest = candidate as Record<string, unknown>
  if (manifest.format !== FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_FORMAT) {
    throw new Error('组件包 format 不受支持')
  }
  if (manifest.packageVersion !== FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_VERSION) {
    throw new Error(`组件包版本不受支持：${String(manifest.packageVersion)}`)
  }
  if (!Number.isFinite(manifest.exportedAt)) throw new Error('组件包 exportedAt 无效')
  if ('assets' in manifest) {
    throw new Error('旧二进制 Source Component 组件包不再支持，请重新导出当前格式')
  }
  if (!manifest.component || typeof manifest.component !== 'object') {
    throw new Error('组件包缺少 Source Component metadata')
  }
  const packagedComponent =
    manifest.component as FrontendWorkshopSourceComponentPackageManifest['component']
  if ('assets' in (packagedComponent as unknown as Record<string, unknown>)) {
    throw new Error('旧 Source Component assets 字段不再支持')
  }
  const validationComponent = createFrontendWorkshopSourceComponent(
    {
      ...packagedComponent,
      provenance: { origin: 'imported' },
      projectIds: [],
    },
    'package-validation',
    now,
  )
  validateComponent(validationComponent)
  return manifest as unknown as FrontendWorkshopSourceComponentPackageManifest
}

/** S8 personal Source Component application owner. */
export class FrontendWorkshopSourceComponentService {
  private readonly storage: FrontendWorkshopSourceComponentStorage
  private readonly sourceDocumentService: FrontendWorkshopSourceDocumentService
  private readonly sourceHistoryService: FrontendWorkshopSourceHistoryService

  constructor(
    storage: FrontendWorkshopSourceComponentStorage,
    sourceDocumentService: FrontendWorkshopSourceDocumentService,
    sourceHistoryService: FrontendWorkshopSourceHistoryService,
  ) {
    this.storage = storage
    this.sourceDocumentService = sourceDocumentService
    this.sourceHistoryService = sourceHistoryService
  }

  async list(): Promise<FrontendWorkshopSourceComponent[]> {
    return this.storage.list()
  }

  async exportPortableState(): Promise<FrontendWorkshopSourceComponent[]> {
    return (await this.list()).map((component) => ({
      ...cloneComponent(component),
      projectIds: [],
    }))
  }

  async importPortableState(components: readonly FrontendWorkshopSourceComponent[]): Promise<void> {
    if (!Array.isArray(components)) throw new Error('Source Component 备份格式无效')
    for (const component of components) {
      const current = await this.storage.get(component.id)
      if (current) continue
      const portable = {
        ...cloneComponent(component),
        projectIds: [],
      }
      validateComponent(portable)
      const saved = await this.storage.putIfRevision(portable, 0)
      if (!saved) throw new Error(`Source Component 恢复冲突：${component.name}`)
    }
  }

  async listForProject(projectId: string): Promise<FrontendWorkshopSourceComponent[]> {
    assertId(projectId)
    return (await this.storage.list()).filter((component) =>
      component.projectIds.includes(projectId),
    )
  }

  async get(id: string): Promise<FrontendWorkshopSourceComponent | undefined> {
    assertId(id)
    return this.storage.get(id)
  }

  async create(
    draft: FrontendWorkshopSourceComponentDraft,
    options: { id?: string; now?: number } = {},
  ): Promise<FrontendWorkshopSourceComponent> {
    const component = createFrontendWorkshopSourceComponent(
      { ...draft, name: normalizedName(draft.name), tags: normalizedTags(draft.tags ?? []) },
      options.id,
      options.now,
    )
    validateComponent(component)
    const saved = await this.storage.putIfRevision(component, 0)
    if (!saved) {
      const current = await this.storage.get(component.id)
      throw new FrontendWorkshopSourceComponentRevisionConflictError(
        component.id,
        0,
        current?.revision,
      )
    }
    return cloneComponent(component)
  }

  async createFromSelection(
    source: FrontendWorkshopSourceDocument,
    selection: FrontendWorkshopSourceComponentSelection,
    draft: FrontendWorkshopSourceComponentSelectionDraft,
    options: { id?: string; now?: number } = {},
  ): Promise<FrontendWorkshopSourceComponent> {
    const current = await this.sourceDocumentService.get(source.projectId)
    if (!current || current.revision !== source.revision) {
      throw new FrontendWorkshopSourceRevisionConflictError(
        source.projectId,
        source.revision,
        current?.revision,
      )
    }
    const extracted = extractFrontendWorkshopSourceComponentHtml(current, selection)
    const selector = selectorForElementId(selection.elementId)
    return this.create(
      {
        name: draft.name,
        description: draft.description,
        tags: draft.tags,
        source: { html: extracted.html, css: '', javascript: '' },
        root: { tagName: extracted.tagName, ...(selector ? { selector } : {}) },
        provenance: {
          origin: 'project-selection',
          projectId: current.projectId,
          sourceRevision: current.revision,
          sourceRange: extracted.range,
        },
        projectIds: [current.projectId],
      },
      options,
    )
  }

  async updateAtRevision(
    component: FrontendWorkshopSourceComponent,
    expectedRevision: number,
    now = Date.now(),
  ): Promise<FrontendWorkshopSourceComponent> {
    assertId(component.id)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Source Component expectedRevision 必须是正整数')
    }
    const current = await this.storage.get(component.id)
    if (
      !current ||
      current.revision !== expectedRevision ||
      component.revision !== expectedRevision
    ) {
      throw new FrontendWorkshopSourceComponentRevisionConflictError(
        component.id,
        expectedRevision,
        current?.revision,
      )
    }
    const next: FrontendWorkshopSourceComponent = {
      ...cloneComponent(component),
      schemaVersion: FRONTEND_WORKSHOP_SOURCE_COMPONENT_SCHEMA_VERSION,
      revision: expectedRevision + 1,
      name: normalizedName(component.name),
      tags: normalizedTags(component.tags),
      createdAt: current.createdAt,
      updatedAt: now,
    }
    validateComponent(next)
    const saved = await this.storage.putIfRevision(next, expectedRevision)
    if (!saved) {
      const latest = await this.storage.get(component.id)
      throw new FrontendWorkshopSourceComponentRevisionConflictError(
        component.id,
        expectedRevision,
        latest?.revision,
      )
    }
    return cloneComponent(next)
  }

  async createFromAiProposal(
    base: FrontendWorkshopSourceComponent,
    bundle: FrontendWorkshopSourceAiContextBundle,
    proposal: FrontendWorkshopSourceAiProposal,
    options: { id?: string; now?: number } = {},
  ): Promise<FrontendWorkshopSourceComponent> {
    const projection = createFrontendWorkshopSourceComponentAiProjection(base)
    const patch = createFrontendWorkshopValidatedSourceAiPatch(
      projection.document,
      bundle,
      proposal,
    )
    const projected = readFrontendWorkshopSourceComponentAiProjection(
      base,
      applyFrontendWorkshopSourcePatch(projection.document, patch),
    )
    return this.create(
      {
        name: base.name,
        description: base.description,
        tags: base.tags,
        source: projected.source,
        root: projected.root,
        dependencies: base.dependencies,
        runtimeRequirements: base.runtimeRequirements,
        provenance: { origin: 'ai' },
        sharePolicy: base.sharePolicy,
        preview: base.preview,
        projectIds: [],
      },
      options,
    )
  }

  async applyAiProposalAtRevision(
    componentId: string,
    expectedRevision: number,
    bundle: FrontendWorkshopSourceAiContextBundle,
    proposal: FrontendWorkshopSourceAiProposal,
    now = Date.now(),
  ): Promise<FrontendWorkshopSourceComponent> {
    const current = await this.getAtRevision(componentId, expectedRevision)
    const projection = createFrontendWorkshopSourceComponentAiProjection(current)
    const patch = createFrontendWorkshopValidatedSourceAiPatch(
      projection.document,
      bundle,
      proposal,
    )
    const projected = readFrontendWorkshopSourceComponentAiProjection(
      current,
      applyFrontendWorkshopSourcePatch(projection.document, patch),
    )
    return this.updateAtRevision(
      { ...current, source: projected.source, root: projected.root },
      expectedRevision,
      now,
    )
  }

  private async getAtRevision(
    id: string,
    expectedRevision: number,
  ): Promise<FrontendWorkshopSourceComponent> {
    assertId(id)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Source Component expectedRevision 必须是正整数')
    }
    const current = await this.storage.get(id)
    if (!current || current.revision !== expectedRevision) {
      throw new FrontendWorkshopSourceComponentRevisionConflictError(
        id,
        expectedRevision,
        current?.revision,
      )
    }
    return current
  }

  async createPortablePackage(
    componentId: string,
    now = Date.now(),
  ): Promise<FrontendWorkshopSourceComponentPortablePackage> {
    const component = await this.get(componentId)
    if (!component) throw new Error('要导出的 Source Component 不存在')
    return this.createPortablePackageFromComponent(component, now)
  }

  async createPortablePackageAtRevision(
    componentId: string,
    expectedRevision: number,
    now = Date.now(),
  ): Promise<FrontendWorkshopSourceComponentPortablePackage> {
    const component = await this.getAtRevision(componentId, expectedRevision)
    return this.createPortablePackageFromComponent(component, now)
  }

  private async createPortablePackageFromComponent(
    component: FrontendWorkshopSourceComponent,
    now: number,
  ): Promise<FrontendWorkshopSourceComponentPortablePackage> {
    const manifest: FrontendWorkshopSourceComponentPackageManifest = {
      format: FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_FORMAT,
      packageVersion: FRONTEND_WORKSHOP_SOURCE_COMPONENT_PACKAGE_VERSION,
      exportedAt: now,
      component: {
        schemaVersion: component.schemaVersion,
        name: component.name,
        description: component.description,
        tags: [...component.tags],
        source: { ...component.source },
        root: { ...component.root },
        dependencies: component.dependencies.map((dependency) => ({ ...dependency })),
        runtimeRequirements: {
          ...component.runtimeRequirements,
          hostApis: [...component.runtimeRequirements.hostApis],
        },
        sharePolicy: { ...component.sharePolicy },
        preview: { ...component.preview },
      },
    }
    const files: Record<string, Uint8Array> = {
      'component.json': strToU8(JSON.stringify(manifest, null, 2)),
    }
    return {
      blob: new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }),
      fileName: portablePackageFileName(component.name),
      manifest,
    }
  }

  async importPortablePackage(
    blob: Blob,
    options: {
      id?: string
      now?: number
    } = {},
  ): Promise<FrontendWorkshopSourceComponent> {
    if (!(blob instanceof Blob) || blob.size < 1) throw new Error('组件包文件不能为空')
    if (blob.size > MAX_PORTABLE_PACKAGE_BYTES) throw new Error('组件包文件超过 4 MiB 限制')
    const now = options.now ?? Date.now()
    const files = unpackPortablePackage(new Uint8Array(await blob.arrayBuffer()))
    if (Object.keys(files).length !== 1 || !files['component.json']) {
      throw new Error('组件包必须且只能包含 component.json')
    }
    const manifest = parsePortablePackageManifest(files['component.json'], now)
    const draft: FrontendWorkshopSourceComponentDraft = {
      ...manifest.component,
      provenance: {
        origin: 'imported',
      },
      projectIds: [],
    }
    return this.create(draft, { id: options.id, now })
  }

  async duplicate(
    id: string,
    options: { id?: string; name?: string; now?: number } = {},
  ): Promise<FrontendWorkshopSourceComponent> {
    const source = await this.get(id)
    if (!source) throw new Error('要复制的 Source Component 不存在')
    return this.create(
      {
        name: options.name ?? `${source.name} 副本`,
        description: source.description,
        tags: source.tags,
        source: source.source,
        root: source.root,
        dependencies: source.dependencies,
        runtimeRequirements: source.runtimeRequirements,
        provenance: { origin: 'derived', sourceComponentId: source.id },
        sharePolicy: source.sharePolicy,
        preview: source.preview,
        projectIds: [],
      },
      options,
    )
  }

  async insertIntoProject(
    componentId: string,
    projectId: string,
    expectedSourceRevision: number,
  ): Promise<FrontendWorkshopSourceComponentInsertionResult> {
    const [component, source] = await Promise.all([
      this.get(componentId),
      this.sourceDocumentService.get(projectId),
    ])
    if (!component) throw new Error('要插入的 Source Component 不存在')
    if (!source || source.revision !== expectedSourceRevision) {
      throw new Error('当前 Source revision 已变化，请重新打开组件库后再插入')
    }
    const applied = await this.sourceHistoryService.applyAndRecord(
      createFrontendWorkshopSourceComponentInsertionPatch(source, component),
      { label: `插入组件：${component.name}` },
    )
    let projectAssociationUpdated = false
    try {
      projectAssociationUpdated = Boolean(
        await this.storage.setProjectAssociation(component.id, projectId, true),
      )
    } catch {
      // Source 已通过 History/Patch/CAS 接受；项目收录失败不能把已落盘 revision 伪装成失败。
    }
    return { document: applied.document, projectAssociationUpdated }
  }

  async removeFromProject(
    componentId: string,
    projectId: string,
  ): Promise<FrontendWorkshopSourceComponent> {
    assertId(componentId)
    assertId(projectId)
    const updated = await this.storage.setProjectAssociation(componentId, projectId, false)
    if (!updated) throw new Error('要移出当前项目的 Source Component 不存在')
    return updated
  }

  async delete(id: string): Promise<void> {
    assertId(id)
    await this.storage.delete(id)
  }
}
