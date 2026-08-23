<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useStartupStore } from '@renderer/app/startup/startup.store'

const { snapshot } = storeToRefs(useStartupStore())
const { t } = useI18n()
</script>

<template>
  <section class="shell-page">
    <p class="shell-page__label">{{ t('settings.label') }}</p>
    <h2>{{ t('settings.title') }}</h2>
    <dl v-if="snapshot" class="readiness-list">
      <div>
        <dt>{{ t('settings.appVersion') }}</dt>
        <dd>{{ snapshot.runtime.appVersion }}</dd>
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
  </section>
</template>
