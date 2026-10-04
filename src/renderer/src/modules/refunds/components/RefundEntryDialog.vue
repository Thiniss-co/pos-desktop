<script setup lang="ts">
/**
 * POS improvements — "Return / Refund" from the POS: choose the ORIGINAL sale, then the existing
 * refund flow (RefundDialog) takes over with all its rules — quantities already refunded, permission,
 * payment, shift and stock return. Nothing here creates a refund, and the POS cart, payment state and
 * scan focus are untouched (this is an overlay, not a navigation).
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SalesInvoiceSummary } from '@shared/contracts/refund.contract'
import { formatMinorCurrency } from '@shared/money/minorUnits'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import { formatDateTime } from '@renderer/shared/utils/format'
import { useLocaleStore } from '@renderer/modules/preferences/locale.store'
import { SalesService } from '@renderer/modules/sales/service'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; select: [invoiceLocalUuid: string] }>()

const { t } = useI18n()
const locale = useLocaleStore()
const service = new SalesService()
const search = ref('')
const invoices = ref<readonly SalesInvoiceSummary[]>([])
const loading = ref(false)
const problem = ref<string | null>(null)
let request = 0
let timer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<void> {
  const current = ++request
  loading.value = true
  problem.value = null
  try {
    const list = await service.listInvoices({ search: search.value.trim() || undefined, limit: 20 })
    if (current === request) invoices.value = list.invoices
  } catch (error) {
    if (current === request) {
      invoices.value = []
      problem.value = (error as { message?: string })?.message ?? t('refunds.entry.loadFailed')
    }
  } finally {
    if (current === request) loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      search.value = ''
      void load()
    }
  },
  { immediate: true }
)
watch(search, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void load(), 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function money(invoice: SalesInvoiceSummary): string {
  const formatted = formatMinorCurrency(
    invoice.grandTotalAmount,
    locale.locale,
    invoice.currency,
    invoice.currencyExponent
  )
  return formatted.ok ? formatted.value : ''
}
</script>

<template>
  <AppDialog
    :open="open"
    size="lg"
    sheet="compact"
    :close-label="t('common.close')"
    data-testid="refund-entry-dialog"
    @close="emit('close')"
  >
    <template #title>
      <span class="flex items-center gap-2"
        ><AppIcon name="undo" :size="22" />{{ t('refunds.entry.title') }}</span
      >
    </template>
    <div class="flex flex-col gap-4">
      <p class="text-sm text-muted">{{ t('refunds.entry.intro') }}</p>
      <AppInput
        v-model="search"
        :label="t('refunds.entry.search')"
        type="search"
        inputmode="search"
        dir="auto"
        autofocus
        data-testid="refund-entry-search"
      />
      <AppInlineError v-if="problem">{{ problem }}</AppInlineError>
      <p v-else-if="!loading && invoices.length === 0" class="py-6 text-center text-muted">
        {{ t('refunds.entry.empty') }}
      </p>
      <ul v-else class="flex flex-col gap-2" :aria-busy="loading ? 'true' : 'false'">
        <li v-for="invoice in invoices" :key="invoice.invoiceLocalUuid">
          <button
            type="button"
            class="flex min-h-14 w-full items-center gap-3 rounded-notice border border-line bg-surf px-3.5 py-2.5 text-start hover:border-pri hover:bg-pri-soft focus-visible:ring-2 focus-visible:ring-focus"
            :data-testid="`refund-entry-${invoice.invoiceLocalUuid}`"
            @click="emit('select', invoice.invoiceLocalUuid)"
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="code truncate font-semibold" dir="ltr">{{ invoice.displayNumber }}</span>
              <span class="text-xs text-muted">{{
                formatDateTime(invoice.soldAt, locale.locale)
              }}</span>
            </span>
            <AppStatusChip v-if="invoice.hasOpenRefund" variant="warning" size="sm">
              {{ t('refunds.entry.openRefund') }}
            </AppStatusChip>
            <AppStatusChip
              v-else-if="invoice.syncStatus !== 'synced'"
              variant="information"
              size="sm"
            >
              {{ t('refunds.entry.notUploaded') }}
            </AppStatusChip>
            <span class="numeric font-semibold">{{ money(invoice) }}</span>
            <AppIcon name="chevron_right" :size="20" class="text-muted" :mirror-rtl="true" />
          </button>
        </li>
      </ul>
    </div>
    <template #actions>
      <AppButton variant="secondary" @click="emit('close')">{{ t('common.cancel') }}</AppButton>
    </template>
  </AppDialog>
</template>
