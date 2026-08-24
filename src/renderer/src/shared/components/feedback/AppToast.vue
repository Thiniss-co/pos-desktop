<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'info' | 'success' | 'warning' | 'error'
    dismissLabel: string
  }>(),
  { variant: 'info' }
)

const emit = defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div class="app-toast" :class="`app-toast--${variant}`" role="status">
    <div class="app-toast__content"><slot /></div>
    <button
      type="button"
      class="app-toast__dismiss"
      :aria-label="dismissLabel"
      @click="emit('dismiss')"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.app-toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--size-target-min);
  padding-inline: var(--space-4);
  padding-block: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-outline);
  background: var(--color-inverse-surface);
  color: var(--color-inverse-on-surface);
  box-shadow: 0 8px 24px var(--color-scrim);
}

.app-toast--error {
  border-color: var(--color-error);
}
.app-toast--warning {
  border-color: var(--color-warning);
}
.app-toast--success {
  border-color: var(--color-success);
}

.app-toast__content {
  flex: 1;
  font-size: var(--text-body-md-size);
}

.app-toast__dismiss {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.app-toast__dismiss svg {
  width: 14px;
  height: 14px;
}
.app-toast__dismiss:hover {
  background: rgb(255 255 255 / 12%);
}
</style>
