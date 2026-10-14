import { DISCORD_INBOX_SCHEMA } from '../../workers/discord-source-bridge/src/DiscordInboxSchema.js'
import { DISCORD_RESOURCE_SCHEMA } from '../../workers/discord-source-bridge/src/DiscordResourceSchema.js'

export const DISCORD_BRIDGE_PUBLIC_REPOSITORY_URL =
  'https://github.com/jixiangruyi117/SRL-Discord-Bridge'

export const DISCORD_BRIDGE_DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(
  DISCORD_BRIDGE_PUBLIC_REPOSITORY_URL,
)}`

/** Migration follows the code's DB binding, including legitimate custom database names. */
export const DISCORD_BRIDGE_AGENT_DEPLOY_COMMAND =
  'npx wrangler d1 migrations apply DB --remote && npx wrangler deploy'

/** Shared by the GitHub tutorial and the APK browser; Bot Token never belongs in this file. */
export const DISCORD_BRIDGE_WRANGLER_TEMPLATE = JSON.stringify(
  {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'srl-discord-source-bridge',
    main: 'src/index.ts',
    compatibility_date: '2026-08-26',
    keep_vars: true,
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'srl-discord-source-handoff',
        database_id: '【粘贴 Cloudflare 的 Database ID】',
        migrations_dir: 'migrations',
      },
    ],
    vars: {
      DISCORD_APPLICATION_ID: '【粘贴 Discord Application ID】',
      DISCORD_PUBLIC_KEY: '【粘贴同一 App 的 Public Key】',
      HANDOFF_TTL_SECONDS: '1200',
    },
  },
  null,
  2,
)

const MANUAL_SCHEMA_HELPER = `
let manualSchemaReady: Promise<void> | undefined

function ensureManualSchema(env: Env): Promise<void> {
  manualSchemaReady ??= (async () => {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS handoffs (token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)',
    ).run()
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_handoffs_expires_at ON handoffs (expires_at)',
    ).run()
    await env.DB.batch(${JSON.stringify([...DISCORD_INBOX_SCHEMA, ...DISCORD_RESOURCE_SCHEMA])}.map((statement) => env.DB.prepare(statement)))
  })()
  return manualSchemaReady
}
`

const FETCH_SIGNATURE =
  'async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {'

/**
 * Dashboard / Quick Editor users do not have Wrangler migrations. Keep the Worker source
 * as the single owner, then derive a browser-paste variant by adding one idempotent D1 schema gate.
 */
export function buildDiscordBridgeManualSource(workerSource: string): string {
  if (!workerSource.includes(FETCH_SIGNATURE)) {
    throw new Error('Discord Bridge 源码结构已变化，无法生成浏览器部署版')
  }
  const exportMarker = '\nexport default {'
  if (!workerSource.includes(exportMarker)) {
    throw new Error('Discord Bridge 源码缺少默认入口')
  }

  const withHelper = workerSource.replace(exportMarker, `${MANUAL_SCHEMA_HELPER}${exportMarker}`)
  return withHelper.replace(
    FETCH_SIGNATURE,
    `${FETCH_SIGNATURE}\n    await ensureManualSchema(env)`,
  )
}
