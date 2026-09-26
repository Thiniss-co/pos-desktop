import { ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  PrinterInfo,
  PrinterSettings,
  PrinterSettingsOverrides,
  PrintJobView,
  PrintPreviewOutput,
  ReceiptDocumentRef
} from '@shared/contracts/printing.contract'
import { PrintingService } from './service'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'

function randomRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Receipt-printing plan -- the printing flow's renderer-side state. `currentRequestId` is created
 * ONCE per explicit user action and reused on retry (never regenerated), so a transport failure
 * followed by a retry replays the SAME request rather than risking a duplicate dispatch.
 */
export const usePrintingStore = defineStore('printing', () => {
  const workstationSettings = ref<PrinterSettings | null>(null)
  const printers = ref<PrinterInfo[]>([])
  const isLoadingPrinters = ref(false)
  const isSavingSettings = ref(false)

  const preview = ref<PrintPreviewOutput | null>(null)
  const isPreviewing = ref(false)
  const previewDocument = ref<ReceiptDocumentRef | null>(null)
  const previewLocale = ref<'en' | 'ar'>('en')
  const previewOverrides = ref<PrinterSettingsOverrides>({})

  const currentRequestId = ref<string | null>(null)
  const jobStatus = ref<PrintJobView | null>(null)
  const isDispatching = ref(false)

  const errorRef = createLocalizedErrorRef()

  function reportError(error: unknown, fallbackKey = 'errors.generic'): void {
    const parsed = parsePublicAppError(error)
    if (parsed) {
      errorRef.setDetail(parsed)
    } else {
      errorRef.setFallbackKey(fallbackKey)
    }
  }

  async function loadSettings(service: PrintingService = new PrintingService()): Promise<void> {
    try {
      workstationSettings.value = await service.getWorkstationSettings()
    } catch (error) {
      reportError(error)
    }
  }

  async function saveSettings(
    settings: PrinterSettings,
    service: PrintingService = new PrintingService()
  ): Promise<boolean> {
    isSavingSettings.value = true
    try {
      workstationSettings.value = await service.saveWorkstationSettings(settings)
      errorRef.clear()
      return true
    } catch (error) {
      reportError(error)
      return false
    } finally {
      isSavingSettings.value = false
    }
  }

  async function loadPrinters(service: PrintingService = new PrintingService()): Promise<void> {
    isLoadingPrinters.value = true
    try {
      printers.value = await service.listPrinters()
    } catch (error) {
      reportError(error)
    } finally {
      isLoadingPrinters.value = false
    }
  }

  async function openPreview(
    document: ReceiptDocumentRef,
    locale: 'en' | 'ar',
    overrides: PrinterSettingsOverrides = {},
    service: PrintingService = new PrintingService()
  ): Promise<void> {
    previewDocument.value = document
    previewLocale.value = locale
    previewOverrides.value = overrides
    isPreviewing.value = true
    jobStatus.value = null
    currentRequestId.value = null
    try {
      preview.value = await service.preview({ document, locale, overrides })
      errorRef.clear()
    } catch (error) {
      preview.value = null
      reportError(error)
    } finally {
      isPreviewing.value = false
    }
  }

  async function refreshPreview(service: PrintingService = new PrintingService()): Promise<void> {
    if (!previewDocument.value) {
      return
    }
    await openPreview(previewDocument.value, previewLocale.value, previewOverrides.value, service)
  }

  /** Prints the currently-open preview. Reuses `currentRequestId` on retry -- never regenerates it
   *  for the same user action, so a transport failure and a subsequent retry are the exact same
   *  request (plan: exact replay reads the stored outcome, never rebuilds or redispatches). */
  async function print(service: PrintingService = new PrintingService()): Promise<void> {
    if (!preview.value || !previewDocument.value || isDispatching.value) {
      return
    }

    if (!currentRequestId.value) {
      currentRequestId.value = randomRequestId()
    }

    isDispatching.value = true
    try {
      jobStatus.value = await service.dispatch({
        requestId: currentRequestId.value,
        document: previewDocument.value,
        locale: previewLocale.value,
        overrides: previewOverrides.value,
        preview: {
          previewDocumentSha256: preview.value.previewDocumentSha256,
          previewOptionsSha256: preview.value.previewOptionsSha256
        }
      })
      errorRef.clear()
    } catch (error) {
      const parsed = parsePublicAppError(error)
      if (parsed?.backendCode === 'receipt_preview_stale') {
        // The document or settings changed since this preview was taken -- refresh and require a
        // new, explicit click rather than silently substituting content.
        currentRequestId.value = null
        await refreshPreview(service)
        errorRef.setFallbackKey('printing.errors.previewStale')
      } else {
        reportError(error)
      }
    } finally {
      isDispatching.value = false
    }
  }

  async function cancel(service: PrintingService = new PrintingService()): Promise<void> {
    if (!currentRequestId.value) {
      return
    }
    try {
      jobStatus.value = await service.cancelJob(currentRequestId.value)
    } catch (error) {
      reportError(error)
    }
  }

  function closePreview(): void {
    preview.value = null
    previewDocument.value = null
    jobStatus.value = null
    currentRequestId.value = null
    errorRef.clear()
  }

  return {
    workstationSettings,
    printers,
    isLoadingPrinters,
    isSavingSettings,
    preview,
    isPreviewing,
    previewDocument,
    currentRequestId,
    jobStatus,
    isDispatching,
    error: errorRef,
    loadSettings,
    saveSettings,
    loadPrinters,
    openPreview,
    refreshPreview,
    print,
    cancel,
    closePreview
  }
})
