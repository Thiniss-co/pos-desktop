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
    <div class="payment-dialog__methods grid grid-cols-3 gap-2">
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
