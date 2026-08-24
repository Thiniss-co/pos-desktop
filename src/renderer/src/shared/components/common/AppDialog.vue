<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const headingId = useId()
const dialogRef = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null

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

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
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
      const [first] = getFocusable()
      first?.focus()
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
    <div v-if="open" class="app-dialog__scrim" @mousedown.self="emit('close')">
      <div
        ref="dialogRef"
        class="app-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="headingId"
      >
        <h2 :id="headingId" class="app-dialog__title"><slot name="title" /></h2>
        <div class="app-dialog__body"><slot /></div>
        <div v-if="$slots.actions" class="app-dialog__actions"><slot name="actions" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.app-dialog__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: var(--color-scrim);
}

.app-dialog {
  width: min(480px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  border-radius: var(--radius-lg);
  background: var(--color-surface-container-lowest);
  border: 1px solid var(--color-outline-variant);
  box-shadow: 0 24px 48px var(--color-scrim);
}

.app-dialog__title {
  font-size: var(--text-headline-sm-size);
  line-height: var(--text-headline-sm-line);
  font-weight: var(--text-headline-sm-weight);
  color: var(--color-on-surface);
}

.app-dialog__body {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-md-size);
  line-height: var(--text-body-md-line);
}

.app-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
