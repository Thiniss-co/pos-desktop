<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useStartupStore } from '@renderer/app/startup/startup.store'

const { snapshot } = storeToRefs(useStartupStore())
const { t } = useI18n()
</script>

<template>
  <section class="settings-page">
    <PageHeader :eyebrow="t('settings.label')" :title="t('settings.title')" />

    <dl v-if="snapshot" class="readiness-list">
      <div>
        <dt>{{ t('settings.appVersion') }}</dt>
        <dd class="numeric">{{ snapshot.runtime.appVersion }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.apiConfiguration') }}</dt>
        <dd>{{ snapshot.runtime.apiConfiguration }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.deviceState') }}</dt>
        <dd>
          {{
            snapshot.device.isRegistered ? t('settings.registered') : t('settings.notRegistered')
          }}
        </dd>
      </div>
    </dl>
    <AppEmptyState v-else :title="t('settings.unavailable')" />
  </section>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
