<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
    lines?: number
  }>(),
  { label: 'Loading', lines: 3 }
)
</script>

<template>
  <div class="app-skeleton flex flex-col gap-2.5 py-2" role="status" :aria-label="label">
    <span
      v-for="line in lines"
      :key="line"
      class="app-skeleton__line block h-3.5 rounded-full bg-subtle motion-safe:animate-pulse"
      :class="{ 'border border-line': true }"
      :style="{ inlineSize: line === lines ? '60%' : '100%' }"
    />
    <span class="sr-only">{{ label }}</span>
  </div>
</template>
