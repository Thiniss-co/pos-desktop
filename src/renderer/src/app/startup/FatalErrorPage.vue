<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import { useStartupStore } from './startup.store'

const { error } = storeToRefs(useStartupStore())
const { t, te } = useI18n()
const message = computed(() =>
  error.value?.detail
    ? localizeAppError(error.value.detail, t, te)
    : (error.value?.message ?? t('startup.fatalFallback'))
)
</script>

<template>
  <div class="startup-panel" role="alert">
    <p class="startup-panel__label">{{ t('startup.fatalLabel') }}</p>
    <h2>{{ t('startup.fatalTitle') }}</h2>
    <p>{{ message }}</p>
  </div>
</template>
