<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'info' | 'success' | 'warning' | 'error'
    role?: 'alert' | 'status'
  }>(),
  { variant: 'info', role: 'status' }
)

// Every variant pairs an icon with the color so status is never conveyed by color alone.
const iconPath = computed(() => {
  switch (props.variant) {
    case 'success':
      return 'M3 8.5 6.5 12 13 4.5'
    case 'warning':
      return 'M8 3v6M8 12.2v.3'
    case 'error':
      return 'M4.5 4.5l7 7M11.5 4.5l-7 7'
    default:
      return 'M8 7v4.5M8 4.3v.3'
  }
})
</script>

<template>
  <div class="app-banner" :class="`app-banner--${variant}`" :role="role">
    <svg class="app-banner__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.3" />
      <path
        :d="iconPath"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <div class="app-banner__content">
      <slot />
    </div>
    <div v-if="$slots.action" class="app-banner__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.app-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-low);
  color: var(--color-on-surface);
  font-size: var(--text-body-md-size);
  line-height: var(--text-body-md-line);
}

.app-banner--info {
  border-color: var(--color-information);
  background: var(--color-information-container);
  color: var(--color-on-information-container);
}
.app-banner--success {
  border-color: var(--color-success);
  background: var(--color-success-container);
  color: var(--color-on-success-container);
}
.app-banner--warning {
  border-color: var(--color-warning);
  background: var(--color-warning-container);
  color: var(--color-on-warning-container);
}
.app-banner--error {
  border-color: var(--color-error);
  background: var(--color-error-container);
  color: var(--color-on-error-container);
}

.app-banner__icon {
  flex: none;
  width: 20px;
  height: 20px;
}

.app-banner__content {
  flex: 1;
}

.app-banner__action {
  flex: none;
}

@media (max-width: 640px) {
  .app-banner {
    flex-wrap: wrap;
  }
}
</style>
