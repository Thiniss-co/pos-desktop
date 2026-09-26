<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import { usePrintingStore } from '../store'

const props = defineProps<{
  open: boolean
  document: ReceiptDocumentRef | null
}>()

const emit = defineEmits<{ close: [] }>()

const { t, locale } = useI18n()
const store = usePrintingStore()
const { preview, isPreviewing, isDispatching, jobStatus, printers, workstationSettings } =
  storeToRefs(store)
const errorMessage = computed(() => store.error.error)

const copiesText = ref('1')
const selectedPrinter = ref<string>('')

const printerOptions = computed(() =>
  printers.value.map((printer) => ({ value: printer.name, label: printer.displayName }))
)

const statusMessage = computed(() => {
  if (isDispatching.value) {
    return t('printing.status.dispatching')
  }
  const status = jobStatus.value?.status
  if (!status) {
    return null
  }
  if (status === 'in_progress') {
    return t(`printing.status.${jobStatus.value!.phase ?? 'queued'}`)
  }
  return t(`printing.status.${status}`)
})

const statusVariant = computed<'info' | 'success' | 'warning' | 'error'>(() => {
  const status = jobStatus.value?.status
  if (status === 'submitted') return 'success'
  if (status === 'outcome_unknown') return 'warning'
  if (status === 'failed_before_dispatch' || status === 'cancelled') return 'error'
  return 'info'
})

async function loadPreview(): Promise<void> {
  if (!props.document) {
    return
  }
  await store.loadPrinters()
  await store.openPreview(props.document, locale.value as 'en' | 'ar', {
    copies: Number(copiesText.value),
    printerName: selectedPrinter.value || undefined
  })
}

watch(
  () => [props.open, props.document],
  ([isOpen]) => {
    if (isOpen) {
      void loadPreview()
    } else {
      store.closePreview()
    }
  }
)

onMounted(() => {
  if (props.open) {
    void loadPreview()
  }
})

async function onPrint(): Promise<void> {
  await store.print()
}

async function onReprint(): Promise<void> {
  await store.print()
}

function onClose(): void {
  emit('close')
}

const isReprintFlow = computed(() => preview.value?.isReprint ?? false)
</script>

<template>
  <AppDialog :open="open" size="lg" @close="onClose">
    <template #title>{{ t('printing.previewTitle') }}</template>

    <div class="receipt-preview">
      <div class="receipt-preview__paper" role="img" :aria-label="t('printing.previewAlt')">
        <div v-if="isPreviewing" class="receipt-preview__loading">
          {{ t('printing.status.preparing') }}
        </div>
        <template v-else-if="preview">
          <div class="receipt-preview__gauge">
            {{
              t('printing.paperGauge', {
                paper: String(preview.pages[0]?.widthMm ?? ''),
                printable: String(workstationSettings?.printableWidthMm ?? '')
              })
            }}
          </div>
          <div v-for="(page, index) in preview.pages" :key="index" class="receipt-preview__page">
            <img :src="page.pngDataUrl" :alt="t('printing.previewAlt')" />
          </div>
          <div v-if="preview.pageCount > 1" class="receipt-preview__page-count">
            {{ t('printing.pageCount', { count: String(preview.pageCount) }) }}
          </div>
          <div v-if="preview.isReprint" class="receipt-preview__reprint-notice">
            {{ t('printing.reprintNotice') }}
          </div>
        </template>
        <div v-else class="receipt-preview__loading">{{ t('printing.previewUnavailable') }}</div>
      </div>

      <div class="receipt-preview__controls">
        <AppSelect
          v-model="selectedPrinter"
          :label="t('printing.printerLabel')"
          :options="[{ value: '', label: t('printing.printerDefault') }, ...printerOptions]"
        />
        <AppSelect
          v-model="copiesText"
          :label="t('printing.copiesLabel')"
          :options="[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' }
          ]"
        />

        <AppBanner v-if="errorMessage" variant="error" role="alert">
          {{ errorMessage }}
        </AppBanner>
        <AppBanner v-else-if="statusMessage" :variant="statusVariant" role="status">
          {{ statusMessage }}
        </AppBanner>
      </div>
    </div>

    <template #actions>
      <AppButton variant="ghost" @click="onClose">{{ t('common.close') }}</AppButton>
      <AppButton
        variant="transaction"
        :loading="isDispatching"
        :disabled="!preview || isPreviewing"
        @click="isReprintFlow ? onReprint() : onPrint()"
      >
        {{ isReprintFlow ? t('printing.reprintAction') : t('printing.printAction') }}
      </AppButton>
    </template>
  </AppDialog>
</template>

<style scoped>
.receipt-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.receipt-preview__paper {
  max-height: 60vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface-container-low);
}

.receipt-preview__page {
  background: #ffffff;
  box-shadow: 0 2px 8px var(--color-scrim);
}

.receipt-preview__page img {
  display: block;
  max-width: 100%;
  height: auto;
}

.receipt-preview__gauge {
  font-size: var(--text-label-caps-size);
  color: var(--color-on-surface-variant);
}

.receipt-preview__page-count,
.receipt-preview__reprint-notice {
  font-size: var(--text-body-sm-size);
  color: var(--color-on-surface-variant);
}

.receipt-preview__loading {
  padding: var(--space-6);
  color: var(--color-on-surface-variant);
}

.receipt-preview__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

@media (min-width: 640px) {
  .receipt-preview {
    flex-direction: row;
    align-items: flex-start;
  }

  .receipt-preview__paper {
    flex: 1 1 auto;
  }

  .receipt-preview__controls {
    flex: 0 0 220px;
  }
}
</style>
