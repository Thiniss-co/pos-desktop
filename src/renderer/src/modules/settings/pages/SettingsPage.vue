<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppEmptyState from '@renderer/shared/components/feedback/AppEmptyState.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import PageContainer from '@renderer/shared/components/layout/PageContainer.vue'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import type { IconName } from '@renderer/shared/components/common/icons.generated'
import AppSegmented from '@renderer/shared/components/forms/AppSegmented.vue'
import AppStepper from '@renderer/shared/components/forms/AppStepper.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import ReceiptPreviewDialog from '@renderer/modules/printing/components/ReceiptPreviewDialog.vue'
import type { PrinterInfo, ReceiptDocumentRef } from '@shared/contracts/printing.contract'
import ReceiptProfileSection from '@renderer/modules/receiptProfile/components/ReceiptProfileSection.vue'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { usePrintingStore } from '@renderer/modules/printing/store'
import { useReceiptProfileStore } from '@renderer/modules/receiptProfile/store'
import TouchModeSwitch from '@renderer/modules/preferences/components/TouchModeSwitch.vue'
import AutoPrintSwitch from '@renderer/modules/preferences/components/AutoPrintSwitch.vue'

const MIN_COPIES = 1
const MAX_COPIES = 3

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
const savedNotice = ref(false)

// ---- Tabs (only rendered when the receipt-profile section is available on this workstation) ----
type SettingsTab = 'workstation' | 'receiptProfile'
const selectedTab = ref<SettingsTab>('workstation')
const activeTab = computed<SettingsTab>(() =>
  isReceiptProfileVisible.value ? selectedTab.value : 'workstation'
)
const tabs = computed<ReadonlyArray<{ key: SettingsTab; label: string; icon: IconName }>>(() => [
  { key: 'workstation', label: t('settings.tabWorkstation'), icon: 'print' },
  { key: 'receiptProfile', label: t('settings.tabReceiptProfile'), icon: 'receipt_long' }
])
const tabRefs = ref<HTMLButtonElement[]>([])

function selectTab(key: SettingsTab): void {
  selectedTab.value = key
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const count = tabs.value.length
  const rtl = (event.currentTarget as HTMLElement).closest('[dir="rtl"]') !== null
  let next: number | null = null
  if (event.key === 'ArrowRight') {
    next = index + (rtl ? -1 : 1)
  } else if (event.key === 'ArrowLeft') {
    next = index + (rtl ? 1 : -1)
  } else if (event.key === 'Home') {
    next = 0
  } else if (event.key === 'End') {
    next = count - 1
  }
  if (next === null) {
    return
  }
  event.preventDefault()
  const target = (next + count) % count
  const tab = tabs.value[target]
  if (!tab) {
    return
  }
  selectTab(tab.key)
  void nextTick(() => tabRefs.value[target]?.focus())
}

// ---- Printer form options (values are exactly the ones the previous selects offered) ----------
function printerStatusLabel(printer: PrinterInfo): string | undefined {
  if (printer.state === 'idle') {
    return t('printing.printerReady')
  }
  if (printer.state === 'busy') {
    return t('printing.printerBusy')
  }
  if (printer.state === 'stopped') {
    return t('printing.printerStopped')
  }
  return undefined
}

const printerOptions = computed(() => {
  const options: Array<{ value: string; label: string; sub?: string; icon: IconName }> = [
    { value: '', label: t('printing.printerDefault'), icon: 'print' },
    ...printers.value.map((printer) => ({
      value: printer.name,
      label: printer.displayName,
      sub: printerStatusLabel(printer),
      icon: 'print' as const
    }))
  ]
  // Keep a saved printer that is no longer installed visible (and focusable) instead of leaving
  // the radio group with no checked option.
  const saved = printerNameModel.value
  if (saved && !isLoadingPrinters.value && !printers.value.some((p) => p.name === saved)) {
    options.push({
      value: saved,
      label: saved,
      sub: t('printing.printerNotFound'),
      icon: 'print_disabled'
    })
  }
  return options
})

const paperWidthOptions = computed(() => [
  { value: '58', label: t('printing.paper58'), sub: t('printing.paper58Sub') },
  { value: '80', label: t('printing.paper80'), sub: t('printing.paper80Sub') }
])

const dispatchModeOptions = computed(() => [
  {
    value: 'direct',
    label: t('printing.dispatchModeDirect'),
    sub: t('printing.dispatchModeDirectSub')
  },
  {
    value: 'system_dialog',
    label: t('printing.dispatchModeSystemDialog'),
    sub: t('printing.dispatchModeSystemDialogSub')
  }
])

const copiesNumber = computed(() => Number(copiesModel.value))

function changeCopies(step: 1 | -1): void {
  const next = Math.min(MAX_COPIES, Math.max(MIN_COPIES, copiesNumber.value + step))
  copiesModel.value = String(next)
}

function syncFormFromSettings(): void {
  const settings = workstationSettings.value
  if (!settings) {
    return
  }
  printerNameModel.value = settings.printerName ?? ''
  paperWidthModel.value = String(settings.paperWidthMm)
  copiesModel.value = String(settings.defaultCopies)
  dispatchModeModel.value = settings.dispatchMode
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
    // POS improvements, Stage 7: the retired workstation flag is kept as stored; the per-user
    // preference alone decides automatic printing (D3).
    autoPrintAfterSale: workstationSettings.value?.autoPrintAfterSale ?? false
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
  <PageContainer class="settings-page">
    <PageHeader :title="t('settings.pageTitle')" :description="t('settings.pageDescription')" />

    <div
      v-if="isReceiptProfileVisible"
      role="tablist"
      :aria-label="t('settings.tabsLabel')"
      class="flex flex-wrap gap-1 border-b border-line"
    >
      <button
        v-for="(tab, index) in tabs"
        :id="`settings-tab-${tab.key}`"
        :key="tab.key"
        ref="tabRefs"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :aria-controls="`settings-panel-${tab.key}`"
        :tabindex="activeTab === tab.key ? 0 : -1"
        class="relative flex h-12 shrink-0 items-center gap-2 rounded-t-md px-3.5 text-base font-semibold whitespace-nowrap transition-colors hover:bg-subtle"
        :class="activeTab === tab.key ? 'text-pri-text' : 'text-ink'"
        @click="selectTab(tab.key)"
        @keydown="onTabKeydown($event, index)"
      >
        <AppIcon :name="tab.icon" :size="20" />
        {{ tab.label }}
        <span
          aria-hidden="true"
          class="absolute inset-x-2 -bottom-px h-0.5 rounded-full"
          :class="activeTab === tab.key ? 'bg-pri' : 'bg-transparent'"
        />
      </button>
    </div>

    <div
      v-show="activeTab === 'workstation'"
      id="settings-panel-workstation"
      :role="isReceiptProfileVisible ? 'tabpanel' : undefined"
      :aria-labelledby="isReceiptProfileVisible ? 'settings-tab-workstation' : undefined"
      :tabindex="isReceiptProfileVisible ? 0 : undefined"
      class="flex flex-wrap items-start gap-4 rounded-lg"
    >
      <AppPanel class="flex-[1_1_300px]" :title="t('settings.workstationDetails')">
        <dl
          v-if="snapshot"
          class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm"
          data-testid="settings-workstation-details"
        >
          <dt class="text-muted">{{ t('settings.serviceConnection') }}</dt>
          <dd class="flex items-center gap-1.5 font-semibold">
            <AppIcon
              :name="
                snapshot.runtime.apiConfiguration === 'configured' ? 'check_circle' : 'warning'
              "
              :size="18"
              :class="snapshot.runtime.apiConfiguration === 'configured' ? 'text-ok' : 'text-warn'"
            />
            {{
              snapshot.runtime.apiConfiguration === 'configured'
                ? t('settings.configured')
                : t('settings.notConfigured')
            }}
          </dd>
          <dt class="text-muted">{{ t('settings.device') }}</dt>
          <dd class="flex items-center gap-1.5 font-semibold">
            <AppIcon
              :name="snapshot.device.isRegistered ? 'check_circle' : 'warning'"
              :size="18"
              :class="snapshot.device.isRegistered ? 'text-ok' : 'text-warn'"
            />
            {{
              snapshot.device.isRegistered
                ? t('settings.deviceRegistered')
                : t('settings.deviceNotRegistered')
            }}
          </dd>
        </dl>
        <AppEmptyState v-else compact :title="t('settings.unavailable')" />
        <p class="flex items-start gap-2 rounded-notice bg-subtle p-3 text-sm">
          <AppIcon name="info" :size="18" class="mt-px text-muted" />
          {{ t('settings.themeNote') }}
        </p>
      </AppPanel>

      <!-- POS improvements, Stage 5: this user's own layout on this register. -->
      <AppPanel
        class="settings-page__touch flex-[1_1_320px]"
        aria-labelledby="settings-touch-title"
      >
        <h2 id="settings-touch-title" class="text-lg font-bold">{{ t('touch.settingsTitle') }}</h2>
        <p class="mt-1 mb-3 text-sm text-muted">{{ t('touch.settingsDescription') }}</p>
        <TouchModeSwitch show-description />
      </AppPanel>

      <AppPanel
        class="settings-page__printer flex-[2_1_520px]"
        :padded="false"
        aria-labelledby="settings-printer-title"
      >
        <div class="px-4.5 pt-4.5">
          <h2 id="settings-printer-title" class="text-lg font-bold">
            {{ t('printing.settingsTitle') }}
          </h2>
          <p class="mt-1 text-sm text-muted">{{ t('printing.settingsDescription') }}</p>
        </div>

        <div class="flex flex-col gap-4.5 px-4.5 py-4">
          <AppSegmented
            v-model="printerNameModel"
            layout="stack"
            :label="t('printing.printerLabel')"
            :options="printerOptions"
            :disabled="isLoadingPrinters"
          />
          <p v-if="isLoadingPrinters" role="status" class="-mt-3 text-xs text-muted">
            {{ t('printing.printersLoading') }}
          </p>

          <AppSegmented
            v-model="paperWidthModel"
            :label="t('printing.paperWidthLabel')"
            :options="paperWidthOptions"
            :columns="2"
          />

          <div class="flex flex-wrap gap-6">
            <div class="flex flex-col gap-1.5">
              <span class="text-sm font-semibold" aria-hidden="true">
                {{ t('printing.copiesLabel') }}
              </span>
              <AppStepper
                width="md"
                :value="copiesModel"
                :group-label="t('printing.copiesLabel')"
                :decrease-label="t('printing.copiesDecrease')"
                :increase-label="t('printing.copiesIncrease')"
                :decrease-disabled="copiesNumber <= MIN_COPIES"
                :increase-disabled="copiesNumber >= MAX_COPIES"
                @decrease="changeCopies(-1)"
                @increase="changeCopies(1)"
              />
              <span class="text-xs text-muted">{{ t('printing.copiesHelp') }}</span>
            </div>
            <AppSegmented
              v-model="dispatchModeModel"
              class="min-w-65 flex-1"
              :label="t('printing.dispatchModeLabel')"
              :options="dispatchModeOptions"
              :columns="2"
            />
          </div>

          <AutoPrintSwitch show-description />

          <AppBanner v-if="errorMessage" variant="error" role="alert">{{ errorMessage }}</AppBanner>
          <AppBanner v-else-if="savedNotice" variant="success" role="status">
            {{ t('printing.settingsSaved') }}
          </AppBanner>
        </div>

        <div class="flex flex-wrap justify-end gap-2.5 border-t border-line px-4.5 py-3.5">
          <AppButton variant="secondary" icon="receipt_long" @click="printTestReceipt">
            {{ t('printing.testReceiptAction') }}
          </AppButton>
          <AppButton
            variant="primary"
            icon="save"
            :loading="isSavingSettings"
            @click="saveSettings"
          >
            {{ t('printing.saveSettings') }}
          </AppButton>
        </div>
      </AppPanel>
    </div>

    <div
      v-if="isReceiptProfileVisible"
      v-show="activeTab === 'receiptProfile'"
      id="settings-panel-receiptProfile"
      role="tabpanel"
      aria-labelledby="settings-tab-receiptProfile"
      tabindex="0"
      class="rounded-lg"
    >
      <ReceiptProfileSection />
    </div>

    <ReceiptPreviewDialog
      :open="receiptDialogOpen"
      :document="receiptDocument"
      @close="closeReceiptDialog"
    />
  </PageContainer>
</template>
