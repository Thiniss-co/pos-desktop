<script setup lang="ts">
/**
 * The till's direct add-to-cart field (V3 cart column). Deliberately NOT a search box: it never
 * filters the catalog grid — Enter resolves exactly one code and adds it to the draft. A
 * keyboard-wedge scanner typing into it is handled here (the page-level scanner listener ignores
 * focused inputs); a scan made while it is not focused still lands via the page listener, and its
 * outcome is shown in the same result strip.
 */
import { ref } from 'vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppKbd from '@renderer/shared/components/common/AppKbd.vue'
import type { DisplayScanResult } from './types'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label: string
    placeholder: string
    hint: string
    multiplierLabel: string
    multipliers?: readonly number[]
    pendingMultiplier: number | null
    clearMultiplierLabel: string
    result: DisplayScanResult | null
    disabled?: boolean
    shortcut?: string
    /**
     * POS workspace: one row — field, multipliers and the key hint — over a single reserved status
     * line (the last result or the hint), sized by the workspace density.
     */
    compact?: boolean
  }>(),
  { multipliers: () => [2, 3, 5, 10], disabled: false, shortcut: 'F3', compact: false }
)

const emit = defineEmits<{
  'update:modelValue': [string]
  submit: [string]
  setMultiplier: [number | null]
}>()

const inputRef = ref<HTMLInputElement | null>(null)

const RESULT_TONE = {
  success: { box: 'bg-ok-bg', icon: 'check_circle', ink: 'text-ok' },
  warning: { box: 'bg-warn-bg', icon: 'warning', ink: 'text-warn' },
  error: { box: 'bg-err-bg', icon: 'error', ink: 'text-err' }
} as const

function submit(): void {
  if (props.disabled) {
    return
  }

  emit('submit', props.modelValue)
}

defineExpose({ focus: () => inputRef.value?.focus() })
</script>

<template>
  <section v-if="compact" class="scan-entry scan-entry--compact flex flex-none flex-col gap-1">
    <form
      class="scan-entry__form flex flex-wrap items-center gap-x-2 gap-y-1.5"
      @submit.prevent="submit"
    >
      <label class="scan-entry__label sr-only" for="scan-entry-input">{{ label }}</label>
      <div
        class="scan-entry__field flex h-[calc(var(--cart-tool-h)+8px)] min-w-[12rem] flex-1 items-center gap-2 rounded-notice border-2 bg-surf ps-2.5 pe-2 focus-within:ring-2 focus-within:ring-focus"
        :class="disabled ? 'border-line opacity-60' : 'border-pri'"
      >
        <AppIcon name="barcode_scanner" :size="20" class="flex-none text-pri-text" />
        <span
          v-if="pendingMultiplier !== null"
          class="scan-entry__pending numeric flex h-7 min-w-8 flex-none items-center justify-center rounded-md bg-pri px-1.5 text-sm font-extrabold text-on-pri"
          data-testid="scan-entry-pending"
          >×{{ pendingMultiplier }}</span
        >
        <input
          id="scan-entry-input"
          ref="inputRef"
          dir="ltr"
          class="scan-entry__input code h-full min-w-0 flex-1 bg-transparent text-md font-semibold tracking-wide text-ink outline-none placeholder:font-normal placeholder:tracking-normal placeholder:text-muted disabled:cursor-not-allowed"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholder"
          :disabled="disabled"
          :value="modelValue"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @keydown.esc="
            modelValue ? ($event.preventDefault(), emit('update:modelValue', '')) : undefined
          "
        />
        <AppKbd aria-hidden="true">{{ shortcut }}</AppKbd>
      </div>
      <div
        class="scan-entry__multipliers flex flex-none items-center gap-1"
        role="group"
        :aria-label="multiplierLabel"
      >
        <button
          v-for="value in multipliers"
          :key="value"
          type="button"
          class="scan-entry__multiplier numeric h-(--cart-tool-h) min-w-(--cart-tool-h) rounded-md border px-1.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            pendingMultiplier === value
              ? 'scan-entry__multiplier--active border-pri bg-pri text-on-pri'
              : 'border-control bg-surf text-ink hover:bg-subtle'
          "
          :aria-pressed="pendingMultiplier === value ? 'true' : 'false'"
          :aria-label="`${multiplierLabel} ×${value}`"
          :disabled="disabled"
          @click="emit('setMultiplier', pendingMultiplier === value ? null : value)"
        >
          ×{{ value }}
        </button>
        <button
          v-if="pendingMultiplier !== null"
          type="button"
          class="scan-entry__multiplier scan-entry__multiplier--clear h-(--cart-tool-h) px-1.5 text-xs font-semibold text-pri-text hover:underline disabled:opacity-50"
          :disabled="disabled"
          @click="emit('setMultiplier', null)"
        >
          {{ clearMultiplierLabel }}
        </button>
      </div>
    </form>
    <div
      v-if="result"
      :key="result.sequence"
      class="scan-entry__result flex min-h-5 min-w-0 items-center gap-1.5 text-xs"
      :class="`scan-entry__result--${result.tone}`"
      role="status"
      aria-live="polite"
    >
      <AppIcon
        :name="RESULT_TONE[result.tone].icon"
        :size="16"
        class="flex-none"
        :class="RESULT_TONE[result.tone].ink"
      />
      <span class="min-w-0 truncate">
        <span class="font-semibold"
          ><span class="code me-1" dir="ltr">{{ result.code }}</span
          >{{ result.message }}</span
        ><span v-if="result.detail" class="numeric text-muted"> · {{ result.detail }}</span>
      </span>
    </div>
    <p v-else class="scan-entry__hint min-h-5 truncate text-xs text-muted">{{ hint }}</p>
  </section>
  <section v-else class="scan-entry mx-4 flex flex-none flex-col gap-2">
    <form class="scan-entry__form relative" @submit.prevent="submit">
      <label
        class="scan-entry__label mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted"
        for="scan-entry-input"
      >
        <AppIcon name="barcode_scanner" :size="18" class="text-pri-text" />{{ label }}
      </label>
      <div
        class="scan-entry__field flex h-14 items-center gap-2 rounded-notice border-2 bg-surf ps-3 pe-2.5 focus-within:ring-2 focus-within:ring-focus"
        :class="disabled ? 'border-line opacity-60' : 'border-pri'"
      >
        <span
          v-if="pendingMultiplier !== null"
          class="scan-entry__pending numeric flex h-8 min-w-9 flex-none items-center justify-center rounded-md bg-pri px-2 text-sm font-extrabold text-on-pri"
          data-testid="scan-entry-pending"
          >×{{ pendingMultiplier }}</span
        >
        <input
          id="scan-entry-input"
          ref="inputRef"
          dir="ltr"
          class="scan-entry__input code h-full min-w-0 flex-1 bg-transparent text-lg font-semibold tracking-wide text-ink outline-none placeholder:font-normal placeholder:tracking-normal placeholder:text-muted disabled:cursor-not-allowed"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholder"
          :disabled="disabled"
          :value="modelValue"
          @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @keydown.esc="
            modelValue ? ($event.preventDefault(), emit('update:modelValue', '')) : undefined
          "
        />
        <AppKbd aria-hidden="true">{{ shortcut }}</AppKbd>
      </div>
    </form>

    <div
      class="scan-entry__multipliers flex flex-wrap items-center gap-1.5"
      role="group"
      :aria-label="multiplierLabel"
    >
      <span class="me-0.5 text-xs text-muted">{{ multiplierLabel }}</span>
      <button
        v-for="value in multipliers"
        :key="value"
        type="button"
        class="scan-entry__multiplier numeric h-8 min-w-11 rounded-md border px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
        :class="
          pendingMultiplier === value
            ? 'scan-entry__multiplier--active border-pri bg-pri text-on-pri'
            : 'border-control bg-surf text-ink hover:bg-subtle'
        "
        :aria-pressed="pendingMultiplier === value ? 'true' : 'false'"
        :disabled="disabled"
        @click="emit('setMultiplier', pendingMultiplier === value ? null : value)"
      >
        ×{{ value }}
      </button>
      <button
        v-if="pendingMultiplier !== null"
        type="button"
        class="scan-entry__multiplier scan-entry__multiplier--clear h-8 px-2 text-xs font-semibold text-pri-text hover:underline disabled:opacity-50"
        :disabled="disabled"
        @click="emit('setMultiplier', null)"
      >
        {{ clearMultiplierLabel }}
      </button>
    </div>

    <div
      v-if="result"
      :key="result.sequence"
      class="scan-entry__result flex items-start gap-2.5 rounded-notice px-3 py-2.5 text-sm motion-safe:animate-[scan-entry-flash_0.4s_ease-out]"
      :class="[`scan-entry__result--${result.tone}`, RESULT_TONE[result.tone].box]"
      role="status"
      aria-live="polite"
    >
      <AppIcon
        :name="RESULT_TONE[result.tone].icon"
        :size="20"
        class="mt-px"
        :class="RESULT_TONE[result.tone].ink"
      />
      <div class="min-w-0 flex-1">
        <p class="font-semibold">
          <span class="code me-1.5" dir="ltr">{{ result.code }}</span
          >{{ result.message }}
        </p>
        <p v-if="result.detail" class="numeric truncate text-muted">{{ result.detail }}</p>
      </div>
    </div>
    <p v-else class="scan-entry__hint text-xs text-muted">{{ hint }}</p>
  </section>
</template>

<style>
@keyframes scan-entry-flash {
  from {
    opacity: 0.35;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
