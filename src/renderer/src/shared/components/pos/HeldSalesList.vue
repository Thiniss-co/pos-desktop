<script setup lang="ts">
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import type { DisplayHeldSale } from './types'

withDefaults(
  defineProps<{
    sales: readonly DisplayHeldSale[]
    emptyTitle: string
    emptyDescription?: string
    recallLabel: string
    discardLabel: string
    note?: string
  }>(),
  { emptyDescription: undefined, note: undefined }
)

const emit = defineEmits<{ recall: [string]; discard: [string] }>()
</script>

<template>
  <div class="held-sales flex flex-col gap-3">
    <p v-if="note" class="held-sales__note flex items-start gap-2 text-sm text-muted">
      <AppIcon name="info" :size="18" class="mt-px" />{{ note }}
    </p>
    <AppEmptyState
      v-if="sales.length === 0"
      compact
      icon="pause_circle"
      :title="emptyTitle"
      :description="emptyDescription"
    />
    <ul v-else class="held-sales__list flex flex-col gap-2">
      <li
        v-for="sale in sales"
        :key="sale.id"
        class="held-sales__item flex flex-wrap items-center gap-3 rounded-notice border border-line px-3.5 py-3"
      >
        <span
          aria-hidden="true"
          class="flex size-9 flex-none items-center justify-center rounded-full bg-pri-soft text-pri-text"
          ><AppIcon name="pause_circle" :size="20"
        /></span>
        <div class="min-w-0 flex-1">
          <p class="held-sales__title font-semibold">{{ sale.title }}</p>
          <p class="held-sales__meta text-sm text-muted">{{ sale.meta }}</p>
        </div>
        <span class="held-sales__total numeric text-lg font-extrabold">{{ sale.total }}</span>
        <div class="flex w-full justify-end gap-2">
          <AppButton variant="ghost" size="sm" icon="delete" @click="emit('discard', sale.id)">
            {{ discardLabel }}
          </AppButton>
          <AppButton variant="secondary" size="sm" icon="history" @click="emit('recall', sale.id)">
            {{ recallLabel }}
          </AppButton>
        </div>
      </li>
    </ul>
  </div>
</template>
