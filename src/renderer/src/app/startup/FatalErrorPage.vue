<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { localizeAppError } from '@renderer/shared/utils/localizeAppError'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
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
  <div class="fatal-error-page flex flex-col items-start gap-3.5" role="alert">
    <span
      class="flex size-12 items-center justify-center rounded-full bg-err-bg text-err"
      aria-hidden="true"
    >
      <AppIcon name="error" :size="26" />
    </span>
    <PageHeader
      class="self-stretch"
      :title="t('startup.fatalLabel')"
      :description="t('startup.fatalTitle')"
    />
    <p class="text-base text-pretty">{{ message }}</p>
  </div>
</template>
