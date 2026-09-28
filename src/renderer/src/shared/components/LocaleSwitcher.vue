<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'

withDefaults(defineProps<{ showLabel?: boolean; compact?: boolean }>(), {
  showLabel: false,
  compact: false
})

function selectLocale(nextLocale: 'en' | 'ar'): void {
  void localeStore.setLocale(nextLocale)
}

const { t } = useI18n()
const localeStore = useLocaleStore()
const { isSaving, locale } = storeToRefs(localeStore)
const OPTIONS = [
  { code: 'en', key: 'locale.english', lang: 'en', dir: 'ltr' },
  { code: 'ar', key: 'locale.arabic', lang: 'ar', dir: 'rtl' }
] as const
</script>

<template>
  <div
    class="locale-switcher flex flex-col gap-1.5"
    role="group"
    :aria-label="t('locale.switcherLabel')"
  >
    <span v-if="showLabel" class="text-xs font-semibold text-muted" aria-hidden="true">
      {{ t('locale.switcherLabel') }}
    </span>
    <div :class="compact ? 'flex gap-1' : 'grid grid-cols-2 gap-1.5'">
      <button
        v-for="option in OPTIONS"
        :key="option.code"
        type="button"
        class="locale-switcher__option rounded-md border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:border-pri aria-pressed:bg-pri-soft aria-pressed:text-pri-text"
        :class="[
          compact ? 'h-9' : 'h-10',
          locale === option.code ? '' : 'border-line bg-surf text-ink hover:bg-subtle'
        ]"
        :lang="option.lang"
        :dir="option.dir"
        :aria-pressed="locale === option.code"
        :disabled="isSaving"
        @click="selectLocale(option.code)"
      >
        {{ t(option.key) }}
      </button>
    </div>
  </div>
</template>
