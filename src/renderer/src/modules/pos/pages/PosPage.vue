<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="shell-page">
    <p class="shell-page__label">{{ t('pos.label') }}</p>
    <h2>{{ t('pos.title') }}</h2>
    <p>{{ t('pos.description') }}</p>
  </section>
</template>
