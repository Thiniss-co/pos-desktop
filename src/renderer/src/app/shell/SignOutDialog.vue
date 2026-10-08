<script setup lang="ts">
/**
 * Sign-out confirmation (V3 `so_*`). Signing out uses the exact sequence the shell always used —
 * auth logout, clear the draft and payment, re-resolve startup — and warns when sales are still
 * queued: they stay saved on this workstation and upload after the next sign in.
 */
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppDialog from '@renderer/shared/components/common/AppDialog.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '@renderer/modules/auth/store'
import { useCartStore } from '@renderer/modules/pos/cart.store'
import { usePaymentStore } from '@renderer/modules/pos/payment.store'
import { useCatalogStore } from '@renderer/modules/pos/catalog.store'
import { useSyncStore } from '@renderer/modules/sync/store'
import { useRefundsStore } from '@renderer/modules/refunds/store'
import { getStartupRouteName } from '../router/guards'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const auth = useAuthStore()
const cart = useCartStore()
const payment = usePaymentStore()
const catalog = useCatalogStore()
const startup = useStartupStore()
const sync = useSyncStore()
const router = useRouter()
const { isSubmitting } = storeToRefs(auth)
const queued = computed(() => sync.queuedCount)
const signingOut = ref(false)

async function confirm(): Promise<void> {
  signingOut.value = true
  try {
    await auth.logout()
    cart.resetDraft('logout')
    payment.resetPayment()
    catalog.resetCatalog()
    useRefundsStore().reset()
    await startup.refresh()
    emit('close')
    await router.push({ name: getStartupRouteName(startup.state) })
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    size="sm"
    role="alertdialog"
    tone="plain"
    :persistent="signingOut || isSubmitting"
    @close="emit('close')"
  >
    <template #title>{{ t('shell.signOut.title') }}</template>
    <p class="text-pretty">{{ t('shell.signOut.body') }}</p>
    <AppBanner v-if="queued > 0" variant="warning" icon="cloud_upload" class="text-ink">
      {{ t('shell.signOut.queue', { count: queued }) }}
    </AppBanner>
    <template #actions>
      <AppButton
        variant="secondary"
        data-autofocus
        :disabled="signingOut || isSubmitting"
        @click="emit('close')"
      >
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton
        variant="primary"
        icon="logout"
        mirror-icon
        :loading="signingOut || isSubmitting"
        @click="confirm"
      >
        {{ t('common.signOut') }}
      </AppButton>
    </template>
  </AppDialog>
</template>
