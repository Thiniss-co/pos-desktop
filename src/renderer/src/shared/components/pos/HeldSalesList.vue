<script setup lang="ts">
import AppButton from '@renderer/shared/components/common/AppButton.vue'
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
  <div class="held-sales">
    <p v-if="note" class="held-sales__note">{{ note }}</p>
    <AppEmptyState v-if="sales.length === 0" :title="emptyTitle" :description="emptyDescription" />
    <ul v-else class="held-sales__list">
      <li v-for="sale in sales" :key="sale.id" class="held-sales__item">
        <div class="held-sales__info">
          <span class="held-sales__title">{{ sale.title }}</span>
          <span class="held-sales__meta">{{ sale.meta }}</span>
        </div>
        <span class="held-sales__total numeric">{{ sale.total }}</span>
        <div class="held-sales__actions">
          <AppButton variant="ghost" @click="emit('discard', sale.id)">
            {{ discardLabel }}
          </AppButton>
          <AppButton variant="secondary" @click="emit('recall', sale.id)">
            {{ recallLabel }}
          </AppButton>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.held-sales {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.held-sales__note {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.held-sales__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.held-sales__item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-2) var(--space-3);
  padding-block: var(--space-3);
  border-block-end: 1px solid var(--color-divider-subtle);
}

.held-sales__info {
  display: flex;
  flex-direction: column;
}

.held-sales__title {
  font-weight: 600;
  color: var(--color-on-surface);
}

.held-sales__meta {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.held-sales__total {
  align-self: center;
  font-weight: 700;
}

.held-sales__actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
