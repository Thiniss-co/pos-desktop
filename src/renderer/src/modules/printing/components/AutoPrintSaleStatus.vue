<script setup lang="ts">
/**
 * POS improvements, Stage 7 — the sale-complete panel's line about the automatic print of THIS sale,
 * and the cashier's own switch for the next sales. "Sent to the printer" means the printer queue
 * accepted the receipt; it never claims that paper came out.
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AutoPrintSwitch from '@renderer/modules/preferences/components/AutoPrintSwitch.vue'
import { useAutoPrintStore } from '../autoPrint.store'
import { autoPrintChip } from '../autoPrintChip'

const props = defineProps<{ invoiceLocalUuid: string }>()

const { t } = useI18n()
const store = useAutoPrintStore()

const chip = computed(() => {
  const current = store.sale
  return current && current.invoiceLocalUuid === props.invoiceLocalUuid
    ? autoPrintChip(current.status)
    : null
})

const TONE: Record<string, string> = {
  muted: 'border-line text-muted',
  ok: 'border-ok/40 bg-ok-bg text-ok',
  warn: 'border-warn/40 bg-warn-bg text-warn',
  err: 'border-err/40 bg-err-bg text-err'
}

watch(
  () => props.invoiceLocalUuid,
  (uuid) => void store.watchSale(uuid),
  { immediate: true }
)
onBeforeUnmount(() => store.stopWatching())
</script>

<template>
  <div class="auto-print-sale-status flex flex-col gap-2" data-testid="auto-print-sale-status">
    <p
      v-if="chip"
      class="flex items-start gap-2 rounded-notice border px-3 py-2 text-sm font-semibold"
      :class="TONE[chip.tone]"
      role="status"
      :data-state="store.sale?.status.state"
      :data-job-status="store.sale?.status.job?.status ?? ''"
      data-testid="auto-print-chip"
    >
      <AppIcon :name="chip.icon" :size="18" class="mt-px flex-none" />
      <span class="min-w-0 text-ink">
        {{ t(`printing.auto.chip.${chip.key}`) }}
        <span v-if="chip.printManually" class="block font-normal text-muted">
          {{ t('printing.auto.chip.printManually') }}
        </span>
      </span>
    </p>
    <AutoPrintSwitch />
  </div>
</template>
