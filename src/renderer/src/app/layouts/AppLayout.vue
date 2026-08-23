<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useCompanyUsersStore } from '@renderer/modules/companyUsers/store'
import ConnectivityBanner from '@renderer/modules/connectivity/components/ConnectivityBanner.vue'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'
import { getStartupRouteName } from '../router/guards'

const companyUsers = useCompanyUsersStore()
const { access } = storeToRefs(companyUsers)
const auth = useAuthStore()
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
  await startup.refresh()
  await router.push({ name: getStartupRouteName(startup.state) })
}
</script>

<template>
  <div class="app-layout">
    <header class="app-layout__header">
      <div>
        <p class="app-layout__eyebrow">{{ t('app.name') }}</p>
        <strong>{{ t('app.workstationShell') }}</strong>
      </div>
      <div class="app-layout__header-actions">
        <span class="app-layout__status">{{ t('app.localFirstFoundation') }}</span>
        <span v-if="session?.userName" class="app-layout__user">{{ session.userName }}</span>
        <LocaleSwitcher />
        <button
          type="button"
          class="app-layout__logout"
          :disabled="isSubmitting"
          @click="handleLogout"
        >
          {{ isSubmitting ? t('common.signingOut') : t('common.signOut') }}
        </button>
      </div>
    </header>
    <ConnectivityBanner />
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
</template>
