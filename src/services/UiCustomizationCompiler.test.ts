import { createEditableUiView } from '../core/UiViewStarter'
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { FrontendWorkshopBrowserSourceCompilerService } from './FrontendWorkshopBrowserSourceCompilerService'
import { vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { compileCustomUiView } from './UiCustomizationService'

vi.mock('../utils/PreviewVendorLibs', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const vue = await readFile(
    createRequire(import.meta.url).resolve('vue/dist/vue.global.prod.js'),
    'utf8',
  )
  return { loadPreviewVendorLibs: async () => ({ vue }) }
})

it.each(
  ['vue', 'js'].flatMap((entry) =>
    ['setup', 'mounted', 'render', 'event', 'async'].map((stage) => [entry, stage]),
  ),
)('%s入口Vue内部捕获的%s异常也传给隔离运行失败保护', async (entry, stage) => {
  const fail = 'throw new Error("vue-probe")'
  const vueSource =
    stage === 'mounted'
      ? `<script setup>import {onMounted} from 'vue';onMounted(()=>{${fail}})</script><template><div>内容</div></template>`
      : stage === 'setup'
        ? `<script setup>${fail}</script><template><div>内容</div></template>`
        : stage === 'render'
          ? `<script setup>function broken(){${fail}}</script><template><div>{{broken()}}</div></template>`
          : `<script setup>function broken(){${stage === 'async' ? 'return Promise.reject(new Error("vue-probe"))' : fail}}</script><template><button @click="broken">触发</button></template>`
  const source =
    entry === 'vue'
      ? vueSource
      : `import {createApp, h, onMounted} from 'vue';function broken(){${stage === 'async' ? 'return Promise.reject(new Error("vue-probe"))' : fail}};createApp({setup(){${stage === 'setup' ? 'broken()' : stage === 'mounted' ? 'onMounted(broken)' : ''}},render(){${stage === 'render' ? 'broken();' : ''}return h('button',{onClick:broken},'触发')}}).mount(document.body.appendChild(document.createElement('div')))`
  const path = `View.${entry}`
  const compiled = await compileCustomUiView(
    {
      entryPath: path,
      files: [{ path, contents: source }],
      enabled: true,
      allowNetwork: false,
    },
    { build },
  )
  const dom = new JSDOM(`<html><body>${compiled}</body></html>`, { runScripts: 'outside-only' })
  try {
    const errors: string[] = []
    dom.window.addEventListener('error', (event) => {
      event.preventDefault()
      errors.push(event.message)
    })
    vi.spyOn(dom.window.console, 'error').mockImplementation(() => {})
    for (const script of dom.window.document.querySelectorAll('script'))
      dom.window.eval(script.textContent!)
    if (stage === 'event' || stage === 'async') dom.window.document.querySelector('button')!.click()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(errors).toEqual(['vue-probe'])
  } finally {
    dom.window.close()
  }
})

it('真实编译 Vue + TypeScript 子组件和相对 SVG 样式素材', async () => {
  const compiler = new FrontendWorkshopBrowserSourceCompilerService({ build })
  const result = await compiler.compile({
    entryPath: 'View.vue',
    files: [
      {
        path: 'View.vue',
        contents:
          '<script setup lang="ts">import Button from "./Button.vue"; const label: string = "异形按钮"</script><template><Button :label="label"/></template><style>.panel{background:url("./shape.svg")}</style>',
      },
      {
        path: 'Button.vue',
        contents:
          '<script setup lang="ts">defineProps<{label:string}>()</script><template><button>{{label}}</button></template>',
      },
      {
        path: 'shape.svg',
        contents: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 5Z"/></svg>',
      },
    ],
  })
  expect(result.authorSource).toContain('data:image/svg+xml')
  expect(result.authorSource).toContain('\\u5F02\\u5F62\\u6309\\u94AE')
  expect(result.authorSource).not.toContain('./shape.svg')
})

it('编译可编辑APP模板和Vue helper，不把标题当脚本执行', async () => {
  const view = createEditableUiView('云备份 </script><script>bad()</script>')
  expect(view.enabled).toBe(false)
  expect(view.files[0]!.contents).toContain('const title = ref(')
  expect(view.files[0]!.contents).not.toContain('bad()</script>')
  const result = await new FrontendWorkshopBrowserSourceCompilerService({ build }).compile(view)
  expect(result.authorSource).toContain('data-srl-view-root')
  expect(result.authorSource).toContain('feature-app-header__back')
})
