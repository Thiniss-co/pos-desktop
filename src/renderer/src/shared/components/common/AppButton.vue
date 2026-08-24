<script setup lang="ts">
/**
 * The single button primitive for the app. Every other button in the codebase (submit, link,
 * icon-only, danger confirm) is built on this — no page should style a bare `<button>` itself.
 */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'transaction' | 'ghost' | 'danger'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    fullWidth?: boolean
  }>(),
  {
    variant: 'primary',
    type: 'button',
    disabled: false,
    loading: false,
    fullWidth: false
  }
)

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    :type="type"
    class="app-button"
    :class="[
      `app-button--${variant}`,
      { 'app-button--full': fullWidth, 'app-button--loading': loading }
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    @click="(event) => emit('click', event)"
  >
    <span v-if="loading" class="app-button__spinner" aria-hidden="true" />
    <span class="app-button__label"><slot /></span>
  </button>
</template>

<style scoped>
.app-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--size-target-min);
  padding-inline: var(--space-5);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-family: var(--font-ui);
  font-size: var(--text-body-md-size);
  line-height: var(--text-body-md-line);
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}

.app-button--full {
  width: 100%;
}

.app-button:disabled {
  cursor: not-allowed;
}

/* Primary */
.app-button--primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.app-button--primary:not(:disabled):hover {
  opacity: 0.92;
}
.app-button--primary:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
}

/* Secondary — dark mode carries a mandatory outline; see palette.css "Conflict 2". */
.app-button--secondary {
  background: var(--color-secondary);
  color: var(--color-on-secondary);
  border-color: var(--color-secondary-outline);
}
.app-button--secondary:not(:disabled):hover {
  background: var(--color-secondary-hover);
}
.app-button--secondary:not(:disabled):active {
  background: var(--color-secondary-active);
}
.app-button--secondary:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
  border-color: transparent;
}

/* Transaction (amber) — pressed state is a ring, not a face swap; see palette.css "Conflict 3". */
.app-button--transaction {
  background: var(--color-transaction-accent);
  color: var(--color-on-transaction-accent);
}
.app-button--transaction:not(:disabled):hover {
  background: var(--color-transaction-accent-hover);
}
.app-button--transaction:not(:disabled):active {
  background: var(--color-transaction-accent-hover);
  box-shadow: inset 0 0 0 2px var(--color-transaction-accent-active);
}
.app-button--transaction:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
}

/* Ghost */
.app-button--ghost {
  background: transparent;
  color: var(--color-on-surface);
  border-color: var(--color-outline);
}
.app-button--ghost:not(:disabled):hover {
  background: var(--color-surface-container);
}
.app-button--ghost:disabled {
  color: var(--color-disabled-text);
  border-color: var(--color-outline-variant);
}

/* Danger */
.app-button--danger {
  background: var(--color-error);
  color: var(--color-on-error);
}
.app-button--danger:not(:disabled):hover {
  opacity: 0.9;
}
.app-button--danger:disabled {
  background: var(--color-disabled-surface);
  color: var(--color-disabled-text);
}

.app-button__spinner {
  width: 1em;
  height: 1em;
  border-radius: var(--radius-full);
  border: 2px solid currentcolor;
  border-inline-end-color: transparent;
  animation: app-button-spin var(--duration-slow) linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .app-button__spinner {
    animation: none;
  }
}

@keyframes app-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
