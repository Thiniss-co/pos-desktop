<script setup lang="ts">
/**
 * Material Symbols Outlined glyph, rendered as inline SVG from `icons.generated.ts` so the
 * renderer never depends on an icon font or a CDN.
 *
 * Decorative by default (`aria-hidden`); pass `label` only when the icon is the sole carrier of
 * meaning. `mirrorRtl` flips the glyph in RTL — use it only for directional icons (arrows,
 * chevrons, first/last page, sign-out), never for symbols whose meaning is not a direction.
 */
import type { IconName } from './icons.generated'
import { ICON_PATHS } from './icons.generated'

withDefaults(
  defineProps<{
    name: IconName
    size?: number
    mirrorRtl?: boolean
    label?: string
  }>(),
  { size: 20, mirrorRtl: false, label: undefined }
)
</script>

<template>
  <svg
    class="app-icon shrink-0"
    :class="{ 'rtl:-scale-x-100': mirrorRtl }"
    viewBox="0 -960 960 960"
    :width="size"
    :height="size"
    fill="currentColor"
    focusable="false"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <path :d="ICON_PATHS[name]" />
  </svg>
</template>
