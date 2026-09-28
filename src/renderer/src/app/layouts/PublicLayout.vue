<script setup lang="ts">
/**
 * V3 startup frame (activate · sign in · prepare data · blocked · fatal · not found): brand row
 * with the language toggle and — deviation D-06 — a compact theme control, the setup step
 * indicator derived from the route, the connectivity notice, and the 520px startup card that holds
 * the routed page. The page background scrolls as a whole, so the card stays usable at 800×600.
 */
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import type { ThemePreference } from '@shared/contracts/preferences.contract'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import { useThemeStore } from '@renderer/modules/preferences/theme.store'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import AppSteps from '@renderer/shared/components/feedback/AppSteps.vue'

const { t } = useI18n()
const route = useRoute()
const themeStore = useThemeStore()
const { isSaving: isSavingTheme, preference } = storeToRefs(themeStore)

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; icon: IconName }> = [
  { value: 'light', icon: 'light_mode' },
  { value: 'dark', icon: 'dark_mode' },
  { value: 'system', icon: 'contrast' }
]

/** Setup step per startup route; routes outside the setup flow show no step indicator. */
const STEP_BY_ROUTE: Readonly<Record<string, number>> = {
  activation: 0,
  login: 1,
  root: 2,
  bootstrap: 2
}

const currentStep = computed(() =>
  typeof route.name === 'string' ? (STEP_BY_ROUTE[route.name] ?? null) : null
)
const steps = computed(() => [
  { label: t('startup.steps.activate') },
  { label: t('startup.steps.signIn') },
  { label: t('startup.steps.prepare') }
])

function selectTheme(next: ThemePreference): void {
  void themeStore.setTheme(next)
}
</script>

<template>
  <main class="public-layout flex min-h-screen flex-col items-center bg-page px-4 py-6 text-ink">
    <div class="mb-5 flex w-full max-w-130 flex-wrap items-center gap-2.5">
      <span
        aria-hidden="true"
        class="flex size-9 flex-none items-center justify-center rounded-[9px] bg-pri text-on-pri"
        ><AppIcon name="stacks" :size="21"
      /></span>
      <span class="min-w-0 flex-1 text-[1.125rem] font-bold">{{ t('shell.brand') }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <LocaleSwitcher compact />
        <div class="flex gap-1" role="group" :aria-label="t('theme.switcherLabel')">
          <button
            v-for="option in THEME_OPTIONS"
            :key="option.value"
            type="button"
            class="flex size-9 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:border-pri aria-pressed:bg-pri-soft aria-pressed:text-pri-text"
            :class="
              preference === option.value ? '' : 'border-line bg-surf text-ink hover:bg-subtle'
            "
            :aria-label="t(`theme.${option.value}`)"
            :title="t(`theme.${option.value}`)"
            :aria-pressed="preference === option.value"
            :disabled="isSavingTheme"
            @click="selectTheme(option.value)"
          >
            <AppIcon :name="option.icon" :size="18" />
          </button>
        </div>
      </div>
    </div>

    <AppSteps
      v-if="currentStep !== null"
      class="mb-5 max-w-130"
      :steps="steps"
      :current="currentStep"
      :label="t('startup.steps.label')"
      centered
    />

    <div class="mb-4 w-full max-w-130 empty:hidden">
      <ConnectivityBanner />
    </div>

    <section
      class="public-layout__card w-full max-w-130 rounded-xl border border-line bg-surf p-7 shadow-panel max-[560px]:p-5"
    >
      <slot />
    </section>
  </main>
</template>
