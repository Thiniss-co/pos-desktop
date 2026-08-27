<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useCartStore } from '@renderer/modules/pos/cart.store'
import { usePaymentStore } from '@renderer/modules/pos/payment.store'
import { useCompanyUsersStore } from '@renderer/modules/companyUsers/store'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import ThemeSwitcher from '@renderer/shared/components/common/ThemeSwitcher.vue'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'
import { getStartupRouteName } from '../router/guards'

const companyUsers = useCompanyUsersStore()
const { access } = storeToRefs(companyUsers)
const auth = useAuthStore()
const cart = useCartStore()
const payment = usePaymentStore()
const { session, isSubmitting } = storeToRefs(auth)
const startup = useStartupStore()
const router = useRouter()
const { t } = useI18n()

onMounted(() => {
  void companyUsers.loadAccess()
  void auth.load()
})

async function handleLogout(): Promise<void> {
  await auth.logout()
  cart.resetDraft('logout')
  payment.resetPayment()
  await startup.refresh()
  await router.push({ name: getStartupRouteName(startup.state) })
}
</script>

<template>
  <div class="app-layout">
    <header class="app-layout__header">
      <div class="app-layout__brand">
        <p class="app-layout__eyebrow">{{ t('app.workstationShell') }}</p>
        <h1 class="app-layout__title">{{ t('app.name') }}</h1>
      </div>
      <div class="app-layout__header-actions">
        <AppStatusChip variant="success">{{ t('app.localFirstFoundation') }}</AppStatusChip>
        <span v-if="session?.userName" class="app-layout__user">{{ session.userName }}</span>
        <ThemeSwitcher />
        <LocaleSwitcher />
        <AppButton variant="ghost" :loading="isSubmitting" @click="handleLogout">
          {{ t('common.signOut') }}
        </AppButton>
      </div>
    </header>
    <ConnectivityBanner class="app-layout__banner" />
    <div class="app-layout__body">
      <nav class="app-layout__nav" :aria-label="t('app.applicationNavigation')">
        <RouterLink to="/pos">{{ t('navigation.pos') }}</RouterLink>
        <RouterLink to="/sync">{{ t('navigation.sync') }}</RouterLink>
        <RouterLink to="/settings">{{ t('navigation.settings') }}</RouterLink>
        <RouterLink v-if="access?.canView || access?.canManage" to="/company-users">
          {{ t('navigation.companyUsers') }}
        </RouterLink>
      </nav>
      <main class="app-layout__content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: grid;
  grid-template-rows: auto auto 1fr;
  min-height: 100vh;
}

.app-layout__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-6);
  border-block-end: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-lowest);
}

.app-layout__eyebrow {
  font-size: var(--text-label-caps-size);
  line-height: var(--text-label-caps-line);
  letter-spacing: var(--text-label-caps-tracking);
  text-transform: uppercase;
  font-weight: var(--text-label-caps-weight);
  color: var(--color-text-muted);
}

html[dir='rtl'] .app-layout__eyebrow {
  text-transform: none;
}

.app-layout__title {
  font-size: var(--text-headline-sm-size);
  line-height: var(--text-headline-sm-line);
  font-weight: var(--text-headline-sm-weight);
  color: var(--color-on-surface);
}

.app-layout__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.app-layout__user {
  font-size: var(--text-body-sm-size);
  color: var(--color-on-surface-variant);
}

.app-layout__banner {
  margin: var(--space-4) var(--space-6) 0;
}

.app-layout__body {
  display: grid;
  grid-template-columns: 14rem 1fr;
  min-height: 0;
}

.app-layout__nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  border-inline-end: 1px solid var(--color-outline-variant);
}

.app-layout__nav a {
  display: flex;
  align-items: center;
  min-height: var(--size-target-min);
  padding-inline: var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-on-surface-variant);
  text-decoration: none;
  font-size: var(--text-body-md-size);
  font-weight: 600;
}

.app-layout__nav a:hover {
  background: var(--color-surface-container);
}

.app-layout__nav a.router-link-active {
  background: var(--color-secondary-container);
  color: var(--color-on-secondary-container);
}

.app-layout__content {
  padding: var(--space-6);
  overflow: auto;
}

@media (max-width: 640px) {
  .app-layout__body {
    grid-template-columns: 1fr;
  }

  .app-layout__nav {
    flex-direction: row;
    flex-wrap: wrap;
    border-inline-end: 0;
    border-block-end: 1px solid var(--color-outline-variant);
  }
}
</style>
