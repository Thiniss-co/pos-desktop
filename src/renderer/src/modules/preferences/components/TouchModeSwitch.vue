<script setup lang="ts">
/**
 * POS improvements, Stage 5 — the signed-in user's touch layout switch (user menu and Settings).
 * Per user on this workstation; scanning and the function keys keep working either way.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserPreferencesStore } from '../userPreferences.store'

withDefaults(defineProps<{ showDescription?: boolean }>(), { showDescription: false })

const { t } = useI18n()
const store = useUserPreferencesStore()
const on = computed(() => store.preferences.touchMode)

function toggle(): void {
  void store.set('ui.touchMode', !on.value)
}
</script>

<template>
  <div class="touch-mode-switch flex flex-col gap-1">
    <button
      type="button"
      role="switch"
      class="touch-mode-switch__control flex min-h-11 w-full items-center justify-between gap-3 rounded-notice border border-line px-3 py-2 text-start text-sm font-semibold text-ink hover:bg-subtle focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
      :aria-checked="on"
      :disabled="store.saving"
      data-testid="touch-mode-switch"
      @click="toggle"
    >
      <span>{{ t('touch.toggle.label') }}</span>
      <span
        aria-hidden="true"
        class="touch-mode-switch__track relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors"
        :class="on ? 'bg-pri' : 'bg-line-strong'"
      >
        <span
          class="absolute size-5 rounded-full bg-surf shadow transition-[inset-inline-start]"
          :class="on ? 'start-5.5' : 'start-0.5'"
        />
      </span>
    </button>
    <p v-if="showDescription" class="text-xs text-muted">{{ t('touch.toggle.description') }}</p>
    <p v-if="store.failed" class="text-xs font-medium text-err" role="alert">
      {{ t('touch.toggle.failed') }}
    </p>
  </div>
</template>
