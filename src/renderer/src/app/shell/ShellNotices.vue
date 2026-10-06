<script setup lang="ts">
/**
 * Full-width notices under the top bar (V3 `notices`): connectivity, "uploading is paused"
 * (everywhere except the Sync page) and "uploaded sales need review" (POS only). Each can be
 * dismissed for the session; a dismissed sync notice returns when its count changes.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import { useSyncStore } from '@renderer/modules/sync/store'
import { useCompanySuspension } from '@renderer/modules/license/useCompanySuspension'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const sync = useSyncStore()
// Phase 3: not dismissible — it explains why selling is refused for as long as it is.
const { suspended } = useCompanySuspension()

const pausedDismissed = ref(false)
const reviewDismissed = ref(false)
watch(
  () => sync.isPaused,
  () => (pausedDismissed.value = false)
)
watch(
  () => sync.failedCount,
  () => (reviewDismissed.value = false)
)

const showPaused = computed(() => sync.isPaused && route.name !== 'sync' && !pausedDismissed.value)
const showReview = computed(
  () => sync.failedCount > 0 && route.name === 'pos' && !reviewDismissed.value
)
</script>

<template>
  <div class="flex flex-none flex-col">
    <ConnectivityBanner bar />
    <AppBanner
      v-if="suspended"
      bar
      variant="error"
      icon="block"
      :title="t('shell.notices.suspendedTitle')"
      data-testid="company-suspended-banner"
    >
      {{ t('shell.notices.suspendedBody') }}
    </AppBanner>
    <AppBanner
      v-if="showPaused"
      bar
      variant="warning"
      icon="pause_circle"
      :title="t('shell.notices.pausedTitle')"
      :dismiss-label="t('shell.notices.dismiss')"
      @dismiss="pausedDismissed = true"
    >
      {{ t('shell.notices.pausedBody') }}
      <template #action>
        <AppButton variant="secondary" size="sm" @click="router.push('/sync')">
          {{ t('shell.notices.openSync') }}
        </AppButton>
      </template>
    </AppBanner>
    <AppBanner
      v-if="showReview"
      bar
      variant="info"
      icon="fact_check"
      :title="t('shell.notices.reviewTitle', { count: sync.failedCount })"
      :dismiss-label="t('shell.notices.dismiss')"
      @dismiss="reviewDismissed = true"
    >
      {{ t('shell.notices.reviewBody') }}
      <template #action>
        <AppButton variant="secondary" size="sm" @click="router.push('/sync')">
          {{ t('shell.notices.openSync') }}
        </AppButton>
      </template>
    </AppBanner>
  </div>
</template>
