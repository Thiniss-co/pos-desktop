<script setup lang="ts">
/**
 * POS workspace: the catalog and the cart as two constrained regions, laid out from the cashier's
 * (saved or draft) layout and what the window can show (`resolveEffectiveLayout`). Presentational:
 * the page owns the layout store; this component only measures, renders and emits.
 *
 * - Regions and sections render in DOM order = visual order (keyed, so moving them keeps component
 *   state); the cart side is logical and mirrors in RTL.
 * - The cart is a flex column whose lines section is the only part that scrolls; the totals section
 *   is always last and pinned.
 * - Products collapse to a 56px rail when collapsed or when the window is too narrow; the rail opens
 *   a browser beside a minimum-width cart (or above it when even that cannot fit) — never over it.
 * - Resize and rearrange handles exist ONLY while `editing`. In normal selling there is no separator,
 *   no drag handle and nothing to drag by accident. Every pointer action has a keyboard equivalent:
 *   the separator takes arrows/Home/End, and each section has Move up / Move down buttons.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  POS_CART_SHARE_MAX,
  POS_CART_SHARE_MIN,
  type PosCartSectionId,
  type PosCatalogSectionId,
  type PosWorkspaceLayout
} from '@shared/contracts/posWorkspace.contract'
import {
  resolveEffectiveLayout,
  type EffectiveWorkspaceLayout
} from '@renderer/modules/preferences/workspaceLayout'
import AppIcon from '../common/AppIcon.vue'

type Column = 'cart' | 'catalog'

const props = withDefaults(
  defineProps<{
    layout: PosWorkspaceLayout
    touchMode?: boolean
    editing?: boolean
    railOpen?: boolean
    catalogLabel?: string
    cartLabel?: string
    resizeLabel?: string
    widthValueText?: (percent: number) => string
    railLabel?: string
    closeBrowserLabel?: string
    sectionLabels?: Partial<Record<PosCartSectionId | PosCatalogSectionId, string>>
    moveUpLabel?: (section: string) => string
    moveDownLabel?: (section: string) => string
    dragLabel?: (section: string) => string
    swapSideLabel?: string
    /** Which sections can move up/down (the page validates against the supported orders). */
    canMove?: (column: Column, id: string, direction: -1 | 1) => boolean
  }>(),
  {
    touchMode: false,
    editing: false,
    railOpen: false,
    catalogLabel: undefined,
    cartLabel: undefined,
    resizeLabel: 'Resize cart',
    widthValueText: (percent: number) => `${percent}%`,
    railLabel: 'Products',
    closeBrowserLabel: 'Close products',
    sectionLabels: () => ({}),
    moveUpLabel: (section: string) => `Move ${section} up`,
    moveDownLabel: (section: string) => `Move ${section} down`,
    dragLabel: (section: string) => `Drag ${section}`,
    swapSideLabel: 'Move the cart to the other side',
    canMove: () => true
  }
)

const emit = defineEmits<{
  'update:railOpen': [boolean]
  /** Requested cart share in percent (already bounded to the contract range). */
  resize: [number]
  move: [{ column: Column; id: string; direction: -1 | 1 }]
  reorder: [{ column: Column; order: string[] }]
  swapSide: []
  effective: [EffectiveWorkspaceLayout]
}>()

const cartId = useId()
const browserId = useId()
const bodyEl = ref<HTMLElement | null>(null)
const bodyWidth = ref(0)
const bodyHeight = ref(0)
const viewportWidth = ref(typeof window === 'undefined' ? 1366 : window.innerWidth)
let observer: ResizeObserver | null = null
let dirObserver: MutationObserver | null = null

const viewportHeight = ref(typeof window === 'undefined' ? 768 : window.innerHeight)

// Until the body has been measured (first paint), estimate it from the window (minus the 12px body
// padding and the 60px top bar), so the first frame already has the right regions.
const effective = computed(() =>
  resolveEffectiveLayout(props.layout, {
    width: bodyWidth.value > 0 ? bodyWidth.value : Math.max(0, viewportWidth.value - 24),
    height: bodyHeight.value > 0 ? bodyHeight.value : Math.max(0, viewportHeight.value - 84),
    viewportWidth: viewportWidth.value,
    touchMode: props.touchMode
  })
)

watch(effective, (value) => emit('effective', value), { immediate: true })

const rtl = ref(false)
/** Whether the cart is on the visual right (logical `end` in LTR, `start` in RTL). */
const cartOnRight = computed(() => (effective.value.cartSide === 'end') !== rtl.value)
const regionOrder = computed<Column[]>(() =>
  effective.value.cartSide === 'end' ? ['catalog', 'cart'] : ['cart', 'catalog']
)
const railMode = computed(() => effective.value.catalogMode === 'rail')
const browserBeside = computed(
  () => railMode.value && props.railOpen && effective.value.railBrowserMode === 'beside'
)
const browserStacked = computed(
  () => railMode.value && props.railOpen && effective.value.railBrowserMode === 'stacked'
)
const catalogSections = computed(() =>
  effective.value.sections.catalog.filter((id) => id !== 'products')
)

function measure(): void {
  if (typeof window !== 'undefined') {
    viewportWidth.value = window.innerWidth
    viewportHeight.value = window.innerHeight
  }
  const body = bodyEl.value
  if (!body) {
    return
  }
  const style = window.getComputedStyle(body)
  rtl.value = style.direction === 'rtl'
  const paddingX =
    (Number.parseFloat(style.paddingInlineStart) || 0) +
    (Number.parseFloat(style.paddingInlineEnd) || 0)
  const paddingY =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const rect = body.getBoundingClientRect()
  bodyWidth.value = Math.max(0, rect.width - paddingX)
  bodyHeight.value = Math.max(0, rect.height - paddingY)
}

onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
  if (typeof ResizeObserver !== 'undefined' && bodyEl.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(bodyEl.value)
  }
  // The language (and so the direction) can flip without any resize.
  if (typeof MutationObserver !== 'undefined') {
    dirObserver = new MutationObserver(() => measure())
    dirObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  observer?.disconnect()
  observer = null
  dirObserver?.disconnect()
  dirObserver = null
  endResize()
  endSectionDrag()
})

// --- Resize (editing only) ------------------------------------------------------------------------
const resizing = ref(false)
let resizePointer: number | null = null
const KEY_STEP = 2
const KEY_STEP_LARGE = 5

function clampShare(value: number): number {
  return Math.min(POS_CART_SHARE_MAX, Math.max(POS_CART_SHARE_MIN, Math.round(value)))
}

function requestShare(percent: number): void {
  emit('resize', clampShare(percent))
}

function onResizeDown(event: PointerEvent): void {
  if (!props.editing || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
    return
  }
  resizePointer = event.pointerId
  resizing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onResizeMove(event: PointerEvent): void {
  if (!resizing.value || event.pointerId !== resizePointer || !bodyEl.value) {
    return
  }
  const rect = bodyEl.value.getBoundingClientRect()
  const style = window.getComputedStyle(bodyEl.value)
  const padStart = Number.parseFloat(style.paddingLeft) || 0
  const padEnd = Number.parseFloat(style.paddingRight) || 0
  const cartPx = cartOnRight.value
    ? rect.right - padEnd - event.clientX
    : event.clientX - rect.left - padStart
  if (bodyWidth.value > 0) {
    requestShare((cartPx / bodyWidth.value) * 100)
  }
}

function endResize(event?: PointerEvent): void {
  if (!resizing.value || (event && event.pointerId !== resizePointer)) {
    return
  }
  const target = event?.currentTarget as HTMLElement | undefined
  if (resizePointer !== null && target?.hasPointerCapture?.(resizePointer)) {
    target.releasePointerCapture(resizePointer)
  }
  resizePointer = null
  resizing.value = false
}

function onResizeKey(event: KeyboardEvent): void {
  const current = effective.value.appliedCartShare
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      // The arrow moves the handle visually: towards the cart narrows it, away from it widens it.
      const towardsLeft = event.key === 'ArrowLeft'
      const widens = towardsLeft === cartOnRight.value
      requestShare(current + (widens ? step : -step))
      break
    }
    case 'Home':
      requestShare(effective.value.minCartShare)
      break
    case 'End':
      requestShare(effective.value.maxCartShare)
      break
    default:
      return
  }
  event.preventDefault()
}

// --- Section drag (editing only) ------------------------------------------------------------------
const dragging = ref<{ column: Column; id: string; pointerId: number } | null>(null)
const dropIndex = ref<number | null>(null)

function sectionElements(column: Column): HTMLElement[] {
  return Array.from(
    bodyEl.value?.querySelectorAll<HTMLElement>(`[data-section-column="${column}"]`) ?? []
  )
}

function onSectionDragDown(event: PointerEvent, column: Column, id: string): void {
  if (!props.editing || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
    return
  }
  dragging.value = { column, id, pointerId: event.pointerId }
  dropIndex.value = null
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onSectionDragMove(event: PointerEvent): void {
  const drag = dragging.value
  if (!drag || event.pointerId !== drag.pointerId) {
    return
  }
  const elements = sectionElements(drag.column)
  let index = elements.length - 1
  for (let i = 0; i < elements.length; i += 1) {
    const rect = elements[i].getBoundingClientRect()
    if (event.clientY < rect.top + rect.height / 2) {
      index = i
      break
    }
  }
  dropIndex.value = index
}

function endSectionDrag(event?: PointerEvent): void {
  const drag = dragging.value
  if (!drag || (event && event.pointerId !== drag.pointerId)) {
    return
  }
  const target = event?.currentTarget as HTMLElement | undefined
  if (target?.hasPointerCapture?.(drag.pointerId)) {
    target.releasePointerCapture(drag.pointerId)
  }
  const elements = sectionElements(drag.column)
  const order = elements.map((element) => element.dataset.section ?? '')
  const from = order.indexOf(drag.id)
  if (event && event.type === 'pointerup' && dropIndex.value !== null && from >= 0) {
    const next = order.filter((value) => value !== drag.id)
    // `dropIndex` counts the dragged section itself; once it is removed, later slots shift by one.
    const insertAt = dropIndex.value > from ? dropIndex.value - 1 : dropIndex.value
    next.splice(Math.min(insertAt, next.length), 0, drag.id)
    if (next.join() !== order.join()) {
      emit('reorder', { column: drag.column, order: next })
    }
  }
  dragging.value = null
  dropIndex.value = null
}

// --- Swap sides by dragging the catalog handle (editing only) ------------------------------------
let swapDrag: { pointerId: number; startX: number } | null = null

function onSwapDown(event: PointerEvent): void {
  if (!props.editing || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
    return
  }
  swapDrag = { pointerId: event.pointerId, startX: event.clientX }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onSwapUp(event: PointerEvent): void {
  if (!swapDrag || event.pointerId !== swapDrag.pointerId) {
    return
  }
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  const travelled = Math.abs(event.clientX - swapDrag.startX)
  swapDrag = null
  // Dragging the catalog across at least a third of the workspace moves it to the other side.
  if (travelled > bodyWidth.value / 3) {
    emit('swapSide')
  }
}

function label(id: string): string {
  return props.sectionLabels[id as PosCartSectionId] ?? id
}

function openRail(): void {
  emit('update:railOpen', !props.railOpen)
}
</script>

<template>
  <div
    class="pos-workspace-shell flex min-h-0 flex-1 flex-col"
    :class="{
      'pos-workspace-shell--editing': editing,
      'pos-workspace-shell--resizing cursor-col-resize select-none': resizing,
      'select-none': dragging !== null
    }"
    :data-density="effective.density"
    :data-preset="effective.preset"
    :data-cart-side="effective.cartSide"
    :data-catalog-mode="effective.catalogMode"
    :data-short="effective.short ? 'true' : undefined"
  >
    <div v-if="$slots['edit-bar'] && editing" class="pos-workspace-shell__edit-bar flex-none">
      <slot name="edit-bar" :effective="effective" />
    </div>
    <div
      ref="bodyEl"
      class="pos-workspace-shell__body flex min-h-0 flex-1 gap-3 overflow-hidden p-3"
      :class="{ 'pt-2': editing }"
    >
      <template v-for="region in regionOrder" :key="region">
        <!-- Catalog: a panel, or the rail with its browser. -->
        <template v-if="region === 'catalog'">
          <section
            v-if="!railMode"
            class="pos-workspace-shell__catalog flex min-w-0 flex-none flex-col gap-2.5 overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-surf p-2.5 shadow-panel"
            :style="{ width: `${effective.catalogWidth}px` }"
            :aria-label="catalogLabel"
          >
            <div
              v-if="editing"
              class="pos-workspace-shell__swap flex flex-none items-center gap-2 rounded-md bg-pri-soft px-2 py-1 text-sm font-semibold text-pri-text"
            >
              <span
                class="pos-workspace-shell__swap-handle flex size-9 cursor-grab touch-none items-center justify-center rounded-md hover:bg-surf"
                role="img"
                :aria-label="dragLabel(catalogLabel ?? 'catalog')"
                @pointerdown="onSwapDown"
                @pointerup="onSwapUp"
                @pointercancel="onSwapUp"
                ><AppIcon name="drag_indicator" :size="20"
              /></span>
              <span class="min-w-0 flex-1 truncate">{{ catalogLabel }}</span>
              <button
                type="button"
                class="pos-workspace-shell__swap-button flex size-9 items-center justify-center rounded-md hover:bg-surf focus-visible:ring-2 focus-visible:ring-focus"
                :aria-label="swapSideLabel"
                :title="swapSideLabel"
                @click="emit('swapSide')"
              >
                <AppIcon name="swap_horiz" :size="20" />
              </button>
            </div>
            <template v-for="(id, index) in catalogSections" :key="id">
              <div
                class="pos-workspace-section flex flex-none flex-col"
                :class="{ 'pos-workspace-section--editing p-1': editing }"
                :data-section="id"
                data-section-column="catalog"
              >
                <div
                  v-if="editing"
                  class="pos-workspace-section__handle mb-1 flex items-center gap-1.5 text-xs font-semibold text-pri-text"
                >
                  <span
                    class="flex size-9 cursor-grab touch-none items-center justify-center rounded-md hover:bg-pri-soft"
                    role="img"
                    :aria-label="dragLabel(label(id))"
                    @pointerdown="onSectionDragDown($event, 'catalog', id)"
                    @pointermove="onSectionDragMove"
                    @pointerup="endSectionDrag"
                    @pointercancel="endSectionDrag"
                    ><AppIcon name="drag_indicator" :size="18"
                  /></span>
                  <span class="min-w-0 flex-1 truncate">{{ label(id) }}</span>
                  <button
                    type="button"
                    class="flex size-9 items-center justify-center rounded-md hover:bg-pri-soft disabled:opacity-40"
                    :aria-label="moveUpLabel(label(id))"
                    :disabled="index === 0 || !canMove('catalog', id, -1)"
                    @click="emit('move', { column: 'catalog', id, direction: -1 })"
                  >
                    <AppIcon name="arrow_upward" :size="18" />
                  </button>
                  <button
                    type="button"
                    class="flex size-9 items-center justify-center rounded-md hover:bg-pri-soft disabled:opacity-40"
                    :aria-label="moveDownLabel(label(id))"
                    :disabled="!canMove('catalog', id, 1)"
                    @click="emit('move', { column: 'catalog', id, direction: 1 })"
                  >
                    <AppIcon name="arrow_downward" :size="18" />
                  </button>
                </div>
                <div class="pos-workspace-section__content" :inert="editing || undefined">
                  <slot :name="`catalog-${id}`" :effective="effective" />
                </div>
              </div>
              <div
                v-if="dragging?.column === 'catalog' && dropIndex === index + 1"
                class="h-0.5 rounded bg-pri"
                aria-hidden="true"
              />
            </template>
            <div
              class="pos-workspace-section__content flex flex-none flex-col gap-2"
              :inert="editing || undefined"
            >
              <slot name="catalog-notices" :effective="effective" />
            </div>
            <div
              class="pos-workspace-section__content flex min-h-0 flex-1 flex-col"
              :inert="editing || undefined"
            >
              <slot name="catalog-products" :effective="effective" />
            </div>
          </section>
          <template v-else>
            <nav
              class="pos-workspace-shell__rail flex w-16 flex-none flex-col items-center gap-2 rounded-lg border border-line bg-surf py-2 shadow-panel"
              :aria-label="catalogLabel"
            >
              <button
                type="button"
                class="pos-workspace-shell__rail-toggle flex w-14 flex-col items-center gap-1 rounded-md px-0.5 py-2 text-[0.6875rem] font-semibold text-ink hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus"
                :class="railOpen ? 'bg-pri-soft text-pri-text' : ''"
                :aria-expanded="railOpen ? 'true' : 'false'"
                :aria-controls="browserId"
                :inert="editing || undefined"
                @click="openRail"
              >
                <AppIcon name="grid_view" :size="22" class="text-pri-text" />
                <span class="leading-tight break-words hyphens-auto">{{ railLabel }}</span>
              </button>
            </nav>
            <section
              v-if="browserBeside"
              :id="browserId"
              class="pos-workspace-shell__catalog pos-workspace-shell__browser flex min-w-0 flex-none flex-col gap-2.5 overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-surf p-2.5 shadow-panel"
              :style="{ width: `${effective.railBrowserWidth}px` }"
              :aria-label="catalogLabel"
            >
              <div class="flex flex-none items-center justify-between gap-2">
                <span class="text-sm font-semibold">{{ catalogLabel }}</span>
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
                  :aria-label="closeBrowserLabel"
                  :title="closeBrowserLabel"
                  @click="emit('update:railOpen', false)"
                >
                  <AppIcon name="close" :size="20" />
                </button>
              </div>
              <template v-for="id in catalogSections" :key="id">
                <div class="flex flex-none flex-col" :inert="editing || undefined">
                  <slot :name="`catalog-${id}`" :effective="effective" />
                </div>
              </template>
              <div class="flex flex-none flex-col gap-2" :inert="editing || undefined">
                <slot name="catalog-notices" :effective="effective" />
              </div>
              <div class="flex min-h-0 flex-1 flex-col" :inert="editing || undefined">
                <slot name="catalog-products" :effective="effective" />
              </div>
            </section>
          </template>
        </template>

        <!-- Cart. The separator (editing only) sits between the two regions. -->
        <template v-else>
          <div
            v-if="editing && !railMode && regionOrder[0] === 'catalog'"
            class="pos-workspace-shell__resizer -mx-2 flex w-4 flex-none touch-none items-center justify-center rounded-md hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus"
            :class="resizing ? 'cursor-col-resize bg-pri-soft' : 'cursor-col-resize'"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            :aria-label="resizeLabel"
            :aria-controls="cartId"
            :aria-valuenow="effective.appliedCartShare"
            :aria-valuemin="effective.minCartShare"
            :aria-valuemax="effective.maxCartShare"
            :aria-valuetext="widthValueText(effective.appliedCartShare)"
            @pointerdown="onResizeDown"
            @pointermove="onResizeMove"
            @pointerup="endResize"
            @pointercancel="endResize"
            @lostpointercapture="endResize"
            @keydown="onResizeKey"
          >
            <span class="pointer-events-none h-16 w-1.5 rounded-full bg-pri" aria-hidden="true" />
          </div>
          <aside
            :id="cartId"
            class="pos-workspace-shell__cart pos-cart flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-line bg-surf shadow-panel"
            :class="editing ? 'overflow-y-auto' : 'overflow-hidden'"
            :aria-label="cartLabel"
          >
            <div
              v-if="browserStacked"
              :id="browserId"
              class="pos-workspace-shell__catalog pos-workspace-shell__browser flex h-[55%] min-h-0 flex-none flex-col gap-2 overflow-hidden border-b border-line p-2.5"
              :aria-label="catalogLabel"
            >
              <div class="flex flex-none items-center justify-between gap-2">
                <span class="text-sm font-semibold">{{ catalogLabel }}</span>
                <button
                  type="button"
                  class="flex size-9 items-center justify-center rounded-md text-muted hover:bg-subtle"
                  :aria-label="closeBrowserLabel"
                  @click="emit('update:railOpen', false)"
                >
                  <AppIcon name="close" :size="20" />
                </button>
              </div>
              <template v-for="id in catalogSections" :key="id">
                <slot :name="`catalog-${id}`" :effective="effective" />
              </template>
              <div class="flex min-h-32 flex-1 flex-col overflow-auto">
                <slot name="catalog-products" :effective="effective" />
              </div>
            </div>
            <template v-for="(id, index) in effective.sections.cart" :key="id">
              <div
                class="pos-workspace-section flex flex-col"
                :class="[
                  id === 'lines' ? (editing ? 'min-h-24 flex-1' : 'min-h-0 flex-1') : 'flex-none',
                  editing ? 'pos-workspace-section--editing m-1 p-1' : ''
                ]"
                :data-section="id"
                data-section-column="cart"
              >
                <div
                  v-if="editing"
                  class="pos-workspace-section__handle mb-1 flex flex-none items-center gap-1.5 text-xs font-semibold text-pri-text"
                >
                  <span
                    v-if="id !== 'totals'"
                    class="flex size-9 cursor-grab touch-none items-center justify-center rounded-md hover:bg-pri-soft"
                    role="img"
                    :aria-label="dragLabel(label(id))"
                    @pointerdown="onSectionDragDown($event, 'cart', id)"
                    @pointermove="onSectionDragMove"
                    @pointerup="endSectionDrag"
                    @pointercancel="endSectionDrag"
                    ><AppIcon name="drag_indicator" :size="18"
                  /></span>
                  <AppIcon v-else name="lock" :size="16" class="mx-2.5" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate">{{ label(id) }}</span>
                  <template v-if="id !== 'totals'">
                    <button
                      type="button"
                      class="flex size-9 items-center justify-center rounded-md hover:bg-pri-soft disabled:opacity-40"
                      :aria-label="moveUpLabel(label(id))"
                      :disabled="index === 0 || !canMove('cart', id, -1)"
                      @click="emit('move', { column: 'cart', id, direction: -1 })"
                    >
                      <AppIcon name="arrow_upward" :size="18" />
                    </button>
                    <button
                      type="button"
                      class="flex size-9 items-center justify-center rounded-md hover:bg-pri-soft disabled:opacity-40"
                      :aria-label="moveDownLabel(label(id))"
                      :disabled="!canMove('cart', id, 1)"
                      @click="emit('move', { column: 'cart', id, direction: 1 })"
                    >
                      <AppIcon name="arrow_downward" :size="18" />
                    </button>
                  </template>
                </div>
                <!-- The lines keep scrolling while editing (their controls are disabled by the page);
                     every other section is inert. -->
                <div
                  class="pos-workspace-section__content flex flex-col"
                  :class="id === 'lines' ? 'min-h-0 flex-1' : ''"
                  :inert="(editing && id !== 'lines') || undefined"
                >
                  <slot :name="`cart-${id}`" :effective="effective" />
                </div>
              </div>
              <div
                v-if="dragging?.column === 'cart' && dropIndex === index + 1"
                class="mx-2 h-0.5 rounded bg-pri"
                aria-hidden="true"
              />
            </template>
            <slot name="cart-extra" :effective="effective" />
          </aside>
          <div
            v-if="editing && !railMode && regionOrder[0] === 'cart'"
            class="pos-workspace-shell__resizer -mx-2 flex w-4 flex-none cursor-col-resize touch-none items-center justify-center rounded-md hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            :aria-label="resizeLabel"
            :aria-controls="cartId"
            :aria-valuenow="effective.appliedCartShare"
            :aria-valuemin="effective.minCartShare"
            :aria-valuemax="effective.maxCartShare"
            :aria-valuetext="widthValueText(effective.appliedCartShare)"
            @pointerdown="onResizeDown"
            @pointermove="onResizeMove"
            @pointerup="endResize"
            @pointercancel="endResize"
            @lostpointercapture="endResize"
            @keydown="onResizeKey"
          >
            <span class="pointer-events-none h-16 w-1.5 rounded-full bg-pri" aria-hidden="true" />
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
