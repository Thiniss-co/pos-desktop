<script setup lang="ts">
withDefaults(defineProps<{ interactive?: boolean }>(), { interactive: false })

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <component
    :is="interactive ? 'button' : 'div'"
    class="app-list-row"
    :class="{ 'app-list-row--interactive': interactive }"
    :type="interactive ? 'button' : undefined"
    @click="(event: MouseEvent) => interactive && emit('click', event)"
  >
    <slot />
  </component>
</template>

<style scoped>
.app-list-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--size-row);
  padding-inline: var(--space-4);
  border: none;
  border-block-end: 1px solid var(--color-divider-subtle);
  background: transparent;
  text-align: start;
  font: inherit;
  color: inherit;
}

.app-list-row--interactive {
  cursor: pointer;
}

.app-list-row--interactive:hover {
  background: var(--color-surface-container-low);
}
</style>
