<script setup lang="ts">
/** Cashier menu (V3): identity, Language, Theme and Sign out. */
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppDropdown from '@renderer/shared/components/common/AppDropdown.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppMenuItem from '@renderer/shared/components/common/AppMenuItem.vue'
import ThemeSwitcher from '@renderer/shared/components/common/ThemeSwitcher.vue'
import LocaleSwitcher from '@renderer/shared/components/LocaleSwitcher.vue'
import { useAuthStore } from '@renderer/modules/auth/store'

const emit = defineEmits<{ signOut: [] }>()
const { t } = useI18n()
const { session } = storeToRefs(useAuthStore())
const open = ref(false)

const displayName = computed(() => session.value?.userName || t('shell.user.fallbackName'))
const initials = computed(() =>
  displayName.value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
)
</script>

<template>
  <AppDropdown
    v-model:open="open"
    :label="t('shell.user.menuLabel')"
    width="300px"
    trigger-class="flex h-11 items-center gap-2 rounded-notice px-2 text-ink hover:bg-subtle"
  >
    <template #trigger>
      <span
        aria-hidden="true"
        class="flex size-8.5 items-center justify-center rounded-full bg-ink text-xs font-bold text-surf"
        >{{ initials }}</span
      >
      <span class="hidden max-w-40 truncate text-base font-semibold pills:inline">{{
        displayName
      }}</span>
      <AppIcon name="expand_more" :size="20" class="text-muted" />
    </template>
    <template #default="{ close }">
      <div class="flex flex-col gap-3.5 p-1">
        <div class="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            class="flex size-10 flex-none items-center justify-center rounded-full bg-ink text-sm font-bold text-surf"
            >{{ initials }}</span
          >
          <div class="min-w-0">
            <div class="truncate font-bold">{{ displayName }}</div>
            <div class="truncate text-xs text-muted" dir="auto">
              {{ session?.userEmail ?? t('shell.user.signedIn') }}
            </div>
          </div>
        </div>
        <LocaleSwitcher show-label />
        <ThemeSwitcher show-label />
        <AppMenuItem
          icon="logout"
          mirror-icon
          class="border border-line"
          @select="
            () => {
              close()
              emit('signOut')
            }
          "
          >{{ t('common.signOut') }}</AppMenuItem
        >
      </div>
    </template>
  </AppDropdown>
</template>
