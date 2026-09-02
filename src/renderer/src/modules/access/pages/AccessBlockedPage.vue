<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useAccessStore } from '../store'

const access = useAccessStore()
const { state, isRefreshing } = storeToRefs(access)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

async function retry(): Promise<void> {
  await startup.refresh()
  await router.push({ name: startup.state === 'ready' ? 'pos' : 'root' })
}

/**
 * The recovery for a *recoverable* block — an overdue license above all, which is cleared by
 * re-validating against the desktop service.
 *
 * Main owns every step: license validation and persistence, the refreshed commercial-access
 * decision, then session, bootstrap, catalog, and stock refresh. This page supplies no license
 * authority and no timestamp. On success it re-evaluates startup so the warning disappears and the
 * cashier lands back in the POS; on failure the block stays and the store surfaces the real error.
 */
async function refreshWorkstationData(): Promise<void> {
  const recovered = await access.refreshWorkstation()

  if (recovered) {
    await startup.refresh()
    await router.push({ name: startup.state === 'ready' ? 'pos' : 'root' })
  }
}
</script>

<template>
  <div class="access-blocked-page" role="alert">
    <PageHeader
      :eyebrow="t('startup.accessBlockedLabel')"
      :title="t('startup.accessBlockedTitle')"
    />
    <p>{{ state.message }}</p>
    <p v-if="state.traceId" class="access-blocked-page__reference numeric">
      {{ t('startup.reference', { traceId: state.traceId }) }}
    </p>
    <div class="access-blocked-page__actions">
      <AppButton
        variant="primary"
        :disabled="isRefreshing"
        data-testid="access-refresh-workstation"
        @click="refreshWorkstationData"
      >
        {{ isRefreshing ? t('pos.catalogRefresh.pending') : t('pos.catalogRefresh.action') }}
      </AppButton>
      <AppButton variant="secondary" :disabled="isRefreshing" @click="retry">
        {{ t('common.retry') }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.access-blocked-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  align-items: flex-start;
}

.access-blocked-page__actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.access-blocked-page__reference {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}
</style>
