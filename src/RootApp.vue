<!-- SRL-PUBLIC-SYNC: BEGIN REPLACE id=root-account-shell -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import ConfirmDialog from './components/ConfirmDialog.vue'
import CharacterCardMigrationReview from './components/CharacterCardMigrationReview.vue'
import ProjectNoticeDialog from './components/ProjectNoticeDialog.vue'
import { createAsyncPanel } from './core/AsyncPanel'
import { markStartupReady } from './core/SafeStartup'
import { BrowserStorageService } from './services/BrowserStorageService'

const LibraryApp = createAsyncPanel('资源库', async () => {
  const [component, services] = await Promise.all([
    import('./App.vue'),
    import('./core/AppContainer'),
  ])
  await services.initializeCredentialServices().catch((error) => {
    console.error('本机凭据初始化失败', error)
  })
  return component
})

const browserStorage = new BrowserStorageService()
const isProjectNoticeOpen = ref(true)

function acknowledgeProjectNotice(): void {
  browserStorage.acknowledgeProjectNotice()
  isProjectNoticeOpen.value = false
}

onMounted(async () => {
  isProjectNoticeOpen.value = !(await browserStorage.hasAcknowledgedProjectNoticePersisted())
  try {
    document.documentElement.dataset.theme =
      localStorage.getItem('srl-theme') === 'dark' ? 'dark' : 'light'
  } catch {
    document.documentElement.dataset.theme = 'light'
  }
  markStartupReady()
})
</script>

<template>
  <div id="srl-independent-page-outlet" class="srl-independent-page-outlet" />
  <LibraryApp />
  <ConfirmDialog />
  <CharacterCardMigrationReview />
  <ProjectNoticeDialog :open="isProjectNoticeOpen" @acknowledged="acknowledgeProjectNotice" />
</template>
<!-- SRL-PUBLIC-SYNC: END REPLACE id=root-account-shell -->
