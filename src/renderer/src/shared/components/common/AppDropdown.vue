<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'

withDefaults(
  defineProps<{
    label: string
    open: boolean
  }>(),
  {}
)

const emit = defineEmits<{ 'update:open': [boolean] }>()

const menuId = useId()
const rootRef = ref<HTMLElement | null>(null)

function close(): void {
  emit('update:open', false)
}

function toggle(): void {
  emit('update:open', true)
}

function onDocumentClick(event: MouseEvent): void {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
    close()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
  }
}

watch(
  () => rootRef.value,
  () => {
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKeydown)
  },
  { once: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootRef" class="app-dropdown">
    <button
      type="button"
      class="app-dropdown__trigger"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="menuId"
      @click="open ? close() : toggle()"
    >
      <slot name="trigger">{{ label }}</slot>
    </button>
    <div v-if="open" :id="menuId" class="app-dropdown__menu" role="menu">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.app-dropdown {
  position: relative;
  display: inline-block;
}

.app-dropdown__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--size-target-min);
  padding-inline: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-outline);
  background: var(--color-surface-container-lowest);
  color: var(--color-on-surface);
  cursor: pointer;
}

.app-dropdown__menu {
  position: absolute;
  inset-inline-end: 0;
  margin-block-start: var(--space-1);
  min-width: 12rem;
  z-index: var(--z-dropdown);
  padding: var(--space-1);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-outline-variant);
  background: var(--color-surface-container-lowest);
  box-shadow: 0 12px 24px var(--color-scrim);
}
</style>
