<script setup lang="ts">
/** A compact icon-only control. `label` is required and renders as the accessible name — there is
 * no icon-only button anywhere in this app without one. */
withDefaults(
  defineProps<{
    label: string
    variant?: 'ghost' | 'danger'
    disabled?: boolean
    pressed?: boolean
  }>(),
  { variant: 'ghost', disabled: false, pressed: undefined }
)

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    class="app-icon-button"
    :class="`app-icon-button--${variant}`"
    :aria-label="label"
    :title="label"
    :aria-pressed="pressed"
    :disabled="disabled"
    @click="(event) => emit('click', event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.app-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--size-target-min);
  height: var(--size-target-min);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-on-surface);
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.app-icon-button--ghost:hover:not(:disabled) {
  background: var(--color-surface-container);
}

.app-icon-button--ghost[aria-pressed='true'] {
  background: var(--color-secondary-container);
  color: var(--color-on-secondary-container);
}

.app-icon-button--danger {
  color: var(--color-error);
}
.app-icon-button--danger:hover:not(:disabled) {
  background: var(--color-error-container);
}

.app-icon-button:disabled {
  color: var(--color-disabled-text);
  cursor: not-allowed;
}
</style>
