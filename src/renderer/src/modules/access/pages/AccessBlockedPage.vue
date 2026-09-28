<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { Translation, useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useAccessStore } from '../store'

const access = useAccessStore()
const { state, isRefreshing } = storeToRefs(access)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

/**
 * Presentation only: the localized access message already ends with "Reference: <trace id>"; the
 * reference has its own box below, so the message shows without that exact suffix.
 */
const message = computed(() => {
  const { message: text, traceId } = state.value
  const suffix = traceId ? ` ${t('startup.reference', { traceId })}` : ''

  return suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
})

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
  <div class="access-blocked-page flex flex-col items-start gap-3.5" role="alert">
    <span
      class="flex size-12 items-center justify-center rounded-full bg-err-bg text-err"
      aria-hidden="true"
    >
      <AppIcon name="block" :size="26" />
    </span>
    <PageHeader
      class="self-stretch"
      :title="t('startup.accessBlockedLabel')"
      :description="t('startup.accessBlockedTitle')"
    />
    <p class="text-base text-pretty">{{ message }}</p>
    <div
      v-if="state.traceId"
      class="flex flex-col gap-1 self-stretch rounded-notice bg-subtle px-3.5 py-3 text-sm"
    >
      <Translation keypath="startup.reference" tag="span" class="font-semibold">
        <template #traceId>
          <span class="code">{{ state.traceId }}</span>
        </template>
      </Translation>
      <span class="text-muted">{{ t('access.shareReference') }}</span>
    </div>
    <div class="flex flex-col gap-2.5 self-stretch">
      <AppButton
        variant="primary"
        size="lg"
        full-width
        :loading="isRefreshing"
        data-testid="access-refresh-workstation"
        @click="refreshWorkstationData"
      >
        {{ isRefreshing ? t('pos.catalogRefresh.pending') : t('pos.catalogRefresh.action') }}
      </AppButton>
      <AppButton variant="secondary" size="lg" full-width :disabled="isRefreshing" @click="retry">
        {{ t('common.retry') }}
      </AppButton>
    </div>
  </div>
</template>
