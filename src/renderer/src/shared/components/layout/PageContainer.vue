<script setup lang="ts">
/** Standard V3 page body: 20px/16px padding and a centred column (1100px by default). */
withDefaults(defineProps<{ width?: 'md' | 'lg' | 'xl' }>(), { width: 'lg' })
</script>

<template>
  <div class="page-container flex-1 px-4 py-5">
    <div
      class="mx-auto flex w-full flex-col gap-4"
      :class="
        width === 'md' ? 'max-w-[1080px]' : width === 'xl' ? 'max-w-[1180px]' : 'max-w-[1100px]'
      "
    >
      <slot />
    </div>
  </div>
</template>
