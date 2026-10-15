import { checkedSetupParameters, type DiscordSetupParameters } from './DiscordSetupParameters'
import { DISCORD_BRIDGE_WRANGLER_TEMPLATE } from './DiscordBridgeDeployService'

/** JSONC is accepted for existing Wrangler files; only JSON is emitted for generated configuration. */
export function readGitHubWrangler(source: string): Record<string, unknown> {
  let clean = '',
    quoted = false,
    escaped = false,
    comment: '' | 'line' | 'block' = ''
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!,
      next = source[index + 1]
    if (comment === 'line') {
      if (char === '\n') {
        comment = ''
        clean += char
      }
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = ''
        index++
      }
      continue
    }
    if (quoted) {
      clean += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '/' && (next === '/' || next === '*')) {
      comment = next === '/' ? 'line' : 'block'
      index++
      clean += ' '
      continue
    }
    clean += char
  }
  if (comment === 'block') throw new Error('Wrangler 注释未结束，未替换当前文件')
  let json = ''
  quoted = false
  escaped = false
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',' && /^\s*[}\]]/u.test(clean.slice(index + 1))) continue
    json += char
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('Wrangler JSON/JSONC 格式无效；未回传源码或字段值')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Wrangler 配置不是对象')
  return value as Record<string, unknown>
}
export function gitHubWranglerSource(
  input: DiscordSetupParameters,
  applicationId?: string,
  existing?: string,
): string {
  const values = checkedSetupParameters(input)
  if (
    !values.applicationId ||
    !values.publicKey ||
    !values.databaseId ||
    values.applicationId !== applicationId
  )
    throw new Error('本次密钥卡缺少 App、公钥或 D1 参数，或与任务 App 不一致，未提交')
  // Preserve legitimate deployment choices and extra bindings; only the task's public values change.
  const template = existing
    ? readGitHubWrangler(existing)
    : JSON.parse(DISCORD_BRIDGE_WRANGLER_TEMPLATE)
  const databases = Array.isArray(template.d1_databases) ? template.d1_databases : []
  const matches = databases.filter((row: Record<string, unknown>) => row?.binding === 'DB')
  if (matches.length !== 1)
    throw new Error('当前配置没有唯一的 DB 绑定，请先核对实际配置；未覆盖其它数据库')
  matches[0].database_id = values.databaseId
  template.vars = {
    ...(template.vars ?? {}),
    DISCORD_APPLICATION_ID: values.applicationId,
    DISCORD_PUBLIC_KEY: values.publicKey,
  }
  if (!validPublicConfiguration(template))
    throw new Error('已有配置格式或结构无效，需要确认替换；未回传字段值')
  return JSON.stringify(template, null, 2)
}
function validPublicConfiguration(value: Record<string, unknown>): boolean {
  const vars = value.vars as Record<string, unknown> | undefined
  const databases = Array.isArray(value.d1_databases) ? value.d1_databases : []
  const rows = databases.filter((row: Record<string, unknown>) => row?.binding === 'DB')
  const db = rows.length === 1 ? rows[0] : undefined
  const privateValue = (item: unknown): boolean =>
    !!item &&
    typeof item === 'object' &&
    Object.entries(item).some(
      ([key, content]) =>
        (/(?:^|_)(?:bot_token|access_token|refresh_token|client_secret|password|api_key|authorization|credential)(?:$|_)/iu.test(
          key,
        ) &&
          ['string', 'number'].includes(typeof content)) ||
        privateValue(content),
    )
  return (
    typeof value.name === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/iu.test(value.name) &&
    typeof value.main === 'string' &&
    /\.(?:[cm]?[jt]s)$/u.test(value.main) &&
    !value.main.startsWith('/') &&
    !value.main.split('/').includes('..') &&
    typeof value.compatibility_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(value.compatibility_date) &&
    Number.isFinite(Date.parse(value.compatibility_date)) &&
    !!db &&
    typeof db.database_name === 'string' &&
    !!db.database_name.trim() &&
    typeof db.database_id === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(db.database_id) &&
    (db.migrations_dir === undefined ||
      (typeof db.migrations_dir === 'string' &&
        !!db.migrations_dir.trim() &&
        !db.migrations_dir.startsWith('/') &&
        !db.migrations_dir.split('/').includes('..'))) &&
    !!vars &&
    typeof vars === 'object' &&
    !Array.isArray(vars) &&
    typeof vars.DISCORD_APPLICATION_ID === 'string' &&
    /^\d{17,20}$/u.test(vars.DISCORD_APPLICATION_ID) &&
    typeof vars.DISCORD_PUBLIC_KEY === 'string' &&
    /^[0-9a-f]{64}$/iu.test(vars.DISCORD_PUBLIC_KEY) &&
    (vars.HANDOFF_TTL_SECONDS === undefined ||
      /^[1-9]\d*$/u.test(String(vars.HANDOFF_TTL_SECONDS))) &&
    !privateValue(value) &&
    !Object.keys(vars).some((key) => /token|secret|password|credential|api[_-]?key/iu.test(key))
  )
}
export function githubWranglerMatches(source: string, expected: string): boolean {
  const actual = readGitHubWrangler(source),
    target = readGitHubWrangler(expected)
  const vars = actual.vars as Record<string, unknown> | undefined
  const targetVars = target.vars as Record<string, unknown>
  const databases = Array.isArray(actual.d1_databases) ? actual.d1_databases : []
  const binding = databases.filter((row: Record<string, unknown>) => row?.binding === 'DB')
  const expectedBinding = (target.d1_databases as Array<Record<string, unknown>>).find(
    (row) => row.binding === 'DB',
  )
  return (
    validPublicConfiguration(actual) &&
    binding.length === 1 &&
    binding[0].database_id === expectedBinding?.database_id &&
    vars?.DISCORD_APPLICATION_ID === targetVars.DISCORD_APPLICATION_ID &&
    vars?.DISCORD_PUBLIC_KEY === targetVars.DISCORD_PUBLIC_KEY &&
    actual.main === target.main &&
    binding[0].migrations_dir === expectedBinding?.migrations_dir &&
    !Object.keys(vars ?? {}).some((key) =>
      /token|secret|password|credential|api[_-]?key/iu.test(key),
    )
  )
}
export function githubConfigurationConflict(source: string, expected: string): boolean {
  const previous = readGitHubWrangler(source),
    next = readGitHubWrangler(expected)
  const original = previous.vars as Record<string, unknown> | undefined
  const target = next.vars as Record<string, unknown>
  const database = (previous.d1_databases as Array<Record<string, unknown>> | undefined)?.find(
    (row) => row.binding === 'DB',
  )?.database_id
  const targetDatabase = (next.d1_databases as Array<Record<string, unknown>>).find(
    (row) => row?.binding === 'DB',
  )?.database_id
  return (
    ['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY'].some(
      (key) =>
        typeof original?.[key] === 'string' &&
        /^[a-f0-9]{17,64}$/iu.test(original[key] as string) &&
        original[key] !== target[key],
    ) ||
    (typeof database === 'string' &&
      /^[a-f0-9-]{36}$/iu.test(database) &&
      database !== targetDatabase)
  )
}
