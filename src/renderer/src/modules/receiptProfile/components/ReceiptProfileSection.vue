<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIconButton from '@renderer/shared/components/common/AppIconButton.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import { useReceiptProfileStore } from '../store'

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

const form = reactive({
  addressLines: [] as string[],
  phone: '',
  taxIdentifierLabel: '',
  taxIdentifierValue: '',
  footerLines: [] as string[]
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
  await store.save({
    addressLines: form.addressLines,
    phone: form.phone,
    taxIdentifierLabel: form.taxIdentifierLabel,
    taxIdentifierValue: form.taxIdentifierValue,
    footerLines: form.footerLines
  })
}
</script>

<template>
  <section class="receipt-profile">
    <h2>{{ t('receiptProfile.title') }}</h2>
    <p class="receipt-profile__description">{{ t('receiptProfile.description') }}</p>

    <AppBanner v-if="!isOnline" variant="warning" role="status">
      {{ t('receiptProfile.offlineNotice') }}
    </AppBanner>

    <div v-if="isLoading" class="receipt-profile__loading">{{ t('receiptProfile.loading') }}</div>

    <template v-else>
      <div class="receipt-profile__logo">
        <span class="receipt-profile__logo-label">{{ t('receiptProfile.logoLabel') }}</span>
        <div class="receipt-profile__logo-preview">
          <img
            v-if="displayedLogo?.thumbnailPngDataUrl"
            :src="displayedLogo.thumbnailPngDataUrl"
            :alt="t('receiptProfile.logoLabel')"
          />
          <span v-else class="receipt-profile__logo-empty">{{ t('receiptProfile.noLogo') }}</span>
        </div>
        <div class="receipt-profile__logo-actions">
          <AppButton
            variant="secondary"
            :loading="isChoosingLogo"
            :disabled="!isOnline"
            @click="onChooseLogo"
          >
            {{ t('receiptProfile.chooseLogo') }}
          </AppButton>
          <AppButton
            v-if="displayedLogo"
            variant="ghost"
            :disabled="!isOnline"
            @click="store.removeLogo()"
          >
            {{ t('receiptProfile.removeLogo') }}
          </AppButton>
          <AppButton
            v-if="store.hasPendingLogoChange"
            variant="ghost"
            @click="store.undoLogoChange()"
          >
            {{ t('receiptProfile.undoLogoChange') }}
          </AppButton>
        </div>
      </div>

      <fieldset class="receipt-profile__lines">
        <legend>{{ t('receiptProfile.addressLinesLabel') }}</legend>
        <div v-for="(line, index) in form.addressLines" :key="index" class="receipt-profile__line">
          <AppInput
            v-model="form.addressLines[index]"
            :label="t('receiptProfile.addressLineNumberLabel', { number: index + 1 })"
            :maxlength="ADDRESS_LINE_MAX_LENGTH"
          />
          <span class="receipt-profile__counter"
            >{{ line.length }}/{{ ADDRESS_LINE_MAX_LENGTH }}</span
          >
          <AppIconButton
            :label="t('receiptProfile.removeLine')"
            variant="danger"
            @click="removeAddressLine(index)"
          >
            &minus;
          </AppIconButton>
        </div>
        <AppButton
          v-if="form.addressLines.length < MAX_ADDRESS_LINES"
          variant="ghost"
          @click="addAddressLine"
        >
          {{ t('receiptProfile.addLine') }}
        </AppButton>
      </fieldset>

      <AppInput
        v-model="form.phone"
        :label="t('receiptProfile.phoneLabel')"
        :maxlength="PHONE_MAX_LENGTH"
      />
      <AppInput
        v-model="form.taxIdentifierLabel"
        :label="t('receiptProfile.taxIdentifierLabelLabel')"
        :maxlength="TAX_LABEL_MAX_LENGTH"
      />
      <AppInput
        v-model="form.taxIdentifierValue"
        :label="t('receiptProfile.taxIdentifierValueLabel')"
        :maxlength="TAX_VALUE_MAX_LENGTH"
      />

      <fieldset class="receipt-profile__lines">
        <legend>{{ t('receiptProfile.footerLinesLabel') }}</legend>
        <div v-for="(line, index) in form.footerLines" :key="index" class="receipt-profile__line">
          <AppInput
            v-model="form.footerLines[index]"
            :label="t('receiptProfile.footerLineNumberLabel', { number: index + 1 })"
            :maxlength="FOOTER_LINE_MAX_LENGTH"
          />
          <span class="receipt-profile__counter"
            >{{ line.length }}/{{ FOOTER_LINE_MAX_LENGTH }}</span
          >
          <AppIconButton
            :label="t('receiptProfile.removeLine')"
            variant="danger"
            @click="removeFooterLine(index)"
          >
            &minus;
          </AppIconButton>
        </div>
        <AppButton
          v-if="form.footerLines.length < MAX_FOOTER_LINES"
          variant="ghost"
          @click="addFooterLine"
        >
          {{ t('receiptProfile.addLine') }}
        </AppButton>
      </fieldset>

      <AppBanner v-if="errorMessage" variant="error" role="alert">{{ errorMessage }}</AppBanner>
      <AppBanner v-else-if="conflictNotice" variant="warning" role="status">
        {{ t('receiptProfile.conflictReloaded') }}
      </AppBanner>
      <AppBanner v-else-if="savedNotice" variant="success" role="status">
        {{ t('receiptProfile.saved') }}
      </AppBanner>

      <div class="receipt-profile__actions">
        <AppButton variant="primary" :loading="isSaving" :disabled="!isOnline" @click="onSave">
          {{ t('receiptProfile.save') }}
        </AppButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.receipt-profile {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-outline-variant);
  border-radius: var(--radius-md);
  background: var(--color-surface-container-low);
}

.receipt-profile__description {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.receipt-profile__loading {
  color: var(--color-on-surface-variant);
}

.receipt-profile__logo {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.receipt-profile__logo-label {
  font-weight: 600;
}

.receipt-profile__logo-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  border: 1px dashed var(--color-outline-variant);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.receipt-profile__logo-preview img {
  max-width: 100%;
  max-height: 100%;
}

.receipt-profile__logo-empty {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
  text-align: center;
  padding: 0 var(--space-2);
}

.receipt-profile__logo-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.receipt-profile__lines {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: none;
  padding: 0;
  margin: 0;
}

.receipt-profile__lines legend {
  font-weight: 600;
  padding: 0;
}

.receipt-profile__line {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
}

.receipt-profile__line > :first-child {
  flex: 1;
}

.receipt-profile__counter {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
  white-space: nowrap;
  padding-bottom: var(--space-2);
}

.receipt-profile__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
