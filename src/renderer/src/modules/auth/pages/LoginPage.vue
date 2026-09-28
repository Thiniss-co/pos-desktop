<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useDeviceStore } from '@renderer/modules/activation/store'
import { useConnectivityStore } from '@renderer/modules/connectivity/store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppIcon from '@renderer/shared/components/common/AppIcon.vue'
import AppBanner from '@renderer/shared/components/feedback/AppBanner.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useAuthStore } from '../store'

const auth = useAuthStore()
const { error, fieldErrors, isSubmitting, session } = storeToRefs(auth)
const device = useDeviceStore()
const { summary } = storeToRefs(device)
const { snapshot } = storeToRefs(useConnectivityStore())
const startup = useStartupStore()
const router = useRouter()
const email = ref('')
const password = ref('')
const { t } = useI18n()

/** Presentation only: whether the password field currently reveals its value. */
const showPassword = ref(false)

/**
 * Presentation only: the "sign in failed" heading belongs to an error raised by a submit, not to
 * the session-summary read error or a session-ended message the same store also reports.
 */
const hasAttempted = ref(false)

/**
 * Shown only when the device store truthfully reports a registered workstation. The device name is
 * not displayed: it defaults to the OS hostname, which V3 never puts on screen.
 */
const workstationActivated = computed(() => summary.value?.isRegistered === true)

/** Display-only hint; sign-in is never blocked on the connectivity snapshot. */
const isDisconnected = computed(
  () => snapshot.value?.status === 'offline' || snapshot.value?.status === 'backend_unreachable'
)

onMounted(() => {
  void auth.load()
  void device.load()
})

function clearPassword(): void {
  password.value = ''
}

onBeforeUnmount(clearPassword)

async function submit(): Promise<void> {
  hasAttempted.value = true
  const succeeded = await auth.login({ email: email.value.trim(), password: password.value })

  clearPassword()

  if (succeeded) {
    await startup.refresh()
    await router.push({ name: startup.state === 'ready' ? 'pos' : 'bootstrap' })
  }
}
</script>

<template>
  <form class="login-page flex flex-col gap-4" @submit.prevent="submit">
    <PageHeader :title="t('auth.title')">
      <template v-if="workstationActivated" #meta>
        <p class="mt-1.5 flex items-center gap-1.5 text-muted">
          <AppIcon name="verified" :size="18" class="text-ok" />
          <span class="min-w-0">{{ t('auth.workstationActivated') }}</span>
        </p>
      </template>
    </PageHeader>

    <p v-if="session?.isAuthenticated" class="text-sm text-muted">
      {{ t('auth.sessionAvailable') }}
    </p>

    <AppBanner
      v-if="error"
      variant="error"
      role="alert"
      :title="hasAttempted ? t('auth.signInFailed') : undefined"
    >
      {{ error }}
    </AppBanner>

    <AppInput
      v-model="email"
      type="email"
      autocomplete="username"
      dir="ltr"
      :label="t('auth.email')"
      :placeholder="t('auth.emailPlaceholder')"
      required
    />
    <AppInput
      v-model="password"
      class="login-page__password"
      :type="showPassword ? 'text' : 'password'"
      autocomplete="current-password"
      :label="t('auth.password')"
      required
    >
      <template #end>
        <button
          type="button"
          class="absolute inset-y-1 inset-e-1 flex items-center rounded-md px-2.5 text-sm font-semibold text-pri-text hover:bg-subtle"
          :aria-label="showPassword ? t('auth.hidePasswordLabel') : t('auth.showPasswordLabel')"
          @click="showPassword = !showPassword"
        >
          {{ showPassword ? t('auth.hidePassword') : t('auth.showPassword') }}
        </button>
      </template>
    </AppInput>

    <AppInlineError v-if="fieldErrors">
      <span v-for="(messages, field) in fieldErrors" :key="field" class="block">
        {{ field }}: {{ messages.join(', ') }}
      </span>
    </AppInlineError>

    <AppButton type="submit" size="xl" :loading="isSubmitting" full-width>
      {{ isSubmitting ? t('auth.signingIn') : t('auth.signIn') }}
    </AppButton>

    <p v-if="isDisconnected" class="flex items-center gap-2 text-sm text-muted" role="status">
      <AppIcon name="wifi_off" :size="18" />{{ t('auth.offlineHint') }}
    </p>
    <p class="text-center text-sm text-pretty text-muted">{{ t('auth.note') }}</p>
  </form>
</template>

<style scoped>
/* Leave room at the inline end of the password control for the Show/Hide toggle. */
.login-page__password :deep(.app-field__control) {
  padding-inline-end: 4.75rem;
}
</style>
