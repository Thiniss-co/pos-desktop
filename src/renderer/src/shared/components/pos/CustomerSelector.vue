<script setup lang="ts">
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppListRow from '@renderer/shared/components/common/AppListRow.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import type { DisplayCustomer } from './types'

withDefaults(
  defineProps<{
    query: string
    searchLabel: string
    results: readonly DisplayCustomer[]
    selectedId: string | null
    emptyTitle: string
  }>(),
  {}
)

const emit = defineEmits<{ 'update:query': [string]; select: [string] }>()
</script>

<template>
  <div class="customer-selector">
    <AppInput
      :model-value="query"
      :label="searchLabel"
      @update:model-value="(value) => emit('update:query', value)"
    />
    <AppEmptyState v-if="results.length === 0" :title="emptyTitle" />
    <ul v-else class="customer-selector__list">
      <li v-for="customer in results" :key="customer.id">
        <AppListRow interactive @click="emit('select', customer.id)">
          <span class="customer-selector__name">{{ customer.name }}</span>
          <span v-if="customer.detail" class="customer-selector__detail">{{
            customer.detail
          }}</span>
          <span
            v-if="selectedId === customer.id"
            class="customer-selector__selected"
            aria-hidden="true"
            >✓</span
          >
        </AppListRow>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.customer-selector {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.customer-selector__list {
  list-style: none;
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.customer-selector__name {
  flex: 1;
  font-weight: 600;
}

.customer-selector__detail {
  font-size: var(--text-body-sm-size);
  color: var(--color-text-muted);
}

.customer-selector__selected {
  color: var(--color-success);
}
</style>
