<script setup lang="ts">
/**
 * Connectivity notice (V3 `n_offline` / `n_unreach` / restored). Non-blocking: selling continues
 * while it shows. `bar` renders the full-width strip under the top bar; the default renders the
 * rounded card used on public (startup) screens. Retry calls the real connectivity re-check.
 * A dismissed notice returns when the connectivity status changes.
 */
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import { useConnectivityStore } from '../store'

withDefaults(defineProps<{ bar?: boolean }>(), { bar: false })

const { t } = useI18n()
const connectivity = useConnectivityStore()
const {
  snapshot,
  isRetrying,
  showBackendUnavailableWarning,
  showCheckingHint,
  showOfflineWarning,
  showRestoredToast
} = storeToRefs(connectivity)

const dismissed = ref(false)
const status = computed(() => snapshot.value?.status)
watch(status, () => {
  dismissed.value = false
})
</script>

<template>
  <template v-if="!dismissed">
    <AppBanner
      v-if="showOfflineWarning || showBackendUnavailableWarning"
      class="connectivity-banner"
      :variant="showOfflineWarning ? 'neutral' : 'warning'"
      :icon="showOfflineWarning ? 'wifi_off' : 'cloud_off'"
      role="alert"
      :bar="bar"
      :title="showOfflineWarning ? t('connectivity.offline') : t('connectivity.backendUnavailable')"
      :dismiss-label="t('shell.notices.dismiss')"
      @dismiss="dismissed = true"
    >
      <!-- The "keep selling" reassurance belongs to the till shell only; startup screens
           (activation, sign in) genuinely need the connection. -->
      <template v-if="bar">{{
        showOfflineWarning ? t('shell.notices.offlineBody') : t('shell.notices.unreachableBody')
      }}</template>
      <template #action>
        <AppButton
          variant="secondary"
          size="sm"
          icon="refresh"
          :loading="isRetrying"
          @click="connectivity.retry()"
        >
          {{ t('connectivity.retry') }}
        </AppButton>
      </template>
    </AppBanner>
    <AppBanner
      v-else-if="showCheckingHint"
      class="connectivity-banner"
      variant="info"
      icon="sync"
      role="status"
      :bar="bar"
    >
      {{ t('connectivity.checking') }}
    </AppBanner>
    <AppBanner
      v-else-if="showRestoredToast"
      class="connectivity-banner"
      variant="success"
      icon="wifi"
      role="status"
      :bar="bar"
      :title="t('connectivity.restored')"
    >
      <template v-if="bar">{{ t('shell.notices.restoredBody') }}</template>
    </AppBanner>
  </template>
</template>
