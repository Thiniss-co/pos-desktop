<script setup lang="ts">
/**
 * Anchored popover menu (V3: raised surface, 12px radius, pop shadow). The trigger slot renders
 * inside the toggle button; the default slot holds `role="menuitem"` rows (see AppMenuItem).
 * Escape and an outside click close it; Escape returns focus to the trigger.
 *
 * `layer="top"` (POS workspace) renders the menu as a native popover in the top layer, placed next
 * to the trigger and flipped/clamped to stay inside the viewport, so a menu opened inside a
 * scrolling region (a cart line) is never clipped. Existing menus keep the inline default.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    open: boolean
    align?: 'start' | 'end'
    width?: string
    triggerClass?: string
    layer?: 'inline' | 'top'
    /** Optional native tooltip of the trigger. */
    triggerTitle?: string
  }>(),
  { align: 'end', width: '300px', triggerClass: '', layer: 'inline', triggerTitle: undefined }
)

const emit = defineEmits<{ 'update:open': [boolean] }>()

const menuId = useId()
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

const VIEWPORT_MARGIN = 8

function supportsPopover(element: HTMLElement | null): element is HTMLElement {
  return element !== null && typeof element.showPopover === 'function'
}

/** Places the top-layer menu below (or, when it does not fit, above) the trigger, inside the viewport. */
function position(): void {
  const menu = menuRef.value
  const trigger = triggerRef.value
  if (props.layer !== 'top' || !menu || !trigger) {
    return
  }
  const anchor = trigger.getBoundingClientRect()
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  const rtl = getComputedStyle(trigger).direction === 'rtl'
  // `end` aligns the menu's inline end with the trigger's inline end (right in LTR, left in RTL).
  const alignEnd = props.align === 'end' ? !rtl : rtl
  let left = alignEnd ? anchor.right - width : anchor.left
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - width - VIEWPORT_MARGIN)
  let top = anchor.bottom + VIEWPORT_MARGIN
  if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
    const above = anchor.top - VIEWPORT_MARGIN - height
    top =
      above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)
  }
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
}

function onViewportChange(): void {
  if (props.open) {
    position()
  }
}

function close(returnFocus = false): void {
  emit('update:open', false)
  if (returnFocus) {
    triggerRef.value?.focus()
  }
}

function toggle(): void {
  emit('update:open', !props.open)
}

function onDocumentPointer(event: MouseEvent): void {
  if (props.open && rootRef.value && !rootRef.value.contains(event.target as Node)) {
    close()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) {
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = Array.from(
      menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
    )
    if (items.length === 0) {
      return
    }
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'ArrowDown'
        ? items[(index + 1) % items.length]
        : items[(index - 1 + items.length) % items.length]
    next.focus()
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      await nextTick()
      if (props.layer === 'top' && supportsPopover(menuRef.value)) {
        if (!menuRef.value.matches(':popover-open')) {
          menuRef.value.showPopover()
        }
        position()
      }
      menuRef.value
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), button:not([disabled])')
        ?.focus()
    }
  }
)

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointer)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointer)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <div ref="rootRef" class="app-dropdown relative">
    <button
      ref="triggerRef"
      type="button"
      class="app-dropdown__trigger"
      :class="triggerClass"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? menuId : undefined"
      :aria-label="$slots.trigger ? label : undefined"
      :title="triggerTitle"
      @click="toggle"
    >
      <slot name="trigger">{{ label }}</slot>
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menuRef"
      class="app-dropdown__menu z-50 flex max-w-[calc(100vw-24px)] flex-col rounded-lg border border-line bg-raised p-2 text-ink shadow-pop"
      :class="
        layer === 'top'
          ? 'app-dropdown__menu--top fixed inset-auto m-0 max-h-[calc(100vh-16px)] overflow-y-auto'
          : ['absolute top-[calc(100%+8px)]', align === 'end' ? 'end-0' : 'start-0']
      "
      :style="{ width }"
      :popover="layer === 'top' ? 'manual' : undefined"
      role="menu"
      :aria-label="label"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
