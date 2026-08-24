<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'
import ThemeSwitcher from '@renderer/shared/components/common/ThemeSwitcher.vue'

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
        <div class="public-layout__preferences">
          <ThemeSwitcher />
          <LocaleSwitcher />
        </div>
      </header>
      <ConnectivityBanner />
      <slot />
    </section>
  </main>
</template>

<style scoped>
.public-layout {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--space-6);
}

.public-layout__card {
  width: min(30rem, 100%);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-8);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-lowest);
  box-shadow: 0 24px 48px var(--color-scrim);
}

.public-layout__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.public-layout__eyebrow {
  font-size: var(--text-label-caps-size);
  line-height: var(--text-label-caps-line);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
  font-weight: var(--text-label-caps-weight);
  color: var(--color-text-muted);
}

html[dir='rtl'] .public-layout__eyebrow {
  text-transform: none;
}

.public-layout__title {
  font-size: var(--text-display-md-size);
  line-height: var(--text-display-md-line);
  font-weight: var(--text-display-md-weight);
  color: var(--color-on-surface);
}

.public-layout__preferences {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .public-layout {
    padding: var(--space-4);
  }

  .public-layout__card {
    padding: var(--space-5);
  }
}
</style>
