import type { OfficialAppId } from '../types/OfficialApp.js'

/**
 * Increment only the APPs whose user-facing behavior or APP-owned resources changed.
 * Shell rebuilds and generated file hashes do not change these revisions.
 */
export const OFFICIAL_APP_CONTENT_REVISIONS: Record<OfficialAppId, number> = {
  chatReader: 12,
  draw: 1,
  stitch: 13,
  frontendWorkshop: 6,
  imageGeneration: 4,
  imageAlbum: 2,
  userPersona: 7,
  tavernBridge: 9,
  assistant: 34,
}

/** Existing installed records predate explicit revisions and start at the migration baseline. */
export const LEGACY_OFFICIAL_APP_CONTENT_REVISION = 1
