<script setup lang="ts">
/** V3 content panel: white (dark: surface) rounded 12px card with a 1px line and soft shadow. */
withDefaults(
  defineProps<{ padded?: boolean; as?: string; title?: string; description?: string }>(),
  { padded: true, as: 'section', title: undefined, description: undefined }
)
</script>

<template>
  <component
    :is="as"
    class="app-panel flex min-w-0 flex-col rounded-lg border border-line bg-surf shadow-panel"
    :class="{ 'app-panel--padded gap-3 p-4.5': padded }"
  >
    <div
      v-if="title || $slots.header"
      class="flex flex-wrap items-start gap-2.5"
      :class="padded ? '' : 'border-b border-line px-4 py-3.5'"
    >
      <div v-if="title" class="min-w-[200px] flex-1">
        <h2 class="text-lg font-bold">{{ title }}</h2>
        <p v-if="description" class="mt-1 text-sm text-muted">{{ description }}</p>
      </div>
      <slot name="header" />
    </div>
    <slot />
  </component>
</template>
