import type { D1Database } from './DiscordDatabase'

export interface Env {
  DB: D1Database
  DISCORD_APPLICATION_ID: string
  DISCORD_PUBLIC_KEY: string
  DISCORD_BOT_TOKEN: string
  HANDOFF_TTL_SECONDS?: string
}

export interface DiscordInteraction {
  id?: string
  type: number
  context?: number
  token?: string
  user?: { id?: string }
  member?: { user?: { id?: string } }
  guild_id?: string
  channel_id?: string
  channel?: Record<string, unknown>
  data?: {
    name?: string
    type?: number
    options?: Array<{ name: string; type?: number; value?: unknown }>
    target_id?: string
    resolved?: {
      messages?: Record<string, Record<string, unknown>>
    }
  }
}

export const DISCORD_SNOWFLAKE_PATTERN = /^\d{5,32}$/u

export function validSnowflake(value: string | undefined): value is string {
  return Boolean(value && DISCORD_SNOWFLAKE_PATTERN.test(value))
}
