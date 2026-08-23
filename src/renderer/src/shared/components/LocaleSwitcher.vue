<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'

const { t } = useI18n()
const localeStore = useLocaleStore()
const { isSaving, locale } = storeToRefs(localeStore)

function selectLocale(nextLocale: 'en' | 'ar'): void {
  void localeStore.setLocale(nextLocale)
}
</script>

<template>
  <div class="locale-switcher" role="group" :aria-label="t('locale.switcherLabel')">
    <button
      type="button"
      :aria-pressed="locale === 'en'"
      :disabled="isSaving"
      @click="selectLocale('en')"
    >
      {{ t('locale.english') }}
    </button>
    <button
      type="button"
      :aria-pressed="locale === 'ar'"
      :disabled="isSaving"
      @click="selectLocale('ar')"
    >
      {{ t('locale.arabic') }}
    </button>
  </div>
</template>
