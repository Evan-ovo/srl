import type { CustomUiView } from '../types/UiCustomization'

/** Packaged helper code runs in the existing isolated Vue compiler, never in the host. */
export const UI_VIEW_HELPER = `import { shallowRef, onMounted, onBeforeUnmount, defineComponent, h } from 'vue'

/** 从模板自带的 ./Page.js 导入，返回当前 APP 的实时界面与操作助手。 */
export function usePage() {
  const state = shallowRef({ html: '', controls: [] })
  let stop
  onMounted(() => { stop = window.srlUi.subscribe(value => { state.value = value }) })
  onBeforeUnmount(() => stop?.())
  let lastHtml, lastDocument
  const documentOf = () => {
    if (lastHtml !== state.value.html || !lastDocument) {
      lastHtml = state.value.html
      lastDocument = new DOMParser().parseFromString(lastHtml, 'text/html')
    }
    return lastDocument
  }
  const rootOf = document => {
    const root = document.querySelector('[data-srl-view-root]') || document.body.firstElementChild
    return root?.classList.contains('feature-hub')
      ? root.querySelector('[data-srl-feature-header]')?.parentElement || root : root
  }
  const root = () => rootOf(documentOf())
  const find = selector => root()?.querySelector(selector)
  const attrs = element => Object.fromEntries(Array.from(element?.attributes || [])
    .filter(a => !a.name.startsWith('on') && a.name !== 'data-srl-action')
    .map(a => [a.name, a.value]))
  const invoke = (selector, event, values = {}) => {
    const element = find(selector)
    const id = element?.getAttribute('data-srl-action')
    if (!id) return Promise.reject(new Error('当前界面没有这个可操作控件：' + selector))
    return window.srlUi.invoke({ ...values, id, event })
  }
  const Region = defineComponent({
    props: {
      /** 要保留的原区域选择器。 */
      selector: String,
      /** 保留原主体内容，排除标准头部。 */
      body: Boolean,
    },
    setup(props) {
      return () => {
        const element = root()
        const nodes = props.body ? Array.from(element?.childNodes || [])
          .filter(n => !(n.nodeType === 1 && n.matches('[data-srl-feature-header], .library__header')))
          : Array.from(element?.querySelectorAll(props.selector || ':scope > *') || [])
        const container = document.createElement('div')
        nodes.forEach(n => container.append(n.cloneNode(true)))
        return h('div', { style: 'display:contents', innerHTML: container.innerHTML })
      }
    },
  })
  const Layout = defineComponent({
    setup(_, { slots }) {
      return () => {
        const element = root()
        if (!element) return h('div', slots.default?.())
        let output = h(element.tagName.toLowerCase(), attrs(element), slots.default?.())
        for (let parent = element.parentElement; parent && parent.tagName !== 'BODY'; parent = parent.parentElement)
          output = h(parent.tagName.toLowerCase(), { ...attrs(parent), style: 'display:contents!important' }, [output])
        return output
      }
    },
  })
  return {
    /** shallowRef 快照；读取 state.value，模板中自动解包。字段见 UiViewSnapshot。 */
    state,
    /** 用 <Layout> 包裹新布局，保留原 APP 根节点与布局上下文。 */
    Layout,
    /** <Region body /> 保留持续更新的原内容；selector 属性保留指定区域，可移动到新布局。 */
    Region,
    /** 检查当前 APP 是否有标准头部。 */
    hasHeader: () => !!find(':scope > [data-srl-feature-header], :scope > .library__header'),
    /** 沿用原头部的属性与样式类。 */
    headerAttrs: () => attrs(find(':scope > [data-srl-feature-header], :scope > .library__header')),
    /** 沿用标题容器的属性。 */
    copyAttrs: () => attrs(find('.feature-app-header__copy, .library__header > div')),
    /** 取得标准头部右侧操作区域的选择器。 */
    trailing: () => find('.feature-app-header__trailing') ? '.feature-app-header__trailing' : '.library__header-actions',
    /** 检查当前快照是否存在该区域。 */
    has: selector => !!find(selector),
    /** 复制匹配区域的属性；不复制原事件或控件 ID。 */
    attrs: selector => attrs(find(selector)),
    /** 读取第一个匹配区域的文本，不存在时返回空字符串。 */
    text: selector => find(selector)?.textContent?.trim() || '',
    /** 返回当前快照的控件列表，字段见 UiControl。 */
    controls: () => state.value.controls,
    /** 取得匹配节点的 key、selector、text、attrs；节点选择器只用于当前快照。 */
    nodes: selector => Array.from(root()?.querySelectorAll(selector) || []).map(element => ({
      /** 当前快照内的节点标识。 */
      key: element.getAttribute('data-srl-node'),
      /** 节点的文本。 */
      text: element.textContent?.trim() || '',
      /** 当前快照内可用于 page 方法的选择器。 */
      selector: '[data-srl-node="' + element.getAttribute('data-srl-node') + '"]',
      /** 排除了原事件与控件 ID 的节点属性。 */
      attrs: attrs(element),
    })),
    /** 调用当前存在且可用的原按钮，返回 Promise。 */
    click: selector => invoke(selector, 'click'),
    /** 调用原输入事件；value 是字符串。 */
    input: (selector, value) => invoke(selector, 'input', { value }),
    /** 调用原选择事件；checked 用于勾选状态。 */
    change: (selector, value, checked) => invoke(selector, 'change', { value, checked }),
  }
}
`

export function createEditableUiView(title: string): CustomUiView {
  const literal = JSON.stringify(title)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
  return {
    entryPath: 'View.vue',
    enabled: false,
    allowNetwork: false,
    files: [
      {
        path: 'View.vue',
        contents: `<script setup>
import { ref } from 'vue'
import { usePage } from './Page.js'

const page = usePage()
const { Layout, Region } = page
const title = ref('') // 当前目标 ${literal}；填写新标题，留空沿用原文
const showMenu = ref(false) // 自己的界面状态可以自由添加

async function back() {
  await page.click('.feature-app-header__back') // 调用原 APP 的返回操作
}
// 其它原操作：page.click('控件选择器')、page.input('输入框选择器', 值)。
// 可以改成先打开自己的菜单，再调用原操作；原资源保存和导出流程仍由 APP 执行。
</script>

<template>
  <Layout>
    <header v-if="page.hasHeader()" v-bind="page.headerAttrs()">
      <button v-if="page.has('.feature-app-header__back')" v-bind="page.attrs('.feature-app-header__back')" type="button" aria-label="返回" @click="back">←</button>
      <div v-bind="page.copyAttrs()"><h1 v-bind="page.attrs('.feature-app-header__copy h1, .library__title')">{{ title || page.text('.feature-app-header__copy h1, .library__title') }}</h1></div>
      <Region :selector="page.trailing()" />
    </header>
    <!-- 原 APP 的列表、表单和内容持续更新，可以把 Region 移到其它位置。 -->
    <Region body />
    <!-- 自定义菜单示例：取消下面注释即可使用，也可以自由修改按钮和流程。
    <button type="button" @click="showMenu = !showMenu">更多操作</button>
    <section v-if="showMenu"><button type="button" @click="back">返回功能桌面</button></section>
    -->
  </Layout>
</template>

<style>
/* 这里的样式只在本 APP 自定义界面内生效；公共配色仍沿用全局/APP CSS。 */
</style>
`,
      },
      { path: 'Page.js', contents: UI_VIEW_HELPER },
    ],
  }
}
