<script setup lang="ts">
/**
 * V3 user form card for the add / edit routes: the prototype's user dialog composition (title
 * bar, scrolling body, tinted footer with Cancel + one primary Save) rendered as a centred page
 * card. Pure layout -- the owning page keeps every store call and route push.
 */
import AppButton from '@renderer/shared/components/common/AppButton.vue'

withDefaults(
  defineProps<{
    title: string
    submitLabel: string
    cancelLabel: string
    busy?: boolean
    /** Render the footer actions (false while loading or when the user lacks permission). */
    showActions?: boolean
  }>(),
  { busy: false, showActions: true }
)

const emit = defineEmits<{ submit: []; cancel: [] }>()
</script>

<template>
  <form
    class="company-user-form-card mx-auto flex w-full max-w-[500px] flex-col overflow-hidden rounded-xl border border-line bg-surf shadow-panel"
    @submit.prevent="emit('submit')"
  >
    <div class="border-b border-line px-5 py-4.5">
      <h1 class="text-xl font-bold">{{ title }}</h1>
    </div>
    <div class="flex flex-col gap-4 p-5">
      <slot />
    </div>
    <div
      v-if="showActions"
      class="flex flex-wrap justify-end gap-2.5 border-t border-line bg-subtle px-5 py-3.5"
    >
      <AppButton variant="secondary" :disabled="busy" @click="emit('cancel')">
        {{ cancelLabel }}
      </AppButton>
      <AppButton type="submit" variant="primary" :loading="busy">{{ submitLabel }}</AppButton>
    </div>
  </form>
</template>
