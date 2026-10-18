<script setup lang="ts">
withDefaults(
  defineProps<{
    origin: string
    token: string
    remember: boolean
    connected?: boolean
    busy?: boolean
  }>(),
  { connected: false, busy: false },
)
defineEmits<{
  'update:origin': [value: string]
  'update:token': [value: string]
  'update:remember': [value: boolean]
  submit: []
}>()
</script>
<template>
  <form class="image-hosting-connection" data-srl-controls @submit.prevent="$emit('submit')">
    <div class="image-hosting-connection__group">
      <header>
        <strong>连接设置</strong><span>{{ connected ? '已配置' : '未配置' }}</span>
      </header>
      <label class="image-hosting-connection__field"
        ><span>图床地址</span
        ><input
          :value="origin"
          type="url"
          inputmode="url"
          placeholder="https://你的图床域名"
          autocomplete="url"
          required
          :disabled="busy"
          @input="$emit('update:origin', ($event.target as HTMLInputElement).value)"
      /></label>
      <label class="image-hosting-connection__field"
        ><span>上传凭据</span
        ><input
          :value="token"
          type="password"
          placeholder="API Token / AUTH_CODE"
          autocomplete="off"
          required
          :disabled="busy"
          @input="$emit('update:token', ($event.target as HTMLInputElement).value)"
      /></label>
      <label class="image-hosting-connection__remember"
        ><span>保存在这台设备</span
        ><input
          :checked="remember"
          type="checkbox"
          role="switch"
          :aria-checked="remember"
          :disabled="busy"
          @change="$emit('update:remember', ($event.target as HTMLInputElement).checked)"
      /></label>
    </div>
    <button class="image-hosting-connection__save button--primary" type="submit" :disabled="busy">
      {{ busy ? '保存中…' : connected ? '更新连接' : '保存连接' }}
    </button>
    <details>
      <summary>连接与凭据说明</summary>
      <p>
        支持自己的
        ImgBed，不占共享额度。凭据仅用于连接该图床，关闭设备保存后仅本次使用。远端删除需要含 delete
        权限的 API Token，AUTH_CODE 可用于上传。
      </p>
    </details>
  </form>
</template>
<style scoped>
.image-hosting-connection {
  display: grid;
  gap: 12px;
  min-width: 0;
  width: 100%;
  max-width: 38rem;
}
.image-hosting-connection__group {
  border: 1px solid var(--color-line);
  border-radius: 14px;
  overflow: hidden;
  background: var(--color-surface);
}
.image-hosting-connection header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 14px;
}
.image-hosting-connection header strong {
  font-size: 14px;
}
.image-hosting-connection header > span {
  font-size: 12px;
  color: var(--color-ink-soft);
}
.image-hosting-connection__field {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 0 14px;
  border-top: 1px solid var(--color-line);
}
.image-hosting-connection__field > span {
  font-size: 13px;
}
.image-hosting-connection__field > input {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--color-ink);
  font: 16px var(--font-body);
}
.image-hosting-connection__remember {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 54px;
  padding: 0 14px;
  border-top: 1px solid var(--color-line);
  font-size: 13px;
}
.image-hosting-connection__save {
  width: 100%;
  min-height: 46px;
  border-radius: 12px;
  background: var(--button-primary-background, var(--color-accent));
  color: var(--button-primary-color, var(--color-on-accent));
  border: 1px solid var(--button-primary-border, var(--color-accent));
  box-shadow: none;
  font-weight: 600;
}
.image-hosting-connection summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding-inline: 4px;
  color: var(--color-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.image-hosting-connection summary::after {
  content: '›';
  margin-left: auto;
}
.image-hosting-connection details p {
  margin: 0;
  padding: 0 4px 8px;
  font-size: 12px;
  color: var(--color-ink-soft);
  line-height: 1.6;
}
</style>
