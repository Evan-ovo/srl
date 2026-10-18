/** @vitest-environment node */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build, type Plugin } from 'vite'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  officialAppContentHash,
  officialAppPackagesPlugin,
  reuseReleasedOfficialAppPackage,
} from './OfficialAppPackages'

const files = {
  'manifest.json': strToU8('{"shellVersion":"srl-test"}'),
  'assets/app.js': strToU8('export const value=1'),
}
const released = zipSync(files, { mtime: new Date('2020-01-01T00:00:00Z') })
const metadata = {
  url: '/official-apps/srl-test/app.srlapp',
  sha256: createHash('sha256').update(released).digest('hex'),
  downloadBytes: released.length,
}

describe('released official APP rebuilds', () => {
  it('tracks only APP-owned files in a deterministic integrity fingerprint', () => {
    const files = [
      { path: '/assets/shared.js', size: 4, sha256: 'a'.repeat(64), bundled: true },
      { path: '/assets/app.js', size: 3, sha256: 'b'.repeat(64) },
    ]
    const version = officialAppContentHash(files)
    expect(officialAppContentHash([...files].reverse())).toBe(version)
    expect(officialAppContentHash([{ ...files[0]!, sha256: 'c'.repeat(64) }, files[1]!])).toBe(
      version,
    )
    expect(officialAppContentHash([files[0]!, { ...files[1]!, sha256: 'd'.repeat(64) }])).not.toBe(
      version,
    )
  })
  it('reuses the exact released ZIP when only a rebuild timestamp would differ', () => {
    const rebuilt = zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') })
    expect(rebuilt).not.toEqual(released)
    expect(reuseReleasedOfficialAppPackage(released, files, metadata)).toBe(released)
  })
  it('refuses changed code under the same released build ID', () => {
    expect(() =>
      reuseReleasedOfficialAppPackage(
        released,
        { ...files, 'assets/app.js': strToU8('export const value=2') },
        metadata,
      ),
    ).toThrow('new buildId')
  })
  it('refuses changes to the file graph or manifest', () => {
    expect(() =>
      reuseReleasedOfficialAppPackage(
        released,
        { ...files, 'assets/new.js': strToU8('new') },
        metadata,
      ),
    ).toThrow('new buildId')
    expect(() =>
      reuseReleasedOfficialAppPackage(
        released,
        { ...files, 'manifest.json': strToU8('{}') },
        metadata,
      ),
    ).toThrow('new buildId')
  })
  it('does not reuse a corrupt archive or an incorrect catalog digest', () => {
    expect(() => reuseReleasedOfficialAppPackage(released.subarray(1), files, metadata)).toThrow(
      'verification',
    )
    expect(() =>
      reuseReleasedOfficialAppPackage(released, files, { ...metadata, sha256: '0'.repeat(64) }),
    ).toThrow('verification')
  })
})

describe('official APP renderer build identity', () => {
  async function sample(
    version: string,
    extraHostApis: boolean,
    changedVue = false,
    productDependency = false,
    publicDirectory: string | false = false,
    hostLazyTool = false,
    requiredCompiler = false,
    changes: { serviceLabel?: string; component?: string } = {},
  ) {
    const fixture: Plugin = {
      name: 'official-app-consumer-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'fixture:host') return '\0' + id
        if (id === 'fixture:gate') return resolve('src/components/OfficialAppGate.vue')
        if (id === 'fixture:product') return '\0' + id
        if (id === 'fixture:source-compiler')
          return resolve('src/services/FrontendWorkshopBrowserSourceCompilerService.ts')
        if (id === 'fixture:source-engine') return '\0' + id
        if (id === 'fixture:service' || id === 'fixture:host-tool' || id === 'fixture:app-tool')
          return '\0' + id
      },
      load(id) {
        if (productDependency && id === '\0virtual:srl-official-app-runtime')
          return "export * from 'vue'; export {productValue} from 'fixture:product';"
        if (id === '\0fixture:product') return 'export const productValue=42;'
        if (id === '\0fixture:source-engine')
          return 'export const compiler="required-source-engine";'
        if (
          id
            .replaceAll('\\', '/')
            .endsWith('/services/FrontendWorkshopBrowserSourceCompilerService.ts')
        )
          return "export const compile=()=>import('fixture:source-engine');"
        if (id === '\0fixture:host-tool') return 'export const compiler="host-only-heavy-compiler";'
        if (id === '\0fixture:app-tool') return 'export const tool="app-owned-lazy-tool";'
        if (id === '\0fixture:service')
          return `export const label=${JSON.stringify(changes.serviceLabel ?? 'shared service')}; export const compile=()=>import('fixture:host-tool');`
        if (id === '\0fixture:host')
          return `import {createApp,h${extraHostApis ? ',useTemplateRef,onActivated,watchPostEffect' : ''}} from 'vue';
            ${hostLazyTool ? "import {compile} from 'fixture:service'; globalThis.compile=compile;" : ''}
            ${requiredCompiler ? "globalThis.sourceCompiler=()=>import('fixture:source-compiler');" : ''}
            import {gate} from 'fixture:gate';
            import {entries,runtimeEntry} from 'virtual:srl-official-app-entries';
            globalThis.fixture={createApp,h,gate,entries,runtimeEntry,version:${JSON.stringify(version)}${extraHostApis ? ',useTemplateRef,onActivated,watchPostEffect' : ''}};`
        if (id.replaceAll('\\', '/').endsWith('/components/OfficialAppGate.vue'))
          return "import {h} from 'vue'; export const gate=()=>h('main');"
        if (id.replaceAll('\\', '/').includes('/src/components/') && id.endsWith('.vue'))
          return `import {defineComponent,h,renderSlot} from 'vue';
            ${hostLazyTool ? "import {label} from 'fixture:service';" : ''}
            export default defineComponent({render(){return h('article',${hostLazyTool ? "{onClick:()=>import('fixture:app-tool')}," : ''}[${hostLazyTool ? 'label,' : ''}${changes.component && id.endsWith('/' + changes.component) ? '"changed APP content",' : ''}renderSlot(this.$slots,'default')])}});`
      },
      transform(code, id) {
        if (changedVue && id.replaceAll('\\', '/').includes('/@vue/runtime-core/'))
          return code.replace(/const version = "[^"]+"/u, 'const version = "changed-vue-fixture"')
      },
    }
    const result = await build({
      configFile: false,
      publicDir: publicDirectory,
      logLevel: 'silent',
      plugins: [fixture, officialAppPackagesPlugin(version)],
      build: { write: false, rolldownOptions: { input: 'fixture:host' } },
    })
    if (!('output' in result)) throw new Error('Expected one fixture build')
    const assets = result.output.filter((file) => file.type === 'asset')
    const catalogAsset = assets.find(
      (file) => file.fileName === `official-apps/${version}/catalog.json`,
    )
    if (!catalogAsset) throw new Error('Fixture APP catalog missing')
    const catalog = JSON.parse(String(catalogAsset.source)) as {
      apps: Record<string, { runtimeEntry: string; hostFiles: unknown[]; url: string }>
    }
    const app = catalog.apps.draw!
    const archive = assets.find((file) => '/' + file.fileName === app.url)
    if (!archive) throw new Error('Fixture APP archive missing')
    const bytes = typeof archive.source === 'string' ? strToU8(archive.source) : archive.source
    return { app, packageFiles: unzipSync(bytes), output: result.output }
  }

  it('keeps installed APP renderer bytes stable across shell releases and new Vue consumers', async () => {
    const before = await sample('shell-before', false)
    const after = await sample('shell-after', true)
    expect(after.app.runtimeEntry).toBe(before.app.runtimeEntry)
    const renderer = (files: unknown[]) =>
      (files as Array<{ path: string }>).filter((file) => file.path === before.app.runtimeEntry)
    expect(renderer(after.app.hostFiles)).toHaveLength(1)
    expect(renderer(after.app.hostFiles)).toEqual(renderer(before.app.hostFiles))
    // The loading gate belongs to the shell; rebuilding it is not an APP dependency change.
    expect(after.app.hostFiles).toEqual(before.app.hostFiles)
    const owned = (archive: Record<string, Uint8Array>) =>
      Object.fromEntries(Object.entries(archive).filter(([name]) => name !== 'manifest.json'))
    expect(owned(after.packageFiles)).toEqual(owned(before.packageFiles))
    for (const file of renderer(after.app.hostFiles)) {
      const path = file.path.slice(1)
      expect(after.packageFiles[path]).toEqual(before.packageFiles[path])
      expect(after.output.find((chunk) => chunk.fileName === path)?.type).toBe('chunk')
    }
  }, 20000)

  it('changes renderer identity when the actual Vue implementation changes', async () => {
    const before = await sample('shell-before', false)
    const after = await sample('shell-after', false, true)
    expect(after.app.runtimeEntry).not.toBe(before.app.runtimeEntry)
    expect(after.app.hostFiles).not.toEqual(before.app.hostFiles)
  }, 20000)

  it('does not change an unrelated APP when another APP changes', async () => {
    const before = await sample('shell-before', false)
    const after = await sample('shell-after', false, false, false, false, false, false, {
      component: 'PresetStitcherApp.vue',
    })
    expect(after.app.hostFiles).toEqual(before.app.hostFiles)
    expect(after.app.runtimeEntry).toBe(before.app.runtimeEntry)
    const { 'manifest.json': beforeManifest, ...beforeFiles } = before.packageFiles
    const { 'manifest.json': afterManifest, ...afterFiles } = after.packageFiles
    expect(beforeManifest).toBeDefined()
    expect(afterManifest).toBeDefined()
    expect(afterFiles).toEqual(beforeFiles)
    expect(
      after.output.some(
        (file) => file.type === 'chunk' && file.code.includes('changed APP content'),
      ),
    ).toBe(true)
  }, 20000)

  it('still declares changed product services actually imported by an APP', async () => {
    const before = await sample('shell-before', false, false, false, false, true)
    const after = await sample('shell-after', false, false, false, false, true, false, {
      serviceLabel: 'changed shared service',
    })
    expect(after.app.hostFiles).not.toEqual(before.app.hostFiles)
    const changedService = after.output.find(
      (file) => file.type === 'chunk' && file.code.includes('changed shared service'),
    )!
    expect(changedService).toBeDefined()
    expect(after.app.hostFiles).toContainEqual(
      expect.objectContaining({ path: '/' + changedService.fileName, bundled: true }),
    )
    expect(after.packageFiles[changedService.fileName]).toBeDefined()
  }, 20000)

  it('keeps a host-only lazy compiler in the shell without copying it into every APP', async () => {
    const result = await sample('shell-lazy-owner', false, false, false, false, true)
    const compiler = result.output.find(
      (file) => file.type === 'chunk' && file.code.includes('host-only-heavy-compiler'),
    )
    expect(compiler).toBeDefined()
    expect(result.packageFiles[compiler!.fileName]).toBeUndefined()
    const ownLazy = result.output.find(
      (file) => file.type === 'chunk' && file.code.includes('app-owned-lazy-tool'),
    )
    expect(ownLazy).toBeDefined()
    expect(result.packageFiles[ownLazy!.fileName]).toBeDefined()
    const inventory = result.output.find(
      (file) => file.type === 'asset' && file.fileName === 'official-app-assets.json',
    )!
    const manifest = JSON.parse(String(inventory.type === 'asset' ? inventory.source : ''))
    expect(
      manifest.shellFiles.some((file: { path: string }) => file.path === '/' + compiler!.fileName),
    ).toBe(true)
    expect(manifest.files).not.toContain(compiler!.fileName)
  }, 20000)

  it('retains the frontend source compiler capability while excluding it from ordinary APPs', async () => {
    const result = await sample('shell-required-compiler', false, false, false, false, false, true)
    const engine = result.output.find(
      (file) => file.type === 'chunk' && file.code.includes('required-source-engine'),
    )!
    expect(engine).toBeDefined()
    expect(result.packageFiles[engine.fileName]).toBeUndefined()
    const catalogAsset = result.output.find(
      (file) =>
        file.type === 'asset' &&
        file.fileName === 'official-apps/shell-required-compiler/catalog.json',
    )!
    const catalog = JSON.parse(String(catalogAsset.type === 'asset' ? catalogAsset.source : ''))
    const archive = result.output.find(
      (file) => file.type === 'asset' && '/' + file.fileName === catalog.apps.frontendWorkshop.url,
    )!
    if (archive.type !== 'asset') throw new Error('Expected frontend package')
    const bytes = typeof archive.source === 'string' ? strToU8(archive.source) : archive.source
    expect(unzipSync(bytes)[engine.fileName]).toBeDefined()
  }, 20000)

  it('keeps an API 1 catalog for released APKs when the current host moves to API 2', async () => {
    mkdirSync(resolve('.codex-tmp'), { recursive: true })
    const temporary = mkdtempSync(resolve('.codex-tmp/official-app-legacy-'))
    const publicDirectory = resolve(temporary, 'public')
    const packages = resolve(publicDirectory, 'official-apps')
    const retained = resolve(packages, 'srl-0.0.150-v310')
    mkdirSync(retained, { recursive: true })
    const manifest = {
      id: 'draw',
      shellVersion: 'srl-0.0.150-v310',
      hostApiVersion: 1,
      appContentHash: 'b'.repeat(64),
      appContentRevision: 1,
      files: [],
    }
    const original = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })
    const name = 'draw-' + 'a'.repeat(16) + '.srlapp'
    const packagePath = resolve(retained, name)
    const catalogPath = resolve(retained, 'catalog.json')
    const url = '/official-apps/srl-0.0.150-v310/' + name
    writeFileSync(packagePath, original)
    writeFileSync(
      catalogPath,
      JSON.stringify({
        apps: {
          draw: {
            url,
            sha256: createHash('sha256').update(original).digest('hex'),
            downloadBytes: original.length,
          },
        },
      }),
    )
    try {
      const result = await sample('current-shell', false, false, false, publicDirectory)
      const catalog = (version: number) => {
        const output = result.output.find(
          (file) =>
            file.type === 'asset' && file.fileName === `official-apps/api-${version}/catalog.json`,
        )
        if (!output || output.type !== 'asset') throw new Error(`Missing API ${version} catalog`)
        return JSON.parse(String(output.source))
      }
      expect(catalog(1)).toMatchObject({
        schemaVersion: 1,
        hostApiVersion: 1,
        apps: { draw: [expect.objectContaining({ url, hostApiVersion: 1 })] },
      })
      expect(
        catalog(2).apps.draw.every((item: { hostApiVersion: number }) => item.hostApiVersion === 2),
      ).toBe(true)
      const inventory = result.output.find(
        (file) => file.type === 'asset' && file.fileName === 'official-app-assets.json',
      )
      if (!inventory || inventory.type !== 'asset') throw new Error('Missing fixture inventory')
      expect(JSON.parse(String(inventory.source)).compatibleHostApiVersions).toEqual([1, 2])
      expect(readFileSync(packagePath)).toEqual(Buffer.from(original))
    } finally {
      unlinkSync(packagePath)
      unlinkSync(catalogPath)
      for (const directory of [retained, packages, publicDirectory, temporary]) rmdirSync(directory)
    }
  }, 20000)

  it('refuses product dependencies in the shared renderer graph', async () => {
    await expect(sample('contaminated-shell', false, false, true)).rejects.toThrow(
      'must not include product modules',
    )
  }, 20000)
})
