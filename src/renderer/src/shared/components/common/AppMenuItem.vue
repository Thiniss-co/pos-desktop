<script setup lang="ts">
/** One row inside AppDropdown. Icon + label, 44px target, subtle hover. */
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons.generated'

withDefaults(
  defineProps<{
    icon?: IconName
    disabled?: boolean
    tone?: 'default' | 'danger' | 'primary'
    mirrorIcon?: boolean
  }>(),
  { icon: undefined, disabled: false, tone: 'default', mirrorIcon: false }
)

const emit = defineEmits<{ select: [MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    role="menuitem"
    class="app-menu-item flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-base font-semibold enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:text-muted"
    :class="tone === 'danger' ? 'text-err' : tone === 'primary' ? 'text-pri-text' : 'text-ink'"
    :disabled="disabled"
    @click="(event) => emit('select', event)"
  >
    <AppIcon v-if="icon" :name="icon" :size="20" :mirror-rtl="mirrorIcon" />
    <span class="min-w-0 flex-1"><slot /></span>
  </button>
</template>
