<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppSelect from '@renderer/shared/components/forms/AppSelect.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import ReceiptProfileSection from '@renderer/modules/receiptProfile/components/ReceiptProfileSection.vue'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { usePrintingStore } from '@renderer/modules/printing/store'
import { useReceiptProfileStore } from '@renderer/modules/receiptProfile/store'

const { snapshot } = storeToRefs(useStartupStore())
const { t } = useI18n()

const receiptProfileStore = useReceiptProfileStore()
const { isVisible: isReceiptProfileVisible } = storeToRefs(receiptProfileStore)

const printingStore = usePrintingStore()
const { workstationSettings, printers, isLoadingPrinters, isSavingSettings } =
  storeToRefs(printingStore)
const errorMessage = computed(() => printingStore.error.error)

const printerNameModel = ref('')
const paperWidthModel = ref('80')
const copiesModel = ref('1')
const dispatchModeModel = ref('direct')
const autoPrintModel = ref(false)
const savedNotice = ref(false)

const printerOptions = computed(() => [
  { value: '', label: t('printing.printerDefault') },
  ...printers.value.map((printer) => ({ value: printer.name, label: printer.displayName }))
])

const paperWidthOptions = [
  { value: '58', label: '58 mm' },
  { value: '80', label: '80 mm' }
]

const copiesOptions = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' }
]

const dispatchModeOptions = computed(() => [
  { value: 'direct', label: t('printing.dispatchModeDirect') },
  { value: 'system_dialog', label: t('printing.dispatchModeSystemDialog') }
])

function syncFormFromSettings(): void {
  const settings = workstationSettings.value
  if (!settings) {
    return
  }
  printerNameModel.value = settings.printerName ?? ''
  paperWidthModel.value = String(settings.paperWidthMm)
  copiesModel.value = String(settings.defaultCopies)
  dispatchModeModel.value = settings.dispatchMode
  autoPrintModel.value = settings.autoPrintAfterSale
}

onMounted(async () => {
  await printingStore.loadSettings()
  await printingStore.loadPrinters()
  syncFormFromSettings()
  await receiptProfileStore.load()
})

async function saveSettings(): Promise<void> {
  const current = workstationSettings.value
  if (!current) {
    return
  }

  const paperWidthMm = Number(paperWidthModel.value) === 58 ? 58 : 80
  savedNotice.value = false
  const ok = await printingStore.saveSettings({
    ...current,
    printerName: printerNameModel.value || null,
    paperWidthMm,
    printableWidthMm: paperWidthMm === 58 ? 48 : 72,
    defaultCopies: Number(copiesModel.value),
    dispatchMode: dispatchModeModel.value === 'system_dialog' ? 'system_dialog' : 'direct',
    autoPrintAfterSale: autoPrintModel.value
  })
  if (ok) {
    syncFormFromSettings()
    savedNotice.value = true
  }
}

const receiptDialogOpen = ref(false)
const receiptDocument = ref<ReceiptDocumentRef | null>(null)

function printTestReceipt(): void {
  receiptDocument.value = { kind: 'test' }
  receiptDialogOpen.value = true
}

function closeReceiptDialog(): void {
  receiptDialogOpen.value = false
}
</script>

<template>
  <section class="settings-page">
    <PageHeader :eyebrow="t('settings.label')" :title="t('settings.title')" />

    <dl v-if="snapshot" class="readiness-list">
      <div>
        <dt>{{ t('settings.appVersion') }}</dt>
        <dd class="numeric">{{ snapshot.runtime.appVersion }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.apiConfiguration') }}</dt>
        <dd>{{ snapshot.runtime.apiConfiguration }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.deviceState') }}</dt>
        <dd>
          {{
            snapshot.device.isRegistered ? t('settings.registered') : t('settings.notRegistered')
          }}
        </dd>
      </div>
    </dl>
    <AppEmptyState v-else :title="t('settings.unavailable')" />

    <section class="settings-page__printer">
      <h2>{{ t('printing.settingsTitle') }}</h2>
      <p class="settings-page__printer-description">{{ t('printing.settingsDescription') }}</p>

      <AppSelect
        v-model="printerNameModel"
        :label="t('printing.printerLabel')"
        :options="printerOptions"
        :disabled="isLoadingPrinters"
      />
      <AppSelect
        v-model="paperWidthModel"
        :label="t('printing.paperWidthLabel')"
        :options="paperWidthOptions"
      />
      <AppSelect
        v-model="copiesModel"
        :label="t('printing.copiesLabel')"
        :options="copiesOptions"
      />
      <AppSelect
        v-model="dispatchModeModel"
        :label="t('printing.dispatchModeLabel')"
        :options="dispatchModeOptions"
      />
      <AppCheckbox
        v-model="autoPrintModel"
        :label="t('printing.autoPrintLabel')"
        :description="t('printing.autoPrintDescription')"
      />

      <AppBanner v-if="errorMessage" variant="error" role="alert">{{ errorMessage }}</AppBanner>
      <AppBanner v-else-if="savedNotice" variant="success" role="status">
        {{ t('printing.settingsSaved') }}
      </AppBanner>

      <div class="settings-page__printer-actions">
        <AppButton variant="secondary" @click="printTestReceipt">
          {{ t('printing.testReceiptAction') }}
        </AppButton>
        <AppButton variant="primary" :loading="isSavingSettings" @click="saveSettings">
          {{ t('printing.saveSettings') }}
        </AppButton>
      </div>
    </section>

    <ReceiptProfileSection v-if="isReceiptProfileVisible" />

    <ReceiptPreviewDialog
      :open="receiptDialogOpen"
      :document="receiptDocument"
      @close="closeReceiptDialog"
    />
  </section>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.settings-page__printer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-md);
  background: var(--color-surface-container-low);
}

.settings-page__printer-description {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.settings-page__printer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
