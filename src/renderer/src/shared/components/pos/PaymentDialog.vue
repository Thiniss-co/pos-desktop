<script setup lang="ts">
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import type { DisplayPaymentMethod } from './types'
import PaymentMethodTile from './PaymentMethodTile.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    methods: readonly DisplayPaymentMethod[]
    selectedMethodId: string | null
  }>(),
  {}
)

const emit = defineEmits<{ close: []; selectMethod: [string] }>()
</script>

<template>
  <AppDialog :open="open" @close="emit('close')">
    <template #title>{{ title }}</template>
    <div class="payment-dialog__methods">
      <PaymentMethodTile
        v-for="method in methods"
        :key="method.id"
        :method="method"
        :selected="selectedMethodId === method.id"
        @select="emit('selectMethod', method.id)"
      />
    </div>
    <slot />
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
  </AppDialog>
</template>

<style scoped>
.payment-dialog__methods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: var(--space-3);
  margin-block-end: var(--space-4);
}
</style>
