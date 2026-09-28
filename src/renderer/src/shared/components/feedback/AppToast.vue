<script setup lang="ts">
/** V3 toast: inverted chip (ink on page) pinned bottom-centre above the cart bar. */
import { computed } from 'vue'
import AppIcon from '../common/AppIcon.vue'
import type { IconName } from '../common/icons.generated'

const props = withDefaults(
  defineProps<{
    variant?: 'info' | 'success' | 'warning' | 'error'
    dismissLabel: string
    icon?: IconName
  }>(),
  { variant: 'info', icon: undefined }
)

const emit = defineEmits<{ dismiss: [] }>()
const iconName = computed<IconName>(
  () =>
    props.icon ??
    ({ info: 'info', success: 'check_circle', warning: 'warning', error: 'error' } as const)[
      props.variant
    ]
)
</script>

<template>
  <div
    class="app-toast fixed bottom-22 left-1/2 z-95 flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-2.5 rounded-notice bg-ink px-4 py-3 text-sm font-semibold text-page shadow-pop"
    :class="`app-toast--${variant}`"
    role="status"
  >
    <AppIcon :name="iconName" :size="20" />
    <div class="app-toast__content min-w-0 flex-1"><slot /></div>
    <button
      type="button"
      class="app-toast__dismiss -me-1 flex size-8 items-center justify-center rounded-md hover:bg-page/10"
      :aria-label="dismissLabel"
      @click="emit('dismiss')"
    >
      <AppIcon name="close" :size="18" />
    </button>
  </div>
</template>
