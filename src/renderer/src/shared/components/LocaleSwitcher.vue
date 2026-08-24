<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'

function selectLocale(nextLocale: 'en' | 'ar'): void {
  void localeStore.setLocale(nextLocale)
}

const { t } = useI18n()
const localeStore = useLocaleStore()
const { isSaving, locale } = storeToRefs(localeStore)
</script>

<template>
  <div class="locale-switcher" role="group" :aria-label="t('locale.switcherLabel')">
    <button
      type="button"
      class="locale-switcher__option"
      :aria-pressed="locale === 'en'"
      :disabled="isSaving"
      @click="selectLocale('en')"
    >
      {{ t('locale.english') }}
    </button>
    <button
      type="button"
      class="locale-switcher__option"
      :aria-pressed="locale === 'ar'"
      :disabled="isSaving"
      @click="selectLocale('ar')"
    >
      {{ t('locale.arabic') }}
    </button>
  </div>
</template>

<style scoped>
.locale-switcher {
  display: inline-flex;
  border: 1px solid var(--color-outline);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.locale-switcher__option {
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

.locale-switcher__option:last-child {
  border-inline-end: none;
}

.locale-switcher__option:hover:not(:disabled) {
  background: var(--color-surface-container);
}

.locale-switcher__option[aria-pressed='true'] {
  background: var(--color-secondary-container);
  color: var(--color-on-secondary-container);
}

.locale-switcher__option:disabled {
  cursor: wait;
  color: var(--color-disabled-text);
}
</style>
