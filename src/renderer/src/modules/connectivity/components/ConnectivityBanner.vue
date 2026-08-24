<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import { useConnectivityStore } from '../store'

const { t } = useI18n()
const connectivity = useConnectivityStore()
const {
  isRetrying,
  showBackendUnavailableWarning,
  showCheckingHint,
  showOfflineWarning,
  showRestoredToast
} = storeToRefs(connectivity)
</script>

<template>
  <AppBanner
    v-if="showOfflineWarning || showBackendUnavailableWarning"
    class="connectivity-banner"
    variant="warning"
    role="alert"
  >
    <p>
      {{ showOfflineWarning ? t('connectivity.offline') : t('connectivity.backendUnavailable') }}
    </p>
    <template #action>
      <AppButton variant="ghost" :loading="isRetrying" @click="connectivity.retry()">
        {{ t('connectivity.retry') }}
      </AppButton>
    </template>
  </AppBanner>
  <AppBanner v-else-if="showCheckingHint" class="connectivity-banner" variant="info" role="status">
    {{ t('connectivity.checking') }}
  </AppBanner>
  <AppBanner
    v-else-if="showRestoredToast"
    class="connectivity-banner"
    variant="success"
    role="status"
  >
    {{ t('connectivity.restored') }}
  </AppBanner>
</template>

<style scoped>
.connectivity-banner {
  margin-block-end: var(--space-4);
}
</style>
