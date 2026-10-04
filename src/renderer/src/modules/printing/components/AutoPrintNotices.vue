<script setup lang="ts">
/**
 * POS improvements, Stage 7 — the POS notices about automatic printing:
 *  - "Automatic printing needs setup": the signed-in user prints automatically but no printer is
 *    set up, or the set-up printer is not connected. Once per session; sales still complete.
 *  - Earlier sales that recovery (sign-in or startup) decided not to print automatically.
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useUserPreferencesStore } from '@renderer/modules/preferences/userPreferences.store'
import { useAutoPrintStore } from '../autoPrint.store'

const REFRESH_MS = 5000

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const preferences = useUserPreferencesStore()
const store = useAutoPrintStore()

const identity = computed(() =>
  auth.session?.isAuthenticated ? `in:${auth.session.userEmail ?? ''}` : null
)

const setupMessage = computed(() => {
  const setup = store.setup
  if (!setup || store.setupDismissed || setup.needsSetup === 'none') {
    return null
  }
  return setup.needsSetup === 'no_printer'
    ? t('printing.auto.setup.noPrinter')
    : t('printing.auto.setup.printerMissing', { name: setup.printerName ?? '' })
})

const noticeNumbers = computed(() =>
  store.notices.map((notice) => notice.receiptNumber).filter((number) => number.length > 0)
)

let timer: ReturnType<typeof setInterval> | null = null

function refresh(): void {
  void store.loadSetup()
  void store.loadNotices()
}

watch(
  identity,
  (next) => {
    store.ensureIdentity(next)
    if (next !== null) {
      refresh()
    }
  },
  { immediate: true }
)
watch(
  () => preferences.preferences.autoPrint,
  () => void store.loadSetup()
)

onMounted(() => {
  timer = setInterval(refresh, REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer)
  }
})
</script>

<template>
  <AppBanner
    v-if="setupMessage"
    variant="warning"
    icon="print_disabled"
    role="status"
    :title="t('printing.auto.setup.title')"
    :dismiss-label="t('printing.auto.setup.dismiss')"
    data-testid="auto-print-setup-banner"
    @dismiss="store.dismissSetup()"
  >
    {{ setupMessage }}
    <template #action>
      <AppButton variant="secondary" size="sm" icon="settings" @click="router.push('/settings')">
        {{ t('printing.auto.setup.openSettings') }}
      </AppButton>
    </template>
  </AppBanner>
  <AppBanner
    v-if="store.notices.length > 0"
    variant="info"
    icon="print_disabled"
    role="status"
    :title="t('printing.auto.notices.title', { count: store.notices.length }, store.notices.length)"
    :dismiss-label="t('printing.auto.notices.dismiss')"
    data-testid="auto-print-notices"
    @dismiss="store.dismissNotices()"
  >
    {{ t('printing.auto.notices.body') }}
    <span v-if="noticeNumbers.length > 0" class="numeric block font-semibold">
      {{ noticeNumbers.join(', ') }}
    </span>
  </AppBanner>
</template>
