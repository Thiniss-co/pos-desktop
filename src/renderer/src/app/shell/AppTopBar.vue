<script setup lang="ts">
/**
 * V3 top bar (60px): brand, text navigation with icons (labels beside icons ≥ 1500px, stacked
 * compact labels below), status pills (network · sync · shift) and the cashier menu. Below 900px
 * the navigation collapses into a labelled Menu button that opens the drawer.
 */
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppPill from '@renderer/shared/components/common/AppPill.vue'
import { PILL_TONE_CLASS } from '@renderer/shared/components/common/types'
import ShiftMenu from '@renderer/modules/pos/components/ShiftMenu.vue'
import UserMenu from './UserMenu.vue'
import WorkstationRefreshControl from './WorkstationRefreshControl.vue'
import type { ShellNavItem } from './useShellNavigation'
import { useShellStatus } from './useShellStatus'

defineProps<{ items: readonly ShellNavItem[] }>()
const emit = defineEmits<{ openNav: []; signOut: [] }>()

const { t } = useI18n()
const { network, syncPill } = useShellStatus()
</script>

<template>
  <header
    class="app-top-bar relative z-20 flex h-15 flex-none items-center gap-3 border-b border-line bg-surf px-4"
  >
    <button
      type="button"
      class="flex h-10 items-center gap-1.5 rounded-md border border-line bg-surf px-3 text-sm font-semibold text-ink hover:bg-subtle wide:hidden"
      @click="emit('openNav')"
    >
      <AppIcon name="menu" :size="20" />{{ t('shell.menu') }}
    </button>
    <div class="flex flex-none items-center gap-2.5">
      <span
        aria-hidden="true"
        class="flex size-8.5 items-center justify-center rounded-[9px] bg-pri text-on-pri"
        ><AppIcon name="stacks" :size="20"
      /></span>
      <!-- 900–1199px: the wordmark yields its width to the navigation labels (still announced). -->
      <span class="text-lg font-bold whitespace-nowrap wide:sr-only cartlg:not-sr-only">{{
        t('shell.brand')
      }}</span>
    </div>
    <!--
      Labels are always visible. From 1500px they sit beside the icon (the prototype's layout);
      below that they use a compact stacked treatment — icon over a 12px label that may wrap at a
      word boundary — so 1366 and 1024 keep readable text without pushing into the status pills.
      Items can shrink to their longest word, which keeps the whole row inside its own box.
    -->
    <nav
      :aria-label="t('shell.mainNavigation')"
      class="ms-1 hidden min-w-0 items-stretch gap-0.5 self-stretch wide:flex navlabels:ms-3"
    >
      <RouterLink
        v-for="item in items"
        :key="item.name"
        :to="item.to"
        :aria-current="item.active ? 'page' : undefined"
        class="app-top-bar__nav-item relative flex min-w-0 flex-col items-center justify-center gap-0.5 px-1.5 text-center text-xs leading-[1.15] no-underline navlabels:flex-row navlabels:gap-1.75 navlabels:px-2.75 navlabels:text-base navlabels:leading-normal navlabels:whitespace-nowrap"
        :class="
          item.active ? 'font-bold text-pri-text' : 'font-medium text-ink hover:text-pri-text'
        "
      >
        <AppIcon :name="item.icon" :size="20" class="flex-none" />
        <span
          class="app-top-bar__nav-label max-w-24 text-balance pills:max-w-32 navlabels:max-w-none"
          >{{ item.label }}</span
        >
        <span
          aria-hidden="true"
          class="absolute inset-x-2 bottom-0 h-0.5 rounded-sm"
          :class="item.active ? 'bg-pri' : 'bg-transparent'"
        />
      </RouterLink>
    </nav>
    <div class="min-w-2 flex-1" />
    <div class="flex flex-none items-center gap-2" role="group" :aria-label="t('shell.statusArea')">
      <AppPill :tone="network.tone" :icon="network.icon" :label="network.label" />
      <RouterLink
        to="/sync"
        :aria-label="syncPill.label"
        :title="syncPill.label"
        class="app-pill flex h-8 flex-none items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap no-underline hover:brightness-95"
        :class="PILL_TONE_CLASS[syncPill.tone]"
      >
        <AppIcon :name="syncPill.icon" :size="18" />
        <span class="hidden pills:inline" aria-hidden="true">{{ syncPill.label }}</span>
      </RouterLink>
      <WorkstationRefreshControl />
      <ShiftMenu />
    </div>
    <UserMenu @sign-out="emit('signOut')" />
  </header>
</template>
