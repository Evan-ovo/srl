import { createEditableUiView } from '../core/UiViewStarter'
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { FrontendWorkshopBrowserSourceCompilerService } from './FrontendWorkshopBrowserSourceCompilerService'

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
