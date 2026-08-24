<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useAccessStore } from '../store'

const { state } = storeToRefs(useAccessStore())
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

async function retry(): Promise<void> {
  await startup.refresh()
  await router.push({ name: startup.state === 'ready' ? 'pos' : 'root' })
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
    <AppButton variant="secondary" @click="retry">{{ t('common.retry') }}</AppButton>
  </div>
</template>

<style scoped>
.access-blocked-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  align-items: flex-start;
}

.access-blocked-page__reference {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}
</style>
