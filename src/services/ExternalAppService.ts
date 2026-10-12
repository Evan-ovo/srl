import { toRaw } from 'vue'
import { CHAT_READER_APP_ID } from '../core/ChatReaderIdentity'
import { strToU8, zipSync } from 'fflate'
import {
  EXTERNAL_APP_PERMISSION,
  EXTERNAL_APP_RUNTIME_MODE,
  EXTERNAL_APP_SCHEMA_VERSION,
  EXTERNAL_APP_SDK_VERSION,
  externalAppDataId,
  getExternalAppPermissionLevel,
  getGrantedExternalAppPermissions,
  type ExternalAppPreview,
  type ExternalAppManifest,
  type ExternalAppPermission,
  type ExternalAppPermissionAuditEntry,
  type ExternalAppRuntimeMode,
  type ExternalAppDataRecord,
  type ExternalAppHealth,
  type InstalledExternalAppSummary,
  type InstalledExternalApp,
  type RetainedExternalAppData,
} from '../types/ExternalApp'
import type { ExternalAppStorageAdapter } from '../storage/ExternalAppStorageAdapter'
import {
  type ExternalAppInstallInput,
  readText,
  normalizeManifest,
  fingerprintFiles,
  filesFromInput,
} from './ExternalAppPackage'
import {
  iconDataUrl,
  buildRuntimeHtml,
  inspectCompatibility,
  RUNTIME_BRIDGE_MARKER,
} from './ExternalAppRuntime'

const MAX_APP_DATA_VALUE_BYTES = 100 * 1024

const MAX_APP_DATA_BYTES = 1024 * 1024

const MAX_DIAGNOSTIC_LENGTH = 500

import { TEXT_ENCODER } from './ExternalAppPackage'
import { describeExternalAppTools } from './ExternalAppTools'

function normalizeDataKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || key.length > 120 || key.includes('\u0000')) throw new Error('APP 存储键无效')
  return key
}

function cloneJsonValue(value: unknown): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error('APP 存储内容必须是可序列化数据')
  }
  if (encoded === undefined) throw new Error('APP 存储内容必须是可序列化数据')
  if (TEXT_ENCODER.encode(encoded).byteLength > MAX_APP_DATA_VALUE_BYTES) {
    throw new Error('单条 APP 存储内容超过限制')
  }
  return JSON.parse(encoded) as unknown
}

function byteLength(value: unknown): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength
}

export class ExternalAppService {
  private builtinReaderPreview?: ExternalAppPreview

  /** Called only by the build-shipped reader entry after normal package inspection. */
  registerBuiltinReader(preview: ExternalAppPreview): void {
    if (preview.manifest.id !== CHAT_READER_APP_ID) throw new Error('内置读了么身份无效')
    this.builtinReaderPreview = preview
  }

  isBuiltinReader(app: InstalledExternalApp): boolean {
    const preview = this.builtinReaderPreview
    return Boolean(
      preview &&
      app.id === CHAT_READER_APP_ID &&
      app.enabled &&
      app.runtimeMode === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE &&
      app.packageFingerprint === preview.packageFingerprint &&
      app.runtimeHtml === preview.compatibleRuntimeHtml,
    )
  }
  private readonly storage: ExternalAppStorageAdapter

  constructor(storage: ExternalAppStorageAdapter) {
    this.storage = storage
  }

  async list(): Promise<InstalledExternalAppSummary[]> {
    return (await this.storage.list()).filter((app) => app.id !== CHAT_READER_APP_ID)
  }

  /** The manifest is the registry; no parallel tool database or source copy. */
  async listCustomTools(query = '', offset = 0) {
    if (query.length > 80 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('工具检索参数无效')
    const keyword = query.trim().toLocaleLowerCase()
    const items: ReturnType<typeof describeExternalAppTools> = []
    let total = 0
    for (const app of await this.list()) {
      for (const item of describeExternalAppTools(app)) {
        if (
          keyword &&
          ![item.appName, item.title, item.name, item.description].some((part) =>
            part.toLocaleLowerCase().includes(keyword),
          )
        )
          continue
        if (total >= offset && items.length < 20) items.push(item)
        total++
      }
    }
    return {
      items,
      total,
      nextOffset: offset + items.length < total ? offset + items.length : null,
    }
  }

  async requireCustomTool(id: string, fingerprint: string) {
    const separator = id.lastIndexOf('/')
    const appId = id.slice(0, separator)
    if (separator < 1 || appId === CHAT_READER_APP_ID) throw new Error('自定义工具标识无效')
    const app = await this.storage.getSummary(appId)
    const tool = app && describeExternalAppTools(app).find((item) => item.id === id)
    if (!tool) throw new Error('自定义工具已移除，请重新查询')
    if (tool.fingerprint !== fingerprint) throw new Error('工具安装版本已变化，请重新查询并确认')
    if (!tool.available) throw new Error(tool.unavailableReason)
    return tool
  }

  async exportPortableState(): Promise<{
    apps: InstalledExternalApp[]
    data: ExternalAppDataRecord[]
  }> {
    const summaries = await this.list()
    const apps = (await Promise.all(summaries.map((app) => this.storage.get(app.id)))).filter(
      (app): app is InstalledExternalApp => Boolean(app),
    )
    const dataAppIds = this.storage.listDataAppIds
      ? await this.storage.listDataAppIds()
      : apps.map((app) => app.id)
    const data = (
      await Promise.all(
        dataAppIds
          .filter((id) => id !== CHAT_READER_APP_ID)
          .map((appId) => this.storage.listData(appId)),
      )
    ).flat()
    return { apps, data }
  }

  async exportReaderData(): Promise<ExternalAppDataRecord[]> {
    return this.storage.listData(CHAT_READER_APP_ID)
  }

  async importReaderData(data: ExternalAppDataRecord[]): Promise<void> {
    await this.importPortableState({
      apps: [],
      data: data.filter((record) => record.appId === CHAT_READER_APP_ID),
    })
  }

  async importPortableState(value: {
    apps: InstalledExternalApp[]
    data: ExternalAppDataRecord[]
  }): Promise<void> {
    const apps = Array.isArray(value?.apps) ? value.apps : []
    for (const app of apps) {
      const manifest = normalizeManifest(app?.manifest)
      if (!app.runtimeHtml || typeof app.runtimeHtml !== 'string') continue
      await this.storage.save({
        id: manifest.id,
        manifest,
        runtimeHtml: app.runtimeHtml,
        ...(app.packageFiles ? { packageFiles: app.packageFiles } : {}),
        ...(app.iconDataUrl ? { iconDataUrl: app.iconDataUrl } : {}),
        allowedPermissions: getGrantedExternalAppPermissions(app),
        grantedPermissions: [],
        packageFingerprint: app.packageFingerprint,
        runtimeMode: app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED,
        persistentPermissionGrants: [],
        permissionAudit: [],
        enabled: false,
        installedAt: Number.isFinite(app.installedAt) ? app.installedAt : Date.now(),
        updatedAt: Number.isFinite(app.updatedAt) ? app.updatedAt : Date.now(),
      })
    }
    for (const record of Array.isArray(value?.data) ? value.data : []) {
      if (!record || typeof record.appId !== 'string' || typeof record.key !== 'string') continue
      await this.storage.setData({
        id: externalAppDataId(record.appId, record.key),
        appId: record.appId,
        key: record.key,
        value: cloneJsonValue(record.value),
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
      })
    }
  }

  getSummary(id: string): Promise<InstalledExternalAppSummary | undefined> {
    return this.storage.getSummary(id)
  }

  async get(id: string): Promise<InstalledExternalApp | undefined> {
    const app = await this.storage.get(id)
    if (!app?.packageFiles || app.runtimeHtml.includes(RUNTIME_BRIDGE_MARKER)) return app

    // 已安装 APP 会保存隔离运行时；升级宿主桥接后，从原始包无损重建一次，避免要求用户重装。
    const migrated: InstalledExternalApp = {
      ...app,
      runtimeHtml: buildRuntimeHtml(
        app.packageFiles,
        app.manifest,
        app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED,
      ),
    }
    await this.storage.save(migrated)
    return migrated
  }

  async inspect(input: File | readonly File[]): Promise<ExternalAppPreview> {
    const packageFiles = await filesFromInput(input)
    return this.preparePreview({
      ...packageFiles,
      packageFingerprint: packageFiles.fingerprint ?? (await fingerprintFiles(packageFiles.files)),
      generatedManifest: !packageFiles.files['manifest.json'],
    })
  }

  /** Draft source uses the same package validation and runtime pipeline as imported APPs. */
  async createSourcePreview(
    manifest: ExternalAppManifest,
    source: Record<string, string>,
  ): Promise<ExternalAppPreview> {
    const normalized = normalizeManifest(manifest)
    if (typeof source[normalized.entry] !== 'string' || !source[normalized.entry]!.trim())
      throw new Error('APP 草稿必须包含非空 HTML 入口文件')
    const files = Object.fromEntries(
      Object.entries(source).map(([path, text]) => [path, TEXT_ENCODER.encode(text)]),
    )
    return this.inspect(this.packageFile(normalized, files, '', undefined))
  }

  /** Reuse inspected bytes when changing a quick-import target or HTML entry. */
  async configurePreview(
    preview: ExternalAppPreview,
    options: { updateAppId?: string; entry?: string },
  ): Promise<ExternalAppPreview> {
    if (!preview.generatedManifest) throw new Error('带清单的安装包按作者声明的 APP 身份与入口安装')
    const target = options.updateAppId
      ? await this.storage.getSummary(options.updateAppId)
      : undefined
    if (options.updateAppId && (!target || target.id === CHAT_READER_APP_ID))
      throw new Error('更新目标不存在或不属于第三方 APP')
    const entry = options.entry ?? preview.manifest.entry
    if (!/\.html?$/i.test(entry) || !preview.packageFiles[entry])
      throw new Error('请选择包内 HTML 入口')
    return this.preparePreview({
      files: preview.packageFiles,
      manifest: { ...preview.manifest, ...(target ? { id: target.id } : {}), entry },
      sourceKind: preview.sourceKind,
      packageFingerprint: preview.packageFingerprint,
      generatedManifest: true,
    })
  }

  private async preparePreview(packageFiles: {
    files: Record<string, Uint8Array>
    manifest: ExternalAppManifest
    sourceKind: ExternalAppPreview['sourceKind']
    packageFingerprint: string
    generatedManifest: boolean
  }): Promise<ExternalAppPreview> {
    const previous = await this.storage.getSummary(packageFiles.manifest.id)
    const requestedPermissions = packageFiles.manifest.permissions ?? []
    const packageFingerprint = packageFiles.packageFingerprint
    const contentChanged = Boolean(
      previous &&
      (previous.packageFingerprint !== packageFingerprint ||
        previous.manifest.entry !== packageFiles.manifest.entry),
    )
    const addedPermissions = requestedPermissions.filter(
      (permission) => previous && !getGrantedExternalAppPermissions(previous).includes(permission),
    )
    // Keep only the requested runtime mode, releasing the previous large string on switches.
    let cachedMode: ExternalAppRuntimeMode | undefined
    let cachedHtml = ''
    const runtime = (mode: ExternalAppRuntimeMode) => {
      if (cachedMode !== mode) {
        cachedHtml = buildRuntimeHtml(packageFiles.files, packageFiles.manifest, mode)
        cachedMode = mode
      }
      return cachedHtml
    }
    const compatibility = [
      ...new Map(
        Object.entries(packageFiles.files)
          .filter(([path]) => /\.(?:html?|js|css)$/i.test(path))
          .flatMap(([path, bytes]) => inspectCompatibility(readText(bytes, path)))
          .map((notice) => [notice.code, notice]),
      ).values(),
    ]
    return {
      manifest: packageFiles.manifest,
      get runtimeHtml() {
        return runtime(EXTERNAL_APP_RUNTIME_MODE.ISOLATED)
      },
      get compatibleRuntimeHtml() {
        return runtime(EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE)
      },
      sourceKind: packageFiles.sourceKind,
      generatedManifest: packageFiles.generatedManifest,
      ...(previous
        ? {
            previousInstallation: {
              id: previous.id,
              name: previous.manifest.name,
              version: previous.manifest.version,
              enabled: previous.enabled,
              runtimeMode: previous.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED,
            },
          }
        : {}),
      contentChanged,
      addedPermissions,
      packageFingerprint,
      requestedPermissions,
      permissionLevel: getExternalAppPermissionLevel(requestedPermissions),
      requiresReauthorization: contentChanged || addedPermissions.length > 0,
      compatibility,
      packageBytes: Object.values(packageFiles.files).reduce(
        (total, bytes) => total + bytes.byteLength,
        0,
      ),
      packageFiles: packageFiles.files,
      iconDataUrl: iconDataUrl(packageFiles.files, packageFiles.manifest),
    }
  }

  async install(
    input: ExternalAppInstallInput,
    runtimeMode: ExternalAppRuntimeMode = EXTERNAL_APP_RUNTIME_MODE.ISOLATED,
  ): Promise<InstalledExternalApp> {
    const preview = 'packageFingerprint' in input ? input : await this.inspect(input)
    const manifest = normalizeManifest(preview.manifest)
    const now = Date.now()
    const previous = await this.storage.getSummary(manifest.id)
    const packageUnchanged =
      previous?.packageFingerprint === preview.packageFingerprint &&
      previous?.manifest.entry === manifest.entry &&
      (previous?.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED) === runtimeMode
    const allowedPermissions = Array.from(
      new Set(preview.allowedPermissions ?? preview.requestedPermissions),
    ).filter((permission) => preview.requestedPermissions.includes(permission))
    const installed: InstalledExternalApp = {
      id: manifest.id,
      // 安装预览会经过 Vue 的响应式状态；写入 IndexedDB 前必须还原为可结构化克隆的普通对象。
      manifest,
      runtimeHtml:
        runtimeMode === EXTERNAL_APP_RUNTIME_MODE.TRUSTED_COMPATIBLE
          ? preview.compatibleRuntimeHtml
          : preview.runtimeHtml,
      ...(preview.packageFiles
        ? {
            packageFiles: Object.fromEntries(
              Object.entries(preview.packageFiles).map(([path, contents]) => [
                path,
                toRaw(contents),
              ]),
            ),
          }
        : {}),
      ...(preview.iconDataUrl !== undefined ? { iconDataUrl: preview.iconDataUrl } : {}),
      allowedPermissions,
      grantedPermissions: [],
      packageFingerprint: preview.packageFingerprint,
      runtimeMode,
      persistentPermissionGrants: packageUnchanged
        ? (previous?.persistentPermissionGrants ?? []).filter((permission) =>
            allowedPermissions.includes(permission),
          )
        : [],
      permissionAudit: packageUnchanged ? (previous?.permissionAudit ?? []) : [],
      health: {
        ...(packageUnchanged ? previous?.health : undefined),
        packageBytes: preview.packageBytes,
        dataBytes: previous?.health?.dataBytes ?? 0,
        dataLimitBytes: MAX_APP_DATA_BYTES,
        dataEntries: previous?.health?.dataEntries ?? 0,
        consecutiveFailures: packageUnchanged ? (previous?.health?.consecutiveFailures ?? 0) : 0,
      },
      enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    }
    await this.storage.save(installed)
    return installed
  }

  async updateSourceFile(id: string, path: string, source: string): Promise<InstalledExternalApp> {
    const app = await this.storage.get(id)
    if (!app?.packageFiles) throw new Error('这个 APP 没有可编辑的原始文件')
    if (path === 'manifest.json' || !/\.(?:html?|css|js|mjs|json)$/i.test(path))
      throw new Error('当前只允许编辑 HTML、CSS、JavaScript 和 JSON 文本文件')
    if (!(path in app.packageFiles)) throw new Error('未找到要编辑的 APP 文件')
    const encoded = TEXT_ENCODER.encode(source)
    if (encoded.byteLength > 512 * 1024) throw new Error('单个源码文件不能超过 512 KiB')
    const packageFiles = { ...app.packageFiles, [path]: encoded }
    const packageFingerprint = await fingerprintFiles(packageFiles)
    const runtimeMode = app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED
    const runtimeHtml = buildRuntimeHtml(packageFiles, app.manifest, runtimeMode)
    const updated: InstalledExternalApp = {
      ...app,
      packageFiles,
      packageFingerprint,
      runtimeHtml,
      persistentPermissionGrants: [],
      permissionAudit: [],
      health: {
        ...(app.health ?? {
          packageBytes: 0,
          dataBytes: 0,
          dataLimitBytes: MAX_APP_DATA_BYTES,
          dataEntries: 0,
          consecutiveFailures: 0,
        }),
        packageBytes: Object.values(packageFiles).reduce(
          (total, bytes) => total + bytes.byteLength,
          0,
        ),
        consecutiveFailures: 0,
      },
      updatedAt: Date.now(),
    }
    await this.storage.save(updated)
    return updated
  }

  async updatePresentation(id: string, name: string, iconDataUrl?: string): Promise<void> {
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 80)
      throw new Error('APP 名称必须为 1 到 80 个字符')
    if (iconDataUrl && iconDataUrl.length > 2 * 1024 * 1024) throw new Error('APP 图标数据过大')
    await this.storage.mutateMetadata(id, (app) => ({
      manifest: { ...app.manifest, name: normalizedName },
      ...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
      updatedAt: Date.now(),
    }))
  }

  async setAllowedPermissions(
    id: string,
    permissions: readonly ExternalAppPermission[],
  ): Promise<void> {
    await this.storage.mutateMetadata(id, (app) => {
      const requested = new Set(app.manifest.permissions ?? [])
      const allowed = Array.from(new Set(permissions)).filter((permission) =>
        requested.has(permission),
      )
      return {
        allowedPermissions: allowed,
        persistentPermissionGrants: (app.persistentPermissionGrants ?? []).filter((permission) =>
          allowed.includes(permission),
        ),
        updatedAt: Date.now(),
      }
    })
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!(await this.storage.getSummary(id))) throw new Error('未找到该 APP')
    await this.storage.mutateMetadata(id, (app) => ({
      enabled,
      updatedAt: Date.now(),
      ...(enabled && app.health?.disabledByWatchdog
        ? { health: { ...app.health, consecutiveFailures: 0, disabledByWatchdog: false } }
        : {}),
    }))
  }

  async setRuntimeMode(id: string, mode: ExternalAppRuntimeMode): Promise<void> {
    if (!Object.values(EXTERNAL_APP_RUNTIME_MODE).includes(mode)) throw new Error('运行模式无效')
    const app = await this.storage.get(id)
    if (!app?.packageFiles) throw new Error('缺少原始文件，请重新导入安装包后切换运行模式')
    if ((app.runtimeMode ?? EXTERNAL_APP_RUNTIME_MODE.ISOLATED) === mode) return
    const runtimeHtml = buildRuntimeHtml(app.packageFiles, app.manifest, mode)
    await this.storage.save({
      ...app,
      runtimeHtml,
      runtimeMode: mode,
      persistentPermissionGrants: [],
      permissionAudit: [],
      updatedAt: Date.now(),
    })
  }

  async listRetainedData(): Promise<RetainedExternalAppData[]> {
    if (!this.storage.listDataAppIds) return []
    const installed = new Set((await this.storage.list()).map((app) => app.id))
    const result: RetainedExternalAppData[] = []
    for (const appId of await this.storage.listDataAppIds()) {
      if (appId === CHAT_READER_APP_ID || installed.has(appId)) continue
      const records = await this.storage.listData(appId)
      result.push({
        appId,
        dataEntries: records.length,
        dataBytes: records.reduce((total, record) => total + byteLength(record.value), 0),
      })
    }
    return result
  }

  async clearRetainedData(appId: string): Promise<void> {
    if (appId === CHAT_READER_APP_ID || (await this.storage.getSummary(appId)))
      throw new Error('请在对应 APP 的管理页清除数据')
    await this.storage.clearData(appId)
  }

  async exportData(appId: string): Promise<File> {
    if (appId === CHAT_READER_APP_ID) throw new Error('请通过读了么备份阅读数据')
    const records = await this.storage.listData(appId)
    return new File(
      [JSON.stringify({ schemaVersion: 1, appId, records }, null, 2)],
      `${appId}-data.json`,
      { type: 'application/json' },
    )
  }

  async uninstall(id: string): Promise<void> {
    await this.storage.delete(id)
  }

  async clearData(appId: string): Promise<void> {
    const app = await this.storage.getSummary(appId)
    if (!app) throw new Error('APP 不存在或已卸载')
    await this.storage.clearData(appId)
    await this.updateHealth(appId, { dataBytes: 0, dataEntries: 0 })
  }

  async hasPermission(
    appId: string,
    permission: ExternalAppPermission | ExternalAppPermission[],
  ): Promise<boolean> {
    const app = await this.storage.getSummary(appId)
    const required = Array.isArray(permission) ? permission : [permission]
    const granted = app ? getGrantedExternalAppPermissions(app) : []
    return Boolean(app?.enabled && required.every((item) => granted.includes(item)))
  }

  async hasPersistentPermission(
    appId: string,
    permission: ExternalAppPermission,
  ): Promise<boolean> {
    const app = await this.storage.getSummary(appId)
    return Boolean(app?.enabled && app.persistentPermissionGrants?.includes(permission))
  }

  async grantPersistentPermission(appId: string, permission: ExternalAppPermission): Promise<void> {
    await this.storage.mutateMetadata(appId, (app) => {
      if (!app.enabled) throw new Error('APP 已被禁用')
      if (!(app.manifest.permissions ?? []).includes(permission))
        throw new Error('APP 未在清单中声明此权限')
      if (!getGrantedExternalAppPermissions(app).includes(permission))
        throw new Error('此权限未在安装时授权')
      return {
        persistentPermissionGrants: Array.from(
          new Set([...(app.persistentPermissionGrants ?? []), permission]),
        ),
        updatedAt: Date.now(),
      }
    })
  }

  async revokePersistentPermission(
    appId: string,
    permission?: ExternalAppPermission,
  ): Promise<void> {
    await this.storage.mutateMetadata(appId, (app) => ({
      persistentPermissionGrants: permission
        ? (app.persistentPermissionGrants ?? []).filter((item) => item !== permission)
        : [],
      updatedAt: Date.now(),
    }))
  }

  async recordPermissionDecision(
    appId: string,
    entry: Omit<ExternalAppPermissionAuditEntry, 'createdAt'>,
  ): Promise<void> {
    await this.storage.mutateMetadata(appId, (app) => ({
      permissionAudit: [{ ...entry, createdAt: Date.now() }, ...(app.permissionAudit ?? [])].slice(
        0,
        50,
      ),
      updatedAt: Date.now(),
    }))
  }

  async exportPackage(appId: string): Promise<File> {
    const app = await this.storage.get(appId)
    if (!app) throw new Error('APP 不存在或已卸载')
    return this.packageFile(app.manifest, app.packageFiles, app.runtimeHtml, app.iconDataUrl)
  }

  async exportPreviewPackage(preview: ExternalAppPreview): Promise<File> {
    return this.packageFile(
      preview.manifest,
      preview.packageFiles,
      preview.runtimeHtml,
      preview.iconDataUrl,
    )
  }

  createTemplatePackage(): File {
    const files: Record<string, Uint8Array> = {
      'index.html': TEXT_ENCODER.encode(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的 SRL APP</title><link rel="stylesheet" href="app.css"></head>
<body><main><h1>我的 SRL APP</h1><p id="status">正在连接 SRL…</p><button id="save">保存示例数据</button></main><script src="app.js"></script></body></html>`),
      'app.css': TEXT_ENCODER.encode(
        'body{margin:0;padding:24px;font:16px system-ui;color:#15343a;background:#f5fbfb}main{max-width:520px;margin:auto;padding:24px;border-radius:18px;background:#fff;box-shadow:0 10px 32px #1f6f7722}button{min-height:44px;padding:0 16px;border:0;border-radius:12px;color:#fff;background:#237f87;font:inherit}',
      ),
      'app.js': TEXT_ENCODER.encode(
        `(async()=>{await window.srlApp.ready();document.querySelector('#status').textContent='已连接 SRL';document.querySelector('#save').onclick=async()=>{await window.srlApp.storage.set('example',{savedAt:Date.now()});await window.srlApp.notify('示例数据已保存')}})()`,
      ),
      'icon.svg': TEXT_ENCODER.encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#237f87"/><circle cx="48" cy="48" r="22" fill="#fff" opacity=".9"/></svg>',
      ),
    }
    const manifest: ExternalAppManifest = {
      schemaVersion: EXTERNAL_APP_SCHEMA_VERSION,
      apiVersion: EXTERNAL_APP_SDK_VERSION,
      id: 'com.example.my-srl-app',
      name: '我的 SRL APP',
      version: '1.0.0',
      entry: 'index.html',
      description: '可直接修改并导入的最小第三方 APP 模板。',
      icon: 'icon.svg',
      splashColor: '#237f87',
      orientation: 'auto',
      immersive: false,
      permissions: [EXTERNAL_APP_PERMISSION.STORAGE],
    }
    return this.packageFile(
      manifest,
      files,
      files['index.html'] ? readText(files['index.html'], 'index.html') : '',
    )
  }

  private packageFile(
    manifestValue: ExternalAppManifest,
    packageFiles: Record<string, Uint8Array> | undefined,
    fallbackHtml: string,
    presentationIcon?: string,
  ): File {
    const exportedManifest = { ...manifestValue }
    const iconFiles: Record<string, Uint8Array> = {}
    if (presentationIcon === '') delete exportedManifest.icon
    else if (
      presentationIcon &&
      presentationIcon !== iconDataUrl(packageFiles ?? {}, manifestValue)
    ) {
      const match = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,([a-z0-9+/=]+)$/i.exec(
        presentationIcon,
      )
      if (!match)
        throw new Error(
          '导出安装包需要本机图片图标，请先上传 PNG、JPEG、WebP、GIF 或 SVG 图片；链接图标仅用于本机显示',
        )
      const extension = match[1]!.toLowerCase().replace('svg+xml', 'svg')
      const bytes = Uint8Array.from(atob(match[2]!), (character) => character.charCodeAt(0))
      let iconPath = `srl-presentation-icon.${extension}`
      for (let index = 1; packageFiles?.[iconPath]; index++) {
        iconPath = `srl-presentation-icon-${index}.${extension}`
      }
      exportedManifest.icon = iconPath
      iconFiles[iconPath] = bytes
    }
    const manifest = JSON.stringify(exportedManifest, null, 2)
    const archive = zipSync({
      ...(packageFiles ?? {}),
      ...iconFiles,
      'manifest.json': strToU8(manifest),
      ...(packageFiles?.[manifestValue.entry]
        ? {}
        : { [manifestValue.entry]: strToU8(fallbackHtml) }),
    })
    return new File([archive], `${manifestValue.id}-${manifestValue.version}.srlapp`, {
      type: 'application/zip',
    })
  }

  async getData(appId: string, keyValue: unknown): Promise<unknown> {
    const key = normalizeDataKey(keyValue)
    if (!(await this.hasPermission(appId, EXTERNAL_APP_PERMISSION.STORAGE))) {
      throw new Error('该 APP 未获得本地存储权限')
    }
    return (await this.storage.getData(appId, key))?.value ?? null
  }

  async setData(appId: string, keyValue: unknown, value: unknown): Promise<void> {
    const key = normalizeDataKey(keyValue)
    if (!(await this.hasPermission(appId, EXTERNAL_APP_PERMISSION.STORAGE))) {
      throw new Error('该 APP 未获得本地存储权限')
    }
    const normalized = cloneJsonValue(value)
    const existing = await this.storage.listData(appId)
    const nextSize = TEXT_ENCODER.encode(JSON.stringify(normalized)).byteLength
    const retainedSize = existing
      .filter((record) => record.key !== key)
      .reduce(
        (total, record) => total + TEXT_ENCODER.encode(JSON.stringify(record.value)).byteLength,
        0,
      )
    if (retainedSize + nextSize > MAX_APP_DATA_BYTES)
      throw new Error('APP 本地存储总量超过 1 MiB 限制')
    await this.storage.setData({
      id: externalAppDataId(appId, key),
      appId,
      key,
      value: normalized,
      updatedAt: Date.now(),
    })
    await this.updateHealth(appId, {
      dataBytes: retainedSize + nextSize,
      dataEntries: existing.some((record) => record.key === key)
        ? existing.length
        : existing.length + 1,
    })
  }

  async removeData(appId: string, keyValue: unknown): Promise<void> {
    const key = normalizeDataKey(keyValue)
    if (!(await this.hasPermission(appId, EXTERNAL_APP_PERMISSION.STORAGE))) {
      throw new Error('该 APP 未获得本地存储权限')
    }
    await this.storage.deleteData(appId, key)
    const remaining = await this.storage.listData(appId)
    await this.updateHealth(appId, {
      dataBytes: remaining.reduce((total, record) => total + byteLength(record.value), 0),
      dataEntries: remaining.length,
    })
  }

  async getHealth(appId: string): Promise<ExternalAppHealth> {
    const app = await this.storage.getSummary(appId)
    if (!app) throw new Error('APP 不存在或已卸载')
    const data = await this.storage.listData(appId)
    const derived = {
      packageBytes: app.health?.packageBytes ?? 0,
      dataBytes: data.reduce((total, record) => total + byteLength(record.value), 0),
      dataLimitBytes: MAX_APP_DATA_BYTES,
      dataEntries: data.length,
      lastLaunchedAt: app.health?.lastLaunchedAt,
      lastErrorAt: app.health?.lastErrorAt,
      lastError: app.health?.lastError,
      consecutiveFailures: app.health?.consecutiveFailures ?? 0,
      disabledByWatchdog: app.health?.disabledByWatchdog,
    }
    await this.updateHealth(appId, derived)
    return derived
  }

  async recordLaunch(appId: string): Promise<void> {
    await this.updateHealth(appId, {
      lastLaunchedAt: Date.now(),
    })
  }

  async recordHealthyLaunch(appId: string): Promise<void> {
    await this.updateHealth(appId, {
      consecutiveFailures: 0,
      lastError: undefined,
      lastErrorAt: undefined,
      disabledByWatchdog: false,
    })
  }

  async recordRuntimeError(appId: string, error: unknown): Promise<ExternalAppHealth | undefined> {
    const app = await this.storage.getSummary(appId)
    if (!app) return undefined
    const message = (error instanceof Error ? error.message : String(error))
      .trim()
      .slice(0, MAX_DIAGNOSTIC_LENGTH)
    const health = await this.updateHealth(appId, {
      lastError: message || 'APP 运行异常',
      lastErrorAt: Date.now(),
      consecutiveFailures: (app.health?.consecutiveFailures ?? 0) + 1,
    })
    if (health.consecutiveFailures >= 3) {
      health.disabledByWatchdog = true
      await this.storage.updateMetadata(appId, { health, enabled: false, updatedAt: Date.now() })
    }
    return health
  }

  private async updateHealth(
    appId: string,
    changes: Partial<ExternalAppHealth>,
  ): Promise<ExternalAppHealth> {
    const current = await this.storage.getSummary(appId)
    if (!current) throw new Error('APP 不存在或已卸载')
    const health: ExternalAppHealth = {
      packageBytes: current.health?.packageBytes ?? 0,
      dataBytes: current.health?.dataBytes ?? 0,
      dataLimitBytes: MAX_APP_DATA_BYTES,
      dataEntries: current.health?.dataEntries ?? 0,
      consecutiveFailures: current.health?.consecutiveFailures ?? 0,
      ...current.health,
      ...changes,
    }
    await this.storage.updateMetadata(appId, { health, updatedAt: Date.now() })
    return health
  }
}
