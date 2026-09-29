<script setup lang="ts">
/**
 * V3 selling layout: the catalog panel (fluid) beside the cart column (340 / 380 / 420px at
 * < 1200 / ≥ 1200 / ≥ 1600). Below 900px the cart leaves the row and becomes a full-height sheet
 * (`sheetOpen`), with the `compact-bar` summary pinned to the bottom. RTL mirrors automatically
 * (the cart sits on the left) because the row follows the document direction.
 *
 * From `wide` up, a separator between the two panels lets the cashier resize the cart. The width
 * is a LAYOUT-ONLY preference held by the preferences cartLayout store (persisted in main, never in
 * browser storage); `null` keeps the per-breakpoint defaults above. The applied width is always
 * clamped to [320, min(640, 50% of the workspace)] — on every change and on every resize — so the
 * catalog keeps at least half of the row and the page never scrolls sideways. The stored
 * preference itself is not rewritten by a resize: a width chosen on a large monitor comes back
 * when the window is large again.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { storeToRefs } from 'pinia'
import { POS_CART_WIDTH_MIN } from '@shared/contracts/preferences.contract'
import { useCartLayoutStore } from '@renderer/modules/preferences/cartLayout.store'
import AppIcon from '../common/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    sheetOpen?: boolean
    catalogLabel?: string
    cartLabel?: string
    /** Accessible name of the resize separator. */
    resizeLabel?: string
    /** Accessible name (and tooltip) of the "reset width" button. */
    resetWidthLabel?: string
    /** Spoken value of the separator, given the cart width in px. */
    widthValueText?: (px: number) => string
  }>(),
  {
    sheetOpen: false,
    catalogLabel: undefined,
    cartLabel: undefined,
    resizeLabel: 'Resize cart',
    resetWidthLabel: 'Reset cart width',
    widthValueText: (px: number) => `${px} pixels`
  }
)

const MIN_WIDTH = POS_CART_WIDTH_MIN
const MAX_WIDTH_CAP = 640
const MAX_WORKSPACE_SHARE = 0.5
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

const cartLayout = useCartLayoutStore()
const { width: preferredWidth } = storeToRefs(cartLayout)

const cartId = useId()
const bodyEl = ref<HTMLElement | null>(null)
const cartEl = ref<HTMLElement | null>(null)
const handleEl = ref<HTMLElement | null>(null)
/** Content width of the catalog+cart row; 0 until measured (then the 640px cap applies alone). */
const workspaceWidth = ref(0)
const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)
const dragging = ref(false)
let drag: { pointerId: number; grabOffset: number } | null = null
let resizeObserver: ResizeObserver | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const maxWidth = computed(() => {
  const share =
    workspaceWidth.value > 0
      ? Math.floor(workspaceWidth.value * MAX_WORKSPACE_SHARE)
      : Number.POSITIVE_INFINITY
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH_CAP, share))
})

/** The design default for the current breakpoint — mirrors the `--cart-w` classes below. */
const defaultWidth = computed(() =>
  viewportWidth.value >= 1600 ? 420 : viewportWidth.value >= 1200 ? 380 : 340
)

/** The width actually applied when the cashier has chosen one; `null` = the design default. */
const appliedWidth = computed(() =>
  preferredWidth.value === null ? null : clamp(preferredWidth.value, MIN_WIDTH, maxWidth.value)
)

const currentWidth = computed(
  () => appliedWidth.value ?? clamp(defaultWidth.value, MIN_WIDTH, maxWidth.value)
)

const cartStyle = computed(() =>
  !props.sheetOpen && appliedWidth.value !== null
    ? { '--cart-w': `${appliedWidth.value}px` }
    : undefined
)

function measure(): void {
  if (typeof window !== 'undefined') {
    viewportWidth.value = window.innerWidth
  }

  const body = bodyEl.value

  if (!body) {
    return
  }

  const style = window.getComputedStyle(body)
  const padding =
    (Number.parseFloat(style.paddingInlineStart) || 0) +
    (Number.parseFloat(style.paddingInlineEnd) || 0)
  workspaceWidth.value = Math.max(0, body.getBoundingClientRect().width - padding)
}

function isRtl(): boolean {
  const scoped = handleEl.value?.closest('[dir]')?.getAttribute('dir')
  return (scoped ?? document.documentElement.dir) === 'rtl'
}

function applyWidth(px: number): void {
  cartLayout.setWidth(clamp(Math.round(px), MIN_WIDTH, maxWidth.value))
}

function resetWidth(): void {
  void cartLayout.reset()
}

function resetFromButton(): void {
  resetWidth()
  // The button disappears with the custom width; keep keyboard focus on the separator.
  handleEl.value?.focus()
}

/** Distance from the cart's inline-end edge (right in LTR, left in RTL) to the pointer. */
function inlineEndDistance(clientX: number): number | null {
  const rect = cartEl.value?.getBoundingClientRect()

  if (!rect) {
    return null
  }

  return isRtl() ? clientX - rect.left : rect.right - clientX
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary) {
    return
  }

  const distance = inlineEndDistance(event.clientX)
  const cartWidth = cartEl.value?.getBoundingClientRect().width

  if (distance === null || cartWidth === undefined) {
    return
  }

  // Grabbing the handle a few px outside the cart edge must not make the cart jump by that much.
  drag = { pointerId: event.pointerId, grabOffset: distance - cartWidth }
  dragging.value = true
  handleEl.value?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) {
    return
  }

  const distance = inlineEndDistance(event.clientX)

  if (distance !== null) {
    applyWidth(distance - drag.grabOffset)
  }
}

function endDrag(event?: PointerEvent): void {
  if (!drag || (event && event.pointerId !== drag.pointerId)) {
    return
  }

  const handle = handleEl.value

  if (handle?.hasPointerCapture?.(drag.pointerId)) {
    handle.releasePointerCapture(drag.pointerId)
  }

  drag = null
  dragging.value = false
  void cartLayout.flush()
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
      // The arrow moves the handle visually. In LTR the cart is on the right, so moving the handle
      // left widens it; in RTL the cart is on the left and the same key narrows it.
      const widens = (event.key === 'ArrowLeft') !== isRtl()
      applyWidth(currentWidth.value + (widens ? step : -step))
      break
    }
    case 'Home':
      applyWidth(MIN_WIDTH)
      break
    case 'End':
      applyWidth(maxWidth.value)
      break
    case 'Enter':
      resetWidth()
      break
    default:
      return
  }

  event.preventDefault()
}

onMounted(() => {
  measure()
  window.addEventListener('resize', measure)

  // The row also changes width without a window resize (e.g. the navigation rail collapsing).
  if (typeof ResizeObserver !== 'undefined' && bodyEl.value) {
    resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(bodyEl.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  resizeObserver?.disconnect()
  resizeObserver = null
  endDrag()
})
</script>

<template>
  <div
    class="pos-workspace-shell flex min-h-0 flex-1 flex-col"
    :class="{ 'pos-workspace-shell--resizing cursor-col-resize select-none': dragging }"
  >
    <div
      v-if="$slots.toolbar"
      class="pos-workspace-shell__toolbar flex flex-none flex-col gap-2 px-4 pt-4"
    >
      <slot name="toolbar" />
    </div>
    <div ref="bodyEl" class="pos-workspace-shell__body flex min-h-0 flex-1 gap-4 p-3 wide:p-4">
      <section
        class="pos-workspace-shell__catalog flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-line bg-surf p-3 shadow-panel wide:p-4"
        :aria-label="catalogLabel"
      >
        <slot name="catalog" />
      </section>
      <!-- Sits inside the 16px gap (negative margins cancel the extra gap it adds), so the panels
           keep exactly their previous spacing. Never rendered for the compact sheet. -->
      <div
        v-if="!sheetOpen"
        class="pos-workspace-shell__resizer group/resizer relative -ms-4 -me-4 hidden w-4 flex-none wide:flex"
      >
        <div
          ref="handleEl"
          class="pos-workspace-shell__resize-handle flex h-full w-4 cursor-col-resize touch-none items-center justify-center rounded-md"
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          :aria-label="resizeLabel"
          :aria-controls="cartId"
          :aria-valuenow="currentWidth"
          :aria-valuemin="MIN_WIDTH"
          :aria-valuemax="maxWidth"
          :aria-valuetext="widthValueText(currentWidth)"
          @mousedown.prevent
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="endDrag"
          @pointercancel="endDrag"
          @lostpointercapture="endDrag"
          @keydown="onKeydown"
          @dblclick="resetWidth"
        >
          <span
            class="pointer-events-none h-10 w-2 rounded-full transition-colors"
            :class="
              dragging
                ? 'bg-pri'
                : 'bg-line-strong group-hover/resizer:bg-pri group-focus-within/resizer:bg-pri'
            "
            aria-hidden="true"
          />
        </div>
        <div
          v-if="preferredWidth !== null"
          class="pointer-events-none absolute start-0 end-0 top-3 z-10 flex justify-center"
        >
          <button
            type="button"
            class="pos-workspace-shell__reset-width pointer-events-auto flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-full border border-control bg-surf text-muted opacity-0 shadow-panel transition-opacity hover:bg-subtle hover:text-ink focus-visible:opacity-100 group-focus-within/resizer:opacity-100 group-hover/resizer:opacity-100"
            :aria-label="resetWidthLabel"
            :title="resetWidthLabel"
            @click="resetFromButton"
          >
            <AppIcon name="restart_alt" :size="18" />
          </button>
        </div>
      </div>
      <aside
        :id="cartId"
        ref="cartEl"
        class="pos-workspace-shell__cart min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-surf"
        :class="
          sheetOpen
            ? 'fixed inset-0 z-40 flex'
            : [
                'hidden w-(--cart-w) flex-none rounded-lg border border-line shadow-panel wide:flex [--cart-w:340px] cartlg:[--cart-w:380px] hd:[--cart-w:420px]',
                // CSS backstop for the JS clamp, covering the frame between a resize and re-measure.
                appliedWidth === null ? '' : 'max-w-[min(640px,50%)]'
              ]
        "
        :style="cartStyle"
        :aria-label="cartLabel"
      >
        <slot name="cart" />
      </aside>
    </div>
    <div v-if="$slots['compact-bar'] && !sheetOpen" class="flex-none wide:hidden">
      <slot name="compact-bar" />
    </div>
  </div>
</template>
