import type { ResourceSummary } from './Resource'

/** Read-only source; native references require an explicitly URI-aware sink. */
export interface ResourceByteSource {
  readonly size: number
  readonly contentIdentity?: string
  /** Existing native file reference representation; only a native URI-aware sink may consume it. */
  nativeFile?(): Promise<Blob>
  text(): Promise<string>
  slice(start?: number, end?: number): { arrayBuffer(signal?: AbortSignal): Promise<ArrayBuffer> }
  /** Optional native implementation of the same immutable CDC/SHA planning contract. */
  planParts?(options: {
    fixedPartSize?: number
    signal?: AbortSignal
    onRead?: (bytes: number, total: number) => void
  }): Promise<{ totalSha256: string; parts: Array<{ size: number; sha256: string }> } | undefined>
}

export type ResourceReadSource = ResourceSummary & {
  originalSource: ResourceByteSource
  /** Legacy buffers/whole-object encryption cannot be reopened cheaply per upload range. */
  requiresWholeRead?: boolean
}
