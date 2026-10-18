/* global fetch, console */
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { URL } from 'node:url'
import { unzipSync } from 'fflate'
import { officialAppIds } from './Check-FeatureContracts.mjs'

const baseUrl = process.argv[2]
if (!baseUrl)
  throw new Error('Usage: node scripts/Verify-OfficialAppDeployment.mjs <deployed-origin>')
const base = new URL(baseUrl)
if (!['http:', 'https:'].includes(base.protocol))
  throw new Error('Deployment origin must use HTTP or HTTPS')
const origin = base.origin
async function verifyConcurrently(items, verify) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) await verify(items[next++])
    }),
  )
}
const responseBytes = async (response, path) => {
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`${path}: response interrupted (${error.cause?.code ?? error.message})`, {
      cause: error,
    })
  }
}
const json = async (path) => {
  const url = new URL(path, origin)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    throw new Error(
      `${url.pathname}: expected application/json, received ${response.headers.get('content-type') ?? 'no content-type'}`,
    )
  try {
    return await response.json()
  } catch {
    throw new Error(
      `${url.pathname}: response is not valid JSON (check SPA fallback or deployment output)`,
    )
  }
}
const bytes = async (path) => {
  const url = new URL(path, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/official-apps/'))
    throw new Error(`Rejected non-local APP package URL: ${path}`)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`)
  return responseBytes(response, url.pathname)
}
const digest = (content) => createHash('sha256').update(content).digest('hex')
const inventory = await json('/official-app-assets.json')
if (
  typeof inventory.shellVersion !== 'string' ||
  !Number.isSafeInteger(inventory.hostApiVersion) ||
  !Array.isArray(inventory.shellFiles)
)
  throw new Error('/official-app-assets.json: invalid shell/API inventory')

const [currentCatalog, compatibleCatalog] = await Promise.all([
  json(`/official-apps/${inventory.shellVersion}/catalog.json`),
  json(`/official-apps/api-${inventory.hostApiVersion}/catalog.json`),
])
if (
  currentCatalog.schemaVersion !== 1 ||
  currentCatalog.shellVersion !== inventory.shellVersion ||
  compatibleCatalog.schemaVersion !== 1 ||
  compatibleCatalog.hostApiVersion !== inventory.hostApiVersion
)
  throw new Error('Current or compatibility catalog does not match the deployed shell')
const ids = Object.keys(currentCatalog.apps ?? {}).sort()
if (
  JSON.stringify(ids) !== JSON.stringify(officialAppIds().sort()) ||
  JSON.stringify(ids) !== JSON.stringify(Object.keys(compatibleCatalog.apps ?? {}).sort())
)
  throw new Error('Current and compatibility catalogs must contain every registered official APP')
const deployedShellFiles = new Map(inventory.shellFiles.map((file) => [file.path, file]))
for (const [id, candidates] of Object.entries(compatibleCatalog.apps)) {
  if (
    currentCatalog.apps[id].appContentRevision !==
    Math.max(...candidates.map((candidate) => candidate.appContentRevision))
  )
    throw new Error(`${id}: current APP revision trails a compatible package`)
  if (!candidates.some((candidate) => candidate.shellVersion === inventory.shellVersion))
    throw new Error(`${id}: compatibility catalog is missing the current shell package`)
  if (
    !candidates.some(
      (candidate) =>
        Array.isArray(candidate.hostFiles) &&
        candidate.hostFiles.every((file) => {
          const current = deployedShellFiles.get(file.path)
          return current?.size === file.size && current.sha256 === file.sha256
        }),
    )
  )
    throw new Error(`${id}: no candidate matches the deployed shared host assets`)
}

const packages = new Map()
for (const [id, download] of Object.entries(currentCatalog.apps)) {
  packages.set(download.url, { id, candidates: [download] })
}
const compatibilityCatalogs = new Map([[inventory.hostApiVersion, compatibleCatalog]])
for (const version of inventory.compatibleHostApiVersions ?? [inventory.hostApiVersion]) {
  if (!Number.isSafeInteger(version) || version < 1 || version > inventory.hostApiVersion)
    throw new Error('Invalid retained host API version')
  if (compatibilityCatalogs.has(version)) continue
  const legacy = await json(`/official-apps/api-${version}/catalog.json`)
  if (
    legacy.schemaVersion !== 1 ||
    legacy.hostApiVersion !== version ||
    JSON.stringify(Object.keys(legacy.apps ?? {}).sort()) !== JSON.stringify(ids)
  )
    throw new Error(`API ${version}: retained compatibility catalog is invalid`)
  compatibilityCatalogs.set(version, legacy)
}
for (const [hostApiVersion, catalog] of compatibilityCatalogs) {
  for (const [id, candidates] of Object.entries(catalog.apps)) {
    if (
      !Array.isArray(candidates) ||
      (hostApiVersion === inventory.hostApiVersion && candidates.length === 0)
    )
      throw new Error(`${id}: no compatible APP candidates`)
    for (const candidate of candidates) {
      if (candidate.hostApiVersion !== hostApiVersion)
        throw new Error(`${id}: candidate has a mismatched host API version`)
      const existing = packages.get(candidate.url)
      if (existing) {
        if (existing.id !== id)
          throw new Error(`${candidate.url}: catalog URL is reused by different APPs`)
        existing.candidates.push(candidate)
      } else {
        packages.set(candidate.url, { id, candidates: [candidate] })
      }
    }
  }
}

const retainedBuilds = new Set(
  [...packages.values()].flatMap(({ candidates }) =>
    candidates.map((candidate) => candidate.shellVersion),
  ),
)
for (const shellVersion of retainedBuilds) {
  if (shellVersion === inventory.shellVersion) continue
  const retained = await json(`/official-apps/${shellVersion}/catalog.json`)
  if (retained.schemaVersion !== 1 || retained.shellVersion !== shellVersion)
    throw new Error(`${shellVersion}: retained shell catalog is invalid`)
  for (const [id, download] of Object.entries(retained.apps ?? {})) {
    // Retirement removes active candidates without rewriting released archives.
    if (!ids.includes(id)) {
      const archiveBytes = await bytes(download.url)
      if (
        archiveBytes.length !== download.downloadBytes ||
        digest(archiveBytes) !== download.sha256
      )
        throw new Error(`${shellVersion}/${id}: retired archive integrity mismatch`)
      const archive = unzipSync(archiveBytes)
      const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'))
      if (
        manifest.schemaVersion !== 1 ||
        manifest.id !== id ||
        manifest.shellVersion !== shellVersion ||
        manifest.entry !== download.entry ||
        !Array.isArray(manifest.files) ||
        Object.keys(archive).length !== manifest.files.length + 1
      )
        throw new Error(`${shellVersion}/${id}: retired archive manifest mismatch`)
      for (const file of manifest.files) {
        const content = archive[file.path?.replace(/^\//u, '')]
        if (!content || content.length !== file.size || digest(content) !== file.sha256)
          throw new Error(`${shellVersion}/${id}: retired archive file integrity mismatch`)
      }
      continue
    }
    const known = packages.get(download.url)
    if (
      known?.id !== id ||
      !known.candidates.some(
        (candidate) =>
          candidate.sha256 === download.sha256 &&
          candidate.downloadBytes === download.downloadBytes,
      )
    )
      throw new Error(`${shellVersion}/${id}: retained catalog does not match verified candidates`)
  }
}

let packageCount = 0
await verifyConcurrently([...packages], async ([url, { id, candidates }]) => {
  const archiveBytes = await bytes(url)
  for (const candidate of candidates) {
    if (
      archiveBytes.length !== candidate.downloadBytes ||
      digest(archiveBytes) !== candidate.sha256
    )
      throw new Error(`${url}: download size or SHA-256 does not match ${id} catalog`)
  }
  const archive = unzipSync(archiveBytes)
  let metadata
  for (const candidate of candidates)
    if (candidate.manifest) {
      metadata ??= await bytes(candidate.manifest.url)
      if (
        candidate.manifest.url !== url.replace(/\.srlapp$/u, '.json') ||
        metadata.length !== candidate.manifest.size ||
        digest(metadata) !== candidate.manifest.sha256 ||
        !Buffer.from(metadata).equals(Buffer.from(archive['manifest.json'] ?? []))
      )
        throw new Error(`${url}: incremental manifest does not match the verified archive`)
    }
  if (!archive['manifest.json']) throw new Error(`${url}: missing manifest.json`)
  let manifest
  try {
    manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'))
  } catch {
    throw new Error(`${url}: manifest.json is invalid`)
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== id ||
    !Array.isArray(manifest.files) ||
    Object.keys(archive).length !== manifest.files.length + 1
  )
    throw new Error(`${url}: package manifest does not match catalog or contains undeclared files`)
  const appContentHash = (files, assetMode = 'host') =>
    digest(
      Buffer.from(
        JSON.stringify(
          files
            .filter((file) => assetMode === 'self-contained' || !file.bundled)
            .map(({ path, size, sha256 }) => [path, size, sha256])
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        ),
      ),
    )
  for (const file of manifest.files) {
    const content = archive[file.path?.replace(/^\//u, '')]
    if (!content || content.length !== file.size || digest(content) !== file.sha256)
      throw new Error(`${url}: packaged file ${file.path} failed size/SHA-256 verification`)
  }
  for (const candidate of candidates) {
    if (
      manifest.shellVersion !== candidate.shellVersion ||
      manifest.entry !== candidate.entry ||
      (manifest.hostApiVersion ?? 1) !== candidate.hostApiVersion
    )
      throw new Error(`${url}: package manifest metadata does not match its catalog`)
    if (!['host', 'self-contained'].includes(manifest.assetMode ?? 'host'))
      throw new Error(`${url}: unsupported APP asset mode`)
    const expectedContentHash = appContentHash(manifest.files, manifest.assetMode ?? 'host')
    if (
      (manifest.appContentHash !== undefined && manifest.appContentHash !== expectedContentHash) ||
      candidate.appContentHash !== expectedContentHash
    )
      throw new Error(`${url}: APP content integrity does not match its catalog`)
    if (
      !Number.isSafeInteger(candidate.appContentRevision) ||
      candidate.appContentRevision < 1 ||
      (manifest.appContentRevision ?? 1) !== candidate.appContentRevision
    )
      throw new Error(`${url}: APP content revision does not match its catalog`)
    if ((manifest.assetMode ?? 'host') !== (candidate.assetMode ?? 'host'))
      throw new Error(`${url}: APP asset mode does not match catalog`)
    const hostFiles = (
      manifest.hostFiles ??
      (manifest.assetMode === 'self-contained' ? [] : manifest.files.filter((file) => file.bundled))
    ).map(({ path, size, sha256, bundled }) => [path, size, sha256, Boolean(bundled)])
    const expectedHostFiles = candidate.hostFiles.map(({ path, size, sha256, bundled }) => [
      path,
      size,
      sha256,
      Boolean(bundled),
    ])
    if (JSON.stringify(hostFiles) !== JSON.stringify(expectedHostFiles))
      throw new Error(`${url}: host dependency list does not match its catalog`)
  }
  packageCount++
  if (packageCount % 11 === 0)
    console.log(`APP package integrity: ${packageCount}/${packages.size}`)
})

let shellCount = 0
await verifyConcurrently(inventory.shellFiles, async (file) => {
  const url = new URL(file.path, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/assets/'))
    throw new Error(`Rejected non-local shell asset URL: ${file.path}`)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`)
  const content = await responseBytes(response, url.pathname)
  if (content.length !== file.size || digest(content) !== file.sha256)
    throw new Error(`${url.pathname}: deployed shell asset failed size/SHA-256 verification`)
  shellCount++
  if (shellCount % 50 === 0)
    console.log(`Shell asset integrity: ${shellCount}/${inventory.shellFiles.length}`)
})

console.log(
  `Deployment verified at ${origin}: shell ${inventory.shellVersion}, host API ${inventory.hostApiVersion}, ${ids.length} APPs, ${packageCount} package URLs across APIs ${[...compatibilityCatalogs.keys()].sort().join('/')}, ${inventory.shellFiles.length} shell assets.`,
)
