<script setup lang="ts">
/** Compact (< 900px) navigation drawer with the three status lines at its foot (V3 `m.nav`). */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import type { ShellNavItem } from './useShellNavigation'

const props = defineProps<{ open: boolean; items: readonly ShellNavItem[] }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const panelRef = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !panelRef.value) {
    return
  }
  const focusable = Array.from(
    panelRef.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
  )
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      returnFocus = document.activeElement as HTMLElement | null
      await nextTick()
      panelRef.value?.querySelector<HTMLElement>('[aria-current="page"], a[href]')?.focus()
      document.addEventListener('keydown', onKeydown)
    } else {
      document.removeEventListener('keydown', onKeydown)
      returnFocus?.focus()
      returnFocus = null
    }
  }
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-60 flex bg-overlay" @mousedown.self="emit('close')">
      <div
        ref="panelRef"
        role="dialog"
        aria-modal="true"
        :aria-label="t('shell.menu')"
        class="flex h-full w-[min(320px,86vw)] flex-col gap-1 bg-surf p-3 text-ink shadow-pop"
      >
        <div class="flex items-center gap-2.5 px-1.5 pt-1.5 pb-3.5">
          <span
            aria-hidden="true"
            class="flex size-8.5 items-center justify-center rounded-[9px] bg-pri text-on-pri"
            ><AppIcon name="stacks" :size="20"
          /></span>
          <span class="flex-1 text-lg font-bold">{{ t('shell.brand') }}</span>
          <AppIconButton :label="t('common.close')" icon="close" @click="emit('close')" />
        </div>
        <nav :aria-label="t('shell.mainNavigation')" class="flex flex-col gap-1">
          <RouterLink
            v-for="item in items"
            :key="item.name"
            :to="item.to"
            :aria-current="item.active ? 'page' : undefined"
            class="flex h-12 items-center gap-3 rounded-md px-3 text-base no-underline"
            :class="
              item.active
                ? 'bg-pri-soft font-bold text-pri-text'
                : 'font-medium text-ink hover:bg-subtle'
            "
            @click="emit('close')"
          >
            <AppIcon :name="item.icon" :size="22" />{{ item.label }}
          </RouterLink>
        </nav>
        <div class="mt-auto flex flex-col gap-2 border-t border-line px-1.5 pt-3 pb-1 text-sm">
          <slot name="status" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
