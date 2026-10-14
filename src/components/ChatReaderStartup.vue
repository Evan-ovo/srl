<template>
  <section class="chat-reader-startup" aria-busy="true" aria-label="读了么阅读工作区">
    <p role="status">正在打开读了么…</p>
  </section>
</template>

<style scoped>
.chat-reader-startup {
  position: fixed;
  z-index: 2000;
  inset: 0;
  box-sizing: border-box;
  height: var(--app-viewport-height, 100dvh);
  padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  color: var(--color-ink-soft);
  background: var(--color-canvas);
}
.chat-reader-startup p {
  position: absolute;
  inset: auto var(--safe-right) var(--safe-bottom) var(--safe-left);
  margin: 0;
  padding: 0.6rem 0.8rem;
  font-size: 0.78rem;
  text-align: center;
}
</style>
