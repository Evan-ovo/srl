import { existsSync, readFileSync, readdirSync } from 'node:fs'
import process from 'node:process'
import console from 'node:console'
import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'
import { URL } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'
import { officialAppIds } from './Check-FeatureContracts.mjs'

const directory = resolve(process.argv[2] ?? 'dist')
// Read the shared runtime policy without requiring Node's optional TypeScript loader.
const maxPackageFiles = Number(
  readFileSync(new URL('../src/core/OfficialAppHostApi.ts', import.meta.url), 'utf8').match(
    /export const OFFICIAL_APP_MAX_PACKAGE_FILES = (\d+)/u,
  )?.[1],
)
assert.ok(Number.isSafeInteger(maxPackageFiles) && maxPackageFiles > 0)
const read = (path) => readFileSync(resolve(directory, path.replace(/^\//u, '')))
const json = (path) => JSON.parse(read(path).toString('utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const contentHash = (files, assetMode = 'host') =>
  hash(
    Buffer.from(
      JSON.stringify(
        files
          .filter((file) => assetMode === 'self-contained' || !file.bundled)
          .map(({ path, size, sha256 }) => [path, size, sha256])
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    ),
  )
const inventory = json('official-app-assets.json')
const catalog = json(`official-apps/${inventory.shellVersion}/catalog.json`)
const compatibleCatalog = json(`official-apps/api-${inventory.hostApiVersion}/catalog.json`)
const offline = json('offline-assets.json')
const optional = new Set(inventory.files.map((path) => '/' + path))
const shellFiles = new Map(inventory.shellFiles.map((file) => [file.path, file]))
for (const [path, file] of shellFiles) {
  const bytes = read(path)
  assert.equal(bytes.length, file.size, `Shell asset size changed: ${path}`)
  assert.equal(hash(bytes), file.sha256, `Shell asset hash changed: ${path}`)
}
assert.deepEqual(
  Object.keys(catalog.apps).sort(),
  officialAppIds().sort(),
  'Current catalog must contain every registered official APP',
)
assert.equal(compatibleCatalog.hostApiVersion, inventory.hostApiVersion)
assert.deepEqual(Object.keys(compatibleCatalog.apps).sort(), Object.keys(catalog.apps).sort())
for (const [id, candidates] of Object.entries(compatibleCatalog.apps)) {
  assert.ok(Array.isArray(candidates) && candidates.length > 0, `${id}: no compatible packages`)
  assert.equal(
    catalog.apps[id].appContentRevision,
    Math.max(...candidates.map((candidate) => candidate.appContentRevision)),
    `${id}: current APP revision cannot trail a compatible package`,
  )
  const urls = new Set()
  for (const candidate of candidates) {
    assert.equal(candidate.hostApiVersion, inventory.hostApiVersion)
    assert.ok(!urls.has(candidate.url), `${id}: duplicate package URL`)
    urls.add(candidate.url)
    const bytes = read(candidate.url)
    assert.equal(bytes.length, candidate.downloadBytes, `${id}: candidate size`)
    assert.equal(hash(bytes), candidate.sha256, `${id}: candidate hash`)
    const archive = unzipSync(bytes)
    if (candidate.manifest) {
      const metadata = read(candidate.manifest.url)
      assert.equal(candidate.manifest.url, candidate.url.replace(/\.srlapp$/u, '.json'))
      assert.equal(metadata.length, candidate.manifest.size)
      assert.equal(hash(metadata), candidate.manifest.sha256)
      assert.deepEqual(metadata, Buffer.from(archive['manifest.json']))
    }
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']))
    assert.equal(manifest.id, id)
    assert.equal(manifest.hostApiVersion ?? 1, candidate.hostApiVersion)
    assert.equal(manifest.shellVersion, candidate.shellVersion)
    assert.equal(manifest.entry, candidate.entry)
    assert.equal(manifest.runtimeEntry, candidate.runtimeEntry)
    assert.ok(['host', 'self-contained'].includes(manifest.assetMode ?? 'host'))
    const expectedContentHash = contentHash(manifest.files, manifest.assetMode ?? 'host')
    if (manifest.appContentHash !== undefined)
      assert.equal(
        manifest.appContentHash,
        expectedContentHash,
        `${id}: manifest APP content integrity`,
      )
    assert.equal(
      candidate.appContentHash,
      expectedContentHash,
      `${id}: candidate APP content integrity`,
    )
    assert.equal(manifest.appContentRevision ?? 1, candidate.appContentRevision)
    assert.ok(
      Number.isSafeInteger(candidate.appContentRevision) && candidate.appContentRevision >= 1,
    )
    assert.deepEqual(
      candidate.hostFiles,
      manifest.hostFiles ??
        (manifest.assetMode === 'self-contained'
          ? []
          : manifest.files.filter((file) => file.bundled)),
      `${id}: candidate host requirements`,
    )
  }
}
for (const [id, download] of Object.entries(catalog.apps)) {
  const bytes = read(download.url)
  assert.equal(bytes.length, download.downloadBytes, id)
  assert.equal(hash(bytes), download.sha256, id)
  const archive = unzipSync(bytes)
  const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']))
  assert.equal(manifest.id, id)
  assert.equal(manifest.shellVersion, inventory.shellVersion)
  assert.equal(manifest.hostApiVersion, inventory.hostApiVersion)
  assert.equal(
    manifest.appContentHash,
    contentHash(manifest.files, manifest.assetMode ?? 'host'),
    `${id}: APP content integrity`,
  )
  assert.equal(
    download.appContentHash,
    manifest.appContentHash,
    `${id}: catalog APP content integrity`,
  )
  assert.equal(download.appContentRevision, manifest.appContentRevision)
  assert.equal(download.assetMode, manifest.assetMode)
  assert.ok(manifest.hostFiles?.length, `${id}: missing shared Vue runtime requirements`)
  assert.deepEqual(download.hostFiles, manifest.hostFiles)
  for (const file of manifest.files.filter((file) => file.bundled))
    assert.ok(
      manifest.hostFiles.some((host) => host.path === file.path),
      `${id}: shared product services must use shell owners`,
    )
  for (const file of manifest.hostFiles) {
    const hostFile = shellFiles.get(file.path)
    const packedFile = manifest.files.find((packed) => packed.path === file.path)
    assert.ok(hostFile && packedFile, `${id}: runtime must exist in shell and APP`)
    assert.equal(hostFile.sha256, file.sha256)
    assert.equal(hostFile.size, file.size)
    assert.equal(packedFile.sha256, file.sha256)
    assert.equal(packedFile.size, file.size)
  }
  assert.ok(Number.isSafeInteger(download.appContentRevision) && download.appContentRevision >= 1)
  assert.equal(manifest.entry, download.entry)
  assert.equal(manifest.runtimeEntry, download.runtimeEntry)
  assert.ok(manifest.hostFiles.some((file) => file.path === manifest.runtimeEntry))
  assert.ok(Object.keys(archive).length <= maxPackageFiles, `${id}: too many archive entries`)
  assert.equal(Object.keys(archive).length, manifest.files.length + 1)
  assert.ok(manifest.files.some((file) => file.path === manifest.entry && !file.bundled))
  for (const file of manifest.files) {
    const packed = archive[file.path.slice(1)]
    assert.ok(packed, `${id}: missing ${file.path}`)
    assert.equal(packed.length, file.size)
    assert.equal(hash(packed), file.sha256)
    // Vite finalizes dynamic-import preloads late; archives must contain those final bytes.
    assert.deepEqual(
      Buffer.from(packed),
      read(file.path),
      `${id}: stale packaged code ${file.path}`,
    )
    assert.equal(optional.has(file.path), !file.bundled)
    if (file.bundled) {
      const hostFile = shellFiles.get(file.path)
      assert.ok(hostFile, `${id}: missing host asset ${file.path}`)
      assert.equal(hostFile.size, file.size)
      assert.equal(hostFile.sha256, file.sha256)
    }
  }
  for (const style of manifest.styles) assert.ok(manifest.files.some((file) => file.path === style))
}
for (const asset of offline.assets) {
  assert.ok(!optional.has(asset.url), `Optional APP precached: ${asset.url}`)
  assert.ok(!asset.url.startsWith('/official-apps/'), `Package precached: ${asset.url}`)
}
// Released APKs request their original build, even after the website is upgraded.
// Check both the immutable archive and Vite's copy into the deployment directory.
const retainedRoot = resolve('public/official-apps')
let retainedPackages = 0
let needsLegacyWorkbenchCover = false
for (const build of readdirSync(retainedRoot, { withFileTypes: true })) {
  assert.ok(build.isDirectory() && /^srl-(?:public-)?\d+\.\d+\.\d+-v\d+$/u.test(build.name))
  const catalogPath = `official-apps/${build.name}/catalog.json`
  const sourceCatalog = readFileSync(resolve('public', catalogPath))
  assert.deepEqual(read(catalogPath), sourceCatalog, `Retained catalog changed: ${build.name}`)
  const retained = JSON.parse(sourceCatalog.toString('utf8'))
  assert.equal(retained.shellVersion, build.name)
  assert.equal(retained.schemaVersion, 1)
  for (const [id, download] of Object.entries(retained.apps)) {
    const prefix = `/official-apps/${build.name}/`
    assert.ok(download.url.startsWith(prefix))
    assert.match(download.url.slice(prefix.length), /^[\w-]+-[a-f0-9]{16}\.srlapp$/u)
    const bytes = read(download.url)
    assert.deepEqual(bytes, readFileSync(resolve('public', download.url.slice(1))))
    assert.equal(bytes.length, download.downloadBytes, `${build.name}/${id}`)
    assert.equal(hash(bytes), download.sha256, `${build.name}/${id}`)
    const archive = unzipSync(bytes)
    assert.ok(
      Object.keys(archive).length <= maxPackageFiles,
      `${build.name}/${id}: too many archive entries`,
    )
    if (id === 'frontendWorkshop')
      needsLegacyWorkbenchCover ||= Object.entries(archive).some(
        ([path, content]) =>
          path.endsWith('.css') &&
          Buffer.from(content).toString('utf8').includes('/images/frontend-workbench-cover-v1.jpg'),
      )
    const manifest = JSON.parse(new TextDecoder().decode(archive['manifest.json']))
    assert.equal(manifest.shellVersion, build.name)
    assert.equal(manifest.id, id)
    assert.equal(manifest.entry, download.entry)
    const retainedApi = manifest.hostApiVersion ?? 1
    assert.ok(inventory.compatibleHostApiVersions.includes(retainedApi))
    const retainedCompatibility = json(`official-apps/api-${retainedApi}/catalog.json`)
    assert.equal(retainedCompatibility.schemaVersion, 1)
    assert.equal(retainedCompatibility.hostApiVersion, retainedApi)
    // Retired APPs keep their immutable archive, but leave active API catalogs.
    if (Object.hasOwn(catalog.apps, id))
      assert.ok(
        retainedCompatibility.apps[id]?.some(
          (candidate) =>
            candidate.url === download.url &&
            candidate.sha256 === download.sha256 &&
            candidate.hostApiVersion === retainedApi,
        ),
        `${build.name}/${id}: original API compatibility catalog is missing the retained package`,
      )
    else assert.equal(retainedCompatibility.apps[id], undefined)
    assert.equal(Object.keys(archive).length, manifest.files.length + 1)
    for (const file of manifest.files) {
      const packed = archive[file.path.slice(1)]
      assert.ok(packed, `${build.name}/${id}: missing ${file.path}`)
      assert.equal(packed.length, file.size)
      assert.equal(hash(packed), file.sha256)
    }
    retainedPackages++
  }
}
if (needsLegacyWorkbenchCover)
  assert.equal(
    hash(read('images/frontend-workbench-cover-v1.jpg')),
    hash(readFileSync(resolve('src/assets/frontend-workbench-cover-v1.jpg'))),
    'Retained workbench cover bytes changed',
  )
else
  assert.ok(
    !existsSync(resolve(directory, 'images/frontend-workbench-cover-v1.jpg')),
    'Unused legacy workbench cover retained',
  )
console.log(
  `Official APP packages verified: ${Object.keys(catalog.apps).length} current + ${retainedPackages} retained packages, ${optional.size} optional assets; final bytes and offline boundaries match.`,
)
