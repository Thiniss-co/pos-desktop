<script setup lang="ts">
/**
 * Modal dialog: header / scrolling body / pinned footer (V3, 16px radius on the overlay scrim).
 *
 * Accessibility contract (covered by AppDialog.test.ts):
 * - `role="dialog"` (or `alertdialog`) with `aria-modal` and `aria-labelledby` → the title slot.
 * - Focus moves into the dialog on open — to the first `[data-autofocus]` element if one exists,
 *   otherwise the first focusable control — is contained by Tab/Shift+Tab, and returns to the
 *   element that was focused before it opened.
 * - Escape and a scrim press close it unless `persistent` (e.g. while a request is in flight).
 */
import { nextTick, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue'
import AppIconButton from './AppIconButton.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    size?: 'sm' | 'md' | 'lg' | 'xl'
    role?: 'dialog' | 'alertdialog'
    /** Accessible name for the header close button. Omit to render no close button. */
    closeLabel?: string
    /** Blocks Escape, scrim and close-button dismissal (a request is in flight). */
    persistent?: boolean
    /** `plain` drops the header rule and footer tint — for short confirmations. */
    tone?: 'standard' | 'plain'
  }>(),
  { size: 'md', role: 'dialog', closeLabel: undefined, persistent: false, tone: 'standard' }
)
const emit = defineEmits<{ close: [] }>()
const slots = useSlots()

const headingId = useId()
const dialogRef = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

const WIDTH = {
  sm: 'max-w-[440px]',
  md: 'max-w-[480px]',
  lg: 'max-w-[820px]',
  xl: 'max-w-[1040px]'
}

function getFocusable(): HTMLElement[] {
  if (!dialogRef.value) {
    return []
  }
  return Array.from(
    dialogRef.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  )
}

function requestClose(): void {
  if (!props.persistent) {
    emit('close')
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }

  if (event.key !== 'Tab') {
    return
  }

  const focusable = getFocusable()
  if (focusable.length === 0) {
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null
      await nextTick()
      const preferred = dialogRef.value?.querySelector<HTMLElement>('[data-autofocus]')
      const target = preferred ?? getFocusable()[0]
      target?.focus()
      document.addEventListener('keydown', onKeydown)
    } else {
      document.removeEventListener('keydown', onKeydown)
      previouslyFocused?.focus()
      previouslyFocused = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="app-dialog__scrim fixed inset-0 z-60 flex items-center justify-center bg-overlay p-4 wide:p-6"
      @mousedown.self="requestClose"
    >
      <div
        ref="dialogRef"
        class="app-dialog flex max-h-[calc(100vh-32px)] w-full flex-col overflow-hidden rounded-xl bg-surf text-ink shadow-pop wide:max-h-[calc(100vh-48px)]"
        :class="[`app-dialog--${props.size}`, WIDTH[props.size]]"
        :role="role"
        aria-modal="true"
        :aria-labelledby="headingId"
      >
        <div
          class="flex flex-none items-start gap-3"
          :class="
            tone === 'plain' ? 'px-5 pt-5.5 pb-2' : 'border-b border-line px-5 py-4 wide:py-4.5'
          "
        >
          <slot name="leading" />
          <h2
            :id="headingId"
            class="app-dialog__title min-w-0 text-xl font-bold text-pretty"
            :class="{ 'self-center': tone !== 'plain' }"
          >
            <slot name="title" />
          </h2>
          <slot name="header-extra" />
          <div class="flex-1" aria-hidden="true" />
          <AppIconButton
            v-if="closeLabel"
            :label="closeLabel"
            icon="close"
            :disabled="persistent"
            class="-my-1 -me-2"
            @click="requestClose"
          />
        </div>
        <div
          class="app-dialog__body flex min-h-0 flex-1 flex-col gap-4 overflow-auto"
          :class="[
            tone === 'plain' ? 'px-5 pb-2 text-muted' : 'p-5',
            { 'app-dialog__body--flush': !slots.default }
          ]"
        >
          <slot />
        </div>
        <div
          v-if="$slots.actions"
          class="app-dialog__actions flex flex-none flex-wrap items-center justify-end gap-2.5 px-5 py-3.5"
          :class="tone === 'plain' ? 'pt-4 pb-5' : 'border-t border-line bg-subtle'"
        >
          <slot name="actions" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
