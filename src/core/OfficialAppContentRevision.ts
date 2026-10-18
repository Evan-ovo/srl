import type { OfficialAppId } from '../types/OfficialApp.js'

/**
 * Increment only the APPs whose user-facing behavior or APP-owned resources changed.
 * Shell rebuilds and generated file hashes do not change these revisions.
 */
export const OFFICIAL_APP_CONTENT_REVISIONS: Record<OfficialAppId, number> = {
  chatReader: 14,
  draw: 1,
  stitch: 16,
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=frontend-workshop-content-revision
  frontendWorkshop: 7,
  // SRL-PUBLIC-SYNC: END REPLACE id=frontend-workshop-content-revision
  imageGeneration: 8,
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=image-album-content-revision
  imageAlbum: 3,
  // SRL-PUBLIC-SYNC: END REPLACE id=image-album-content-revision
  userPersona: 7,
  tavernBridge: 9,
  // SRL-PUBLIC-SYNC: BEGIN REPLACE id=assistant-content-revision
  assistant: 47,
  // SRL-PUBLIC-SYNC: END REPLACE id=assistant-content-revision
}

/** Existing installed records predate explicit revisions and start at the migration baseline. */
export const LEGACY_OFFICIAL_APP_CONTENT_REVISION = 1
