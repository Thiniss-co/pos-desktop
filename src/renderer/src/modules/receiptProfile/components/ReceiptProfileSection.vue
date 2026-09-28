<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import AppPanel from '@renderer/shared/components/common/AppPanel.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppStatusChip from '@renderer/shared/components/feedback/AppStatusChip.vue'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { useReceiptProfileStore, type ReceiptProfileFieldsDraft } from '../store'

const MAX_ADDRESS_LINES = 4
const MAX_FOOTER_LINES = 3
const ADDRESS_LINE_MAX_LENGTH = 80
const FOOTER_LINE_MAX_LENGTH = 80
const PHONE_MAX_LENGTH = 40
const TAX_LABEL_MAX_LENGTH = 24
const TAX_VALUE_MAX_LENGTH = 40

const { t } = useI18n()
const store = useReceiptProfileStore()
const { draft, isLoading, isSaving, isChoosingLogo, savedNotice, conflictNotice, displayedLogo } =
  storeToRefs(store)
const errorMessage = computed(() => store.error.error)

const connectivity = useConnectivityStore()
const { snapshot } = storeToRefs(connectivity)
const isOnline = computed(() => snapshot.value?.status === 'online')
const isFormDisabled = computed(() => !isOnline.value || isSaving.value)

const form = reactive({
  addressLines: [] as string[],
  phone: '',
  taxIdentifierLabel: '',
  taxIdentifierValue: '',
  footerLines: [] as string[]
})

/** The fields the operator last submitted, kept only to show them back after a revision
 *  conflict (the store reloads the newer version into the form). Display-only. */
const lastSubmitted = ref<ReceiptProfileFieldsDraft | null>(null)
const unsavedLines = computed(() => {
  const fields = lastSubmitted.value
  if (!fields) {
    return []
  }
  const tax = [fields.taxIdentifierLabel.trim(), fields.taxIdentifierValue.trim()]
    .filter(Boolean)
    .join(': ')
  return [...fields.addressLines, fields.phone, tax, ...fields.footerLines]
    .map((line) => line.trim())
    .filter(Boolean)
})

function syncFormFromDraft(): void {
  form.addressLines = [...draft.value.addressLines]
  form.phone = draft.value.phone
  form.taxIdentifierLabel = draft.value.taxIdentifierLabel
  form.taxIdentifierValue = draft.value.taxIdentifierValue
  form.footerLines = [...draft.value.footerLines]
}

watch(draft, syncFormFromDraft, { immediate: true })

function addAddressLine(): void {
  if (form.addressLines.length < MAX_ADDRESS_LINES) {
    form.addressLines.push('')
  }
}

function removeAddressLine(index: number): void {
  form.addressLines.splice(index, 1)
}

function addFooterLine(): void {
  if (form.footerLines.length < MAX_FOOTER_LINES) {
    form.footerLines.push('')
  }
}

function removeFooterLine(index: number): void {
  form.footerLines.splice(index, 1)
}

async function onChooseLogo(): Promise<void> {
  await store.chooseLogo()
}

async function onSave(): Promise<void> {
  const fields: ReceiptProfileFieldsDraft = {
    addressLines: form.addressLines,
    phone: form.phone,
    taxIdentifierLabel: form.taxIdentifierLabel,
    taxIdentifierValue: form.taxIdentifierValue,
    footerLines: form.footerLines
  }
  lastSubmitted.value = {
    ...fields,
    addressLines: [...fields.addressLines],
    footerLines: [...fields.footerLines]
  }
  await store.save(fields)
}

// ---- Live header/footer preview (display only; the printed receipt is rendered by main) -------
const previewAddress = computed(() => form.addressLines.map((l) => l.trim()).filter(Boolean))
const previewFooter = computed(() => form.footerLines.map((l) => l.trim()).filter(Boolean))
const previewPhone = computed(() => form.phone.trim())
const previewTax = computed(() =>
  [form.taxIdentifierLabel.trim(), form.taxIdentifierValue.trim()].filter(Boolean).join(': ')
)
const previewLogoUrl = computed(() => displayedLogo.value?.thumbnailPngDataUrl ?? null)
const previewIsEmpty = computed(
  () =>
    !displayedLogo.value &&
    previewAddress.value.length === 0 &&
    previewFooter.value.length === 0 &&
    !previewPhone.value &&
    !previewTax.value
)
</script>

<template>
  <section class="receipt-profile flex flex-col gap-4" aria-labelledby="receipt-profile-title">
    <AppBanner v-if="!isOnline" variant="neutral" icon="wifi_off" role="status">
      {{ t('receiptProfile.offlineNotice') }}
    </AppBanner>

    <AppBanner v-if="conflictNotice" variant="warning" icon="sync_problem" role="alert">
      <div class="flex flex-col gap-1.5">
        <span class="font-semibold">{{ t('receiptProfile.conflictReloaded') }}</span>
        <template v-if="unsavedLines.length > 0">
          <span class="font-bold">{{ t('receiptProfile.yourChanges') }}</span>
          <span
            v-for="(line, index) in unsavedLines"
            :key="index"
            dir="auto"
            class="border-s-2 border-warn ps-2.5"
          >
            {{ line }}
          </span>
        </template>
      </div>
    </AppBanner>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-4">
      <AppPanel :padded="false">
        <div class="flex flex-wrap items-start gap-2.5 px-4.5 pt-4.5">
          <div class="min-w-50 flex-1">
            <h2 id="receipt-profile-title" class="text-lg font-bold">
              {{ t('receiptProfile.title') }}
            </h2>
            <p class="mt-1 text-sm text-muted">{{ t('receiptProfile.description') }}</p>
          </div>
          <AppStatusChip variant="information" icon="wifi" size="sm">
            {{ t('receiptProfile.onlineRequired') }}
          </AppStatusChip>
        </div>

        <div v-if="isLoading" class="px-4.5 py-4">
          <AppLoadingSkeleton :label="t('receiptProfile.loading')" />
        </div>

        <template v-else>
          <fieldset
            :disabled="isFormDisabled"
            class="m-0 flex min-w-0 flex-col gap-4 border-0 px-4.5 py-4"
          >
            <div class="flex flex-col gap-1.5">
              <span class="text-sm font-semibold">{{ t('receiptProfile.logoLabel') }}</span>
              <div class="flex flex-wrap items-center gap-3">
                <span
                  class="flex size-14 flex-none items-center justify-center overflow-hidden rounded-md border border-dashed border-line-strong bg-paper text-paper-ink"
                >
                  <img
                    v-if="previewLogoUrl"
                    :src="previewLogoUrl"
                    :alt="t('receiptProfile.logoLabel')"
                    class="max-h-full max-w-full"
                  />
                  <AppIcon
                    v-else-if="displayedLogo?.present"
                    name="image"
                    :size="24"
                    :label="t('receiptProfile.logoLabel')"
                  />
                  <span v-else class="px-1 text-center text-xs font-medium">
                    {{ t('receiptProfile.noLogo') }}
                  </span>
                </span>
                <AppButton
                  variant="secondary"
                  size="sm"
                  :loading="isChoosingLogo"
                  :disabled="!isOnline"
                  @click="onChooseLogo"
                >
                  {{ t('receiptProfile.chooseLogo') }}
                </AppButton>
                <AppButton
                  v-if="displayedLogo"
                  variant="ghost"
                  size="sm"
                  class="text-err!"
                  :disabled="!isOnline"
                  @click="store.removeLogo()"
                >
                  {{ t('receiptProfile.removeLogo') }}
                </AppButton>
                <template v-if="store.hasPendingLogoChange">
                  <span class="text-xs font-semibold text-warn" role="status">
                    {{
                      displayedLogo
                        ? t('receiptProfile.logoPendingNew')
                        : t('receiptProfile.logoPendingRemove')
                    }}
                  </span>
                  <AppButton
                    variant="ghost"
                    size="sm"
                    icon="undo"
                    class="text-pri-text!"
                    @click="store.undoLogoChange()"
                  >
                    {{ t('receiptProfile.undoLogoChange') }}
                  </AppButton>
                </template>
              </div>
            </div>

            <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend class="mb-1.5 p-0 text-sm font-semibold">
                {{ t('receiptProfile.addressLinesLabel', { max: MAX_ADDRESS_LINES }) }}
              </legend>
              <div
                v-for="(line, index) in form.addressLines"
                :key="index"
                class="flex items-start gap-1.5"
              >
                <AppInput
                  v-model="form.addressLines[index]"
                  class="flex-1"
                  hide-label
                  dir="auto"
                  :label="t('receiptProfile.addressLineNumberLabel', { number: index + 1 })"
                  :maxlength="ADDRESS_LINE_MAX_LENGTH"
                  :hint="`${line.length}/${ADDRESS_LINE_MAX_LENGTH}`"
                />
                <AppIconButton
                  icon="close"
                  variant="outline"
                  class="size-11!"
                  :label="t('receiptProfile.removeAddressLine', { number: index + 1 })"
                  @click="removeAddressLine(index)"
                />
              </div>
              <AppButton
                v-if="form.addressLines.length < MAX_ADDRESS_LINES"
                variant="ghost"
                size="sm"
                icon="add"
                class="self-start text-pri-text!"
                @click="addAddressLine"
              >
                {{ t('receiptProfile.addLine') }}
              </AppButton>
            </fieldset>

            <AppInput
              v-model="form.phone"
              dir="ltr"
              inputmode="tel"
              :label="t('receiptProfile.phoneLabel')"
              :maxlength="PHONE_MAX_LENGTH"
            />

            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5">
              <AppInput
                v-model="form.taxIdentifierLabel"
                :label="t('receiptProfile.taxIdentifierLabelLabel')"
                :maxlength="TAX_LABEL_MAX_LENGTH"
              />
              <AppInput
                v-model="form.taxIdentifierValue"
                code
                :label="t('receiptProfile.taxIdentifierValueLabel')"
                :maxlength="TAX_VALUE_MAX_LENGTH"
              />
            </div>

            <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend class="mb-1.5 p-0 text-sm font-semibold">
                {{ t('receiptProfile.footerLinesLabel', { max: MAX_FOOTER_LINES }) }}
              </legend>
              <div
                v-for="(line, index) in form.footerLines"
                :key="index"
                class="flex items-start gap-1.5"
              >
                <AppInput
                  v-model="form.footerLines[index]"
                  class="flex-1"
                  hide-label
                  dir="auto"
                  :label="t('receiptProfile.footerLineNumberLabel', { number: index + 1 })"
                  :maxlength="FOOTER_LINE_MAX_LENGTH"
                  :hint="`${line.length}/${FOOTER_LINE_MAX_LENGTH}`"
                />
                <AppIconButton
                  icon="close"
                  variant="outline"
                  class="size-11!"
                  :label="t('receiptProfile.removeFooterLine', { number: index + 1 })"
                  @click="removeFooterLine(index)"
                />
              </div>
              <AppButton
                v-if="form.footerLines.length < MAX_FOOTER_LINES"
                variant="ghost"
                size="sm"
                icon="add"
                class="self-start text-pri-text!"
                @click="addFooterLine"
              >
                {{ t('receiptProfile.addLine') }}
              </AppButton>
            </fieldset>
          </fieldset>

          <div v-if="errorMessage" class="px-4.5 pb-4">
            <AppBanner variant="error" role="alert">{{ errorMessage }}</AppBanner>
          </div>

          <div
            class="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-4.5 py-3.5"
          >
            <span
              v-if="savedNotice && !errorMessage && !conflictNotice"
              role="status"
              class="me-auto flex items-center gap-1.5 text-sm font-semibold text-ok"
            >
              <AppIcon name="check_circle" :size="18" />
              {{ t('receiptProfile.saved') }}
            </span>
            <AppButton
              variant="primary"
              icon="save"
              :loading="isSaving"
              :disabled="!isOnline"
              @click="onSave"
            >
              {{ t('receiptProfile.save') }}
            </AppButton>
          </div>
        </template>
      </AppPanel>

      <AppPanel class="items-center" aria-labelledby="receipt-profile-preview-title">
        <h2 id="receipt-profile-preview-title" class="self-stretch text-lg font-bold">
          {{ t('receiptProfile.previewTitle') }}
        </h2>
        <div
          class="receipt-profile__paper flex w-[302px] max-w-full flex-col items-center gap-0.5 bg-paper px-3.5 py-4 text-center font-[family-name:var(--font-code)] text-xs leading-[1.45] text-paper-ink shadow-panel"
          data-testid="receipt-profile-preview"
        >
          <img
            v-if="previewLogoUrl"
            :src="previewLogoUrl"
            :alt="t('receiptProfile.logoLabel')"
            class="mb-1 max-h-16 max-w-[60%]"
          />
          <div v-for="(line, index) in previewAddress" :key="`a-${index}`" dir="auto">
            {{ line }}
          </div>
          <div v-if="previewPhone" dir="ltr">{{ previewPhone }}</div>
          <div v-if="previewTax" dir="auto">{{ previewTax }}</div>
          <div
            v-if="!previewIsEmpty"
            aria-hidden="true"
            class="my-2 self-stretch border-t border-dashed border-paper-ink"
          />
          <div v-for="(line, index) in previewFooter" :key="`f-${index}`" dir="auto">
            {{ line }}
          </div>
          <div v-if="previewIsEmpty">{{ t('receiptProfile.previewEmpty') }}</div>
        </div>
        <p class="text-center text-xs text-muted">{{ t('receiptProfile.previewNote') }}</p>
      </AppPanel>
    </div>
  </section>
</template>
