<script setup lang="ts">
/**
 * Anchored popover menu (V3: raised surface, 12px radius, pop shadow). The trigger slot renders
 * inside the toggle button; the default slot holds `role="menuitem"` rows (see AppMenuItem).
 * Escape and an outside click close it; Escape returns focus to the trigger.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    open: boolean
    align?: 'start' | 'end'
    width?: string
    triggerClass?: string
  }>(),
  { align: 'end', width: '300px', triggerClass: '' }
)

const emit = defineEmits<{ 'update:open': [boolean] }>()

const menuId = useId()
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

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
      menuRef.value
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), button:not([disabled])')
        ?.focus()
    }
  }
)

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointer)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointer)
  document.removeEventListener('keydown', onKeydown)
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
      @click="toggle"
    >
      <slot name="trigger">{{ label }}</slot>
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menuRef"
      class="app-dropdown__menu absolute top-[calc(100%+8px)] z-50 flex max-w-[calc(100vw-24px)] flex-col rounded-lg border border-line bg-raised p-2 text-ink shadow-pop"
      :class="align === 'end' ? 'end-0' : 'start-0'"
      :style="{ width }"
      role="menu"
      :aria-label="label"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
