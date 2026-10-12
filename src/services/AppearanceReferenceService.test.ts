import { describe, expect, it, vi } from 'vitest'
import type { ReferenceCatalog } from '../types/AppearanceReference'
import type { InstalledOfficialApp } from '../types/OfficialApp'
import { createAppearanceReferenceReader } from './AppearanceReferenceService'
import { createReferenceChapters, referenceMarkdown } from '../core/AppearanceReference'

const catalog: ReferenceCatalog = {
  version: 'host-current',
  fingerprint: 'host-source',
  vue: [['page.click(selector)', '调用原按钮。']],
  sources: [
    {
      path: 'old.css:1',
      rules: [
        { selector: '.obsolete', conditions: '', declarations: { color: 'var(--obsolete)' } },
      ],
    },
  ],
  scopes: { stitch: ['old.css:1'] },
}
const installed = (
  id: 'stitch' | 'draw',
  path: string,
  sha = 'a'.repeat(64),
): InstalledOfficialApp => ({
  schemaVersion: 1,
  id,
  shellVersion: 'host-current',
  installedAt: 1,
  entry: `/assets/${id}.js`,
  styles: [path],
  files: [{ path, size: 100, sha256: sha }],
})
const signal = () => new AbortController().signal

describe('实际安装的 APP 接口参考', () => {
  it('只读取所选 APP，沿资产清单替换旧源码教程；同版本号不同样式也按实物读取', async () => {
    const apps = [
      installed('stitch', '/assets/stitch-new.css'),
      installed('draw', '/assets/draw.css'),
    ]
    const read = vi.fn(
      async (_path: string, _signal: AbortSignal) =>
        '@media (max-width: 700px) { .actual { --实际颜色: red; color: var(--实际颜色) !important } }',
    )
    const reader = createAppearanceReferenceReader(catalog, async () => apps, read)
    const result = await reader.read(['stitch'], signal())
    expect(read.mock.calls.map(([path]) => path)).toEqual(['/assets/stitch-new.css'])
    const chapter = createReferenceChapters(result).find((item) => item.scope.value === 'stitch')!
    const markdown = referenceMarkdown([chapter], 'both')
    expect(markdown).toContain('--实际颜色')
    expect(markdown).toContain('!important')
    expect(markdown).toContain('@media (max-width: 700px)')
    expect(markdown).not.toContain('.obsolete')
    expect(markdown).toContain('已安装 APP 样式：host-current')
    expect(markdown).toContain('page.click(selector)')
    expect(await reader.read(['stitch'], signal())).toBe(result)
    expect(read).toHaveBeenCalledTimes(1)
    expect(catalog.sources[0]!.path).toBe('old.css:1')
  })

  it('更新样式 SHA/路径后失效旧内容，卸载后回到源码参考；不跨 APP 重读共享资产', async () => {
    let apps = [installed('stitch', '/assets/shared.css'), installed('draw', '/assets/shared.css')]
    let css = '.first { --first: 1px; gap: var(--first) }'
    const read = vi.fn(async () => css)
    const reader = createAppearanceReferenceReader(catalog, async () => apps, read)
    await reader.read(['stitch', 'draw'], signal())
    expect(read).toHaveBeenCalledTimes(1)
    apps = [installed('stitch', '/assets/replacement.css', 'b'.repeat(64))]
    css = '.second { --second: blue; color: var(--second) }'
    const next = await reader.read(['stitch'], signal())
    expect(read).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(next.sources)).toContain('--second')
    expect(JSON.stringify(next.sources)).not.toContain('--first')
    apps = []
    const removed = await reader.read(['stitch'], signal())
    expect(removed.scopes.stitch).toEqual(['old.css:1'])
    expect(removed.installed).toEqual({})
  })

  it('关闭取消读取，迟到结果不作为教程；失败后不缓存拒绝的请求', async () => {
    let finish!: (value: string) => void
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const reader = createAppearanceReferenceReader(
      catalog,
      async () => [installed('stitch', '/assets/late.css')],
      read,
    )
    const controller = new AbortController()
    const pending = reader.read(['stitch'], controller.signal)
    await Promise.resolve()
    controller.abort()
    finish('.late { color: red }')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    read.mockResolvedValueOnce('.new { color: blue }')
    const next = await reader.read(['stitch'], signal())
    expect(JSON.stringify(next.sources)).not.toContain('.late')
    expect(JSON.stringify(next.sources)).toContain('.new')
  })

  it('读取期间安装版本变化则拒绝旧结果；未知/外部地址不读取', async () => {
    let apps = [installed('stitch', '/assets/first.css')]
    const reader = createAppearanceReferenceReader(
      catalog,
      async () => apps,
      async () => {
        apps = [installed('stitch', '/assets/second.css')]
        return '.first { color: red }'
      },
    )
    await expect(reader.read(['stitch'], signal())).rejects.toThrow('APP 在读取教程期间已更新')
    const unsafe = vi.fn(async () => '')
    const invalid = createAppearanceReferenceReader(
      catalog,
      async () => [installed('stitch', 'https://external.test/theme.css')],
      unsafe,
    )
    await expect(invalid.read(['stitch'], signal())).rejects.toThrow('样式清单无效')
    expect(unsafe).not.toHaveBeenCalled()
  })
})
