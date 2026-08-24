<script setup lang="ts">
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
  <AppDialog :open="open" @close="emit('cancel')">
    <template #title>{{ title }}</template>
    <p>{{ message }}</p>
    <template #actions>
      <AppButton variant="ghost" :disabled="loading" @click="emit('cancel')">
        {{ cancelLabel }}
      </AppButton>
      <AppButton :variant="variant" :loading="loading" @click="emit('confirm')">
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppDialog>
</template>
