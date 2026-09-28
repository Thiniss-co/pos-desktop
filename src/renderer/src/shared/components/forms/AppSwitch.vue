<script setup lang="ts">
/** V3 switch tile: `role="switch"` button with a 44×24 track, bold label and helper line. */
withDefaults(
  defineProps<{ modelValue: boolean; label: string; description?: string; disabled?: boolean }>(),
  { description: undefined, disabled: false }
)
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    class="app-switch flex items-start gap-3 rounded-notice border border-line bg-surf px-3.5 py-3 text-start text-ink disabled:cursor-not-allowed disabled:opacity-60"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      aria-hidden="true"
      class="relative mt-0.5 h-6 w-11 flex-none rounded-full transition-colors"
      :class="modelValue ? 'bg-pri' : 'bg-control'"
    >
      <span
        class="absolute top-0.5 start-0.5 size-5 rounded-full bg-on-pri transition-transform duration-150"
        :class="modelValue ? 'translate-x-5 rtl:-translate-x-5' : ''"
      />
    </span>
    <span class="flex flex-col">
      <span class="font-semibold">{{ label }}</span>
      <span v-if="description" class="text-sm text-muted">{{ description }}</span>
    </span>
  </button>
</template>
