<script setup lang="ts">
/**
 * POS workspace layout controls, shared by the POS layout editor (the edit bar above the live
 * workspace) and Settings → POS workspace (beside a schematic preview).
 *
 * They change only the store's DRAFT; nothing is written until Apply. Every control is a button,
 * radio group or stepper — there is deliberately no text field, so a barcode scanned while editing
 * can never be typed into the editor. Section order is changed with Move up / Move down (`sections`
 * variant) or the handles on the live workspace.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  POS_CART_SHARE_MAX,
  POS_CART_SHARE_MIN,
  isSupportedCartOrder,
  isSupportedCatalogOrder,
  type PosCartSectionId,
  type PosCatalogSectionId,
  type PosWorkspacePreset
} from '@shared/contracts/posWorkspace.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSegmented from '@renderer/shared/components/forms/AppSegmented.vue'
import { directionFor } from '@renderer/i18n/localeRegistry'
import { useLocaleStore } from '../locale.store'
import { useWorkspaceLayoutStore } from '../posWorkspace.store'
import { canMoveSection, moveSection, type EffectiveWorkspaceLayout } from '../workspaceLayout'

const props = withDefaults(
  defineProps<{
    /** The live effective layout, when the editor sits on the workspace (applied cart share). */
    effective?: EffectiveWorkspaceLayout | null
    touchMode?: boolean
    /** `bar`: the compact POS edit bar; `panel`: the Settings form with the section lists. */
    variant?: 'bar' | 'panel'
    /** Announced through the live region (a section moved, saved, …). */
    announcement?: string | null
  }>(),
  { effective: null, touchMode: false, variant: 'bar', announcement: null }
)

const emit = defineEmits<{ applied: []; cancelled: []; moved: [string] }>()

const { t } = useI18n()
const store = useWorkspaceLayoutStore()
const locale = useLocaleStore()
const draft = computed(() => store.draft)
const rtl = computed(() => directionFor(locale.locale) === 'rtl')

const SHARE_STEP = 5

const presetOptions = computed(() =>
  (['cartFirst', 'balanced', 'scanner'] as const).map((value) => ({
    value,
    label: t(`pos.workspace.presets.${value}`),
    sub: props.variant === 'panel' ? t(`pos.workspace.presetHints.${value}`) : undefined
  }))
)

const presetValue = computed<Exclude<PosWorkspacePreset, 'custom'> | null>(() =>
  draft.value && draft.value.preset !== 'custom' ? draft.value.preset : null
)

/** The physical side the cart is on for the logical value, in the current language. */
const sideValue = computed<'left' | 'right'>(() => {
  const end = draft.value?.cartSide !== 'start'
  return end !== rtl.value ? 'right' : 'left'
})

function chooseSide(side: 'left' | 'right'): void {
  const end = (side === 'right') !== rtl.value
  store.patchDraft({ cartSide: end ? 'end' : 'start' })
}

const share = computed(() => draft.value?.cartShare ?? 64)
const appliedShare = computed(() => props.effective?.appliedCartShare ?? null)

function changeShare(delta: number): void {
  const next = Math.min(POS_CART_SHARE_MAX, Math.max(POS_CART_SHARE_MIN, share.value + delta))
  store.patchDraft({ cartShare: next })
}

function sectionLabel(id: string): string {
  return t(`pos.workspace.sections.${id}`)
}

function move(column: 'cart' | 'catalog', id: string, direction: -1 | 1): void {
  if (!draft.value) {
    return
  }
  if (column === 'cart') {
    const order = moveSection(
      draft.value.sections.cart,
      id as PosCartSectionId,
      direction,
      isSupportedCartOrder
    )
    store.patchDraft({ sections: { ...draft.value.sections, cart: order } })
    emit(
      'moved',
      t('pos.workspace.edit.moved', {
        section: sectionLabel(id),
        position: order.indexOf(id as PosCartSectionId) + 1
      })
    )
  } else {
    const order = moveSection(
      draft.value.sections.catalog,
      id as PosCatalogSectionId,
      direction,
      isSupportedCatalogOrder
    )
    store.patchDraft({ sections: { ...draft.value.sections, catalog: order } })
    emit(
      'moved',
      t('pos.workspace.edit.moved', {
        section: sectionLabel(id),
        position: order.indexOf(id as PosCatalogSectionId) + 1
      })
    )
  }
}

function canMove(column: 'cart' | 'catalog', id: string, direction: -1 | 1): boolean {
  if (!draft.value) {
    return false
  }
  return column === 'cart'
    ? canMoveSection(
        draft.value.sections.cart,
        id as PosCartSectionId,
        direction,
        isSupportedCartOrder
      )
    : canMoveSection(
        draft.value.sections.catalog,
        id as PosCatalogSectionId,
        direction,
        isSupportedCatalogOrder
      )
}

const errorMessage = computed(() =>
  store.saveError ? t(`pos.workspace.edit.${store.saveError}`) : null
)

async function apply(): Promise<void> {
  if (await store.apply()) {
    emit('applied')
  }
}

function cancel(): void {
  store.cancel()
  emit('cancelled')
}
</script>

<template>
  <div
    v-if="draft"
    class="workspace-layout-controls flex flex-col"
    :class="variant === 'bar' ? 'gap-2 text-sm' : 'gap-3'"
    data-testid="workspace-layout-controls"
  >
    <div class="flex flex-none flex-wrap items-center gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1">
        <h2 class="font-bold" :class="variant === 'bar' ? 'text-md' : 'text-lg'">
          {{ t('pos.workspace.edit.title') }}
          <span v-if="variant === 'bar'" class="ms-2 text-xs font-normal text-muted">{{
            t('pos.workspace.edit.keyboardHint')
          }}</span>
        </h2>
        <p v-if="variant === 'panel'" class="text-xs text-muted">
          {{ t('pos.workspace.edit.keyboardHint') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <AppButton
          variant="ghost"
          size="sm"
          icon="restart_alt"
          data-testid="workspace-restore"
          :disabled="store.saving"
          @click="store.restoreDefaults()"
          >{{ t('pos.workspace.edit.restore') }}</AppButton
        >
        <AppButton
          variant="secondary"
          size="sm"
          data-testid="workspace-cancel"
          :disabled="store.saving"
          @click="cancel"
          >{{ t('pos.workspace.edit.cancel') }}</AppButton
        >
        <AppButton
          variant="primary"
          size="sm"
          data-testid="workspace-apply"
          :loading="store.saving"
          :disabled="store.saving || !store.canPersist"
          @click="apply"
          >{{
            store.saving ? t('pos.workspace.edit.saving') : t('pos.workspace.edit.apply')
          }}</AppButton
        >
      </div>
    </div>

    <p
      v-if="errorMessage"
      class="flex items-center gap-1.5 rounded-md bg-err-bg px-2.5 py-1.5 text-sm text-err"
      role="alert"
      data-testid="workspace-save-error"
    >
      <AppIcon name="error" :size="18" />{{ errorMessage }}
    </p>
    <p
      v-else-if="!store.canPersist"
      class="rounded-md bg-warn-bg px-2.5 py-1.5 text-sm text-warn"
      role="status"
    >
      {{ t('pos.workspace.edit.unavailable') }}
    </p>

    <!-- The bar keeps its title and Apply/Cancel fixed; on a short window its controls scroll inside a
         bounded region instead of pushing the workspace off screen. -->
    <div
      class="grid gap-x-5 gap-y-2"
      :class="
        variant === 'bar'
          ? 'max-h-[min(30vh,13rem)] grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] overflow-y-auto pe-1'
          : 'grid-cols-1 sm:grid-cols-2'
      "
    >
      <AppSegmented
        :class="variant === 'bar' ? 'col-span-2' : 'col-span-full'"
        :model-value="presetValue"
        :label="
          draft.preset === 'custom'
            ? `${t('pos.workspace.edit.preset')} · ${t('pos.workspace.presets.custom')}`
            : t('pos.workspace.edit.preset')
        "
        :options="presetOptions"
        :layout="variant === 'bar' ? 'chip' : 'tile'"
        data-testid="workspace-preset"
        @update:model-value="(value) => store.choosePreset(value)"
      />
      <AppSegmented
        :model-value="sideValue"
        :label="t('pos.workspace.edit.cartSide')"
        :options="[
          { value: 'left', label: t('pos.workspace.edit.sideLeft') },
          { value: 'right', label: t('pos.workspace.edit.sideRight') }
        ]"
        layout="chip"
        data-testid="workspace-side"
        @update:model-value="chooseSide"
      />
      <div class="flex flex-col gap-1">
        <AppSegmented
          :model-value="draft.density"
          :label="t('pos.workspace.edit.density')"
          :options="[
            { value: 'compact', label: t('pos.workspace.edit.compact'), disabled: touchMode },
            { value: 'comfortable', label: t('pos.workspace.edit.comfortable') }
          ]"
          layout="chip"
          data-testid="workspace-density"
          @update:model-value="(value) => store.patchDraft({ density: value })"
        />
        <p v-if="touchMode" class="text-xs text-muted">
          {{ t('pos.workspace.edit.densityForced') }}
        </p>
      </div>
      <AppSegmented
        :model-value="draft.catalogCollapsed ? 'collapsed' : 'shown'"
        :label="t('pos.workspace.edit.products')"
        :options="[
          { value: 'shown', label: t('pos.workspace.edit.productsShown') },
          { value: 'collapsed', label: t('pos.workspace.edit.productsCollapsed') }
        ]"
        layout="chip"
        data-testid="workspace-collapse"
        @update:model-value="
          (value) => store.patchDraft({ catalogCollapsed: value === 'collapsed' })
        "
      />
      <AppSegmented
        :model-value="draft.catalogView"
        :label="t('pos.workspace.edit.productView')"
        :options="[
          { value: 'compact', label: t('pos.workspace.edit.viewCompact') },
          { value: 'cards', label: t('pos.workspace.edit.viewCards') }
        ]"
        layout="chip"
        data-testid="workspace-view"
        @update:model-value="(value) => store.patchDraft({ catalogView: value })"
      />
      <div
        class="flex flex-col gap-1.5"
        role="group"
        :aria-label="t('pos.workspace.edit.cartWidth')"
      >
        <span class="text-sm font-semibold">{{ t('pos.workspace.edit.cartWidth') }}</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-md border border-control bg-surf text-lg font-bold hover:bg-subtle disabled:opacity-40"
            :aria-label="`${t('pos.workspace.edit.cartWidth')} −${SHARE_STEP}%`"
            data-testid="workspace-narrower"
            :disabled="share <= POS_CART_SHARE_MIN || draft.catalogCollapsed"
            @click="changeShare(-SHARE_STEP)"
          >
            −
          </button>
          <output
            class="numeric min-w-14 text-center text-md font-bold"
            aria-live="polite"
            data-testid="workspace-share"
            >{{ share }}%</output
          >
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-md border border-control bg-surf text-lg font-bold hover:bg-subtle disabled:opacity-40"
            :aria-label="`${t('pos.workspace.edit.cartWidth')} +${SHARE_STEP}%`"
            data-testid="workspace-wider"
            :disabled="share >= POS_CART_SHARE_MAX || draft.catalogCollapsed"
            @click="changeShare(SHARE_STEP)"
          >
            +
          </button>
        </div>
        <p
          v-if="appliedShare !== null && appliedShare !== share && !draft.catalogCollapsed"
          class="text-xs text-muted"
        >
          {{ t('pos.workspace.edit.cartWidthHint', { applied: appliedShare }) }}
        </p>
      </div>
    </div>

    <div v-if="variant === 'panel'" class="grid gap-4 sm:grid-cols-2">
      <section
        v-for="column in ['cart', 'catalog'] as const"
        :key="column"
        class="flex flex-col gap-1.5"
      >
        <h3 class="text-sm font-semibold">
          {{
            t(
              column === 'cart'
                ? 'pos.workspace.edit.cartSections'
                : 'pos.workspace.edit.catalogSections'
            )
          }}
        </h3>
        <ol class="flex flex-col gap-1.5" :data-testid="`workspace-sections-${column}`">
          <li
            v-for="(id, index) in column === 'cart' ? draft.sections.cart : draft.sections.catalog"
            :key="id"
            class="flex items-center gap-2 rounded-md border border-line bg-surf px-2.5 py-1"
            :data-section="id"
          >
            <span class="numeric w-5 text-xs text-muted">{{ index + 1 }}</span>
            <span class="min-w-0 flex-1 text-sm font-medium">{{ sectionLabel(id) }}</span>
            <button
              type="button"
              class="flex size-10 items-center justify-center rounded-md hover:bg-subtle disabled:opacity-40"
              :aria-label="t('pos.workspace.moveUp', { section: sectionLabel(id) })"
              :disabled="!canMove(column, id, -1)"
              @click="move(column, id, -1)"
            >
              <AppIcon name="arrow_upward" :size="18" />
            </button>
            <button
              type="button"
              class="flex size-10 items-center justify-center rounded-md hover:bg-subtle disabled:opacity-40"
              :aria-label="t('pos.workspace.moveDown', { section: sectionLabel(id) })"
              :disabled="!canMove(column, id, 1)"
              @click="move(column, id, 1)"
            >
              <AppIcon name="arrow_downward" :size="18" />
            </button>
          </li>
        </ol>
      </section>
    </div>

    <p class="sr-only" role="status" aria-live="polite">{{ announcement ?? '' }}</p>
  </div>
</template>
