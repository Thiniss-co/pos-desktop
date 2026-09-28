<script setup lang="ts">
/**
 * Short confirmation (V3 alert dialog): title, message, Cancel (focused first, so Enter never
 * confirms a destructive action by accident) and one confirm action.
 */
import AppButton from './AppButton.vue'
import AppDialog from './AppDialog.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
    variant?: 'danger' | 'primary'
    loading?: boolean
  }>(),
  { variant: 'danger', loading: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <AppDialog
    :open="open"
    size="sm"
    role="alertdialog"
    tone="plain"
    :persistent="loading"
    @close="emit('cancel')"
  >
    <template #title>{{ title }}</template>
    <p class="text-base text-pretty">{{ message }}</p>
    <slot />
    <template #actions>
      <AppButton variant="secondary" data-autofocus :disabled="loading" @click="emit('cancel')">
        {{ cancelLabel }}
      </AppButton>
      <AppButton :variant="variant" :loading="loading" @click="emit('confirm')">
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppDialog>
</template>
