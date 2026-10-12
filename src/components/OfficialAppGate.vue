<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, ref } from 'vue'
import type { OfficialAppId } from '../types/OfficialApp'
import {
  acquireOfficialAppUse,
  ensurePreinstalledOfficialApps,
  loadOfficialApp,
  officialAppService,
} from '../core/OfficialAppRuntime'
import FeatureAppHeader from './FeatureAppHeader.vue'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ appId: OfficialAppId; appName: string }>()
const emit = defineEmits<{ back: [] }>()
const component = shallowRef()
const busy = ref(true)
const error = ref('')
const installed = ref(false)
const hasInstallationRecord = ref(false)
let release: (() => void) | undefined
let disposed = false
onBeforeUnmount(() => {
  disposed = true
  release?.()
})
async function open() {
  busy.value = true
  error.value = ''
  try {
    await ensurePreinstalledOfficialApps()
    release = await acquireOfficialAppUse(props.appId)
    if (disposed) {
      release()
      return
    }
    const loaded = await loadOfficialApp(props.appId, (ready) => {
      installed.value = ready
    })
    if (!loaded) {
      release()
      release = undefined
      hasInstallationRecord.value = Boolean(await officialAppService.getInstalled(props.appId))
      return
    }
    if (!disposed) component.value = loaded
  } catch (reason) {
    release?.()
    release = undefined
    error.value = reason instanceof Error ? reason.message : 'APP 打开失败'
  } finally {
    busy.value = false
  }
}
async function install() {
  busy.value = true
  error.value = ''
  try {
    await officialAppService.install(props.appId)
    await open()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'APP 安装失败'
  } finally {
    busy.value = false
  }
}
onMounted(open)
function reload() {
  window.location.reload()
}
</script>
<template>
  <span v-if="component" hidden :data-official-app-ready="appId"></span>
  <component :is="component" v-if="component" v-bind="$attrs" @back="emit('back')" />
  <template v-else>
    <FeatureAppHeader :title="appName" @back="emit('back')" />
    <section class="official-app-install" :aria-busy="busy">
      <p>
        {{
          busy
            ? '正在准备 APP…'
            : installed
              ? 'APP 暂时无法打开'
              : hasInstallationRecord
                ? '已安装版本与当前资源库不兼容或文件缺失，需要更新；已有数据会保留。'
                : '使用前需要下载此 APP，已有数据会保留。'
        }}
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <button v-if="!busy" type="button" @click="installed ? open() : install()">
        {{ installed ? '重新打开' : hasInstallationRecord ? '下载兼容版本' : '下载并安装' }}
      </button>
      <button v-if="!busy && installed && error" type="button" @click="reload">刷新页面</button>
      <p>可以在“功能 → APP 管理”卸载程序，并选择是否清除数据。</p>
    </section>
  </template>
</template>
<style scoped>
.official-app-install {
  padding: 1rem;
  overflow-wrap: anywhere;
}
.official-app-install button {
  min-height: 44px;
  padding: 0.5rem 1rem;
}
</style>
