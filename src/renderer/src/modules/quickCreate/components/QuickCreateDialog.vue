<script setup lang="ts">
/**
 * POS improvements — one compact dialog for adding a customer, a supplier or a product from the
 * register. Essential fields first; optional details expand on demand. Validation mirrors main's
 * contract (main validates again). The record is saved on this register at once and sent to the
 * server in the background; a product becomes sellable only after the catalog refresh brings its
 * server price ("Ready to sell").
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  QuickCreateEntity,
  QuickCreateProductOptions,
  QuickCreateRecord
} from '@shared/contracts/quickCreate.contract'
import {
  quickCreateCustomerInputSchema,
  quickCreateProductInputSchema,
  quickCreateSupplierInputSchema
} from '@shared/contracts/quickCreate.contract'
import AppButton from '../../../shared/components/common/AppButton.vue'
import AppDialog from '../../../shared/components/common/AppDialog.vue'
import AppIcon from '../../../shared/components/common/AppIcon.vue'
import AppInput from '../../../shared/components/forms/AppInput.vue'
import AppSelect from '../../../shared/components/forms/AppSelect.vue'
import AppSwitch from '../../../shared/components/forms/AppSwitch.vue'
import AppInlineError from '../../../shared/components/feedback/AppInlineError.vue'
import { useQuickCreateStore } from '../store'

const props = withDefaults(
  defineProps<{
    open: boolean
    kind: QuickCreateEntity
    /** Prefill for the name (e.g. the customer search text). */
    initialName?: string
    /** Correct and send again: the refused request this replaces (same entity id, new request). */
    resubmitKey?: string | null
  }>(),
  { initialName: '', resubmitKey: null }
)
const emit = defineEmits<{ close: []; created: [record: QuickCreateRecord] }>()

const { t } = useI18n()
const store = useQuickCreateStore()
const busy = ref(false)
const problem = ref<string | null>(null)
const errors = ref<Record<string, string>>({})
const showMore = ref(false)
const options = ref<QuickCreateProductOptions | null>(null)

const form = reactive({
  name: '',
  phone: '',
  email: '',
  taxNumber: '',
  address: '',
  notes: '',
  contactPerson: '',
  price: '',
  categoryUuid: '',
  tax: '',
  barcode: '',
  sku: '',
  unit: '',
  trackStock: true
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    Object.assign(form, {
      name: props.initialName.trim(),
      phone: '',
      email: '',
      taxNumber: '',
      address: '',
      notes: '',
      contactPerson: '',
      price: '',
      categoryUuid: '',
      tax: '',
      barcode: '',
      sku: '',
      unit: '',
      trackStock: true
    })
    errors.value = {}
    problem.value = null
    showMore.value = false
    if (props.kind === 'product') {
      try {
        options.value = await store.productOptions()
        form.categoryUuid = options.value.categories[0]?.uuid ?? ''
      } catch {
        options.value = null
        problem.value = t('quickCreate.optionsUnavailable')
      }
    }
  },
  { immediate: true }
)

const title = computed(() => t(`quickCreate.title.${props.kind}`))
const icon = computed(() =>
  props.kind === 'customer'
    ? 'person_add'
    : props.kind === 'supplier'
      ? 'storefront'
      : 'inventory_2'
)
const categoryOptions = computed(() =>
  (options.value?.categories ?? []).map((category) => ({
    value: category.uuid,
    label: category.name
  }))
)
const taxOptions = computed(() => [
  { value: '', label: t('quickCreate.field.noTax') },
  ...(options.value?.taxes ?? []).flatMap((tax) => [
    {
      value: `${tax.uuid}|inclusive`,
      label: t('quickCreate.field.taxIncluded', { name: tax.name, rate: tax.rateLabel })
    },
    {
      value: `${tax.uuid}|exclusive`,
      label: t('quickCreate.field.taxAdded', { name: tax.name, rate: tax.rateLabel })
    }
  ])
])

function input(): unknown {
  if (props.kind === 'customer') {
    return {
      name: form.name,
      phone: form.phone,
      email: form.email,
      taxNumber: form.taxNumber,
      address: form.address,
      notes: form.notes
    }
  }
  if (props.kind === 'supplier') {
    return {
      name: form.name,
      contactPerson: form.contactPerson,
      phone: form.phone,
      email: form.email,
      taxNumber: form.taxNumber
    }
  }
  const [taxUuid, taxMode] = form.tax === '' ? [null, 'none'] : form.tax.split('|')
  return {
    name: form.name,
    price: form.price,
    categoryUuid: form.categoryUuid,
    taxUuid,
    taxMode,
    barcode: form.barcode,
    sku: form.sku,
    unit: form.unit,
    trackStock: form.trackStock
  }
}

const FIELD_LABEL: Record<string, string> = { taxUuid: 'tax' }

async function submit(): Promise<void> {
  if (busy.value) return
  errors.value = {}
  problem.value = null
  const schema =
    props.kind === 'customer'
      ? quickCreateCustomerInputSchema
      : props.kind === 'supplier'
        ? quickCreateSupplierInputSchema
        : quickCreateProductInputSchema
  const parsed = schema.safeParse(input())
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'name')
      errors.value[FIELD_LABEL[key] ?? key] ??= t(`quickCreate.invalid.${FIELD_LABEL[key] ?? key}`)
    }
    if (Object.keys(errors.value).some((key) => !['name', 'price', 'categoryUuid'].includes(key))) {
      showMore.value = true
    }
    return
  }
  busy.value = true
  try {
    const record = props.resubmitKey
      ? await store.resubmit({
          entityType: props.kind,
          requestKey: props.resubmitKey,
          fields: parsed.data
        } as never)
      : props.kind === 'customer'
        ? await store.createCustomer(parsed.data as never)
        : props.kind === 'supplier'
          ? await store.createSupplier(parsed.data as never)
          : await store.createProduct(parsed.data as never)
    emit('created', record)
  } catch (error) {
    problem.value = (error as { message?: string })?.message ?? t('quickCreate.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    size="md"
    sheet="compact"
    :persistent="busy"
    :close-label="t('common.close')"
    data-testid="quick-create-dialog"
    @close="emit('close')"
  >
    <template #title>
      <span class="flex items-center gap-2"><AppIcon :name="icon" :size="22" />{{ title }}</span>
    </template>
    <form id="quick-create-form" class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <p class="text-sm text-muted">{{ t(`quickCreate.intro.${kind}`) }}</p>
      <AppInput
        v-model="form.name"
        :label="t('quickCreate.field.name')"
        required
        autofocus
        :maxlength="255"
        :error="errors.name"
        data-testid="quick-create-name"
      />
      <template v-if="kind === 'product'">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <AppInput
            v-model="form.price"
            :label="t('quickCreate.field.price')"
            required
            inputmode="decimal"
            dir="ltr"
            :prefix="options?.currency"
            :error="errors.price"
            data-testid="quick-create-price"
          />
          <AppSelect
            v-model="form.categoryUuid"
            :label="t('quickCreate.field.category')"
            :options="categoryOptions"
            required
            :error="errors.categoryUuid"
          />
        </div>
        <AppSelect
          v-model="form.tax"
          :label="t('quickCreate.field.tax')"
          :options="taxOptions"
          :error="errors.tax"
          data-testid="quick-create-tax"
        />
      </template>
      <AppInput
        v-else
        v-model="form.phone"
        :label="t('quickCreate.field.phone')"
        inputmode="tel"
        dir="ltr"
        :maxlength="50"
        :error="errors.phone"
      />

      <button
        type="button"
        class="flex h-11 items-center gap-1.5 self-start rounded-md px-1 text-sm font-semibold text-pri"
        :aria-expanded="showMore ? 'true' : 'false'"
        aria-controls="quick-create-more"
        @click="showMore = !showMore"
      >
        <AppIcon :name="showMore ? 'expand_less' : 'expand_more'" :size="20" />
        {{ showMore ? t('quickCreate.lessDetails') : t('quickCreate.moreDetails') }}
      </button>
      <div v-show="showMore" id="quick-create-more" class="flex flex-col gap-4">
        <template v-if="kind === 'customer'">
          <AppInput
            v-model="form.email"
            :label="t('quickCreate.field.email')"
            type="email"
            inputmode="email"
            dir="ltr"
            :error="errors.email"
          />
          <AppInput
            v-model="form.taxNumber"
            :label="t('quickCreate.field.taxNumber')"
            dir="ltr"
            :maxlength="100"
          />
          <AppInput
            v-model="form.address"
            :label="t('quickCreate.field.address')"
            :maxlength="1000"
          />
          <AppInput v-model="form.notes" :label="t('quickCreate.field.notes')" :maxlength="2000" />
        </template>
        <template v-else-if="kind === 'supplier'">
          <AppInput
            v-model="form.contactPerson"
            :label="t('quickCreate.field.contactPerson')"
            :maxlength="255"
          />
          <AppInput
            v-model="form.email"
            :label="t('quickCreate.field.email')"
            type="email"
            inputmode="email"
            dir="ltr"
            :error="errors.email"
          />
          <AppInput
            v-model="form.taxNumber"
            :label="t('quickCreate.field.taxNumber')"
            dir="ltr"
            :maxlength="100"
          />
        </template>
        <template v-else>
          <AppInput
            v-model="form.barcode"
            :label="t('quickCreate.field.barcode')"
            dir="ltr"
            code
            :maxlength="255"
            :hint="t('quickCreate.field.barcodeHint')"
          />
          <AppInput
            v-model="form.sku"
            :label="t('quickCreate.field.sku')"
            dir="ltr"
            code
            :maxlength="255"
            :hint="t('quickCreate.field.skuHint')"
          />
          <AppInput v-model="form.unit" :label="t('quickCreate.field.unit')" :maxlength="50" />
          <AppSwitch v-model="form.trackStock" :label="t('quickCreate.field.trackStock')" />
        </template>
      </div>
      <p v-if="kind === 'product'" class="text-xs text-muted">{{ t('quickCreate.productNote') }}</p>
      <AppInlineError v-if="problem">{{ problem }}</AppInlineError>
    </form>
    <template #actions>
      <AppButton variant="secondary" :disabled="busy" @click="emit('close')">{{
        t('common.cancel')
      }}</AppButton>
      <AppButton
        type="submit"
        form="quick-create-form"
        :loading="busy"
        data-testid="quick-create-save"
      >
        {{ t(`quickCreate.save.${kind}`) }}
      </AppButton>
    </template>
  </AppDialog>
</template>
