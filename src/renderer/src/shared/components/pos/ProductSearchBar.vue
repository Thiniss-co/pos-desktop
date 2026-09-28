<script setup lang="ts">
/**
 * V3 catalog search (50px, search glyph, clear button, F2 hint). Barcode scanning never needs this
 * field focused — the page's keyboard-wedge listener captures scans anywhere.
 */
import { ref } from 'vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppKbd from '@renderer/shared/components/common/AppKbd.vue'

withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder?: string
    disabled?: boolean
    clearLabel?: string
    shortcut?: string
  }>(),
  { placeholder: undefined, disabled: false, clearLabel: undefined, shortcut: 'F2' }
)

const emit = defineEmits<{ 'update:modelValue': [string]; submit: [] }>()
const inputRef = ref<HTMLInputElement | null>(null)

function clear(): void {
  emit('update:modelValue', '')
  inputRef.value?.focus()
}

defineExpose({ focus: () => inputRef.value?.focus() })
</script>

<template>
  <form
    class="product-search-bar relative flex-none"
    role="search"
    @submit.prevent="emit('submit')"
  >
    <label class="product-search-bar__label sr-only" for="product-search-bar-input">{{
      label
    }}</label>
    <AppIcon
      name="search"
      :size="22"
      class="product-search-bar__icon pointer-events-none absolute start-3.5 top-3.5 text-muted"
    />
    <input
      id="product-search-bar-input"
      ref="inputRef"
      class="product-search-bar__input h-12.5 w-full rounded-notice border border-control bg-subtle ps-11.5 pe-24 text-base text-ink disabled:cursor-not-allowed disabled:opacity-60 [&::-webkit-search-cancel-button]:hidden"
      type="search"
      autocomplete="off"
      spellcheck="false"
      :placeholder="placeholder"
      :disabled="disabled"
      :value="modelValue"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.esc="modelValue ? ($event.preventDefault(), clear()) : undefined"
    />
    <div class="absolute end-2.5 top-2.25 flex items-center gap-1.5">
      <button
        v-if="modelValue && clearLabel"
        type="button"
        class="flex size-8 items-center justify-center rounded-md text-muted hover:bg-surf"
        :aria-label="clearLabel"
        :title="clearLabel"
        @click="clear"
      >
        <AppIcon name="close" :size="20" />
      </button>
      <AppKbd aria-hidden="true">{{ shortcut }}</AppKbd>
    </div>
  </form>
</template>
