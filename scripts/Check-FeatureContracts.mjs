import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
import { build } from 'esbuild'
import ts from 'typescript'

// Read declarations from their existing owners. Do not create another APP/type catalogue.
export function declarationKeys(source, variable) {
  const ast = ts.createSourceFile('owner.ts', source, ts.ScriptTarget.Latest, true)
  let keys
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === variable) {
      let value = node.initializer
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
        value = value.expression
      if (value && ts.isObjectLiteralExpression(value))
        keys = value.properties.map((property) => property.name?.text)
      if (value && ts.isArrayLiteralExpression(value))
        keys = value.elements.map((element) =>
          ts.isStringLiteral(element) ? element.text : undefined,
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!keys || keys.some((key) => !key)) throw new Error(`无法读取 Owner 声明：${variable}`)
  return keys
}

export function officialAppIds() {
  return declarationKeys(
    readFileSync(fileURLToPath(new URL('../src/types/OfficialApp.ts', import.meta.url)), 'utf8'),
    'OFFICIAL_APP_IDS',
  )
}

export function cleanupAppIds(source) {
  const ids = new Set(declarationKeys(source, 'keys'))
  const ast = ts.createSourceFile('cleanup.ts', source, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      node.left.getText(ast) === 'id' &&
      ts.isStringLiteral(node.right)
    )
      ids.add(node.right.text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...ids]
}

const hasSelection = (value) =>
  value === true || (value && typeof value === 'object' && Object.values(value).some(hasSelection))

export function validateFeatureContracts(snapshot, contracts, exists = () => true) {
  const errors = []
  const check = (condition, message) => {
    if (!condition) errors.push(message)
  }
  check(
    contracts.version === 1 && contracts.apps && typeof contracts.apps === 'object',
    '功能合同版本/结构无效',
  )
  if (errors.length) return errors
  const ids = snapshot.apps.map((app) => app.id)
  check(new Set(ids).size === ids.length, 'FeatureAppRegistry 存在重复 APP ID')
  check(
    new Set(snapshot.apps.map((app) => app.page)).size === ids.length,
    'FeatureAppRegistry 存在重复页面',
  )
  const scopeIds = snapshot.backupScopes.map((scope) => scope.id)
  check(new Set(scopeIds).size === scopeIds.length, 'BackupScopeRegistry 存在重复范围 ID')
  for (const type of Object.values(snapshot.resourceTypes))
    check(
      snapshot.backupScopes.filter((scope) => scope.resourceType === type).length === 1,
      `${type} 必须恰好对应一个资源备份范围`,
    )
  for (const scope of snapshot.backupScopes) {
    if (scope.sensitive)
      check(!scope.defaultLocal && !scope.defaultCloud, `${scope.id} 不得默认携带敏感数据`)
    if (scope.id.startsWith('extra.')) {
      const state = { resourceIds: new Set(), scopes: new Set([scope.id]) }
      check(hasSelection(snapshot.toArchive(state)), `${scope.id} 未接入 ZIP 选择转换`)
      check(hasSelection(snapshot.toCloud(state)), `${scope.id} 未接入云备份选择转换`)
    }
  }
  for (const key of Object.keys(contracts.apps))
    check(ids.includes(key), `${key} 的合同没有对应 APP，请退役过期声明`)
  for (const app of snapshot.apps) {
    const contract = contracts.apps[app.id]
    check(Boolean(contract), `${app.id} 缺少功能合同：Owner、测试、备份策略和外观示例必须同轮声明`)
    if (!contract) continue
    check(exists(contract.owner), `${app.id} Owner 路径无效：${contract.owner}`)
    check(Array.isArray(contract.tests) && contract.tests.length > 0, `${app.id} 缺少相关测试声明`)
    for (const test of contract.tests || [])
      check(/\.(test|spec)\./u.test(test) && exists(test), `${app.id} 测试路径无效：${test}`)
    const policy = contract.backup?.policy
    check(
      ['supported', 'partial', 'unsupported', 'archive-core', 'none'].includes(policy),
      `${app.id} 缺少明确备份策略`,
    )
    check(Array.isArray(contract.backup?.scopes), `${app.id} 缺少备份范围声明`)
    for (const scope of contract.backup?.scopes || [])
      check(scopeIds.includes(scope), `${app.id} 引用了不存在的备份范围：${scope}`)
    if (policy === 'supported')
      check(contract.backup.scopes.length > 0, `${app.id} 宣称支持备份但未声明范围`)
    if (policy !== 'supported')
      check(Boolean(contract.backup?.reason?.trim()), `${app.id} 必须说明备份边界/缺口`)
    const cleanup = contract.cleanup
    check(
      ['app-owned', 'retain', 'not-applicable'].includes(cleanup?.policy),
      `${app.id} 未声明数据清理边界`,
    )
    if (cleanup?.policy === 'app-owned') {
      check(exists(cleanup.owner), `${app.id} 清理 Owner 路径无效`)
      check(snapshot.cleanupIds.includes(app.id), `${app.id} 未接入官方 APP 数据清理 Owner`)
    } else check(Boolean(cleanup?.reason?.trim()), `${app.id} 必须说明数据保留/无需卸载的原因`)
    if (app.visible) {
      const scopes = snapshot.appearance.filter((scope) => scope.appId === app.id)
      check(scopes.length === 1, `${app.id} 必须有唯一动态外观范围`)
      check(
        contract.cssReference === 'available' && snapshot.referenceKeys.includes(app.id),
        `${app.id} CSS接口来源漏接`,
      )
    }
  }
  const official = [...snapshot.officialIds].sort()
  check(
    JSON.stringify([...snapshot.packageIds].sort()) === JSON.stringify(official),
    '官方 APP 构建入口与 OfficialAppId 不一致',
  )
  check(
    JSON.stringify(Object.keys(snapshot.revisions).sort()) === JSON.stringify(official),
    '官方 APP 内容修订表漏项或存在过期项',
  )
  for (const id of official) {
    check(ids.includes(id), `${id} 官方 APP 未注册桌面入口`)
    check(
      Number.isSafeInteger(snapshot.revisions[id]) && snapshot.revisions[id] >= 1,
      `${id} 内容修订号无效`,
    )
  }
  return errors
}

export async function inspectFeatureContracts(root) {
  const require = createRequire(import.meta.url)
  const compiled = await build({
    stdin: {
      contents: `export { FEATURE_APP_REGISTRY as apps } from './src/core/FeatureAppRegistry.ts';
        export { appearanceScopes } from './src/core/AppearanceScopes.ts';
        export { RESOURCE_TYPE as resourceTypes } from './src/types/Resource.ts';
        export { BACKUP_SCOPE_REGISTRY as backupScopes, toArchivePortableSelection as toArchive, toCloudContentSelection as toCloud } from './src/services/BackupScopeRegistry.ts';
        export { OFFICIAL_APP_IDS as officialIds } from './src/types/OfficialApp.ts';
        export { OFFICIAL_APP_CONTENT_REVISIONS as revisions } from './src/core/OfficialAppContentRevision.ts';
        export { createAppearanceReferenceCatalog } from './scripts/AppearanceReferenceCatalog.ts';`,
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    // Keep compiler packages at their installed Node entry; bundling SFC's optional
    // template-engine adapters would require unrelated engines and duplicate compiler memory.
    plugins: [
      {
        name: 'feature-contract-compilers',
        setup(plugin) {
          plugin.onResolve(
            { filter: /^(?:@vue\/compiler-sfc|postcss|typescript)$/ },
            ({ path }) => ({
              path: pathToFileURL(require.resolve(path)).href,
              external: true,
            }),
          )
        },
      },
    ],
  })
  const metadata = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  )
  const read = (path) => readFileSync(resolve(root, path), 'utf8')
  const contracts = JSON.parse(read('scripts/FeatureContracts.json'))
  const snapshot = {
    ...metadata,
    appearance: metadata.appearanceScopes(),
    referenceKeys: Object.entries(metadata.createAppearanceReferenceCatalog(root).scopes)
      .filter(([, sources]) => sources.length > 0)
      .map(([id]) => id),
    packageIds: declarationKeys(read('scripts/OfficialAppPackages.ts'), 'entries'),
    cleanupIds: cleanupAppIds(read('src/storage/OfficialAppDataStorage.ts')),
  }
  const exists = (path) =>
    typeof path === 'string' &&
    (/^(src|scripts)\/[\w./-]+$/u.test(path) ||
      /^cloudflare\/[\w/-]+\.(test|spec)\.js$/u.test(path)) &&
    !path.includes('..') &&
    existsSync(resolve(root, path))
  return { errors: validateFeatureContracts(snapshot, contracts, exists), contracts, snapshot }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectFeatureContracts(fileURLToPath(new URL('..', import.meta.url)))
  if (result.errors.length) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `功能完整性通过：${result.snapshot.apps.length} 个 APP、${result.snapshot.backupScopes.length} 个备份范围；明确缺口保留在功能合同中`,
    )
  }
}
