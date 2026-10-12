import type { CustomUiView, CustomUiViews } from '../types/UiCustomization'

/** Uses the browser source compiler's existing project budget, including decoded assets. */
export function normalizeUiViews(value: unknown, disable = false): CustomUiViews {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('界面源码格式无效')
  const result: CustomUiViews = {}
  let total = 0
  for (const [scope, raw] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9:_-]{1,100}$/.test(scope) ||
      ['__proto__', 'constructor', 'prototype'].includes(scope) ||
      !raw ||
      typeof raw !== 'object'
    )
      throw new Error('界面范围无效')
    const view = raw as CustomUiView
    if (!Array.isArray(view.files) || !view.files.length || view.files.length > 256)
      throw new Error('界面项目需要 1–256 个文件')
    const paths = new Set<string>()
    const files = view.files.map((file) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        typeof file.contents !== 'string' ||
        !/^[\w\u3400-\u9fff./ -]+$/u.test(file.path) ||
        file.path.startsWith('/') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        paths.has(file.path) ||
        (file.encoding !== undefined && file.encoding !== 'base64')
      )
        throw new Error('界面文件路径或内容无效')
      paths.add(file.path)
      if (
        file.encoding === 'base64' &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contents)
      )
        throw new Error('界面素材编码无效')
      const size =
        file.encoding === 'base64'
          ? Math.ceil((file.contents.length * 3) / 4)
          : new TextEncoder().encode(file.contents).byteLength
      if (size > 5 * 1024 * 1024) throw new Error('单个界面文件超过浏览器编译器的 5 MiB 预算')
      total += size
      if (total > 20 * 1024 * 1024) throw new Error('界面源码与素材超过浏览器编译器的 20 MiB 预算')
      return {
        path: file.path,
        contents: file.contents,
        ...(file.encoding ? { encoding: file.encoding } : {}),
      }
    })
    if (typeof view.entryPath !== 'string' || !paths.has(view.entryPath))
      throw new Error('界面入口文件不存在')
    result[scope as keyof CustomUiViews] = {
      entryPath: view.entryPath,
      files,
      enabled: !disable && view.enabled === true,
      allowNetwork: !disable && view.allowNetwork === true,
    }
  }
  return result
}

export function createUiView(): CustomUiView {
  return {
    entryPath: 'View.vue',
    enabled: false,
    allowNetwork: false,
    files: [
      {
        path: 'View.vue',
        contents: `<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
const view = ref({ html: '', controls: [] })
let unsubscribe
onMounted(() => { unsubscribe = window.srlUi.subscribe(state => { view.value = state }) })
onBeforeUnmount(() => unsubscribe?.())
// 所有业务动作都由原界面执行。可按 view.controls 的 label 找到当前动作，
// 并用 window.srlUi.invoke({ id: control.id, event: 'click' }) 绑定自己的 SVG 按钮。
// 自行编写模板、状态与交互；也可修改收到的 view.html 再显示。
</script>

<template>
  <div class="my-interface" v-html="view.html"></div>
</template>

<style>
/* 例如：按钮反馈、布局、背景图片和 SVG；公共主题样式由宿主提供。 */
.my-interface { min-height: 100%; }
</style>
`,
      },
    ],
  }
}

/** Resolve packaged assets after validating the small author CSS, so images are not truncated. */
export function resolveUiCssAssets(css: string, views: CustomUiViews): string {
  return css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu,
    (match, double: string, single: string, bare: string) => {
      const reference = (double ?? single ?? bare).trim().match(/^srl-ui-asset:([^/]+)\/(.+)$/u)
      if (!reference) return match
      const scope = reference[1] as keyof CustomUiViews
      const path = reference[2]!
      const file = views[scope]?.files.find((item) => item.path === path)
      if (!file) return 'none'
      const extension = path.split('.').pop()?.toLowerCase()
      const mime = (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
          svg: 'image/svg+xml',
        } as Record<string, string>
      )[extension || '']
      if (!mime) return 'none'
      return `url("data:${mime};${file.encoding === 'base64' ? `base64,${file.contents}` : `charset=utf-8,${encodeURIComponent(file.contents)}`}")`
    },
  )
}
