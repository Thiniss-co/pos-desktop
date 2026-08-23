<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
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
  <section
    v-if="showOfflineWarning || showBackendUnavailableWarning"
    class="connectivity-banner connectivity-banner--warning"
    role="alert"
  >
    <p>
      {{ showOfflineWarning ? t('connectivity.offline') : t('connectivity.backendUnavailable') }}
    </p>
    <button type="button" :disabled="isRetrying" @click="connectivity.retry()">
      {{ isRetrying ? t('common.loading') : t('connectivity.retry') }}
    </button>
  </section>
  <p
    v-else-if="showCheckingHint"
    class="connectivity-banner connectivity-banner--hint"
    role="status"
  >
    {{ t('connectivity.checking') }}
  </p>
  <p
    v-else-if="showRestoredToast"
    class="connectivity-banner connectivity-banner--restored"
    role="status"
  >
    {{ t('connectivity.restored') }}
  </p>
</template>
