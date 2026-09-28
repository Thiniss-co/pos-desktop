<script setup lang="ts">
/**
 * V3 page heading: 24px extra-bold title, muted description, actions at the inline end. Sentence
 * case only — the retired all-caps `eyebrow` is accepted for compatibility but never rendered.
 */
withDefaults(
  defineProps<{
    eyebrow?: string
    title: string
    description?: string
    headingLevel?: 'h1' | 'h2'
  }>(),
  { eyebrow: undefined, description: undefined, headingLevel: 'h1' }
)
</script>

<template>
  <header class="page-header flex flex-wrap items-start gap-4">
    <div class="page-header__heading min-w-[260px] flex-1">
      <div class="flex flex-wrap items-center gap-2.5">
        <component :is="headingLevel" class="page-header__title text-3xl font-extrabold">
          {{ title }}
        </component>
        <slot name="badge" />
      </div>
      <p
        v-if="description"
        class="page-header__description mt-1 max-w-[680px] text-pretty text-muted"
      >
        {{ description }}
      </p>
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="page-header__actions flex flex-wrap items-center gap-2.5">
      <slot name="actions" />
    </div>
  </header>
</template>
