<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?: 'success' | 'warning' | 'error' | 'information' | 'neutral'
  }>(),
  { variant: 'neutral' }
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
    case 'information':
      return 'M8 7v4.5M8 4.3v.3'
    default:
      return 'M4 8h8'
  }
})
</script>

<template>
  <span class="app-status-chip" :class="`app-status-chip--${variant}`">
    <svg class="app-status-chip__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        :d="iconPath"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span class="app-status-chip__label"><slot /></span>
  </span>
</template>

<style scoped>
/* Container-based per the elevation contrast rule (Checkpoint 1, "Conflict 4") — bare colored
   text is not permitted once a component sits on an elevated surface, so this always renders as
   a container + on-container pair, never a bare-colored span. */
.app-status-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding-inline: var(--space-2);
  padding-block: 2px;
  border-radius: var(--radius-sm);
  font-size: var(--text-body-sm-size);
  line-height: var(--text-body-sm-line);
  font-weight: 600;
}

.app-status-chip__icon {
  width: 14px;
  height: 14px;
  flex: none;
}

.app-status-chip--success {
  background: var(--color-success-container);
  color: var(--color-on-success-container);
}
.app-status-chip--warning {
  background: var(--color-warning-container);
  color: var(--color-on-warning-container);
}
.app-status-chip--error {
  background: var(--color-error-container);
  color: var(--color-on-error-container);
}
.app-status-chip--information {
  background: var(--color-information-container);
  color: var(--color-on-information-container);
}
.app-status-chip--neutral {
  background: var(--color-surface-container-high);
  color: var(--color-on-surface-variant);
}
</style>
