<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'

const { t } = useI18n()
</script>

<template>
  <section class="pos-page">
    <PageHeader
      :eyebrow="t('pos.label')"
      :title="t('pos.title')"
      :description="t('pos.description')"
    />
  </section>
</template>

<style scoped>
.pos-page {
  display: flex;
  flex-direction: column;
}
</style>
