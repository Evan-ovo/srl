import { describe, expect, it } from 'vitest'

import { extractTavernHelperScripts, readTavernHelperScriptBlob } from './TavernHelperScriptParser'

describe('TavernHelperScriptParser', () => {
  it('preserves hidden buttons and disabled static controls through helper-record roundtrips', () => {
    const input = {
      type: 'script',
      id: 'phone',
      name: '手机',
      content: 'run()',
      button: {
        enabled: true,
        buttons: [
          { name: '开关', visible: true },
          { name: '隐形', visible: false },
        ],
      },
    }
    const first = extractTavernHelperScripts([input], { source: 'character' })[0]!
    expect(first.buttonDefinitions).toEqual(input.button.buttons)
    expect(
      extractTavernHelperScripts([{ ...first, type: 'script' }], { source: 'bound' })[0]
        ?.buttonDefinitions,
    ).toEqual(input.button.buttons)
    expect(
      extractTavernHelperScripts([{ ...input, button: { ...input.button, enabled: false } }], {
        source: 'character',
      })[0]?.buttonDefinitions?.every((button) => !button.visible),
    ).toBe(true)
  })
  it('honors folder and script enable switches', () => {
    const scripts = extractTavernHelperScripts(
      [
        {
          type: 'folder',
          name: '界面',
          enabled: false,
          scripts: [{ type: 'script', id: 'status', name: '状态栏', content: 'render()' }],
        },
        { type: 'script', id: 'active', name: '交互', content: 'bind()', enabled: true },
      ],
      { source: 'character' },
    )

    expect(scripts).toMatchObject([
      { id: 'status', folder: '界面', enabled: false },
      { id: 'active', enabled: true },
    ])
  })

  it('保留角色卡脚本自身的数据域供脚本 iframe 使用', () => {
    const scripts = extractTavernHelperScripts(
      [
        {
          type: 'script',
          id: 'stateful',
          name: '有状态脚本',
          content: 'getVariables({ type: "script" })',
          data: { selected: 2 },
          enabled: true,
        },
      ],
      { source: 'character' },
    )

    expect(scripts[0]?.data).toEqual({ selected: 2 })
  })

  it('extracts nested Tavern Helper scripts from a bound JSON resource', async () => {
    const blob = new Blob([
      JSON.stringify({
        extensions: {
          tavern_helper: {
            scripts: [
              {
                type: 'script',
                id: 'manual',
                name: '手动脚本',
                content: 'run()',
                enabled: true,
              },
            ],
          },
        },
      }),
    ])

    await expect(
      readTavernHelperScriptBlob(blob, 'manual.json', {
        source: 'bound',
        fallbackName: '绑定资源',
      }),
    ).resolves.toMatchObject([
      { id: 'manual', name: '手动脚本', source: 'bound', content: 'run()', enabled: true },
    ])
  })

  it('reads TavernHelper character settings stored as entry arrays like upstream Object.fromEntries', () => {
    const scripts = extractTavernHelperScripts(
      {
        extensions: {
          tavern_helper: [
            [
              'scripts',
              [
                {
                  type: 'script',
                  id: 'array-settings-script',
                  name: 'array settings script',
                  content: 'runArraySettings()',
                  enabled: true,
                },
              ],
            ],
          ],
        },
      },
      { source: 'character' },
    )

    expect(scripts).toMatchObject([
      {
        id: 'array-settings-script',
        name: 'array settings script',
        content: 'runArraySettings()',
        enabled: true,
      },
    ])
  })

  it('treats a plain JavaScript resource as one manually bound script', async () => {
    const scripts = await readTavernHelperScriptBlob(
      new Blob(['document.body.dataset.ready = "yes"']),
      'layout.js',
      { source: 'bound', fallbackName: '布局脚本' },
    )

    expect(scripts).toMatchObject([
      {
        name: '布局脚本',
        source: 'bound',
        content: 'document.body.dataset.ready = "yes"',
        enabled: true,
      },
    ])
  })

  it('uses Tavern Helper defaults for omitted modern enable switches', () => {
    const scripts = extractTavernHelperScripts(
      [
        { type: 'script', id: 'script-default', name: '脚本', content: 'run()' },
        {
          type: 'folder',
          id: 'folder-default',
          name: '文件夹',
          scripts: [{ type: 'script', id: 'nested', content: 'nested()', enabled: true }],
        },
      ],
      { source: 'character' },
    )

    expect(scripts).toMatchObject([
      { id: 'script-default', enabled: false },
      { id: 'nested', folder: '文件夹', enabled: false },
    ])
  })

  it('reads legacy TavernHelper_scripts wrapper records', () => {
    const scripts = extractTavernHelperScripts(
      [
        {
          type: 'folder',
          name: '旧文件夹',
          value: [
            {
              type: 'script',
              value: {
                id: 'legacy',
                name: '旧脚本',
                content: 'legacy()',
                enabled: true,
              },
            },
          ],
        },
      ],
      { source: 'character' },
    )

    expect(scripts).toMatchObject([
      {
        id: 'legacy',
        name: '旧脚本',
        folder: '旧文件夹',
        content: 'legacy()',
        enabled: true,
      },
    ])
  })
})
