<script setup lang="ts">
import { onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterLink, useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useCompanyUsersStore } from '@renderer/modules/companyUsers/store'
import { getStartupRouteName } from '../router/guards'

const companyUsers = useCompanyUsersStore()
const { access } = storeToRefs(companyUsers)
const auth = useAuthStore()
const { session, isSubmitting } = storeToRefs(auth)
const startup = useStartupStore()
const router = useRouter()

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
        <p class="app-layout__eyebrow">Thinis POS</p>
        <strong>Workstation shell</strong>
      </div>
      <div class="app-layout__header-actions">
        <span class="app-layout__status">Local-first foundation</span>
        <span v-if="session?.userName" class="app-layout__user">{{ session.userName }}</span>
        <button
          type="button"
          class="app-layout__logout"
          :disabled="isSubmitting"
          @click="handleLogout"
        >
          {{ isSubmitting ? 'Signing out…' : 'Log out' }}
        </button>
      </div>
    </header>
    <nav class="app-layout__nav" aria-label="Application">
      <RouterLink to="/pos">POS</RouterLink>
      <RouterLink to="/sync">Sync</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
      <RouterLink v-if="access?.canView || access?.canManage" to="/company-users">
        Company users
      </RouterLink>
    </nav>
    <main class="app-layout__content">
      <slot />
    </main>
  </div>
</template>
