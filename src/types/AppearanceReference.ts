export interface ReferenceRule {
  selector: string
  conditions: string
  line?: number
  declarations: Record<string, string>
}
export interface ReferenceSource {
  path: string
  rules: ReferenceRule[]
}
export interface ReferenceCatalog {
  sources: ReferenceSource[]
  scopes: Record<string, string[]>
  /** Generated from the actual Page.js helper, bridge and snapshot types. */
  vue?: Array<[signature: string, description: string]>
  version?: string
  fingerprint?: string
  installed?: Record<string, { version: string; fingerprint: string }>
}
