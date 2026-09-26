import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ReceiptProfileGetOutput } from '@shared/contracts/printing.contract'
import { ReceiptProfileService } from './service'
import { createLocalizedErrorRef } from '@renderer/shared/utils/localizedErrorRef'
import { parsePublicAppError } from '@renderer/shared/utils/parsePublicAppError'

export interface ReceiptProfileFieldsDraft {
  addressLines: string[]
  phone: string
  taxIdentifierLabel: string
  taxIdentifierValue: string
  footerLines: string[]
}

function emptyDraft(): ReceiptProfileFieldsDraft {
  return {
    addressLines: [],
    phone: '',
    taxIdentifierLabel: '',
    taxIdentifierValue: '',
    footerLines: []
  }
}

function draftFrom(profile: ReceiptProfileGetOutput['profile']): ReceiptProfileFieldsDraft {
  if (!profile) {
    return emptyDraft()
  }
  return {
    addressLines: [...profile.addressLines],
    phone: profile.phone ?? '',
    taxIdentifierLabel: profile.taxIdentifierLabel ?? '',
    taxIdentifierValue: profile.taxIdentifierValue ?? '',
    footerLines: [...profile.footerLines]
  }
}

/**
 * Receipt-printing plan §D-11 -- the CompanyAdmin receipt-profile editor's renderer-side state.
 * The server-mirrored `profile` is the source of truth; `draft` is the form the operator is
 * editing, explicitly synced from `profile` on load and after every successful save so a stale
 * edit is never silently carried forward across a revision-conflict reload.
 */
export const useReceiptProfileStore = defineStore('receiptProfile', () => {
  const state = ref<ReceiptProfileGetOutput | null>(null)
  const draft = ref<ReceiptProfileFieldsDraft>(emptyDraft())
  const isLoading = ref(false)
  const isSaving = ref(false)
  const isChoosingLogo = ref(false)

  /** A newly uploaded logo not yet published -- overrides `state.logo` for display purposes only. */
  const pendingLogo = ref<{ sha256: string; thumbnailPngDataUrl: string } | null>(null)
  const logoRemoveRequested = ref(false)
  const savedNotice = ref(false)
  const conflictNotice = ref(false)

  const errorRef = createLocalizedErrorRef()

  const capability = computed(() => state.value?.capability ?? 'unsupported')
  const canManage = computed(() => state.value?.canManage ?? false)
  const isVisible = computed(() => capability.value === 'supported' && canManage.value)
  const expectedRevision = computed(() => state.value?.profile?.revision ?? 0)
  const displayedLogo = computed(() => {
    if (logoRemoveRequested.value) {
      return null
    }
    if (pendingLogo.value) {
      return { present: true, thumbnailPngDataUrl: pendingLogo.value.thumbnailPngDataUrl }
    }
    return state.value?.logo ?? null
  })

  function reportError(error: unknown, fallbackKey = 'errors.generic'): void {
    const parsed = parsePublicAppError(error)
    if (parsed) {
      errorRef.setDetail(parsed)
    } else {
      errorRef.setFallbackKey(fallbackKey)
    }
  }

  function resetDraftFromState(): void {
    draft.value = draftFrom(state.value?.profile ?? null)
    pendingLogo.value = null
    logoRemoveRequested.value = false
  }

  async function load(service: ReceiptProfileService = new ReceiptProfileService()): Promise<void> {
    isLoading.value = true
    try {
      state.value = await service.get()
      resetDraftFromState()
      errorRef.clear()
    } catch (error) {
      reportError(error)
    } finally {
      isLoading.value = false
    }
  }

  async function chooseLogo(
    service: ReceiptProfileService = new ReceiptProfileService()
  ): Promise<void> {
    isChoosingLogo.value = true
    try {
      const chosen = await service.chooseLogo()
      pendingLogo.value = chosen
      logoRemoveRequested.value = false
      errorRef.clear()
    } catch (error) {
      // A cancelled file dialog is not an error worth showing; every other failure is.
      const parsed = parsePublicAppError(error)
      if (parsed && parsed.category === 'validation' && !parsed.backendCode) {
        return
      }
      reportError(error)
    } finally {
      isChoosingLogo.value = false
    }
  }

  function removeLogo(): void {
    pendingLogo.value = null
    logoRemoveRequested.value = true
  }

  function undoLogoChange(): void {
    pendingLogo.value = null
    logoRemoveRequested.value = false
  }

  async function save(
    fields: ReceiptProfileFieldsDraft,
    service: ReceiptProfileService = new ReceiptProfileService()
  ): Promise<boolean> {
    isSaving.value = true
    savedNotice.value = false
    conflictNotice.value = false

    const logo = pendingLogo.value
      ? ({ action: 'set', sha256: pendingLogo.value.sha256 } as const)
      : logoRemoveRequested.value
        ? ({ action: 'remove' } as const)
        : ({ action: 'keep' } as const)

    try {
      state.value = await service.publish({
        expectedRevision: expectedRevision.value,
        fields: {
          addressLines: fields.addressLines.map((line) => line.trim()).filter(Boolean),
          phone: fields.phone.trim() || null,
          taxIdentifierLabel: fields.taxIdentifierLabel.trim() || null,
          taxIdentifierValue: fields.taxIdentifierValue.trim() || null,
          footerLines: fields.footerLines.map((line) => line.trim()).filter(Boolean)
        },
        logo
      })
      resetDraftFromState()
      errorRef.clear()
      savedNotice.value = true
      return true
    } catch (error) {
      const parsed = parsePublicAppError(error)
      if (parsed?.backendCode === 'RECEIPT_PROFILE_REVISION_CONFLICT') {
        // Main already refreshed the mirror from bootstrap before rethrowing -- pull the newer
        // version now so the operator reviews it instead of blindly retrying a stale edit.
        await load(service)
        conflictNotice.value = true
      } else {
        reportError(error)
      }
      return false
    } finally {
      isSaving.value = false
    }
  }

  return {
    state,
    draft,
    isLoading,
    isSaving,
    isChoosingLogo,
    savedNotice,
    conflictNotice,
    error: errorRef,
    capability,
    canManage,
    isVisible,
    displayedLogo,
    load,
    chooseLogo,
    removeLogo,
    undoLogoChange,
    hasPendingLogoChange: computed(() => pendingLogo.value !== null || logoRemoveRequested.value),
    save
  }
})
