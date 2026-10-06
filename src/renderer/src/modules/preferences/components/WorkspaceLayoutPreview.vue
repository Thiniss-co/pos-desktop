<script setup lang="ts">
/**
 * Settings → POS workspace: a proportional schematic of a layout as it would appear on a 1366×768
 * register (or the size given), computed with the same `resolveEffectiveLayout` the till uses.
 * Presentation only; one image with a text description for assistive technology.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PosWorkspaceLayout } from '@shared/contracts/posWorkspace.contract'
import { resolveEffectiveLayout } from '../workspaceLayout'

const props = withDefaults(
  defineProps<{
    layout: PosWorkspaceLayout
    touchMode?: boolean
    rtl?: boolean
    viewport?: { width: number; height: number }
  }>(),
  { touchMode: false, rtl: false, viewport: () => ({ width: 1366, height: 768 }) }
)

const { t } = useI18n()

const effective = computed(() =>
  resolveEffectiveLayout(props.layout, {
    width: props.viewport.width - 24,
    height: props.viewport.height - 60 - 24,
    viewportWidth: props.viewport.width,
    touchMode: props.touchMode
  })
)

const total = computed(() => Math.max(1, props.viewport.width - 24))
const catalogPercent = computed(() => (effective.value.catalogWidth / total.value) * 100)
const cartFirstVisually = computed(() => (effective.value.cartSide === 'start') !== props.rtl)

const SECTION_HEIGHT: Record<string, number> = { actions: 10, scan: 14, totals: 16 }

const description = computed(() =>
  [
    t(`pos.workspace.presets.${effective.value.preset}`),
    `${t('pos.workspace.edit.cartWidth')} ${effective.value.appliedCartShare}%`,
    t(
      effective.value.catalogMode === 'rail'
        ? 'pos.workspace.edit.productsCollapsed'
        : 'pos.workspace.edit.productsShown'
    ),
    t(`pos.workspace.edit.${effective.value.density}`),
    effective.value.sections.cart.map((id) => t(`pos.workspace.sections.${id}`)).join(', ')
  ].join(' · ')
)
</script>

<template>
  <figure class="workspace-layout-preview flex flex-col gap-2" data-testid="workspace-preview">
    <div
      class="flex aspect-[1366/708] w-full gap-[1.2%] rounded-lg border border-line bg-page p-[1.2%]"
      :class="cartFirstVisually ? 'flex-row-reverse' : 'flex-row'"
      dir="ltr"
      role="img"
      :aria-label="`${t('pos.workspace.edit.previewLabel')}: ${description}`"
    >
      <div
        class="flex flex-none flex-col gap-[4%] rounded-md border border-line bg-surf p-[1.5%]"
        :style="{ width: `${catalogPercent}%` }"
      >
        <template v-if="effective.catalogMode === 'panel'">
          <div
            v-for="id in effective.sections.catalog.filter((s) => s !== 'products')"
            :key="id"
            class="h-[7%] rounded-sm"
            :class="id === 'search' ? 'border border-control bg-surf' : 'bg-cat-1'"
          />
          <div
            class="grid flex-1 gap-[3%]"
            :class="
              effective.catalogView === 'cards'
                ? 'grid-cols-[repeat(auto-fill,minmax(28%,1fr))]'
                : 'grid-cols-[repeat(auto-fill,minmax(40%,1fr))]'
            "
          >
            <div
              v-for="n in effective.catalogView === 'cards' ? 9 : 10"
              :key="n"
              class="rounded-sm border border-line"
              :class="effective.catalogView === 'cards' ? 'bg-cat-0' : 'bg-subtle'"
            />
          </div>
        </template>
        <div v-else class="mx-auto mt-[20%] h-[6%] w-[60%] rounded-sm bg-pri-soft" />
      </div>
      <div
        class="flex min-w-0 flex-1 flex-col gap-[2%] rounded-md border border-line bg-surf p-[1.5%]"
      >
        <template v-for="id in effective.sections.cart" :key="id">
          <div
            v-if="id === 'lines'"
            class="flex flex-1 flex-col justify-start gap-[3%] overflow-hidden py-[1%]"
          >
            <div
              v-for="n in effective.density === 'compact' ? 12 : 7"
              :key="n"
              class="flex h-[5%] min-h-1 flex-none gap-[3%]"
            >
              <span class="flex-1 rounded-sm bg-line" />
              <span class="w-[14%] rounded-sm bg-line" />
              <span class="w-[12%] rounded-sm bg-line-strong" />
            </div>
          </div>
          <div
            v-else
            class="flex-none rounded-sm"
            :style="{ height: `${SECTION_HEIGHT[id]}%` }"
            :class="
              id === 'totals'
                ? 'bg-pri'
                : id === 'scan'
                  ? 'border-2 border-pri bg-surf'
                  : 'bg-pri-soft'
            "
          />
        </template>
      </div>
    </div>
    <figcaption class="text-xs text-muted">{{ description }}</figcaption>
  </figure>
</template>
