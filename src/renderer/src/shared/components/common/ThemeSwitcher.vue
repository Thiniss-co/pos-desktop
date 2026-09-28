<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { ThemePreference } from '@shared/contracts/preferences.contract'
import { useThemeStore } from '@renderer/modules/preferences/theme.store'
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons.generated'

const THEME_OPTIONS = ['light', 'dark', 'system'] as const
const THEME_ICONS: Record<(typeof THEME_OPTIONS)[number], IconName> = {
  light: 'light_mode',
  dark: 'dark_mode',
  system: 'contrast'
}

withDefaults(defineProps<{ showLabel?: boolean }>(), { showLabel: false })

const { t } = useI18n()
const themeStore = useThemeStore()
const { isSaving, preference } = storeToRefs(themeStore)

function selectTheme(next: ThemePreference): void {
  void themeStore.setTheme(next)
}
</script>

<template>
  <div
    class="theme-switcher flex flex-col gap-1.5"
    role="group"
    :aria-label="t('theme.switcherLabel')"
  >
    <span v-if="showLabel" class="text-xs font-semibold text-muted" aria-hidden="true">
      {{ t('theme.switcherLabel') }}
    </span>
    <div class="grid grid-cols-3 gap-1.5">
      <button
        v-for="option in THEME_OPTIONS"
        :key="option"
        type="button"
        class="theme-switcher__option flex h-10 items-center justify-center gap-1 rounded-md border px-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:border-pri aria-pressed:bg-pri-soft aria-pressed:text-pri-text"
        :class="preference === option ? '' : 'border-line bg-surf text-ink hover:bg-subtle'"
        :aria-pressed="preference === option"
        :disabled="isSaving"
        @click="selectTheme(option)"
      >
        <AppIcon :name="THEME_ICONS[option]" :size="17" />{{ t(`theme.${option}`) }}
      </button>
    </div>
  </div>
</template>
