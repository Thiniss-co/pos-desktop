<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppSpinner from '@renderer/shared/components/common/AppSpinner.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import { usePrintingStore } from '../store'

/**
 * V3 print dialog: the receipt pages on a subtle panel (main-process PNGs on white paper — never
 * recoloured, identical in both themes), and a control column with paper, printer, duplicate and
 * outcome notices. Every notice is driven by the real preview / job state.
 */
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

/** The OS-reported state of the explicitly chosen printer, when the OS reports one. */
const selectedPrinterState = computed(
  () => printers.value.find((printer) => printer.name === selectedPrinter.value)?.state ?? null
)

const PRINTER_STATE_ICON_CLASS = {
  idle: 'text-ok',
  busy: 'text-warn',
  stopped: 'text-err'
} as const

type OutcomeNotice = {
  variant: 'info' | 'success' | 'warning' | 'error' | 'neutral'
  icon: IconName
  message: string
  hint?: string
}

/** The job's outcome after (or while) dispatching — `isDispatching` has its own notice. */
const outcomeNotice = computed<OutcomeNotice | null>(() => {
  const job = jobStatus.value
  if (isDispatching.value || !job) {
    return null
  }
  switch (job.status) {
    case 'in_progress':
      return {
        variant: 'info',
        icon: 'hourglass_top',
        message: t(`printing.status.${job.phase ?? 'queued'}`)
      }
    case 'submitted':
      return {
        variant: 'success',
        icon: 'print',
        message: t('printing.status.submitted'),
        hint: t('printing.submittedHint')
      }
    case 'outcome_unknown':
      return { variant: 'warning', icon: 'help', message: t('printing.status.outcome_unknown') }
    case 'cancelled':
      return { variant: 'neutral', icon: 'block', message: t('printing.status.cancelled') }
    case 'failed_before_dispatch':
      return {
        variant: 'error',
        icon: 'print_disabled',
        message: t('printing.status.failed_before_dispatch')
      }
    default:
      return null
  }
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
  <AppDialog :open="open" size="lg" :close-label="t('common.close')" @close="onClose">
    <template #title>{{ t('printing.previewTitle') }}</template>

    <div class="flex flex-wrap gap-5">
      <section
        class="flex max-h-[60vh] min-w-0 flex-[1_1_320px] flex-col items-center gap-3 overflow-auto rounded-lg border border-line bg-subtle p-5"
        :aria-label="t('printing.previewAlt')"
      >
        <p
          v-if="isPreviewing"
          class="flex items-center gap-2 py-6 text-sm text-muted"
          role="status"
        >
          <AppSpinner :size="18" />
          {{ t('printing.status.preparing') }}
        </p>
        <template v-else-if="preview">
          <div
            v-for="(page, index) in preview.pages"
            :key="index"
            class="receipt-preview__page bg-paper shadow-panel"
          >
            <img
              class="block h-auto max-w-full"
              :src="page.pngDataUrl"
              :alt="t('printing.previewAlt')"
            />
          </div>
          <p v-if="preview.pageCount > 1" class="numeric text-xs text-muted">
            {{ t('printing.pageCount', { count: String(preview.pageCount) }) }}
          </p>
        </template>
        <p v-else class="flex items-center gap-2 py-6 text-sm text-muted">
          <AppIcon name="print_disabled" :size="18" />
          {{ t('printing.previewUnavailable') }}
        </p>
      </section>

      <div class="flex min-w-0 flex-[1_1_260px] flex-col gap-3">
        <p v-if="preview" class="numeric text-sm font-bold">
          {{
            workstationSettings?.printableWidthMm
              ? t('printing.paperGauge', {
                  paper: String(preview.pages[0]?.widthMm ?? ''),
                  printable: String(workstationSettings.printableWidthMm)
                })
              : t('printing.paperOnly', { paper: String(preview.pages[0]?.widthMm ?? '') })
          }}
        </p>

        <p v-if="selectedPrinterState" class="flex items-center gap-2 text-sm">
          <AppIcon
            name="print"
            :size="20"
            :class="PRINTER_STATE_ICON_CLASS[selectedPrinterState]"
          />
          {{ t(`printing.printerState.${selectedPrinterState}`) }}
        </p>

        <AppBanner
          v-if="preview?.isReprint"
          variant="warning"
          role="note"
          icon="content_copy"
          :title="t('printing.duplicateTitle')"
        >
          {{ t('printing.reprintNotice') }}
        </AppBanner>

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
        <p
          v-else-if="isDispatching"
          class="flex items-center gap-2.5 rounded-notice bg-info-bg px-3.5 py-3 text-sm font-semibold"
          role="status"
        >
          <AppSpinner :size="20" class="text-info" />
          {{ t('printing.status.dispatching') }}
        </p>
        <AppBanner
          v-else-if="outcomeNotice"
          :variant="outcomeNotice.variant"
          :icon="outcomeNotice.icon"
          role="status"
        >
          <p :class="{ 'font-bold': outcomeNotice.hint }">{{ outcomeNotice.message }}</p>
          <p v-if="outcomeNotice.hint">{{ outcomeNotice.hint }}</p>
        </AppBanner>
      </div>
    </div>

    <template #actions>
      <AppButton variant="secondary" @click="onClose">{{ t('common.close') }}</AppButton>
      <AppButton
        variant="primary"
        icon="print"
        :loading="isDispatching"
        :disabled="!preview || isPreviewing"
        @click="isReprintFlow ? onReprint() : onPrint()"
      >
        {{ isReprintFlow ? t('printing.reprintAction') : t('printing.printAction') }}
      </AppButton>
    </template>
  </AppDialog>
</template>
