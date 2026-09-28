<script setup lang="ts">
withDefaults(defineProps<{ interactive?: boolean; selected?: boolean }>(), {
  interactive: false,
  selected: false
})

const emit = defineEmits<{ click: [MouseEvent] }>()
</script>

<template>
  <component
    :is="interactive ? 'button' : 'div'"
    class="app-list-row flex min-h-14 w-full items-center gap-3 rounded-notice border px-3 py-2.5 text-start text-ink"
    :class="[
      selected ? 'border-pri bg-pri-soft' : 'border-line bg-surf',
      { 'app-list-row--interactive cursor-pointer hover:bg-subtle': interactive && !selected }
    ]"
    :type="interactive ? 'button' : undefined"
    @click="(event: MouseEvent) => interactive && emit('click', event)"
  >
    <slot />
  </component>
</template>
