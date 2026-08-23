<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'

const { t } = useI18n()
</script>

<template>
  <main class="public-layout">
    <section class="public-layout__card" aria-labelledby="app-title">
      <header class="public-layout__header">
        <div>
          <p class="public-layout__eyebrow">{{ t('app.publicEyebrow') }}</p>
          <h1 id="app-title" class="public-layout__title">{{ t('app.publicTitle') }}</h1>
        </div>
        <LocaleSwitcher />
      </header>
      <ConnectivityBanner />
      <slot />
    </section>
  </main>
</template>
