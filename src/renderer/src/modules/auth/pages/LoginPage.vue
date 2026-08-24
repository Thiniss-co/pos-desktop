<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useAuthStore } from '../store'

const auth = useAuthStore()
const { error, fieldErrors, isSubmitting, session } = storeToRefs(auth)
const startup = useStartupStore()
const router = useRouter()
const email = ref('')
const password = ref('')
const { t } = useI18n()

onMounted(() => void auth.load())

function clearPassword(): void {
  password.value = ''
}

onBeforeUnmount(clearPassword)

async function submit(): Promise<void> {
  const succeeded = await auth.login({ email: email.value.trim(), password: password.value })

  clearPassword()

  if (succeeded) {
    await startup.refresh()
    await router.push({ name: startup.state === 'ready' ? 'pos' : 'bootstrap' })
  }
}
</script>

<template>
  <div class="login-page">
    <PageHeader :eyebrow="t('auth.label')" :title="t('auth.title')" />
    <p v-if="session?.isAuthenticated" class="login-page__hint">
      {{ t('auth.sessionAvailable') }}
    </p>

    <form class="login-page__form" @submit.prevent="submit">
      <AppInput
        v-model="email"
        type="email"
        autocomplete="username"
        :label="t('auth.email')"
        :placeholder="t('auth.emailPlaceholder')"
        required
      />
      <AppInput
        v-model="password"
        type="password"
        autocomplete="current-password"
        :label="t('auth.password')"
        placeholder="••••••••"
        required
      />

      <AppInlineError v-if="fieldErrors">
        <span v-for="(messages, field) in fieldErrors" :key="field">
          {{ field }}: {{ messages.join(', ') }}
        </span>
      </AppInlineError>

      <AppButton type="submit" :loading="isSubmitting" full-width>
        {{ t('auth.signIn') }}
      </AppButton>
    </form>

    <AppInlineError v-if="error">{{ error }}</AppInlineError>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.login-page__hint {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-md-size);
}

.login-page__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
