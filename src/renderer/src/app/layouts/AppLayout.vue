<script setup lang="ts">
/**
 * V3 application shell: top bar, full-width notices, the routed page, and the shell-level
 * overlays (compact nav drawer, shift dialogs, sign-out confirmation).
 *
 * The shell holds the sync-status subscription for its whole lifetime (the store is reference
 * counted, so pages that also hold it never blank the pill when they unmount) and reads the
 * current shift once if nothing has yet — the shift pill must be truthful on every page, not only
 * after the POS page has mounted.
 */
import WorkstationRefreshControl from '@renderer/app/shell/WorkstationRefreshControl.vue'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import { PILL_TONE_TEXT } from '@renderer/shared/components/common/types'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useCompanyUsersStore } from '@renderer/modules/companyUsers/store'
import ShiftDialogs from '@renderer/modules/pos/components/ShiftDialogs.vue'
import { useShiftStore } from '@renderer/modules/pos/shift.store'
import { useSyncStore } from '@renderer/modules/sync/store'
import AppTopBar from '../shell/AppTopBar.vue'
import NavDrawer from '../shell/NavDrawer.vue'
import ShellNotices from '../shell/ShellNotices.vue'
import SignOutDialog from '../shell/SignOutDialog.vue'
import { useShellNavigation } from '../shell/useShellNavigation'
import { useShellStatus } from '../shell/useShellStatus'

const route = useRoute()
const companyUsers = useCompanyUsersStore()
const auth = useAuthStore()
const shift = useShiftStore()
const sync = useSyncStore()
const { items } = useShellNavigation()
const { network, syncPill } = useShellStatus()

const navOpen = ref(false)
const signOutOpen = ref(false)
const mainRef = ref<HTMLElement | null>(null)
const { t } = useI18n()

function focusMain(): void {
  mainRef.value?.focus()
}

watch(
  () => route.fullPath,
  () => {
    navOpen.value = false
  }
)

onMounted(() => {
  void companyUsers.loadAccess()
  void auth.load()
  void sync.initialize()
  if (
    shift.freshness === 'loading' &&
    shift.currentShift === null &&
    shift.localAuthority === null
  ) {
    void shift.loadCurrent()
  }
})

onBeforeUnmount(() => sync.dispose())
</script>

<template>
  <div class="app-layout flex h-screen min-w-0 flex-col bg-page text-ink">
    <!-- Keyboard users reach the page without tabbing through the whole top bar. A button, not an
         `#main` link: the router uses hash history, so a fragment link would navigate. -->
    <button
      type="button"
      class="app-layout__skip sr-only focus:not-sr-only focus:absolute focus:inset-s-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surf focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-pri-text focus:shadow-md"
      @click="focusMain"
    >
      {{ t('shell.skipToContent') }}
    </button>
    <AppTopBar :items="items" @open-nav="navOpen = true" @sign-out="signOutOpen = true" />
    <ShellNotices />
    <main
      id="main"
      ref="mainRef"
      tabindex="-1"
      class="app-layout__content relative flex min-h-0 flex-1 flex-col overflow-auto focus:outline-none"
    >
      <slot />
    </main>

    <NavDrawer :open="navOpen" :items="items" @close="navOpen = false">
      <template #status>
        <div class="flex items-center gap-2" :class="PILL_TONE_TEXT[network.tone]">
          <AppIcon :name="network.icon" :size="18" /><span class="text-ink">{{
            network.label
          }}</span>
        </div>
        <div class="flex items-center gap-2" :class="PILL_TONE_TEXT[syncPill.tone]">
          <AppIcon :name="syncPill.icon" :size="18" /><span class="text-ink">{{
            syncPill.label
          }}</span>
        </div>
        <WorkstationRefreshControl compact />
      </template>
    </NavDrawer>
    <ShiftDialogs />
    <SignOutDialog :open="signOutOpen" @close="signOutOpen = false" />
  </div>
</template>
