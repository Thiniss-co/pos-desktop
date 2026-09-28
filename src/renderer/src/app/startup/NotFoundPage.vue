<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'

const { t } = useI18n()
</script>

<template>
  <div class="not-found-page flex flex-col items-start gap-3.5">
    <span
      class="flex size-12 items-center justify-center rounded-full bg-subtle text-muted"
      aria-hidden="true"
    >
      <AppIcon name="search_off" :size="26" />
    </span>
    <PageHeader
      class="self-stretch"
      :title="t('startup.notFoundTitle')"
      :description="t('startup.notFoundLabel')"
    />
    <RouterLink
      class="not-found-page__link inline-flex min-h-12 items-center justify-center gap-2 self-stretch rounded-md border border-control bg-surf px-4.5 text-base font-semibold text-ink no-underline hover:bg-subtle hover:text-ink"
      to="/"
    >
      <AppIcon name="arrow_back" :size="20" mirror-rtl />{{ t('startup.returnToStartup') }}
    </RouterLink>
  </div>
</template>
