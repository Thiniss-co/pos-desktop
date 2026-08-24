<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { ThemePreference } from '@shared/contracts/preferences.contract'
import { useThemeStore } from '@renderer/modules/preferences/theme.store'

const THEME_OPTIONS = ['light', 'dark', 'system'] as const

const { t } = useI18n()
const themeStore = useThemeStore()
const { isSaving, preference } = storeToRefs(themeStore)

function selectTheme(next: ThemePreference): void {
  void themeStore.setTheme(next)
}
</script>

<template>
  <div class="theme-switcher" role="group" :aria-label="t('theme.switcherLabel')">
    <button
      v-for="option in THEME_OPTIONS"
      :key="option"
      type="button"
      class="theme-switcher__option"
      :aria-pressed="preference === option"
      :disabled="isSaving"
      @click="selectTheme(option)"
    >
      {{ t(`theme.${option}`) }}
    </button>
  </div>
</template>

<style scoped>
.theme-switcher {
  display: inline-flex;
  border: 1px solid var(--color-outline);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.theme-switcher__option {
  min-height: var(--size-target-min);
  padding-inline: var(--space-3);
  border: none;
  border-inline-end: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-body-sm-size);
  font-weight: 600;
}

.theme-switcher__option:last-child {
  border-inline-end: none;
}

.theme-switcher__option:hover:not(:disabled) {
  background: var(--color-surface-container);
}

.theme-switcher__option[aria-pressed='true'] {
  background: var(--color-secondary-container);
  color: var(--color-on-secondary-container);
}

.theme-switcher__option:disabled {
  cursor: wait;
  color: var(--color-disabled-text);
}
</style>
