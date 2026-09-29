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
 * - Tab from an element that is focusable only programmatically (`tabindex="-1"`, e.g. a heading
 *   used as the initial focus target) still wraps inside the dialog instead of escaping it.
 *
 * `sheet="compact"`: below the `wide` breakpoint, or on a `short` viewport, the dialog becomes a
 * full-screen sheet (no scrim padding, no radius, no max width, full height). In every size the
 * header and the footer (`actions`) never scroll — the body is the only scrolling region.
 * Attributes passed to the component (class, data-*) land on the dialog panel.
 */
import { nextTick, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue'
import AppIconButton from './AppIconButton.vue'

defineOptions({ inheritAttrs: false })

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
    /** `compact`: full-screen sheet below `wide` width or on a `short` height. */
    sheet?: 'compact'
  }>(),
  {
    size: 'md',
    role: 'dialog',
    closeLabel: undefined,
    persistent: false,
    tone: 'standard',
    sheet: undefined
  }
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

/**
 * `short:` is emitted after `wide:` by Tailwind, so on a wide-but-short viewport these win over the
 * default `wide:` padding and max height; `max-wide:` and `wide:` never overlap.
 */
const SHEET_SCRIM = 'max-wide:p-0 short:p-0'
const SHEET_PANEL =
  'app-dialog--sheet max-wide:h-full max-wide:max-h-none max-wide:max-w-none max-wide:rounded-none short:h-full short:max-h-none short:max-w-none short:rounded-none'

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
  const active = document.activeElement

  // Focus outside this dialog (e.g. a dialog stacked on top of it) is not this dialog's to trap.
  if (!(active instanceof HTMLElement) || !dialogRef.value?.contains(active)) {
    return
  }

  if (event.shiftKey && (active === first || !hasFocusableBefore(active, focusable))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !hasFocusableAfter(active, focusable))) {
    event.preventDefault()
    first.focus()
  }
}

/** True when a tabbable element precedes `active` in document order. */
function hasFocusableBefore(active: HTMLElement, focusable: HTMLElement[]): boolean {
  return focusable.some(
    (element) =>
      element !== active &&
      (element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  )
}

/** True when a tabbable element follows `active` in document order. */
function hasFocusableAfter(active: HTMLElement, focusable: HTMLElement[]): boolean {
  return focusable.some(
    (element) =>
      element !== active &&
      (active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  )
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
      :class="{ [SHEET_SCRIM]: sheet === 'compact' }"
      @mousedown.self="requestClose"
    >
      <div
        v-bind="$attrs"
        ref="dialogRef"
        class="app-dialog flex max-h-[calc(100vh-32px)] w-full flex-col overflow-hidden rounded-xl bg-surf text-ink shadow-pop wide:max-h-[calc(100vh-48px)]"
        :class="[
          `app-dialog--${props.size}`,
          WIDTH[props.size],
          { [SHEET_PANEL]: sheet === 'compact' }
        ]"
        :role="role"
        aria-modal="true"
        :aria-labelledby="headingId"
      >
        <div
          class="app-dialog__header flex flex-none items-start gap-3"
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
          <slot name="header-end" />
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
            { 'app-dialog__body--flush': !slots.default, 'overscroll-contain': sheet === 'compact' }
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
