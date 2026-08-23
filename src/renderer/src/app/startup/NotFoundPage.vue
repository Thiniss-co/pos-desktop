<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">{{ t('startup.notFoundLabel') }}</p>
    <h2>{{ t('startup.notFoundTitle') }}</h2>
    <RouterLink class="button-link" to="/">{{ t('startup.returnToStartup') }}</RouterLink>
  </div>
</template>
