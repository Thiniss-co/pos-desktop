<script setup lang="ts">
/**
 * V3 customer picker body: search, match count, then a listbox of customers (monogram, name,
 * phone kept LTR) with the current selection marked. The dialog chrome is the page's.
 */
import { useId } from 'vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import type { DisplayCustomer } from './types'

withDefaults(
  defineProps<{
    query: string
    searchLabel: string
    results: readonly DisplayCustomer[]
    selectedId: string | null
    emptyTitle: string
    emptyDescription?: string
    countLabel?: string
    selectedLabel?: string
  }>(),
  { emptyDescription: undefined, countLabel: undefined, selectedLabel: undefined }
)

const emit = defineEmits<{ 'update:query': [string]; select: [string] }>()
const countId = useId()

function monogram(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
</script>

<template>
  <div class="customer-selector flex min-h-0 flex-col gap-2.5">
    <AppInput
      :model-value="query"
      :label="searchLabel"
      hide-label
      :placeholder="searchLabel"
      type="search"
      autofocus
      @update:model-value="(value) => emit('update:query', value)"
    />
    <span v-if="countLabel" :id="countId" class="text-xs font-semibold text-muted">{{
      countLabel
    }}</span>
    <AppEmptyState
      v-if="results.length === 0"
      compact
      :title="emptyTitle"
      :description="emptyDescription"
    />
    <ul
      v-else
      class="customer-selector__list flex flex-col gap-1.5"
      role="listbox"
      :aria-labelledby="countLabel ? countId : undefined"
      :aria-label="countLabel ? undefined : searchLabel"
    >
      <li v-for="customer in results" :key="customer.id" role="none">
        <button
          type="button"
          role="option"
          :aria-selected="selectedId === customer.id"
          class="flex min-h-14 w-full items-center gap-3 rounded-notice border px-3 py-2.5 text-start text-ink"
          :class="
            selectedId === customer.id
              ? 'border-pri bg-pri-soft'
              : 'border-line bg-surf hover:bg-subtle'
          "
          @click="emit('select', customer.id)"
        >
          <span
            aria-hidden="true"
            class="flex size-9 flex-none items-center justify-center rounded-full bg-cat-0 text-xs font-bold text-cat-ink-0"
            >{{ monogram(customer.name) }}</span
          >
          <span class="min-w-0 flex-1">
            <span class="customer-selector__name block font-semibold">{{ customer.name }}</span>
            <span
              v-if="customer.detail"
              class="customer-selector__detail numeric block text-start text-xs text-muted [unicode-bidi:plaintext]"
              dir="ltr"
              >{{ customer.detail }}</span
            >
          </span>
          <span
            v-if="selectedId === customer.id"
            class="customer-selector__selected flex items-center gap-1 text-xs font-bold text-pri-text"
          >
            <AppIcon name="check" :size="18" />{{ selectedLabel }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
