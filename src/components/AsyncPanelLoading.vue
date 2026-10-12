<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <div class="async-panel-loading" role="status" aria-live="polite" aria-busy="true">
    <span aria-hidden="true">SRL</span>
    <div>
      <strong>正在打开{{ label }}</strong>
      <small>正在载入界面</small>
      <i class="async-panel-loading__progress" aria-hidden="true"><b></b></i>
    </div>
  </div>
</template>

<style scoped>
.async-panel-loading {
  display: flex;
  width: min(32rem, calc(100% - 2rem));
  min-height: 8rem;
  align-items: center;
  gap: 0.9rem;
  margin: clamp(2rem, 15vh, 8rem) auto;
  padding: 1rem;
  border: 1px solid var(--color-line);
  color: var(--color-ink);
  background: var(--color-surface);
}
.async-panel-loading > span {
  display: grid;
  width: 3rem;
  height: 3rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: var(--color-on-accent);
  background: var(--color-accent);
  font: 800 0.66rem var(--font-label);
  letter-spacing: 0.08em;
  animation: async-panel-pulse 1.3s ease-in-out infinite;
}
.async-panel-loading--embedded {
  width: 100%;
  margin: 0 0 1rem;
}
.async-panel-loading div {
  display: grid;
  gap: 0.3rem;
}
.async-panel-loading strong {
  font-family: var(--font-display);
  font-size: 1rem;
}
.async-panel-loading small {
  color: var(--color-ink-soft);
  font-size: 0.6rem;
  line-height: 1.5;
}
.async-panel-loading__progress {
  display: block;
  width: min(14rem, 100%);
  height: 0.22rem;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
}
.async-panel-loading__progress > b {
  display: block;
  width: 42%;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
  animation: async-panel-loading-progress 1.2s ease-in-out infinite alternate;
}
@keyframes async-panel-pulse {
  50% {
    opacity: 0.58;
    transform: scale(0.94);
  }
}
@keyframes async-panel-loading-progress {
  to {
    transform: translateX(135%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .async-panel-loading > span,
  .async-panel-loading__progress > b {
    animation: none;
  }
}
</style>
