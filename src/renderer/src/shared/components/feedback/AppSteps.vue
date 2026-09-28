<script setup lang="ts">
/** Numbered step indicator (startup activation → sign in → prepare; refund select → review → result). */
import AppIcon from '../common/AppIcon.vue'

withDefaults(
  defineProps<{
    steps: ReadonlyArray<{ label: string }>
    current: number
    label: string
    centered?: boolean
  }>(),
  { centered: false }
)
</script>

<template>
  <ol
    class="app-steps flex flex-wrap items-center gap-2"
    :class="{ 'justify-center': centered }"
    :aria-label="label"
  >
    <li
      v-for="(step, index) in steps"
      :key="step.label"
      class="flex items-center gap-2"
      :aria-current="index === current ? 'step' : undefined"
    >
      <span
        class="numeric flex size-7 items-center justify-center rounded-full border text-xs font-bold"
        :class="
          index < current
            ? 'border-ok bg-ok-bg text-ok'
            : index === current
              ? 'border-pri bg-pri text-on-pri'
              : 'border-line-strong bg-surf text-muted'
        "
      >
        <AppIcon v-if="index < current" name="check" :size="17" />
        <template v-else>{{ index + 1 }}</template>
      </span>
      <span
        class="text-sm whitespace-nowrap"
        :class="index === current ? 'font-bold text-ink' : 'font-medium text-muted'"
        >{{ step.label }}</span
      >
      <span v-if="index < steps.length - 1" aria-hidden="true" class="h-px w-6 bg-line-strong" />
    </li>
  </ol>
</template>
