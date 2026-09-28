<script setup lang="ts">
/** Determinate (value 0–100) or indeterminate progress bar. */
withDefaults(defineProps<{ value?: number | null; label: string; size?: 'sm' | 'md' }>(), {
  value: null,
  size: 'sm'
})
</script>

<template>
  <div
    class="app-progress overflow-hidden rounded-full border border-line bg-subtle"
    :class="size === 'md' ? 'h-2.5' : 'h-2'"
    role="progressbar"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="value ?? undefined"
  >
    <div
      class="h-full rounded-full bg-pri transition-[width] duration-500"
      :class="{ 'w-1/3 motion-safe:animate-pulse': value === null }"
      :style="value === null ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }"
    />
  </div>
</template>
